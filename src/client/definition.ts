/**
 * The `autopilot-run` conversation node definition — a PURE fold over root
 * session events that reconstructs one autopilot run card from the root
 * agent's `autopilot_*` tool traffic.
 *
 * WHY TOOL TRAFFIC AND NOT `autopilot/*` EVENTS. DESIGN.md §4 closes the
 * durable event vocabulary to out-of-tree plugins: dsh-autopilot writes NO
 * session events at all, and run state lives in files or the storage domain.
 * A definition that matched on `autopilot/*` would match nothing, forever.
 * What the session log DOES carry is `tool/call` and `tool/result` for the
 * eleven root-agent `autopilot_*` tools, both of which are in
 * `KNOWN_SESSION_EVENT_TYPES`. So the card is an honest record of WHAT THE
 * ROOT AGENT CALLED AND WHAT IT WAS TOLD — never a live view of run state.
 * The live view is the host route (`../web.ts`), a different surface.
 *
 * WHY THIS FILE HAS NO IMPORTS. Every type below is declared structurally
 * rather than imported from `@deepseek-ai/dsh-client-runtime/client`, for two
 * reasons that both matter:
 *
 *  1. those declarations live in a sibling dsh checkout reached through
 *     `tsconfig.client.json` `paths`, and this module must typecheck under
 *     `tsconfig.test.json` (NodeNext, no paths) so vitest can drive it;
 *  2. the reducer is the part with the invariants, and a pure module with no
 *     module-level state is the only shape that survives `replaceWindow`
 *     re-running `match()` over the same events on every resync.
 *
 * `src/client/index.ts` performs the one structural assignment to the real
 * `ConversationNodeDefinition<AutopilotRunState>`; if these shapes ever drift
 * from the contract, that assignment is where it fails, at compile time.
 *
 * @module dsh-autopilot/client/definition
 */

// ─────────────────────────────────────────────────────────────────────────────
// Structural mirrors of the host contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structural mirror of `SessionEvent`. Deliberately looser than the real
 * discriminated union: `SessionEvent` is assignable to this, which is all the
 * assignment in `index.ts` needs.
 */
export interface CardEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  /** Present only on the three surface-eligible types; `'append'` or a replace record. */
  readonly surfaceOp?: unknown
}

/** Structural mirror of `ConversationMatchResult`. */
export interface CardMatchResult {
  readonly id: string
  readonly role: 'start' | 'update'
}

/** Structural mirror of `ConversationMatch` (the subset the reducer reads). */
export interface CardMatch {
  readonly event: CardEvent
  readonly role: 'start' | 'update'
  readonly location: unknown
}

/** Structural mirror of `ConversationNodeContext<State>`. */
export interface CardContext<State> {
  readonly key: string
  readonly id: string
  readonly state: State | undefined
  readonly start: CardMatch | undefined
  readonly matches: readonly CardMatch[]
}

/** Structural mirror of `ChatConversationViewNode`. */
export interface CardViewNode {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly target: 'chat'
  readonly anchorSeq: number
  readonly location: unknown
  readonly visibility: 'visible' | 'hidden'
  readonly data: AutopilotRunChatData
}

// ─────────────────────────────────────────────────────────────────────────────
// Public card data
// ─────────────────────────────────────────────────────────────────────────────

/** A value the card OBSERVED, stamped with the run revision it was observed at. Never inferred. */
export interface Observed<T> {
  readonly value: T
  /** Run revision the observation carried, or 0 when the payload had none. */
  readonly revision: number
  /**
   * Seq of the `tool/result` that carried it.
   *
   * ABSENT when the observation came from the host route instead of the session
   * log (`./live.ts`), because that surface has no session sequence number.
   * Optional rather than `0`: a sentinel would attribute a polled answer to an
   * event that never happened, and the card prints this number in a tooltip
   * that says "observed at seq N". The renderer branches on its presence.
   */
  readonly seq?: number
}

/** One paired audit dispatch: `tool/call` arguments joined to the `AuditOutcome` by callId. */
export interface AutopilotAuditRow {
  readonly callId: string
  /** `tool/call` seq — timeline order. */
  readonly seq: number
  readonly time: number
  readonly kind: 'audit' | 'self-check'
  /** From the call arguments; `undefined` when the model omitted it. Never guessed. */
  readonly role: string | undefined
  /** False while the `tool/result` has not landed. */
  readonly settled: boolean
  readonly verdict?: string
  readonly note?: string
  readonly auditorId?: string
  readonly route?: Readonly<Record<string, unknown>>
  /** The result came back `isError: true`. */
  readonly failed: boolean
}

