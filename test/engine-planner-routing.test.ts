/**
 * M6 planner opt-in via installModelSelection (plan v3 "Roles and routing";
 * packet E6).
 *
 * The planner IS the root agent — never dispatched — so a non-inherit planner
 * decision is a model selection INSTALLED on the root agent's scoped ctx for
 * exactly the planning phases (planning, plan-reviewing, replanning), and
 * disposed at every exit from them (plan-gate pass first of all). The engine
 * port is optional by the same doctrine as the E3 routing ports: with no
 * installer port, or no root ctx, a non-inherit planner decision DEGRADES to
 * inheritance with `plannerRouting: 'unsupported'` recorded (status surface +
 * the deciding commit's durable event detail) — never silent, never fatal.
 * An `inherit` decision (the shipped default) records nothing and never calls
 * the port.
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RoutingPorts } from '../src/engine.js'
import { AutopilotEngine } from '../src/engine.js'
import { apply, resolveConfig } from '../src/index.js'
import { RouteCatalog } from '../src/routing/catalog.js'
import type { LlmCallConfig, LlmModelInfo, LlmResolvedModelInfo, LlmRuntimeSubset } from '../src/routing/catalog.js'
import { RunStore } from '../src/store/file.js'
import type { RunEvent } from '../src/domain/types.js'
import { makeHarness, makeTriage, makeUsageEntry, stubSubagents, undeclaredSeed, FakeAgents, fakeAgent } from './helpers.js'

/** The deliberate scoped-ctx stub ([R2-P3-1]): real host agents carry one. */
const ROOT_CTX = { marker: 'root-scoped-ctx' }

interface InstallCall {
  readonly agentCtx: unknown
  readonly route: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
}

/** A capturing installer port: records calls, counts disposer invocations. */
function stubInstaller(behavior: { readonly throw?: Error; readonly decline?: boolean } = {}): {
  readonly port: NonNullable<RoutingPorts['modelSelectionInstaller']>
  readonly calls: InstallCall[]
  readonly disposes: () => number
} {
  const calls: InstallCall[] = []
  let disposes = 0
  const port: NonNullable<RoutingPorts['modelSelectionInstaller']> = (agentCtx, route) => {
    calls.push({ agentCtx, route: { ...route } })
    if (behavior.throw !== undefined) throw behavior.throw
    if (behavior.decline === true) return undefined
    return () => {
      disposes += 1
    }
  }
  return { port, calls, disposes: () => disposes }
}

/** A locked planner route, opted in through the config surface. */
const LOCKED_PLANNER = {
  routing: {
    roles: {
      planner: {
        mode: 'locked' as const,
        lock: { provider: 'planner-p', model: 'planner-m', reasoningEffort: 'high' },
      },
    },
  },
}

const LOCKED_ROUTE = { provider: 'planner-p', model: 'planner-m', reasoningEffort: 'high' }

/** Drive a lightweight self-check run through the plan gate (usage-exempt). */
async function driveThroughPlanGate(h: ReturnType<typeof makeHarness>): Promise<void> {
  await h.engine.init(h.root, makeTriage())
  await h.engine.submitPlan(h.root, 'milestone 1 - verify: pnpm test')
  await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'binary checks present' })
}

/** Every persisted event of one run's stream, parsed. */
function eventsOf(h: { readonly storeDir: string; readonly root: { readonly id: string } }): RunEvent[] {
  return readFileSync(join(h.storeDir, 'runs', h.root.id, 'events.jsonl'), 'utf8')
    .trim().split(String.fromCharCode(10))
    .map(line => JSON.parse(line) as RunEvent)
}

/** The init event's detail (line 1 of events.jsonl), as persisted. */
function initEventDetail(h: { readonly storeDir: string; readonly root: { readonly id: string } }): { plannerRouting?: { status?: string; route?: unknown; why?: readonly string[] } } | undefined {
  return eventsOf(h)[0]?.detail as { plannerRouting?: { status?: string; route?: unknown } } | undefined
}

describe('(i) planner locked: installed at planning with the locked route, disposed on plan-gate pass', () => {
  it('installs once on the root ctx at init and keeps the install across the planning phases', async () => {
    const installer = stubInstaller()
    const h = makeHarness({ config: LOCKED_PLANNER, rootCtx: ROOT_CTX, routing: { modelSelectionInstaller: installer.port } })
    await h.engine.init(h.root, makeTriage())
    expect(installer.calls).toHaveLength(1)
    expect(installer.calls[0]?.agentCtx).toBe(ROOT_CTX)
    expect(installer.calls[0]?.route).toEqual(LOCKED_ROUTE)
    expect(installer.disposes()).toBe(0)
    expect(h.engine.status(h.root)?.plannerRouting).toEqual({
      status: 'routed',
      route: LOCKED_ROUTE,
      why: expect.any(Array),
    })

    // Still one install through submit-plan and a needs-replan round: the
    // planning FAMILY keeps the selection; only leaving it disposes.
    await h.engine.submitPlan(h.root, 'plan v1')
    await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'needs-replan', note: 'weak verification' })
    expect(h.engine.peek(h.root.id)?.phase).toBe('replanning')
    await h.engine.submitPlan(h.root, 'plan v2')
    expect(installer.calls).toHaveLength(1)
    expect(installer.disposes()).toBe(0)
  })

  it('disposes exactly once when the plan gate passes (planning -> executing)', async () => {
    const installer = stubInstaller()
    const h = makeHarness({ config: LOCKED_PLANNER, rootCtx: ROOT_CTX, routing: { modelSelectionInstaller: installer.port } })
    await driveThroughPlanGate(h)
    expect(h.engine.peek(h.root.id)?.phase).toBe('executing')
    expect(h.engine.peek(h.root.id)?.planGate).toBe('pass')
    expect(installer.disposes()).toBe(1)
    // The status surface stops claiming a routed planner once disposed.
    expect(h.engine.status(h.root)?.plannerRouting).toBeUndefined()
  })

  it('the deciding commit carries the durable plannerRouting record; later commits do not', async () => {
    const installer = stubInstaller()
    const h = makeHarness({ config: LOCKED_PLANNER, rootCtx: ROOT_CTX, routing: { modelSelectionInstaller: installer.port } })
    await h.engine.init(h.root, makeTriage())
    const detail = initEventDetail(h)
    expect(detail?.plannerRouting?.status).toBe('routed')
    expect(detail?.plannerRouting?.route).toEqual(LOCKED_ROUTE)
    await h.engine.submitPlan(h.root, 'plan')
    const events = readFileSync(join(h.storeDir, 'runs', h.root.id, 'events.jsonl'), 'utf8')
      .trim().split(String.fromCharCode(10)).map(line => JSON.parse(line) as { op: string; detail?: unknown })
    // Only the init event (the deciding commit) stamps the record.
    expect(events.filter(event => event.detail !== undefined && 'plannerRouting' in (event.detail as object))).toHaveLength(1)
  })
})

