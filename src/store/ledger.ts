/**
 * The v3 ledger store: one small JSON document per root session.
 *
 * WHAT IT HOLDS. Execution, cancel, resume and history display (see
 * `../domain/ledger-types.ts`). It is not an approval record and nothing reads
 * it as a gate, so the store is deliberately plain: a compare-and-swap on a
 * revision counter and an atomic whole-document replace. There is no event
 * stream and no fold.
 *
 * TWO BACKENDS, same contract. `file` writes `<root>/ledgers/<id>.json` via
 * tmp+rename; `domain` keeps a `ledgers` table on the autopilot domain of
 * `ctx.storageDomain`. `load` and `list` are synchronous reads from an
 * in-memory cache filled when the store opens (the domain facility has already
 * materialized its records by then; the file store reads the directory once).
 *
 * A DOCUMENT THAT CANNOT BE USED NEVER FAILS THE MOUNT. A file that does not
 * parse, or a record that is not a v3 ledger, is skipped and reported through
 * `diagnostics` (file name or key plus a reason code, no stored text), so one
 * damaged ledger costs that session's history display and nothing else. It is
 * left in place, untouched.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LEDGER_VERSION } from '../domain/ledger-types.js'
import type { Ledger } from '../domain/ledger-types.js'
import { AP_LEDGER_CONFLICT } from '../domain/refusals.js'
import { AutopilotError } from '../domain/types.js'
import type { LegacyDomainReader, LegacySources } from '../legacy/index.js'
import { AUTOPILOT_DOMAIN_SPEC, LEDGERS_TABLE } from './domain.js'
import type { DomainFacilityLike, DomainLike, DomainSpecLike, KvTableLike } from './domain.js'

export { AP_LEDGER_CONFLICT }

/** Why a stored ledger was skipped. A code, never stored text. */
export interface LedgerDiagnostic {
  /** File name (file backend) or table key (domain backend). */
  readonly where: string
  readonly reason: 'unparseable' | 'not-a-ledger'
}

/** What the engine and the read-only service depend on. */
export interface LedgerStoreLike {
  /** Which backend this is, recorded rather than assumed. */
  readonly kind: 'file' | 'domain'
  /** The cached ledger for a root session, or `undefined` when it has none. */
  load(sessionId: string): Ledger | undefined
  /** Every cached ledger, unordered. */
  list(): readonly Ledger[]
  /**
   * Compare-and-swap write. Stores `next` with `revision = expectedRevision + 1`
   * and a fresh `updatedAt`, and resolves with the stored ledger. A session with
   * no ledger has revision 0.
   * @throws AutopilotError `AP_LEDGER_CONFLICT` when the stored revision differs.
   */
  write(next: Ledger, expectedRevision: number): Promise<Ledger>
  /**
   * Re-read one session's document from the medium into the cache, for a store
   * another process can write. Called after a CAS conflict so the retry sees the
   * other writer's revision. Optional: a single-process backend has nothing to re-read.
   */
  reload?(sessionId: string): void
  /** Documents skipped when the store opened. */
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

/** Options shared by both backends. */
export interface LedgerStoreOptions {
  /** ISO-8601 clock; tests inject one. */
  readonly now?: () => string
}

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

/** File-backed ledger store under `<root>/ledgers/`. */
export class FileLedgerStore implements LedgerStoreLike {
  readonly kind = 'file' as const
  readonly diagnostics: readonly LedgerDiagnostic[]
  private readonly cache = new Map<string, Ledger>()
  private readonly now: () => string

  private constructor(private readonly root: string, options: LedgerStoreOptions) {
    this.now = options.now ?? isoNow
    const skipped: LedgerDiagnostic[] = []
    const dir = join(root, 'ledgers')
    let names: string[] = []
    if (existsSync(dir)) {
      try {
        names = readdirSync(dir).filter(name => name.endsWith('.json'))
      } catch {
        names = []
      }
    }
    for (const name of names) {
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      } catch {
        skipped.push({ where: name, reason: 'unparseable' })
        continue
      }
      // A file whose own sessionId does not map back to its name is not ours to trust.
      if (!isLedger(parsed) || ledgerFileName(parsed.sessionId) !== name) {
        skipped.push({ where: name, reason: 'not-a-ledger' })
        continue
      }
      this.cache.set(parsed.sessionId, parsed)
    }
    this.diagnostics = skipped
  }

