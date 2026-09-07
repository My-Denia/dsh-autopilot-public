/**
 * ONE-OFF, ON-DEMAND: export domain-table runs into the file-store layout.
 *
 * WHY THIS EXISTS. `storeKind: 'auto'` picks the domain backend on any profile
 * that mounts `ctx.storageDomain` (the web-app bundle) and the file backend
 * everywhere else (headless). Both backends resolve the SAME run root, so one
 * machine running both profiles accumulated two canonical media that cannot see
 * each other — measured here 2026-08-27: 41 runs under `runs/` on disk and 5
 * runs in the `dsh_autopilot` domain tables. `cordis.patch.yml` now pins the
 * file backend so the split stops growing; this script is what carries the runs
 * already stranded on the other side across.
 *
 * WHY IT IS NOT WIRED INTO `apply()`, AND MUST NOT BE. A migration that runs at
 * mount is a write nobody asked for, performed at the least observable moment
 * in the process's life, against a medium another process may hold open. This
 * one is invoked by a human, prints what it would do, and only writes when told
 * to. `src/index.ts` does not import this module and nothing else does either;
 * it is reachable only by explicit path (`package.json` `exports` does not
 * publish a subpath for it), which is the correct amount of reachability for a
 * maintenance tool.
 *
 * WHY IT READS THE JSON MEDIUM DIRECTLY RATHER THAN OPENING A DOMAIN. Opening
 * `ctx.storageDomain` needs a live cordis host, and upstream `DomainFacility`
 * refuses a unit that is already open — i.e. the tool would fight the very
 * running dsh whose data it is exporting. The json backend's file is a plain
 * document (`{unit, global, tables: {events, runs}}`, read from
 * `$DSH_HOME/storages/dsh_autopilot.json`), so reading it is both simpler and
 * safe against a live process, because reading is all it does there.
 *
 * WHAT IT WILL NOT DO, by construction rather than by discipline:
 *   - it never deletes or rewrites a domain record: the domain file is opened
 *     read-only and the exported runs stay in it afterwards, so a failed
 *     migration costs nothing and can simply be run again;
 *   - it never overwrites a file-store run: a run id whose `events.jsonl`
 *     already exists is SKIPPED and reported, because two streams under one id
 *     is precisely the corruption the file store's single-writer rule exists to
 *     prevent, and a merge cannot be justified from either side alone;
 *   - it never writes anything it has not first replayed through the strict
 *     {@link foldRun}. A stream the fold rejects is reported and skipped: the
 *     file backend's whole contract is that what is on disk replays, and
 *     importing a stream that does not would move the corruption rather than
 *     the run.
 *
 * Usage, after `npm run build:host`:
 *   node lib/tools/migrate-domain-runs.js                # dry run, prints a plan
 *   node lib/tools/migrate-domain-runs.js --apply        # writes
 *   node lib/tools/migrate-domain-runs.js --domain <file> --root <dir> --apply
 *
 * @module dsh-autopilot/tools/migrate-domain-runs
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { foldRun } from '../domain/fold.js'
import { errorMessage } from '../domain/types.js'
import type { RunEvent, RunId, Snapshot } from '../domain/types.js'
import { defaultStoreRoot, runDirFor } from '../store/file.js'
import { parseEventKey } from '../store/domain.js'

/** The json backend's on-disk document, narrowed to what an export reads. */
export interface DomainDocument {
  readonly tables?: {
    readonly events?: Record<string, unknown>
    readonly runs?: Record<string, unknown>
  }
}

/** What happened to one run id. */
export interface MigrationEntry {
  readonly runId: RunId
  /**
   * `exported` — written (or, in a dry run, ready to be written).
   * `skipped-existing` — the file store already holds a stream for this id.
   * `skipped-no-events` — the `runs` projection has no events behind it.
   * `skipped-corrupt` — the stream did not survive the strict fold.
   */
  readonly outcome: 'exported' | 'skipped-existing' | 'skipped-no-events' | 'skipped-corrupt'
  /** Events found in the domain's `events` table for this id. */
  readonly eventCount: number
  /** The folded revision, when the stream folded at all. */
  readonly revision?: number
  /** Where it was written, or would be written. */
  readonly runDir: string
  /** Present only on `skipped-corrupt`: the fold's own message, unedited. */
  readonly problem?: string
}

