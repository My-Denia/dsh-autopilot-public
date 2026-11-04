/**
 * THE refusal registry: every refusal code the plugin can raise, with one line
 * on what it means. A code that is not here cannot be thrown, because
 * `AutopilotError` takes a {@link RefusalCode}. Add the code here first, then
 * throw it; delete it here when its last throw site goes.
 *
 * Only `src/legacy` keeps its own `LEGACY_` codes: that reader is frozen and
 * never raises into a live call.
 */

export const REFUSALS = {
  AP_LEDGER_CONFLICT: 'The stored ledger revision is not the one the writer read; reload and retry.',
  AP_LEDGER_BUSY: 'The ledger kept changing under this write and the bounded retries ran out.',
  AP_DISPOSED: 'The plugin is shutting down; no new ledger writes are accepted.',
  AP_NO_AGENT: 'The tool needs the calling agent and the host supplied none.',
  AP_ROLE_ROUTE_NOT_ALLOWED: 'The route named by the call or an owner pin is outside the allowed model set.',
  AP_ROLE_ROUTE_INCOMPLETE: 'The call named only one of provider and model.',
  AP_ROLE_ROUTE_PREFLIGHT_FAILED: 'Preflight rejected the named route or effort.',
  AP_ROLE_ROUTE_ESCALATE_OWNER: 'Routing could not choose and the owner must arbitrate.',
  AP_ROLE_ROUTE_BLOCKED: 'Routing found no dispatchable route for this role.',
  AP_ROLE_VERDICT_INVALID: "The reviewer's structured output failed validation.",
  AP_TOOL_SURFACE_INCOMPLETE: 'A tool name the role requires is not registered on this deployment.',
  AP_ROUTE_NO_REACHABLE_WORK_CLASS: 'The work class maps to ladder tiers that hold no reachable authorized route.',
  AP_STORE_CORRUPT: 'A stored record is not an object the store can read.',
  AP_INVALID_ARGUMENT: 'A tool argument is missing, malformed or names something that does not exist.',
  AP_ROLE_NOT_DISPATCHABLE: 'The calling agent may not dispatch this role (only an executor-lead dispatches, and only scout, clerk and worker).',
  AP_WRITE_PATHS_REQUIRED: 'This role writes files, so the dispatch must declare the paths it may write.',
  AP_WRITE_PATHS_CONFLICT: 'The declared write paths intersect those of another active writer under the same root.',
  AP_UNKNOWN_CHILD: 'No delegation with this child id exists under this root.',
  AP_DISPATCH_FAILED: 'The host refused to start the child; the delegation is recorded as failed with the host reason.',
} as const

/** Every code the plugin can raise. */
export type RefusalCode = keyof typeof REFUSALS

export const AP_LEDGER_CONFLICT = 'AP_LEDGER_CONFLICT' satisfies RefusalCode
export const AP_LEDGER_BUSY = 'AP_LEDGER_BUSY' satisfies RefusalCode
export const AP_DISPOSED = 'AP_DISPOSED' satisfies RefusalCode
export const AP_NO_AGENT = 'AP_NO_AGENT' satisfies RefusalCode
export const AP_ROLE_ROUTE_NOT_ALLOWED = 'AP_ROLE_ROUTE_NOT_ALLOWED' satisfies RefusalCode
export const AP_ROLE_ROUTE_INCOMPLETE = 'AP_ROLE_ROUTE_INCOMPLETE' satisfies RefusalCode
export const AP_ROLE_ROUTE_PREFLIGHT_FAILED = 'AP_ROLE_ROUTE_PREFLIGHT_FAILED' satisfies RefusalCode
export const AP_ROLE_ROUTE_ESCALATE_OWNER = 'AP_ROLE_ROUTE_ESCALATE_OWNER' satisfies RefusalCode
export const AP_ROLE_ROUTE_BLOCKED = 'AP_ROLE_ROUTE_BLOCKED' satisfies RefusalCode
export const AP_ROLE_VERDICT_INVALID = 'AP_ROLE_VERDICT_INVALID' satisfies RefusalCode
export const AP_TOOL_SURFACE_INCOMPLETE = 'AP_TOOL_SURFACE_INCOMPLETE' satisfies RefusalCode
export const AP_ROUTE_NO_REACHABLE_WORK_CLASS = 'AP_ROUTE_NO_REACHABLE_WORK_CLASS' satisfies RefusalCode
export const AP_STORE_CORRUPT = 'AP_STORE_CORRUPT' satisfies RefusalCode
export const AP_INVALID_ARGUMENT = 'AP_INVALID_ARGUMENT' satisfies RefusalCode
export const AP_ROLE_NOT_DISPATCHABLE = 'AP_ROLE_NOT_DISPATCHABLE' satisfies RefusalCode
export const AP_WRITE_PATHS_REQUIRED = 'AP_WRITE_PATHS_REQUIRED' satisfies RefusalCode
export const AP_WRITE_PATHS_CONFLICT = 'AP_WRITE_PATHS_CONFLICT' satisfies RefusalCode
export const AP_UNKNOWN_CHILD = 'AP_UNKNOWN_CHILD' satisfies RefusalCode
export const AP_DISPATCH_FAILED = 'AP_DISPATCH_FAILED' satisfies RefusalCode
