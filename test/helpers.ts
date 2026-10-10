/** Shared test fixtures: snapshots, fake agents, stub subagents, temp stores. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutopilotEngine } from '../src/engine.js'
import type { AgentOptionsLike, AgentRef, EnvironmentProbes, ResolvedConfig, RoutingPorts, SubagentsRef, SubagentRunRef } from '../src/engine.js'
import { resolveConfig } from '../src/index.js'
import { RunStore } from '../src/store/file.js'
import type { Snapshot, Triage, UsageEntry } from '../src/domain/types.js'

export function makeTriage(overrides: Partial<Triage> = {}): Triage {
  return {
    objective: 'test objective',
    scope: ['src/'],
    nonGoals: ['docs/'],
    acceptanceCriteria: ['tests pass'],
    risk: 'low',
    size: 'lightweight',
    executionMode: 'inline',
    auditMode: 'self-check',
    touchesOperatingLayer: false,
    baseline: {},
    ...overrides,
  }
}

export function makeSnapshot(overrides: Partial<Snapshot> = {}, triage: Partial<Triage> = {}): Snapshot {
  return {
    runId: 'run-1',
    revision: 1,
    triage: makeTriage(triage),
    plan: { revision: 0, text: '' },
    phase: 'planning',
    planGate: 'pending',
    executionGate: 'pending',
    audits: [],
    residualRisks: [],
    logCount: 0,
    consecutiveReplans: 0,
    enforcement: { sandbox: 'off', reminders: 0, ownerApprovals: [] },
    ...overrides,
  }
}

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
    // M6 ([R2-P3-1]): the scoped ctx is PRESENT only on real host agents —
    // a test stubs it deliberately (the planner install requires it), and
    // every other fixture keeps the absent-means-absent shape.
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
  get(id: string): AgentRef | undefined { return this.map.get(id) }
}

/** Scripted one-shot verdicts, FIFO. */
export interface StubVerdictScript {
  verdict: string
  note: string
  /** Graded findings forwarded verbatim into the structured return (governance pragmatics v1). */
  findings?: import('../src/domain/types.js').AuditFinding[]
  /**
   * Override the child's logged `request/header` route (M4 observed leg).
   * Absent ⇒ the stub logs a header AGREEING with the dispatch — what a
   * healthy host does. `null` ⇒ no header event at all (observed unreadable).
   * An object ⇒ a scripted divergence (model axis, provider axis, effort).
   */
  requestHeader?: { provider?: string; model?: string; reasoningEffort?: string } | null
}

