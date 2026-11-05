/**
 * The v3 ledger and its web projection: the one interface the engine writes
 * and the card renders.
 *
 * WHAT THE LEDGER IS FOR. Execution, cancel, resume and history display. It is
 * not a record of completion, approval or authority: the goal lives in the
 * host's native dsh-goal, the project record lives on the issue and the PR, and
 * the ledger only links to them. Nothing here is a gate.
 *
 * DEPENDENCY-FREE ON PURPOSE. The browser half (`src/client/**`, a separate
 * tsconfig with no node types) imports this file directly, so it names no
 * other module and no runtime value except the route constants below.
 *
 * STABILITY. Fields are added, never renamed or removed, inside v3. A change
 * that breaks a reader bumps `v`.
 */

/** Ledger format version. */
export const LEDGER_VERSION = 3 as const

// ─────────────────────────────────────────────────────────────────────────────
// Roles and routes
// ─────────────────────────────────────────────────────────────────────────────

/** The delegation roles (src/roles/). The main agent is not a role. */
export type DelegationRoleName = 'scout' | 'clerk' | 'worker' | 'executor-lead' | 'planner' | 'reviewer'

/** One concrete model route. `reasoningEffort` absent means none was sent / none was observed. */
export interface LedgerRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/**
 * Where the selected MODEL came from.
 * - `arg`: the dispatch call named it (autopilot_delegate model/provider).
 * - `pin`: a user role pin in plugin config (routing.roles.<role> lock).
 * - `ladder`: routing selected it from the user's ladder / work class.
 * - `inherit`: no route was sent; the host's delegation default applies.
 */
export type ModelSource = 'arg' | 'pin' | 'ladder' | 'inherit'

/**
 * Where the selected EFFORT came from. Kept separate from {@link ModelSource}
 * because the two can differ (MY-25 #1: an explicit effort on a ladder route).
 * - `arg` / `pin`: explicit user value, never overridden by preflight.
 * - `catalog-default`: the adapter's declared `defaultEffort` for the model.
 * - `host-default`: nothing was sent; the host decides (observed tells what it did).
 */
export type EffortSource = 'arg' | 'pin' | 'catalog-default' | 'host-default'

/**
 * Agreement between what was selected and what the child's first request
 * header shows. `pending` until the child has sent a request; `unreadable`
 * when the child session could not be read.
 */
export type RouteMatch = 'match' | 'mismatch' | 'pending' | 'unreadable'

// ─────────────────────────────────────────────────────────────────────────────
// Delegations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lifecycle of one delegated child as the ledger knows it.
 * - `starting`: dispatch accepted, child not yet confirmed by the host.
 * - `running`: the child exists and has not settled.
 * - `idle`: a continuable child that settled a turn and can be messaged.
 * - `completed` / `failed` / `cancelled`: terminal for this generation.
 * - `lost`: was `starting`/`running` when the plugin (re)loaded after a host
 *   restart; the host did not keep it running. Never auto-restarted.
 */
export type DelegationState = 'starting' | 'running' | 'idle' | 'completed' | 'failed' | 'cancelled' | 'lost'

