/**
 * M5 (DESIGN §9 item 12): the first-use routing onboarding section.
 *
 * Every assertion below is about WHEN the notice may spend prompt tokens
 * (only on an observed unreachable-models finding with routing on) and WHAT
 * it may claim (the profile config is the only ladder truth; capability
 * facts must be checked, never inferred from names).
 */

import { describe, expect, it } from 'vitest'
import { workClassReachability } from '../src/routing/coverage.js'
import type { CoverageCatalog } from '../src/routing/coverage.js'
import { observeOnboardingReachability, renderRoutingOnboarding } from '../src/routing/onboarding.js'
import { DEFAULT_WORK_CLASSES } from '../src/routing/work-class.js'

const LIVE: CoverageCatalog['catalogStatus'] = 'live'

/** A live catalog whose glm-5.3-flash sits in NO tier any default class maps to. */
function unreachableReport() {
  return workClassReachability(
    { catalogStatus: LIVE, models: [{ provider: 'zai', id: 'glm-5.3' }, { provider: 'zai', id: 'glm-5.3-flash' }], failedProviders: [] },
    { tiers: { standard: ['zai/glm-5.3'] } },
    DEFAULT_WORK_CLASSES,
  )
}

describe('renderRoutingOnboarding', () => {
  it('renders the notice only on an observed unreachable-models finding with routing on', () => {
    const report = unreachableReport()
    expect(report.outcome).toBe('unreachable-models')
    const text = renderRoutingOnboarding({ mode: 'auto', report, configEditorAvailable: false, policyState: 'present' })
    expect(text).not.toBe('')
    // The finding is named, by catalog id.
    expect(text).toContain('glm-5.3-flash')
    expect(text).not.toContain('(+')
    // The fix points at the profile config ladder leaves, and ONLY there.
    expect(text).toContain('routing.ladder.tiers')
    expect(text).toContain('volatile')
    expect(text).toContain('no restart')
    // Capability facts must be CHECKED, never inferred from names (§1.2).
    expect(text).toContain('Do NOT infer capabilities from model names')
    // No plugin-private policy file is ever referenced as a write target.
    expect(text).not.toMatch(/goal-runs|\.jsonl|plugin-artifacts/)
  })

  it('degrades to the owner-edit path when the host exposes no config editor — and hands over the promised YAML', () => {
    const text = renderRoutingOnboarding({ mode: 'auto', report: unreachableReport(), configEditorAvailable: false, policyState: 'present' })
    expect(text).toContain('no config-edit surface')
    expect(text).toContain('ask them to edit the profile config')
    expect(text).not.toContain('apply the edit yourself')
    // The promise is now kept: a fenced YAML block carrying the OBSERVED ids.
    expect(text).toContain('```yaml')
    expect(text).toContain('- id: autopilot')
    expect(text).toContain('storeKind: file')
    expect(text).toContain('      ladder:')
    expect(text).toContain('            - zai/glm-5.3-flash')
    // Never a name-based tier verdict: the tier is the owner's/facts' call.
    expect(text).toContain('pick ONE of economy / standard / reserve per model')
  })

  it('offers the agent-edit path when a config editor IS available, without a redundant YAML block', () => {
    const text = renderRoutingOnboarding({ mode: 'auto', report: unreachableReport(), configEditorAvailable: true, policyState: 'present' })
    expect(text).toContain('apply the edit yourself with the host config editor')
    expect(text).not.toContain('no config-edit surface')
    // It names the leaves instead — no block, and no promise of one.
    expect(text).toContain('routing.ladder.tiers.economy')
    expect(text).not.toContain('```yaml')
    expect(text).not.toContain('YAML for the owner')
  })

  it('renders zero tokens when routing is OFF, whatever the report says', () => {
    expect(renderRoutingOnboarding({ mode: 'off', report: unreachableReport(), configEditorAvailable: false, policyState: 'present' })).toBe('')
  })

  it('renders zero tokens when the catalog was never observed (absence is not reachability)', () => {
    expect(renderRoutingOnboarding({ mode: 'auto', report: undefined, configEditorAvailable: false, policyState: 'present' })).toBe('')
  })

  it('renders zero tokens on every outcome that is not an unreachable-models finding', () => {
    const outcomes = [
      // reachable: the whole ladder placed, nothing to onboard.
      workClassReachability(
        { catalogStatus: LIVE, models: [{ provider: 'zai', id: 'glm-5.3' }], failedProviders: [] },
        { tiers: { standard: ['zai/glm-5.3'] } },
        DEFAULT_WORK_CLASSES,
      ),
      // unobservable: no observation, no claim.
      workClassReachability({ catalogStatus: 'unavailable', models: [], failedProviders: [] }, { tiers: { standard: [] } }, DEFAULT_WORK_CLASSES),
      // unconfigured: the shipped default is a normal pre-ladder state.
      workClassReachability({ catalogStatus: LIVE, models: [{ provider: 'zai', id: 'glm-5.3' }], failedProviders: [] }, { tiers: {} }, DEFAULT_WORK_CLASSES),
      // incomplete: a failed provider listing is withheld observation.
      workClassReachability(
        { catalogStatus: LIVE, models: [{ provider: 'zai', id: 'glm-5.3' }], failedProviders: ['kimi'] },
        { tiers: { standard: ['zai/glm-5.3'] } },
        DEFAULT_WORK_CLASSES,
      ),
    ]
    for (const report of outcomes) {
      expect(renderRoutingOnboarding({ mode: 'auto', report, configEditorAvailable: false, policyState: 'present' })).toBe('')
    }
  })

  it('names at most five models inline and tails the rest as "+N more"', () => {
    const models = Array.from({ length: 8 }, (_, index) => ({ provider: 'zai', id: `glm-${index}` }))
    const report = workClassReachability(
      { catalogStatus: LIVE, models, failedProviders: [] },
      { tiers: { standard: ['zai/glm-0'] } },
      DEFAULT_WORK_CLASSES,
    )
    expect(report.unreachable.length).toBe(7)
    const text = renderRoutingOnboarding({ mode: 'auto', report, configEditorAvailable: false, policyState: 'present' })
    expect(text).toContain('(+2 more)')
  })

  // ── M7 live finding (2026-10-10): a policy-less session selects NOTHING ──
  //
  // Measured on a real 0.2.0 desktop host: the ladder was fully configured and
  // this notice fired, while every dispatch still recorded `authorization: no
  // session model-selection policy recorded (the native default) — auto mode
  // performs inheritance only`. A notice about unreachable models that stayed
  // silent about that would imply autonomous selection was live when it was not.
  it('says the ladder selects NOTHING when the session has no model-selection policy', () => {
    const text = renderRoutingOnboarding({ mode: 'auto', report: unreachableReport(), configEditorAvailable: true, policyState: 'absent' })
    expect(text).toContain('INHERITANCE ONLY')
    expect(text).toContain('Allow agents to choose models for Subagents')
    expect(text).toContain('NEW sessions')
    // The ladder advice is not withdrawn — tier edits still decide this notice.
    expect(text).toContain('routing.ladder.tiers')
  })

  it('names an UNREACHABLE policy projection as its own cause', () => {
    const text = renderRoutingOnboarding({ mode: 'auto', report: unreachableReport(), configEditorAvailable: false, policyState: 'unreachable' })
    expect(text).toContain('UNREACHABLE')
    expect(text).toContain('unreachable-inherit')
    expect(text).not.toContain('Allow agents to choose models for Subagents')
  })

  it('stays silent about selection when the session policy IS present (nothing to warn)', () => {
    const text = renderRoutingOnboarding({ mode: 'auto', report: unreachableReport(), configEditorAvailable: false, policyState: 'present' })
    expect(text).not.toContain('INHERITANCE ONLY')
    expect(text).not.toContain('Blocker to know')
  })
})

describe('observeOnboardingReachability', () => {
  it('computes the report through the SAME workClassReachability metric the engine surfaces', async () => {
    const catalog = {
      snapshot: async () => ({
        catalogStatus: 'live' as const,
        providers: [{ id: 'zai', name: 'ZAI' }],
        listedModels: [
          { provider: 'zai', id: 'glm-5.3', name: 'GLM 5.3' },
          { provider: 'zai', id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
        ],
        providerErrors: new Map<string, string>(),
      }),
    }
    const report = await observeOnboardingReachability(catalog, { tiers: { standard: ['zai/glm-5.3'] } }, DEFAULT_WORK_CLASSES)
    expect(report?.kind).toBe('work-class-reachability')
    expect(report?.outcome).toBe('unreachable-models')
    expect(report?.unreachable).toEqual(['zai/glm-5.3-flash'])
  })

  it('never throws: a failed catalog read yields undefined (unobserved, not reachable)', async () => {
    const catalog = {
      snapshot: async () => {
        throw new Error('scripted catalog failure')
      },
    }
    await expect(observeOnboardingReachability(catalog, { tiers: {} }, DEFAULT_WORK_CLASSES)).resolves.toBeUndefined()
  })
})