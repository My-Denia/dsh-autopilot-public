/**
 * Deterministic ordered-rule route selection (plan v3 "Roles and routing",
 * steps 1–6). Pure decision core: every input is injected, every output is an
 * EXACT decision kind — never a boolean — so an N-valued outcome can never
 * collapse (the repo's standing lesson; see `test/gate.test.ts`).
 *
 * THE RULE TABLE, in order, over catalog facts only:
 *
 *  1. Eligibility — route ∈ authorized set; provider live in the catalog.
 *     An empty intersection terminates to INHERITANCE with the reason
 *     recorded ([R2-P2-2a]: an infrastructure fact, not a verdict).
 *  2. Role floor — `minContext` (default executor/planner 131072, auditors
 *     65536). A KNOWN context window below the floor excludes the candidate;
 *     an UNKNOWN one keeps it eligible, ranked after every known-sufficient
 *     candidate and named in `why`.
 *  3. Preference — `quality`: has-reasoning-efforts first, then contextWindow
 *     descending. `economy`: smallest contextWindow ≥ floor first. `balanced`
 *     (default): efforts preferred, then contextWindow descending. Ties break
 *     by adapter-preferred catalog order; unlisted routes tie-break after all
 *     listed ones. No scores, no name parsing — ever.
 *  4. Auditor independence [R2-P2-1] — at/above the risk floor this OUTRANKS
 *     step 3 for auditor roles: candidates are reordered both-axis-distinct
 *     from the executor's live pin first, then modelAxis-distinct-only, then
 *     the rest. Axes are RECOMPUTED at every dispatch against the executor's
 *     CURRENT pin ([R2-P2-2b]: pins stabilize routes, not judgments). Below
 *     the floor, step-3 order is unmodified.
 *  5. Effort — the route's adapter-declared `defaultEffort`, unless a role
 *     lock names one. Never invented: no facts ⇒ no effort field.
 *  6. Preflight — `resolveCallConfig` at dispatch; a rejection moves to the
 *     next ranked candidate with `fallbackFrom` + reason recorded. Verdicts
 *     (needs-fix/needs-replan) NEVER cause reselection — they do not reach
 *     this module at all.
 *
 * Authorization arrives resolved (`./authorize.ts`): the session policy is
 * the only authority for auto selection, plugin-config grants are checked
 * under the one [R2-P1-1] rule, and settings are never consulted. A
 * single-route authorized set inherits (fixture c): with nothing to choose
 * between, an explicit selection would record a choice that never happened —
 * the pseudo-active defect this repository keeps paying for.
 *
 * Pure domain module: no dsh imports, no I/O of its own (the catalog port is
 * injected), no state held between calls.
 */

import { errorMessage } from '../domain/types.js'
import type { Risk } from '../domain/types.js'
import { catalogRank, providerIsLive } from './catalog.js'
import type { LlmResolvedModelInfo, RouteCatalog } from './catalog.js'
import { independenceOf, sameRoute, toRoutePin } from './identity.js'
import type { IndependenceRecord, RoutePin, RouteRef } from './identity.js'
import { authorizedAutoRoutes, resolvePluginGrant } from './authorize.js'
import type { AuthorizationSource, SessionPolicyState } from './authorize.js'

/** The roles GAH routes (plan "Roles and routing"); auditor roles carry the independence constraint. */
export type Role = 'executor' | 'plan-auditor' | 'execution-auditor' | 'rules-auditor' | 'planner'

/** The auditor roles: the ones whose independence from the executor is recorded. */
export type AuditorRole = 'plan-auditor' | 'execution-auditor' | 'rules-auditor'

/** Ordinal route preference (plan step 3). Cost metering is out of scope — this is ordinal only. */
export type RoutePreference = 'balanced' | 'economy' | 'quality'

/**
 * Per-role routing config as the engine resolved it from the `routing`
 * section (M3 maps config and legacy fields onto this). Discriminated so a
 * "locked mode with no lock route" is unrepresentable rather than improvised
 * around.
 */
