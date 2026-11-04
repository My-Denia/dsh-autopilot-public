/**
 * AutopilotEngine (v3): the slim ledger writer.
 *
 * WHAT IT IS FOR. The engine holds the per-session ledger (execution, cancel,
 * resume and history display; see `./domain/ledger-types.ts`) and the few
 * host-bound jobs that need a live root agent: marking children a host restart
 * took, linking the session to its legacy runs, and the one-time lazy sandbox
 * restore for sessions the 0.2.x clamp left read-only. It is not a state
 * machine and nothing in it is a gate. The goal lives in the host's native
 * dsh-goal; the project record lives on the issue and the PR.
 *
 * SINGLE WRITER, CAS. Every ledger write goes through {@link AutopilotEngine.mutate}:
 * one lane per session inside this process, a compare-and-swap on the stored
 * revision against anything outside it, a bounded retry on conflict.
 *
 * STAGE 2 ADDS the role dispatch (`autopilot_delegate` and friends) on top of
 * `mutate`, the routing ports and the host mirrors declared here.
 */

import { AP_DISPOSED, AP_LEDGER_BUSY, AP_LEDGER_CONFLICT } from './domain/refusals.js'
import { AutopilotError, errorMessage } from './domain/types.js'
import type { AuditRole, RoutingPin } from './domain/types.js'
import type { DelegationRecord, GoalRef, Ledger, LegacyRunSummary, LinkRecord, SandboxRestoreRecord } from './domain/ledger-types.js'
import { Delegator, autoContinueFor } from './delegate.js'
import type { DelegateArgs, DelegateResult } from './delegate.js'
import type { ModelSelectionSetting } from './roles/route.js'
import { legacyClampOf, listLegacyRuns, readLegacyRun } from './legacy/index.js'
import type { LegacySources } from './legacy/index.js'
import type { CrossFamilyPolicy } from './roles/cross-family.js'
import { emptyLedger } from './store/ledger.js'
import type { LedgerStoreLike } from './store/ledger.js'
import type { RouteCatalog } from './routing/catalog.js'
import type { SessionPolicyState } from './routing/authorize.js'
import type { Role, RoleRouting, RoutePreference } from './routing/select.js'
import type { ResolvedWorkClass, WorkClassName } from './routing/work-class.js'

// ── Structural platform types (subset of dsh surfaces the engine touches) ──

/**
 * Structural subset of a dsh Session.
 *
 * dsh 0.1.2 removed the `events` array (`Session.events` → `snapshotEvents()`,
 * `seq`, `eventAt()`); a whole-log read is `snapshotEvents()` with no
 * arguments. The returned array must not be cached across `append` calls.
 * `test/host-types.test.ts` asserts that the REAL `Session` is assignable to
 * this mirror, so a host member disappearing again fails `pnpm run check`
 * instead of surfacing as `undefined` at runtime.
 */
export interface SessionReadRef {
  readonly header: { readonly parentSession?: string; readonly cwd?: string }
  snapshotEvents(): ReadonlyArray<{ readonly type: string; readonly data: unknown }>
}

/**
 * The read mirror plus the ONE event the engine writes.
 *
 * `append` is kept out of the compile-time assignability bearer on purpose:
 * `sandbox/mode` enters `SessionEventMap` by declaration merging from
 * `@deepseek-ai/dsh-sandbox-policy` (rc.1 `packages/sandbox/sandbox-policy/lib/types/session-mode.d.ts`),
 * a package this plugin deliberately does not depend on, so in this
 * package's type universe the host's generic `append<T extends SessionEventType>`
 * cannot be shown to accept it. At runtime the host lists it in
 * `KNOWN_SESSION_EVENT_TYPES` (`packages/core/session/src/known-event-types.ts:47`)
 * and the 0.1.1-rc.2 real-host rounds in DESIGN.md §8 observed the append
 * succeeding. On dsh 0.1.2-rc.1 this path is borne by tsc and the unit suite
 * only: the rc.1 smoke turn was a `lightweight` run, and the sandbox coupling
 * (and with it both appends) runs for `standard` runs alone.
 */
export interface SessionRef extends SessionReadRef {
  append(type: 'sandbox/mode', data: { readonly mode: string }): unknown
}

/** Structural subset of a dsh Agent. */
export interface AgentRef {
  readonly id: string
  readonly session: SessionRef
  readonly options?: { readonly provider?: string; readonly model?: string }
  /**
   * The agent's scoped context ([R2-P3-1], M6): present on REAL host agents
   * (upstream `Agent.ctx`), absent in tests unless deliberately stubbed. The
   * M6 planner install passes the ROOT agent's ctx to the
   * `modelSelectionInstaller` port (`installModelSelection` is agent-scoped);
   * nothing else in this plugin reads it. `unknown` on purpose: the host's
   * Context type is not imported here, and the engine never touches it beyond
   * handing it to the port.
   */
  readonly ctx?: unknown
}

/** Structural subset of ctx.agents. */
export interface AgentsRef {
  get(id: string): AgentRef | undefined
}


