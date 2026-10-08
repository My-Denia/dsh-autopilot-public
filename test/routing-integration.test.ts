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

import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AutopilotEngine } from '../src/engine.js'
import type { AgentOptionsLike, RoutingPorts } from '../src/engine.js'
import { Config } from '../src/config.js'
import { createRoutingWiring, resolveConfig, volatileRoutingAccess } from '../src/index.js'
import type { ConfigInput } from '../src/index.js'
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
  /** Routes `resolveCallConfig` REJECTS (F7 fixtures): "provider/model" → reason. */
  public readonly preflightRejects = new Map<string, string>()
  /** F14 fixtures: when true, `listProviders` throws — the whole-catalog READ fails (infrastructure), distinct from adapter loss. */
  public failProviders = false
  /** F15 fixtures: "provider/model" routes where `resolveCallConfig` rejects a config that carries `maxTokens`. */
  public readonly maxTokensRejects = new Set<string>()

  constructor(private readonly models: readonly StubModel[]) {
    this.live = new Set(models.map(model => model.provider))
  }

  /** Simulate `llm/adapters-updated` removing a provider from the deployment. */
  dropProvider(provider: string): void {
    this.live.delete(provider)
  }

  listProviders() {
    if (this.failProviders) throw new Error('listProviders: scripted outage')
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
    const rejection = this.preflightRejects.get(`${config.provider}/${config.model}`)
    if (rejection !== undefined) throw new Error(rejection)
    if (config.maxTokens !== undefined && this.maxTokensRejects.has(`${config.provider}/${config.model}`)) {
      throw new Error(`resolveCallConfig: maxTokens ${config.maxTokens} is invalid on ${config.provider}/${config.model}`)
    }
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

// ── F1 (PR #2 Codex review): a pin cannot be reused when the policy cannot authorize it ──

describe('F1 (PR #2 review): session-policy pin reuse vs. an unreadable policy', () => {
  /** The execution-auditor pin a PRESENT_ABC run settles on (balanced preference, context-descending). */
  const SETTLED_PIN = { provider: 'beta', model: 'm-c', reasoningEffort: 'high' }

  /**
   * A policy the test can FLIP in place. The shared `fixture()` helper spreads
   * its state into the return value, so rebinding `f.policy` on the copy never
   * reaches the `portsFor` closure — exactly the silent no-op these tests
   * exist to avoid, so the flip lives behind an explicit setter over one
   * closure-shared cell.
   */
  function flippableFixture(initial: SessionPolicyState): {
    readonly ports: RoutingPorts
    readonly setPolicy: (next: SessionPolicyState) => void
  } {
    const cell: { policy: SessionPolicyState } = { policy: initial }
    const catalog = new RouteCatalog(new StubLlm(MODELS))
    return {
      ports: { catalog, policyReader: () => cell.policy },
      setPolicy: next => { cell.policy = next },
    }
  }

  /** A closing run over a live execution-auditor pin, with a third dispatch still scripted. */
  async function pinnedRun(initial: SessionPolicyState, config?: Parameters<typeof resolveConfig>[0]): Promise<{ readonly h: Harness; readonly flip: ReturnType<typeof flippableFixture>['setPolicy'] }> {
    const wiring = flippableFixture(initial)
    const h = makeHarness({
      routing: wiring.ports,
      ...(config === undefined ? {} : { config }),
      subagents: stubSubagents({ verdicts: [
        { verdict: 'pass', note: 'plan ok' },
        { verdict: 'pass', note: 'exec ok' },
        { verdict: 'pass', note: 'exec ok again' },
      ] }),
    })
    await toClosing(h)
    expect(h.engine.peek(h.root.id)?.routingPins?.['execution-auditor']).toEqual(SETTLED_PIN)
    return { h, flip: wiring.setPolicy }
  }

  /** The last execution-auditor routing detail in the durable stream. */
  function lastExecDetail(h: Harness): RoutingDecisionDetail | undefined {
    const details = routingDetails(h).filter(detail => detail.role === 'execution-auditor')
    return details[details.length - 1]
  }

  it('(a) policy still PRESENT ⇒ the pin is reused as-is: same route, session-policy source, no repin', async () => {
    const { h } = await pinnedRun(PRESENT_ABC)
    await h.engine.audit(h.root, { role: 'execution', prompt: 'again' })
    expect(h.subagents.auditOptions[2]).toEqual(SETTLED_PIN)
    const last = lastExecDetail(h)
    expect(last?.pin).toEqual(SETTLED_PIN)
    expect(last?.repinFrom).toBeUndefined()
    expect(last?.authorizationSource).toBe('session-policy')
    expect(last?.why?.some(entry => entry.includes('pin: reusing the role pin'))).toBe(true)
  })

  it('(b) policy flips PRESENT→absent between dispatches ⇒ the pin is refused, the re-selection inherits, the pin is cleared, repinFrom named', async () => {
    const { h, flip } = await pinnedRun(PRESENT_ABC)
    flip(ABSENT)
    await h.engine.audit(h.root, { role: 'execution', prompt: 'again' })
    // NOT reused: the dispatch inherits (no agentOptions reach the start).
    expect(h.subagents.auditOptions[2]).toBeUndefined()
    const last = lastExecDetail(h)
    expect(last?.pin).toBeUndefined()
    expect(last?.repinFrom).toEqual(SETTLED_PIN)
    // The honest conservative reason, naming the policy state.
    expect(last?.why?.some(entry =>
      entry.includes('cannot re-establish its session-policy authorization') && entry.includes('absent'))).toBe(true)
    // The re-selection under an absent policy records inheritance with NO authority claim.
    expect(last?.authorizationSource).toBeUndefined()
    // The pin is cleared in the snapshot — the fold re-derives it from the pinless record.
    expect(h.engine.peek(h.root.id)?.routingPins?.['execution-auditor']).toBeUndefined()
  })

  it('(c) policy flips PRESENT→unreachable ⇒ same refusal, with unreachable-inherit on the re-selection', async () => {
    const { h, flip } = await pinnedRun(PRESENT_ABC)
    flip({ kind: 'unreachable' })
    await h.engine.audit(h.root, { role: 'execution', prompt: 'again' })
    expect(h.subagents.auditOptions[2]).toBeUndefined()
    const last = lastExecDetail(h)
    expect(last?.pin).toBeUndefined()
    expect(last?.repinFrom).toEqual(SETTLED_PIN)
    expect(last?.why?.some(entry =>
      entry.includes('cannot re-establish its session-policy authorization') && entry.includes('unreachable'))).toBe(true)
    expect(last?.authorizationSource).toBe('unreachable-inherit')
    expect(h.engine.peek(h.root.id)?.routingPins?.['execution-auditor']).toBeUndefined()
  })

  it('(d) a POOL pin under an absent policy keeps its plugin-config grant — dispatched, never silently inherited', async () => {
    const { h, flip } = await pinnedRun(PRESENT_ABC, { crossFamily: { pool: [{ provider: 'beta', model: 'm-c' }] } })
    flip(ABSENT)
    await h.engine.audit(h.root, { role: 'execution', prompt: 'again' })
    // The pool grant escalates under an absent policy per the plan's one rule:
    // the pin is REUSED on the grant, not inherited away.
    expect(h.subagents.auditOptions[2]).toEqual(SETTLED_PIN)
    const last = lastExecDetail(h)
    expect(last?.pin).toEqual(SETTLED_PIN)
    expect(last?.repinFrom).toBeUndefined()
    expect(last?.authorizationSource).toBe('plugin-config')
    expect(last?.why?.some(entry => entry.includes('a plugin-config pool grant'))).toBe(true)
    expect(h.engine.peek(h.root.id)?.routingPins?.['execution-auditor']).toEqual(SETTLED_PIN)
  })
})

// ── F2 (PR #2 Codex review): volatile routing values are read at each decision ──

describe('F2 (PR #2 review): a volatile routing patch reaches the NEXT dispatch without a remount', () => {
  const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
  type Ref = { get(): unknown } & Record<symbol, unknown>

  /** Commit one simulated volatile update (what the loader runtime's patch path does to the ref). */
  function patch(ref: Ref, next: unknown): void {
    ;(ref[VOLATILE_WRITE] as (value: unknown) => void)(next)
  }

  /** The loader-path config value with volatile routing leaves, plus a live-access engine over it. */
  function volatileHarness(raw: unknown, policy: SessionPolicyState): Harness & { readonly routingRefs: { mode: Ref; roles: Record<string, { lock: Ref }> } } {
    const validated = Config['~standard'].validate(raw) as { value?: ConfigInput }
    expect(validated.value).toBeDefined()
    const value = validated.value as ConfigInput
    // The seam the fix ships: the accessor is wired EXACTLY because the leaves are references.
    expect(volatileRoutingAccess(value)).toBeDefined()
    const routingRefs = (value as unknown as { routing: { mode: Ref; roles: Record<string, { lock: Ref }> } }).routing
    const f = fixture(MODELS, policy)
    const storeDir = mkdtempSync(join(tmpdir(), 'dsh-autopilot-f2-'))
    const agents = new FakeAgents()
    const root = fakeAgent('root-1')
    agents.add(root)
    const subagents = stubSubagents({ verdicts: [
      { verdict: 'pass', note: 'plan ok' },
      { verdict: 'pass', note: 'exec ok' },
      { verdict: 'pass', note: 'exec ok again' },
    ] })
    const engine = new AutopilotEngine(
      agents, subagents, new RunStore(storeDir), resolveConfig(value), () => true, {},
      f.portsFor(), volatileRoutingAccess(value),
    )
    const h: Harness = { engine, agents, subagents, root, storeDir }
    return { ...h, routingRefs }
  }

  it('a routing.mode auto→off patch makes the next dispatch the 0.2.0 flow: inherit, no routing detail', async () => {
    const h = volatileHarness({ routing: { mode: 'auto' } }, PRESENT_ABC)
    await toClosing(h)
    expect(h.subagents.auditOptions[1]).toEqual({ provider: 'beta', model: 'm-c', reasoningEffort: 'high' })
    patch(h.routingRefs.mode, 'off')
    await h.engine.audit(h.root, { role: 'execution', prompt: 'again' })
    // Mode off with a default-auto role: the 0.2.0 composition, inherit, and
    // NO routing decision on the dispatch — the parity record, not a frozen 'auto'.
    expect(h.subagents.auditOptions[2]).toBeUndefined()
    expect(routingDetails(h).filter(detail => detail.role === 'execution-auditor')).toHaveLength(1)
  })

  it('a lock patched onto a role is followed by the next dispatch, grant-checked against the policy', async () => {
    const h = volatileHarness({ routing: { roles: { executionAuditor: {} } } }, PRESENT_ABC)
    await toClosing(h)
    expect(h.subagents.auditOptions[1]).toEqual({ provider: 'beta', model: 'm-c', reasoningEffort: 'high' })
    patch(h.routingRefs.roles.executionAuditor?.lock as Ref, { provider: 'alpha', model: 'm-a' })
    await h.engine.audit(h.root, { role: 'execution', prompt: 'again' })
    // The lock is INSIDE the policy ⇒ the grant stands and the dispatch follows it.
    // A lock names no effort here, and the locked dispatch carries exactly the
    // lock's own fields (no adapter default invented).
    expect(h.subagents.auditOptions[2]).toEqual({ provider: 'alpha', model: 'm-a' })
    const details = routingDetails(h).filter(detail => detail.role === 'execution-auditor')
    const last = details[details.length - 1]
    expect(last?.authorizationSource).toBe('plugin-config')
    expect(last?.pin).toEqual({ provider: 'alpha', model: 'm-a' })
    expect(h.engine.peek(h.root.id)?.routingPins?.['execution-auditor']).toEqual({ provider: 'alpha', model: 'm-a' })
  })

  it('a patch to an INVALID mode refuses the route at the next decision: inherit, recorded, no crash, stream replays', async () => {
    const h = volatileHarness({ routing: { mode: 'auto' } }, PRESENT_ABC)
    await toClosing(h)
    expect(h.engine.peek(h.root.id)?.routingPins?.['execution-auditor']).toBeDefined()
    patch(h.routingRefs.mode, 'on')
    await h.engine.audit(h.root, { role: 'execution', prompt: 'again' })
    // The decided degradation (F2): refuse the route — inherit the deployment
    // default — with the validation failure recorded on the dispatch, never a
    // throw mid-commit and never a dispatch on unvalidatable config.
    expect(h.subagents.auditOptions[2]).toBeUndefined()
    const details = routingDetails(h).filter(detail => detail.role === 'execution-auditor')
    const last = details[details.length - 1]
    expect(last?.pin).toBeUndefined()
    expect(last?.why?.some(entry => entry.includes('no longer resolves') && entry.includes("routing.mode must be 'auto' or 'off'"))).toBe(true)
    // The pin did not survive a dispatch whose config context cannot be validated.
    expect(h.engine.peek(h.root.id)?.routingPins?.['execution-auditor']).toBeUndefined()
    // The run itself is alive and the degraded record is fold-legal.
    expect(h.engine.peek(h.root.id)?.phase).toBe('closing')
    expect(() => foldRun(eventsOf(h))).not.toThrow()
  })

  it('the plain path keeps the snapshot semantics: no volatile leaves ⇒ no accessor at all', () => {
    expect(volatileRoutingAccess(undefined)).toBeUndefined()
    expect(volatileRoutingAccess({ routing: { mode: 'auto' } })).toBeUndefined()
    expect(volatileRoutingAccess({ executor: { agentOptions: { provider: 'p', model: 'm' } } })).toBeUndefined()
  })
})

// ── F3 (PR #2 Codex review): the planner installer port is settled before the engine exists ──

describe('F3 (PR #2 review): createRoutingWiring settles the installer import before use', () => {
  /** A bare service-less host shape (the wiring probes tolerate absence). */
  const bareCtx: unknown = { get: () => undefined, on: () => () => {} }

  it('the port is undefined while the import is in flight and wired once installerReady settles (never rejects)', async () => {
    const wiring = createRoutingWiring(bareCtx)
    // Synchronously after construction the dynamic import cannot have landed
    // (its continuation is a microtask away) — this is the window apply() closes.
    expect(wiring.ports.modelSelectionInstaller).toBeUndefined()
    await wiring.installerReady
    // The real host package is resolvable from this repo, so the port is wired.
    expect(typeof wiring.ports.modelSelectionInstaller).toBe('function')
    wiring.dispose()
  })
})

// ── F5 (PR #2 Codex review, round 2): the executor routing lock feeds the independence axes ──
//
// The defect: `executorPinOf` fell back from the dispatch pin straight to the
// legacy `executor.agentOptions` surface and never consulted the NEW
// `routing.roles.executor` lock — so a medium+ plan audit dispatched BEFORE
// the executor gave the selector no executor route, every candidate's
// independence was unknown, and the auditor could land on the locked
// executor's own family even when a both-axis-distinct candidate existed.
// The fix puts the CURRENT live routing lock between the pin and the legacy
// surface, per decision (F2's live read, never a cached judgment).

describe('F5 (PR #2 review, round 2): routing.roles.executor is visible to auditor independence before the executor dispatches', () => {
  // beta/m-big wins on preference alone (efforts + the largest window) AND is
  // the locked executor route; alpha/m-small is the both-axis-distinct candidate.
  const F5_MODELS: readonly StubModel[] = [
    { provider: 'beta', id: 'm-big', contextWindow: 400000, efforts: ['high'], defaultEffort: 'high' },
    { provider: 'alpha', id: 'm-small', contextWindow: 131072, efforts: ['high'], defaultEffort: 'high' },
  ]
  const F5_POLICY: SessionPolicyState = {
    kind: 'present',
    routes: [{ provider: 'beta', model: 'm-big' }, { provider: 'alpha', model: 'm-small' }],
  }

  function f5Harness(
    lock: { provider: string; model: string },
    models: readonly StubModel[] = F5_MODELS,
    policy: SessionPolicyState = F5_POLICY,
  ): Harness {
    const f = fixture(models, policy)
    return makeHarness({
      config: { routing: { roles: { executor: { lock } } } },
      routing: f.portsFor(),
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] }),
    })
  }

  it('(a) a locked executor with no legacy config and no pin yet gives the pre-executor plan audit REAL axes: the both-axis-distinct candidate is selected and `achieved` recorded', async () => {
    const h = f5Harness({ provider: 'beta', model: 'm-big' })
    await toExecuting(h)
    // Preference alone would take beta/m-big — the locked executor's own
    // family; the independence reorder against the LIVE lock takes the
    // both-axis-distinct alpha/m-small instead.
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'alpha', model: 'm-small', reasoningEffort: 'high' })
    const record = h.engine.peek(h.root.id)?.audits[0]?.route
    expect(record?.crossFamily).toBe('achieved')
    expect(record?.routeDiagnostic).toContain('modelAxis distinct, providerAxis distinct')
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.why?.some(entry => entry.includes("both-axis-distinct candidates from the executor's live pin first"))).toBe(true)
    // No executor dispatch happened yet: the axes came from the LOCK, not a pin.
    expect(h.engine.peek(h.root.id)?.routingPins?.executor).toBeUndefined()
  })

  it('(b) provider-axis distinctness is the differentiator: the same-provider preference winner loses to the provider-distinct candidate', async () => {
    // Executor locked to beta/m-big; beta/m-alt shares the PROVIDER (modelAxis
    // distinct only) and is the preference winner; alpha/m-x is both-axis distinct.
    const models: readonly StubModel[] = [
      { provider: 'beta', id: 'm-alt', contextWindow: 400000, efforts: ['high'], defaultEffort: 'high' },
      { provider: 'alpha', id: 'm-x', contextWindow: 131072, efforts: ['high'], defaultEffort: 'high' },
    ]
    const policy: SessionPolicyState = {
      kind: 'present',
      routes: [{ provider: 'beta', model: 'm-alt' }, { provider: 'alpha', model: 'm-x' }],
    }
    const h = f5Harness({ provider: 'beta', model: 'm-big' }, models, policy)
    await toExecuting(h)
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'alpha', model: 'm-x', reasoningEffort: 'high' })
    expect(h.engine.peek(h.root.id)?.audits[0]?.route?.crossFamily).toBe('achieved')
    expect(h.engine.peek(h.root.id)?.audits[0]?.route?.routeDiagnostic).toContain('providerAxis distinct')
  })

  it('(c) no lock ⇒ the legacy fallback is unchanged: executor.agentOptions still names the family for the axes', async () => {
    // No routing lock (and resolveConfig maps this legacy explicit route onto
    // the executor role itself): the legacy surface remains the family source
    // an auditor's axes are computed against — 0.2.0 behavior preserved.
    const f = fixture(F5_MODELS, F5_POLICY)
    const h = makeHarness({
      config: { executor: { agentOptions: { provider: 'beta', model: 'm-big' } } },
      routing: f.portsFor(),
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] }),
    })
    await toExecuting(h)
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'alpha', model: 'm-small', reasoningEffort: 'high' })
    expect(h.engine.peek(h.root.id)?.audits[0]?.route?.crossFamily).toBe('achieved')
  })
})

