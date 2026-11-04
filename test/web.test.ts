/**
 * The host-side read-only HTTP surface (`src/web.ts`), over a stub service.
 *
 * Claims: the three routes answer the documented status codes and bodies; the
 * ledger projection overlays the sandbox-restore outcome the ledger recorded
 * onto the session's legacy runs; error bodies are codes, never store text;
 * every mounted route sits behind the host's connection fence; and the absence
 * of a web server is the default, not a branch.
 */

import { describe, expect, it } from 'vitest'
import { LEDGER_ROUTE, LEGACY_RUN_ROUTE, LEGACY_RUNS_ROUTE } from '../src/domain/ledger-types.js'
import type { LedgerProjection, LegacyRunProjection, LegacyRunSummary } from '../src/domain/ledger-types.js'
import type { AutopilotReadOnly } from '../src/service.js'
import { emptyLedger } from '../src/store/ledger.js'
import { installAutopilotRoutes, makeAutopilotRoutes, projectLedger, queryParam } from '../src/web.js'
import type { AutopilotWebRoute, RouteResponse, WebServerScope } from '../src/web.js'

const T0 = '2026-11-04T00:00:00.000Z'

function summary(runId: string, sessionId: string | undefined, over: Partial<LegacyRunSummary> = {}): LegacyRunSummary {
  return { runId, ...(sessionId === undefined ? {} : { sessionId }), backend: 'file', fold: 'ok', eventCount: 2, sandboxRestore: { state: 'pending' }, ...over }
}

const RUN = { runId: 'r1', phase: 'completed', archived: true, sandboxRestore: { state: 'not-clamped' } } as unknown as LegacyRunProjection

/** A stub service; the web layer must work from this alone. */
function stubService(over: Partial<AutopilotReadOnly> = {}): AutopilotReadOnly {
  const ledger = { ...emptyLedger('s1', T0), revision: 3, legacyRestores: { r1: { state: 'restored' as const, mode: 'workspace-write' } } }
  const runs = [summary('r1', 's1'), summary('r2', 's2')]
  return {
    ledger: async (id) => (id === 's1' ? projectLedger(ledger, runs, ['note']) : undefined),
    ledgers: async () => [],
    legacyRuns: async () => runs,
    legacyRun: async (id) => (id === 'r1' ? RUN : undefined),
    notes: () => ['note'],
    storeKind: 'file',
    ...over,
  }
}

interface Captured { status: number; body: unknown; raw: string; headers: Record<string, string> }

/** Drive a handler and wait for its (asynchronous) response. */
function call(route: AutopilotWebRoute, url: string, method = 'GET'): Promise<Captured> {
  return new Promise((resolve) => {
    const out: Captured = { status: 0, body: undefined, raw: '', headers: {} }
    const res: RouteResponse = {
      writeHead(status, headers) { out.status = status; out.headers = headers },
      end(body) {
        out.raw = body ?? ''
        try { out.body = body === undefined ? undefined : JSON.parse(body) } catch { out.body = undefined }
        resolve(out)
      },
    }
    route.handler({ method, url }, res)
  })
}

function routeAt(service: AutopilotReadOnly, path: string): AutopilotWebRoute {
  return makeAutopilotRoutes(service).find(r => r.path === path)!
}

describe('projectLedger', () => {
  const ledger = {
    ...emptyLedger('s1', T0),
    revision: 4,
    legacyRunIds: ['r4'],
    legacyRestores: { r1: { state: 'restored' as const, mode: 'read-only', at: T0 } },
  }
  const runs = [
    summary('r1', 's1'),
    summary('r2', 's1', { sandboxRestore: { state: 'not-clamped' } }),
    summary('r3', 's2'),
    summary('r4', undefined),
  ]

  it('keeps this session’s runs (by session id or recorded id) and drops the rest', () => {
    expect(projectLedger(ledger, runs, []).legacyRuns.map(r => r.runId)).toEqual(['r1', 'r2', 'r4'])
  })

  it('overlays the ledger’s recorded restore, and leaves runs without a record as the reader summarized them', () => {
    const projected = projectLedger(ledger, runs, [])
    expect(projected.legacyRuns.find(r => r.runId === 'r1')?.sandboxRestore).toEqual({ state: 'restored', mode: 'read-only', at: T0 })
    expect(projected.legacyRuns.find(r => r.runId === 'r2')?.sandboxRestore).toEqual({ state: 'not-clamped' })
    expect(projected.legacyRuns.find(r => r.runId === 'r4')?.sandboxRestore).toEqual({ state: 'pending' })
  })

  it('carries the retired config keys as data when given, and omits the field when none', () => {
    expect(projectLedger(ledger, [], ['n'], ['governance.unattended', 'storeKind']).retiredConfigKeys).toEqual(['governance.unattended', 'storeKind'])
    expect(projectLedger(ledger, [], ['n'], [])).not.toHaveProperty('retiredConfigKeys')
    expect(projectLedger(ledger, [], ['n'])).not.toHaveProperty('retiredConfigKeys')
  })

  it('carries the ledger fields, notes and updatedAt, and omits absent optionals', () => {
    const projected = projectLedger(ledger, [], ['n1', 'n2'])
    expect(projected).toEqual({
      v: 3, sessionId: 's1', revision: 4, previousGoals: [], delegations: [], reviews: [], links: [],
      autoContinue: { available: false, code: 'not-yet-observed', reason: 'not yet observed' },
      depth: { executorLead: 2, source: 'plugin-default' },
      legacyRuns: [], notes: ['n1', 'n2'], updatedAt: T0,
    })
    expect('goal' in projected).toBe(false)
    expect('hostRestart' in projected).toBe(false)
    // The raw ledger's own bookkeeping does not ride along.
    expect('legacyRestores' in projected).toBe(false)
    expect('legacyRunIds' in projected).toBe(false)
  })

  it('does not mutate its inputs', () => {
    const before = JSON.stringify([ledger, runs])
    projectLedger(ledger, runs, ['x'])
    expect(JSON.stringify([ledger, runs])).toBe(before)
  })
})

