/**
 * The card's v3 half: reading the ledger projection the host route serves and
 * turning it into display rows.
 *
 * WHAT THE CARD SAYS, AND WHAT IT REFUSES TO SAY. The goal itself lives in the
 * host's native dsh-goal; the ledger only mirrors its last-seen status, links
 * to issue/PR, and records the delegations and reviews this session ran. So
 * every line here is a statement about a recorded value, and when a value was
 * never recorded the row says so instead of defaulting. In particular:
 *
 * - The goal phase is rendered from `goal.status` verbatim. The contract does
 *   not carry the native `blockedReason` or the process-local activation, so
 *   the card never invents a reason it was not given.
 * - Auto-continue is the ledger's `autoContinue` status, reason verbatim. The
 *   `hostRestart` marker is HISTORY ("restart at T, N children lost"): it
 *   persists after the owner resumes, so keying the "say continue" prompt to it
 *   would keep asking after the owner already did.
 * - Who may resume is the native rule: the model cannot resume a paused goal
 *   (dsh `tool-goal` update action `resume` refuses it), so a paused or blocked
 *   goal says the owner resumes it.
 *
 * FRAMEWORK-FREE AND DOM-FREE, like `./live.ts`: vitest drives this module
 * directly and `tsconfig.test.json` has no DOM lib. The contract types are
 * imported TYPE-ONLY so the bundle gains no runtime module; the two route
 * constants are mirrored locally with a compile-time equality check.
 *
 * @module dsh-autopilot/client/ledger
 */

import type {
  DelegationRecord, DelegationState, GoalRef, LedgerProjection, LedgerRoute, LegacyRunProjection,
  LegacyRunSummary, LinkRecord, ReviewRecord, SandboxRestoreRecord,
} from '../domain/ledger-types.js'
import type {
  LEDGER_ROUTE as LedgerRouteConst, LEGACY_RUN_ROUTE as LegacyRunRouteConst,
} from '../domain/ledger-types.js'
import type { LiveFetch } from './live.js'

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

/** Mirror of `LEDGER_ROUTE`; the `satisfies` fails the build if the two drift. */
export const LEDGER_ROUTE_PATH = '/api/autopilot/ledger' satisfies typeof LedgerRouteConst
/** Mirror of `LEGACY_RUN_ROUTE`. */
export const LEGACY_RUN_ROUTE_PATH = '/api/autopilot/run' satisfies typeof LegacyRunRouteConst

/** Poll cadence while something is running (a child, or an active goal). */
export const LEDGER_BUSY_POLL_MS = 3000
/** Poll cadence while nothing runs: the owner may still resume, so it never stops. */
export const LEDGER_QUIET_POLL_MS = 10000

export function ledgerRouteUrl(sessionId: string): string {
  return `${LEDGER_ROUTE_PATH}?session=${encodeURIComponent(sessionId)}`
}

/** The session id the ledger request is made for: the root, else this session. */
export function ledgerSessionId(props: { readonly sessionId?: string; readonly rootSessionId?: string }): string | undefined {
  const root = props.rootSessionId
  return root !== undefined && root.trim() !== '' ? root : props.sessionId
}

