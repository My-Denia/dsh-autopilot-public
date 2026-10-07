/**
 * M3b engine integration: role-true routing at the dispatch seams.
 *
 * Stub ports at the structural boundary (RouteCatalog over a stub
 * `LlmRuntimeSubset`, a policyReader closure) drive the REAL engine through
 * audit()/startExecutor()/resumeExecutor() and assert on the durable stream:
 * `detail.routing` on dispatch commits, `snapshot.routingPins`, RouteRecord
 * fields, and the escalation transitions. The plan's decision KINDS are
 * asserted exactly (route / inherit / escalate-owner / blocked), never as a
 * boolean.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AutopilotEngine } from '../src/engine.js'
import type { AgentOptionsLike, RoutingPorts } from '../src/engine.js'
import { createRoutingWiring, resolveConfig } from '../src/index.js'
import { RouteCatalog } from '../src/routing/catalog.js'
import type { LlmCallConfig, LlmRuntimeSubset } from '../src/routing/catalog.js'
import type { SessionPolicyState } from '../src/routing/authorize.js'
import { selectRoute } from '../src/routing/select.js'
import { foldRun } from '../src/domain/fold.js'
import { RunStore } from '../src/store/file.js'
import type { RoutingDecisionDetail, RunEvent, Snapshot } from '../src/domain/types.js'
import { fakeAgent, makeHarness, makeTriage, makeUsageEntry, stubSubagents, undeclaredSeed, FakeAgents } from './helpers.js'
import type { Harness } from './helpers.js'

// ── Stub at the structural boundary (mutable for adapter-loss fixtures) ──

interface StubModel {
  readonly provider: string
  readonly id: string
  readonly contextWindow?: number
  readonly efforts?: readonly string[]
  readonly defaultEffort?: string
}

class StubLlm implements LlmRuntimeSubset {
  private readonly live: Set<string>
  public readonly preflights: LlmCallConfig[] = []

  constructor(private readonly models: readonly StubModel[]) {
    this.live = new Set(models.map(model => model.provider))
  }

  /** Simulate `llm/adapters-updated` removing a provider from the deployment. */
  dropProvider(provider: string): void {
    this.live.delete(provider)
  }

  listProviders() {
    return [...this.live].map(id => ({ id, name: id }))
  }

  async listModels(provider: string) {
    return this.models
      .filter(model => model.provider === provider)
      .map(model => ({ provider, id: model.id, name: model.id }))
  }

  async resolveModelInfo(provider: string, model: string) {
    const hit = this.models.find(candidate => candidate.provider === provider && candidate.id === model)
    if (hit === undefined) throw new Error(`resolveModelInfo: unknown route ${provider}/${model}`)
    const hasReasoning = (hit.efforts?.length ?? 0) > 0 || hit.defaultEffort !== undefined
    return {
      provider,
      id: model,
      name: model,
      ...(hit.contextWindow !== undefined ? { context: { contextWindow: hit.contextWindow } } : {}),
      ...(hasReasoning
        ? {
            reasoning: {
              efforts: (hit.efforts ?? []).map(effort => ({ id: effort, name: effort })),
              ...(hit.defaultEffort !== undefined ? { defaultEffort: hit.defaultEffort } : {}),
            },
          }
        : {}),
    }
  }

  async resolveCallConfig(config: LlmCallConfig) {
    this.preflights.push(config)
    return { ...config }
  }
}

interface Fixture {
  readonly llm: StubLlm
  readonly catalog: RouteCatalog
  policy: SessionPolicyState
}

function fixture(models: readonly StubModel[], policy: SessionPolicyState): Fixture & { portsFor: () => RoutingPorts } {
  const llm = new StubLlm(models)
  const catalog = new RouteCatalog(llm)
  const state: Fixture = { llm, catalog, policy }
  return {
    ...state,
    portsFor: () => ({
      catalog,
      policyReader: () => state.policy,
    }),
  }
}

const MODELS: readonly StubModel[] = [
  { provider: 'alpha', id: 'm-a', contextWindow: 131072, efforts: ['high'], defaultEffort: 'high' },
  { provider: 'alpha', id: 'm-b', contextWindow: 131072 },
  { provider: 'beta', id: 'm-c', contextWindow: 200000, efforts: ['high'], defaultEffort: 'high' },
]