export function stubSubagents(script: {
  verdicts?: Array<StubVerdictScript | { stopReason: string }>
  onFollowup?: (childId: string, text: string) => void
  onStartContinuable?: (childId: string) => void
  failContinuable?: boolean
  followupFails?: number
} = {}): SubagentsRef & {
  followups: Array<{ childId: string; text: string }>
  started: string[]
  /** The agentOptions each one-shot auditor dispatch received (undefined = inherit). */
  auditOptions: Array<AgentOptionsLike | undefined>
  /** The agentOptions each continuable executor dispatch received (undefined = inherit). */
  continuableOptions: Array<AgentOptionsLike | undefined>
} {
  const verdicts = [...(script.verdicts ?? [])]
  const followups: Array<{ childId: string; text: string }> = []
  const started: string[] = []
  const auditOptions: Array<AgentOptionsLike | undefined> = []
  const continuableOptions: Array<AgentOptionsLike | undefined> = []
  let auditCounter = 0
  let followupFailsLeft = script.followupFails ?? 0
  return {
    followups,
    started,
    auditOptions,
    continuableOptions,
    async start(_provider, request) {
      auditOptions.push(request.agentOptions)
      const next = verdicts.shift()
      auditCounter += 1
      const id = `auditor-${auditCounter}`
      // The child the real host would create (`resolveChildAgentOptions`:
      // the parent's route unless the request overrides it): creation options
      // echo the dispatch, and the session logs a `request/header` for the
      // request the child actually sent — AGREEING with the dispatch unless a
      // test scripts a divergence via `requestHeader`.
      const override = next !== undefined && !('stopReason' in next) ? next.requestHeader : undefined
      const childOptions = {
        provider: request.agentOptions?.provider ?? 'stub-llm',
        model: request.agentOptions?.model ?? 'stub-model',
      }
      const effort = override !== null && override !== undefined && override.reasoningEffort !== undefined
        ? override.reasoningEffort
        : request.agentOptions?.reasoningEffort
      const events: Array<{ type: string; data: unknown }> = override === null ? [] : [{
        type: 'request/header',
        data: {
          header: {
            config: {
              provider: override?.provider ?? childOptions.provider,
              model: override?.model ?? childOptions.model,
              ...(effort === undefined ? {} : { reasoningEffort: effort }),
            },
          },
          reason: 'initial',
        },
      }]
      const run: SubagentRunRef = {
        id,
        localAgent: {
          id,
          session: { header: {}, snapshotEvents: () => events.slice(), append() {} },
          options: childOptions,
        },
        result: Promise.resolve(
          next === undefined
            ? { stopReason: 'error', diagnostic: 'script exhausted' }
            : 'stopReason' in next
              ? { stopReason: next.stopReason }
              : { stopReason: 'completed', structured: next },
        ),
        async dispose() {},
      }
      return run
    },
    async startContinuable(spec) {
      if (script.failContinuable === true) throw new Error('continuable startup failed (scripted)')
      started.push(spec.childId)
      continuableOptions.push(spec.request.agentOptions)
      script.onStartContinuable?.(spec.childId)
      return {}
    },
    // The resume transport (`SubagentManager.sendMessage`). The record keeps
    // its historical `followups` name; the manager never had `followup`.
    async sendMessage(_sender, childId, content, _options) {
      if (followupFailsLeft > 0) {
        followupFailsLeft -= 1
        throw new Error('sendMessage failed (scripted)')
      }
      const text = content.map(block => block.text).join('\n')
      followups.push({ childId, text })
      script.onFollowup?.(childId, text)
      return {}
    },
    interrupt() {},
    async drainContinuableChildren() { return {} },
  }
}

export interface Harness {
  engine: AutopilotEngine
  agents: FakeAgents
  subagents: ReturnType<typeof stubSubagents>
  root: FakeAgent
  storeDir: string
}

export function makeHarness(options: {
  config?: Parameters<typeof resolveConfig>[0]
  subagents?: ReturnType<typeof stubSubagents>
  /** Sandbox confine-provider probe; tests default to true (provider mounted). */
  sandboxAvailable?: () => boolean
  /** Remaining enforcement bearers; each defaults to the LEAST capable answer. */
  environment?: EnvironmentProbes
  /** Routing ports (M3b): a stub catalog/policy pair; absent ⇒ 0.2.0/inherit parity. */
  routing?: RoutingPorts
  /** M6: a deliberate scoped-ctx stub on the fake root agent (the planner install leg). */
  rootCtx?: unknown
  cwd?: string
} = {}): Harness {
  const storeDir = mkdtempSync(join(tmpdir(), 'dsh-autopilot-test-'))
  const agents = new FakeAgents()
  const root = fakeAgent('root-1', undefined, options.cwd, options.rootCtx)
  agents.add(root)
  const subagents = options.subagents ?? stubSubagents()
  const config: ResolvedConfig = resolveConfig(options.config)
  const engine = new AutopilotEngine(
    agents,
    subagents,
    new RunStore(storeDir),
    config,
    options.sandboxAvailable ?? (() => true),
    options.environment ?? {},
    options.routing ?? {},
  )
  return { engine, agents, subagents, root, storeDir }
}

/** A well-formed usage entry for a CLI change, ready to pass `validateUsageEntry`. */
export function makeUsageEntry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    id: 'm1',
    usageClass: 'cli',
    boundaryStates: ['empty', 'happy-path'],
    artifacts: [{
      kind: 'session-log',
      ref: 'usage/m1.log',
      covers: ['empty'],
      capturedAt: new Date().toISOString(),
    }],
    attempted: [],
    ...overrides,
  }
}

/** Seed one `undeclared` entry, i.e. the shape `autopilot_init` gives a standard run. */
export function undeclaredSeed(id = 'm1'): UsageEntry {
  return { id, usageClass: 'undeclared', boundaryStates: [], artifacts: [], attempted: [] }
}
