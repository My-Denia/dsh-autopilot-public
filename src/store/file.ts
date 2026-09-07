/**
 * File-backed run store under $DSH_HOME/storages/dsh-autopilot.
 *
 * WHY files and not Session events: dsh's durable Session event vocabulary is
 * closed to out-of-tree plugins today (KNOWN_SESSION_EVENT_TYPES; the
 * registration surface is explicitly deferred upstream). Appending unknown
 * event types would risk refusing session reconstruction on resume. Until dsh
 * opens that surface, run state lives beside the session — events.jsonl is
 * canonical (event-sourced, strictly folded on load), snapshot.json and
 * log.md are human/UI projections. This mirrors the CC harness's proven
 * goal-runs/<slug>/ artifact model.
 *
 * WHY this file moved under `src/store/` in v2: it is now ONE implementation
 * of {@link RunStoreLike}, not the only possible persistence. The other is
 * `./domain.ts` over `ctx.storageDomain`; the engine depends on the interface
 * and the run RECORDS which backend it actually got (`Enforcement.store`).
 *
 * Single-writer: only the engine writes here, and the engine serializes
 * mutations per run. Two dsh processes sharing one run is out of contract
 * (same as CC state.json) and is surfaced by fold failures rather than hidden.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { foldRun } from '../domain/fold.js'
import { AutopilotError, errorMessage } from '../domain/types.js'
import type { LogEntry, Operation, RunEvent, RunId, Snapshot, StoreKind } from '../domain/types.js'
import type { RunStoreLike } from './types.js'

/**
 * Resolve the store root: $DSH_AUTOPILOT_HOME, else $DSH_HOME/storages/dsh-autopilot,
 * else ~/.dsh/storages/dsh-autopilot.
 *
 * PRECEDENCE IS THE POINT: the explicit override wins over `DSH_HOME`, never
 * the other way round. An operator who redirects run state to a scratch disk
 * sets `DSH_AUTOPILOT_HOME` on a machine where `DSH_HOME` is already set (that
 * is the normal dsh installation), so a rule that let `DSH_HOME` win would
 * silently ignore the override and split reads from writes.
 *
 * A BLANK value is treated as unset, not as a root. `DSH_AUTOPILOT_HOME=''` is
 * the ordinary result of an unset variable in a shell wrapper or a CI matrix;
 * accepting it would make the root the empty string and scatter `runs/<id>`
 * across whatever the process cwd happens to be. The blank test is `trim()`-aware
 * to match this codebase's sibling rule for env overrides
 * (`outbound/manifest.ts` `manifestPath`), which already treats a
 * whitespace-only value as absent.
 *
 * TILDE EXPANSION AND `resolve`, ADDED 2026-08-27 BECAUSE THE DIVERGENCE WAS
 * MEASURED. dsh's own `resolveDshHome`
 * (`packages/util/home-paths/src/index.ts`) ends in
 * `resolve(expandHomePath(selected))`; this function used to return `DSH_HOME`
 * RAW. So on a machine whose `DSH_HOME` is spelled `~/.dsh` — a spelling dsh
 * itself accepts — the host resolved its storages under the real home while
 * this plugin resolved them under a LITERAL `~` directory beside the process
 * cwd, and the two halves of one deployment would write to different trees
 * while both reported "the default root". Performing the host's two steps in
 * the host's order is what makes the paths provably the same rather than the
 * same by habit.
 *
 * `resolve` is the second half and is not decoration: it pins the root at
 * RESOLUTION time. Without it a relative override stays relative and the store
 * follows `process.cwd()` around, so a later `process.chdir` (or a host that
 * launches the plugin from a different directory than it serves from) would
 * split reads from writes exactly the way the precedence rule above exists to
 * prevent.
 */
export function defaultStoreRoot(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.DSH_AUTOPILOT_HOME
  if (explicit !== undefined && explicit.trim().length > 0) return resolve(expandHomePath(explicit))
  const dshHome = env.DSH_HOME !== undefined && env.DSH_HOME.trim().length > 0 ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(resolve(expandHomePath(dshHome)), 'storages', 'dsh-autopilot')
}