/**
 * One managed child on dsh 0.2.1 (`SubagentRuntime.startActivation`).
 * `result` settles when the activation does. Disposal addresses this activation.
 */
export interface SubagentActivationRef {
  readonly childId: string
  readonly result: Promise<{
    readonly stopReason: string
    readonly structured?: unknown
    readonly diagnostic?: string
  }>
  dispose(): Promise<void>
}


/**
 * Structural subset of ctx.subagents on the supported host (dsh 0.2.1-rc.5).
 *
 * `startActivation` starts a managed child and does not accept a tool filter:
 * the plugin applies the child's allow-list itself on `agent/created`, keyed by
 * the pre-assigned `childId`. `sendMessage` and `interrupt` address a direct
 * child; `drainChildren` waits for named children to settle. Hosts older than
 * rc.5 (the `start` / `startContinuable` / `drainContinuableChildren` trio) are
 * no longer supported.
 */
export interface SubagentsRef {
  startActivation(spec: {
    provider: string
    label: string
    childId?: string
    request: {
      prompt: Array<{ type: 'text'; text: string }>
      parent: unknown
      outputSchema?: object
      maxDepth?: number
      agentOptions?: AgentOptionsLike
    }
    signal: AbortSignal
    delivery: 'parent' | 'caller'
  }): Promise<SubagentActivationRef>
  /** Deliver one message to a direct continuable child (`SubagentManager.sendMessage`). */
  sendMessage(sender: unknown, targetId: string, content: Array<{ type: 'text'; text: string }>, options: {
    signal: AbortSignal
  }): Promise<unknown>
  interrupt(childId: string, authority: { kind: 'ancestor'; agent: unknown }): void
  drainChildren(parent: unknown, childIds: readonly string[]): Promise<unknown>
}

/** Explicit LLM route for a dispatched child; omitted fields inherit the deployment default. */
export interface AgentOptionsLike {
  readonly provider?: string
  readonly model?: string
  readonly maxTokens?: number
  /**
   * Reasoning effort ([R2-P3-1]): adapter-declared `defaultEffort` or a
   * lock-named value, validated at dispatch preflight (`resolveCallConfig`)
   * and NEVER invented. Wider than the 0.2.0 shape; the host's subagent
   * `agentOptions` capability accepts it.
   */
  readonly reasoningEffort?: string
}

/**
 * Resolved routing: EXACTLY what the routing core consumes —
 * `selectRoute`'s `roleRouting` (`RoleRouting` values, keys in the core's
 * role vocabulary) plus the section-level `mode` and `preference`
 * (`RouteSelectionInput.preference`). Built by `resolveConfig` in
 * `./index.ts` (which maps legacy explicit routes onto locked roles) and
 * consumed here without re-deriving anything.
 *
 * `mode: 'off'` reproduces 0.2.0 dispatch semantics on deployments without a
 * session model-selection policy — while the per-role table still resolves,
 * so locks stay visible (and enforced as plugin-config grants) in every mode.
 */
/** One owner-authored cost override, parsed from `provider/model=input/output`. */
export interface ResolvedCostOverride {
  readonly provider: string
  readonly model: string
  readonly inputPerM: number
  readonly outputPerM: number
}

/**
 * The owner's routing ladder, resolved.
 *
 * TIER NAMES ARE FIXED (economy/standard/reserve) and every field is a fixed
 * path, because Schemastery forbids a volatile field under a transform or a
 * keyed dict and `containsVolatileRef` caps the depth it will follow. An
 * owner-authored map of arbitrary tier names is therefore not expressible;
 * fixed names are, and they are what this type carries.
 *
 * ABSENT IS NOT DERIVED. Every default here is a declared literal. Nothing is
 * inferred from a model name or id: a name is not evidence about speed, cost
 * or tier, so the ladder states nothing it was not told.
 */
export interface ResolvedLadder {
  readonly tiers: Readonly<Record<'economy' | 'standard' | 'reserve', readonly string[]>>
  readonly auditTier: 'economy' | 'standard' | 'reserve' | 'none'
  /**
   * A4 (DESIGN §9 item 15): owner opt-in to engine-level re-selection at a
   * role's next dispatch. Default off — the shipped pin-stability semantics are
   * unchanged, and a healthy pin is re-selected only when the owner wrote
   * `true`. AUDITOR roles offset within their independence class; the EXECUTOR
   * offsets within the ranked survivor list by its own dispatch count, and a
   * LIVE child is never re-routed (only `startExecutor` reaches the resolver).
   */
  readonly rotation: boolean
  /** Owner-declared speed order, earliest = faster. Empty means speed is UNKNOWN. */
  readonly speedOrder: readonly string[]
  readonly costOverrides: readonly ResolvedCostOverride[]
}

