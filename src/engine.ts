/**
 * AutopilotEngine: the single-writer run state machine.
 *
 * Authority pattern (from dsh's experimental GAH, reimplemented): every public
 * mutation validates the exact live root Agent (registered, identical object,
 * no durable parentSession). Auditor verdicts arrive in-band from one-shot
 * subagents with structured output schemas — provenance is structural, not
 * forensic. All state transitions are validated by the domain fold before
 * they are persisted.
 */

import { randomUUID } from 'node:crypto'
import { applyEvent } from './domain/fold.js'
import {
  AutopilotError,
  MAX_REPLAN_ROUNDS,
  MAX_STOP_REMINDERS,
  TERMINAL_PHASES,
  canonicalBearer,
  errorMessage,
  evaluateCompletion,
  evidenceKindProblems,
  isAbsoluteShapedBearer,
  latestVerdicts,
  requiredRoles,
  validateTriage,
  validateExternalReview,
  compareDeclaredTree,
} from './domain/types.js'
import type {
  AuditRecord,
  AuditRole,
  CrossFamilyOutcome,
  ExternalReview,
  Risk,
  Closeout,
  EgressChannel,
  Enforcement,
  ExecutorRecord,
  LogEntry,
  Operation,
  OwnerApproval,
  RouteRecord,
  RoutingDecisionDetail,
  RoutingPin,
  RunEvent,
  RunId,
  Snapshot,
  Stance,
  Triage,
  UsageEntry,
  UsageEvidence,
  Verdict,
} from './domain/types.js'
import { applyRoutingDecision } from './domain/types.js'
import { settleExternalReviews, settleUsageArtifacts, usageDeclarationProblems, validateUsageEntry } from './domain/usage.js'
import { SHELL_TOOLS, egressSegments, isEgressCommand } from './gate/decide.js'
import { matchesAtTokenBoundary } from './outbound/manifest.js'
import type { RunStoreLike } from './store/types.js'
import { selectRoute } from './routing/select.js'
import type { Role, RoleRouting, RoutePreference, SelectionDecision } from './routing/select.js'
import { resolvePluginGrant } from './routing/authorize.js'
import type { GrantSource, SessionPolicyState } from './routing/authorize.js'
import { RouteCatalog, providerIsLive } from './routing/catalog.js'
import { independenceOf, sameRoute, toRoutePin } from './routing/identity.js'
import type { RoutePin } from './routing/identity.js'

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

/** Structural subset of a one-shot SubagentRun. */
export interface SubagentRunRef {
  readonly id: string
  readonly localAgent?: AgentRef
  readonly result: Promise<{
    readonly stopReason: string
    readonly structured?: unknown
    readonly diagnostic?: string
  }>
  dispose(): Promise<void>
}

/** Structural subset of ctx.subagents. */
export interface SubagentsRef {
  start(provider: string, request: {
    prompt: Array<{ type: 'text'; text: string }>
    parent: unknown
    outputSchema: object
    maxDepth: number
    toolFilter: { allow: readonly string[] }
    signal: AbortSignal
    agentOptions?: AgentOptionsLike
  }): Promise<SubagentRunRef>
  startContinuable(spec: {
    childId: string
    provider: string
    label: string
    request: {
      prompt: Array<{ type: 'text'; text: string }>
      parent: unknown
      persona?: string
      toolFilter?: { allow: readonly string[] }
      agentOptions?: AgentOptionsLike
    }
    signal: AbortSignal
  }): Promise<unknown>
  /**
   * Deliver one message to a direct continuable child (`SubagentManager.sendMessage`).
   * The host derives sender attribution from the exact live `sender`. This is
   * the resume transport: the manager has had no `followup` since at least
   * dsh 0.1.2-rc.1 (checked against the published 0.1.2-rc.1, 0.1.5-rc.1,
   * 0.1.7-rc.2 and 0.2.0-rc.2 packages), so the earlier call threw
   * `followup is not a function` on every real host.
   */
  sendMessage(sender: unknown, targetId: string, content: Array<{ type: 'text'; text: string }>, options: {
    signal: AbortSignal
  }): Promise<unknown>
  interrupt(childId: string, authority: { kind: 'ancestor'; agent: unknown }): void
  drainContinuableChildren(parent: unknown, childIds: readonly string[]): Promise<unknown>
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
export interface ResolvedRouting {
  readonly mode: 'auto' | 'off'
  readonly preference: RoutePreference
  /** Every role is always present, resolved to its effective routing. */
  readonly roles: Readonly<Record<Role, RoleRouting>>
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
}

/**
 * Read-only tool names REQUESTED for auditors (no write, no shell, no delegation).
 *
 * REQUESTED, not granted: see {@link resolveToolAllow}. This plugin does not
 * own the tool vocabulary, and `tools.restrict()` is ALL-OR-NOTHING — one name
 * the running profile does not register throws and takes the whole dispatch
 * with it.
 *
 * `ask_user_question` WAS REMOVED (2026-08-25) after the first run against a
 * real dsh host, and removed outright rather than left to narrowing, because it
 * was wrong on two independent grounds:
 *
 *  1. IT IS NOT REGISTERED HEADLESS. Upstream it lives in
 *     `packages/interaction/tool-ask-user`, which the shipped headless profile
 *     does not load, so every `audit()` died at dispatch with
 *     `tools.restrict() names unknown global tool "ask_user_question"`.
 *  2. AN AUDITOR HAS NOBODY TO ASK. Audits are dispatched as one-shot
 *     `maxDepth: 1` subagents with a structured output schema, and the engine
 *     resolves on the child's first stop. There is no interactive turn on which
 *     a human answer could arrive, so even on a profile that DOES register the
 *     tool the entry granted a capability this dispatch shape cannot use.
 *
 * Ground (1) is why this is a high-severity fix and not a tidy-up.
 * `auditMode: 'independent'` is the only audit mode a standard or delegated run
 * may hold — `validateTriage` allows `self-check` for lightweight+low only, and
 * `delegated` execution forbids lightweight — so while this list was
 * undispatchable NO standard and NO delegated run could reach a passing plan
 * gate, and therefore none could ever reach `completed`.
 */

/**
 * The family key of one route. The PROVIDER is what "family" means
 * operationally — a different vendor or gateway, and so a different training
 * and failure distribution. Two models behind one provider are deliberately
 * NOT different families: treating them as such would let a blind spot shared
 * by that provider pass both gates while the record claimed independence.
 */
export function familyOf(options: AgentOptionsLike | undefined): string | undefined {
  const provider = options?.provider?.trim()
  return provider !== undefined && provider.length > 0 ? provider : undefined
}

/** Inputs to cross-family selection. Pure, so the policy is testable without a dispatch. */
export interface CrossFamilySelection {
  readonly risk: Risk
  /** What role-level config already resolved to; the starting point. */
  readonly configured: AgentOptionsLike | undefined
  /** The executor's route — the family a reviewer should NOT share. */
  readonly executor: AgentOptionsLike | undefined
  readonly policy: CrossFamilyPolicy
}

/** Resolved cross-family policy. */
export interface CrossFamilyPolicy {
  readonly enabled: boolean
  /** Risk at which cross-family review starts being sought. */
  readonly minRisk: Risk
  /** Candidate auditor routes to draw an out-of-family reviewer from. */
  readonly pool: readonly AgentOptionsLike[]
}

/** What to dispatch with, and what may honestly be claimed about it. */
export interface CrossFamilyChoice {
  readonly agentOptions: AgentOptionsLike | undefined
  readonly outcome: CrossFamilyOutcome
  readonly diagnostic?: string
}

const RISK_ORDER: readonly Risk[] = ['low', 'medium', 'high', 'critical']

/**
 * Pick the auditor route for one dispatch, preferring a family the executor is
 * not from once risk reaches the configured floor.
 *
 * A ROUTING STRATEGY, not a gate. A deployment with one provider is a
 * legitimate deployment, and refusing to audit there would be worse than
 * auditing same-family and SAYING so — which is exactly what the outcome
 * field is for. The CC lineage's rule is "builder family is not reviewer
 * family", and its reason is that a blind spot shared by one family passes
 * both gates unchallenged; recording `same-family` is how a reader learns the
 * two gates were not independent on that run.
 */
export function selectCrossFamily(selection: CrossFamilySelection): CrossFamilyChoice {
  const { policy } = selection
  if (!policy.enabled || RISK_ORDER.indexOf(selection.risk) < RISK_ORDER.indexOf(policy.minRisk)) {
    return { agentOptions: selection.configured, outcome: 'not-required' }
  }
  const builder = familyOf(selection.executor)
  const configured = familyOf(selection.configured)
  if (builder === undefined) {
    return {
      agentOptions: selection.configured,
      outcome: 'unknown-family',
      diagnostic: 'the executor route inherits the deployment default, so the family it builds with is not observable here; cross-family can be claimed neither way',
    }
  }
  if (configured !== undefined && configured !== builder) {
    return { agentOptions: selection.configured, outcome: 'achieved' }
  }
  const alternative = policy.pool.find((candidate) => {
    const family = familyOf(candidate)
    return family !== undefined && family !== builder
  })
  if (alternative !== undefined) return { agentOptions: alternative, outcome: 'achieved' }
  if (configured === undefined) {
    return {
      agentOptions: selection.configured,
      outcome: 'unknown-family',
      diagnostic: `no configured auditor route and no pool entry outside the builder family "${builder}"; the dispatched family is whatever the deployment defaults to`,
    }
  }
  return {
    agentOptions: selection.configured,
    outcome: 'same-family',
    diagnostic: `auditor and executor are both family "${builder}" and the pool offers no alternative; a blind spot shared by that family passes both gates unchallenged`,
  }
}

export const AUDITOR_TOOL_ALLOW: readonly string[] = ['read', 'glob', 'grep', 'read_image']

/**
 * Auditor names narrowing may NEVER drop.
 *
 * An auditor that cannot `read` is not a weaker auditor, it is a rubber stamp:
 * it still returns a schema-valid `pass` that the gate accepts, having seen
 * nothing. Silently narrowing onto that surface would be a worse defect than
 * the one narrowing exists to fix, so a deployment that does not register these
 * names fails the dispatch loudly instead.
 */
export const AUDITOR_TOOL_REQUIRED: readonly string[] = ['read']

/**
 * Interchangeable capability families, used by {@link resolveToolAllow}.
 *
 * A family is what lets narrowing tell "this deployment SPELLS the capability
 * differently" apart from "this deployment does not HAVE the capability".
 * Losing `bash` on a Windows host that registers `pwsh` is the first and is
 * fine; losing every shell name the caller asked for is the second and is not.
 * Only the second is an error, and expressing the rule over families the
 * REQUEST named keeps it config-respecting: a family the request never
 * mentioned imposes nothing, so a deliberately shell-less or read-only
 * `executor.toolAllowList` (including the empty one `test/config.test.ts`
 * pins as legal) stays legal.
 */
const TOOL_FAMILIES: ReadonlyArray<{ readonly label: string; readonly members: readonly string[] }> = [
  { label: 'shell', members: SHELL_TOOLS },
  { label: 'file-write', members: ['write', 'edit', 'str_replace_editor'] },
  { label: 'search', members: ['glob', 'grep'] },
]

/** What one requested allow-list resolves to against a deployment's real registry. */
export interface ToolAllowResolution {
  /** The names to hand the host: `requested` ∩ registry, or `requested` verbatim when the registry is unknown. */
  readonly allow: readonly string[]
  /** Requested names this deployment does not register. Empty when nothing was dropped or the registry is unknown. */
  readonly dropped: readonly string[]
  /** Durable record of the narrowing, ABSENT when nothing was dropped — narrowing is never silent. */
  readonly diagnostic?: string
}

/**
 * Resolve a requested tool allow-list against what a deployment actually
 * registers.
 *
 * THE PROBLEM THIS SOLVES. `tools.restrict()` validates every name against the
 * calling scope's restrictable set and throws on the first miss
 * (`packages/core/tools/src/index.ts`), so a plugin that asserts a tool
 * vocabulary it does not own turns any profile difference into a DEAD dispatch.
 * Two shipped lists did exactly that, and both failures were total rather than
 * partial: the run did not get a weaker auditor, it got no auditor.
 *
 * WHY INTERSECT RATHER THAN PRUNE THE CONSTANTS. Pruning answers one host.
 * `bash` is a real dsh tool that a POSIX profile registers and this Windows
 * headless profile does not; deleting it breaks the hosts where it works and
 * keeping it breaks the hosts where it does not. The name is not wrong — the
 * ASSERTION that every named tool exists everywhere is.
 *
 * WHY NARROWING IS NOT ALLOWED TO BE SILENT. An intersection that quietly
 * removed `read` from an auditor, or every shell from an executor, would
 * convert a loud startup failure into a plausible-looking agent that cannot do
 * its job — and for an auditor, into a `pass` verdict from an agent that read
 * nothing. So every drop produces a `diagnostic` (recorded on the dispatch's
 * `RouteRecord`), and a drop that would cost a required name or a whole
 * requested family REFUSES instead.
 *
 * @param requested - the allow-list the plugin asked for.
 * @param registered - the deployment's restrictable global tool names, or undefined when the host cannot be asked.
 * @param required - names whose loss must fail the dispatch instead of narrowing it.
 * @param label - what is being dispatched, for the refusal and diagnostic text.
 * @returns the names to send, what was dropped, and the record of the drop.
 */
export function resolveToolAllow(
  requested: readonly string[],
  registered: readonly string[] | undefined,
  required: readonly string[],
  label: string,
): ToolAllowResolution {
  // Unknown registry: pass the request through UNCHANGED. Claiming a narrowing
  // the code did not observe is the same over-claim every other bearer in this
  // file exists to prevent, and an intersection against an empty default would
  // blind every dispatch on a host that simply cannot be asked.
  if (registered === undefined) return { allow: [...requested], dropped: [] }
  const known = new Set(registered)
  const allow = requested.filter(name => known.has(name))
  const dropped = requested.filter(name => !known.has(name))
  if (dropped.length === 0) return { allow, dropped: [] }

  const missing = required.filter(name => !known.has(name))
  if (missing.length > 0) {
    throw new AutopilotError(
      `${label} cannot be dispatched: this deployment does not register ${quoteNames(missing)}, and an agent narrowed off that surface would still return a schema-valid answer having seen nothing`,
      'AP_TOOL_SURFACE_INCOMPLETE',
    )
  }
  for (const family of TOOL_FAMILIES) {
    const asked = requested.filter(name => family.members.includes(name))
    if (asked.length === 0) continue
    if (asked.some(name => known.has(name))) continue
    throw new AutopilotError(
      `${label} cannot be dispatched: this deployment registers none of the ${family.label} tools it was given (${quoteNames(asked)}); narrowing would hand the child a surface with no ${family.label} capability at all`,
      'AP_TOOL_SURFACE_INCOMPLETE',
    )
  }
  return {
    allow,
    dropped,
    diagnostic: `tool surface narrowed for ${label}: this deployment does not register ${quoteNames(dropped)} (kept ${allow.length} of ${requested.length})`,
  }
}

function quoteNames(names: readonly string[]): string {
  return names.map(name => `"${name}"`).join(', ')
}

/**
 * Upstream's restrict rejection, which names BOTH the unknown tools and the
 * deployment's complete restrictable set:
 * `tools.restrict() names unknown global tools "a", "b"; known global tools: c, d, e`.
 */
const RESTRICT_REJECTION = /tools\.restrict\(\) names unknown global tools?\s+(.+?);\s*known global tools:\s*(.*)$/s

/**
 * Recover the deployment's tool registry from a `tools.restrict()` rejection.
 *
 * THE SEAM OF LAST RESORT, and deliberately so. The designed seam is
 * {@link EnvironmentProbes.registeredToolNames}, wired at mount from the host's
 * own restrictable-name view. This exists because a deployment that leaves that
 * probe unwired would otherwise get no repair at all — and the harness's own
 * first real-host run was exactly such a deployment. The rejection message is
 * authoritative (upstream builds it from the very set `restrict` validated
 * against) and complete (it is not truncated), so one failed dispatch teaches
 * the engine the registry for every later one.
 *
 * It degrades to today's behaviour rather than guessing: a message that does not
 * match this exact shape yields `undefined` and the caller rethrows the original
 * error untouched.
 * @param message - the rejection message from a failed dispatch.
 * @returns the unknown names and the deployment's restrictable set, or undefined when the message is not a restrict rejection.
 */
export function parseRestrictRejection(
  message: string,
): { readonly unknown: readonly string[]; readonly known: readonly string[] } | undefined {
  const match = RESTRICT_REJECTION.exec(message)
  const unknownText = match?.[1]
  const knownText = match?.[2]
  if (unknownText === undefined || knownText === undefined) return undefined
  const unknown = [...unknownText.matchAll(/"([^"]+)"/g)]
    .map(entry => entry[1])
    .filter((name): name is string => name !== undefined)
  if (unknown.length === 0) return undefined
  const trimmed = knownText.trim()
  const known = trimmed === '(none)' || trimmed.length === 0
    ? []
    : trimmed.split(',').map(part => part.trim()).filter(part => part.length > 0)
  return { unknown, known }
}

/**
 * Normalize a declared tree hash: trim, lowercase, and treat BLANK AS ABSENT.
 *
 * BLANK-IS-ABSENT IS NOT COSMETIC — it is a regression class this repository
 * has already paid for once (`autopilot_usage`'s `inheritedFrom`, and again
 * `autopilot_log`'s `note`). The models this harness actually runs fill every
 * optional property a tool schema declares, so what arrives for a field the
 * human omitted is `""`, not `undefined`. Written through, that blank becomes a
 * present-but-empty `treeHash` in the durable record: a countersign that CLAIMS
 * to name a tree and names nothing, which is strictly worse than one that
 * claims nothing. `tools.ts` drops it at the tool boundary and this drops it
 * again here, because the engine is also reachable from tests and from any
 * later caller — an invariant enforced only at the outermost layer is one
 * caller away from being false.
 *
 * LOWERCASING HERE is what lets `validateExternalReview` demand lowercase on
 * the replay path: every hash this engine writes is already lowercase, so a
 * stored value in another case did not come from here.
 */
function normalizeTreeHash(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim().toLowerCase()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * The declared-vs-declared clause of an external countersign's route
 * diagnostic.
 *
 * WHY A DIAGNOSTIC AND NOT A GATE, decided deliberately: a mismatch between the
 * reviewer's declared tree and the run's declared baseline is the NORMAL case
 * for an execution-role countersign — the run has been committing while it
 * executed, so the tree has moved on purpose. Refusing on it would make the
 * field unusable exactly where it is most informative, and would dress a
 * comparison of two unverified strings up as an authority. Both `problems` in
 * `evaluateCompletion` and a throw here are refusal channels; the route record
 * is the one surface that is carried into the durable audit record AND handed
 * straight back to the caller, so it is where information belongs.
 *
 * @param treeHash - the reviewer's normalized declared hash, if any.
 * @param baselineCommit - `triage.baseline.commit`, as declared at init.
 * @returns the clause, or '' when there is nothing to say.
 */
function treeHashNote(treeHash: string | undefined, baselineCommit: string | undefined): string {
  switch (compareDeclaredTree(treeHash, baselineCommit)) {
    case 'no-hash':
      return ''
    case 'no-baseline':
      return `reviewer declared treeHash ${treeHash} and the run declared no baseline commit to compare it with`
    case 'agrees':
      return `reviewer declared treeHash ${treeHash}, consistent with the run's declared baseline commit ${baselineCommit?.trim().toLowerCase() ?? ''} — both are declarations, neither is measured`
    case 'differs':
      return `reviewer declared treeHash ${treeHash}, which differs from the run's declared baseline commit ${baselineCommit?.trim().toLowerCase() ?? ''} — INFORMATION, not a refusal: a run's tree legitimately moves while it executes`
  }
}

/** The snapshot with any carried transition diagnostic removed (see `commit`). */
function withoutDiagnostic(snapshot: Snapshot): Snapshot {
  const { diagnostic: _carried, ...rest } = snapshot
  return rest
}

/** Append a tool-surface note to a route record without losing the route's own diagnostic. */
/**
 * Stamp the cross-family outcome onto an audit's route, folding its diagnostic
 * in beside any narrowing note rather than replacing it — the two are
 * independent facts about the same dispatch and a reader needs both.
 */
function withCrossFamily(route: RouteRecord, choice: CrossFamilyChoice): RouteRecord {
  const merged = choice.diagnostic === undefined
    ? route.routeDiagnostic
    : [route.routeDiagnostic, `cross-family: ${choice.diagnostic}`].filter(Boolean).join(' | ')
  return {
    ...route,
    crossFamily: choice.outcome,
    ...(merged === undefined ? {} : { routeDiagnostic: merged }),
  }
}

/** Keep completed/revoked byte-identical; only nonterminal records may enter a terminal. */
function keepOrSetExecutorState(
  executor: ExecutorRecord | undefined,
  state: 'completed' | 'revoked',
): ExecutorRecord | undefined {
  if (executor === undefined) return undefined
  if (executor.state === 'completed' || executor.state === 'revoked') return executor
  return { ...executor, state }
}

/** Dispatch text that tells the executor which revision its packet must CAS on. */
function packetRevisionHint(executionRevision: number): string {
  return `[autopilot] executionRevision=${String(executionRevision)}. Pass this integer as autopilot_submit_packet.executionRevision; a stale or missing value is refused.`
}

function withToolDiagnostic(route: RouteRecord, note: string | undefined): RouteRecord {
  if (note === undefined) return route
  return {
    ...route,
    routeDiagnostic: route.routeDiagnostic === undefined ? note : `${route.routeDiagnostic}; ${note}`,
  }
}

/** Structured verdict schema for plan auditors (no needs-fix on the plan gate). */
export const PLAN_VERDICT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  required: ['verdict', 'note'],
  properties: {
    verdict: { type: 'string' as const, enum: ['pass', 'needs-replan', 'blocked', 'needs-owner-decision'] },
    note: { type: 'string' as const },
  },
}

/** Structured verdict schema for execution and rules auditors. */
export const EXECUTION_VERDICT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  required: ['verdict', 'note'],
  properties: {
    verdict: { type: 'string' as const, enum: ['pass', 'needs-fix', 'needs-replan', 'blocked', 'needs-owner-decision'] },
    note: { type: 'string' as const },
  },
}

const PLAN_VERDICTS: readonly string[] = ['pass', 'needs-replan', 'blocked', 'needs-owner-decision']
const EXECUTION_VERDICTS: readonly string[] = ['pass', 'needs-fix', 'needs-replan', 'blocked', 'needs-owner-decision']