// ── F7 (PR #2 Codex round 3): the auto-mode pool fallback checks liveness and preflight ──
//
// The pool fallback fires when the routing core terminated to inheritance
// (here: a single-route or empty policy∩catalog authorized set). Before F7 a
// pool pick was dispatched after ONLY the grant check, so a policy-authorized
// but DEAD provider got dispatched. Now every pool candidate runs the same
// checks as any explicit selection — provider liveness against the catalog
// snapshot, then preflight/resolveCallConfig — and a failing entry is skipped
// honestly (why names it) with the walk falling to the next pool entry or the
// inheritance result standing. The grant rule stays FIRST (a present policy
// excluding the entry still escalates), and the 0.2.0-verbatim off-mode pool
// path stays untouched (see the mode-off suite above).

describe('F7 (PR #2 round 3): pool fallback liveness and preflight', () => {
  /** An auto-mode harness whose executor names the 'alpha' family, so the beta/gamma pool entries qualify as out-of-family picks. */
  function autoHarness(f: ReturnType<typeof fixture>, config?: Parameters<typeof resolveConfig>[0]): Harness {
    return makeHarness({
      routing: f.portsFor(),
      config: {
        executor: { agentOptions: { provider: 'alpha', model: 'm-a' } },
        crossFamily: { enabled: true, minRisk: 'medium', pool: [{ provider: 'beta', model: 'm-c' }] },
        ...(config ?? {}),
      },
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] }),
    })
  }

  it('(a) a dead provider in both pool and policy is NOT dispatched — inheritance retained, why names the liveness failure', async () => {
    const f = fixture(MODELS, { kind: 'present', routes: [{ provider: 'beta', model: 'm-c' }] })
    const h = autoHarness(f)
    f.llm.dropProvider('beta')
    await toExecuting(h)
    // The authorized set is EMPTY after the live-catalog intersection, the
    // core inherits, and the pool entry — policy-authorized but dead — is
    // skipped instead of dispatched.
    expect(h.subagents.auditOptions[0]).toBeUndefined()
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.pin).toBeUndefined()
    expect(routing?.why?.some(entry => entry.includes('pool route beta/m-c skipped') && entry.includes('not live in the catalog snapshot'))).toBe(true)
    expect(routing?.why?.some(entry => entry.includes('the inheritance result stands'))).toBe(true)
  })

  it('(b) a LIVE pool route inside the policy dispatches as before — grant green, checks green', async () => {
    const f = fixture(MODELS, { kind: 'present', routes: [{ provider: 'beta', model: 'm-c' }] })
    const h = autoHarness(f)
    await toExecuting(h)
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'beta', model: 'm-c' })
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.pin).toEqual({ provider: 'beta', model: 'm-c' })
    expect(routing?.authorizationSource).toBe('plugin-config')
    // The checks actually ran: the pool pick was preflighted like any explicit selection.
    expect(f.llm.preflights.some(config => config.provider === 'beta' && config.model === 'm-c')).toBe(true)
    // And nothing was skipped.
    expect(routing?.why?.some(entry => entry.includes('skipped'))).toBe(false)
  })

  it('(c) a pool route whose preflight rejects is skipped with the reason recorded', async () => {
    const f = fixture(MODELS, ABSENT)
    f.llm.preflightRejects.set('beta/m-c', 'resolveCallConfig: effort unsupported on this route')
    const h = autoHarness(f)
    await toExecuting(h)
    expect(h.subagents.auditOptions[0]).toBeUndefined()
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.pin).toBeUndefined()
    expect(routing?.why?.some(entry =>
      entry.includes('pool route beta/m-c skipped')
      && entry.includes('preflight rejected it')
      && entry.includes('effort unsupported on this route'))).toBe(true)
  })

  it('(d) a dead first entry falls to the NEXT pool entry, with the skip named', async () => {
    const models = [...MODELS, { provider: 'gamma', id: 'm-d', contextWindow: 131072 }]
    const f = fixture(models, ABSENT)
    f.llm.dropProvider('beta')
    const h = autoHarness(f, { crossFamily: { enabled: true, minRisk: 'medium', pool: [{ provider: 'beta', model: 'm-c' }, { provider: 'gamma', model: 'm-d' }] } })
    await toExecuting(h)
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'gamma', model: 'm-d' })
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.pin).toEqual({ provider: 'gamma', model: 'm-d' })
    expect(routing?.authorizationSource).toBe('plugin-config')
    expect(routing?.why?.some(entry => entry.includes('pool route beta/m-c skipped') && entry.includes('not live in the catalog snapshot'))).toBe(true)
  })

  it('(e) the grant rule stays FIRST: a pool entry outside a present policy still escalates, never dispatches', async () => {
    const f = fixture(MODELS, { kind: 'present', routes: [{ provider: 'alpha', model: 'm-a' }] })
    const h = autoHarness(f)
    await h.engine.init(h.root, makeTriage(STANDARD), [undeclaredSeed('m1')])
    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    await h.engine.submitPlan(h.root, 'plan')
    await expect(h.engine.audit(h.root, { role: 'plan', prompt: 'packet' }))
      .rejects.toThrowError(/outside the session model-selection policy/)
    expect(h.engine.peek(h.root.id)?.phase).toBe('needs-owner-decision')
    expect(h.subagents.auditOptions.length).toBe(0)
  })

  it('(f) no catalog port ⇒ the pool pick still dispatches (0.2.0 parity) with the skipped checks NAMED', async () => {
    const h = makeHarness({
      config: {
        executor: { agentOptions: { provider: 'alpha', model: 'm-a' } },
        crossFamily: { enabled: true, minRisk: 'medium', pool: [{ provider: 'beta', model: 'm-c' }] },
      },
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] }),
    })
    await toExecuting(h)
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'beta', model: 'm-c' })
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.pin).toEqual({ provider: 'beta', model: 'm-c' })
    expect(routing?.why?.some(entry => entry.includes('no catalog port wired — provider liveness not checked and dispatch preflight not run'))).toBe(true)
  })
})