export interface ResolvedRouting {
  readonly mode: 'auto' | 'off'
  /** The EFFECTIVE preference (see `preferenceSource`): what selections actually rank by. */
  readonly preference: RoutePreference
  /**
   * Whether the effective preference came from an explicit owner write or the
   * shipped default. A2 (DESIGN section 9 item 13): the explicitness ceiling of
   * the config loader applies — schemastery fills the declared default before
   * `apply()` sees the value, so a preference WRITTEN as exactly the default
   * ('balanced') is indistinguishable from an absent one and deliberately
   * counts as 'default' on BOTH config paths (the same doctrine
   * `modeIsExplicit` follows for role modes; the loader/plain deep-equality
   * fixture requires one answer). Only a non-'balanced' value proves a write.
   * 'default' is also the source when `routing.orderingAxisDefault` promoted
   * the effective preference to 'axis' — the owner opted into the promotion,
   * not into 'axis' itself.
   */
  readonly preferenceSource: 'explicit' | 'default'
  /** Every role is always present, resolved to its effective routing. */
  readonly roles: Readonly<Record<Role, RoleRouting>>
  /**
   * The owner's ladder. Present on every resolved routing (empty by default)
   * so a consumer never has to distinguish "no ladder" from "an empty one".
   */
  readonly ladder: ResolvedLadder
  /**
   * The five work classes (DESIGN §1.2; §9 items 13/14), resolved. Fixed
   * names for the same schemastery reason as the ladder tier names; the
   * owner-table mapping/axis are the declared defaults, overridable per
   * class through `routing.workClasses.<name>`. Present on every resolved
   * routing — an owner who never wrote a class gets the owner table verbatim.
   */
  readonly workClasses: Readonly<Record<WorkClassName, ResolvedWorkClass>>
}

/** Resolved plugin configuration. */
export interface ResolvedConfig {
  readonly auditProvider: string
  readonly executorProvider: string
  readonly auditors: Partial<Record<AuditRole, { provider?: string; agentOptions?: AgentOptionsLike }>>
  readonly executor: {
    readonly agentOptions?: AgentOptionsLike
    readonly persona: string
    readonly toolAllowList: readonly string[]
  }
  readonly crossFamily: CrossFamilyPolicy
  /** Role-true model routing, resolved (legacy explicit routes map to locked roles). */
  readonly routing: ResolvedRouting
  readonly gate: {
    readonly sandboxCoupling: boolean
    readonly toolDeny: boolean
    readonly egressDeny: boolean
    readonly stopReminder: boolean
    readonly strictShell: boolean
    readonly restoreMode: string
  }
  /** Copy bundled SKILL.md into the skill-scan root (`auto`) or leave it (`off`). */
  readonly skillInstall: 'auto' | 'off'
  /**
   * Governance pragmatics knobs (all optional, all OFF by default).
   * `maxAuditRoundsPerRole` brakes audit storms: beyond the cap, further
   * dispatches for that role were refused instead of
   * silently escalating to the owner.
   */
  readonly governance?: {
    readonly maxAuditRoundsPerRole?: number
    /**
     * Unattended approval policy (default off). When on, a validated egress
     * returns an immediate, visible, recoverable DENY instead of an owner ask
     * (which pends forever with nobody to answer). Never auto-approves.
     */
    readonly unattended?: boolean
  }
}

/**
 * Deployment probes the dispatch layer reads, each a thunk because the answer
 * is a property of the live host context, not of the config. Every probe is
 * optional; absent means "not observable", never a guess.
 */
export interface EnvironmentProbes {
  /**
   * The tool names the registry shows `scope` (an agent), or `undefined` when
   * the host cannot be asked. `tools.restrict()` is all-or-nothing: one name
   * the profile does not register throws and takes the dispatch with it, so an
   * allow-list request is narrowed against this view first. The scope matters:
   * a preset composition registers the model-facing tools in the preset's
   * scope layer, which the global view does not include.
   */
  readonly registeredToolNames?: (scope?: AgentRef) => readonly string[] | undefined
  /**
   * The host's resolved default sandbox mode (`ctx.sandboxPolicy.defaultMode`),
   * or `undefined` when it cannot be read. The lazy clamp restore writes it when
   * a legacy run recorded no prior mode, because the host has no way to delete
   * a per-session override.
   */
  readonly sandboxDefaultMode?: () => string | undefined
  /** The user's native subagent `maxDepth` setting (`ctx.subagents.config.maxDepth`), or `undefined` when unreadable. */
  readonly subagentMaxDepth?: () => number | undefined
  /** The user's native `subagentModelSelection` setting, or `undefined` when unreadable or off. */
  readonly modelSelection?: () => ModelSelectionSetting | undefined
  /** The session's native dsh-goal (`ctx.goals.get`), or `undefined` when the service or the goal is absent. */
  readonly readGoal?: (root: AgentRef) => NativeGoalView | undefined
  /** Whether the composition has an ACTIVE goal round driver: true, false, or `undefined` when it cannot be inspected. */
  readonly goalDriverPresent?: () => boolean | undefined
}

/** The slice of the host's goal view the ledger mirrors (`dsh-goal` `GoalView`). */
export interface NativeGoalView {
  readonly id: string
  readonly revision: number
  readonly objective: string
  readonly phase: string
  readonly maxGoalRounds: number
  readonly roundsStarted: number
  readonly activation: 'armed' | 'disarmed'
  readonly blockedReason?: { readonly code: string; readonly message: string }
}

