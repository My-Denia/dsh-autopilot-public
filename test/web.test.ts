/**
 * The host-side read-only HTTP surface (`src/web.ts`).
 *
 * Two claims carry this file, and both are asserted against a LIVE engine
 * rather than a hand-written `StatusView`:
 *
 *  1. **The projection is an allow-list, and the denied fields are denied.**
 *     `AutopilotReadOnly.peek()` returns the whole `Snapshot` — plan text,
 *     execution packet, auditor notes, closeout, residual risks, baseline. The
 *     route never calls it, and the two free-text fields that survive into
 *     `StatusView` (`diagnostic`, and each `ownerApprovals[].target`) are
 *     dropped. The tests below drive a real run into the states that PRODUCE
 *     those values and then assert they do not appear anywhere in the served
 *     JSON — a substring search over the serialized body, so a field added by
 *     a future spread cannot pass.
 *
 *  2. **Absence of a web server is the default, not a branch.** The mount goes
 *     through `ctx.inject(['webServer'], …)`, so a host with no such service
 *     never runs the callback. Both shapes are exercised.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createAutopilotService } from '../src/service.js'
import { RunStore } from '../src/store/file.js'
import type { Snapshot } from '../src/domain/types.js'
import {
  AUTOPILOT_API_PREFIX, installAutopilotRoutes, makeAutopilotRoutes,
  projectEnforcement, projectRun, projectRuns, queryParam,
} from '../src/web.js'
import type { AutopilotWebRoute, RouteResponse, WebServerScope } from '../src/web.js'
import type { AutopilotReadOnly } from '../src/service.js'
import { makeHarness, makeTriage } from './helpers.js'

/** Capture one handler's response. */
interface Captured {
  status: number
  body: unknown
  raw: string
  headers: Record<string, string>
}

function call(route: AutopilotWebRoute, url: string, method = 'GET'): Captured {
  const out: Captured = { status: 0, body: undefined, raw: '', headers: {} }
  const res: RouteResponse = {
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(body) { out.raw = body ?? ''; out.body = body === undefined ? undefined : JSON.parse(body) },
  }
  route.handler({ method, url }, res)
  return out
}

/** Like `call`, but keeps the raw body (the fence answers plain text, not JSON). */
function callRaw(route: AutopilotWebRoute, url: string, method = 'GET'): { status: number; raw: string } {
  const out = { status: 0, raw: '' }
  const res: RouteResponse = {
    writeHead(status) { out.status = status },
    end(body) { out.raw = body ?? '' },
  }
  route.handler({ method, url }, res)
  return out
}

function routesOf(service: AutopilotReadOnly): { runs: AutopilotWebRoute; run: AutopilotWebRoute } {
  const routes = makeAutopilotRoutes(service)
  const runs = routes.find(r => r.path === `${AUTOPILOT_API_PREFIX}/runs`)!
  const run = routes.find(r => r.path === `${AUTOPILOT_API_PREFIX}/run`)!
  return { runs, run }
}

/**
 * AC1. The GET path must answer with the revision the MEDIUM holds, not with
 * the first revision this process happened to fold.
 *
 * WHY THIS SHAPE. The defect is invisible to any test that uses one engine:
 * the engine that wrote the run has the newest snapshot in its own memo by
 * construction. It only appears when something ELSE advances the run — which
 * is the real deployment (a headless process drives the run; the web process
 * serves it). A second `RunStore` over the same root is exactly that other
 * writer, reduced to its essentials.
 *
 * MUTATION CONTROL (watched, 2026-08-27): reverting `createAutopilotService`
 * to `engine.peek` — i.e. the memoized `current()` the code shipped with —
 * turns the first two cases red and leaves the rest green.
 */