// ── F9/F10 (PR #2 Codex round 4): the pool is an AUDITOR grant — never an executor authorization ──

describe('F9/F10 (PR #2 round 4): auditor-only pool grants and pool fallback', () => {
  /** The executor pin a PRESENT_ABC run settles on (balanced, context-descending): equal to the pool entry below. */
  const EXECUTOR_PIN = { provider: 'beta', model: 'm-c', reasoningEffort: 'high' }

  /** A policy cell the test can flip in place (same closure discipline as the F1 block). */
  function flippable(initial: SessionPolicyState): {
    readonly ports: RoutingPorts
    readonly flip: (next: SessionPolicyState) => void
  } {
    const cell: { policy: SessionPolicyState } = { policy: initial }
    const catalog = new RouteCatalog(new StubLlm(MODELS))
    return { ports: { catalog, policyReader: () => cell.policy }, flip: next => { cell.policy = next } }
  }

  /** The last routing detail for one (op, role) pair in the durable stream. */
  function lastRoutingOf(h: Harness, op: string, role: string): RoutingDecisionDetail | undefined {
    const details = routingDetails(h).filter(detail => detail.op === op && detail.role === role)
    return details[details.length - 1]
  }

  /**
   * (a) F9: an EXECUTOR pin that equals a pool entry is not pool-authorized.
   * The pool-equality check used to be role-agnostic, so the pin survived a
   * policy flip to absent as a phantom plugin-config grant. Now the pin is
   * refused on the F1 machinery (conservative re-selection ⇒ inheritance with
   * repinFrom), and the F10 guard keeps the pool from re-dispatching the
   * executor afterwards: the second start carries only the owner's routeless
   * legacy tuning, never a route.
   */
  it('(a) an executor pin equal to a pool entry + policy flips absent ⇒ NOT pool-authorized: conservative re-selection (inheritance) with repinFrom, no pool dispatch', async () => {
    const wiring = flippable(PRESENT_ABC)
    const h = makeHarness({
      routing: wiring.ports,
      config: {
        executor: { agentOptions: { provider: 'alpha' } },
        crossFamily: { enabled: true, minRisk: 'medium', pool: [{ provider: 'beta', model: 'm-c' }] },
      },
      subagents: stubSubagents({ verdicts: [
        { verdict: 'pass', note: 'plan ok' },
        { verdict: 'pass', note: 'plan ok again' },
      ] }),
    })
    const signal = new AbortController().signal
    await h.engine.init(h.root, makeTriage(STANDARD_DELEGATED), [undeclaredSeed('m1')])
    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })

    // First dispatch: the executor SELECTS beta/m-c from the present policy and pins it.
    await h.engine.startExecutor(h.root, { prompt: 'implement', signal })
    expect(h.subagents.continuableOptions[0]).toEqual(EXECUTOR_PIN)
    expect(h.engine.peek(h.root.id)?.routingPins?.executor).toEqual(EXECUTOR_PIN)

    // Replan revokes the executor (a second start becomes legal), then the policy goes absent.
    await h.engine.replan(h.root, 'round two')
    wiring.flip(ABSENT)
    await h.engine.submitPlan(h.root, 'plan v2')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })

    const second = await h.engine.startExecutor(h.root, { prompt: 'implement again', signal })
    expect(second.executor?.state).toBe('running')
    // NO route reached the dispatch: the pool entry equal to the dead pin was
    // neither reused as a grant nor re-dispatched from the fallback. Only the
    // owner's routeless legacy tuning rides (the P2-1 carry — tuning, not a route).
    expect(h.subagents.continuableOptions[1]).toEqual({ provider: 'alpha' })
    expect(second.executor?.route.selected).toBeUndefined()

    const last = lastRoutingOf(h, 'start-executor', 'executor')
    expect(last?.pin).toBeUndefined()
    expect(last?.repinFrom).toEqual(EXECUTOR_PIN)
    expect(last?.authorizationSource).toBeUndefined()
    // The honest conservative refusal, naming the policy state — the F1 machinery, not a pool grant.
    expect(last?.why?.some(entry =>
      entry.includes('cannot re-establish its session-policy authorization') && entry.includes('absent'))).toBe(true)
    expect(last?.why?.some(entry => entry.includes('pin: re-selecting'))).toBe(true)
    // No plugin-config pool claim anywhere on the executor's record, and the
    // F10 boundary is named: the pick existed and was withheld.
    expect(last?.why?.some(entry => entry.includes('a plugin-config pool grant'))).toBe(false)
    expect(last?.why?.some(entry => entry.includes('pool fallback is auditor-only'))).toBe(true)
    // The pin is cleared in the snapshot — the fold re-derives it from the pinless record.
    expect(h.engine.peek(h.root.id)?.routingPins?.executor).toBeUndefined()
  })

  /**
   * (b) F10, end to end at medium risk: a provider-only legacy executor
   * (`{ provider: 'alpha' }` — no model ⇒ no lock ⇒ auto) under an absent
   * policy inherits. Before the guard, the fallback read the executor's own
   * family and dispatched the executor on the first out-of-family pool entry,
   * silently replacing the requested provider with an auditor model. Now no
   * agentOptions the POOL could supply reaches the dispatch — the only
   * agentOptions on the start is the owner's own routeless tuning carry
   * (the P2-1 decided behavior, deliberately intact), the why names the
   * inheritance and the withheld pick, and nothing is pinned.
   */
  it('(b) provider-only legacy executor + absent policy ⇒ executor inherits, the pool is never consulted for it, why names the inheritance', async () => {
    const f = fixture(MODELS, ABSENT)
    const h = makeHarness({
      routing: f.portsFor(),
      config: {
        executor: { agentOptions: { provider: 'alpha' } },
        crossFamily: { enabled: true, minRisk: 'medium', pool: [{ provider: 'beta', model: 'm-c' }] },
      },
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'plan ok' }] }),
    })
    const signal = new AbortController().signal
    await h.engine.init(h.root, makeTriage(STANDARD_DELEGATED), [undeclaredSeed('m1')])
    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })

    // The AUDITOR leg still dispatches from the pool (auditor semantics unchanged).
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'beta', model: 'm-c' })

    const started = await h.engine.startExecutor(h.root, { prompt: 'implement', signal })
    expect(started.executor?.state).toBe('running')
    // The EXECUTOR leg: the requested provider rides as routeless tuning; the
    // auditor model never replaces it.
    expect(h.subagents.continuableOptions[0]).toEqual({ provider: 'alpha' })
    expect(started.executor?.route.selected).toBeUndefined()

    const routing = routingOf(h, 'start-executor', 'executor')
    expect(routing?.pin).toBeUndefined()
    expect(routing?.repinFrom).toBeUndefined()
    expect(routing?.authorizationSource).toBeUndefined()
    // The why names the inheritance (the native default), the withheld pick,
    // and the carry — never a pool grant.
    expect(routing?.why?.some(entry => entry.includes('auto mode performs inheritance only'))).toBe(true)
    expect(routing?.why?.some(entry => entry.includes('pool fallback is auditor-only'))).toBe(true)
    expect(routing?.why?.some(entry => entry.includes('carried onto the inherit dispatch'))).toBe(true)
    expect(routing?.why?.some(entry => entry.includes('pool fallback supplied'))).toBe(false)
    expect(h.engine.peek(h.root.id)?.routingPins?.executor).toBeUndefined()
  })

  /**
   * (c) F10 counterweight: a provider-only legacy AUDITOR keeps the full E11
   * checked walk (grant → liveness → preflight) over the pool — the guard
   * changes nothing for the roles the pool exists for.
   */
  it('(c) a provider-only legacy auditor + pool ⇒ the checked walk still dispatches the pick, grant/liveness/preflight unchanged', async () => {
    const f = fixture(MODELS, ABSENT)
    const h = makeHarness({
      routing: f.portsFor(),
      config: {
        executor: { agentOptions: { provider: 'alpha' } },
        auditors: { plan: { agentOptions: { provider: 'alpha' } } },
        crossFamily: { enabled: true, minRisk: 'medium', pool: [{ provider: 'beta', model: 'm-c' }] },
      },
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] }),
    })
    await toExecuting(h)
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'beta', model: 'm-c' })
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.pin).toEqual({ provider: 'beta', model: 'm-c' })
    expect(routing?.authorizationSource).toBe('plugin-config')
    expect(routing?.why?.some(entry => entry.includes('the 0.2.0 pool fallback supplied beta/m-c as a plugin-config grant'))).toBe(true)
    // The checked walk actually ran: the pick was preflighted like any explicit selection.
    expect(f.llm.preflights.some(config => config.provider === 'beta' && config.model === 'm-c')).toBe(true)
    expect(h.engine.peek(h.root.id)?.routingPins?.['plan-auditor']).toEqual({ provider: 'beta', model: 'm-c' })
  })
})

