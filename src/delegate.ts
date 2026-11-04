/**
 * Role delegation: one `SubagentRuntime.startActivation` call per child, a
 * ledger record around it, and the host-bound work that has to happen when the
 * child appears (its tool allow-list, its own tools).
 *
 * WHAT THIS IS NOT. It is not a gate. Nothing here refuses work for lack of a
 * plan, an audit or an approval; the only refusals are about the call itself
 * (an unknown role, a caller that may not dispatch it, write paths that collide
 * with another active writer, a route the owner's pins forbid).
 *
 * THE FLOW (`delegate`): validate -> pre-check write paths -> route -> mint the
 * child id and arm its tool allow-list under that id -> record `starting`
 * (re-checking the write paths in the same compare-and-swap) -> start the child
 * -> `running`. Settlement is tracked asynchronously. The reviewer is the one
 * role whose call waits: it is one-shot, delivered to the caller, and its
 * structured verdict is validated and recorded here, never accepted from a
 * caller.
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
import type {
  AutoContinueStatus,
  DelegationRecord,
  DelegationRoleName,
  DelegationState,
  DepthStatus,
  EffortSource,
  GoalRef,
  Ledger,
  LedgerRoute,
  ModelSource,
  ReviewRecord,
  RouteMatch,
} from './domain/ledger-types.js'
import type { AgentRef, AutopilotEngine, ResolvedRouting, SessionReadRef } from './engine.js'
import { observedRouteOf } from './engine.js'
import { REVIEW_VERDICT_SCHEMA, ROLES, ROLE_NAMES, parseReviewVerdict } from './roles/index.js'
import { isRouteRefusal, routeForDelegation } from './roles/route.js'
import type { RouteDecision } from './roles/route.js'
import { familyOf } from './roles/cross-family.js'
import { allowListDiagnostic, allowListFor, parseRestrictRejection } from './roles/tools.js'
import { findWriteConflict } from './roles/paths.js'
import { installChildTools } from './tools.js'
import type { WorkClassName } from './routing/work-class.js'

/** The local subagent backend; the only one that accepts a pre-minted child id. */
const LOCAL_PROVIDER = 'spawn'

/** Arguments of `autopilot_delegate`, already shaped (blank strings removed). */
export interface DelegateArgs {
  readonly role: string
  readonly task: string
  readonly writePaths?: readonly string[]
  readonly provider?: string
  readonly model?: string
  readonly effort?: string
  readonly workClass?: WorkClassName
  readonly replaces?: string
  readonly reviewedChildIds?: readonly string[]
}

export interface DelegateResult {
  readonly childId: string
  readonly role: DelegationRoleName
  readonly state: DelegationState
  readonly selected?: LedgerRoute
  readonly modelSource: ModelSource
  readonly effortSource: EffortSource
  readonly tools: readonly string[] | 'inherit'
  readonly maxDepth: number
  readonly generation: number
  readonly routeWhy?: readonly string[]
  /** Reviewer only: the verdict, returned in-band. */
  readonly review?: {
    readonly verdict: string
    readonly findings: ReviewRecord['findings']
    readonly subject: string
    readonly independence: ReviewRecord['independence']
    readonly excludedFamilies: readonly string[]
    readonly independenceNote?: string
    readonly reviewerRoute?: LedgerRoute
  }
}

interface Caller {
  readonly agent: AgentRef
  readonly rootId: string
  readonly self?: DelegationRecord
  /** Depth of the caller below the root: 0 for the root itself. */
  readonly depth: number
}

interface Armed {
  readonly role: DelegationRoleName
  readonly allow: readonly string[] | 'inherit'
}

const fail = (message: string, code: RefusalCode): never => { throw new AutopilotError(message, code) }

/** Same route on every comparable axis? Effort is compared only when it was actually sent. */
export function routeMatchOf(
  selected: LedgerRoute | undefined,
  effortSource: EffortSource,
  observed: LedgerRoute | undefined,
  unreadable: boolean,
): RouteMatch {
  if (observed === undefined) return unreadable ? 'unreadable' : 'pending'
  if (selected === undefined) return 'match'
  if (selected.provider !== observed.provider || selected.model !== observed.model) return 'mismatch'
  if (effortSource !== 'host-default' && selected.reasoningEffort !== undefined) {
    // The effort was sent; the child's own header has to carry it.
    if (observed.reasoningEffort === undefined) return 'unreadable'
    if (observed.reasoningEffort !== selected.reasoningEffort) return 'mismatch'
  }
  return 'match'
}

