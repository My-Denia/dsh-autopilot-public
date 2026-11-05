/**
 * One routing entry for EVERY delegation role (the MY-127 fix: the planner and
 * all roles get a work class and the ladder, not a private code path).
 *
 * PRECEDENCE, per field:
 *   model:  call arg  >  user role pin  >  ladder / work class  >  inherit
 *   effort: call arg  >  pin effort     >  catalog default      >  host default (omitted)
 *
 * An arg or pin that names only an effort keeps the model choice from the next
 * layer; the effort stays explicit (`effortSource` arg / pin) and is
 * preflighted for the chosen route. A preflight-carried effort NEVER replaces
 * an explicit one (MY-25 #1). Every dispatch must send `reasoningEffort`
 * whenever one is known: the host drops the parent's effort when the child
 * route differs and none is sent, so `reasoningEffort` is returned as its own
 * field (it is set even when `selected` is absent, i.e. an inherited model with
 * an explicit effort).
 *
 * MODEL ALLOWLIST (non-blocking item 1). Two constraints can apply and they are
 * CONJUNCTIVE; neither widens the other, and a refusal beats an arg:
 *   - the session model-selection policy (`ports.policy`), the routing core's
 *     authority for ladder selection, and
 *   - the user setting `subagentModelSelection` (`ports.modelSelection`), passed
 *     in as data. The setting only RESTRICTS: it never turns an absent session
 *     policy into selection authority (the routing core's rule is that settings
 *     are never authority, so with no policy the ladder still inherits).
 * An arg or pin route outside either constraint is refused
 * (`AP_ROLE_ROUTE_NOT_ALLOWED`); ladder selection draws only from the
 * intersection.
 *
 * Escalation never widens role eligibility: the allowlist, the reviewer's
 * excluded families and the work-class tier mapping apply identically whatever
 * class the caller names.
 *
 * Pure of dsh imports; the catalog is an injected port.
 */

import type { DelegationRoleName, EffortSource, LedgerRoute, ModelSource, ReviewIndependence } from '../domain/ledger-types.js'
import { errorMessage } from '../domain/types.js'
import { sameRoute, toRoutePin } from '../routing/identity.js'
import type { RoutePin } from '../routing/identity.js'
import type { RouteCatalog } from '../routing/catalog.js'
import type { SessionPolicyState } from '../routing/authorize.js'
import { selectRoute } from '../routing/select.js'
import type { Role, RoleRouting, RoutePreference, SelectionDecision } from '../routing/select.js'
import { DEFAULT_WORK_CLASSES, resolveWorkClassSelection } from '../routing/work-class.js'
import type { ResolvedWorkClass, WorkClassName, WorkClassSelection, WorkClassTier } from '../routing/work-class.js'
import {
  AP_ROLE_ROUTE_BLOCKED,
  AP_ROLE_ROUTE_ESCALATE_OWNER,
  AP_ROLE_ROUTE_INCOMPLETE,
  AP_ROLE_ROUTE_NOT_ALLOWED,
  AP_ROLE_ROUTE_PREFLIGHT_FAILED,
  ROLES,
} from './index.js'
import { familyOf } from './cross-family.js'

/**
 * The slice of the engine's `ResolvedRouting` this module reads. Structural, so
 * `ResolvedRouting` is assignable to it (test/roles.test.ts pins that).
 */
export interface RoleRoutingConfig {
  readonly mode: 'auto' | 'off'
  readonly preference: RoutePreference
  /** Legacy role vocabulary; user pins and per-role work-class overrides live here. */
  readonly roles: Readonly<Record<Role, RoleRouting>>
  readonly ladder: {
    readonly tiers: Readonly<Record<WorkClassTier, readonly string[]>>
    readonly auditTier: WorkClassTier | 'none'
    readonly speedOrder: readonly string[]
    readonly costOverrides: ReadonlyArray<{
      readonly provider: string
      readonly model: string
      readonly inputPerM: number
      readonly outputPerM: number
    }>
  }
  readonly workClasses: Readonly<Record<WorkClassName, ResolvedWorkClass>>
}

/** The user setting `subagentModelSelection`, as data. */
export interface ModelSelectionSetting {
  readonly enabled: boolean
  readonly allowedModels: ReadonlyArray<{ readonly provider: string; readonly model: string }>
}