export type RoleRouting =
  | { readonly mode: 'auto'; readonly minContext?: number }
  | { readonly mode: 'inherit' }
  | { readonly mode: 'locked'; readonly provider: string; readonly model: string; readonly reasoningEffort?: string }

/**
 * Declared role floors (plan step 2), user-tunable via
 * `routing.roles.<role>.minContext`. A floor governs GAH's EXPLICIT
 * selections only — an inherited dispatch runs on the deployment default,
 * exactly as 0.2.0 did, and the honest record is the `why` list.
 */
export const DEFAULT_ROLE_MIN_CONTEXT: Readonly<Record<Role, number>> = {
  executor: 131072,
  planner: 131072,
  'plan-auditor': 65536,
  'execution-auditor': 65536,
  'rules-auditor': 65536,
}

const RISK_ORDER: readonly Risk[] = ['low', 'medium', 'high', 'critical']

/** Whether an auditor role's independence constraint is required at this risk. */
function independenceRequired(risk: Risk, floor: Risk): boolean {
  return RISK_ORDER.indexOf(risk) >= RISK_ORDER.indexOf(floor)
}

/** Everything one selection needs. All injected; nothing read from the world. */
export interface RouteSelectionInput {
  readonly role: Role
  /** The run's current risk — the independence gate input. */
  readonly risk: Risk
  /** `routing.preference`. */
  readonly preference: RoutePreference
  /** This role's resolved routing config. */
  readonly roleRouting: RoleRouting
  /** The session policy state, as the engine already read it. */
  readonly policy: SessionPolicyState
  /** The catalog port: snapshot + exact facts + preflight. */
  readonly catalog: RouteCatalog
  /**
   * The executor's CURRENT pin, re-read per dispatch. Auditor axes are
   * computed against this live value, never against a stored judgment.
   */
  readonly executorPin?: RouteRef
  /** Risk at/above which auditor independence outranks preference (`crossFamily.minRisk`; default `medium`, the shipped value). */
  readonly independenceFloor?: Risk
}

/** One candidate as the decision records it: facts, axes, and its disposition. */
export interface CandidateConsidered {
  readonly provider: string
  readonly model: string
  readonly contextWindow?: number
  readonly hasReasoningEfforts: boolean
  /** Present for auditor roles: identity vs the executor's live pin, two axes. */
  readonly independence?: IndependenceRecord
  readonly disposition: 'selected' | 'eligible' | 'excluded-below-floor' | 'preflight-rejected'
  readonly note?: string
}

/** A preflight rejection that moved selection to the next ranked candidate (plan step 6). */
export interface FallbackRecord {
  readonly provider: string
  readonly model: string
  readonly reason: string
}

/** The chosen route. `reasoningEffort` is adapter-declared or lock-named — never invented. */
export interface SelectedRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  /** Auditor roles: two-axis identity vs the executor pin, with the 0.2.0 outcome word. */
  readonly independence?: IndependenceRecord
}

/**
 * The selection decision. Exact kinds:
 *  - `route` — dispatch explicitly with this route; carries the full record.
 *  - `inherit` — dispatch with NO explicit agentOptions; `why` records why.
 *  - `escalate-owner` — the owner must arbitrate (grant/policy conflict, or
 *    a locked route whose provider is gone: "dispatch blocked +
 *    needs-owner-decision").
 *  - `blocked` — no dispatch and no arbitration path; every reason recorded.
 */
export type SelectionDecision =
  | {
      readonly kind: 'route'
      readonly route: SelectedRoute
      readonly why: readonly string[]
      readonly candidatesConsidered: readonly CandidateConsidered[]
      readonly authorizationSource: AuthorizationSource
      /** Present iff at least one preflight rejection moved selection onward. */
      readonly fallbackFrom?: readonly FallbackRecord[]
    }
  | { readonly kind: 'inherit'; readonly why: readonly string[]; readonly authorizationSource?: AuthorizationSource }
  | { readonly kind: 'escalate-owner'; readonly reason: string }
  | { readonly kind: 'blocked'; readonly reason: string; readonly why: readonly string[] }

