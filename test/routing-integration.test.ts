/**
 * Routing integration at the structural boundary: the runtime wiring
 * (`createRoutingWiring`) over probed services, the planner-installer port, and
 * the live routing read (`engine.routing()`) that follows a volatile config patch.
 *
 * The 0.2.x version of this file drove the REAL run engine through audit and
 * executor dispatches and asserted on its durable event stream (F1 to F29: pin
 * reuse, pool fallback, rotation, work-class reachability on the status view).
 * That engine and stream are retired. The selection rules themselves are tested
 * directly in `test/routing.test.ts` (`selectRoute`), the role-level routing in
 * `test/roles.test.ts` (`routeForDelegation`), and the dispatch layer adds its
 * own cases with the stage-2 delegation tools.
 */

import { describe, expect, it } from 'vitest'
import { AutopilotEngine } from '../src/engine.js'
import { Config } from '../src/config.js'
import { createRoutingWiring, resolveConfig, volatileRoutingAccess } from '../src/index.js'
import type { ConfigInput } from '../src/index.js'
import { RouteCatalog } from '../src/routing/catalog.js'
import type { LlmCallConfig, LlmRuntimeSubset } from '../src/routing/catalog.js'
import { FileLedgerStore, legacySourcesOf } from '../src/store/ledger.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeAgents, fakeAgent, stubSubagents } from './helpers.js'

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
  /** F29 fixtures: model id → an effort `resolveCallConfig` MATERIALIZES when the config carries none (the facts declare nothing). */
  public readonly materializeEfforts = new Map<string, string>()
  /** F29 fixtures: when true, materialization fires only on configs carrying other call-config fields — isolating the engine's composed-locked preflight site (the only one that sees riding tuning). */
  public materializeOnlyWithExtraFields = false

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
    // F29 fixtures: an adapter that materializes its default effort ONLY in
    // the resolved config — nothing in the model facts names it.
    const materialized = config.reasoningEffort === undefined ? this.materializeEfforts.get(config.model) : undefined
    if (materialized !== undefined && (!this.materializeOnlyWithExtraFields || config.maxTokens !== undefined)) {
      return { ...config, reasoningEffort: materialized }
    }
    return { ...config }
  }
}

const MODELS: readonly StubModel[] = [
  { provider: 'alpha', id: 'm-a', contextWindow: 131072, efforts: ['high'], defaultEffort: 'high' },
  { provider: 'alpha', id: 'm-b', contextWindow: 131072 },
  { provider: 'beta', id: 'm-c', contextWindow: 200000, efforts: ['high'], defaultEffort: 'high' },
]

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

// ── The live routing read follows a volatile patch without a remount (F2) ──

describe('F2: engine.routing() follows a volatile routing patch without a remount', () => {
  const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
  type Ref = { get(): unknown } & Record<symbol, unknown>

  /** Commit one simulated volatile update (what the loader runtime's patch path does to the ref). */
  function patch(ref: Ref, next: unknown): void {
    ;(ref[VOLATILE_WRITE] as (value: unknown) => void)(next)
  }

  /** The loader-path config value with volatile routing leaves, and an engine reading it live. */
  function volatileEngine(raw: unknown) {
    const validated = Config['~standard'].validate(raw) as { value?: ConfigInput }
    expect(validated.value).toBeDefined()
    const value = validated.value as ConfigInput
    // The seam: the accessor is wired EXACTLY because the leaves are references.
    expect(volatileRoutingAccess(value)).toBeDefined()
    const routingRefs = (value as unknown as { routing: { mode: Ref; roles: Record<string, { lock: Ref }> } }).routing
    const dir = mkdtempSync(join(tmpdir(), 'dsh-autopilot-f2-'))
    const agents = new FakeAgents()
    agents.add(fakeAgent('root-1'))
    const engine = new AutopilotEngine(agents, stubSubagents(), FileLedgerStore.open(dir), legacySourcesOf(dir), resolveConfig(value), {
      liveRouting: volatileRoutingAccess(value)!,
    })
    return { engine, routingRefs }
  }

  it('a routing.mode auto to off patch is visible at the next read', () => {
    const { engine, routingRefs } = volatileEngine({ routing: { mode: 'auto' } })
    expect(engine.routing().mode).toBe('auto')
    patch(routingRefs.mode, 'off')
    expect(engine.routing().mode).toBe('off')
  })

  it('a lock patched onto a role is followed by the next read', () => {
    const { engine, routingRefs } = volatileEngine({ routing: { roles: { executionAuditor: {} } } })
    expect(engine.routing().roles['execution-auditor'].mode).not.toBe('locked')
    patch(routingRefs.roles.executionAuditor?.lock as Ref, { provider: 'alpha', model: 'm-a' })
    const role = engine.routing().roles['execution-auditor']
    expect(role.mode).toBe('locked')
    expect(role).toMatchObject({ provider: 'alpha', model: 'm-a' })
  })

  it('a patch to an INVALID mode makes the read throw with the validation failure (the dispatch layer decides what to do)', () => {
    const { engine, routingRefs } = volatileEngine({ routing: { mode: 'auto' } })
    patch(routingRefs.mode, 'on')
    expect(() => engine.routing()).toThrowError(/routing\.mode must be 'auto' or 'off'/)
  })

  it('without a live accessor the engine reads the config snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-autopilot-f2-'))
    const engine = new AutopilotEngine(new FakeAgents(), stubSubagents(), FileLedgerStore.open(dir), legacySourcesOf(dir), resolveConfig({ routing: { mode: 'off' } }))
    expect(engine.routing().mode).toBe('off')
  })

  it('the plain path keeps the snapshot semantics: no volatile leaves means no accessor at all', () => {
    expect(volatileRoutingAccess(undefined)).toBeUndefined()
    expect(volatileRoutingAccess({ routing: { mode: 'auto' } })).toBeUndefined()
    expect(volatileRoutingAccess({ executor: { agentOptions: { provider: 'p', model: 'm' } } })).toBeUndefined()
  })
})