export class Delegator {
  /** Allow-lists armed before `startActivation`, keyed by the pre-minted child id (never by parent). */
  private readonly armed = new Map<string, Armed>()
  /** Settlement of each tracked child, resolved after the ledger write. */
  private readonly settlements = new Map<string, Promise<void>>()
  private readonly childSurfaces = new Map<string, () => void>()
  /**
   * Each delegated child's session, retained from `agent/created` until its
   * observed route has been read after settlement. dsh 0.2.1-rc.5 disposes a
   * settled child (and drops it from `ctx.agents`) BEFORE it resolves the
   * activation result (`dsh-subagent` `finishDisposal`), so by the time
   * {@link settle} refreshes routes `agents.get(childId)` is already empty. The
   * session object outlives the registry entry and its in-memory log is not
   * cleared on disposal, so the final `request/header` stays readable here.
   */
  private readonly childSessions = new Map<string, SessionReadRef>()
  private learnedToolNames: readonly string[] | undefined

  constructor(private readonly engine: AutopilotEngine) {}

  // ── Who is calling ─────────────────────────────────────────────────────────

  /** The root session id of any agent: itself, or the top of its parent chain. */
  rootIdOf(agent: AgentRef): string {
    let cur: AgentRef = agent
    for (let i = 0; i < 16; i += 1) {
      const parent = cur.session.header.parentSession
      if (parent === undefined) return cur.id
      const next = this.engine.agents.get(parent)
      if (next === undefined) return parent
      cur = next
    }
    return cur.id
  }

  private callerOf(agent: AgentRef): Caller {
    const rootId = this.rootIdOf(agent)
    if (agent.session.header.parentSession === undefined) return { agent, rootId, depth: 0 }
    const self = this.engine.peekLedger(rootId)?.delegations.find(d => d.childId === agent.id)
    if (self === undefined) {
      return fail('only the root agent and the executor-leads it dispatched can delegate', AP_ROLE_NOT_DISPATCHABLE)
    }
    return { agent, rootId, self, depth: self.depth }
  }

  // ── Routing inputs ─────────────────────────────────────────────────────────

  private liveRouting(why: string[]): ResolvedRouting {
    try {
      return this.engine.routing()
    } catch (error: unknown) {
      why.push(`live routing config invalid (${errorMessage(error)}); using the mount-time snapshot`)
      return this.engine.config.routing
    }
  }

  /**
   * The tool names `scope` can be restricted to: the caller at dispatch (a child
   * inherits its parent's preset generation), the child itself on a cold resume.
   */
  private registeredNames(scope: AgentRef): readonly string[] | undefined {
    return this.engine.ports.environment?.registeredToolNames?.(scope) ?? this.learnedToolNames
  }

  private depthStatus(): DepthStatus {
    const read = this.engine.ports.environment?.subagentMaxDepth?.()
    if (read === undefined) {
      return { executorLead: 2, source: 'unknown', note: 'the host subagent maxDepth setting is not readable; the plugin sends 2 and the host enforces its own limit' }
    }
    if (read >= 2) return { executorLead: 2, source: 'plugin-default', note: `host subagent maxDepth setting is ${read}` }
    return {
      executorLead: 2,
      source: 'plugin-default',
      note: `host subagent maxDepth setting is ${read} (its shipped default; it cannot be told from an explicit value and governs the native subagent tools only); the plugin sends 2 and the host enforces the cap it is given`,
    }
  }

