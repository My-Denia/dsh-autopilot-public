/**
 * The few domain types the live plugin still shares across modules.
 *
 * The 0.2.x run state machine (Snapshot, RunEvent, gates, audits, usage,
 * outbound manifests) is retired. Its frozen copy lives in `src/legacy/types.ts`
 * and is read only by the legacy reader. The v3 ledger is typed in
 * `./ledger-types.ts`.
 */

import type { RefusalCode } from './refusals.js'

/** Risk classification, kept for the cross-family policy. */
export type Risk = 'low' | 'medium' | 'high' | 'critical'

/**
 * Cross-family selection outcome. Four-valued, not boolean: when either side
 * inherits the deployment default the plugin cannot see which family it got,
 * so it must not claim `achieved`.
 */
export type CrossFamilyOutcome = 'not-required' | 'achieved' | 'same-family' | 'unknown-family'

/** The three 0.2.x audit role names; still the keys of the legacy `auditors` config section. */
export type AuditRole = 'plan' | 'execution' | 'rules'

/** Where the ledger lives; recorded honestly, never assumed. */
export type StoreKind = 'domain' | 'file'

/** One role's route as routing resolves it and the status view prints it. */
export interface RoutingPin {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Typed error with a stable code from the refusal registry. */
export class AutopilotError extends Error {
  constructor(message: string, readonly code: RefusalCode) {
    super(message)
    this.name = 'AutopilotError'
  }
}

/** Message for an AutopilotError or any thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