/**
 * Expand the tilde prefixes dsh accepts, and ONLY those.
 *
 * A mirror of `expandHomePath` in `@deepseek-ai/dsh-home-paths` (read from
 * source 2026-08-27): `~` alone is the home; `~/` and `~\` are the home plus
 * the remainder; anything else is returned untouched — including a `~` that is
 * not the first character, and `~user`, because per-user tilde expansion is a
 * SHELL feature that no Node API implements and guessing at it would invent a
 * home directory that does not exist.
 *
 * Mirrored rather than imported for the standing reason (DESIGN.md §1): a
 * runtime dependency on a dsh package bought for one path computation is a
 * worse trade than a copy small enough for a test to hold to its original.
 *
 * @param path - a configured or environment-supplied path.
 * @returns the path with a supported tilde prefix expanded.
 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Keep run ids filesystem-safe WITHOUT losing uniqueness.
 *
 * The one-character-per-character mapping is load-bearing: collapsing runs of
 * unsafe characters (`/[^…]+/g`) would map `a/b` and `a//b` onto the same
 * directory, and two runs sharing one directory interleave their
 * `events.jsonl` streams, collide on `snapshot.json`, `log.md`, usage
 * artifacts and the outbound manifest. Injectivity, not just safety, is what
 * this function owes its callers.
 */