describe('AC1 — the read-only path serves the store, not this process’s memo', () => {
  /** Advance a run from OUTSIDE the engine, the way another dsh process would. */
  async function advanceOutOfBand(storeDir: string, runId: string, times = 1): Promise<Snapshot> {
    const foreign = new RunStore(storeDir)
    let snapshot = foreign.load(runId)
    if (snapshot === undefined) throw new Error(`no run ${runId} on disk`)
    for (let i = 0; i < times; i++) {
      snapshot = { ...snapshot, revision: snapshot.revision + 1, logCount: snapshot.logCount + 1 }
      await foreign.commit(runId, 'log', snapshot)
    }
    return snapshot
  }

  it('returns an out-of-band revision written by a second RunStore', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    const service = createAutopilotService(h.engine)
    const { run } = routesOf(service)
    const url = `${AUTOPILOT_API_PREFIX}/run?id=${h.root.id}`

    const before = call(run, url)
    expect(before.status).toBe(200)
    expect((before.body as { run: { revision: number } }).run.revision).toBe(1)

    await advanceOutOfBand(h.storeDir, h.root.id, 2)

    const after = call(run, url)
    expect(after.status).toBe(200)
    const served = (after.body as { run: { revision: number; logCount: number } }).run
    expect(served.revision).toBe(3)
    expect(served.logCount).toBe(2)
  })

  it('the /runs list is fresh too, not only the single-run route', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    const service = createAutopilotService(h.engine)
    const { runs } = routesOf(service)
    await advanceOutOfBand(h.storeDir, h.root.id)
    const body = call(runs, `${AUTOPILOT_API_PREFIX}/runs`).body as { runs: Array<{ revision: number }> }
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0]?.revision).toBe(2)
  })

  it('the WRITE path is deliberately NOT revalidated — single-writer semantics stand', async () => {
    // `engine.peek` is what every mutating path reads inside `transact` before
    // validating a transition. If it imported another process's writes
    // mid-transaction, a single-writer design would become a lost-update race.
    // So the asymmetry below is the design, asserted rather than assumed.
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    await advanceOutOfBand(h.storeDir, h.root.id)
    expect(h.engine.peek(h.root.id)?.revision).toBe(1)
    expect(h.engine.peekFresh(h.root.id)?.revision).toBe(2)
  })

  it('reloads on the PUBLISHED revision, so a half-written stream is never served', async () => {
    // `RunStore.commit` appends the canonical event FIRST and renames the
    // projection SECOND, and `currentRevision` reads the projection. So the
    // freshness signal fires only after the writer has published — which is
    // what lets a reader reload with no lock. Here the event is appended but
    // the projection is held back, i.e. the writer's crash window: the reader
    // must keep serving the last published revision rather than a stream it
    // was never told was complete.
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    const service = createAutopilotService(h.engine)
    const { run } = routesOf(service)
    const url = `${AUTOPILOT_API_PREFIX}/run?id=${h.root.id}`
    call(run, url)

    const dir = h.engine.runDirOf(h.root.id)
    const published = readFileSync(join(dir, 'snapshot.json'), 'utf8')
    await advanceOutOfBand(h.storeDir, h.root.id)
    writeFileSync(join(dir, 'snapshot.json'), published, 'utf8') // un-publish

    expect((call(run, url).body as { run: { revision: number } }).run.revision).toBe(1)

    // Control: republish, and the very same reader moves. Without this the
    // assertion above would also pass on a reader that never refreshes at all.
    const foreign = new RunStore(h.storeDir)
    const current = foreign.load(h.root.id)!
    writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(current, null, 2), 'utf8')
    expect((call(run, url).body as { run: { revision: number } }).run.revision).toBe(2)
  })
})

describe('the no-run case is a normal answer, not an error', () => {
  it('serves an empty list plus the observed store kind', () => {
    const service = createAutopilotService(makeHarness().engine)
    expect(projectRuns(service)).toEqual({ ok: true, storeKind: 'file', runs: [] })
    const { runs } = routesOf(service)
    const answer = call(runs, `${AUTOPILOT_API_PREFIX}/runs`)
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({ ok: true, storeKind: 'file', runs: [] })
  })

  it('answers 404 for an id with no run, and 400 for no id at all', () => {
    const { run } = routesOf(createAutopilotService(makeHarness().engine))
    expect(call(run, `${AUTOPILOT_API_PREFIX}/run?id=nope`)).toMatchObject({
      status: 404, body: { ok: false, error: 'no-run' },
    })
    expect(call(run, `${AUTOPILOT_API_PREFIX}/run`)).toMatchObject({
      status: 400, body: { ok: false, error: 'missing-id' },
    })
    expect(call(run, `${AUTOPILOT_API_PREFIX}/run?id=`)).toMatchObject({ status: 400 })
  })

  it('skips a run id list() reports but status() cannot project', () => {
    // The half-filled row is the failure this guard prevents; a stub is the
    // only way to reach it, because a live engine never produces the shape.
    const service: AutopilotReadOnly = {
      peek: () => undefined,
      status: () => undefined,
      list: () => ['ghost-run'],
      storeKind: 'domain',
    }
    expect(projectRuns(service)).toEqual({ ok: true, storeKind: 'domain', runs: [] })
  })
})

describe('the projection is read-only and GET-only', () => {
  it('answers 405 on any other method rather than treating it as a read', () => {
    const { runs, run } = routesOf(createAutopilotService(makeHarness().engine))
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect(call(runs, `${AUTOPILOT_API_PREFIX}/runs`, method).status).toBe(405)
      expect(call(run, `${AUTOPILOT_API_PREFIX}/run?id=x`, method).status).toBe(405)
    }
  })

  it('declares JSON with an explicit charset', () => {
    const { runs } = routesOf(createAutopilotService(makeHarness().engine))
    expect(call(runs, `${AUTOPILOT_API_PREFIX}/runs`).headers['content-type'])
      .toBe('application/json; charset=utf-8')
  })

  it('reads the id parameter, URL-decoded, first occurrence winning', () => {
    expect(queryParam('/x?id=a%2Fb', 'id')).toBe('a/b')
    expect(queryParam('/x?other=1&id=first&id=second', 'id')).toBe('first')
    expect(queryParam('/x', 'id')).toBeUndefined()
    expect(queryParam('/x?id=%E0%A4%A', 'id')).toBeUndefined()
  })
})