  private async route(
    role: DelegationRoleName,
    args: DelegateArgs,
    caller: Caller,
    excludeFamilies?: readonly string[],
  ): Promise<RouteDecision> {
    const why: string[] = []
    const routing = this.liveRouting(why)
    const ports = this.engine.routingPorts
    const policy = ports.policyReader?.(caller.agent.id === caller.rootId ? caller.agent : (this.engine.agents.get(caller.rootId) ?? caller.agent)) ?? { kind: 'unreachable' as const }
    const modelSelection = this.engine.ports.environment?.modelSelection?.()
    const arg = {
      ...(args.provider === undefined ? {} : { provider: args.provider }),
      ...(args.model === undefined ? {} : { model: args.model }),
      ...(args.effort === undefined ? {} : { effort: args.effort }),
    }
    const decision = await routeForDelegation({
      role,
      ...(args.workClass === undefined ? {} : { workClass: args.workClass }),
      ...(Object.keys(arg).length === 0 ? {} : { arg }),
      routing,
      ports: { ...(ports.catalog === undefined ? {} : { catalog: ports.catalog }), policy, ...(modelSelection === undefined ? {} : { modelSelection }) },
      ...(excludeFamilies === undefined ? {} : { excludeFamilies }),
    })
    if (isRouteRefusal(decision)) return fail(decision.detail, decision.refused as RefusalCode)
    if (why.length === 0) return decision
    return { ...decision, why: [...why, ...decision.why] }
  }

  // ── delegate ───────────────────────────────────────────────────────────────

  async delegate(agent: AgentRef, args: DelegateArgs): Promise<DelegateResult> {
    const caller = this.callerOf(agent)
    const role = ROLE_NAMES.find(name => name === args.role)
    if (role === undefined) return fail(`unknown role "${args.role}"; roles are ${ROLE_NAMES.join(', ')}`, AP_INVALID_ARGUMENT)
    if (args.task.trim().length === 0) return fail('task must not be empty', AP_INVALID_ARGUMENT)
    const spec = ROLES[role]
    if (caller.self !== undefined && !ROLES[caller.self.role].canDispatch.includes(role)) {
      return fail(`a ${caller.self.role} may dispatch ${ROLES[caller.self.role].canDispatch.join(', ') || 'nothing'}, not ${role}`, AP_ROLE_NOT_DISPATCHABLE)
    }
    const writePaths = spec.write ? (args.writePaths ?? []).map(p => p.trim()).filter(p => p.length > 0) : []
    if (spec.requiresWritePaths && writePaths.length === 0) {
      return fail(`a ${role} writes files: declare writePaths (exact files, or a prefix such as src/parser/**)`, AP_WRITE_PATHS_REQUIRED)
    }
    let replaced: DelegationRecord | undefined
    if (args.replaces !== undefined) {
      replaced = this.engine.peekLedger(caller.rootId)?.delegations.find(d => d.childId === args.replaces)
      if (replaced === undefined) return fail(`replaces names no delegation under this root: ${args.replaces}`, AP_UNKNOWN_CHILD)
      if (replaced.role !== role) return fail(`replaces ${replaced.childId} is a ${replaced.role}; a replacement keeps the role`, AP_INVALID_ARGUMENT)
    }
    const ancestors = this.ancestorsOf(caller, replaced)
    this.assertNoConflict(this.engine.ledgerFor(caller.rootId), writePaths, ancestors)

    if (role === 'reviewer') return await this.review(caller, args)

    const decision = await this.route(role, args, caller)
    const registered = this.registeredNames(caller.agent)
    const allow = allowListFor(role, registered)
    const narrowed = allowListDiagnostic(role, registered)
    const why = [...decision.why, ...(narrowed === undefined ? [] : [narrowed])]
    const { activation, ...started } = await this.start(caller, role, args, decision, allow, writePaths, ancestors, replaced, why)
    void activation
    return started
  }

  private ancestorsOf(caller: Caller, replaced: DelegationRecord | undefined): ReadonlySet<string> {
    const out = new Set<string>()
    const ledger = this.engine.peekLedger(caller.rootId)
    let cur = caller.self
    for (let i = 0; cur !== undefined && i < 8; i += 1) {
      out.add(cur.childId)
      cur = ledger?.delegations.find(d => d.childId === cur?.parentId)
    }
    if (replaced !== undefined) out.add(replaced.childId)
    return out
  }

  private assertNoConflict(ledger: Ledger, writePaths: readonly string[], ancestors: ReadonlySet<string>): void {
    if (writePaths.length === 0) return
    const conflict = findWriteConflict(writePaths, ledger.delegations, ancestors)
    if (conflict !== undefined) {
      fail(`writePaths ${conflict.path} intersects ${conflict.with}, which child ${conflict.childId} may write while it is still running; give concurrent writers disjoint paths, or wait for it to finish`, AP_WRITE_PATHS_CONFLICT)
    }
  }

