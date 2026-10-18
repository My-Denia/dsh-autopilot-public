/**
 * The coverage report's contract.
 *
 * Its job is to be the thing that CANNOT say "covered" when nothing was
 * observed, nothing was configured, or a provider failed to list. Every
 * assertion below is therefore about a way to withhold that claim.
 */

import { describe, expect, it } from 'vitest'
import { coverageReport, coverageRouteKey, workClassReachability } from '../src/routing/coverage.js'
import type { CoverageCatalog } from '../src/routing/coverage.js'
import { DEFAULT_WORK_CLASSES } from '../src/routing/work-class.js'
import type { ResolvedWorkClass, WorkClassName } from '../src/routing/work-class.js'

const LIVE: CoverageCatalog['catalogStatus'] = 'live'
const ladder = (tiers: Record<string, readonly string[]>) => ({ tiers })

describe('coverageReport', () => {
  it('reports a live model no configured tier places, by name', () => {
    const report = coverageReport(
      { catalogStatus: LIVE, models: [{ provider: 'zai', id: 'glm-5.3' }, { provider: 'zai', id: 'glm-5.3-flash' }], failedProviders: [] },
      ladder({ standard: ['zai/glm-5.3'] }),
    )
    expect(report.outcome).toBe('gap')
    expect(report.gaps).toEqual(['zai/glm-5.3-flash'])
    expect(report.placed).toEqual(['zai/glm-5.3'])
    expect(report.observed).toBe(2)
  })

  it('claims covered only when every observed model is placed', () => {
    const report = coverageReport(
      { catalogStatus: LIVE, models: [{ provider: 'zai', id: 'glm-5.3' }], failedProviders: [] },
      ladder({ standard: ['zai/glm-5.3'] }),
    )
    expect(report.outcome).toBe('covered')
    expect(report.gaps).toEqual([])
    expect(report.kind).toBe('tier-coverage')
  })

  it('refuses to claim coverage on an EMPTY catalog (non-vacuity floor)', () => {
    // The failure mode this whole module exists for: an empty model list would
    // satisfy "every observed model is placed" vacuously and read as a pass.
    const report = coverageReport({ catalogStatus: LIVE, models: [], failedProviders: [] }, ladder({ standard: ['zai/glm-5.3'] }))
    expect(report.outcome).toBe('unobservable')
    expect(report.outcome).not.toBe('covered')
    expect(report.observed).toBe(0)
  })

  it('refuses to claim coverage when the catalog read failed', () => {
    const report = coverageReport(
      { catalogStatus: 'unavailable', models: [{ provider: 'zai', id: 'glm-5.3' }], failedProviders: [] },
      ladder({ standard: ['zai/glm-5.3'] }),
    )
    expect(report.outcome).toBe('unobservable')
  })

  it('refuses to claim coverage when no tier has a member', () => {
    const report = coverageReport(
      { catalogStatus: LIVE, models: [{ provider: 'zai', id: 'glm-5.3' }], failedProviders: [] },
      ladder({ standard: [], reserve: ['  '] }),
    )
    expect(report.outcome).toBe('unconfigured')
    expect(report.outcome).not.toBe('covered')
  })

  it('withholds coverage when a live listing lost providers, even if everything seen is placed', () => {
    // A live snapshot can be INCOMPLETE. "Everything we saw is placed" is not
    // coverage when we did not see everything.
    const report = coverageReport(
      { catalogStatus: LIVE, models: [{ provider: 'zai', id: 'glm-5.3' }], failedProviders: ['moonshotai'] },
      ladder({ standard: ['zai/glm-5.3'] }),
    )
    expect(report.outcome).toBe('incomplete')
    expect(report.outcome).not.toBe('covered')
    expect(report.failedProviders).toEqual(['moonshotai'])
    expect(report.gaps).toEqual([]) // nothing observed is unplaced ...
  })

  it('names configured tiers that hold no observed member', () => {
    const report = coverageReport(
      { catalogStatus: LIVE, models: [{ provider: 'zai', id: 'glm-5.3' }], failedProviders: [] },
      ladder({ standard: ['zai/glm-5.3'], reserve: ['openai/gpt-6-astra'] }),
    )
    expect(report.outcome).toBe('covered')
    expect(report.emptyTiers).toEqual(['reserve'])
  })

  it('matches membership trim-exact and ignores blank entries', () => {
    expect(coverageRouteKey('  zai ', ' glm-5.3 ')).toBe('zai/glm-5.3')
    const report = coverageReport(
      { catalogStatus: LIVE, models: [{ provider: 'zai', id: 'glm-5.3' }], failedProviders: [] },
      ladder({ standard: [' zai/glm-5.3 ', ''] }),
    )
    expect(report.outcome).toBe('covered')
  })

  it('never reports a work-class claim: the metric is named tier-coverage', () => {
    const report = coverageReport({ catalogStatus: LIVE, models: [], failedProviders: [] }, ladder({}))
    // Tier placement and work-class reachability are different questions with
    // different kinds; the tier-coverage metric answers ONLY its own. The
    // work-class question moved to `workClassReachability` below. The type is
    // the guard.
    expect(report.kind).toBe('tier-coverage')
    expect(JSON.stringify(report)).not.toContain('workClass')
  })
})
/**
 * The work-class reachability metric (DESIGN §9-14/16). Same withholding
 * doctrine as tier-coverage, plus the two things that metric could not say:
 * an observed model NO class can reach is a finding, and a class with no
 * tier mapping (mechanical) is named but never counted as vouching for
 * anyone from a listing.
 */
