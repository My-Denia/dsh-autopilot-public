/**
 * Routing status (DESIGN §1.2 boundary (e)): the READER's answer to "is routing
 * actually live on this deployment, and which route does each role stand on".
 *
 * WHY THIS EXISTS. Every routing fact the plugin produces is recorded on a
 * DECISION (a dispatch's `detail.routing`, with its `why` trace, its
 * `authorizationSource` and its candidate set). That is the right place for
 * authorization-bearing state, and it is unreadable for the question a person
 * actually asks: a deployment can have a fully configured ladder, coverage
 * reporting an unreachable model, and EVERY dispatch still inheriting the
 * deployment default, because auto mode performs inheritance only when the
 * session carries no model-selection policy (DESIGN boundary (e), measured on
 * two real 0.2.0 hosts). Until this projection there was no surface that said
 * so: `routingReachability` answers a different question ("does every observed
 * model have a reachable class"), and on a healthy ladder it is silent.
 *
 * WHAT IT MAY CLAIM. Only facts already resolved elsewhere: the config-derived
 * mode/preference/source, the per-role resolved routing, the owner's ladder and
 * work-class mapping, the run's own pins, and the policy state the engine
 * already read for the dispatching session. Nothing is inferred from a model
 * NAME (DESIGN §1.2's standing prohibition) and nothing is guessed when a read
 * could not happen — an unreadable policy is `unobserved`, never `present` and
 * never `absent`.
 *
 * Pure domain module: no dsh imports, no I/O, no state.
 */

import type { Snapshot } from '../domain/types.js'
import type { ResolvedRouting } from '../engine.js'
import type { SessionPolicyState } from './authorize.js'
import type { WorkClassAxis, WorkClassName, WorkClassTier } from './work-class.js'
import { DEFAULT_ROLE_WORK_CLASS, DEFAULT_WORK_CLASSES, WORK_CLASS_NAMES } from './work-class.js'

/** The five routed roles, in the vocabulary order the engine uses. */
export const ROUTING_STATUS_ROLES = [
  'executor', 'planner', 'plan-auditor', 'execution-auditor', 'rules-auditor',
] as const

export type RoutingStatusRole = (typeof ROUTING_STATUS_ROLES)[number]

/** What a role's routing config resolves to, independent of any dispatch. */
export type RoutingStatusEffective = 'auto' | 'inherit' | 'locked'

/** What the reader could observe about the SESSION's model-selection policy. */
export type RoutingStatusPolicyState =
  /** The engine read the policy for the dispatching session: auto mode may select. */
  | 'present'
  /** No policy recorded on the session (the native default): auto mode inherits only. */
  | 'absent'
  /** The policy projection could not be read: auto mode inherits only, recorded as such. */
  | 'unreachable'
  /**
   * The reader had no live session to ask (the HTTP/service path). This is the
   * ABSENCE of a read, not a finding about the policy — the one answer that
   * must never be folded into `absent`.
   */
  | 'unobserved'

/** One role's place in the routing status. */
export interface RoutingStatusRoleView {
  readonly role: RoutingStatusRole
  readonly effective: RoutingStatusEffective
  /** Present iff `effective === 'locked'`: the owner's explicit route. */
  readonly lock?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  /**
   * The work class this role would draw from on an auto dispatch — the owner's
   * per-role override, else the owner-table default. ABSENT for roles that make
   * no selection (inherit/locked), because a class the role never consults is
   * not a fact about that role.
   */
  readonly workClass?: {
    readonly name: WorkClassName
    readonly axis: WorkClassAxis
    readonly tiers: readonly WorkClassTier[]
    /**
     * Whether the class machinery APPLIES (the ladder is configured, or the
     * owner overrode this class/role assignment). False is the shipped-default
     * shape: the mapping is recorded but restricts nothing (0.2.0 parity).
     */
    readonly engaged: boolean
  }
}

/** One work class as resolved, for the reader who wants the whole table. */
export interface RoutingStatusWorkClassView {
  readonly name: WorkClassName
  readonly axis: WorkClassAxis
  readonly tiers: readonly WorkClassTier[]
}