  private async start(
    caller: Caller,
    role: DelegationRoleName,
    args: DelegateArgs,
    decision: RouteDecision,
    allow: readonly string[] | 'inherit',
    writePaths: readonly string[],
    ancestors: ReadonlySet<string>,
    replaced: DelegationRecord | undefined,
    why: readonly string[],
    extra: { readonly outputSchema?: object; readonly delivery?: 'parent' | 'caller' } = {},
  ): Promise<DelegateResult & { activation?: { result: Promise<{ stopReason: string; structured?: unknown; diagnostic?: string }> } }> {
    // Mirror the goal first: its firstSeenAt must not be later than this dispatch's startedAt, or the
    // reviewer's default window (since the goal's first sighting) would miss this dispatch.
    await this.engine.syncGoal(this.engine.agents.get(caller.rootId) ?? caller.agent)
    const spec = ROLES[role]
    const depth = caller.depth + 1
    const cap = depth + spec.maxDepth - 1
    const childId = randomUUID()
    const delivery = extra.delivery ?? spec.delivery
    const record: DelegationRecord = {
      childId,
      role,
      parentId: caller.agent.id,
      depth,
      generation: replaced === undefined ? 1 : replaced.generation + 1,
      ...(replaced === undefined ? {} : { replaces: replaced.childId }),
      title: args.task.trim().split('\n')[0]!.slice(0, 160),
      state: 'starting',
      ...(writePaths.length === 0 ? {} : { writePaths }),
      ...(decision.selected === undefined ? {} : { selected: decision.selected }),
      modelSource: decision.modelSource,
      effortSource: decision.effortSource,
      routeMatch: 'pending',
      routeWhy: [...why],
      tools: allow,
      maxDepth: cap,
      startedAt: this.engine.clock(),
    }
    const depthStatus = this.depthStatus()
    // Re-check the write paths inside the compare-and-swap: two concurrent dispatches must not both pass.
    await this.engine.mutate(caller.rootId, (ledger) => {
      this.assertNoConflict(ledger, writePaths, ancestors)
      return { ...ledger, depth: depthStatus, delegations: [...ledger.delegations, record] }
    })

    const armed: Armed = { role, allow }
    this.armed.set(childId, armed)
    const agentOptions = this.agentOptionsOf(decision)
    const prompt = this.promptOf(role, args.task, writePaths)
    const request = {
      prompt: [{ type: 'text' as const, text: prompt }],
      parent: caller.agent,
      maxDepth: cap,
      ...(extra.outputSchema === undefined ? {} : { outputSchema: extra.outputSchema }),
      ...(agentOptions === undefined ? {} : { agentOptions }),
    }
    const label = `${role}: ${record.title}`.slice(0, 120)
    let activation
    try {
      activation = await this.engine.subagents.startActivation({ provider: LOCAL_PROVIDER, label, childId, request, signal: this.engine.signal, delivery })
    } catch (error: unknown) {
      // No fallback: a host that rejects a pre-minted id fails the dispatch rather than arming by parent.
      return await this.failStart(caller.rootId, childId, error)
    }
    const realId = String(activation.childId)
    if (realId !== childId) {
      this.armed.delete(childId)
      await this.engine.mutate(caller.rootId, ledger => ({ ...ledger, delegations: ledger.delegations.map(d => (d.childId === childId ? { ...d, childId: realId } : d)) }))
    }
    await this.engine.mutate(caller.rootId, ledger => ({
      ...ledger,
      delegations: ledger.delegations.map(d => (d.childId === realId && d.state === 'starting' ? { ...d, state: 'running' as const } : d)),
    }))
    this.track(caller.rootId, realId, role, activation.result)
    await this.engine.syncGoal(this.engine.agents.get(caller.rootId) ?? caller.agent)
    return {
      childId: realId,
      role,
      state: 'running',
      ...(decision.selected === undefined ? {} : { selected: decision.selected }),
      modelSource: decision.modelSource,
      effortSource: decision.effortSource,
      tools: allow,
      maxDepth: cap,
      generation: record.generation,
      routeWhy: record.routeWhy ?? [],
      activation,
    }
  }

