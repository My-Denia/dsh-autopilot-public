/**
 * The injected `autopilot:policy` prompt section.
 *
 * In 0.3.0 it is empty unless a host restart took running children. The notice
 * is the only channel that tells the main agent so, and a channel checked only
 * for existence can go silent unobserved: the assertions below are on the
 * content a model needs (which children, that auto-continue was released, what
 * resumes the work) and on the zero-token cases.
 */

import { describe, expect, it } from 'vitest'
import { renderRootPolicy } from '../src/policy.js'
import { emptyLedger } from '../src/store/ledger.js'
import type { Ledger } from '../src/domain/ledger-types.js'
import { delegation } from './helpers.js'

const NOW = '2026-11-04T00:00:00.000Z'

function restarted(overrides: Partial<Ledger> = {}): Ledger {
  return {
    ...emptyLedger('root-1', NOW),
    delegations: [delegation('w-1', 'lost', { title: 'port the parser' }), delegation('s-1', 'completed', { role: 'scout' })],
    hostRestart: { at: NOW, lostChildIds: ['w-1'] },
    autoContinue: { available: false, reason: 'released after host restart' },
    ...overrides,
  }
}

describe('renderRootPolicy: zero tokens by default', () => {
  it('is empty with no ledger at all', () => {
    expect(renderRootPolicy(undefined)).toBe('')
  })

  it('is empty for a ledger with children but no host restart', () => {
    const ledger = { ...emptyLedger('root-1', NOW), delegations: [delegation('w-1', 'running')] }
    expect(renderRootPolicy(ledger)).toBe('')
  })

  it('carries no gate doctrine words even after a restart', () => {
    const text = renderRootPolicy(restarted())
    for (const word of ['plan gate', 'execution gate', 'audit', 'manifest', 'triage', 'autopilot_init', 'closeout']) {
      expect(text.toLowerCase()).not.toContain(word)
    }
  })
})

describe('renderRootPolicy: after a host restart', () => {
  it('names the lost child with its role and task, and not the one that finished', () => {
    const text = renderRootPolicy(restarted())
    expect(text).toContain('worker w-1 (port the parser)')
    expect(text).not.toContain('s-1')
  })

  it('says auto-continue was released, with the ledger\'s own reason', () => {
    expect(renderRootPolicy(restarted())).toContain('released after host restart')
  })

  it('says the owner\'s "continue" resumes the work and that new children start from the brief', () => {
    const text = renderRootPolicy(restarted())
    expect(text).toContain('"continue"')
    expect(text).toContain('start new children')
  })

  it('falls back to the marker\'s child ids when the lost records are gone from the delegation list', () => {
    const text = renderRootPolicy(restarted({ delegations: [] }))
    expect(text).toContain('Lost children: w-1')
  })

  it('still renders when the marker names no child', () => {
    const text = renderRootPolicy(restarted({ delegations: [], hostRestart: { at: NOW, lostChildIds: [] } }))
    expect(text).toContain('recorded a restart but no child ids')
  })
})
