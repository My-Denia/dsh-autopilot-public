/**
 * Two-axis route identity for auditor independence (plan v3 "Identity levels").
 *
 * WHY TWO AXES AND NEVER ONE WORD. The only native facts about a route are
 * the provider route key and the provider-owned model id; upstream carries no
 * lineage or alias information between them. Collapsing identity into one
 * boolean ("same model" / "different model") would force one of two lies:
 * either `deepseek/deepseek-chat` and `gateway/deepseek-chat` count as
 * independent (they may be the same weights behind two routes — alias
 * detection is impossible), or `openai/gpt-a` and `openai/gpt-b` count as
 * non-independent (they are different weights behind one vendor). Recording
 * {@link modelAxis} and {@link providerAxis} SEPARATELY lets every consumer
 * state exactly which comparison it made.
 *
 * CEILING, RECORDED HONESTLY. `distinct` on an axis means only "not the same
 * trim-exact string on this axis". It never claims different weights, and no
 * `independent`-strength language is used anywhere in this module, because
 * the native facts cannot support that claim. The 0.2.0 cross-family OUTCOME
 * vocabulary is kept (`achieved` now requires `distinct` on BOTH axes), so
 * historical records stay comparable while the axes add the missing proof.
 *
 * Pure domain module: no dsh imports, no I/O, no state.
 */

/** One axis of route identity. `unknown` = a side carries no explicit route (inheritance). */
export type IdentityAxis = 'same' | 'distinct' | 'unknown'

/**
 * A model route as the routing core sees it: a structural subset of the
 * engine's `AgentOptionsLike` (provider/model optional because a dispatch can
 * inherit the deployment default, carrying no explicit route at all).
 */
export interface RouteRef {
  readonly provider?: string
  readonly model?: string
}

/**
 * An explicit route: both fields present and non-blank. Locks, session-policy
 * entries, and selected routes are always this strong; only inherited
 * dispatches are not.
 */
export interface RoutePin {
  readonly provider: string
  readonly model: string
}

/** A blank-or-missing field trimmed to `undefined`. */
function idOf(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
}

/**
 * The model axis of two routes: `same` when the model ids are identical
 * TRIM-EXACT strings, across ANY providers — the conservative same-family
 * call, because the same id behind a second provider may be the same weights
 * and we cannot prove otherwise. `unknown` when either side carries no
 * explicit model (inheritance). `distinct` otherwise, claiming nothing about
 * weights.
 */
export function modelAxis(a: RouteRef | undefined, b: RouteRef | undefined): IdentityAxis {
  const am = idOf(a?.model)
  const bm = idOf(b?.model)
  if (am === undefined || bm === undefined) return 'unknown'
  return am === bm ? 'same' : 'distinct'
}

/**
 * The provider axis of two routes: `same` for identical trim-exact provider
 * route keys (the 0.2.0 "family"), `unknown` when either side inherits, and
 * `distinct` otherwise. A different provider is the strongest identity signal
 * the native facts offer — and still not a weights claim.
 */
export function providerAxis(a: RouteRef | undefined, b: RouteRef | undefined): IdentityAxis {
  const ap = idOf(a?.provider)
  const bp = idOf(b?.provider)
  if (ap === undefined || bp === undefined) return 'unknown'
  return ap === bp ? 'same' : 'distinct'
}

/** Trim-exact equality of both route fields. The policy-membership comparison. */
export function sameRoute(a: RouteRef | undefined, b: RouteRef | undefined): boolean {
  const ap = idOf(a?.provider)
  const bp = idOf(b?.provider)
  const am = idOf(a?.model)
  const bm = idOf(b?.model)
  return ap !== undefined && ap === bp && am !== undefined && am === bm
}

/** Whether a route is explicit (both fields present and non-blank). */
export function isExplicitRoute(route: RouteRef | undefined): route is RoutePin {
  return idOf(route?.provider) !== undefined && idOf(route?.model) !== undefined
}

/** Normalize a route to its trimmed explicit form, or `undefined` when it is not one. */
export function toRoutePin(route: RouteRef | undefined): RoutePin | undefined {
  if (!isExplicitRoute(route)) return undefined
  return { provider: route.provider.trim(), model: route.model.trim() }
}

/** The 0.2.0 cross-family outcome words, now derived from BOTH axes. */
export type IndependenceOutcome = 'achieved' | 'same-family' | 'unknown-family' | 'not-required'

/**
 * Independence as the routing core may record it: both axes separately, plus
 * the 0.2.0 outcome word derived from them under the plan's rule —
 * `achieved` requires `distinct` on BOTH axes; a known executor pin with
 * either axis not distinct is `same-family`; an executor that inherits
 * (`unknown` on an axis) is `unknown-family`; below the risk floor the
 * constraint was `not-required`. The record never claims weight independence.
 */
export interface IndependenceRecord {
  readonly modelAxis: IdentityAxis
  readonly providerAxis: IdentityAxis
  readonly outcome: IndependenceOutcome
}

/**
 * Record one candidate's identity against the executor's CURRENT pin.
 *
 * Axes are recomputed at every dispatch by the caller passing the live pin
 * (plan [R2-P2-2b]: pins stabilize routes, not judgments) — this function is
 * deliberately stateless.
 */
export function independenceOf(
  candidate: RouteRef | undefined,
  executorPin: RouteRef | undefined,
  required: boolean,
): IndependenceRecord {
  const model = modelAxis(candidate, executorPin)
  const provider = providerAxis(candidate, executorPin)
  if (!required) return { modelAxis: model, providerAxis: provider, outcome: 'not-required' }
  if (model === 'unknown' || provider === 'unknown') {
    return { modelAxis: model, providerAxis: provider, outcome: 'unknown-family' }
  }
  if (model === 'distinct' && provider === 'distinct') {
    return { modelAxis: model, providerAxis: provider, outcome: 'achieved' }
  }
  return { modelAxis: model, providerAxis: provider, outcome: 'same-family' }
}
