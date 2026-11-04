/**
 * The v3 ledger store: one small JSON file per root session.
 *
 * WHAT IT HOLDS. Execution, cancel, resume and history display (see
 * `../domain/ledger-types.ts`). It is not an approval record and nothing reads
 * it as a gate, so the store is deliberately plain: a compare-and-swap on a
 * revision counter and an atomic whole-document replace. There is no event
 * stream and no fold.
 *
 * ONE WRITER, ONE FILE PER ROOT. Ledgers live at `<root>/ledgers/<id>.json`,
 * where `<root>` is the plugin store root (`defaultStoreRoot()`, by default
 * `$DSH_HOME/storages/dsh-autopilot`, beside the legacy `runs/`). Until 0.3.0-rc
 * the ledger went into the `ledgers` table of the autopilot storage domain when
 * the host mounted one; the host's JSON backend keeps that whole domain in ONE
 * file (`$DSH_HOME/storages/dsh_autopilot.json`) that each process loads at open
 * and republishes whole on every put. Two dsh processes on one profile therefore
 * overwrote each other's rows (observed on Windows: one session's ledger never
 * appeared). A file per root session means two processes writing two sessions
 * never touch the same file, and the domain file, which also holds the legacy
 * v1 `events`/`runs`, is never written by this plugin again.
 *
 * CROSS-PROCESS CAS. `write` takes `<id>.lock` (exclusive create), re-reads the
 * stored revision FROM DISK, compares, writes a temp file and renames it over the
 * ledger, then drops the lock. So a second process's write is seen as a revision
 * conflict, never overwritten. A lock older than {@link STALE_LOCK_MS} is a
 * crashed writer and is taken over; a lock that stays busy past the wait bound
 * is reported as `AP_LEDGER_CONFLICT`, which the engine already retries.
 *
 * READS COME FROM DISK. `load` reads its file every call: a cache filled at
 * open would hide what another process wrote since. `list` still scans the
 * directory every call, but keeps the one successful read per file that still
 * carries the same stat fingerprint (`mtimeNs:size:ino`, bigint stat): an
 * atomic rename by another process changes that fingerprint, so its ledger is
 * re-read; a file that did not parse is never memoised, so its diagnostic is
 * produced on every call.
 *
 * MIGRATION. A ledger an earlier build wrote into the domain `ledgers` table is
 * still read (passed in as `migrateFrom`, read-only). The first `load` of that
 * session copies it to its file under the lock, if the file is still absent; from
 * then on the file wins. Nothing here ever calls `put` on a domain table.
 *
 * A DOCUMENT THAT CANNOT BE USED NEVER FAILS THE MOUNT. A file that does not
 * parse, or a record that is not a v3 ledger, is skipped and reported through
 * `diagnostics` (file name or key plus a reason code, no stored text), so one
 * damaged ledger costs that session's history display and nothing else. It is
 * left in place, untouched.
 */

import { hostname } from 'node:os'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { LEDGER_VERSION } from '../domain/ledger-types.js'
import type { Ledger } from '../domain/ledger-types.js'
import { AP_LEDGER_CONFLICT, AP_STORE_CORRUPT } from '../domain/refusals.js'
import { AutopilotError } from '../domain/types.js'
import type { LegacyDomainReader, LegacySources } from '../legacy/index.js'

export { AP_LEDGER_CONFLICT }

/** Why a stored ledger was skipped. A code, never stored text. */
export interface LedgerDiagnostic {
  /** File name, or `ledgers:<key>` for a row of the legacy domain table. */
  readonly where: string
  readonly reason: 'unparseable' | 'not-a-ledger'
}

/** What the engine and the read-only service depend on. */
export interface LedgerStoreLike {
  /** Which backend this is, recorded rather than assumed. Always `file` since the domain table stopped being written. */
  readonly kind: 'file'
  /** The stored ledger for a root session, read now, or `undefined` when it has none. */
  load(sessionId: string): Ledger | undefined
  /**
   * Every stored ledger, unordered. A file already read at its current stat
   * fingerprint is not read again; a changed, absent or damaged file is.
   */
  list(): readonly Ledger[]
  /**
   * Compare-and-swap write. Stores `next` with `revision = expectedRevision + 1`
   * and a fresh `updatedAt`, and resolves with the stored ledger. A session with
   * no ledger has revision 0.
   * @throws AutopilotError `AP_LEDGER_CONFLICT` when the stored revision differs.
   */
  write(next: Ledger, expectedRevision: number): Promise<Ledger>
  /**
   * Re-read one session's document after a CAS conflict. Optional: a store whose
   * reads already come from the medium has nothing to do.
   */
  reload?(sessionId: string): void
  /** Documents skipped by the latest directory scan (the open, or the last `list`). */
  readonly diagnostics: readonly LedgerDiagnostic[]
}