/** Triage as DECLARED AT INIT. Immutable per DESIGN §3; source is init's call arguments. */
export interface AutopilotTriageView {
  readonly objective?: string
  readonly acceptanceCriteria?: readonly string[]
  readonly nonGoals?: readonly string[]
  readonly scope?: readonly string[]
  readonly size?: string
  readonly risk?: string
  readonly executionMode?: string
  readonly auditMode?: string
  readonly touchesOperatingLayer?: boolean
  readonly usageIds?: readonly string[]
  readonly baseline?: {
    readonly branch?: string
    readonly commit?: string
    readonly dirty?: boolean
    readonly note?: string
  }
}

/** One observed `autopilot_*` dispatch, for the call strip. */
export interface AutopilotCallRow {
  readonly seq: number
  readonly time: number
  readonly name: string
  readonly failed: boolean
}

/** The renderer-facing payload. */
export interface AutopilotRunChatData {
  /** Only present when `autopilot_status` was called at least once. */
  readonly runId?: string
  /** Highest run revision any result carried; 0 when none did. */
  readonly revision: number
  readonly triage?: AutopilotTriageView
  readonly phase?: Observed<string>
  readonly planGate?: Observed<string>
  /** status-only. */
  readonly executionGate?: Observed<string>
  readonly planRevision?: Observed<number>
  /** status-only. Never re-derived from risk + touchesOperatingLayer — that duplicates a server rule. */
  readonly requiredRoles?: Observed<readonly string[]>
  /** status-only. */
  readonly replanBudgetRemaining?: Observed<number>
  /** status-only mirror of the engine's own latest-wins table. */
  readonly latestVerdicts?: Observed<Readonly<Record<string, string>>>
  readonly logCount?: Observed<number>
  readonly closeoutSubmitted?: Observed<boolean>
  readonly enforcement?: Observed<Readonly<Record<string, unknown>>>
  readonly executor?: Observed<Readonly<Record<string, unknown>>>
  /** Ascending by seq. */
  readonly audits: readonly AutopilotAuditRow[]
  /** Ascending by seq. */
  readonly calls: readonly AutopilotCallRow[]
  /**
   * True when the newest phase observation is older than the highest revision
   * seen. Drives a "gates may have moved" badge — the honest alternative to
   * inferring a gate from an audit verdict, which §3.2 proves unsound.
   */
  readonly stale: boolean
  /** Non-empty when `autopilot_init` was called more than once (the engine refused the later ones). */
  readonly reinitSeqs: readonly number[]
}

/** Internal reducer state. */
export interface AutopilotRunState {
  /** callId -> the autopilot tool that issued it. The discriminator for anonymous results. */
  readonly pending: ReadonlyMap<string, PendingCall>
  /** callId -> index into `data.audits`, so a late result patches the right row. */
  readonly auditIndex: ReadonlyMap<string, number>
  /** callId -> index into `data.calls`, so an error result marks the right row. */
  readonly callIndex: ReadonlyMap<string, number>
  readonly data: AutopilotRunChatData
  /** Seq of the first autopilot `tool/call` matched; undefined until one lands. */
  readonly firstSeq: number | undefined
  /** Location of that first match — the card's placement, NOT turn 1's. */
  readonly firstLocation: unknown
}

