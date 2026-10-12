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

/** What the card renders beside a route model for one route status (M4). */
export interface RouteStatusView {
  /** Suffix appended after the route model; '' renders plain (no claim). */
  readonly suffix: string
  /** Hover text; carried only when the record explains itself. */
  readonly title?: string
}

/**
 * The route-status rendering rule, PURE so it is testable without mounting
 * the card (react is host-provided; see the card's own header).
 *
 * FALSE-STATEMENT DOCTRINE, same as every other card decision: `verified`
 * renders PLAIN (the record claims nothing to correct), `unverified` keeps
 * the 0.2.0 suffix verbatim, `mismatch`/`unverifiable` say so and carry the
 * record's diagnostic as the hover title — the diagnostic is the only place
 * the differing axes are named, and this function must not paraphrase them
 * into a softer claim. Anything unrecognised (an old record, a foreign shape)
 * stays PLAIN rather than guessing a mood.
 */
export function routeStatusView(route: unknown): RouteStatusView {
  if (!isPlainObject(route)) return { suffix: '' }
  const diagnostic = typeof route.routeDiagnostic === 'string' ? route.routeDiagnostic : undefined
  const titled = diagnostic === undefined ? {} : { title: diagnostic }
  switch (route.routeStatus) {
    case 'unverified':
      return { suffix: ' (unverified route)' }
    case 'mismatch':
      return { suffix: ' (route mismatch)', ...titled }
    case 'unverifiable':
      return { suffix: ' (route unverifiable)', ...titled }
    default:
      return { suffix: '' }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The routing block (M13). TWO SOURCES, and the card must not confuse them.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the policy triple came from — the card's own honesty field.
 *
 * `session`: an `autopilot_status` result in THIS session, i.e. the engine really
 * read the dispatching session's model-selection policy.
 * `route`: the same-origin HTTP route, which has NO session to ask
 * (`../service.ts` projects with no policy argument), so its `unobserved` means
 * "this path cannot read a policy" and NEVER "there is no policy".
 */
export type RoutingPolicySource = 'session' | 'route'

/** One role's place in the routing block. */
export interface RoutingRoleMirror {
  readonly role: string
  readonly effective: string
  /** Present only when the role actually makes a selection (auto). */
  readonly workClass?: string
  readonly workClassEngaged?: boolean
  readonly lock?: string
}

/** One route this run's own dispatches settled on — an ACTUAL dispatch record. */
export interface RoutingPinMirror {
  readonly role: string
  readonly provider: string
  readonly model: string
}

/**
 * The routing projection, mirrored field-by-field for the browser half.
 *
 * A MIRROR, not an opaque record: the card RENDERS these values, so each one is
 * re-read and type-checked at the boundary ({@link readRoutingMirror}) rather
 * than trusted — this is JSON off a socket, and a half-parsed object rendered as
 * a claim is exactly what a status card must not do.
 */
export interface RoutingMirror {
  readonly mode: string
  readonly preference: string
  readonly preferenceSource: string
  /** `present|absent|unreachable|unobserved` — four states, never merged into one. */
  readonly policyState: string
  readonly policyRouteCount?: number
  readonly policyStateFrom: RoutingPolicySource
  /** `live|inherit-only|unobserved`, derived by the engine FROM `policyState`. */
  readonly dispatch: string
  readonly roles: readonly RoutingRoleMirror[]
  readonly pins: readonly RoutingPinMirror[]
  readonly ladderTiers: Readonly<Record<string, number>>
  readonly auditTier: string
}

/**
 * The candidate-coverage report, narrowed to what the card says out loud.
 *
 * THIS IS NOT A DISPATCH RECORD. It answers "is every OBSERVED model reachable
 * by some tier-bound work class" — a statement about the configured ladder and
 * the live catalog. The card renders it under a label that says so, because a
 * reader who took it for "what ran" would be reading a different claim.
 */
export interface ReachabilityMirror {
  readonly reachable: readonly string[]
  readonly unreachable: readonly string[]
  readonly outcome?: string
}

/** One gate's provenance, mirrored for the browser half (DESIGN §9 item 8). */
export interface GateSourceMirror {
  readonly source: string
  readonly planRevision?: number
  readonly ownerDecision?: number
  readonly withdrawn?: boolean
  readonly note?: string
}

/** Per-gate provenance as the host route serves it. */
export interface GateSourcesMirror {
  readonly plan?: GateSourceMirror
  readonly execution?: GateSourceMirror
}

/** One rendered line of the gate-provenance row. */
export interface GateSourceLine {
  readonly gate: 'plan' | 'execution'
  readonly text: string
  readonly title: string
}

function readGateSourceMirror(value: unknown): GateSourceMirror | undefined {
  if (!isPlainObject(value)) return undefined
  const source = str(value.source)
  if (source === undefined) return undefined
  const planRevision = num(value.planRevision)
  const ownerDecision = num(value.ownerDecision)
  const note = str(value.note)
  return {
    source,
    ...(planRevision === undefined ? {} : { planRevision }),
    ...(ownerDecision === undefined ? {} : { ownerDecision }),
    ...(value.withdrawn === true ? { withdrawn: true } : {}),
    ...(note === undefined ? {} : { note }),
  }
}

/**
 * Read the gate-provenance projection out of a route body.
 *
 * Malformed input answers `undefined` (the caller treats that as absence rather
 * than inventing a source), and a record with no usable gate at all is absence
 * too. An UNKNOWN source string is carried through verbatim rather than mapped:
 * a reader must be able to see a vocabulary this build does not know instead of
 * being shown a source the stream never recorded.
 */
export function readGateSourcesMirror(value: unknown): GateSourcesMirror | undefined {
  if (!isPlainObject(value)) return undefined
  const plan = readGateSourceMirror(value.plan)
  const execution = readGateSourceMirror(value.execution)
  if (plan === undefined && execution === undefined) return undefined
  return {
    ...(plan === undefined ? {} : { plan }),
    ...(execution === undefined ? {} : { execution }),
  }
}

/** What a source MEANS, in the reader's terms. */
function describeGateSource(source: string): string {
  switch (source) {
    case 'owner': return 'the OWNER (an explicit owner-gate-pass)'
    case 'auditor': return 'a dispatched auditor'
    case 'self-check': return 'a self-check'
    case 'pending': return 'nothing yet — not decided'
    case 'no-source': return 'not recorded by this stream'
    default: return source
  }
}

/** The explanatory title every provenance line carries. */
const GATE_SOURCE_TITLE = 'who last set this gate, and the generation it belongs to. An owner pass stands against a later audit objection — the objection is recorded but the gate does not move — and only the owner can withdraw it; a withdrawn decision never comes back into force. "not recorded by this stream" is a statement about THIS STREAM, not a claim that nobody decided.'

/**
 * The gate-provenance lines, as DATA (DESIGN §9 item 8).
 *
 * WHY THE SOURCE IS THE HEADLINE AND THE GATE VALUE IS NOT: the card already
 * shows each gate's value. What a value cannot say is WHO put it there — and
 * that is the difference between a gate a review passed and one the owner
 * passed, which the precedence rule turns into different futures (a later
 * objection moves the first and is merely recorded against the second).
 *
 * @param mirror - the provenance the host route served.
 * @returns one line per gate, plan first.
 */
export function gateSourceLines(mirror: GateSourcesMirror): readonly GateSourceLine[] {
  const lines: GateSourceLine[] = []
  for (const gate of ['plan', 'execution'] as const) {
    const record = mirror[gate]
    if (record === undefined) continue
    const details: string[] = []
    if (record.planRevision !== undefined) details.push(`plan revision ${record.planRevision}`)
    if (record.ownerDecision !== undefined) details.push(`owner decision ${record.ownerDecision}`)
    if (record.withdrawn === true) details.push('withdrawn')
    lines.push({
      gate,
      text: `${gate} gate: ${describeGateSource(record.source)}${details.length === 0 ? '' : ` (${details.join(', ')})`}`,
      title: GATE_SOURCE_TITLE,
    })
  }
  return lines
}

function strListOrUndefined(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.every(entry => typeof entry === 'string') ? (value as readonly string[]) : undefined
}

/**
 * Read the routing projection out of a tool result or a route body.
 *
 * TOTAL: anything that is not the shape this card renders becomes `undefined`,
 * which the card treats as "not observed" — the same rule the live poll follows
 * for the whole run projection. `mode`, `preference`, `preferenceSource`,
 * `policyState` and `dispatch` are required: without them there is no routing
 * block to speak of, and a defaulted one would be a claim no reader made.
 *
 * @param value - the raw `routing` value from a status result or the host route.
 * @param from - which channel this came from; STAMPED here, never inferred later.
 * @returns the mirrored projection, or undefined when it is not one.
 */
export function readRoutingMirror(value: unknown, from: RoutingPolicySource): RoutingMirror | undefined {
  if (!isPlainObject(value)) return undefined
  const mode = str(value.mode)
  const preference = str(value.preference)
  const preferenceSource = str(value.preferenceSource)
  const policyState = str(value.policyState)
  const dispatch = str(value.dispatch)
  if (mode === undefined || preference === undefined || preferenceSource === undefined
    || policyState === undefined || dispatch === undefined) return undefined
  const roles: RoutingRoleMirror[] = []
  if (Array.isArray(value.roles)) {
    for (const entry of value.roles) {
      if (!isPlainObject(entry)) return undefined
      const role = str(entry.role)
      const effective = str(entry.effective)
      if (role === undefined || effective === undefined) return undefined
      const workClass = isPlainObject(entry.workClass) ? entry.workClass : undefined
      const cls = workClass === undefined ? undefined : str(workClass.name)
      const lock = isPlainObject(entry.lock)
        ? [str(entry.lock.provider), str(entry.lock.model)].filter((part): part is string => part !== undefined).join('/')
        : undefined
      roles.push({
        role,
        effective,
        ...(cls === undefined ? {} : { workClass: cls }),
        ...(workClass !== undefined && typeof workClass.engaged === 'boolean' ? { workClassEngaged: workClass.engaged } : {}),
        ...(lock === undefined || lock.length === 0 ? {} : { lock }),
      })
    }
  }
  const pins: RoutingPinMirror[] = []
  if (Array.isArray(value.pins)) {
    for (const entry of value.pins) {
      if (!isPlainObject(entry)) return undefined
      const role = str(entry.role)
      const provider = str(entry.provider)
      const model = str(entry.model)
      if (role === undefined || provider === undefined || model === undefined) return undefined
      pins.push({ role, provider, model })
    }
  }
  const ladderTiers: Record<string, number> = {}
  if (isPlainObject(value.ladderTiers)) {
    for (const [tier, count] of Object.entries(value.ladderTiers)) {
      if (typeof count === 'number' && Number.isFinite(count)) ladderTiers[tier] = count
    }
  }
  const auditTier = str(value.auditTier)
  return {
    mode,
    preference,
    preferenceSource,
    policyState,
    ...(typeof value.policyRouteCount === 'number' ? { policyRouteCount: value.policyRouteCount } : {}),
    policyStateFrom: from,
    dispatch,
    roles,
    pins,
    ladderTiers,
    auditTier: auditTier ?? 'none',
  }
}

/** Read the candidate-coverage report; `undefined` when it is not the shape the card renders. */
export function readReachabilityMirror(value: unknown): ReachabilityMirror | undefined {
  if (!isPlainObject(value)) return undefined
  const reachable = strListOrUndefined(value.reachable)
  const unreachable = strListOrUndefined(value.unreachable)
  if (reachable === undefined || unreachable === undefined) return undefined
  const outcome = str(value.outcome)
  return { reachable, unreachable, ...(outcome === undefined ? {} : { outcome }) }
}

/** One rendered line of the routing block. */
export interface RoutingLine {
  readonly label: string
  readonly text: string
  readonly title: string
}

/**
 * What a policy state MEANS, in the reader's terms, plus where it was read.
 *
 * THE `unobserved` ARM IS THE POINT OF THIS FUNCTION. Three of the four states
 * are findings about the session's model-selection policy; the fourth is the
 * absence of a read. A card that rendered them with one voice would let a
 * reader conclude "no authorization" from "we could not look" — which is the one
 * inference this whole block exists to prevent. So the branch says out loud that
 * nothing was read and that it is not a statement about a policy.
 *
 * `marker` is VISIBLE on the line, not only in the tooltip: a source claim that
 * a reader has to hover to find is not a claim they can check.
 *
 * @param view - the mirrored routing projection.
 * @returns the short form for the header, the visible source marker, and the hover text.
 */
function policyText(view: RoutingMirror): { readonly short: string; readonly marker: string; readonly title: string } {
  const marker = view.policyStateFrom === 'session' ? 'read in this session' : 'from the host route'
  const from = view.policyStateFrom === 'session'
    ? 'read in this session by autopilot_status'
    : 'reported by the host route, which has no session to ask'
  switch (view.policyState) {
    case 'present':
      return {
        short: `policy present${view.policyRouteCount === undefined ? '' : ` (${view.policyRouteCount} routes)`}`,
        marker,
        title: `this session carries a model-selection policy, so auto routing may SELECT; the count is how many routes it allows (${from})`,
      }
    case 'absent':
      return {
        short: 'policy absent',
        marker,
        title: `no model-selection policy is recorded on this session, so auto routing INHERITS the deployment default instead of selecting (${from})`,
      }
    case 'unreachable':
      return {
        short: 'policy unreadable',
        marker,
        title: `the policy projection could not be read, so auto routing INHERITS the deployment default — a failed read, which is not the same as finding no policy (${from})`,
      }
    default:
      return {
        short: 'policy unobserved',
        marker,
        title: `NOTHING was read: this source has no session to ask (${from}). This is the ABSENCE OF AN OBSERVATION — NOT a statement that no policy exists, and not a statement that auto routing lacks authorization`,
      }
  }
}

/**
 * The ladder tiers, in the order the card lists them.
 *
 * A LOCAL COPY, recorded rather than hidden: the tier NAMES are fixed config
 * paths (`src/routing/work-class.ts` fixes the same three), and the browser half
 * cannot import the host half. The card maps over THIS list, so a tier the engine
 * reports but this list omits would be silently dropped from a header that claims
 * to describe the ladder — which is why the list is here, next to its only reader.
 */
const LADDER_TIER_ORDER: readonly string[] = ['economy', 'standard', 'reserve']

/**
 * The routing block's lines, as DATA.
 *
 * Pure and separate from the renderer for the same reason {@link routeStatusView}
 * is: `react` is a host-provided external this package cannot install, so no test
 * can mount the card. Every judgement the block makes about what a value MEANS
 * therefore lives here, where a test can hold it — and the structural judgement
 * this block exists for is that CONFIGURATION, ACTUAL DISPATCHES and CANDIDATE
 * COVERAGE are three different claims, so they get three different labels rather
 * than one merged sentence.
 *
 * @param routing - the merged routing projection.
 * @param reachability - the candidate-coverage report, when one was observed.
 * @returns the lines to render, in order. The coverage line is present only when
 *   a report was observed — an unobserved one is never rendered as "no coverage".
 */
export function routingLines(
  routing: Observed<RoutingMirror>,
  reachability?: Observed<ReachabilityMirror> | undefined,
): readonly RoutingLine[] {
  const view = routing.value
  const policy = policyText(view)
  const lines: RoutingLine[] = [
    {
      label: 'routing',
      text: `${view.mode} · preference ${view.preference} (${view.preferenceSource}) · ${policy.short} [${policy.marker}] · dispatch ${view.dispatch}`,
      title: `the routing CONFIGURATION and whether selection can happen. ${policy.title}. "dispatch" is the engine's own verdict derived from the policy state`,
    },
    {
      // THE LADDER, as COUNTS per tier plus the tier the audit class draws from.
      //
      // Counts, not member lists: the ladder is the owner's config and the card's
      // job is to show its SHAPE (how many routes each tier holds, and which tier
      // audits come from), not to reprint a list the owner wrote. `mode: 'off'`
      // never reaches here — the engine serves no routing block at all in that
      // case, so the card renders no ladder line either.
      label: 'ladder',
      text: `${LADDER_TIER_ORDER.map(tier => `${tier} ${view.ladderTiers[tier] ?? 0}`).join(' · ')} · audit tier ${view.auditTier}`,
      title: 'the configured ladder\'s member COUNT per tier, and the tier the audit class draws from (`routing.ladder.auditTier`, the owner\'s override; `none` means the class\'s own mapping stands). Counts, because the tiers are the owner\'s config — this line reports its shape, not a second copy of the list',
    },
    {
      label: 'roles',
      text: view.roles.length === 0
        ? 'no routed role reported'
        : view.roles.map(roleText).join(' · '),
      title: 'each role\'s effective routing mode, and for auto roles the work class it selects from (a class marked "not engaged" is recorded but restricts nothing)',
    },
    {
      label: 'dispatched',
      text: view.pins.length === 0
        ? 'no dispatch has settled a route yet'
        : view.pins.map(pin => `${pin.role} ${pin.provider}/${pin.model}`).join(' · '),
      title: 'the routes THIS RUN\'s own dispatches settled on — actual dispatch records, not candidate coverage',
    },
  ]
  if (reachability !== undefined) {
    const report = reachability.value
    const observed = report.reachable.length + report.unreachable.length
    const unreachable = report.unreachable.length === 0 ? '' : ` · unreachable: ${report.unreachable.join(', ')}`
    lines.push({
      label: 'candidate coverage',
      text: `${report.reachable.length}/${observed} observed model(s) reachable by a tier-bound class${unreachable} · NOT a dispatch record`,
      title: 'CANDIDATE COVERAGE, not a dispatch record: which models the configured ladder maps to some work class. A model can be perfectly reachable and still never have been dispatched, and a dispatched model is not vouched for here',
    })
  }
  return lines
}

/** One role's cell: mode, plus the class it consults when it makes a selection. */
function roleText(role: RoutingRoleMirror): string {
  if (role.effective === 'locked') {
    return role.lock === undefined ? `${role.role} locked` : `${role.role} locked ${role.lock}`
  }
  if (role.workClass === undefined) return `${role.role} ${role.effective}`
  const engaged = role.workClassEngaged === false ? ' (not engaged)' : ''
  return `${role.role} ${role.effective}/${role.workClass}${engaged}`
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
  /**
   * M13: the routing projection, from EITHER source.
   *
   * An `autopilot_status` result in this session carries it (the engine really
   * read this session's model-selection policy), and the host route carries it
   * too — with a policy state that CANNOT be read there. `./live.ts` merges the
   * two without ever letting the route's "cannot read" overwrite a session's
   * "read it", and stamps the resulting triple's origin.
   *
   * ABSENT when routing mode is not `auto`: the engine deliberately serves no
   * block at all in that case (`routingStatusOf` returns undefined), because a
   * row of `inherit` would read like a routing state that failed rather than a
   * feature the owner switched off.
   */
  readonly routing?: Observed<RoutingMirror>
  /**
   * M13: candidate COVERAGE (which observed models a tier-bound work class can
   * reach), never a dispatch record. Rendered under its own label for exactly
   * that reason.
   */
  readonly routingReachability?: Observed<ReachabilityMirror>
  /**
   * DESIGN §9 item 8: per-gate provenance (who set the gate, for which plan
   * revision), carried as its own observation so a stale value is never shown
   * as current.
   */
  readonly gateSources?: Observed<GateSourcesMirror>
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
  if (!isPlainObject(block)) return { callId, isError: message.isError === true, payload: undefined }
  // TWO ENVELOPE SHAPES, both MEASURED, and the card must fold either one:
  //
  //  (a) WRAPPED — `content[0] = { isError, content: [ { type: 'text', text } ] }`.
  //      This is the 0.1.x-era shape the fixtures under `test/fixtures/card/`
  //      carry, and a legacy stream still replays it. Replay compatibility is a
  //      standing invariant, so this arm cannot be dropped.
  //  (b) FLAT — `content[0]` IS the text block (`{ type: 'text', text }`) and
  //      `isError` sits on the MESSAGE. Measured 2026-10-12 on a real 0.2.0
  //      session: `data.message.content[0].text` plus `data.message.isError`.
  //
  // WHY THIS MATTERS, in the sharpest possible terms: before this arm existed,
  // reading (b) produced `payload: undefined` for EVERY result, so the fold
  // applied nothing at all — the card rendered as a hollow shell (revision 0, no
  // phase, no gates, no audit verdicts, no routing block) on the current host,
  // silently, with no error anywhere. The unit fixtures could not catch it
  // because they only ever carried shape (a); a real 0.2.0 session replay did.
  const wrapped = Array.isArray(block.content) ? block.content[0] : undefined
  const wrappedText = isPlainObject(wrapped) ? str(wrapped.text) : undefined
  const flatText = str(block.text)
  const text = wrappedText ?? flatText
  const isError = block.isError === true || message.isError === true
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
    // M13: the routing block and the coverage report. BOTH are read from THIS
    // result — the engine's StatusView carries both (src/engine.ts), so the card
    // has a session-observed source for each and does not depend on the poll
    // (which stops entirely once the run is terminal).
    //
    // ABSENCE CLEARS, and that is the honest direction: `autopilot_status`
    // returns the whole status view every time, so a result that carries no
    // routing is the engine SAYING there is none (mode is not `auto`). Keeping
    // the previous block would leave the card asserting a routing state the
    // newest observation contradicts. A malformed block is likewise treated as
    // absence — never as a claim.
    const routing = readRoutingMirror(payload.routing, 'session')
    data = routing === undefined ? clear(data, 'routing') : merge(data, 'routing', routing, revision, seq)
    const reachability = readReachabilityMirror(payload.routingReachability)
    data = reachability === undefined
      ? clear(data, 'routingReachability')
      : merge(data, 'routingReachability', reachability, revision, seq)
    // PRESENCE-GATED THE OTHER WAY ROUND: the engine always projects
    // `gateSources` (a stream that recorded none reads `no-source`), so a
    // session-log payload WITHOUT the field is an observation from before this
    // build — not a claim that provenance is absent. It therefore neither
    // merges nor CLEARS what is already known.
    const gateSources = readGateSourcesMirror(payload.gateSources)
    if (gateSources !== undefined) data = merge(data, 'gateSources', gateSources, revision, seq)
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
      // MAX_REPLAN_ROUNDS stays in `replanning` with an exhaustion diagnostic
      // (governance pragmatics v1 removed the forced owner escalation) — the
      // gate values still cannot be inferred from the verdict alone.
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

/**
 * Drop a key entirely — the counterpart of {@link merge} for a source that
 * SPOKE and said "there is none".
 *
 * The distinction is the whole reason this exists: `merge`'s "absent value
 * leaves the fold alone" is right for a partial result (a trimmed payload that
 * simply does not mention a field), and wrong for a COMPLETE projection whose
 * absent field is a statement. `autopilot_status` serves the whole status view,
 * so its absent routing block means the engine has none to report — clearing is
 * the honest fold, and keeping the old value would let the card assert a routing
 * state its newest observation contradicts.
 */
function clear<K extends keyof AutopilotRunChatData & string>(
  data: AutopilotRunChatData,
  key: K,
): AutopilotRunChatData {
  if (data[key] === undefined) return data
  const next = { ...data }
  delete next[key]
  return next
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
