/**
 * Role delegation: one `SubagentRuntime.startActivation` call per child, a
 * ledger record around it, and the host-bound work that has to happen when the
 * child appears (its tool allow-list and its own tools).
 *
 * WHAT THIS IS NOT. It is not a gate. Nothing here refuses work for lack of a
 * plan, an audit or an approval; the only refusals are about the call itself
 * (an unknown role, a caller that may not dispatch it, write paths that collide
 * with a live writer, a read-only surface this deployment cannot provide).
 *
 * THE FLOW (`delegate`): validate -> read the route -> pre-check write paths ->
 * mint the child id and arm its tool allow-list under that id -> record
 * `starting` -> start the child -> `running`. Settlement is tracked
 * asynchronously. The reviewer is the one role whose call waits: it is
 * one-shot, delivered to the caller, and its structured verdict is validated
 * and returned here, never accepted from a caller.
 *
 * NO ROUTING. A dispatch names provider+model (and optionally effort), or it
 * names nothing and the host default applies; the record says which.
 */

import { randomUUID } from 'node:crypto'
import {
  AP_DISPATCH_FAILED,
  AP_INVALID_ARGUMENT,
  AP_ROLE_NOT_DISPATCHABLE,
  AP_ROLE_VERDICT_INVALID,
  AP_TOOL_SURFACE_INCOMPLETE,
  AP_UNKNOWN_CHILD,
  AP_WRITE_PATHS_CONFLICT,
  AP_WRITE_PATHS_REQUIRED,
} from './domain/refusals.js'
import type { RefusalCode } from './domain/refusals.js'
import { AutopilotError, errorMessage } from './domain/types.js'
import { LedgerStore } from './ledger.js'
import type {
  DelegationRecord,
  DelegationRoleName,
  DelegationState,
  ReviewVerdict,
  Route,
  RouteSource,
} from './ledger.js'
import { LOCAL_PROVIDER, registeredToolNamesOf } from './host.js'
import type { ActivationRef, HostSeam } from './host.js'
import type { AgentRef, ToolScopeRef } from './host-types.js'
import { REVIEW_VERDICT_SCHEMA, ROLES, ROLE_NAMES, parseReviewVerdict } from './roles/index.js'
import type { RoleSpec } from './roles/index.js'
import { allowListDiagnostic, allowListFor, parseRestrictRejection } from './roles/tools.js'
import { findWriteConflict } from './roles/paths.js'
import { installChildTools } from './tools.js'

/** Arguments of `autopilot_delegate`, already shaped (blank strings removed). */
export interface DelegateArgs {
  readonly role: string
  readonly task: string
  readonly writePaths?: readonly string[]
  readonly provider?: string
  readonly model?: string
  readonly effort?: string
  readonly replaces?: string
}

/** What `autopilot_delegate` returns at once (or, for a reviewer, after it settles). */
export interface DelegateResult {
  readonly childId: string
  readonly role: DelegationRoleName
  readonly state: DelegationState
  readonly generation: number
  /** The route sent with the dispatch, or null when the host default applies. */
  readonly route: Route | null
  readonly routeSource: RouteSource
  readonly writePaths?: readonly string[]
  readonly tools: readonly string[] | 'inherit'
  readonly maxDepth: number
  /** Reviewer only: the route its first request actually used, when readable. */
  readonly observed?: Route
  /** Reviewer only: the verdict, returned in-band from the same call. */
  readonly review?: ReviewVerdict
}

/** What `autopilot_agents` returns. */
export interface WaitResult {
  readonly timedOut: boolean
  readonly delegations: readonly DelegationRecord[]
}

interface Caller {
  readonly agent: AgentRef
  readonly rootId: string
  /** The caller's own record when it is a delegated child. */
  readonly self?: DelegationRecord
  /** Depth of the caller below the root: 0 for the root itself. */
  readonly depth: number
}