export interface RoutePorts {
  /** Absent = no `llm` service: arg/pin routes pass unverified, the ladder inherits. */
  readonly catalog?: RouteCatalog
  /** The session model-selection policy as the engine read it. */
  readonly policy: SessionPolicyState
  readonly modelSelection?: ModelSelectionSetting
}

export interface RouteForDelegationInput {
  readonly role: DelegationRoleName
  readonly workClass?: WorkClassName
  readonly arg?: { readonly provider?: string; readonly model?: string; readonly effort?: string }
  readonly routing: RoleRoutingConfig
  readonly ports: RoutePorts
  /** Reviewer only: provider families of the reviewed delegations (observed route, else selected), from one ledger snapshot. */
  readonly excludeFamilies?: readonly string[]
}

export interface RouteDecision {
  /** The route to send. Absent = send no model (inherit the host default). */
  readonly selected?: LedgerRoute
  /** The effort to send: `selected.reasoningEffort`, or the explicit arg effort when the model is inherited. Absent = send none. */
  readonly reasoningEffort?: string
  readonly modelSource: ModelSource
  readonly effortSource: EffortSource
  readonly why: string[]
  /** Reviewer only. */
  readonly independence?: ReviewIndependence
  readonly excludedFamilies: string[]
  readonly independenceNote?: string
}

export interface RouteRefusal {
  /** One of the role-route refusal codes in ../domain/refusals.ts. */
  readonly refused: string
  readonly detail: string
}

export type RouteForDelegation = RouteDecision | RouteRefusal

export function isRouteRefusal(result: RouteForDelegation): result is RouteRefusal {
  return 'refused' in result
}

// ─────────────────────────────────────────────────────────────────────────────

/** The legacy routing role a delegation role is selected under (context floor; auditor shape). */
function legacyRoleOf(role: DelegationRoleName): Role {
  switch (role) {
    case 'planner': return 'planner'
    case 'reviewer': return 'execution-auditor'
    default: return 'executor'
  }
}

/** The legacy roles whose user config applies to a delegation role, in priority order. */
function legacyPinRoles(role: DelegationRoleName): readonly Role[] {
  switch (role) {
    case 'worker':
    case 'executor-lead': return ['executor']
    case 'planner': return ['planner']
    case 'reviewer': return ['plan-auditor', 'execution-auditor', 'rules-auditor']
    default: return []
  }
}

type LockedRouting = Extract<RoleRouting, { readonly mode: 'locked' }>

function pinOf(role: DelegationRoleName, roles: RoleRoutingConfig['roles']): LockedRouting | undefined {
  for (const legacy of legacyPinRoles(role)) {
    const routing = roles[legacy]
    if (routing.mode === 'locked') return routing
  }
  return undefined
}

/** A per-role work class the owner wrote on an auto legacy role. */
function legacyWorkClassOf(role: DelegationRoleName, roles: RoleRoutingConfig['roles']): WorkClassName | undefined {
  for (const legacy of legacyPinRoles(role)) {
    const routing = roles[legacy]
    if (routing.mode === 'auto' && routing.workClass !== undefined) return routing.workClass
  }
  return undefined
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
}

function label(pin: RoutePin): string {
  return `${pin.provider}/${pin.model}`
}

function explain(decision: SelectionDecision): string {
  if (decision.kind === 'escalate-owner') return decision.reason
  if (decision.kind === 'blocked') return decision.reason
  return decision.kind
}

/** The route the allowlist constraints reject, or undefined when it is allowed. */
function allowlistViolation(pin: RoutePin, ports: RoutePorts): string | undefined {
  const setting = ports.modelSelection
  if (setting?.enabled === true && setting.allowedModels.length > 0) {
    const allowed = setting.allowedModels.map((entry) => toRoutePin(entry)).filter((entry): entry is RoutePin => entry !== undefined)
    if (!allowed.some((entry) => sameRoute(entry, pin))) {
      return `${label(pin)} is outside the user's subagentModelSelection allowedModels [${allowed.map(label).join(', ')}]`
    }
  }
  if (ports.policy.kind === 'present') {
    const allowed = ports.policy.routes.map((entry) => toRoutePin(entry)).filter((entry): entry is RoutePin => entry !== undefined)
    if (!allowed.some((entry) => sameRoute(entry, pin))) {
      return `${label(pin)} is outside the session model-selection policy [${allowed.map(label).join(', ')}]`
    }
  }
  return undefined
}

