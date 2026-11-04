/** Shared test fixtures: fake agents, stub subagents, temp ledger stores, the engine harness. */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AutopilotEngine } from '../src/engine.js'
import type {
  AgentRef,
  EnginePorts,
  EnvironmentProbes,
  RoutingPorts,
  SubagentActivationRef,
  SubagentsRef,
} from '../src/engine.js'
import { resolveConfig } from '../src/index.js'
import type { ConfigInput } from '../src/index.js'
import { FileLedgerStore, legacySourcesOf } from '../src/store/ledger.js'
import type { LedgerStoreLike } from '../src/store/ledger.js'
import type { LegacySources } from '../src/legacy/index.js'
import type { DelegationRecord } from '../src/domain/ledger-types.js'

export interface FakeAgent extends AgentRef {
  readonly appended: Array<{ type: string; data: unknown }>
  /** The fake accepts ANY event type so tests can script a turn; the engine's mirror only names `sandbox/mode`. */
  readonly session: AgentRef['session'] & { append(type: string, data: unknown): void }
}

export function fakeAgent(id: string, parentSession?: string, cwd?: string, ctx?: unknown): FakeAgent {
  const events: Array<{ type: string; data: unknown }> = []
  return {
    id,
    appended: events,
    options: { provider: 'fake', model: 'fake-model' },
    ...(ctx === undefined ? {} : { ctx }),
    session: {
      header: {
        ...(parentSession === undefined ? {} : { parentSession }),
        ...(cwd === undefined ? {} : { cwd }),
      },
      snapshotEvents: () => events.slice(),
      append(type: string, data: unknown) {
        events.push({ type, data })
      },
    },
  }
}

export class FakeAgents {
  private readonly map = new Map<string, AgentRef>()
  add(agent: AgentRef): void { this.map.set(agent.id, agent) }
  remove(id: string): void { this.map.delete(id) }
  get(id: string): AgentRef | undefined { return this.map.get(id) }
}

/** A subagent runtime that records every activation and resolves each one immediately. */
export function stubSubagents(): SubagentsRef & {
  readonly activations: Array<{ childId?: string; label: string; prompt: string }>
  readonly messages: Array<{ childId: string; text: string }>
} {
  const activations: Array<{ childId?: string; label: string; prompt: string }> = []
  const messages: Array<{ childId: string; text: string }> = []
  let counter = 0
  return {
    activations,
    messages,
    async startActivation(spec): Promise<SubagentActivationRef> {
      counter += 1
      const childId = spec.childId ?? `child-${counter}`
      activations.push({
        ...(spec.childId === undefined ? {} : { childId: spec.childId }),
        label: spec.label,
        prompt: spec.request.prompt.map(block => block.text).join('\n'),
      })
      return { childId, result: Promise.resolve({ stopReason: 'completed' }), async dispose() {} }
    },
    async sendMessage(_sender, childId, content) {
      messages.push({ childId, text: content.map(block => block.text).join('\n') })
      return {}
    },
    interrupt() {},
    async drainChildren() { return {} },
  }
}

export interface Harness {
  engine: AutopilotEngine
  agents: FakeAgents
  subagents: ReturnType<typeof stubSubagents>
  root: FakeAgent
  ledgers: LedgerStoreLike
  sources: LegacySources
  storeDir: string
  warnings: string[]
}

export function makeHarness(options: {
  config?: ConfigInput
  subagents?: ReturnType<typeof stubSubagents>
  routing?: RoutingPorts
  environment?: EnvironmentProbes
  /** Legacy runs in the file root, as fixture file names under test/fixtures/legacy-synthetic. */
  legacyFixtures?: readonly string[]
  rootId?: string
  cwd?: string
  rootCtx?: unknown
  ports?: Partial<EnginePorts>
} = {}): Harness {
  const storeDir = mkdtempSync(join(tmpdir(), 'dsh-autopilot-test-'))
  const agents = new FakeAgents()
  const root = fakeAgent(options.rootId ?? 'root-1', undefined, options.cwd, options.rootCtx)
  agents.add(root)
  const subagents = options.subagents ?? stubSubagents()
  const warnings: string[] = []
  for (const name of options.legacyFixtures ?? []) writeLegacyFixture(storeDir, name)
  const ledgers = FileLedgerStore.open(storeDir)
  const sources = legacySourcesOf(storeDir)
  const engine = new AutopilotEngine(agents, subagents, ledgers, sources, resolveConfig(options.config), {
    ...(options.routing === undefined ? {} : { routing: options.routing }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    warn: message => warnings.push(message),
    ...options.ports,
  })
  return { engine, agents, subagents, root, ledgers, sources, storeDir, warnings }
}

const LEGACY_FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'legacy-synthetic')