/** A fresh ledger at revision 0 (never written until the first `write`). */
export function emptyLedger(sessionId: string, now: string): Ledger {
  return {
    v: LEDGER_VERSION,
    sessionId,
    revision: 0,
    previousGoals: [],
    delegations: [],
    reviews: [],
    links: [],
    autoContinue: { available: false, code: 'not-yet-observed', reason: 'not yet observed' },
    depth: { executorLead: 2, source: 'plugin-default' },
    legacyRunIds: [],
    updatedAt: now,
  }
}

/** True when `value` has the v3 shape the store needs to trust (not a deep schema check). */
function isLedger(value: unknown): value is Ledger {
  if (value === null || typeof value !== 'object') return false
  const l = value as Record<string, unknown>
  return (
    l.v === LEDGER_VERSION &&
    typeof l.sessionId === 'string' && l.sessionId.length > 0 &&
    typeof l.revision === 'number' && Number.isInteger(l.revision) && l.revision >= 0 &&
    typeof l.updatedAt === 'string' &&
    Array.isArray(l.previousGoals) && Array.isArray(l.delegations) &&
    Array.isArray(l.reviews) && Array.isArray(l.links) && Array.isArray(l.legacyRunIds) &&
    typeof l.autoContinue === 'object' && l.autoContinue !== null &&
    typeof l.depth === 'object' && l.depth !== null
  )
}

function conflict(sessionId: string, expected: number, actual: number): AutopilotError {
  return new AutopilotError(
    `ledger ${JSON.stringify(sessionId)}: expected revision ${expected}, stored revision is ${actual}`,
    AP_LEDGER_CONFLICT,
  )
}

/** Read-only view of the legacy domain `ledgers` table: the part of `KvTableLike` migration reads. */
export interface LegacyLedgerTable {
  get(key: string): unknown
  entries(): IterableIterator<[string, unknown]>
}

/** Options of {@link FileLedgerStore.open}. */
export interface LedgerStoreOptions {
  /** ISO-8601 clock; tests inject one. */
  readonly now?: () => string
  /** The domain `ledgers` table an earlier build wrote, read and migrated, never written. */
  readonly migrateFrom?: LegacyLedgerTable
  /** How long `write` waits for another writer's lock before reporting a conflict. Default 2000 ms. */
  readonly lockWaitMs?: number
}

/** A lock older than this belongs to a writer that died inside the critical section. */
export const STALE_LOCK_MS = 30_000

const isoNow = (): string => new Date().toISOString()

/**
 * Injective file name for a session id: `[A-Za-z0-9._-]` stay, every other UTF-8
 * byte (and `%`) becomes `%XX`. Two ids can never share a file.
 */
export function ledgerFileName(sessionId: string): string {
  let out = ''
  for (const byte of Buffer.from(sessionId, 'utf8')) {
    const ch = String.fromCharCode(byte)
    out += /[A-Za-z0-9._-]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return `${out}.json`
}

/** True when the lock names a pid on this host that no longer exists. Unreadable or foreign locks are not dead. */
function lockOwnerIsDead(lock: string): boolean {
  let text: string
  try { text = readFileSync(lock, 'utf8') } catch { return false }
  const [pidText, host] = text.split('\n')
  const pid = Number(pidText)
  if (!Number.isInteger(pid) || pid <= 0 || host !== hostname()) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Windows can refuse a rename for a moment while another process has the target open. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error
      const until = Date.now() + 10 * (attempt + 1)
      while (Date.now() < until) { /* brief synchronous back-off: the lock is held */ }
    }
  }
}

type Read =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ledger'; readonly ledger: Ledger }
  | { readonly kind: 'skipped'; readonly reason: LedgerDiagnostic['reason'] }

/** File-backed ledger store under `<root>/ledgers/`; the only ledger writer. */
export class FileLedgerStore implements LedgerStoreLike {
  readonly kind = 'file' as const
  private scanned: readonly LedgerDiagnostic[] = []
  /**
   * `list`'s memo: file name → the ledger that file held at `fingerprint`.
   * Successful reads only. A skipped or absent result is never kept here: a
   * transient Windows EPERM/EBUSY or a half-finished external write must not
   * stick. Keyed by stat identity, so another process's rename is seen.
   */
  private readonly listed = new Map<string, { readonly fingerprint: string; readonly ledger: Ledger }>()
  private readonly now: () => string
  private readonly dir: string
  private readonly legacy: LegacyLedgerTable | undefined
  private readonly lockWaitMs: number