/**
 * The latest `request/header` route from a child session — the OBSERVED leg of
 * route evidence.
 *
 * `request/header` is a durable session event (`{header: {config: {provider,
 * model, reasoningEffort?, …}}, reason}`); the LATEST snapshot reconstructs
 * the request the child actually sent, which is the only proof of the request
 * route (`Agent.options` prove creation only — plan-gate R1 P1). The read is
 * defensive by contract: an unreadable session, a throwing `snapshotEvents`,
 * or a header with no well-formed config degrades to `{unreadable}` naming
 * which read failed, NEVER to a throw — route evidence must not be able to
 * break a verdict path ([R2-P3-3]: the feature degrades, it does not block).
 */
export function observedRouteOf(session: SessionReadRef | undefined): {
  readonly observed?: RoutingPin
  readonly unreadable?: string
} {
  if (session === undefined) return { unreadable: 'child session not readable' }
  let events: ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  try {
    events = session.snapshotEvents()
  } catch (error) {
    return { unreadable: `child session read failed: ${errorMessage(error)}` }
  }
  let observed: RoutingPin | undefined
  for (const event of events) {
    if (event.type !== 'request/header') continue
    const config = (event.data as {
      readonly header?: { readonly config?: { readonly provider?: unknown; readonly model?: unknown; readonly reasoningEffort?: unknown } }
    } | undefined)?.header?.config
    if (config === undefined || typeof config.provider !== 'string' || typeof config.model !== 'string') continue
    observed = {
      provider: config.provider,
      model: config.model,
      ...(typeof config.reasoningEffort === 'string' ? { reasoningEffort: config.reasoningEffort } : {}),
    }
  }
  return observed === undefined
    ? { unreadable: 'no well-formed request/header event in the child session' }
    : { observed }
}

/** Effective sandbox mode from a session log (last 'sandbox/mode' event wins). */
export function effectiveSandboxMode(events: ReadonlyArray<{ type: string; data: unknown }>): string | undefined {
  let mode: string | undefined
  for (const event of events) {
    if (event.type === 'sandbox/mode') {
      const data = event.data as { mode?: string } | undefined
      if (data?.mode !== undefined) mode = data.mode
    }
  }
  return mode
}

/**
 * Routing ports (M3b): the live facts the routing core needs that the
 * engine cannot derive — the catalog of live routes, the session
 * model-selection policy, and (M6) the planner's model-selection installer.
 * ALL OPTIONAL AND DEFENSIVE BY DESIGN: a test (or a host profile with neither
 * `llm` nor `sessionProjections` observable) constructs the engine unchanged,
 * and absent ports mean routing resolves to 0.2.0/inherit dispatch behavior
 * with `authorizationSource: 'unreachable-inherit'` recorded on auto
 * decisions — never a blocked dispatch that 0.2.0 would have made. An absent
 * installer port likewise degrades a non-inherit planner decision to
 * inheritance with `plannerRouting: 'unsupported'` recorded (M6).
 */
export interface RoutingPorts {
  /** The E1 catalog port (snapshot cache + exact facts + preflight). `undefined` ⇒ no explicit selection or preflight. */
  readonly catalog?: RouteCatalog
  /** Reads the durable session model-selection policy for the run's root session. */
  readonly policyReader?: (root: AgentRef) => SessionPolicyState
  /**
   * M6 planner install port: couples a model selection to one agent's scoped
   * ctx (the host's `installModelSelection`). Returns the DISPOSER, or
   * `undefined` when the installer declines — both outcomes the engine
   * records; a THROWING installer is caught and recorded, never fatal. The
   * durable model-switch notice is the host's own; GAH adds nothing to the
   * session. Wired by DYNAMIC import in `./index.ts`; absence of the host
   * export leaves this port `undefined`.
   */
  readonly modelSelectionInstaller?: (
    agentCtx: unknown,
    route: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string },
  ) => (() => void) | undefined
}


/** Sandbox modes the host accepts on a `sandbox/mode` event. */
export const SANDBOX_MODES: readonly string[] = ['read-only', 'workspace-write', 'danger-full-access']

/** Everything the engine takes besides the stores and the config; all optional. */
export interface EnginePorts {
  readonly routing?: RoutingPorts
  /**
   * The routing section re-read per decision (wired exactly when the routing
   * leaves arrived as volatile references, where a config patch updates them in
   * place). Absent: `config.routing` IS the live routing.
   */
  readonly liveRouting?: () => ResolvedRouting
  readonly environment?: EnvironmentProbes
  /** ISO-8601 clock; tests inject one. */
  readonly now?: () => string
  /** Plain diagnostics (never a refusal): a restore that failed, a legacy read that threw. */
  readonly warn?: (message: string) => void
}

/** Bounded retries of a ledger CAS that lost to a writer outside this process. */
const MAX_CONFLICT_RETRIES = 4

/** What {@link AutopilotEngine.onRootOpened} did, for tests and diagnostics. */
export interface RootOpenedOutcome {
  readonly lostChildIds: readonly string[]
  /** Run ids whose lazy restore was recorded by this call. */
  readonly restoredRunIds: readonly string[]
}