export function legacyRunUrl(runId: string): string {
  return `${LEGACY_RUN_ROUTE_PATH}?id=${encodeURIComponent(runId)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Safe readers. What arrives is JSON off a socket; a malformed row is dropped,
// never allowed to take the card down.
// ─────────────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
function strList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}
function rows<T>(value: unknown, read: (row: unknown) => T | undefined): readonly T[] {
  if (!Array.isArray(value)) return []
  const out: T[] = []
  for (const row of value) {
    const parsed = read(row)
    if (parsed !== undefined) out.push(parsed)
  }
  return out
}
/** Copy `key` from `src` only when `read` accepts it (exactOptionalPropertyTypes-safe). */
function opt<K extends string, T>(key: K, value: T | undefined): { [P in K]?: T } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: T }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : undefined
}

const DELEGATION_STATES: readonly DelegationState[] = ['starting', 'running', 'idle', 'completed', 'failed', 'cancelled', 'lost']
const ROLES = ['scout', 'clerk', 'worker', 'executor-lead', 'planner', 'reviewer'] as const

export function readRoute(value: unknown): LedgerRoute | undefined {
  if (!isObj(value)) return undefined
  const provider = str(value.provider)
  const model = str(value.model)
  if (provider === undefined || model === undefined) return undefined
  return { provider, model, ...opt('reasoningEffort', str(value.reasoningEffort)) }
}

function readGoal(value: unknown): GoalRef | undefined {
  if (!isObj(value)) return undefined
  const goalId = str(value.goalId)
  const firstSeenAt = str(value.firstSeenAt)
  const lastSeenAt = str(value.lastSeenAt)
  if (goalId === undefined || firstSeenAt === undefined || lastSeenAt === undefined) return undefined
  return {
    goalId, firstSeenAt, lastSeenAt,
    ...opt('revision', num(value.revision)),
    ...opt('status', str(value.status)),
    ...opt('objective', str(value.objective)),
  }
}

function readDelegation(value: unknown): DelegationRecord | undefined {
  if (!isObj(value)) return undefined
  const childId = str(value.childId)
  const role = oneOf(value.role, ROLES)
  const parentId = str(value.parentId)
  const state = oneOf(value.state, DELEGATION_STATES)
  const startedAt = str(value.startedAt)
  if (childId === undefined || role === undefined || parentId === undefined || state === undefined || startedAt === undefined) {
    return undefined
  }
  const escalation = isObj(value.escalation) && str(value.escalation.reason) !== undefined && str(value.escalation.at) !== undefined
    ? { reason: value.escalation.reason as string, at: value.escalation.at as string }
    : undefined
  return {
    childId, role, parentId, state, startedAt,
    depth: num(value.depth) ?? 1,
    generation: num(value.generation) ?? 1,
    title: str(value.title) ?? '',
    modelSource: oneOf(value.modelSource, ['arg', 'pin', 'ladder', 'inherit'] as const) ?? 'inherit',
    effortSource: oneOf(value.effortSource, ['arg', 'pin', 'catalog-default', 'host-default'] as const) ?? 'host-default',
    routeMatch: oneOf(value.routeMatch, ['match', 'mismatch', 'pending', 'unreadable'] as const) ?? 'unreadable',
    tools: value.tools === 'inherit' ? 'inherit' : strList(value.tools),
    maxDepth: num(value.maxDepth) ?? 0,
    ...opt('replaces', str(value.replaces)),
    ...opt('writePaths', Array.isArray(value.writePaths) ? strList(value.writePaths) : undefined),
    ...opt('selected', readRoute(value.selected)),
    ...opt('observed', readRoute(value.observed)),
    ...opt('routeWhy', Array.isArray(value.routeWhy) ? strList(value.routeWhy) : undefined),
    ...opt('settledAt', str(value.settledAt)),
    ...opt('diagnostic', str(value.diagnostic)),
    ...opt('escalation', escalation),
  }
}

function readReview(value: unknown): ReviewRecord | undefined {
  if (!isObj(value)) return undefined
  const reviewerChildId = str(value.reviewerChildId)
  const verdict = oneOf(value.verdict, ['pass', 'needs-fix', 'blocked'] as const)
  const independence = oneOf(value.independence, ['cross-family', 'reduced'] as const)
  const at = str(value.at)
  if (reviewerChildId === undefined || verdict === undefined || independence === undefined || at === undefined) return undefined
  return {
    reviewerChildId, verdict, independence, at,
    reviewedChildIds: strList(value.reviewedChildIds),
    subject: str(value.subject) ?? '',
    findings: rows(value.findings, (f) => {
      if (!isObj(f)) return undefined
      const severity = oneOf(f.severity, ['blocker', 'major', 'minor'] as const)
      const summary = str(f.summary)
      if (severity === undefined || summary === undefined) return undefined
      return { severity, summary, ...opt('where', str(f.where)) }
    }),
    excludedFamilies: strList(value.excludedFamilies),
    ...opt('reviewerRoute', readRoute(value.reviewerRoute)),
    ...opt('independenceNote', str(value.independenceNote)),
  }
}

function readLink(value: unknown): LinkRecord | undefined {
  if (!isObj(value)) return undefined
  const kind = oneOf(value.kind, ['issue', 'pr'] as const)
  const ref = str(value.ref)
  const at = str(value.at)
  if (kind === undefined || ref === undefined || at === undefined) return undefined
  return { kind, ref, at, ...opt('url', str(value.url)) }
}

function readSandbox(value: unknown): SandboxRestoreRecord {
  if (!isObj(value)) return { state: 'pending' }
  const state = oneOf(value.state, ['restored', 'default-written', 'untouched-user-changed', 'not-clamped', 'pending', 'failed'] as const)
  return {
    state: state ?? 'pending',
    ...opt('mode', str(value.mode)),
    ...opt('at', str(value.at)),
    ...opt('note', str(value.note)),
  }
}

export function readLegacySummary(value: unknown): LegacyRunSummary | undefined {
  if (!isObj(value)) return undefined
  const runId = str(value.runId)
  if (runId === undefined) return undefined
  return {
    runId,
    backend: oneOf(value.backend, ['file', 'domain'] as const) ?? 'file',
    fold: oneOf(value.fold, ['ok', 'rejected'] as const) ?? 'rejected',
    eventCount: num(value.eventCount) ?? 0,
    sandboxRestore: readSandbox(value.sandboxRestore),
    ...opt('sessionId', str(value.sessionId)),
    ...opt('foldError', str(value.foldError)),
    ...opt('phase', str(value.phase)),
    ...opt('objective', str(value.objective)),
    ...opt('revision', num(value.revision)),
  }
}

/**
 * Validate a `GET LEDGER_ROUTE` body. Undefined for an error body, a wrong
 * version, or anything that is not a ledger; rows inside are filtered one by one.
 */
export function readLedgerBody(body: unknown): LedgerProjection | undefined {
  if (!isObj(body) || body.ok !== true || !isObj(body.ledger)) return undefined
  const l = body.ledger
  if (l.v !== 3) return undefined
  const sessionId = str(l.sessionId)
  const revision = num(l.revision)
  if (sessionId === undefined || revision === undefined) return undefined
  const ac = isObj(l.autoContinue) ? l.autoContinue : {}
  const depth = isObj(l.depth) ? l.depth : {}
  const restart = isObj(l.hostRestart) && str(l.hostRestart.at) !== undefined
    ? { at: l.hostRestart.at as string, lostChildIds: strList(l.hostRestart.lostChildIds) }
    : undefined
  return {
    v: 3,
    sessionId,
    revision,
    previousGoals: rows(l.previousGoals, readGoal),
    delegations: rows(l.delegations, readDelegation),
    reviews: rows(l.reviews, readReview),
    links: rows(l.links, readLink),
    autoContinue: {
      available: ac.available === true,
      reason: str(ac.reason) ?? 'not reported',
    },
    depth: {
      executorLead: num(depth.executorLead) ?? 2,
      source: oneOf(depth.source, ['plugin-default', 'user-setting', 'unknown'] as const) ?? 'unknown',
      ...opt('note', str(depth.note)),
    },
    legacyRuns: rows(l.legacyRuns, readLegacySummary),
    notes: strList(l.notes),
    updatedAt: str(l.updatedAt) ?? '',
    ...opt('goal', readGoal(l.goal)),
    ...opt('hostRestart', restart),
  }
}

/** Validate a `GET LEGACY_RUN_ROUTE` body carrying a v3 `LegacyRunProjection`. */
export function readLegacyRunBody(body: unknown): LegacyRunProjection | undefined {
  if (!isObj(body) || body.ok !== true || !isObj(body.run)) return undefined
  const r = body.run
  const runId = str(r.runId)
  const phase = str(r.phase)
  if (runId === undefined || phase === undefined) return undefined
  const verdicts: Record<string, string> = {}
  if (isObj(r.latestVerdicts)) {
    for (const [k, v] of Object.entries(r.latestVerdicts)) if (typeof v === 'string') verdicts[k] = v
  }
  const executor = isObj(r.executor) && num(r.executor.generation) !== undefined && str(r.executor.state) !== undefined
    ? { generation: r.executor.generation as number, state: r.executor.state as string }
    : undefined
  return {
    runId, phase,
    revision: num(r.revision) ?? 0,
    planGate: str(r.planGate) ?? '',
    executionGate: str(r.executionGate) ?? '',
    planRevision: num(r.planRevision) ?? 0,
    objective: str(r.objective) ?? '',
    size: str(r.size) ?? '',
    risk: str(r.risk) ?? '',
    executionMode: str(r.executionMode) ?? '',
    auditMode: str(r.auditMode) ?? '',
    requiredRoles: strList(r.requiredRoles),
    latestVerdicts: verdicts,
    replanBudgetRemaining: num(r.replanBudgetRemaining) ?? 0,
    auditCount: num(r.auditCount) ?? 0,
    logCount: num(r.logCount) ?? 0,
    closeoutSubmitted: r.closeoutSubmitted === true,
    enforcement: isObj(r.enforcement) ? r.enforcement : {},
    archived: true,
    sandboxRestore: readSandbox(r.sandboxRestore),
    ...opt('executor', executor),
    ...opt('routing', r.routing),
    ...opt('routingReachability', r.routingReachability),
    ...opt('gateSources', r.gateSources),
    ...opt('ownerResolutions', Array.isArray(r.ownerResolutions)
      ? rows(r.ownerResolutions, (o) => isObj(o) && typeof o.text === 'string'
        ? { text: o.text, ...opt('at', str(o.at)) }
        : undefined)
      : undefined),
    ...opt('planAmendments', num(r.planAmendments)),
  }
}

/** Fetch and validate; any failure is `undefined` (no answer this time). */
export async function fetchLedger(sessionId: string, fetchJson: LiveFetch): Promise<LedgerProjection | undefined> {
  try {
    const res = await fetchJson(ledgerRouteUrl(sessionId))
    if (!res.ok) return undefined
    return readLedgerBody(await res.json())
  } catch {
    return undefined
  }
}

export async function fetchLegacyRun(runId: string, fetchJson: LiveFetch): Promise<LegacyRunProjection | undefined> {
  try {
    const res = await fetchJson(legacyRunUrl(runId))
    if (!res.ok) return undefined
    return readLegacyRunBody(await res.json())
  } catch {
    return undefined
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// View model
// ─────────────────────────────────────────────────────────────────────────────

/** Neutral display tone; the TSX maps it onto `--dsw-alias-*` colours. */
export type Tone = 'success' | 'warn' | 'error' | 'neutral'

export type GoalPhaseView = 'active' | 'paused' | 'blocked' | 'complete' | 'no-goal' | 'unrecognised'

export interface GoalView {
  readonly phase: GoalPhaseView
  /** Badge text: the phase, or the verbatim status when unrecognised. */
  readonly label: string
  readonly tone: Tone
  readonly objective?: string
  /** Who can move it next, in plain words. */
  readonly next?: string
  /** Revision and when the plugin last read it. */
  readonly seen?: string
}

const NATIVE_PHASES: readonly string[] = ['active', 'paused', 'blocked', 'complete']

/**
 * The goal line. `status` is shown verbatim when it is not one of the four
 * native phases, because the contract carries no reason field to parse.
 */
export function goalView(p: LedgerProjection): GoalView {
  const g = p.goal
  if (g === undefined) {
    return { phase: 'no-goal', label: 'no goal recorded', tone: 'neutral', next: 'no dsh-goal has been seen in this session' }
  }
  const status = g.status?.trim()
  const seen = `goal ${g.goalId}${g.revision === undefined ? '' : ` r${g.revision}`} · last read ${g.lastSeenAt}`
  const base = { seen, ...opt('objective', g.objective) }
  if (status === undefined || status === '') {
    return { ...base, phase: 'unrecognised', label: 'status not read', tone: 'neutral' }
  }
  if (!NATIVE_PHASES.includes(status)) {
    return { ...base, phase: 'unrecognised', label: status, tone: 'neutral' }
  }
  switch (status) {
    case 'active':
      return {
        ...base, phase: 'active', label: 'active', tone: 'success',
        next: p.autoContinue.available
          ? 'rounds continue automatically while the session is idle'
          : `auto-continue is not running: ${p.autoContinue.reason}`,
      }
    case 'paused':
      return { ...base, phase: 'paused', label: 'paused', tone: 'warn', next: 'paused; only you can resume it (say "continue")' }
    case 'blocked':
      return { ...base, phase: 'blocked', label: 'blocked', tone: 'error', next: 'blocked; the block reason is not recorded in the ledger — check the goal before resuming (a round-limit block needs a higher round cap first)' }
    default:
      return { ...base, phase: 'complete', label: 'complete', tone: 'success', next: 'complete; a new goal can be created in this session' }
  }
}

export interface AutoContinueView {
  readonly available: boolean
  /** e.g. `auto-continue available: goal round driver present`. */
  readonly text: string
  readonly tone: Tone
  /**
   * The B4 line, shown while a goal is active: continuing across a host
   * restart needs the owner's "continue"; a scheduled reminder does not re-arm
   * the goal.
   */
  readonly restartNote?: string
}

export const RESTART_NOTE = 'After a host restart the goal does not continue on its own: say "continue" once to resume it. A scheduled reminder does not re-arm the goal.'

export function autoContinueView(p: LedgerProjection): AutoContinueView {
  const active = p.goal?.status?.trim() === 'active'
  return {
    available: p.autoContinue.available,
    text: p.autoContinue.available
      ? `auto-continue available: ${p.autoContinue.reason}`
      : `auto-continue unavailable: ${p.autoContinue.reason}`,
    tone: p.autoContinue.available ? 'success' : 'warn',
    ...opt('restartNote', active ? RESTART_NOTE : undefined),
  }
}

/** The host-restart marker as history, never as a live instruction. */
export function hostRestartLine(p: LedgerProjection): string | undefined {
  const r = p.hostRestart
  if (r === undefined) return undefined
  const n = r.lostChildIds.length
  return `host restart at ${r.at}: ${n} running ${n === 1 ? 'child was' : 'children were'} lost (not restarted automatically)`
}

export function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

/** `provider/model · effort high`, or `… · no effort sent` / `no effort observed`. */
export function routeText(route: LedgerRoute | undefined, side: 'selected' | 'observed'): string {
  if (route === undefined) return side === 'selected' ? 'nothing sent (host default)' : 'not observed yet'
  const effort = route.reasoningEffort === undefined
    ? (side === 'selected' ? 'no effort sent' : 'no effort observed')
    : `effort ${route.reasoningEffort}`
  return `${route.provider}/${route.model} · ${effort}`
}

export interface DelegationRow {
  readonly childId: string
  readonly shortId: string
  readonly role: string
  readonly title: string
  /** 0-based indentation level (depth - 1). */
  readonly indent: number
  readonly generation: number
  readonly replaces?: string
  readonly state: DelegationState
  readonly stateTone: Tone
  /** Extra state text, e.g. lost: `lost — not restarted automatically`. */
  readonly stateNote?: string
  readonly selected: string
  readonly observed: string
  /** `model from pin · effort from arg`. */
  readonly source: string
  readonly match: 'match' | 'mismatch' | 'pending' | 'unreadable'
  /** Human text for the match cell. */
  readonly matchText: string
  readonly matchTone: Tone
  readonly diagnostic?: string
  readonly escalation?: string
}

const SOURCE_TEXT: Readonly<Record<string, string>> = {
  arg: 'call argument',
  pin: 'role pin',
  ladder: 'routing ladder',
  inherit: 'host default',
  'catalog-default': 'model catalog default',
  'host-default': 'host default',
}

function stateTone(state: DelegationState): Tone {
  switch (state) {
    case 'running': case 'starting': case 'idle': return 'neutral'
    case 'completed': return 'success'
    case 'lost': case 'failed': return 'error'
    default: return 'warn'
  }
}

/**
 * Delegations in tree order: each child directly under its parent (depth 2
 * under its executor-lead), siblings by start time. Orphans (parent not in the
 * list and not the root) are appended at their own depth rather than dropped.
 */
export function delegationRows(p: LedgerProjection): readonly DelegationRow[] {
  const byStart = [...p.delegations].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const ids = new Set(byStart.map(d => d.childId))
  const ordered: DelegationRecord[] = []
  const seen = new Set<string>()
  const visit = (d: DelegationRecord): void => {
    if (seen.has(d.childId)) return
    seen.add(d.childId)
    ordered.push(d)
    for (const c of byStart) if (c.parentId === d.childId) visit(c)
  }
  for (const d of byStart) if (!ids.has(d.parentId)) visit(d)
  for (const d of byStart) visit(d)
  return ordered.map((d) => {
    const matchText = d.routeMatch === 'match'
      ? 'observed matches selected'
      : d.routeMatch === 'mismatch'
        ? 'MISMATCH: observed differs from selected'
        : d.routeMatch === 'pending'
          ? 'not observed yet (child has not sent a request)'
          : 'could not read the child session'
    return {
      childId: d.childId,
      shortId: shortId(d.childId),
      role: d.role,
      title: d.title,
      indent: Math.max(0, d.depth - 1),
      generation: d.generation,
      state: d.state,
      stateTone: stateTone(d.state),
      selected: routeText(d.selected, 'selected'),
      observed: routeText(d.observed, 'observed'),
      source: `model from ${SOURCE_TEXT[d.modelSource] ?? d.modelSource} · effort from ${SOURCE_TEXT[d.effortSource] ?? d.effortSource}`,
      match: d.routeMatch,
      matchText,
      matchTone: d.routeMatch === 'match' ? 'success' : d.routeMatch === 'mismatch' ? 'error' : 'neutral',
      ...opt('replaces', d.replaces === undefined ? undefined : shortId(d.replaces)),
      ...opt('stateNote', d.state === 'lost' ? 'lost after host restart, not restarted automatically' : undefined),
      ...opt('diagnostic', d.diagnostic),
      ...opt('escalation', d.escalation === undefined ? undefined : `asked to escalate: ${d.escalation.reason}`),
    }
  })
}

export interface ReviewRow {
  readonly key: string
  readonly verdict: string
  readonly verdictTone: Tone
  readonly subject: string
  readonly reviewer: string
  readonly reduced: boolean
  /** `cross-family` text, or the reduced-independence explanation. */
  readonly independence: string
  readonly findings: string
  readonly at: string
}

export function reviewRows(p: LedgerProjection): readonly ReviewRow[] {
  return p.reviews.map((r, i) => {
    const counts = (['blocker', 'major', 'minor'] as const)
      .map(sev => [sev, r.findings.filter(f => f.severity === sev).length] as const)
      .filter(([, n]) => n > 0)
      .map(([sev, n]) => `${n} ${sev}`)
    const excluded = r.excludedFamilies.length > 0 ? ` (excluded: ${r.excludedFamilies.join(', ')})` : ''
    return {
      key: `${r.reviewerChildId}:${r.at}:${i}`,
      verdict: r.verdict,
      verdictTone: r.verdict === 'pass' ? 'success' : r.verdict === 'blocked' ? 'error' : 'warn',
      subject: r.subject,
      reviewer: `${shortId(r.reviewerChildId)} · ${routeText(r.reviewerRoute, 'observed')}`,
      reduced: r.independence === 'reduced',
      independence: r.independence === 'reduced'
        ? `REDUCED INDEPENDENCE${r.independenceNote === undefined ? '' : `: ${r.independenceNote}`}${excluded}`
        : `cross-family review${excluded}`,
      findings: counts.length === 0 ? 'no findings' : counts.join(', '),
      at: r.at,
    }
  })
}

export interface LinkRow {
  readonly key: string
  readonly label: string
  /** Present only for `http:` / `https:` URLs; anything else renders as text. */
  readonly href?: string
}

export function safeHref(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  return /^https?:\/\//i.test(url.trim()) ? url.trim() : undefined
}

export function linkRows(p: LedgerProjection): readonly LinkRow[] {
  return p.links.map((l, i) => ({
    key: `${l.kind}:${l.ref}:${i}`,
    label: `${l.kind === 'pr' ? 'PR' : 'issue'} ${l.ref}`,
    ...opt('href', safeHref(l.url ?? l.ref)),
  }))
}

const SANDBOX_TEXT: Readonly<Record<string, string>> = {
  restored: 'sandbox restored',
  'default-written': 'sandbox reset to host default',
  'untouched-user-changed': 'sandbox left as you changed it',
  'not-clamped': 'sandbox never clamped',
  pending: 'sandbox restore pending (session not opened since upgrade)',
  failed: 'sandbox restore failed',
}

export function sandboxText(s: SandboxRestoreRecord): string {
  const base = SANDBOX_TEXT[s.state] ?? s.state
  const mode = s.mode === undefined ? '' : ` to ${s.mode}`
  const note = s.note === undefined ? '' : ` (${s.note})`
  return `${base}${s.state === 'restored' || s.state === 'default-written' ? mode : ''}${note}`
}

export interface LegacySummaryRow {
  readonly runId: string
  readonly text: string
  readonly sandbox: string
  readonly rejected: boolean
}

export function legacySummaryRows(runs: readonly LegacyRunSummary[]): readonly LegacySummaryRow[] {
  return runs.map((r) => {
    const rejected = r.fold === 'rejected'
    const text = rejected
      ? `run ${shortId(r.runId)} · could not be read${r.foldError === undefined ? '' : `: ${r.foldError}`} · ${r.eventCount} events`
      : [
        `run ${shortId(r.runId)}`,
        r.phase === undefined ? 'phase not recorded' : `phase ${r.phase}`,
        `${r.eventCount} events`,
        r.backend === 'domain' ? 'domain store' : 'file stream',
        ...(r.objective === undefined ? [] : [r.objective]),
      ].join(' · ')
    return { runId: r.runId, text, sandbox: sandboxText(r.sandboxRestore), rejected }
  })
}

/** Label/value lines for one archived legacy run. Read-only history, no gate semantics. */
export function legacyRunLines(r: LegacyRunProjection): readonly { readonly label: string; readonly text: string }[] {
  const lines: { label: string; text: string }[] = [
    { label: 'final phase', text: r.phase },
    { label: 'plan gate', text: r.planGate === '' ? 'not recorded' : r.planGate },
    { label: 'execution gate', text: r.executionGate === '' ? 'not recorded' : r.executionGate },
    { label: 'plan revision', text: String(r.planRevision) },
    { label: 'triage', text: [r.size, r.risk, r.executionMode, r.auditMode].filter(s => s !== '').join(' · ') || 'not recorded' },
    { label: 'audits', text: `${r.auditCount} audit${r.auditCount === 1 ? '' : 's'}, ${r.logCount} log entr${r.logCount === 1 ? 'y' : 'ies'}` },
  ]
  const verdicts = Object.entries(r.latestVerdicts)
  if (verdicts.length > 0) lines.push({ label: 'verdicts', text: verdicts.map(([k, v]) => `${k} ${v}`).join(', ') })
  if (r.executor !== undefined) lines.push({ label: 'executor', text: `${r.executor.state} · gen ${r.executor.generation}` })
  if (r.planAmendments !== undefined && r.planAmendments > 0) {
    lines.push({ label: 'plan amendments', text: `${r.planAmendments} amendment${r.planAmendments === 1 ? '' : 's'}` })
  }
  for (const [i, o] of (r.ownerResolutions ?? []).entries()) {
    lines.push({ label: i === 0 ? 'owner decisions' : '', text: o.at === undefined ? o.text : `${o.at}: ${o.text}` })
  }
  lines.push({ label: 'closeout', text: r.closeoutSubmitted ? 'submitted' : 'not submitted' })
  lines.push({ label: 'sandbox', text: sandboxText(r.sandboxRestore) })
  return lines
}

/** Shown above every legacy block: these runs no longer need anything. */
export const LEGACY_NOTE = 'Archived run from an earlier plugin version, shown read-only. Its gates and closeout are history; nothing here needs action.'

const LIVE_STATES: readonly DelegationState[] = ['starting', 'running']

/** Busy cadence while a child runs or the goal is active; quiet otherwise. Never stops. */
export function ledgerPollDelayMs(p: LedgerProjection | undefined): number {
  if (p === undefined) return LEDGER_QUIET_POLL_MS
  const busy = p.goal?.status?.trim() === 'active' || p.delegations.some(d => LIVE_STATES.includes(d.state))
  return busy ? LEDGER_BUSY_POLL_MS : LEDGER_QUIET_POLL_MS
}
