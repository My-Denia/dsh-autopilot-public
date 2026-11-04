/**
 * Frozen, read-only reader for the pre-0.3.0 run streams.
 *
 * 0.3.0 retired the run state machine, but the owner's history (file-backend
 * `runs/<id>/events.jsonl` and domain-store `events` rows) must still fold and
 * display. This module is the only code that knows how. It is self-contained:
 * it imports nothing outside `src/legacy/` except the projection types in
 * `../domain/ledger-types.js` and node builtins, and it never writes.
 *
 * Replay is NOT tightened: `./fold.ts` and `./types.ts` are verbatim copies of
 * the 0.2.x fold, so a stream the old engine could replay still replays, and a
 * stream it refused is `rejected` here with the same code. The old two-letter-prefixed refusal
 * codes were renamed `LEGACY_` because they are no longer live refusals.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LegacyRunProjection, LegacyRunSummary, SandboxRestoreRecord } from '../domain/ledger-types.js'
import { applyEvent } from './fold.js'
import { AutopilotError, latestVerdicts, MAX_REPLAN_ROUNDS, requiredRoles } from './types.js'
import type { Enforcement, Operation, RunEvent, Snapshot } from './types.js'

export type { Snapshot } from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Operations
// ─────────────────────────────────────────────────────────────────────────────

/** Compile-time exhaustiveness: this record has one key per `Operation` member, so adding or dropping one fails tsc. */
const OPERATION_KEYS: Record<Operation, true> = {
  'init': true,
  'submit-plan': true,
  'amend-plan': true,
  'audit': true,
  'self-check': true,
  'external-audit': true,
  'start-executor': true,
  'resume-executor': true,
  'submit-packet': true,
  'submit-evidence': true,
  'log': true,
  'replan': true,
  'set-blocked': true,
  'set-owner-decision': true,
  'owner-approve': true,
  'owner-resolve': true,
  'owner-gate-pass': true,
  'owner-gate-withdraw': true,
  'consume-approval': true,
  'reminder': true,
  'sandbox': true,
  'declare-usage': true,
  'consume-manifest': true,
  'submit-closeout': true,
}

/** Every op type string the fold accepts. */
export const LEGACY_OPERATIONS: readonly string[] = Object.freeze(Object.keys(OPERATION_KEYS))

// ─────────────────────────────────────────────────────────────────────────────
// Fold
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A folded legacy snapshot: the 0.2.x `Snapshot` plus two facts the snapshot
 * never carried but the event stream does. The fold itself is untouched; these
 * are read off the accepted events afterwards.
 */
export interface LegacySnapshot extends Snapshot {
  /** One entry per accepted `owner-resolve` event: the event time and the owner's note (the "owner ruling: " prefix removed). */
  readonly ownerResolutions: readonly { readonly at?: string; readonly text: string }[]
  /** Number of accepted `amend-plan` events. */
  readonly planAmendments: number
}

export type LegacyFoldResult =
  | { readonly ok: true; readonly snapshot: LegacySnapshot; readonly eventCount: number }
  | { readonly ok: false; readonly error: string; readonly eventCount: number; readonly failedAt: number }

const OWNER_RULING_PREFIX = 'owner ruling: '

function describeError(error: unknown): string {
  if (error instanceof AutopilotError) return `${error.code}: ${error.message}`
  return `LEGACY_FOLD_EXCEPTION: ${error instanceof Error ? error.message : String(error)}`
}

/**
 * Strictly replay a stream. Never throws: the first illegal event yields
 * `ok:false` with the fold's `LEGACY_*` code at the front of `error` and the
 * zero-based index of the offending event in `failedAt`. An empty stream is a
 * rejection (`LEGACY_EMPTY_STREAM`), not an uninitialized success.
 */