function sanitize(runId: RunId): string {
  return runId.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/**
 * THE run-directory rule, shared by every backend.
 *
 * WHY this is one exported function and not a private copy per store: the run
 * directory is where `log.md`, `UsageArtifact.ref` containment and the
 * outbound manifest all resolve, and `store/domain.ts` states as a module
 * invariant that both backends must compute the SAME path for one run id.
 * Two copies of an identical function can only be held together by a test,
 * and a test can only sample the input space — an id shape outside the table
 * diverges unobserved. One implementation makes divergence structurally
 * impossible instead of merely unmeasured, which is the standing preference
 * of DESIGN.md §2 (纪律 -> 结构性不可能).
 *
 * It lives beside {@link defaultStoreRoot} because that function is already
 * the shared owner of the ROOT half of the same path, and `store/domain.ts`
 * already imports from here.
 */
export function runDirFor(root: string, runId: RunId): string {
  return join(root, 'runs', sanitize(runId))
}

/** Durable store for run event streams and their projections. */
export class RunStore implements RunStoreLike {
  /** Recorded into `Enforcement.store`; never inferred by the engine. */
  readonly kind: StoreKind = 'file'

  constructor(private readonly root: string) {}

  runDir(runId: RunId): string {
    return runDirFor(this.root, runId)
  }

  /**
   * Enumerate run ids from the DIRECTORY TREE, not from anything this process
   * remembers. The directory NAME cannot be trusted as the id: `sanitize`
   * maps every character outside `[a-zA-Z0-9._-]` to `_`, which is lossy and
   * not invertible. So each run's own `snapshot.json` is read for its
   * authoritative `runId`. A directory whose projection is missing or
   * unreadable is OMITTED rather than reported under its mangled path — a
   * guessed id would be worse than an absent one, because callers would use it
   * to `load()` and get nothing.
   */
  listRuns(): readonly RunId[] {
    const runsRoot = join(this.root, 'runs')
    if (!existsSync(runsRoot)) return []
    let entries: string[]
    try {
      entries = readdirSync(runsRoot)
    } catch {
      return []
    }
    const ids: RunId[] = []
    for (const entry of entries) {
      try {
        const raw = readFileSync(join(runsRoot, entry, 'snapshot.json'), 'utf8')
        const parsed = JSON.parse(raw) as { runId?: unknown }
        if (typeof parsed.runId === 'string' && parsed.runId.length > 0) ids.push(parsed.runId)
      } catch {
        // Unreadable or not a run directory: omit it. See the doc comment.
      }
    }
    return ids
  }

  /**
   * The revision the BACKING STORE currently holds for one run, WITHOUT
   * folding its stream.
   *
   * WHY THIS EXISTS: `AutopilotEngine` memoizes a folded snapshot per run id,
   * and a process that is only READING a run (the web profile serving
   * `/api/autopilot/run?id=`) would otherwise serve its first observation
   * forever while another process advanced the run on disk. Measured on this
   * machine 2026-08-25: 41 file-backed runs and 5 domain-table runs, mutually
   * invisible, with the read path pinned to whatever revision it happened to
   * load first. A cheap revision probe lets the read path notice it is behind
   * without paying a full fold on every GET.
   *
   * WHY `snapshot.json` AND NOT `events.jsonl`'s mtime: `commit` appends the
   * canonical event FIRST and refreshes this projection SECOND (tmp+rename),
   * so a bumped revision here proves the corresponding append already
   * completed. That ordering is the reason a reader can reload without a lock
   * and without ever observing a half-written stream: it only reloads when the
   * writer has already published. An mtime would carry neither guarantee (it
   * moves on the append, i.e. mid-write, and it is clock-dependent).
   *
   * TOTAL BY CONSTRUCTION: a missing, unreadable, or non-JSON projection
   * answers `undefined` — "cannot tell", which the engine treats as "keep what
   * you have". A freshness probe that throws would turn a cosmetic staleness
   * into a failed read.
   *
   * @param runId - the run to probe.
   * @returns the published revision, or `undefined` when it cannot be read.
   */
  currentRevision(runId: RunId): number | undefined {
    try {
      const parsed = JSON.parse(readFileSync(join(this.runDir(runId), 'snapshot.json'), 'utf8')) as { revision?: unknown }
      return typeof parsed.revision === 'number' && Number.isFinite(parsed.revision) ? parsed.revision : undefined
    } catch {
      return undefined
    }
  }

  /** Load and strictly fold a run's event stream. Returns undefined when no stream exists. */
  load(runId: RunId): Snapshot | undefined {
    const eventsPath = join(this.runDir(runId), 'events.jsonl')
    if (!existsSync(eventsPath)) return undefined
    const raw = readFileSync(eventsPath, 'utf8')
    const lines = raw.split('\n').filter(line => line.trim().length > 0)
    const events: RunEvent[] = []
    for (const [index, line] of lines.entries()) {
      try {
        events.push(JSON.parse(line) as RunEvent)
      } catch (error: unknown) {
        throw new AutopilotError(
          `run ${runId}: events.jsonl line ${index + 1} is not valid JSON: ${errorMessage(error)}`,
          'AP_STORE_CORRUPT',
        )
      }
    }
    const state = foldRun(events)
    return state.snapshot
  }

  /**
   * Commit one event: validate-by-fold is the caller's job (engine folds via
   * applyEvent before calling); here we only persist atomically enough for a
   * single-writer file store: append the canonical line first, then refresh
   * the snapshot projection via tmp+rename.
   *
   * WHY the body stays SYNCHRONOUS inside an async method: the seam is async
   * because the domain backend's writes are (see `./types.ts`), not because
   * this one became concurrent. Keeping `appendFileSync` -> `writeFileSync` ->
   * `renameSync` unbroken means no other task can interleave between the
   * canonical append and the projection refresh, which is exactly the
   * discipline v1 relied on. Switching to `fs/promises` here would introduce
   * an await window between the two and buy nothing.
   */
  async commit(runId: RunId, op: Operation, snapshot: Snapshot, detail?: unknown): Promise<RunEvent> {
    const dir = this.runDir(runId)
    mkdirSync(dir, { recursive: true })
    const event: RunEvent = {
      v: 1,
      op,
      revision: snapshot.revision,
      time: new Date().toISOString(),
      snapshot,
      ...(detail === undefined ? {} : { detail }),
    }
    appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
    const tmp = join(dir, 'snapshot.json.tmp')
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8')
    renameSync(tmp, join(dir, 'snapshot.json'))
    return event
  }

  /** Append one human-readable line to the run's log.md (CC execution-log.md counterpart). */
  async appendLog(runId: RunId, entry: LogEntry): Promise<void> {
    const dir = this.runDir(runId)
    mkdirSync(dir, { recursive: true })
    const suffix = [
      entry.note !== undefined ? ` note: ${entry.note}` : '',
      entry.escalationTarget !== undefined ? ` -> ${entry.escalationTarget}` : '',
      entry.blockingScope !== undefined ? ` (blocks: ${entry.blockingScope})` : '',
    ].join('')
    appendFileSync(
      join(dir, 'log.md'),
      `- [${new Date().toISOString()}] [${entry.stance}] ${entry.text}${suffix}\n`,
      'utf8',
    )
  }
}