interface PendingCall {
  readonly name: string
  readonly seq: number
  readonly time: number
  readonly args: Record<string, unknown> | undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Tool-name prefix that identifies this plugin's controller surface. */
export const AUTOPILOT_PREFIX = 'autopilot_'

/** The card's kind — the chat renderer dispatch key and the slot registration key. */
export const AUTOPILOT_RUN_KIND = 'autopilot-run'

/**
 * The context id, a CONSTANT.
 *
 * One run IS one session: `engine.ts` binds `runId: root.id` and `init` refuses
 * a second run on the same session. So a per-session card needs exactly one
 * business identity, and a constant is the only value that cannot be produced
 * twice by `match()`, which has no history access.
 */
export const AUTOPILOT_RUN_ID = 'run'

/**
 * Local mirror of `isAppendSurfaceEvent`
 * (`packages/core/session/src/surface.ts:51`, which is
 * `isSurfaceEvent(event) && event.surfaceOp === 'append'`).
 *
 * Since dsh 0.1.2 this IS the production predicate: `@deepseek-ai/dsh-client-runtime`
 * (which used to re-export the host's function to the browser) was removed
 * upstream, and `@deepseek-ai/dsh-session`, where the function now lives, has
 * no browser entry. `src/client/index.ts` wires this mirror into the shipped
 * definition. The honest cost: a new `SurfaceOp` variant upstream would have to
 * be mirrored here by hand; the read is `surfaceOp === 'append'` on the three
 * surface event types, nothing more.
 */
export function isAppendSurfaceEventMirror(event: CardEvent): boolean {
  if (event.type !== 'user/message' && event.type !== 'assistant/message' && event.type !== 'tool/result') return false
  return event.surfaceOp === 'append'
}

// ─────────────────────────────────────────────────────────────────────────────
// Safe readers — a reducer must never throw; the assembler has no catch.
// ─────────────────────────────────────────────────────────────────────────────

/** JSON.parse that yields `undefined` instead of throwing, and only for plain objects. */
export function safeJsonObject(text: unknown): Record<string, unknown> | undefined {
  if (typeof text !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  return isPlainObject(parsed) ? parsed : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function strArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) if (typeof item === 'string') out.push(item)
  return out
}

function stringMap(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isPlainObject(value)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v
  return out
}

function observed<T>(value: T, revision: number, seq: number): Observed<T> {
  return { value, revision, seq }
}

// ─────────────────────────────────────────────────────────────────────────────
// Event field readers
// ─────────────────────────────────────────────────────────────────────────────

/** `tool/call` payload the reducer reads. */
export interface CallFields {
  readonly name: string
  readonly callId: string
  readonly args: Record<string, unknown> | undefined
}

/** Read a `tool/call` envelope; `undefined` when it is not a well-formed autopilot call. */
export function readCall(event: CardEvent): CallFields | undefined {
  if (!isPlainObject(event.data)) return undefined
  const name = str(event.data.name)
  const callId = str(event.data.callId)
  if (name === undefined || callId === undefined) return undefined
  if (!name.startsWith(AUTOPILOT_PREFIX)) return undefined
  return { name, callId, args: safeJsonObject(event.data.arguments) }
}

/**
 * `tool/code-dispatch-start` — the CALL analog when the host runs in PTC
 * (programmatic tool calling) mode.
 *
 * WHY THIS EXISTS, AND WHAT IT COST TO LEARN. In PTC the model does not call
 * `autopilot_*` directly: it calls `run_code`, and the code body calls
 * `tools.autopilot_init(...)`. The session log therefore carries a `tool/call`
 * whose `name` is `"run_code"` — which {@link readCall} correctly refuses — and
 * the REAL tool name appears only here. Measured on session
 * `session-32d85066-366b-45e0-bb27-6fe033fea285`: the card matched nothing,
 * `state.firstSeq` stayed undefined, `buildViewNode` returned null, and the
 * card was INVISIBLE for the entire run. Every bearer this reducer had was fed
 * direct-call envelopes, so nothing could see it.
 *
 * TWO DIFFERENCES FROM `tool/call`, both load-bearing:
 *
 *  1. **`arguments` is already a PARSED OBJECT**, not a JSON string. Running it
 *     through {@link safeJsonObject} would return `undefined` (that helper only
 *     accepts strings) and silently drop the triage block the card exists to
 *     show. It is read structurally instead.
 *  2. **The identity is `subCallId`**, not `callId`. One `run_code` call can
 *     dispatch several tools, and `rootCallId`/`parentCallId` are shared across
 *     all of them — keying on either would collapse sibling dispatches onto one
 *     pending entry. `subCallId` carries the `:code:N` discriminator.
 */
export interface DispatchCallFields {
  readonly name: string
  /** The per-dispatch identity; NOT rootCallId, which siblings share. */
  readonly subCallId: string
  /** Already parsed by the host. */
  readonly args: Record<string, unknown> | undefined
}

/**
 * The PTC dispatch envelope names, in BOTH spellings.
 *
 * dsh 0.1.7+ (session format v3+) writes `tool/ptc-dispatch-start` /
 * `tool/ptc-dispatch`; earlier hosts wrote `tool/code-dispatch-start` /
 * `tool/code-dispatch` (upstream `session-format-v2-to-v3` `renamePtcEvent`).
 * The payload fields are unchanged, so only the names differ. Both stay
 * accepted because 0.1.x hosts remain in this plugin's peer range; every match
 * site goes through these two predicates so a third spelling is one edit.
 */
export function isDispatchStartType(type: string): boolean {
  return type === 'tool/ptc-dispatch-start' || type === 'tool/code-dispatch-start'
}

/** Result-side twin of {@link isDispatchStartType}. */
export function isDispatchResultType(type: string): boolean {
  return type === 'tool/ptc-dispatch' || type === 'tool/code-dispatch'
}

/**
 * Read a `tool/code-dispatch-start` envelope.
 *
 * Unlike `tool/result`, this event NAMES its tool, so a foreign dispatch is
 * refused here rather than being matched and discriminated later by callId.
 *
 * @param event - the session event.
 * @returns the call fields, or `undefined` when this is not an autopilot dispatch.
 */
export function readDispatchStart(event: CardEvent): DispatchCallFields | undefined {
  if (!isPlainObject(event.data)) return undefined
  const name = str(event.data.name)
  const subCallId = str(event.data.subCallId)
  if (name === undefined || subCallId === undefined) return undefined
  if (!name.startsWith(AUTOPILOT_PREFIX)) return undefined
  // NOT safeJsonObject: the host hands this over already parsed.
  return { name, subCallId, args: isPlainObject(event.data.arguments) ? event.data.arguments : undefined }
}

/**
 * `tool/code-dispatch` — the RESULT analog under PTC.
 *
 * It repeats the start event's keys and adds the outcome. The return value IS
 * carried, at `data.content[0].text`, as a JSON string — a flatter path than
 * `tool/result`'s `message.content[0].content[0].text`, and read from the
 * captured events rather than assumed. The error flag is `isError`, spelled the
 * same as on the direct path but one level higher.
 */
export interface DispatchResultFields {
  readonly subCallId: string
  readonly isError: boolean
  readonly payload: Record<string, unknown> | undefined
}

/**
 * Read a `tool/code-dispatch` envelope.
 *
 * @param event - the session event.
 * @returns the result fields, or `undefined` when this is not an autopilot dispatch.
 */
export function readDispatch(event: CardEvent): DispatchResultFields | undefined {
  if (!isPlainObject(event.data)) return undefined
  const name = str(event.data.name)
  const subCallId = str(event.data.subCallId)
  if (name === undefined || subCallId === undefined) return undefined
  if (!name.startsWith(AUTOPILOT_PREFIX)) return undefined
  const isError = event.data.isError === true
  const block = Array.isArray(event.data.content) ? event.data.content[0] : undefined
  const text = isPlainObject(block) ? block.text : undefined
  return { subCallId, isError, payload: isError ? undefined : safeJsonObject(text) }
}

/** `tool/result` payload the reducer reads. */
export interface ResultFields {
  readonly callId: string
  readonly isError: boolean
  readonly payload: Record<string, unknown> | undefined
}

/**
 * Read a `tool/result` envelope.
 *
 * The path is exact and measured against real logs:
 * `data.message.source.callId`, `data.message.content[0].isError`,
 * `data.message.content[0].content[0].text`. `data.message.source.kind` is
 * `'tool'` for EVERY tool result, autopilot or not, so it is not a
 * discriminator — the callId table is.
 */
export function readResult(event: CardEvent): ResultFields | undefined {
  if (!isPlainObject(event.data)) return undefined
  const message = event.data.message
  if (!isPlainObject(message)) return undefined
  const source = message.source
  if (!isPlainObject(source)) return undefined
  const callId = str(source.callId)
  if (callId === undefined) return undefined
  const content = message.content
  const block = Array.isArray(content) ? content[0] : undefined
  if (!isPlainObject(block)) return { callId, isError: false, payload: undefined }
  const isError = block.isError === true
  const inner = Array.isArray(block.content) ? block.content[0] : undefined
  const text = isPlainObject(inner) ? inner.text : undefined
  return { callId, isError, payload: isError ? undefined : safeJsonObject(text) }
}

// ─────────────────────────────────────────────────────────────────────────────
// The reducer
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_DATA: AutopilotRunChatData = {
  revision: 0,
  audits: [],
  calls: [],
  stale: false,
  reinitSeqs: [],
}

/** A fresh state. Never `undefined` — `requireState` throws on that. */
export function emptyState(): AutopilotRunState {
  return {
    pending: new Map(),
    auditIndex: new Map(),
    callIndex: new Map(),
    data: EMPTY_DATA,
    firstSeq: undefined,
    firstLocation: undefined,
  }
}

/** Recompute the honest staleness badge: the newest phase observation vs. the newest revision. */
function withStale(data: AutopilotRunChatData): AutopilotRunChatData {
  const stale = data.revision > (data.phase?.revision ?? 0)
  return stale === data.stale ? data : { ...data, stale }
}

/**
 * Fold one autopilot invocation into the state — from EITHER envelope family.
 *
 * `tool/call` (direct) and a PTC dispatch-start ({@link isDispatchStartType}) are normalized to
 * the same three fields here and folded by one body. That sameness is the
 * point: a second copy of this fold for the PTC path could only be held level
 * with this one by a test, and the defect that made this function necessary was
 * precisely a path with no bearer.
 */
export function applyCall(state: AutopilotRunState, match: CardMatch): AutopilotRunState {
  const event = match.event
  const call = isDispatchStartType(event.type)
    ? asCall(readDispatchStart(event))
    : readCall(event)
  if (call === undefined) return state

  const pending = new Map(state.pending)
  pending.set(call.callId, { name: call.name, seq: event.seq, time: event.time, args: call.args })

  const callIndex = new Map(state.callIndex)
  const calls = [...state.data.calls, { seq: event.seq, time: event.time, name: call.name, failed: false }]
  callIndex.set(call.callId, calls.length - 1)

  let data: AutopilotRunChatData = { ...state.data, calls }
  const auditIndex = new Map(state.auditIndex)

  if (call.name === 'autopilot_init') {
    if (data.triage === undefined) {
      // First init wins. The engine refuses every later one (AP_ALREADY_ACTIVE
      // / AP_RUN_EXHAUSTED), but the tool/call event is appended BEFORE the
      // engine ever runs, so the later calls reach us regardless.
      const triage = readTriage(call.args)
      if (triage !== undefined) data = { ...data, triage }
    } else {
      data = { ...data, reinitSeqs: [...data.reinitSeqs, event.seq] }
    }
  }

  if (call.name === 'autopilot_audit' || call.name === 'autopilot_self_check') {
    const row: AutopilotAuditRow = {
      callId: call.callId,
      seq: event.seq,
      time: event.time,
      kind: call.name === 'autopilot_self_check' ? 'self-check' : 'audit',
      role: str(call.args?.role),
      settled: false,
      failed: false,
    }
    data = { ...data, audits: [...data.audits, row] }
    auditIndex.set(call.callId, data.audits.length - 1)
  }

  return {
    pending,
    auditIndex,
    callIndex,
    data: withStale(data),
    firstSeq: state.firstSeq ?? event.seq,
    firstLocation: state.firstSeq === undefined ? match.location : state.firstLocation,
  }
}

/** Normalize a PTC dispatch-start into the shape {@link applyCall} folds. */
function asCall(fields: DispatchCallFields | undefined): CallFields | undefined {
  // The subCallId BECOMES the callId for the whole pending/audit/call index
  // machinery. Those tables only ever need an identity that is unique per
  // invocation and matched by its completion event, and subCallId is both.
  return fields === undefined ? undefined : { name: fields.name, callId: fields.subCallId, args: fields.args }
}

/** Normalize a PTC dispatch completion into the shape {@link applyResult} folds. */
function asResult(fields: DispatchResultFields | undefined): ResultFields | undefined {
  return fields === undefined
    ? undefined
    : { callId: fields.subCallId, isError: fields.isError, payload: fields.payload }
}

/** Read the immutable triage block out of `autopilot_init`'s call arguments. */
function readTriage(args: Record<string, unknown> | undefined): AutopilotTriageView | undefined {
  if (args === undefined) return undefined
  const baseline = isPlainObject(args.baseline) ? args.baseline : undefined
  const view: AutopilotTriageView = {
    ...optional('objective', str(args.objective)),
    ...optional('acceptanceCriteria', strArray(args.acceptanceCriteria)),
    ...optional('nonGoals', strArray(args.nonGoals)),
    ...optional('scope', strArray(args.scope)),
    ...optional('size', str(args.size)),
    ...optional('risk', str(args.risk)),
    ...optional('executionMode', str(args.executionMode)),
    ...optional('auditMode', str(args.auditMode)),
    ...optional('touchesOperatingLayer', bool(args.touchesOperatingLayer)),
    ...optional('usageIds', strArray(args.usageIds)),
    ...optional('baseline', {
      ...optional('branch', str(baseline?.branch ?? args.baselineBranch)),
      ...optional('commit', str(baseline?.commit ?? args.baselineCommit)),
      ...optional('dirty', bool(baseline?.dirty ?? args.baselineDirty)),
      ...optional('note', str(baseline?.note ?? args.baselineNote)),
    }),
  }
  return Object.keys(view).length === 0 ? undefined : view
}

function optional<K extends string, T>(key: K, value: T | undefined): Record<K, T> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, T>)
}

