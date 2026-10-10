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
 *     recorded ([R2-P2-2a]: an infrastructure fact, not a verdict). A catalog
 *     READ failure is the mirror case (F23): the outage SKIPS the
 *     intersection — the policy routes stay candidates and preflight gates —
 *     so an unreadable catalog is never mistaken for an empty one.
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
import type { CatalogSnapshot, LlmCallConfig, LlmResolvedModelInfo, RouteCatalog } from './catalog.js'
import { independenceOf, sameRoute, toRoutePin } from './identity.js'
import type { IndependenceRecord, RoutePin, RouteRef } from './identity.js'
import { authorizedAutoRoutes, resolvePluginGrant } from './authorize.js'
import type { AuthorizationSource, AutoAuthorization, SessionPolicyState } from './authorize.js'
import { seededCost } from './capability-seed.js'
import type { SeedMatchKind } from './capability-seed.js'

/** The roles GAH routes (plan "Roles and routing"); auditor roles carry the independence constraint. */
export type Role = 'executor' | 'plan-auditor' | 'execution-auditor' | 'rules-auditor' | 'planner'

/** The auditor roles: the ones whose independence from the executor is recorded. */
export type AuditorRole = 'plan-auditor' | 'execution-auditor' | 'rules-auditor'

/**
 * Ordinal route preference (plan step 3). Cost metering is out of scope —
 * this is ordinal only.
 *
 * `axis` is the owner-declared ordering path: sufficiency THRESHOLDS pass or
 * fail (never ranked), and survivors are ranked on declared AXES only —
 * effective cost, then the owner's speed order when one is declared. It is
 * deliberately NOT a synonym for `economy`: `economy` keeps the historical
 * "smallest contextWindow ≥ floor" proxy, whose window-is-price conflation
 * this preference exists to correct.
 */
export type RoutePreference = 'balanced' | 'economy' | 'quality' | 'axis'

/**
 * Provenance of the EFFECTIVE cost a decision ranked on. The use of the
 * built-in seed must always be visible, and an owner price is never reported
 * as a seed kind.
 */
export type CostMatchKind = SeedMatchKind | 'unknown' | 'owner-override'

/**
 * One owner cost override, US dollars per million tokens. `costOverrides` is
 * keyed by the exact `provider/model` route, because an override is an owner
 * statement about a route the deployment runs — unlike the seed, which is
 * keyed by route and then by model identity.
 */
export interface RouteCostOverride {
  readonly inputPerM: number
  readonly outputPerM: number
}

/**
 * Sufficiency thresholds for preference `axis`: pass/fail, NEVER ranked. A
 * candidate that fails any threshold is excluded from the walk; absence of a
 * required fact is a FAILURE, not a maybe (fail closed).
 */
export interface RouteRequirements {
  /** Required reasoning-effort ids; a candidate must publish every one. */
  readonly effortIds?: readonly string[]
  /** Required input modality; a candidate must disclose it. */
  readonly modality?: 'image'
  /** Required context-window floor in tokens; unknown context does NOT satisfy it. */
  readonly minContext?: number
}

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
  /**
   * The owner's cost overrides, keyed by the exact `provider/model` route. An
   * override BEATS the seeded price for that route and is reported as
   * `owner-override` — never as a seed kind.
   */
  readonly costOverrides?: Readonly<Record<string, RouteCostOverride>>
  /**
   * Sufficiency thresholds for preference `axis`. Not a ranking input: a
   * candidate either passes every declared threshold or is excluded.
   */
  readonly requirements?: RouteRequirements
  /**
   * Owner-declared speed order (`provider/model`, earlier = faster). Absent
   * (or empty) means speed is NOT an axis at all — never inferred, never
   * approximated.
   */
  readonly speedOrder?: readonly string[]
  /**
   * Rotation ordinal: an OFFSET into the already-ordered survivor list, and
   * only within the top independence class when the auditor independence
   * constraint is active. Purely positional — it selects nothing on its own.
   */
  readonly rotation?: number
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
      /**
       * Provenance of the effective cost the walk ranked on. Present exactly
       * when cost was an ordering input (preference `axis`); absent
       * otherwise, so every legacy decision record is unchanged.
       */
      readonly costMatch?: CostMatchKind
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

