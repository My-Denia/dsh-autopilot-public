/**
 * The card's LIVE half: polling `/api/autopilot/run?id=` and folding the answer
 * over the session-log reconstruction.
 *
 * WHY THIS EXISTS AT ALL. `./definition.ts` reconstructs the card from the root
 * session's `autopilot_*` tool traffic, and that reconstruction is already live
 * for anything the model does — every tool call and result re-renders it. What
 * it cannot see is a run advancing with NO tool call in this session: a headless
 * process driving the run while a browser watches. The card's own `stale` badge
 * marks exactly that gap ("the run advanced past the newest phase observation")
 * and, until now, the only way to close it was to reload the page. The host
 * route (`../web.ts`) has always been able to answer the question; nothing was
 * asking it.
 *
 * WHY A SEPARATE, FRAMEWORK-FREE MODULE. Everything here is a pure function
 * over plain values, so vitest can drive it directly — `react` is a
 * host-provided external that is NOT a dependency of this package, so a test
 * cannot mount a component. The hook in `./AutopilotRunCard.tsx` is therefore
 * kept to the smallest possible shell (a timer and two state slots) and every
 * decision it makes — whether to poll, how often, what a response means,
 * whether the answer changes anything — is made by a function in this file that
 * a test can call. That split is what makes the poll's gating testable rather
 * than merely reviewable.
 *
 * NO DOM TYPES ARE NAMED HERE. `fetch`, `Response` and `AbortSignal` live in
 * the `DOM` lib, which `tsconfig.client.json` has and `tsconfig.test.json`
 * (NodeNext, `lib: ES2022`) does not. {@link LiveFetch} is the structural
 * minimum this module actually uses, so the same source typechecks under both
 * gates and the caller supplies the real `fetch`.
 *
 * @module dsh-autopilot/client/live
 */

import type { AutopilotRunChatData, Observed } from './definition.js'

/**
 * Terminal phases, mirrored from `../domain/types.js`.
 *
 * A LOCAL COPY, deliberately: `tsconfig.client.json` includes `src/client`
 * only, so the browser half cannot import the host half — that separation is
 * what keeps `node:fs` and the engine out of the bundle. The cost is this
 * constant, and the cost is real: if the host ever adds a third terminal phase,
 * a card polling a run in it would keep polling forever. That is bounded (a
 * request every few seconds against a run that has stopped changing) rather
 * than incorrect, and it is the reason the poll ALSO stops on an unchanged
 * revision streak; see {@link pollDelayMs}.
 */
export const TERMINAL_PHASES: readonly string[] = ['completed', 'blocked']

/** Same-origin route the card polls; the host mounts it in `../web.ts`. */
export const RUN_ROUTE = '/api/autopilot/run'

/** Floor for the poll interval. Never lower this without a measurement. */
export const MIN_POLL_MS = 2000

/** Cadence while the fold says the card may be behind. */
export const STALE_POLL_MS = MIN_POLL_MS

/** Cadence while the fold looks current — still polled, just less eagerly. */
export const STEADY_POLL_MS = 8000

/**
 * The projection served by `GET /api/autopilot/run?id=` — the fields the card
 * shows, and nothing else.
 *
 * This is a STRUCTURAL mirror of `RunProjection` in `../web.ts`, not an import,
 * for the same reason `./definition.ts` mirrors the host's event shapes: the
 * browser half must typecheck under `tsconfig.client.json`, which cannot see
 * the host half. Every field is re-validated at runtime by {@link readLiveRun}
 * anyway, because what arrives is JSON off a socket, not a typed value.
 */
export interface LiveRun {
  readonly runId: string
  readonly revision: number
  readonly phase: string
  readonly planGate?: string
  readonly executionGate?: string
  readonly planRevision?: number
  readonly requiredRoles?: readonly string[]
  readonly replanBudgetRemaining?: number
  readonly logCount?: number
  readonly closeoutSubmitted?: boolean
  readonly latestVerdicts?: Readonly<Record<string, string>>
  readonly executor?: Readonly<Record<string, unknown>>
  readonly enforcement?: Readonly<Record<string, unknown>>
}

