/**
 * Routing status (`src/routing/status.ts`) — the READER's answer to "is routing
 * live here, and which route does each role stand on".
 *
 * THE DEFECT THIS FILE EXISTS FOR. Every routing fact the plugin produced lived
 * on a DECISION (a dispatch's `detail.routing`), and the only routing field on
 * the status view was `routingReachability` — a COVERAGE question that says
 * nothing at all on a healthy ladder. A deployment could have a fully
 * configured ladder, a covered catalog, and every dispatch still inheriting the
 * deployment default, because auto mode performs inheritance only when the
 * session carries no model-selection policy (DESIGN §1.2 boundary (e)). Before
 * this projection, no surface said so.
 *
 * The cases below separate the three things a reader must be able to tell
 * apart: routing is LIVE (policy present), routing is configured but
 * INHERIT-ONLY (policy absent/unreachable), and routing could not be READ at
 * all (`unobserved` — the service path, where there is no session to ask). The
 * last one is the one that must never collapse into `absent`: an absence of
 * observation is not a finding about the policy.
 */

import { describe, expect, it } from 'vitest'

import { resolveConfig } from '../src/index.js'
import { routingStatusOf, ROUTING_STATUS_ROLES } from '../src/routing/status.js'
import type { SessionPolicyState } from '../src/routing/authorize.js'
import { makeSnapshot } from './helpers.js'

/** Resolve a routing section exactly as the plugin does, then project it. */
function status(
  routing: Parameters<typeof resolveConfig>[0],
  snapshot = makeSnapshot(),
  policy?: SessionPolicyState,
) {
  const resolved = resolveConfig(routing).routing
  return routingStatusOf(snapshot, resolved, policy)
}

const LADDER = {
  tiers: { economy: ['alpha/m-a'], standard: ['beta/m-c'], reserve: [] },
}

describe('routingStatusOf — the three states a reader must be able to tell apart', () => {
  it('auto + a policy ⇒ `live`, with the effective preference, its source, and every role resolved', () => {
    const view = status(
      { routing: { mode: 'auto', ladder: LADDER } },
      makeSnapshot(),
      { kind: 'present', routes: [{ provider: 'alpha', model: 'm-a' }, { provider: 'beta', model: 'm-c' }] },
    )
    expect(view).toBeDefined()
    expect(view?.mode).toBe('auto')
    expect(view?.dispatch).toBe('live')
    expect(view?.policyState).toBe('present')
    expect(view?.policyRouteCount).toBe(2)
    expect(view?.preference).toBe('balanced')
    expect(view?.preferenceSource).toBe('default')
    expect(view?.ladderTiers).toEqual({ economy: 1, standard: 1, reserve: 0 })
    expect(view?.auditTier).toBe('none')
    // Every routed role is accounted for, in the core's vocabulary order.
    expect(view?.roles.map(entry => entry.role)).toEqual([...ROUTING_STATUS_ROLES])
    const executor = view?.roles.find(entry => entry.role === 'executor')
    expect(executor?.effective).toBe('auto')
    // The owner table's default class, with the ladder engaged by configuration.
    expect(executor?.workClass).toEqual({
      name: 'simple', axis: 'speed-cost', tiers: ['economy'], engaged: true,
    })
    const auditors = view?.roles.filter(entry => entry.role.endsWith('-auditor'))
    expect(auditors?.every(entry => entry.workClass?.name === 'audit')).toBe(true)
  })

  it('auto + NO policy ⇒ `inherit-only`: the ladder is configured and still selects nothing', () => {
    const view = status({ routing: { mode: 'auto', ladder: LADDER } }, makeSnapshot(), { kind: 'absent' })
    expect(view?.dispatch).toBe('inherit-only')
    expect(view?.policyState).toBe('absent')
    // The routes are unknown here, not zero: an absent policy has no route list.
    expect(view?.policyRouteCount).toBeUndefined()
  })

  it('auto + an UNREADABLE policy ⇒ `inherit-only`, recorded as unreachable (never as absent)', () => {
    const view = status({ routing: { mode: 'auto' } }, makeSnapshot(), { kind: 'unreachable' })
    expect(view?.dispatch).toBe('inherit-only')
    expect(view?.policyState).toBe('unreachable')
  })

  it('no session to ask (the service/HTTP path) ⇒ `unobserved`, never `absent`', () => {
    const view = status({ routing: { mode: 'auto' } }, makeSnapshot())
    expect(view?.policyState).toBe('unobserved')
    expect(view?.dispatch).toBe('unobserved')
    expect(view?.policyRouteCount).toBeUndefined()
  })

  it('routing.mode off ⇒ NOTHING is projected: an absent field, not a block of `inherit` rows', () => {
    expect(status({ routing: { mode: 'off' } }, makeSnapshot(), { kind: 'present', routes: [] })).toBeUndefined()
    // ...and auto is the shipped default, so the same call without `mode` projects.
    expect(status({}, makeSnapshot(), { kind: 'absent' })).toBeDefined()
  })
})