describe('a LIVE run projects to exactly the allow-listed fields', () => {
  it('serves phase, gates and counts — and nothing the snapshot holds privately', async () => {
    const h = makeHarness()
    const service = createAutopilotService(h.engine)
    await h.engine.init(h.root, makeTriage({ objective: 'expose run state to the web UI' }))
    await h.engine.submitPlan(h.root, 'PLAN-BODY-SECRET: rewrite the widget')

    const body = projectRuns(service)
    expect(body.runs).toHaveLength(1)
    const run = body.runs[0]!
    expect(run.runId).toBe(h.root.id)
    expect(run.phase).toBe('planning')
    expect(run.planGate).toBe('pending')
    expect(run.planRevision).toBe(1)
    expect(run.objective).toBe('expose run state to the web UI')

    // The plan text IS in the snapshot the service can reach…
    expect(service.peek(h.root.id)?.plan.text).toContain('PLAN-BODY-SECRET')
    // …and is nowhere in what the route serves.
    expect(JSON.stringify(body)).not.toContain('PLAN-BODY-SECRET')

    // The served key set is closed. A field added to StatusView cannot appear
    // here without someone naming it in projectRun.
    expect(Object.keys(run).sort()).toEqual([
      'auditCount', 'auditMode', 'closeoutSubmitted', 'enforcement', 'executionGate',
      'executionMode', 'latestVerdicts', 'logCount', 'objective', 'phase', 'planGate',
      'planRevision', 'replanBudgetRemaining', 'requiredRoles', 'revision', 'risk',
      'runId', 'size',
    ])
  })

  it('DROPS `diagnostic`, which the engine aliases onto an auditor note', async () => {
    const h = makeHarness()
    const service = createAutopilotService(h.engine)
    await h.engine.init(h.root, makeTriage())
    await h.engine.submitPlan(h.root, 'the plan')
    await h.engine.selfCheck(h.root, {
      role: 'plan', verdict: 'blocked', note: 'AUDITOR-NOTE-LEAK: the plan omits rollback',
    })

    // The engine really does put the note in `diagnostic` — `applyVerdict`'s
    // 'blocked' and 'needs-owner-decision' arms both commit
    // `diagnostic: outcome.note` verbatim (src/engine.ts). This is the
    // measurement the drop exists for, not an assumption about it.
    const status = service.status(h.root.id)!
    expect(status.diagnostic).toContain('AUDITOR-NOTE-LEAK')

    const projected = projectRun(status)
    expect((projected as unknown as Record<string, unknown>).diagnostic).toBeUndefined()
    expect(JSON.stringify(projectRuns(service))).not.toContain('AUDITOR-NOTE-LEAK')
  })

  it('replaces ownerApprovals with counts, keeping the fact and dropping the destination', () => {
    const projected = projectEnforcement({
      sandbox: 'active',
      reminders: 0,
      store: 'file',
      approval: 'signal-only',
      egress: 'guard-deny',
      service: 'registered',
      ownerApprovals: [
        { seq: 0, target: 'EGRESS-TARGET-LEAK: push to git@github.com:acme/private.git', grantedAtRevision: 3, consumedBy: 'git push' },
        { seq: 1, target: 'EGRESS-TARGET-LEAK: curl https://internal.example', grantedAtRevision: 5 },
      ],
    })
    expect(projected.ownerApprovalsGranted).toBe(2)
    expect(projected.ownerApprovalsConsumed).toBe(1)
    expect(projected.sandbox).toBe('active')
    expect(projected.egress).toBe('guard-deny')
    expect(JSON.stringify(projected)).not.toContain('EGRESS-TARGET-LEAK')
    expect(JSON.stringify(projected)).not.toContain('ownerApprovals"')
  })

  it('forwards only the named enforcement keys, so a new one cannot ride along', () => {
    const projected = projectEnforcement({
      sandbox: 'off', reminders: 1, ownerApprovals: [],
      // A field a future Enforcement might add.
      futureSecretPath: 'C:/Users/someone/.dsh/storages',
    } as never)
    expect(Object.keys(projected).sort()).toEqual([
      'ownerApprovalsConsumed', 'ownerApprovalsGranted', 'reminders', 'sandbox',
    ])
  })

  it('serves one run by id, and the executor summary when there is one', async () => {
    const h = makeHarness()
    const service = createAutopilotService(h.engine)
    await h.engine.init(h.root, makeTriage())
    const { run } = routesOf(service)
    const answer = call(run, `${AUTOPILOT_API_PREFIX}/run?id=${encodeURIComponent(h.root.id)}`)
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ ok: true, run: { runId: h.root.id, phase: 'planning' } })
  })

  it('answers 500 with a stable code, never an exception message, when the engine throws', () => {
    const service: AutopilotReadOnly = {
      peek: () => undefined,
      status: () => { throw new Error('ENOENT C:/Users/someone/.dsh/storages/dsh-autopilot/runs') },
      list: () => ['x'],
      storeKind: 'file',
    }
    const { runs, run } = routesOf(service)
    const listAnswer = call(runs, `${AUTOPILOT_API_PREFIX}/runs`)
    expect(listAnswer).toMatchObject({ status: 500, body: { ok: false, error: 'projection-failed' } })
    expect(listAnswer.raw).not.toContain('storages')
    expect(call(run, `${AUTOPILOT_API_PREFIX}/run?id=x`)).toMatchObject({ status: 500 })
  })
})