describe('(ii) planner inherit (the shipped default): the port is never called', () => {
  it('no install, no dispose, nothing recorded, through the whole run', async () => {
    const installer = stubInstaller()
    const h = makeHarness({ rootCtx: ROOT_CTX, routing: { modelSelectionInstaller: installer.port } })
    await driveThroughPlanGate(h)
    expect(installer.calls).toHaveLength(0)
    expect(installer.disposes()).toBe(0)
    expect(h.engine.status(h.root)?.plannerRouting).toBeUndefined()
    const detail = initEventDetail(h)
    expect(detail?.plannerRouting).toBeUndefined()
  })
})

describe('(iii) dispose idempotence across terminal transitions', () => {
  it('a blocked verdict out of planning disposes once; later engine dispose does not double-fire', async () => {
    const installer = stubInstaller()
    const h = makeHarness({ config: LOCKED_PLANNER, rootCtx: ROOT_CTX, routing: { modelSelectionInstaller: installer.port } })
    await h.engine.init(h.root, makeTriage())
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'blocked', note: 'out of scope' })
    expect(h.engine.peek(h.root.id)?.phase).toBe('blocked')
    expect(installer.disposes()).toBe(1)
    await h.engine.dispose()
    expect(installer.disposes()).toBe(1)
  })

  it('needs-owner-decision disposes; resume-planning re-arms from CURRENT facts; the later gate pass disposes again', async () => {
    const installer = stubInstaller()
    const h = makeHarness({ config: LOCKED_PLANNER, rootCtx: ROOT_CTX, routing: { modelSelectionInstaller: installer.port } })
    await h.engine.init(h.root, makeTriage())
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'needs-owner-decision', note: 'owner must arbitrate' })
    expect(h.engine.peek(h.root.id)?.phase).toBe('needs-owner-decision')
    expect(installer.disposes()).toBe(1)
    expect(installer.calls).toHaveLength(1)

    await h.engine.ownerResolve(h.root, { decision: 'resume-planning', note: 'narrow the scope' })
    expect(h.engine.peek(h.root.id)?.phase).toBe('planning')
    expect(installer.calls).toHaveLength(2)
    expect(installer.calls[1]?.route).toEqual(LOCKED_ROUTE)

    await h.engine.submitPlan(h.root, 'plan v2')
    await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'ok' })
    expect(h.engine.peek(h.root.id)?.phase).toBe('executing')
    expect(installer.disposes()).toBe(2)
  })

  it('engine.dispose() tears down an install that is still live mid-planning', async () => {
    const installer = stubInstaller()
    const h = makeHarness({ config: LOCKED_PLANNER, rootCtx: ROOT_CTX, routing: { modelSelectionInstaller: installer.port } })
    await h.engine.init(h.root, makeTriage())
    expect(installer.disposes()).toBe(0)
    await h.engine.dispose()
    expect(installer.disposes()).toBe(1)
  })

  it('the public set-blocked and set-owner-decision exits out of planning dispose too', async () => {
    const installer = stubInstaller()
    const h = makeHarness({ config: LOCKED_PLANNER, rootCtx: ROOT_CTX, routing: { modelSelectionInstaller: installer.port } })
    await h.engine.init(h.root, makeTriage())
    await h.engine.setBlocked(h.root, 'owner stopped the run')
    expect(h.engine.peek(h.root.id)?.phase).toBe('blocked')
    expect(installer.disposes()).toBe(1)

    const second = stubInstaller()
    const h2 = makeHarness({ config: LOCKED_PLANNER, rootCtx: ROOT_CTX, routing: { modelSelectionInstaller: second.port } })
    await h2.engine.init(h2.root, makeTriage())
    await h2.engine.setOwnerDecision(h2.root, 'owner arbitration')
    expect(h2.engine.peek(h2.root.id)?.phase).toBe('needs-owner-decision')
    expect(second.disposes()).toBe(1)
  })
})

describe('(iv) no installer port with a locked planner: inheritance, recorded unsupported', () => {
  it('the run proceeds normally and records the degradation on the status surface AND the durable event', async () => {
    const h = makeHarness({ config: LOCKED_PLANNER, rootCtx: ROOT_CTX, routing: {} })
    await h.engine.init(h.root, makeTriage())
    // While still planning, the degradation is LIVE-VISIBLE on status...
    const status = h.engine.status(h.root)
    expect(status?.plannerRouting?.status).toBe('unsupported')
    expect(status?.plannerRouting?.route).toEqual(LOCKED_ROUTE)
    expect(status?.plannerRouting?.why?.join('\n')).toContain('no modelSelectionInstaller port')
    // ...and it is durable on the deciding (init) commit's detail.
    const detail = initEventDetail(h)
    expect(detail?.plannerRouting?.status).toBe('unsupported')
    expect(detail?.plannerRouting?.route).toEqual(LOCKED_ROUTE)
    // And the run itself is untouched: the normal lightweight flow completes.
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'ok' })
    expect(h.engine.peek(h.root.id)?.phase).toBe('executing')
  })
})