/** Internal working candidate. */
interface Working {
  readonly pin: RoutePin
  readonly facts?: LlmResolvedModelInfo
  readonly factsError?: string
  /** Adapter-preferred position; `Infinity` for unlisted routes. */
  readonly catalogIndex: number
  readonly independence?: IndependenceRecord
}

function contextWindowOf(candidate: Working): number | undefined {
  return candidate.facts?.context?.contextWindow
}

function hasEffortsOf(candidate: Working): boolean {
  return (candidate.facts?.reasoning?.efforts.length ?? 0) > 0
}

/** The effort to preflight and dispatch: lock-named, else adapter-declared, else none. Never invented. */
function effortFor(candidate: Working, lockEffort?: string): string | undefined {
  return lockEffort ?? candidate.facts?.reasoning?.defaultEffort
}

function candidateRecord(candidate: Working, disposition: CandidateConsidered['disposition'], note?: string): CandidateConsidered {
  const window = contextWindowOf(candidate)
  return {
    provider: candidate.pin.provider,
    model: candidate.pin.model,
    ...(window !== undefined ? { contextWindow: window } : {}),
    hasReasoningEfforts: hasEffortsOf(candidate),
    ...(candidate.independence !== undefined ? { independence: candidate.independence } : {}),
    disposition,
    ...(note !== undefined ? { note } : {}),
  }
}

function routeLabel(pin: RoutePin): string {
  return `${pin.provider}/${pin.model}`
}

/**
 * Select the route for one role dispatch. See the module rule table; every
 * decision carries a non-empty `why` (or `reason`) naming the rules that
 * fired, so a reader can reconstruct the choice from the record alone.
 */
export async function selectRoute(input: RouteSelectionInput): Promise<SelectionDecision> {
  if (input.roleRouting.mode === 'inherit') {
    return { kind: 'inherit', why: ['role routing mode is inherit — GAH does not reroute this role; the deployment default applies'] }
  }
  if (input.roleRouting.mode === 'locked') {
    return selectLocked(input)
  }
  return selectAuto(input)
}

// ── Locked: an explicit plugin-config grant, checked under the one rule ──