// ── F11 (PR #2 Codex round 5): an equal-route lock rebuilds the ROUTE fields from the lock ──
//
// When the written lock's route EQUALS the legacy surface's route, the legacy
// object used to be dispatched VERBATIM — including a legacy `reasoningEffort`
// the lock deliberately omits, while preflight and route evidence ran on the
// lock's fields (no effort): the dispatched child differed from both the
// explicit lock and its recorded evidence. Now equal-route dispatch keeps the
// legacy NON-ROUTE tuning (E2's 0.2.0 resolve contract: `maxTokens` and
// siblings) but builds provider/model/reasoningEffort from the lock — an
// effort present in legacy but absent from the lock is NOT dispatched. The
// unequal/absent-legacy path is unchanged (the lock's own fields only).

describe('F11 (PR #2 round 5): an equal-route lock rebuilds route identity fields from the lock', () => {
  // alpha/m-a declares every effort the fixtures name; alpha/m-b declares
  // none, so a lock on it preflights (and dispatches) with NO effort unless
  // the lock names one — making effort absence assertable exactly.
  const F11_MODELS: readonly StubModel[] = [
    { provider: 'alpha', id: 'm-a', contextWindow: 131072, efforts: ['high', 'low'], defaultEffort: 'high' },
    { provider: 'alpha', id: 'm-b', contextWindow: 131072 },
  ]

  /** Drive a delegated run to a passed plan gate, then start the (locked) executor once. */
  async function startedExecutor(
    agentOptions: AgentOptionsLike,
    lock: { provider: string; model: string; reasoningEffort?: string },
  ): Promise<{ readonly h: Harness; readonly f: Fixture }> {
    const f = fixture(F11_MODELS, ABSENT)
    const h = makeHarness({
      routing: f.portsFor(),
      config: {
        executor: { agentOptions },
        routing: { roles: { executor: { lock } } },
      },
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'plan ok' }] }),
    })
    const signal = new AbortController().signal
    await h.engine.init(h.root, makeTriage(STANDARD_DELEGATED), [undeclaredSeed('m1')])
    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })
    const started = await h.engine.startExecutor(h.root, { prompt: 'implement', signal })
    expect(started.executor?.state).toBe('running')
    return { h, f }
  }

  it('(i) equal route: legacy maxTokens rides, a legacy effort the lock omits is NOT dispatched, and pin/preflight agree with the dispatch', async () => {
    const { h, f } = await startedExecutor(
      { provider: 'alpha', model: 'm-b', maxTokens: 8192, reasoningEffort: 'high' },
      { provider: 'alpha', model: 'm-b' },
    )
    // Non-route tuning rides; the route identity (including NO effort) is the lock's.
    expect(h.subagents.continuableOptions[0]).toEqual({ provider: 'alpha', model: 'm-b', maxTokens: 8192 })
    const routing = routingOf(h, 'start-executor', 'executor')
    expect(routing?.pin).toEqual({ provider: 'alpha', model: 'm-b' })
    expect(routing?.authorizationSource).toBe('plugin-config')
    // The equal-route provenance note still fires ([R2-P1-1]).
    expect(routing?.why?.some(entry => entry.includes('grant source is the legacy executor.agentOptions surface'))).toBe(true)
    // Preflight ran on the LOCK's fields (m-b declares no default effort): no
    // effort reached the check, exactly as none reached the dispatch.
    expect(f.llm.preflights.some(config =>
      config.provider === 'alpha' && config.model === 'm-b' && config.reasoningEffort === undefined)).toBe(true)
  })

  it('(ii) equal route with a lock-named effort: the lock’s effort WINS over a different legacy effort (tuning still rides)', async () => {
    const { h } = await startedExecutor(
      { provider: 'alpha', model: 'm-a', maxTokens: 2048, reasoningEffort: 'high' },
      { provider: 'alpha', model: 'm-a', reasoningEffort: 'low' },
    )
    expect(h.subagents.continuableOptions[0]).toEqual({ provider: 'alpha', model: 'm-a', maxTokens: 2048, reasoningEffort: 'low' })
    expect(routingOf(h, 'start-executor', 'executor')?.pin).toEqual({ provider: 'alpha', model: 'm-a', reasoningEffort: 'low' })
  })

  it('(iii) routeless legacy executor under an explicit lock: the E8 boundary holds — nothing rides, the lock’s fields only', async () => {
    const { h } = await startedExecutor(
      { provider: 'alpha' },
      { provider: 'alpha', model: 'm-b' },
    )
    // Routeless legacy does NOT ride an explicit lock (the E8 decided
    // boundary): the dispatch is exactly the lock's own fields.
    expect(h.subagents.continuableOptions[0]).toEqual({ provider: 'alpha', model: 'm-b' })
    expect(routingOf(h, 'start-executor', 'executor')?.pin).toEqual({ provider: 'alpha', model: 'm-b' })
  })
})

// ── F12 (PR #2 Codex round 5): the pool fallback's builder family sees locks and pins ──
//
// The fallback's builder-family input used to come from the legacy
// `executor.agentOptions` surface alone, so with a lock-only or pin-only
// executor route `selectCrossFamily` read `unknown-family` and never consulted
// a valid out-of-family pool entry. The family is now sourced through the F5
// order — dispatch pin → live routing lock → legacy surface — with the
// executor's own just-refused pin never counting as a declaration, and the
// checked walk (grant → liveness → preflight) unchanged.

describe('F12 (PR #2 round 5): the pool fallback builder family is sourced from the executor pin/lock', () => {
  /** A policy cell the test can flip in place (same closure discipline as the F1/F9 blocks). */
  function flippable(initial: SessionPolicyState): {
    readonly llm: StubLlm
    readonly ports: RoutingPorts
    readonly flip: (next: SessionPolicyState) => void
  } {
    const cell: { policy: SessionPolicyState } = { policy: initial }
    const llm = new StubLlm(MODELS)
    const catalog = new RouteCatalog(llm)
    return { llm, ports: { catalog, policyReader: () => cell.policy }, flip: next => { cell.policy = next } }
  }

  /** The last routing detail for one (op, role) pair in the durable stream. */
  function lastRouting(h: Harness, op: string, role: string): RoutingDecisionDetail | undefined {
    const details = routingDetails(h).filter(detail => detail.op === op && detail.role === role)
    return details[details.length - 1]
  }

  it('(a) executor route via a routing lock ONLY (no legacy surface): the auditor’s inherit falls to the pool and the checked walk dispatches the pick', async () => {
    const f = fixture(MODELS, ABSENT)
    const h = makeHarness({
      routing: f.portsFor(),
      config: {
        routing: { roles: { executor: { lock: { provider: 'alpha', model: 'm-a' } } } },
        auditors: { plan: { agentOptions: { provider: 'alpha' } } },
        crossFamily: { enabled: true, minRisk: 'medium', pool: [{ provider: 'beta', model: 'm-c' }] },
      },
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] }),
    })
    await toExecuting(h)
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'beta', model: 'm-c' })
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.pin).toEqual({ provider: 'beta', model: 'm-c' })
    expect(routing?.authorizationSource).toBe('plugin-config')
    expect(routing?.why?.some(entry => entry.includes('the 0.2.0 pool fallback supplied beta/m-c as a plugin-config grant'))).toBe(true)
    // The walk’s checks actually ran over the lock-sourced family: the pick
    // was preflighted like any explicit selection.
    expect(f.llm.preflights.some(config => config.provider === 'beta' && config.model === 'm-c')).toBe(true)
    expect(h.engine.peek(h.root.id)?.routingPins?.['plan-auditor']).toEqual({ provider: 'beta', model: 'm-c' })
    // The executor never dispatched: its family reached the walk through the LOCK alone.
    expect(h.engine.peek(h.root.id)?.routingPins?.executor).toBeUndefined()
    expect(h.engine.peek(h.root.id)?.audits[0]?.route?.crossFamily).toBe('achieved')
  })

  it('(b) executor route via an AUTO PIN only: after the policy flips absent, the re-selected auditor’s fallback sees the pin’s family and dispatches the out-of-family pool entry', async () => {
    const wiring = flippable(PRESENT_ABC)
    const h = makeHarness({
      routing: wiring.ports,
      config: {
        auditors: { plan: { agentOptions: { provider: 'beta' } } },
        crossFamily: { enabled: true, minRisk: 'medium', pool: [{ provider: 'alpha', model: 'm-a' }] },
      },
      subagents: stubSubagents({ verdicts: [
        { verdict: 'pass', note: 'plan ok' },
        { verdict: 'pass', note: 'plan ok again' },
      ] }),
    })
    const signal = new AbortController().signal
    await h.engine.init(h.root, makeTriage(STANDARD_DELEGATED), [undeclaredSeed('m1')])
    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    await h.engine.submitPlan(h.root, 'plan')
    // Audit #1: the auditor selects beta/m-c from the present policy (no
    // executor pin/lock/legacy exists yet, so no axes input).
    await h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })
    // The executor auto-selects beta/m-c and PINS it — the only place its
    // route exists (no legacy surface, no lock).
    await h.engine.startExecutor(h.root, { prompt: 'implement', signal })
    const executorPin = { provider: 'beta', model: 'm-c', reasoningEffort: 'high' }
    expect(h.engine.peek(h.root.id)?.routingPins?.executor).toEqual(executorPin)

    await h.engine.replan(h.root, 'round two')
    wiring.flip(ABSENT)
    await h.engine.submitPlan(h.root, 'plan v2')
    // Audit #2: the auditor’s own pin is refused on the absent policy ⇒ inherit
    // ⇒ the fallback, whose builder family is the EXECUTOR PIN’s (’beta’).
    await h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })

    expect(h.subagents.auditOptions[1]).toEqual({ provider: 'alpha', model: 'm-a' })
    const second = lastRouting(h, 'audit', 'plan-auditor')
    expect(second?.pin).toEqual({ provider: 'alpha', model: 'm-a' })
    expect(second?.authorizationSource).toBe('plugin-config')
    // The fallback ran on the auditor’s own conservative re-selection (the why
    // names the refused pin — the pool record deliberately rebuilds the detail
    // and keeps the re-selection provenance in `why`), and the walk preflighted
    // the pick like any explicit selection.
    expect(second?.why?.some(entry =>
      entry.includes('pin: re-selecting') && entry.includes('refusing the pin conservatively'))).toBe(true)
    expect(second?.why?.some(entry => entry.includes('the 0.2.0 pool fallback supplied alpha/m-a as a plugin-config grant'))).toBe(true)
    // The walk’s checks ran on the pin-sourced family: the pick was preflighted
    // like any explicit selection.
    expect(wiring.llm.preflights.some(config => config.provider === 'alpha' && config.model === 'm-a')).toBe(true)
    expect(h.engine.peek(h.root.id)?.routingPins?.executor).toEqual(executorPin)
  })

  it('(c) genuinely unrouted executor (no pin, no lock, no legacy surface): the honest unknown-family inheritance path is retained', async () => {
    const f = fixture(MODELS, ABSENT)
    const h = makeHarness({
      routing: f.portsFor(),
      config: {
        auditors: { plan: { agentOptions: { provider: 'alpha' } } },
        crossFamily: { enabled: true, minRisk: 'medium', pool: [{ provider: 'beta', model: 'm-c' }] },
      },
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] }),
    })
    await toExecuting(h)
    // No executor family is observable ⇒ the pool is not in play: the auditor
    // inherits, its routeless legacy tuning carries, and the record says
    // unknown-family instead of claiming a pick.
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'alpha' })
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.pin).toBeUndefined()
    expect(routing?.authorizationSource).toBeUndefined()
    expect(routing?.why?.some(entry => entry.includes('carried onto the inherit dispatch'))).toBe(true)
    expect(routing?.why?.some(entry => entry.includes('pool fallback supplied'))).toBe(false)
    expect(h.engine.peek(h.root.id)?.audits[0]?.route?.crossFamily).toBe('unknown-family')
    expect(h.engine.peek(h.root.id)?.routingPins?.['plan-auditor']).toBeUndefined()
  })
})