export function foldLegacyEvents(events: readonly unknown[]): LegacyFoldResult {
  if (events.length === 0) {
    return { ok: false, error: 'LEGACY_EMPTY_STREAM: the stream holds no events', eventCount: 0, failedAt: 0 }
  }
  let snapshot: Snapshot | undefined
  const ownerResolutions: { at?: string; text: string }[] = []
  let planAmendments = 0
  for (let index = 0; index < events.length; index += 1) {
    try {
      const event = events[index] as RunEvent
      snapshot = applyEvent(snapshot, event)
      if (event.op === 'owner-resolve') {
        const diagnostic = snapshot.diagnostic ?? ''
        ownerResolutions.push({
          ...(typeof event.time === 'string' ? { at: event.time } : {}),
          text: diagnostic.startsWith(OWNER_RULING_PREFIX) ? diagnostic.slice(OWNER_RULING_PREFIX.length) : diagnostic,
        })
      } else if (event.op === 'amend-plan') {
        planAmendments += 1
      }
    } catch (error: unknown) {
      return { ok: false, error: describeError(error), eventCount: events.length, failedAt: index }
    }
  }
  if (snapshot === undefined) {
    return { ok: false, error: 'LEGACY_EMPTY_STREAM: the stream folded to nothing', eventCount: events.length, failedAt: 0 }
  }
  return { ok: true, snapshot: { ...snapshot, ownerResolutions, planAmendments }, eventCount: events.length }
}

// ─────────────────────────────────────────────────────────────────────────────
// Projection (frozen copy of the 0.2.x web projection)
// ─────────────────────────────────────────────────────────────────────────────

/** The keys of `Enforcement` that are safe to forward verbatim (frozen from 0.2.x `ENFORCEMENT_KEYS`). */
const ENFORCEMENT_KEYS = [
  'sandbox', 'modeAppended', 'priorSandboxMode', 'reminders',
  'store', 'approval', 'egress', 'service', 'outboundConsumed',
] as const

function projectEnforcement(enforcement: Enforcement): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const key of ENFORCEMENT_KEYS) {
    const value = enforcement[key]
    if (value !== undefined) out[key] = value
  }
  const approvals = enforcement.ownerApprovals
  const list = Array.isArray(approvals) ? approvals : []
  out.ownerApprovalsGranted = list.length
  out.ownerApprovalsConsumed = list.filter(
    entry => typeof entry === 'object' && entry !== null && (entry as { consumedBy?: unknown }).consumedBy !== undefined,
  ).length
  return out
}

/**
 * Project a folded legacy run exactly as the 0.2.x web layer served it, plus
 * `ownerResolutions`, `planAmendments`, `archived: true` and the restore record.
 *
 * Differences from 0.2.x, all because there is no live engine to ask:
 * - `routingReachability` is never present (it was a live catalog reading).
 * - `routing` is never present. 0.2.x served it only while `routing.mode` was
 *   `auto`, as a reading of live configuration (ladder, policy, role routing);
 *   the archive cannot reconstruct that, and the 0.2.x card parses it against
 *   that exact shape, so an invented one would render as garbage. Absent is the
 *   shape 0.2.x already served for "no routing block".
 * - `gateSources` keeps the 0.2.x per-gate `no-source` reading.
 */
export function projectLegacyRun(snapshot: LegacySnapshot, restore: SandboxRestoreRecord): LegacyRunProjection {
  const latest = latestVerdicts(snapshot.audits)
  const verdicts: Record<string, string> = {}
  for (const [role, record] of Object.entries(latest)) {
    if (typeof record?.verdict === 'string') verdicts[role] = record.verdict
  }
  return {
    runId: snapshot.runId,
    revision: snapshot.revision,
    phase: snapshot.phase,
    planGate: snapshot.planGate,
    executionGate: snapshot.executionGate,
    planRevision: snapshot.plan.revision,
    objective: snapshot.triage.objective,
    size: snapshot.triage.size,
    risk: snapshot.triage.risk,
    executionMode: snapshot.triage.executionMode,
    auditMode: snapshot.triage.auditMode,
    requiredRoles: [...requiredRoles(snapshot.triage)],
    latestVerdicts: verdicts,
    replanBudgetRemaining: Math.max(0, MAX_REPLAN_ROUNDS - snapshot.consecutiveReplans),
    auditCount: snapshot.audits.length,
    logCount: snapshot.logCount,
    closeoutSubmitted: snapshot.closeout !== undefined,
    ...(snapshot.executor === undefined
      ? {}
      : { executor: { generation: snapshot.executor.generation, state: snapshot.executor.state } }),
    enforcement: projectEnforcement(snapshot.enforcement),
    gateSources: {
      plan: snapshot.gateSources?.plan ?? { source: 'no-source' },
      execution: snapshot.gateSources?.execution ?? { source: 'no-source' },
    },
    ...(snapshot.ownerResolutions.length === 0 ? {} : { ownerResolutions: snapshot.ownerResolutions }),
    ...(snapshot.planAmendments === 0 ? {} : { planAmendments: snapshot.planAmendments }),
    archived: true,
    sandboxRestore: restore,
  }
}

