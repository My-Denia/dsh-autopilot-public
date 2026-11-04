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
