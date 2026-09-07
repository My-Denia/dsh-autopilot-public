/**
 * Run store backed by dsh's native domain data form (`ctx.storageDomain`).
 *
 * WHY a second backend rather than a replacement: the domain facility is
 * mounted by the web-app bundle only (measured 2026-08-24 against dsh
 * 0.1.1-rc.2, `packages/bundle/web-app/cordis.patch.yml:59`, `backend: json`).
 * The `headless` profile (`packages/bundle/headless/cordis.patch.yml`) has no `ctx.storageDomain`, so the file
 * store stays the fallback and the run records which one it got. See
 * `./types.ts` for the seam's rationale.
 *
 * WHY structural types and no import of `@deepseek-ai/dsh-storage-domain`:
 * this package's standing rule (DESIGN.md §1) is that a second physical copy of
 * a dsh SERVICE package would give the plugin a different class identity than
 * the host's, so every dsh service surface is reached through `ctx` plus a LOCAL
 * structural subset of the shape actually used. (Corrected 2026-08-25: this used
 * to say "its only runtime dependency is `@deepseek-ai/dsh-tools`; every other
 * dsh surface is reached through `ctx`" — both halves of a sentence §1 retracts
 * as false, since `src/config.ts` statically imports `@deepseek-ai/schemastery`
 * as a value. The rule that survives is the class-identity one.)
 *
 * HONEST DEVIATION, recorded rather than hidden: upstream types a table's
 * `valueSchema` as a zod `ZodType`. `zod` is NOT a dependency of this package
 * and could not be installed offline, so {@link AUTOPILOT_DOMAIN_SPEC} carries
 * a structural {@link DomainRecordSchema} instead. That is runtime-compatible
 * with the facility as measured: for a spec that declares tables and no
 * `global`, the ONLY schema method `DomainFacility.open` ever invokes is
 * `valueSchema.parse(raw)` (`storage-domain/src/index.ts`, `parseRecord`);
 * `safeParse` is reached only through `defineDomain`'s global-nullability
 * guard, and this spec declares no global. If a future dsh version exercises
 * more of the zod surface, the fix is to add `zod` and swap one constant.
 *
 * WHY `log.md` still goes to the filesystem: the domain stores JSON records,
 * not an appendable markdown artifact, and `UsageArtifact.ref` and
 * `OutboundManifest` artifact refs resolve against {@link
 * DomainRunStore.runDir}. Moving that directory when the EVENT backend changes
 * would silently invalidate every recorded artifact ref, so the run directory
 * keeps the same path under both backends and only the canonical stream moves.
 * That sameness is now STRUCTURAL: both backends call the single exported
 * `runDirFor` in `./file.js` instead of each keeping a private copy of the
 * id-sanitizing rule (corrected 2026-08-25 — the copies were identical by
 * habit and nothing could observe them drifting apart).
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { foldRun } from '../domain/fold.js'
import { AutopilotError } from '../domain/types.js'
import type { LogEntry, Operation, RunEvent, RunId, Snapshot, StoreKind } from '../domain/types.js'
import { defaultStoreRoot, runDirFor } from './file.js'
import type { RunStoreLike } from './types.js'

/**
 * Structural subset of a record schema. Upstream this is a zod `ZodType`;
 * `parse` is the whole surface the facility uses per stored record.
 */
export interface DomainRecordSchema<V = unknown> {
  /** Validate one stored record at the durable read boundary; throw to reject it. */
  parse(value: unknown): V
}

/** Structural subset of one table declaration inside a domain spec. */
export interface DomainTableSpecLike<V = unknown> {
  /** Validates every stored record of this table when the domain is opened. */
  readonly valueSchema: DomainRecordSchema<V>
}

/** Structural subset of a domain declaration (upstream `DomainSpec`). */
export interface DomainSpecLike {
  /** Domain name; also the backend unit name, so it must match upstream `UNIT_NAME_RE`. */
  readonly name: string
  /** Domain format version; a medium stamped with a different version rejects at open. */
  readonly version: number
  /** Table declarations keyed by table name. */
  readonly tables: Readonly<Record<string, DomainTableSpecLike>>
}

/**
 * Structural subset of an open table handle. Reads are synchronous from the
 * facility's in-memory state; writes queue on the domain's per-domain write
 * chain and resolve only after durability.
 */