  private constructor(root: string, options: LedgerStoreOptions) {
    this.now = options.now ?? isoNow
    this.dir = join(root, 'ledgers')
    this.legacy = options.migrateFrom
    this.lockWaitMs = options.lockWaitMs ?? 2000
    this.list()
  }

  /** Scan once for diagnostics and return the store. Never throws on a damaged ledger. */
  static open(root: string, options: LedgerStoreOptions = {}): FileLedgerStore {
    return new FileLedgerStore(root, options)
  }

  get diagnostics(): readonly LedgerDiagnostic[] {
    return this.scanned
  }

  private pathOf(sessionId: string): string {
    return join(this.dir, ledgerFileName(sessionId))
  }

  /** One ledger file, read now. `name` must be the file name of the id it claims. */
  private readFile(name: string): Read {
    let text: string | undefined
    for (let attempt = 0; text === undefined; attempt += 1) {
      try {
        text = readFileSync(join(this.dir, name), 'utf8')
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
        if (attempt >= 1) return { kind: 'skipped', reason: 'unparseable' } // a read error twice running: not usable
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { kind: 'skipped', reason: 'unparseable' }
    }
    // A file whose own sessionId does not map back to its name is not ours to trust.
    if (!isLedger(parsed) || ledgerFileName(parsed.sessionId) !== name) return { kind: 'skipped', reason: 'not-a-ledger' }
    return { kind: 'ledger', ledger: parsed }
  }

  /** The legacy domain row for a session, when it is a usable ledger. */
  private legacyRow(sessionId: string): Ledger | undefined {
    if (this.legacy === undefined) return undefined
    let value: unknown
    try { value = this.legacy.get(sessionId) } catch { return undefined }
    return isLedger(value) && value.sessionId === sessionId ? value : undefined
  }

  load(sessionId: string): Ledger | undefined {
    const read = this.readFile(ledgerFileName(sessionId))
    if (read.kind === 'ledger') return read.ledger.sessionId === sessionId ? read.ledger : undefined
    if (read.kind === 'skipped') return undefined
    const row = this.legacyRow(sessionId)
    if (row === undefined) return undefined
    this.migrate(row)
    const after = this.readFile(ledgerFileName(sessionId))
    return after.kind === 'ledger' ? after.ledger : row
  }

  /**
   * One ledger file as seen by `list`: the memo when the file's stat identity is
   * unchanged, a fresh read otherwise. The stat is taken BEFORE the read, so a
   * write racing this read can only leave a stale fingerprint (a re-read next
   * time), never a current fingerprint on stale bytes.
   */
  private readListed(name: string): Read {
    let fingerprint: string
    try {
      const stats = statSync(join(this.dir, name), { bigint: true })
      fingerprint = `${stats.mtimeNs}:${stats.size}:${stats.ino}`
    } catch {
      this.listed.delete(name) // absent or not statable: no memo can be trusted
      return this.readFile(name)
    }
    const cached = this.listed.get(name)
    if (cached !== undefined && cached.fingerprint === fingerprint) return { kind: 'ledger', ledger: cached.ledger }
    const read = this.readFile(name)
    if (read.kind === 'ledger') this.listed.set(name, { fingerprint, ledger: read.ledger })
    else this.listed.delete(name)
    return read
  }

  list(): readonly Ledger[] {
    const skipped: LedgerDiagnostic[] = []
    const found = new Map<string, Ledger>()
    let names: string[] = []
    if (existsSync(this.dir)) {
      try {
        names = readdirSync(this.dir).filter(name => name.endsWith('.json'))
      } catch {
        names = []
      }
    }
    for (const name of names) {
      const read = this.readListed(name)
      if (read.kind === 'ledger') found.set(read.ledger.sessionId, read.ledger)
      else if (read.kind === 'skipped') skipped.push({ where: name, reason: read.reason })
    }
    // Names gone from the directory must not linger in the memo: a recreated file
    // could otherwise be matched against an identity it no longer has.
    const present = new Set(names)
    for (const name of this.listed.keys()) if (!present.has(name)) this.listed.delete(name)
    // Rows only the legacy table holds stay listed (read-only) until their session is opened.
    // This branch is not memoised: the table can change under us and a row is cheap to read.
    if (this.legacy !== undefined) {
      let rows: Array<[string, unknown]> = []
      try { rows = [...this.legacy.entries()] } catch { rows = [] }
      for (const [key, value] of rows) {
        if (!isLedger(value) || value.sessionId !== key) {
          skipped.push({ where: `ledgers:${key}`, reason: 'not-a-ledger' })
          continue
        }
        if (!found.has(key) && !names.includes(ledgerFileName(key))) found.set(key, value)
      }
    }
    this.scanned = skipped
    return [...found.values()]
  }

  reload(_sessionId: string): void {
    // Reads already come from disk.
  }

  /** Copy a legacy domain row to its file, under the lock and only while the file is still absent. Best effort. */
  private migrate(row: Ledger): void {
    let release: (() => void) | undefined
    try {
      release = this.tryLock(row.sessionId)
      if (release === undefined) return // another writer is on it; the next read sees its file
      if (this.readFile(ledgerFileName(row.sessionId)).kind !== 'absent') return
      this.publish(row)
    } catch {
      // A failed copy leaves the row readable from the table; the next load tries again.
    } finally {
      release?.()
    }
  }

  /** Take `<id>.lock` by exclusive create, taking over a stale one. `undefined` when another writer holds it. */
  private tryLock(sessionId: string): (() => void) | undefined {
    mkdirSync(this.dir, { recursive: true })
    const lock = `${this.pathOf(sessionId)}.lock`
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(lock, 'wx')
        try { writeSync(fd, `${process.pid}\n${hostname()}\n`) } catch { /* an empty lock falls back to the age rule */ }
        closeSync(fd)
        return () => {
          try { unlinkSync(lock) } catch { /* already gone */ }
        }
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code
        // Windows refuses a create for a moment while another process holds or is deleting the file: busy.
        if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') return undefined
        if (code !== 'EEXIST') throw error
        let age: number
        try { age = Date.now() - statSync(lock).mtimeMs } catch { continue } // released meanwhile: try again
        if (age < STALE_LOCK_MS && !lockOwnerIsDead(lock)) return undefined
        // Rename away first: only one taker wins the rename, and a lock someone re-created meanwhile is not unlinked by name.
        const aside = `${lock}.${process.pid}.${randomUUID()}.stale`
        try { renameSync(lock, aside) } catch { continue } // someone else took it over first
        try { unlinkSync(aside) } catch { /* nothing to clean */ }
        // Fall through to our own exclusive create on the next attempt.
      }
    }
    return undefined
  }

  /** Atomic replace: temp file (not `*.json`, so a scan never reads it), then rename. Caller holds the lock. */
  private publish(ledger: Ledger): void {
    const path = this.pathOf(ledger.sessionId)
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
    try {
      renameWithRetry(tmp, path)
    } catch (error: unknown) {
      try { unlinkSync(tmp) } catch { /* nothing to clean */ }
      throw error
    }
    // Our own write is always visible to the next `list` at once, whatever the
    // fingerprint granularity of this filesystem turns out to be.
    this.listed.delete(ledgerFileName(ledger.sessionId))
  }

  async write(next: Ledger, expectedRevision: number): Promise<Ledger> {
    const sessionId = next.sessionId
    const deadline = Date.now() + this.lockWaitMs
    let release = this.tryLock(sessionId)
    while (release === undefined) {
      if (Date.now() >= deadline) {
        throw new AutopilotError(
          `ledger ${JSON.stringify(sessionId)}: another writer held the lock for more than ${this.lockWaitMs} ms`,
          AP_LEDGER_CONFLICT,
        )
      }
      await sleep(5 + Math.floor(Math.random() * 10))
      release = this.tryLock(sessionId)
    }
    try {
      // Inside the lock and synchronous: the revision read here is the one the rename replaces.
      const read = this.readFile(ledgerFileName(sessionId))
      if (read.kind === 'skipped') {
        // Unusable on disk (unparseable, newer version, unreadable): never publish over it.
        throw new AutopilotError(
          `ledger ${JSON.stringify(sessionId)}: the stored file cannot be used (${read.reason}); left untouched`,
          AP_STORE_CORRUPT,
        )
      }
      const actual =
        read.kind === 'ledger' ? read.ledger.revision
          : (this.legacyRow(sessionId)?.revision ?? 0)
      if (actual !== expectedRevision) throw conflict(sessionId, expectedRevision, actual)
      const stored: Ledger = { ...next, v: LEDGER_VERSION, revision: expectedRevision + 1, updatedAt: this.now() }
      this.publish(stored)
      return stored
    } finally {
      release()
    }
  }
}

/**
 * Where the frozen legacy reader finds pre-0.3.0 runs: the file root and/or a
 * domain facility. Either may be absent; the reader skips what is not there.
 */
export function legacySourcesOf(fileRoot: string | undefined, domain?: LegacyDomainReader): LegacySources {
  return {
    ...(fileRoot === undefined ? {} : { fileRoot }),
    ...(domain === undefined ? {} : { domain }),
  }
}