// ── F14 (PR #2 round 6): a catalog outage is infrastructure, not provider disappearance ──
//
// `RouteCatalog.snapshot()` degrades a failed `listProviders` to
// `catalogStatus: 'unavailable'` with an EMPTY provider list — a shape a bare
// `providerIsLive` check cannot distinguish from a vanished provider. The
// locked-route branch and the auto pin-reuse liveness check used exactly that
// bare check, so ONE transient read failure escalated every locked dispatch
// as needs-owner-decision and re-selected healthy pins over. Now liveness is
// asserted only on a SUCCESSFUL read (`catalogStatus: 'live'`); an
// unavailable read is recorded as the outage it is, and preflight — which
// calls `resolveCallConfig` independently of the failed listing — decides.
// The gone-provider escalation on a live read is unchanged ((iv-c) above
// keeps proving it end to end).

describe('F14 (PR #2 round 6): a catalog outage is infrastructure, not provider disappearance', () => {
  /** A closing run over a live execution-auditor pin, with a third dispatch still scripted. */
  async function pinnedRun(): Promise<{ readonly h: Harness; readonly f: Fixture }> {
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
    expect(h.engine.peek(h.root.id)?.routingPins?.['execution-auditor']).toEqual({ provider: 'beta', model: 'm-c', reasoningEffort: 'high' })
    return { h, f }
  }

  /** The last routing detail for one role in the durable stream. */
  function lastDetail(h: Harness, role: string): RoutingDecisionDetail | undefined {
    const details = routingDetails(h).filter(detail => detail.role === role)
    return details[details.length - 1]
  }

  it('(a) locked role + catalog read failure ⇒ NOT escalated: the lock dispatches through preflight, why names the outage', async () => {
    const f = fixture(MODELS, PRESENT_ABC)
    const h = makeHarness({
      routing: f.portsFor(),
      config: { routing: { roles: { executionAuditor: { mode: 'locked', lock: { provider: 'alpha', model: 'm-a' } } } } },
      subagents: stubSubagents({ verdicts: [
        { verdict: 'pass', note: 'plan ok' },
        { verdict: 'pass', note: 'exec ok' },
        { verdict: 'pass', note: 'exec ok again' },
      ] }),
    })
    await toClosing(h)
    expect(h.subagents.auditOptions[1]).toEqual({ provider: 'alpha', model: 'm-a' })

    f.llm.failProviders = true
    f.catalog.invalidate()

    // The outage is infrastructure, not evidence the provider is gone: the
    // locked dispatch PROCEEDS instead of escalating needs-owner-decision.
    await h.engine.audit(h.root, { role: 'execution', prompt: 'again' })
    expect(h.subagents.auditOptions[2]).toEqual({ provider: 'alpha', model: 'm-a' })
    const last = lastDetail(h, 'execution-auditor')
    expect(last?.pin).toEqual({ provider: 'alpha', model: 'm-a' })
    expect(last?.repinFrom).toBeUndefined()
    expect(last?.why?.some(entry =>
      entry.includes('catalog: snapshot unavailable') && entry.includes('not evidence the provider is gone'))).toBe(true)
    expect(h.engine.peek(h.root.id)?.phase).not.toBe('needs-owner-decision')
    // Preflight was the actual gate: resolveCallConfig ran for the locked route.
    expect(f.llm.preflights.some(config => config.provider === 'alpha' && config.model === 'm-a')).toBe(true)
  })

  it('(b) locked role + outage + preflight failure ⇒ still escalates with the existing reason shape', async () => {
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

    f.llm.preflightRejects.set('alpha/m-a', 'resolveCallConfig: scripted rejection under outage')
    f.llm.failProviders = true
    f.catalog.invalidate()

    // The outage does not WEAKEN the gate either: preflight failure on a lock
    // still blocks dispatch and escalates, exactly as on a healthy catalog.
    await expect(h.engine.audit(h.root, { role: 'execution', prompt: 'again' }))
      .rejects.toThrowError(/failed preflight/)
    const snapshot = h.engine.peek(h.root.id)
    expect(snapshot?.phase).toBe('needs-owner-decision')
    expect(snapshot?.diagnostic?.startsWith('routing-escalation:')).toBe(true)
    expect(h.subagents.auditOptions.length).toBe(2)
  })

  it('(c) auto pin reuse + catalog read failure ⇒ the pin is NOT killed by liveness; preflight decides; the outage is recorded', async () => {
    const { h, f } = await pinnedRun()
    const preflightsBefore = f.llm.preflights.length

    f.llm.failProviders = true
    f.catalog.invalidate()

    await h.engine.audit(h.root, { role: 'execution', prompt: 'again' })
    // The healthy pin survived the outage: same route dispatched, no repin,
    // the session-policy authority intact.
    expect(h.subagents.auditOptions[2]).toEqual({ provider: 'beta', model: 'm-c', reasoningEffort: 'high' })
    const last = lastDetail(h, 'execution-auditor')
    expect(last?.pin).toEqual({ provider: 'beta', model: 'm-c', reasoningEffort: 'high' })
    expect(last?.repinFrom).toBeUndefined()
    expect(last?.authorizationSource).toBe('session-policy')
    // The reuse record names the outage instead of claiming a liveness proof
    // it could not run — and instead of killing the pin over one it could not read.
    expect(last?.why?.some(entry =>
      entry.includes('pin: reusing the role pin')
      && entry.includes('provider liveness NOT assertable')
      && entry.includes('not evidence the provider is gone'))).toBe(true)
    // Preflight decided AFTER the outage began: resolveCallConfig ran for the pin.
    const afterOutage = f.llm.preflights.slice(preflightsBefore)
    expect(afterOutage.some(config => config.provider === 'beta' && config.model === 'm-c')).toBe(true)
  })
})

// ── F15 (PR #2 round 6): the pool walk preflights the FULL call config ──
//
// The pool fallback dispatches the COMPLETE pool entry as agentOptions, but
// its preflight used to forward only provider/model/reasoningEffort — an
// invalid `maxTokens` on a pool entry passed the walk and failed at subagent
// start. The walk now routes the whole entry through `resolveCallConfig`
// (the port's `preflight` signature already carries `maxTokens` — no port
// change), so walk acceptance implies dispatch validity. Grant-first
// ordering and the honest skip records are unchanged.

describe('F15 (PR #2 round 6): the pool walk preflights every dispatched call-config field', () => {
  /** Auto-mode harness over models with a gamma provider, executor named to the alpha family. */
  function poolHarness(pool: readonly AgentOptionsLike[], llm: StubLlm): Harness {
    const catalog = new RouteCatalog(llm)
    const h = makeHarness({
      routing: { catalog, policyReader: () => ABSENT },
      config: {
        executor: { agentOptions: { provider: 'alpha', model: 'm-a' } },
        crossFamily: { enabled: true, minRisk: 'medium', pool: [...pool] },
      },
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] }),
    })
    return h
  }

  it('(a) a pool entry whose maxTokens the preflight rejects is SKIPPED with the reason; the next entry dispatches', async () => {
    const llm = new StubLlm([...MODELS, { provider: 'gamma', id: 'm-d', contextWindow: 131072 }])
    llm.maxTokensRejects.add('beta/m-c')
    const h = poolHarness(
      [
        { provider: 'beta', model: 'm-c', maxTokens: 64 },
        { provider: 'gamma', model: 'm-d', maxTokens: 512 },
      ],
      llm,
    )
    await toExecuting(h)
    // The invalid first entry was stepped past — NOT dispatched to fail at start.
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'gamma', model: 'm-d', maxTokens: 512 })
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.pin).toEqual({ provider: 'gamma', model: 'm-d' })
    expect(routing?.authorizationSource).toBe('plugin-config')
    expect(routing?.why?.some(entry =>
      entry.includes('pool route beta/m-c skipped')
      && entry.includes('dispatch preflight rejected it')
      && entry.includes('maxTokens 64 is invalid'))).toBe(true)
    // The walk actually SAW the field: the beta/m-c preflight carried maxTokens.
    expect(llm.preflights.some(config =>
      config.provider === 'beta' && config.model === 'm-c' && config.maxTokens === 64)).toBe(true)
  })

  it('(b) a valid maxTokens entry dispatches WHOLE — preflight proven to have received the complete fields', async () => {
    const llm = new StubLlm([...MODELS, { provider: 'gamma', id: 'm-d', contextWindow: 131072 }])
    const h = poolHarness([{ provider: 'gamma', model: 'm-d', maxTokens: 512, reasoningEffort: 'high' }], llm)
    await toExecuting(h)
    // The dispatch carries the complete entry verbatim, as 0.2.0 did.
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'gamma', model: 'm-d', maxTokens: 512, reasoningEffort: 'high' })
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.pin).toEqual({ provider: 'gamma', model: 'm-d', reasoningEffort: 'high' })
    expect(routing?.why?.some(entry => entry.includes('skipped'))).toBe(false)
    // And the preflight received EXACTLY those complete fields before it —
    // walk acceptance and dispatch validity are now the same check.
    expect(llm.preflights.some(config =>
      config.provider === 'gamma' && config.model === 'm-d'
      && config.maxTokens === 512 && config.reasoningEffort === 'high')).toBe(true)
  })
})

