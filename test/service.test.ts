/**
 * `ctx.autopilot`: the read-only service surface.
 *
 * NO TEST FILE IMPORTED `../src/service.js` AT ALL before this one, and the
 * consequences were measured rather than guessed. Every one of the following
 * mutations left the whole suite green:
 *
 * - forcing the no-provide-surface branch to `registered: true`, i.e. recording
 *   a confidence (`enforcement.service`) the code cannot be observed producing
 *   falsely — the exact honest-ceiling violation DESIGN.md §6 calls out for
 *   `enforcement.sandbox`;
 * - replacing `peek` with `() => undefined` and `list` with `() => []`, because
 *   the only assertions anywhere were the vacuous no-run cases;
 * - wrapping the `Symbol.for('cordis.tracker')` definition in `if (false)`,
 *   which is one of the three stated reasons this hand-rolled service is safe
 *   to have instead of `class extends Service`.
 *
 * So each of those is asserted here against a LIVE run, and each registration
 * branch — `provide`, `reflect.provide`, neither, and a throwing `provide` —
 * carries its own fixture.
 */

import { describe, expect, it } from 'vitest'
import { createAutopilotService, registerAutopilotService } from '../src/service.js'
import type { LegacyReader, ProvideHost } from '../src/service.js'
import { FileLedgerStore, emptyLedger } from '../src/store/ledger.js'
import type { LegacyRunProjection, LegacyRunSummary } from '../src/domain/ledger-types.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CORDIS_TRACKER = Symbol.for('cordis.tracker')

describe('registerAutopilotService: every branch of the registration surface', () => {
  it('registers through ctx.provide and hands back its disposer', () => {
    const provided: Record<string, unknown> = {}
    let disposed = 0
    const host: ProvideHost = {
      provide(name, value) {
        provided[name] = value
        return () => { disposed += 1 }
      },
    }
    const service = quietService()
    const result = registerAutopilotService(host, service)
    expect(result.registered).toBe(true)
    expect(result.diagnostic).toBeUndefined()
    expect(provided.autopilot).toBe(service)
    result.dispose()
    expect(disposed).toBe(1)
  })

  it('tolerates a ctx.provide that returns nothing (the disposer is a no-op, not a crash)', () => {
    const host: ProvideHost = { provide: () => undefined }
    const result = registerAutopilotService(host, quietService())
    expect(result.registered).toBe(true)
    expect(() => result.dispose()).not.toThrow()
  })

  it('falls back to ctx.reflect.provide when only that surface exists', () => {
    // An ENTIRELY untested branch until now, and the one that matters: cordis's
    // own `Service` constructor registers through `ctx.reflect.provide`, so a
    // context shape that exposes only the reflect level is not exotic.
    const provided: Record<string, unknown> = {}
    let disposed = 0
    const host: ProvideHost = {
      reflect: {
        provide(name, value) {
          provided[name] = value
          return () => { disposed += 1 }
        },
      },
    }
    const service = quietService()
    const result = registerAutopilotService(host, service)
    expect(result.registered).toBe(true)
    expect(provided.autopilot).toBe(service)
    result.dispose()
    expect(disposed).toBe(1)
  })

  it('reports registered:false — with a reason — when the host exposes NO provide surface', () => {
    const result = registerAutopilotService({}, quietService())
    expect(result.registered).toBe(false)
    expect(result.diagnostic).toContain('neither ctx.provide nor ctx.reflect.provide')
    expect(() => result.dispose()).not.toThrow()
  })

  it('reports registered:false when ctx.provide THROWS (a host that already provides autopilot)', () => {
    const host: ProvideHost = {
      provide: () => { throw new Error('service autopilot is already provided') },
    }
    const result = registerAutopilotService(host, quietService())
    expect(result.registered).toBe(false)
    expect(result.diagnostic).toContain('already provided')
    // The plugin deliberately survives this: a harness that refuses to load
    // over a read-only accessor would be worse than one without the accessor.
    expect(() => result.dispose()).not.toThrow()
  })
})


const T0 = '2026-11-04T00:00:00.000Z'

function summary(runId: string, sessionId: string | undefined, over: Partial<LegacyRunSummary> = {}): LegacyRunSummary {
  return {
    runId,
    ...(sessionId === undefined ? {} : { sessionId }),
    backend: 'file',
    fold: 'ok',
    eventCount: 3,
    sandboxRestore: { state: 'pending' },
    ...over,
  }
}

function stubLegacy(runs: readonly LegacyRunSummary[], projections: Record<string, LegacyRunProjection> = {}): LegacyReader & { calls: number } {
  const reader = {
    calls: 0,
    list: async () => { reader.calls += 1; return runs },
    read: async (_sources: unknown, runId: string) => projections[runId],
  }
  return reader
}

