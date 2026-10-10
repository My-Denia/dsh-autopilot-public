/**
 * The cost seed's contract.
 *
 * The seed exists to replace a proxy with a fact, so these checks are about the
 * ways that can go wrong: the seed claiming more than it is, the seed silently
 * shrinking, and — the correction that produced this file — the seed keying on
 * something that is not the model's identity.
 */

import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_SEED_BY_MODEL,
  CAPABILITY_SEED_BY_ROUTE,
  CAPABILITY_SEED_PROVENANCE,
  seededCost,
} from '../src/routing/capability-seed.js'

/**
 * Providers whose catalogs are aggregators, resellers or gateways.
 *
 * The seed's header states this exclusion; the assertion is what keeps the two
 * in sync. A gateway's price is a resale and its ids are namespaced, so a
 * seeded entry there would be a fact about a route this plugin cannot resolve.
 */
const EXCLUDED_PREFIXES = [
  'openrouter', 'vercel-ai-gateway', 'amazon-bedrock', 'azure-openai-responses',
  'google-vertex', 'github-copilot', 'huggingface', 'cloudflare-', 'opencode',
  'radius', 'together', 'baseten', 'fireworks', 'nvidia', 'groq', 'cerebras',
  'ant-ling', 'meta',
]

const routes = Object.entries(CAPABILITY_SEED_BY_ROUTE)
const models = Object.entries(CAPABILITY_SEED_BY_MODEL)

function wellFormed(key: string, cost: { inputPerM: number; outputPerM: number; cacheReadPerM?: number }): void {
  expect(Number.isFinite(cost.inputPerM), key).toBe(true)
  expect(cost.inputPerM, key).toBeGreaterThan(0)
  expect(Number.isFinite(cost.outputPerM), key).toBe(true)
  expect(cost.outputPerM, key).toBeGreaterThan(0)
  if (cost.cacheReadPerM !== undefined) expect(cost.cacheReadPerM, key).toBeGreaterThan(0)
}

