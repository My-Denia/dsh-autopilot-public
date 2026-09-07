/**
 * Backwards compatibility with persisted v1 streams.
 *
 * TWO fixtures, because they answer different questions and the first one alone
 * was not a claim about the population it named.
 *
 * 1. `test/fixtures/v1-real-run/events.jsonl` — a REAL v1 stream, copied byte
 *    for byte out of `$DSH_HOME/storages/dsh-autopilot/runs/` on the machine
 *    that produced it. Seven events, self-check audit mode, lightweight size,
 *    `enforcement` with exactly three keys. It is the only artifact here that
 *    can falsify "v2 still reads v1 streams", because everything about its
 *    shape was decided by v1 and nothing about it was decided by us.
 * 2. The SYNTHETIC stream below — hand-written, standard size, independent
 *    audit mode, an owner approval and a delegated-shaped enforcement record.
 *    It covers combinations the real run does not, and is kept for that reason
 *    alone.
 *
 * WHY BOTH. The synthetic fixture used to carry a cardinality floor
 * (`length >= 8`) pinned to its own length — and the real run is 7 events, so a
 * genuine member of the population would have FAILED the floor meant to
 * characterise it. It also disagreed with reality in four measurable ways
 * (`modeAppended` present, no `triage.baseline.note`, no log `detail`, a
 * `verified` route where the real one is `unverified` with a diagnostic). A
 * floor a real instance fails is not a claim about the population, so the floor
 * is now a SHAPE floor and the real stream carries the compatibility claim.
 *
 * The Moving-Anchor rule applies to both fixtures: each asserts IN PLACE that
 * it really is missing every v2 field, so neither can quietly become a v2 test
 * if someone "helpfully" fills them in.
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { foldRun } from '../src/domain/fold.js'
import { decideTool } from '../src/gate/decide.js'
import type { GateConfig } from '../src/gate/decide.js'
import { evaluateCompletion } from '../src/domain/types.js'
import type { RunEvent, Snapshot } from '../src/domain/types.js'
import { RunStore } from '../src/store/file.js'

const RUN_ID = 'legacy-session-0001'

const V1_TRIAGE = {
  objective: 'ship the v1 harness',
  scope: ['src/'],
  nonGoals: ['docs/'],
  acceptanceCriteria: ['unit tests pass', 'the plugin loads in the headless profile'],
  risk: 'medium' as const,
  size: 'standard' as const,
  executionMode: 'inline' as const,
  auditMode: 'independent' as const,
  touchesOperatingLayer: false,
  baseline: { commit: 'a1b2c3d', branch: 'main', dirty: false },
}

/** Only the four fields v1 ever wrote. */
const V1_ENFORCEMENT = {
  sandbox: 'active' as const,
  modeAppended: true,
  reminders: 1,
  ownerApprovals: [{ seq: 0, target: 'push the release branch', grantedAtRevision: 4, consumedBy: 'git push origin main' }],
}

const V1_ROUTE = {
  provider: 'spawn',
  routeProvider: 'deepseek-official',
  routeModel: 'deepseek-v4-pro',
  routeStatus: 'verified' as const,
}

function base(revision: number, overrides: Partial<Snapshot>): Snapshot {
  return {
    runId: RUN_ID,
    revision,
    triage: V1_TRIAGE,
    plan: { revision: 0, text: '' },
    phase: 'planning',
    planGate: 'pending',
    executionGate: 'pending',
    audits: [],
    residualRisks: [],
    logCount: 0,
    consecutiveReplans: 0,
    enforcement: V1_ENFORCEMENT,
    ...overrides,
  } as Snapshot
}