async function storeWith(...sessions: string[]): Promise<FileLedgerStore> {
  const store = FileLedgerStore.open(mkdtempSync(join(tmpdir(), 'dsh-autopilot-service-')), { now: () => T0 })
  for (const id of sessions) await store.write(emptyLedger(id, T0), 0)
  return store
}

describe('the read-only view over a ledger store and the legacy reader', () => {
  it('serves a session ledger with only its own legacy runs and the restore the ledger recorded', async () => {
    const store = await storeWith('s1')
    const first = store.load('s1')!
    await store.write({ ...first, legacyRestores: { r1: { state: 'restored', mode: 'workspace-write', at: T0 } } }, 1)
    const legacy = stubLegacy([summary('r1', 's1'), summary('r2', 's2'), summary('r3', undefined)])
    const service = createAutopilotService({ ledgers: store, sources: { fileRoot: '/x' }, legacy, notes: () => ['n1'] })
    const projection = await service.ledger('s1')
    expect(projection?.sessionId).toBe('s1')
    expect(projection?.revision).toBe(2)
    expect(projection?.legacyRuns.map(r => r.runId)).toEqual(['r1'])
    expect(projection?.legacyRuns[0]?.sandboxRestore).toEqual({ state: 'restored', mode: 'workspace-write', at: T0 })
    expect(projection?.notes).toEqual(['n1'])
  })

  it('answers undefined for a session without a ledger, and lists every ledger', async () => {
    const store = await storeWith('a', 'b')
    const service = createAutopilotService({ ledgers: store, sources: {}, legacy: stubLegacy([]) })
    expect(await service.ledger('missing')).toBeUndefined()
    expect((await service.ledgers()).map(l => l.sessionId).sort()).toEqual(['a', 'b'])
    expect(service.notes()).toEqual([])
  })

  it('reads legacy runs through the injected reader with the sources it was given', async () => {
    const projection = { runId: 'r1' } as unknown as LegacyRunProjection
    let seen: unknown
    const legacy: LegacyReader = {
      list: async (sources) => { seen = sources; return [summary('r1', 's1')] },
      read: async (_s, id) => (id === 'r1' ? projection : undefined),
    }
    const sources = { fileRoot: '/root' }
    const service = createAutopilotService({ ledgers: await storeWith(), sources, legacy })
    expect((await service.legacyRuns()).map(r => r.runId)).toEqual(['r1'])
    expect(seen).toBe(sources)
    expect(await service.legacyRun('r1')).toBe(projection)
    expect(await service.legacyRun('nope')).toBeUndefined()
  })

  it('reads notes on every call, so a note added after mount still shows', async () => {
    const notes: string[] = []
    const service = createAutopilotService({ ledgers: await storeWith(), sources: {}, legacy: stubLegacy([]), notes: () => notes })
    expect(service.notes()).toEqual([])
    notes.push('later')
    expect(service.notes()).toEqual(['later'])
  })

  it('records the backend kind it was built over', async () => {
    expect(createAutopilotService({ ledgers: await storeWith(), sources: {}, legacy: stubLegacy([]) }).storeKind).toBe('file')
  })

  it('exposes no mutator: the ledger has one writer and it is not this handle', async () => {
    const service = createAutopilotService({ ledgers: await storeWith(), sources: {}, legacy: stubLegacy([]) }) as unknown as Record<string, unknown>
    for (const name of ['write', 'init', 'commit', 'save', 'put']) expect(service[name]).toBeUndefined()
    expect(Object.keys(service).sort()).toEqual(['ledger', 'ledgers', 'legacyRun', 'legacyRuns', 'notes', 'storeKind'])
  })

  it('carries the cordis tracker symbol, non-enumerably, with the value a Service would attach', async () => {
    // cordis's symbols are `Symbol.for(...)`, so the tracker metadata can be
    // attached by key from outside without a runtime cordis import.
    const service = createAutopilotService({ ledgers: await storeWith(), sources: {}, legacy: stubLegacy([]) }) as unknown as Record<symbol, unknown>
    expect(service[CORDIS_TRACKER]).toEqual({ associate: 'autopilot', property: 'ctx' })
    const descriptor = Object.getOwnPropertyDescriptor(service, CORDIS_TRACKER)
    expect(descriptor?.enumerable).toBe(false)
    expect(descriptor?.writable).toBe(false)
    expect(Object.keys(service as object)).not.toContain('cordis.tracker')
  })
})

/** A service over an empty store, for the registration tests that only need a handle. */
function quietService(): ReturnType<typeof createAutopilotService> {
  return createAutopilotService({
    ledgers: FileLedgerStore.open(mkdtempSync(join(tmpdir(), 'dsh-autopilot-service-'))),
    sources: {},
    legacy: { list: async () => [], read: async () => undefined },
  })
}