/**
 * The narrowest shape of `fetch` this module uses.
 *
 * `ok` is read rather than `status` because the card treats every non-2xx the
 * same way — as "no answer this time" — and a card has no business branching on
 * 404 vs 500. See {@link fetchLiveRun}.
 */
export type LiveFetch = (url: string) => Promise<{ readonly ok: boolean; json(): Promise<unknown> }>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Build the URL for one run id.
 *
 * The id is percent-encoded: run ids are session ids today, but the encoding is
 * not there for today's alphabet — an id containing `&` or `#` would otherwise
 * truncate the query and the card would silently poll a DIFFERENT run.
 *
 * @param runId - the run to ask about.
 * @returns a same-origin, absolute-path URL.
 */
export function runRouteUrl(runId: string): string {
  return `${RUN_ROUTE}?id=${encodeURIComponent(runId)}`
}

/** True when the phase is one no operation can follow. */
export function isTerminalPhase(phase: string | undefined): boolean {
  return phase !== undefined && TERMINAL_PHASES.includes(phase)
}

/**
 * The phase the card is currently SHOWING — live if there is a live answer,
 * otherwise the folded observation. The poll gate is asked about this one,
 * because a run that reached `completed` through the route must stop being
 * polled even though the session log never saw it happen.
 */
export function displayedPhase(data: AutopilotRunChatData, live: LiveRun | undefined): string | undefined {
  return live?.phase ?? data.phase?.value
}

/**
 * The id to poll for, or `undefined` when there is nothing to ask about.
 *
 * WHY A SESSION-ID FALLBACK EXISTS, AND WHY IT IS SOUND RATHER THAN A GUESS.
 * The first version of this gate required `data.runId`, which the fold only
 * learns from an `autopilot_status` result — and M7 measured the consequence on
 * a real run: the engine's trimmed tool results carried no `runId` at all
 * (`{"revision":1,"phase":"planning","enforcement":{…}}`), so the card reported
 * "run id not reported", this gate returned false, the poll never started, and
 * an out-of-band advance from revision 2 to 3 went unnoticed for the whole
 * session. That is the SAME defect species the plan audit caught for `stale`:
 * a gate keyed to a signal the channel does not reliably deliver.
 *
 * The fallback is sound by construction, not by heuristic: `AutopilotEngine`
 * binds `runId: root.id` at init, so a run's id IS its root session id. The
 * card renders inside that session's own view and receives `sessionId` from the
 * session-scoped slot kit, so polling it asks about exactly the run rooted
 * here. When this session has no run, the route answers 404 and
 * {@link fetchLiveRun} turns that into `undefined` — silent, no state change,
 * no worse than not polling. That is also what makes the fallback safe in a
 * CHILD session (an executor or auditor child has its own session id and is not
 * a run root): it asks, gets nothing, and stays quiet.
 *
 * The fold's answer is still PREFERRED when present, because a card whose
 * traffic named a run should follow that run even if the two ever diverge.
 *
 * @param data - the folded card data.
 * @param sessionId - the session this card is rendered in, if the host supplied it.
 * @returns the id to poll, or undefined.
 */
export function pollKey(data: AutopilotRunChatData, sessionId?: string | undefined): string | undefined {
  const fromFold = data.runId?.trim()
  if (fromFold !== undefined && fromFold.length > 0) return fromFold
  const fromSession = sessionId?.trim()
  return fromSession !== undefined && fromSession.length > 0 ? fromSession : undefined
}