/** One role's ACTIVE route (a pin this run's own dispatches settled on). */
export interface RoutingStatusPinView {
  readonly role: RoutingStatusRole
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/**
 * The routing status a reader projects. Every field is derived; there is no
 * engine-local state in here, so the same snapshot renders the same view.
 */
export interface RoutingStatusView {
  readonly mode: 'auto'
  /** The EFFECTIVE preference selections rank by. */
  readonly preference: string
  /**
   * Whether that preference came from an explicit owner write or the shipped
   * default (the config loader's explicitness ceiling — a `balanced` written as
   * the default still records `default`; see DESIGN boundary (c)).
   */
  readonly preferenceSource: 'explicit' | 'default'
  /** The session's policy state as the ENGINE read it, or `unobserved`. */
  readonly policyState: RoutingStatusPolicyState
  /** Present iff `policyState === 'present'`: how many routes the policy allows. */
  readonly policyRouteCount?: number
  /**
   * THE HEADLINE. `live` = auto mode with a policy present, i.e. selections can
   * actually happen; `inherit-only` = auto mode whose dispatches inherit the
   * deployment default because the policy is absent/unreachable; `unobserved` =
   * the policy could not be read, so nothing about selection is claimed.
   */
  readonly dispatch: 'live' | 'inherit-only' | 'unobserved'
  readonly roles: readonly RoutingStatusRoleView[]
  /** Only roles the run has actually pinned, in vocabulary order. */
  readonly pins: readonly RoutingStatusPinView[]
  readonly workClasses: readonly RoutingStatusWorkClassView[]
  /** Member COUNT per tier — the ids themselves are the owner's config, not this view's. */
  readonly ladderTiers: Readonly<Record<WorkClassTier, number>>
  readonly auditTier: WorkClassTier | 'none'
}

/**
 * Project the routing status, or `undefined` when there is nothing ROUTING to
 * report.
 *
 * `mode: 'off'` returns `undefined` deliberately: with routing switched off
 * every dispatch inherits (0.2.0 parity), so a block full of `inherit` rows
 * would read like a routing state that failed to select rather than a feature
 * the owner turned off. The absent field is the honest record, exactly as the
 * other absent-means-unobserved fields on the status view are.
 *
 * @param snapshot - the run's durable state (read for its own pins only).
 * @param routing - the LIVE resolved routing section (the same value the
 *   dispatch sites resolve), so a volatile config edit is visible here without
 *   a restart.
 * @param policy - the session policy state the engine read for the DISPATCHING
 *   session, or `undefined` when the reader has no live session to ask (the
 *   service/HTTP path). `undefined` renders `unobserved`; it is never folded
 *   into `absent`.
 */
export function routingStatusOf(
  snapshot: Snapshot,
  routing: ResolvedRouting,
  policy?: SessionPolicyState,
): RoutingStatusView | undefined {
  if (routing.mode !== 'auto') return undefined

  const policyState: RoutingStatusPolicyState =
    policy === undefined ? 'unobserved' : policy.kind
  const dispatch: RoutingStatusView['dispatch'] =
    policyState === 'present' ? 'live' : policyState === 'unobserved' ? 'unobserved' : 'inherit-only'

  const roles: RoutingStatusRoleView[] = ROUTING_STATUS_ROLES.map((role) => {
    const roleRouting = routing.roles[role]
    if (roleRouting.mode === 'locked') {
      return {
        role,
        effective: 'locked',
        lock: {
          provider: roleRouting.provider,
          model: roleRouting.model,
          ...(roleRouting.reasoningEffort === undefined ? {} : { reasoningEffort: roleRouting.reasoningEffort }),
        },
      }
    }
    if (roleRouting.mode === 'inherit') return { role, effective: 'inherit' }
    const name = roleRouting.workClass ?? DEFAULT_ROLE_WORK_CLASS[role]
    const cls = routing.workClasses[name]
    const seeded = DEFAULT_WORK_CLASSES[name]
    const classOverridden =
      cls.axis !== seeded.axis ||
      cls.tiers.length !== seeded.tiers.length ||
      cls.tiers.some((tier, index) => tier !== seeded.tiers[index])
    return {
      role,
      effective: 'auto',
      workClass: {
        name,
        axis: cls.axis,
        tiers: [...cls.tiers],
        // The SAME engagement rule the dispatch site applies
        // (`selectForRole`): the machinery engages once the ladder holds a
        // member anywhere, or the owner overrode this class's definition, or
        // the owner assigned a class to this role. The override half is
        // computed from the resolved class versus the owner table — the one
        // definition of "the owner wrote a mapping" in this codebase.
        engaged: hasLadderMembers(routing) || classOverridden || roleRouting.workClass !== undefined,
      },
    }
  })

  const pins: RoutingStatusPinView[] = ROUTING_STATUS_ROLES.flatMap((role) => {
    const pin = snapshot.routingPins?.[role]
    if (pin === undefined) return []
    return [{
      role,
      provider: pin.provider,
      model: pin.model,
      ...(pin.reasoningEffort === undefined ? {} : { reasoningEffort: pin.reasoningEffort }),
    }]
  })

  return {
    mode: 'auto',
    preference: routing.preference,
    preferenceSource: routing.preferenceSource,
    policyState,
    ...(policy === undefined || policy.kind !== 'present' ? {} : { policyRouteCount: policy.routes.length }),
    dispatch,
    roles,
    pins,
    workClasses: WORK_CLASS_NAMES.map((name) => ({
      name,
      axis: routing.workClasses[name].axis,
      tiers: [...routing.workClasses[name].tiers],
    })),
    ladderTiers: {
      economy: routing.ladder.tiers.economy.length,
      standard: routing.ladder.tiers.standard.length,
      reserve: routing.ladder.tiers.reserve.length,
    },
    auditTier: routing.ladder.auditTier,
  }
}

/** Whether ANY ladder tier holds a member — the shipped-default-versus-configured test. */
function hasLadderMembers(routing: ResolvedRouting): boolean {
  return (['economy', 'standard', 'reserve'] as const).some(
    (tier) => routing.ladder.tiers[tier].some((entry) => entry.trim().length > 0),
  )
}
