/**
 * Work classes (DESIGN §1.2 "任务档（work_class）决定哪条轴当主导").
 *
 * The class of a dispatch decides which ladder tiers it may draw members from
 * and which ordering axis dominates — the owner table (DESIGN §1.2), encoded
 * as DATA, not as model-name inference (§1.2's standing prohibition). The
 * five class names are fixed config paths (the same schemastery volatile
 * constraint that fixes the ladder tier names), the tier mapping and axis of
 * every class are the owner-stated defaults, and every leaf stays
 * owner-overridable via `routing.workClasses.<name>`.
 *
 * Nothing here reads the world: the selector receives the class's resolved
 * member set from the producer (the engine), which reads the live ladder.
 */

import type { Role } from './select.js'

/** The five fixed task classes of the owner table (DESIGN §1.2). */
export type WorkClassName = 'mechanical' | 'simple' | 'hard' | 'audit' | 'extreme'

/** Fixed iteration order: the owner table's row order. */
export const WORK_CLASS_NAMES: readonly WorkClassName[] = ['mechanical', 'simple', 'hard', 'audit', 'extreme']

/** The ladder tier names a class may draw members from. */
export type WorkClassTier = 'economy' | 'standard' | 'reserve'

/**
 * The dominant ordering axis of a class (owner table, column 2):
 *  - `speed` — owner-declared speedOrder first; cost is NOT an axis
 *    (mechanical: scan/enumerate/leaf edits).
 *  - `speed-cost` — speed first, effective cost breaks ties (simple daily
 *    work: 速度 + 价格).
 *  - `economy-first` — effective cost ascending first: the cheapest mapped
 *    tier is tried first (难度高: 先试 economy). The window a REQUEST opens is
 *    `ESCALATION_TIERS` (below), not this axis's business: the axis only says
 *    how the pool that exists is ranked, and a request widens the pool without
 *    changing the ranking rule.
 *  - `ceiling-independence` / `ceiling` — the class adds NO ranking of its
 *    own; ceiling is carried by the tier mapping and independence by the
 *    auditor rules, both upstream of ranking.
 */
export type WorkClassAxis = 'speed' | 'speed-cost' | 'economy-first' | 'ceiling-independence' | 'ceiling'

/** Fixed iteration order for validation and docs. */
export const WORK_CLASS_AXES: readonly WorkClassAxis[] = ['speed', 'speed-cost', 'economy-first', 'ceiling-independence', 'ceiling']

/** One resolved class: which tiers it draws from and which axis dominates. */
export interface ResolvedWorkClass {
  readonly name: WorkClassName
  /**
   * The mapped ladder tiers. EMPTY means entry is gated by the class's own
   * thresholds (mechanical: the `low`-effort license), never an error — the
   * zero-reachability case (a CONFIGURED ladder whose mapped tiers leave the
   * class no reachable route) is judged in the selector, where the
   * authorized set is known.
   */
  readonly tiers: readonly WorkClassTier[]
  readonly axis: WorkClassAxis
}

/**
 * The owner-table defaults (DESIGN §1.2). Bootstrap seed values under the
 * authority order (owner-explicit > live facts > bootstrap seed): an owner
 * override through `routing.workClasses.<name>` replaces them.
 */
export const DEFAULT_WORK_CLASSES: Readonly<Record<WorkClassName, ResolvedWorkClass>> = {
  mechanical: { name: 'mechanical', tiers: [], axis: 'speed' },
  simple: { name: 'simple', tiers: ['economy'], axis: 'speed-cost' },
  // `hard` = DESIGN §1.2's "try economy first; widen to the ceiling ONLY when
  // the working model ASKS for it". The REQUEST channel is now delivered (an
  // `escalate` checkpoint targeting `stronger-model`); the DEFAULT mapping
  // below stays the FIRST-TRY pool — economy — because seeding
  // standard/reserve here would hand every `hard` dispatch a ceiling route
  // with no request behind it: exactly the prediction-style widening DESIGN
  // forbids (`没有被请求就不升档`). An owner who wants a permanently wider
  // pool states it through `routing.workClasses.hard.tiers`; a REQUESTED
  // widening resolves through ESCALATION_TIERS instead (see there).
  hard: { name: 'hard', tiers: ['economy'], axis: 'economy-first' },
  audit: { name: 'audit', tiers: ['standard'], axis: 'ceiling-independence' },
  extreme: { name: 'extreme', tiers: ['reserve'], axis: 'ceiling' },
}