interface Armed {
  readonly role: DelegationRoleName
  readonly allow: readonly string[] | 'inherit'
}

interface Started {
  readonly result: DelegateResult
  readonly activation: ActivationRef
}

const fail = (message: string, code: RefusalCode): never => {
  throw new AutopilotError(message, code)
}

/** Strip a blank-ish optional string. */
function blank(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** First line of a task, bounded, for display. */
function titleOf(task: string): string {
  const first = task.split('\n')[0] ?? task
  return first.trim().slice(0, 160)
}

/** Settle `pending` within `seconds`, or when the plugin unmounts. */
async function settleWithin(pending: readonly Promise<void>[], seconds: number, signal: AbortSignal): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const stopped = new Promise<'stopped'>((resolve) => {
    timer = setTimeout(() => resolve('stopped'), seconds * 1000)
    timer.unref?.()
    onAbort = () => resolve('stopped')
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const outcome = await Promise.race([Promise.all(pending).then(() => 'settled' as const), stopped])
    return outcome === 'settled'
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

export class Delegator {
  private readonly ledger = new LedgerStore()
  /** Allow-lists armed before `startActivation`, keyed by the pre-minted child id. */
  private readonly armed = new Map<string, Armed>()
  /** Settlement of each tracked child, resolved after the ledger write. */
  private readonly settlements = new Map<string, Promise<void>>()
  /** Own-scope tool registrations made on a child's context, released on disposal. */
  private readonly childSurfaces = new Map<string, () => void>()
  /** Each child's session, retained so its first request header can be read after settlement. */
  private readonly childSessions = new Map<string, AgentRef['session']>()

  constructor(private readonly host: HostSeam) {}

  /** Every record of one root session (read-only view). */
  records(rootId: string): readonly DelegationRecord[] {
    return this.ledger.records(rootId)
  }

  // ── Who is calling ─────────────────────────────────────────────────────────

  /** The root session id of any agent: itself, or the top of its parent chain. */
  rootIdOf(agent: AgentRef): string {
    let current: AgentRef = agent
    for (let i = 0; i < 16; i += 1) {
      const parent = current.session.header.parentSession
      if (parent === undefined) return current.id
      const next = this.host.agents.get(parent)
      if (next === undefined) return parent
      current = next
    }
    return current.id
  }

  private callerOf(agent: AgentRef): Caller {
    const rootId = this.rootIdOf(agent)
    if (agent.session.header.parentSession === undefined) return { agent, rootId, depth: 0 }
    const self = this.ledger.find(rootId, agent.id)
    if (self === undefined) {
      return fail('only the root agent and the executor-leads it dispatched can delegate', AP_ROLE_NOT_DISPATCHABLE)
    }
    return { agent, rootId, self, depth: self.depth }
  }

  // ── delegate ───────────────────────────────────────────────────────────────

  async delegate(agent: AgentRef, args: DelegateArgs): Promise<DelegateResult> {
    const caller = this.callerOf(agent)
    const role = ROLE_NAMES.find((name) => name === args.role)
    if (role === undefined) return fail(`unknown role "${args.role}"; roles are ${ROLE_NAMES.join(', ')}`, AP_INVALID_ARGUMENT)
    const spec = ROLES[role]
    const task = args.task.trim()
    if (task.length === 0) return fail('task must not be empty', AP_INVALID_ARGUMENT)
    if (caller.self !== undefined) {
      const callerSpec = ROLES[caller.self.role]
      if (!callerSpec.canDispatch.includes(role)) {
        return fail(
          `a ${caller.self.role} may dispatch ${callerSpec.canDispatch.join(', ') || 'nothing'}, not ${role}`,
          AP_ROLE_NOT_DISPATCHABLE,
        )
      }
    }
    const route = this.routeOf(args)
    const routeSource: RouteSource = route === undefined ? 'inherit' : 'call'
    const writePaths = spec.write
      ? (args.writePaths ?? []).map((path) => path.trim()).filter((path) => path.length > 0)
      : []
    if (spec.requiresWritePaths && writePaths.length === 0) {
      return fail(`a ${role} writes files: declare writePaths (exact files, or a prefix such as src/parser/**)`, AP_WRITE_PATHS_REQUIRED)
    }
    let replaced: DelegationRecord | undefined
    if (args.replaces !== undefined) {
      replaced = this.ledger.find(caller.rootId, args.replaces.trim())
      if (replaced === undefined) return fail(`replaces names no delegation under this root: ${args.replaces}`, AP_UNKNOWN_CHILD)
      if (replaced.role !== role) return fail(`replaces ${replaced.childId} is a ${replaced.role}; a replacement keeps the role`, AP_INVALID_ARGUMENT)
    }
    const ancestors = this.ancestorsOf(caller, replaced)
    this.assertNoConflict(caller.rootId, writePaths, ancestors)
    const started = await this.start(caller, role, task, route, routeSource, writePaths, ancestors, replaced, role === 'reviewer' ? { outputSchema: REVIEW_VERDICT_SCHEMA } : {})
    if (role === 'reviewer') return await this.review(caller.rootId, started)
    return started.result
  }

  /** Validate the explicit route: both provider and model, or neither; effort requires both. */
  private routeOf(args: DelegateArgs): Route | undefined {
    const provider = blank(args.provider)
    const model = blank(args.model)
    const effort = blank(args.effort)
    if ((provider === undefined) !== (model === undefined)) {
      return fail('provider and model must be named together, or neither', AP_INVALID_ARGUMENT)
    }
    if (effort !== undefined && (provider === undefined || model === undefined)) {
      return fail('effort requires provider and model: the host rejects an effort without an explicit route', AP_INVALID_ARGUMENT)
    }
    if (provider === undefined || model === undefined) return undefined
    return { provider, model, ...(effort === undefined ? {} : { effort }) }
  }

  private ancestorsOf(caller: Caller, replaced: DelegationRecord | undefined): ReadonlySet<string> {
    const out = new Set<string>()
    let current = caller.self
    for (let i = 0; current !== undefined && i < 8; i += 1) {
      out.add(current.childId)
      current = this.ledger.find(caller.rootId, current.parentId)
    }
    if (replaced !== undefined) out.add(replaced.childId)
    return out
  }

  private assertNoConflict(rootId: string, writePaths: readonly string[], ancestors: ReadonlySet<string>): void {
    if (writePaths.length === 0) return
    const conflict = findWriteConflict(writePaths, this.ledger.records(rootId), ancestors)
    if (conflict !== undefined) {
      fail(
        `writePaths ${conflict.path} intersects ${conflict.with}, which child ${conflict.childId} may write while it is still running; give concurrent writers disjoint paths, or wait for it to finish`,
        AP_WRITE_PATHS_CONFLICT,
      )
    }
  }

  private async start(
    caller: Caller,
    role: DelegationRoleName,
    task: string,
    route: Route | undefined,
    routeSource: RouteSource,
    writePaths: readonly string[],
    ancestors: ReadonlySet<string>,
    replaced: DelegationRecord | undefined,
    options: { readonly outputSchema?: object } = {},
  ): Promise<Started> {
    const spec = ROLES[role]
    const childId = randomUUID()
    const depth = caller.depth + 1
    const cap = depth + spec.maxDepth - 1
    const generation = replaced === undefined ? 1 : replaced.generation + 1
    const registered = registeredToolNamesOf(this.host.tools, caller.agent)
    const allow = allowListFor(spec, registered)
    const narrowed = allowListDiagnostic(spec, registered)

    this.assertNoConflict(caller.rootId, writePaths, ancestors)
    const record = this.ledger.add(
      caller.rootId,
      {
        childId,
        role,
        parentId: caller.agent.id,
        depth,
        generation,
        ...(replaced === undefined ? {} : { replaces: replaced.childId }),
        title: titleOf(task),
        ...(writePaths.length === 0 ? {} : { writePaths }),
        ...(route === undefined ? {} : { route }),
        routeSource,
        tools: allow,
        maxDepth: cap,
      },
      this.host.now(),
    )
    if (narrowed !== undefined) this.host.warn(narrowed)
    this.armed.set(childId, { role, allow })

    const agentOptions = route === undefined
      ? undefined
      : { provider: route.provider, model: route.model, ...(route.effort === undefined ? {} : { reasoningEffort: route.effort }) }
    let activation: ActivationRef
    try {
      activation = await this.host.subagents.startActivation({
        provider: LOCAL_PROVIDER,
        label: `${role}: ${record.title}`.slice(0, 120),
        childId,
        prompt: [{ type: 'text', text: promptOf(spec, task, writePaths) }],
        parent: caller.agent,
        maxDepth: cap,
        ...(agentOptions === undefined ? {} : { agentOptions }),
        ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
        signal: this.host.signal,
        delivery: spec.delivery,
      })
    } catch (error: unknown) {
      this.armed.delete(childId)
      const message = errorMessage(error)
      this.ledger.update(caller.rootId, childId, { state: 'failed', settledAt: this.host.now(), diagnostic: message })
      throw new AutopilotError(message, AP_DISPATCH_FAILED)
    }

    const realId = String(activation.childId)
    if (realId !== childId) {
      this.armed.delete(childId)
      this.armed.set(realId, { role, allow })
      this.ledger.update(caller.rootId, childId, { childId: realId })
    }
    this.ledger.update(caller.rootId, realId, { state: 'running' })
    this.track(caller.rootId, realId, role, activation.result)

    return {
      activation,
      result: {
        childId: realId,
        role,
        state: 'running',
        generation,
        route: route ?? null,
        routeSource,
        ...(writePaths.length === 0 ? {} : { writePaths }),
        tools: allow,
        maxDepth: cap,
      },
    }
  }

  // ── settlement ─────────────────────────────────────────────────────────────

  private track(
    rootId: string,
    childId: string,
    role: DelegationRoleName,
    result: Promise<{ readonly stopReason: string; readonly diagnostic?: string }>,
  ): void {
    const settled = result
      .then(
        (outcome) => this.settle(rootId, childId, role, outcome.stopReason, outcome.diagnostic),
        (error: unknown) => this.settle(rootId, childId, role, 'error', errorMessage(error)),
      )
      .catch((error: unknown) => this.host.warn(`settling child ${childId} failed: ${errorMessage(error)}`))
    this.settlements.set(childId, settled)
  }

  private settle(
    rootId: string,
    childId: string,
    role: DelegationRoleName,
    stopReason: string,
    diagnostic: string | undefined,
  ): void {
    const state: DelegationState = stopReason === 'completed'
      ? (ROLES[role].oneShot ? 'completed' : 'idle')
      : (stopReason === 'aborted' || stopReason === 'cancelled' || stopReason === 'interrupted')
        ? 'cancelled'
        : 'failed'
    const observed = observedRouteOf(this.childSessions.get(childId))
    const current = this.ledger.find(rootId, childId)
    if (current !== undefined && (current.state === 'starting' || current.state === 'running')) {
      this.ledger.update(rootId, childId, {
        state,
        settledAt: this.host.now(),
        ...(state === 'failed' ? { diagnostic: diagnostic ?? stopReason } : {}),
        ...(observed === undefined ? {} : { observed }),
      })
    }
    this.childSessions.delete(childId)
    this.settlements.delete(childId)
  }

  // ── wait ───────────────────────────────────────────────────────────────────

  async wait(agent: AgentRef, childIds: readonly string[] | undefined, timeoutSeconds: number): Promise<WaitResult> {
    const caller = this.callerOf(agent)
    const known = this.ledger.records(caller.rootId)
    for (const id of childIds ?? []) {
      if (!known.some((record) => record.childId === id)) {
        fail(`no delegation with child id ${id} under this root`, AP_UNKNOWN_CHILD)
      }
    }
    const targets = childIds === undefined
      ? known.filter((record) => record.parentId === agent.id)
      : known.filter((record) => childIds.includes(record.childId))
    const pending = targets
      .filter((record) => record.state === 'starting' || record.state === 'running')
      .map((record) => this.settlements.get(record.childId))
      .filter((promise): promise is Promise<void> => promise !== undefined)
    let timedOut = false
    if (pending.length > 0) {
      timedOut = timeoutSeconds <= 0 ? true : !(await settleWithin(pending, timeoutSeconds, this.host.signal))
    }
    const ids = new Set(targets.map((record) => record.childId))
    return {
      timedOut,
      delegations: this.ledger.records(caller.rootId).filter((record) => ids.has(record.childId)),
    }
  }

  // ── escalate ───────────────────────────────────────────────────────────────

  async escalate(agent: AgentRef, reason: string): Promise<string> {
    const rootId = this.rootIdOf(agent)
    const self = agent.session.header.parentSession === undefined ? undefined : this.ledger.find(rootId, agent.id)
    if (self === undefined) return fail('only a delegated child can escalate', AP_UNKNOWN_CHILD)
    if (self.role === 'reviewer') return fail('a reviewer cannot escalate: report the finding in the verdict', AP_ROLE_NOT_DISPATCHABLE)
    const trimmed = reason.trim()
    if (trimmed.length === 0) return fail('reason must not be empty', AP_INVALID_ARGUMENT)
    this.ledger.update(rootId, agent.id, { escalation: { reason: trimmed, at: this.host.now() } })
    return 'Recorded. Your parent decides: it may re-dispatch this work with a stronger model or more effort, which starts a new child in a new context with the same contract. Finish or stop what you are doing and report; do not wait for an answer.'
  }

  // ── reviewer ───────────────────────────────────────────────────────────────

  private async review(rootId: string, started: Started): Promise<DelegateResult> {
    let outcome: { readonly stopReason: string; readonly structured?: unknown; readonly diagnostic?: string }
    try {
      outcome = await started.activation.result
    } catch (error: unknown) {
      outcome = { stopReason: 'error', diagnostic: errorMessage(error) }
    }
    // The settlement tracker runs first (it is registered before this call) and
    // already read and stored the observed route; fall back to a direct read.
    const observed = this.ledger.find(rootId, started.result.childId)?.observed
      ?? observedRouteOf(this.childSessions.get(started.result.childId))
    this.childSessions.delete(started.result.childId)
    const parsed = outcome.stopReason === 'completed'
      ? parseReviewVerdict(outcome.structured)
      : (outcome.diagnostic ?? `the reviewer stopped with ${outcome.stopReason}`)
    if (typeof parsed === 'string') {
      this.ledger.update(rootId, started.result.childId, {
        state: 'failed',
        settledAt: this.host.now(),
        diagnostic: parsed,
      })
      if (outcome.stopReason === 'completed') throw new AutopilotError(parsed, AP_ROLE_VERDICT_INVALID)
      throw new AutopilotError(parsed, AP_DISPATCH_FAILED)
    }
    this.ledger.update(rootId, started.result.childId, {
      state: 'completed',
      settledAt: this.host.now(),
      ...(observed === undefined ? {} : { observed }),
    })
    return { ...started.result, state: 'completed', ...(observed === undefined ? {} : { observed }), review: parsed }
  }

  // ── agent/created: tool restriction and the child's own tools ──────────────

  /**
   * A child agent exists and has not seen its first prompt. Restrict its tools
   * from the allow-list armed under ITS id, then give it its own tools. Fails
   * closed: a restriction that cannot be applied is rethrown so the host vetoes
   * the child's publication, and the delegation is recorded as failed.
   */
  onChildCreated(agent: AgentRef): void {
    const parentId = agent.session.header.parentSession
    if (parentId === undefined) return
    const rootId = this.rootIdOf(agent)
    let armed = this.armed.get(agent.id)
    if (armed === undefined) {
      const record = this.ledger.find(rootId, agent.id)
      if (record === undefined) return
      armed = { role: record.role, allow: allowListFor(ROLES[record.role], registeredToolNamesOf(this.host.tools, agent)) }
    }
    this.armed.delete(agent.id)
    this.childSessions.set(agent.id, agent.session)
    try {
      if (armed.allow !== 'inherit') this.restrict(agent.ctx.tools, armed.allow, armed.role)
      const tools = agent.ctx.tools
      if (tools !== undefined) {
        this.childSurfaces.get(agent.id)?.()
        this.childSurfaces.set(agent.id, installChildTools(tools, this, armed.role))
      }
    } catch (error: unknown) {
      this.childSurfaces.get(agent.id)?.()
      this.childSurfaces.delete(agent.id)
      const message = `tool restriction failed: ${errorMessage(error)}`
      this.ledger.update(rootId, agent.id, { state: 'failed', settledAt: this.host.now(), diagnostic: message })
      throw error
    }
  }

  private restrict(tools: ToolScopeRef | undefined, allow: readonly string[], role: DelegationRoleName): void {
    const restrict = tools?.restrict
    if (tools === undefined || restrict === undefined) {
      throw new AutopilotError('this child has no tool restriction surface, so its allow-list cannot be applied', AP_TOOL_SURFACE_INCOMPLETE)
    }
    try {
      restrict.call(tools, { allow })
    } catch (error: unknown) {
      // restrict() is all-or-nothing: learn the registry from the rejection and retry once with what exists.
      const parsed = parseRestrictRejection(errorMessage(error))
      if (parsed === undefined) throw error
      const kept = allow.filter((name) => parsed.known.includes(name))
      if (!kept.includes('read') && ROLES[role].requestedTools !== 'inherit') throw error
      restrict.call(tools, { allow: kept })
    }
  }

  /** `agent/disposed` of a child: release its own-scope tools. */
  onChildDisposed(agent: AgentRef): void {
    this.childSurfaces.get(agent.id)?.()
    this.childSurfaces.delete(agent.id)
    this.armed.delete(agent.id)
    this.childSessions.delete(agent.id)
  }
}

/**
 * The route the child's own first request header showed (the last well-formed
 * `request/header` event wins). Undefined when the host exposes no session log,
 * the read fails, or no well-formed header was recorded before this read.
 */
export function observedRouteOf(
  session: { snapshotEvents?(): ReadonlyArray<{ readonly type: string; readonly data: unknown }> } | undefined,
): Route | undefined {
  if (session?.snapshotEvents === undefined) return undefined
  let events: ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  try {
    events = session.snapshotEvents()
  } catch {
    return undefined
  }
  let observed: Route | undefined
  for (const event of events) {
    if (event.type !== 'request/header') continue
    const config = (event.data as {
      readonly header?: { readonly config?: { readonly provider?: unknown; readonly model?: unknown; readonly reasoningEffort?: unknown } }
    } | undefined)?.header?.config
    if (config === undefined || typeof config.provider !== 'string' || typeof config.model !== 'string') continue
    observed = {
      provider: config.provider,
      model: config.model,
      ...(typeof config.reasoningEffort === 'string' ? { effort: config.reasoningEffort } : {}),
    }
  }
  return observed
}

/** Role persona + optional write scope + the task, as the child's first message. */
export function promptOf(spec: RoleSpec, task: string, writePaths: readonly string[]): string {
  const lines: string[] = [spec.persona, '']
  if (writePaths.length > 0) lines.push(`Your writePaths (edit nothing outside them): ${writePaths.join(', ')}`, '')
  lines.push('Task:', task.trim())
  return lines.join('\n')
}