/**
 * The effective cost of one candidate, with the evidence step that produced
 * it: the owner override first, then the seeded price, then `unknown` — the
 * authority order. The provenance rides WITH the price so a record can never
 * present an owner price as a seed kind.
 */
interface EffectiveCost {
  readonly cost?: { readonly inputPerM: number; readonly outputPerM: number }
  readonly match: CostMatchKind
}

function effectiveCostOf(input: RouteSelectionInput, candidate: Working): EffectiveCost {
  const key = candidate.pin.provider + '/' + candidate.pin.model
  const override = input.costOverrides?.[key]
  if (override !== undefined) return { cost: override, match: 'owner-override' }
  const seed = seededCost(candidate.pin.provider, candidate.pin.model)
  if (seed !== undefined) return { cost: seed.cost, match: seed.match }
  return { match: 'unknown' }
}

/**
 * The owner's speed order as `provider/model` → rank (0 = fastest).
 * `undefined` means speed is NOT an axis: an absent (or empty) declaration
 * states nothing, and an unlisted route is unknown speed — never ranked as
 * though it were slow or fast.
 */
function speedRanksOf(speedOrder: readonly string[] | undefined): ReadonlyMap<string, number> | undefined {
  if (speedOrder === undefined || speedOrder.length === 0) return undefined
  const ranks = new Map<string, number>()
  for (const entry of speedOrder) {
    const key = entry.trim()
    if (key.length > 0 && !ranks.has(key)) ranks.set(key, ranks.size)
  }
  return ranks.size === 0 ? undefined : ranks
}

/**
 * The sufficiency-threshold verdict for one candidate under preference
 * `axis`: a string naming the failed threshold, or `undefined` when every
 * declared threshold passes. Absence of a required fact FAILS (fail closed) —
 * "the adapter did not say" must never be read as "the route satisfies it".
 */
