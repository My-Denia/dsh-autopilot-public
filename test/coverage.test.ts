/**
 * The coverage report's contract.
 *
 * Its job is to be the thing that CANNOT say "covered" when nothing was
 * observed, nothing was configured, or a provider failed to list. Every
 * assertion below is therefore about a way to withhold that claim.
 */

import { describe, expect, it } from 'vitest'
import { coverageReport, coverageRouteKey } from '../src/routing/coverage.js'
import type { CoverageCatalog } from '../src/routing/coverage.js'

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
    // No field anywhere asserts work-class reachability, because the plugin has
    // no work-class input. The type is the guard.
    expect(report.kind).toBe('tier-coverage')
    expect(JSON.stringify(report)).not.toContain('workClass')
  })
})
