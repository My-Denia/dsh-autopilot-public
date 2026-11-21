/** The few domain types every module shares. */

import type { RefusalCode } from './refusals.js'

/**
 * Typed error with a stable code from the refusal registry.
 *
 * The code is part of the message the model sees: dsh turns a thrown error into
 * a failed tool result carrying only its message, so a code that lived only on
 * the instance would be invisible to the caller. Messages therefore read
 * `AP_SOMETHING: what happened`, and the code is also kept on {@link code} for
 * programmatic assertions.
 */
export class AutopilotError extends Error {
  constructor(message: string, readonly code: RefusalCode) {
    super(`${code}: ${message}`)
    this.name = 'AutopilotError'
  }
}

/** Message for an AutopilotError or any thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