/** What the run's sandbox clamp left behind, for the lazy one-time restore. */
export function legacyClampOf(snapshot: LegacySnapshot): {
  readonly modeAppended: boolean
  readonly priorSandboxMode?: string
  readonly sessionId?: string
  readonly phase: string
} {
  return {
    modeAppended: snapshot.enforcement.modeAppended === true,
    ...(snapshot.enforcement.priorSandboxMode === undefined ? {} : { priorSandboxMode: snapshot.enforcement.priorSandboxMode }),
    ...(snapshot.sessionId === undefined ? {} : { sessionId: snapshot.sessionId }),
    phase: snapshot.phase,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sources
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The minimal read-only shape of the domain backend: every stored record of one
 * table as `{ key, value }`. The live adapter wraps `DomainLike.table(name)`
 * (`entries()`), the tests use an in-memory stub. Only the `events` table is read.
 */
export interface LegacyDomainReader {
  list(table: string): Promise<readonly { readonly key: string; readonly value: unknown }[]>
}

export interface LegacySources {
  /** Store root holding `runs/<id>/events.jsonl` and `sessions/<sid>.json` (default root: `$DSH_HOME/storages/dsh-autopilot`). */
  readonly fileRoot?: string
  readonly domain?: LegacyDomainReader
}

/** The domain events table; keys are `<runId>#<12-digit revision>`. */
const EVENTS_TABLE = 'events'
const REVISION_KEY_WIDTH = 12

/** The file store's lossy id-to-directory rule (one character per character, so it stays injective for safe ids). */
function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_')
}

interface LoadedRun {
  readonly runId: string
  readonly backend: 'file' | 'domain'
  readonly result: LegacyFoldResult
}

function rejected(error: string, eventCount: number, failedAt: number): LegacyFoldResult {
  return { ok: false, error, eventCount, failedAt }
}

// ── file backend ─────────────────────────────────────────────────────────────

function parseJsonl(raw: string): { events: unknown[] } | { error: string; eventCount: number; failedAt: number } {
  const lines = raw.split('\n').filter(line => line.trim().length > 0)
  const events: unknown[] = []
  for (const [index, line] of lines.entries()) {
    try {
      events.push(JSON.parse(line))
    } catch {
      return { error: `LEGACY_STORE_CORRUPT: events.jsonl line ${index + 1} is not valid JSON`, eventCount: lines.length, failedAt: index }
    }
  }
  return { events }
}

function runIdOfEvents(events: readonly unknown[]): string | undefined {
  for (const event of events) {
    const id = (event as { snapshot?: { runId?: unknown } } | null)?.snapshot?.runId
    if (typeof id === 'string' && id.length > 0) return id
  }
  return undefined
}

function loadFileDir(runsRoot: string, dirName: string): LoadedRun | undefined {
  const eventsPath = join(runsRoot, dirName, 'events.jsonl')
  if (!existsSync(eventsPath)) return undefined
  let raw: string
  try {
    raw = readFileSync(eventsPath, 'utf8')
  } catch {
    return { runId: dirName, backend: 'file', result: rejected('LEGACY_STORE_UNREADABLE: events.jsonl could not be read', 0, 0) }
  }
  const parsed = parseJsonl(raw)
  if ('error' in parsed) {
    // The id of an unparsable stream is the directory name (lossy for ids with unsafe characters).
    return { runId: dirName, backend: 'file', result: rejected(parsed.error, parsed.eventCount, parsed.failedAt) }
  }
  const runId = runIdOfEvents(parsed.events) ?? dirName
  return { runId, backend: 'file', result: foldLegacyEvents(parsed.events) }
}

function loadFileRuns(fileRoot: string, only?: string): LoadedRun[] {
  const runsRoot = join(fileRoot, 'runs')
  if (!existsSync(runsRoot)) return []
  if (only !== undefined) {
    const loaded = loadFileDir(runsRoot, sanitize(only))
    return loaded !== undefined && loaded.runId === only ? [loaded] : []
  }
  let entries: string[]
  try {
    entries = readdirSync(runsRoot)
  } catch {
    return []
  }
  const out: LoadedRun[] = []
  for (const entry of entries.sort()) {
    const loaded = loadFileDir(runsRoot, entry)
    if (loaded !== undefined) out.push(loaded)
  }
  return out
}

/** `sessions/<sid>.json` -> run ids it lists. Only well-formed v1 indexes count (same checks as the 0.2.x reader). */
function readSessionIndexes(fileRoot: string): Map<string, string> {
  const runToSession = new Map<string, string>()
  const dir = join(fileRoot, 'sessions')
  if (!existsSync(dir)) return runToSession
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return runToSession
  }
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { v?: unknown; sessionId?: unknown; currentRunId?: unknown; runIds?: unknown }
      if (parsed.v !== 1 || typeof parsed.sessionId !== 'string' || parsed.sessionId.length === 0) continue
      if (!Array.isArray(parsed.runIds) || parsed.runIds.some(id => typeof id !== 'string' || id.length === 0)) continue
      for (const id of parsed.runIds as string[]) {
        if (!runToSession.has(id)) runToSession.set(id, parsed.sessionId)
      }
    } catch {
      // Unreadable index: the snapshot's own sessionId still applies.
    }
  }
  return runToSession
}