/** Copy one synthetic legacy stream into `<root>/runs/<runId>/events.jsonl`; returns its run id. */
export function writeLegacyFixture(root: string, name: string): string {
  const raw = readFileSync(join(LEGACY_FIXTURES, name), 'utf8')
  const first = JSON.parse(raw.split('\n')[0]!) as { snapshot: { runId: string } }
  const runId = first.snapshot.runId
  mkdirSync(join(root, 'runs', runId), { recursive: true })
  writeFileSync(join(root, 'runs', runId, 'events.jsonl'), raw)
  return runId
}

/** A minimal delegation record for ledger fixtures. */
export function delegation(childId: string, state: DelegationRecord['state'], overrides: Partial<DelegationRecord> = {}): DelegationRecord {
  return {
    childId,
    role: 'worker',
    parentId: 'root-1',
    depth: 1,
    generation: 1,
    title: `task for ${childId}`,
    state,
    modelSource: 'inherit',
    effortSource: 'host-default',
    routeMatch: 'pending',
    tools: 'inherit',
    maxDepth: 1,
    startedAt: '2026-11-04T00:00:00.000Z',
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A fake host for the delegation tests: startActivation creates a real-shaped child agent,
// announces it through the engine's agent/created hook, and settles on demand.
// ─────────────────────────────────────────────────────────────────────────────

import { RouteCatalog } from '../src/routing/catalog.js'
import type { LlmCallConfig, LlmRuntimeSubset } from '../src/routing/catalog.js'
import type { SessionPolicyState } from '../src/routing/authorize.js'
import type { NativeGoalView } from '../src/engine.js'

export interface StubModel {
  readonly provider: string
  readonly id: string
  readonly contextWindow?: number
  readonly defaultEffort?: string
}

export function stubLlm(models: readonly StubModel[], over: Partial<LlmRuntimeSubset> = {}): LlmRuntimeSubset {
  const providers = [...new Set(models.map(model => model.provider))]
  return {
    listProviders: () => providers.map(id => ({ id, name: id })),
    listModels: async (provider: string) => models.filter(m => m.provider === provider).map(m => ({ provider, id: m.id, name: m.id })),
    resolveModelInfo: async (provider: string, model: string) => {
      const hit = models.find(c => c.provider === provider && c.id === model)
      if (hit === undefined) throw new Error(`unknown route ${provider}/${model}`)
      return {
        provider,
        id: model,
        name: model,
        ...(hit.contextWindow !== undefined ? { context: { contextWindow: hit.contextWindow } } : {}),
        ...(hit.defaultEffort !== undefined ? { reasoning: { efforts: [{ id: hit.defaultEffort, name: hit.defaultEffort }], defaultEffort: hit.defaultEffort } } : {}),
      }
    },
    resolveCallConfig: async (config: LlmCallConfig) => ({ ...config }),
    ...over,
  }
}

export const catalogOf = (models: readonly StubModel[], over: Partial<LlmRuntimeSubset> = {}): RouteCatalog => new RouteCatalog(stubLlm(models, over))

export const policyOf = (...routes: readonly [string, string][]): SessionPolicyState => ({
  kind: 'present',
  routes: routes.map(([provider, model]) => ({ provider, model })),
})

export interface Deferred { resolve(value: { stopReason: string; structured?: unknown; diagnostic?: string }): void }

export interface DelegationHost {
  engine: AutopilotEngine
  agents: FakeAgents
  root: FakeAgent
  ledgers: LedgerStoreLike
  storeDir: string
  warnings: string[]
  /** Every startActivation spec, in call order. */
  starts: Array<{ childId?: string; label: string; delivery: string; maxDepth?: number; outputSchema?: object; agentOptions?: Record<string, unknown>; prompt: string; parentId: string; provider: string }>
  /** restrict() calls per child id. */
  restricts: Map<string, string[][]>
  /** Tool names registered in each child's own scope. */
  childTools: Map<string, string[]>
  /** Settle one child's activation. */
  settle(childId: string, result?: { stopReason: string; structured?: unknown; diagnostic?: string }): void
  /** A child agent as the host would hold it (cold resume): created and announced without a start. */
  announceExisting(childId: string, parentId?: string): FakeAgent
  /** Make the next startActivation throw. */
  failNextStart: { error?: Error }
  /** Make restrict() throw for a child id once. */
  restrictThrows: Map<string, Error>
  /** Make EVERY restrict() throw while set. */
  restrictAlways: { error?: Error }
}

export function delegationHost(options: {
  config?: ConfigInput
  models?: readonly StubModel[]
  catalog?: RouteCatalog
  policy?: SessionPolicyState
  registered?: readonly string[]
  maxDepthSetting?: number
  goal?: () => NativeGoalView | undefined
  driver?: () => boolean | undefined
  rootId?: string
  hold?: (childId: string) => boolean
} = {}): DelegationHost {
  const storeDir = mkdtempSync(join(tmpdir(), 'dsh-autopilot-delegation-'))
  const agents = new FakeAgents()
  const rootTools: string[] = []
  const root = fakeAgent(options.rootId ?? 'root-1', undefined, undefined, { tools: { register: (def: { name?: string }) => { rootTools.push(def.name ?? '?'); return () => {} } } })
  agents.add(root)
  const starts: DelegationHost['starts'] = []
  const restricts = new Map<string, string[][]>()
  const childTools = new Map<string, string[]>()
  const deferreds = new Map<string, Deferred>()
  const failNextStart: { error?: Error } = {}
  const restrictThrows = new Map<string, Error>()
  const restrictAlways: { error?: Error } = {}
  const warnings: string[] = []
  let counter = 0
  let engine!: AutopilotEngine

  const makeChild = (childId: string, parentId: string, options2?: Record<string, unknown>): FakeAgent => {
    const tools: string[] = []
    childTools.set(childId, tools)
    const child = fakeAgent(childId, parentId, undefined, {
      tools: {
        restrict(filter: { allow: string[] }) {
          if (restrictAlways.error !== undefined) throw restrictAlways.error
          const thrown = restrictThrows.get(childId)
          if (thrown !== undefined) { restrictThrows.delete(childId); throw thrown }
          restricts.set(childId, [...(restricts.get(childId) ?? []), [...filter.allow]])
        },
        register(def: { name?: string }) { tools.push(def.name ?? '?'); return () => {} },
      },
    })
    const config = { provider: (options2?.['provider'] as string | undefined) ?? 'host', model: (options2?.['model'] as string | undefined) ?? 'default', ...(options2?.['reasoningEffort'] === undefined ? {} : { reasoningEffort: options2['reasoningEffort'] }) }
    child.session.append('request/header', { header: { config }, reason: 'initial' })
    return child
  }

  const subagents: SubagentsRef = {
    async startActivation(spec): Promise<SubagentActivationRef> {
      const pending = failNextStart.error
      if (pending !== undefined) { failNextStart.error = undefined; throw pending }
      counter += 1
      const childId = spec.childId ?? `auto-child-${counter}`
      const parent = spec.request.parent as FakeAgent
      starts.push({
        ...(spec.childId === undefined ? {} : { childId: spec.childId }),
        label: spec.label,
        delivery: spec.delivery,
        ...(spec.request.maxDepth === undefined ? {} : { maxDepth: spec.request.maxDepth }),
        ...(spec.request.outputSchema === undefined ? {} : { outputSchema: spec.request.outputSchema }),
        ...(spec.request.agentOptions === undefined ? {} : { agentOptions: { ...spec.request.agentOptions } }),
        prompt: spec.request.prompt.map(b => b.text).join('\n'),
        parentId: parent.id,
        provider: spec.provider,
      })
      const child = makeChild(childId, parent.id, spec.request.agentOptions as Record<string, unknown> | undefined)
      agents.add(child)
      // The host announces the child before startActivation returns; a throw vetoes it.
      try {
        engine.onChildCreated(child)
      } catch (error) {
        agents.remove(childId)
        throw error
      }
      let resolve!: Deferred['resolve']
      const result = new Promise<{ stopReason: string; structured?: unknown; diagnostic?: string }>((r) => { resolve = r })
      deferreds.set(childId, { resolve })
      return { childId, result, async dispose() {} }
    },
    async sendMessage() { return {} },
    interrupt() {},
    async drainChildren() { return {} },
  }

  const ledgers = FileLedgerStore.open(storeDir)
  engine = new AutopilotEngine(agents, subagents, ledgers, legacySourcesOf(storeDir), resolveConfig(options.config), {
    routing: {
      ...(options.catalog === undefined && options.models === undefined ? {} : { catalog: options.catalog ?? catalogOf(options.models ?? []) }),
      policyReader: () => options.policy ?? { kind: 'absent' },
    },
    environment: {
      ...(options.registered === undefined ? {} : { registeredToolNames: () => options.registered }),
      ...(options.maxDepthSetting === undefined ? {} : { subagentMaxDepth: () => options.maxDepthSetting }),
      ...(options.goal === undefined ? {} : { readGoal: () => options.goal!() }),
      ...(options.driver === undefined ? {} : { goalDriverPresent: options.driver }),
    },
    warn: message => warnings.push(message),
    now: (() => { let t = 0; return () => `2026-11-04T10:00:${String(Math.min(59, t++)).padStart(2, '0')}.000Z` })(),
  })
  return {
    engine, agents, root, ledgers, storeDir, warnings, starts, restricts, childTools,
    settle(childId, result = { stopReason: 'completed' }) { deferreds.get(childId)?.resolve(result) },
    announceExisting(childId, parentId = root.id) {
      const child = makeChild(childId, parentId)
      agents.add(child)
      engine.onChildCreated(child)
      return child
    },
    failNextStart,
    restrictThrows,
    restrictAlways,
  }
}
