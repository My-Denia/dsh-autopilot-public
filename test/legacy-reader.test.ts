/**
 * The frozen legacy reader (src/legacy): fixtures, projection, both backends.
 *
 * Fixtures are test/fixtures/legacy-synthetic/*.jsonl, hand-built synthetic
 * streams (no owner history). Each one was validated by the frozen fold when
 * it was generated; the first block here keeps that true, and keeps the set
 * covering every operation the fold accepts.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  LEGACY_OPERATIONS,
  foldLegacyEvents,
  legacyClampOf,
  legacyRunIdsForSession,
  listLegacyRuns,
  projectLegacyRun,
  readLegacyRun,
} from '../src/legacy/index.js'
import type { LegacyDomainReader } from '../src/legacy/index.js'

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'legacy-synthetic')

function events(name: string): Record<string, unknown>[] {
  return readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
}

const NAMES = readdirSync(FIXTURES).filter(name => name.endsWith('.jsonl')).sort()

function fileRootWith(names: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-legacy-reader-'))
  for (const name of names) {
    const stream = events(name)
    const runId = (stream[0]?.snapshot as { runId: string }).runId
    mkdirSync(join(root, 'runs', runId), { recursive: true })
    writeFileSync(join(root, 'runs', runId, 'events.jsonl'), readFileSync(join(FIXTURES, name), 'utf8'))
  }
  return root
}

/** An in-memory domain `events` table holding the given fixtures (and optional truncation). */
function domainWith(entries: readonly { name: string; keep?: number }[]): LegacyDomainReader {
  const rows: { key: string; value: unknown }[] = []
  for (const { name, keep } of entries) {
    const stream = events(name).slice(0, keep)
    const runId = (stream[0]?.snapshot as { runId: string }).runId
    for (const event of stream) rows.push({ key: `${runId}#${String(event.revision).padStart(12, '0')}`, value: event })
  }
  // Insertion order is NOT revision order in a real domain; shuffle so the reader has to sort.
  rows.reverse()
  return { async list(table) { return table === 'events' ? rows : [] } }
}

describe('synthetic fixtures', () => {
  it('there are fixtures', () => {
    expect(NAMES.length).toBeGreaterThanOrEqual(7)
  })

  it('the union of op types across the fixtures equals LEGACY_OPERATIONS, in both directions', () => {
    const seen = new Set<string>()
    for (const name of NAMES) for (const event of events(name)) seen.add(String(event.op))
    const declared = new Set(LEGACY_OPERATIONS)
    expect([...seen].filter(op => !declared.has(op))).toEqual([])
    expect([...declared].filter(op => !seen.has(op))).toEqual([])
    expect(LEGACY_OPERATIONS).toHaveLength(24)
  })

  it.each(NAMES)('%s folds ok', (name) => {
    const stream = events(name)
    const result = foldLegacyEvents(stream)
    expect(result.ok).toBe(true)
    expect(result.eventCount).toBe(stream.length)
  })
})

describe('foldLegacyEvents', () => {
  it('never throws: a corrupt first event, a non-object and an empty stream are rejections', () => {
    expect(foldLegacyEvents([])).toMatchObject({ ok: false, failedAt: 0, eventCount: 0 })
    expect(foldLegacyEvents([null])).toMatchObject({ ok: false, failedAt: 0 })
    expect(foldLegacyEvents(['x', 1])).toMatchObject({ ok: false, failedAt: 0 })
    const bad = foldLegacyEvents([{ v: 1, op: 'submit-plan', revision: 1, time: 't', snapshot: {} }])
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/^LEGACY_FIRST_NOT_INIT/)
  })

  it('points at the first illegal event and keeps the fold code at the front of the error', () => {
    const stream = events('amend-plan.jsonl')
    const tampered = stream.map((event, index) => (index === 3 ? { ...event, revision: 99 } : event))
    const result = foldLegacyEvents(tampered)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failedAt).toBe(3)
      expect(result.error).toMatch(/^LEGACY_REVISION/)
    }
  })

  it('derives ownerResolutions and planAmendments from the accepted events', () => {
    const owner = foldLegacyEvents(events('owner-resolve.jsonl'))
    const amend = foldLegacyEvents(events('amend-plan.jsonl'))
    expect(owner.ok && owner.snapshot.ownerResolutions.map(item => item.text)).toEqual([
      'keep the API backwards compatible',
      'redo the plan from the new assumption',
      'stop, the scope is out of budget',
    ])
    expect(amend.ok && amend.snapshot.planAmendments).toBe(1)
  })
})