const PRESENT_ABC: SessionPolicyState = {
  kind: 'present',
  routes: [{ provider: 'alpha', model: 'm-a' }, { provider: 'beta', model: 'm-c' }],
}

/** Three routes over two providers: after `beta` dies, two remain — enough to re-SELECT (not inherit). */
const PRESENT_ABC3: SessionPolicyState = {
  kind: 'present',
  routes: [{ provider: 'alpha', model: 'm-a' }, { provider: 'alpha', model: 'm-b' }, { provider: 'beta', model: 'm-c' }],
}

const ABSENT: SessionPolicyState = { kind: 'absent' }

const STANDARD = { size: 'standard', risk: 'medium', executionMode: 'inline', auditMode: 'independent' } as const
const STANDARD_DELEGATED = { ...STANDARD, executionMode: 'delegated' } as const

/** Drive an inline run to `executing` with a passed plan gate. */
async function toExecuting(h: Harness): Promise<void> {
  await h.engine.init(h.root, makeTriage(STANDARD), [undeclaredSeed('m1')])
  await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
  await h.engine.submitPlan(h.root, 'plan')
  await h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })
}

/** Drive an inline run to `closing` (one execution audit already recorded). */
async function toClosing(h: Harness): Promise<void> {
  await toExecuting(h)
  await h.engine.submitExecutionEvidence(h.root, { report: 'did the work', residualRisks: [] })
  await h.engine.audit(h.root, { role: 'execution', prompt: 'audit packet' })
}

function eventsOf(h: Harness): RunEvent[] {
  return readFileSync(join(h.storeDir, 'runs', h.root.id, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as RunEvent)
}

function routingDetails(h: Harness): Array<RoutingDecisionDetail & { op: string }> {
  return eventsOf(h)
    .filter(event => (event.detail as { routing?: unknown } | undefined)?.routing !== undefined)
    .map(event => ({
      op: event.op,
      ...((event.detail as { routing: RoutingDecisionDetail }).routing),
    }))
}

function routingOf(h: Harness, op: string, role: string): RoutingDecisionDetail | undefined {
  return routingDetails(h).find(detail => detail.op === op && detail.role === role)
}

// ── (i) auto + policy ⇒ dispatched agentOptions + pin + RouteRecord fields ──

describe('routing integration: auto mode with a session policy', () => {
  it('(i) dispatches the selected route with agentOptions, pins it in detail.routing, and records the RouteRecord fields', async () => {
    const f = fixture(MODELS, PRESENT_ABC)
    const h = makeHarness({
      routing: f.portsFor(),
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] }),
    })
    await toExecuting(h)

    // balanced preference over the authorized set: both-efforts candidates
    // first, contextWindow descending ⇒ beta/m-c (200000, defaultEffort high).
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'beta', model: 'm-c', reasoningEffort: 'high' })

    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing).toBeDefined()
    expect(routing?.pin).toEqual({ provider: 'beta', model: 'm-c', reasoningEffort: 'high' })
    expect(routing?.authorizationSource).toBe('session-policy')
    expect(routing?.why?.length ?? 0).toBeGreaterThan(0)

    const snapshot = h.engine.peek(h.root.id)
    expect(snapshot?.routingPins?.['plan-auditor']).toEqual({ provider: 'beta', model: 'm-c', reasoningEffort: 'high' })

    const record = snapshot?.audits[0]?.route
    expect(record?.selected).toEqual({ provider: 'beta', model: 'm-c', reasoningEffort: 'high' })
    expect(record?.authorizationSource).toBe('session-policy')
    expect(record?.why?.length ?? 0).toBeGreaterThan(0)
    expect(record?.routeStatus).toBe('verified')
    // The executor route is not observable on this run: no honest achieved claim.
    expect(record?.crossFamily).toBe('unknown-family')
  })

  it('(ii) no policy ⇒ inheritance: no agentOptions, no pin, no authorizationSource', async () => {
    const f = fixture(MODELS, ABSENT)
    const h = makeHarness({
      routing: f.portsFor(),
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] }),
    })
    await toExecuting(h)

    expect(h.subagents.auditOptions[0]).toBeUndefined()
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing).toBeDefined()
    expect(routing?.pin).toBeUndefined()
    expect(routing?.authorizationSource).toBeUndefined()
    expect(routing?.why?.some(entry => entry.includes('inheritance'))).toBe(true)
    expect(h.engine.peek(h.root.id)?.routingPins).toBeUndefined()
    expect(h.engine.peek(h.root.id)?.audits[0]?.route.selected).toBeUndefined()
  })
})