const isoNow = (): string => new Date().toISOString()

/** The autopilot ledger engine. One instance per plugin mount. */
export class AutopilotEngine {
  private readonly lifecycle = new AbortController()
  /** One lane per session: ledger writes of this process never interleave. */
  private readonly lanes = new Map<string, Promise<unknown>>()
  /** Root opens in flight, so dispose can wait for them. */
  private readonly inflight = new Set<Promise<unknown>>()
  /** The last open of each session: two opens of one session run one after the other, never together. */
  private readonly openTails = new Map<string, Promise<unknown>>()
  /** The frozen legacy listing, read once per mount (the streams no longer change). */
  private legacyListing: Promise<readonly LegacyRunSummary[]> | undefined
  private readonly now: () => string
  private readonly warn: (message: string) => void
  private readonly delegator: Delegator

  constructor(
    readonly agents: AgentsRef,
    readonly subagents: SubagentsRef,
    readonly ledgers: LedgerStoreLike,
    readonly sources: LegacySources,
    readonly config: ResolvedConfig,
    readonly ports: EnginePorts = {},
  ) {
    this.now = ports.now ?? isoNow
    this.warn = ports.warn ?? (() => {})
    this.delegator = new Delegator(this)
  }

  /** A plain diagnostic through the mount's warn channel. */
  report(message: string): void {
    this.warn(`dsh-autopilot: ${message}`)
  }

  // ── Delegation (see ./delegate.ts) ─────────────────────────────────────────

  delegate(caller: AgentRef, args: DelegateArgs): Promise<DelegateResult> {
    return this.delegator.delegate(caller, args)
  }

  wait(caller: AgentRef, childIds: readonly string[] | undefined, timeoutSeconds: number) {
    return this.delegator.wait(caller, childIds, timeoutSeconds)
  }

  escalate(child: AgentRef, reason: string): Promise<string> {
    return this.delegator.escalate(child, reason)
  }

  /** `agent/created` of a child: apply its armed or ledger-derived tool allow-list, then give it its own tools. Throws to veto. */
  onChildCreated(child: AgentRef): void {
    this.delegator.onChildCreated(child)
  }

  onChildDisposed(child: AgentRef): void {
    this.delegator.onChildDisposed(child)
  }

  rootIdOf(agent: AgentRef): string {
    return this.delegator.rootIdOf(agent)
  }

  /** Record observed routes of this root's children from their request headers. */
  refreshRoutes(rootId: string): Promise<void> {
    return this.delegator.refreshRoutes(rootId)
  }

  // ── Goal mirror and links ──────────────────────────────────────────────────

  /**
   * Mirror the session's native goal into the ledger and recompute auto-continue.
   * A session with a goal gets a ledger even when nothing was dispatched (the card
   * anchors on it); a session with neither a goal nor a ledger gets none. Never throws.
   */
  async syncGoal(root: AgentRef): Promise<void> {
    try {
      const env = this.ports.environment
      let view: ReturnType<NonNullable<EnvironmentProbes['readGoal']>>
      try { view = env?.readGoal?.(root) } catch { view = undefined }
      if (view === undefined && this.ledgers.load(root.id) === undefined) return
      const driver = env?.goalDriverPresent?.()
      if (view === undefined && driver === undefined) return
      await this.mutate(root.id, (ledger) => {
        const at = this.now()
        let goal = ledger.goal
        let previousGoals = ledger.previousGoals
        let changed = false
        if (view !== undefined) {
          const same = goal?.goalId === view.id
          const next: GoalRef = {
            goalId: view.id,
            revision: view.revision,
            status: view.phase,
            objective: view.objective,
            activation: view.activation,
            roundsStarted: view.roundsStarted,
            maxGoalRounds: view.maxGoalRounds,
            ...(view.blockedReason === undefined ? {} : { blockedReason: view.blockedReason }),
            firstSeenAt: same ? goal!.firstSeenAt : at,
            lastSeenAt: at,
          }
          const { lastSeenAt: _a, ...nextCore } = next
          const { lastSeenAt: _b, ...goalCore } = goal ?? { lastSeenAt: '' }
          if (goal === undefined || JSON.stringify(nextCore) !== JSON.stringify(goalCore)) {
            if (goal !== undefined && !same && !previousGoals.some(g => g.goalId === goal!.goalId)) previousGoals = [...previousGoals, goal]
            goal = next
            changed = true
          }
        }
        const autoContinue = autoContinueFor({ ...ledger, ...(goal === undefined ? {} : { goal }) }, goal, driver)
        const sameAuto = autoContinue.available === ledger.autoContinue.available && autoContinue.code === ledger.autoContinue.code && autoContinue.reason === ledger.autoContinue.reason
        if (!changed && sameAuto) return undefined
        return { ...ledger, ...(goal === undefined ? {} : { goal }), previousGoals, autoContinue }
      })
    } catch (error: unknown) {
      this.report(`mirroring the goal of session ${root.id} failed: ${errorMessage(error)}`)
    }
  }