describe('(v) no root ctx with a locked planner: the same degradation', () => {
  it('records unsupported naming the missing ctx leg and never calls the port', async () => {
    const installer = stubInstaller()
    // No rootCtx: the fake root agent carries no scoped ctx, by default.
    const h = makeHarness({ config: LOCKED_PLANNER, routing: { modelSelectionInstaller: installer.port } })
    await h.engine.init(h.root, makeTriage())
    expect(installer.calls).toHaveLength(0)
    const status = h.engine.status(h.root)
    expect(status?.plannerRouting?.status).toBe('unsupported')
    expect(status?.plannerRouting?.why?.join('\n')).toContain('no scoped ctx')
    // And the run still runs: the plan cycle proceeds.
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'ok' })
    expect(h.engine.peek(h.root.id)?.phase).toBe('executing')
  })
})

describe('the degradation vocabulary: installer refusals and grant conflicts', () => {
  it('a throwing installer is recorded unsupported and the run continues with inheritance', async () => {
    const installer = stubInstaller({ throw: new Error('waterfall full') })
    const h = makeHarness({ config: LOCKED_PLANNER, rootCtx: ROOT_CTX, routing: { modelSelectionInstaller: installer.port } })
    await h.engine.init(h.root, makeTriage())
    expect(installer.calls).toHaveLength(1)
    const status = h.engine.status(h.root)
    expect(status?.plannerRouting?.status).toBe('unsupported')
    expect(status?.plannerRouting?.why?.join('\n')).toContain('waterfall full')
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'ok' })
    expect(h.engine.peek(h.root.id)?.phase).toBe('executing')
  })

  it('a declining installer (no disposer) is recorded unsupported', async () => {
    const installer = stubInstaller({ decline: true })
    const h = makeHarness({ config: LOCKED_PLANNER, rootCtx: ROOT_CTX, routing: { modelSelectionInstaller: installer.port } })
    await h.engine.init(h.root, makeTriage())
    expect(h.engine.status(h.root)?.plannerRouting?.status).toBe('unsupported')
    expect(h.engine.status(h.root)?.plannerRouting?.why?.join('\n')).toContain('declined')
  })

  it('a locked planner route outside the session policy is NOT installed (policy respected, run continues)', async () => {
    const installer = stubInstaller()
    const h = makeHarness({
      config: LOCKED_PLANNER,
      rootCtx: ROOT_CTX,
      routing: {
        modelSelectionInstaller: installer.port,
        policyReader: () => ({ kind: 'present', routes: [{ provider: 'other-p', model: 'other-m' }] }),
      },
    })
    await h.engine.init(h.root, makeTriage())
    expect(installer.calls).toHaveLength(0)
    const status = h.engine.status(h.root)
    expect(status?.plannerRouting?.status).toBe('unsupported')
    expect(status?.plannerRouting?.why?.join('\n')).toContain('outside the session model-selection policy')
  })
})

describe('the arm invariant holds at the edges of the plan gate', () => {
  it('a plan-gate refusal (usage undeclared) stays in planning and keeps the install', async () => {
    const installer = stubInstaller()
    const h = makeHarness({
      config: LOCKED_PLANNER,
      rootCtx: ROOT_CTX,
      routing: { modelSelectionInstaller: installer.port },
      subagents: stubSubagents({ verdicts: [
        { verdict: 'pass', note: 'plan ok' },
        { verdict: 'pass', note: 'plan ok after usage' },
      ] }),
    })
    await h.engine.init(
      h.root,
      makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent' }),
      [undeclaredSeed('m1')],
    )
    await h.engine.submitPlan(h.root, 'plan')
    await expect(h.engine.audit(h.root, { role: 'plan', prompt: 'p' }))
      .rejects.toThrowError(/usage evidence must be declared/)
    // The refusal put the run BACK in planning: the planner install survives.
    expect(h.engine.peek(h.root.id)?.phase).toBe('planning')
    expect(installer.disposes()).toBe(0)
    expect(h.engine.status(h.root)?.plannerRouting?.status).toBe('routed')

    // Declaring usage and passing a fresh audit flips the gate: dispose fires.
    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    await h.engine.submitPlan(h.root, 'plan v2')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    expect(h.engine.peek(h.root.id)?.phase).toBe('executing')
    expect(installer.disposes()).toBe(1)
  })
})

// ── P2-3 (execution-audit r1): the planner install is re-armed after an engine reload ──
//
// `plannerInstalls` is engine-local: a restart with a run parked in a planning
// phase loses the install while the durable stream still says
// `plannerRouting: 'routed'`. The decided fix is the plan-faithful one — RE-ARM
// at engine load (re-resolving against CURRENT policy/catalog facts, never
// resurrecting), with the next planning-phase commit recording the re-arm
// once, durably. When the root agent is not observable at load, arming would
// falsely degrade ("no scoped ctx"), so the re-arm defers to the commit
// chokepoint and the named gap is recorded there instead.