// ── (iii) lock conflict ⇒ needs-owner-decision, no dispatch ──

describe('routing integration: locked outside the policy', () => {
  it('(iii) escalates to needs-owner-decision and never dispatches', async () => {
    const f = fixture(MODELS, PRESENT_ABC)
    const h = makeHarness({
      routing: f.portsFor(),
      config: { routing: { mode: 'auto', roles: { planAuditor: { mode: 'locked', lock: { provider: 'gamma', model: 'm-g' } } } } },
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'never reached' }] }),
    })
    await h.engine.init(h.root, makeTriage(STANDARD), [undeclaredSeed('m1')])
    await h.engine.submitPlan(h.root, 'plan')
    await expect(h.engine.audit(h.root, { role: 'plan', prompt: 'packet' }))
      .rejects.toThrowError(/two owner grants conflict/)
    const snapshot = h.engine.peek(h.root.id)
    expect(snapshot?.phase).toBe('needs-owner-decision')
    expect(snapshot?.diagnostic?.startsWith('routing-escalation:')).toBe(true)
    expect(h.subagents.auditOptions.length).toBe(0)
    expect(routingOf(h, 'audit', 'plan-auditor')).toBeUndefined()
  })
})

// ── (iv) repin on adapter loss ──

describe('routing integration: repin on adapter loss', () => {
  it('(iv-a) auto pin whose provider died ⇒ re-select with repinFrom recorded', async () => {
    const f = fixture(MODELS, PRESENT_ABC3)
    const h = makeHarness({
      routing: f.portsFor(),
      subagents: stubSubagents({ verdicts: [
        { verdict: 'pass', note: 'plan ok' },
        { verdict: 'pass', note: 'exec ok' },
        { verdict: 'pass', note: 'exec ok again' },
      ] }),
    })
    await toClosing(h)
    const firstPin = h.engine.peek(h.root.id)?.routingPins?.['execution-auditor']
    expect(firstPin).toEqual({ provider: 'beta', model: 'm-c', reasoningEffort: 'high' })

    f.llm.dropProvider('beta')
    f.catalog.invalidate()

    await h.engine.audit(h.root, { role: 'execution', prompt: 'again' })
    expect(h.subagents.auditOptions[2]).toEqual({ provider: 'alpha', model: 'm-a', reasoningEffort: 'high' })
    const details = routingDetails(h).filter(detail => detail.role === 'execution-auditor')
    const last = details[details.length - 1]
    expect(last?.repinFrom).toEqual(firstPin)
    expect(last?.pin).toEqual({ provider: 'alpha', model: 'm-a', reasoningEffort: 'high' })
    expect(last?.why?.some(entry => entry.includes('no longer live'))).toBe(true)
    expect(h.engine.peek(h.root.id)?.routingPins?.['execution-auditor'])
      .toEqual({ provider: 'alpha', model: 'm-a', reasoningEffort: 'high' })
  })

  it('(iv-b) auto pin with an EMPTY live authorized set ⇒ inheritance recorded, pin cleared', async () => {
    const f = fixture(MODELS, PRESENT_ABC)
    const h = makeHarness({
      routing: f.portsFor(),
      subagents: stubSubagents({ verdicts: [
        { verdict: 'pass', note: 'plan ok' },
        { verdict: 'pass', note: 'exec ok' },
        { verdict: 'pass', note: 'exec ok again' },
      ] }),
    })
    await toClosing(h)
    expect(h.engine.peek(h.root.id)?.routingPins?.['execution-auditor']).toBeDefined()

    f.llm.dropProvider('alpha')
    f.llm.dropProvider('beta')
    f.catalog.invalidate()

    await h.engine.audit(h.root, { role: 'execution', prompt: 'again' })
    expect(h.subagents.auditOptions[2]).toBeUndefined()
    const details = routingDetails(h).filter(detail => detail.role === 'execution-auditor')
    const last = details[details.length - 1]
    expect(last?.pin).toBeUndefined()
    expect(last?.repinFrom).toBeDefined()
    expect(last?.why?.some(entry => entry.includes('EMPTY'))).toBe(true)
    expect(h.engine.peek(h.root.id)?.routingPins?.['execution-auditor']).toBeUndefined()
  })

  it('(iv-c) locked pin whose provider died ⇒ escalation, no dispatch', async () => {
    const f = fixture(MODELS, PRESENT_ABC)
    const h = makeHarness({
      routing: f.portsFor(),
      config: { routing: { roles: { executionAuditor: { mode: 'locked', lock: { provider: 'alpha', model: 'm-a' } } } } },
      subagents: stubSubagents({ verdicts: [
        { verdict: 'pass', note: 'plan ok' },
        { verdict: 'pass', note: 'exec ok' },
        { verdict: 'pass', note: 'never reached' },
      ] }),
    })
    await toClosing(h)
    expect(h.subagents.auditOptions[1]).toEqual({ provider: 'alpha', model: 'm-a' })

    f.llm.dropProvider('alpha')
    f.catalog.invalidate()

    await expect(h.engine.audit(h.root, { role: 'execution', prompt: 'again' }))
      .rejects.toThrowError(/no live provider/)
    const snapshot = h.engine.peek(h.root.id)
    expect(snapshot?.phase).toBe('needs-owner-decision')
    expect(snapshot?.diagnostic?.startsWith('routing-escalation:')).toBe(true)
    expect(h.subagents.auditOptions.length).toBe(2)
  })
})