  /** Append an issue or PR link; idempotent on (kind, ref), which only fills a missing url. */
  async addLink(rootId: string, link: { readonly kind: 'issue' | 'pr'; readonly ref: string; readonly url?: string }): Promise<Ledger | undefined> {
    return await this.mutate(rootId, (ledger) => {
      const existing = ledger.links.find(l => l.kind === link.kind && l.ref === link.ref)
      if (existing !== undefined) {
        if (existing.url !== undefined || link.url === undefined) return undefined
        return { ...ledger, links: ledger.links.map(l => (l === existing ? { ...l, url: link.url! } : l)) }
      }
      const added: LinkRecord = { kind: link.kind, ref: link.ref, ...(link.url === undefined ? {} : { url: link.url }), at: this.now() }
      return { ...ledger, links: [...ledger.links, added] }
    })
  }

  /** The routing ports (catalog, policy reader, installer); empty when none was wired. */
  get routingPorts(): RoutingPorts {
    return this.ports.routing ?? {}
  }

  /** The live routing section: re-read per decision when the config is volatile. */
  routing(): ResolvedRouting {
    return this.ports.liveRouting?.() ?? this.config.routing
  }

  /** The clock the ledger records use. */
  clock(): string {
    return this.now()
  }

  /** The signal that aborts on dispose; stage 2 passes it to every host call. */
  get signal(): AbortSignal {
    return this.lifecycle.signal
  }

  // ── Ledger access ──────────────────────────────────────────────────────────

  /** The stored ledger of a root session, or `undefined` when it has never written one. */
  peekLedger(sessionId: string): Ledger | undefined {
    return this.ledgers.load(sessionId)
  }

  /** The stored ledger, or a fresh revision-0 one that is not written until the first mutation. */
  ledgerFor(sessionId: string): Ledger {
    return this.ledgers.load(sessionId) ?? emptyLedger(sessionId, this.now())
  }