describe('P2-3: the planner install is re-armed after an engine reload', () => {
  /** A catalog stub with a fixed provider list (dead-provider fixtures). */
  class FixedLlm implements LlmRuntimeSubset {
    constructor(private readonly providers: readonly string[]) {}
    listProviders() { return this.providers.map(id => ({ id, name: id })) }
    async listModels() { return [] }
    async resolveModelInfo(): Promise<never> { throw new Error('resolveModelInfo: unknown route') }
    async resolveCallConfig() { return { provider: 'x', model: 'y' } }
  }

  /** Events whose plannerRouting record names the reload re-arm. */
  function rearmEvents(store: { readonly storeDir: string; readonly root: { readonly id: string } }): RunEvent[] {
    return eventsOf(store).filter(event => {
      const detail = event.detail as { plannerRouting?: { why?: readonly string[] } } | undefined
      return detail?.plannerRouting?.why?.some(entry => entry.includes('re-armed after an engine reload')) ?? false
    })
  }

  /** Park a locked-planner run in planning, then kill the engine mid-planning. */
  async function parkedRun(): Promise<ReturnType<typeof makeHarness>> {
    const installer = stubInstaller()
    const h = makeHarness({ config: LOCKED_PLANNER, rootCtx: ROOT_CTX, routing: { modelSelectionInstaller: installer.port } })
    await h.engine.init(h.root, makeTriage())
    await h.engine.submitPlan(h.root, 'plan v1')
    expect(installer.calls).toHaveLength(1)
    await h.engine.dispose()
    expect(installer.disposes()).toBe(1)
    return h
  }

  it('engine load re-installs from CURRENT facts exactly once, and the next planning-phase commit records the re-arm durably', async () => {
    const h = await parkedRun()
    const installer2 = stubInstaller()
    const agents = new FakeAgents()
    const root2 = fakeAgent(h.root.id, undefined, undefined, ROOT_CTX)
    agents.add(root2)
    const engine2 = new AutopilotEngine(
      agents, stubSubagents(), new RunStore(h.storeDir), resolveConfig(LOCKED_PLANNER), () => true, {},
      { modelSelectionInstaller: installer2.port },
    )

    // The first observation of the parked run (engine load) re-arms...
    expect(engine2.peek(h.root.id)?.phase).toBe('planning')
    await vi.waitFor(() => expect(installer2.calls).toHaveLength(1))
    expect(installer2.calls[0]?.agentCtx).toBe(ROOT_CTX)
    expect(installer2.calls[0]?.route).toEqual(LOCKED_ROUTE)
    // ...so the live status agrees with the durable stream again.
    expect(engine2.status(root2)?.plannerRouting?.status).toBe('routed')

    // The next planning-phase op does NOT install again — exactly once —
    await engine2.submitPlan(root2, 'plan v2')
    expect(installer2.calls).toHaveLength(1)
    // ...and its commit carries the one-shot durable re-arm record.
    const stamped = rearmEvents(h)
    expect(stamped).toHaveLength(1)
    expect(stamped[0]?.op).toBe('submit-plan')

    // The plan-gate pass then disposes the re-armed install, exactly once.
    await engine2.selfCheck(root2, { role: 'plan', verdict: 'pass', note: 'ok' })
    expect(engine2.peek(h.root.id)?.phase).toBe('executing')
    expect(installer2.disposes()).toBe(1)
    await engine2.dispose()
    expect(installer2.disposes()).toBe(1)
  })

  it('when the root is not observable at load, the next planning-phase op re-arms and records the named gap on its own commit', async () => {
    const h = await parkedRun()
    const installer2 = stubInstaller()
    const agents = new FakeAgents()
    const engine2 = new AutopilotEngine(
      agents, stubSubagents(), new RunStore(h.storeDir), resolveConfig(LOCKED_PLANNER), () => true, {},
      { modelSelectionInstaller: installer2.port },
    )

    // A read-only touch loads the parked run with NO live root registered:
    // arming now would falsely degrade, so nothing fires yet...
    expect(engine2.peek(h.root.id)?.phase).toBe('planning')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(installer2.calls).toHaveLength(0)

    // ...until the first planning-phase op, whose commit re-arms from its
    // resolveRoot-verified live agent and records the reload once.
    const root2 = fakeAgent(h.root.id, undefined, undefined, ROOT_CTX)
    agents.add(root2)
    await engine2.submitPlan(root2, 'plan v2')
    expect(installer2.calls).toHaveLength(1)
    const stamped = rearmEvents(h)
    expect(stamped).toHaveLength(1)
    expect(stamped[0]?.op).toBe('submit-plan')
    await engine2.selfCheck(root2, { role: 'plan', verdict: 'pass', note: 'ok' })
    expect(installer2.disposes()).toBe(1)
  })

  it('a reload whose locked route is no longer live records the degradation honestly instead of resurrecting the install', async () => {
    const h = await parkedRun()
    // The restarted process sees a catalog where the locked provider is GONE.
    const dead = new RouteCatalog(new FixedLlm(['other-provider']))
    const installer2 = stubInstaller()
    const agents = new FakeAgents()
    const root2 = fakeAgent(h.root.id, undefined, undefined, ROOT_CTX)
    agents.add(root2)
    const engine2 = new AutopilotEngine(
      agents, stubSubagents(), new RunStore(h.storeDir), resolveConfig(LOCKED_PLANNER), () => true, {},
      { catalog: dead, modelSelectionInstaller: installer2.port },
    )

    expect(engine2.peek(h.root.id)?.phase).toBe('planning')
    await vi.waitFor(() => expect(engine2.status(root2)?.plannerRouting).toBeDefined())
    const status = engine2.status(root2)?.plannerRouting
    expect(status?.status).toBe('unsupported')
    expect(status?.route).toEqual(LOCKED_ROUTE)
    expect(status?.why?.join('\n')).toContain('no live provider')
    expect(installer2.calls).toHaveLength(0)

    // The next commit records the degraded re-arm durably, once; the run continues.
    await engine2.submitPlan(root2, 'plan v2')
    const stamped = rearmEvents(h)
    expect(stamped).toHaveLength(1)
    expect((stamped[0]?.detail as { plannerRouting?: { status?: string } } | undefined)?.plannerRouting?.status).toBe('unsupported')
    await engine2.selfCheck(root2, { role: 'plan', verdict: 'pass', note: 'ok' })
    expect(engine2.peek(h.root.id)?.phase).toBe('executing')
  })

  it('the shipped default (planner inherit) reloads with no re-arm work at all', async () => {
    const h = makeHarness({ rootCtx: ROOT_CTX })
    await h.engine.init(h.root, makeTriage())
    await h.engine.submitPlan(h.root, 'plan v1')
    await h.engine.dispose()

    const installer2 = stubInstaller()
    const agents = new FakeAgents()
    const root2 = fakeAgent(h.root.id, undefined, undefined, ROOT_CTX)
    agents.add(root2)
    const engine2 = new AutopilotEngine(
      agents, stubSubagents(), new RunStore(h.storeDir), resolveConfig(), () => true, {},
      { modelSelectionInstaller: installer2.port },
    )
    expect(engine2.peek(h.root.id)?.phase).toBe('planning')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(installer2.calls).toHaveLength(0)
    expect(engine2.status(root2)?.plannerRouting).toBeUndefined()
    await engine2.submitPlan(root2, 'plan v2')
    expect(installer2.calls).toHaveLength(0)
    expect(rearmEvents(h)).toHaveLength(0)
  })
})