/** The policy ladder selection draws from: the session policy narrowed by the setting. */
function effectivePolicy(ports: RoutePorts): SessionPolicyState {
  const setting = ports.modelSelection
  if (ports.policy.kind !== 'present' || setting?.enabled !== true || setting.allowedModels.length === 0) return ports.policy
  const allowed = setting.allowedModels.map((entry) => toRoutePin(entry)).filter((entry): entry is RoutePin => entry !== undefined)
  return { kind: 'present', routes: ports.policy.routes.filter((route) => allowed.some((entry) => sameRoute(entry, route))) }
}

function costIndex(ladder: RoleRoutingConfig['ladder']): Readonly<Record<string, { inputPerM: number; outputPerM: number }>> | undefined {
  if (ladder.costOverrides.length === 0) return undefined
  const index: Record<string, { inputPerM: number; outputPerM: number }> = {}
  for (const entry of ladder.costOverrides) index[`${entry.provider}/${entry.model}`] = { inputPerM: entry.inputPerM, outputPerM: entry.outputPerM }
  return index
}

function workClassFor(
  input: RouteForDelegationInput,
): WorkClassSelection {
  const { role, routing } = input
  const legacy = legacyWorkClassOf(role, routing.roles)
  const name = input.workClass ?? legacy ?? ROLES[role].defaultWorkClass
  const resolved = routing.workClasses[name]
  const seeded = DEFAULT_WORK_CLASSES[name]
  const mapped =
    resolved.axis !== seeded.axis ||
    resolved.tiers.length !== seeded.tiers.length ||
    resolved.tiers.some((tier, index) => tier !== seeded.tiers[index])
  // The class machinery applies when the call or the owner named a class, or the owner re-mapped it; with an empty ladder and none of those it is recorded, not applied (0.2.0 parity).
  const ownerOverridden = input.workClass !== undefined || legacy !== undefined || mapped
  return resolveWorkClassSelection(
    routing.workClasses,
    routing.ladder.tiers,
    name,
    role === 'reviewer' ? routing.ladder.auditTier : undefined,
    ownerOverridden,
  )
}

interface Base {
  readonly selected?: LedgerRoute
  readonly modelSource: ModelSource
  readonly why: string[]
}

function toLedgerRoute(route: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }): LedgerRoute {
  return {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}),
  }
}

/**
 * Route one delegation. Returns a decision to send, or a refusal with an
 * role-route refusal code. Never throws for routing outcomes.
 */
