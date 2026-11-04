/**
 * Per-child tool allow-list. The host has no `toolFilter` on
 * `startActivation`; the plugin restricts the child's tools on `agent/created`.
 * `tools.restrict()` throws on the first name the profile does not register, so
 * a requested list must be narrowed to the registry first, and narrowing must
 * never be silent. Ported from engine.ts (`resolveToolAllow`,
 * `parseRestrictRejection`); the engine copy is deleted later.
 */

import { AP_TOOL_SURFACE_INCOMPLETE } from '../domain/refusals.js'
import { AutopilotError } from '../domain/types.js'
import type { DelegationRoleName } from '../domain/ledger-types.js'
import { REQUIRED_READ_TOOLS, ROLES } from './index.js'

/**
 * The names under which a deployment registers a shell. `bash` and `pwsh` are one
 * capability split by platform; the terminal pair carries command text too.
 */
export const SHELL_TOOLS: readonly string[] = [
  'bash', 'pwsh', 'run_code', 'terminal_open', 'terminal_send',
]

/**
 * Interchangeable capability families. A family lets narrowing tell "this
 * deployment SPELLS the capability differently" from "this deployment does
 * not HAVE it": only losing every name of a family the request named is an
 * error.
 */
const TOOL_FAMILIES: ReadonlyArray<{ readonly label: string; readonly members: readonly string[] }> = [
  { label: 'shell', members: SHELL_TOOLS },
  { label: 'file-write', members: ['write', 'edit', 'str_replace_editor'] },
  { label: 'search', members: ['glob', 'grep'] },
]

/** What one requested allow-list resolves to against a deployment's real registry. */
export interface ToolAllowResolution {
  /** The names to hand the host: `requested` ∩ registry, or `requested` verbatim when the registry is unknown. */
  readonly allow: readonly string[]
  /** Requested names this deployment does not register. */
  readonly dropped: readonly string[]
  /** Durable record of the narrowing; ABSENT when nothing was dropped. */
  readonly diagnostic?: string
}

function quoteNames(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(', ')
}

/**
 * Resolve a requested tool allow-list against what a deployment registers.
 * A drop that would cost a required name or a whole requested family REFUSES
 * (`AP_TOOL_SURFACE_INCOMPLETE`) instead of narrowing, because a reviewer that
 * cannot `read` still returns a schema-valid verdict having seen nothing.
 *
 * @param requested names the plugin asked for.
 * @param registered the deployment's restrictable tool names, or undefined when the host cannot be asked.
 * @param required names whose loss must fail the dispatch.
 * @param label what is being dispatched, for refusal and diagnostic text.
 */
export function resolveToolAllow(
  requested: readonly string[],
  registered: readonly string[] | undefined,
  required: readonly string[],
  label: string,
): ToolAllowResolution {
  if (registered === undefined) return { allow: [...requested], dropped: [] }
  const known = new Set(registered)
  const allow = requested.filter((name) => known.has(name))
  const dropped = requested.filter((name) => !known.has(name))
  if (dropped.length === 0) return { allow, dropped: [] }

  const missing = required.filter((name) => !known.has(name))
  if (missing.length > 0) {
    throw new AutopilotError(
      `${label} cannot be dispatched: this deployment does not register ${quoteNames(missing)}, and an agent narrowed off that surface would still return a schema-valid answer having seen nothing`,
      AP_TOOL_SURFACE_INCOMPLETE,
    )
  }
  for (const family of TOOL_FAMILIES) {
    const asked = requested.filter((name) => family.members.includes(name))
    if (asked.length === 0) continue
    if (asked.some((name) => known.has(name))) continue
    throw new AutopilotError(
      `${label} cannot be dispatched: this deployment registers none of the ${family.label} tools it was given (${quoteNames(asked)}); narrowing would hand the child a surface with no ${family.label} capability at all`,
      AP_TOOL_SURFACE_INCOMPLETE,
    )
  }
  return {
    allow,
    dropped,
    diagnostic: `tool surface narrowed for ${label}: this deployment does not register ${quoteNames(dropped)} (kept ${allow.length} of ${requested.length})`,
  }
}

/**
 * Upstream's restrict rejection, which names BOTH the unknown tools and the
 * deployment's complete restrictable set:
 * `tools.restrict() names unknown global tools "a", "b"; known global tools: c, d, e`.
 */
const RESTRICT_REJECTION = /tools\.restrict\(\) names unknown global tools?\s+(.+?);\s*known global tools:\s*(.*)$/s

/**
 * Recover the deployment's tool registry from a `tools.restrict()` rejection
 * (the seam of last resort when no registry probe is wired). Returns undefined
 * for any message that is not exactly that shape.
 */
export function parseRestrictRejection(
  message: string,
): { readonly unknown: readonly string[]; readonly known: readonly string[] } | undefined {
  const match = RESTRICT_REJECTION.exec(message)
  const unknownText = match?.[1]
  const knownText = match?.[2]
  if (unknownText === undefined || knownText === undefined) return undefined
  const unknown = [...unknownText.matchAll(/"([^"]+)"/g)]
    .map((entry) => entry[1])
    .filter((name): name is string => name !== undefined)
  if (unknown.length === 0) return undefined
  const trimmed = knownText.trim()
  const known = trimmed === '(none)' || trimmed.length === 0
    ? []
    : trimmed.split(',').map((part) => part.trim()).filter((part) => part.length > 0)
  return { unknown, known }
}

/**
 * The final allow-list for one child: the role's requested tools narrowed to
 * the registered names, plus its delegation tools; or `inherit` for a write
 * role with no delegation tools (no restriction at all).
 *
 * A write role WITH delegation tools (executor-lead) also returns `inherit`:
 * the delegation tools are added to the child's surface by the engine, and the
 * allow-list vocabulary cannot express "everything except X". Callers that need
 * the delegation names read `ROLES[role].delegationTools`.
 *
 * Read-only roles throw `AP_TOOL_SURFACE_INCOMPLETE` when `read` is not
 * registered; extra names (web_*, connector tools the engine appends) are
 * narrowed with a diagnostic by {@link allowListDiagnostic}.
 *
 * @param registeredToolNames the deployment's registered tool names, or undefined when unknown (request passes through).
 * @param extraRequested connector tool names actually present that a clerk may use (the engine passes them).
 */
export function allowListFor(
  role: DelegationRoleName,
  registeredToolNames: readonly string[] | undefined,
  extraRequested: readonly string[] = [],
): readonly string[] | 'inherit' {
  const spec = ROLES[role]
  if (spec.requestedTools === 'inherit') return 'inherit'
  const requested = role === 'clerk' ? [...spec.requestedTools, ...extraRequested] : spec.requestedTools
  const resolved = resolveToolAllow(requested, registeredToolNames, REQUIRED_READ_TOOLS, `the ${role}`)
  const allow = [...resolved.allow]
  for (const name of spec.delegationTools) if (!allow.includes(name)) allow.push(name)
  return allow
}

/** The narrowing record for the same inputs as {@link allowListFor}, or undefined when nothing was dropped. */
export function allowListDiagnostic(
  role: DelegationRoleName,
  registeredToolNames: readonly string[] | undefined,
  extraRequested: readonly string[] = [],
): string | undefined {
  const spec = ROLES[role]
  if (spec.requestedTools === 'inherit') return undefined
  const requested = role === 'clerk' ? [...spec.requestedTools, ...extraRequested] : spec.requestedTools
  return resolveToolAllow(requested, registeredToolNames, REQUIRED_READ_TOOLS, `the ${role}`).diagnostic
}