/**
 * Fold one `tool/result` into the state.
 *
 * `match` accepts EVERY append-surface `tool/result` because the envelope
 * carries no tool name. This function is the discriminator: a callId the
 * pending table does not know belongs to some other tool and is dropped
 * without touching `data`.
 */
export function applyResult(state: AutopilotRunState, match: CardMatch): AutopilotRunState {
  const event = match.event
  const result = isDispatchResultType(event.type)
    ? asResult(readDispatch(event))
    : readResult(event)
  if (result === undefined) return state
  const call = state.pending.get(result.callId)
  // ← drops every non-autopilot result, AND the PTC wrapper's own `tool/result`.
  // In PTC the run_code call produces an ordinary `tool/result` carrying the
  // ROOT callId and the same JSON body the dispatch already delivered. It is
  // dropped here because the pending table is keyed by subCallId, which is what
  // keeps one logical invocation from being counted twice — once as a dispatch
  // and once as its wrapper's result.
  if (call === undefined) return state

  const pending = new Map(state.pending)
  pending.delete(result.callId)

  let data = state.data

  if (result.isError) {
    data = markCallFailed(data, state.callIndex.get(result.callId))
    const auditAt = state.auditIndex.get(result.callId)
    if (auditAt !== undefined) {
      data = patchAudit(data, auditAt, { settled: true, failed: true })
    }
    return { ...state, pending, data: withStale(data) }
  }

  const payload = result.payload
  if (payload === undefined) return { ...state, pending, data }

  const seq = event.seq
  const revision = num(payload.revision) ?? 0
  if (revision > data.revision) data = { ...data, revision }

  // THE RUN ID IS READ FROM ANY RESULT, not only from `autopilot_status`.
  // It used to be status-only, which was true to what the engine sent at the
  // time and left the card reporting "run id not reported" for every session
  // that never called status — measured live in M7, where it also disabled the
  // live poll. The engine's trimmed results now carry `runId`, and a reader
  // that only looked for it in one of them would keep the old behaviour for no
  // reason. First one wins; they cannot legally disagree, since a run's id is
  // immutable for the life of the stream.
  const anyRunId = str(payload.runId)
  if (anyRunId !== undefined && anyRunId.length > 0 && data.runId === undefined) {
    data = { ...data, runId: anyRunId }
  }

  // ── Fields any tool result may carry ──────────────────────────────────
  data = merge(data, 'phase', str(payload.phase), revision, seq)
  data = merge(data, 'planGate', str(payload.planGate), revision, seq)
  data = merge(data, 'planRevision', num(payload.planRevision), revision, seq)
  data = merge(data, 'logCount', num(payload.logCount), revision, seq)
  if (isPlainObject(payload.enforcement)) {
    data = merge(data, 'enforcement', payload.enforcement as Readonly<Record<string, unknown>>, revision, seq)
  }
  if (isPlainObject(payload.executor)) {
    data = merge(data, 'executor', mergeExecutor(data.executor?.value, payload.executor), revision, seq)
  }

  if (call.name === 'autopilot_status') {
    const runId = str(payload.runId)
    if (runId !== undefined && data.runId !== runId) data = { ...data, runId }
    data = merge(data, 'executionGate', str(payload.executionGate), revision, seq)
    data = merge(data, 'requiredRoles', strArray(payload.requiredRoles), revision, seq)
    data = merge(data, 'replanBudgetRemaining', num(payload.replanBudgetRemaining), revision, seq)
    data = merge(data, 'latestVerdicts', stringMap(payload.latestVerdicts), revision, seq)
    data = merge(data, 'closeoutSubmitted', bool(payload.closeoutSubmitted), revision, seq)
    // `status` mirrors five triage fields, but init's ARGUMENTS are strictly
    // richer (acceptanceCriteria, scope, nonGoals, baseline, usageIds are not
    // in StatusView at all) and are immutable per DESIGN §3. So status only
    // fills keys init never supplied.
    data = backfillTriage(data, payload)
  }

  if (call.name === 'autopilot_submit_closeout' && payload.phase === 'completed') {
    data = merge(data, 'closeoutSubmitted', true, revision, seq)
  }

  if (call.name === 'autopilot_audit' || call.name === 'autopilot_self_check') {
    const at = state.auditIndex.get(result.callId)
    if (at !== undefined) {
      // DELIBERATELY does not touch phase/planGate/executionGate. AuditOutcome
      // carries none of them, and inferring `verdict:'pass' -> gate:'pass'` is
      // UNSOUND: `applyVerdict` records a plan pass while REFUSING the gate flip
      // when a usage entry is still `undeclared`, and a `needs-replan` past
      // MAX_REPLAN_ROUNDS yields `needs-owner-decision`, not `needs-replan`.
      data = patchAudit(data, at, {
        settled: true,
        ...optional('verdict', str(payload.verdict)),
        ...optional('note', str(payload.note)),
        ...optional('auditorId', str(payload.auditorId)),
        ...optional('route', isPlainObject(payload.route) ? (payload.route as Readonly<Record<string, unknown>>) : undefined),
      })
    }
  }

  if (call.name === 'autopilot_signal' && Array.isArray(payload.approvals) && data.enforcement !== undefined) {
    data = merge(
      data,
      'enforcement',
      { ...data.enforcement.value, ownerApprovals: payload.approvals },
      revision,
      seq,
    )
  }

  return { ...state, pending, data: withStale(data) }
}