  private agentOptionsOf(decision: RouteDecision): { provider?: string; model?: string; reasoningEffort?: string } | undefined {
    const options = {
      ...(decision.selected === undefined ? {} : { provider: decision.selected.provider, model: decision.selected.model }),
      // Always send the effort when one is known: the host drops the parent's effort on a route change that names none.
      ...(decision.reasoningEffort === undefined ? {} : { reasoningEffort: decision.reasoningEffort }),
    }
    return Object.keys(options).length === 0 ? undefined : options
  }

  private promptOf(role: DelegationRoleName, task: string, writePaths: readonly string[]): string {
    return [
      ROLES[role].persona,
      '',
      writePaths.length === 0 ? '' : `Your writePaths (edit nothing outside them): ${writePaths.join(', ')}`,
      writePaths.length === 0 ? '' : '',
      'Task:',
      task.trim(),
    ].filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n')
  }

  private async failStart(rootId: string, childId: string, error: unknown): Promise<never> {
    this.armed.delete(childId)
    const message = errorMessage(error)
    await this.engine.mutate(rootId, ledger => ({
      ...ledger,
      delegations: ledger.delegations.map(d => (d.childId === childId ? { ...d, state: 'failed' as const, settledAt: this.engine.clock(), diagnostic: message } : d)),
    }))
    return fail(message, AP_DISPATCH_FAILED)
  }

  // ── settlement and observed routes ────────────────────────────────────────

  private track(
    rootId: string,
    childId: string,
    role: DelegationRoleName,
    result: Promise<{ stopReason: string; structured?: unknown; diagnostic?: string }>,
  ): void {
    const settled = result.then(
      res => this.settle(rootId, childId, role, res.stopReason, res.diagnostic),
      (error: unknown) => this.settle(rootId, childId, role, 'error', errorMessage(error)),
    ).catch((error: unknown) => this.engine.report(`settling child ${childId} failed: ${errorMessage(error)}`))
    this.settlements.set(childId, settled)
  }

  private async settle(rootId: string, childId: string, role: DelegationRoleName, stopReason: string, diagnostic: string | undefined): Promise<void> {
    const state: DelegationState =
      stopReason === 'completed' ? (ROLES[role].oneShot ? 'completed' : 'idle')
        : stopReason === 'aborted' || stopReason === 'interrupted' || stopReason === 'cancelled' ? 'cancelled'
          : 'failed'
    const at = this.engine.clock()
    await this.engine.mutate(rootId, ledger => ({
      ...ledger,
      delegations: ledger.delegations.map(d => (
        d.childId === childId && (d.state === 'starting' || d.state === 'running')
          ? { ...d, state, settledAt: at, ...(state === 'failed' ? { diagnostic: diagnostic ?? stopReason } : diagnostic !== undefined && stopReason !== 'completed' ? { diagnostic } : {}) }
          : d
      )),
    }))
    await this.refreshRoutes(rootId)
  }

