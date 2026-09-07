/**
 * The one-off domain -> file export (`src/tools/migrate-domain-runs.ts`).
 *
 * WHAT THIS FILE IS GUARDING. A migration tool's failure mode is not "it threw"
 * — it is "it wrote something plausible that the destination cannot replay", or
 * "it overwrote a run that was already there". Both are silent at the moment
 * they happen and expensive later, so every case below checks the DESTINATION
 * through the real `RunStore` rather than checking that the tool returned a
 * happy-looking report.
 *
 * The strongest case here is the round trip: what the exporter writes is read
 * back by the same strict `foldRun` the file backend uses in production. A
 * layout that is subtly wrong (wrong line framing, events out of order, a
 * projection that disagrees with its stream) cannot survive that.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AutopilotError } from '../src/domain/types.js'
import type { RunEvent, Snapshot, Triage } from '../src/domain/types.js'
import { RunStore, runDirFor } from '../src/store/file.js'
import { eventKey } from '../src/store/domain.js'
import {
  defaultDomainFile, formatReport, groupEvents, migrateDomainRuns, parseArgv,
} from '../src/tools/migrate-domain-runs.js'

const TRIAGE: Triage = {
  objective: 'migration round trip',
  scope: ['src/store/'],
  nonGoals: [],
  acceptanceCriteria: ['stream replays after export'],
  risk: 'low',
  size: 'lightweight',
  executionMode: 'inline',
  auditMode: 'self-check',
  touchesOperatingLayer: false,
  baseline: {},
}

function snapshot(runId: string, revision = 1, overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    runId,
    revision,
    triage: TRIAGE,
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

function event(op: RunEvent['op'], next: Snapshot): RunEvent {
  return { v: 1, op, revision: next.revision, time: '2026-08-27T00:00:00.000Z', snapshot: next }
}

/** A legal two-event run, the shape the real domain table holds. */
function legalRun(runId: string): RunEvent[] {
  const first = snapshot(runId)
  return [event('init', first), event('log', { ...first, revision: 2, logCount: 1 })]
}

/** Write a json-backend document the way `@deepseek-ai/dsh-storage-json` does. */
function writeDomain(dir: string, runs: Record<string, readonly RunEvent[]>): string {
  const events: Record<string, RunEvent> = {}
  const projections: Record<string, Snapshot> = {}
  for (const [runId, stream] of Object.entries(runs)) {
    for (const item of stream) events[eventKey(runId, item.revision)] = item
    const last = stream[stream.length - 1]
    if (last !== undefined) projections[runId] = last.snapshot
  }
  const file = join(dir, 'dsh_autopilot.json')
  writeFileSync(file, JSON.stringify({
    unit: { name: 'dsh_autopilot', version: 1 },
    global: null,
    tables: { events, runs: projections },
  }, null, 2), 'utf8')
  return file
}

function sandbox(): { readonly storages: string; readonly root: string } {
  const storages = mkdtempSync(join(tmpdir(), 'dsh-autopilot-migrate-'))
  return { storages, root: join(storages, 'dsh-autopilot') }
}

describe('groupEvents', () => {
  it('orders by parsed revision, not by the table’s key order', () => {
    const stream = legalRun('run-1')
    const shuffled: Record<string, unknown> = {
      [eventKey('run-1', 2)]: stream[1],
      [eventKey('run-1', 1)]: stream[0],
    }
    expect([...groupEvents(shuffled).get('run-1')!].map(e => e.revision)).toEqual([1, 2])
  })

  it('separates runs that share the table, and keeps every one of them', () => {
    const events: Record<string, unknown> = {}
    for (const runId of ['run-a', 'run-b']) {
      for (const item of legalRun(runId)) events[eventKey(runId, item.revision)] = item
    }
    const grouped = groupEvents(events)
    expect([...grouped.keys()].sort()).toEqual(['run-a', 'run-b'])
    expect(grouped.get('run-a')!.every(e => e.snapshot.runId === 'run-a')).toBe(true)
  })

  it('raises a malformed key instead of skipping it', () => {
    // A key the parser cannot read is corruption of a SHARED table. Skipping it
    // would drop an event out of some run's canonical stream and hand the fold
    // a gap-free-looking prefix of a broken run.
    expect(() => groupEvents({ 'run-1#nope': {} })).toThrowError(AutopilotError)
  })
})

