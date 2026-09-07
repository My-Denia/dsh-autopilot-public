/**
 * The enforcement probes. Every one of them is a BEARER for a claim written
 * into a durable run record, so every one needs a fixture where it says yes and
 * a fixture where it says no — a probe whose fail nobody has observed can only
 * ever record a confidence, never a fact.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  observeApproval,
  probeApproval,
  probeSandbox,
  probeStorageDomain,
  resolveEgressChannel,
  resolveStore,
} from '../src/index.js'
import { DomainRunStore } from '../src/store/domain.js'
import { RunStore } from '../src/store/file.js'
import { fakeAgent, makeHarness, makeTriage } from './helpers.js'

describe('probeSandbox', () => {
  it('true only when BOTH sandbox (confine) and sandboxPolicy are observable via ctx.get', () => {
    const services: Record<string, unknown> = { sandbox: {}, sandboxPolicy: {} }
    const ctx = { get: (name: string) => services[name] }
    expect(probeSandbox(ctx)).toBe(true)
  })

  it('false when the confine provider is missing', () => {
    const services: Record<string, unknown> = { sandboxPolicy: {} }
    expect(probeSandbox({ get: (name: string) => services[name] })).toBe(false)
  })

  it('false when the policy service is missing', () => {
    const services: Record<string, unknown> = { sandbox: {} }
    expect(probeSandbox({ get: (name: string) => services[name] })).toBe(false)
  })

  it('falls back to property access when ctx.get is absent', () => {
    expect(probeSandbox({ sandbox: {}, sandboxPolicy: {} })).toBe(true)
    expect(probeSandbox({ sandbox: {} })).toBe(false)
  })

  it('a throwing ctx.get reads as unavailable via the property fallback, and a fully hostile ctx reads false', () => {
    const throwingGetWithProps = {
      get: () => { throw new Error('service access denied') },
      sandbox: {},
      sandboxPolicy: {},
    }
    // get() throws -> per-name fallback to property access still observes the services.
    expect(probeSandbox(throwingGetWithProps)).toBe(true)
    const hostile = new Proxy({}, { get: () => { throw new Error('boom') } })
    expect(probeSandbox(hostile)).toBe(false)
  })

  it('false on null-ish contexts', () => {
    expect(probeSandbox({})).toBe(false)
  })
})

/**
 * The approval probe, which used to ask only whether the service OBJECT existed.
 *
 * Its two siblings ask whether the service can do its job; this one did not, and
 * the live host showed exactly what that costs: one run recorded
 * `"approval":"native"` while every `approval/asked` in that same session
 * resolved `{"outcome":"unavailable"}`. The headless profile mounts the service
 * (base bundle) and composes no answerer, so the old check was structurally
 * unable to be false precisely where the claim was false.
 *
 * The fixtures below run through a REAL cordis `Context`: a real `EventsService`,
 * a real `ctx.on` registration, and the real `_hooks` record the probe reads —
 * because a fake `_hooks` object would only prove the probe agrees with my idea
 * of what cordis stores.
 */