export interface DelegationRecord {
  /** Host child session/agent id, minted before start when the host allows it. */
  readonly childId: string
  readonly role: DelegationRoleName
  /** The agent that dispatched it: the root session id, or an executor-lead's childId (depth 2). */
  readonly parentId: string
  /** 1-based depth below the root (root's direct child = 1). */
  readonly depth: number
  /** Per-child generation: bumps when the same logical slot is re-dispatched (escalation, replacement). */
  readonly generation: number
  /** The childId this record replaces (escalation or replacement), if any. */
  readonly replaces?: string
  /** First line of the task, for display. The full brief stays in the child session. */
  readonly title: string
  readonly state: DelegationState
  /** Write scope declared at dispatch. Empty/absent for read-only roles. Globs ending in `/**` are prefixes. */
  readonly writePaths?: readonly string[]
  /** What routing chose and sent. Absent when nothing was sent (`modelSource: 'inherit'`). */
  readonly selected?: LedgerRoute
  /** What the child's request header showed. Absent until observed. */
  readonly observed?: LedgerRoute
  readonly modelSource: ModelSource
  readonly effortSource: EffortSource
  readonly routeMatch: RouteMatch
  /** Short notes from routing (why this route, fallbacks taken). Display only. */
  readonly routeWhy?: readonly string[]
  /** Tool allow-list applied to the child (names), or `inherit` when unrestricted. */
  readonly tools: readonly string[] | 'inherit'
  /** maxDepth sent to the host for this child. */
  readonly maxDepth: number
  /** ISO-8601 UTC. */
  readonly startedAt: string
  readonly settledAt?: string
  /** Host stop reason / failure text, short. */
  readonly diagnostic?: string
  /** Escalation the child asked for (child proposes, main decides). */
  readonly escalation?: { readonly reason: string; readonly at: string }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reviews
// ─────────────────────────────────────────────────────────────────────────────

export type ReviewVerdict = 'pass' | 'needs-fix' | 'blocked'

/**
 * - `cross-family`: reviewer's provider family differs from every reviewed child's.
 * - `reduced`: no other family was available; same family used and said so.
 */
export type ReviewIndependence = 'cross-family' | 'reduced'

export interface ReviewFinding {
  readonly severity: 'blocker' | 'major' | 'minor'
  readonly summary: string
  readonly where?: string
}

export interface ReviewRecord {
  /** The reviewer child's id (also present as a `reviewer` delegation). */
  readonly reviewerChildId: string
  /** Delegations reviewed (childIds), possibly empty when the main agent's own work was reviewed. */
  readonly reviewedChildIds: readonly string[]
  /** One-line subject (PR, commit, chunk). */
  readonly subject: string
  readonly verdict: ReviewVerdict
  readonly findings: readonly ReviewFinding[]
  /** Reviewer's own route as observed (selected when not observed). */
  readonly reviewerRoute?: LedgerRoute
  readonly independence: ReviewIndependence
  /** Families excluded for independence (provider names). */
  readonly excludedFamilies: readonly string[]
  /** Whether every reviewed child's provider was known at dispatch; absent in older records. */
  readonly reviewedProvidersComplete?: boolean
  /** Routing note for a same-vendor or unobserved-vendor review, when there is one. */
  readonly independenceNote?: string
  readonly at: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Goal, links, markers
// ─────────────────────────────────────────────────────────────────────────────

/** A reference to the host's native dsh-goal. The goal itself is not stored here. */
export interface GoalRef {
  readonly goalId: string
  readonly revision?: number
  /** Last status the plugin read from the host (mirror, display only). */
  readonly status?: string
  readonly objective?: string
  /** Native dsh-goal blocked reason, mirrored (e.g. round-limit, queue-failed, model-reported). */
  readonly blockedReason?: { readonly code: string; readonly message: string }
  /** Whether the host's goal continuation is armed for this session (mirror). */
  readonly activation?: 'armed' | 'disarmed'
  readonly roundsStarted?: number
  readonly maxGoalRounds?: number
  readonly firstSeenAt: string
  readonly lastSeenAt: string
}

export interface LinkRecord {
  readonly kind: 'issue' | 'pr'
  /** e.g. `MY-195`, `#12`, or a URL. */
  readonly ref: string
  readonly url?: string
  readonly at: string
}

/** Set on the first load after a host restart that found unsettled children. */
export interface HostRestartMarker {
  readonly at: string
  readonly lostChildIds: readonly string[]
}

export interface AutoContinueStatus {
  /** Whether the host composition has a goal round driver for this session. */
  readonly available: boolean
  /** Machine-readable reason; `reason` keeps the plain text. Absent on ledgers written before this field. */
  readonly code?: 'driver-present' | 'no-driver-in-composition' | 'released-after-restart' | 'not-yet-observed' | 'unknown'
  /** Plain reason, e.g. `goal round driver present`, `released after host restart`, `no goal round driver in this composition`. */
  readonly reason: string
}

export interface DepthStatus {
  /** Depth the plugin sends for an executor-lead (2 unless the user set lower). */
  readonly executorLead: number
  /** `plugin-default` (2) or `user-setting` (a lower explicit user maxDepth was honored) or `unknown` (setting unreadable; host enforces). */
  readonly source: 'plugin-default' | 'user-setting' | 'unknown'
  readonly note?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy (pre-0.3.0 run streams, read-only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the lazy one-time sandbox restore did for a legacy run's session.
 * - `restored`: the plugin's own read-only clamp was still last; prior mode written back.
 * - `default-written`: clamp still last, no prior recorded; the host default was written
 *   (the host has no way to delete an override).
 * - `untouched-user-changed`: a later `sandbox/mode` event exists; left alone.
 * - `not-clamped`: the run never clamped (or the clamp was not the plugin's).
 * - `pending`: session not opened since upgrade.
 * - `failed`: the write threw; `note` says why.
 */
export type SandboxRestoreState = 'restored' | 'default-written' | 'untouched-user-changed' | 'not-clamped' | 'pending' | 'failed'

export interface SandboxRestoreRecord {
  readonly state: SandboxRestoreState
  /** Mode written back, for `restored` / `default-written`. */
  readonly mode?: string
  readonly at?: string
  readonly note?: string
}

/** One row of the legacy history list. */
export interface LegacyRunSummary {
  readonly runId: string
  readonly sessionId?: string
  readonly backend: 'file' | 'domain'
  /** `ok` when the frozen reader folded every event; `rejected` otherwise. */
  readonly fold: 'ok' | 'rejected'
  readonly foldError?: string
  readonly phase?: string
  readonly objective?: string
  readonly revision?: number
  readonly eventCount: number
  readonly sandboxRestore: SandboxRestoreRecord
}

/**
 * Full projection of one legacy run, frozen from the 0.2.x `RunProjection`
 * so the legacy renderer can show an old run completely. Routing and
 * reachability ride as opaque JSON (the 0.2.x card's mirror readers parse them).
 */
export interface LegacyRunProjection {
  readonly runId: string
  readonly revision: number
  readonly phase: string
  readonly planGate: string
  readonly executionGate: string
  readonly planRevision: number
  readonly objective: string
  readonly size: string
  readonly risk: string
  readonly executionMode: string
  readonly auditMode: string
  readonly requiredRoles: readonly string[]
  readonly latestVerdicts: Readonly<Record<string, string>>
  readonly replanBudgetRemaining: number
  readonly auditCount: number
  readonly logCount: number
  readonly closeoutSubmitted: boolean
  readonly executor?: { readonly generation: number; readonly state: string }
  readonly enforcement: Readonly<Record<string, unknown>>
  readonly routing?: unknown
  readonly routingReachability?: unknown
  readonly gateSources?: unknown
  /** Owner resolutions and plan amendments, for the runs that had them. */
  readonly ownerResolutions?: readonly { readonly at?: string; readonly text: string }[]
  readonly planAmendments?: number
  /** v3 addition: legacy archive status. */
  readonly archived: true
  readonly sandboxRestore: SandboxRestoreRecord
}

// ─────────────────────────────────────────────────────────────────────────────
// The ledger
// ─────────────────────────────────────────────────────────────────────────────

/** One root session's ledger. */
export interface Ledger {
  readonly v: typeof LEDGER_VERSION
  readonly sessionId: string
  /** Monotonic write counter (CAS). */
  readonly revision: number
  /** Current goal (latest seen) and earlier goals of the same session (A→B), newest last. */
  readonly goal?: GoalRef
  readonly previousGoals: readonly GoalRef[]
  readonly delegations: readonly DelegationRecord[]
  readonly reviews: readonly ReviewRecord[]
  readonly links: readonly LinkRecord[]
  readonly hostRestart?: HostRestartMarker
  readonly autoContinue: AutoContinueStatus
  readonly depth: DepthStatus
  /** Legacy run ids recorded for this session (summaries are served separately). */
  readonly legacyRunIds: readonly string[]
  /** Outcome of the one-time lazy sandbox restore, per legacy run id (absent = not attempted yet). */
  readonly legacyRestores?: Readonly<Record<string, SandboxRestoreRecord>>
  readonly updatedAt: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Web projection
// ─────────────────────────────────────────────────────────────────────────────

/** `GET LEDGER_ROUTE?session=<id>` → {@link LedgerBody}. */
export const LEDGER_ROUTE = '/api/autopilot/ledger'
/** `GET LEGACY_RUNS_ROUTE` → {@link LegacyRunsBody} (every legacy run, both backends). */
export const LEGACY_RUNS_ROUTE = '/api/autopilot/runs'
/** `GET LEGACY_RUN_ROUTE?id=<runId>` → {@link LegacyRunBody}. Same path as 0.2.x. */
export const LEGACY_RUN_ROUTE = '/api/autopilot/run'

/** What the card renders for one session. */
export interface LedgerProjection {
  readonly v: typeof LEDGER_VERSION
  readonly sessionId: string
  readonly revision: number
  readonly goal?: GoalRef
  readonly previousGoals: readonly GoalRef[]
  readonly delegations: readonly DelegationRecord[]
  readonly reviews: readonly ReviewRecord[]
  readonly links: readonly LinkRecord[]
  readonly hostRestart?: HostRestartMarker
  readonly autoContinue: AutoContinueStatus
  readonly depth: DepthStatus
  /** Legacy runs of this session, summarized. */
  readonly legacyRuns: readonly LegacyRunSummary[]
  /** One-time notes (e.g. deprecated config keys ignored). */
  readonly notes: readonly string[]
  /**
   * Retired config keys the host ignored, as data (the card words the notice in the viewer's
   * language). Absent from older hosts; `notes` still carries the English sentence for the tool.
   */
  readonly retiredConfigKeys?: readonly string[]
  readonly updatedAt: string
}

export interface LedgerBody {
  readonly ok: true
  readonly ledger: LedgerProjection
}

export interface LegacyRunsBody {
  readonly ok: true
  readonly runs: readonly LegacyRunSummary[]
}

export interface LegacyRunBody {
  readonly ok: true
  readonly run: LegacyRunProjection
}

/** Error bodies carry a code, never free text from the store. */
export interface ErrorBody {
  readonly ok: false
  readonly error: 'missing-session' | 'missing-id' | 'no-ledger' | 'no-run' | 'internal'
}
