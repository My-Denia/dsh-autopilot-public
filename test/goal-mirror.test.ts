/**
 * The native-goal mirror, auto-continue, the status link, and the card anchors:
 * a session with a goal gets a ledger without a single dispatch, the ledger route
 * answers a session without one with a plain no-ledger body, and a session id
 * resolves to its legacy run.
 */

import { describe, expect, it } from 'vitest'
import { goalDriverPresentIn, readNativeGoal, registeredToolNamesOf, subagentMaxDepthOf } from '../src/index.js'
import type { NativeGoalView } from '../src/engine.js'
import { autoContinueFor } from '../src/delegate.js'
import { createAutopilotService } from '../src/service.js'
import { installRootTools, statusBody } from '../src/tools.js'
import { makeAutopilotRoutes } from '../src/web.js'
import type { RouteResponse } from '../src/web.js'
import { LEDGER_ROUTE, LEGACY_RUN_ROUTE } from '../src/domain/ledger-types.js'
import { emptyLedger } from '../src/store/ledger.js'
import { delegationHost, makeHarness } from './helpers.js'

const goal = (over: Partial<NativeGoalView> = {}): NativeGoalView => ({
  id: 'g-1', revision: 1, objective: 'ship 0.3.0', phase: 'active', maxGoalRounds: 40, roundsStarted: 0, activation: 'disarmed', ...over,
})

describe('goal mirror', () => {
  it('a session with a native goal gets a ledger on open, with every mirrored field, and no dispatch', async () => {
    const view: NativeGoalView = goal({ activation: 'armed', roundsStarted: 3 })
    const h = delegationHost({ goal: () => view, driver: () => true })
    await h.engine.onRootOpened(h.root)
    const ledger = h.engine.peekLedger('root-1')!
    expect(ledger.delegations).toEqual([])
    expect(ledger.goal).toMatchObject({ goalId: 'g-1', revision: 1, status: 'active', objective: 'ship 0.3.0', activation: 'armed', roundsStarted: 3, maxGoalRounds: 40 })
    expect(ledger.autoContinue).toEqual({ available: true, code: 'driver-present', reason: 'goal round driver present' })
  })

  it('no goal and no ledger: nothing is written', async () => {
    const h = delegationHost({ goal: () => undefined, driver: () => true })
    await h.engine.onRootOpened(h.root)
    expect(h.ledgers.load('root-1')).toBeUndefined()
  })

  it('an unchanged goal is not rewritten; a change is; blockedReason is carried', async () => {
    let view = goal()
    const h = delegationHost({ goal: () => view, driver: () => true })
    await h.engine.syncGoal(h.root)
    const revision = h.engine.peekLedger('root-1')!.revision
    await h.engine.syncGoal(h.root)
    expect(h.engine.peekLedger('root-1')!.revision).toBe(revision)
    view = goal({ revision: 2, phase: 'blocked', blockedReason: { code: 'round-limit', message: 'cap of 40 reached' }, roundsStarted: 40 })
    await h.engine.syncGoal(h.root)
    expect(h.engine.peekLedger('root-1')!.goal).toMatchObject({ revision: 2, status: 'blocked', blockedReason: { code: 'round-limit', message: 'cap of 40 reached' }, roundsStarted: 40 })
  })

  it('A to B in one session: the earlier goal moves to previousGoals once, the new one is current', async () => {
    let view = goal()
    const h = delegationHost({ goal: () => view, driver: () => true })
    await h.engine.syncGoal(h.root)
    view = goal({ id: 'g-2', objective: 'second goal' })
    await h.engine.syncGoal(h.root)
    await h.engine.syncGoal(h.root)
    const ledger = h.engine.peekLedger('root-1')!
    expect(ledger.goal?.goalId).toBe('g-2')
    expect(ledger.previousGoals.map(g => g.goalId)).toEqual(['g-1'])
    expect(ledger.goal?.firstSeenAt).not.toBe(ledger.previousGoals[0]?.firstSeenAt)
  })

  it('a goal read that throws is contained: nothing written, a warning, no rejection', async () => {
    const h = delegationHost({ goal: () => { throw new Error('agent is not live') }, driver: () => true })
    await expect(h.engine.syncGoal(h.root)).resolves.toBeUndefined()
    expect(h.ledgers.load('root-1')).toBeUndefined()
  })

  it('dispatching mirrors the goal too', async () => {
    const h = delegationHost({ goal: () => goal(), driver: () => false })
    await h.engine.delegate(h.root, { role: 'scout', task: 't' })
    expect(h.engine.peekLedger('root-1')!.goal?.goalId).toBe('g-1')
    expect(h.engine.peekLedger('root-1')!.autoContinue.code).toBe('no-driver-in-composition')
  })
})

