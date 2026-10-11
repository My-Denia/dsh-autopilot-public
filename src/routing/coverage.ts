/**
 * Coverage over the OBSERVED live catalog: two metrics, one doctrine.
 *
 * TIER COVERAGE (`coverageReport`). It answers one question: given the
 * ladder's configured tier membership, is every model we actually OBSERVED
 * placed in some tier? The result type says `'tier-coverage'` — an empty
 * set must never be readable as success, and placement in a tier is NOT
 * reachability by a work class (a tier no class draws from is placed but
 * unreachable).
 *
 * WORK-CLASS REACHABILITY (`workClassReachability`, DESIGN §9-14/16). The
 * per-model question the dispatch side now has the input for: is every
 * observed model inside AT LEAST ONE work class's member set? A different
 * kind (`'work-class-reachability'`), because the claims differ — a green
 * tier report must not read as a work-class claim and vice versa. The two
 * metrics coincide only when the class-tier union spans every configured
 * tier (the shipped defaults) AND the listing is complete.
 *
 * WHY THE OUTCOMES ARE FIVE AND NOT A BOOLEAN. A boolean would have to collapse
 * "everything is placed / reachable", "nothing is configured", "the catalog
 * could not be read" and "some providers failed to list" into the same word.
 * The first is the only one that may claim coverage; the other three are
 * absences of observation, and an unobserved catalog is not a covered one.
 */
import {
  resolveWorkClassSelection,
  WORK_CLASS_NAMES,
  type ResolvedWorkClass,
  type WorkClassName,
  type WorkClassTier,
} from './work-class.js'
/** The catalog facts this check needs. Supplied structurally, never imported. */
export interface CoverageCatalog {
  /** `'live'` only when the listing actually succeeded. */
  readonly catalogStatus: 'live' | 'unavailable'
  /** The models the listing returned. An empty list with a live status is still unobservable. */
  readonly models: readonly { readonly provider: string; readonly id: string }[]
  /**
   * Providers whose listing FAILED during an otherwise live read. A live
   * snapshot can carry these with an incomplete model list, and claiming
   * coverage over a list that never arrived is the exact over-claim this
   * field exists to prevent.
   */
  readonly failedProviders: readonly string[]
}

/** The owner's configured tier membership. */
export interface CoverageLadder {
  readonly tiers: Readonly<Record<string, readonly string[]>>
}

/**
 * `'unobservable'` — the catalog is unavailable, or the listing returned nothing.
 * `'unconfigured'` — no tier has any member, so there is nothing to be covered BY.
 * `'incomplete'`   — a live listing where some providers failed: models may exist that we never saw.
 * `'gap'`          — observed models that no configured tier places.
 * `'covered'`      — the ONLY outcome that claims coverage.
 */
export type CoverageOutcome = 'unobservable' | 'unconfigured' | 'incomplete' | 'gap' | 'covered'

export interface CoverageReport {
  /** Identifies the metric. Deliberately not "work-class reachability". */
  readonly kind: 'tier-coverage'
  readonly outcome: CoverageOutcome
  /** How many models were actually observed. */
  readonly observed: number
  /** Observed models placed in a configured tier. */
  readonly placed: readonly string[]
  /** Observed models no configured tier places. */
  readonly gaps: readonly string[]
  /** Configured tiers with no observed member. */
  readonly emptyTiers: readonly string[]
  /** Providers whose listing failed, carried so the reader sees WHY coverage is withheld. */
  readonly failedProviders: readonly string[]
  readonly why: readonly string[]
}

/** Trim-exact `provider/model`, the same identity rule the seed and the pins use. */
export function coverageRouteKey(provider: string, model: string): string {
  return `${provider.trim()}/${model.trim()}`
}