export interface KvTableLike<V = unknown> {
  /** Read one record synchronously, or `undefined` when absent. */
  get(key: string): V | undefined
  /** Snapshot iterator over `[key, record]` pairs. */
  entries(): IterableIterator<[string, V]>
  /** Snapshot iterator over keys. */
  keys(): IterableIterator<string>
  /** Insert or overwrite one record durably. */
  put(key: string, value: V): Promise<void>
}

/** Structural subset of an open domain handle. */
export interface DomainLike {
  /** Resolve one declared table handle; handles are stable across calls. */
  table(name: string): KvTableLike
  /** Drain queued writes and release the backend unit. The CALLER owns this call. */
  close(): Promise<void>
}

/** Structural subset of `ctx.storageDomain`. */
export interface DomainFacilityLike {
  /** Open one declared domain over its routed backend. */
  open(spec: DomainSpecLike): Promise<DomainLike>
}

/**
 * Permissive record schema: accept any non-null object, reject anything else.
 *
 * DELIBERATELY not a transcription of `Snapshot`/`RunEvent`. The strict
 * invariant guardian is `applyEvent` (through `foldRun`), which validates each
 * transition against its committed prefix — a job no per-record schema can do,
 * because a schema cannot see the prior event. Restating the Snapshot shape
 * here would create a SECOND source of truth that drifts out of step with
 * `domain/types.ts` on the first optional field added, and would reject the
 * legacy v1 records the fold is required to keep replaying. The schema's job
 * is only to stop non-records (a string, a number, `null`) from reaching the
 * fold dressed as events.
 */
const recordShape: DomainRecordSchema = {
  parse(value: unknown): unknown {
    if (value === null || typeof value !== 'object') {
      throw new AutopilotError(
        `domain record must be an object, got ${value === null ? 'null' : typeof value}`,
        'AP_STORE_CORRUPT',
      )
    }
    return value
  },
}

/** Table holding the canonical event stream of every run, keyed by {@link eventKey}. */
export const EVENTS_TABLE = 'events'

/** Table holding the latest Snapshot projection per run, keyed by run id. */
export const RUNS_TABLE = 'runs'

/**
 * Fixed decimal width of the revision segment in an event key.
 *
 * THE RELATION, stated the way it actually holds. The domain guarantees NO key
 * order at all — `KvTableImpl.keys()` hands back Map insertion order — so the
 * padding is not there to fix the medium. `DomainRunStore.load` performs its
 * OWN `keys.sort()`, and the fold requires events in revision order; padding to
 * a FIXED decimal width is what makes that lexical sort equal numeric order.
 * Unpadded, `'#10'` sorts before `'#2'` and the fold would reject a legal
 * stream as non-monotonic.
 *
 * This block previously said "domain key order is LEXICAL", which is a claim
 * about the medium rather than about `load`. A reader who believed it could
 * delete the sort in `load` as redundant and get insertion order instead — the
 * comment on that sort line already states the true relation, and now so does
 * this one.
 *
 * The width sits far above any reachable run length, and {@link eventKey}
 * refuses to build a key that would overflow it rather than emitting one that
 * silently misorders.
 */
export const REVISION_KEY_WIDTH = 12

/**
 * The autopilot's domain declaration.
 *
 * The name is `dsh_autopilot`, NOT `dsh-autopilot`: upstream validates domain
 * and table names against `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`
 * (`packages/storage/storage/src/backend.ts:10`) because the name doubles as a
 * file name and a SQL identifier segment, so a hyphen is refused. WHERE it is
 * refused matters and was stated wrongly here: {@link DomainRunStore.open}
 * calls `facility.open(spec)` DIRECTLY and never calls `defineDomain`, so the
 * enforcement site is the backend's own check at `KvFacet.open`, not
 * `defineDomain`. Bypassing `defineDomain` also skips its version guard and its
 * global-nullability guard — deliberate, because this spec declares no global
 * and its version is a literal in the constant below, and recorded here rather
 * than left to be discovered.
 *
 * The package, the plugin id and the store root keep their hyphenated names;
 * only the medium-facing identifier is underscored.
 */
export const AUTOPILOT_DOMAIN_SPEC: DomainSpecLike = {
  name: 'dsh_autopilot',
  version: 1,
  tables: {
    [EVENTS_TABLE]: { valueSchema: recordShape },
    [RUNS_TABLE]: { valueSchema: recordShape },
  },
}

