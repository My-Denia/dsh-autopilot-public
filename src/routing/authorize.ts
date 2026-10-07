/**
 * Authorization resolution for the routing core (plan v3 "Authorization
 * model", the [R1-P1-1] rewrite and [R2-P1-1] narrowing).
 *
 * THE AUTHORITY IS THE SESSION, NEVER THE SETTINGS. GAH dispatches through
 * `ctx.subagents.start`/`startContinuable`, which the native tool-level
 * enforcement does not cover, so GAH applies the policy itself. The authority
 * is the durable per-session `subagent/model-selection-policy`; the volatile
 * subagent model-selection settings are a preference for the NEXT session
 * composition by upstream design and are NEVER read here — there is no
 * settings import, reference, or seam anywhere under `src/routing/`
 * (guarded by the source-scan test in `test/routing.test.ts`).
 *
 * Three policy states in, exact decisions out:
 *
 *  - `present`     — the policy event exists and its route list was read.
 *                    Auto selection set = policy routes ∩ live catalog.
 *  - `absent`      — projection reachable, no policy recorded (the native
 *                    default): auto mode performs INHERITANCE ONLY.
 *  - `unreachable` — the projection is not readable on this profile:
 *                    inheritance only, recorded `unreachable-inherit`.
 *
 * PLUGIN-CONFIG GRANTS ([R2-P1-1]). EVERY GAH-config-sourced explicit route —
 * `routing lock`, legacy `auditors[role]` / `executor.agentOptions`, and
 * legacy `crossFamily.pool` picks — is a grant under ONE rule, in EVERY mode:
 * allowed as an explicit selection with `authorizationSource:
 * 'plugin-config'` when no session policy excludes it, and a CONFLICT
 * (escalate-owner) when a policy exists and the route is outside it. Two
 * owner grants disagreeing is the owner-arbitrated case; the selector must
 * not pick a winner between its two authorities. This is what makes
 * `routing.mode: 'off'` honest on policy-bearing sessions: a legacy pool
 * entry cannot silently bypass a deployment's native allowlist.
 *
 * Pure domain module: no dsh imports, no I/O, no state.
 */

import { sameRoute, toRoutePin } from './identity.js'
import type { RoutePin, RouteRef } from './identity.js'

/**
 * The session model-selection policy as the ENGINE has already read it (the
 * read path is the engine's job, not the routing core's). `routes` is the
 * policy's allowlist verbatim — normalization happens here.
 */
export type SessionPolicyState =
  | { readonly kind: 'present'; readonly routes: readonly RoutePin[] }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreachable' }

/** Where an explicit-selection decision's authority came from. */
export type AuthorizationSource = 'session-policy' | 'plugin-config' | 'unreachable-inherit'

/** Every GAH-config surface that can hand the engine an explicit route ([R2-P1-1]). */
export type GrantSource = 'routing-lock' | 'legacy-role' | 'legacy-pool'

/** Trim, drop non-explicit entries, dedupe — preserving policy order. */
function normalizeRoutes(routes: readonly RouteRef[]): readonly RoutePin[] {
  const out: RoutePin[] = []
  for (const route of routes) {
    const pin = toRoutePin(route)
    if (pin === undefined) continue
    if (!out.some((kept) => sameRoute(kept, pin))) out.push(pin)
  }
  return out
}

/** The auto-mode authorized set: what auto selection may draw from, and why. */
export interface AutoAuthorization {
  /** True when auto mode must inherit only (policy absent or unreachable). */
  readonly inheritOnly: boolean
  /** Policy routes whose provider is live in the catalog, deduped, in policy order. Empty when `inheritOnly`. */
  readonly routes: readonly RoutePin[]
  /** `session-policy` when a policy governs; `unreachable-inherit` for an unreachable projection. */
  readonly authorizationSource?: AuthorizationSource
  readonly why: readonly string[]
}

/**
 * Resolve the auto-mode authorized set: policy routes ∩ live providers.
 *
 * Live-ness is PROVIDER-level on purpose (plan eligibility rule 1): core
 * routing accepts unlisted model ids, so a policy route whose provider is
 * registered stays a candidate even when the advisory listing omits it — its
 * facts then come from exact-route resolution and may legitimately be
 * unknown. Routes whose provider is not registered are dropped and NAMED,
 * because an empty intersection terminates to inheritance ([R2-P2-2a]) and a
 * silent drop would hide why.
 */
