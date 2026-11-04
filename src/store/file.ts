/**
 * File-store paths and legacy readers under $DSH_HOME/storages/dsh-autopilot.
 *
 * 0.3.0 writes only the v3 ledger (`./ledger.ts`, `<root>/ledgers/`). What stays
 * here is the root resolution every backend shares and the path rules of the
 * 0.2.x run tree (`runs/<id>/`, `sessions/<sid>.json`), which the frozen legacy
 * reader follows. The 0.2.x `RunStore`
 * class and its writers (`commit`, `appendLog`, `writeSessionIndex`) are gone.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SessionRunIndex } from './types.js'

/** A run id (the 0.2.x run id was its root session id). */
type RunId = string

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
 * (the retired outbound manifest path rule did the same), which treated a
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

function sessionIndexPath(root: string, sessionId: string): string {
  return join(root, 'sessions', `${sanitize(sessionId)}.json`)
}

/** Read the session's run index, or `undefined` when this session never started a second run. */
export function readSessionIndex(root: string, sessionId: string): SessionRunIndex | undefined {
  try {
    const parsed = JSON.parse(readFileSync(sessionIndexPath(root, sessionId), 'utf8')) as Partial<SessionRunIndex>
    if (parsed.v !== 1) return undefined
    if (parsed.sessionId !== sessionId) return undefined
    if (typeof parsed.currentRunId !== 'string' || parsed.currentRunId.length === 0) return undefined
    if (!Array.isArray(parsed.runIds) || parsed.runIds.some(id => typeof id !== 'string' || id.length === 0)) return undefined
    if (!parsed.runIds.includes(parsed.currentRunId)) return undefined
    return {
      v: 1,
      sessionId,
      currentRunId: parsed.currentRunId,
      runIds: parsed.runIds,
    }
  } catch {
    return undefined
  }
}