  /** Read each unsettled-evidence child's request/header and record observed route and match. */
  async refreshRoutes(rootId: string): Promise<void> {
    const ledger = this.engine.peekLedger(rootId)
    if (ledger === undefined) return
    const updates = new Map<string, { observed?: LedgerRoute; routeMatch: RouteMatch }>()
    for (const d of ledger.delegations) {
      if (d.state === 'lost' || d.routeMatch === 'match' || d.routeMatch === 'mismatch') continue
      // Live agent first; a settled child is already gone from the registry, so its retained session.
      const read = observedRouteOf(this.engine.agents.get(d.childId)?.session ?? this.childSessions.get(d.childId))
      // A child that has not settled may simply not have sent its first request yet: still pending.
      const live = d.state === 'starting' || d.state === 'running'
      const routeMatch = routeMatchOf(d.selected, d.effortSource, read.observed, read.unreadable !== undefined && !live)
      if (routeMatch !== d.routeMatch || (read.observed !== undefined && d.observed === undefined)) {
        updates.set(d.childId, { ...(read.observed === undefined ? {} : { observed: read.observed }), routeMatch })
      }
    }
    if (updates.size > 0) {
      // The snapshot above can be stale by the time this write runs (another refresh may have
      // committed first), so decide against the committed record: never overwrite a decided
      // match/mismatch, and never let a missing read replace an observed route already recorded.
      await this.engine.mutate(rootId, current => {
        let changed = false
        const delegations = current.delegations.map(d => {
          const update = updates.get(d.childId)
          if (update === undefined || d.routeMatch === 'match' || d.routeMatch === 'mismatch') return d
          if (update.observed === undefined && d.observed !== undefined) return d
          changed = true
          return { ...d, ...(update.observed === undefined ? {} : { observed: update.observed }), routeMatch: update.routeMatch }
        })
        return changed ? { ...current, delegations } : undefined
      })
    }
    // Release retained sessions once they can tell nothing more: the child settled and left the
    // registry (this read was its last), or its route is already decided. Judged on the committed
    // ledger and only after the write above landed, so a concurrent refresh can still read them.
    // A cold resume re-retains.
    const committed = this.engine.peekLedger(rootId)
    if (committed === undefined) return
    for (const d of committed.delegations) {
      if (!this.childSessions.has(d.childId)) continue
      const decided = d.routeMatch === 'match' || d.routeMatch === 'mismatch' || d.state === 'lost'
      const gone = d.state !== 'starting' && d.state !== 'running' && this.engine.agents.get(d.childId) === undefined
      if (decided || gone) this.childSessions.delete(d.childId)
    }
  }

  // ── wait ───────────────────────────────────────────────────────────────────