// ── (v) reload restores pins ──

describe('routing integration: reload restores pins', () => {
  it('(v) a cold engine over the written events replays the routing pins', async () => {
    const f = fixture(MODELS, PRESENT_ABC)
    const h = makeHarness({
      routing: f.portsFor(),
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] }),
    })
    await toExecuting(h)
    const pinned = h.engine.peek(h.root.id)?.routingPins
    expect(pinned).toBeDefined()

    const agents = new FakeAgents()
    const root = fakeAgent(h.root.id)
    agents.add(root)
    const cold = new AutopilotEngine(
      agents,
      stubSubagents(),
      new RunStore(h.storeDir),
      resolveConfig(),
      () => true,
      {},
      f.portsFor(),
    )
    const restored = cold.peek(h.root.id)
    expect(restored?.routingPins).toEqual(pinned)
  })
})

// ── (vi) legacy auditors[role].agentOptions maps to locked ──

describe('routing integration: legacy auditor config maps to a locked role', () => {
  it('(vi) dispatches the legacy route as a plugin-config grant, preserving maxTokens and naming the source', async () => {
    const f = fixture(MODELS, PRESENT_ABC)
    const h = makeHarness({
      routing: f.portsFor(),
      config: { auditors: { plan: { agentOptions: { provider: 'alpha', model: 'm-a', maxTokens: 1234 } } } },
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] }),
    })
    await toExecuting(h)

    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'alpha', model: 'm-a', maxTokens: 1234 })
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.pin).toEqual({ provider: 'alpha', model: 'm-a' })
    expect(routing?.authorizationSource).toBe('plugin-config')
    expect(routing?.why?.some(entry => entry.includes('legacy auditors.plan.agentOptions'))).toBe(true)
    expect(h.engine.peek(h.root.id)?.routingPins?.['plan-auditor']).toEqual({ provider: 'alpha', model: 'm-a' })
  })
})

// ── (vii) off mode: 0.2.0 flow + the one grant rule ──

describe('routing integration: mode off', () => {
  function offHarness(policy: SessionPolicyState, f: Fixture): Harness {
    return makeHarness({
      routing: { catalog: f.catalog, policyReader: () => policy },
      config: {
        routing: { mode: 'off' },
        executor: { agentOptions: { provider: 'alpha', model: 'm-a' } },
        crossFamily: { enabled: true, minRisk: 'medium', pool: [{ provider: 'beta', model: 'm-c' }] },
      },
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] }),
    })
  }

  it('(vii-a) pool pick INSIDE the policy dispatches with a recorded plugin-config grant', async () => {
    const f = fixture(MODELS, PRESENT_ABC)
    const h = offHarness(PRESENT_ABC, f)
    await toExecuting(h)
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'beta', model: 'm-c' })
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.pin).toEqual({ provider: 'beta', model: 'm-c' })
    expect(routing?.authorizationSource).toBe('plugin-config')
    const record = h.engine.peek(h.root.id)?.audits[0]?.route
    expect(record?.crossFamily).toBe('achieved')
  })

  it('(vii-b) pool pick OUTSIDE the policy escalates instead of dispatching', async () => {
    const f = fixture(MODELS, { kind: 'present', routes: [{ provider: 'alpha', model: 'm-a' }] })
    const h = offHarness({ kind: 'present', routes: [{ provider: 'alpha', model: 'm-a' }] }, f)
    await h.engine.init(h.root, makeTriage(STANDARD), [undeclaredSeed('m1')])
    await h.engine.submitPlan(h.root, 'plan')
    await expect(h.engine.audit(h.root, { role: 'plan', prompt: 'packet' }))
      .rejects.toThrowError(/outside the session model-selection policy/)
    expect(h.engine.peek(h.root.id)?.phase).toBe('needs-owner-decision')
    expect(h.subagents.auditOptions.length).toBe(0)
  })

  it('(vii-c) no policy ⇒ 0.2.0 parity: the pool pick dispatches', async () => {
    const f = fixture(MODELS, ABSENT)
    const h = offHarness(ABSENT, f)
    await toExecuting(h)
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'beta', model: 'm-c' })
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.authorizationSource).toBe('plugin-config')
  })
})