describe('observeApproval / probeApproval', () => {
  function realCtx() {
    const ctx = new Context()
    return {
      ctx,
      /** Register an answerer the way `packages/acp` and `packages/host/apiproxy` do. */
      answer: () => (ctx as unknown as { on(name: string, listener: () => void): () => void })
        .on('approval/request', () => {}),
    }
  }

  it('ANSWERABLE needs a service, a promptable default policy AND a composed answerer', () => {
    const { ctx, answer } = realCtx()
    ctx.provide('approval', { config: { policy: 'ask' } })
    // The live shape: service mounted, nothing composed to answer it.
    expect(observeApproval(ctx)).toBe('unanswerable')
    expect(probeApproval(ctx)).toBe(false)

    const dispose = answer()
    expect(observeApproval(ctx)).toBe('answerable')
    expect(probeApproval(ctx)).toBe(true)

    // and it reads back DOWN when the answerer unmounts, on the same context.
    dispose()
    expect(observeApproval(ctx)).toBe('unanswerable')
    expect(probeApproval(ctx)).toBe(false)
  })

  it('a deployment default policy of never is UNANSWERABLE even with an answerer composed', () => {
    const { ctx, answer } = realCtx()
    ctx.provide('approval', { config: { policy: 'never' } })
    answer()
    // `ApprovalService.decide` returns 'rejected' BEFORE dispatch under that
    // policy, so the composed answerer is never reached. Not hypothetical: the
    // base bundle sets it whenever DSH_PERMISSION_MODE is danger-full-access.
    expect(observeApproval(ctx)).toBe('unanswerable')
    expect(probeApproval(ctx)).toBe(false)
  })

  it('ABSENT when no approval service is composed at all', () => {
    const { ctx } = realCtx()
    expect(observeApproval(ctx)).toBe('absent')
    expect(observeApproval({ get: () => undefined })).toBe('absent')
    expect(observeApproval({})).toBe('absent')
    expect(observeApproval({ approval: null })).toBe('absent')
    expect(probeApproval({})).toBe(false)
  })

  it('an unreadable policy does not disqualify — absence of the field is not evidence of its value', () => {
    // The answerer chain carries the positive evidence; the policy check only
    // removes a claim the code can see is false.
    expect(observeApproval({ approval: {}, events: { _hooks: { 'approval/request': [{}] } } })).toBe('answerable')
    expect(observeApproval({ approval: { config: null }, events: { _hooks: { 'approval/request': [{}] } } })).toBe('answerable')
  })

  it('an unreadable or empty event bus reads DOWN — a probe that cannot see cannot upgrade a claim', () => {
    expect(observeApproval({ approval: {} })).toBe('unanswerable')
    expect(observeApproval({ approval: {}, events: null })).toBe('unanswerable')
    expect(observeApproval({ approval: {}, events: { _hooks: 'not a record' } })).toBe('unanswerable')
    expect(observeApproval({ approval: {}, events: { _hooks: {} } })).toBe('unanswerable')
    expect(observeApproval({ approval: {}, events: { _hooks: { 'approval/request': [] } } })).toBe('unanswerable')
    expect(observeApproval(new Proxy({}, { get: () => { throw new Error('boom') } }))).toBe('absent')
  })

  it('reads the answerer chain under the name the service actually waterfalls', () => {
    // DETECTOR: a probe that looked for any other event name would report
    // 'answerable' here, and 'unanswerable' for the real registration above.
    expect(observeApproval({ approval: {}, events: { _hooks: { 'approval/asked': [{}] } } })).toBe('unanswerable')
  })
})

describe('probeStorageDomain', () => {
  it('returns the facility when it exposes open()', () => {
    const facility = { open: async () => ({}) }
    expect(probeStorageDomain({ get: (name: string) => (name === 'storageDomain' ? facility : undefined) }))
      .toBe(facility)
  })

  it('undefined when the deployment mounts no storageDomain (the headless profile)', () => {
    expect(probeStorageDomain({ get: () => undefined })).toBeUndefined()
    expect(probeStorageDomain({})).toBeUndefined()
  })

  it('undefined for a truthy service that cannot open — presence is not capability', () => {
    expect(probeStorageDomain({ storageDomain: {} })).toBeUndefined()
    expect(probeStorageDomain({ storageDomain: { open: 'not a function' } })).toBeUndefined()
    expect(probeStorageDomain({ storageDomain: 'yes' })).toBeUndefined()
  })

  it('undefined on a hostile context', () => {
    expect(probeStorageDomain(new Proxy({}, { get: () => { throw new Error('boom') } }))).toBeUndefined()
  })
})