/** Tiers that actually declare a member. An empty tier covers nothing by definition. */
function configuredTiers(ladder: CoverageLadder): readonly (readonly [string, readonly string[]])[] {
  return Object.entries(ladder.tiers)
    .map(([name, members]) => [name, members.map(member => member.trim()).filter(member => member.length > 0)] as const)
    .filter(([, members]) => members.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
}

export function coverageReport(catalog: CoverageCatalog, ladder: CoverageLadder): CoverageReport {
  const failedProviders = [...catalog.failedProviders].map(provider => provider.trim()).filter(provider => provider.length > 0).sort()
  const base = {
    kind: 'tier-coverage' as const,
    placed: [] as readonly string[],
    gaps: [] as readonly string[],
    emptyTiers: [] as readonly string[],
    failedProviders,
  }

  // Observation first: nothing below can be asserted about a catalog we did not read.
  if (catalog.catalogStatus !== 'live' || catalog.models.length === 0) {
    return {
      ...base,
      outcome: 'unobservable',
      observed: 0,
      why: [
        catalog.catalogStatus !== 'live'
          ? `the catalog read reported "${catalog.catalogStatus}" — no listing succeeded, so coverage is not claimed`
          : 'the catalog read succeeded but listed no models — an empty listing cannot support a coverage claim',
      ],
    }
  }

  const tiers = configuredTiers(ladder)
  if (tiers.length === 0) {
    return {
      ...base,
      outcome: 'unconfigured',
      observed: catalog.models.length,
      why: ['every configured tier is empty, so no model can be placed and no coverage can be claimed — this is a configuration state, not a pass'],
    }
  }

  const observedKeys = catalog.models.map(model => coverageRouteKey(model.provider, model.id)).sort()
  const covered = new Set(tiers.flatMap(([, members]) => members))
  const placed = observedKeys.filter(key => covered.has(key))
  const gaps = observedKeys.filter(key => !covered.has(key))
  const emptyTiers = tiers.filter(([, members]) => !members.some(member => observedKeys.includes(member))).map(([name]) => name)

  // A live read that lost providers has an unknown denominator. It is reported
  // BEFORE gaps/covered, because "everything we saw is placed" is not coverage
  // when we did not see everything.
  if (failedProviders.length > 0) {
    return {
      ...base,
      outcome: 'incomplete',
      observed: observedKeys.length,
      placed,
      gaps,
      emptyTiers,
      why: [
        `the listing was live but ${String(failedProviders.length)} provider(s) failed to list: ${failedProviders.join(', ')} — models from those providers were never observed, so coverage is withheld`,
      ],
    }
  }

  if (gaps.length > 0) {
    return {
      ...base,
      outcome: 'gap',
      observed: observedKeys.length,
      placed,
      gaps,
      emptyTiers,
      why: [`${String(gaps.length)} observed model(s) are placed in no configured tier`],
    }
  }

  return {
    ...base,
    outcome: 'covered',
    observed: observedKeys.length,
    placed,
    gaps,
    emptyTiers,
    why: [`all ${String(observedKeys.length)} observed model(s) are placed in a configured tier`],
  }
}
/**
 * WORK-CLASS REACHABILITY over the OBSERVED live catalog (DESIGN §9 items
 * 14/16). The per-MODEL question tier-coverage deliberately could not ask:
 * for every model we actually observed, does AT LEAST ONE work class's
 * member set include it — i.e. could a dispatch drawing from some class
 * reach it? A model inside a configured tier that NO class draws from is
 * tier-covered but work-class-unreachable; that difference is the entire
 * reason this metric exists alongside the legacy one.
 *
 * WHAT IT REFUSES TO REPORT. A class with NO tier mapping (the mechanical
 * class) admits members through fact-gated licenses (a real `low` effort
 * published by the adapter), which a catalog LISTING does not carry — exact
 * routes must be resolved one by one for that. Such classes are named in
 * `nonTierBoundClasses` and never silently counted as vouching for any
 * model: a model outside every tier-bound class's members is reported
 * unreachable ON LISTING FACTS ALONE, with the why saying so.
 *
 * The five outcomes mirror tier-coverage's discipline: `'reachable'` is the
 * ONLY outcome that claims anything; `unobservable`, `unconfigured` and
 * `incomplete` are absences of observation or configuration, never passes.
 */
export type ReachabilityOutcome =
  | 'unobservable'
  | 'unconfigured'
  | 'incomplete'
  | 'unreachable-models'
  | 'reachable'

/** One observed model and the classes whose member sets include it. */
export interface ModelReachability {
  readonly model: string
  /** Tier-bound classes that could reach this model. Empty ⇒ the model is unreachable. */
  readonly reachableClasses: readonly WorkClassName[]
}

export interface WorkClassReachabilityReport {
  /** Identifies the metric. Deliberately a DIFFERENT kind than tier-coverage. */
  readonly kind: 'work-class-reachability'
  readonly outcome: ReachabilityOutcome
  /** How many models were actually observed. */
  readonly observed: number
  /** Observed models at least one tier-bound class can reach. */
  readonly reachable: readonly string[]
  /** Observed models NO tier-bound class can reach — the finding this metric exists for. */
  readonly unreachable: readonly string[]
  /** Per-model detail, same order as `reachable` + `unreachable` would give (sorted keys). */
  readonly models: readonly ModelReachability[]
  /**
   * Classes with NO tier mapping (entry is fact-gated, not listing-gated).
   * Named, never counted: the listing cannot prove or disprove their reach.
   */
  readonly nonTierBoundClasses: readonly WorkClassName[]
  /** Providers whose listing failed, carried so the reader sees WHY reachability is withheld. */
  readonly failedProviders: readonly string[]
  readonly why: readonly string[]
}

/**
 * Per-model work-class reachability. `auditTier` is the owner's deployment-
 * level override of the AUDIT class's tier mapping (`routing.ladder.auditTier`)
 * — the selector honors it for auditor roles, so the coverage report must
 * answer with the SAME effective mapping, never the superseded one.
 */
export function workClassReachability(
  catalog: CoverageCatalog,
  ladder: CoverageLadder,
  workClasses: Readonly<Record<WorkClassName, ResolvedWorkClass>>,
  auditTier?: WorkClassTier | 'none',
): WorkClassReachabilityReport {
  const failedProviders = [...catalog.failedProviders]
    .map(provider => provider.trim())
    .filter(provider => provider.length > 0)
    .sort()
  const nonTierBoundClasses = WORK_CLASS_NAMES.filter(name => workClasses[name].tiers.length === 0)
  const base = {
    kind: 'work-class-reachability' as const,
    reachable: [] as readonly string[],
    unreachable: [] as readonly string[],
    models: [] as readonly ModelReachability[],
    nonTierBoundClasses,
    failedProviders,
  }
  const nonTierBoundWhy =
    nonTierBoundClasses.length === 0
      ? []
      : [
          `class(es) with no tier mapping — ${nonTierBoundClasses.join(', ')} — admit members through fact-gated licenses (a real 'low' effort published by the adapter), which a catalog listing does not carry; they cannot vouch for any model from this report and are named, never counted`,
        ]

  // Observation first: nothing below can be asserted about a catalog we did not read.
  if (catalog.catalogStatus !== 'live' || catalog.models.length === 0) {
    return {
      ...base,
      outcome: 'unobservable',
      observed: 0,
      why: [
        catalog.catalogStatus !== 'live'
          ? `the catalog read reported "${catalog.catalogStatus}" — no listing succeeded, so reachability is not claimed`
          : 'the catalog read succeeded but listed no models — an empty listing cannot support a reachability claim',
        ...nonTierBoundWhy,
      ],
    }
  }

  // Only the three real tiers participate; unknown keys in the structural
  // ladder are ignored exactly as the selector ignores them.
  const tiers: Readonly<Record<WorkClassTier, readonly string[]>> = {
    economy: ladder.tiers['economy'] ?? [],
    standard: ladder.tiers['standard'] ?? [],
    reserve: ladder.tiers['reserve'] ?? [],
  }
  const anyConfigured = (['economy', 'standard', 'reserve'] as const).some(tier =>
    tiers[tier].some(member => member.trim().length > 0),
  )
  if (!anyConfigured) {
    return {
      ...base,
      outcome: 'unconfigured',
      observed: catalog.models.length,
      why: [
        'every configured tier is empty, so no class can reach any model and no reachability can be claimed — this is a configuration state, not a pass',
        ...nonTierBoundWhy,
      ],
    }
  }

  // Per-class member sets, resolved with the SAME effective mapping the
  // selector uses (the auditTier override applied to the audit class).
  const memberSets = new Map<WorkClassName, ReadonlySet<string>>(
    WORK_CLASS_NAMES.map(name => {
      const selection = resolveWorkClassSelection(
        workClasses,
        tiers,
        name,
        name === 'audit' ? auditTier : undefined,
      )
      return [name, new Set(selection.members)] as const
    }),
  )

  const observedKeys = catalog.models.map(model => coverageRouteKey(model.provider, model.id)).sort()
  const models: ModelReachability[] = observedKeys.map(key => ({
    model: key,
    reachableClasses: WORK_CLASS_NAMES.filter(name => memberSets.get(name)?.has(key) === true),
  }))
  const reachable = models.filter(entry => entry.reachableClasses.length > 0).map(entry => entry.model)
  const unreachable = models.filter(entry => entry.reachableClasses.length === 0).map(entry => entry.model)

  // A live read that lost providers has an unknown denominator — reported
  // BEFORE reachable/unreachable, same as tier-coverage's incomplete rule.
  if (failedProviders.length > 0) {
    return {
      ...base,
      outcome: 'incomplete',
      observed: observedKeys.length,
      reachable,
      unreachable,
      models,
      why: [
        `the listing was live but ${String(failedProviders.length)} provider(s) failed to list: ${failedProviders.join(', ')} — models from those providers were never observed, so reachability is withheld`,
        ...nonTierBoundWhy,
      ],
    }
  }

  if (unreachable.length > 0) {
    return {
      ...base,
      outcome: 'unreachable-models',
      observed: observedKeys.length,
      reachable,
      unreachable,
      models,
      why: [
        `${String(unreachable.length)} observed model(s) are in NO work class's member set: ${unreachable.join(', ')} — a dispatch drawing from any tier-bound class could never select them`,
        ...nonTierBoundWhy,
      ],
    }
  }

  return {
    ...base,
    outcome: 'reachable',
    observed: observedKeys.length,
    reachable,
    unreachable,
    models,
    why: [
      `all ${String(observedKeys.length)} observed model(s) are reachable by at least one tier-bound work class`,
      ...nonTierBoundWhy,
    ],
  }
}