/**
 * Fold a new executor observation over the previous one.
 *
 * The two sources are ASYMMETRIC and both are real: `autopilot_executor`
 * returns the full `ExecutorRecord` (childId, generation, executionRevision,
 * state, route), while `StatusView.executor` carries only `{generation,
 * state}`. Measured on `session-61a05524`: the full record lands at seq 711 and
 * FOUR later `autopilot_status` results carry the partial one, so a wholesale
 * replace silently drops the childId the card exists to show.
 *
 * A blind merge is equally wrong: `generation` increments on each needs-fix
 * resume and the childId changes with it, so carrying a childId across a
 * generation bump would attribute one child's id to another. The rule is
 * therefore: keep the earlier fields only while `generation` still matches.
 *
 * @param previous - the last observed executor record, if any.
 * @param next - the record this result carried.
 * @returns the merged record.
 */
function mergeExecutor(
  previous: Readonly<Record<string, unknown>> | undefined,
  next: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  if (previous === undefined) return next
  if (next.childId !== undefined) return next
  if (previous.generation !== next.generation) return next
  return { ...previous, ...next }
}

/** Publish one observation, leaving `data` untouched when the value is absent. */
function merge<K extends keyof AutopilotRunChatData & string, T>(
  data: AutopilotRunChatData,
  key: K,
  value: T | undefined,
  revision: number,
  seq: number,
): AutopilotRunChatData {
  if (value === undefined) return data
  return { ...data, [key]: observed(value, revision, seq) } as AutopilotRunChatData
}

