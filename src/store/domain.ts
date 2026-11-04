/**
 * Domain declaration and the legacy-reader adapter over dsh's native domain data form (`ctx.storageDomain`).
 *
 * WHY a second backend rather than a replacement: the domain facility is
 * mounted by the web-app bundle only (measured 2026-08-24 against dsh
 * 0.1.1-rc.2, `packages/bundle/web-app/cordis.patch.yml:59`, `backend: json`).
 * The `headless` profile (`packages/bundle/headless/cordis.patch.yml`) has no `ctx.storageDomain`, so the file
 * store stays the fallback and the run records which one it got. See
 * `./ledger.ts` for the ledger store that uses it.
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
 * 0.3.0 CHANGE. The `ledgers` table holds the v3 per-session ledger (see
 * `./ledger.ts`); `events` and `runs` are the 0.2.x run streams, kept only so
 * the frozen legacy reader (`src/legacy`) can show them. Nothing here writes
 * them any more, so the run store classes, the event-key writers and the `log.md`
 * seam are gone. The legacy reader parses the `<runId>#<revision>` keys itself.
 */

import { AP_STORE_CORRUPT } from '../domain/refusals.js'
import { AutopilotError } from '../domain/types.js'
import type { LegacyDomainReader } from '../legacy/index.js'

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
        AP_STORE_CORRUPT,
      )
    }
    return value
  },
}

/** Table holding the canonical event stream of every run, keyed `<runId>#<12-digit revision>` (read-only; see `src/legacy`). */
export const EVENTS_TABLE = 'events'

/** Table holding the latest Snapshot projection per run, keyed by run id. */
export const RUNS_TABLE = 'runs'

/**
 * Table holding the v3 ledger per root session, keyed by session id.
 *
 * Added to the SAME domain at the SAME version: tables are additive, so a medium
 * written by 0.2.x opens unchanged and simply starts with an empty `ledgers`
 * table. The `events` and `runs` tables are the legacy 0.2.x runs, now read-only
 * through `src/legacy`.
 */
export const LEDGERS_TABLE = 'ledgers'

/**
 * The autopilot's domain declaration.
 *
 * The name is `dsh_autopilot`, NOT `dsh-autopilot`: upstream validates domain
 * and table names against `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`
 * (`packages/storage/storage/src/backend.ts:10`) because the name doubles as a
 * file name and a SQL identifier segment, so a hyphen is refused. WHERE it is
 * refused matters and was stated wrongly here: `DomainLedgerStore.open`
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
    [LEDGERS_TABLE]: { valueSchema: recordShape },
  },
}

/**
 * Adapt an open domain to the frozen legacy reader: every stored record of one
 * table as `{ key, value }`. Only `events` is ever asked for. A table the domain
 * does not declare reads as empty.
 */
export function legacyDomainReaderOf(domain: DomainLike): LegacyDomainReader {
  return {
    async list(table: string) {
      let handle: KvTableLike
      try {
        handle = domain.table(table)
      } catch {
        return []
      }
      return [...handle.entries()].map(([key, value]) => ({ key, value }))
    },
  }
}