describe('GET ledger', () => {
  it('serves the projection with the legacy overlay for a known session', async () => {
    const out = await call(routeAt(stubService(), LEDGER_ROUTE), `${LEDGER_ROUTE}?session=s1`)
    expect(out.status).toBe(200)
    expect(out.headers['content-type']).toBe('application/json; charset=utf-8')
    const ledger = (out.body as { ok: true; ledger: LedgerProjection }).ledger
    expect(ledger.sessionId).toBe('s1')
    expect(ledger.revision).toBe(3)
    expect(ledger.legacyRuns.map(r => [r.runId, r.sandboxRestore.state])).toEqual([['r1', 'restored']])
    expect(ledger.notes).toEqual(['note'])
  })

  it('answers 400 missing-session without a session parameter, 404 no-ledger for an unknown one', async () => {
    const route = routeAt(stubService(), LEDGER_ROUTE)
    expect(await call(route, LEDGER_ROUTE)).toMatchObject({ status: 400, body: { ok: false, error: 'missing-session' } })
    expect(await call(route, `${LEDGER_ROUTE}?session=`)).toMatchObject({ status: 400, body: { ok: false, error: 'missing-session' } })
    expect(await call(route, `${LEDGER_ROUTE}?session=nope`)).toMatchObject({ status: 404, body: { ok: false, error: 'no-ledger' } })
  })

  it('decodes the session id', async () => {
    let seen: string | undefined
    const route = routeAt(stubService({ ledger: async (id) => { seen = id; return undefined } }), LEDGER_ROUTE)
    await call(route, `${LEDGER_ROUTE}?session=a%2Fb%3A1`)
    expect(seen).toBe('a/b:1')
  })
})

describe('GET legacy runs', () => {
  it('lists every legacy run, not only one session’s', async () => {
    const out = await call(routeAt(stubService(), LEGACY_RUNS_ROUTE), LEGACY_RUNS_ROUTE)
    expect(out.status).toBe(200)
    expect((out.body as { runs: LegacyRunSummary[] }).runs.map(r => r.runId)).toEqual(['r1', 'r2'])
    expect((out.body as { ok: boolean }).ok).toBe(true)
  })

  it('serves an empty list when there are no legacy runs', async () => {
    const out = await call(routeAt(stubService({ legacyRuns: async () => [] }), LEGACY_RUNS_ROUTE), LEGACY_RUNS_ROUTE)
    expect(out).toMatchObject({ status: 200, body: { ok: true, runs: [] } })
  })
})

describe('GET legacy run', () => {
  it('serves one run, 400 missing-id without an id, 404 no-run for an unknown one', async () => {
    const route = routeAt(stubService(), LEGACY_RUN_ROUTE)
    expect(await call(route, `${LEGACY_RUN_ROUTE}?id=r1`)).toMatchObject({ status: 200, body: { ok: true, run: { runId: 'r1', archived: true } } })
    expect(await call(route, LEGACY_RUN_ROUTE)).toMatchObject({ status: 400, body: { ok: false, error: 'missing-id' } })
    expect(await call(route, `${LEGACY_RUN_ROUTE}?id=zzz`)).toMatchObject({ status: 404, body: { ok: false, error: 'no-run' } })
  })
})

