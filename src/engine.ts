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
  RunEvent,
  RunId,
  Snapshot,
  Stance,
  Triage,
  UsageEntry,
  UsageEvidence,
  Verdict,
} from './domain/types.js'
import { settleExternalReviews, settleUsageArtifacts, usageDeclarationProblems, validateUsageEntry } from './domain/usage.js'
import { SHELL_TOOLS, egressSegments, isEgressCommand } from './gate/decide.js'
import { matchesAtTokenBoundary } from './outbound/manifest.js'
import type { RunStoreLike } from './store/types.js'

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

function captureRoute(childId: string, provider: string, agent: AgentRef | undefined): RouteRecord {
  const routeProvider = agent?.options?.provider
  const routeModel = agent?.options?.model
  if (routeProvider !== undefined && routeModel !== undefined) {
    return { provider, routeProvider, routeModel, routeStatus: 'verified' }
  }
  return {
    provider,
    routeProvider: routeProvider ?? 'unverified',
    routeModel: routeModel ?? 'unverified',
    routeStatus: 'unverified',
    routeDiagnostic: `child ${childId}: provider/model not available from durable Agent options`,
  }
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
  ) {}

  /**
   * Dispose: abort new work, then WAIT (bounded) for in-flight transactions to
   * settle — dispose must reach quiescence, not just request it. The 5s bound
   * is a protocol constant; tails swallow their own errors, so allSettled here
   * cannot reject.
   */
  async dispose(): Promise<void> {
    this.lifecycle.abort(new AutopilotError('autopilot engine disposed', 'AP_DISPOSED'))
    const pending = [...this.tails.values()]
    if (pending.length === 0) return
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5000)
        if (typeof timer === 'object' && 'unref' in timer) timer.unref()
      }),
    ])
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
      // Cross-family review: past the risk floor, prefer a reviewer the
      // executor is not from. The CHOICE is recorded on the audit's route
      // whatever it turns out to be, including the two ways it can fail to
      // happen — a silent fallback to the builder's own family would be the
      // pseudo-active defect class this repo keeps paying for.
      const choice = selectCrossFamily({
        risk: prior.triage.risk,
        configured: this.config.auditors[request.role]?.agentOptions,
        executor: this.config.executor.agentOptions,
        policy: this.config.crossFamily,
      })
      const agentOptions = choice.agentOptions
      const schema = request.role === 'plan' ? PLAN_VERDICT_SCHEMA : EXECUTION_VERDICT_SCHEMA

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
        // whose surface was reduced, and by what.
        const route = withCrossFamily(
          withToolDiagnostic(captureRoute(run.id, provider, run.localAgent), toolDiagnostic),
          choice,
        )
        return await this.applyVerdict(root, live, {
          role: request.role,
          verdict: structured.verdict as Verdict,
          note: structured.note ?? '',
          auditorId: run.id,
          route,
          captured,
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
      const agentOptions = this.config.executor.agentOptions
      const executor: ExecutorRecord = {
        childId,
        generation: prior.executor === undefined ? 1 : prior.executor.generation + 1,
        executionRevision: 1,
        state: 'starting',
        route: agentOptions?.provider !== undefined && agentOptions.model !== undefined
          ? { provider, routeProvider: agentOptions.provider, routeModel: agentOptions.model, routeStatus: 'verified' }
          : { provider, routeProvider: 'unverified', routeModel: 'unverified', routeStatus: 'unverified', routeDiagnostic: 'executor route inherits the deployment default' },
      }
      const starting = await this.commit(prior, 'start-executor', {
        ...prior,
        revision: prior.revision + 1,
        executor,
      }, { stage: 'starting', childId })

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
        const route = withToolDiagnostic(
          captureRoute(childId, provider, this.agents.get(childId)),
          dispatched.resolution.diagnostic,
        )
        return await this.commit(starting, 'start-executor', {
          ...starting,
          revision: starting.revision + 1,
          executor: { ...executor, state: 'running', route },
        }, { stage: 'running', childId })
      } catch (error: unknown) {
        // Record the reason ON THE EXECUTOR RECORD, not only in the run-level
        // `diagnostic`. A revoked executor is the artefact a later reader
        // inspects to ask "why did delegation never start", and the run-level
        // field is transition-scoped (see `commit`) so it does not survive the
        // next revision. `route.routeDiagnostic` does.
        await this.commit(starting, 'start-executor', {
          ...starting,
          revision: starting.revision + 1,
          executor: {
            ...executor,
            state: 'revoked',
            route: withToolDiagnostic(executor.route, `executor startup failed: ${errorMessage(error)}`),
          },
          diagnostic: `executor startup failed: ${errorMessage(error)}`,
        }, { stage: 'revoked', childId })
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
    if (loaded !== undefined) this.cache.set(runId, loaded)
    return loaded
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
    const candidate: RunEvent = {
      v: 1,
      op,
      revision: scoped.revision,
      time: new Date().toISOString(),
      snapshot: scoped,
      ...(detail === undefined ? {} : { detail }),
    }
    applyEvent(prior, candidate)
    await this.store.commit(scoped.runId, op, scoped, detail)
    this.cache.set(scoped.runId, scoped)
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
  private async applyVerdict(root: AgentRef, live: Snapshot, outcome: {
    role: AuditRole
    verdict: Verdict
    note: string
    auditorId: string
    route: RouteRecord
    external?: ExternalReview
    captured: { runRevision: number; planRevision: number; executionRevision: number }
  }): Promise<AuditOutcome> {
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
        })
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
      })
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
            })
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
          })
        } else if (outcome.role === 'execution') {
          await this.commit(live, op, {
            ...live,
            revision: live.revision + 1,
            phase: 'closing',
            executionGate: 'pass',
            audits,
            consecutiveReplans: 0,
            executor: keepOrSetExecutorState(live.executor, 'completed'),
          })
        } else {
          // rules: record-only on pass; completion reads it via latestVerdicts.
          await this.commit(live, op, {
            ...live,
            revision: live.revision + 1,
            audits,
          })
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
        })
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
        })
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
        })
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