// ── F16 (PR #2 Codex round 7): preflight the FULLY COMPOSED locked dispatch ──
//
// `selectLocked` preflights the LOCK's route fields (provider/model/effort),
// but the dispatch object is composed ENGINE-side: on the equal-route branch
// `lockedAgentOptions` rides the legacy NON-ROUTE tuning (`maxTokens` and
// siblings) onto the lock's route — fields the selector never sees and never
// checks. An adapter-INVALID retained maxTokens therefore passed routing
// preflight and failed the actual audit/executor dispatch MID-RUN. The
// composed object is now preflighted at the engine's locked dispatch call
// site (the selector stays pure w.r.t. legacy composition — it is E2/engine
// knowledge), so a rejection blocks BEFORE the subagent start with the
// adapter's reason named, exactly like every other locked-route refusal. The
// selector's own bare-lock preflight is unchanged (the lock's fields stay
// validated — F14(b) and the selector unit tests keep proving it).

describe('F16 (PR #2 round 7): the engine preflights the composed locked agentOptions before dispatch', () => {
  const F16_MODELS: readonly StubModel[] = [
    { provider: 'alpha', id: 'm-a', contextWindow: 131072, efforts: ['high', 'low'], defaultEffort: 'high' },
    { provider: 'alpha', id: 'm-b', contextWindow: 131072 },
  ]

  /** A delegated run at a passed plan gate, executor locked, with the stub preflight armed per test. */
  function lockedHarness(
    agentOptions: AgentOptionsLike,
    lock: { provider: string; model: string; reasoningEffort?: string },
  ): { readonly h: Harness; readonly f: Fixture } {
    const f = fixture(F16_MODELS, ABSENT)
    const h = makeHarness({
      routing: f.portsFor(),
      config: {
        executor: { agentOptions },
        routing: { roles: { executor: { lock } } },
      },
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'plan ok' }] }),
    })
    return { h, f }
  }

  async function toPassedPlanGate(h: Harness): Promise<void> {
    await h.engine.init(h.root, makeTriage(STANDARD_DELEGATED), [undeclaredSeed('m1')])
    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })
  }

  it('(a) equal route + a legacy maxTokens the adapter rejects ⇒ blocked BEFORE start and escalated with the reason named, never a mid-run failure', async () => {
    const { h, f } = lockedHarness(
      { provider: 'alpha', model: 'm-b', maxTokens: 8192, reasoningEffort: 'high' },
      { provider: 'alpha', model: 'm-b' },
    )
    f.llm.maxTokensRejects.add('alpha/m-b')
    await toPassedPlanGate(h)

    // The composed dispatch fails the engine-side preflight: the run
    // escalates needs-owner-decision BEFORE any subagent start — the exact
    // pre-start failure the finding demands, in the existing escalation shape.
    const signal = new AbortController().signal
    await expect(h.engine.startExecutor(h.root, { prompt: 'implement', signal }))
      .rejects.toThrowError(/failed preflight.*maxTokens 8192 is invalid/s)
    const snapshot = h.engine.peek(h.root.id)
    expect(snapshot?.phase).toBe('needs-owner-decision')
    expect(snapshot?.diagnostic?.startsWith('routing-escalation:')).toBe(true)
    expect(snapshot?.diagnostic).toContain('maxTokens 8192 is invalid on alpha/m-b')
    // BEFORE start, literally: nothing was handed to the subagent manager,
    // and no executor pin was written for a dispatch that never happened.
    expect(h.subagents.continuableOptions.length).toBe(0)
    expect(snapshot?.routingPins?.executor).toBeUndefined()
    // Both legs ran, in the honest order: the selector validated the bare
    // lock (no maxTokens, no effort — the lock names none), and the engine
    // then preflighted the COMPOSED object that carries the riding tuning.
    expect(f.llm.preflights.some(config =>
      config.provider === 'alpha' && config.model === 'm-b'
      && config.maxTokens === undefined && config.reasoningEffort === undefined)).toBe(true)
    expect(f.llm.preflights.some(config =>
      config.provider === 'alpha' && config.model === 'm-b' && config.maxTokens === 8192)).toBe(true)
  })

  it('(b) equal route + VALID tuning ⇒ dispatched, the composed object proven to have passed preflight whole', async () => {
    const { h, f } = lockedHarness(
      { provider: 'alpha', model: 'm-b', maxTokens: 8192 },
      { provider: 'alpha', model: 'm-b' },
    )
    await toPassedPlanGate(h)
    const signal = new AbortController().signal
    await h.engine.startExecutor(h.root, { prompt: 'implement', signal })

    expect(h.subagents.continuableOptions[0]).toEqual({ provider: 'alpha', model: 'm-b', maxTokens: 8192 })
    // Walk acceptance implies dispatch validity: the preflight saw the riding
    // maxTokens, not just the lock's route fields.
    expect(f.llm.preflights.some(config =>
      config.provider === 'alpha' && config.model === 'm-b' && config.maxTokens === 8192)).toBe(true)
    const routing = routingOf(h, 'start-executor', 'executor')
    expect(routing?.pin).toEqual({ provider: 'alpha', model: 'm-b' })
    expect(routing?.why?.some(entry =>
      entry.includes('accepted the composed dispatch')
      && entry.includes('the exact object the subagent start receives'))).toBe(true)
  })

  it('(c) unequal legacy route ⇒ the lock’s own fields dispatch, the composed leg re-validating exactly them (no tuning rides)', async () => {
    const { h } = lockedHarness(
      { provider: 'beta', model: 'm-c', maxTokens: 4096 },
      { provider: 'alpha', model: 'm-b' },
    )
    await toPassedPlanGate(h)
    const signal = new AbortController().signal
    await h.engine.startExecutor(h.root, { prompt: 'implement', signal })

    // The E8/F11 boundary: nothing rides from an unconfirmed legacy surface —
    // and the composed preflight therefore validated exactly the lock's fields.
    expect(h.subagents.continuableOptions[0]).toEqual({ provider: 'alpha', model: 'm-b' })
    const routing = routingOf(h, 'start-executor', 'executor')
    expect(routing?.pin).toEqual({ provider: 'alpha', model: 'm-b' })
    expect(routing?.why?.some(entry =>
      entry.includes('accepted the composed dispatch') && entry.includes('the lock\'s own fields — no legacy tuning rides'))).toBe(true)
  })
})

// ── F17 (PR #2 Codex round 7): the pool liveness skip splits outage from absence ──
//
// The pool walk's `providerIsLive` skip was unconditional, but an
// `unavailable` snapshot (a `listProviders` throw) carries an EMPTY provider
// list — so one transient catalog read failure read as "every pool provider
// is gone" and the walk ended in plain inheritance without ever attempting
// the preflight that was still available (resolveCallConfig runs
// independently of the failed listing). The liveness skip is now gated on a
// SUCCESSFUL read (`catalogStatus: 'live'`), the F14 split applied to the
// last remaining unconditional liveness check: under an outage the liveness
// leg is skipped, preflight decides, and the outage is recorded in the
// decision's `why` in the F14 wording family. A live read that genuinely
// lacks the provider keeps the unchanged skip (F7(a) keeps proving it).

describe('F17 (PR #2 round 7): the pool liveness skip distinguishes a catalog outage from a vanished provider', () => {
  const F17_MODELS: readonly StubModel[] = [
    ...MODELS,
    { provider: 'gamma', id: 'm-d', contextWindow: 131072 },
  ]

  /** An auto-mode harness whose plan auditor falls to the pool (executor on the alpha family, absent policy). */
  function poolHarness(llm: StubLlm, pool: readonly AgentOptionsLike[]): { readonly h: Harness; readonly catalog: RouteCatalog } {
    const catalog = new RouteCatalog(llm)
    const h = makeHarness({
      routing: { catalog, policyReader: () => ABSENT },
      config: {
        executor: { agentOptions: { provider: 'alpha', model: 'm-a' } },
        crossFamily: { enabled: true, minRisk: 'medium', pool: [...pool] },
      },
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] }),
    })
    return { h, catalog }
  }

  it('(a) outage + a pool entry preflight accepts ⇒ DISPATCHED with the outage recorded and the liveness leg skipped', async () => {
    const llm = new StubLlm(F17_MODELS)
    llm.failProviders = true
    const { h, catalog } = poolHarness(llm, [{ provider: 'gamma', model: 'm-d', maxTokens: 512 }])
    await toExecuting(h)

    // Under the old unconditional skip this was plain inheritance: every
    // entry "not live" on the empty outage snapshot. Now preflight decides.
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'gamma', model: 'm-d', maxTokens: 512 })
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.pin).toEqual({ provider: 'gamma', model: 'm-d' })
    expect(routing?.authorizationSource).toBe('plugin-config')
    expect(routing?.why?.some(entry =>
      entry.includes('provider liveness NOT assertable for the pool walk')
      && entry.includes('catalog unavailable')
      && entry.includes('not evidence the provider is gone')
      && entry.includes('the liveness leg is skipped and preflight decides'))).toBe(true)
    // No liveness skip was recorded — the leg never ran — and the outage is
    // the infrastructure fact it is (F14 wording family), on the cached read.
    expect(routing?.why?.some(entry => entry.includes('is not live in the catalog snapshot'))).toBe(false)
    expect(catalog.snapshot()).resolves.toMatchObject({ catalogStatus: 'unavailable' })
    // Preflight was the actual gate: resolveCallConfig ran for the pick.
    expect(llm.preflights.some(config => config.provider === 'gamma' && config.model === 'm-d')).toBe(true)
  })

  it('(b) outage + preflight failure ⇒ skipped with the preflight reason; the inheritance result stands, the outage named', async () => {
    const llm = new StubLlm(F17_MODELS)
    llm.failProviders = true
    llm.preflightRejects.set('gamma/m-d', 'resolveCallConfig: scripted rejection under outage')
    const { h } = poolHarness(llm, [{ provider: 'gamma', model: 'm-d' }])
    await toExecuting(h)

    // Nothing dispatched: the audit that runs is the INHERIT one (no route
    // options), and the skip carries the PREFLIGHT verdict (the only leg that
    // ran), never a liveness claim the outage could not support.
    expect(h.subagents.auditOptions[0]).toBeUndefined()
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.pin).toBeUndefined()
    expect(routing?.why?.some(entry =>
      entry.includes('pool route gamma/m-d skipped')
      && entry.includes('dispatch preflight rejected it')
      && entry.includes('scripted rejection under outage'))).toBe(true)
    expect(routing?.why?.some(entry =>
      entry.includes('provider liveness NOT assertable for the pool walk')
      && entry.includes('catalog unavailable'))).toBe(true)
    expect(routing?.why?.some(entry => entry.includes('is not live in the catalog snapshot'))).toBe(false)
    expect(h.engine.peek(h.root.id)?.phase).toBe('executing')
  })

  it('(c) live catalog + a provider genuinely absent ⇒ the liveness skip is unchanged', async () => {
    const llm = new StubLlm(F17_MODELS)
    const { h, catalog } = poolHarness(llm, [{ provider: 'beta', model: 'm-c' }])
    // A LIVE read whose listing omits the provider — the real disappearance
    // the skip exists for. Drop beta BEFORE any catalog read this run.
    llm.dropProvider('beta')
    catalog.invalidate()
    await toExecuting(h)

    expect(h.subagents.auditOptions[0]).toBeUndefined()
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.pin).toBeUndefined()
    expect(routing?.why?.some(entry =>
      entry.includes('pool route beta/m-c skipped')
      && entry.includes('its provider is not live in the catalog snapshot'))).toBe(true)
    // The liveness leg decided — preflight was never reached for the entry.
    expect(llm.preflights.some(config => config.provider === 'beta' && config.model === 'm-c')).toBe(false)
  })
})

