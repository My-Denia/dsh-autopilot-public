/**
 * Per-child tool allow-lists.
 *
 * The host's `startActivation` has no tool filter, so the plugin restricts the
 * child's tools on `agent/created` with `ctx.tools.restrict({ allow })`. The
 * registry rejects an unknown name outright, so a requested list must first be
 * narrowed to the names this deployment actually registers — and narrowing
 * must never be silent: a read-only role that loses `read` is refused, because
 * a reviewer that cannot read still returns a schema-valid verdict having seen
 * nothing.
 *
 * Pure module: it takes the role's tool data as an argument, so it imports no
 * role table and stays testable in isolation.
 */

import { AP_TOOL_SURFACE_INCOMPLETE } from '../domain/refusals.js'
import { AutopilotError } from '../domain/types.js'

/** Read-only file tools every deployment that can be reviewed at all registers. */
export const READ_ONLY_TOOLS: readonly string[] = ['read', 'glob', 'grep', 'read_image']

/** Web tools a scout asks for; losing them narrows the scout, it does not refuse it. */
export const WEB_TOOLS: readonly string[] = ['web_fetch', 'web_search']

/** Names a read-only role may never lose: a reviewer without `read` is a rubber stamp. */
export const REQUIRED_READ_TOOLS: readonly string[] = ['read']

/** The parts of a role this module reads. */
export interface RoleToolSpec {
  readonly name: string
  readonly requestedTools: readonly string[] | 'inherit'
  readonly delegationTools: readonly string[]
}

/** What one requested allow-list resolves to against a deployment's registry. */
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
  return {
    allow,
    dropped,
    diagnostic: `tool surface narrowed for ${label}: this deployment does not register ${quoteNames(dropped)} (kept ${allow.length} of ${requested.length})`,
  }
}

/**
 * The tool registry's own rejection, which names BOTH the unknown tools and the
 * deployment's complete restrictable set:
 * `tools.restrict() names unknown global tools "a", "b"; known global tools: c, d, e`.
 */
const RESTRICT_REJECTION = /tools\.restrict\(\) names unknown global tools?\s+(.+?);\s*known global tools:\s*(.*)$/s

/**
 * Recover the deployment's tool registry from a `tools.restrict()` rejection
 * (the seam of last resort when the registry probe read nothing).
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
 * The final allow-list for one child: `inherit` for a write role (no
 * restriction at all; its own delegation tools are own-scope registrations,
 * which restrictions never touch), or the role's requested names narrowed to
 * the registry for a read-only role.
 *
 * @param registeredToolNames the deployment's registered tool names, or undefined when unknown (the request passes through).
 */
export function allowListFor(
  spec: RoleToolSpec,
  registeredToolNames: readonly string[] | undefined,
): readonly string[] | 'inherit' {
  if (spec.requestedTools === 'inherit') return 'inherit'
  const resolved = resolveToolAllow(spec.requestedTools, registeredToolNames, REQUIRED_READ_TOOLS, `the ${spec.name}`)
  const allow = [...resolved.allow]
  for (const name of spec.delegationTools) if (!allow.includes(name)) allow.push(name)
  return allow
}

/** The narrowing record for the same inputs as {@link allowListFor}, or undefined when nothing was dropped. */
export function allowListDiagnostic(
  spec: RoleToolSpec,
  registeredToolNames: readonly string[] | undefined,
): string | undefined {
  if (spec.requestedTools === 'inherit') return undefined
  return resolveToolAllow(spec.requestedTools, registeredToolNames, REQUIRED_READ_TOOLS, `the ${spec.name}`).diagnostic
}