/** The whole run's outcome. */
export interface MigrationReport {
  /** The domain document that was read. */
  readonly domainFile: string
  /** The file-store root that was (or would be) written. */
  readonly root: string
  /** False for a dry run — the default. */
  readonly applied: boolean
  readonly entries: readonly MigrationEntry[]
}

/** Options for {@link migrateDomainRuns}. */
export interface MigrateOptions {
  /** The json backend's document; defaults to `<storeRoot>/../dsh_autopilot.json`. */
  readonly domainFile?: string
  /** The file-store root; defaults to {@link defaultStoreRoot}. */
  readonly root?: string
  /** Write. Defaults to FALSE: the tool reports before it acts. */
  readonly apply?: boolean
}

/**
 * The domain document's default location.
 *
 * The two names differ on purpose and the difference is load-bearing: the run
 * directory root is `…/storages/dsh-autopilot` (the package name), while the
 * domain unit is `dsh_autopilot` because upstream `UNIT_NAME_RE` refuses a
 * hyphen in a name that doubles as a file name and a SQL identifier segment
 * (see `../store/domain.ts`). So the document is a SIBLING of the run root, not
 * a child of it.
 *
 * @param root - the file-store root.
 * @returns the default path of the json backend's document.
 */
export function defaultDomainFile(root: string = defaultStoreRoot()): string {
  return join(dirname(root), 'dsh_autopilot.json')
}

/**
 * Group one domain `events` table into per-run streams, in revision order.
 *
 * Every key is parsed, including keys belonging to other runs — a malformed key
 * is corruption of a shared table and {@link parseEventKey} raises it rather
 * than letting this tool export a gap-free-LOOKING prefix of a broken stream.
 * The sort is numeric on the parsed revision instead of lexical on the key, so
 * it does not silently depend on the key padding staying what it is today.
 *
 * @param events - the domain's `events` table.
 * @returns run id -> its events, ascending by revision.
 */
export function groupEvents(events: Record<string, unknown>): Map<RunId, RunEvent[]> {
  const byRun = new Map<RunId, Array<{ revision: number; event: RunEvent }>>()
  for (const [key, value] of Object.entries(events)) {
    const { runId, revision } = parseEventKey(key)
    const list = byRun.get(runId) ?? []
    list.push({ revision, event: value as RunEvent })
    byRun.set(runId, list)
  }
  const out = new Map<RunId, RunEvent[]>()
  for (const [runId, list] of byRun) {
    list.sort((a, b) => a.revision - b.revision)
    out.set(runId, list.map(item => item.event))
  }
  return out
}

/**
 * Export every domain-held run that the file store does not already have.
 *
 * @param options - see {@link MigrateOptions}; the default is a DRY RUN.
 * @returns what happened, per run id.
 * @throws when the domain document cannot be read or parsed — an unreadable
 * source is a fact the caller must see, not a reason to report zero runs.
 */
export function migrateDomainRuns(options: MigrateOptions = {}): MigrationReport {
  const root = options.root ?? defaultStoreRoot()
  const domainFile = options.domainFile ?? defaultDomainFile(root)
  const apply = options.apply === true

  const document = JSON.parse(readFileSync(domainFile, 'utf8')) as DomainDocument
  const streams = groupEvents(document.tables?.events ?? {})
  // The `runs` projection table is the enumeration authority (its key IS the
  // run id), but a stream with no projection is still a run, so the union is
  // what gets walked. Neither table alone is trusted to be complete.
  const ids = [...new Set([...Object.keys(document.tables?.runs ?? {}), ...streams.keys()])].sort()

  const entries: MigrationEntry[] = []
  for (const runId of ids) {
    const runDir = runDirFor(root, runId)
    const events = streams.get(runId) ?? []
    if (events.length === 0) {
      entries.push({ runId, outcome: 'skipped-no-events', eventCount: 0, runDir })
      continue
    }
    if (existsSync(join(runDir, 'events.jsonl'))) {
      entries.push({ runId, outcome: 'skipped-existing', eventCount: events.length, runDir })
      continue
    }
    let snapshot: Snapshot | undefined
    try {
      snapshot = foldRun(events).snapshot
    } catch (error: unknown) {
      entries.push({ runId, outcome: 'skipped-corrupt', eventCount: events.length, runDir, problem: errorMessage(error) })
      continue
    }
    if (snapshot === undefined) {
      entries.push({ runId, outcome: 'skipped-no-events', eventCount: events.length, runDir })
      continue
    }
    if (apply) writeRun(runDir, events, snapshot)
    entries.push({ runId, outcome: 'exported', eventCount: events.length, revision: snapshot.revision, runDir })
  }
  return { domainFile, root, applied: apply, entries }
}