/** A complete, realistic v1 run: init -> plan -> plan audit -> evidence -> execution audit -> closeout. */
function v1Stream(): RunEvent[] {
  const planAudit = {
    role: 'plan' as const,
    seq: 0,
    runRevision: 3,
    planRevision: 1,
    executionRevision: 0,
    auditorId: 'auditor-7f31',
    verdict: 'pass' as const,
    note: 'milestones carry binary checks',
    route: V1_ROUTE,
  }
  const executionAudit = {
    role: 'execution' as const,
    seq: 1,
    runRevision: 6,
    planRevision: 1,
    executionRevision: 0,
    auditorId: 'auditor-9c02',
    verdict: 'pass' as const,
    note: 'evidence matches every criterion',
    route: V1_ROUTE,
  }
  const closeout = {
    summary: 'v1 harness shipped',
    changedFiles: ['src/engine.ts', 'src/store.ts'],
    commands: ['pnpm test - 83/83 pass', 'pnpm run check - clean'],
    evidence: [
      { criterion: 'unit tests pass', bearer: 'artifacts/vitest.txt', status: 'proven' as const },
      { criterion: 'the plugin loads in the headless profile', bearer: 'artifacts/headless-boot.log', status: 'proven' as const },
    ],
    residualRisks: ['egress matcher is command-class, not evidence-based'],
    exclusions: ['no web UI work'],
    workspaceCleanup: 'temp run directory removed',
    drift: 'none found',
  }

  const snapshots: Array<[number, RunEvent['op'], Partial<Snapshot>]> = [
    [1, 'init', {}],
    [2, 'submit-plan', { plan: { revision: 1, text: 'M1 ... verify: pnpm test' } }],
    [3, 'audit', { plan: { revision: 1, text: 'M1 ... verify: pnpm test' }, phase: 'plan-reviewing' }],
    [4, 'audit', {
      plan: { revision: 1, text: 'M1 ... verify: pnpm test' },
      phase: 'executing',
      planGate: 'pass',
      audits: [planAudit],
    }],
    [5, 'log', {
      plan: { revision: 1, text: 'M1 ... verify: pnpm test' },
      phase: 'executing',
      planGate: 'pass',
      audits: [planAudit],
      logCount: 1,
    }],
    [6, 'submit-evidence', {
      plan: { revision: 1, text: 'M1 ... verify: pnpm test' },
      phase: 'execution-reviewing',
      planGate: 'pass',
      audits: [planAudit],
      logCount: 1,
      executionPacket: 'changed engine.ts and store.ts; pnpm test 83/83',
    }],
    [7, 'audit', {
      plan: { revision: 1, text: 'M1 ... verify: pnpm test' },
      phase: 'closing',
      planGate: 'pass',
      executionGate: 'pass',
      audits: [planAudit, executionAudit],
      logCount: 1,
      executionPacket: 'changed engine.ts and store.ts; pnpm test 83/83',
    }],
    [8, 'submit-closeout', {
      plan: { revision: 1, text: 'M1 ... verify: pnpm test' },
      phase: 'completed',
      planGate: 'pass',
      executionGate: 'pass',
      audits: [planAudit, executionAudit],
      logCount: 1,
      executionPacket: 'changed engine.ts and store.ts; pnpm test 83/83',
      closeout,
    }],
  ]

  return snapshots.map(([revision, op, overrides]) => ({
    v: 1 as const,
    op,
    revision,
    time: new Date(Date.parse('2026-08-20T09:00:00.000Z') + revision * 60_000).toISOString(),
    snapshot: base(revision, overrides),
  }))
}

describe('v1 stream compatibility', () => {
  const stream = v1Stream()

  it('the fixture really is v1-shaped (Moving-Anchor: asserted in place)', () => {
    for (const event of stream) {
      expect(event.snapshot.usage).toBeUndefined()
      expect(event.snapshot.planGatePassedAt).toBeUndefined()
      expect(event.snapshot.enforcement.store).toBeUndefined()
      expect(event.snapshot.enforcement.approval).toBeUndefined()
      expect(event.snapshot.enforcement.egress).toBeUndefined()
      expect(event.snapshot.enforcement.outboundConsumed).toBeUndefined()
    }
    // SHAPE floor, not a length floor. The number this used to assert (>= 8)
    // was the synthetic fixture's own length, and the real v1 run on this
    // machine is 7 events — it would have failed the floor written to
    // characterise it. What actually has to hold is that the stream is a full
    // lifecycle: an init, at least one audit record, and a terminal completion.
    expect(stream[0]?.op).toBe('init')
    expect(stream.map(event => event.op)).toContain('submit-closeout')
    expect(stream[stream.length - 1]?.snapshot.phase).toBe('completed')
    expect((stream[stream.length - 1]?.snapshot.audits ?? []).length).toBeGreaterThanOrEqual(1)
  })

  it('still replays under the v2 fold, all the way to completed', () => {
    const folded = foldRun(stream)
    expect(folded.eventCount).toBe(stream.length)
    expect(folded.snapshot?.phase).toBe('completed')
    expect(folded.snapshot?.planGate).toBe('pass')
    expect(folded.snapshot?.executionGate).toBe('pass')
    expect(folded.snapshot?.audits.map(record => record.verdict)).toEqual(['pass', 'pass'])
  })

  it('still passes the v2 completion check, which never asks a legacy run about usage', () => {
    const folded = foldRun(stream)
    const check = evaluateCompletion(folded.snapshot as Snapshot)
    expect(check.problems).toEqual([])
    expect(check.ok).toBe(true)
  })

  it('loads and folds off disk through the v2 file store', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-legacy-'))
    const dir = join(root, 'runs', RUN_ID)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'events.jsonl'), stream.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')

    const store = new RunStore(root)
    const snapshot = store.load(RUN_ID)
    expect(snapshot?.phase).toBe('completed')
    // Derived from the fixture rather than hardcoded: `8` was the synthetic
    // stream's own length restated as a constant, i.e. an anchor that moves
    // with whatever the fixture becomes.
    expect(snapshot?.revision).toBe(stream.length)
    expect(snapshot?.usage).toBeUndefined()
    // The store still records its own kind even for a stream that predates the field.
    expect(store.kind).toBe('file')
  })

  it('the v2 gates leave a legacy run alone: no usage clamp, terminal phase ungated', () => {
    const config: GateConfig = { toolDeny: true, egressDeny: true, strictShell: false, egressSeam: 'native-ask' }
    const midRun = stream[5]?.snapshot as Snapshot // revision 6, execution-reviewing, standard size
    expect(midRun.triage.size).toBe('standard')
    expect(midRun.usage).toBeUndefined()
    expect(decideTool(midRun, 'write', {}, config).kind).toBe('allow')

    const finished = foldRun(stream).snapshot as Snapshot
    expect(decideTool(finished, 'write', {}, config).kind).toBe('allow')
  })
})