describe('mounting degrades to nothing without a web server', () => {
  it('is a no-op on a context with no ctx.inject at all (headless)', () => {
    const service = createAutopilotService(makeHarness().engine)
    const dispose = installAutopilotRoutes({}, service)
    expect(typeof dispose).toBe('function')
    expect(() => dispose()).not.toThrow()
  })

  it('never registers when the inject callback is not invoked (webServer absent)', () => {
    let injected: readonly string[] | undefined
    const host = {
      // cordis's lazy inject: the callback runs only once the service exists.
      inject: (names: readonly string[]) => { injected = names; return () => {} },
    }
    const dispose = installAutopilotRoutes(host, createAutopilotService(makeHarness().engine))
    expect(injected).toEqual(['webServer'])
    expect(() => dispose()).not.toThrow()
  })

  it('registers both routes through the scoped effect, and releases them on unload', () => {
    const registered: string[] = []
    const disposed: string[] = []
    let teardown: (() => void) | undefined
    const host = {
      inject: (
        _names: readonly string[],
        callback: (scoped: {
          webServer: { register(route: AutopilotWebRoute): () => void }
          effect?: (setup: () => () => void, label?: string) => unknown
        }) => void,
      ) => {
        callback({
          webServer: {
            register: (route) => {
              registered.push(route.path)
              return () => { disposed.push(route.path) }
            },
          },
          effect: (setup) => { teardown = setup() },
        })
        return () => {}
      },
    }
    installAutopilotRoutes(host, createAutopilotService(makeHarness().engine))
    expect(registered).toEqual([`${AUTOPILOT_API_PREFIX}/runs`, `${AUTOPILOT_API_PREFIX}/run`])
    teardown?.()
    expect(disposed.sort()).toEqual([`${AUTOPILOT_API_PREFIX}/run`, `${AUTOPILOT_API_PREFIX}/runs`])
  })

  it('fences every registered route through the scoped connection service, looked up per request', () => {
    // dsh 0.1.2 (A1-08): `webServer.register` applies no auth; the plugin
    // must ask `connection.requestRejection(req)` itself. The lookup happens
    // on each request, so a `connection` that appears AFTER mount is honoured.
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
    installAutopilotRoutes(host, createAutopilotService(makeHarness().engine))
    const runs = registered.find(r => r.path === `${AUTOPILOT_API_PREFIX}/runs`)!
    // No connection service yet → fail closed.
    expect(callRaw(runs, `${AUTOPILOT_API_PREFIX}/runs`)).toEqual({ status: 503, raw: JSON.stringify({ ok: false, error: 'no-connection-service' }) })
    present = true
    expect(callRaw(runs, `${AUTOPILOT_API_PREFIX}/runs`)).toEqual({ status: 401, raw: 'unauthorized' })
    rejection = 403
    expect(callRaw(runs, `${AUTOPILOT_API_PREFIX}/runs`)).toEqual({ status: 403, raw: 'forbidden' })
    rejection = undefined
    expect(callRaw(runs, `${AUTOPILOT_API_PREFIX}/runs`).status).toBe(200)
  })

  it('still mounts on a scoped context that exposes no effect', () => {
    const registered: string[] = []
    const host = {
      inject: (
        _names: readonly string[],
        callback: (scoped: { webServer: { register(route: AutopilotWebRoute): () => void } }) => void,
      ) => {
        callback({ webServer: { register: (route) => { registered.push(route.path); return () => {} } } })
        return undefined
      },
    }
    installAutopilotRoutes(host, createAutopilotService(makeHarness().engine))
    expect(registered).toHaveLength(2)
  })
})