describe('routingStatusOf — the facts it may report about roles, classes and pins', () => {
  it('reports each role\'s pinned route, and nothing for roles the run never pinned', () => {
    const snapshot = makeSnapshot({
      routingPins: {
        executor: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
        'execution-auditor': { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      },
    })
    const view = status({ routing: { mode: 'auto' } }, snapshot, { kind: 'present', routes: [] })
    expect(view?.pins).toEqual([
      { role: 'executor', provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
      { role: 'execution-auditor', provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    ])
  })

  it('an EMPTY ladder leaves the class mapping recorded but NOT engaged (0.2.0 parity)', () => {
    const view = status({ routing: { mode: 'auto' } }, makeSnapshot(), { kind: 'present', routes: [] })
    const executor = view?.roles.find(entry => entry.role === 'executor')
    expect(executor?.workClass?.engaged).toBe(false)
    expect(view?.ladderTiers).toEqual({ economy: 0, standard: 0, reserve: 0 })
  })

  it('an owner override of the class, or of the role\'s class, ENGAGES the machinery', () => {
    const byClass = status(
      { routing: { mode: 'auto', workClasses: { simple: { tiers: ['economy', 'standard'] } } } },
      makeSnapshot(),
      { kind: 'present', routes: [] },
    )
    expect(byClass?.roles.find(entry => entry.role === 'executor')?.workClass?.engaged).toBe(true)
    expect(byClass?.roles.find(entry => entry.role === 'executor')?.workClass?.tiers).toEqual(['economy', 'standard'])

    const byRole = status(
      { routing: { mode: 'auto', roles: { executor: { workClass: 'hard' } } } },
      makeSnapshot(),
      { kind: 'present', routes: [] },
    )
    const executor = byRole?.roles.find(entry => entry.role === 'executor')
    expect(executor?.workClass?.name).toBe('hard')
    expect(executor?.workClass?.engaged).toBe(true)
    // The owner table's `hard` mapping is the first-try pool, unchanged.
    expect(executor?.workClass?.tiers).toEqual(['economy'])
    expect(executor?.workClass?.axis).toBe('economy-first')
  })

  it('locked and inherit roles report their own mode, and a lock reports the route', () => {
    const view = status(
      {
        routing: {
          mode: 'auto',
          roles: {
            executor: { mode: 'locked', lock: { provider: 'alpha', model: 'm-a', reasoningEffort: 'high' } },
            planner: { mode: 'auto' },
          },
        },
      },
      makeSnapshot(),
      { kind: 'present', routes: [] },
    )
    const executor = view?.roles.find(entry => entry.role === 'executor')
    expect(executor?.effective).toBe('locked')
    expect(executor?.lock).toEqual({ provider: 'alpha', model: 'm-a', reasoningEffort: 'high' })
    // A locked role makes no selection, so it consults no work class.
    expect(executor?.workClass).toBeUndefined()
    expect(view?.roles.find(entry => entry.role === 'planner')?.effective).toBe('auto')
  })

  it('reports the whole resolved work-class table, not only the engaged classes', () => {
    const view = status({ routing: { mode: 'auto' } }, makeSnapshot(), { kind: 'present', routes: [] })
    expect(view?.workClasses.map(entry => entry.name)).toEqual(
      ['mechanical', 'simple', 'hard', 'audit', 'extreme'],
    )
    expect(view?.workClasses.find(entry => entry.name === 'audit')?.tiers).toEqual(['standard'])
  })
})