describe('every route is read-only and never leaks store text', () => {
  const paths = [LEDGER_ROUTE, LEGACY_RUNS_ROUTE, LEGACY_RUN_ROUTE]

  it('answers 405 on any method other than GET', async () => {
    for (const path of paths) {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        expect(await call(routeAt(stubService(), path), `${path}?session=s1&id=r1`, method)).toMatchObject({
          status: 405, body: { ok: false, error: 'method-not-allowed' },
        })
      }
    }
  })

  it('answers 500 internal with a code only, when the service throws', async () => {
    const boom = (): never => { throw new Error('ENOENT /home/secret/.dsh/ledgers/x.json') }
    const service = stubService({
      ledger: async () => boom(),
      legacyRuns: async () => boom(),
      legacyRun: async () => boom(),
    })
    for (const path of paths) {
      const out = await call(routeAt(service, path), `${path}?session=s1&id=r1`)
      expect(out.status).toBe(500)
      expect(out.body).toEqual({ ok: false, error: 'internal' })
      expect(out.raw).not.toContain('secret')
    }
  })

  it('reads query parameters URL-decoded, first occurrence winning', () => {
    expect(queryParam('/x?id=a%2Fb&id=c', 'id')).toBe('a/b')
    expect(queryParam('/x', 'id')).toBeUndefined()
    expect(queryParam('/x?id=%E0%A4%A', 'id')).toBeUndefined()
  })
})

describe('mounting degrades to nothing without a web server', () => {
  const PATHS = [LEDGER_ROUTE, LEGACY_RUNS_ROUTE, LEGACY_RUN_ROUTE]

  it('is a no-op on a context with no ctx.inject at all (headless)', () => {
    const dispose = installAutopilotRoutes({}, stubService())
    expect(() => dispose()).not.toThrow()
  })

  it('never registers when the inject callback is not invoked (webServer absent)', () => {
    let injected: readonly string[] | undefined
    const host = { inject: (names: readonly string[]) => { injected = names; return () => {} } }
    const dispose = installAutopilotRoutes(host, stubService())
    expect(injected).toEqual(['webServer'])
    expect(() => dispose()).not.toThrow()
  })

  it('registers all three routes through the scoped effect, and releases them on unload', () => {
    const registered: string[] = []
    const disposed: string[] = []
    let teardown: (() => void) | undefined
    const host = {
      inject: (_names: readonly string[], callback: (scoped: WebServerScope) => void) => {
        callback({
          webServer: { register: (route) => { registered.push(route.path); return () => { disposed.push(route.path) } } },
          effect: (setup) => { teardown = setup() },
        })
        return () => {}
      },
    }
    installAutopilotRoutes(host, stubService())
    expect(registered).toEqual(PATHS)
    teardown?.()
    expect(disposed.sort()).toEqual([...PATHS].sort())
  })

  it('fences every registered route through the connection service, looked up per request', async () => {
    const registered: AutopilotWebRoute[] = []
    let rejection: number | undefined = 401
    let present = false
    const host = {
      inject: (_names: readonly string[], callback: (scoped: WebServerScope) => void) => {
        callback({
          webServer: { register: (route) => { registered.push(route); return () => {} } },
          get: (name: string) => (name === 'connection' && present ? { requestRejection: () => rejection } : undefined),
        })
        return () => {}
      },
    }
    installAutopilotRoutes(host, stubService())
    expect(registered.map(r => r.path)).toEqual(PATHS)
    for (const route of registered) {
      const url = `${route.path}?session=s1&id=r1`
      // No connection service yet: fail closed, and the service is never asked.
      expect(await call(route, url)).toMatchObject({ status: 503, raw: JSON.stringify({ ok: false, error: 'no-connection-service' }) })
    }
    present = true
    for (const route of registered) expect((await call(route, `${route.path}?session=s1&id=r1`)).status).toBe(401)
    rejection = 403
    for (const route of registered) expect((await call(route, `${route.path}?session=s1&id=r1`)).status).toBe(403)
    rejection = undefined
    for (const route of registered) expect((await call(route, `${route.path}?session=s1&id=r1`)).status).toBe(200)
  })

  it('does not reach the service when the fence rejects', async () => {
    let reads = 0
    const service = stubService({ legacyRuns: async () => { reads += 1; return [] } })
    const registered: AutopilotWebRoute[] = []
    const host = {
      inject: (_n: readonly string[], callback: (scoped: WebServerScope) => void) => {
        callback({
          webServer: { register: (route) => { registered.push(route); return () => {} } },
          get: () => ({ requestRejection: () => 403 }),
        })
        return () => {}
      },
    }
    installAutopilotRoutes(host, service)
    const runs = registered.find(r => r.path === LEGACY_RUNS_ROUTE)!
    expect((await call(runs, LEGACY_RUNS_ROUTE)).status).toBe(403)
    expect(reads).toBe(0)
  })

  it('still mounts on a scoped context that exposes no effect', () => {
    const registered: string[] = []
    const host = {
      inject: (_n: readonly string[], callback: (scoped: WebServerScope) => void) => {
        callback({ webServer: { register: (route) => { registered.push(route.path); return () => {} } } })
        return undefined
      },
    }
    installAutopilotRoutes(host, stubService())
    expect(registered).toHaveLength(3)
  })
})