describe('autoContinueFor', () => {
  const ledger = emptyLedger('s', '2026-11-04T00:00:00.000Z')
  const asGoal = (activation: 'armed' | 'disarmed') => ({ goalId: 'g', activation, firstSeenAt: 'x', lastSeenAt: 'x' })

  it('driver present / absent / uninspectable map to their codes, and unknown is NOT available', () => {
    expect(autoContinueFor(ledger, undefined, true)).toMatchObject({ available: true, code: 'driver-present' })
    expect(autoContinueFor(ledger, undefined, false)).toMatchObject({ available: false, code: 'no-driver-in-composition' })
    expect(autoContinueFor(ledger, undefined, undefined)).toMatchObject({ available: false, code: 'unknown' })
  })

  it('after a restart, released-after-restart wins until the goal shows armed again', () => {
    const restarted = { ...ledger, hostRestart: { at: 'x', lostChildIds: ['c'] } }
    expect(autoContinueFor(restarted, asGoal('disarmed'), true)).toMatchObject({ available: false, code: 'released-after-restart' })
    expect(autoContinueFor(restarted, undefined, true)).toMatchObject({ code: 'released-after-restart' })
    expect(autoContinueFor(restarted, asGoal('armed'), true)).toMatchObject({ available: true, code: 'driver-present' })
  })

  it('end to end: a restart marks released, re-arming the goal restores availability', async () => {
    let view = goal({ activation: 'disarmed' })
    const h = delegationHost({ goal: () => view, driver: () => true })
    await h.engine.mutate('root-1', l => ({ ...l, delegations: [{
      childId: 'w', role: 'worker', parentId: 'root-1', depth: 1, generation: 1, title: 't', state: 'running', modelSource: 'inherit',
      effortSource: 'host-default', routeMatch: 'pending', tools: 'inherit', maxDepth: 1, startedAt: 'x',
    }] }))
    await h.engine.onRootOpened(h.root)
    expect(h.engine.peekLedger('root-1')!.autoContinue.code).toBe('released-after-restart')
    view = goal({ activation: 'armed' })
    await h.engine.syncGoal(h.root)
    expect(h.engine.peekLedger('root-1')!.autoContinue).toMatchObject({ available: true, code: 'driver-present' })
  })
})