async function selectLocked(input: RouteSelectionInput): Promise<SelectionDecision> {
  if (input.roleRouting.mode !== 'locked') throw new Error('unreachable: selectLocked on a non-locked routing')
  const grant = {
    provider: input.roleRouting.provider,
    model: input.roleRouting.model,
    source: 'routing-lock' as const,
  }
  const verdict = resolvePluginGrant(grant, input.policy)
  if (verdict.kind === 'conflict') {
    return { kind: 'escalate-owner', reason: verdict.reason }
  }
  const snapshot = await input.catalog.snapshot()
  if (!providerIsLive(snapshot, grant.provider)) {
    // Plan "Route records and stability": a locked route whose provider is
    // gone blocks dispatch and escalates needs-owner-decision. The lock is an
    // owner grant; only the owner can re-decide it.
    return {
      kind: 'escalate-owner',
      reason:
        `locked route ${grant.provider}/${grant.model} has no live provider in the catalog — ` +
        'dispatch blocked, run escalates needs-owner-decision',
    }
  }
  let facts: LlmResolvedModelInfo | undefined
  let factsError: string | undefined
  try {
    facts = await input.catalog.resolveRoute(grant.provider, grant.model)
  } catch (error) {
    factsError = errorMessage(error)
  }
  const pin = toRoutePin(grant)
  if (pin === undefined) throw new Error('unreachable: locked route is not explicit')
  const working: Working = {
    pin,
    facts,
    factsError,
    catalogIndex: catalogRank(snapshot, pin.provider, pin.model) ?? Number.POSITIVE_INFINITY,
  }
  const effort = effortFor(working, input.roleRouting.reasoningEffort)
  const why = [...verdict.why, 'role-floor: not applied — a locked route is an explicit owner selection; no preference ranking applies']
  if (factsError !== undefined) {
    why.push(`facts: ${routeLabel(pin)} resolution failed (${factsError}) — effort defaults omitted, never invented`)
  }
  const config = { provider: pin.provider, model: pin.model, ...(effort !== undefined ? { reasoningEffort: effort } : {}) }
  try {
    await input.catalog.preflight(config)
    if (effort !== undefined) {
      why.push(
        input.roleRouting.reasoningEffort !== undefined
          ? `effort: "${effort}" named by the role lock (overrides the adapter default)`
          : `effort: "${effort}" is the route's adapter-declared defaultEffort`,
      )
    } else {
      why.push('effort: none declared and none named — omitted, never invented')
    }
    why.push(`preflight: resolveCallConfig accepted ${routeLabel(pin)}`)
    return {
      kind: 'route',
      route: { provider: pin.provider, model: pin.model, ...(effort !== undefined ? { reasoningEffort: effort } : {}) },
      why,
      candidatesConsidered: [candidateRecord(working, 'selected')],
      authorizationSource: 'plugin-config',
    }
  } catch (error) {
    const reason = errorMessage(error)
    return {
      kind: 'blocked',
      reason:
        `locked route ${routeLabel(pin)} failed preflight (${reason}) and a lock has no fallback candidate — ` +
        'dispatch blocked; the recorded attempt is the honest fallbackFrom chain',
      why: [...why, `preflight: resolveCallConfig rejected ${routeLabel(pin)} (${reason})`],
    }
  }
}

// ── Auto: the ordered rule table over policy ∩ live catalog ──

