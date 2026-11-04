/**
 * `FileLedgerStore.list()`'s read memo (MY-202 review note): a warm scan must
 * not re-read and re-parse every ledger file, yet the listing must still equal
 * what a fresh scan would return, still see another process's atomic rename,
 * still report a damaged ledger on every call, and still show the store's own
 * write. `node:fs` is mocked here (not in any other test file) so the ledger
 * reads can be counted; the mock delegates every call to the real one.
 */

import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FileLedgerStore, emptyLedger, ledgerFileName } from '../src/store/ledger.js'
import type { LedgerDiagnostic, LegacyLedgerTable } from '../src/store/ledger.js'

const T0 = '2026-11-04T00:00:00.000Z'
const T1 = '2026-11-04T01:00:00.000Z'

/** Every path handed to `readFileSync` by the module graph of this test file. */
const counters = vi.hoisted(() => ({ reads: [] as string[] }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const realReadFileSync = actual.readFileSync as unknown as (path: unknown, ...rest: unknown[]) => unknown
  const countingReadFileSync = ((path: unknown, ...rest: unknown[]): unknown => {
    counters.reads.push(String(path))
    return realReadFileSync(path, ...rest)
  }) as unknown as typeof actual.readFileSync
  return { ...actual, readFileSync: countingReadFileSync }
})

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-autopilot-ledger-list-cache-'))
}

/** Ledger files read since the counter was last cleared. */
function jsonReads(): string[] {
  return counters.reads.filter(path => path.endsWith('.json'))
}

function diagnosticsSorted(store: FileLedgerStore): LedgerDiagnostic[] {
  return [...store.diagnostics].sort((a, b) => a.where.localeCompare(b.where))
}

describe('file ledger store list cache', () => {
  it('serves a warmed scan without reading any ledger file again', async () => {
    const root = tempRoot()
    const store = FileLedgerStore.open(root, { now: () => T1 })
    await store.write({ ...emptyLedger('s1', T0), links: [{ kind: 'pr', ref: '#1', at: T0 }] }, 0)
    await store.write({ ...emptyLedger('s2', T0), links: [{ kind: 'issue', ref: 'A-2', at: T0 }] }, 0)

    counters.reads.length = 0
    const first = store.list()
    expect(first.map(ledger => ledger.sessionId).sort()).toEqual(['s1', 's2'])
    expect(jsonReads()).toHaveLength(2) // the counter is live: a cold scan reads both files

    counters.reads.length = 0
    const second = store.list()
    expect(second).toEqual(first) // same ledgers, same readdir order
    expect(jsonReads()).toEqual([]) // and no ledger file was touched again
  })

  it('sees a ledger another store replaced on disk, not only the memo', async () => {
    const root = tempRoot()
    const mine = FileLedgerStore.open(root, { now: () => T1 })
    const base = await mine.write(emptyLedger('s1', T0), 0)
    expect(mine.list().map(ledger => ledger.revision)).toEqual([1]) // warm the scan

    const theirs = FileLedgerStore.open(root, { now: () => T1 })
    await theirs.write(base, 1) // atomic rename: a new file identity

    counters.reads.length = 0
    const after = mine.list()
    expect(after.map(ledger => ledger.sessionId)).toEqual(['s1'])
    expect(after.map(ledger => ledger.revision)).toEqual([2])
    expect(jsonReads().length).toBeGreaterThan(0) // the changed file was read again
  })

  it('re-reads a damaged ledger on every list and still lists the good one', async () => {
    const root = tempRoot()
    const store = FileLedgerStore.open(root, { now: () => T1 })
    const good = await store.write(emptyLedger('good', T0), 0)
    writeFileSync(join(root, 'ledgers', 'broken.json'), '{ not json', 'utf8')

    expect(store.list()).toEqual([good])
    expect(diagnosticsSorted(store)).toEqual([{ where: 'broken.json', reason: 'unparseable' }])

    counters.reads.length = 0
    expect(store.list()).toEqual([good])
    expect(diagnosticsSorted(store)).toEqual([{ where: 'broken.json', reason: 'unparseable' }])
    expect(counters.reads.some(path => path.endsWith('broken.json'))).toBe(true) // never memoised
    expect(counters.reads.some(path => path.endsWith('good.json'))).toBe(false) // memoised
  })

  it('shows its own write on the next list after a warm scan', async () => {
    const root = tempRoot()
    const store = FileLedgerStore.open(root, { now: () => T1 })
    const first = await store.write(emptyLedger('s1', T0), 0)
    expect(store.list()).toEqual([first])

    const next = await store.write({ ...first, links: [{ kind: 'pr', ref: '#2', at: T0 }] }, 1)
    expect(store.list()).toEqual([next])
    expect(store.list().map(ledger => ledger.revision)).toEqual([2])
  })

  it('re-reads the legacy table on every list and never memoises it', () => {
    const root = tempRoot()
    const rows = new Map<string, unknown>([['s1', { ...emptyLedger('s1', T0), revision: 1 }]])
    const legacy: LegacyLedgerTable = { get: key => rows.get(key), entries: () => rows.entries() }
    const store = FileLedgerStore.open(root, { migrateFrom: legacy })

    expect(store.list().map(ledger => ledger.revision)).toEqual([1])
    rows.set('s1', { ...emptyLedger('s1', T0), revision: 4 })
    expect(store.list().map(ledger => ledger.revision)).toEqual([4])
  })

  it('forgets a name that left the directory, so a recreated file is read again', async () => {
    const root = tempRoot()
    const store = FileLedgerStore.open(root, { now: () => T1 })
    const kept = await store.write(emptyLedger('kept', T0), 0)
    await store.write(emptyLedger('gone', T0), 0)
    expect(store.list().map(ledger => ledger.sessionId).sort()).toEqual(['gone', 'kept'])

    unlinkSync(join(root, 'ledgers', ledgerFileName('gone')))
    expect(store.list()).toEqual([kept])

    writeFileSync(join(root, 'ledgers', ledgerFileName('gone')), JSON.stringify({ ...emptyLedger('gone', T0), revision: 12345 }), 'utf8')
    const back = store.list()
    expect(back.map(ledger => ledger.sessionId).sort()).toEqual(['gone', 'kept'])
    expect(back.find(ledger => ledger.sessionId === 'gone')?.revision).toBe(12345)
  })
})
