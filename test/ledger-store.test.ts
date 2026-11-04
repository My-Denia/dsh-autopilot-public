/**
 * The v3 ledger store through the `LedgerStoreLike` contract: CAS and revision
 * stamping, durable reload, the rule that a damaged ledger is skipped with a
 * diagnostic and never fails the mount, and the cross-process rules that made
 * the file store the only writer: reads come from disk, a write holds a lock
 * across check and rename, and a ledger an earlier build put in the domain
 * `ledgers` table is migrated without that table ever being written.
 */

import { execFile, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { AUTOPILOT_DOMAIN_SPEC, LEDGERS_TABLE } from '../src/store/domain.js'
import type { DomainFacilityLike, DomainLike, DomainSpecLike, KvTableLike } from '../src/store/domain.js'
import {
  AP_LEDGER_CONFLICT,
  FileLedgerStore,
  STALE_LOCK_MS,
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

// The domain backend is gone (it lost rows across processes); the contract now has one backend.
const backends: readonly Backend[] = [
  { name: 'file', open: async () => FileLedgerStore.open(tempRoot(), { now: clock() }) },
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

/** The two-process stress writer and the vite-node runner that executes its TypeScript. */
const WRITER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ledger-writer', 'writer.ts')
const VITE_NODE = join(
  dirname(createRequire(createRequire(import.meta.url).resolve('vitest/package.json')).resolve('vite-node/package.json')),
  'vite-node.mjs',
)

describe('file ledger store across processes', () => {
  // The Windows finding: two processes, two sessions, one storage. Each must see the other's ledger.
  it('two stores (two processes) writing two sessions: both survive and each sees the other without reopening', async () => {
    const root = tempRoot()
    const a = FileLedgerStore.open(root)
    const b = FileLedgerStore.open(root)
    const fromA = await a.write(emptyLedger('session-a', T0), 0)
    const fromB = await b.write(emptyLedger('session-b', T0), 0)
    expect(a.load('session-b')).toEqual(fromB)
    expect(b.load('session-a')).toEqual(fromA)
    expect(a.list().map(l => l.sessionId).sort()).toEqual(['session-a', 'session-b'])
    expect(FileLedgerStore.open(root).list().map(l => l.sessionId).sort()).toEqual(['session-a', 'session-b'])
  })

  it('same session from two stores: the stale writer gets AP_LEDGER_CONFLICT, and a re-read retry loses nothing', async () => {
    const root = tempRoot()
    const a = FileLedgerStore.open(root)
    const b = FileLedgerStore.open(root)
    const base = await a.write(emptyLedger('s1', T0), 0)
    const seenByB = b.load('s1')!
    await a.write({ ...base, links: [{ kind: 'issue', ref: 'A-1', at: T0 }] }, base.revision)
    await expectConflict(b.write({ ...seenByB, links: [{ kind: 'issue', ref: 'B-1', at: T0 }] }, seenByB.revision))
    const fresh = b.load('s1')!
    await b.write({ ...fresh, links: [...fresh.links, { kind: 'issue', ref: 'B-1', at: T0 }] }, fresh.revision)
    expect(a.load('s1')?.links.map(l => l.ref)).toEqual(['A-1', 'B-1'])
    expect(a.load('s1')?.revision).toBe(3)
  })

  it('a writer waits for another process\'s lock and then sees its revision instead of overwriting it', async () => {
    const root = tempRoot()
    const mine = FileLedgerStore.open(root)
    const base = await mine.write(emptyLedger('s1', T0), 0)
    const path = join(root, 'ledgers', ledgerFileName('s1'))
    // "Another process" holds the lock, publishes revision 2, then releases.
    writeFileSync(`${path}.lock`, '')
    const pending = mine.write({ ...base, links: [{ kind: 'issue', ref: 'mine', at: T0 }] }, 1)
    await new Promise(resolve => setTimeout(resolve, 60))
    writeFileSync(path, JSON.stringify({ ...base, revision: 2, links: [{ kind: 'issue', ref: 'theirs', at: T0 }] }))
    const { unlinkSync } = await import('node:fs')
    unlinkSync(`${path}.lock`)
    await expectConflict(pending)
    expect(mine.load('s1')?.links.map(l => l.ref)).toEqual(['theirs'])
  })

  it('a lock that stays held past the wait bound is AP_LEDGER_CONFLICT; a stale one (crashed writer) is taken over', async () => {
    const root = tempRoot()
    const store = FileLedgerStore.open(root, { lockWaitMs: 50 })
    const path = join(root, 'ledgers', ledgerFileName('s1'))
    mkdirSync(join(root, 'ledgers'), { recursive: true })
    writeFileSync(`${path}.lock`, '')
    await expectConflict(store.write(emptyLedger('s1', T0), 0))
    const old = (Date.now() - STALE_LOCK_MS - 1000) / 1000
    utimesSync(`${path}.lock`, old, old)
    expect((await store.write(emptyLedger('s1', T0), 0)).revision).toBe(1)
    expect(readdirSync(join(root, 'ledgers'))).toEqual([ledgerFileName('s1')]) // no lock or temp file left
  })

  it('a lock naming a dead pid on this host is taken over at once, without waiting', async () => {
    const root = tempRoot()
    const store = FileLedgerStore.open(root, { lockWaitMs: 50 })
    const path = join(root, 'ledgers', ledgerFileName('s1'))
    mkdirSync(join(root, 'ledgers'), { recursive: true })
    const dead = spawnSync(process.execPath, ['-e', ''])
    writeFileSync(`${path}.lock`, `${dead.pid}\n${hostname()}\n`)
    expect((await store.write(emptyLedger('s1', T0), 0)).revision).toBe(1)
    expect(readdirSync(join(root, 'ledgers'))).toEqual([ledgerFileName('s1')])
  })

  it('a lock naming a live pid is not taken over', async () => {
    const root = tempRoot()
    const store = FileLedgerStore.open(root, { lockWaitMs: 50 })
    const path = join(root, 'ledgers', ledgerFileName('s1'))
    mkdirSync(join(root, 'ledgers'), { recursive: true })
    writeFileSync(`${path}.lock`, `${process.pid}\n${hostname()}\n`)
    await expectConflict(store.write(emptyLedger('s1', T0), 0))
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a refused lock create (EACCES) is a busy lock: AP_LEDGER_CONFLICT, not a dispatch failure', async () => {
    const root = tempRoot()
    const store = FileLedgerStore.open(root, { lockWaitMs: 50 })
    const dir = join(root, 'ledgers')
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o555)
    try {
      await expectConflict(store.write(emptyLedger('s1', T0), 0))
    } finally {
      chmodSync(dir, 0o755)
    }
  })

  it.each(['not json {', JSON.stringify({ v: 99, sessionId: 's1' })])('a write over an unusable stored file raises AP_STORE_CORRUPT and leaves it byte-unchanged', async (content) => {
    const root = tempRoot()
    const store = FileLedgerStore.open(root)
    mkdirSync(join(root, 'ledgers'), { recursive: true })
    const path = join(root, 'ledgers', ledgerFileName('s1'))
    writeFileSync(path, content)
    const err = await store.write(emptyLedger('s1', T0), 0).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AutopilotError)
    expect((err as AutopilotError).code).toBe('AP_STORE_CORRUPT')
    expect(readFileSync(path, 'utf8')).toBe(content)
    expect(readdirSync(join(root, 'ledgers'))).toEqual([ledgerFileName('s1')])
  })

  // A real two-process race on one session. Without the lock both processes can pass the
  // revision check before either renames, and one append is silently lost.
  it('two real processes appending to ONE session: every append is kept', async () => {
    const root = tempRoot()
    const run = promisify(execFile)
    const count = 40
    const children = ['P', 'Q'].map(tag => run(process.execPath, [VITE_NODE, WRITER, '--', root, 'shared', tag, String(count)], { timeout: 60_000 }))
    await Promise.all(children)
    const ledger = FileLedgerStore.open(root).load('shared')!
    const refs = ledger.links.map(l => l.ref)
    expect(refs).toHaveLength(2 * count)
    expect(new Set(refs).size).toBe(2 * count)
    expect(ledger.revision).toBe(2 * count)
  }, 90_000)
})

describe('file ledger store: migration from the domain ledgers table', () => {
  const tableOf = (rows: Record<string, unknown>) => {
    const facility = new FakeFacility({ [LEDGERS_TABLE]: rows })
    return { facility, table: facility.tables.get(LEDGERS_TABLE)! }
  }

  it('lists a table-only ledger, migrates it to its file on first load, and continues its CAS sequence', async () => {
    const stored: Ledger = { ...emptyLedger('s1', T0), revision: 4, links: [{ kind: 'pr', ref: '#9', at: T0 }] }
    const { facility, table } = tableOf({ s1: stored })
    const root = tempRoot()
    const store = FileLedgerStore.open(root, { migrateFrom: table })
    expect(store.list()).toEqual([stored])
    expect(existsSync(join(root, 'ledgers', 's1.json'))).toBe(false) // listing does not write
    expect(store.load('s1')).toEqual(stored)
    expect(JSON.parse(readFileSync(join(root, 'ledgers', 's1.json'), 'utf8'))).toEqual(stored)
    await expectConflict(store.write(stored, 0))
    expect((await store.write(stored, 4)).revision).toBe(5)
    // The file wins from now on; the table is never written.
    expect(store.load('s1')?.revision).toBe(5)
    expect(store.list().map(l => l.revision)).toEqual([5])
    for (const t of facility.tables.values()) expect(t.puts).toBe(0)
    expect(table.records.get('s1')).toEqual(stored)
  })

  it('a first write of a table-only session expects the table revision, so a stale 0 cannot erase it', async () => {
    const stored: Ledger = { ...emptyLedger('s1', T0), revision: 2 }
    const store = FileLedgerStore.open(tempRoot(), { migrateFrom: tableOf({ s1: stored }).table })
    await expectConflict(store.write(emptyLedger('s1', T0), 0))
    expect((await store.write(stored, 2)).revision).toBe(3)
  })

  it('an existing file is never replaced by the table row', async () => {
    const root = tempRoot()
    const onDisk = await FileLedgerStore.open(root).write({ ...emptyLedger('s1', T0), links: [{ kind: 'pr', ref: 'file', at: T0 }] }, 0)
    const store = FileLedgerStore.open(root, { migrateFrom: tableOf({ s1: { ...emptyLedger('s1', T0), revision: 7 } }).table })
    expect(store.load('s1')).toEqual(onDisk)
    expect(store.list()).toEqual([onDisk])
  })

  it('skips table rows that are not ledgers, with a diagnostic, and still lists the good ones', async () => {
    const store = FileLedgerStore.open(tempRoot(), {
      migrateFrom: tableOf({ ok: emptyLedger('ok', T0), junk: { hello: 'world' }, moved: emptyLedger('other', T0) }).table,
    })
    expect(store.list().map(l => l.sessionId)).toEqual(['ok'])
    expect([...store.diagnostics].sort((a, b) => a.where.localeCompare(b.where))).toEqual([
      { where: 'ledgers:junk', reason: 'not-a-ledger' },
      { where: 'ledgers:moved', reason: 'not-a-ledger' },
    ])
    expect(store.load('moved')).toBeUndefined()
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