async function selectAuto(input: RouteSelectionInput): Promise<SelectionDecision> {
  const snapshot = await input.catalog.snapshot()
  const live = new Set(snapshot.providers.map((provider) => provider.id.trim()).filter((id) => id.length > 0))
  const authorized = authorizedAutoRoutes(input.policy, live)
  const inheritDecision = (extraWhy: readonly string[]): SelectionDecision => ({
    kind: 'inherit',
    why: [...authorized.why, ...extraWhy],
    ...(authorized.authorizationSource !== undefined ? { authorizationSource: authorized.authorizationSource } : {}),
  })
  if (authorized.inheritOnly) {
    return inheritDecision([])
  }
  const why = [...authorized.why]
  if (authorized.routes.length === 0) {
    return inheritDecision([
      'eligibility: the authorized set is EMPTY after the live-catalog intersection — terminating to inheritance per eligibility rule 1 (an infrastructure fact, not a verdict)',
    ])
  }
  if (authorized.routes.length === 1) {
    const only = authorized.routes[0]
    if (only === undefined) throw new Error('unreachable: single-route authorized set missing its route')
    return inheritDecision([
      `eligibility: the authorized set holds a single route (${routeLabel(only)}) — with nothing to choose between, ` +
        'inheritance is the honest record; an explicit selection would claim a choice that never happened',
    ])
  }

  // Facts for every authorized route. Listed or not, resolveModelInfo is the
  // exact-route source; a rejection becomes an unknown-fact candidate with
  // the reason recorded, never an exclusion and never a guess.
  const working: Working[] = []
  for (const pin of authorized.routes) {
    let facts: LlmResolvedModelInfo | undefined
    let factsError: string | undefined
    try {
      facts = await input.catalog.resolveRoute(pin.provider, pin.model)
    } catch (error) {
      factsError = errorMessage(error)
    }
    working.push({ pin, facts, factsError, catalogIndex: catalogRank(snapshot, pin.provider, pin.model) ?? Number.POSITIVE_INFINITY })
  }

  // Step 2 — role floor.
  const floor =
    input.roleRouting.mode === 'auto'
      ? (input.roleRouting.minContext ?? DEFAULT_ROLE_MIN_CONTEXT[input.role])
      : DEFAULT_ROLE_MIN_CONTEXT[input.role]
  const excluded = working.filter((candidate) => {
    const window = contextWindowOf(candidate)
    return window !== undefined && window < floor
  })
  const sufficient = working.filter((candidate) => {
    const window = contextWindowOf(candidate)
    return window !== undefined && window >= floor
  })
  const unknownFacts = working.filter((candidate) => contextWindowOf(candidate) === undefined)
  why.push(
    `role-floor: ${input.role} minimum ${floor} tokens` +
      (excluded.length > 0
        ? `; excluded ${excluded.map((candidate) => `${routeLabel(candidate.pin)} (${contextWindowOf(candidate)})`).join(', ')}`
        : '') +
      (unknownFacts.length > 0
        ? `; ${unknownFacts.map((candidate) => routeLabel(candidate.pin)).join(', ')} contextWindow unknown — eligible, ranked after known-sufficient`
        : ''),
  )
  if (sufficient.length + unknownFacts.length === 0) {
    return inheritDecision([
      'role-floor: every authorized route has a KNOWN context window below the floor and none is unknown — ' +
        'no honest explicit selection exists, terminating to inheritance with the exclusions named above',
    ])
  }

  // Adapter-preferred base order (catalog position; unlisted after listed;
  // policy order for full ties) — established BEFORE the preference sort so
  // stable sorting lands equal keys in adapter-preferred order (plan step 3).
  const byCatalog = [...sufficient, ...unknownFacts].sort((a, b) => a.catalogIndex - b.catalogIndex)
  why.push(
    `preference: ${input.preference} — ` +
      (input.preference === 'economy'
        ? 'smallest contextWindow ≥ floor first'
        : input.preference === 'quality'
          ? 'has-reasoning-efforts first, then contextWindow descending'
          : 'efforts preferred, then contextWindow descending') +
      '; ties in adapter-preferred catalog order',
  )
  const orderedSufficient = byCatalog.filter((candidate) => contextWindowOf(candidate) !== undefined)
  if (input.preference === 'economy') {
    orderedSufficient.sort((a, b) => (contextWindowOf(a) ?? 0) - (contextWindowOf(b) ?? 0))
  } else {
    orderedSufficient.sort((a, b) => Number(hasEffortsOf(b)) - Number(hasEffortsOf(a)) || (contextWindowOf(b) ?? 0) - (contextWindowOf(a) ?? 0))
  }
  // Unknown-facts candidates keep adapter-preferred order; the efforts clause
  // stays applicable where it is still observable (quality/balanced).
  const orderedUnknown = byCatalog.filter((candidate) => contextWindowOf(candidate) === undefined)
  if (input.preference !== 'economy') {
    orderedUnknown.sort((a, b) => Number(hasEffortsOf(b)) - Number(hasEffortsOf(a)))
  }
  let ordered = [...orderedSufficient, ...orderedUnknown]

  // Step 4 — auditor independence reordering at/above the floor.
  const isAuditor = input.role === 'plan-auditor' || input.role === 'execution-auditor' || input.role === 'rules-auditor'
  const floorRisk = input.independenceFloor ?? 'medium'
  const required = isAuditor && independenceRequired(input.risk, floorRisk)
  if (isAuditor) {
    ordered = ordered.map((candidate) => ({
      ...candidate,
      independence: independenceOf(candidate.pin, input.executorPin, required),
    }))
    if (required) {
      ordered = [
        ...ordered.filter((candidate) => candidate.independence?.modelAxis === 'distinct' && candidate.independence?.providerAxis === 'distinct'),
        ...ordered.filter((candidate) => candidate.independence?.modelAxis === 'distinct' && candidate.independence?.providerAxis !== 'distinct'),
        ...ordered.filter((candidate) => candidate.independence?.modelAxis !== 'distinct'),
      ]
      why.push(
        `independence: risk ${input.risk} ≥ floor ${floorRisk} — both-axis-distinct candidates from the executor's live pin first, ` +
          'then modelAxis-distinct-only, then the rest (axes recomputed against the CURRENT pin this dispatch; trim-exact id comparison only — ' +
          'no alias or lineage detection, no weight-independence claim)',
      )
      if (toRoutePin(input.executorPin) === undefined) {
        why.push('independence: the executor route is not observable (inheritance) — axes are unknown, order unmodified, outcome unknown-family')
      }
    } else {
      why.push(`independence: risk ${input.risk} < floor ${floorRisk} — preference order unmodified (constraint not required)`)
    }
  }

  // Steps 5 + 6 — per-candidate effort, then the preflight walk down the
  // ranked list; the first candidate resolveCallConfig accepts is chosen.
  const fallbackFrom: FallbackRecord[] = []
  let chosen: Working | undefined
  for (const candidate of ordered) {
    const effort = effortFor(candidate)
    const config = {
      provider: candidate.pin.provider,
      model: candidate.pin.model,
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    }
    try {
      await input.catalog.preflight(config)
      chosen = candidate
      break
    } catch (error) {
      fallbackFrom.push({ provider: candidate.pin.provider, model: candidate.pin.model, reason: errorMessage(error) })
    }
  }
  if (chosen === undefined) {
    const chain = fallbackFrom.map((record) => `${record.provider}/${record.model}: ${record.reason}`).join('; ')
    return {
      kind: 'blocked',
      reason: `every ranked candidate failed preflight — ${chain}`,
      why: [...why, `preflight: resolveCallConfig rejected all ${fallbackFrom.length} ranked candidate(s); no route dispatched`],
    }
  }

  const considered: CandidateConsidered[] = ordered.map((candidate) => {
    const rejected = fallbackFrom.some((record) => sameRoute(record, candidate.pin))
    const isSelected = sameRoute(chosen?.pin, candidate.pin)
    const notes: string[] = []
    if (rejected) notes.push(`fallbackFrom: ${fallbackFrom.find((record) => sameRoute(record, candidate.pin))?.reason ?? ''}`)
    if (candidate.factsError !== undefined) {
      notes.push(`facts: resolveModelInfo rejected this route (${candidate.factsError}) — contextWindow unknown`)
    } else if (contextWindowOf(candidate) === undefined) {
      notes.push('contextWindow unknown — eligible, ranked after known-sufficient')
    }
    return candidateRecord(candidate, isSelected ? 'selected' : rejected ? 'preflight-rejected' : 'eligible', notes.length > 0 ? notes.join('; ') : undefined)
  })
  for (const candidate of excluded) {
    considered.push(candidateRecord(candidate, 'excluded-below-floor', `contextWindow ${contextWindowOf(candidate)} < floor ${floor}`))
  }

  const effort = effortFor(chosen)
  why.push(
    effort !== undefined
      ? `effort: "${effort}" is the route's adapter-declared defaultEffort`
      : 'effort: none declared and none named — omitted, never invented',
  )
  why.push(
    fallbackFrom.length > 0
      ? `preflight: ${fallbackFrom.map((record) => `${record.provider}/${record.model} rejected (${record.reason})`).join('; ')} — fell back to ${routeLabel(chosen.pin)}`
      : `preflight: resolveCallConfig accepted ${routeLabel(chosen.pin)}`,
  )
  return {
    kind: 'route',
    route: {
      provider: chosen.pin.provider,
      model: chosen.pin.model,
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
      ...(chosen.independence !== undefined ? { independence: chosen.independence } : {}),
    },
    why,
    candidatesConsidered: considered,
    authorizationSource: authorized.authorizationSource ?? 'session-policy',
    ...(fallbackFrom.length > 0 ? { fallbackFrom } : {}),
  }
}
