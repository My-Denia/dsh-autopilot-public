/**
 * The delegation ledger: what this mount has started, how it was routed, and
 * how it ended.
 *
 * IN MEMORY, PER ROOT SESSION, DELIBERATELY. There is no file, no storage
 * domain, no card and no route. The ledger answers "what did I delegate in this
 * session, and is it still running?" for the model and for `autopilot_agents`;
 * it is not a record of completion, authority or approval. A host restart (or
 * any reload of this plugin) loses it, and the children it described were
 * stopped by that same restart: the model starts new work instead of reading
 * stale rows. Nothing here is ever consulted as a gate.
 *
 * The records never leave the process, so they are plain mutable-free data
 * held in arrays; there is no compare-and-swap, no revision and no locking
 * because every writer lives in one event loop.
 */

/** The delegation roles. The main agent is not a role. */
export type DelegationRoleName = 'scout' | 'worker' | 'executor-lead' | 'planner' | 'reviewer'

/**
 * Lifecycle of one delegated child as this mount knows it.
 *
 * - `starting`: dispatch accepted, the host has not confirmed the child yet.
 * - `running`: the child exists and has not settled.
 * - `idle`: a continuable child that settled a turn and can be messaged.
 * - `completed` / `failed` / `cancelled`: terminal for this generation.
 *
 * There is no `lost` state: the ledger dies with the mount, so a restart cannot
 * observe a record whose child is gone.
 */
export type DelegationState = 'starting' | 'running' | 'idle' | 'completed' | 'failed' | 'cancelled'

/** A concrete model route. `effort` is absent when none was sent. */
export interface Route {
  readonly provider: string
  readonly model: string
  readonly effort?: string
}

/**
 * Where the route came from:
 * - `call`: the dispatch named provider and model explicitly.
 * - `inherit`: nothing was sent; the host's delegation default applies.
 */
export type RouteSource = 'call' | 'inherit'

/** One reviewer finding. Severities are `blocker` (must be fixed) and `note`. */
export interface ReviewFinding {
  readonly severity: 'blocker' | 'note'
  readonly file?: string
  readonly line?: number
  readonly note: string
}

/** The reviewer's structured verdict, returned in-band from the reviewing call. */
export interface ReviewVerdict {
  readonly verdict: 'pass' | 'fail'
  readonly findings: readonly ReviewFinding[]
  readonly summary?: string
}

/** One delegated child. */
export interface DelegationRecord {
  /** Host child session/agent id, minted before start. */
  readonly childId: string
  readonly role: DelegationRoleName
  /** The agent that dispatched it: the root id, or an executor-lead's child id. */
  readonly parentId: string
  /** 1-based depth below the root (the root's direct child is 1). */
  readonly depth: number
  /** Per-child generation: bumps when the same logical slot is re-dispatched. */
  readonly generation: number
  /** The child id this record replaces, when the dispatch named `replaces`. */
  readonly replaces?: string
  /** First line of the task, for display. The full brief stays in the child session. */
  readonly title: string
  readonly state: DelegationState
  /** Write scope declared at dispatch. Absent for read-only roles. */
  readonly writePaths?: readonly string[]
  /** The route sent with the dispatch. Absent when nothing was sent. */
  readonly route?: Route
  readonly routeSource: RouteSource
  /** The route the child's own first request header showed, when readable. */
  readonly observed?: Route
  /** The tool allow-list applied to the child, or `inherit` when unrestricted. */
  readonly tools: readonly string[] | 'inherit'
  /** maxDepth sent to the host for this child. */
  readonly maxDepth: number
  /** ISO-8601 UTC. */
  readonly startedAt: string
  readonly settledAt?: string
  /** Host stop reason or failure text, short. */
  readonly diagnostic?: string
  /** Escalation the child asked for (the child proposes, the parent decides). */
  readonly escalation?: { readonly reason: string; readonly at: string }
}

/** Fields a caller supplies when opening a record. */
export type NewDelegationRecord = Omit<DelegationRecord, 'state' | 'startedAt'>

/** The one in-memory ledger of this mount. */
export class LedgerStore {
  private readonly byRoot = new Map<string, DelegationRecord[]>()

  /** Every record of one root session, in dispatch order. */
  records(rootId: string): readonly DelegationRecord[] {
    return this.byRoot.get(rootId) ?? []
  }

  /** One record of one root session, or undefined. */
  find(rootId: string, childId: string): DelegationRecord | undefined {
    return this.byRoot.get(rootId)?.find((record) => record.childId === childId)
  }

  /** Append one record as `starting`. */
  add(rootId: string, record: NewDelegationRecord, startedAt: string): DelegationRecord {
    const stored: DelegationRecord = { ...record, state: 'starting', startedAt }
    const list = this.byRoot.get(rootId)
    if (list === undefined) this.byRoot.set(rootId, [stored])
    else list.push(stored)
    return stored
  }

  /**
   * Patch one record in place. Returns the patched record, or undefined when
   * the child is unknown under that root.
   */
  update(rootId: string, childId: string, patch: Partial<DelegationRecord>): DelegationRecord | undefined {
    const list = this.byRoot.get(rootId)
    if (list === undefined) return undefined
    const index = list.findIndex((record) => record.childId === childId)
    const current = list[index]
    if (current === undefined) return undefined
    const next: DelegationRecord = { ...current, ...patch }
    list[index] = next
    return next
  }

  /** Root ids that have at least one record (diagnostics and tests). */
  roots(): readonly string[] {
    return [...this.byRoot.keys()]
  }
}