// ── (viii) resume carries no route fields ──

describe('routing integration: resume is descriptor-pinned, route-free', () => {
  it('(viii) resume-executor and needs-fix sendMessage carry NO route fields and do not touch the pins', async () => {
    const f = fixture(MODELS, PRESENT_ABC)
    const subagents = stubSubagents({ verdicts: [
      { verdict: 'pass', note: 'plan ok' },
      { verdict: 'needs-fix', note: 'missing test' },
    ] })
    const h = makeHarness({ routing: f.portsFor(), subagents })
    const signal = new AbortController().signal
    await h.engine.init(h.root, makeTriage(STANDARD_DELEGATED), [undeclaredSeed('m1')])
    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })
    const started = await h.engine.startExecutor(h.root, { prompt: 'implement', signal })
    const childId = started.executor?.childId as string
    h.agents.add(fakeAgent(childId, h.root.id))
    await h.engine.submitExecutionPacket(h.agents.get(childId) as never, {
      packet: 'work', residualRisks: [], executionRevision: 1,
    })
    await h.engine.audit(h.root, { role: 'execution', prompt: 'packet' })

    const pinsBefore = h.engine.peek(h.root.id)?.routingPins
    expect(pinsBefore?.executor).toBeDefined()
    await h.engine.resumeExecutor(h.root, { findings: 'add a test', nextPrompt: 'add it', signal })

    const resumeEvent = eventsOf(h).find(event => event.op === 'resume-executor')
    expect(resumeEvent).toBeDefined()
    expect((resumeEvent?.detail as { routing?: unknown } | undefined)?.routing).toBeUndefined()
    expect((h.engine.peek(h.root.id) as Snapshot).routingPins).toEqual(pinsBefore)
    // The resume transport is sendMessage: no agentOptions channel exists at all.
    expect(subagents.followups.length).toBe(1)
    // Contrast: the dispatch events DID carry routing decisions.
    expect(routingOf(h, 'start-executor', 'executor')).toBeDefined()
    expect(routingOf(h, 'audit', 'plan-auditor')).toBeDefined()
    expect(routingOf(h, 'audit', 'execution-auditor')).toBeDefined()
  })
})

// ── absent ports ⇒ 0.2.0/inherit parity with an honest record ──

describe('routing integration: absent ports', () => {
  it('auto roles inherit with unreachable-inherit recorded; a locked legacy route still dispatches (0.2.0 parity)', async () => {
    const h = makeHarness({
      config: { auditors: { plan: { agentOptions: { provider: 'alpha', model: 'm-a' } } } },
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] }),
    })
    await toExecuting(h)
    // The legacy auditor route is a locked grant: dispatched as 0.2.0 did.
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'alpha', model: 'm-a' })
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.authorizationSource).toBe('plugin-config')
    expect(routing?.why?.some(entry => entry.includes('no catalog port wired'))).toBe(true)
  })

  it('an auto role with no ports inherits and records unreachable-inherit', async () => {
    const h = makeHarness({ subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] }) })
    await toExecuting(h)
    expect(h.subagents.auditOptions[0]).toBeUndefined()
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.authorizationSource).toBe('unreachable-inherit')
  })
})

// ── Runtime wiring: createRoutingWiring over probed services ──

