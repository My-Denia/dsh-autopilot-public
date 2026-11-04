/**
 * The owner's routing ladder.
 *
 * The two properties worth pinning are that an absent ladder is a DECLARED
 * default rather than something derived from model names, and that a malformed
 * owner instruction is REFUSED rather than dropped — a silently ignored pricing
 * override would leave the owner believing a route costs what it does not.
 */

import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/index.js'

describe('routing.ladder', () => {
  it('resolves to declared defaults when the owner configures nothing', () => {
    const ladder = resolveConfig({}).routing.ladder
    expect(ladder.tiers).toEqual({ economy: [], standard: [], reserve: [] })
    expect(ladder.auditTier).toBe('none')
    expect(ladder.speedOrder).toEqual([])
    expect(ladder.costOverrides).toEqual([])
  })

  it('keeps the owner values an owner actually wrote', () => {
    const ladder = resolveConfig({
      routing: {
        ladder: {
          tiers: { economy: ['zai/glm-5.3-flash'], standard: ['zai/glm-5.3', 'moonshotai/k3'], reserve: [] },
          auditTier: 'standard',
          speedOrder: ['zai/glm-5.3-flash', 'moonshotai/kimi-for-coding-highspeed'],
          costOverrides: ['zai/glm-5.3=1.0/3.0'],
        },
      },
    }).routing.ladder
    expect(ladder.tiers.economy).toEqual(['zai/glm-5.3-flash'])
    expect(ladder.tiers.standard).toEqual(['zai/glm-5.3', 'moonshotai/k3'])
    expect(ladder.auditTier).toBe('standard')
    expect(ladder.speedOrder).toEqual(['zai/glm-5.3-flash', 'moonshotai/kimi-for-coding-highspeed'])
    expect(ladder.costOverrides).toEqual([{ provider: 'zai', model: 'glm-5.3', inputPerM: 1, outputPerM: 3 }])
  })

  it('trims entries and drops blanks rather than carrying empty membership', () => {
    const ladder = resolveConfig({
      routing: { ladder: { tiers: { economy: ['  zai/glm-5.3-flash  ', '   '] } } },
    }).routing.ladder
    expect(ladder.tiers.economy).toEqual(['zai/glm-5.3-flash'])
  })

  it('REFUSES a malformed cost override instead of ignoring it', () => {
    for (const bad of ['zai/glm-5.3', 'zai/glm-5.3=free', 'zai/glm-5.3=1.0', 'zai/glm-5.3=0/3', '=1/2']) {
      expect(() => resolveConfig({ routing: { ladder: { costOverrides: [bad] } } }), bad).toThrow(/costOverrides/)
    }
  })

  it('REFUSES an auditTier outside the fixed set', () => {
    expect(() => resolveConfig({ routing: { ladder: { auditTier: 'premium' as never } } })).toThrow(/auditTier/)
  })

  it('states no tier from a model name: an empty ladder stays empty', () => {
    // The guard against the failure this design exists to prevent. A resolved
    // ladder is a record of what the OWNER said, so a catalog full of
    // flash/pro/highspeed names must not populate it.
    const ladder = resolveConfig({ routing: {} }).routing.ladder
    expect(JSON.stringify(ladder.tiers)).toBe('{"economy":[],"standard":[],"reserve":[]}')
    expect(ladder.auditTier).toBe('none')
  })
})
