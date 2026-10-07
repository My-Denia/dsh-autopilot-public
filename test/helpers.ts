/** Shared test fixtures: snapshots, fake agents, stub subagents, temp stores. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutopilotEngine } from '../src/engine.js'
import type { AgentRef, EnvironmentProbes, ResolvedConfig, SubagentsRef, SubagentRunRef } from '../src/engine.js'
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

export function fakeAgent(id: string, parentSession?: string, cwd?: string): FakeAgent {
  const events: Array<{ type: string; data: unknown }> = []
  return {
    id,
    appended: events,
    options: { provider: 'fake', model: 'fake-model' },
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
export function stubSubagents(script: {
  verdicts?: Array<{ verdict: string; note: string } | { stopReason: string }>
  onFollowup?: (childId: string, text: string) => void
  onStartContinuable?: (childId: string) => void
  failContinuable?: boolean
  followupFails?: number
} = {}): SubagentsRef & { followups: Array<{ childId: string; text: string }>; started: string[] } {
  const verdicts = [...(script.verdicts ?? [])]
  const followups: Array<{ childId: string; text: string }> = []
  const started: string[] = []
  let auditCounter = 0
  let followupFailsLeft = script.followupFails ?? 0
  return {
    followups,
    started,
    async start(_provider, _request) {
      const next = verdicts.shift()
      auditCounter += 1
      const id = `auditor-${auditCounter}`
      const run: SubagentRunRef = {
        id,
        localAgent: { id, session: { header: {}, snapshotEvents: () => [], append() {} }, options: { provider: 'stub-llm', model: 'stub-model' } },
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
  cwd?: string
} = {}): Harness {
  const storeDir = mkdtempSync(join(tmpdir(), 'dsh-autopilot-test-'))
  const agents = new FakeAgents()
  const root = fakeAgent('root-1', undefined, options.cwd)
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