/**
 * The candidate pool a REQUESTED escalation resolves to when the owner has not
 * overridden the mapped class's own `tiers`.
 *
 * WHY A SEPARATE CONSTANT RATHER THAN WIDENING `DEFAULT_WORK_CLASSES.hard`.
 * DESIGN §1.2 makes escalation a REQUEST, not a prediction: the pool must stay
 * economy until something asks, and widen only for the dispatch that carries
 * the request. Putting these tiers in the class default would widen EVERY
 * `hard` dispatch — the forbidden shape — and would also make the owner's
 * `routing.workClasses.hard.tiers` override indistinguishable from the
 * default. So the request path states its own floor and the owner's mapping
 * still wins when written.
 *
 * The union spans all three owner tiers on purpose: the requester reported that
 * it could not make progress, so the point of the widening is the CEILING, and
 * which member of it is best is the ranking axes' question (cost first for
 * `economy-first`, then the owner's declared speed order) — not a second
 * hand-maintained tier list here.
 */
export const ESCALATION_TIERS: readonly WorkClassTier[] = ['economy', 'standard', 'reserve']

/**
 * The class a role draws from when the owner names none. Default-optimistic
 * (DESIGN §1.2 "升档是请求，不是预测"): implementation rides the daily
 * class; auditors ride the audit class. mechanical/hard/extreme are reached
 * only by the owner's per-role override (`routing.roles.<role>.workClass`) —
 * the plugin never predicts difficulty on its own.
 */
export const DEFAULT_ROLE_WORK_CLASS: Readonly<Record<Role, WorkClassName>> = {
  executor: 'simple',
  planner: 'simple',
  'plan-auditor': 'audit',
  'execution-auditor': 'audit',
  'rules-auditor': 'audit',
}

/**
 * The class assignment the selector consumes: the class plus its resolved
 * member set against the live ladder. `members` is the trim-exact
 * `provider/model` union of the mapped tiers; `ladderConfigured` records
 * whether ANY tier holds a member, because an empty ladder restricts NOTHING
 * (the shipped default — 0.2.0 parity) while a configured ladder that leaves
 * a mapped class zero reachable routes is a configuration error
 * (AP_ROUTE_NO_REACHABLE_WORK_CLASS).
 */
export interface WorkClassSelection {
  readonly name: WorkClassName
  readonly axis: WorkClassAxis
  /** The EFFECTIVE tier mapping (the audit-tier override applied, when set). */
  readonly tiers: readonly WorkClassTier[]
  readonly members: readonly string[]
  readonly ladderConfigured: boolean
  /**
   * Whether the class machinery APPLIES to this dispatch. False — the
   * shipped-default shape (an empty ladder AND no owner override of the
   * class or the role's class assignment) — means the selection is RECORDED
   * but nothing changes: no membership restriction, no class-axis ranking,
   * no class requirement gate (0.2.0 parity). The owner engages the
   * machinery by configuring the ladder or by naming the class themselves.
   */
  readonly engaged: boolean
  /** Present when `routing.ladder.auditTier` replaced the class's own mapping. */
  readonly tierOverride?: WorkClassTier
}

/**
 * Resolve one class against the live ladder (pure; the caller read the
 * world). `auditTier` is the owner's explicit per-deployment override of the
 * AUDIT class's tier mapping (`routing.ladder.auditTier`, auditor roles
 * only): owner-explicit beats the bootstrap-seeded mapping, and the
 * resulting record says so via `tierOverride`.
 *
 * `ownerOverridden` is the producer's record that the OWNER engaged this
 * class (a per-role `workClass` assignment or a `routing.workClasses.<name>`
 * override differing from the table default): with it, the machinery applies
 * even on an empty ladder. Without it and with an empty ladder the selection
 * is recorded, not applied (0.2.0 parity).
 */
export function resolveWorkClassSelection(
  classes: Readonly<Record<WorkClassName, ResolvedWorkClass>>,
  ladderTiers: Readonly<Record<WorkClassTier, readonly string[]>>,
  name: WorkClassName,
  auditTier?: WorkClassTier | 'none',
  ownerOverridden?: boolean,
): WorkClassSelection {
  const cls = classes[name]
  const tierOverride = name === 'audit' && auditTier !== undefined && auditTier !== 'none' ? auditTier : undefined
  const tiers: readonly WorkClassTier[] = tierOverride !== undefined ? [tierOverride] : cls.tiers
  const members: string[] = []
  for (const tier of tiers) {
    for (const entry of ladderTiers[tier] ?? []) {
      const key = entry.trim()
      if (key.length > 0 && !members.includes(key)) members.push(key)
    }
  }
  const ladderConfigured = (['economy', 'standard', 'reserve'] as const).some(
    (tier) => (ladderTiers[tier] ?? []).some((entry) => entry.trim().length > 0),
  )
  return {
    name,
    axis: cls.axis,
    tiers,
    members,
    ladderConfigured,
    engaged: ladderConfigured || ownerOverridden === true,
    ...(tierOverride === undefined ? {} : { tierOverride }),
  }
}