/** Fill only the triage keys init never supplied. */
function backfillTriage(data: AutopilotRunChatData, payload: Record<string, unknown>): AutopilotRunChatData {
  const current: AutopilotTriageView = data.triage ?? {}
  const next: AutopilotTriageView = {
    ...optional('objective', str(payload.objective)),
    ...optional('size', str(payload.size)),
    ...optional('risk', str(payload.risk)),
    ...optional('executionMode', str(payload.executionMode)),
    ...optional('auditMode', str(payload.auditMode)),
    ...current, // init args LAST: they win every key they supplied.
  }
  return Object.keys(next).length === 0 ? data : { ...data, triage: next }
}

function markCallFailed(data: AutopilotRunChatData, at: number | undefined): AutopilotRunChatData {
  if (at === undefined) return data
  const row = data.calls[at]
  if (row === undefined || row.failed) return data
  const calls = [...data.calls]
  calls[at] = { ...row, failed: true }
  return { ...data, calls }
}

function patchAudit(
  data: AutopilotRunChatData,
  at: number,
  patch: Partial<AutopilotAuditRow>,
): AutopilotRunChatData {
  const row = data.audits[at]
  if (row === undefined) return data
  const audits = [...data.audits]
  audits[at] = { ...row, ...patch }
  return { ...data, audits }
}