describe('capability seed', () => {
  it('declares itself as a cost snapshot, not a capability or authority claim', () => {
    expect(CAPABILITY_SEED_PROVENANCE.id).toMatch(/^seed-cost@\d{4}-\d{2}-\d{2}$/)
    expect(CAPABILITY_SEED_PROVENANCE.source).toContain('pi-ai/dist/providers/data')
    expect(CAPABILITY_SEED_PROVENANCE.scope).toContain('never a capability ranking')
    expect(CAPABILITY_SEED_PROVENANCE.scope).toContain('never a dispatch authority')
  })

  it('holds enough entries to be worth having (cardinality floors)', () => {
    // A seed that silently emptied would make every economy dispatch report
    // cost-unknown and read as a calm pass. Floors first, then contents.
    expect(routes.length).toBeGreaterThanOrEqual(100)
    expect(models.length).toBeGreaterThanOrEqual(100)
  })

  it('is structurally sound in both indexes', () => {
    for (const [key, cost] of routes) {
      expect(key.split('/').length, key).toBeGreaterThanOrEqual(2)
      wellFormed(key, cost)
    }
    for (const [model, cost] of models) {
      expect(model.trim().length, model).toBeGreaterThan(0)
      expect(model.includes('/'), model).toBe(false)
      wellFormed(model, cost)
    }
  })

  it('omits subscription and free routes, whose zero is a billing arrangement', () => {
    for (const [key, cost] of routes) expect(cost.inputPerM === 0 && cost.outputPerM === 0, key).toBe(false)
    for (const [key, cost] of models) expect(cost.inputPerM === 0 && cost.outputPerM === 0, key).toBe(false)
  })

  it('carries no aggregator or gateway provider', () => {
    for (const key of Object.keys(CAPABILITY_SEED_BY_ROUTE)) {
      const provider = key.slice(0, key.lastIndexOf('/'))
      for (const excluded of EXCLUDED_PREFIXES) {
        expect(provider === excluded || provider.startsWith(excluded), key).toBe(false)
      }
    }
  })

  it('keeps the model index consistent with the route index', () => {
    // The model index is provider-blind, so it is only as trustworthy as the
    // catalogs being consistent about an id. Where a route states a price for
    // that same id, the two must agree; the generator refuses an id with two
    // prices outright, which is why this can assert equality rather than note a
    // tolerance.
    let compared = 0
    for (const [key, cost] of routes) {
      const model = key.slice(key.lastIndexOf('/') + 1)
      const canonical = CAPABILITY_SEED_BY_MODEL[model]
      if (canonical === undefined) continue
      compared++
      expect(canonical, key).toEqual(cost)
    }
    expect(compared).toBeGreaterThan(0)
  })

  it('resolves from the specific to the general and REPORTS which step answered', () => {
    const flash = seededCost('zai', 'glm-5.3-flash')
    expect(flash?.match).toBe('route')
    expect(flash?.source).toBe('zai/glm-5.3-flash')

    // Kimi is Moonshot's model; which catalog file names it is bookkeeping.
    // `k3` is packaged under kimi-coding in the catalogs while an operator may
    // register it under moonshotai. The model index is what survives that.
    const k3 = seededCost('moonshotai', 'k3')
    expect(k3?.match).toBe('model')
    expect(k3?.source).toBe('k3')

    const highspeed = seededCost('moonshotai', 'kimi-for-coding-highspeed')
    expect(highspeed?.match).toBe('model')

    // A misspelled route id is RECOVERED but LABELLED: a typo must be visible,
    // not silently absorbed as if it were the route the operator meant.
    const typo = seededCost('moonshotai', 'kimI-for-coding')
    expect(typo?.match).toBe('model-case-folded')
    expect(typo?.source).toBe('kimi-for-coding')
    expect(typo?.cost).toEqual(seededCost('kimi-coding', 'kimi-for-coding')?.cost)

    // A model the catalogs genuinely do not carry stays unknown.
    expect(seededCost('moonshotai', 'k3-256k')).toBeUndefined()
    expect(seededCost('', '')).toBeUndefined()
    expect(seededCost('openrouter', 'anything')).toBeUndefined()
  })

  it('answers unknown rather than substituting a proxy', () => {
    expect(seededCost('zai', 'glm-5.3-does-not-exist')).toBeUndefined()
    expect(seededCost('nonexistent-provider', 'glm-5.3')?.match).toBe('model')
  })

  it('adds information a context window cannot carry', () => {
    // THE DEFECT THIS TABLE FIXES, pinned. `economy` used to rank by smallest
    // context window, which is not a price. This pair declares the SAME window
    // and materially different prices, so a window-derived proxy ties them
    // while the true costs do not.
    const flash = seededCost('zai', 'glm-5.3-flash')?.cost
    const full = seededCost('zai', 'glm-5.3')?.cost
    expect(flash, 'seed must keep both zai/glm-5.3-flash and zai/glm-5.3').toBeDefined()
    expect(full, 'seed must keep both zai/glm-5.3-flash and zai/glm-5.3').toBeDefined()
    if (flash === undefined || full === undefined) return
    // If a future catalog update inverts this, the economy preference's premise
    // changed and this test SHOULD fail loudly rather than rank wrong.
    expect(flash.inputPerM).toBeLessThan(full.inputPerM)
    expect(flash.outputPerM).toBeLessThan(full.outputPerM)
  })

  it('keeps the DeepSeek pair the out-of-the-box ladder depends on', () => {
    expect(seededCost('deepseek', 'deepseek-flash')).toBeDefined()
    // V4 Pro is seeded even though the owner judges it weak: the seed states
    // price, and a price stays true whatever a capability ranking says.
    expect(seededCost('deepseek', 'deepseek-v4-pro')).toBeDefined()
  })
})
