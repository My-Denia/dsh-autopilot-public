/**
 * M4 observed-route evidence + visibility (plan v3; packet E4).
 *
 * The R1-P1 fix under test: a route record may claim `verified` ONLY when the
 * three legs — selected (the routing decision's pin), creation (`Agent.options`
 * at child creation), observed (the child session's latest `request/header`) —
 * are ALL present and agree. Creation-only evidence was the defect (it read
 * `verified`); it is now honestly `unverifiable`. Divergence is `mismatch`
 * with the differing axes NAMED, never smoothed over. And route evidence is
 * provenance only: it informs the reader of a verdict, it never blocks one
 * (test iv — the plan gate still passes on a mismatching route).
 *
 * Boundary-state labels borne here for the usage gate: `card-routes-rendered`
 * (the four status states render — see test/card.test.ts) and
 * `card-empty-catalog` (every engine drive below runs with NO routing ports
 * wired at all — an empty catalog is the normal zero-config deployment).
 */

import { describe, expect, it } from 'vitest'
import { observedRouteOf, routeStatusOf } from '../src/engine.js'
import type { SessionReadRef } from '../src/engine.js'
import type { RoutingPin } from '../src/domain/types.js'
import { fakeAgent, makeHarness, makeTriage, makeUsageEntry, stubSubagents, undeclaredSeed } from './helpers.js'
import type { Harness } from './helpers.js'

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

// ── routeStatusOf: the four-state semantics, axis by axis ──────────────────

const PIN: RoutingPin = { provider: 'beta', model: 'm-c', reasoningEffort: 'high' }
const CREATION = { provider: 'beta', model: 'm-c' }

describe('routeStatusOf implements the plan v3 status semantics', () => {
  it('(i) selected, creation, and observed all agree: verified, no diagnostic', () => {
    const out = routeStatusOf('c1', { selected: PIN, creation: CREATION, observed: PIN })
    expect(out).toEqual({ routeStatus: 'verified' })
  })

  it('(ii) observed differs from creation/selected: mismatch naming the model axis', () => {
    const out = routeStatusOf('c1', {
      selected: PIN,
      creation: CREATION,
      observed: { provider: 'beta', model: 'm-other', reasoningEffort: 'high' },
    })
    expect(out.routeStatus).toBe('mismatch')
    expect(out.routeDiagnostic).toContain('model')
    expect(out.routeDiagnostic).toContain('m-c')
    expect(out.routeDiagnostic).toContain('m-other')
  })

  it('(ii) the reasoningEffort axis is named when both legs carry it and they differ', () => {
    const out = routeStatusOf('c1', {
      selected: { provider: 'beta', model: 'm-c', reasoningEffort: 'high' },
      creation: CREATION,
      observed: { provider: 'beta', model: 'm-c', reasoningEffort: 'low' },
    })
    expect(out.routeStatus).toBe('mismatch')
    expect(out.routeDiagnostic).toContain('reasoningEffort')
  })

  it('(ii) a provider-axis divergence between creation and observed is named even with no selection', () => {
    const out = routeStatusOf('c1', {
      creation: { provider: 'alpha', model: 'm-a' },
      observed: { provider: 'beta', model: 'm-a' },
    })
    expect(out.routeStatus).toBe('mismatch')
    expect(out.routeDiagnostic).toContain('provider')
  })

  it('(iii) creation-only (observed unreadable): unverifiable, NEVER verified — the R1-P1 fix', () => {
    const out = routeStatusOf('c1', {
      selected: PIN,
      creation: CREATION,
      observedUnreadable: 'no well-formed request/header event in the child session',
    })
    expect(out.routeStatus).toBe('unverifiable')
    expect(out.routeDiagnostic).toContain('no well-formed request/header')
  })

  it('(iii) selected with an unreadable CREATION leg is unverifiable too', () => {
    const out = routeStatusOf('c1', { selected: PIN, observed: PIN })
    expect(out.routeStatus).toBe('unverifiable')
    expect(out.routeDiagnostic).toContain('not available from durable Agent options')
  })

  it('inheritance with creation and observed agreeing: unverified (no selection to verify), never verified', () => {
    const out = routeStatusOf('c1', { creation: CREATION, observed: { provider: 'beta', model: 'm-c' } })
    expect(out.routeStatus).toBe('unverified')
    expect(out.routeDiagnostic).toContain('inheritance')
  })

  it('no selection and no readable creation: the 0.2.0 unverified record, observed named either way', () => {
    const none = routeStatusOf('c1', { observedUnreadable: 'child session not readable' })
    expect(none.routeStatus).toBe('unverified')
    expect(none.routeDiagnostic).toContain('not available from durable Agent options')
    const withObserved = routeStatusOf('c1', { observed: { provider: 'beta', model: 'm-c' } })
    expect(withObserved.routeStatus).toBe('unverified')
    expect(withObserved.routeDiagnostic).toContain('observed route beta/m-c recorded')
  })
})