/** Outcome of one audit dispatch. */
export interface AuditOutcome {
  readonly verdict: Verdict
  readonly note: string
  readonly auditorId: string
  readonly route: RouteRecord
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

// ── Role-true routing (plan v3; packet M3b) ─────────────────────────────

/** The routing-core role a dispatch's audit role corresponds to. */
export function routeRoleOf(role: AuditRole): Role {
  if (role === 'plan') return 'plan-auditor'
  if (role === 'execution') return 'execution-auditor'
  return 'rules-auditor'
}

const AUDITOR_ROLE_SET: readonly Role[] = ['plan-auditor', 'execution-auditor', 'rules-auditor']

/** Whether routing is ACTIVE for one role's dispatch: mode `auto`, or a role that is locked/inherit. */
function routingActive(routing: ResolvedRouting, role: Role): boolean {
  if (routing.mode === 'auto') return true
  return routing.roles[role].mode !== 'auto'
}

/**
 * F2 (PR #2 Codex review): the conservative routing an INVALID live section
 * degrades to — mode `off` with every role `inherit`, i.e. "route nothing
 * explicitly". Only its ACTIVITY is ever consumed (the dispatch gates and the
 * planner re-arm check); every decision path that would act on it returns the
 * recorded refusal instead, so this shape can never select, lock, or pin
 * anything. It exists so the gates have a total function to read even when
 * the real section cannot be resolved at all.
 */
const REFUSED_ROUTING: ResolvedRouting = {
  mode: 'off',
  preference: 'balanced',
  roles: {
    executor: { mode: 'inherit' },
    planner: { mode: 'inherit' },
    'plan-auditor': { mode: 'inherit' },
    'execution-auditor': { mode: 'inherit' },
    'rules-auditor': { mode: 'inherit' },
  },
}

/** What one dispatch runs on, after routing decided (or recorded parity). */
export interface DispatchRouting {
  /** The agentOptions the child dispatches with; `undefined` = inherit the deployment default. */
  readonly agentOptions: AgentOptionsLike | undefined
  /** The `detail.routing` for the dispatch commits; ABSENT when routing made no decision (pure 0.2.0 parity). */
  readonly routing?: RoutingDecisionDetail
  /** The cross-family outcome for the audit's RouteRecord (absent on the executor's own record). */
  readonly crossFamily?: CrossFamilyOutcome
  readonly crossFamilyDiagnostic?: string
}

/** One role dispatch's routing resolution: dispatch, or the owner-escalation exit. */
export type RoleRouteResolution =
  | ({ readonly kind: 'dispatch' } & DispatchRouting)
  | { readonly kind: 'escalate'; readonly reason: string }

/** Merge a routing decision's record fields onto a captured route record. */
function withRoutingRecord(route: RouteRecord, routing: RoutingDecisionDetail | undefined): RouteRecord {
  if (routing === undefined) return route
  return {
    ...route,
    ...(routing.pin === undefined ? {} : { selected: routing.pin }),
    ...(routing.authorizationSource === undefined ? {} : { authorizationSource: routing.authorizationSource }),
    ...(routing.fallbackFrom === undefined ? {} : { fallbackFrom: routing.fallbackFrom }),
    ...(routing.candidates === undefined ? {} : { candidatesConsidered: routing.candidates }),
    why: [...routing.why],
  }
}

// ── Observed-route evidence (plan v3 M4; [R1-P1-5], [R2-P3-3]) ────────────

/** The three legs of route evidence for one dispatched child, as reads see them. */
export interface RouteEvidence {
  /** What the routing decision selected; absent on inherit/parity dispatches. */
  readonly selected?: RoutingPin
  /** Creation route (`Agent.options`); partial when the host exposes half of it. */
  readonly creation?: { readonly provider?: string; readonly model?: string }
  /** Observed route (latest `request/header`); absent when the read failed. */
  readonly observed?: RoutingPin
  /** Why the observed read failed, when it did — the honest `unverifiable` reason. */
  readonly observedUnreadable?: string
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

/**
 * Route status under plan v3 semantics — the R1-P1 fix.
 *
 * `verified` ONLY when selected, creation, and observed are ALL present and
 * agree on every comparable axis (provider, model, and reasoningEffort where
 * both legs carry it — and the effort axis is only establishable when the
 * observed `request/header` CARRIES the field: a selection that pins an
 * effort while the observed header omits it is `unverifiable`, never
 * `verified`, because the child's own evidence cannot show the selected
 * effort ran). Any disagreement among the legs that ARE present ⇒
 * `mismatch` with the differing axes named — divergence is signal, recorded
 * and never hidden. A missing leg while a claim was in scope ⇒ `unverifiable`
 * naming which read failed: creation-only evidence is NEVER `verified` (the
 * defect this replaces). `unverified` keeps the 0.2.0 meaning — no route claim
 * was in play to verify (inheritance without a readable creation route).
 */
export function routeStatusOf(childId: string, evidence: RouteEvidence): {
  readonly routeStatus: RouteRecord['routeStatus']
  readonly routeDiagnostic?: string
} {
  const { selected, creation, observed } = evidence
  const creationFull = creation?.provider !== undefined && creation?.model !== undefined
  // 1 — disagreements among the legs that are present, axis by axis.
  const axes: string[] = []
  if (selected !== undefined) {
    if (creation?.provider !== undefined && creation.provider !== selected.provider) {
      axes.push(`provider: selected ${selected.provider} vs creation ${creation.provider}`)
    }
    if (creation?.model !== undefined && creation.model !== selected.model) {
      axes.push(`model: selected ${selected.model} vs creation ${creation.model}`)
    }
    if (observed !== undefined) {
      if (observed.provider !== selected.provider) {
        axes.push(`provider: selected ${selected.provider} vs observed ${observed.provider}`)
      }
      if (observed.model !== selected.model) {
        axes.push(`model: selected ${selected.model} vs observed ${observed.model}`)
      }
      if (selected.reasoningEffort !== undefined && observed.reasoningEffort !== undefined
        && selected.reasoningEffort !== observed.reasoningEffort) {
        axes.push(`reasoningEffort: selected ${selected.reasoningEffort} vs observed ${observed.reasoningEffort}`)
      }
    }
  }
  if (creation !== undefined && observed !== undefined) {
    if (creation.provider !== undefined && creation.provider !== observed.provider) {
      axes.push(`provider: creation ${creation.provider} vs observed ${observed.provider}`)
    }
    if (creation.model !== undefined && creation.model !== observed.model) {
      axes.push(`model: creation ${creation.model} vs observed ${observed.model}`)
    }
  }
  if (axes.length > 0) {
    return {
      routeStatus: 'mismatch',
      routeDiagnostic: `route mismatch — the dispatch did not run the recorded route: ${axes.join('; ')}`,
    }
  }
  const creationGap = creationFull
    ? undefined
    : `child ${childId}: provider/model not available from durable Agent options`
  const observedGap = observed === undefined
    ? `observed route not readable: ${evidence.observedUnreadable ?? 'unreadable'}`
    : undefined
  // F18 (PR #2 Codex round 8): a comparable leg pinning an effort while the
  // observed `request/header` OMITS the optional field leaves the effort axis
  // unestablishable — the observed evidence cannot show the selected effort
  // ran, so its silence must not read as agreement. Only the OBSERVED omission
  // is a gap: an observed effort with no selected one keeps the existing
  // handling (the axis is not comparable without both legs), and both absent
  // means there is no effort axis to establish at all.
  const effortGap = selected?.reasoningEffort !== undefined && observed !== undefined && observed.reasoningEffort === undefined
    ? `child ${childId}: observed request/header omits reasoningEffort (selected ${selected.reasoningEffort}) — the selected effort is not observable from the child session; the leg is unverifiable, not agreed`
    : undefined
  // 2 — a claim was in scope (a selection, or a full creation route to check).
  if (selected !== undefined || creationFull) {
    if (observed === undefined) {
      return { routeStatus: 'unverifiable', routeDiagnostic: [creationGap, observedGap].filter(Boolean).join('; ') }
    }
    if (selected !== undefined && !creationFull) {
      return { routeStatus: 'unverifiable', routeDiagnostic: [creationGap, effortGap].filter(Boolean).join('; ') }
    }
    if (effortGap !== undefined) {
      return { routeStatus: 'unverifiable', routeDiagnostic: effortGap }
    }
    if (selected !== undefined) return { routeStatus: 'verified' }
    return {
      routeStatus: 'unverified',
      routeDiagnostic: 'no routing decision selected a route (inheritance); creation and observed routes agree',
    }
  }
  // 3 — no selection and no readable creation route: the 0.2.0 record stands,
  // with the observed leg named either way.
  return {
    routeStatus: 'unverified',
    routeDiagnostic: [
      creationGap,
      observed === undefined
        ? observedGap
        : `observed route ${observed.provider}/${observed.model} recorded from the child request header`,
    ].filter(Boolean).join('; '),
  }
}

/**
 * F6 (PR #2 Codex round 3): the executor's OBSERVED route leg, recaptured at
 * execution-packet submission — a NEW evidence read, labeled as one.
 *
 * `startContinuable` resolves before the child's first turn (upstream: the
 * promise settles at inbox acceptance), so the `running` record's observed
 * read found no `request/header` yet and the record has sat `unverifiable`
 * forever — packet submission and resume preserved it, and a later route
 * mismatch was never recorded. By packet submission a request HAS run (the
 * child is calling the packet tool), so the latest header is finally
 * readable: this refresh re-reads it, recomputes `routeStatus` through the
 * same {@link routeStatusOf} doctrine (never `verified` without three-leg
 * agreement), and says IN the diagnostic that the observed leg was refreshed
 * at packet submission — it never pretends the leg was there from the start.
 * The recomputed `routeDiagnostic` REPLACES the capture-time one (which said
 * the observed read had failed); the capture-time record — including any
 * tool-surface note — stands unchanged in the snapshot beside this refresh.
 *
 * WHERE THE REFRESH LIVES (the fold-contract decision): the fold refuses
 * executor mutation on `submit-packet` (`AP_EXECUTOR_MUTATED`), so the
 * refreshed record rides as the ADDITIVE `routeRecapture` key on the
 * submit-packet commit's detail — the established pattern
 * (`withPlannerDetail`) — and the snapshot keeps the capture-time record
 * unchanged beside it. A failed read keeps the prior record and records the
 * failure the same way; nothing here can refuse a packet.
 */
export interface ExecutorRouteRecapture {
  /** `refreshed` — an observed leg was read and the status recomputed. */
  readonly outcome: 'refreshed'
  /** The recomputed record: the prior record plus the observed leg and the recomputed status. */
  readonly route: RouteRecord
  /** The observed leg as re-read at submission (also on `route`). */
  readonly observed: RoutingPin
}

/** The failed half of the packet-submission recapture: the read did not yield an observed leg. */
export interface ExecutorRouteRecaptureFailed {
  /** `unreadable` — no well-formed `request/header` was readable; the prior record stands. */
  readonly outcome: 'unreadable'
  /** Why the read failed; the prior record is kept unchanged. */
  readonly reason: string
}

/** See {@link ExecutorRouteRecapture}. */
function recapturedExecutorRoute(
  childId: string,
  record: RouteRecord,
  session: SessionReadRef | undefined,
): ExecutorRouteRecapture | ExecutorRouteRecaptureFailed {
  const read = observedRouteOf(session)
  if (read.observed === undefined) {
    return { outcome: 'unreadable', reason: read.unreadable ?? 'observed route read failed' }
  }
  // The creation leg is the record's OWN (captured from the durable Agent
  // options at dispatch) — re-reading a live agent object here could drift
  // from what was actually dispatched, and the record is the durable fact.
  const creation = record.routeProvider === 'unverified' && record.routeModel === 'unverified'
    ? undefined
    : {
        ...(record.routeProvider === 'unverified' ? {} : { provider: record.routeProvider }),
        ...(record.routeModel === 'unverified' ? {} : { model: record.routeModel }),
      }
  const status = routeStatusOf(childId, {
    ...(record.selected === undefined ? {} : { selected: record.selected }),
    ...(creation === undefined ? {} : { creation }),
    observed: read.observed,
  })
  const diagnostic = [
    'observed leg refreshed at execution-packet submission — a new evidence read (the running record was captured before the child\'s first request could exist)',
    status.routeDiagnostic,
  ].filter(Boolean).join('; ')
  return {
    outcome: 'refreshed',
    route: {
      ...record,
      routeStatus: status.routeStatus,
      routeDiagnostic: diagnostic,
      observed: read.observed,
    },
    observed: read.observed,
  }
}

/**
 * Capture one dispatched child's route record: creation from the durable Agent
 * options, observed from the child session's latest `request/header`, status
 * per plan v3 (see {@link routeStatusOf}), and the routing decision's record
 * fields (`selected`/`why`/`authorizationSource`/`fallbackFrom`) merged in.
 *
 * @param childId - the dispatched child's id, for read-failure diagnostics.
 * @param provider - the provider the dispatch was issued through.
 * @param creation - the creation route (`Agent.options`), when the child (or a
 * pre-dispatch config expectation) exposes one.
 * @param session - the child session to read the observed route from; pass
 * `undefined` before the child exists (the `starting` executor record).
 * @param routing - the dispatch's routing decision, when routing made one.
 * @param note - an extra diagnostic prepended for pre-dispatch records.
 */
function captureRoute(
  childId: string,
  provider: string,
  creation: { readonly provider?: string; readonly model?: string } | undefined,
  session: SessionReadRef | undefined,
  routing?: RoutingDecisionDetail,
  note?: string,
): RouteRecord {
  const read = observedRouteOf(session)
  const status = routeStatusOf(childId, {
    ...(routing?.pin === undefined ? {} : { selected: routing.pin }),
    ...(creation === undefined ? {} : { creation }),
    ...(read.observed === undefined ? {} : { observed: read.observed }),
    ...(read.unreadable === undefined ? {} : { observedUnreadable: read.unreadable }),
  })
  const diagnostic = [note, status.routeDiagnostic].filter(Boolean).join('; ')
  return withRoutingRecord({
    provider,
    routeProvider: creation?.provider ?? 'unverified',
    routeModel: creation?.model ?? 'unverified',
    routeStatus: status.routeStatus,
    ...(diagnostic === '' ? {} : { routeDiagnostic: diagnostic }),
    ...(read.observed === undefined ? {} : { observed: read.observed }),
  }, routing)
}

/**
 * Stamp one routing decision's pin onto a snapshot — the WRITER half of the
 * shared derivation (`applyRoutingDecision` is the rule; the fold re-derives
 * and holds the event to it). A decision without a pin CLEARS the role's pin:
 * a reload must not resurrect a route the live run replaced with inheritance.
 */
function withRoutingDecision(snapshot: Snapshot, routing: RoutingDecisionDetail | undefined): Snapshot {
  if (routing === undefined) return snapshot
  const pins = applyRoutingDecision(snapshot.routingPins, routing)
  if (pins === undefined) {
    if (snapshot.routingPins === undefined) return snapshot
    const { routingPins: _dropped, ...rest } = snapshot
    return rest
  }
  return { ...snapshot, routingPins: pins }
}

/**
 * Stamp the M6 planner record onto a commit's detail (additive key).
 *
 * The fold validates `detail.routing` STRICTLY on `audit`/`start-executor`
 * commits and validates `detail` for `submit-packet`/`submit-evidence` stamps
 * only — an additive `plannerRouting` key folds through untouched everywhere
 * (the durable degradation record the packet requires). Never mutates the
 * caller's detail object.
 */
function withPlannerDetail(detail: unknown, record: PlannerRoutingRecord): unknown {
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return { plannerRouting: record }
  return { ...(detail as Record<string, unknown>), plannerRouting: record }
}

/** Model-facing status projection. */
export interface StatusView {
  readonly runId: RunId
  readonly revision: number
  readonly phase: Snapshot['phase']
  readonly planGate: Snapshot['planGate']
  readonly executionGate: Snapshot['executionGate']
  readonly planRevision: number
  readonly objective: string
  readonly size: Snapshot['triage']['size']
  readonly risk: Snapshot['triage']['risk']
  readonly executionMode: Snapshot['triage']['executionMode']
  readonly auditMode: Snapshot['triage']['auditMode']
  readonly requiredRoles: readonly AuditRole[]
  readonly latestVerdicts: Partial<Record<AuditRole, Verdict>>
  readonly replanBudgetRemaining: number
  readonly auditCount: number
  readonly logCount: number
  readonly executor?: { generation: number; state: string }
  readonly enforcement: Enforcement
  readonly closeoutSubmitted: boolean
  /**
   * The M6 planner model-routing record, present exactly while the run sits
   * in a planning phase with a NON-inherit planner decision (routed or
   * unsupported). An inherit decision (the shipped default) and every
   * disposed state project NOTHING — the absent field is the honest record.
   * (The record vocabulary's `inherit` status is a DURABLE-only shape — the
   * mid-planning refresh-into-inherit record of F4 — and never projects
   * here.)
   */
  readonly plannerRouting?: PlannerRoutingRecord
  readonly diagnostic?: string
}

/**
 * Deployment bearers the engine records into `Enforcement` at init.
 *
 * Each is a THUNK rather than a boolean because the answer is a property of
 * the live host context, not of the config: `ctx.approval` is mounted by the
 * base bundle, `ctx.storageDomain` only by the web-app bundle, and the
 * pre-execute seam may fail to install on a given agent. Recording an assumed
 * value would be exactly the pseudo-`active` defect DESIGN.md §6 documents.
 */
export interface EnvironmentProbes {
  /** True only when an approval service is actually observable on the context. */
  readonly approvalAvailable?: () => boolean
  /**
   * Which seam is actually enforcing egress for THIS run's root scope.
   *
   * The root session id is a parameter, not a closure capture, because seam
   * installation is PER ROOT AGENT: one root's `tools/pre-execute`
   * registration can succeed while another's throws. A mount-wide answer would
   * let a run persist the channel of whichever root was configured last —
   * over-claiming 'native-ask' for a scope whose guard denies unconditionally,
   * or the reverse. Both are values the code is not observing for the scope
   * they name.
   */
  readonly egressChannel?: (rootSessionId: string) => EgressChannel
  /** True only when the read-only `ctx.autopilot` surface was actually provided. */
  readonly serviceRegistered?: () => boolean
  /**
   * The global tool names this deployment actually registers, or `undefined`
   * when the host cannot be asked.
   *
   * WHY A PROBE AND NOT A CONSTANT. The plugin does not own the tool
   * vocabulary. {@link AUDITOR_TOOL_ALLOW} and `config.executor.toolAllowList`
   * are REQUESTS, and `tools.restrict()` is all-or-nothing: one name the
   * running profile does not register throws and takes the whole dispatch with
   * it. Wiring this to the host's restrictable-name view lets a dispatch narrow
   * honestly — and SAY SO on the route record — instead of dying.
   *
   * Defaults to absent, and absent means "send the request through verbatim",
   * NOT "narrow to nothing": claiming a narrowing the code did not observe is
   * the same over-claim the other bearers here exist to prevent. A deployment
   * that leaves this unwired still gets repaired by
   * {@link parseRestrictRejection}, but pays one failed dispatch to learn the
   * registry.
   */
  readonly registeredToolNames?: () => readonly string[] | undefined
}

/**
 * The bearer base for a run, from the session workspace.
 *
 * `trim()` is used ONLY to decide whether the header value is blank; the value
 * that gets stamped is the ORIGINAL string. A POSIX directory may legitimately
 * end in whitespace, and stamping `/workspace/project` for a workspace of
 * `/workspace/project ` split `report.txt` from `/workspace/project /report.txt`
 * — one artifact proving two criteria without tripping reverse Single-Bearer.
 *
 * LEADING whitespace is a different case and is deliberately left on the
 * pre-existing arm: `' /ws'` is not absolute-shaped AS WRITTEN, so it falls to
 * `canonicalBearer(candidate, process.cwd())`, which trims the bearer and then
 * resolves it against the process cwd — so the result is drive-qualified on
 * Windows (`' /ws'` under `C:\work` becomes `C:/ws`) and `/ws` on POSIX.
 *
 * BE CLEAR THAT THIS OUTPUT CHANGED. Before this function stopped trimming, a
 * leading-whitespace header was trimmed FIRST, so `' /ws'` was already
 * absolute-shaped and got stamped verbatim as `/ws` on every platform. Now it is
 * not absolute-shaped, takes the resolve arm, and on Windows stamps `C:/ws`
 * instead. Both are deterministic and absolute-shaped, and neither is the defect
 * this function was fixed for (that is TRAILING whitespace, above) — but the
 * leading case is not untouched collateral-free, and saying otherwise would be
 * a claim the code does not support.
 */
function resolveBearerBase(sessionCwd: string | undefined): string {
  const blank = sessionCwd === undefined || sessionCwd.trim().length === 0
  const candidate = blank ? process.cwd() : sessionCwd
  if (isAbsoluteShapedBearer(candidate)) return candidate
  const joined = canonicalBearer(candidate, process.cwd())
  if (isAbsoluteShapedBearer(joined)) return joined
  const fallback = process.cwd()
  if (!isAbsoluteShapedBearer(fallback)) {
    throw new AutopilotError('bearerBase could not be resolved to an absolute-shaped path', 'AP_BEARER_BASE_RELATIVE')
  }
  return fallback
}

/** The phases whose actor is the PLANNER (the root agent itself). */
const PLANNING_PHASES: readonly Snapshot['phase'][] = ['planning', 'plan-reviewing', 'replanning']

/**
 * The one-shot reload re-arm note (P2-3), stamped on the first planning-phase
 * commit after an engine load re-armed (or still owes) the planner install.
 * Honest by construction: it claims only what the engine can observe — that
 * the previous process's install died with it and this arm re-resolved
 * against current facts — and names the unrouted window as a possibility,
 * never as a fact.
 */
const PLANNER_REARM_NOTE =
  'planner: install re-armed after an engine reload of a planning-phase run — the previous process\u2019s install died with it; '
  + 'this arm was re-resolved against CURRENT policy/catalog facts, and planning turns between the reload and the re-arm (if any) ran on the deployment default'

/**
 * The planner's model-routing record (M6), engine-local and per run.
 *
 * The planner is the one role that is NEVER dispatched — it IS the root
 * agent — so its route never becomes `agentOptions`, never pins
 * `routingPins` (the fold derives those from dispatch `detail.routing` only),
 * and never touches the audit/executor route records. When routing resolves
 * the planner to a route, the route is INSTALLED on the root agent's scoped
 * ctx via the `modelSelectionInstaller` port for exactly the planning phases
 * (plan "Roles and routing"); the record here is what the run says about it.
 *
 * `status` kinds are exact:
 *  - `routed` — installed; the root agent plans on `route` until the run
 *    leaves the planning phases.
 *  - `unsupported` — a NON-inherit planner decision that could not be
 *    installed (no installer port, no root ctx, a grant/preflight refusal,
 *    or a declining/throwing installer). The run CONTINUES WITH INHERITANCE —
 *    degradation is recorded, never silent, never fatal.
 *  - `inherit` — ONLY the durable record of a mid-planning REFRESH INTO
 *    inherit (F4): the previous install existed and was disposed because the
 *    live routing decision changed to inherit. This status never appears on
 *    the LIVE status surface (an inherit install projects nothing there) —
 *    it exists so the disposal is recorded, exactly as a dispose on leaving
 *    planning needs no record but a dispose INSIDE planning does.
 *
 * Steady-state `inherit` decisions (the shipped default) still record NOTHING
 * beyond the normal routing detail — the absent field IS that record; only a
 * transition AWAY from a live install carries the `inherit` status.
 */
export interface PlannerRoutingRecord {
  readonly status: 'routed' | 'unsupported' | 'inherit'
  /** The route the decision named; present whenever one was resolved. */
  readonly route?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  /** The rule trace, same vocabulary as the routing details' `why`. */
  readonly why: readonly string[]
}

/** A planner route as the install decision names it (provider/model/effort). */
interface PlannerRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** The resolved planner decision, reduced to what change detection needs (F4). */
interface PlannerDecisionKey {
  readonly kind: 'inherit' | 'route' | 'degraded'
  readonly route?: PlannerRoute
}

/** Trim-exact equality of a planner route's full identity, effort included. */
function samePlannerRoute(a: PlannerRoute | undefined, b: PlannerRoute | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}

/**
 * Whether a planning-phase re-resolution is the SAME decision the current
 * install was armed from (F4): kind and full route identity equal, `why`
 * prose deliberately ignored — a changed refusal REASON under the same kind
 * and route is not a re-arm event, so unchanged config can never churn the
 * install (no extra install/dispose, no extra record).
 */
function samePlannerDecision(a: PlannerDecisionKey, b: PlannerDecisionKey): boolean {
  if (a.kind !== b.kind) return false
  return samePlannerRoute(a.route, b.route)
}

/** One planner route's compact identity, for from→to refresh notes (F4). */
function plannerRouteLabel(route: PlannerRoute | undefined): string {
  if (route === undefined) return '(no route named)'
  return `${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : ` @ ${route.reasoningEffort}`}`
}

/** What one run's live planner install state is (engine-internal). */
type PlannerInstallState =
  | { readonly kind: 'armed'; readonly record: PlannerRoutingRecord; readonly dispose?: () => void; readonly decision: PlannerDecisionKey }
  | { readonly kind: 'inherit' }

/** The resolved planner decision in full: the arm instruction plus its rule trace. */
type PlannerRouteDecision =
  | { readonly kind: 'inherit' }
  | { readonly kind: 'route'; readonly route: PlannerRoute; readonly why: readonly string[] }
  | { readonly kind: 'degraded'; readonly route?: PlannerRoute; readonly why: readonly string[] }

/** The decision reduced to its change-detection key (F4). */
function plannerDecisionKeyOf(decision: PlannerRouteDecision): PlannerDecisionKey {
  if (decision.kind === 'inherit') return { kind: 'inherit' }
  return { kind: decision.kind, ...(decision.route === undefined ? {} : { route: decision.route }) }
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

/** The autopilot run engine. One instance per plugin mount. */
export class AutopilotEngine {
  private readonly cache = new Map<RunId, Snapshot>()
  private readonly tails = new Map<RunId, Promise<void>>()
  private readonly lifecycle = new AbortController()
  /**
   * The deployment's restrictable tool names once observed, from the probe or
   * from a host rejection. Cached for the mount because the registry a
   * `restrict` call validates against is fixed by what the profile loaded, so
   * exactly one dispatch anywhere should ever have to pay for the lesson.
   */
  private learnedToolNames: readonly string[] | undefined
  /**
   * The live planner installs (M6), per run. An entry exists exactly while
   * the run sits in a planning phase: armed (with the disposer when the
   * install happened) or the recorded `inherit` no-op. Deleted on every exit
   * from the planning phases (dispose first, idempotent by deletion) and on
   * engine dispose, so a stale model selection can never outlive its run's
   * planning window — and a fresh entry (re-arm) is re-resolved from CURRENT
   * policy/catalog facts on re-entry, never resurrected.
   *
   * P2-3 (execution-audit r1): the map is ENGINE-LOCAL, so an engine restart
   * with a run parked in a planning phase loses the install while the durable
   * stream still says `plannerRouting: 'routed'`. The reload re-arm below
   * (`schedulePlannerRearm`) closes that gap at the earliest moment a new
   * engine can observe the run, and `plannerReloadStamps` makes the next
   * commit say so once, durably.
   */
  private readonly plannerInstalls = new Map<RunId, PlannerInstallState>()
  /**
   * Runs whose planning-phase install was re-armed (or must be re-armed) after
   * an engine reload and whose NEXT planning-phase commit still owes the
   * durable re-arm record (P2-3). Consumed exactly once by that commit and
   * cleared whenever the planning window closes without one.
   */
  private readonly plannerReloadStamps = new Set<RunId>()

  constructor(
    private readonly agents: AgentsRef,
    private readonly subagents: SubagentsRef,
    private readonly store: RunStoreLike,
    readonly config: ResolvedConfig,
    /**
     * Bearer for the 'active' enforcement claim: must return true ONLY when a
     * sandbox confine provider is actually mounted. Defaults to false so an
     * unwired probe records 'degraded' (honest) instead of a confidence the
     * code cannot observe (Checker-Resolution: a checker must be able to see
     * the fail).
     */
    private readonly sandboxAvailable: () => boolean = () => false,
    /**
     * The remaining enforcement bearers, same doctrine as `sandboxAvailable`:
     * each defaults to the LEAST capable answer, so an unwired probe records
     * what the code can actually observe rather than what the deployment is
     * assumed to provide.
     */
    private readonly environment: EnvironmentProbes = {},
    /** Routing ports (M3b). Absent ⇒ 0.2.0/inherit dispatch behavior, recorded honestly. */
    private readonly routingPorts: RoutingPorts = {},
    /**
     * F2 (PR #2 Codex review): re-resolves the routing section from the raw
     * config at each routing decision. Wired by `apply()` exactly when the
     * routing leaves arrived as volatile references (the Cordis loader
     * path), where a config PATCH updates the refs in place WITHOUT
     * remounting the plugin — a mount-time snapshot would freeze
     * mode/lock/preference at their mount values while the legacy surfaces
     * follow their patches through the remount. Absent (every plain-object
     * caller, and the whole pre-F2 test suite) ⇒ `config.routing` IS the
     * live routing, byte-identical to the previous behavior.
     */
    private readonly routingSource: (() => ResolvedRouting) | undefined = undefined,
  ) {}

  /**
   * Dispose: abort new work, then WAIT (bounded) for in-flight transactions to
   * settle — dispose must reach quiescence, not just request it. The 5s bound
   * is a protocol constant; tails swallow their own errors, so allSettled here
   * cannot reject.
   */
  async dispose(): Promise<void> {
    this.lifecycle.abort(new AutopilotError('autopilot engine disposed', 'AP_DISPOSED'))
    // M6: no planner model selection may outlive the engine that installed
    // it — mount teardown disposes every armed install exactly once. The
    // sweep runs EAGERLY (before the tail wait) so a live install is released
    // immediately even when an in-flight transaction hangs past the 5s bound.
    for (const runId of [...this.plannerInstalls.keys()]) this.disposePlanner(runId)
    const pending = [...this.tails.values()]
    if (pending.length === 0) return
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5000)
        if (typeof timer === 'object' && 'unref' in timer) timer.unref()
      }),
    ])
    // F25 (PR #2 Codex round 13): RE-SWEEP after the tail settles. A
    // transaction that was mid-planner-route-resolution when the first sweep
    // ran resumes during the wait above; the arm guard refuses its install,
    // but dispose() OWNS the zero-live-installs invariant mechanically rather
    // than trusting every arm path to have observed the guard — so whatever
    // appeared after the first sweep is disposed here, and dispose() returns
    // with no live install either way. (Idempotent by deletion: a no-op when
    // nothing appeared, as the guard alone guarantees.)
    for (const runId of [...this.plannerInstalls.keys()]) this.disposePlanner(runId)
  }

  // ── Public state machine operations (root authority) ─────────────────────

  /**
   * Start a run.
   * @param usageSeeds - initial usage entries, normally one `undeclared` entry
   * per user-visible change the run intends. Pass `undefined` for a
   * legacy-exempt run with no usage dimension at all: that is what lightweight
   * runs do (CC parity with the plan-gate and sandbox exemptions), and it is
   * the same absent-means-exempt shape a v1 stream replays with.
   */
  async init(caller: AgentRef, triage: Triage, usageSeeds?: readonly UsageEntry[]): Promise<Snapshot> {
    const root = this.resolveRoot(caller)
    const problems = validateTriage(triage)
    if (problems.length > 0) {
      throw new AutopilotError(`triage rejected: ${problems.join('; ')}`, 'AP_TRIAGE_INVALID')
    }
    for (const seed of usageSeeds ?? []) {
      const seedProblems = validateUsageEntry(seed)
      if (seedProblems.length > 0) {
        throw new AutopilotError(`usage seed rejected: ${seedProblems.join('; ')}`, 'AP_USAGE_INVALID')
      }
    }
    return this.transact(root.id, async () => {
      const prior = this.current(root.id)
      if (prior !== undefined && !TERMINAL_PHASES.includes(prior.phase)) {
        throw new AutopilotError('an autopilot run is already active on this session', 'AP_ALREADY_ACTIVE')
      }
      if (prior !== undefined) {
        throw new AutopilotError(
          'this session already carries a finished run; start a new session for a new run',
          'AP_RUN_EXHAUSTED',
        )
      }

      const enforcement = this.applyInitEnforcement(root, triage)
      const snapshot: Snapshot = {
        runId: root.id,
        revision: 1,
        triage,
        plan: { revision: 0, text: '' },
        phase: 'planning',
        planGate: 'pending',
        executionGate: 'pending',
        audits: [],
        residualRisks: [],
        logCount: 0,
        consecutiveReplans: 0,
        ...(usageSeeds === undefined ? {} : { usage: { entries: [...usageSeeds] } }),
        bearerBase: resolveBearerBase(root.session.header.cwd),
        enforcement,
      }
      return await this.commit(undefined, 'init', snapshot)
    })
  }

  status(caller: AgentRef): StatusView | undefined {
    const root = this.resolveRoot(caller)
    const snapshot = this.current(root.id)
    if (snapshot === undefined) return undefined
    return this.projectStatus(snapshot)
  }

  async submitPlan(caller: AgentRef, text: string): Promise<Snapshot> {
    const root = this.resolveRoot(caller)
    if (text.trim().length === 0) throw new AutopilotError('plan text is empty', 'AP_INVALID_ARGUMENT')
    return this.transact(root.id, async () => {
      const prior = this.require(root.id)
      if (prior.phase !== 'planning' && prior.phase !== 'replanning') {
        throw new AutopilotError(`cannot submit plan in phase ${prior.phase}`, 'AP_WRONG_PHASE')
      }
      // A new plan revision restarts the evidence chain: stale execution
      // evidence and gate values must not survive into the next round
      // (the fold enforces this shape mechanically as well).
      const next: Snapshot = {
        ...prior,
        revision: prior.revision + 1,
        plan: { revision: prior.plan.revision + 1, text },
        phase: 'planning',
        planGate: 'pending',
        executionGate: 'pending',
        executionPacket: undefined,
        residualRisks: [],
      }
      return await this.commit(prior, 'submit-plan', next)
    })
  }

  /** Dispatch one independent auditor (auditMode independent only). */
  async audit(caller: AgentRef, request: { role: AuditRole; prompt: string; provider?: string }): Promise<AuditOutcome> {
    const root = this.resolveRoot(caller)
    return this.transact(root.id, async () => {
      const prior = this.require(root.id)
      if (prior.triage.auditMode !== 'independent') {
        throw new AutopilotError(`audit dispatch requires auditMode independent (run is ${prior.triage.auditMode}); use autopilot_self_check`, 'AP_WRONG_AUDIT_MODE')
      }
      this.assertAuditPhase(prior, request.role)
      if (request.prompt.trim().length === 0) throw new AutopilotError('audit prompt is empty', 'AP_INVALID_ARGUMENT')

      const provider = request.provider ?? this.config.auditors[request.role]?.provider ?? this.config.auditProvider
      const roleKey = routeRoleOf(request.role)
      const schema = request.role === 'plan' ? PLAN_VERDICT_SCHEMA : EXECUTION_VERDICT_SCHEMA

      // ── Route resolution (M3b) ──
      // Routing ACTIVE (mode auto, or this role locked/inherit): the E1/E2 core
      // decides — `selectCrossFamily` is fully subsumed there (independence is
      // the core's step 4 over the authorized set; pool entries are
      // plugin-config grants that never widen it). Mode OFF with a default-auto
      // role: the 0.2.0 flow VERBATIM, then the pick through the one grant rule
      // ([R2-P1-1]) — on a no-policy deployment that is byte-for-byte 0.2.0
      // dispatch parity, and on a policy-bearing one a grant outside the policy
      // escalates instead of silently bypassing the native allowlist.
      let agentOptions: AgentOptionsLike | undefined
      let routingDetail: RoutingDecisionDetail | undefined
      let familyChoice: CrossFamilyChoice
      // F2: the gate reads the CURRENT routing (a volatile patch lands
      // without remount); an invalid live section reads as the conservative
      // all-inherit shape, which routes every role INTO resolveRoleRoute so
      // the refusal is recorded on the dispatch instead of silently taking
      // the 0.2.0 pool path under a config the code cannot validate.
      if (routingActive(this.routingConfig().routing, roleKey)) {
        const resolution = await this.resolveRoleRoute(root, roleKey, prior)
        if (resolution.kind === 'escalate') {
          return await this.routingEscalation(root, prior, resolution.reason)
        }
        agentOptions = resolution.agentOptions
        routingDetail = resolution.routing
        const family = this.crossFamilyOfResolution(resolution, roleKey, prior)
        familyChoice = { agentOptions, outcome: family.outcome, ...(family.diagnostic === undefined ? {} : { diagnostic: family.diagnostic }) }
      } else {
        // Cross-family review: past the risk floor, prefer a reviewer the
        // executor is not from. The CHOICE is recorded on the audit's route
        // whatever it turns out to be, including the two ways it can fail to
        // happen — a silent fallback to the builder's own family would be the
        // pseudo-active defect class this repo keeps paying for.
        const choice = selectCrossFamily({
          risk: prior.triage.risk,
          configured: this.config.auditors[request.role]?.agentOptions,
          executor: this.config.executor.agentOptions,
          // F21: the pool leg of the policy reads the normalized pool (the one
          // seam), so a POOL pick's blank effort never reaches the pin built
          // below; the legacy `configured` surface stays verbatim (0.2.0
          // dispatch parity for mode 'off').
          policy: { ...this.config.crossFamily, pool: this.normalizedPool() },
        })
        agentOptions = choice.agentOptions
        familyChoice = choice
        const pick = toRoutePin(choice.agentOptions)
        if (pick !== undefined) {
          // An explicit pick is a plugin-config grant ([R2-P1-1]) — checked in
          // EVERY mode. A routeless pick (inheritance, tuning-only options)
          // names no route and checks nothing: 0.2.0 parity.
          const verdict = resolvePluginGrant(
            { provider: pick.provider, model: pick.model, source: 'legacy-pool' },
            this.readPolicy(root),
          )
          if (verdict.kind === 'conflict') {
            return await this.routingEscalation(root, prior, verdict.reason)
          }
          const effort = choice.agentOptions?.reasoningEffort
          routingDetail = {
            role: roleKey,
            pin: { provider: pick.provider, model: pick.model, ...(effort === undefined ? {} : { reasoningEffort: effort }) },
            why: [
              ...verdict.why,
              `cross-family: routed by the 0.2.0 pool fallback (${choice.outcome})${choice.diagnostic === undefined ? '' : ` — ${choice.diagnostic}`}`,
            ],
            authorizationSource: 'plugin-config',
          }
        }
      }

      let run: SubagentRunRef | undefined
      let toolDiagnostic: string | undefined
      try {
        const dispatched = await this.dispatchWithToolAllow(
          { requested: AUDITOR_TOOL_ALLOW, required: AUDITOR_TOOL_REQUIRED, label: `${request.role} auditor` },
          allow => this.subagents.start(provider, {
            prompt: [{ type: 'text', text: request.prompt }],
            parent: root,
            outputSchema: schema,
            maxDepth: 1,
            toolFilter: { allow },
            signal: this.lifecycle.signal,
            ...(agentOptions === undefined ? {} : { agentOptions }),
          }),
        )
        run = dispatched.value
        toolDiagnostic = dispatched.resolution.diagnostic

        // Plan audits transition to plan-reviewing before awaiting the verdict.
        let baseline = prior
        if (request.role === 'plan') {
          baseline = await this.commit(prior, 'audit', {
            ...prior,
            revision: prior.revision + 1,
            phase: 'plan-reviewing',
          }, { role: request.role, auditorId: run.id, stage: 'started' })
        }
        const captured = {
          runRevision: baseline.revision,
          planRevision: baseline.plan.revision,
          executionRevision: baseline.executor?.executionRevision ?? 0,
        }

        const result = await run.result
        if (result.stopReason !== 'completed' || result.structured === undefined) {
          throw new AutopilotError(
            `${request.role} audit returned no structured verdict (stopReason ${result.stopReason}): ${result.diagnostic ?? 'missing structured output'}`,
            'AP_AUDIT_NO_VERDICT',
          )
        }
        const structured = result.structured as { verdict?: string; note?: string }
        const legal = request.role === 'plan' ? PLAN_VERDICTS : EXECUTION_VERDICTS
        if (structured.verdict === undefined || !legal.includes(structured.verdict)) {
          throw new AutopilotError(`${request.role} audit returned invalid verdict: ${String(structured.verdict)}`, 'AP_AUDIT_INVALID_VERDICT')
        }

        // Staleness CAS: reject a verdict whose baseline moved. Execution-class
        // audits additionally CAS on the executor's execution revision so a
        // verdict about revision N can never gate revision N+1.
        const live = this.require(root.id)
        if (live.revision !== captured.runRevision || live.plan.revision !== captured.planRevision) {
          throw new AutopilotError('stale audit result: run/plan revision advanced since the audit started', 'AP_STALE_AUDIT')
        }
        if (request.role !== 'plan'
          && (live.executor?.executionRevision ?? 0) !== captured.executionRevision) {
          throw new AutopilotError('stale execution audit result: execution revision advanced since the audit started', 'AP_STALE_AUDIT')
        }

        // The narrowing rides on the audit's own route record, so a reader of
        // the durable stream can see that THIS verdict came from an auditor
        // whose surface was reduced, and by what. `run.result` has settled by
        // this point, so the observed leg (`request/header`) is read from the
        // child session HERE — the latest header is the only proof of the
        // request route (plan v3 M4; `Agent.options` prove creation only).
        // Route status never gates the verdict below: it is provenance for the
        // auditor's reader, including when it records a mismatch.
        const route = withCrossFamily(
          withToolDiagnostic(
            captureRoute(run.id, provider, run.localAgent?.options, run.localAgent?.session, routingDetail),
            toolDiagnostic,
          ),
          familyChoice,
        )
        return await this.applyVerdict(root, live, {
          role: request.role,
          verdict: structured.verdict as Verdict,
          note: structured.note ?? '',
          auditorId: run.id,
          route,
          captured,
          ...(routingDetail === undefined ? {} : { routing: routingDetail }),
        })
      } finally {
        if (run !== undefined) await run.dispose()
      }
    })
  }

  /** Record a self-check verdict (auditMode self-check only; labeled honestly). */
  async selfCheck(caller: AgentRef, request: { role: AuditRole; verdict: Verdict; note: string }): Promise<AuditOutcome> {
    const root = this.resolveRoot(caller)
    return this.transact(root.id, async () => {
      const prior = this.require(root.id)
      if (prior.triage.auditMode !== 'self-check') {
        throw new AutopilotError('self-check verdicts are only legal on auditMode self-check runs', 'AP_WRONG_AUDIT_MODE')
      }
      this.assertAuditPhase(prior, request.role)
      if (request.role === 'plan' && !PLAN_VERDICTS.includes(request.verdict)) {
        throw new AutopilotError(`verdict ${request.verdict} is not legal for the plan gate`, 'AP_AUDIT_INVALID_VERDICT')
      }
      const route: RouteRecord = {
        provider: 'self-check',
        routeProvider: 'self-check',
        routeModel: 'self-check',
        routeStatus: 'unverified',
        routeDiagnostic: 'same-context self-review, labeled per CC audit-mode rules',
      }
      return await this.applyVerdict(root, prior, {
        role: request.role,
        verdict: request.verdict,
        note: request.note,
        auditorId: 'self-check',
        route,
        captured: {
          runRevision: prior.revision,
          planRevision: prior.plan.revision,
          executionRevision: prior.executor?.executionRevision ?? 0,
        },
      })
    })
  }

  /**
   * Record an owner-countersigned external review (`auditMode: 'external'`).
   *
   * This is the ONE verdict path the harness does not itself produce: a human
   * read something outside this process and is signing for it. The tool layer
   * gates it on a direct human turn, exactly like `owner-approve` — an
   * agent-generated turn must never be able to countersign the run it is
   * running, which would turn `external` into a self-check with better
   * paperwork.
   *
   * What is checked here is only what a record can answer (see
   * `validateExternalReview`); whether the attached review EXISTS on disk is
   * settled at completion, because the replay path must not read the disk.
   */
  async recordExternalAudit(caller: AgentRef, request: {
    role: AuditRole
    verdict: Verdict
    note: string
    review: ExternalReview
  }): Promise<AuditOutcome> {
    const root = this.resolveRoot(caller)
    return this.transact(root.id, async () => {
      const prior = this.require(root.id)
      if (prior.triage.auditMode !== 'external') {
        throw new AutopilotError(
          `external countersigns are only legal on auditMode external runs (run is ${prior.triage.auditMode})`,
          'AP_WRONG_AUDIT_MODE',
        )
      }
      this.assertAuditPhase(prior, request.role)
      if (request.role === 'plan' && !PLAN_VERDICTS.includes(request.verdict)) {
        throw new AutopilotError(`verdict ${request.verdict} is not legal for the plan gate`, 'AP_AUDIT_INVALID_VERDICT')
      }
      if (request.note.trim().length === 0) {
        throw new AutopilotError('external countersign requires a note', 'AP_INVALID_ARGUMENT')
      }
      // THE ONE PLACE A COUNTERSIGN IS BUILT. Normalization happens here and
      // nowhere else: `treeHash` is trimmed and lowercased once, before
      // validation, and the record written below is the only version of it that
      // ever exists. Re-deriving any part of this record later would break the
      // fold's audit-append-only check, which compares committed records by
      // `JSON.stringify` and is therefore sensitive to key order as well as to
      // values.
      const treeHash = normalizeTreeHash(request.review.treeHash)
      const review: ExternalReview = {
        reviewer: request.review.reviewer.trim(),
        reviewRef: request.review.reviewRef.trim(),
        // Dropped when absent rather than written as `undefined`: this object is
        // JSON-serialized into the stream, and an explicitly-undefined key is a
        // different shape from an absent one for `toEqual` and for the fold's
        // stringify comparison alike.
        ...(treeHash === undefined ? {} : { treeHash }),
      }
      const problems = validateExternalReview(review)
      if (problems.length > 0) {
        throw new AutopilotError(`external countersign rejected: ${problems.join('; ')}`, 'AP_EXTERNAL_INVALID')
      }
      const route: RouteRecord = {
        provider: 'external',
        routeProvider: 'external',
        routeModel: 'external',
        routeStatus: 'unverified',
        routeDiagnostic: [
          `owner-countersigned external review by ${review.reviewer}; the harness cannot verify the review happened`,
          treeHashNote(treeHash, prior.triage.baseline.commit),
        ].filter(part => part.length > 0).join('; '),
      }
      return await this.applyVerdict(root, prior, {
        role: request.role,
        verdict: request.verdict,
        note: request.note,
        auditorId: 'external',
        route,
        external: review,
        captured: {
          runRevision: prior.revision,
          planRevision: prior.plan.revision,
          executionRevision: prior.executor?.executionRevision ?? 0,
        },
      })
    })
  }

  async startExecutor(caller: AgentRef, request: { prompt: string; persona?: string; provider?: string; signal: AbortSignal }): Promise<Snapshot> {
    const root = this.resolveRoot(caller)
    const childId = randomUUID()
    return this.transact(root.id, async () => {
      const prior = this.require(root.id)
      if (prior.triage.executionMode !== 'delegated') {
        throw new AutopilotError('executor children are only legal on delegated runs; inline runs implement directly', 'AP_WRONG_EXECUTION_MODE')
      }
      if (prior.planGate !== 'pass') throw new AutopilotError('planGate must be pass before an executor starts', 'AP_PLAN_GATE_NOT_PASS')
      // THE PLAN GATE DOES NOT STAND IN FOR THIS. `planGate === 'pass'` implies
      // the usage question was answered AT THE FLIP INSTANT and nowhere else:
      // `declare-usage` is legal in `executing`, `autopilot_usage`'s class enum
      // includes 'undeclared', and last-wins means an entry can be reverted.
      // Without this check a run could re-open the question and still authorize
      // a fresh executor child that reaches state 'running'.
      const undeclared = usageDeclarationProblems(prior.usage)
      if (undeclared.length > 0) {
        throw new AutopilotError(
          `executor refused while the usage question is unanswered: ${undeclared.join('; ')}`,
          'AP_USAGE_UNDECLARED',
        )
      }
      if (prior.phase !== 'executing') throw new AutopilotError(`cannot start executor in phase ${prior.phase}`, 'AP_WRONG_PHASE')
      if (prior.executor !== undefined && prior.executor.state !== 'revoked' && prior.executor.state !== 'completed') {
        throw new AutopilotError(`executor ${prior.executor.childId} is still ${prior.executor.state}`, 'AP_EXECUTOR_EXISTS')
      }

      const provider = request.provider ?? this.config.executorProvider
      // ── Route resolution (M3b): the executor role resolves the same way
      // (independence N/A — it is not an auditor). Routing INACTIVE (mode off
      // with a default-auto executor) keeps the 0.2.0 composition verbatim;
      // note an explicit legacy executor route makes the role LOCKED at
      // resolve, which activates routing even in off mode — so the grant rule
      // still covers every config-sourced explicit route in every mode.
      let agentOptions: AgentOptionsLike | undefined
      let routingDetail: RoutingDecisionDetail | undefined
      // F2: same live gate read as the audit path above.
      if (routingActive(this.routingConfig().routing, 'executor')) {
        const resolution = await this.resolveRoleRoute(root, 'executor', prior)
        if (resolution.kind === 'escalate') {
          return await this.routingEscalation(root, prior, resolution.reason)
        }
        agentOptions = resolution.agentOptions
        routingDetail = resolution.routing
      } else {
        agentOptions = this.config.executor.agentOptions
      }
      const executor: ExecutorRecord = {
        childId,
        generation: prior.executor === undefined ? 1 : prior.executor.generation + 1,
        executionRevision: 1,
        state: 'starting',
        // The starting record is PRE-DISPATCH: creation is the configured/
        // resolved expectation, the child session does not exist yet, so the
        // observed leg cannot have been read. Under plan v3 that is honest
        // `unverifiable` (creation-only evidence is never `verified` — the
        // R1-P1 fix); the running commit below re-captures with the real child.
        route: (() => {
          const creation = agentOptions === undefined ? undefined : {
            ...(agentOptions.provider === undefined ? {} : { provider: agentOptions.provider }),
            ...(agentOptions.model === undefined ? {} : { model: agentOptions.model }),
          }
          return captureRoute(
            childId,
            provider,
            creation,
            undefined,
            routingDetail,
            [
              'executor starting record: the child is dispatched after this commit; the running record re-reads creation and the observed request route',
              ...(creation === undefined ? ['executor route inherits the deployment default'] : []),
            ].join('; '),
          )
        })(),
      }
      const starting = await this.commit(
        prior,
        'start-executor',
        withRoutingDecision({
          ...prior,
          revision: prior.revision + 1,
          executor,
        }, routingDetail),
        { stage: 'starting', childId, ...(routingDetail === undefined ? {} : { routing: routingDetail }) },
      )

      try {
        // `autopilot_submit_packet` IS DELIBERATELY ABSENT from this list, and
        // adding it back makes every delegated executor unstartable on every
        // host. Two independent upstream facts, both in
        // `packages/core/tools/src/index.ts` and
        // `packages/subagent/subagent/src/{child-agent,continuation}.ts`:
        //
        //  1. IT IS NEVER RESTRICTABLE. `restrict()` validates names against
        //     `view(scope).restrictableNames`, which `view()` builds from the
        //     INHERITED surface only — the global layer plus ancestor layers,
        //     with the scope's OWN layer explicitly skipped. The packet tool is
        //     registered into the child's own layer by
        //     `createContinuableChildSetup`, so it is not in that set at any
        //     instant, on any host.
        //  2. IT IS NEVER REGISTERED IN TIME EITHER. The child's setup runs
        //     `applyChildComposition(childCtx, …)` — which calls
        //     `childCtx.tools.restrict(...)` — and the packet tool registers
        //     only AFTER that: through the setup registry on dsh 0.1.1, and
        //     on `agent/created` (announced after setup) since dsh 0.1.2,
        //     where `createContinuableChildSetup` installs it into the
        //     child's own scope. So the name is unknown at restrict time by
        //     construction, and the live failure was deterministic:
        //     `tools.restrict() names unknown global tools "bash",
        //     "autopilot_submit_packet"`, executor `starting` -> `revoked`.
        //
        // WHAT STILL GUARANTEES THE CHILD CAN CALL IT: the same `view()`. A
        // restriction filters only what a scope INHERITS; the scope's own
        // registrations are re-added to `visible` after the filter runs and are
        // documented upstream as exempt precisely so "a filter naming the
        // capabilities the child may use must not strip the machinery it answers
        // through". The packet tool is visible to the executor because it is the
        // executor's own, not because anything allow-listed it.
        const dispatched = await this.dispatchWithToolAllow(
          // No `required` names: the executor surface is the OWNER's config, so
          // the engine has no business insisting on a name the owner did not
          // ask for. The family rule below still refuses to hand back a child
          // that lost an entire capability class the config DID ask for.
          { requested: this.config.executor.toolAllowList, required: [], label: 'executor child' },
          allow => this.subagents.startContinuable({
            childId,
            provider,
            label: 'autopilot-executor',
            request: {
              prompt: [{ type: 'text', text: `${request.prompt}\n\n${packetRevisionHint(executor.executionRevision)}` }],
              parent: root,
              persona: request.persona ?? this.config.executor.persona,
              toolFilter: { allow },
              ...(agentOptions === undefined ? {} : { agentOptions }),
            },
            signal: request.signal,
          }),
        )
        // A continuable child's first turn starts only AFTER `startContinuable`
        // resolves (upstream: the promise settles at inbox acceptance), so on a
        // real host the observed read here usually finds no header yet —
        // honestly `unverifiable` at this instant. Whatever IS in the child
        // session at commit time is captured; a malformed or absent session
        // degrades the same way it does for audits.
        const child = this.agents.get(childId)
        const route = withToolDiagnostic(
          captureRoute(childId, provider, child?.options, child?.session, routingDetail),
          dispatched.resolution.diagnostic,
        )
        return await this.commit(starting, 'start-executor', {
          ...starting,
          revision: starting.revision + 1,
          executor: { ...executor, state: 'running', route },
        }, { stage: 'running', childId, ...(routingDetail === undefined ? {} : { routing: routingDetail }) })
      } catch (error: unknown) {
        // Record the reason ON THE EXECUTOR RECORD, not only in the run-level
        // `diagnostic`. A revoked executor is the artefact a later reader
        // inspects to ask "why did delegation never start", and the run-level
        // field is transition-scoped (see `commit`) so it does not survive the
        // next revision. `route.routeDiagnostic` does. The revoked route keeps
        // the starting record: upstream, a failed `startContinuable` rolls the
        // child back entirely, so there is no child session left to read an
        // observed route from — the honest status is the starting record's
        // `unverifiable` plus this failure note, never a fabricated observed.
        await this.commit(starting, 'start-executor', {
          ...starting,
          revision: starting.revision + 1,
          executor: {
            ...executor,
            state: 'revoked',
            route: withToolDiagnostic(executor.route, `executor startup failed: ${errorMessage(error)}`),
          },
          diagnostic: `executor startup failed: ${errorMessage(error)}`,
        }, { stage: 'revoked', childId, ...(routingDetail === undefined ? {} : { routing: routingDetail }) })
        throw error
      }
    })
  }

  async resumeExecutor(caller: AgentRef, request: { findings: string; nextPrompt: string; signal: AbortSignal }): Promise<Snapshot> {
    const root = this.resolveRoot(caller)
    return this.transact(root.id, async () => {
      const prior = this.require(root.id)
      if (prior.executor === undefined) throw new AutopilotError('no executor to resume', 'AP_NO_EXECUTOR')
      if (prior.executor.state !== 'running') {
        throw new AutopilotError(`executor is ${prior.executor.state}, cannot resume`, 'AP_EXECUTOR_NOT_RUNNING')
      }
      if (prior.phase !== 'executing') throw new AutopilotError(`cannot resume executor in phase ${prior.phase}`, 'AP_WRONG_PHASE')
      // Resume is the needs-fix channel ONLY (protocol: "only an execution-audit
      // needs-fix may resume the same executor"). Mechanically required, not
      // narrated: the gate must be needs-fix AND the latest execution/rules
      // audit must be a needs-fix captured at the CURRENT execution revision.
      if (prior.executionGate !== 'needs-fix') {
        throw new AutopilotError(
          `executor resume requires executionGate needs-fix (got ${prior.executionGate})`,
          'AP_RESUME_REQUIRES_NEEDS_FIX',
        )
      }
      const executionAudits = prior.audits.filter(record => record.role === 'execution' || record.role === 'rules')
      const latest = executionAudits[executionAudits.length - 1]
      if (latest === undefined || latest.verdict !== 'needs-fix'
        || latest.executionRevision !== prior.executor.executionRevision) {
        throw new AutopilotError(
          'executor resume requires the latest execution audit to be a needs-fix at the current execution revision',
          'AP_RESUME_REQUIRES_NEEDS_FIX',
        )
      }

      const nextRevision = prior.executor.executionRevision + 1
      await this.subagents.sendMessage(
        root,
        prior.executor.childId,
        [{ type: 'text', text: `[audit findings]\n${request.findings}\n\n[next dispatch]\n${request.nextPrompt}\n\n${packetRevisionHint(nextRevision)}` }],
        { signal: request.signal },
      )
      return await this.commit(prior, 'resume-executor', {
        ...prior,
        revision: prior.revision + 1,
        executor: { ...prior.executor, executionRevision: nextRevision },
        executionPacket: undefined,
      })
    })
  }

  /** Packet submission from the exact live executor child (delegated mode). */
  async submitExecutionPacket(child: AgentRef, request: {
    packet: string
    residualRisks: readonly string[]
    executionRevision: number
  }): Promise<Snapshot> {
    const root = this.resolveChildRoot(child)
    return this.transact(root.id, async () => {
      const prior = this.require(root.id)
      if (prior.executor === undefined) throw new AutopilotError('no executor authorized', 'AP_NO_EXECUTOR')
      if (prior.executor.childId !== child.id) {
        throw new AutopilotError(`child ${child.id} is not the authorized executor`, 'AP_EXECUTOR_MISMATCH')
      }
      if (prior.executor.state !== 'running') {
        throw new AutopilotError(`executor is ${prior.executor.state}, cannot submit`, 'AP_EXECUTOR_NOT_RUNNING')
      }
      if (prior.executionPacket !== undefined) {
        throw new AutopilotError('execution packet already submitted for this revision', 'AP_PACKET_EXISTS')
      }
      if (prior.phase !== 'executing') throw new AutopilotError(`cannot submit packet in phase ${prior.phase}`, 'AP_WRONG_PHASE')
      const claimed = request.executionRevision
      if (typeof claimed !== 'number' || !Number.isInteger(claimed)) {
        throw new AutopilotError(
          'execution packet must declare executionRevision (the live executor revision this packet is for)',
          'AP_PACKET_REVISION_REQUIRED',
        )
      }
      if (claimed !== prior.executor.executionRevision) {
        throw new AutopilotError(
          `execution packet executionRevision ${String(claimed)} does not match live ${String(prior.executor.executionRevision)}`,
          'AP_PACKET_REVISION_MISMATCH',
        )
      }

      // F6 (PR #2 Codex round 3): recapture the executor's OBSERVED route
      // leg HERE — the first executor-bearing op where a request has
      // actually run. `startContinuable` resolves before the child's first
      // turn, so the `running` record could not carry this leg; the child
      // submitting this packet has made at least one request, so its latest
      // `request/header` is finally readable. The refreshed record is a NEW
      // evidence read stamped as the ADDITIVE `routeRecapture` key on this
      // commit (the fold refuses executor mutation on submit-packet), and a
      // failed read keeps the prior record with the failure recorded — the
      // recapture is evidence, never a gate: it cannot refuse a packet.
      const recapture = recapturedExecutorRoute(prior.executor.childId, prior.executor.route, child.session)
      return await this.commit(prior, 'submit-packet', {
        ...prior,
        revision: prior.revision + 1,
        phase: 'execution-reviewing',
        executionPacket: request.packet,
        residualRisks: [...request.residualRisks],
      }, {
        executionRevision: claimed,
        generation: prior.executor.generation,
        childId: prior.executor.childId,
        routeRecapture: recapture,
      })
    })
  }

  /** Evidence submission from the root itself (inline mode). */
  async submitExecutionEvidence(caller: AgentRef, request: { report: string; residualRisks: readonly string[] }): Promise<Snapshot> {
    const root = this.resolveRoot(caller)
    return this.transact(root.id, async () => {
      const prior = this.require(root.id)
      if (prior.triage.executionMode !== 'inline') {
        throw new AutopilotError('inline evidence submission is illegal on delegated runs; the executor child submits the packet', 'AP_WRONG_EXECUTION_MODE')
      }
      if (prior.planGate !== 'pass') throw new AutopilotError('planGate must be pass before execution evidence', 'AP_PLAN_GATE_NOT_PASS')
      if (prior.phase !== 'executing') throw new AutopilotError(`cannot submit evidence in phase ${prior.phase}`, 'AP_WRONG_PHASE')
      return await this.commit(prior, 'submit-evidence', {
        ...prior,
        revision: prior.revision + 1,
        phase: 'execution-reviewing',
        executionPacket: request.report,
        residualRisks: [...request.residualRisks],
      })
    })
  }

  async log(caller: AgentRef, entry: {
    text: string
    stance: Stance
    note?: string
    escalationTarget?: LogEntry['escalationTarget']
    blockingScope?: LogEntry['blockingScope']
  }): Promise<Snapshot> {
    const root = this.resolveRoot(caller)
    if (entry.text.trim().length === 0) throw new AutopilotError('log text is empty', 'AP_INVALID_ARGUMENT')
    if (entry.stance === 'escalate' && (entry.note === undefined || entry.note.trim().length === 0)) {
      throw new AutopilotError('escalate checkpoints require a note (CC checkpoint contract)', 'AP_INVALID_ARGUMENT')
    }
    return this.transact(root.id, async () => {
      const prior = this.require(root.id)
      // Stance coupling, the converse of the rule above. `escalate` REQUIRES a
      // note; every other stance must not carry escalation fields at all.
      // Measured on the real host 2026-08-25: the driving model filled every
      // optional key with legal-but-meaningless values, so log.md rendered an
      // ON-PLAN checkpoint as `... -> root-agent (blocks: none)` — the
      // human-readable record reporting an escalation for a step that had none.
      // The values were valid enum members, so the schema could not catch it;
      // only the stance makes them meaningless.
      const escalating = entry.stance === 'escalate'
      const logEntry: LogEntry = {
        seq: prior.logCount,
        text: entry.text,
        stance: entry.stance,
        ...(entry.note === undefined ? {} : { note: entry.note }),
        ...(!escalating || entry.escalationTarget === undefined ? {} : { escalationTarget: entry.escalationTarget }),
        ...(!escalating || entry.blockingScope === undefined ? {} : { blockingScope: entry.blockingScope }),
      }
      const next = await this.commit(prior, 'log', {
        ...prior,
        revision: prior.revision + 1,
        logCount: prior.logCount + 1,
      }, logEntry)
      await this.store.appendLog(root.id, logEntry)
      return next
    })
  }

  async replan(caller: AgentRef, note: string): Promise<Snapshot> {
    const root = this.resolveRoot(caller)
    return this.transact(root.id, async () => {
      const prior = this.require(root.id)
      if (TERMINAL_PHASES.includes(prior.phase) || prior.phase === 'needs-owner-decision') {
        throw new AutopilotError(`cannot replan in phase ${prior.phase}`, 'AP_WRONG_PHASE')
      }
      const drained = await this.drainExecutorIfRunning(root, prior)
      if (drained !== undefined) return drained
      return await this.commit(prior, 'replan', {
        ...prior,
        revision: prior.revision + 1,
        phase: 'replanning',
        planGate: 'pending',
        executionGate: 'pending',
        executor: keepOrSetExecutorState(prior.executor, 'revoked'),
        executionPacket: undefined,
        diagnostic: note,
      })
    })
  }

  async setBlocked(caller: AgentRef, reason: string): Promise<Snapshot> {
    const root = this.resolveRoot(caller)
    return this.transact(root.id, async () => {
      const prior = this.require(root.id)
      return await this.commit(prior, 'set-blocked', {
        ...prior,
        revision: prior.revision + 1,
        phase: 'blocked',
        diagnostic: reason,
      })
    })
  }

  async setOwnerDecision(caller: AgentRef, reason: string): Promise<Snapshot> {
    const root = this.resolveRoot(caller)
    return this.transact(root.id, async () => {
      const prior = this.require(root.id)
      return await this.commit(prior, 'set-owner-decision', {
        ...prior,
        revision: prior.revision + 1,
        phase: 'needs-owner-decision',
        diagnostic: reason,
      })
    })
  }

  /** Owner-authority: grant one egress approval (the tool layer verifies the direct-human turn). */
  async ownerApprove(caller: AgentRef, target: string): Promise<Snapshot> {
    const root = this.resolveRoot(caller)
    if (target.trim().length === 0) throw new AutopilotError('approval target is empty', 'AP_INVALID_ARGUMENT')
    return this.transact(root.id, async () => {
      const prior = this.require(root.id)
      const approval: OwnerApproval = {
        seq: prior.enforcement.ownerApprovals.length,
        target,
        grantedAtRevision: prior.revision,
      }
      return await this.commit(prior, 'owner-approve', {
        ...prior,
        revision: prior.revision + 1,
        enforcement: { ...prior.enforcement, ownerApprovals: [...prior.enforcement.ownerApprovals, approval] },
      })
    })
  }

  /** Owner-authority: resolve a needs-owner-decision pause. */
  async ownerResolve(caller: AgentRef, request: { decision: 'resume-planning' | 'block'; note: string }): Promise<Snapshot> {
    const root = this.resolveRoot(caller)
    return this.transact(root.id, async () => {
      const prior = this.require(root.id)
      if (prior.phase !== 'needs-owner-decision') {
        throw new AutopilotError(`ownerResolve requires phase needs-owner-decision, got ${prior.phase}`, 'AP_WRONG_PHASE')
      }
      if (request.decision === 'block') {
        return await this.commit(prior, 'owner-resolve', {
          ...prior,
          revision: prior.revision + 1,
          phase: 'blocked',
          diagnostic: `owner ruling: ${request.note}`,
        })
      }
      return await this.commit(prior, 'owner-resolve', {
        ...prior,
        revision: prior.revision + 1,
        phase: 'planning',
        planGate: 'pending',
        executionGate: 'pending',
        consecutiveReplans: 0,
        executionPacket: undefined,
        diagnostic: `owner ruling: ${request.note}`,
      })
    })
  }

  /**
   * Declare (or re-declare) one usage-evidence entry.
   *
   * Last-wins on the id: a run upgrades `undeclared` to a real class by
   * declaring the same id again. The whole call is REFUSED when the entry is
   * malformed, before the transaction opens — a rejected declaration leaves
   * the event stream byte-identical, so a run cannot half-declare its way past
   * the plan gate.
   * @throws AutopilotError `AP_USAGE_INVALID` listing every violated rule.
   */
  async declareUsage(caller: AgentRef, entry: UsageEntry): Promise<Snapshot> {
    const root = this.resolveRoot(caller)
    const problems = validateUsageEntry(entry)
    if (problems.length > 0) {
      throw new AutopilotError(`usage declaration rejected: ${problems.join('; ')}`, 'AP_USAGE_INVALID')
    }
    return this.transact(root.id, async () => {
      const prior = this.require(root.id)
      const existing = prior.usage?.entries ?? []
      const replaced = existing.some(item => item.id === entry.id)
      const entries = replaced
        ? existing.map(item => (item.id === entry.id ? entry : item))
        : [...existing, entry]
      const usage: UsageEvidence = { entries }
      return await this.commit(prior, 'declare-usage', {
        ...prior,
        revision: prior.revision + 1,
        usage,
      }, { id: entry.id, usageClass: entry.usageClass, replaced })
    })
  }

  async submitCloseout(caller: AgentRef, closeout: Closeout): Promise<Snapshot> {
    const root = this.resolveRoot(caller)
    return this.transact(root.id, async () => {
      const prior = this.require(root.id)
      if (prior.phase !== 'closing') {
        throw new AutopilotError(`closeout requires phase closing, got ${prior.phase}`, 'AP_WRONG_PHASE')
      }
      // Kinds are checked HERE, before anything is built, so the refusal names
      // the actual defect. `evaluateCompletion` below would also refuse a
      // kind-less proven entry, but only as one more line inside
      // AP_COMPLETION_REFUSED, and the caller cannot act on that.
      const kindProblems = evidenceKindProblems(closeout.evidence, { requireKind: true })
      const firstKindProblem = kindProblems[0]
      if (firstKindProblem !== undefined) {
        throw new AutopilotError(
          `closeout refused: ${kindProblems.map(problem => problem.message).join('; ')}`,
          firstKindProblem.code,
        )
      }
      const candidate: Snapshot = {
        ...prior,
        revision: prior.revision + 1,
        phase: 'completed',
        closeout,
      }
      // Settlement runs HERE and not in the fold: it reads the filesystem, and
      // replay of an old stream must not depend on artifacts still being on
      // disk. `runDir` is the store's, so both backends settle against the
      // same directory.
      const check = evaluateCompletion(candidate, {
        runDir: this.store.runDir(root.id),
        settleUsage: settleUsageArtifacts,
        settleExternal: settleExternalReviews,
        // The freshness UPPER bound needs a clock, and this is the only place
        // one may be read. `settleUsageArtifacts` deliberately defaults no
        // clock so that REPLAY stays deterministic (fold.ts settles without
        // options); but closeout is not replay, and without a `settledAt` the
        // future-stamp arm is inert in production — measured 2026-08-25 on the
        // real host, where an artifact stamped 2027-01-01 settled clean and the
        // run reached `completed` while 15 unit bearers for the rule passed.
        // A checker whose bearers all sit on a code path production never takes
        // carries no information (DESIGN.md §5).
        settledAt: new Date().toISOString(),
        requireKind: true,
      })
      if (!check.ok) {
        throw new AutopilotError(`completion refused: ${check.problems.join('; ')}`, 'AP_COMPLETION_REFUSED')
      }
      // The format stamp. It says what THIS writer guaranteed, so a later
      // replay can hold this event to the current rule without holding older
      // events to a rule that did not exist when they were written.
      return await this.commit(prior, 'submit-closeout', candidate, { evidenceKinds: 1 })
    })
  }

  // ── Read surfaces for gate/policy/tools (no root-authority requirement) ──

  /** Peek the run rooted at one session id (undefined when none). */
  peek(rootSessionId: string): Snapshot | undefined {
    return this.current(rootSessionId)
  }

  /**
   * Peek, revalidated against the store first.
   *
   * This is what the read-only `ctx.autopilot` surface — and therefore the web
   * routes — must call, so a GET answers with the revision the medium holds
   * rather than the one this process happened to load first. Every mutating
   * path keeps using {@link peek}; see {@link currentFresh} for why the two
   * are deliberately different reads.
   *
   * @param rootSessionId - the run id.
   * @returns the freshest snapshot this process can justify, or undefined.
   */
  peekFresh(rootSessionId: string): Snapshot | undefined {
    return this.currentFresh(rootSessionId)
  }

  /**
   * The run's artifact directory: where `log.md`, the outbound manifest, and
   * usage artifacts live. Both store backends answer the same path, so an
   * artifact ref recorded under one backend stays valid under the other.
   */
  runDirOf(rootSessionId: string): string {
    return this.store.runDir(rootSessionId)
  }

  /** Which backend this engine's canonical stream actually lives in. */
  get storeKind(): Snapshot['enforcement']['store'] {
    return this.store.kind
  }

  /** Run ids this engine has materialized in memory (read-only service surface). */
  /**
   * Every run this engine can serve, asked of the STORE and not of the cache.
   *
   * The cache-only answer shipped and was measured wrong on 2026-08-25: a
   * freshly booted web profile served `/api/autopilot/runs` -> `[]` while the
   * store held dozens, and the list grew only as individual ids were probed —
   * enumeration was hydration-order dependent. The cache is still unioned in
   * because it is authoritative for the CURRENT process (a run committed this
   * tick is in both, and a store that cannot enumerate still answers for what
   * this process is actively driving).
   */
  listRuns(): readonly RunId[] {
    const seen = new Set<RunId>(this.cache.keys())
    try {
      for (const id of this.store.listRuns()) seen.add(id)
    } catch {
      // Enumeration is a convenience surface: a store that cannot list must
      // not take down the runs this process is already driving.
    }
    return [...seen]
  }

  executorStatus(caller: AgentRef): { generation: number; executionRevision: number } | undefined {
    const root = this.resolveRoot(caller)
    const snapshot = this.current(root.id)
    if (snapshot?.executor === undefined) return undefined
    return { generation: snapshot.executor.generation, executionRevision: snapshot.executor.executionRevision }
  }

  /**
   * Consume one unconsumed owner approval for an egress command.
   *
   * v1 ran this inside the SYNCHRONOUS `ToolGuard`, which is what forced the
   * store's commit to be synchronous too. v2 calls it from the async
   * `tools/pre-execute` waterfall instead, so it can serialize on the run's
   * transaction queue like every other mutation — an approval can no longer be
   * consumed concurrently with an in-flight audit commit.
   *
   * AN APPROVAL IS NOT A FUNGIBLE TOKEN. This used to take the first
   * unconsumed approval regardless of what it said, so `owner-approve` on
   * "ONLY the README typo fix" silently authorized `git push origin main` —
   * and because the pre-execute seam consumes BEFORE it asks, the human saw no
   * prompt at all. The manifest binds a command class but is agent-authored;
   * the approval is the one human-authored artifact in the egress chain, so its
   * text has to be load-bearing. {@link approvalAuthorizes} states the rule.
   * A non-matching approval is left UNCONSUMED and this returns undefined, so
   * the seam falls through to `ask` and the owner still sees the question.
   * @returns the consumed approval's seq, or undefined when none matches.
   */
  async consumeApproval(rootSessionId: string, command: string): Promise<number | undefined> {
    return this.transact(rootSessionId, async () => {
      const prior = this.current(rootSessionId)
      if (prior === undefined) return undefined
      const open = prior.enforcement.ownerApprovals.find(entry =>
        entry.consumedBy === undefined && approvalAuthorizes(entry.target, command))
      if (open === undefined) return undefined
      const approvals = prior.enforcement.ownerApprovals.map(entry =>
        entry.seq === open.seq ? { ...entry, consumedBy: command.slice(0, 500) } : entry)
      await this.commit(prior, 'consume-approval', {
        ...prior,
        revision: prior.revision + 1,
        enforcement: { ...prior.enforcement, ownerApprovals: approvals },
      }, { seq: open.seq, command: command.slice(0, 500) })
      return open.seq
    })
  }

  /**
   * Record that an outbound evidence manifest was archived and spent by one
   * egress command, bumping `enforcement.outboundConsumed`.
   *
   * Called from the `tools/execute` seam, i.e. only for a call that actually
   * dispatches. That is the correct consumption point: a manifest proposed for
   * an egress the human then rejected was never spent, and burning it at
   * pre-execute would force the run to author a fresh manifest for a command
   * that never left the machine.
   * @returns the new consumed count, or undefined when no run is bound.
   */
  async recordManifestConsumed(rootSessionId: string, detail: {
    readonly command: string
    readonly archivedAt: string
    readonly target: string
  }): Promise<number | undefined> {
    return this.transact(rootSessionId, async () => {
      const prior = this.current(rootSessionId)
      if (prior === undefined) return undefined
      const consumed = (prior.enforcement.outboundConsumed ?? 0) + 1
      const next = await this.commit(prior, 'consume-manifest', {
        ...prior,
        revision: prior.revision + 1,
        enforcement: { ...prior.enforcement, outboundConsumed: consumed },
      }, { ...detail, command: detail.command.slice(0, 500) })
      return next.enforcement.outboundConsumed
    })
  }

  /** Bump the turn-stop reminder counter; returns the new count, or undefined when the budget is spent. */
  async bumpReminder(rootSessionId: string): Promise<number | undefined> {
    return this.transact(rootSessionId, async () => {
      const prior = this.current(rootSessionId)
      if (prior === undefined) return undefined
      if (prior.enforcement.reminders >= MAX_STOP_REMINDERS) return undefined
      const next = await this.commit(prior, 'reminder', {
        ...prior,
        revision: prior.revision + 1,
        enforcement: { ...prior.enforcement, reminders: prior.enforcement.reminders + 1 },
      })
      return next.enforcement.reminders
    })
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private resolveRoot(caller: AgentRef): AgentRef {
    const live = this.agents.get(caller.id)
    if (live === undefined || live !== caller) {
      throw new AutopilotError(`Agent ${caller.id} is not the live registered root`, 'AP_NOT_LIVE_ROOT')
    }
    if (caller.session.header.parentSession !== undefined) {
      throw new AutopilotError(`Agent ${caller.id} has a parent session; the autopilot root must be top-level`, 'AP_NOT_ROOT')
    }
    return caller
  }

  private resolveChildRoot(child: AgentRef): AgentRef {
    const liveChild = this.agents.get(child.id)
    if (liveChild === undefined || liveChild !== child) {
      throw new AutopilotError(`Agent ${child.id} is not the live registered executor child`, 'AP_EXECUTOR_MISMATCH')
    }
    const parentId = child.session.header.parentSession
    if (parentId === undefined) throw new AutopilotError('executor child has no parent session', 'AP_NO_PARENT')
    const parent = this.agents.get(parentId)
    if (parent === undefined) throw new AutopilotError('parent agent not found', 'AP_PARENT_NOT_FOUND')
    if (parent.session.header.parentSession !== undefined) {
      throw new AutopilotError('executor parent is not a top-level root', 'AP_PARENT_NOT_ROOT')
    }
    return parent
  }

  private current(runId: RunId): Snapshot | undefined {
    const cached = this.cache.get(runId)
    if (cached !== undefined) return cached
    const loaded = this.store.load(runId)
    if (loaded !== undefined) {
      this.cache.set(runId, loaded)
      // P2-3: engine load is the earliest moment a fresh process can observe a
      // parked planning-phase run — and the moment its lost planner install
      // (which died with the previous process) becomes re-armable.
      this.schedulePlannerRearm(runId, loaded)
    }
    return loaded
  }

  /**
   * Whether the planner role's routing is ACTIVE for reload re-arm purposes
   * (P2-3): a non-inherit planner mode under an active routing section. The
   * shipped default (planner inherit) never schedules anything, so zero-config
   * deployments are untouched by the reload path.
   */
  private plannerRoutingActive(): boolean {
    // F2: the CURRENT routing decides — an invalid live section reads as the
    // conservative all-inherit shape ⇒ inactive, so no re-arm is scheduled on
    // config the code cannot validate.
    const routing = this.routingConfig().routing
    return routing.roles.planner.mode !== 'inherit' && routingActive(routing, 'planner')
  }

  /**
   * The reload re-arm (P2-3, execution-audit r1; the plan-faithful variant).
   *
   * `plannerInstalls` is engine-local; after a restart with a run parked in a
   * planning phase, the durable stream says `plannerRouting: 'routed'` while
   * this process holds no install — the next planning turns would run on the
   * deployment default. On ENGINE LOAD of such a run:
   *
   *  1. the run is marked for a one-shot durable re-arm record on its next
   *     planning-phase commit (`plannerReloadStamps`) — the honest record
   *     either way, because a re-arm that DEGRADED (the route is no longer
   *     resolvable against current facts) must not leave the old `routed`
   *     claim standing unqualified;
   *  2. when the live root agent is already registered, the install is
   *     re-armed IMMEDIATELY — re-resolved against CURRENT policy/catalog
   *     facts, never resurrected — through `transact`, so it serializes with
   *     commits instead of racing them. A queued arm that finds the state
   *     already present (a commit armed first) is a no-op; one that finds the
   *     run left planning is a no-op; a throw is swallowed — the commit
   *     chokepoint remains the mechanical enforcer of the arm invariant.
   *
   * When the root is NOT observable at load (a read-only peek on a fresh web
   * process), arming now would record a FALSE `unsupported` degradation ("no
   * scoped ctx" for an agent that is merely unregistered), so the re-arm
   * defers to the commit chokepoint, where every op has a resolveRoot-verified
   * live agent — and the one-shot stamp still names the reload there.
   */
  private schedulePlannerRearm(runId: RunId, loaded: Snapshot): void {
    if (!PLANNING_PHASES.includes(loaded.phase)) return
    if (!this.plannerRoutingActive()) return
    this.plannerReloadStamps.add(runId)
    if (this.plannerInstalls.has(runId)) return
    if (this.agents.get(runId) === undefined) return
    void this.transact(runId, async () => {
      if (this.lifecycle.signal.aborted) return
      if (this.plannerInstalls.has(runId)) return
      const snapshot = this.current(runId)
      if (snapshot === undefined || !PLANNING_PHASES.includes(snapshot.phase)) return
      await this.armPlannerSelection(runId, snapshot)
    }).catch(() => {
      // Never fatal on this fire-and-forget path: the commit chokepoint will
      // re-attempt the arm and unwind it on failure, exactly as before.
    })
  }

  /**
   * Consume a pending reload stamp (P2-3): the first planning-phase commit
   * after the re-arm records it ONCE, durably, with the honest caveat that
   * turns between the reload and the re-arm may have run on the default.
   */
  private notePlannerReload(runId: RunId, record: PlannerRoutingRecord): PlannerRoutingRecord {
    if (!this.plannerReloadStamps.delete(runId)) return record
    return { ...record, why: [...record.why, PLANNER_REARM_NOTE] }
  }

  /**
   * The same read, revalidated against the store — the READ-ONLY path.
   *
   * THE DEFECT THIS CLOSES, measured 2026-08-25 and again 2026-08-27:
   * {@link current} memoizes per run id and has no invalidation at all, which
   * is correct for the process DRIVING a run (it is the single writer, so its
   * memo is the newest thing that exists) and wrong for a process merely
   * SERVING one. A web profile that answered `/api/autopilot/run?id=` for a run
   * a headless process was advancing served its first observation forever: the
   * revision never moved, no matter how long the caller polled.
   *
   * WHY IT IS A SECOND METHOD AND NOT A FIX TO `current`. `current` is what
   * every WRITE path reads inside `transact` before validating a transition.
   * Making that path re-read the medium would import another process's writes
   * into the middle of this process's transaction — turning a single-writer
   * design into a lost-update race. So the revalidation lives exactly where
   * reading is all that happens, and single-writer semantics are untouched.
   *
   * WHY IT CANNOT REGRESS A WRITER'S OWN RUN: the probe is compared with `>`.
   * For a run this process writes, the on-disk revision equals the memo's
   * (commit persists, then caches), so the reload never fires. It fires only
   * when the medium is genuinely AHEAD, which only a foreign writer can do.
   *
   * A backend with no probe, a probe that throws, and an unreadable projection
   * all mean the same thing — "not observed to be stale" — and all keep the
   * memo. Claiming freshness the code cannot observe is the one move this
   * codebase's doctrine forbids; serving the last known-good revision is the
   * honest floor. What is NOT swallowed is a corrupt stream: if the probe says
   * the medium moved and the fold then rejects it, that throws, because a
   * broken canonical stream must be loud rather than papered over with a stale
   * snapshot.
   *
   * @param runId - the run to read.
   * @returns the freshest snapshot this process can justify.
   */
  private currentFresh(runId: RunId): Snapshot | undefined {
    const cached = this.cache.get(runId)
    if (cached === undefined) return this.current(runId)
    let onDisk: number | undefined
    try {
      onDisk = this.store.currentRevision?.(runId)
    } catch {
      return cached
    }
    if (onDisk === undefined || onDisk <= cached.revision) return cached
    const loaded = this.store.load(runId)
    if (loaded === undefined) return cached
    this.cache.set(runId, loaded)
    return loaded
  }

  private require(runId: RunId): Snapshot {
    const snapshot = this.current(runId)
    if (snapshot === undefined) throw new AutopilotError('no autopilot run on this session; call autopilot_init first', 'AP_NOT_INITIALIZED')
    return snapshot
  }

  /**
   * Validate against the fold, persist, and cache.
   *
   * The ORDER is load-bearing and unchanged by v2's async store: `applyEvent`
   * runs SYNCHRONOUSLY, against the in-memory prior snapshot, before the first
   * byte reaches any backend. An illegal transition is therefore refused
   * before it is written, never unwound after. The `await` below is a
   * DURABILITY boundary only — no invariant moved behind it.
   */
  private async commit(prior: Snapshot | undefined, op: Operation, next: Snapshot, detail?: unknown): Promise<Snapshot> {
    // `diagnostic` IS TRANSITION-SCOPED: it explains why THIS revision looks the
    // way it does, and every caller here builds `next` by spreading the prior
    // snapshot. Without this, a refusal string outlives the condition that
    // produced it — live, revisions 5 and 6 both read "plan gate refused despite
    // a pass verdict" while revision 6 already had `planGate: 'pass'`, i.e. the
    // snapshot contradicted itself and a model reading status was told the gate
    // had refused when it had passed.
    //
    // THE RULE: a diagnostic that is byte-identical to the prior revision's was
    // carried by the spread, not restated, so it is dropped. Callers that mean
    // to say something about this transition set a NEW string and keep it.
    //
    // Honest ceiling: a caller that genuinely wants to repeat the previous
    // revision's diagnostic verbatim cannot, because carried and restated are
    // indistinguishable here. No path in this file needs to — the verdict
    // diagnostics are terminal-phase writes and `assertAuditPhase` blocks a
    // second audit from those phases — and the alternative (auditing every one
    // of the ~20 spread sites) fails open the moment a new one is added.
    const scoped = prior !== undefined && next.diagnostic !== undefined && next.diagnostic === prior.diagnostic
      ? withoutDiagnostic(next)
      : next
    // ── M6 planner install (engine-local; plan "Roles and routing") ──────
    //
    // The planner IS the root agent, so its route is a model selection
    // INSTALLED on the root's scoped ctx, not a dispatch. This is the one
    // choke point every transition passes through, so the invariant is
    // enforced mechanically: the install is armed exactly while the run sits
    // in a planning phase. ARM runs BEFORE the event is validated/persisted so
    // the record stamped on this event reflects the LIVE install (and a fold
    // or store failure unwinds a fresh install rather than orphaning it);
    // DISPOSE runs only AFTER the transition persisted — a rejected transition
    // must not leave planning without its model selection.
    //
    // F4 (PR #2 Codex review, round 2): an EXISTING install is re-evaluated
    // here too — the decision is re-resolved from CURRENT facts at every
    // planning-phase commit, and only a CHANGED decision churns the install
    // (dispose + re-arm, recorded from→to). Unchanged decisions keep the
    // arm-once economics: no extra install/dispose, no extra record.
    const wasPlanning = prior !== undefined && PLANNING_PHASES.includes(prior.phase)
    const isPlanning = PLANNING_PHASES.includes(scoped.phase)
    let stampedDetail = detail
    let armedHere = false
    if (isPlanning && !this.plannerInstalls.has(scoped.runId)) {
      armedHere = true
      const record = await this.armPlannerSelection(scoped.runId, scoped)
      if (record !== undefined) {
        // Additive key on the event's detail; the fold validates
        // `detail.routing` on dispatch ops only and ignores this everywhere,
        // and `init`'s detail is unchecked — the durable degradation record
        // the packet requires ("recorded, never silent, never fatal"). A
        // reload re-arm (P2-3) carries the one-shot reload note here too.
        stampedDetail = withPlannerDetail(detail, this.notePlannerReload(scoped.runId, record))
      }
    } else if (isPlanning) {
      const refreshed = await this.refreshPlannerInstall(scoped.runId, scoped)
      if (refreshed !== undefined) {
        // A changed decision re-armed the install: the new record (from→to in
        // its `why`) is this commit's durable plannerRouting, and a failed
        // commit unwinds the re-arm exactly as it unwinds a fresh one.
        armedHere = true
        stampedDetail = withPlannerDetail(detail, this.notePlannerReload(scoped.runId, refreshed))
      } else if (this.plannerReloadStamps.has(scoped.runId)) {
        // P2-3: the install was re-armed at ENGINE LOAD of this planning-phase
        // run — before this commit — so this commit owes the durable re-arm
        // record once (the armed state itself stamps nothing on later commits).
        const state = this.plannerInstalls.get(scoped.runId)
        if (state?.kind === 'armed') {
          stampedDetail = withPlannerDetail(detail, this.notePlannerReload(scoped.runId, state.record))
        }
      }
    }
    const candidate: RunEvent = {
      v: 1,
      op,
      revision: scoped.revision,
      time: new Date().toISOString(),
      snapshot: scoped,
      ...(stampedDetail === undefined ? {} : { detail: stampedDetail }),
    }
    try {
      applyEvent(prior, candidate)
      await this.store.commit(scoped.runId, op, scoped, stampedDetail)
    } catch (error: unknown) {
      // The transition did not happen; whatever arm state this call created
      // must not survive it (disposed AND deleted — a retried transition
      // re-resolves from current facts instead of trusting a stale arm).
      if (armedHere) this.disposePlanner(scoped.runId)
      throw error
    }
    this.cache.set(scoped.runId, scoped)
    if (wasPlanning && !isPlanning) this.disposePlanner(scoped.runId)
    return scoped
  }

  private transact<T>(runId: RunId, operation: () => Promise<T>): Promise<T> {
    if (this.lifecycle.signal.aborted) {
      return Promise.reject(new AutopilotError('autopilot engine disposed', 'AP_DISPOSED'))
    }
    const prior = this.tails.get(runId) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.tails.set(runId, tail)
    void tail.finally(() => {
      if (this.tails.get(runId) === tail) this.tails.delete(runId)
    })
    return run
  }

  /** The deployment's restrictable tool names: learned first, probed second, unknown last. */
  private knownToolNames(): readonly string[] | undefined {
    if (this.learnedToolNames !== undefined) return this.learnedToolNames
    try {
      return this.environment.registeredToolNames?.()
    } catch {
      // Same doctrine as every other probe here: a throwing probe never
      // upgrades a claim, it just leaves the answer unobserved.
      return undefined
    }
  }

  /**
   * Dispatch a child under a tool allow-list the deployment can actually honour.
   *
   * Two attempts at most. The first uses whatever registry is known (the probe,
   * or a registry a previous dispatch already learned); if the host rejects it
   * with the restrict-unknown-name error, the rejection itself carries the
   * deployment's complete restrictable set, so the engine learns it, re-resolves
   * against it, and retries ONCE. A rejection of any other shape, or a
   * re-resolution that would send the same list again, rethrows unchanged — the
   * repair may never mask a failure it did not diagnose.
   *
   * Retrying is safe against the upstream contract: a subagent creation that
   * throws inside its setup callback rolls back to no Activation, no handle and
   * no ownership before rejecting (`packages/subagent/subagent/src/continuation.ts`),
   * so the second attempt starts from a clean slate rather than a half-built child.
   * @param spec - the requested names, the names that may not be narrowed away, and a label for diagnostics.
   * @param dispatch - performs the actual start with a given allow-list.
   * @returns the dispatch result and the resolution that produced it.
   */
  private async dispatchWithToolAllow<T>(
    spec: { readonly requested: readonly string[]; readonly required: readonly string[]; readonly label: string },
    dispatch: (allow: readonly string[]) => Promise<T>,
  ): Promise<{ readonly value: T; readonly resolution: ToolAllowResolution }> {
    const first = resolveToolAllow(spec.requested, this.knownToolNames(), spec.required, spec.label)
    try {
      return { value: await dispatch(first.allow), resolution: first }
    } catch (error: unknown) {
      const parsed = parseRestrictRejection(errorMessage(error))
      if (parsed === undefined) throw error
      this.learnedToolNames = parsed.known
      // May THROW AP_TOOL_SURFACE_INCOMPLETE, and should: replacing an opaque
      // upstream name error with "this deployment has no shell for the executor"
      // is the whole point of learning the registry.
      const repaired = resolveToolAllow(spec.requested, parsed.known, spec.required, spec.label)
      if (repaired.allow.join('\u0000') === first.allow.join('\u0000')) throw error
      return { value: await dispatch(repaired.allow), resolution: repaired }
    }
  }

  // ── Role-true routing resolution (plan v3 "Roles and routing" + "Route records and stability") ──

  /**
   * The session policy, read defensively: an absent or throwing reader is an
   * UNREACHABLE projection (inheritance only, recorded `unreachable-inherit`),
   * never a guess and never a blocked dispatch.
   */
  private readPolicy(root: AgentRef): SessionPolicyState {
    const reader = this.routingPorts.policyReader
    if (reader === undefined) return { kind: 'unreachable' }
    try {
      return reader(root)
    } catch {
      return { kind: 'unreachable' }
    }
  }

  /** The legacy agentOptions surface for one role, if any (E2 leaves it here with its 0.2.0 meaning). */
  private legacyOptionsFor(role: Role): AgentOptionsLike | undefined {
    if (role === 'executor') return this.config.executor.agentOptions
    if (role === 'plan-auditor') return this.config.auditors.plan?.agentOptions
    if (role === 'execution-auditor') return this.config.auditors.execution?.agentOptions
    if (role === 'rules-auditor') return this.config.auditors.rules?.agentOptions
    return undefined
  }

  /** The config-surface name of one role's legacy route, for provenance notes. */
  private legacySurfaceOf(role: Role): string {
    if (role === 'executor') return 'executor.agentOptions'
    if (role === 'plan-auditor') return 'auditors.plan.agentOptions'
    if (role === 'execution-auditor') return 'auditors.execution.agentOptions'
    return 'auditors.rules.agentOptions'
  }

  /**
   * The [R2-P1-1] provenance note: a locked role whose lock equals the legacy
   * explicit route was mapped from the legacy surface at resolve, and the
   * record says so — `resolveConfig` collapses `routing-lock` and `legacy-role`
   * into one `locked` shape, so this engine-side comparison is the only place
   * the true grant source can still be named without re-widening the routing
   * core's `RoleRouting` shape.
   */
  private legacyLockNote(role: Role, roleRouting: RoleRouting): string | undefined {
    if (roleRouting.mode !== 'locked') return undefined
    const legacy = toRoutePin(this.legacyOptionsFor(role))
    if (legacy === undefined) return undefined
    if (legacy.provider !== roleRouting.provider || legacy.model !== roleRouting.model) return undefined
    return `authorization: grant source is the legacy ${this.legacySurfaceOf(role)} surface — mapped to a locked role at config resolve ([R2-P1-1]: a plugin-config grant under the one rule)`
  }

  /**
   * Whether the legacy surface's route EQUALS the lock — E2's riding
   * condition: exactly then the legacy NON-ROUTE tuning rides the locked
   * dispatch (`lockedAgentOptions`). One definition of the equal-route
   * branch so the dispatch composition and the F16 composed-preflight note
   * can never disagree about what rode.
   */
  private legacyTuningRides(role: Role, roleRouting: RoleRouting & { readonly mode: 'locked' }): boolean {
    const legacyPin = toRoutePin(this.legacyOptionsFor(role))
    return legacyPin !== undefined && legacyPin.provider === roleRouting.provider && legacyPin.model === roleRouting.model
  }

  /**
   * The dispatch agentOptions for a locked role. When the legacy surface's
   * route EQUALS the lock, the legacy NON-ROUTE tuning rides (`maxTokens` and
   * siblings keep their 0.2.0 meaning — E2's resolve contract) while the
   * route identity fields — `provider`, `model`, AND `reasoningEffort` — are
   * built from the lock itself (F11, PR #2 Codex round 5): an effort present
   * in legacy but absent from the lock is NOT dispatched, because preflight
   * and route evidence run on the lock's fields and the dispatched child must
   * match both the explicit lock and its recorded evidence. When the legacy
   * route is unequal or absent, the lock's own fields only — nothing rides
   * from a legacy surface the lock did not confirm.
   */
  private lockedAgentOptions(role: Role, roleRouting: RoleRouting & { readonly mode: 'locked' }): AgentOptionsLike {
    const legacy = this.legacyOptionsFor(role)
    if (this.legacyTuningRides(role, roleRouting) && legacy !== undefined) {
      // Strip the legacy ROUTE identity; keep every other field as tuning.
      const { provider: _legacyProvider, model: _legacyModel, reasoningEffort: _legacyEffort, ...tuning } = legacy
      return {
        ...tuning,
        provider: roleRouting.provider,
        model: roleRouting.model,
        ...(roleRouting.reasoningEffort === undefined ? {} : { reasoningEffort: roleRouting.reasoningEffort }),
      }
    }
    return {
      provider: roleRouting.provider,
      model: roleRouting.model,
      ...(roleRouting.reasoningEffort === undefined ? {} : { reasoningEffort: roleRouting.reasoningEffort }),
    }
  }

  /**
   * F16 (PR #2 Codex round 7): preflight the FULLY COMPOSED locked dispatch —
   * the exact object the subagent start receives — BEFORE it is dispatched.
   *
   * The seam decision, documented: `selectLocked`'s preflight validates the
   * LOCK's route fields (provider/model/reasoningEffort — existing behavior,
   * unchanged), but the dispatch object is composed ENGINE-side by
   * `lockedAgentOptions`, which rides the legacy NON-ROUTE tuning
   * (`maxTokens` and siblings) onto the equal-route branch. The selector is
   * pure w.r.t. that composition (it is E2/engine knowledge — the selector
   * must stay free of legacy-surface concerns), so its preflight can only
   * ever see the bare lock: an adapter-INVALID retained `maxTokens` passed
   * routing preflight and failed the actual dispatch mid-run. The honest
   * place to validate the composed object is therefore the engine's locked
   * dispatch call site (the engine holds the catalog port). The check runs
   * UNIFORMLY for every locked dispatch — the invariant is "the engine
   * preflights exactly what it dispatches", with no conditional logic that
   * could drift from `lockedAgentOptions`'s own branch — so on the
   * unequal/absent-legacy path it re-validates the bare lock the selector
   * just accepted (a redundant validation call, never a dispatch), and on
   * the equal-route path it is the FIRST time the riding tuning is checked.
   * `preflight`/`resolveCallConfig` validates without binding the later
   * dispatch (the port's upstream contract), so this is one more validation
   * call, not a double dispatch; grant and escalation semantics are
   * untouched — a rejection takes the existing owner-escalation exit BEFORE
   * any subagent start, with the adapter's reason named, instead of a
   * mid-run failure at the audit/executor dispatch.
   */
  private async preflightComposedLockedDispatch(
    role: Role,
    roleRouting: RoleRouting & { readonly mode: 'locked' },
    resolution: Extract<RoleRouteResolution, { readonly kind: 'dispatch' }>,
    catalog: RouteCatalog,
  ): Promise<RoleRouteResolution> {
    const composed = resolution.agentOptions
    if (composed === undefined) return resolution
    try {
      await catalog.preflight({
        ...composed,
        // Route identity normalized to the lock's fields — the same values
        // `lockedAgentOptions` just wrote, pinned so the object satisfies the
        // port's required provider/model regardless of the optional mirror.
        provider: roleRouting.provider,
        model: roleRouting.model,
      })
    } catch (error) {
      return {
        kind: 'escalate',
        reason:
          `locked route ${roleRouting.provider}/${roleRouting.model} dispatch config failed preflight (${errorMessage(error)}) — ` +
          'the routing core validated the lock\'s route fields, but the composed dispatch (lock route + riding legacy non-route tuning) is not adapter-valid; ' +
          'a lock has no fallback candidate — dispatch blocked BEFORE start',
      }
    }
    if (resolution.routing === undefined) return resolution
    const note = this.legacyTuningRides(role, roleRouting)
      ? 'preflight: resolveCallConfig accepted the composed dispatch (lock route + legacy non-route tuning) — the exact object the subagent start receives'
      : 'preflight: resolveCallConfig accepted the composed dispatch (the lock\'s own fields — no legacy tuning rides)'
    return { ...resolution, routing: { ...resolution.routing, why: [...resolution.routing.why, note] } }
  }

  /**
   * Resolve one role's route for dispatch, implementing the plan's rule table
   * through the E1/E2 core. Decision kinds map exactly: `route` ⇒ agentOptions
   * + pin write; `inherit` ⇒ no agentOptions (still a dispatch — recorded);
   * `escalate-owner`/`blocked` ⇒ the owner-escalation exit, with the reason.
   */
  /**
   * The executor's CURRENT route for auditor-independence axes, in fallback
   * order: the dispatch pin when one exists; else the CURRENT live routing
   * lock for the executor (`routing.roles.executor` under `mode: 'locked'` —
   * F5, PR #2 Codex review round 2: a lock is a DECLARED family even before
   * the executor's first dispatch, so a medium+ plan audit dispatched before
   * the executor still gets real axes instead of `unknown` on every
   * candidate); else the legacy `executor.agentOptions` surface (the 0.2.0
   * family source — an executor that has not dispatched yet still has a
   * declared family). Recomputed at every dispatch; never a stored judgment.
   * The routing leg is the per-decision LIVE read (F2): a volatile lock patch
   * reaches the next audit's axes without a remount, and an invalid live
   * section reads as the all-inherit `REFUSED_ROUTING` shape, so no lock is
   * claimed from config the code cannot validate.
   */
  private executorPinOf(prior: Snapshot): RoutePin | undefined {
    const pinned = prior.routingPins?.executor
    if (pinned !== undefined) return toRoutePin(pinned)
    const executorRouting = this.routingConfig().routing.roles.executor
    if (executorRouting.mode === 'locked') {
      return { provider: executorRouting.provider, model: executorRouting.model }
    }
    return toRoutePin(this.config.executor.agentOptions)
  }

  /**
   * F21 (PR #2 Codex round 10): the pool as the engine CONSTRUCTS from it —
   * every entry's `reasoningEffort` normalized exactly the way lock
   * resolution normalizes a lock's effort (`effortOf` in resolveRouting:
   * trimmed when non-blank, ABSENCE when blank/whitespace). THE ONE SEAM:
   * every place the engine converts a pool entry into a routing pin, dispatch
   * agentOptions, or a preflight reads THIS pool — the walk in `poolFallback`,
   * the reuse recovery in `auditorPoolMatchFor`, and both `selectCrossFamily`
   * policy inputs — so dispatch, pin, preflight, and the fold's detail
   * validation can never disagree about the effort a pool entry names. The
   * config schema accepts `''`/whitespace efforts, and before this seam the
   * blank value was copied into the pin AND dispatched while the fold rejects
   * a pin whose effort is empty — a completed plan audit's verdict commit then
   * failed AFTER the run had entered plan-reviewing, wedging it there. A
   * blank pool effort now means what a blank lock effort already meant: the
   * entry names no effort at all. `config.crossFamily.pool` itself is kept
   * verbatim (resolved config is read-only, and in-place owner edits remain
   * live — normalization is applied at consumption, per decision, not by
   * mutating the resolved object); route identity (provider/model) is left
   * as-written because the pin constructions downstream already normalize it
   * through `toRoutePin`.
   */
  private normalizedPool(): readonly AgentOptionsLike[] {
    return this.config.crossFamily.pool.map((entry) => {
      const effort = entry.reasoningEffort
      if (effort === undefined) return entry
      const trimmed = effort.trim()
      if (trimmed.length === 0) {
        const { reasoningEffort: _blank, ...rest } = entry
        return rest
      }
      return trimmed === effort ? entry : { ...entry, reasoningEffort: trimmed }
    })
  }

  /**
   * F20 (PR #2 Codex round 9): the pool entry a pinned route currently
   * matches, when the pool is an authority for the role at all. The
   * pool-equality reclassification is AUDITOR-only (F9), so a non-auditor
   * role never recovers an entry — its pin stands or falls on session-policy
   * membership alone. For an auditor the FIRST match in the pool's own order
   * (the walk's order) is returned WHOLE, with the dispatch object the reuse
   * path carries: the COMPLETE entry — provider, model, reasoningEffort,
   * maxTokens and every other call-config field — composed exactly as the
   * E11/F15 walk dispatches it (route identity normalized to the trimmed
   * pin), with one documented rider: the PIN's own reasoningEffort survives
   * only where the current entry names none (a pin settled by policy
   * selection can carry an effort a coincidentally route-equal pool entry
   * omits — dropping it would be the same silent-degradation class this
   * recovery exists to close). A pool edit that changed the entry's own
   * fields is followed, not averaged: the current entry wins. `undefined`
   * when no current entry matches — the edit that removed it took the grant
   * with it, and the pin must stand on session-policy membership alone or
   * re-select; there is no entry to recover and no silent degradation back
   * to a three-field reconstruction. F24 (PR #2 Codex round 12) audited this
   * composition for the raw-entry route-field leak fixed in the pool walk:
   * this path needed NO change — provider/model are overridden from the
   * trimmed `toRoutePin` route (and the effort from the F21-normalized pool),
   * so the reuse dispatch can never carry untrimmed route fields.
   */
  private auditorPoolMatchFor(role: Role, pin: RoutingPin): {
    readonly entry: AgentOptionsLike
    readonly route: RoutePin
    readonly dispatch: AgentOptionsLike & { readonly provider: string; readonly model: string }
  } | undefined {
    if (!AUDITOR_ROLE_SET.includes(role)) return undefined
    const entry = this.normalizedPool().find(candidate => {
      const route = toRoutePin(candidate)
      return route !== undefined && sameRoute(route, pin)
    })
    const route = entry === undefined ? undefined : toRoutePin(entry)
    if (entry === undefined || route === undefined) return undefined
    return {
      entry,
      route,
      dispatch: {
        ...entry,
        provider: route.provider,
        model: route.model,
        ...(entry.reasoningEffort === undefined && pin.reasoningEffort !== undefined
          ? { reasoningEffort: pin.reasoningEffort }
          : {}),
      },
    }
  }

  /**
   * Whether the executor pin is still authorized, for the reuse path: a
   * plugin-config pin re-runs the one grant rule, and a session-policy pin
   * must still be a member of the (write-once, but re-read) policy set. A pin
   * that fails either check re-selects — recorded as a repin, not a crash.
   *
   * F1 (PR #2 Codex review): a NON-pool pin whose policy is `absent` or
   * `unreachable` is refused too. Before, that case fell through to
   * `undefined` (authorized) and the auto reuse branch dispatched the pin
   * labeled `session-policy` although current authorization could not be
   * established — the pin's authority evaporated with the policy read. The
   * refusal names the policy state and lets the existing re-selection
   * machinery apply unchanged (absent/unreachable ⇒ the selector terminates
   * to inheritance, the pin is cleared, `repinFrom` records the dead pin). A
   * POOL pin is untouched: a plugin-config grant already escalates under an
   * absent policy per the plan's one rule, so it is reused on the grant, not
   * silently inherited.
   *
   * F9 (PR #2 Codex round 4): the pool-grant reclassification is AUDITOR-only.
   * `crossFamily.pool` is defined as candidate AUDITOR routes — a
   * plugin-config grant for a reviewer the executor should not share a family
   * with — never an EXECUTOR authorization. The check below used to be
   * role-agnostic, so an executor pin that happened to equal a pool entry was
   * treated as pool-authorized and kept dispatching explicitly after the
   * session policy went absent/unreachable (the P3-3 provenance blur with a
   * concrete failure path). For a non-auditor role the pool branch does not
   * fire at all: the pin stands or falls on its own authority — session-policy
   * membership when the policy is present, the F1 conservative refusal
   * otherwise. Auditor pool semantics are unchanged.
   */
  private pinStillAuthorized(role: Role, pin: RoutePin, policy: SessionPolicyState): string | undefined {
    // F9: pool equality reclassifies a pin as a plugin-config grant for
    // AUDITORS only — for every other role the pool is not an authority and
    // the pin must survive on session-policy membership alone. F20: the SAME
    // match rule `auditorPoolMatchFor` applies on the reuse dispatch — one
    // rule, two consumers, so the authority check and the entry recovery can
    // never disagree about which entry (if any) authorizes the pin.
    const poolHit = this.auditorPoolMatchFor(role, pin) !== undefined
    if (poolHit) {
      const verdict = resolvePluginGrant({ provider: pin.provider, model: pin.model, source: 'legacy-pool' }, policy)
      return verdict.kind === 'conflict' ? verdict.reason : undefined
    }
    if (policy.kind !== 'present') {
      return `pinned route ${pin.provider}/${pin.model} cannot re-establish its session-policy authorization — the session policy is ${policy.kind}; refusing the pin conservatively`
    }
    const member = policy.routes.some(route => {
      const candidate = toRoutePin(route)
      return candidate !== undefined && sameRoute(candidate, pin)
    })
    if (!member) return `pinned route ${pin.provider}/${pin.model} is no longer in the session model-selection policy set`
    return undefined
  }

  /**
   * F2 (PR #2 Codex review): the routing section as of THIS decision. With a
   * volatile routing source wired, every call re-resolves the CURRENT values
   * — a config patch lands without a remount, and the next dispatch must
   * follow it, exactly like the legacy surfaces follow theirs. A patch that
   * made the section INVALID must not crash mid-commit: throwing during a
   * commit is worse than refusing the route with an honest record (the
   * commit's persisted state must survive the owner's broken patch), so the
   * read degrades to {@link REFUSED_ROUTING} and the refusal reason rides the
   * decision's `why` — dispatch roles inherit the deployment default, the
   * planner install is refused with a recorded degradation. Mount-time
   * validation is unchanged: an invalid INITIAL config still fails the mount
   * fast, exactly as before.
   */
  private routingConfig(): { readonly routing: ResolvedRouting; readonly refused?: string } {
    if (this.routingSource === undefined) return { routing: this.config.routing }
    try {
      return { routing: this.routingSource() }
    } catch (error: unknown) {
      return {
        routing: REFUSED_ROUTING,
        refused: `the live routing section no longer resolves (${errorMessage(error)})`,
      }
    }
  }

  private async resolveRoleRoute(root: AgentRef, role: Role, prior: Snapshot): Promise<RoleRouteResolution> {
    // F2: one live read per decision — the section as of THIS dispatch. An
    // invalid live section refuses the route outright: the dispatch inherits
    // the deployment default with the refusal recorded, rather than
    // dispatching on config the code cannot validate (and rather than
    // throwing inside the commit that carries the dispatch). The pinless
    // record also clears any existing role pin — a pin whose config context
    // can no longer be validated is not kept alive silently.
    const live = this.routingConfig()
    if (live.refused !== undefined) {
      return {
        kind: 'dispatch',
        agentOptions: undefined,
        routing: {
          role,
          why: [`routing: ${live.refused} — refusing to route this dispatch; inheriting the deployment default until the config is valid again`],
        },
      }
    }
    const routing = live.routing
    const roleRouting = routing.roles[role]
    const policy = this.readPolicy(root)
    const catalog = this.routingPorts.catalog

    if (role === 'planner') {
      // The planner IS the root agent (plan "Roles and routing"); it is routed
      // by installModelSelection in M6, never dispatched. Reaching this path
      // with 'planner' is a wiring fact to record, not a dispatch to reroute.
      return {
        kind: 'dispatch',
        agentOptions: undefined,
        routing: {
          role,
          why: ['planner routing is installed on the root agent (M6), not dispatched — this dispatch path never reroutes it'],
        },
      }
    }

    // Absent catalog port: the routing core cannot select or preflight. Per the
    // packet this resolves to 0.2.0/inherit behavior — an auto role inherits
    // (recording `unreachable-inherit` exactly when the POLICY read is what is
    // missing), and a locked role still gets its grant check (pure) plus its
    // 0.2.0 dispatch, with the skipped preflight named rather than claimed.
    let core: RoleRouteResolution
    if (catalog === undefined) {
      if (roleRouting.mode === 'locked') {
        const grant = resolvePluginGrant(
          { provider: roleRouting.provider, model: roleRouting.model, source: this.lockGrantSource(role, roleRouting) },
          policy,
        )
        if (grant.kind === 'conflict') return { kind: 'escalate', reason: grant.reason }
        const note = this.legacyLockNote(role, roleRouting)
        core = {
          kind: 'dispatch',
          agentOptions: this.lockedAgentOptions(role, roleRouting),
          routing: {
            role,
            pin: this.lockPin(roleRouting),
            why: [
              ...grant.why,
              ...(note === undefined ? [] : [note]),
              'catalog: no catalog port wired — provider liveness not checked and dispatch preflight not run (0.2.0 dispatch parity)',
            ],
            authorizationSource: 'plugin-config',
          },
        }
      } else if (roleRouting.mode === 'inherit') {
        core = {
          kind: 'dispatch',
          agentOptions: undefined,
          routing: {
            role,
            why: ['role routing mode is inherit — GAH does not reroute this role; the deployment default applies'],
          },
        }
      } else {
        core = {
          kind: 'dispatch',
          agentOptions: undefined,
          routing: {
            role,
            why: [
              'routing: no catalog port wired — the routing core cannot select from live facts; inheriting the deployment default (0.2.0 dispatch parity)',
            ],
            ...(policy.kind === 'unreachable' ? { authorizationSource: 'unreachable-inherit' as const } : {}),
          },
        }
      }
    } else if (roleRouting.mode === 'auto') {
      // Auto roles with a live pin reuse it (stability over reselection). A pin
      // whose provider left the catalog, whose preflight now rejects, or whose
      // authority no longer covers it re-selects with `repinFrom` recorded.
      const pin = prior.routingPins?.[role]
      if (pin !== undefined) {
        const pinRoute: RoutePin = { provider: pin.provider, model: pin.model }
        // F20 (PR #2 Codex round 9): recover the pool entry BEFORE the checks,
        // because when a pool grant is what authorizes this pin (the auditor
        // pool-equality branch `pinStillAuthorized` re-runs below) the COMPLETE
        // entry is what the dispatch carries — so the preflight leg and the
        // reuse dispatch below are both built from this one recovered object:
        // preflight exactly what you dispatch (the F15 discipline). The first
        // dispatch of a pool-picked route carries the entry whole (`agentOptions:
        // entry` in the pool walk — maxTokens and every call-config field), but
        // this reuse path used to rebuild agentOptions from the pin's three
        // fields alone, silently dropping the entry's tuning after the first
        // dispatch. An entry whose extra fields fail preflight kills the pin
        // (dead below ⇒ re-selection with `repinFrom`), never a silent fall
        // back to the bare reconstruction; an entry that no longer matches
        // leaves the pin standing (or falling) on session-policy membership
        // alone, exactly as before.
        const poolMatch = this.auditorPoolMatchFor(role, pin)
        const snapshot = await catalog.snapshot()
        let dead: string | undefined
        // F14 (PR #2 Codex round 6): an `unavailable` snapshot (a catalog read
        // failure — infrastructure) is NOT evidence the pinned provider is
        // gone; `providerIsLive` honestly answers false on it (nothing is
        // provably live), so the old check killed a HEALTHY pin on one hiccup
        // and re-selected over it. Liveness is asserted only on a SUCCESSFUL
        // read; otherwise preflight decides (it talks to `resolveCallConfig`
        // directly, independent of the failed listing) and the outage is
        // recorded on the reuse below.
        if (snapshot.catalogStatus === 'live' && !providerIsLive(snapshot, pin.provider)) {
          dead = `pinned provider "${pin.provider}" is no longer live in the catalog (llm/adapters-updated refreshed it)`
        } else {
          try {
            // F20: the preflight carries EXACTLY what the dispatch will — the
            // complete recovered pool entry when a pool grant authorizes the
            // pin (maxTokens and every call-config field ride, route identity
            // normalized to the trimmed pin the liveness leg checked), the
            // pin's own three fields otherwise.
            await catalog.preflight(poolMatch?.dispatch ?? {
              provider: pin.provider,
              model: pin.model,
              ...(pin.reasoningEffort === undefined ? {} : { reasoningEffort: pin.reasoningEffort }),
            })
          } catch (error) {
            dead = `pinned route ${pin.provider}/${pin.model} failed dispatch preflight${poolMatch === undefined ? '' : ' on the complete pool entry that authorizes it'} (${errorMessage(error)})`
          }
        }
        if (dead === undefined) {
          dead = this.pinStillAuthorized(role, pinRoute, policy)
        }
        if (dead === undefined) {
          // F9 (PR #2 Codex round 4): the reuse label's pool inference is
          // auditor-only, mirroring pinStillAuthorized. Persist/recover
          // honesty, DECIDED and documented here: the fold-validated
          // `RoutingPin` shape deliberately carries NO `authorizationSource`
          // (it is a route, not a grant — the source lives on the DECISION
          // that wrote the pin, a domain-owned shape outside this fix), so a
          // recorded source is not recoverable at this call site; and reading
          // one back from the last dispatch's RouteRecord could resurrect a
          // STALE authority (e.g. a pre-F9 pool relabel) that contradicts the
          // check that just re-authorized the pin. The label therefore states
          // the authority THIS reuse actually stood on in pinStillAuthorized:
          // a plugin-config pool grant for an auditor (route-equality — kept
          // as-is per the finding), session-policy membership for everything
          // else — which is what a non-auditor pin must now pass to be here at
          // all. If the pin shape ever persists a source, prefer it over this
          // inference whenever the two disagree.
          //
          // F20 (PR #2 Codex round 9): that same inference now decides WHAT is
          // dispatched, not just how it is labeled. A pool grant authorizes
          // the COMPLETE entry, so the pool-authorized reuse dispatches the
          // recovered entry whole (`poolMatch.dispatch` — maxTokens and every
          // call-config field, the pin's own effort riding only where the
          // entry names none), and the preflight above proved exactly those
          // fields. The recorded pin carries the effort actually dispatched —
          // the entry's when it names one, the pin's own otherwise. A pin
          // with NO matching entry never takes this branch: it kept (or lost)
          // its authority on session-policy membership alone and keeps the
          // existing provider/model/effort reconstruction below unchanged.
          // F14: the reuse record states liveness only when the read could
          // assert it; an unavailable catalog is named as the outage it is —
          // never dressed up as "provider live" (nothing was proven) and
          // never as "provider gone" (nothing failed but the read).
          const livenessNote = snapshot.catalogStatus === 'live'
            ? 'provider live'
            : `provider liveness NOT assertable — catalog unavailable (${snapshot.diagnostic ?? 'no diagnostic recorded'}): a catalog read failure (infrastructure), not evidence the provider is gone`
          if (poolMatch !== undefined) {
            const pinEffortRides = poolMatch.entry.reasoningEffort === undefined && pin.reasoningEffort !== undefined
            return {
              kind: 'dispatch',
              agentOptions: poolMatch.dispatch,
              routing: {
                role,
                pin: {
                  provider: poolMatch.route.provider,
                  model: poolMatch.route.model,
                  ...(poolMatch.dispatch.reasoningEffort === undefined ? {} : { reasoningEffort: poolMatch.dispatch.reasoningEffort }),
                },
                why: [
                  `pin: reusing the role pin — ${livenessNote}, preflight accepted on the COMPLETE pool entry, authority intact (a plugin-config pool grant — the matching pool entry recovered at reuse: maxTokens ${poolMatch.entry.maxTokens === undefined ? 'unset' : String(poolMatch.entry.maxTokens)}${pinEffortRides ? ', the pin\'s own reasoningEffort riding where the entry names none' : ''}; never a provider/model/effort reconstruction)`,
                ],
                authorizationSource: 'plugin-config',
              },
            }
          }
          return {
            kind: 'dispatch',
            agentOptions: {
              provider: pin.provider,
              model: pin.model,
              ...(pin.reasoningEffort === undefined ? {} : { reasoningEffort: pin.reasoningEffort }),
            },
            routing: {
              role,
              pin,
              why: [
                `pin: reusing the role pin — ${livenessNote}, preflight accepted, authority intact (authorized by the session policy when selected)`,
              ],
              authorizationSource: 'session-policy',
            },
          }
        }
        const reselected = await this.selectForRole(role, routing.preference, roleRouting, prior, policy, catalog)
        core = this.decorateRepinned(
          this.resolutionOfDecision(role, roleRouting, reselected, undefined),
          {
            provider: pin.provider,
            model: pin.model,
            ...(pin.reasoningEffort === undefined ? {} : { reasoningEffort: pin.reasoningEffort }),
          },
          dead,
        )
      } else {
        core = this.resolutionOfDecision(role, roleRouting, await this.selectForRole(role, routing.preference, roleRouting, prior, policy, catalog), undefined)
      }
    } else {
      core = this.resolutionOfDecision(role, roleRouting, await this.selectForRole(role, routing.preference, roleRouting, prior, policy, catalog), undefined)
      // F16 (PR #2 Codex round 7): a locked dispatch is COMPOSED here
      // (lock route + riding legacy tuning — `lockedAgentOptions`), and the
      // composed object — not just the bare lock the selector validated — is
      // what must pass preflight before the subagent start receives it. See
      // {@link preflightComposedLockedDispatch} for the seam decision.
      if (roleRouting.mode === 'locked' && core.kind === 'dispatch' && core.agentOptions !== undefined) {
        core = await this.preflightComposedLockedDispatch(role, roleRouting, core, catalog)
      }
    }

    if (core.kind === 'escalate') return core
    // A selected route is final: the pool never widens the auto set and never
    // overrides a role lock. An explicit `inherit` role mode is the owner's
    // opt-OUT of routing for this role — the pool fallback must not fire either.
    if (core.agentOptions !== undefined || roleRouting.mode === 'inherit') return core
    // The core terminated to inheritance. The 0.2.0 pool fallback stays
    // CONSULTABLE here as plugin-config grants under the one rule ([R2-P1-1]):
    // on a no-policy deployment this is exactly 0.2.0 dispatch behavior; on a
    // policy-bearing one a pool entry outside the policy escalates instead of
    // silently bypassing the native allowlist. F10: for AUDITORS only — a
    // non-auditor role keeps the inheritance result and never dispatches from
    // the auditor candidate pool.
    return this.carryRoutelessLegacy(role, roleRouting, await this.poolFallback(role, prior, policy, core))
  }

  /**
   * The 0.2.0 pool fallback over an inherit resolution, grant-checked.
   *
   * F7 (PR #2 Codex round 3): a pool pick now runs the SAME dispatch checks as
   * every other explicit selection BEFORE it can be handed a dispatch —
   * provider liveness against the catalog snapshot and
   * `preflight`/`resolveCallConfig`. Before this, the fallback checked only
   * the grant rule, so a pool entry that was policy-authorized but DEAD (a
   * provider absent from the live catalog, or a route resolveCallConfig
   * rejects) was dispatched anyway: auto mode could hand a dispatch to a
   * route no live adapter can serve. A pool route failing these checks is
   * skipped HONESTLY — the `why` names the failure, the walk falls to the
   * NEXT pool entry outside the builder family, and the inheritance result
   * is retained when none qualifies. The grant rule stays FIRST (policy
   * membership / conflict escalation per the plan's one rule), and the
   * 0.2.0-verbatim `off`-mode path is untouched: off mode dispatches legacy
   * verbatim by design, so these checks apply to the auto-mode pool fallback
   * only. With no catalog port wired the checks cannot run; the pick
   * dispatches with the skips NAMED, exactly as a locked route does in the
   * same state (0.2.0 dispatch parity) — never a silent claim.
   *
   * F10 (PR #2 Codex round 4): the fallback is AUDITOR-only. The pool is a
   * set of candidate AUDITOR routes, and this fallback used to be reachable
   * for every role: a legacy provider-only executor config
   * (`{ provider: 'alpha' }` — no model, so no lock, so auto mode) plus an
   * absent policy made the core inherit, then the fallback read the
   * executor's own family and dispatched the EXECUTOR on the first
   * out-of-family pool entry — silently replacing the requested executor
   * provider with an auditor model (the E8-disclosed residual, now a review
   * finding). For every non-auditor role the fallback does not fire: the walk
   * never runs and the inheritance result stands, with the withheld pick
   * named honestly in `why`. The E11 checked walk (grant → liveness →
   * preflight) is unchanged for auditors.
   *
   * F12 (PR #2 Codex round 5): the builder family is sourced through
   * `executorFamilySourceOf(prior)` — dispatch pin, then the live routing
   * lock, then the legacy `executor.agentOptions` surface (the F5 order,
   * with the legacy tail kept at 0.2.0 family granularity: a provider-only
   * legacy executor still names its family) — not the legacy surface alone.
   * Before, a lock-only or pin-only executor route made
   * `familyOf(legacy-absent)` read `undefined`, so `selectCrossFamily` saw
   * `unknown-family` and a valid out-of-family pool entry was never consulted;
   * the executor's DECLARED family now reaches the choice and the walk. The
   * genuinely unrouted executor (no pin, no lock, no legacy provider) keeps
   * the honest `unknown-family` inheritance path, and the checked walk itself
   * is unchanged.
   */
  /**
   * The executor's CURRENT family source for the pool fallback (F12): the F5
   * order — dispatch pin, live routing lock, legacy surface — read at FAMILY
   * granularity. `executorPinOf` walks pin → lock → a FULL legacy route; the
   * legacy tail here keeps the 0.2.0 granularity `familyOf` always had: a
   * provider-only legacy executor (`{ provider: 'alpha' }`, no model ⇒ no pin
   * leg) still names its family (the F10(b)/(c) fixtures). Only an executor
   * with no pin, no lock, and no legacy provider yields `undefined` — the
   * honest `unknown-family` case.
   *
   * The PIN leg is skipped when THIS decision just refused the executor's own
   * pin (`repinFrom` on the inherit resolution the fallback decorates — the
   * executor role reaching here always arrives via that refusal): a refused
   * pin names no family the fallback can consult, and letting the dead pin
   * shadow the legacy surface would silently change which pool entries count
   * as out-of-family exactly when the executor's route is least settled.
   */
  private executorFamilySourceOf(
    prior: Snapshot,
    refusedExecutorPin: RoutingPin | undefined,
  ): AgentOptionsLike | undefined {
    const pinned = refusedExecutorPin === undefined ? this.executorPinOf(prior) : undefined
    if (pinned !== undefined) return pinned
    const executorRouting = this.routingConfig().routing.roles.executor
    if (executorRouting.mode === 'locked') {
      return { provider: executorRouting.provider, model: executorRouting.model }
    }
    return this.config.executor.agentOptions
  }

  private async poolFallback(
    role: Role,
    prior: Snapshot,
    policy: SessionPolicyState,
    inherit: Extract<RoleRouteResolution, { readonly kind: 'dispatch' }>,
  ): Promise<RoleRouteResolution> {
    // The consultability gate is unchanged and pure: `selectCrossFamily`
    // decides whether the pool is in play at all (enabled, the risk floor,
    // an observable builder family) and supplies the outcome word the
    // record cites. Its pick — the FIRST pool entry outside the builder
    // family — is where the checked walk below STARTS; the walk may continue
    // past it when the dispatch checks reject it. F12: the builder family is
    // the executor's CURRENT route (pin → live lock → legacy surface), so a
    // lock-only or pin-only executor route is a real family input here — with
    // the executor's own just-refused pin (repinFrom) never counting as one.
    const familySource = this.executorFamilySourceOf(
      prior,
      role === 'executor' ? inherit.routing?.repinFrom : undefined,
    )
    const choice = selectCrossFamily({
      risk: prior.triage.risk,
      configured: undefined,
      executor: familySource,
      // F21: the pool the choice consults is the same normalized pool the
      // walk below iterates — one seam, so the pick the choice names and the
      // entry the walk dispatches cannot disagree about effort.
      policy: { ...this.config.crossFamily, pool: this.normalizedPool() },
    })
    if (toRoutePin(choice.agentOptions) === undefined) return inherit
    // F10: auditor-only. A non-auditor role (the executor) never dispatches
    // from the auditor candidate pool — no grant walk, no liveness or
    // preflight, no pick. The note fires exactly when a pick existed and was
    // withheld, so the record explains the divergence from 0.2.0 dispatch
    // parity instead of silently dropping it; with no pick in play the plain
    // inheritance result is already the honest record.
    if (!AUDITOR_ROLE_SET.includes(role)) {
      const withheld = toRoutePin(choice.agentOptions)
      if (withheld === undefined || inherit.routing === undefined) return inherit
      return {
        ...inherit,
        routing: {
          ...inherit.routing,
          why: [
            ...inherit.routing.why,
            `cross-family: the 0.2.0 pool fallback is auditor-only — the pool is a candidate AUDITOR route set, never an authorization for "${role}"; the ${withheld.provider}/${withheld.model} pick was not dispatched and the inheritance result stands`,
          ],
        },
      }
    }
    const catalog = this.routingPorts.catalog
    const builder = familyOf(familySource)
    // F7: walk the pool in order over the entries the 0.2.0 rule considers —
    // a well-formed route whose family differs from the builder's — so the
    // first entry `selectCrossFamily` names is checked first and a dead one
    // is stepped past, not dispatched.
    const skipped: string[] = []
    // F17: the outage note for the CURRENT walk, set by the iteration that
    // read an `unavailable` snapshot (the catalog is cached per commit, so
    // every iteration shares one read) and recorded on whichever resolution
    // the walk returns — never a silent skip of the liveness leg.
    let outage: string | undefined
    for (const entry of this.normalizedPool()) {
      const candidate = toRoutePin(entry)
      if (candidate === undefined) continue
      const family = familyOf(entry)
      if (family === undefined || family === builder) continue
      // The grant rule FIRST, per the plan's one rule ([R2-P1-1]): a pool
      // entry a present policy excludes is an owner-vs-owner conflict that
      // ESCALATES — never skipped past, never silently bypassed.
      const verdict = resolvePluginGrant({ provider: candidate.provider, model: candidate.model, source: 'legacy-pool' }, policy)
      if (verdict.kind === 'conflict') return { kind: 'escalate', reason: verdict.reason }
      const effort = entry.reasoningEffort
      const pin = { provider: candidate.provider, model: candidate.model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
      // F24 (PR #2 Codex round 12): ONE normalized dispatch object per pool
      // candidate — route identity (provider/model) from the trimmed pin the
      // grant and liveness legs checked, every non-route call-config field
      // from the entry itself (F15's full-field discipline; the effort is
      // already the normalized value — F21's `normalizedPool` seam supplies
      // these entries). Grant, liveness, and preflight all validate the
      // NORMALIZED route, but the dispatch below used to hand the subagent
      // start the RAW entry: a pool entry `{ provider: ' alpha ', model:
      // ' model ' }` passed every check as `alpha/model` while the child start
      // received the untrimmed strings — dispatch failure or route-evidence
      // mismatch. The SAME object is now both preflighted and dispatched
      // (preflight exactly what you dispatch, now including normalization),
      // and it rides the no-catalog-port path too — there is no preflight leg
      // there to disagree, but the dispatched route still must be the one the
      // grant check authorized. For a clean entry the composition is
      // field-identical to the entry (0.2.0 behavior unchanged). Site audit
      // for the same leak: the F20 reuse recovery (`auditorPoolMatchFor`'s
      // pre-composed dispatch) already builds its object with
      // `provider`/`model` overridden from the trimmed `toRoutePin` route, so
      // it needed NO change — this walk's two `agentOptions: entry` sites were
      // the only raw-entry dispatch paths. Blank-after-trim route fields never
      // reach here: `toRoutePin` returns `undefined` and the walk's
      // well-formedness gate skips the entry, unchanged.
      const dispatch: AgentOptionsLike & { readonly provider: string; readonly model: string } = {
        ...entry,
        provider: candidate.provider,
        model: candidate.model,
      }
      const grantNote = `cross-family: the routing core terminated to inheritance; the 0.2.0 pool fallback supplied ${candidate.provider}/${candidate.model} as a plugin-config grant (${choice.outcome})`
      if (catalog === undefined) {
        return {
          kind: 'dispatch',
          agentOptions: dispatch,
          routing: {
            role,
            pin,
            why: [
              ...(inherit.routing?.why ?? []),
              ...verdict.why,
              'catalog: no catalog port wired — provider liveness not checked and dispatch preflight not run (0.2.0 dispatch parity)',
              grantNote,
            ],
            authorizationSource: 'plugin-config',
          },
        }
      }
      const snapshot = await catalog.snapshot()
      // F17 (PR #2 Codex round 7): the liveness skip is asserted only on a
      // SUCCESSFUL read — the same outage-vs-disappearance split F14 made for
      // locks and pins. An `unavailable` snapshot (a `listProviders` throw)
      // carries an EMPTY provider list, so the old unconditional
      // `providerIsLive` skip read "the catalog could not be read" as "every
      // pool provider is gone" and one hiccup ended the walk with plain
      // inheritance, never attempting the preflight that was still available
      // (`resolveCallConfig` runs independently of the failed listing). Under
      // an outage the liveness leg is SKIPPED, preflight decides, and the
      // outage is recorded below in the wording F14 established: a catalog
      // read failure (infrastructure), not evidence the provider is gone.
      // A live read that lacks the provider keeps the unchanged skip.
      if (snapshot.catalogStatus === 'unavailable') {
        outage =
          `cross-family: provider liveness NOT assertable for the pool walk — catalog unavailable ` +
          `(${snapshot.diagnostic ?? 'no diagnostic recorded'}): a catalog read failure (infrastructure), ` +
          'not evidence the provider is gone; the liveness leg is skipped and preflight decides'
      }
      if (snapshot.catalogStatus === 'live' && !providerIsLive(snapshot, candidate.provider)) {
        skipped.push(`cross-family: pool route ${candidate.provider}/${candidate.model} skipped — its provider is not live in the catalog snapshot`)
        continue
      }
      // F15 (PR #2 Codex round 6): preflight EVERY call-config field the
      // dispatch carries. The dispatch hands the COMPLETE pool entry to the
      // subagent start as agentOptions, but this walk used to forward only
      // provider/model/reasoningEffort — a pool entry with an invalid
      // `maxTokens` (or any other call-config field) passed the walk and
      // failed at subagent start. The port's `preflight` signature already
      // accepts the full `LlmCallConfig` (maxTokens included), so the entry is
      // routed through `resolveCallConfig` WHOLE (route identity normalized
      // to the trimmed pin the grant/liveness legs checked): walk acceptance
      // now implies dispatch validity. Grant-first ordering and the honest
      // skip records are unchanged. F24: the object preflighted here is the
      // SAME `dispatch` object the resolution below carries — never a
      // parallel reconstruction that could drift (in fields or in
      // normalization) from what the subagent start receives.
      try {
        await catalog.preflight(dispatch)
      } catch (error) {
        skipped.push(`cross-family: pool route ${candidate.provider}/${candidate.model} skipped — dispatch preflight rejected it (${errorMessage(error)})`)
        continue
      }
      return {
        kind: 'dispatch',
        agentOptions: dispatch,
        routing: {
          role,
          pin,
          why: [
            ...(inherit.routing?.why ?? []),
            ...verdict.why,
            ...(outage !== undefined ? [outage] : []),
            ...(skipped.length > 0 ? [skipped.join('; ')] : []),
            grantNote,
          ],
          authorizationSource: 'plugin-config',
        },
      }
    }
    // No pool entry survived the dispatch checks: the inheritance result is
    // retained, with every skip named — never a silent reversion to it.
    if (inherit.routing === undefined) return inherit
    return {
      ...inherit,
      routing: {
        ...inherit.routing,
        why: [
          ...inherit.routing.why,
          ...skipped,
          // F17: when the walk ran under an outage, the retained-inheritance
          // record names it too — the skips above are preflight verdicts, and
          // no liveness leg was (or could be) run.
          ...(outage !== undefined ? [outage] : []),
          'cross-family: every pool entry outside the builder family failed the dispatch checks (provider liveness, preflight) — the inheritance result stands',
        ],
      },
    }
  }

  /**
   * P2-1 (execution-audit r1): carry ROUTELESS legacy agentOptions onto an
   * INHERIT dispatch of the auto arm.
   *
   * A legal 0.2.0 config like `executor.agentOptions: {maxTokens: 8192}` (any
   * legacy object naming no provider+model pair) maps to no lock — correctly —
   * but when the auto arm then terminates to inheritance, mode `off` dispatches
   * the object verbatim while auto dropped it entirely: the owner's tuning
   * silently vanished exactly where the owner most likely still runs it. The
   * remedy is the auditor's: the object is TUNING, not a route claim, so it
   * rides the inherit dispatch VERBATIM and the decision's `why` says so. The
   * route legs stay absent — no pin, no `selected`, the RouteRecord keeps
   * saying inheritance — because GAH still selected nothing.
   *
   * THE DECIDED BOUNDARY (packet E8 decide point), documented and tested:
   * routeless legacy is NOT carried onto explicitly SELECTED routes (an auto
   * policy selection, a pin reuse, or a pool pick). Rationale: (1) the
   * repo's own E2 resolve contract (`lockedAgentOptions`) rides legacy tuning
   * exactly when the dispatch follows a legacy-named route, and a selection is
   * by construction not one; (2) merging unvalidated legacy fields (effort,
   * maxTokens) onto a preflight-validated selection would dispatch values the
   * preflight never saw, weakening the "efforts validated at dispatch"
   * invariant; (3) a selection cites the session policy as its authority, and
   * the legacy config object is not a party to that grant. The asymmetry with
   * mode `off` is visible, not hidden: no-policy deployments cannot select
   * (inheritOnly), so the carry fires exactly there, and every selected
   * dispatch names its own authority instead.
   *
   * Equally deliberate: an explicit `mode: 'inherit'` role does NOT carry —
   * that is a v3-surface opt-out ("the deployment default applies"), a shape
   * no 0.2.0 config can produce, and honoring it literally is the honest read.
   */
  private carryRoutelessLegacy(
    role: Role,
    roleRouting: RoleRouting,
    resolution: RoleRouteResolution,
  ): RoleRouteResolution {
    if (resolution.kind !== 'dispatch') return resolution
    if (roleRouting.mode !== 'auto') return resolution
    if (resolution.agentOptions !== undefined) return resolution
    const legacy = this.legacyOptionsFor(role)
    if (legacy === undefined || toRoutePin(legacy) !== undefined) return resolution
    if (resolution.routing === undefined) return resolution
    const fields = Object.keys(legacy).join(', ')
    return {
      ...resolution,
      agentOptions: legacy,
      routing: {
        ...resolution.routing,
        why: [
          ...resolution.routing.why,
          `legacy ${this.legacySurfaceOf(role)}: routeless agentOptions ({${fields}}) carried onto the inherit dispatch — tuning only, not a route claim; the route legs stay absent and this record keeps saying inheritance`,
        ],
      },
    }
  }

  /** `selectRoute` with the engine's resolved inputs (risk, preference, live executor pin). */
  private async selectForRole(
    role: Role,
    preference: RoutePreference,
    roleRouting: RoleRouting,
    prior: Snapshot,
    policy: SessionPolicyState,
    catalog: RouteCatalog,
  ): Promise<SelectionDecision> {
    const executorPin = AUDITOR_ROLE_SET.includes(role) ? this.executorPinOf(prior) : undefined
    return await selectRoute({
      role,
      risk: prior.triage.risk,
      // F2: the preference as read at THIS decision's start, passed down so a
      // patch landing mid-decision cannot split one decision across two
      // configs (one live read per decision, not one per sub-step).
      preference,
      roleRouting,
      policy,
      catalog,
      // Axes are recomputed against the executor's CURRENT pin at every
      // dispatch ([R2-P2-2b] — pins stabilize routes, not judgments).
      ...(executorPin === undefined ? {} : { executorPin }),
      independenceFloor: this.config.crossFamily.minRisk,
    })
  }

  /** Which config surface named a locked route, for the grant's `source` field. */
  private lockGrantSource(role: Role, roleRouting: RoleRouting): GrantSource {
    if (roleRouting.mode !== 'locked') throw new Error('unreachable: lockGrantSource on a non-locked routing')
    const legacy = toRoutePin(this.legacyOptionsFor(role))
    if (
      legacy !== undefined
      && legacy.provider === roleRouting.provider
      && legacy.model === roleRouting.model
    ) return 'legacy-role'
    return 'routing-lock'
  }

  private lockPin(roleRouting: RoleRouting & { readonly mode: 'locked' }): RoutingPin {
    return {
      provider: roleRouting.provider,
      model: roleRouting.model,
      ...(roleRouting.reasoningEffort === undefined ? {} : { reasoningEffort: roleRouting.reasoningEffort }),
    }
  }

  /** Map a core selection decision onto the engine's dispatch/escalate resolution. */
  private resolutionOfDecision(
    role: Role,
    roleRouting: RoleRouting,
    decision: SelectionDecision,
    repinFrom: RoutingPin | undefined,
  ): RoleRouteResolution {
    if (decision.kind === 'escalate-owner') return { kind: 'escalate', reason: decision.reason }
    if (decision.kind === 'blocked') return { kind: 'escalate', reason: decision.reason }
    if (decision.kind === 'inherit') {
      return {
        kind: 'dispatch',
        agentOptions: undefined,
        routing: {
          role,
          why: [...decision.why],
          ...(decision.authorizationSource === undefined ? {} : { authorizationSource: decision.authorizationSource }),
          ...(repinFrom === undefined ? {} : { repinFrom }),
        },
      }
    }
    const why = [...decision.why]
    const note = this.legacyLockNote(role, roleRouting)
    if (note !== undefined) why.push(note)
    return {
      kind: 'dispatch',
      agentOptions:
        roleRouting.mode === 'locked'
          ? this.lockedAgentOptions(role, roleRouting)
          : {
              provider: decision.route.provider,
              model: decision.route.model,
              ...(decision.route.reasoningEffort === undefined ? {} : { reasoningEffort: decision.route.reasoningEffort }),
            },
      routing: {
        role,
        pin:
          roleRouting.mode === 'locked'
            ? this.lockPin(roleRouting)
            : {
                provider: decision.route.provider,
                model: decision.route.model,
                ...(decision.route.reasoningEffort === undefined ? {} : { reasoningEffort: decision.route.reasoningEffort }),
              },
        why,
        authorizationSource: decision.authorizationSource,
        ...(decision.fallbackFrom === undefined ? {} : { fallbackFrom: decision.fallbackFrom }),
        ...(decision.candidatesConsidered === undefined ? {} : { candidates: [...decision.candidatesConsidered] }),
        ...(repinFrom === undefined ? {} : { repinFrom }),
      },
    }
  }

  /** Attach the repin provenance to a re-selection the dead pin forced. */
  private decorateRepinned(decision: RoleRouteResolution, deadPin: RoutingPin, reason: string): RoleRouteResolution {
    if (decision.kind !== 'dispatch' || decision.routing === undefined) return decision
    return {
      ...decision,
      routing: {
        ...decision.routing,
        repinFrom: deadPin,
        why: [`pin: re-selecting — ${reason}`, ...decision.routing.why],
      },
    }
  }

  /**
   * The owner-escalation exit ([R2-P1-1] conflicts, dead locked routes, exhausted
   * candidates): commit the EXISTING `set-owner-decision` op with the
   * machine-readable `routing-escalation:` reason, then surface a typed error —
   * state is committed first and survives, exactly like the plan-gate refusal
   * and the revoked-executor path. No new op types, no new verdict words.
   */
  private async routingEscalation(root: AgentRef, prior: Snapshot, reason: string): Promise<never> {
    await this.commit(prior, 'set-owner-decision', {
      ...prior,
      revision: prior.revision + 1,
      phase: 'needs-owner-decision',
      diagnostic: `routing-escalation: ${reason}`,
    })
    throw new AutopilotError(
      `routing escalation: ${reason} — the run is needs-owner-decision; owner-resolve to arbitrate`,
      'AP_ROUTING_ESCALATION',
    )
  }

  // ── Planner model-selection install (M6; engine-local by plan "Roles and routing") ──

  /**
   * Resolve the PLANNER role's routing decision (M6). Same rule core and same
   * vocabulary as {@link resolveRoleRoute}, but the outcome is an INSTALL, not
   * a dispatch: `route` ⇒ install on the root agent's scoped ctx for the
   * planning phases; `inherit` ⇒ nothing at all (the shipped default); every
   * refusal (grant conflict, dead/blocked lock, exhausted auto candidates) is
   * a RECORDED DEGRADATION to inheritance — the planner opt-in is an
   * augmentation of the owner's own session, so unlike a dispatch role it
   * never escalates the run and never blocks run start (packet E6:
   * degradation is recorded, never silent, never fatal).
   */
  private async resolvePlannerRoute(
    root: AgentRef | undefined,
    next: Snapshot,
  ): Promise<PlannerRouteDecision> {
    // F2: the same per-decision live read as dispatch roles — a volatile
    // patch to the routing section reaches the planner decision without a
    // remount. An invalid live section refuses the install with a recorded
    // degradation (never fatal, per the planner opt-in contract): the run
    // plans on the deployment default until the config is valid again.
    const live = this.routingConfig()
    if (live.refused !== undefined) {
      return {
        kind: 'degraded',
        why: [`routing: ${live.refused} — the planner install is refused; the run plans on the deployment default until the config is valid again`],
      }
    }
    const routing = live.routing
    const roleRouting = routing.roles.planner
    // The shipped default: the planner inherits — GAH does not reroute the
    // user's session model. Nothing is recorded beyond the config itself.
    if (roleRouting.mode === 'inherit') return { kind: 'inherit' }
    // Mode `off` with a default-`auto` planner keeps 0.2.0 parity, exactly as
    // dispatch roles do (`routingActive`); a LOCKED planner is still a
    // plugin-config grant and still applies in every mode.
    if (!routingActive(routing, 'planner')) return { kind: 'inherit' }
    // No live root agent ⇒ the policy cannot be read for its session; the
    // unreachable state is the honest input, and the missing-ctx degradation
    // below records the rest.
    const policy: SessionPolicyState = root === undefined ? { kind: 'unreachable' } : this.readPolicy(root)
    const catalog = this.routingPorts.catalog
    const degrade = (reason: string, why: readonly string[], route?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }):
      { readonly kind: 'degraded'; readonly route?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }; readonly why: readonly string[] } => ({
      kind: 'degraded',
      ...(route === undefined ? {} : { route }),
      why: [...why, `planner: ${reason} — the planner decision degrades to inheritance; recorded, never fatal`],
    })

    if (roleRouting.mode === 'locked') {
      const lock = {
        provider: roleRouting.provider,
        model: roleRouting.model,
        ...(roleRouting.reasoningEffort === undefined ? {} : { reasoningEffort: roleRouting.reasoningEffort }),
      }
      // A lock is a plugin-config grant under the one rule ([R2-P1-1]). A
      // grant CONFLICT means the session policy forbids this route: for a
      // dispatch role that escalates the owner, but installing it here would
      // route the user's own session against the deployment's allowlist —
      // degrading to inheritance is the policy-RESPECTING outcome, recorded.
      const grant = resolvePluginGrant({ provider: lock.provider, model: lock.model, source: 'routing-lock' }, policy)
      if (grant.kind === 'conflict') return degrade('the locked planner route is a plugin-config grant outside the session model-selection policy — not installed', grant.why, lock)
      // No catalog port: the grant stands and the install proceeds without
      // liveness/preflight verification — the same 0.2.0 parity a locked
      // dispatch role gets, with the skipped checks NAMED, not claimed.
      if (catalog === undefined) {
        return {
          kind: 'route',
          route: lock,
          why: [
            ...grant.why,
            'catalog: no catalog port wired — provider liveness not checked and install preflight not run (0.2.0 parity)',
          ],
        }
      }
      // Full core resolution for the lock: liveness, exact facts, effort,
      // preflight — `selectRoute` re-runs the same grant check internally.
      const decision = await selectRoute({
        role: 'planner',
        risk: next.triage.risk,
        preference: routing.preference,
        roleRouting,
        policy,
        catalog,
      })
      if (decision.kind === 'route') return { kind: 'route', route: decision.route, why: decision.why }
      if (decision.kind === 'inherit') return { kind: 'inherit' }
      if (decision.kind === 'escalate-owner') return degrade(decision.reason, [decision.reason], lock)
      return degrade(decision.reason, decision.why, lock)
    }

    // Auto planner: selection authority is the session policy ONLY ("auto
    // with session policy"). Without a catalog port there are no live facts
    // to select from — inheritance, the same no-catalog parity as dispatch
    // roles (and an inherit decision records nothing).
    if (catalog === undefined) return { kind: 'inherit' }
    const decision = await selectRoute({
      role: 'planner',
      risk: next.triage.risk,
      preference: routing.preference,
      roleRouting,
      policy,
      catalog,
    })
    if (decision.kind === 'route') return { kind: 'route', route: decision.route, why: decision.why }
    if (decision.kind === 'inherit') return { kind: 'inherit' }
    if (decision.kind === 'escalate-owner') return degrade(decision.reason, [decision.reason])
    return degrade(decision.reason, decision.why)
  }

  /**
   * Arm one run's planner install (called at the commit that finds the run in
   * a planning phase with no live install state). Records — and returns, for
   * the event's detail — exactly what happened; `undefined` means an inherit
   * decision, which records NOTHING.
   */
  private async armPlannerSelection(runId: RunId, next: Snapshot): Promise<PlannerRoutingRecord | undefined> {
    const decision = await this.resolvePlannerRoute(this.agents.get(runId), next)
    return await this.armPlannerDecision(runId, decision)
  }

  /**
   * The arm itself, over an ALREADY-RESOLVED decision (F4: the refresh path
   * re-resolves first, then arms the decision it compared — one resolution
   * per arm, never two, so a volatile patch landing between comparison and
   * arm cannot split one refresh across two decisions). Every state write
   * carries the decision key the arm came from: that key is what the next
   * planning-phase commit's change detection compares against.
   */
  private async armPlannerDecision(runId: RunId, decision: PlannerRouteDecision): Promise<PlannerRoutingRecord | undefined> {
    const root = this.agents.get(runId)
    const decisionKey = plannerDecisionKeyOf(decision)
    // F25 (PR #2 Codex round 13): the arm may land here AFTER dispose()
    // swept — the caller awaited planner route resolution (catalog/policy
    // awaits that do not observe the abort), and the engine was torn down
    // under it. Past the abort, arming is REFUSED at every state write below:
    // no installer call, no map entry — a model selection installed now would
    // survive plugin unload/reload and outlive the engine that owns it. The
    // refusal is still RECORDED for installable decisions (the least-surprising
    // existing shape: `unsupported`, why naming the disposal) so the deciding
    // commit can stamp it durably; an inherit decision records nothing,
    // exactly as a live-arm inherit does. Each guarded stretch is synchronous,
    // so once past its guard no abort can interleave before the write.
    if (decision.kind === 'inherit') {
      if (this.lifecycle.signal.aborted) return undefined
      this.plannerInstalls.set(runId, { kind: 'inherit' })
      return undefined
    }
    const record = (status: 'routed' | 'unsupported', why: readonly string[]): PlannerRoutingRecord => ({
      status,
      ...(decision.kind === 'degraded' && decision.route === undefined ? {} : { route: decision.route }),
      why,
    })
    if (this.lifecycle.signal.aborted) {
      return record('unsupported', [
        ...decision.why,
        'planner: the engine was disposed while the route was resolving — arming refused so no model selection outlives the engine (degraded to inheritance)',
      ])
    }
    // A decision that already refused to name an installable route degrades
    // whatever the port situation — the refusal reasons are the record.
    if (decision.kind === 'degraded') {
      const degraded = record('unsupported', decision.why)
      this.plannerInstalls.set(runId, { kind: 'armed', record: degraded, decision: decisionKey })
      return degraded
    }
    const installer = this.routingPorts.modelSelectionInstaller
    const agentCtx = root?.ctx
    if (installer === undefined || agentCtx === undefined) {
      const missing = installer === undefined
        ? 'no modelSelectionInstaller port is wired (the host installModelSelection export was not reachable at mount)'
        : 'the root agent exposes no scoped ctx for the install'
      const unsupported = record('unsupported', [...decision.why, `planner: ${missing} — degraded to inheritance`])
      this.plannerInstalls.set(runId, { kind: 'armed', record: unsupported, decision: decisionKey })
      return unsupported
    }
    let dispose: (() => void) | undefined
    try {
      dispose = installer(agentCtx, decision.route)
    } catch (error: unknown) {
      const unsupported = record('unsupported', [...decision.why, `planner: the installer threw (${errorMessage(error)}) — degraded to inheritance`])
      this.plannerInstalls.set(runId, { kind: 'armed', record: unsupported, decision: decisionKey })
      return unsupported
    }
    if (dispose === undefined) {
      const unsupported = record('unsupported', [...decision.why, 'planner: the installer declined (returned no disposer) — degraded to inheritance'])
      this.plannerInstalls.set(runId, { kind: 'armed', record: unsupported, decision: decisionKey })
      return unsupported
    }
    const routed = record('routed', [
      ...decision.why,
      'planner: model selection installed on the root agent\u2019s scoped ctx for the planning phases — the durable switch notice is the host\u2019s own; GAH adds nothing to the session',
    ])
    this.plannerInstalls.set(runId, { kind: 'armed', record: routed, dispose, decision: decisionKey })
    return routed
  }

  /**
   * F4 (PR #2 Codex review, round 2): re-evaluate an EXISTING planner install
   * against CURRENT facts at every planning-phase commit. Since F2 made the
   * routing values live, a volatile patch to `routing.roles.planner` (or
   * `routing.mode`) mid-planning must reach the install within the planning
   * window, not at its end — so the decision is re-resolved here, and only a
   * CHANGED decision (different kind, or different full route identity)
   * churns the install: the old one is disposed and the new decision armed
   * atomically, with the refresh recorded (from→to) on the returning record.
   * An UNCHANGED decision is a strict no-op — no dispose, no install, no
   * record — so steady-state planning commits keep the arm-once economics the
   * chokepoint always had (installer call count stable).
   *
   * Refresh-to-inherit returns the durable `status: 'inherit'` transition
   * record instead of `undefined`: the disposal of a live install INSIDE the
   * planning window is exactly the event the absent-field convention cannot
   * express, and the packet requires it recorded.
   *
   * The reload stamp (P2-3) is deliberately PRESERVED across the internal
   * dispose: the run never left planning, so the one-shot reload record is
   * still owed — it rides whichever record this commit stamps (the refresh
   * record when a refresh happened, else the armed state's record).
   */
  private async refreshPlannerInstall(runId: RunId, next: Snapshot): Promise<PlannerRoutingRecord | undefined> {
    const state = this.plannerInstalls.get(runId)
    if (state === undefined) return undefined
    const previousDecision: PlannerDecisionKey = state.kind === 'inherit' ? { kind: 'inherit' } : state.decision
    const decision = await this.resolvePlannerRoute(this.agents.get(runId), next)
    if (samePlannerDecision(previousDecision, plannerDecisionKeyOf(decision))) return undefined
    // F25: the re-resolution awaited catalog/policy facts, and the engine may
    // have been disposed under it — the old install was already taken by
    // dispose()'s sweep (disposePlanner is idempotent, so the one below is a
    // no-op then). On a disposed engine there is nothing left to churn: no
    // dispose/re-arm dance, no state entry, no record — the arm guard in
    // {@link armPlannerDecision} refuses whatever a later path would try.
    if (this.lifecycle.signal.aborted) return undefined
    const from = state.kind === 'inherit'
      ? 'inherit'
      : `${state.record.status} ${plannerRouteLabel(state.record.route)}`
    const owedReload = this.plannerReloadStamps.has(runId)
    this.disposePlanner(runId)
    if (owedReload) this.plannerReloadStamps.add(runId)
    const note = (to: string): string =>
      `planner: install refreshed mid-planning (${from} → ${to}) — the live routing decision changed, so the previous install was disposed and this one armed from CURRENT policy/catalog/routing facts at this commit; planning turns between the config change and this commit ran on the previous install`
    if (decision.kind === 'inherit') {
      this.plannerInstalls.set(runId, { kind: 'inherit' })
      return { status: 'inherit', why: [note('inherit')] }
    }
    const armed = await this.armPlannerDecision(runId, decision)
    // A non-inherit decision always arms to a record (routed or unsupported);
    // the transition note is appended so from→to rides the durable commit,
    // AND the armed state keeps the noted record — the live status surface and
    // the durable detail name the same event, exactly as the arm path does.
    const to = armed === undefined ? 'inherit' : `${armed.status} ${plannerRouteLabel(armed.route)}`
    const noted = armed === undefined
      ? { status: 'inherit' as const, why: [note(to)] }
      : { ...armed, why: [...armed.why, note(to)] }
    const armedState = this.plannerInstalls.get(runId)
    if (armed !== undefined && armedState?.kind === 'armed' && armedState.record === armed) {
      this.plannerInstalls.set(runId, { ...armedState, record: noted })
    }
    return noted
  }

  /**
   * Dispose one run's planner install — exactly once, idempotently: the state
   * entry is deleted FIRST, so a re-entrant or repeated call is a no-op, and a
   * throwing disposer is swallowed (a teardown failure must never surface as
   * a run error).
   */
  private disposePlanner(runId: RunId): void {
    const state = this.plannerInstalls.get(runId)
    this.plannerInstalls.delete(runId)
    // The planning window closed: no later commit owes a reload re-arm record
    // for it (P2-3) — dropping the pending stamp here keeps the one-shot honest.
    this.plannerReloadStamps.delete(runId)
    if (state === undefined || state.kind !== 'armed' || state.dispose === undefined) return
    try {
      state.dispose()
    } catch {
      // Never fatal — the run's transition is already committed.
    }
  }

  /**
   * The cross-family record for an actively-routed auditor dispatch: derived
   * from the two-axis identity the core computed (or computed here for a locked
   * route, which the core does not re-derive), with the honest ceiling kept.
   */
  private crossFamilyOfResolution(resolution: RoleRouteResolution, role: Role, prior: Snapshot): {
    readonly outcome: CrossFamilyOutcome
    readonly diagnostic?: string
  } {
    if (resolution.kind !== 'dispatch' || resolution.routing === undefined) return { outcome: 'unknown-family' }
    const pin = resolution.routing.pin
    if (pin === undefined) {
      const required = RISK_ORDER.indexOf(prior.triage.risk) >= RISK_ORDER.indexOf(this.config.crossFamily.minRisk)
      if (!required) return { outcome: 'not-required' }
      return {
        outcome: 'unknown-family',
        diagnostic: 'the auditor dispatch inherits the deployment default (no explicit route), so its family is not observable here; cross-family can be claimed neither way',
      }
    }
    const executorPin = this.executorPinOf(prior)
    const required = AUDITOR_ROLE_SET.includes(role)
      && RISK_ORDER.indexOf(prior.triage.risk) >= RISK_ORDER.indexOf(this.config.crossFamily.minRisk)
    const record = independenceOf(pin, executorPin, required)
    if (record.outcome === 'achieved') {
      return {
        outcome: record.outcome,
        diagnostic: `independence: modelAxis ${record.modelAxis}, providerAxis ${record.providerAxis} (trim-exact id comparison only — no alias or lineage detection, no weight-independence claim)`,
      }
    }
    if (record.outcome === 'not-required') return { outcome: record.outcome }
    const label = record.outcome === 'same-family'
      ? 'auditor and executor are not distinct on both axes — a blind spot shared by that family passes both gates unchallenged'
      : 'the executor route is not observable (inheritance) — axes are unknown, order was unmodified'
    return {
      outcome: record.outcome,
      diagnostic: `independence: modelAxis ${record.modelAxis}, providerAxis ${record.providerAxis} — ${label}`,
    }
  }

  private assertAuditPhase(snapshot: Snapshot, role: AuditRole): void {
    if (role === 'plan') {
      if (snapshot.phase !== 'planning' && snapshot.phase !== 'replanning') {
        throw new AutopilotError(`plan audits run from planning/replanning, not ${snapshot.phase}`, 'AP_WRONG_PHASE')
      }
      if (snapshot.plan.revision < 1) {
        throw new AutopilotError('no plan submitted yet', 'AP_NO_PLAN')
      }
      return
    }
    if (snapshot.phase !== 'execution-reviewing' && snapshot.phase !== 'closing') {
      throw new AutopilotError(`${role} audits run from execution-reviewing/closing, not ${snapshot.phase}`, 'AP_WRONG_PHASE')
    }
  }

  /**
   * The channel bearers recorded at init, each read from what the mount can
   * actually SEE rather than from what the config asked for.
   *
   * `store` comes from the store instance itself, so a headless deployment
   * that fell back to files says 'file' and a web-app deployment says
   * 'domain'. `approval` is 'native' only when an approval service was
   * observable — otherwise the sole owner channel is the direct-human-turn
   * `autopilot_signal owner-approve`, which is what 'signal-only' names.
   * `egress` names which seam is doing the enforcing FOR THIS ROOT's scope.
   * `service` says whether `ctx.autopilot` was actually provided, because the
   * plugin deliberately survives a failed registration and a failure nothing
   * writes down cannot be observed later. Every probe failure reads as the
   * LESS capable value; a throwing probe never upgrades a claim.
   */
  private observedChannels(
    rootSessionId: string,
  ): Pick<Enforcement, 'store' | 'approval' | 'egress' | 'service' | 'outboundConsumed'> {
    let approvalNative = false
    try {
      approvalNative = this.environment.approvalAvailable?.() ?? false
    } catch {
      approvalNative = false
    }
    let egress: EgressChannel = 'guard-deny'
    try {
      egress = this.environment.egressChannel?.(rootSessionId) ?? 'guard-deny'
    } catch {
      egress = 'guard-deny'
    }
    let serviceRegistered = false
    try {
      serviceRegistered = this.environment.serviceRegistered?.() ?? false
    } catch {
      serviceRegistered = false
    }
    return {
      store: this.store.kind,
      approval: approvalNative ? 'native' : 'signal-only',
      egress,
      service: serviceRegistered ? 'registered' : 'unavailable',
      outboundConsumed: 0,
    }
  }

  /**
   * Sandbox coupling at init (standard runs only). Fail-open with an honest
   * record: 'active' requires BOTH the mode append succeeding AND a mounted
   * confine provider (the probe) — appending the event alone proves nothing
   * about OS enforcement, so recording 'active' on the append alone would be
   * a claim the code cannot observe being false.
   */
  private applyInitEnforcement(root: AgentRef, triage: Triage): Enforcement {
    const base: Enforcement = { sandbox: 'off', reminders: 0, ownerApprovals: [], ...this.observedChannels(root.id) }
    if (triage.size !== 'standard' || !this.config.gate.sandboxCoupling) return base
    try {
      const priorMode = effectiveSandboxMode(root.session.snapshotEvents())
      root.session.append('sandbox/mode', { mode: 'read-only' })
      let providerMounted = false
      try {
        providerMounted = this.sandboxAvailable()
      } catch {
        providerMounted = false
      }
      if (!providerMounted) {
        return {
          ...base,
          sandbox: 'degraded',
          modeAppended: true,
          ...(priorMode === undefined ? {} : { priorSandboxMode: priorMode }),
          diagnostic: 'sandbox mode appended but no confine provider is observable; shell is NOT OS-confined pre-plan-gate',
        }
      }
      return { ...base, sandbox: 'active', modeAppended: true, ...(priorMode === undefined ? {} : { priorSandboxMode: priorMode }) }
    } catch (error: unknown) {
      return { ...base, sandbox: 'degraded', diagnostic: `sandbox coupling failed: ${errorMessage(error)}` }
    }
  }

  /**
   * Restore the session sandbox mode when the plan gate passes. Restores
   * whenever the read-only mode event was APPENDED (active or degraded) —
   * a degraded run must not stay clamped read-only forever.
   */
  private restoreSandbox(root: AgentRef, prior: Snapshot): Enforcement {
    if (prior.enforcement.modeAppended !== true) return prior.enforcement
    try {
      const mode = prior.enforcement.priorSandboxMode ?? this.config.gate.restoreMode
      root.session.append('sandbox/mode', { mode })
      return prior.enforcement
    } catch (error: unknown) {
      return { ...prior.enforcement, sandbox: 'degraded', diagnostic: `sandbox restore failed: ${errorMessage(error)}` }
    }
  }

  private async drainExecutorIfRunning(root: AgentRef, prior: Snapshot): Promise<Snapshot | undefined> {
    if (prior.executor === undefined || prior.executor.state !== 'running') return undefined
    try {
      this.subagents.interrupt(prior.executor.childId, { kind: 'ancestor', agent: root })
      await this.subagents.drainContinuableChildren(root, [prior.executor.childId])
      return undefined
    } catch (error: unknown) {
      return await this.commit(prior, 'set-owner-decision', {
        ...prior,
        revision: prior.revision + 1,
        phase: 'needs-owner-decision',
        executionGate: 'needs-owner-decision',
        diagnostic: `executor drain failed: ${errorMessage(error)}`,
      })
    }
  }

  /** Apply one verdict to the state machine (shared by audit and selfCheck). */
  private async applyVerdict(root: AgentRef, liveIn: Snapshot, outcome: {
    role: AuditRole
    verdict: Verdict
    note: string
    auditorId: string
    route: RouteRecord
    external?: ExternalReview
    captured: { runRevision: number; planRevision: number; executionRevision: number }
    /** The dispatch's routing decision; its pin rides THIS commit (M3b). */
    routing?: RoutingDecisionDetail
  }): Promise<AuditOutcome> {
    // The routing pin derives onto exactly the commit that records this
    // dispatch's verdict, with the SAME shared rule the fold re-derives — every
    // `{...live}` below inherits it, and `routingDetail` stamps the event.
    const live = withRoutingDecision(liveIn, outcome.routing)
    const routingDetail = outcome.routing === undefined ? undefined : { routing: outcome.routing }
    const record: AuditRecord = {
      ...(outcome.external === undefined ? {} : { external: outcome.external }),
      role: outcome.role,
      seq: live.audits.length,
      runRevision: outcome.captured.runRevision,
      planRevision: outcome.captured.planRevision,
      executionRevision: outcome.captured.executionRevision,
      auditorId: outcome.auditorId,
      verdict: outcome.verdict,
      note: outcome.note,
      route: outcome.route,
    }
    const audits = [...live.audits, record]
    // The op distinguishes the three verdict PROVENANCES in the event stream
    // itself, so a reader of events.jsonl can tell a dispatched audit from a
    // self-review from an owner countersign without parsing route fields.
    const op: Operation = outcome.external !== undefined
      ? 'external-audit'
      : outcome.auditorId === 'self-check' ? 'self-check' : 'audit'
    const result: AuditOutcome = {
      verdict: outcome.verdict,
      note: outcome.note,
      auditorId: outcome.auditorId,
      route: outcome.route,
    }

    // needs-replan from any role: bounded escalation (CC: 2 rounds, the 3rd escalates).
    if (outcome.verdict === 'needs-replan') {
      const rounds = live.consecutiveReplans + 1
      if (rounds > MAX_REPLAN_ROUNDS) {
        await this.commit(live, op, {
          ...live,
          revision: live.revision + 1,
          phase: 'needs-owner-decision',
          planGate: outcome.role === 'plan' ? 'needs-owner-decision' : live.planGate,
          executionGate: outcome.role === 'plan' ? live.executionGate : 'needs-owner-decision',
          audits,
          consecutiveReplans: rounds,
          diagnostic: `bounded escalation: ${rounds} consecutive needs-replan rounds (max ${MAX_REPLAN_ROUNDS}); owner decision required`,
        }, routingDetail)
        return result
      }
      const prior = this.current(root.id) ?? live
      const drained = outcome.role !== 'plan' ? await this.drainExecutorIfRunning(root, prior) : undefined
      if (drained !== undefined) return result
      await this.commit(live, op, {
        ...live,
        revision: live.revision + 1,
        phase: 'replanning',
        planGate: 'needs-replan',
        executionGate: outcome.role === 'plan' ? live.executionGate : 'needs-replan',
        audits,
        consecutiveReplans: rounds,
        executor: keepOrSetExecutorState(live.executor, 'revoked'),
        executionPacket: undefined,
      }, routingDetail)
      return result
    }

    switch (outcome.verdict) {
      case 'pass': {
        if (outcome.role === 'plan') {
          // PLAN-GATE / USAGE COUPLING. The refusal happens BEFORE the commit
          // that would flip the gate, never after. The invariant this buys is
          // exactly "AT THE REVISION WHERE planGate BECOMES 'pass', the usage
          // question was answered" — not the durable implication the comment
          // used to assert. `declare-usage` stays legal in `executing` and
          // `autopilot_usage` accepts 'undeclared', so a later revision can
          // re-open the question; `startExecutor` and `evaluateCompletion` each
          // re-ask it rather than inferring an answer from the gate. Writing
          // the flip and then reversing it would leave a
          // persisted stream in which even the instant-wise claim is false at some revision,
          // and a stream is what an auditor reads. (This is the CC lesson
          // recorded in their ledger: a gate that persists first and validates
          // second has already told the lie.)
          //
          // WHAT HAPPENS TO THE VERDICT: it is RECORDED, not discarded. The
          // auditor really ran and really said pass; deleting that would erase
          // evidence to make bookkeeping tidy. So the audit record lands, the
          // phase returns to planning, the gate stays where it was, and the
          // caller gets a typed refusal naming every missing declaration. The
          // recovery path is `autopilot_usage` + a fresh plan audit. Refusing
          // BEFORE dispatch was rejected as the alternative: it would also
          // block plan audits whose verdict is needs-replan/blocked, which are
          // exactly the verdicts an undeclared run most needs to hear.
          const usageProblems = usageDeclarationProblems(live.usage)
          if (usageProblems.length > 0) {
            await this.commit(live, op, {
              ...live,
              revision: live.revision + 1,
              phase: 'planning',
              audits,
              diagnostic: `plan gate refused despite a pass verdict: ${usageProblems.join('; ')}`,
            }, routingDetail)
            throw new AutopilotError(
              `plan gate refused: usage evidence must be declared before the plan gate can pass: ${usageProblems.join('; ')}`,
              'AP_USAGE_UNDECLARED',
            )
          }
          const enforcement = this.restoreSandbox(root, live)
          await this.commit(live, op, {
            ...live,
            revision: live.revision + 1,
            phase: 'executing',
            planGate: 'pass',
            audits,
            consecutiveReplans: 0,
            enforcement,
            // Freshness anchor for usage artifacts, stamped on the FIRST pass
            // only. The fold refuses any restamp: re-anchoring would silently
            // re-admit artifacts captured before the gate.
            ...(live.planGatePassedAt === undefined
              ? { planGatePassedAt: new Date().toISOString() }
              : {}),
          }, routingDetail)
        } else if (outcome.role === 'execution') {
          await this.commit(live, op, {
            ...live,
            revision: live.revision + 1,
            phase: 'closing',
            executionGate: 'pass',
            audits,
            consecutiveReplans: 0,
            executor: keepOrSetExecutorState(live.executor, 'completed'),
          }, routingDetail)
        } else {
          // rules: record-only on pass; completion reads it via latestVerdicts.
          await this.commit(live, op, {
            ...live,
            revision: live.revision + 1,
            audits,
          }, routingDetail)
        }
        return result
      }
      case 'needs-fix': {
        await this.commit(live, op, {
          ...live,
          revision: live.revision + 1,
          phase: 'executing',
          executionGate: 'needs-fix',
          audits,
          executionPacket: undefined,
        }, routingDetail)
        return result
      }
      case 'blocked': {
        await this.commit(live, op, {
          ...live,
          revision: live.revision + 1,
          phase: 'blocked',
          planGate: outcome.role === 'plan' ? 'blocked' : live.planGate,
          executionGate: outcome.role === 'plan' ? live.executionGate : 'blocked',
          audits,
          diagnostic: outcome.note,
        }, routingDetail)
        return result
      }
      case 'needs-owner-decision': {
        await this.commit(live, op, {
          ...live,
          revision: live.revision + 1,
          phase: 'needs-owner-decision',
          planGate: outcome.role === 'plan' ? 'needs-owner-decision' : live.planGate,
          executionGate: outcome.role === 'plan' ? live.executionGate : 'needs-owner-decision',
          audits,
          diagnostic: outcome.note,
        }, routingDetail)
        return result
      }
      default: {
        const exhaustive: never = outcome.verdict
        throw new AutopilotError(`unhandled verdict ${String(exhaustive)}`, 'AP_UNREACHABLE')
      }
    }
  }

  /**
   * Project a snapshot into the model-facing status view.
   *
   * Public because the read-only `ctx.autopilot` service projects snapshots it
   * obtained by run id, where no calling Agent exists to authorize against —
   * and projection is a pure read, so it needs none.
   */
  projectStatus(snapshot: Snapshot): StatusView {
    const latest = latestVerdicts(snapshot.audits)
    const verdicts: Partial<Record<AuditRole, Verdict>> = {}
    for (const [role, record] of Object.entries(latest)) {
      verdicts[role as AuditRole] = record.verdict
    }
    return {
      runId: snapshot.runId,
      revision: snapshot.revision,
      phase: snapshot.phase,
      planGate: snapshot.planGate,
      executionGate: snapshot.executionGate,
      planRevision: snapshot.plan.revision,
      objective: snapshot.triage.objective,
      size: snapshot.triage.size,
      risk: snapshot.triage.risk,
      executionMode: snapshot.triage.executionMode,
      auditMode: snapshot.triage.auditMode,
      requiredRoles: requiredRoles(snapshot.triage),
      latestVerdicts: verdicts,
      replanBudgetRemaining: Math.max(0, MAX_REPLAN_ROUNDS - snapshot.consecutiveReplans),
      auditCount: snapshot.audits.length,
      logCount: snapshot.logCount,
      ...(snapshot.executor === undefined
        ? {}
        : { executor: { generation: snapshot.executor.generation, state: snapshot.executor.state } }),
      enforcement: snapshot.enforcement,
      closeoutSubmitted: snapshot.closeout !== undefined,
      ...((): { plannerRouting?: PlannerRoutingRecord } => {
        const planner = this.plannerInstalls.get(snapshot.runId)
        return planner?.kind === 'armed' ? { plannerRouting: planner.record } : {}
      })(),
      ...(snapshot.diagnostic === undefined ? {} : { diagnostic: snapshot.diagnostic }),
    }
  }
}