// ── F3 (PR #2 Codex review): the installer import settles BEFORE the engine exists ──
//
// The defect: `createRoutingWiring`'s dynamic import of the host's
// `installModelSelection` was fire-and-forget, and `apply()` constructed the
// engine immediately — a run entering planning at cold mount recorded
// `plannerRouting: 'unsupported'` ("no modelSelectionInstaller port is wired")
// on a perfectly healthy host and never retried within the planning phase.
// The decided fix is the mount-ordering one: `apply()` awaits the wiring's
// `installerReady` promise before constructing the engine, so the port is
// known (or honestly `undefined`) by the time any run can exist. The mock
// below delays the module on purpose — the mount must be observed WAITING on
// it, then the first planning commit must find the install LIVE.

const slowImport = vi.hoisted(() => {
  const calls: Array<{ agentCtx: unknown; route: { provider: string; model: string } }> = []
  let disposes = 0
  return {
    calls,
    disposes: () => disposes,
    installModelSelection(
      agentCtx: unknown,
      selection: { current: { provider: string; model: string; reasoningEffort?: string } | undefined },
    ): () => void {
      calls.push({ agentCtx, route: { ...(selection.current as { provider: string; model: string }) } })
      return () => {
        disposes += 1
        selection.current = undefined
      }
    },
  }
})

vi.mock('@deepseek-ai/dsh-agent', () => new Promise(resolve => {
  // The simulated slow import: the factory resolves only after the timer,
  // exactly like a cold dynamic import landing behind other module work.
  setTimeout(() => resolve({ installModelSelection: slowImport.installModelSelection }), 30)
}))

describe('F3 (PR #2 review): a slow installer import cannot lose the planner route at cold mount', () => {
  /** A minimal fake host for apply(): one root agent, recorded tools, no services. */
  function fakeHost(storeRoot: string) {
    const toolDefs: Array<{ name?: string; execute?: (args: unknown, exec: unknown) => Promise<unknown> }> = []
    const agentTools = {
      register(definition: unknown) {
        toolDefs.push(definition as never)
        return () => {}
      },
      guard() { return () => {} },
    }
    const rootAgent = {
      id: 'root-session-1',
      // The scoped ctx IS the planner install target (armPlannerSelection
      // passes the root agent's own ctx to the installer).
      ctx: { tools: agentTools, on: () => () => {} },
      session: { header: {}, snapshotEvents: () => [] as Array<{ type: string; data: unknown }>, append() {} },
      followup() {},
    }
    const created: Array<(payload: { agent: unknown }) => void> = []
    const disposed: Array<(payload: { agent: unknown }) => void> = []
    const ctx = {
      agents: {
        get: (id: string) => (id === rootAgent.id ? rootAgent : undefined),
        list: () => [rootAgent],
        roots: () => [rootAgent as unknown],
      },
      subagents: stubSubagents(),
      systemPrompt: { section: () => () => {} },
      provide: () => () => {},
      logger: { warn() {} },
      on(event: string, listener: (payload: { agent: unknown }) => void) {
        if (event === 'agent/created') created.push(listener)
        if (event === 'agent/disposed') disposed.push(listener)
        return () => {}
      },
    }
    return { ctx, toolDefs, rootAgent, storeRoot }
  }

  it('apply() holds the mount open on the slow import, then the first planning run is INSTALLED (not unsupported)', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'dsh-autopilot-f3-'))
    const host = fakeHost(storeRoot)
    const mount = apply(host.ctx, {
      storeRoot,
      storeKind: 'file',
      skillInstall: 'off',
      routing: { roles: { planner: { mode: 'locked', lock: { provider: 'planner-p', model: 'planner-m' } } } },
    })

    // While the 30ms import is in flight the mount is STILL pending — the
    // engine (and every autopilot surface) must not exist yet. This is the
    // window in which the fire-and-forget shape used to construct the engine.
    let settled = false
    void mount.then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    expect(host.toolDefs.length).toBe(0)
    expect(slowImport.calls).toHaveLength(0)

    const dispose = await mount
    expect(settled).toBe(true)

    // An IMMEDIATE planning run on the freshly mounted engine: the locked
    // planner route must be installed through the (now settled) port — the
    // exact run that recorded 'unsupported' before the fix.
    const init = host.toolDefs.find(definition => definition.name === 'autopilot_init')
    expect(init?.execute).toBeDefined()
    const execute = init?.execute
    if (execute === undefined) throw new Error('inject: autopilot_init tool was not registered')
    await execute(
      {
        objective: 'o', scope: ['src/'], nonGoals: ['docs/'], acceptanceCriteria: ['tests pass'],
        risk: 'low', size: 'lightweight', executionMode: 'inline', auditMode: 'self-check',
      },
      { agent: host.rootAgent },
    )
    expect(slowImport.calls).toHaveLength(1)
    expect(slowImport.calls[0]?.agentCtx).toBe(host.rootAgent.ctx)
    expect(slowImport.calls[0]?.route).toEqual({ provider: 'planner-p', model: 'planner-m' })

    // And the durable init event says ROUTED, not unsupported.
    const stream = readFileSync(join(storeRoot, 'runs', host.rootAgent.id, 'events.jsonl'), 'utf8')
      .trim().split(String.fromCharCode(10)).map(line => JSON.parse(line) as RunEvent)
    const plannerRouting = (stream[0]?.detail as { plannerRouting?: { status?: string } } | undefined)?.plannerRouting
    expect(plannerRouting?.status).toBe('routed')

    await dispose()
    expect(slowImport.disposes()).toBe(1)
  })
})