describe('probes of the host composition', () => {
  const entry = (name: string, extra: Record<string, unknown> = {}) => ({ options: { name, ...extra }, fiber: { state: 2 } })

  it('goalDriverPresentIn: found, absent, disabled, not loaded, and uninspectable', () => {
    const ctx = (entries: unknown[] | undefined) => ({ loader: entries === undefined ? {} : { tree: { entries: () => entries } } })
    expect(goalDriverPresentIn(ctx([entry('@deepseek-ai/dsh-goal'), entry('@deepseek-ai/dsh-goal-round-driver')]))).toBe(true)
    expect(goalDriverPresentIn(ctx([entry('@deepseek-ai/dsh-goal')]))).toBe(false)
    expect(goalDriverPresentIn(ctx([entry('@deepseek-ai/dsh-goal-round-driver', { disabled: true })]))).toBe(false)
    expect(goalDriverPresentIn(ctx([{ options: { name: '@deepseek-ai/dsh-goal-round-driver' }, fiber: { state: 4 } }]))).toBe(false)
    expect(goalDriverPresentIn(ctx(undefined))).toBeUndefined()
    expect(goalDriverPresentIn({})).toBeUndefined()
    expect(goalDriverPresentIn(new Proxy({}, { get: () => { throw new Error('boom') } }))).toBeUndefined()
  })

  it('readNativeGoal normalizes the host view and reads nothing when there is no goal service', () => {
    const goals = { get: () => ({ id: 'g', revision: 2, objective: 'o', phase: 'active', maxGoalRounds: 5, roundsStarted: 1, activation: 'armed', createdAt: 1 }) }
    expect(readNativeGoal({ goals }, {})).toEqual({ id: 'g', revision: 2, objective: 'o', phase: 'active', maxGoalRounds: 5, roundsStarted: 1, activation: 'armed' })
    expect(readNativeGoal({}, {})).toBeUndefined()
    expect(readNativeGoal({ goals: { get: () => undefined } }, {})).toBeUndefined()
    expect(() => readNativeGoal({ goals: { get: () => { throw new Error('not live') } } }, {})).toThrow('not live')
  })

  it('subagentMaxDepthOf reads the volatile reference, a plain number, and nothing else', () => {
    expect(subagentMaxDepthOf({ subagents: { config: { maxDepth: { get: () => 3 } } } })).toBe(3)
    expect(subagentMaxDepthOf({ subagents: { config: { maxDepth: 2 } } })).toBe(2)
    expect(subagentMaxDepthOf({ subagents: {} })).toBeUndefined()
  })

  it('registeredToolNamesOf lists the registry, and reads an empty or missing one as unknown', () => {
    expect(registeredToolNamesOf({ tools: { schemas: () => [{ name: 'read' }, { name: 'bash' }] } })).toEqual(['read', 'bash'])
    expect(registeredToolNamesOf({ tools: { schemas: () => [] } })).toBeUndefined()
    expect(registeredToolNamesOf({})).toBeUndefined()
  })
})

describe('autopilot_status link', () => {
  function install() {
    const defs = new Map<string, { execute(args: unknown, exec: unknown): Promise<unknown> }>()
    const h = makeHarness()
    const service = createAutopilotService({ ledgers: h.ledgers, sources: h.sources })
    installRootTools({ register: (d: unknown) => { defs.set((d as { name: string }).name, d as never); return () => {} } }, service, h.engine)
    return { h, status: defs.get('autopilot_status')! }
  }

  it('appends a link, is idempotent on (kind, ref), fills a missing url, and keeps distinct kinds apart', async () => {
    const { h, status } = install()
    const call = (link: unknown) => status.execute({ link }, { agent: h.root }) as Promise<{ ledger: { links: Array<{ kind: string; ref: string; url?: string }> } }>
    await call({ kind: 'pr', ref: '#12' })
    await call({ kind: 'pr', ref: '#12' })
    await call({ kind: 'issue', ref: '#12' })
    const filled = await call({ kind: 'pr', ref: '#12', url: 'https://example.test/pull/12' })
    expect(filled.ledger.links.map(l => [l.kind, l.ref, l.url])).toEqual([['pr', '#12', 'https://example.test/pull/12'], ['issue', '#12', undefined]])
    const revision = h.engine.peekLedger('root-1')!.revision
    await call({ kind: 'pr', ref: '#12', url: 'https://other.test' })
    expect(h.engine.peekLedger('root-1')!.revision).toBe(revision)
  })

  it('no link, no write: a plain status call on a session without a ledger leaves none', async () => {
    const { h, status } = install()
    const body = await status.execute({}, { agent: h.root }) as { ledger: unknown }
    expect(body.ledger).toBeNull()
    expect(h.ledgers.load('root-1')).toBeUndefined()
  })

  it('a blank ref is ignored rather than refused, and a kind outside issue|pr is rejected by the host schema before the tool runs', async () => {
    const { h, status } = install()
    await expect(status.execute({ link: { kind: 'pr', ref: '   ' } }, { agent: h.root })).resolves.toBeDefined()
    expect(h.ledgers.load('root-1')).toBeUndefined()
    await expect(status.execute({ link: { kind: 'wiki', ref: 'x' } }, { agent: h.root })).rejects.toMatchObject({ code: 'INVALID_ARGS' })
  })

  it('statusBody still answers for a session with only a goal ledger', async () => {
    const h = delegationHost({ goal: () => goal(), driver: () => true })
    await h.engine.syncGoal(h.root)
    const service = createAutopilotService({ ledgers: h.ledgers, sources: {} })
    const body = await statusBody(service, 'root-1') as { ledger: { goal: { goalId: string } } }
    expect(body.ledger.goal.goalId).toBe('g-1')
  })
})