describe('migrateDomainRuns', () => {
  it('DRY RUN by default: reports what it would export and writes nothing', () => {
    const { storages, root } = sandbox()
    const domainFile = writeDomain(storages, { 'run-1': legalRun('run-1') })
    const report = migrateDomainRuns({ domainFile, root })

    expect(report.applied).toBe(false)
    expect(report.entries).toEqual([
      { runId: 'run-1', outcome: 'exported', eventCount: 2, revision: 2, runDir: runDirFor(root, 'run-1') },
    ])
    expect(existsSync(runDirFor(root, 'run-1'))).toBe(false)
  })

  it('round-trips: what it writes, the real RunStore replays to the same revision', () => {
    const { storages, root } = sandbox()
    const domainFile = writeDomain(storages, { 'run-1': legalRun('run-1'), 'run-2': legalRun('run-2') })

    const report = migrateDomainRuns({ domainFile, root, apply: true })
    expect(report.entries.map(e => e.outcome)).toEqual(['exported', 'exported'])

    // THE bearer: the destination's own strict fold, not a shape assertion.
    const store = new RunStore(root)
    for (const runId of ['run-1', 'run-2']) {
      const loaded = store.load(runId)
      expect(loaded?.runId).toBe(runId)
      expect(loaded?.revision).toBe(2)
      expect(loaded?.logCount).toBe(1)
    }
    expect([...store.listRuns()].sort()).toEqual(['run-1', 'run-2'])
    // The projection is published too, so the freshness probe can see it.
    expect(store.currentRevision('run-1')).toBe(2)
  })

  it('never touches the domain document — a failed migration costs nothing', () => {
    const { storages, root } = sandbox()
    const domainFile = writeDomain(storages, { 'run-1': legalRun('run-1') })
    const before = readFileSync(domainFile, 'utf8')
    migrateDomainRuns({ domainFile, root, apply: true })
    expect(readFileSync(domainFile, 'utf8')).toBe(before)
  })

  it('SKIPS a run the file store already holds, rather than merging or clobbering', () => {
    const { storages, root } = sandbox()
    const domainFile = writeDomain(storages, { 'run-1': legalRun('run-1'), 'run-2': legalRun('run-2') })
    // `run-1` already exists on the file side with a DIFFERENT stream.
    const dir = runDirFor(root, 'run-1')
    mkdirSync(dir, { recursive: true })
    const mine = `${JSON.stringify(event('init', snapshot('run-1')))}\n`
    writeFileSync(join(dir, 'events.jsonl'), mine, 'utf8')

    const report = migrateDomainRuns({ domainFile, root, apply: true })
    expect(report.entries.find(e => e.runId === 'run-1')?.outcome).toBe('skipped-existing')
    expect(readFileSync(join(dir, 'events.jsonl'), 'utf8')).toBe(mine)
    // Control: the sibling still exported, so the skip is a decision about
    // run-1 and not the tool giving up on the whole document.
    expect(report.entries.find(e => e.runId === 'run-2')?.outcome).toBe('exported')
  })

  it('SKIPS a stream the strict fold rejects, and still exports its healthy sibling', () => {
    const { storages, root } = sandbox()
    const broken = legalRun('run-bad')
    // A revision gap: the shape a hand-edit or a partial write leaves behind.
    broken[1] = event('log', { ...snapshot('run-bad'), revision: 5, logCount: 1 })
    const domainFile = writeDomain(storages, { 'run-bad': broken, 'run-ok': legalRun('run-ok') })

    const report = migrateDomainRuns({ domainFile, root, apply: true })
    const bad = report.entries.find(e => e.runId === 'run-bad')
    expect(bad?.outcome).toBe('skipped-corrupt')
    expect(bad?.problem).toMatch(/non-monotonic revision/)
    expect(existsSync(join(runDirFor(root, 'run-bad'), 'events.jsonl'))).toBe(false)
    expect(report.entries.find(e => e.runId === 'run-ok')?.outcome).toBe('exported')
  })

  it('reports a projection with no events instead of inventing a stream for it', () => {
    const { storages, root } = sandbox()
    const file = join(storages, 'dsh_autopilot.json')
    writeFileSync(file, JSON.stringify({
      tables: { events: {}, runs: { 'run-orphan': snapshot('run-orphan') } },
    }), 'utf8')
    const report = migrateDomainRuns({ domainFile: file, root, apply: true })
    expect(report.entries).toEqual([
      { runId: 'run-orphan', outcome: 'skipped-no-events', eventCount: 0, runDir: runDirFor(root, 'run-orphan') },
    ])
    expect(existsSync(runDirFor(root, 'run-orphan'))).toBe(false)
  })

  it('exports a stream whose run the `runs` table never projected', () => {
    // Neither table is trusted to be complete: a crash between the canonical
    // write and the projection write leaves exactly this shape, and the events
    // are the authority.
    const { storages, root } = sandbox()
    const file = join(storages, 'dsh_autopilot.json')
    const events: Record<string, RunEvent> = {}
    for (const item of legalRun('run-1')) events[eventKey('run-1', item.revision)] = item
    writeFileSync(file, JSON.stringify({ tables: { events, runs: {} } }), 'utf8')
    const report = migrateDomainRuns({ domainFile: file, root, apply: true })
    expect(report.entries.map(e => e.outcome)).toEqual(['exported'])
    expect(new RunStore(root).load('run-1')?.revision).toBe(2)
  })

  it('an unreadable document is raised, never reported as "no runs found"', () => {
    const { root } = sandbox()
    expect(() => migrateDomainRuns({ domainFile: join(tmpdir(), 'definitely-absent.json'), root }))
      .toThrowError()
  })
})

describe('the tool’s surface', () => {
  it('defaults the document to a SIBLING of the run root, matching the unit name', () => {
    // The names differ on purpose: the run root is `dsh-autopilot` (package
    // name) and the domain unit is `dsh_autopilot` (upstream refuses a hyphen).
    expect(defaultDomainFile(join('C:', 'home', '.dsh', 'storages', 'dsh-autopilot')))
      .toBe(join('C:', 'home', '.dsh', 'storages', 'dsh_autopilot.json'))
  })

  it('parses its flags and refuses anything it does not understand', () => {
    expect(parseArgv([])).toEqual({})
    expect(parseArgv(['--apply'])).toEqual({ apply: true })
    expect(parseArgv(['--domain', 'd.json', '--root', 'r', '--apply']))
      .toEqual({ domainFile: 'd.json', root: 'r', apply: true })
    // A typo must not silently become a dry run against the default paths.
    expect(() => parseArgv(['--aply'])).toThrowError(/unrecognized argument/)
  })

  it('says plainly which mode it ran in', () => {
    const { storages, root } = sandbox()
    const domainFile = writeDomain(storages, { 'run-1': legalRun('run-1') })
    expect(formatReport(migrateDomainRuns({ domainFile, root }))).toMatch(/DRY RUN/)
    expect(formatReport(migrateDomainRuns({ domainFile, root, apply: true }))).toMatch(/APPLY/)
  })
})