// ─────────────────────────────────────────────────────────────────────────────
// The definition
// ─────────────────────────────────────────────────────────────────────────────

/** Injected host predicates; production supplies the real client-runtime exports. */
export interface CardDeps {
  /**
   * The host's own `isAppendSurfaceEvent`.
   *
   * LOAD-BEARING, not decoration. After a compaction, replaced surface copies
   * of earlier `tool/result` events re-enter the log with an object
   * `surfaceOp`. Without this guard the fold would apply an
   * `autopilot_log` result twice on resume and once live — a live/resume
   * divergence in a reducer whose entire correctness claim is that
   * `replaceWindow` and `append` produce identical state.
   */
  readonly isAppendSurfaceEvent: (event: CardEvent) => boolean
}

/** The definition object, structurally a `ConversationNodeDefinition<AutopilotRunState>`. */
export interface AutopilotRunDefinition {
  readonly kind: string
  readonly target: string
  match: (event: CardEvent) => CardMatchResult | null
  start: () => AutopilotRunState
  update: (context: CardContext<AutopilotRunState> & { readonly state: AutopilotRunState }, match: CardMatch) => AutopilotRunState
  publication: (match: CardMatch) => 'none' | 'animation-frame' | 'immediate'
  buildViewNode: (context: CardContext<AutopilotRunState>) => CardViewNode | null
}

/**
 * Build the definition.
 *
 * THE START IS `turn/start` WHERE `data.turn === 1`, NOT `autopilot_init`.
 * `acceptMatch` throws on a second start and on a start arriving after an
 * update, and both shapes occur in real logs: 8 of 55 sessions with autopilot
 * traffic log TWO `autopilot_init` calls (the engine refuses the second, but
 * the event is appended before the engine runs), and at least one logs
 * `autopilot_status` at seq 22 BEFORE the first `autopilot_init` at seq 137.
 * Anchoring on `autopilot_init` therefore takes the whole conversation view
 * down. Turn 1's `turn/start` is measured exactly once per session in 55/55
 * and precedes every `autopilot_*` call in 55/55, so it is at-most-once and
 * lowest-seq by construction. `match()` has no history access, and a
 * module-level counter would break `replaceWindow` determinism, so a
 * measured-invariant anchor is the only sound one.
 */