  /**
   * Change one session's ledger.
   *
   * `fn` receives the current ledger (fresh at revision 0 when none exists) and
   * returns the next one, or `undefined` for "nothing to write". On a revision
   * conflict with a writer outside this process the ledger is reloaded and `fn`
   * runs again, up to a bound; then {@link AP_LEDGER_BUSY}.
   *
   * @returns the stored ledger, or `undefined` when `fn` declined to write.
   * @throws AutopilotError AP_DISPOSED after dispose; AP_LEDGER_BUSY when the retries ran out.
   */
  mutate(sessionId: string, fn: (ledger: Ledger) => Ledger | undefined): Promise<Ledger | undefined> {
    if (this.lifecycle.signal.aborted) {
      return Promise.reject(new AutopilotError('the autopilot engine is disposed', AP_DISPOSED))
    }
    const run = async (): Promise<Ledger | undefined> => {
      let lastConflict: unknown
      for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt += 1) {
        const base = this.ledgerFor(sessionId)
        const next = fn(base)
        if (next === undefined) return undefined
        try {
          return await this.ledgers.write(next, base.revision)
        } catch (error: unknown) {
          if (!(error instanceof AutopilotError) || error.code !== AP_LEDGER_CONFLICT) throw error
          lastConflict = error
          this.ledgers.reload?.(sessionId)
        }
      }
      throw new AutopilotError(
        `ledger ${JSON.stringify(sessionId)} kept changing under this write: ${errorMessage(lastConflict)}`,
        AP_LEDGER_BUSY,
      )
    }
    const tail = this.lanes.get(sessionId) ?? Promise.resolve()
    const result = tail.then(run, run)
    const settled = result.then(() => undefined, () => undefined)
    this.lanes.set(sessionId, settled)
    void settled.then(() => {
      if (this.lanes.get(sessionId) === settled) this.lanes.delete(sessionId)
    })
    return result
  }

  // ── Root session opened ────────────────────────────────────────────────────

  /**
   * A root session was opened or resumed (`agent/created` of a root agent, and
   * each root already live at mount). Three jobs, each idempotent:
   *
   * 1. Children the ledger believes are `starting` or `running` but the host no
   *    longer holds (`agents.get(childId)` is undefined) become `lost`; the
   *    first time that happens the ledger gets the host-restart marker and
   *    auto-continue is released.
   * 2. The session's legacy run ids are recorded on the ledger.
   * 3. The lazy sandbox restore for the legacy runs of this session (see
   *    {@link restoreLegacyClamps}).
   *
   * A session with nothing to record gets NO ledger: a simple session leaves no
   * footprint. Never rejects: a failure is reported through `warn`, because the
   * caller sits inside the host's serial `agent/created` listener, where a
   * rejection would veto the agent's publication.
   */
  onRootOpened(root: AgentRef, skipChildIds: ReadonlySet<string> = new Set()): Promise<RootOpenedOutcome> {
    // Serialized per session: the restore decides from the session log BEFORE it appends, so two
    // concurrent opens of one session would each see the clamp and each append.
    const tail = this.openTails.get(root.id) ?? Promise.resolve()
    const work: Promise<RootOpenedOutcome> = tail
      .then(() => this.openRoot(root, skipChildIds))
      .then(async (outcome) => { await this.syncGoal(root); return outcome })
      .catch((error: unknown): RootOpenedOutcome => {
        this.warn(`dsh-autopilot: opening session ${root.id} failed: ${errorMessage(error)}`)
        return { lostChildIds: [], restoredRunIds: [] }
      })
    this.openTails.set(root.id, work)
    this.inflight.add(work)
    void work.then(() => {
      this.inflight.delete(work)
      if (this.openTails.get(root.id) === work) this.openTails.delete(root.id)
    })
    return work
  }

  private legacyRuns(): Promise<readonly LegacyRunSummary[]> {
    if (this.legacyListing === undefined) {
      this.legacyListing = listLegacyRuns(this.sources).catch((error: unknown) => {
        this.legacyListing = undefined
        throw error
      })
    }
    return this.legacyListing
  }

  private async openRoot(root: AgentRef, skipChildIds: ReadonlySet<string>): Promise<RootOpenedOutcome> {
    const sessionId = root.id
    const lost = this.lostCandidates(sessionId, skipChildIds)
    const runs = (await this.legacyRuns()).filter(run => run.sessionId === sessionId)
    // Decide the restores BEFORE the ledger write and apply the host append first:
    // a ledger write that fails afterwards leaves a session whose clamp is already
    // gone, so the next open finds nothing to undo and cannot write twice.
    const restores = await this.restoreLegacyClamps(root, runs)
    const runIds = runs.map(run => run.runId)
    const recordsNew = runIds.some(id => !this.ledgerFor(sessionId).legacyRunIds.includes(id))
    if (lost.length === 0 && Object.keys(restores).length === 0 && !recordsNew) {
      return { lostChildIds: [], restoredRunIds: [] }
    }
    const lostIds: string[] = []
    await this.mutate(sessionId, (ledger) => {
      // Re-derive inside the CAS: a concurrent dispatch may have changed the ledger.
      const gone = ledger.delegations.filter(d => this.isLostCandidate(d, skipChildIds))
      lostIds.splice(0, lostIds.length, ...gone.map(d => d.childId))
      const at = this.now()
      const known = new Set(ledger.legacyRunIds)
      const legacyRunIds = [...ledger.legacyRunIds, ...runIds.filter(id => !known.has(id))]
      const legacyRestores = { ...(ledger.legacyRestores ?? {}) }
      for (const [runId, record] of Object.entries(restores)) legacyRestores[runId] ??= record
      const sameRestores = Object.keys(legacyRestores).length === Object.keys(ledger.legacyRestores ?? {}).length
      if (gone.length === 0 && legacyRunIds.length === ledger.legacyRunIds.length && sameRestores) return undefined
      return {
        ...ledger,
        delegations: ledger.delegations.map(d => (gone.includes(d) ? lostRecord(d, at) : d)),
        ...(gone.length === 0
          ? {}
          : {
              hostRestart: { at, lostChildIds: [...(ledger.hostRestart?.lostChildIds ?? []), ...gone.map(d => d.childId)] },
              autoContinue: { available: false, code: 'released-after-restart', reason: 'released after host restart' },
            }),
        legacyRunIds,
        legacyRestores,
      }
    })
    return { lostChildIds: lostIds, restoredRunIds: Object.keys(restores) }
  }

  private isLostCandidate(d: DelegationRecord, skip: ReadonlySet<string>): boolean {
    return (d.state === 'starting' || d.state === 'running') && !skip.has(d.childId) && this.agents.get(d.childId) === undefined
  }

  private lostCandidates(sessionId: string, skip: ReadonlySet<string>): readonly DelegationRecord[] {
    return (this.ledgers.load(sessionId)?.delegations ?? []).filter(d => this.isLostCandidate(d, skip))
  }

  // ── Lazy sandbox restore ───────────────────────────────────────────────────

  /**
   * Undo, once, the read-only clamp a 0.2.x run left on this session.
   *
   * WHY LAZY AND CONSERVATIVE. The clamp was an ordinary `sandbox/mode` event, so
   * the session may have been changed by its owner since. Writing the old mode
   * back blindly would override that. A run is restored only when the session's
   * CURRENT mode is still `read-only` and the LAST `sandbox/mode` event is the
   * clamp: `read-only`, carrying no `source` field, directly after the event that
   * set the mode the run recorded as its prior (or the first mode event, when the
   * run recorded none). Anything else is left alone and recorded.
   *
   * THE TARGET. The run's recorded prior mode when it has one. Otherwise the host
   * offers no way to remove a per-session override (the sandbox policy fold has no
   * clear event, and writing an off-type mode into the durable log is not a
   * supported clear), so the host's resolved default mode is written, recorded as
   * `default-written`; when that default cannot be read the outcome is `failed`
   * and no mode is invented.
   *
   * Runs already recorded in `ledger.legacyRestores` are skipped, so a second open
   * appends nothing. At most ONE event is appended per call: every matching run
   * shares the outcome.
   *
   * @returns the outcome per run id that still needed one (not yet in the ledger).
   */
  private async restoreLegacyClamps(
    root: AgentRef,
    runs: readonly LegacyRunSummary[],
  ): Promise<Record<string, SandboxRestoreRecord>> {
    const recorded = this.ledgers.load(root.id)?.legacyRestores ?? {}
    const pending = runs.filter(run => run.sandboxRestore.state === 'pending' && recorded[run.runId] === undefined)
    if (pending.length === 0) return {}

    const modeEvents = readModeEvents(root)
    const out: Record<string, SandboxRestoreRecord> = {}
    const at = this.now()
    const matching: Array<{ runId: string; prior: string | undefined }> = []
    for (const run of pending) {
      const read = await readLegacyRun(this.sources, run.runId).catch(() => undefined)
      if (read?.snapshot === undefined) {
        out[run.runId] = { state: 'failed', at, note: 'the legacy run could not be read, so its clamp was not examined' }
        continue
      }
      const clamp = legacyClampOf(read.snapshot)
      if (modeEvents === undefined) {
        out[run.runId] = { state: 'failed', at, note: 'the session log could not be read, so the clamp was not examined' }
      } else if (modeEvents.length === 0) {
        out[run.runId] = { state: 'not-clamped', at, note: 'the session log holds no sandbox/mode event' }
      } else if (isOwnClamp(modeEvents, clamp.priorSandboxMode)) {
        matching.push({ runId: run.runId, prior: clamp.priorSandboxMode })
      } else {
        out[run.runId] = { state: 'untouched-user-changed', at }
      }
    }
    if (matching.length === 0) return out

    // Every matching run proved the same prior (it equals the mode event before the clamp),
    // so one append serves them all.
    const prior = matching[0]!.prior
    let record: SandboxRestoreRecord
    if (prior !== undefined) {
      record = this.appendMode(root, prior, 'restored', at)
    } else {
      const fallback = this.ports.environment?.sandboxDefaultMode?.()
      if (fallback === undefined || !SANDBOX_MODES.includes(fallback)) {
        record = {
          state: 'failed',
          at,
          note: 'no prior sandbox mode was recorded and the host default mode is not readable; the session was left read-only',
        }
      } else if (fallback === 'read-only') {
        record = { state: 'default-written', mode: 'read-only', at, note: 'the host default is read-only; there was nothing to write' }
      } else {
        record = this.appendMode(root, fallback, 'default-written', at)
      }
    }
    for (const { runId } of matching) out[runId] = record
    return out
  }

  private appendMode(root: AgentRef, mode: string, state: 'restored' | 'default-written', at: string): SandboxRestoreRecord {
    if (!SANDBOX_MODES.includes(mode)) {
      return { state: 'failed', at, note: `"${mode}" is not a sandbox mode the host knows; the session was left read-only` }
    }
    try {
      root.session.append('sandbox/mode', { mode })
      return { state, mode, at }
    } catch (error: unknown) {
      return { state: 'failed', at, note: `appending the sandbox mode failed: ${errorMessage(error)}` }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Dispose: refuse new writes, then wait (bounded, 5s) for root opens and
   * queued ledger writes to settle. Their errors are already contained.
   */
  async dispose(): Promise<void> {
    this.lifecycle.abort(new AutopilotError('the autopilot engine is disposed', AP_DISPOSED))
    const pending = [...this.inflight, ...this.lanes.values()]
    if (pending.length === 0) return
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => { setTimeout(resolve, 5000).unref?.() }),
    ])
  }
}