describe('runtime wiring (createRoutingWiring)', () => {
  /** A mini registry that actually drives a registered definition over the session log, like the real one. */
  function fakeRegistry(preRegistered?: { key: string; init: () => unknown; apply: (state: unknown, event: { type: string; data: unknown }) => unknown }) {
    const definitions = new Map<string, { key: string; init: () => unknown; apply: (state: unknown, event: { type: string; data: unknown }) => unknown }>()
    const registrations: unknown[] = []
    if (preRegistered !== undefined) definitions.set(preRegistered.key, preRegistered)
    return {
      registrations,
      stateOf(session: { snapshotEvents(): ReadonlyArray<{ type: string; data: unknown }> }, key: string): unknown {
        const def = definitions.get(key)
        if (def === undefined) return undefined
        let state: unknown = def.init()
        for (const event of session.snapshotEvents()) state = def.apply(state, event)
        return state
      },
      register(definition: unknown): () => void {
        const def = definition as { key: string; init: () => unknown; apply: (state: unknown, event: { type: string; data: unknown }) => unknown }
        registrations.push(definition)
        definitions.set(def.key, def)
        return () => definitions.delete(def.key)
      },
    }
  }

  function ctxOf(services: Record<string, unknown>, listeners: Array<{ event: string; run: () => void }> = []): unknown {
    return {
      get: (name: string) => services[name],
      on: (event: string, run: () => void) => {
        listeners.push({ event, run })
        return () => {}
      },
    }
  }

  it('reads the policy through stateOf when the key is already registered, and registers nothing', () => {
    const registry = fakeRegistry({
      key: 'subagentModelSelectionPolicy',
      init: () => null,
      apply: (state, event) => (state !== null || event.type !== 'subagent/model-selection-policy'
        ? state
        : (event.data as { allowedModels: unknown }).allowedModels),
    })
    const root = fakeAgent('root-1')
    root.session.append('subagent/model-selection-policy', { allowedModels: [{ provider: 'alpha', model: 'm-a' }] })
    const wiring = createRoutingWiring(ctxOf({ sessionProjections: registry }))
    expect(wiring.ports.policyReader?.(root)).toEqual({
      kind: 'present',
      routes: [{ provider: 'alpha', model: 'm-a' }],
    })
    expect(registry.registrations.length).toBe(0)
    wiring.dispose()
  })

  it('registers GAH\'s own mirror projection when the key is unregistered, and folds the durable event with it', () => {
    const registry = fakeRegistry()
    const root = fakeAgent('root-1')
    root.session.append('subagent/model-selection-policy', { allowedModels: [{ provider: 'alpha', model: 'm-a' }, { provider: 'beta', model: 'm-c' }] })
    const wiring = createRoutingWiring(ctxOf({ sessionProjections: registry }))
    expect(wiring.ports.policyReader?.(root)).toEqual({
      kind: 'present',
      routes: [{ provider: 'alpha', model: 'm-a' }, { provider: 'beta', model: 'm-c' }],
    })
    expect(registry.registrations.length).toBe(1)
    const def = registry.registrations[0] as { key: string; stateVersion: number }
    expect(def.key).toBe('subagentModelSelectionPolicy')
    expect(def.stateVersion).toBe(1)
    wiring.dispose()
  })

  it('no policy event folded ⇒ absent; absent service ⇒ unreachable', () => {
    const registry = fakeRegistry()
    const root = fakeAgent('root-1')
    const wiring = createRoutingWiring(ctxOf({ sessionProjections: registry }))
    expect(wiring.ports.policyReader?.(root)).toEqual({ kind: 'absent' })
    wiring.dispose()
    const bare = createRoutingWiring(ctxOf({}))
    expect(bare.ports.policyReader?.(root)).toEqual({ kind: 'unreachable' })
    expect(bare.ports.catalog).toBeUndefined()
    bare.dispose()
  })

  it('subscribes llm/adapters-updated and invalidates the catalog when it fires', async () => {
    const listeners: Array<{ event: string; run: () => void }> = []
    const llm = new StubLlm(MODELS)
    const wiring = createRoutingWiring(ctxOf({ llm }, listeners))
    const catalog = wiring.ports.catalog
    expect(catalog).toBeDefined()
    await catalog?.snapshot()
    await catalog?.snapshot()
    expect(llm.preflights.length).toBe(0)
    // One cached read so far: force a snapshot re-read through the event.
    const before = await catalog?.snapshot()
    listeners.filter(listener => listener.event === 'llm/adapters-updated').forEach(listener => listener.run())
    const after = await catalog?.snapshot()
    expect(after).not.toBe(before)
    wiring.dispose()
  })
})