  async wait(agent: AgentRef, childIds: readonly string[] | undefined, timeoutSeconds: number): Promise<{ delegations: readonly DelegationRecord[]; timedOut: boolean }> {
    const caller = this.callerOf(agent)
    const known = this.engine.ledgerFor(caller.rootId).delegations
    for (const id of childIds ?? []) {
      if (!known.some(d => d.childId === id)) fail(`no delegation with child id ${id} under this root`, AP_UNKNOWN_CHILD)
    }
    const targets = (childIds === undefined ? known.filter(d => d.parentId === agent.id) : known.filter(d => childIds.includes(d.childId)))
    const pending = targets.filter(d => d.state === 'starting' || d.state === 'running').map(d => this.settlements.get(d.childId)).filter((p): p is Promise<void> => p !== undefined)
    let timedOut = false
    if (pending.length > 0 && timeoutSeconds > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutSeconds * 1000); timer.unref?.() })
      const aborted = new Promise<'timeout'>((resolve) => { this.engine.signal.addEventListener('abort', () => resolve('timeout'), { once: true }) })
      const outcome = await Promise.race([Promise.all(pending).then(() => 'settled' as const), timeout, aborted])
      if (timer !== undefined) clearTimeout(timer)
      timedOut = outcome === 'timeout'
    } else if (pending.length > 0) {
      timedOut = true
    }
    await this.refreshRoutes(caller.rootId)
    const after = this.engine.ledgerFor(caller.rootId).delegations
    const ids = new Set(targets.map(d => d.childId))
    return { delegations: after.filter(d => ids.has(d.childId)), timedOut }
  }

  // ── escalate ───────────────────────────────────────────────────────────────

  async escalate(agent: AgentRef, reason: string): Promise<string> {
    const rootId = this.rootIdOf(agent)
    const self = this.engine.peekLedger(rootId)?.delegations.find(d => d.childId === agent.id)
    if (self === undefined) return fail('only a delegated child can escalate', AP_UNKNOWN_CHILD)
    if (reason.trim().length === 0) return fail('reason must not be empty', AP_INVALID_ARGUMENT)
    const at = this.engine.clock()
    await this.engine.mutate(rootId, ledger => ({
      ...ledger,
      delegations: ledger.delegations.map(d => (d.childId === agent.id ? { ...d, escalation: { reason: reason.trim(), at } } : d)),
    }))
    return 'Recorded. Your parent decides: it may re-dispatch this work with a stronger model or more effort, which starts a new child in a new context with the same contract. Finish or stop what you are doing and report; do not wait for an answer.'
  }

  // ── reviewer ───────────────────────────────────────────────────────────────

  private async review(caller: Caller, args: DelegateArgs): Promise<DelegateResult> {
    // ONE ledger snapshot at the start of the decision (MY-25 #2): exclusions come from it and
    // from nothing read later, so a dispatch that lands during routing cannot change them.
    const snapshot = this.engine.ledgerFor(caller.rootId)
    let reviewedIds: readonly string[]
    if (args.reviewedChildIds !== undefined && args.reviewedChildIds.length > 0) {
      for (const id of args.reviewedChildIds) {
        if (!snapshot.delegations.some(d => d.childId === id)) fail(`reviewedChildIds names no delegation under this root: ${id}`, AP_UNKNOWN_CHILD)
      }
      reviewedIds = args.reviewedChildIds
    } else {
      // Default: every settled non-reviewer delegation of the current goal. Delegation records carry no
      // goal id, so the goal's window starts at its first sighting; without goal info, the root's history.
      const since = snapshot.goal?.firstSeenAt
      reviewedIds = snapshot.delegations
        .filter(d => d.role !== 'reviewer' && (d.state === 'completed' || d.state === 'idle') && (since === undefined || d.startedAt >= since))
        .map(d => d.childId)
    }
    const families = new Set<string>()
    for (const d of snapshot.delegations) {
      if (!reviewedIds.includes(d.childId)) continue
      const family = familyOf(d.observed ?? d.selected)
      if (family !== undefined) families.add(family)
    }
    const decision = await this.route('reviewer', args, caller, [...families])
    const registered = this.registeredNames(caller.agent)
    const allow = allowListFor('reviewer', registered)
    const started = await this.start(caller, 'reviewer', args, decision, allow, [], new Set(), undefined, decision.why, { outputSchema: REVIEW_VERDICT_SCHEMA, delivery: 'caller' })
    const { activation, ...base } = started
    let outcome: { stopReason: string; structured?: unknown; diagnostic?: string }
    try {
      outcome = await activation!.result
    } catch (error: unknown) {
      outcome = { stopReason: 'error', diagnostic: errorMessage(error) }
    }
    const parsed = outcome.stopReason === 'completed' ? parseReviewVerdict(outcome.structured) : outcome.diagnostic ?? `the reviewer stopped with ${outcome.stopReason}`
    // The reviewer's own route is recorded when its settlement lands; wait for it so the record
    // carries the observed route rather than the selected one.
    await this.settlements.get(base.childId)
    await this.refreshRoutes(caller.rootId)
    if (typeof parsed === 'string') {
      const code: RefusalCode = outcome.stopReason === 'completed' ? AP_ROLE_VERDICT_INVALID : AP_DISPATCH_FAILED
      await this.engine.mutate(caller.rootId, ledger => ({
        ...ledger,
        delegations: ledger.delegations.map(d => (d.childId === base.childId ? { ...d, state: 'failed' as const, settledAt: this.engine.clock(), diagnostic: parsed } : d)),
      }))
      return fail(parsed, code)
    }
    const at = this.engine.clock()
    let reviewerRoute: LedgerRoute | undefined
    await this.engine.mutate(caller.rootId, (ledger) => {
      const me = ledger.delegations.find(d => d.childId === base.childId)
      reviewerRoute = me?.observed ?? me?.selected
      const record: ReviewRecord = {
        reviewerChildId: base.childId,
        reviewedChildIds: reviewedIds,
        subject: parsed.subject,
        verdict: parsed.verdict,
        findings: parsed.findings,
        ...(reviewerRoute === undefined ? {} : { reviewerRoute }),
        independence: decision.independence ?? 'reduced',
        excludedFamilies: decision.excludedFamilies,
        ...(decision.independenceNote === undefined ? {} : { independenceNote: decision.independenceNote }),
        at,
      }
      return {
        ...ledger,
        delegations: ledger.delegations.map(d => (d.childId === base.childId ? { ...d, state: 'completed' as const, settledAt: at } : d)),
        reviews: [...ledger.reviews, record],
      }
    })
    return {
      ...base,
      state: 'completed',
      review: {
        verdict: parsed.verdict,
        findings: parsed.findings,
        subject: parsed.subject,
        independence: decision.independence ?? 'reduced',
        excludedFamilies: decision.excludedFamilies,
        ...(decision.independenceNote === undefined ? {} : { independenceNote: decision.independenceNote }),
        ...(reviewerRoute === undefined ? {} : { reviewerRoute }),
      },
    }
  }

  // ── agent/created: tool restriction and the child's own tools ──────────────

  /**
   * A child agent exists and has not seen its first prompt. Restrict its tools
   * from the allow-list armed under ITS id, or (cold resume) derived from the
   * durable ledger record of that id, then give it its own tools. Fails closed:
   * a restriction that cannot be applied is rethrown so the host vetoes the
   * child's publication, and the delegation is recorded as failed.
   */
  onChildCreated(agent: AgentRef): void {
    const parentId = agent.session.header.parentSession
    if (parentId === undefined) return
    const rootId = this.rootIdOf(agent)
    let armed = this.armed.get(agent.id)
    if (armed === undefined) {
      const record = this.engine.peekLedger(rootId)?.delegations.find(d => d.childId === agent.id)
      if (record === undefined) return
      armed = { role: record.role, allow: allowListFor(record.role, this.registeredNames(agent)) }
    }
    this.armed.delete(agent.id)
    // Retain the session itself, not a snapshot: no request/header exists before the first prompt.
    this.childSessions.set(agent.id, agent.session)
    const ctx = agent.ctx as { tools?: { restrict?: (filter: { allow: readonly string[] }) => void; register?: (def: unknown) => () => void } } | undefined
    try {
      if (armed.allow !== 'inherit') this.restrict(ctx?.tools, armed.allow)
      if (ctx?.tools?.register !== undefined) {
        this.childSurfaces.get(agent.id)?.()
        this.childSurfaces.set(agent.id, installChildTools(ctx.tools as { register(d: unknown): () => void }, this.engine, armed.role))
      }
    } catch (error: unknown) {
      this.childSessions.delete(agent.id)
      const message = `tool restriction failed: ${errorMessage(error)}`
      void this.engine.mutate(rootId, ledger => ({
        ...ledger,
        delegations: ledger.delegations.map(d => (d.childId === agent.id ? { ...d, state: 'failed' as const, settledAt: this.engine.clock(), diagnostic: message } : d)),
      })).catch(() => {})
      throw error
    }
  }

  private restrict(tools: { restrict?: (filter: { allow: readonly string[] }) => void } | undefined, allow: readonly string[]): void {
    if (tools?.restrict === undefined) fail('this child has no tool restriction surface, so its allow-list cannot be applied', AP_TOOL_SURFACE_INCOMPLETE)
    try {
      tools!.restrict!.call(tools, { allow })
    } catch (error: unknown) {
      // restrict() is all-or-nothing: learn the registry from the rejection and retry once with what exists.
      const parsed = parseRestrictRejection(errorMessage(error))
      if (parsed === undefined) throw error
      this.learnedToolNames = parsed.known
      const kept = allow.filter(name => parsed.known.includes(name))
      if (!kept.includes('read')) throw error
      tools!.restrict!.call(tools, { allow: kept })
    }
  }

  /**
   * `agent/disposed` of a child. The retained session is deliberately KEPT: on
   * rc.5 this fires before the activation result resolves, so dropping it here
   * would leave the settlement refresh nothing to read; {@link refreshRoutes}
   * releases it after that read.
   */
  onChildDisposed(agent: AgentRef): void {
    this.childSurfaces.get(agent.id)?.()
    this.childSurfaces.delete(agent.id)
    this.armed.delete(agent.id)
  }
}

/** The pure part of the goal mirror: the next auto-continue status. */
export function autoContinueFor(
  ledger: Ledger,
  goal: GoalRef | undefined,
  driverPresent: boolean | undefined,
): AutoContinueStatus {
  if (ledger.hostRestart !== undefined && goal?.activation !== 'armed') {
    return { available: false, code: 'released-after-restart', reason: 'released after host restart' }
  }
  if (driverPresent === true) return { available: true, code: 'driver-present', reason: 'goal round driver present' }
  if (driverPresent === false) return { available: false, code: 'no-driver-in-composition', reason: 'no goal round driver in this composition' }
  return { available: false, code: 'unknown', reason: 'the host composition could not be inspected for a goal round driver' }
}