describe('projectLegacyRun', () => {
  it('amend-plan fixture: a fully populated projection', () => {
    const folded = foldLegacyEvents(events('amend-plan.jsonl'))
    if (!folded.ok) throw new Error(folded.error)
    const projection = projectLegacyRun(folded.snapshot, { state: 'not-clamped' })
    expect(projection).toMatchObject({
      runId: 'syn-amend-plan',
      revision: 6,
      phase: 'executing',
      planGate: 'pass',
      executionGate: 'pending',
      planRevision: 2,
      objective: 'synthetic standard run',
      size: 'standard',
      risk: 'medium',
      executionMode: 'inline',
      auditMode: 'independent',
      requiredRoles: ['plan', 'execution'],
      latestVerdicts: { plan: 'pass' },
      replanBudgetRemaining: 2,
      auditCount: 2,
      logCount: 1,
      closeoutSubmitted: false,
      planAmendments: 1,
      archived: true,
      sandboxRestore: { state: 'not-clamped' },
      gateSources: { plan: { source: 'no-source' }, execution: { source: 'no-source' } },
    })
    expect(projection.enforcement).toEqual({ sandbox: 'off', reminders: 0, ownerApprovalsGranted: 0, ownerApprovalsConsumed: 0 })
    expect(projection.ownerResolutions).toBeUndefined()
    expect(projection.executor).toBeUndefined()
  })

  it('owner-resolve fixture: the owner rulings ride the projection', () => {
    const folded = foldLegacyEvents(events('owner-resolve.jsonl'))
    if (!folded.ok) throw new Error(folded.error)
    const projection = projectLegacyRun(folded.snapshot, { state: 'not-clamped' })
    expect(projection.phase).toBe('blocked')
    expect(projection.revision).toBe(9)
    expect(projection.planGate).toBe('pending')
    expect(projection.executionGate).toBe('pending')
    expect(projection.ownerResolutions).toHaveLength(3)
    expect(projection.ownerResolutions?.[0]).toEqual({ at: '2026-03-01T09:05:00.000Z', text: 'keep the API backwards compatible' })
    expect(projection.ownerResolutions?.map(item => item.text)).toContain('redo the plan from the new assumption')
    expect(projection.planAmendments).toBeUndefined()
    expect(projection.archived).toBe(true)
  })

  it('full lifecycle fixture: executor, enforcement counts, gate provenance, closeout', () => {
    const folded = foldLegacyEvents(events('independent-clamped-completed.jsonl'))
    if (!folded.ok) throw new Error(folded.error)
    const projection = projectLegacyRun(folded.snapshot, { state: 'pending' })
    expect(projection.phase).toBe('completed')
    expect(projection.closeoutSubmitted).toBe(true)
    expect(projection.executor).toEqual({ generation: 1, state: 'completed' })
    expect(projection.latestVerdicts).toEqual({ plan: 'pass', execution: 'pass' })
    expect(projection.enforcement).toMatchObject({
      sandbox: 'active', modeAppended: true, priorSandboxMode: 'workspace-write', reminders: 1,
      store: 'file', approval: 'signal-only', egress: 'guard-deny', service: 'registered', outboundConsumed: 1,
      ownerApprovalsGranted: 1, ownerApprovalsConsumed: 1,
    })
    expect(projection.sandboxRestore).toEqual({ state: 'pending' })
  })

  it('owner-gate fixture: the withdrawn owner pass is visible in gateSources', () => {
    const folded = foldLegacyEvents(events('owner-gate-pass-withdraw.jsonl'))
    if (!folded.ok) throw new Error(folded.error)
    const projection = projectLegacyRun(folded.snapshot, { state: 'not-clamped' })
    expect(projection.planGate).toBe('pending')
    expect(projection.gateSources).toMatchObject({ plan: { source: 'pending', ownerDecision: 1, withdrawn: true }, execution: { source: 'no-source' } })
  })
})

