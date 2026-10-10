/**
 * Tier coverage over the OBSERVED live catalog.
 *
 * WHAT THIS REPORTS, AND WHAT IT REFUSES TO REPORT. It answers one question:
 * given the ladder's configured tier membership, is every model we actually
 * OBSERVED placed in some tier? It does NOT answer "does every model have a
 * reachable work class", because no dispatch site supplies a work class yet, so
 * that question has no input. The result type says `'tier-coverage'` for that
 * reason: an empty set must never be readable as work-class success, and a
 * capability the plugin does not have must not be implied by a green report.
 *
 * WHY THE OUTCOMES ARE FIVE AND NOT A BOOLEAN. A boolean would have to collapse
 * "everything is placed", "nothing is configured", "the catalog could not be
 * read" and "some providers failed to list" into the same word. The first is
 * the only one that may claim coverage; the other three are absences of
 * observation, and an unobserved catalog is not a covered one.
 */

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