// ── P2-1 (execution-audit r1): routeless legacy agentOptions carried in auto mode ──

describe('routing integration: routeless legacy tuning in auto mode (P2-1)', () => {
  it('carries routeless legacy executor + auditor options onto INHERIT dispatches — options reach the start, no pin, no route claim, the carry named in why', async () => {
    const f = fixture(MODELS, ABSENT)
    const h = makeHarness({
      routing: f.portsFor(),
      config: {
        executor: { agentOptions: { maxTokens: 8192 } },
        auditors: { plan: { agentOptions: { maxTokens: 512 } } },
      },
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] }),
    })
    const signal = new AbortController().signal
    await h.engine.init(h.root, makeTriage(STANDARD_DELEGATED), [undeclaredSeed('m1')])
    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    await h.engine.submitPlan(h.root, 'plan')

    // The auditor leg: the routeless legacy object reaches the dispatch.
    await h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })
    expect(h.subagents.auditOptions[0]).toEqual({ maxTokens: 512 })
    const auditRouting = routingOf(h, 'audit', 'plan-auditor')
    expect(auditRouting?.pin).toBeUndefined()
    expect(auditRouting?.authorizationSource).toBeUndefined()
    expect(auditRouting?.why?.some(entry => entry.includes('auditors.plan.agentOptions') && entry.includes('carried onto the inherit dispatch'))).toBe(true)
    const auditRecord = h.engine.peek(h.root.id)?.audits[0]?.route
    expect(auditRecord?.selected).toBeUndefined()

    // The executor leg: same carry on the continuable start.
    const started = await h.engine.startExecutor(h.root, { prompt: 'go', signal })
    expect(started.executor?.state).toBe('running')
    expect(h.subagents.continuableOptions[0]).toEqual({ maxTokens: 8192 })
    const executorRouting = routingOf(h, 'start-executor', 'executor')
    expect(executorRouting?.pin).toBeUndefined()
    expect(executorRouting?.why?.some(entry => entry.includes('executor.agentOptions') && entry.includes('carried onto the inherit dispatch'))).toBe(true)
    // The RouteRecord keeps saying inheritance: no selection leg anywhere, no pins.
    expect(started.executor?.route.selected).toBeUndefined()
    expect(h.engine.peek(h.root.id)?.routingPins).toBeUndefined()
  })

  it('the decided boundary: routeless legacy tuning is NOT carried onto an explicitly SELECTED route — the selection cites its own authority', async () => {
    // Documented decision (packet E8): a selection replaces the legacy routing
    // meaning, exactly as `lockedAgentOptions` rides legacy tuning only when
    // the dispatch follows a legacy-named route. The selection composes its
    // own validated agentOptions; the legacy object is not a party to the
    // session-policy grant and its unvalidated fields do not ride it.
    const f = fixture(MODELS, PRESENT_ABC)
    const h = makeHarness({
      routing: f.portsFor(),
      config: { auditors: { plan: { agentOptions: { maxTokens: 512 } } } },
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] }),
    })
    await toExecuting(h)
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'beta', model: 'm-c', reasoningEffort: 'high' })
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.pin).toEqual({ provider: 'beta', model: 'm-c', reasoningEffort: 'high' })
    expect(routing?.authorizationSource).toBe('session-policy')
    expect(routing?.why?.some(entry => entry.includes('carried onto the inherit dispatch'))).toBe(false)
  })
})

// ── P2-2 (execution-audit r1): candidatesConsidered persisted ──