describe('what the card can anchor on', () => {
  function call(url: string, service: ReturnType<typeof createAutopilotService>): Promise<{ status: number; body: unknown }> {
    const path = url.split('?')[0]!
    const route = makeAutopilotRoutes(service).find(r => r.path === path)!
    return new Promise((resolve) => {
      const out = { status: 0, body: undefined as unknown }
      const res: RouteResponse = {
        writeHead(status) { out.status = status },
        end(body) { out.body = body === undefined ? undefined : JSON.parse(body); resolve(out) },
      }
      route.handler({ method: 'GET', url }, res)
    })
  }

  it('the ledger route answers a session with no ledger as a non-throwing {ok:false, error:no-ledger}', async () => {
    const h = makeHarness()
    const service = createAutopilotService({ ledgers: h.ledgers, sources: h.sources })
    expect(await call(`${LEDGER_ROUTE}?session=nobody`, service)).toEqual({ status: 404, body: { ok: false, error: 'no-ledger' } })
    expect(await call(LEDGER_ROUTE, service)).toEqual({ status: 400, body: { ok: false, error: 'missing-session' } })
  })

  it('a session that only has a goal is served by the ledger route, keyed by its session id', async () => {
    const h = delegationHost({ goal: () => goal({ activation: 'armed' }), driver: () => true })
    await h.engine.onRootOpened(h.root)
    const service = createAutopilotService({ ledgers: h.ledgers, sources: {} })
    const out = await call(`${LEDGER_ROUTE}?session=root-1`, service)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, ledger: { sessionId: 'root-1', goal: { goalId: 'g-1', activation: 'armed' }, delegations: [] } })
  })

  it('the legacy run route serves a pre-upgrade SESSION id as its legacy run; an unknown id is still no-run', async () => {
    const h = makeHarness({ legacyFixtures: ['amend-plan.jsonl', 'external-audit.jsonl'] })
    const service = createAutopilotService({ ledgers: h.ledgers, sources: h.sources })
    // syn-amend-plan belongs to session syn-session-a, which has no run of that name (its first run is not on disk here).
    const bySession = await call(`${LEGACY_RUN_ROUTE}?id=syn-session-a`, service)
    expect(bySession.status).toBe(200)
    expect(bySession.body).toMatchObject({ ok: true, run: { runId: 'syn-amend-plan', archived: true } })
    // An exact run id still wins over the session lookup.
    const exact = await call(`${LEGACY_RUN_ROUTE}?id=syn-external-audit`, service)
    expect(exact.body).toMatchObject({ ok: true, run: { runId: 'syn-external-audit' } })
    expect(await call(`${LEGACY_RUN_ROUTE}?id=ghost`, service)).toEqual({ status: 404, body: { ok: false, error: 'no-run' } })
  })
})