/**
 * Write one exported run in the file store's own layout.
 *
 * The ORDER matches `RunStore.commit`: the canonical stream lands first and the
 * projection second, by tmp+rename. A crash between the two leaves a run whose
 * `snapshot.json` is missing — which `RunStore.load` does not care about (it
 * folds the stream) and `listRuns` reports as an omitted directory. The reverse
 * order would publish a projection for a stream that never arrived.
 */
function writeRun(runDir: string, events: readonly RunEvent[], snapshot: Snapshot): void {
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'events.jsonl'), events.map(event => `${JSON.stringify(event)}\n`).join(''), 'utf8')
  const tmp = join(runDir, 'snapshot.json.tmp')
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8')
  renameSync(tmp, join(runDir, 'snapshot.json'))
}

/**
 * Render the report the way a human reads it: one line per run, then a tally.
 *
 * @param report - the migration outcome.
 * @returns the printable text.
 */
export function formatReport(report: MigrationReport): string {
  const lines = [
    `domain document: ${report.domainFile}`,
    `file store root: ${report.root}`,
    report.applied ? 'mode: APPLY (files written)' : 'mode: DRY RUN (nothing written; pass --apply to write)',
    '',
  ]
  for (const entry of report.entries) {
    const detail = entry.outcome === 'exported'
      ? `revision ${String(entry.revision)}, ${entry.eventCount} event(s) -> ${entry.runDir}`
      : entry.outcome === 'skipped-corrupt'
        ? `${entry.eventCount} event(s); stream rejected by the strict fold: ${entry.problem ?? ''}`
        : entry.outcome === 'skipped-existing'
          ? `the file store already holds a stream at ${entry.runDir}`
          : 'the domain has a projection but no events for this id'
    lines.push(`  ${entry.outcome.padEnd(18)} ${entry.runId}  ${detail}`)
  }
  const tally = new Map<string, number>()
  for (const entry of report.entries) tally.set(entry.outcome, (tally.get(entry.outcome) ?? 0) + 1)
  lines.push('', [...tally].map(([outcome, count]) => `${outcome}: ${count}`).join(', ') || 'no runs found')
  return `${lines.join('\n')}\n`
}

/** Parse `--flag value` pairs plus the bare `--apply` switch. */
export function parseArgv(argv: readonly string[]): MigrateOptions {
  const options: { domainFile?: string; root?: string; apply?: boolean } = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--apply') options.apply = true
    else if (flag === '--domain' && argv[i + 1] !== undefined) { options.domainFile = argv[++i] }
    else if (flag === '--root' && argv[i + 1] !== undefined) { options.root = argv[++i] }
    else throw new Error(`migrate-domain-runs: unrecognized argument ${JSON.stringify(flag)}`)
  }
  return options
}

/**
 * CLI entry. Kept behind an explicit invocation check so importing this module
 * — which the test suite does — can never write to a real store.
 */
if (process.argv[1] !== undefined && process.argv[1].endsWith('migrate-domain-runs.js')) {
  try {
    process.stdout.write(formatReport(migrateDomainRuns(parseArgv(process.argv.slice(2)))))
  } catch (error: unknown) {
    process.stderr.write(`migrate-domain-runs: ${errorMessage(error)}\n`)
    process.exitCode = 1
  }
}