/**
 * The REAL v1 stream, as bytes.
 *
 * Nothing here is reconstructed: the file is a copy of a run this repository's
 * v1 build actually wrote, so every shape it carries is v1's answer and not
 * ours. That is the entire point — the synthetic fixture above is the team's
 * MODEL of v1, and a model cannot falsify a compatibility claim about the
 * thing it was derived from.
 */
describe('a REAL v1 events.jsonl, read as bytes', () => {
  const fixture = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'v1-real-run', 'events.jsonl')
  const rawStream = readFileSync(fixture, 'utf8')
  const real = rawStream.split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as RunEvent)

  it('is genuinely v1-shaped, and differs from the synthetic fixture in the ways reality does', () => {
    expect(real.length).toBe(7)
    expect(real.map(event => event.op)).toEqual([
      'init', 'submit-plan', 'self-check', 'log', 'submit-evidence', 'self-check', 'submit-closeout',
    ])
    for (const event of real) {
      expect(event.snapshot.usage).toBeUndefined()
      expect(event.snapshot.planGatePassedAt).toBeUndefined()
      expect(event.snapshot.enforcement.store).toBeUndefined()
      expect(event.snapshot.enforcement.approval).toBeUndefined()
      expect(event.snapshot.enforcement.egress).toBeUndefined()
      expect(event.snapshot.enforcement.outboundConsumed).toBeUndefined()
    }
    // The four measured disagreements with the synthetic fixture, asserted so
    // that "the hand-written one is close enough" stops being an assumption.
    const first = real[0]?.snapshot as Snapshot
    expect(Object.keys(first.enforcement).sort()).toEqual(['ownerApprovals', 'reminders', 'sandbox'])
    expect(first.enforcement.modeAppended).toBeUndefined()
    expect(Object.keys(first.triage.baseline)).toContain('note')
    expect(real[3]?.detail).toBeDefined()
    const audits = (real[real.length - 1]?.snapshot as Snapshot).audits
    expect(audits[0]?.route.routeStatus).toBe('unverified')
    expect(audits[0]?.route.routeDiagnostic).toBeDefined()
    // No intermediate 'plan-reviewing' hop: a self-check audit never enters it.
    expect(real.map(event => event.snapshot.phase)).not.toContain('plan-reviewing')
  })

  it('replays under the v2 fold, all the way to completed', () => {
    const folded = foldRun(real)
    expect(folded.eventCount).toBe(real.length)
    expect(folded.snapshot?.phase).toBe('completed')
    expect(folded.snapshot?.planGate).toBe('pass')
    expect(folded.snapshot?.executionGate).toBe('pass')
  })

  it('passes the v2 completion check unchanged', () => {
    const check = evaluateCompletion(foldRun(real).snapshot as Snapshot)
    expect(check.problems).toEqual([])
    expect(check.ok).toBe(true)
  })

  it('loads off disk through the v2 file store, from the original bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-legacy-real-'))
    const runId = (real[0]?.snapshot as Snapshot).runId
    const dir = join(root, 'runs', runId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'events.jsonl'), rawStream, 'utf8')
    const snapshot = new RunStore(root).load(runId)
    expect(snapshot?.phase).toBe('completed')
    expect(snapshot?.revision).toBe(real.length)
    expect(snapshot?.usage).toBeUndefined()
  })

  it('accepts a v2-only op appended onto a TRUNCATED real prefix', () => {
    // Cut the real stream before its closeout so the prefix is a LIVE run, then
    // append the v2-only `declare-usage` op the way today's engine would. This
    // is the direction the synthetic fixture cannot test: v2 WRITING onto a
    // stream v1 wrote.
    const prefix = real.slice(0, 4)
    const prior = foldRun(prefix).snapshot as Snapshot
    expect(prior.phase).toBe('executing')
    expect(prior.usage).toBeUndefined()
    const appended: RunEvent = {
      v: 1,
      op: 'declare-usage',
      revision: prior.revision + 1,
      time: new Date().toISOString(),
      snapshot: {
        ...prior,
        revision: prior.revision + 1,
        usage: {
          entries: [{
            id: 'm1',
            usageClass: 'cli',
            boundaryStates: ['empty', 'happy-path'],
            artifacts: [{ kind: 'session-log', ref: 'usage/m1.log', covers: ['empty'], capturedAt: new Date().toISOString() }],
            attempted: [],
          }],
        },
      },
    }
    const next = foldRun([...prefix, appended]).snapshot as Snapshot
    expect(next.usage?.entries[0]?.usageClass).toBe('cli')
    expect(next.revision).toBe(prior.revision + 1)
  })
})