describe('resolveEgressChannel', () => {
  // Three-valued, asserted on each value.
  it('native-ask when the seam installed', () => {
    expect(resolveEgressChannel(true, true)).toBe('native-ask')
  })

  it('guard-deny when the seam did not install', () => {
    expect(resolveEgressChannel(false, true)).toBe('guard-deny')
  })

  it('off when the owner disabled the boundary, regardless of the seam', () => {
    expect(resolveEgressChannel(true, false)).toBe('off')
    expect(resolveEgressChannel(false, false)).toBe('off')
  })

  it('UNDEFINED — no seam observed for THIS scope — reads as the less capable value', () => {
    // The branch the docstring makes an explicit safety claim about ("a run must
    // never record native-ask on the strength of some OTHER scope's seam") and
    // the one no fixture reached: `seamInstalled === true` was the only value
    // ever asserted against, so `!== false` would have passed too, and a root
    // that never reached `maybeInstall` would have persisted 'native-ask'.
    expect(resolveEgressChannel(undefined, true)).toBe('guard-deny')
    expect(resolveEgressChannel(undefined, false)).toBe('off')
  })
})

describe('resolveStore', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-store-'))

  /** A minimal in-memory stand-in for the storage-domain facility. */
  function fakeFacility() {
    const tables = new Map<string, Map<string, unknown>>()
    return {
      open: async () => ({
        table: (name: string) => {
          const store = tables.get(name) ?? new Map<string, unknown>()
          tables.set(name, store)
          return {
            get: (key: string) => store.get(key),
            entries: () => store.entries(),
            keys: () => store.keys(),
            put: async (key: string, value: unknown) => { store.set(key, value) },
          }
        },
        close: async () => {},
      }),
    }
  }

  it('storeKind file never touches the domain, even where one exists', async () => {
    const resolution = await resolveStore({ storageDomain: fakeFacility() }, 'file', root)
    expect(resolution.store).toBeInstanceOf(RunStore)
    expect(resolution.store.kind).toBe('file')
    // Files were what the operator ASKED for. Nothing degraded, so nothing is
    // reported as having degraded — otherwise the reason would be noise on the
    // one configuration where it means nothing.
    expect(resolution.degraded).toBeUndefined()
  })

  it('storeKind auto prefers the domain when the facility is observable', async () => {
    const resolution = await resolveStore({ storageDomain: fakeFacility() }, 'auto', root)
    expect(resolution.store).toBeInstanceOf(DomainRunStore)
    expect(resolution.store.kind).toBe('domain')
    expect(resolution.degraded).toBeUndefined()
  })

  it('storeKind auto falls back to files on a deployment with no facility', async () => {
    const resolution = await resolveStore({}, 'auto', root)
    expect(resolution.store).toBeInstanceOf(RunStore)
    expect(resolution.store.kind).toBe('file')
  })

  it('storeKind auto falls back to files when open() rejects', async () => {
    const broken = { storageDomain: { open: async () => { throw new Error('backend unavailable') } } }
    const resolution = await resolveStore(broken, 'auto', root)
    expect(resolution.store.kind).toBe('file')
  })

  /**
   * `enforcement.store: 'file'` cannot tell these two apart, and the 'auto'
   * branch used to discard the only thing that could: the thrown error went into
   * a bare `catch {}` and nothing was recorded anywhere. A deployment that
   * degraded looked exactly like one that never had a facility.
   */
  it('says WHY auto did not get the domain, and the two reasons are distinguishable', async () => {
    const none = await resolveStore({}, 'auto', root)
    expect(none.store.kind).toBe('file')
    expect(none.degraded).toMatch(/storageDomain is not observable/)

    const broken = await resolveStore(
      { storageDomain: { open: async () => { throw new Error('backend unavailable') } } },
      'auto',
      root,
    )
    expect(broken.store.kind).toBe('file')
    // The thrown message SURVIVES: it is the only thing that says what broke.
    expect(broken.degraded).toContain('backend unavailable')
    expect(broken.degraded).not.toBe(none.degraded)

    // A non-Error rejection is still reported rather than rendered as [object Object].
    const odd = await resolveStore(
      { storageDomain: { open: async () => { throw 'domain name already open' } } },
      'auto',
      root,
    )
    expect(odd.degraded).toContain('domain name already open')
  })

  it('storeKind domain REFUSES rather than silently mounting a different backend', async () => {
    await expect(resolveStore({}, 'domain', root))
      .rejects.toThrowError(/ctx.storageDomain is not observable/)
  })
})