// ── F20 (PR #2 Codex round 9): a pool-authorized pin reuse carries the COMPLETE entry ──
//
// The pool fallback dispatches the COMPLETE pool entry (`agentOptions: entry`
// — maxTokens and every call-config field), but the pin it records is the
// trimmed route ({provider, model, reasoningEffort?}). A SUBSEQUENT dispatch
// for the same role reused that pin and reconstructed agentOptions from only
// provider/model/effort — the entry's tuning (a configured token cap) was
// silently dropped after the first dispatch. On the reuse path, when the
// pool grant is what authorizes the pin (the auditor pool-equality branch),
// the matching entry is now recovered and dispatched WHOLE, with the
// preflight carrying the same complete fields (the F15 discipline applied to
// reuse). An entry that no longer matches takes its grant with it: the pin
// must stand on session-policy membership alone or re-select (repinFrom
// recorded) — never a silent degradation to the bare reconstruction.

describe('F20 (PR #2 round 9): pin reuse over a pool grant recovers the complete pool entry', () => {
  /** An absent-policy auto run whose plan/execution auditors fall to the pool (executor named to the alpha family). */
  function poolRun(pool: readonly AgentOptionsLike[]): { readonly h: Harness; readonly llm: StubLlm } {
    const llm = new StubLlm(MODELS)
    const catalog = new RouteCatalog(llm)
    const h = makeHarness({
      routing: { catalog, policyReader: () => ABSENT },
      config: {
        executor: { agentOptions: { provider: 'alpha', model: 'm-a' } },
        crossFamily: { enabled: true, minRisk: 'medium', pool: [...pool] },
      },
      subagents: stubSubagents({ verdicts: [
        { verdict: 'pass', note: 'plan ok' },
        { verdict: 'pass', note: 'exec ok' },
        { verdict: 'pass', note: 'exec ok again' },
      ] }),
    })
    return { h, llm }
  }

  /** The last execution-auditor routing detail in the durable stream. */
  function lastExecDetail(h: Harness): RoutingDecisionDetail | undefined {
    const details = routingDetails(h).filter(detail => detail.role === 'execution-auditor')
    return details[details.length - 1]
  }

  it('(a) a pool entry with maxTokens ⇒ BOTH sequential dispatches carry it, and the reuse\'s preflight received the complete fields', async () => {
    const { h, llm } = poolRun([{ provider: 'beta', model: 'm-c', maxTokens: 4321 }])
    await toClosing(h)
    // First dispatch: the pool walk hands the COMPLETE entry to the start...
    expect(h.subagents.auditOptions[1]).toEqual({ provider: 'beta', model: 'm-c', maxTokens: 4321 })
    // ...and pins the trimmed route (the pin shape carries no maxTokens).
    expect(h.engine.peek(h.root.id)?.routingPins?.['execution-auditor']).toEqual({ provider: 'beta', model: 'm-c' })

    const preflightsBefore = llm.preflights.length
    await h.engine.audit(h.root, { role: 'execution', prompt: 'again' })

    // The REUSE recovers the complete entry: the token cap is NOT silently
    // dropped after the first dispatch (before F20 this was {beta, m-c} only).
    expect(h.subagents.auditOptions[2]).toEqual({ provider: 'beta', model: 'm-c', maxTokens: 4321 })
    const last = lastExecDetail(h)
    expect(last?.authorizationSource).toBe('plugin-config')
    expect(last?.repinFrom).toBeUndefined()
    expect(last?.pin).toEqual({ provider: 'beta', model: 'm-c' })
    expect(last?.why?.some(entry =>
      entry.includes('preflight accepted on the COMPLETE pool entry') && entry.includes('maxTokens 4321'))).toBe(true)
    // Preflight proven to have received it: the reuse's resolveCallConfig ran
    // on the complete fields — and NEVER on a bare provider/model fallback.
    const reusePreflights = llm.preflights.slice(preflightsBefore)
    expect(reusePreflights.some(config =>
      config.provider === 'beta' && config.model === 'm-c' && config.maxTokens === 4321)).toBe(true)
    expect(reusePreflights.some(config =>
      config.provider === 'beta' && config.model === 'm-c' && config.maxTokens === undefined)).toBe(false)
    // The pin rides unchanged: same route, no repin.
    expect(h.engine.peek(h.root.id)?.routingPins?.['execution-auditor']).toEqual({ provider: 'beta', model: 'm-c' })
  })

  it('(b) the pool entry VANISHES between dispatches ⇒ the grant died with it: re-selection with repinFrom, not a silent pin ride', async () => {
    const { h } = poolRun([{ provider: 'beta', model: 'm-c' }])
    await toClosing(h)
    expect(h.engine.peek(h.root.id)?.routingPins?.['execution-auditor']).toEqual({ provider: 'beta', model: 'm-c' })

    // The owner edits the pool between dispatches: the entry whose grant kept
    // the pin authorized is GONE (the engine reads the live pool at each
    // decision, so the in-place edit is the next dispatch's truth).
    ;(h.engine.config.crossFamily.pool as AgentOptionsLike[]).pop()
    expect(h.engine.config.crossFamily.pool).toHaveLength(0)

    await h.engine.audit(h.root, { role: 'execution', prompt: 'again' })
    // NOT a silent degradation to a bare reconstruction: the pin's authority
    // is gone with the entry, the conservative F1 refusal fired, and the
    // re-selection inherited (nothing explicit left to dispatch).
    expect(h.subagents.auditOptions[2]).toBeUndefined()
    const last = lastExecDetail(h)
    expect(last?.pin).toBeUndefined()
    expect(last?.repinFrom).toEqual({ provider: 'beta', model: 'm-c' })
    expect(last?.authorizationSource).toBeUndefined()
    expect(last?.why?.some(entry =>
      entry.includes('cannot re-establish its session-policy authorization') && entry.includes('absent'))).toBe(true)
    // The pin is cleared in the snapshot — the fold re-derives it from the pinless record.
    expect(h.engine.peek(h.root.id)?.routingPins?.['execution-auditor']).toBeUndefined()
  })

  it('(c) a session-policy pin with NO matching pool entry keeps the existing reconstruction — the pool never widens into it', async () => {
    const f = fixture([...MODELS, { provider: 'gamma', id: 'm-d', contextWindow: 131072 }], PRESENT_ABC)
    const h = makeHarness({
      routing: f.portsFor(),
      config: {
        executor: { agentOptions: { provider: 'alpha', model: 'm-a' } },
        crossFamily: { enabled: true, minRisk: 'medium', pool: [{ provider: 'gamma', model: 'm-d', maxTokens: 999 }] },
      },
      subagents: stubSubagents({ verdicts: [
        { verdict: 'pass', note: 'plan ok' },
        { verdict: 'pass', note: 'exec ok' },
        { verdict: 'pass', note: 'exec ok again' },
      ] }),
    })
    await toClosing(h)
    // The pin was settled by POLICY SELECTION (beta/m-c, effort from the
    // adapter default) — the pool entry (gamma) does not match its route.
    expect(h.engine.peek(h.root.id)?.routingPins?.['execution-auditor']).toEqual({ provider: 'beta', model: 'm-c', reasoningEffort: 'high' })

    const preflightsBefore = f.llm.preflights.length
    await h.engine.audit(h.root, { role: 'execution', prompt: 'again' })

    // Existing reconstruction, unchanged: provider/model/effort from the pin —
    // the non-matching entry's maxTokens never rides, and no pool claim appears.
    expect(h.subagents.auditOptions[2]).toEqual({ provider: 'beta', model: 'm-c', reasoningEffort: 'high' })
    const last = lastExecDetail(h)
    expect(last?.authorizationSource).toBe('session-policy')
    expect(last?.repinFrom).toBeUndefined()
    expect(last?.why?.some(entry => entry.includes('authorized by the session policy when selected'))).toBe(true)
    expect(last?.why?.some(entry => entry.includes('COMPLETE pool entry'))).toBe(false)
    expect(f.llm.preflights.slice(preflightsBefore).some(config =>
      config.provider === 'beta' && config.model === 'm-c'
      && config.maxTokens === undefined && config.reasoningEffort === 'high')).toBe(true)
  })
})