function lostRecord(d: DelegationRecord, at: string): DelegationRecord {
  return { ...d, state: 'lost', settledAt: at, diagnostic: 'the host restarted while this child was running' }
}

type ModeEvent = { readonly mode: string; readonly hasSource: boolean }

/** Every `sandbox/mode` event of the session in log order, or `undefined` when the log cannot be read. */
function readModeEvents(root: AgentRef): readonly ModeEvent[] | undefined {
  let events: ReturnType<SessionReadRef['snapshotEvents']>
  try {
    events = root.session.snapshotEvents()
  } catch {
    return undefined
  }
  const out: ModeEvent[] = []
  for (const event of events) {
    if (event.type !== 'sandbox/mode') continue
    const data = event.data as { mode?: unknown } | null | undefined
    if (typeof data?.mode !== 'string') continue
    out.push({ mode: data.mode, hasSource: data !== null && typeof data === 'object' && 'source' in data })
  }
  return out
}

/**
 * True when the session's last `sandbox/mode` event is this plugin's clamp: a
 * `read-only` with no `source` field, directly after the event that set the
 * mode the run recorded as its prior (or the only mode event, when none was).
 */
function isOwnClamp(modeEvents: readonly ModeEvent[], prior: string | undefined): boolean {
  const last = modeEvents[modeEvents.length - 1]
  if (last === undefined || last.mode !== 'read-only' || last.hasSource) return false
  const before = modeEvents[modeEvents.length - 2]
  return before === undefined ? prior === undefined : before.mode === prior
}