// ── F4 (PR #2 Codex review, round 2): the planner install follows live routing patches mid-planning ──
//
// The defect: the commit chokepoint armed the planner install ONCE per
// planning window (`!plannerInstalls.has(runId)`), so after E9's F2 made the
// routing values live, a volatile patch to `routing.roles.planner` (or
// `routing.mode`) mid-planning left the stale install active — or an inherited
// planner unrouted — until the run left planning. The fix re-resolves the
// decision from CURRENT facts at every planning-phase commit and, when it
// CHANGED (decision kind, or full route identity), disposes the old install
// and re-arms, with the from→to transition recorded on that commit's
// `plannerRouting` detail. An UNCHANGED decision churns nothing: no dispose,
// no install, no record — the arm-once economics of a steady planning window.

describe('F4 (PR #2 review, round 2): the planner install follows live routing patches mid-planning', () => {
  const PATCHED_LOCK = {
    routing: {
      roles: {
        planner: {
          mode: 'locked' as const,
          lock: { provider: 'other-p', model: 'other-m' },
        },
      },
    },
  }
  const PATCHED_ROUTE = { provider: 'other-p', model: 'other-m' }

  /** A stateful installer whose failures are toggled per call (re-arm fixtures). */
  function toggleInstaller(): {
    readonly port: NonNullable<RoutingPorts['modelSelectionInstaller']>
    readonly calls: InstallCall[]
    readonly failNext: { value: boolean }
    readonly disposes: () => number
  } {
    const calls: InstallCall[] = []
    let disposes = 0
    const failNext = { value: false }
    const port: NonNullable<RoutingPorts['modelSelectionInstaller']> = (agentCtx, route) => {
      calls.push({ agentCtx, route: { ...route } })
      if (failNext.value) throw new Error('install slot busy')
      return () => {
        disposes += 1
      }
    }
    return { port, calls, failNext, disposes: () => disposes }
  }

  /** A planner-volatile harness: the routing section is a mutable live source. */
  function volatilePlanner(port?: NonNullable<RoutingPorts['modelSelectionInstaller']>): {
    readonly engine: AutopilotEngine
    readonly root: ReturnType<typeof fakeAgent>
    readonly storeDir: string
    readonly installer: ReturnType<typeof stubInstaller>
    readonly patch: (config: Parameters<typeof resolveConfig>[0]) => void
  } {
    const installer = stubInstaller()
    const storeDir = mkdtempSync(join(tmpdir(), 'dsh-autopilot-f4-'))
    const agents = new FakeAgents()
    const root = fakeAgent('root-1', undefined, undefined, ROOT_CTX)
    agents.add(root)
    let routing = resolveConfig(LOCKED_PLANNER).routing
    const engine = new AutopilotEngine(
      agents, stubSubagents(), new RunStore(storeDir), resolveConfig(LOCKED_PLANNER), () => true, {},
      { modelSelectionInstaller: port ?? installer.port },
      () => routing,
    )
    return {
      engine, root, storeDir, installer,
      patch: config => {
        routing = resolveConfig(config).routing
      },
    }
  }

  /** Events whose plannerRouting record names the mid-planning refresh. */
  function refreshEvents(h: { readonly storeDir: string; readonly root: { readonly id: string } }): RunEvent[] {
    return eventsOf(h).filter(event => {
      const detail = event.detail as { plannerRouting?: { why?: readonly string[] } } | undefined
      return detail?.plannerRouting?.why?.some(entry => entry.includes('install refreshed mid-planning')) ?? false
    })
  }

  it('a lock patched mid-planning is followed at the next planning commit: old disposed, new installed, from→to recorded', async () => {
    const h = volatilePlanner()
    await h.engine.init(h.root, makeTriage())
    expect(h.installer.calls).toHaveLength(1)
    h.patch(PATCHED_LOCK)
    await h.engine.submitPlan(h.root, 'plan v2')
    // The install follows the new route: exactly one dispose, one new install.
    expect(h.installer.calls).toHaveLength(2)
    expect(h.installer.calls[1]?.route).toEqual(PATCHED_ROUTE)
    expect(h.installer.disposes()).toBe(1)
    expect(h.engine.status(h.root)?.plannerRouting).toEqual({
      status: 'routed',
      route: PATCHED_ROUTE,
      why: expect.any(Array),
    })
    // The deciding commit carries the from→to refresh record, durably.
    const stamped = refreshEvents(h)
    expect(stamped).toHaveLength(1)
    expect(stamped[0]?.op).toBe('submit-plan')
    const note = (stamped[0]?.detail as { plannerRouting?: { why?: readonly string[] } } | undefined)?.plannerRouting?.why?.join('\n') ?? ''
    expect(note).toContain('install refreshed mid-planning')
    expect(note).toContain('routed planner-p/planner-m @ high') // the from
    expect(note).toContain('routed other-p/other-m') // the to
    // And the run completes normally on the refreshed install.
    await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'ok' })
    expect(h.engine.peek(h.root.id)?.phase).toBe('executing')
    expect(h.installer.disposes()).toBe(2)
  })

  it('a patch to inherit mid-planning disposes the install and records the transition; nothing projects live', async () => {
    const h = volatilePlanner()
    await h.engine.init(h.root, makeTriage())
    expect(h.installer.calls).toHaveLength(1)
    h.patch({ routing: { roles: { planner: { mode: 'inherit' } } } })
    await h.engine.submitPlan(h.root, 'plan v2')
    // Inherit arms nothing: the old install is disposed and NOT replaced.
    expect(h.installer.calls).toHaveLength(1)
    expect(h.installer.disposes()).toBe(1)
    expect(h.engine.status(h.root)?.plannerRouting).toBeUndefined()
    // The disposal is still recorded durably — the `inherit` transition record.
    const stamped = refreshEvents(h)
    expect(stamped).toHaveLength(1)
    const record = (stamped[0]?.detail as { plannerRouting?: { status?: string; why?: readonly string[] } } | undefined)?.plannerRouting
    expect(record?.status).toBe('inherit')
    expect(record?.why?.join('\n')).toContain('routed planner-p/planner-m @ high')
    expect(record?.why?.join('\n')).toContain('→ inherit')
    // The run continues: the gate passes and no second dispose fires.
    await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'ok' })
    expect(h.engine.peek(h.root.id)?.phase).toBe('executing')
    expect(h.installer.disposes()).toBe(1)
  })

  it('unchanged config churns nothing: no re-install, no dispose, no refresh record (installer call count stable)', async () => {
    const h = volatilePlanner()
    await h.engine.init(h.root, makeTriage())
    await h.engine.submitPlan(h.root, 'plan v1')
    await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'needs-replan', note: 'weak verification' })
    await h.engine.submitPlan(h.root, 'plan v2')
    expect(h.installer.calls).toHaveLength(1)
    expect(h.installer.disposes()).toBe(0)
    expect(refreshEvents(h)).toHaveLength(0)
    // Re-resolving the SAME config (a no-op patch) is still no churn.
    h.patch(LOCKED_PLANNER)
    await h.engine.submitPlan(h.root, 'plan v3')
    expect(h.installer.calls).toHaveLength(1)
    expect(h.installer.disposes()).toBe(0)
    expect(refreshEvents(h)).toHaveLength(0)
  })

  it('an effort-only lock patch is still a changed decision: the install is refreshed', async () => {
    const h = volatilePlanner()
    await h.engine.init(h.root, makeTriage())
    h.patch({
      routing: {
        roles: {
          planner: { mode: 'locked', lock: { provider: 'planner-p', model: 'planner-m', reasoningEffort: 'low' } },
        },
      },
    })
    await h.engine.submitPlan(h.root, 'plan v2')
    expect(h.installer.calls).toHaveLength(2)
    expect(h.installer.calls[1]?.route).toEqual({ provider: 'planner-p', model: 'planner-m', reasoningEffort: 'low' })
    expect(h.installer.disposes()).toBe(1)
    const note = (refreshEvents(h)[0]?.detail as { plannerRouting?: { why?: readonly string[] } } | undefined)?.plannerRouting?.why?.join('\n') ?? ''
    expect(note).toContain('routed planner-p/planner-m @ high')
    expect(note).toContain('routed planner-p/planner-m @ low')
  })

  it('a re-arm whose install FAILS degrades to recorded unsupported — the run never throws', async () => {
    const installer = toggleInstaller()
    const h = volatilePlanner(installer.port)
    await h.engine.init(h.root, makeTriage())
    expect(installer.calls).toHaveLength(1)
    h.patch(PATCHED_LOCK)
    installer.failNext.value = true
    await h.engine.submitPlan(h.root, 'plan v2') // must not throw
    // The old install was disposed; the failed re-arm degrades honestly.
    expect(installer.calls).toHaveLength(2)
    expect(installer.disposes()).toBe(1)
    const status = h.engine.status(h.root)?.plannerRouting
    expect(status?.status).toBe('unsupported')
    expect(status?.route).toEqual(PATCHED_ROUTE)
    expect(status?.why?.join('\n')).toContain('install slot busy')
    expect(status?.why?.join('\n')).toContain('install refreshed mid-planning')
    // The degradation is durable on the commit, and the run continues.
    expect(refreshEvents(h)).toHaveLength(1)
    await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'ok' })
    expect(h.engine.peek(h.root.id)?.phase).toBe('executing')
    expect(installer.disposes()).toBe(1) // the failed arm left no disposer to fire
  })
})