describe('workClassReachability', () => {
  const classes = DEFAULT_WORK_CLASSES

  it('is a different kind and reports reachable when every observed model has a class', () => {
    const report = workClassReachability(
      { catalogStatus: LIVE, models: [{ provider: 'zai', id: 'glm-5.3' }, { provider: 'zai', id: 'glm-5.3-flash' }], failedProviders: [] },
      ladder({ standard: ['zai/glm-5.3'], economy: ['zai/glm-5.3-flash'] }),
      classes,
    )
    expect(report.kind).toBe('work-class-reachability')
    expect(report.outcome).toBe('reachable')
    expect(report.observed).toBe(2)
    expect(report.reachable).toEqual(['zai/glm-5.3', 'zai/glm-5.3-flash'])
    expect(report.unreachable).toEqual([])
    // Per-model detail names WHICH classes can reach it. `hard` is NOT one of
    // them: its default pool is economy-only (DESIGN's first-try rule), and
    // this model sits in `standard` — reachable through the audit class only.
    const glm = report.models.find(entry => entry.model === 'zai/glm-5.3')
    expect(glm?.reachableClasses).toEqual(['audit'])
    expect(glm?.reachableClasses).not.toContain('mechanical')
    const flash = report.models.find(entry => entry.model === 'zai/glm-5.3-flash')
    expect(flash?.reachableClasses).toEqual(['simple', 'hard'])
  })

  it('names an observed model NO tier-bound class can reach — the finding this metric exists for', () => {
    // alpha/m-b sits in the economy tier, but the owner re-mapped the classes
    // so nobody draws economy: tier-coverage would say "placed", this metric
    // must say "unreachable".
    const remapped: Readonly<Record<WorkClassName, ResolvedWorkClass>> = {
      ...classes,
      simple: { ...classes.simple, tiers: ['standard'] },
      hard: { ...classes.hard, tiers: ['standard', 'reserve'] },
    }
    const report = workClassReachability(
      {
        catalogStatus: LIVE,
        models: [
          { provider: 'alpha', id: 'm-a' },
          { provider: 'alpha', id: 'm-b' },
          { provider: 'beta', id: 'm-c' },
        ],
        failedProviders: [],
      },
      ladder({ economy: ['alpha/m-b'], standard: ['alpha/m-a'], reserve: ['beta/m-c'] }),
      remapped,
    )
    expect(report.outcome).toBe('unreachable-models')
    expect(report.unreachable).toEqual(['alpha/m-b'])
    expect(report.why.join('\n')).toContain('alpha/m-b')
    expect(report.why.join('\n')).toContain("NO work class's member set")
  })

  it('answers with the auditTier override, never the superseded seeded mapping', () => {
    // Only the audit class draws standard; an auditTier override to reserve
    // moves its member set, so the standard-only model flips unreachable.
    const remap: Readonly<Record<WorkClassName, ResolvedWorkClass>> = {
      ...classes,
      simple: { ...classes.simple, tiers: ['economy'] },
      hard: { ...classes.hard, tiers: ['economy'] },
    }
    const catalog: CoverageCatalog = {
      catalogStatus: LIVE,
      models: [
        { provider: 'alpha', id: 'm-a' },
        { provider: 'alpha', id: 'm-b' },
        { provider: 'beta', id: 'm-c' },
      ],
      failedProviders: [],
    }
    const tiers = ladder({ economy: ['alpha/m-b'], standard: ['alpha/m-a'], reserve: ['beta/m-c'] })
    const seeded = workClassReachability(catalog, tiers, remap)
    expect(seeded.outcome).toBe('reachable')
    const overridden = workClassReachability(catalog, tiers, remap, 'reserve')
    expect(overridden.outcome).toBe('unreachable-models')
    expect(overridden.unreachable).toEqual(['alpha/m-a'])
    // The override must not leak into non-audit classes: reserve's beta/m-c
    // stays reachable (via extreme) in both readings.
    expect(overridden.reachable).toEqual(expect.arrayContaining(['beta/m-c']))
  })

  it('names mechanical as non-tier-bound and never lets it vouch for a model', () => {
    // m-x is listed but in NO configured tier. Mechanical admits members via
    // fact-gated licenses, which a listing does not carry — so the model is
    // unreachable ON LISTING FACTS, and the why says so.
    const report = workClassReachability(
      { catalogStatus: LIVE, models: [{ provider: 'zai', id: 'glm-5.3' }, { provider: 'zai', id: 'm-x' }], failedProviders: [] },
      ladder({ standard: ['zai/glm-5.3'] }),
      classes,
    )
    expect(report.outcome).toBe('unreachable-models')
    expect(report.unreachable).toEqual(['zai/m-x'])
    expect(report.nonTierBoundClasses).toEqual(['mechanical'])
    expect(report.why.join('\n')).toContain('mechanical')
    expect(report.why.join('\n')).toContain('fact-gated')
    // Even a FULLY reachable report carries the named caveat.
    const covered = workClassReachability(
      { catalogStatus: LIVE, models: [{ provider: 'zai', id: 'glm-5.3' }], failedProviders: [] },
      ladder({ standard: ['zai/glm-5.3'] }),
      classes,
    )
    expect(covered.outcome).toBe('reachable')
    expect(covered.nonTierBoundClasses).toEqual(['mechanical'])
    expect(covered.why.join('\n')).toContain('never counted')
  })

  it('refuses to claim reachability on an EMPTY catalog (non-vacuity floor)', () => {
    const report = workClassReachability({ catalogStatus: LIVE, models: [], failedProviders: [] }, ladder({ standard: ['zai/glm-5.3'] }), classes)
    expect(report.outcome).toBe('unobservable')
    expect(report.outcome).not.toBe('reachable')
    expect(report.observed).toBe(0)
  })

  it('refuses to claim reachability when the catalog read failed', () => {
    const report = workClassReachability(
      { catalogStatus: 'unavailable', models: [{ provider: 'zai', id: 'glm-5.3' }], failedProviders: [] },
      ladder({ standard: ['zai/glm-5.3'] }),
      classes,
    )
    expect(report.outcome).toBe('unobservable')
  })

  it('refuses to claim reachability when no tier has a member', () => {
    const report = workClassReachability(
      { catalogStatus: LIVE, models: [{ provider: 'zai', id: 'glm-5.3' }], failedProviders: [] },
      ladder({ standard: [], reserve: ['  '] }),
      classes,
    )
    expect(report.outcome).toBe('unconfigured')
    expect(report.outcome).not.toBe('reachable')
  })

  it('withholds reachability when a live listing lost providers', () => {
    const report = workClassReachability(
      { catalogStatus: LIVE, models: [{ provider: 'zai', id: 'glm-5.3' }], failedProviders: ['moonshotai'] },
      ladder({ standard: ['zai/glm-5.3'] }),
      classes,
    )
    expect(report.outcome).toBe('incomplete')
    expect(report.outcome).not.toBe('reachable')
    expect(report.failedProviders).toEqual(['moonshotai'])
  })

  it('matches membership trim-exact', () => {
    const report = workClassReachability(
      { catalogStatus: LIVE, models: [{ provider: 'zai', id: 'glm-5.3' }], failedProviders: [] },
      ladder({ standard: [' zai/glm-5.3 ', ''] }),
      classes,
    )
    expect(report.outcome).toBe('reachable')
  })
})