/**
 * Build the events-table key for one revision of one run.
 * @throws AutopilotError when the revision cannot be padded to
 * {@link REVISION_KEY_WIDTH} without losing the ordering guarantee.
 */
export function eventKey(runId: RunId, revision: number): string {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new AutopilotError(`event revision must be a positive integer, got ${revision}`, 'AP_STORE_KEY')
  }
  const digits = String(revision)
  if (digits.length > REVISION_KEY_WIDTH) {
    throw new AutopilotError(
      `revision ${revision} exceeds the ${REVISION_KEY_WIDTH}-digit key width; keys would stop sorting by revision`,
      'AP_STORE_KEY',
    )
  }
  return `${runId}#${digits.padStart(REVISION_KEY_WIDTH, '0')}`
}

/** One parsed events-table key. */
export interface ParsedEventKey {
  /** Run the event belongs to. */
  readonly runId: RunId
  /** Revision the event carries. */
  readonly revision: number
}

/**
 * Parse an events-table key back into its run id and revision.
 *
 * A key that does not parse is store corruption and is raised loudly: skipping
 * it would drop an event out of a canonical stream and let the fold accept a
 * gap-free-LOOKING prefix of a broken run. The run id is taken from the LAST
 * `#`, so a run id that itself contains `#` still round-trips.
 */
export function parseEventKey(key: string): ParsedEventKey {
  const cut = key.lastIndexOf('#')
  const digits = cut < 0 ? '' : key.slice(cut + 1)
  if (cut < 1 || digits.length !== REVISION_KEY_WIDTH || !/^[0-9]+$/.test(digits)) {
    throw new AutopilotError(
      `events table holds a key that is not '<runId>#<${REVISION_KEY_WIDTH}-digit revision>': ${JSON.stringify(key)}`,
      'AP_STORE_CORRUPT',
    )
  }
  const revision = Number(digits)
  if (revision < 1) {
    throw new AutopilotError(`event key carries a non-positive revision: ${JSON.stringify(key)}`, 'AP_STORE_CORRUPT')
  }
  return { runId: key.slice(0, cut), revision }
}

/** Narrow one stored record to a RunEvent, or fail loudly naming its key. */
function asRunEvent(key: string, raw: unknown): RunEvent {
  if (raw === null || typeof raw !== 'object') {
    throw new AutopilotError(`events record ${JSON.stringify(key)} is not an object`, 'AP_STORE_CORRUPT')
  }
  const record = raw as { v?: unknown; op?: unknown; revision?: unknown; snapshot?: unknown }
  if (record.v !== 1) {
    throw new AutopilotError(
      `events record ${JSON.stringify(key)} has unsupported version ${String(record.v)}`,
      'AP_STORE_CORRUPT',
    )
  }
  if (typeof record.op !== 'string' || typeof record.revision !== 'number') {
    throw new AutopilotError(`events record ${JSON.stringify(key)} is missing op/revision`, 'AP_STORE_CORRUPT')
  }
  if (record.snapshot === null || typeof record.snapshot !== 'object') {
    throw new AutopilotError(`events record ${JSON.stringify(key)} carries no snapshot`, 'AP_STORE_CORRUPT')
  }
  return raw as RunEvent
}

/** Options for {@link DomainRunStore.open}. */
export interface DomainRunStoreOptions {
  /** Root of the run directories that hold `log.md` and artifacts; defaults to the file store's root so both backends agree on artifact paths. */
  readonly root?: string
}

/**
 * Run store over an open `ctx.storageDomain` domain.
 *
 * The canonical stream lives in the `events` table and is replayed through the
 * SAME strict `foldRun` the file backend uses, so changing the medium does not
 * cost the run its invariant guardian.
 */
export class DomainRunStore implements RunStoreLike {
  /** Recorded into `Enforcement.store`; never inferred by the engine. */
  readonly kind: StoreKind = 'domain'

  private constructor(
    private readonly domain: DomainLike,
    private readonly events: KvTableLike,
    private readonly runs: KvTableLike,
    private readonly root: string,
  ) {}