/**
 * Whether to poll at all.
 *
 * THE GATE IS "NOT TERMINAL", NOT "STALE". An earlier draft gated on the
 * `stale` badge, which is wrong in the one case the whole feature exists for:
 * `stale` is computed from the SESSION LOG (highest revision seen vs. newest
 * phase observation), so a session whose log carries no new events never
 * recomputes it, and the badge can stay false for the entire time the run is
 * advancing elsewhere. Gating on it would mean the card polls exactly when it
 * already knows it is behind and stays quiet when it has no idea. Staleness
 * accelerates the cadence instead ({@link pollDelayMs}).
 *
 * An id is required because the route is keyed by one — see {@link pollKey} for
 * why that id no longer has to come from the session log.
 *
 * @param data - the folded card data.
 * @param live - the newest live answer, if one has landed.
 * @param sessionId - the session this card is rendered in, if the host supplied it.
 * @returns true when a poll is warranted.
 */
export function shouldPoll(
  data: AutopilotRunChatData,
  live?: LiveRun | undefined,
  sessionId?: string | undefined,
): boolean {
  if (pollKey(data, sessionId) === undefined) return false
  return !isTerminalPhase(displayedPhase(data, live))
}

/**
 * How long to wait before the next poll.
 *
 * Staleness is an ACCELERATOR, not the gate: when the fold already suspects it
 * is behind, ask at the floor; otherwise ask at a slower steady rate. Both are
 * at or above {@link MIN_POLL_MS}, which is the floor a browser tab full of
 * cards has to live with.
 *
 * @param data - the folded card data.
 * @returns milliseconds until the next poll.
 */
export function pollDelayMs(data: AutopilotRunChatData): number {
  return data.stale ? STALE_POLL_MS : STEADY_POLL_MS
}

/**
 * Read the route's body into a {@link LiveRun}, or `undefined` when it is not
 * one.
 *
 * TOTAL AND SILENT BY DESIGN. This runs inside a render loop with no error
 * boundary of its own, and the card's contract is that a failed poll leaves it
 * exactly as good as it was before polling existed. So a 404 body, an error
 * body, a truncated payload, a proxy's HTML error page — all become
 * `undefined`, which the caller treats as "no news".
 *
 * `runId` and `revision` are the two fields that must be present and
 * well-typed: without the first the answer cannot be attributed to a run, and
 * without the second it cannot be compared with what the card already shows.
 * Everything else is optional and simply omitted when absent — never defaulted,
 * because a defaulted gate value would be a claim the route never made.
 *
 * @param body - the parsed response body.
 * @returns the run projection, or undefined.
 */
