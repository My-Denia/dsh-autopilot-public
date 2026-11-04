/**
 * Cross-family selection helpers, ported from engine.ts (`familyOf`,
 * `selectCrossFamily`, `CrossFamilyPolicy`); the engine copy is deleted later.
 *
 * The rule inherited from the CC lineage is "the builder family is not the
 * reviewer family": a blind spot shared by one provider passes both gates
 * unchallenged. It is a routing STRATEGY, not a gate. A one-provider deployment
 * is legitimate, so the recorded outcome (`same-family`, `unknown-family`) is
 * what keeps the record from claiming an independence the dispatch never had.
 */

import type { CrossFamilyOutcome, Risk } from '../domain/types.js'

/** A route as far as family is concerned: structurally a subset of the engine's agent options. */
export interface RouteLike {
  readonly provider?: string
  readonly model?: string
}

/**
 * The family key of one route: the PROVIDER. Two models behind one provider are
 * deliberately NOT different families.
 */
export function familyOf(options: RouteLike | undefined): string | undefined {
  const provider = options?.provider?.trim()
  return provider !== undefined && provider.length > 0 ? provider : undefined
}

/** Resolved cross-family policy. */
export interface CrossFamilyPolicy {
  readonly enabled: boolean
  /** Risk at which cross-family review starts being sought. */
  readonly minRisk: Risk
  /** Candidate routes to draw an out-of-family reviewer from. */
  readonly pool: readonly RouteLike[]
}

/** Inputs to cross-family selection. Pure. */
export interface CrossFamilySelection {
  readonly risk: Risk
  /** What role-level config already resolved to; the starting point. */
  readonly configured: RouteLike | undefined
  /** The builder's route: the family a reviewer should NOT share. */
  readonly executor: RouteLike | undefined
  readonly policy: CrossFamilyPolicy
}

/** What to dispatch with, and what may honestly be claimed about it. */
export interface CrossFamilyChoice {
  readonly agentOptions: RouteLike | undefined
  readonly outcome: CrossFamilyOutcome
  readonly diagnostic?: string
}

const RISK_ORDER: readonly Risk[] = ['low', 'medium', 'high', 'critical']

/** Pick the reviewer route for one dispatch, preferring a family the builder is not from once risk reaches the floor. */
export function selectCrossFamily(selection: CrossFamilySelection): CrossFamilyChoice {
  const { policy } = selection
  if (!policy.enabled || RISK_ORDER.indexOf(selection.risk) < RISK_ORDER.indexOf(policy.minRisk)) {
    return { agentOptions: selection.configured, outcome: 'not-required' }
  }
  const builder = familyOf(selection.executor)
  const configured = familyOf(selection.configured)
  if (builder === undefined) {
    return {
      agentOptions: selection.configured,
      outcome: 'unknown-family',
      diagnostic: 'the executor route inherits the deployment default, so the family it builds with is not observable here; cross-family can be claimed neither way',
    }
  }
  if (configured !== undefined && configured !== builder) {
    return { agentOptions: selection.configured, outcome: 'achieved' }
  }
  const alternative = policy.pool.find((candidate) => {
    const family = familyOf(candidate)
    return family !== undefined && family !== builder
  })
  if (alternative !== undefined) return { agentOptions: alternative, outcome: 'achieved' }
  if (configured === undefined) {
    return {
      agentOptions: selection.configured,
      outcome: 'unknown-family',
      diagnostic: `no configured auditor route and no pool entry outside the builder family "${builder}"; the dispatched family is whatever the deployment defaults to`,
    }
  }
  return {
    agentOptions: selection.configured,
    outcome: 'same-family',
    diagnostic: `auditor and executor are both family "${builder}" and the pool offers no alternative; a blind spot shared by that family passes both gates unchallenged`,
  }
}
