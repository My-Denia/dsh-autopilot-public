/**
 * Observed-route evidence: what a dispatched child's latest `request/header`
 * shows. `request/header` is a durable session event; the LATEST well-formed one
 * reconstructs the request the child actually sent, which is the only proof of
 * the route (`Agent.options` prove creation only). The read is defensive by
 * contract: an unreadable session, a throwing `snapshotEvents` or a header with
 * no well-formed config degrades to `{unreadable}` naming which read failed and
 * never throws, because route evidence must not be able to break a dispatch.
 */

import { describe, expect, it } from 'vitest'
import { observedRouteOf } from '../src/engine.js'
import type { SessionReadRef } from '../src/engine.js'

// ── observedRouteOf: the observed leg's read, including its failures ────────

function sessionOf(events: Array<{ type: string; data: unknown }>): SessionReadRef {
  return { header: {}, snapshotEvents: () => events.slice() }
}

function headerEvent(config: Record<string, unknown>): { type: string; data: unknown } {
  return { type: 'request/header', data: { header: { config }, reason: 'initial' } }
}

describe('observedRouteOf reads the latest request/header', () => {
  it('extracts provider/model/reasoningEffort from the latest snapshot', () => {
    const read = observedRouteOf(sessionOf([
      headerEvent({ provider: 'p1', model: 'm1' }),
      { type: 'assistant/message', data: {} },
      headerEvent({ provider: 'p2', model: 'm2', reasoningEffort: 'high' }),
    ]))
    expect(read.observed).toEqual({ provider: 'p2', model: 'm2', reasoningEffort: 'high' })
  })

  it('skips malformed snapshots and keeps the last well-formed one', () => {
    const read = observedRouteOf(sessionOf([
      headerEvent({ provider: 'p1', model: 'm1' }),
      { type: 'request/header', data: { header: {} } },
      { type: 'request/header', data: { header: { config: { provider: 'p2' } } } },
    ]))
    expect(read.observed).toEqual({ provider: 'p1', model: 'm1' })
  })

  it('an absent session, an empty log, and a throwing read each name their failure', () => {
    expect(observedRouteOf(undefined).unreadable).toContain('child session not readable')
    expect(observedRouteOf(sessionOf([])).unreadable).toContain('no well-formed request/header')
    const throwing: SessionReadRef = {
      header: {},
      snapshotEvents: () => { throw new Error('boom') },
    }
    expect(observedRouteOf(throwing).unreadable).toContain('child session read failed')
  })
})