/**
 * Whether one owner approval's `target` authorizes the command about to run.
 *
 * TWO conditions, and both are needed:
 *
 * 1. The target must ITSELF be in the egress command class. `OwnerApproval.target`
 *    is documented as the human description of the approved egress; a target
 *    that is not a recognisable egress command is prose, and prose cannot be
 *    matched against a command without matching everything.
 * 2. The target must occur at a shell TOKEN BOUNDARY in EVERY egress-classified
 *    SEGMENT of the live command, using the same `matchesAtTokenBoundary` the
 *    outbound manifest's command-class rule uses. So `git push` authorizes
 *    `cd repo && git push origin main`, and does not authorize `npm publish` —
 *    nor `git push origin main && npm publish`, which is the escape this
 *    quantifier closes (measured 2026-08-25): the old rule asked whether the
 *    approved class appears SOMEWHERE in the command, and a command carrying a
 *    second, unapproved egress answers that yes. A command that classifies as
 *    egress nowhere falls back to the whole-line question.
 *
 * The direction is deliberate: the approval is the NARROWER string and must be
 * contained in the command. An owner who writes a sentence rather than a
 * command grants nothing, which is the fail-closed reading — the egress then
 * goes to `ask`, where the owner answers the question in front of them.
 */
export function approvalAuthorizes(target: string, command: string): boolean {
  const needle = target.trim()
  if (needle.length === 0) return false
  if (!isEgressCommand(needle)) return false
  const segments = egressSegments(command)
  if (segments.length === 0) return matchesAtTokenBoundary(command, needle)
  return segments.every(segment => matchesAtTokenBoundary(segment, needle))
}