  /**
   * Open the autopilot domain and bind its tables.
   *
   * Opening IS the preload: the facility validates and materializes every
   * stored record before it resolves, which is what lets {@link load} stay
   * synchronous.
   * @param facility - `ctx.storageDomain`.
   * @param spec - Domain declaration; defaults to {@link AUTOPILOT_DOMAIN_SPEC}.
   * @param options - Run-directory root override.
   * @returns the opened store; the caller owns it and must {@link close} it.
   */
  static async open(
    facility: DomainFacilityLike,
    spec: DomainSpecLike = AUTOPILOT_DOMAIN_SPEC,
    options: DomainRunStoreOptions = {},
  ): Promise<DomainRunStore> {
    const domain = await facility.open(spec)
    return new DomainRunStore(
      domain,
      domain.table(EVENTS_TABLE),
      domain.table(RUNS_TABLE),
      options.root ?? defaultStoreRoot(),
    )
  }

  /**
   * Release the domain handle. The facility hands ownership to the caller, so
   * whoever opened the store disposes it; the facility only closes leftovers
   * when it unmounts.
   */
  async close(): Promise<void> {
    await this.domain.close()
  }

  /**
   * The run directory, computed by the SHARED {@link runDirFor} rather than by
   * a local copy of the file store's rule. This module's header states that
   * both backends must resolve one run id to the SAME directory; a second copy
   * of the path rule could only be held to that by a test, so the copy is gone.
   */
  runDir(runId: RunId): string {
    return runDirFor(this.root, runId)
  }

  /**
   * Enumerate run ids from the `runs` projection table, whose key IS the run id
   * (unlike the file backend, whose directory name is a lossy sanitization).
   * The table is loaded into memory when the domain opens, so this needs no
   * I/O — but it is still a STORE question, not a cache question: it answers
   * for every run the medium holds, including runs this process never touched.
   */
  listRuns(): readonly RunId[] {
    return [...this.runs.keys()]
  }

  /**
   * Replay one run from the `events` table.
   *
   * EVERY key in the table is parsed, including keys of other runs: a
   * malformed key is corruption of a shared stream and must be loud even when
   * it does not belong to the run being loaded. Well-formed keys of OTHER runs
   * are skipped — that is the table's normal multi-run layout, not an anomaly.
   */
  load(runId: RunId): Snapshot | undefined {
    const keys: string[] = []
    for (const key of this.events.keys()) {
      if (parseEventKey(key).runId === runId) keys.push(key)
    }
    // Lexical sort equals revision order only because REVISION_KEY_WIDTH pads it to.
    keys.sort()
    const events: RunEvent[] = []
    for (const key of keys) {
      const event = asRunEvent(key, this.events.get(key))
      const { revision } = parseEventKey(key)
      if (event.revision !== revision) {
        throw new AutopilotError(
          `events record ${JSON.stringify(key)} carries revision ${event.revision}, contradicting its key`,
          'AP_STORE_CORRUPT',
        )
      }
      events.push(event)
    }
    return foldRun(events).snapshot
  }

  /**
   * Persist one already-validated transition.
   *
   * ORDER IS LOAD-BEARING: the canonical event lands BEFORE the `runs`
   * projection. A crash between the two leaves the projection one revision
   * stale, which the next `load` corrects by replaying the stream — the
   * projection is derived and disposable. The reverse order could publish a
   * projection for an event that never became durable: a state no replay can
   * justify, and one that makes `runs` disagree with the only authority.
   */
  async commit(runId: RunId, op: Operation, snapshot: Snapshot, detail?: unknown): Promise<RunEvent> {
    const event: RunEvent = {
      v: 1,
      op,
      revision: snapshot.revision,
      time: new Date().toISOString(),
      snapshot,
      ...(detail === undefined ? {} : { detail }),
    }
    await this.events.put(eventKey(runId, snapshot.revision), event)
    await this.runs.put(runId, snapshot)
    return event
  }

  /** Append one checkpoint line to the run's `log.md` (the filesystem seam; see the module header). */
  async appendLog(runId: RunId, entry: LogEntry): Promise<void> {
    const dir = this.runDir(runId)
    await mkdir(dir, { recursive: true })
    const suffix = [
      entry.note !== undefined ? ` note: ${entry.note}` : '',
      entry.escalationTarget !== undefined ? ` -> ${entry.escalationTarget}` : '',
      entry.blockingScope !== undefined ? ` (blocks: ${entry.blockingScope})` : '',
    ].join('')
    await appendFile(
      join(dir, 'log.md'),
      `- [${new Date().toISOString()}] [${entry.stance}] ${entry.text}${suffix}\n`,
      'utf8',
    )
  }
}