describe('enforcement record at init', () => {
  it('records what the probes saw: store kind, approval channel, egress seam, consumed count', async () => {
    const h = makeHarness({
      environment: {
        approvalAvailable: () => true,
        egressChannel: () => 'native-ask',
      },
    })
    const snapshot = await h.engine.init(h.root, makeTriage())
    expect(snapshot.enforcement.store).toBe('file')
    expect(snapshot.enforcement.approval).toBe('native')
    expect(snapshot.enforcement.egress).toBe('native-ask')
    expect(snapshot.enforcement.outboundConsumed).toBe(0)
  })

  it('records the LESS capable value when the probes say no', async () => {
    const h = makeHarness({
      environment: {
        approvalAvailable: () => false,
        egressChannel: () => 'guard-deny',
      },
    })
    const snapshot = await h.engine.init(h.root, makeTriage())
    expect(snapshot.enforcement.approval).toBe('signal-only')
    expect(snapshot.enforcement.egress).toBe('guard-deny')
  })

  it('a THROWING probe never upgrades a claim', async () => {
    const h = makeHarness({
      environment: {
        approvalAvailable: () => { throw new Error('probe exploded') },
        egressChannel: () => { throw new Error('probe exploded') },
      },
    })
    const snapshot = await h.engine.init(h.root, makeTriage())
    expect(snapshot.enforcement.approval).toBe('signal-only')
    expect(snapshot.enforcement.egress).toBe('guard-deny')
  })

  it('asks the egress probe about THIS run, so two roots cannot inherit each other channel', async () => {
    // A mount-wide, last-write-wins flag lets a root whose seam installed record
    // the channel of a root whose seam did not (and vice versa) — a value the
    // code is not observing for the scope it names.
    const asked: string[] = []
    const h = makeHarness({
      environment: {
        egressChannel: (rootSessionId: string) => {
          asked.push(rootSessionId)
          return rootSessionId === 'root-1' ? 'native-ask' : 'guard-deny'
        },
      },
    })
    const snapshot = await h.engine.init(h.root, makeTriage())
    expect(asked).toContain(h.root.id)
    expect(snapshot.enforcement.egress).toBe('native-ask')

    // Negative half on the same engine: a DIFFERENT root gets its own answer.
    const other = fakeAgent('root-2')
    h.agents.add(other)
    const secondary = await h.engine.init(other, makeTriage())
    expect(secondary.enforcement.egress).toBe('guard-deny')
  })

  it('records whether ctx.autopilot was actually provided at mount', async () => {
    const yes = makeHarness({ environment: { serviceRegistered: () => true } })
    expect((await yes.engine.init(yes.root, makeTriage())).enforcement.service).toBe('registered')

    const no = makeHarness({ environment: { serviceRegistered: () => false } })
    expect((await no.engine.init(no.root, makeTriage())).enforcement.service).toBe('unavailable')

    // An unwired probe answers the least capable value, like every sibling.
    const unwired = makeHarness()
    expect((await unwired.engine.init(unwired.root, makeTriage())).enforcement.service).toBe('unavailable')
  })

  it('an UNWIRED probe set defaults to the same least-capable answers', async () => {
    const h = makeHarness()
    const snapshot = await h.engine.init(h.root, makeTriage())
    expect(snapshot.enforcement.approval).toBe('signal-only')
    expect(snapshot.enforcement.egress).toBe('guard-deny')
  })
})