export function authorizedAutoRoutes(policy: SessionPolicyState, liveProviders: ReadonlySet<string>): AutoAuthorization {
  if (policy.kind === 'absent') {
    return {
      inheritOnly: true,
      routes: [],
      why: [
        'authorization: no session model-selection policy recorded (the native default) — auto mode performs inheritance only; settings are never consulted as authority',
      ],
    }
  }
  if (policy.kind === 'unreachable') {
    return {
      inheritOnly: true,
      routes: [],
      authorizationSource: 'unreachable-inherit',
      why: [
        'authorization: session model-selection policy projection unreachable on this profile — inheritance only, recorded as unreachable-inherit',
      ],
    }
  }
  const normalized = normalizeRoutes(policy.routes)
  const droppedInvalid = policy.routes.length - normalized.length
  const live = normalized.filter((route) => liveProviders.has(route.provider))
  const dead = normalized.filter((route) => !liveProviders.has(route.provider))
  const why: string[] = [
    `authorization: session model-selection policy present — ${normalized.length} route(s) after normalization, ${live.length} with a live provider`,
  ]
  if (droppedInvalid > 0) why.push(`authorization: ${droppedInvalid} policy entr(y|ies) lacked an explicit provider/model and were dropped`)
  if (dead.length > 0) {
    why.push(`authorization: no live provider for ${dead.map((route) => `${route.provider}/${route.model}`).join(', ')}`)
  }
  return { inheritOnly: false, routes: live, authorizationSource: 'session-policy', why }
}

/** One plugin-config grant as the engine resolved it from GAH config. */
export interface PluginGrant {
  readonly provider: string
  readonly model: string
  /** Which GAH-config surface named the route; recorded in every decision. */
  readonly source: GrantSource
}

/** The one-rule verdict on a plugin-config grant. Exact kinds, never booleans. */
export type PluginGrantDecision =
  | { readonly kind: 'allowed'; readonly authorizationSource: 'plugin-config'; readonly why: readonly string[] }
  | { readonly kind: 'conflict'; readonly reason: string; readonly why: readonly string[] }

/**
 * Apply [R2-P1-1]: EVERY GAH-config-sourced explicit route is a grant under
 * the same rule in EVERY mode. No session policy (absent or unreachable) ⇒
 * allowed — this is the 0.2.0 parity path, where plugin config was the only
 * authority. A policy that exists and does not include the route ⇒ conflict:
 * the deployment owner's session policy and the GAH config owner disagree,
 * which only the owner can arbitrate. The selector escalates; it never picks
 * between its two authorities and never silently bypasses the allowlist.
 */
export function resolvePluginGrant(grant: PluginGrant, policy: SessionPolicyState): PluginGrantDecision {
  const pin = toRoutePin(grant)
  if (pin === undefined) {
    return {
      kind: 'conflict',
      reason: `plugin-config grant from ${grant.source} is not an explicit route`,
      why: [`authorization: grant from ${grant.source} lacked provider/model — refused rather than guessed`],
    }
  }
  const label = `${grant.source} ${pin.provider}/${pin.model}`
  if (policy.kind !== 'present') {
    const state = policy.kind === 'absent' ? 'no session model-selection policy recorded' : 'policy projection unreachable'
    return {
      kind: 'allowed',
      authorizationSource: 'plugin-config',
      why: [`authorization: ${label} allowed by plugin config — ${state} (0.2.0 parity); preflight still applies`],
    }
  }
  const allowed = normalizeRoutes(policy.routes).some((route) => sameRoute(route, pin))
  if (allowed) {
    return {
      kind: 'allowed',
      authorizationSource: 'plugin-config',
      why: [`authorization: ${label} allowed by plugin config and included in the session model-selection policy`],
    }
  }
  const policyList = normalizeRoutes(policy.routes)
    .map((route) => `${route.provider}/${route.model}`)
    .join(', ')
  const reason =
    `plugin-config grant (${label}) is outside the session model-selection policy [${policyList}]: ` +
    'two owner grants conflict — dispatch blocked, run escalates needs-owner-decision'
  return {
    kind: 'conflict',
    reason,
    why: [`authorization: ${reason}`],
  }
}