// ── F25 (PR #2 Codex round 13): planner installs must not reappear during teardown ──
//
// dispose() swept the planner installs once, then waited for the in-flight
// transaction tail — but a transaction awaiting planner route resolution
// (catalog/policy awaits that never observe the abort) could land its arm
// AFTER the sweep, leaving a live model selection that survives the plugin
// unload/reload. Two-sided fix, defense in depth: the ARM GUARD refuses any
// install once the lifecycle signal aborted (recording the refusal honestly
// as `unsupported` on the deciding commit's durable detail), and dispose()
// RE-SWEEPS after the tail settles, so it owns the zero-live-installs
// invariant mechanically instead of trusting the guard alone.

describe('F25: planner installs cannot reappear during dispose()', () => {
  /** A gated `ctx.llm` subset: every async catalog read/preflight awaits the current gate. */
  class GatedLlm implements LlmRuntimeSubset {
    private gate: Promise<void> = Promise.resolve()
    /** Make every subsequent async read hang until `promise` settles. */
    hangOn(promise: Promise<void>): void { this.gate = promise }
    listProviders() { return [{ id: 'planner-p', name: 'planner-p' }] }
    async listModels(): Promise<readonly LlmModelInfo[]> {
      await this.gate
      return [{ provider: 'planner-p', id: 'planner-m', name: 'planner-m' }]
    }
    async resolveModelInfo(): Promise<LlmResolvedModelInfo> {
      await this.gate
      return { provider: 'planner-p', id: 'planner-m', name: 'planner-m' }
    }
    async resolveCallConfig(config: LlmCallConfig): Promise<LlmCallConfig> {
      await this.gate
      return config
    }
  }

  /** A deferred the test releases on purpose. */
  function deferred(): { promise: Promise<void>; release: () => void } {
    let release!: () => void
    const promise = new Promise<void>(resolve => { release = resolve })
    return { promise, release }
  }

  it('an arm still resolving when dispose() swept is refused: never installed, refusal recorded honestly on the durable event', async () => {
    const installer = stubInstaller()
    const llm = new GatedLlm()
    const catalog = new RouteCatalog(llm)
    const slow = deferred()
    llm.hangOn(slow.promise)
    const h = makeHarness({ config: LOCKED_PLANNER, rootCtx: ROOT_CTX, routing: { modelSelectionInstaller: installer.port, catalog } })

    // init's commit enters the planner arm and hangs on the catalog read...
    const initCall = h.engine.init(h.root, makeTriage())
    // ...the engine is torn down under it (abort + first sweep + tail wait)...
    const disposeCall = h.engine.dispose()
    // ...and only THEN does the resolution land — post-abort, post-sweep.
    slow.release()
    await disposeCall
    await initCall

    // The arm was refused after the abort: the installer was NEVER called, so
    // no model selection exists for teardown to have missed, and dispose()
    // returned with zero live installs (the re-sweep finds nothing because
    // the guard already refused — defense in depth holds either way).
    expect(installer.calls).toHaveLength(0)
    expect(installer.disposes()).toBe(0)
    // The refusal is the honest durable record on the deciding (init) event...
    const record = initEventDetail(h)?.plannerRouting
    expect(record?.status).toBe('unsupported')
    expect(record?.route).toEqual(LOCKED_ROUTE)
    expect(record?.why?.join('\n')).toContain('the engine was disposed while the route was resolving')
    // ...the run itself completed normally, and the disposed state projects
    // nothing on the live status surface (the absent field is the honest record).
    expect(h.engine.peek(h.root.id)?.phase).toBe('planning')
    expect(h.engine.status(h.root)?.plannerRouting).toBeUndefined()
  })

  it('a live install is swept by dispose() while a REFRESH of it is still resolving; the refresh arms nothing after', async () => {
    const installer = stubInstaller()
    const llm = new GatedLlm()
    const catalog = new RouteCatalog(llm)
    const storeDir = mkdtempSync(join(tmpdir(), 'dsh-autopilot-f25-'))
    const agents = new FakeAgents()
    const root = fakeAgent('root-1', undefined, undefined, ROOT_CTX)
    agents.add(root)
    let routing = resolveConfig(LOCKED_PLANNER).routing
    const engine = new AutopilotEngine(
      agents, stubSubagents(), new RunStore(storeDir), resolveConfig(LOCKED_PLANNER), () => true, {},
      { modelSelectionInstaller: installer.port, catalog },
      () => routing,
    )

    // Armed normally at init (the gate starts open)...
    await engine.init(root, makeTriage())
    expect(installer.calls).toHaveLength(1)

    // ...then the lock is patched mid-planning and the catalog read goes
    // slow, so the next planning commit's REFRESH hangs mid-resolution.
    const slow = deferred()
    catalog.invalidate()
    llm.hangOn(slow.promise)
    routing = resolveConfig({
      routing: { roles: { planner: { mode: 'locked' as const, lock: { provider: 'other-p', model: 'other-m' } } } },
    }).routing
    const submitCall = engine.submitPlan(root, 'plan v2')

    const disposeCall = engine.dispose() // the first sweep takes the LIVE install
    slow.release() // the refresh resolution lands — post-abort
    await disposeCall
    await submitCall

    // Only the init install ever existed: swept exactly once by dispose's
    // sweep, and the post-abort refresh armed nothing (guard) — zero live
    // installs when dispose() returned, and none appeared after.
    expect(installer.calls).toHaveLength(1)
    expect(installer.disposes()).toBe(1)
    expect(engine.peek(root.id)?.phase).toBe('planning')
  })

  it('a clean dispose does not poison the next engine: reload re-arm still works (the guard is per-lifecycle)', async () => {
    const installer = stubInstaller()
    const h = makeHarness({ config: LOCKED_PLANNER, rootCtx: ROOT_CTX, routing: { modelSelectionInstaller: installer.port } })
    await h.engine.init(h.root, makeTriage())
    expect(installer.calls).toHaveLength(1)
    await h.engine.dispose() // clean: the live install is swept exactly once
    expect(installer.disposes()).toBe(1)

    const installer2 = stubInstaller()
    const agents = new FakeAgents()
    const root2 = fakeAgent(h.root.id, undefined, undefined, ROOT_CTX)
    agents.add(root2)
    const engine2 = new AutopilotEngine(
      agents, stubSubagents(), new RunStore(h.storeDir), resolveConfig(LOCKED_PLANNER), () => true, {},
      { modelSelectionInstaller: installer2.port },
    )
    expect(engine2.peek(h.root.id)?.phase).toBe('planning')
    // P2-3 reload re-arm fires on the fresh lifecycle, un-refused.
    await vi.waitFor(() => expect(installer2.calls).toHaveLength(1))
    expect(installer2.calls[0]?.route).toEqual(LOCKED_ROUTE)
    await engine2.dispose()
    expect(installer2.disposes()).toBe(1)
  })
})