function requirementFailure(input: RouteSelectionInput, candidate: Working): string | undefined {
  const requirements = input.requirements
  if (input.preference !== 'axis' || requirements === undefined) return undefined
  const label = routeLabel(candidate.pin)
  const efforts = requirements.effortIds
  if (efforts !== undefined && efforts.length > 0) {
    const published = new Set((candidate.facts?.reasoning?.efforts ?? []).map((effort) => effort.id))
    const missing = efforts.filter((effort) => !published.has(effort))
    if (missing.length > 0) {
      return label + ' does not publish required reasoning effort id(s) ' + missing.join(', ') + ' — excluded (sufficiency threshold)'
    }
  }
  const modality = requirements.modality
  if (modality !== undefined) {
    const disclosed = candidate.facts?.inputModalities
    if (disclosed === undefined || !disclosed.includes(modality)) {
      return label + ' does not include the required input modality "' + modality + '"' +
        (disclosed === undefined ? ' (modalities unknown — fail closed)' : '') + ' — excluded (sufficiency threshold)'
    }
  }
  const minContext = requirements.minContext
  if (minContext !== undefined) {
    const window = contextWindowOf(candidate)
    if (window === undefined) {
      return label + ' contextWindow is unknown — it does NOT satisfy the required minimum ' + String(minContext) +
        ' (fail closed) — excluded (sufficiency threshold)'
    }
    if (window < minContext) {
      return label + ' contextWindow ' + String(window) + ' is below the required minimum ' + String(minContext) + ' — excluded (sufficiency threshold)'
    }
  }
  return undefined
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

/** F29: the composed route fields, plus whether the effort came only from the retained preflight result. */
interface RetainedRouteFields {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  /** True iff the resolved config carried an effort the walk never sent — the F29 defect class. */
  readonly effortMaterialized: boolean
}

/**
 * F29 (PR #2 Codex round 16): compose the selected route's fields from the
 * RETAINED successful preflight result instead of discarding it.
 *
 * The candidate walk and the locked path used to `await resolveCallConfig`
 * and throw the returned config away, rebuilding the route from
 * `effortFor(chosen)` — the facts `resolveModelInfo` disclosed. An adapter
 * that materializes its default `reasoningEffort` ONLY in the resolved
 * config (nothing in the model facts names it) then dispatched that effort
 * while the pin and `why` recorded none, and `routeStatusOf` reads
 * observed-effort-without-selected-effort as compatible — the route could
 * read `verified` against an effort the record never named. The fix is
 * retention: the selected route's provider/model/reasoningEffort are
 * composed FROM the resolved config when it carries them, falling back to
 * the chosen candidate's fields otherwise.
 *
 * THE ADOPTION GUARD, decided and documented: the resolved config's
 * provider/model are adopted only when they name the SAME route the
 * eligibility/grant/preflight walk authorized (trim-exact, `sameRoute`),
 * and its effort only when the selector sent NONE. `resolveCallConfig`
 * validates the config it is given — it does not re-route it — so a
 * resolved config naming a different route, or rewriting an effort the
 * lock named or the facts declared, is out of the upstream contract;
 * adopting such a value would let a divergent echo outrank the owner's lock
 * or the catalog's own declared default, so the checked candidate's fields
 * stand there. For a contract-conformant adapter the composition is
 * field-identical to the previous behavior (the echo case), which keeps
 * every existing assertion byte-identical when the adapter returns nothing
 * extra.
 *
 * @param candidate the route the checks authorized (already the trimmed pin).
 * @param unsent the effort the selector itself had to send, if any (`effortFor`).
 * @param resolved the retained successful `resolveCallConfig` result, if the walk kept one.
 */
function retainedRouteFields(candidate: RoutePin, unsent: string | undefined, resolved: LlmCallConfig | undefined): RetainedRouteFields {
  const resolvedPin = resolved === undefined ? undefined : toRoutePin(resolved)
  if (resolvedPin === undefined || !sameRoute(resolvedPin, candidate)) {
    return {
      provider: candidate.provider,
      model: candidate.model,
      ...(unsent !== undefined ? { reasoningEffort: unsent } : {}),
      effortMaterialized: false,
    }
  }
  const carried = resolved?.reasoningEffort
  const effort = typeof carried === 'string' && carried.trim().length > 0 ? carried : undefined
  const effective = effort ?? unsent
  return {
    provider: resolvedPin.provider,
    model: resolvedPin.model,
    ...(effective !== undefined ? { reasoningEffort: effective } : {}),
    effortMaterialized: effort !== undefined && unsent === undefined,
  }
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
  // F14 (PR #2 Codex round 6): branch on the read's own status BEFORE reading
  // liveness off it. An `unavailable` snapshot (a `listProviders` throw — a
  // transient infrastructure failure) carries an EMPTY provider list, so the
  // old `!providerIsLive` check conflated "the catalog could not be read"
  // with "the locked provider is gone" and one hiccup escalated every locked
  // dispatch as needs-owner-decision. Only a SUCCESSFUL read (`live`) that
  // lacks the provider is evidence of disappearance and escalates as before;
  // an unavailable read degrades honestly below (the outage is named in `why`)
  // and the lock proceeds to preflight — `resolveCallConfig` is the actual
  // gate for an explicit owner selection, and a preflight failure still
  // blocks with the existing reason shape.
  if (snapshot.catalogStatus === 'live' && !providerIsLive(snapshot, grant.provider)) {
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
  const catalogOutage =
    snapshot.catalogStatus === 'unavailable'
      ? `catalog: snapshot unavailable (${snapshot.diagnostic ?? 'no diagnostic recorded'}) — ` +
        'catalog read failed (infrastructure), not evidence the provider is gone; ' +
        'proceeding to preflight, the actual gate for an explicit owner selection'
      : undefined
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
  if (catalogOutage !== undefined) why.push(catalogOutage)
  if (factsError !== undefined) {
    why.push(`facts: ${routeLabel(pin)} resolution failed (${factsError}) — effort defaults omitted, never invented`)
  }
  const config = { provider: pin.provider, model: pin.model, ...(effort !== undefined ? { reasoningEffort: effort } : {}) }
  // F29 (PR #2 Codex round 16): RETAIN the successful preflight result and
  // compose the selected route from it — an adapter that materializes its
  // default `reasoningEffort` only in the resolved config dispatches that
  // effort while a route rebuilt from `effortFor` alone records none. The
  // adoption guard (see `retainedRouteFields`): the resolved fields ride only
  // when they name the lock's own authorized route, and the effort only when
  // neither the lock nor the facts named one — a lock-named effort is owner
  // authority and never rewritten by an adapter echo. An adapter that echoes
  // the preflighted config back (nothing extra) composes the identical route:
  // byte-identical behavior, existing green.
  let resolved: LlmCallConfig | undefined
  try {
    resolved = await input.catalog.preflight(config)
    const retained = retainedRouteFields(pin, effort, resolved)
    if (retained.effortMaterialized) {
      why.push(
        `effort: "${retained.reasoningEffort}" materialized by the adapter at preflight — ` +
          `resolveCallConfig's resolved config carried a default neither the lock nor the route's facts named`,
      )
    } else if (effort !== undefined) {
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
      route: {
        provider: retained.provider,
        model: retained.model,
        ...(retained.reasoningEffort !== undefined ? { reasoningEffort: retained.reasoningEffort } : {}),
      },
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

/**
 * F23 (PR #2 Codex round 11): what a catalog-read outage changes in the
 * ranked walk. `note` rides `why` on EVERY outcome (selected route and
 * retained inheritance alike) in the F14 wording family; `tieBreak` keeps
 * the preference line from claiming an adapter-preferred order the outage
 * made unobservable.
 */
interface CatalogOutageContext {
  readonly note: string
  readonly tieBreak: string
}

/**
 * Trim, drop non-explicit, dedupe — preserving policy order: the same
 * discipline as `normalizeRoutes` in `./authorize.ts` (module-private there,
 * and `authorize.ts` is outside this fix's write surface). The outage path
 * needs the normalized policy routes WITHOUT the live-provider intersection,
 * so the normalization is restated here rather than reaching for the
 * intersection just to borrow its cleanup.
 */
function policyRoutesVerbatim(routes: readonly RouteRef[]): readonly RoutePin[] {
  const out: RoutePin[] = []
  for (const route of routes) {
    const pin = toRoutePin(route)
    if (pin === undefined) continue
    if (!out.some((kept) => sameRoute(kept, pin))) out.push(pin)
  }
  return out
}

async function selectAuto(input: RouteSelectionInput): Promise<SelectionDecision> {
  const snapshot = await input.catalog.snapshot()
  // F23 (PR #2 Codex round 11): branch on the read's own status BEFORE the
  // live-provider intersection — the F14/F17 conflation class on the last
  // unguarded path. An `unavailable` snapshot (a `listProviders` throw)
  // carries an EMPTY provider list, so intersecting it with the policy read
  // "the catalog could not be read" as "every policy provider is gone": a
  // fresh auto dispatch inherited WITHOUT attempting `resolveModelInfo` or
  // preflight — both of which run independently of the failed listing — and
  // the evidence never named the outage. Liveness is asserted only on a
  // SUCCESSFUL read; under an outage the policy routes remain candidates and
  // preflight is the actual gate, exactly as F14 made it for locks and pins
  // and F17 for the pool walk.
  if (snapshot.catalogStatus === 'unavailable') {
    return selectAutoUnderCatalogOutage(input, snapshot)
  }
  const live = new Set(snapshot.providers.map((provider) => provider.id.trim()).filter((id) => id.length > 0))
  return selectAutoRanked(input, snapshot, authorizedAutoRoutes(input.policy, live), undefined)
}

/**
 * The auto rule table under a catalog READ failure. The empty-POLICY
 * inheritance path (absent/unreachable policy) is unchanged — it never
 * consults the catalog, so the outage changes nothing about it (the empty
 * live set is inert on those branches of `authorizedAutoRoutes`). A PRESENT
 * policy SKIPS the intersection — running it against the outage's
 * provably-empty provider list would manufacture evidence of absence the
 * read cannot support — and hands the normalized policy routes to the ranked
 * walk, where `resolveModelInfo` supplies the facts and `resolveCallConfig`
 * preflight is the gate.
 */
async function selectAutoUnderCatalogOutage(input: RouteSelectionInput, snapshot: CatalogSnapshot): Promise<SelectionDecision> {
  const outage: CatalogOutageContext = {
    note:
      `catalog: snapshot unavailable (${snapshot.diagnostic ?? 'no diagnostic recorded'}) — ` +
      'catalog read failed (infrastructure), not evidence of provider absence; ' +
      'the policy routes remain candidates and preflight is the actual gate',
    tieBreak: 'ties in policy order — the catalog listing is unavailable, so no adapter-preferred order exists to break them',
  }
  if (input.policy.kind !== 'present') {
    return selectAutoRanked(input, snapshot, authorizedAutoRoutes(input.policy, new Set<string>()), undefined)
  }
  const normalized = policyRoutesVerbatim(input.policy.routes)
  const droppedInvalid = input.policy.routes.length - normalized.length
  const why: string[] = [
    `authorization: session model-selection policy present — ${normalized.length} route(s) after normalization; ` +
      'the live-catalog intersection is SKIPPED (catalog read failed — infrastructure, not evidence of provider absence)',
  ]
  if (droppedInvalid > 0) {
    why.push(`authorization: ${droppedInvalid} policy entr(y|ies) lacked an explicit provider/model and were dropped`)
  }
  return selectAutoRanked(
    input,
    snapshot,
    { inheritOnly: false, routes: normalized, authorizationSource: 'session-policy', why },
    outage,
  )
}

/**
 * The ordered rule table (steps 1–6) over an already-resolved authorized
 * set. With `outage === undefined` this is the live-catalog path,
 * byte-identical to the pre-F23 behavior; an outage context only (a) names
 * the outage on every outcome, (b) states the policy-order tie-break
 * honestly, (c) rewords the empty-set reason (no intersection ran), and
 * (d) retains INHERITANCE — the pool walk's skip discipline — when every
 * candidate fails preflight on preflight-only evidence.
 */
async function selectAutoRanked(
  input: RouteSelectionInput,
  snapshot: CatalogSnapshot,
  authorized: AutoAuthorization,
  outage: CatalogOutageContext | undefined,
): Promise<SelectionDecision> {
  const inheritDecision = (extraWhy: readonly string[]): SelectionDecision => ({
    kind: 'inherit',
    why: [...authorized.why, ...extraWhy, ...(outage !== undefined ? [outage.note] : [])],
    ...(authorized.authorizationSource !== undefined ? { authorizationSource: authorized.authorizationSource } : {}),
  })
  if (authorized.inheritOnly) {
    return inheritDecision([])
  }
  const why = [...authorized.why]
  if (authorized.routes.length === 0) {
    return inheritDecision([
      outage !== undefined
        ? 'eligibility: the policy holds NO explicit routes after normalization — nothing to rank, terminating to inheritance (no intersection ran; the catalog outage is not the cause)'
        : 'eligibility: the authorized set is EMPTY after the live-catalog intersection — terminating to inheritance per eligibility rule 1 (an infrastructure fact, not a verdict)',
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
        ? `; ${unknownFacts.map((candidate) => routeLabel(candidate.pin)).join(', ')} contextWindow unknown — eligible` +
          (input.preference === 'axis' ? ' (the window is a threshold, not a ranking axis under preference axis)' : ', ranked after known-sufficient')
        : ''),
  )
  if (sufficient.length + unknownFacts.length === 0) {
    return inheritDecision([
      'role-floor: every authorized route has a KNOWN context window below the floor and none is unknown — ' +
        'no honest explicit selection exists, terminating to inheritance with the exclusions named above',
    ])
  }

  // Preference `axis` only — SUFFICIENCY THRESHOLDS: every declared
  // requirement is pass/fail and NEVER ranked, so a failing candidate is
  // excluded from the walk before any axis comparison happens. Absence of a
  // required fact is a FAILURE (fail closed), named in `why`.
  const requirementExclusions: Array<{ readonly candidate: Working; readonly note: string }> = []
  if (input.preference === 'axis') {
    for (const candidate of [...sufficient, ...unknownFacts]) {
      const note = requirementFailure(input, candidate)
      if (note !== undefined) requirementExclusions.push({ candidate, note })
    }
    if (requirementExclusions.length > 0) {
      why.push(`requirements: ${requirementExclusions.map((entry) => entry.note).join('; ')}`)
    }
  }
  const requirementExcluded = new Set(requirementExclusions.map((entry) => entry.candidate))
  const survivors = [...sufficient, ...unknownFacts].filter((candidate) => !requirementExcluded.has(candidate))
  if (survivors.length === 0) {
    return inheritDecision([
      'requirements: every eligible route fails a declared sufficiency threshold — no honest explicit selection exists, terminating to inheritance with the exclusions named above',
    ])
  }

  // Adapter-preferred base order (catalog position; unlisted after listed;
  // policy order for full ties) — established BEFORE the preference sort so
  // stable sorting lands equal keys in adapter-preferred order (plan step 3).
  const byCatalog = [...survivors].sort((a, b) => a.catalogIndex - b.catalogIndex)
  // Preference `axis` — the RANKING AXES: effective cost first (outputPerM
  // ascending, then inputPerM ascending; a route with no known cost ranks
  // after every route with one and is NEVER treated as free), then the
  // owner-declared speed order when one exists. An absent speedOrder means
  // speed is not an axis at all — never inferred from a model name.
  const speedRanks = input.preference === 'axis' ? speedRanksOf(input.speedOrder) : undefined
  why.push(
    `preference: ${input.preference} — ` +
      (input.preference === 'axis'
        ? 'sufficiency thresholds pass/fail (never ranked); ranking axes: effective cost ascending (outputPerM then inputPerM; no known cost ranks after every known cost)' +
          (speedRanks !== undefined
            ? ', then owner-declared speedOrder (earlier = faster; an unlisted route is unknown speed and ranks after listed routes)'
            : '; speedOrder is absent, so speed is NOT a ranking axis')
        : input.preference === 'economy'
          ? 'smallest contextWindow ≥ floor first'
          : input.preference === 'quality'
            ? 'has-reasoning-efforts first, then contextWindow descending'
            : 'efforts preferred, then contextWindow descending') +
      (outage !== undefined ? `; ${outage.tieBreak}` : '; ties in adapter-preferred catalog order'),
  )
  let ordered: Working[]
  if (input.preference === 'axis') {
    // The axis walk: effective cost, then (only when declared) speed. The
    // sort is stable, so an equal pair keeps the adapter-preferred base
    // order. An unknown window is NOT an ordering axis here — the window is a
    // threshold, and the thresholds above already decided pass/fail.
    const costs = new Map<Working, EffectiveCost>()
    for (const candidate of byCatalog) costs.set(candidate, effectiveCostOf(input, candidate))
    ordered = [...byCatalog].sort((a, b) => {
      const left = costs.get(a) as EffectiveCost
      const right = costs.get(b) as EffectiveCost
      if ((left.cost === undefined) !== (right.cost === undefined)) return left.cost === undefined ? 1 : -1
      if (left.cost !== undefined && right.cost !== undefined) {
        const byOutput = left.cost.outputPerM - right.cost.outputPerM
        if (byOutput !== 0) return byOutput
        const byInput = left.cost.inputPerM - right.cost.inputPerM
        if (byInput !== 0) return byInput
      }
      if (speedRanks !== undefined) {
        const fastA = speedRanks.get(a.pin.provider + '/' + a.pin.model) ?? Number.POSITIVE_INFINITY
        const fastB = speedRanks.get(b.pin.provider + '/' + b.pin.model) ?? Number.POSITIVE_INFINITY
        if (fastA !== fastB) return fastA - fastB
      }
      return 0
    })
  } else {
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
    ordered = [...orderedSufficient, ...orderedUnknown]
  }

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

  // Step 4b — ROTATION (owner coverage requirement): applied ONLY as an
  // OFFSET into the already-ordered survivor list, and, whenever the auditor
  // independence constraint is ACTIVE, only WITHIN the top independence
  // class. Rotation permutes candidates that are interchangeable on
  // independence; it can never move a candidate out of the independent group.
  // A group of 0 or 1 members is a no-op, and `why` says so.
  if (input.rotation !== undefined) {
    const ordinal = Number.isFinite(input.rotation) ? Math.max(0, Math.floor(input.rotation)) : 0
    const independentGroup = required && isAuditor
    const groupSize = independentGroup
      ? ordered.filter((candidate) => candidate.independence?.modelAxis === 'distinct' && candidate.independence?.providerAxis === 'distinct').length
      : ordered.length
    const groupLabel = independentGroup ? 'the top (both-axis-distinct) independence class' : 'the ranked survivor list'
    if (groupSize <= 1) {
      why.push(`rotation: ordinal ${ordinal} into ${groupLabel} — ${groupSize} eligible member(s), so rotation is a NO-OP (nothing to rotate through)`)
    } else {
      const shift = ordinal % groupSize
      const head = ordered.slice(0, groupSize)
      const tail = ordered.slice(groupSize)
      ordered = [...head.slice(shift), ...head.slice(0, shift), ...tail]
      why.push(`rotation: ordinal ${ordinal} into ${groupLabel} (${groupSize} members) — offset ${shift} applied within the group; a candidate can never be rotated out of the independent group`)
    }
  }

  // Steps 5 + 6 — per-candidate effort, then the preflight walk down the
  // ranked list; the first candidate resolveCallConfig accepts is chosen.
  // F29 (PR #2 Codex round 16): the successful preflight result is RETAINED
  // (`resolved`) so the selected route below can be composed FROM it — an
  // adapter that materializes its default `reasoningEffort` only in the
  // resolved config dispatches that effort while a route rebuilt from
  // `effortFor(chosen)` alone records none, and the route then verifies
  // against an effort the pin never named. Adoption guard in
  // `retainedRouteFields`; an adapter that echoes the preflighted config
  // back (nothing extra) composes the identical route — byte-identical.
  const fallbackFrom: FallbackRecord[] = []
  let chosen: Working | undefined
  let resolved: LlmCallConfig | undefined
  for (const candidate of ordered) {
    const effort = effortFor(candidate)
    const config = {
      provider: candidate.pin.provider,
      model: candidate.pin.model,
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    }
    try {
      resolved = await input.catalog.preflight(config)
      chosen = candidate
      break
    } catch (error) {
      fallbackFrom.push({ provider: candidate.pin.provider, model: candidate.pin.model, reason: errorMessage(error) })
    }
  }
  if (chosen === undefined) {
    const chain = fallbackFrom.map((record) => `${record.provider}/${record.model}: ${record.reason}`).join('; ')
    if (outage !== undefined) {
      // F23, the pool walk's skip discipline (F17): exhausting the ranked
      // list under an outage retains INHERITANCE with every skip named. The
      // walk's evidence is preflight-only — no liveness leg was assertable —
      // so escalating to the owner on partial evidence would read the
      // outage as a verdict. A live read exhausting preflight stays
      // `blocked` below, unchanged.
      return inheritDecision([
        `preflight: resolveCallConfig rejected all ${fallbackFrom.length} ranked candidate(s) under the catalog outage — skips: ${chain}; no route dispatched, inheritance retained`,
      ])
    }
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
      notes.push(input.preference === 'axis'
        ? 'contextWindow unknown — eligible (the window is a threshold, not a ranking axis under preference axis)'
        : 'contextWindow unknown — eligible, ranked after known-sufficient')
    }
    return candidateRecord(candidate, isSelected ? 'selected' : rejected ? 'preflight-rejected' : 'eligible', notes.length > 0 ? notes.join('; ') : undefined)
  })
  for (const candidate of excluded) {
    considered.push(candidateRecord(candidate, 'excluded-below-floor', `contextWindow ${contextWindowOf(candidate)} < floor ${floor}`))
  }
  for (const entry of requirementExclusions) {
    considered.push(candidateRecord(entry.candidate, 'excluded-below-floor', entry.note))
  }

  const retained = retainedRouteFields(chosen.pin, effortFor(chosen), resolved)
  if (retained.effortMaterialized) {
    why.push(
      `effort: "${retained.reasoningEffort}" materialized by the adapter at preflight — ` +
        `resolveCallConfig's resolved config carried a default the route's facts never declared`,
    )
  } else {
    why.push(
      retained.reasoningEffort !== undefined
        ? `effort: "${retained.reasoningEffort}" is the route's adapter-declared defaultEffort`
        : 'effort: none declared and none named — omitted, never invented',
    )
  }
  why.push(
    fallbackFrom.length > 0
      ? `preflight: ${fallbackFrom.map((record) => `${record.provider}/${record.model} rejected (${record.reason})`).join('; ')} — fell back to ${routeLabel(chosen.pin)}`
      : `preflight: resolveCallConfig accepted ${routeLabel(chosen.pin)}`,
  )
  // Cost provenance: recorded exactly when cost was an ordering input
  // (preference `axis`). An owner override is NEVER reported as a seed kind;
  // an absent price is `unknown`, never a proxy.
  let costMatch: CostMatchKind | undefined
  if (input.preference === 'axis') {
    const effective = effectiveCostOf(input, chosen)
    costMatch = effective.match
    why.push(
      effective.cost === undefined
        ? `cost: ${routeLabel(chosen.pin)} has NO known cost — never treated as free, and it ranked after every route with a known cost`
        : `cost: ${routeLabel(chosen.pin)} effective ${String(effective.cost.outputPerM)}/M output, ${String(effective.cost.inputPerM)}/M input — provenance ${effective.match}`,
    )
  }
  return {
    kind: 'route',
    route: {
      provider: retained.provider,
      model: retained.model,
      ...(retained.reasoningEffort !== undefined ? { reasoningEffort: retained.reasoningEffort } : {}),
      ...(chosen.independence !== undefined ? { independence: chosen.independence } : {}),
    },
    why: [...why, ...(outage !== undefined ? [outage.note] : [])],
    candidatesConsidered: considered,
    authorizationSource: authorized.authorizationSource ?? 'session-policy',
    ...(fallbackFrom.length > 0 ? { fallbackFrom } : {}),
    ...(costMatch === undefined ? {} : { costMatch }),
  }
}