// ── domain backend ───────────────────────────────────────────────────────────

function parseEventKey(key: string): { runId: string; revision: number } | undefined {
  const cut = key.lastIndexOf('#')
  const digits = cut < 0 ? '' : key.slice(cut + 1)
  if (cut < 1 || digits.length !== REVISION_KEY_WIDTH || !/^[0-9]+$/.test(digits)) return undefined
  const revision = Number(digits)
  return revision < 1 ? undefined : { runId: key.slice(0, cut), revision }
}

async function loadDomainRuns(domain: LegacyDomainReader, only?: string): Promise<LoadedRun[]> {
  let rows: readonly { readonly key: string; readonly value: unknown }[]
  try {
    rows = await domain.list(EVENTS_TABLE)
  } catch {
    return []
  }
  const byRun = new Map<string, { key: string; revision: number; value: unknown }[]>()
  for (const row of rows) {
    const parsed = parseEventKey(row.key)
    // A key that is not '<runId>#<12 digits>' cannot be attributed to any run; skipping it is the reader's only option.
    if (parsed === undefined) continue
    if (only !== undefined && parsed.runId !== only) continue
    const list = byRun.get(parsed.runId) ?? []
    list.push({ key: row.key, revision: parsed.revision, value: row.value })
    byRun.set(parsed.runId, list)
  }
  const out: LoadedRun[] = []
  for (const [runId, list] of [...byRun.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    // Lexical key order equals revision order only because the revision is zero-padded to a fixed width.
    list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const events: unknown[] = []
    let problem: LegacyFoldResult | undefined
    for (const [index, row] of list.entries()) {
      const value = row.value as { revision?: unknown } | null
      if (value === null || typeof value !== 'object') {
        problem = rejected('LEGACY_STORE_CORRUPT: an events record is not an object', list.length, index)
        break
      }
      if (value.revision !== row.revision) {
        problem = rejected('LEGACY_STORE_CORRUPT: an events record carries a revision that contradicts its key', list.length, index)
        break
      }
      events.push(value)
    }
    out.push({ runId, backend: 'domain', result: problem ?? foldLegacyEvents(events) })
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Public reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The restore state before the one-time lazy restore has run. A run is `pending` only when its clamp can
 * still be on the session: the mode event was appended AND the plan gate never passed (0.2.x restored the
 * prior mode at the gate pass), or the run recorded that its restore failed. Anything else is `not-clamped`,
 * so a read-only the user set later is never mistaken for the plugin's clamp.
 */
function defaultRestore(result: LegacyFoldResult): SandboxRestoreRecord {
  if (!result.ok) return { state: 'not-clamped' }
  const snapshot = result.snapshot
  const restoredAtGate = snapshot.planGatePassedAt !== undefined && !/sandbox restore failed/i.test(snapshot.enforcement.diagnostic ?? '')
  return legacyClampOf(snapshot).modeAppended && !restoredAtGate ? { state: 'pending' } : { state: 'not-clamped' }
}

function summarize(loaded: LoadedRun, sessionOf: ReadonlyMap<string, string>): LegacyRunSummary {
  const { result } = loaded
  // The session's first run carries no sessionId and its run id IS the session id (0.2.x `Snapshot.sessionId`);
  // a session index, when one exists, is authoritative for the rest.
  const sessionId = (result.ok ? result.snapshot.sessionId : undefined) ?? sessionOf.get(loaded.runId) ?? loaded.runId
  return {
    runId: loaded.runId,
    sessionId,
    backend: loaded.backend,
    fold: result.ok ? 'ok' : 'rejected',
    ...(result.ok ? {} : { foldError: result.error }),
    ...(result.ok
      ? { phase: result.snapshot.phase, objective: result.snapshot.triage.objective, revision: result.snapshot.revision }
      : {}),
    eventCount: result.eventCount,
    sandboxRestore: defaultRestore(result),
  }
}

/** Prefer the copy with more events; a tie goes to the file backend. */
function pickRicher(a: LoadedRun, b: LoadedRun): LoadedRun {
  if (b.result.eventCount > a.result.eventCount) return b
  if (a.result.eventCount > b.result.eventCount) return a
  return a.backend === 'file' ? a : b
}

async function loadAll(sources: LegacySources, only?: string): Promise<Map<string, LoadedRun>> {
  const loaded: LoadedRun[] = [
    ...(sources.fileRoot === undefined ? [] : loadFileRuns(sources.fileRoot, only)),
    ...(sources.domain === undefined ? [] : await loadDomainRuns(sources.domain, only)),
  ]
  // A run id can appear in BOTH backends (the store was switched mid-history). Both are listed
  // regardless of which backend the engine last used; the duplicate is resolved by keeping the
  // copy with MORE events, because that one advanced further and the other is a stale prefix.
  const byId = new Map<string, LoadedRun>()
  for (const run of loaded) {
    const seen = byId.get(run.runId)
    byId.set(run.runId, seen === undefined ? run : pickRicher(seen, run))
  }
  return byId
}

function sessionMap(sources: LegacySources): ReadonlyMap<string, string> {
  return sources.fileRoot === undefined ? new Map() : readSessionIndexes(sources.fileRoot)
}

/** Every legacy run of both backends, deduped by run id, ordered by run id. */
export async function listLegacyRuns(sources: LegacySources): Promise<readonly LegacyRunSummary[]> {
  const byId = await loadAll(sources)
  const sessionOf = sessionMap(sources)
  return [...byId.values()]
    .sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
    .map(run => summarize(run, sessionOf))
}

/** One run: its summary, and (when the fold was ok) the snapshot and the frozen projection. */
export async function readLegacyRun(
  sources: LegacySources,
  runId: string,
): Promise<{ summary: LegacyRunSummary; projection?: LegacyRunProjection; snapshot?: LegacySnapshot } | undefined> {
  const run = (await loadAll(sources, runId)).get(runId)
  if (run === undefined) return undefined
  const summary = summarize(run, sessionMap(sources))
  if (!run.result.ok) return { summary }
  return {
    summary,
    projection: projectLegacyRun(run.result.snapshot, summary.sandboxRestore),
    snapshot: run.result.snapshot,
  }
}

/** Run ids (both backends) that belong to one root session. */
export async function legacyRunIdsForSession(sources: LegacySources, sessionId: string): Promise<readonly string[]> {
  return (await listLegacyRuns(sources)).filter(run => run.sessionId === sessionId).map(run => run.runId)
}