// ── F21 (PR #2 Codex round 10): blank pool efforts normalize to absence ──
//
// The pool entry schema accepts `reasoningEffort: ''` (or whitespace) — a
// blank string is a legal value. Before F21 the blank value was copied into
// the routing PIN and dispatched verbatim, while the fold's detail validation
// requires an effort to be a NON-EMPTY string when present: a completed plan
// audit's verdict commit was then rejected by the fold AFTER the run had
// already entered plan-reviewing, wedging the run there. The fix normalizes
// blank/whitespace pool efforts to ABSENCE at the ONE construction seam
// (the engine's normalized pool read), so dispatch options, the pin, the
// preflight, and the fold's validation all agree that a blank pool effort
// names no effort at all — exactly what a blank LOCK effort already meant
// (lock resolution trims-or-drops, `effortOf` in resolveRouting).

describe('F21 (PR #2 round 10): blank pool efforts normalize to absence before pin/dispatch', () => {
  /** The F7(f) shape — NO routing ports, executor on the alpha family — with the pool entry's effort scripted. */
  function blankEffortHarness(effort: string): Harness {
    return makeHarness({
      config: {
        executor: { agentOptions: { provider: 'alpha', model: 'm-a' } },
        crossFamily: { enabled: true, minRisk: 'medium', pool: [{ provider: 'beta', model: 'm-c', reasoningEffort: effort }] },
      },
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] }),
    })
  }

  it('(a) empty-string effort + no catalog port ⇒ dispatch and pin carry NO effort; the verdict commit folds and the run completes plan review', async () => {
    const h = blankEffortHarness('')
    // Before F21 this threw AP_ROUTING_DETAIL at the verdict commit with the
    // run already wedged in plan-reviewing; now the plan gate completes.
    await toExecuting(h)
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'beta', model: 'm-c' })
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.pin).toEqual({ provider: 'beta', model: 'm-c' })
    expect('reasoningEffort' in (routing?.pin ?? {})).toBe(false)
    expect(h.engine.peek(h.root.id)?.phase).toBe('executing')
    expect(h.engine.peek(h.root.id)?.planGate).toBe('pass')
    // The durable stream replays clean through the verdict commit: the fold
    // accepted the routing detail the engine wrote.
    expect(foldRun(eventsOf(h)).snapshot?.phase).toBe('executing')
  })

  it('(b) whitespace-only effort ⇒ same absence (a blank is a blank, trim-exact)', async () => {
    const h = blankEffortHarness('   ')
    await toExecuting(h)
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'beta', model: 'm-c' })
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.pin).toEqual({ provider: 'beta', model: 'm-c' })
    expect(h.engine.peek(h.root.id)?.planGate).toBe('pass')
    expect(foldRun(eventsOf(h)).snapshot?.planGate).toBe('pass')
  })

  it('(c) a non-empty effort is preserved verbatim on dispatch and pin (existing green, restated)', async () => {
    const h = blankEffortHarness('high')
    await toExecuting(h)
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'beta', model: 'm-c', reasoningEffort: 'high' })
    expect(routingOf(h, 'audit', 'plan-auditor')?.pin).toEqual({ provider: 'beta', model: 'm-c', reasoningEffort: 'high' })
    expect(h.engine.peek(h.root.id)?.planGate).toBe('pass')
  })

  it('(d) a padded-but-present effort is TRIMMED to its value — the same normalization lock resolution applies (parity)', async () => {
    const h = blankEffortHarness(' high ')
    await toExecuting(h)
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'beta', model: 'm-c', reasoningEffort: 'high' })
    expect(routingOf(h, 'audit', 'plan-auditor')?.pin).toEqual({ provider: 'beta', model: 'm-c', reasoningEffort: 'high' })
  })

  it('(e) with a catalog wired, the WALK dispatch/pin/preflight AND the pool-authorized pin REUSE all carry no effort', async () => {
    const llm = new StubLlm(MODELS)
    const catalog = new RouteCatalog(llm)
    const h = makeHarness({
      routing: { catalog, policyReader: () => ABSENT },
      config: {
        executor: { agentOptions: { provider: 'alpha', model: 'm-a' } },
        crossFamily: { enabled: true, minRisk: 'medium', pool: [{ provider: 'beta', model: 'm-c', reasoningEffort: '' }] },
      },
      subagents: stubSubagents({ verdicts: [
        { verdict: 'pass', note: 'plan ok' },
        { verdict: 'pass', note: 'exec ok' },
        { verdict: 'pass', note: 'exec ok again' },
      ] }),
    })
    await toClosing(h)
    // The walk's first dispatches: the entry minus its blank effort.
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'beta', model: 'm-c' })
    expect(h.subagents.auditOptions[1]).toEqual({ provider: 'beta', model: 'm-c' })
    expect(h.engine.peek(h.root.id)?.routingPins?.['execution-auditor']).toEqual({ provider: 'beta', model: 'm-c' })
    // Every beta/m-c preflight ran on the effort-less shape too.
    expect(llm.preflights.filter(config => config.provider === 'beta' && config.model === 'm-c')
      .every(config => config.reasoningEffort === undefined)).toBe(true)

    await h.engine.audit(h.root, { role: 'execution', prompt: 'again' })
    // The pool-authorized REUSE (auditorPoolMatchFor) recovers the normalized
    // entry: no blank effort rides the second dispatch, and the recorded pin
    // stays effort-less instead of resurrecting the blank.
    expect(h.subagents.auditOptions[2]).toEqual({ provider: 'beta', model: 'm-c' })
    const details = routingDetails(h).filter(detail => detail.role === 'execution-auditor')
    expect(details[details.length - 1]?.pin).toEqual({ provider: 'beta', model: 'm-c' })
    expect(foldRun(eventsOf(h)).snapshot?.phase).toBe('closing')
  })
})

// ── F23 (PR #2 round 11): a catalog outage is not "all providers gone" for auto selection ──
//
// The last unguarded conflation of the F14/F17 class. When `listProviders`
// throws, `RouteCatalog.snapshot()` degrades to `catalogStatus: 'unavailable'`
// with an EMPTY provider list — and the auto path's eligibility intersection
// read that empty list as "every policy provider is gone": a FRESH auto
// dispatch inherited without ever attempting `resolveModelInfo` or preflight
// (both of which run independently of the failed listing), and the evidence
// never named the outage. The selector now branches on the snapshot's own
// status BEFORE the intersection: under an outage the policy routes remain
// candidates, preflight is the actual gate, and the outage rides `why` on
// every outcome — a dispatched route and a retained inheritance alike.

describe('F23 (PR #2 round 11): a catalog outage is not "all providers gone" for auto selection', () => {
  /** A run driven to a passed plan with the plan auditor's dispatch still ahead. */
  async function toPlannedAudit(h: Harness): Promise<void> {
    await h.engine.init(h.root, makeTriage(STANDARD), [undeclaredSeed('m1')])
    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    await h.engine.submitPlan(h.root, 'plan')
  }

  it('(a) fresh auto dispatch under an outage ⇒ the policy route is DISPATCHED (not inherited), why names the outage', async () => {
    const f = fixture(MODELS, PRESENT_ABC)
    const h = makeHarness({
      routing: f.portsFor(),
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'plan ok' }] }),
    })
    await toPlannedAudit(h)

    const preflightsBefore = f.llm.preflights.length
    f.llm.failProviders = true
    f.catalog.invalidate()

    await h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })
    // The outage did NOT terminate eligibility: the policy routes stayed
    // candidates and the same route as the healthy-catalog run (i) was
    // selected, preflight-gated, and dispatched explicitly.
    expect(h.subagents.auditOptions[0]).toEqual({ provider: 'beta', model: 'm-c', reasoningEffort: 'high' })
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.pin).toEqual({ provider: 'beta', model: 'm-c', reasoningEffort: 'high' })
    expect(routing?.authorizationSource).toBe('session-policy')
    expect(routing?.why?.some(entry =>
      entry.includes('catalog: snapshot unavailable') && entry.includes('not evidence of provider absence'))).toBe(true)
    expect(h.engine.peek(h.root.id)?.phase).not.toBe('needs-owner-decision')
    // The gate actually ran AFTER the outage began — the read failed, not the
    // route's ability to serve.
    const afterOutage = f.llm.preflights.slice(preflightsBefore)
    expect(afterOutage.some(config => config.provider === 'beta' && config.model === 'm-c')).toBe(true)
  })

  it('(b) outage + every policy route failing preflight ⇒ inheritance RETAINED with the outage and every skip named — no escalation', async () => {
    const f = fixture(MODELS, PRESENT_ABC)
    const h = makeHarness({
      routing: f.portsFor(),
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'plan ok' }] }),
    })
    await toPlannedAudit(h)

    f.llm.preflightRejects.set('alpha/m-a', 'resolveCallConfig: scripted rejection under outage')
    f.llm.preflightRejects.set('beta/m-c', 'resolveCallConfig: scripted rejection under outage')
    f.llm.failProviders = true
    f.catalog.invalidate()

    await h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })
    // Pool-walk discipline: exhausting the ranked list on preflight-only
    // evidence (no liveness leg was assertable) retains INHERITANCE — the
    // dispatch carries no agentOptions and the run does NOT escalate.
    expect(h.subagents.auditOptions[0]).toBeUndefined()
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.pin).toBeUndefined()
    expect(routing?.why?.some(entry =>
      entry.includes('catalog: snapshot unavailable') && entry.includes('not evidence of provider absence'))).toBe(true)
    expect(routing?.why?.some(entry =>
      entry.includes('rejected all 2 ranked candidate(s) under the catalog outage')
      && entry.includes('alpha/m-a') && entry.includes('beta/m-c')
      && entry.includes('inheritance retained'))).toBe(true)
    expect(h.engine.peek(h.root.id)?.phase).not.toBe('needs-owner-decision')
    // The walk really attempted both candidates — the outage did not end it
    // early at the intersection.
    expect(f.llm.preflights.some(config => config.provider === 'alpha' && config.model === 'm-a')).toBe(true)
    expect(f.llm.preflights.some(config => config.provider === 'beta' && config.model === 'm-c')).toBe(true)
  })

  it('(c) LIVE catalog + empty intersection ⇒ the pre-F23 inheritance stands, record unchanged', async () => {
    // A live catalog that intersects nothing in the policy: on a successful
    // read, absence IS evidence, and the empty-intersection inheritance is
    // the honest termination — the F23 carve-out must not weaken it.
    const f = fixture(MODELS, { kind: 'present', routes: [{ provider: 'gamma', model: 'm-g' }, { provider: 'delta', model: 'm-d' }] })
    const h = makeHarness({
      routing: f.portsFor(),
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'plan ok' }] }),
    })
    await toPlannedAudit(h)

    await h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })
    expect(h.subagents.auditOptions[0]).toBeUndefined()
    const routing = routingOf(h, 'audit', 'plan-auditor')
    expect(routing?.pin).toBeUndefined()
    expect(routing?.why?.some(entry =>
      entry.includes('authorized set is EMPTY after the live-catalog intersection'))).toBe(true)
    expect(routing?.why?.some(entry => entry.includes('catalog: snapshot unavailable'))).toBe(false)
  })
})