describe('legacyClampOf', () => {
  const clamp = (name: string) => {
    const folded = foldLegacyEvents(events(name))
    if (!folded.ok) throw new Error(folded.error)
    return legacyClampOf(folded.snapshot)
  }

  it('reports the clamp and the prior mode', () => {
    expect(clamp('independent-clamped-completed.jsonl')).toEqual({ modeAppended: true, priorSandboxMode: 'workspace-write', phase: 'completed' })
  })

  it('a clamp with no prior mode has no priorSandboxMode', () => {
    expect(clamp('clamped-no-prior-mode.jsonl')).toEqual({ modeAppended: true, phase: 'completed' })
  })

  it('a run that never clamped reports modeAppended false and carries its sessionId', () => {
    expect(clamp('amend-plan.jsonl')).toEqual({ modeAppended: false, sessionId: 'syn-session-a', phase: 'executing' })
  })
})

describe('listLegacyRuns / readLegacyRun / legacyRunIdsForSession', () => {
  it('lists the union of the file backend and the domain events table, deduped', async () => {
    const root = fileRootWith(['independent-clamped-completed.jsonl', 'clamped-no-prior-mode.jsonl', 'amend-plan.jsonl'])
    const domain = domainWith([
      { name: 'owner-resolve.jsonl' },
      { name: 'replan-blocked.jsonl' },
      // The same run also exists in the file root, but the domain copy is a truncated prefix: the longer one wins.
      { name: 'amend-plan.jsonl', keep: 3 },
    ])
    const runs = await listLegacyRuns({ fileRoot: root, domain })
    expect(runs.map(run => run.runId)).toEqual([
      'syn-amend-plan', 'syn-clamped-no-prior', 'syn-owner-resolve', 'syn-replan-blocked', 'syn-session-a',
    ])
    const byId = new Map(runs.map(run => [run.runId, run]))
    expect(byId.get('syn-amend-plan')).toMatchObject({ backend: 'file', eventCount: 6, fold: 'ok', phase: 'executing' })
    expect(byId.get('syn-owner-resolve')).toMatchObject({ backend: 'domain', eventCount: 9, fold: 'ok', phase: 'blocked' })
    expect(byId.get('syn-replan-blocked')).toMatchObject({ backend: 'domain', fold: 'ok', phase: 'blocked' })
    expect(runs.every(run => run.fold === 'ok')).toBe(true)
  })

  it('a longer domain copy beats a shorter file copy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-legacy-reader-'))
    const full = events('amend-plan.jsonl')
    mkdirSync(join(root, 'runs', 'syn-amend-plan'), { recursive: true })
    writeFileSync(join(root, 'runs', 'syn-amend-plan', 'events.jsonl'), full.slice(0, 2).map(e => JSON.stringify(e)).join('\n') + '\n')
    const runs = await listLegacyRuns({ fileRoot: root, domain: domainWith([{ name: 'amend-plan.jsonl' }]) })
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ backend: 'domain', eventCount: 6 })
  })

  it('works with either source alone and with none', async () => {
    expect(await listLegacyRuns({})).toEqual([])
    expect(await listLegacyRuns({ fileRoot: join(tmpdir(), 'dsh-legacy-reader-does-not-exist') })).toEqual([])
    expect((await listLegacyRuns({ domain: domainWith([{ name: 'external-audit.jsonl' }]) })).map(run => run.runId)).toEqual(['syn-external-audit'])
  })

  it('sandboxRestore defaults: pending when the run clamped, not-clamped otherwise', async () => {
    const root = fileRootWith(['independent-clamped-completed.jsonl', 'clamped-no-prior-mode.jsonl', 'amend-plan.jsonl'])
    const byId = new Map((await listLegacyRuns({ fileRoot: root })).map(run => [run.runId, run]))
    expect(byId.get('syn-session-a')?.sandboxRestore).toEqual({ state: 'pending' })
    expect(byId.get('syn-clamped-no-prior')?.sandboxRestore).toEqual({ state: 'pending' })
    expect(byId.get('syn-amend-plan')?.sandboxRestore).toEqual({ state: 'not-clamped' })
  })

  it('a corrupt line makes the run rejected with an error and nothing throws', async () => {
    const root = fileRootWith(['amend-plan.jsonl'])
    const path = join(root, 'runs', 'syn-amend-plan', 'events.jsonl')
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    writeFileSync(path, [...lines.slice(0, 2), '{"v":1,"op":"log", this is not json', ...lines.slice(2)].join('\n') + '\n')
    const [summary] = await listLegacyRuns({ fileRoot: root })
    expect(summary).toMatchObject({ runId: 'syn-amend-plan', fold: 'rejected', backend: 'file' })
    expect(summary?.foldError).toMatch(/^LEGACY_STORE_CORRUPT.*line 3/)
    expect(summary?.phase).toBeUndefined()
    const read = await readLegacyRun({ fileRoot: root }, 'syn-amend-plan')
    expect(read?.summary.fold).toBe('rejected')
    expect(read?.projection).toBeUndefined()
    expect(read?.snapshot).toBeUndefined()
  })

  it('a stream the fold refuses is rejected with the fold code; neighbours still list', async () => {
    const root = fileRootWith(['amend-plan.jsonl', 'external-audit.jsonl'])
    const path = join(root, 'runs', 'syn-amend-plan', 'events.jsonl')
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    // Drop the init line: the stream no longer starts with init.
    writeFileSync(path, lines.slice(1).join('\n') + '\n')
    const runs = await listLegacyRuns({ fileRoot: root })
    expect(runs.map(run => [run.runId, run.fold])).toEqual([['syn-amend-plan', 'rejected'], ['syn-external-audit', 'ok']])
    expect(runs[0]?.foldError).toMatch(/^LEGACY_FIRST_NOT_INIT/)
  })

  it('a domain record whose revision contradicts its key rejects only that run', async () => {
    const good = events('external-audit.jsonl')
    const rows = good.map(event => ({ key: `syn-external-audit#${String(event.revision).padStart(12, '0')}`, value: event }))
    const first = rows[0]
    if (first === undefined) throw new Error('fixture empty')
    const tampered = [{ key: first.key, value: { ...(first.value as object), revision: 7 } }, ...rows.slice(1)]
    const domain: LegacyDomainReader = { async list() { return [...tampered, { key: 'not-a-key', value: {} }] } }
    const [summary] = await listLegacyRuns({ domain })
    expect(summary).toMatchObject({ runId: 'syn-external-audit', backend: 'domain', fold: 'rejected' })
    expect(summary?.foldError).toMatch(/^LEGACY_STORE_CORRUPT/)
  })

  it('readLegacyRun returns summary, projection and snapshot, and undefined for an unknown run', async () => {
    const root = fileRootWith(['owner-resolve.jsonl'])
    const read = await readLegacyRun({ fileRoot: root }, 'syn-owner-resolve')
    expect(read?.summary).toMatchObject({ runId: 'syn-owner-resolve', fold: 'ok', phase: 'blocked', revision: 9, eventCount: 9, objective: 'synthetic standard run' })
    expect(read?.projection?.ownerResolutions).toHaveLength(3)
    expect(read?.snapshot?.phase).toBe('blocked')
    expect(await readLegacyRun({ fileRoot: root }, 'no-such-run')).toBeUndefined()
    expect((await readLegacyRun({ domain: domainWith([{ name: 'owner-resolve.jsonl' }]) }, 'syn-owner-resolve'))?.summary.backend).toBe('domain')
  })

  it('legacyRunIdsForSession: the first run (id = session id), a later run (snapshot.sessionId) and a sessions index', async () => {
    const root = fileRootWith(['independent-clamped-completed.jsonl', 'amend-plan.jsonl', 'owner-resolve.jsonl'])
    mkdirSync(join(root, 'sessions'), { recursive: true })
    writeFileSync(join(root, 'sessions', 'syn-session-b.json'), JSON.stringify({ v: 1, sessionId: 'syn-session-b', currentRunId: 'syn-owner-resolve', runIds: ['syn-owner-resolve'] }))
    expect([...await legacyRunIdsForSession({ fileRoot: root }, 'syn-session-a')].sort()).toEqual(['syn-amend-plan', 'syn-session-a'])
    expect(await legacyRunIdsForSession({ fileRoot: root }, 'syn-session-b')).toEqual(['syn-owner-resolve'])
    expect(await legacyRunIdsForSession({ fileRoot: root }, 'unknown')).toEqual([])
    const listed = (await listLegacyRuns({ fileRoot: root })).find(run => run.runId === 'syn-owner-resolve')
    expect(listed?.sessionId).toBe('syn-session-b')
  })
})
