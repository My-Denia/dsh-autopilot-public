/**
 * THE refusal registry: every refusal code the plugin can raise, with one line
 * on what it means. A code that is not here cannot be thrown, because
 * {@link AutopilotError} takes a {@link RefusalCode}. Add the code here first,
 * then throw it; delete it here when its last throw site goes.
 *
 * Refusals are about the CALL, never about the work: the plugin has no plan
 * gate, no audit gate and no approval gate. The only refusals are an unknown
 * role, a caller that may not dispatch that role, a dispatch missing a write
 * scope it needs, write scopes that collide with a live writer, an unknown
 * child id, a read-only surface this deployment cannot provide, a host that
 * refused to start the child, and a reviewer verdict that failed validation.
 */

export const REFUSALS = {
  AP_NO_AGENT: 'The tool needs the calling agent and the host supplied none.',
  AP_INVALID_ARGUMENT: 'A tool argument is missing, malformed or names something that does not exist.',
  AP_ROLE_NOT_DISPATCHABLE: 'This caller may not dispatch that role: only the root and an executor-lead delegate, and an executor-lead may only dispatch scout and worker.',
  AP_WRITE_PATHS_REQUIRED: 'This role writes files, so the dispatch must declare the paths it may write.',
  AP_WRITE_PATHS_CONFLICT: 'The declared write paths intersect those of another live writer under the same root.',
  AP_UNKNOWN_CHILD: 'No delegation with this child id exists under this root.',
  AP_TOOL_SURFACE_INCOMPLETE: 'A tool this role requires is not registered on this deployment, so the child is refused rather than started blind.',
  AP_DISPATCH_FAILED: 'The host refused to start the child; the delegation is recorded as failed with the host reason.',
  AP_ROLE_VERDICT_INVALID: "The reviewer's structured output failed validation.",
} as const

/** Every code the plugin can raise. */
export type RefusalCode = keyof typeof REFUSALS

export const AP_NO_AGENT = 'AP_NO_AGENT' satisfies RefusalCode
export const AP_INVALID_ARGUMENT = 'AP_INVALID_ARGUMENT' satisfies RefusalCode
export const AP_ROLE_NOT_DISPATCHABLE = 'AP_ROLE_NOT_DISPATCHABLE' satisfies RefusalCode
export const AP_WRITE_PATHS_REQUIRED = 'AP_WRITE_PATHS_REQUIRED' satisfies RefusalCode
export const AP_WRITE_PATHS_CONFLICT = 'AP_WRITE_PATHS_CONFLICT' satisfies RefusalCode
export const AP_UNKNOWN_CHILD = 'AP_UNKNOWN_CHILD' satisfies RefusalCode
export const AP_TOOL_SURFACE_INCOMPLETE = 'AP_TOOL_SURFACE_INCOMPLETE' satisfies RefusalCode
export const AP_DISPATCH_FAILED = 'AP_DISPATCH_FAILED' satisfies RefusalCode
export const AP_ROLE_VERDICT_INVALID = 'AP_ROLE_VERDICT_INVALID' satisfies RefusalCode