export async function routeForDelegation(input: RouteForDelegationInput): Promise<RouteForDelegation> {
  const { role, routing, ports } = input
  const catalog = ports.catalog
  const argProvider = clean(input.arg?.provider)
  const argModel = clean(input.arg?.model)
  const argEffort = clean(input.arg?.effort)
  const excluded = [...new Set((input.excludeFamilies ?? []).map((family) => family.trim()).filter((family) => family.length > 0))]
  const isReviewer = role === 'reviewer'

  if ((argProvider === undefined) !== (argModel === undefined)) {
    return {
      refused: AP_ROLE_ROUTE_INCOMPLETE,
      detail: `a route named by the call needs both provider and model (got provider=${argProvider ?? '(none)'}, model=${argModel ?? '(none)'})`,
    }
  }

  const finish = async (base: Base, pin: LockedRouting | undefined, ladderNote?: string): Promise<RouteForDelegation> => {
    let selected = base.selected
    const why = [...base.why]
    // An explicit call effort over a model chosen by an earlier layer was never preflighted with that effort: do it now, and refuse rather than fall back.
    if (argEffort !== undefined && selected !== undefined && selected.reasoningEffort !== argEffort) {
      if (catalog !== undefined) {
        try {
          await catalog.preflight({ provider: selected.provider, model: selected.model, reasoningEffort: argEffort })
        } catch (error) {
          return {
            refused: AP_ROLE_ROUTE_PREFLIGHT_FAILED,
            detail: `effort "${argEffort}" was rejected for ${label(selected)}: ${errorMessage(error)}`,
          }
        }
        why.push(`effort: "${argEffort}" named by the call, preflighted for ${label(selected)}`)
      } else {
        why.push(`effort: "${argEffort}" named by the call; no catalog port, so it was not preflighted`)
      }
      selected = { provider: selected.provider, model: selected.model, reasoningEffort: argEffort }
    }
    if (isReviewer) {
      // The core is called with risk 'low' (see `select`), so its own vendor line says "constraint not required" and would contradict the review's vendor note. Replace it with the real reason.
      for (let i = why.length - 1; i >= 0; i -= 1) if (why[i]!.startsWith('independence: risk ')) why.splice(i, 1)
      if (ladderNote !== undefined) why.push(`reviewer vendor: ${ladderNote}`)
      else if (excluded.length === 0) why.push('reviewer vendor: no reviewed provider known; normal ladder')
    }
    const reasoningEffort = selected?.reasoningEffort ?? argEffort
    if (selected === undefined && argEffort !== undefined) {
      why.push(`effort: "${argEffort}" named by the call, sent with the inherited model; no route to preflight it against`)
    }
    const effortSource: EffortSource =
      argEffort !== undefined ? 'arg'
        : base.modelSource === 'pin' && pin?.reasoningEffort !== undefined ? 'pin'
          : reasoningEffort !== undefined ? 'catalog-default'
            : 'host-default'

    let independence: ReviewIndependence | undefined
    let independenceNote: string | undefined = ladderNote
    if (isReviewer) {
      const family = familyOf(selected)
      if (excluded.length === 0) {
        independence = 'reduced'
        independenceNote = 'the reviewed work has no observed provider family to exclude, so the vendor relation to it is not known'
      } else if (selected === undefined || family === undefined) {
        independence = 'reduced'
        independenceNote = 'the reviewer route is inherited from the host default, so its provider family is not observable'
      } else if (excluded.includes(family)) {
        independence = 'reduced'
        independenceNote ??= `the reviewer runs on provider family "${family}", which the reviewed work also used`
      } else {
        independence = 'cross-family'
        independenceNote = undefined
      }
    }
    return {
      ...(selected !== undefined ? { selected } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      modelSource: base.modelSource,
      effortSource,
      why,
      ...(independence !== undefined ? { independence } : {}),
      excludedFamilies: isReviewer ? excluded : [],
      ...(independenceNote !== undefined ? { independenceNote } : {}),
    }
  }

  /** Dispatch an explicit route (arg or pin) through the locked path: grant check, liveness, facts, preflight. */
  const explicit = async (
    pinRoute: { readonly provider: string; readonly model: string },
    source: 'arg' | 'pin',
    pin: LockedRouting | undefined,
  ): Promise<RouteForDelegation> => {
    const target = toRoutePin(pinRoute)
    if (target === undefined) {
      return { refused: AP_ROLE_ROUTE_INCOMPLETE, detail: `${source} route is not an explicit provider/model` }
    }
    const violation = allowlistViolation(target, ports)
    if (violation !== undefined) {
      return { refused: AP_ROLE_ROUTE_NOT_ALLOWED, detail: `${source === 'arg' ? 'the call' : 'the role pin'} names a route that is not allowed: ${violation}` }
    }
    const modelSource: ModelSource = source
    const origin = source === 'arg' ? 'named by the call' : 'the owner role pin'
    if (catalog === undefined) {
      const effort = argEffort ?? (source === 'pin' ? pin?.reasoningEffort : undefined)
      return finish({
        selected: toLedgerRoute({ ...target, ...(effort !== undefined ? { reasoningEffort: effort } : {}) }),
        modelSource,
        why: [`model: ${label(target)} ${origin}`, 'catalog: no catalog port wired - the route was not verified or preflighted'],
      }, pin)
    }
    const lockEffort = argEffort ?? (source === 'pin' ? pin?.reasoningEffort : undefined)
    const decision = await selectRoute({
      role: legacyRoleOf(role),
      risk: 'low',
      preference: routing.preference,
      roleRouting: { mode: 'locked', provider: target.provider, model: target.model, ...(lockEffort !== undefined ? { reasoningEffort: lockEffort } : {}) },
      policy: ports.policy,
      catalog,
    })
    if (decision.kind === 'route') {
      return finish({ selected: toLedgerRoute(decision.route), modelSource, why: [`model: ${label(target)} ${origin}`, ...decision.why] }, pin)
    }
    if (decision.kind === 'escalate-owner') return { refused: AP_ROLE_ROUTE_ESCALATE_OWNER, detail: decision.reason }
    return { refused: AP_ROLE_ROUTE_PREFLIGHT_FAILED, detail: explain(decision) }
  }

  // 1. call arg
  if (argProvider !== undefined && argModel !== undefined) {
    return explicit({ provider: argProvider, model: argModel }, 'arg', undefined)
  }
  // 2. owner pin
  const pin = pinOf(role, routing.roles)
  if (pin !== undefined) {
    return explicit({ provider: pin.provider, model: pin.model }, 'pin', pin)
  }
  // 3. ladder / work class
  if (routing.mode === 'off') {
    return finish({ modelSource: 'inherit', why: ['routing mode is off - no ladder selection; the host default applies'] }, undefined)
  }
  if (catalog === undefined) {
    return finish({ modelSource: 'inherit', why: ['catalog: no catalog port wired - nothing to select from; the host default applies'] }, undefined)
  }
  const workClass = workClassFor(input)
  const select = (policy: SessionPolicyState, roleRouting: RoleRouting): Promise<SelectionDecision> =>
    selectRoute({
      role: legacyRoleOf(role),
      // Risk stays 'low': the auditor independence step in the core compares against an EXECUTOR pin, which a delegated reviewer does not use; family exclusion is done here, from the reviewed delegations.
      risk: 'low',
      preference: routing.preference,
      roleRouting,
      policy,
      catalog,
      ...(costIndex(routing.ladder) === undefined ? {} : { costOverrides: costIndex(routing.ladder) }),
      ...(routing.ladder.speedOrder.length === 0 ? {} : { speedOrder: routing.ladder.speedOrder }),
      workClass,
      ...(workClass.name === 'mechanical' ? { requirements: { effortIds: ['low'] } } : {}),
    })
  const auto: RoleRouting = { mode: 'auto' }
  const policy = effectivePolicy(ports)
  const classNote = `work class: ${workClass.name}${input.workClass === undefined ? ' (role default or owner override)' : ' (named by the call)'}`
  let ladderNote: string | undefined

  if (isReviewer && excluded.length > 0 && policy.kind === 'present') {
    let outside = policy.routes.filter((route) => !excluded.includes(route.provider.trim()))
    if (workClass.engaged && workClass.tiers.length > 0 && workClass.ladderConfigured) {
      outside = outside.filter((route) => workClass.members.includes(`${route.provider.trim()}/${route.model.trim()}`))
    }
    let preferred: SelectionDecision | undefined
    if (outside.length >= 2) {
      preferred = await select({ kind: 'present', routes: outside }, auto)
    } else if (outside.length === 1 && outside[0] !== undefined) {
      // A single outside route would be INHERITED by the core (nothing to choose between), and the host default may be the excluded family: pick it explicitly.
      preferred = await select(ports.policy, { mode: 'locked', provider: outside[0].provider, model: outside[0].model })
    }
    if (preferred?.kind === 'route') {
      return finish({
        selected: toLedgerRoute(preferred.route),
        modelSource: 'ladder',
        why: [classNote, `reviewer vendor: preferring a provider outside [${excluded.join(', ')}]`, ...preferred.why],
      }, undefined)
    }
    ladderNote = `no reviewer route outside provider families [${excluded.join(', ')}] was selectable${preferred === undefined ? '' : ` (${explain(preferred)})`}; used the normal ladder`
  }

  const decision = await select(policy, auto)
  if (decision.kind === 'route') {
    return finish({ selected: toLedgerRoute(decision.route), modelSource: 'ladder', why: [classNote, ...decision.why] }, undefined, ladderNote)
  }
  if (decision.kind === 'inherit') {
    return finish({ modelSource: 'inherit', why: [classNote, ...decision.why] }, undefined, ladderNote)
  }
  if (decision.kind === 'escalate-owner') return { refused: AP_ROLE_ROUTE_ESCALATE_OWNER, detail: decision.reason }
  return { refused: AP_ROLE_ROUTE_BLOCKED, detail: decision.reason }
}