export function createAutopilotRunDefinition(deps: CardDeps): AutopilotRunDefinition {
  /**
   * Last node handed out per context key, with the two inputs it was built
   * from.
   *
   * WHY A CACHE HERE. `match()` claims EVERY append-surface `tool/result`,
   * because the envelope carries no tool name and only `applyResult` can
   * discriminate on the callId. That is correct and cannot be narrowed — but it
   * means a session doing ordinary file edits drives this definition's
   * `buildViewNode` on every foreign tool result, and the old body allocated a
   * fresh object literal every time. `chat-snapshot-builder` compares
   * contributions by REFERENCE, so a new-but-identical node re-rendered the
   * card for traffic that had nothing to do with the run.
   *
   * WHY IT IS SAFE FOR A PURE REDUCER. The state is immutable and rebuilt by
   * `applyCall`/`applyResult`, which return the SAME object when nothing
   * changed — so reference equality on `state` is exactly "no observation
   * landed". This closure lives in the definition instance, not at module
   * scope: `replaceWindow` re-running `match()` over the same events rebuilds
   * state objects and simply misses the cache, which costs one allocation and
   * cannot produce a wrong node.
   *
   * WHY THE LOCATION IS PART OF THE KEY. `buildViewNode` falls back to
   * `context.start?.location` when `state.firstLocation` is undefined, so two
   * calls with identical state and different starts must NOT share a node —
   * the card would render at the wrong anchor. Keying on the resolved location
   * INPUT (before the `{kind:'unresolved'}` fallback, which allocates) keeps
   * that fallback stable across calls too.
   */
  const built = new Map<string, { state: AutopilotRunState; location: unknown; node: CardViewNode }>()

  return {
    kind: AUTOPILOT_RUN_KIND,
    target: 'chat',

    match: (event) => {
      if (event.type === 'turn/start') {
        const data = event.data
        if (isPlainObject(data) && data.turn === 1) return { id: AUTOPILOT_RUN_ID, role: 'start' }
        return null
      }
      if (event.type === 'tool/call') {
        return readCall(event) === undefined ? null : { id: AUTOPILOT_RUN_ID, role: 'update' }
      }
      if (event.type === 'tool/result' && deps.isAppendSurfaceEvent(event)) {
        // The envelope carries no tool name; applyResult discriminates on callId.
        return { id: AUTOPILOT_RUN_ID, role: 'update' }
      }
      // THE PTC PAIR. Both name their tool, so both are filtered HERE rather
      // than matched broadly and discriminated later — the opposite of the
      // `tool/result` line above, and better: a foreign dispatch never enters
      // `context.matches` and never schedules a publication.
      //
      // NO SURFACE GUARD ON THESE. `isAppendSurfaceEvent` is defined over
      // user/assistant messages and `tool/result` only, so applying it here
      // would refuse every dispatch event — the captured ones carry no
      // `surfaceOp` at all. That mirrors `tool/call`, which is also unguarded,
      // and the fold stays idempotent for the same reason it does there: a
      // repeated completion for an already-consumed subCallId finds no pending
      // entry and returns the state object unchanged.
      if (isDispatchStartType(event.type)) {
        return readDispatchStart(event) === undefined ? null : { id: AUTOPILOT_RUN_ID, role: 'update' }
      }
      if (isDispatchResultType(event.type)) {
        return readDispatch(event) === undefined ? null : { id: AUTOPILOT_RUN_ID, role: 'update' }
      }
      return null
    },

    start: () => emptyState(),

    update: (context, match) => {
      const type = match.event.type
      if (type === 'tool/call' || isDispatchStartType(type)) return applyCall(context.state, match)
      if (type === 'tool/result' || isDispatchResultType(type)) return applyResult(context.state, match)
      return context.state
    },

    // `tool/result` matches EVERY tool in the session, so an unrelated tool must
    // not force a synchronous view rebuild.
    //
    // A PTC dispatch-start is a CALL and gets the call cadence: it is the first
    // moment the card can know an autopilot tool is running, and in PTC it is
    // the ONLY such moment — the wrapping `tool/call` says `run_code`.
    // `tool/code-dispatch` keeps the completion cadence. It could safely be
    // immediate, since match() already filtered it by name and it is not the
    // noisy surface `tool/result` is; the completion cadence is kept uniform
    // deliberately, so "a result lands on an animation frame" stays one rule
    // rather than two.
    publication: (match) => (
      match.event.type === 'tool/call' || isDispatchStartType(match.event.type)
        ? 'immediate'
        : 'animation-frame'
    ),

    buildViewNode: (context) => {
      const state = context.state
      // REQUIRED: flush's replace path calls buildViewNode for EVERY context,
      // including one whose start fell outside a truncated window and therefore
      // has no state at all.
      if (state === undefined) return null
      // No autopilot traffic in this session: the card must not appear at all.
      if (state.firstSeq === undefined) return null

      // Both inputs, resolved before the allocating fallback below.
      const location = state.firstLocation ?? context.start?.location
      const previous = built.get(context.key)
      if (previous !== undefined && previous.state === state && previous.location === location) {
        return previous.node
      }

      const node: CardViewNode = {
        key: context.key,
        kind: AUTOPILOT_RUN_KIND,
        id: context.id,
        target: 'chat',
        // Placement is the FIRST AUTOPILOT CALL, not turn 1: a run that starts
        // in turn 5 of a long session must not render its card at the top.
        anchorSeq: state.firstSeq,
        location: location ?? { kind: 'unresolved' },
        visibility: 'visible',
        data: state.data,
      }
      built.set(context.key, { state, location, node })
      return node
    },
  }
}