  /** Read the directory once and return the store. Never throws on a damaged ledger. */
  static open(root: string, options: LedgerStoreOptions = {}): FileLedgerStore {
    return new FileLedgerStore(root, options)
  }

  load(sessionId: string): Ledger | undefined {
    return this.cache.get(sessionId)
  }

  list(): readonly Ledger[] {
    return [...this.cache.values()]
  }

  reload(sessionId: string): void {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(this.root, 'ledgers', ledgerFileName(sessionId)), 'utf8'))
      if (isLedger(parsed) && parsed.sessionId === sessionId) this.cache.set(sessionId, parsed)
    } catch {
      // Missing or unreadable: keep what this process holds.
    }
  }

  /** The revision on disk right now, so a second process is seen; falls back to the cache. */
  private storedRevision(sessionId: string): number {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(this.root, 'ledgers', ledgerFileName(sessionId)), 'utf8'))
      if (isLedger(parsed)) return parsed.revision
    } catch {
      // Missing or unreadable: fall through to what this process holds.
    }
    return this.cache.get(sessionId)?.revision ?? 0
  }

  async write(next: Ledger, expectedRevision: number): Promise<Ledger> {
    // Everything from the check to the rename is synchronous, so nothing in this
    // process can interleave between them.
    const actual = this.storedRevision(next.sessionId)
    if (actual !== expectedRevision) throw conflict(next.sessionId, expectedRevision, actual)
    const stored: Ledger = { ...next, v: LEDGER_VERSION, revision: expectedRevision + 1, updatedAt: this.now() }
    const dir = join(this.root, 'ledgers')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, ledgerFileName(next.sessionId))
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
    this.cache.set(stored.sessionId, stored)
    return stored
  }
}

/** Ledger store over the `ledgers` table of the autopilot domain. */
export class DomainLedgerStore implements LedgerStoreLike {
  readonly kind = 'domain' as const
  readonly diagnostics: readonly LedgerDiagnostic[]
  private readonly cache = new Map<string, Ledger>()
  private readonly now: () => string
  /** Serializes writes: the domain `put` is asynchronous, so check-then-put needs a lane. */
  private lane: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly domain: DomainLike,
    private readonly table: KvTableLike,
    options: LedgerStoreOptions,
  ) {
    this.now = options.now ?? isoNow
    const skipped: LedgerDiagnostic[] = []
    for (const [key, value] of this.table.entries()) {
      if (!isLedger(value) || value.sessionId !== key) {
        skipped.push({ where: key, reason: 'not-a-ledger' })
        continue
      }
      this.cache.set(key, value)
    }
    this.diagnostics = skipped
  }

  /**
   * Open the autopilot domain and bind its `ledgers` table. The caller owns the
   * returned store and must {@link close} it.
   */
  static async open(
    facility: DomainFacilityLike,
    spec: DomainSpecLike = AUTOPILOT_DOMAIN_SPEC,
    options: LedgerStoreOptions = {},
  ): Promise<DomainLedgerStore> {
    return DomainLedgerStore.fromDomain(await facility.open(spec), options)
  }

  /**
   * Bind the `ledgers` table of a domain the caller already opened. The facility
   * refuses a name that is open twice, so the plugin opens the domain ONCE and
   * hands the same handle to this store and to the legacy reader.
   */
  static fromDomain(domain: DomainLike, options: LedgerStoreOptions = {}): DomainLedgerStore {
    return new DomainLedgerStore(domain, domain.table(LEDGERS_TABLE), options)
  }

  async close(): Promise<void> {
    await this.domain.close()
  }

  load(sessionId: string): Ledger | undefined {
    return this.cache.get(sessionId)
  }

  list(): readonly Ledger[] {
    return [...this.cache.values()]
  }

  write(next: Ledger, expectedRevision: number): Promise<Ledger> {
    const run = async (): Promise<Ledger> => {
      const actual = this.cache.get(next.sessionId)?.revision ?? 0
      if (actual !== expectedRevision) throw conflict(next.sessionId, expectedRevision, actual)
      const stored: Ledger = { ...next, v: LEDGER_VERSION, revision: expectedRevision + 1, updatedAt: this.now() }
      await this.table.put(stored.sessionId, stored)
      this.cache.set(stored.sessionId, stored)
      return stored
    }
    const result = this.lane.then(run)
    this.lane = result.catch(() => undefined)
    return result
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
