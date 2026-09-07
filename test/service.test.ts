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
import type { ProvideHost } from '../src/service.js'
import { makeHarness, makeTriage } from './helpers.js'

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
    const service = createAutopilotService(makeHarness().engine)
    const result = registerAutopilotService(host, service)
    expect(result.registered).toBe(true)
    expect(result.diagnostic).toBeUndefined()
    expect(provided.autopilot).toBe(service)
    result.dispose()
    expect(disposed).toBe(1)
  })

  it('tolerates a ctx.provide that returns nothing (the disposer is a no-op, not a crash)', () => {
    const host: ProvideHost = { provide: () => undefined }
    const result = registerAutopilotService(host, createAutopilotService(makeHarness().engine))
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
    const service = createAutopilotService(makeHarness().engine)
    const result = registerAutopilotService(host, service)
    expect(result.registered).toBe(true)
    expect(provided.autopilot).toBe(service)
    result.dispose()
    expect(disposed).toBe(1)
  })

  it('reports registered:false — with a reason — when the host exposes NO provide surface', () => {
    const result = registerAutopilotService({}, createAutopilotService(makeHarness().engine))
    expect(result.registered).toBe(false)
    expect(result.diagnostic).toContain('neither ctx.provide nor ctx.reflect.provide')
    expect(() => result.dispose()).not.toThrow()
  })

  it('reports registered:false when ctx.provide THROWS (a host that already provides autopilot)', () => {
    const host: ProvideHost = {
      provide: () => { throw new Error('service autopilot is already provided') },
    }
    const result = registerAutopilotService(host, createAutopilotService(makeHarness().engine))
    expect(result.registered).toBe(false)
    expect(result.diagnostic).toContain('already provided')
    // The plugin deliberately survives this: a harness that refuses to load
    // over a read-only accessor would be worse than one without the accessor.
    expect(() => result.dispose()).not.toThrow()
  })
})

describe('the read-only view, asserted against a LIVE run', () => {
  it('peek, status and list track the engine rather than answering emptily', async () => {
    const h = makeHarness()
    const service = createAutopilotService(h.engine)
    // Vacuous half first, so the live half is not the only observation.
    expect(service.peek(h.root.id)).toBeUndefined()
    expect(service.status(h.root.id)).toBeUndefined()
    expect(service.list()).toEqual([])

    await h.engine.init(h.root, makeTriage({ objective: 'ship the read-only surface' }))
    expect(service.peek(h.root.id)?.phase).toBe('planning')
    expect(service.peek(h.root.id)?.revision).toBe(1)
    expect(service.status(h.root.id)?.objective).toBe('ship the read-only surface')
    expect(service.status(h.root.id)?.planGate).toBe('pending')
    expect(service.list()).toEqual([h.root.id])

    await h.engine.submitPlan(h.root, 'the plan')
    expect(service.peek(h.root.id)?.plan.revision).toBe(1)
    expect(service.status(h.root.id)?.planRevision).toBe(1)
    // An unknown id is still undefined: the surface is per-run, not a dump.
    expect(service.peek('no-such-run')).toBeUndefined()
  })

  it('records the backend kind it was built over', () => {
    expect(createAutopilotService(makeHarness().engine).storeKind).toBe('file')
  })

  it('exposes no mutator: single-writer authority has no service-shaped hole', () => {
    const service = createAutopilotService(makeHarness().engine) as unknown as Record<string, unknown>
    for (const name of ['init', 'submitPlan', 'declareUsage', 'audit', 'submitCloseout', 'consumeApproval']) {
      expect(service[name]).toBeUndefined()
    }
    expect(Object.keys(service).sort()).toEqual(['list', 'peek', 'status', 'storeKind'])
  })

  it('carries the cordis tracker symbol, non-enumerably, with the value a Service would attach', () => {
    // One of the three stated reasons this is not `class extends Service`:
    // cordis's symbols are `Symbol.for(...)`, so the tracker metadata can be
    // attached by key from outside without a runtime cordis import. Wrapping
    // the definition in `if (false)` was invisible to the suite.
    const service = createAutopilotService(makeHarness().engine) as unknown as Record<symbol, unknown>
    expect(service[CORDIS_TRACKER]).toEqual({ associate: 'autopilot', property: 'ctx' })
    const descriptor = Object.getOwnPropertyDescriptor(service, CORDIS_TRACKER)
    expect(descriptor?.enumerable).toBe(false)
    expect(descriptor?.writable).toBe(false)
    // and it does not leak into the enumerable surface asserted above
    expect(Object.keys(service as object)).not.toContain('cordis.tracker')
  })
})