// ── The engine writes those statuses onto real dispatches ──────────────────
//
// The executor drives carry an explicit selected route without any routing
// ports being wired (a legacy `executor.agentOptions` maps to a locked role at
// resolve), so they run the full dispatch → capture pipeline with only the
// stub subagents — the `card-empty-catalog` configuration.

const SIGNAL = new AbortController().signal

interface ChildScript {
  options?: { provider?: string; model?: string }
  header?: { provider: string; model: string; reasoningEffort?: string } | null
}

/** Start a delegated executor whose child Agent exposes exactly this script. */
async function executorRoute(script: ChildScript, harness?: Harness): Promise<Record<string, unknown> | undefined> {
  const h = harness ?? makeHarness({
    subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'plan ok' }] }),
    config: { executor: { agentOptions: { provider: 'beta', model: 'm-c' } } },
  })
  // The child Agent registers the moment the transport starts it — the same
  // moment a real host would have it resolvable by id.
  ;(h.subagents as unknown as { startContinuable: (spec: { childId: string }) => Promise<unknown> })
    .startContinuable = async (spec) => {
      const child = fakeAgent(spec.childId, h.root.id)
      h.agents.add({
        ...child,
        ...(script.options === undefined ? {} : { options: script.options }),
      } as never)
      if (script.header !== null && script.header !== undefined) {
        child.session.append('request/header', { header: { config: script.header }, reason: 'initial' })
      }
      return {}
    }
  await h.engine.init(
    h.root,
    makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' }),
    [undeclaredSeed('m1')],
  )
  await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
  await h.engine.submitPlan(h.root, 'plan')
  await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
  const started = await h.engine.startExecutor(h.root, { prompt: 'go', signal: SIGNAL })
  expect(started.executor?.state).toBe('running')
  return started.executor?.route as Record<string, unknown> | undefined
}

describe('the engine records the observed route on dispatched children', () => {
  it('(i) agreement of selected, creation, and observed: the running executor record is verified', async () => {
    const route = await executorRoute({
      options: { provider: 'beta', model: 'm-c' },
      header: { provider: 'beta', model: 'm-c' },
    })
    expect(route?.routeStatus).toBe('verified')
    expect(route?.selected).toEqual({ provider: 'beta', model: 'm-c' })
    expect(route?.observed).toEqual({ provider: 'beta', model: 'm-c' })
    expect(route?.routeDiagnostic).toBeUndefined()
  })

  it('(ii) observed differs from creation: mismatch, the diagnostic names the axis', async () => {
    const route = await executorRoute({
      options: { provider: 'beta', model: 'm-c' },
      header: { provider: 'beta', model: 'm-imposter' },
    })
    expect(route?.routeStatus).toBe('mismatch')
    expect(route?.observed).toEqual({ provider: 'beta', model: 'm-imposter' })
    expect(String(route?.routeDiagnostic)).toContain('model')
    expect(String(route?.routeDiagnostic)).toContain('m-imposter')
  })

  it('(iii) no request/header in the child session: unverifiable with the failed read named', async () => {
    const route = await executorRoute({
      options: { provider: 'beta', model: 'm-c' },
      header: null,
    })
    expect(route?.routeStatus).toBe('unverifiable')
    expect(String(route?.routeDiagnostic)).toContain('no well-formed request/header')
  })

  it('(iv) route status never blocks a verdict: a mismatching auditor still passes the plan gate', async () => {
    const subagents = stubSubagents({
      verdicts: [{ verdict: 'pass', note: 'sound plan', requestHeader: { provider: 'stub-llm', model: 'm-imposter' } }],
    })
    const h = makeHarness({ subagents })
    await h.engine.init(
      h.root,
      makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent' }),
      [undeclaredSeed('m1')],
    )
    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    await h.engine.submitPlan(h.root, 'plan')
    const outcome = await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    expect(outcome.verdict).toBe('pass')
    expect(h.engine.peek(h.root.id)?.planGate).toBe('pass')
    expect(h.engine.peek(h.root.id)?.phase).toBe('executing')
    const route = h.engine.peek(h.root.id)?.audits[0]?.route as Record<string, unknown> | undefined
    expect(route?.routeStatus).toBe('mismatch')
    expect(String(route?.routeDiagnostic)).toContain('model')
  })
})