describe('routing integration: candidatesConsidered persisted (P2-2)', () => {
  it('the persisted detail.routing.candidates equal the selector\u2019s own output for the named fixture, and surface on the RouteRecord', async () => {
    const f = fixture(MODELS, PRESENT_ABC)
    const h = makeHarness({
      routing: f.portsFor(),
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] }),
    })
    await toExecuting(h)

    // The selector, called directly with the same resolved inputs the engine
    // used (risk medium, balanced, auto role, present policy, live catalog,
    // no executor pin yet, default independence floor).
    const decision = await selectRoute({
      role: 'plan-auditor',
      risk: 'medium',
      preference: 'balanced',
      roleRouting: { mode: 'auto' },
      policy: PRESENT_ABC,
      catalog: f.catalog,
      independenceFloor: 'medium',
    })
    expect(decision.kind).toBe('route')

    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.candidates).toEqual(decision.kind === 'route' ? decision.candidatesConsidered : undefined)
    // The considered set is the full authorized set with honest dispositions:
    // beta/m-c selected, alpha/m-a eligible, both axes recorded per candidate.
    const candidates = routing?.candidates ?? []
    expect(candidates.map(candidate => `${candidate.provider}/${candidate.model}:${candidate.disposition}`))
      .toEqual(['beta/m-c:selected', 'alpha/m-a:eligible'])
    expect(candidates.every(candidate => candidate.independence !== undefined)).toBe(true)
    expect(candidates.every(candidate => typeof candidate.contextWindow === 'number' && typeof candidate.hasReasoningEfforts === 'boolean')).toBe(true)

    // And the durable RouteRecord surfaces the same set additively.
    const record = h.engine.peek(h.root.id)?.audits[0]?.route
    expect(record?.candidatesConsidered).toEqual(routing?.candidates)
  })

  it('fold validation: the written stream (candidates included) replays clean; malformed candidates are rejected loudly', async () => {
    const f = fixture(MODELS, PRESENT_ABC)
    const h = makeHarness({
      routing: f.portsFor(),
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] }),
    })
    await toExecuting(h)
    const written = eventsOf(h)
    expect(written.some(event => {
      const routing = (event.detail as { routing?: { candidates?: unknown } } | undefined)?.routing
      return Array.isArray(routing?.candidates) && (routing.candidates as unknown[]).length > 0
    })).toBe(true)
    // Well-formed candidates: the pristine stream folds clean.
    expect(() => foldRun(written)).not.toThrow()

    // Malformed variants, each rejected loudly with the routing-detail failure.
    const corrupt = (mutate: (candidates: unknown[]) => void): RunEvent[] => {
      const copy = JSON.parse(JSON.stringify(written)) as RunEvent[]
      for (const event of copy) {
        const routing = (event.detail as { routing?: { candidates?: unknown } } | undefined)?.routing
        if (routing !== undefined && Array.isArray(routing.candidates)) mutate(routing.candidates)
      }
      return copy
    }
    expect(() => foldRun(corrupt(candidates => {
      (candidates[0] as Record<string, unknown>).bogus = 'x'
    }))).toThrowError(/candidates entry has an unknown key/)
    expect(() => foldRun(corrupt(candidates => {
      (candidates[0] as Record<string, unknown>).disposition = 'chosen-by-vibes'
    }))).toThrowError(/disposition must be one of/)
    expect(() => foldRun(corrupt(candidates => {
      const first = candidates[0] as { independence?: Record<string, unknown> }
      if (first.independence !== undefined) first.independence.modelAxis = 'samey'
    }))).toThrowError(/independence\.modelAxis must be one of/)
    expect(() => foldRun(corrupt(candidates => {
      (candidates[0] as Record<string, unknown>).hasReasoningEfforts = 'yes'
    }))).toThrowError(/hasReasoningEfforts must be a boolean/)
    expect(() => foldRun(corrupt(candidates => {
      (candidates as unknown[])[0] = 'beta/m-c'
    }))).toThrowError(/candidates entries must be objects/)
    expect(() => foldRun(corrupt(candidates => {
      (candidates as unknown[]).length = 0
    }))).not.toThrow()
  })

  it('historical fixtures: the same stream with every candidates key stripped (the pre-P2-2 shape) replays unchanged', async () => {
    const f = fixture(MODELS, PRESENT_ABC)
    const h = makeHarness({
      routing: f.portsFor(),
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] }),
    })
    await toExecuting(h)
    const stripped = (JSON.parse(JSON.stringify(eventsOf(h))) as RunEvent[]).map(event => {
      const routing = (event.detail as { routing?: Record<string, unknown> } | undefined)?.routing
      if (routing !== undefined) delete routing.candidates
      return event
    })
    const folded = foldRun(stripped)
    expect(folded.snapshot?.routingPins).toEqual(h.engine.peek(h.root.id)?.routingPins)
    expect(folded.snapshot?.audits[0]?.route.selected).toEqual({ provider: 'beta', model: 'm-c', reasoningEffort: 'high' })
  })
})