export function readLiveRun(body: unknown): LiveRun | undefined {
  if (!isPlainObject(body) || body.ok !== true) return undefined
  const run = body.run
  if (!isPlainObject(run)) return undefined
  const runId = str(run.runId)
  const revision = num(run.revision)
  const phase = str(run.phase)
  if (runId === undefined || revision === undefined || phase === undefined) return undefined
  const roles = Array.isArray(run.requiredRoles)
    ? run.requiredRoles.filter((role): role is string => typeof role === 'string')
    : undefined
  const verdicts = isPlainObject(run.latestVerdicts)
    ? Object.fromEntries(Object.entries(run.latestVerdicts).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    : undefined
  return {
    runId,
    revision,
    phase,
    ...(str(run.planGate) === undefined ? {} : { planGate: str(run.planGate) as string }),
    ...(str(run.executionGate) === undefined ? {} : { executionGate: str(run.executionGate) as string }),
    ...(num(run.planRevision) === undefined ? {} : { planRevision: num(run.planRevision) as number }),
    ...(roles === undefined ? {} : { requiredRoles: roles }),
    ...(num(run.replanBudgetRemaining) === undefined ? {} : { replanBudgetRemaining: num(run.replanBudgetRemaining) as number }),
    ...(num(run.logCount) === undefined ? {} : { logCount: num(run.logCount) as number }),
    ...(typeof run.closeoutSubmitted === 'boolean' ? { closeoutSubmitted: run.closeoutSubmitted } : {}),
    ...(verdicts === undefined ? {} : { latestVerdicts: verdicts }),
    ...(isPlainObject(run.executor) ? { executor: run.executor } : {}),
    ...(isPlainObject(run.enforcement) ? { enforcement: run.enforcement } : {}),
  }
}

/**
 * Ask the host route once.
 *
 * DEGRADES SILENTLY, WHICH IS THE POINT. The browser has no autopilot state of
 * its own to fall back on, so the only honest failure behaviour is to keep
 * showing the session-log reconstruction — which is what the card showed before
 * this module existed and is never wrong, only possibly behind. A rejected
 * promise (offline, aborted, CORS), a non-2xx status, and a body that is not a
 * run projection are therefore indistinguishable here on purpose: all three
 * mean "no news".
 *
 * @param runId - the run to ask about.
 * @param fetchJson - the injected fetch; production passes the browser's.
 * @returns the run projection, or undefined when there is no usable answer.
 */
export async function fetchLiveRun(runId: string, fetchJson: LiveFetch): Promise<LiveRun | undefined> {
  try {
    const response = await fetchJson(runRouteUrl(runId))
    if (!response.ok) return undefined
    return readLiveRun(await response.json())
  } catch {
    return undefined
  }
}

/** Stamp a live value with the revision it was read at. */
function liveObserved<T>(value: T, revision: number): Observed<T> {
  // NO `seq`: a live read has no session sequence number, and inventing one
  // (0, or the last observed seq) would attribute a host-route answer to a
  // session event that never happened. `Observed.seq` is optional precisely so
  // this stays sayable.
  return { value, revision }
}

/**
 * Fold a live answer over the session-log reconstruction.
 *
 * PRECEDENCE IS BY REVISION, NOT BY SOURCE. A live answer older than what the
 * session log already showed is DROPPED — that happens naturally when the model
 * in this very session advances the run between two polls, and letting the
 * older answer win would make the card flicker backwards. Equal revisions also
 * keep the fold, because the fold carries strictly more (triage from init's
 * arguments, the audit rows, the call strip) and the two agree by construction
 * at the same revision.
 *
 * REFERENCE STABILITY IS PART OF THE CONTRACT: when there is nothing to add,
 * the SAME `data` object comes back, so `buildViewNode`'s reuse check and the
 * host's `sameContribution` comparison both see an unchanged card.
 *
 * `stale` is recomputed to FALSE on a live overlay, and that is not a
 * cosmetic: `stale` means "the run's revision has moved past the newest phase
 * observation", and a live answer carries phase and revision from the SAME
 * read, so the gap it describes is genuinely closed.
 *
 * @param data - the folded card data.
 * @param live - the newest live answer, if any.
 * @returns the data the card should render.
 */
export function overlayLive(data: AutopilotRunChatData, live: LiveRun | undefined): AutopilotRunChatData {
  if (live === undefined) return data
  if (live.revision <= data.revision) return data
  const at = live.revision
  return {
    ...data,
    revision: at,
    runId: live.runId,
    phase: liveObserved(live.phase, at),
    ...(live.planGate === undefined ? {} : { planGate: liveObserved(live.planGate, at) }),
    ...(live.executionGate === undefined ? {} : { executionGate: liveObserved(live.executionGate, at) }),
    ...(live.planRevision === undefined ? {} : { planRevision: liveObserved(live.planRevision, at) }),
    ...(live.requiredRoles === undefined ? {} : { requiredRoles: liveObserved(live.requiredRoles, at) }),
    ...(live.replanBudgetRemaining === undefined ? {} : { replanBudgetRemaining: liveObserved(live.replanBudgetRemaining, at) }),
    ...(live.logCount === undefined ? {} : { logCount: liveObserved(live.logCount, at) }),
    ...(live.closeoutSubmitted === undefined ? {} : { closeoutSubmitted: liveObserved(live.closeoutSubmitted, at) }),
    ...(live.latestVerdicts === undefined ? {} : { latestVerdicts: liveObserved(live.latestVerdicts, at) }),
    ...(live.executor === undefined ? {} : { executor: liveObserved(live.executor, at) }),
    ...(live.enforcement === undefined ? {} : { enforcement: liveObserved(live.enforcement, at) }),
    stale: false,
  }
}
