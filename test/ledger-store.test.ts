/**
 * The v3 ledger store, both backends, through the one `LedgerStoreLike`
 * contract: CAS and revision stamping, durable reload, and the rule that a
 * damaged ledger is skipped with a diagnostic and never fails the mount.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AUTOPILOT_DOMAIN_SPEC, LEDGERS_TABLE } from '../src/store/domain.js'
import type { DomainFacilityLike, DomainLike, DomainSpecLike, KvTableLike } from '../src/store/domain.js'
import {
  AP_LEDGER_CONFLICT,
  DomainLedgerStore,
  FileLedgerStore,
  emptyLedger,
  ledgerFileName,
  legacySourcesOf,
} from '../src/store/ledger.js'
import type { LedgerStoreLike } from '../src/store/ledger.js'
import { AutopilotError } from '../src/domain/types.js'
import type { Ledger } from '../src/domain/ledger-types.js'

const T0 = '2026-11-04T00:00:00.000Z'
const T1 = '2026-11-04T01:00:00.000Z'

function clock(): () => string {
  let n = 0
  return () => (n++ === 0 ? T1 : `2026-11-04T01:00:0${Math.min(n, 9)}.000Z`)
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-autopilot-ledger-'))
}

async function expectConflict(promise: Promise<unknown>): Promise<void> {
  try {
    await promise
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AutopilotError)
    expect((error as AutopilotError).code).toBe(AP_LEDGER_CONFLICT)
    return
  }
  expect.unreachable('expected AP_LEDGER_CONFLICT')
}

// ---------------------------------------------------------------- fake domain

class FakeTable implements KvTableLike {
  readonly records = new Map<string, unknown>()
  puts = 0
  get(key: string): unknown { return this.records.get(key) }
  entries(): IterableIterator<[string, unknown]> { return [...this.records.entries()][Symbol.iterator]() }
  keys(): IterableIterator<string> { return [...this.records.keys()][Symbol.iterator]() }
  async put(key: string, value: unknown): Promise<void> {
    await Promise.resolve() // a real put is asynchronous; the lane must cope with that
    this.puts += 1
    this.records.set(key, value)
  }
}

class FakeFacility implements DomainFacilityLike {
  readonly tables = new Map<string, FakeTable>()
  closed = false
  opened: DomainSpecLike | undefined

  constructor(seed: Record<string, Record<string, unknown>> = {}) {
    for (const name of Object.keys(AUTOPILOT_DOMAIN_SPEC.tables)) {
      const table = new FakeTable()
      for (const [key, raw] of Object.entries(seed[name] ?? {})) {
        // The facility runs the spec's valueSchema on every stored record at open.
        table.records.set(key, AUTOPILOT_DOMAIN_SPEC.tables[name]!.valueSchema.parse(raw))
      }
      this.tables.set(name, table)
    }
  }

  async open(spec: DomainSpecLike): Promise<DomainLike> {
    this.opened = spec
    return {
      table: (name: string) => {
        const table = this.tables.get(name)
        if (table === undefined) throw new Error(`no table ${name}`)
        return table
      },
      close: async () => { this.closed = true },
    }
  }
}

// ------------------------------------------------------------- shared contract

interface Backend {
  readonly name: string
  open(): Promise<LedgerStoreLike>
}

const backends: readonly Backend[] = [
  { name: 'file', open: async () => FileLedgerStore.open(tempRoot(), { now: clock() }) },
  { name: 'domain', open: async () => DomainLedgerStore.open(new FakeFacility(), AUTOPILOT_DOMAIN_SPEC, { now: clock() }) },
]

describe('emptyLedger', () => {
  it('is revision 0 with the documented defaults', () => {
    expect(emptyLedger('s1', T0)).toEqual({
      v: 3,
      sessionId: 's1',
      revision: 0,
      previousGoals: [],
      delegations: [],
      reviews: [],
      links: [],
      autoContinue: { available: false, code: 'not-yet-observed', reason: 'not yet observed' },
      depth: { executorLead: 2, source: 'plugin-default' },
      legacyRunIds: [],
      updatedAt: T0,
    })
  })
})

for (const backend of backends) {
  describe(`${backend.name} ledger store contract`, () => {
    it('reports its kind and an empty state before any write', async () => {
      const store = await backend.open()
      expect(store.kind).toBe(backend.name)
      expect(store.load('s1')).toBeUndefined()
      expect(store.list()).toEqual([])
      expect(store.diagnostics).toEqual([])
    })

    it('stamps revision = expected + 1 and updatedAt, ignoring the revision the caller put on the document', async () => {
      const store = await backend.open()
      const first = await store.write({ ...emptyLedger('s1', T0), revision: 99 }, 0)
      expect(first.revision).toBe(1)
      expect(first.updatedAt).toBe(T1)
      expect(store.load('s1')).toEqual(first)
      const second = await store.write({ ...first, links: [{ kind: 'pr', ref: '#1', at: T0 }] }, 1)
      expect(second.revision).toBe(2)
      expect(second.links).toHaveLength(1)
      expect(store.list()).toEqual([second])
    })

    it('rejects a stale or premature expected revision with AP_LEDGER_CONFLICT and changes nothing', async () => {
      const store = await backend.open()
      const first = await store.write(emptyLedger('s1', T0), 0)
      await expectConflict(store.write(first, 0)) // already written once
      await expectConflict(store.write(first, 5)) // from the future
      await expectConflict(store.write(emptyLedger('s2', T0), 1)) // new session must expect 0
      expect(store.load('s1')).toEqual(first)
      expect(store.load('s2')).toBeUndefined()
    })

    it('lets exactly one of two concurrent writers at the same revision win', async () => {
      const store = await backend.open()
      const base = await store.write(emptyLedger('s1', T0), 0)
      const results = await Promise.allSettled([
        store.write({ ...base, links: [{ kind: 'issue', ref: 'A-1', at: T0 }] }, 1),
        store.write({ ...base, links: [{ kind: 'issue', ref: 'B-1', at: T0 }] }, 1),
      ])
      expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected'])
      const loser = results.find(r => r.status === 'rejected') as PromiseRejectedResult
      expect((loser.reason as AutopilotError).code).toBe(AP_LEDGER_CONFLICT)
      expect(store.load('s1')?.revision).toBe(2)
    })

    it('keeps sessions independent', async () => {
      const store = await backend.open()
      await store.write(emptyLedger('a', T0), 0)
      await store.write(emptyLedger('b', T0), 0)
      expect(store.list().map(l => l.sessionId).sort()).toEqual(['a', 'b'])
    })
  })
}

describe('file ledger store', () => {
  it('writes <root>/ledgers/<id>.json atomically and a fresh store reloads it from disk', async () => {
    const root = tempRoot()
    expect(existsSync(join(root, 'ledgers'))).toBe(false) // created lazily
    const store = FileLedgerStore.open(root, { now: () => T1 })
    expect(existsSync(join(root, 'ledgers'))).toBe(false) // opening does not create it
    const written = await store.write({ ...emptyLedger('ses-1', T0), links: [{ kind: 'pr', ref: '#7', at: T0 }] }, 0)
    expect(readdirSync(join(root, 'ledgers'))).toEqual(['ses-1.json']) // no tmp file left behind
    expect(JSON.parse(readFileSync(join(root, 'ledgers', 'ses-1.json'), 'utf8'))).toEqual(written)

    const reopened = FileLedgerStore.open(root)
    expect(reopened.load('ses-1')).toEqual(written)
    expect(reopened.diagnostics).toEqual([])
    // The reloaded store continues the CAS sequence.
    await expectConflict(reopened.write(written, 0))
    expect((await reopened.write(written, 1)).revision).toBe(2)
  })

  it('sees a revision another process published, not only its own cache', async () => {
    const root = tempRoot()
    const mine = FileLedgerStore.open(root)
    const base = await mine.write(emptyLedger('s1', T0), 0)
    const theirs = FileLedgerStore.open(root)
    await theirs.write(base, 1) // disk is now at revision 2
    await expectConflict(mine.write(base, 1)) // mine still caches revision 1
    expect((await mine.write(base, 2)).revision).toBe(3)
  })

  it('maps distinct session ids to distinct files and keeps ids with unsafe characters', async () => {
    const ids = ['a/b', 'a//b', 'a_b', 'a%2Fb', '../x', 'sess:1', 'sess::1']
    expect(new Set(ids.map(ledgerFileName)).size).toBe(ids.length)
    for (const id of ids) expect(ledgerFileName(id)).toMatch(/^[A-Za-z0-9._%-]+\.json$/)
    const root = tempRoot()
    const store = FileLedgerStore.open(root)
    for (const id of ids) await store.write(emptyLedger(id, T0), 0)
    const reopened = FileLedgerStore.open(root)
    expect(reopened.list().map(l => l.sessionId).sort()).toEqual([...ids].sort())
    expect(readdirSync(join(root, 'ledgers')).every(name => !name.includes('/'))).toBe(true)
  })

  it('skips damaged files with a diagnostic and still mounts the good ones', async () => {
    const root = tempRoot()
    const good = await FileLedgerStore.open(root, { now: () => T1 }).write(emptyLedger('good', T0), 0)
    const dir = join(root, 'ledgers')
    writeFileSync(join(dir, 'broken.json'), '{ not json', 'utf8')
    writeFileSync(join(dir, 'wrong-shape.json'), JSON.stringify({ v: 2, sessionId: 'wrong-shape' }), 'utf8')
    writeFileSync(join(dir, 'liar.json'), JSON.stringify(emptyLedger('someone-else', T0)), 'utf8') // name does not match its id
    writeFileSync(join(dir, 'notes.txt'), 'ignored', 'utf8')
    mkdirSync(join(dir, 'dir.json'))

    const store = FileLedgerStore.open(root)
    expect(store.list()).toEqual([good])
    expect(store.load('broken')).toBeUndefined()
    expect([...store.diagnostics].sort((a, b) => a.where.localeCompare(b.where))).toEqual([
      { where: 'broken.json', reason: 'unparseable' },
      { where: 'dir.json', reason: 'unparseable' },
      { where: 'liar.json', reason: 'not-a-ledger' },
      { where: 'wrong-shape.json', reason: 'not-a-ledger' },
    ])
    // The damaged file is left alone, and a diagnostic carries no stored text.
    expect(readFileSync(join(dir, 'broken.json'), 'utf8')).toBe('{ not json')
    expect(JSON.stringify(store.diagnostics)).not.toContain('not json')
  })

  it('treats a missing root as empty', () => {
    const store = FileLedgerStore.open(join(tempRoot(), 'does', 'not', 'exist'))
    expect(store.list()).toEqual([])
    expect(store.diagnostics).toEqual([])
  })
})

describe('domain ledger store', () => {
  it('opens the autopilot domain spec and writes the ledgers table keyed by session id', async () => {
    const facility = new FakeFacility()
    const store = await DomainLedgerStore.open(facility, undefined, { now: () => T1 })
    expect(facility.opened).toBe(AUTOPILOT_DOMAIN_SPEC)
    const written = await store.write(emptyLedger('s1', T0), 0)
    expect(facility.tables.get(LEDGERS_TABLE)?.records.get('s1')).toEqual(written)
    // The 0.2.x tables are untouched.
    expect(facility.tables.get('events')?.puts).toBe(0)
    expect(facility.tables.get('runs')?.puts).toBe(0)
  })

  it('materializes existing records at open and continues their CAS sequence', async () => {
    const stored: Ledger = { ...emptyLedger('s1', T0), revision: 4 }
    const store = await DomainLedgerStore.open(new FakeFacility({ [LEDGERS_TABLE]: { s1: stored } }))
    expect(store.load('s1')).toEqual(stored)
    await expectConflict(store.write(stored, 0))
    expect((await store.write(stored, 4)).revision).toBe(5)
  })

  it('skips records that are not ledgers, or sit under another session id, without failing open', async () => {
    const store = await DomainLedgerStore.open(new FakeFacility({
      [LEDGERS_TABLE]: {
        ok: emptyLedger('ok', T0),
        junk: { hello: 'world' },
        moved: emptyLedger('other', T0),
      },
    }))
    expect(store.list().map(l => l.sessionId)).toEqual(['ok'])
    expect([...store.diagnostics].sort((a, b) => a.where.localeCompare(b.where))).toEqual([
      { where: 'junk', reason: 'not-a-ledger' },
      { where: 'moved', reason: 'not-a-ledger' },
    ])
  })

  it('a failed put leaves the cache unchanged and the next write at the same revision succeeds', async () => {
    const facility = new FakeFacility()
    const store = await DomainLedgerStore.open(facility)
    const table = facility.tables.get(LEDGERS_TABLE)!
    const original = table.put.bind(table)
    let fail = true
    table.put = async (key, value) => {
      if (fail) { fail = false; throw new Error('disk full') }
      return original(key, value)
    }
    await expect(store.write(emptyLedger('s1', T0), 0)).rejects.toThrow('disk full')
    expect(store.load('s1')).toBeUndefined()
    expect((await store.write(emptyLedger('s1', T0), 0)).revision).toBe(1)
  })

  it('releases the domain handle on close', async () => {
    const facility = new FakeFacility()
    const store = await DomainLedgerStore.open(facility)
    await store.close()
    expect(facility.closed).toBe(true)
  })
})

describe('legacySourcesOf', () => {
  it('carries only what is present', () => {
    const domain = { open: async () => { throw new Error('unused') } }
    expect(legacySourcesOf('/root')).toEqual({ fileRoot: '/root' })
    expect(legacySourcesOf(undefined, domain as never)).toEqual({ domain })
    expect(legacySourcesOf(undefined)).toEqual({})
    expect(legacySourcesOf('/root', domain as never)).toEqual({ fileRoot: '/root', domain })
  })
})
