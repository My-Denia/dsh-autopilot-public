/**
 * Delegation roles (goal-workflow vocabulary): scout, clerk, worker,
 * executor-lead, planner, reviewer. The main agent decides and integrates; it
 * is not a role.
 *
 * A role is DATA: a persona brief, a tool surface, a depth, a delivery mode and
 * a default work class. The engine reads these to build one
 * `SubagentRuntime.startActivation` call per child. The host has no per-child
 * persona or tool filter, so the plugin applies the tool surface on
 * `agent/created` (see ./tools.ts) and hands the persona in the prompt.
 *
 * Pure module: no dsh imports, no I/O.
 */

import type { DelegationRoleName, ReviewFinding, ReviewVerdict } from '../domain/ledger-types.js'
import type { WorkClassName } from '../routing/work-class.js'

export type { DelegationRoleName } from '../domain/ledger-types.js'

/** The role vocabulary in a fixed order (display, validation, docs). */
export const ROLE_NAMES: readonly DelegationRoleName[] = ['scout', 'clerk', 'worker', 'executor-lead', 'planner', 'reviewer']

/**
 * The tool names a read-only child asks for. Verified against the dsh rc.5
 * packages: `read`/`read_image` (dsh-tool-fs), `glob`/`grep` (dsh-tool-fs-search),
 * `web_fetch`/`web_search` (dsh-tool-web). They are REQUESTED names; the
 * engine narrows them to what the profile registers (./tools.ts).
 */
export const READ_ONLY_TOOLS: readonly string[] = ['read', 'glob', 'grep', 'read_image']
export const WEB_TOOLS: readonly string[] = ['web_fetch', 'web_search']
export const MCP_RESOURCE_TOOLS: readonly string[] = [
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
]

/** Names a read-only role may never lose: a reviewer without `read` is a rubber stamp. */
export const REQUIRED_READ_TOOLS: readonly string[] = ['read']

/** Tools only an executor-lead receives, so it can dispatch leaves. */
export const DELEGATION_TOOLS: readonly string[] = ['autopilot_delegate', 'autopilot_agents']

export interface RoleSpec {
  readonly name: DelegationRoleName
  /** Concise English system brief handed to the child in its prompt. */
  readonly persona: string
  /** Whether the role may modify files / run mutating tools. */
  readonly write: boolean
  /** Requested tool names (narrowed to the registry), or `inherit` = no restriction beyond `delegationTools`. */
  readonly requestedTools: readonly string[] | 'inherit'
  /** Extra tools added on top of `requestedTools` (executor-lead only). */
  readonly delegationTools: readonly string[]
  /** Roles this role may dispatch itself. Empty = a leaf. */
  readonly canDispatch: readonly DelegationRoleName[]
  /** `maxDepth` sent to the host (1 = leaf below the root; the executor-lead is 2). */
  readonly maxDepth: number
  /** One turn, then done; no follow-up messages. */
  readonly oneShot: boolean
  /** Who receives the settlement: `parent` = the native settlement notice, `caller` = the dispatching call. */
  readonly delivery: 'parent' | 'caller'
  /** The work class the role draws from when the dispatch names none. */
  readonly defaultWorkClass: WorkClassName
  /** Whether a dispatch must declare disjoint `writePaths`. */
  readonly requiresWritePaths: boolean
}

const COMMON_REPORT =
  'Report back briefly: what you did or found, the evidence (file paths and line numbers, command output), and anything you could not do or are unsure about. If you cannot finish within your role or need a stronger model, say so plainly instead of guessing; the main agent decides.'

export const ROLES: Readonly<Record<DelegationRoleName, RoleSpec>> = {
  scout: {
    name: 'scout',
    persona:
      'You are a scout: a read-only search and inventory agent. Find, read and compress. ' +
      'You do not modify files, run mutating commands, or make decisions for the main agent. ' +
      'Return compressed findings with file paths and line numbers, not file dumps. ' +
      COMMON_REPORT,
    write: false,
    requestedTools: [...READ_ONLY_TOOLS, ...WEB_TOOLS],
    delegationTools: [],
    canDispatch: [],
    maxDepth: 1,
    oneShot: false,
    delivery: 'parent',
    defaultWorkClass: 'mechanical',
    requiresWritePaths: false,
  },
  clerk: {
    name: 'clerk',
    persona:
      'You are a clerk: you read and write external systems through the connector tools you actually have (trackers, docs, chat, the web), and you return a short digest or a write readback. ' +
      'You do not edit repository files and you do not invent connector access: if a tool you need is not present, say which one. ' +
      'After any write, read it back and report what the system now shows. ' +
      COMMON_REPORT,
    write: false,
    // Connector tools (`mcp__<server>__<tool>` and MCP_RESOURCE_TOOLS) come from the scope's registered set; ./tools.ts adds the ones actually present.
    requestedTools: [...READ_ONLY_TOOLS, ...WEB_TOOLS],
    delegationTools: [],
    canDispatch: [],
    maxDepth: 1,
    oneShot: false,
    delivery: 'parent',
    defaultWorkClass: 'mechanical',
    requiresWritePaths: false,
  },
  worker: {
    name: 'worker',
    persona:
      'You are a worker: a bounded implementer doing one delegated piece with a checkable result. ' +
      'Edit and create files ONLY inside your declared writePaths; never touch anything outside them, and never change git state (no commit, push, branch or reset) unless the brief says so. ' +
      'Run the checks the brief names and report their exact commands and exit results. A failing check is a finding: fix the code or the test for a stated reason, never weaken an assertion to get green. ' +
      'Do not dispatch other agents. ' +
      COMMON_REPORT,
    write: true,
    requestedTools: 'inherit',
    delegationTools: [],
    canDispatch: [],
    maxDepth: 1,
    oneShot: false,
    delivery: 'parent',
    defaultWorkClass: 'simple',
    requiresWritePaths: true,
  },
  'executor-lead': {
    name: 'executor-lead',
    persona:
      'You are an executor-lead: you own one chunk end to end. Split it into leaves and dispatch them with autopilot_delegate as scout (read-only search), clerk (connector reads/writes) and worker (implementation); use autopilot_agents to see their state. ' +
      'Keep concurrent writers on DISJOINT writePaths. Do the small, directly-checkable steps yourself rather than splitting for its own sake. ' +
      'Integrate the leaves\' results, validate the whole (run the checks, read the diff), and return a short summary with the commands you ran and their exit results, the changed paths, and what is unresolved. ' +
      'You cannot dispatch planner, reviewer or another executor-lead, and you do not declare the goal done; the main agent decides and the independent review is the main agent\'s to request.',
    write: true,
    requestedTools: 'inherit',
    delegationTools: DELEGATION_TOOLS,
    canDispatch: ['scout', 'clerk', 'worker'],
    maxDepth: 2,
    oneShot: false,
    delivery: 'parent',
    defaultWorkClass: 'hard',
    requiresWritePaths: false,
  },
  planner: {
    name: 'planner',
    persona:
      'You are a planner and diagnostician for hard, unclear or failed work. You are read-only: you do not modify files or run mutating commands. ' +
      'Read the evidence, state the actual problem, and return a plan: ordered steps, the files each touches, the risks, how each step is verified, and what you could not establish. ' +
      COMMON_REPORT,
    write: false,
    requestedTools: READ_ONLY_TOOLS,
    delegationTools: [],
    canDispatch: [],
    maxDepth: 1,
    oneShot: false,
    delivery: 'parent',
    defaultWorkClass: 'hard',
    requiresWritePaths: false,
  },
  reviewer: {
    name: 'reviewer',
    persona:
      'You are an independent reviewer. You are read-only and one-shot. Find what breaks, gets lost, leaks or is reported wrongly in the subject you are given; read the actual files and diff, do not trust the author\'s summary. ' +
      'Your verdict is yours alone: the main agent cannot override it, soften it or ask you to change it; it can only fix the subject and request a new review. ' +
      'Return the structured verdict exactly as the output schema requires: verdict (pass | needs-fix | blocked), findings (each with severity blocker | major | minor, a one-sentence summary, and where when you can name it), and the subject you reviewed. ' +
      'Use pass only when you found no blocker or major; blocked when you could not review (say why in a finding).',
    write: false,
    requestedTools: READ_ONLY_TOOLS,
    delegationTools: [],
    canDispatch: [],
    maxDepth: 1,
    oneShot: true,
    delivery: 'caller',
    defaultWorkClass: 'audit',
    requiresWritePaths: false,
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Refusal codes: the single registry is ../domain/refusals.ts; re-exported for callers of this module.
// ─────────────────────────────────────────────────────────────────────────────

export {
  AP_ROLE_ROUTE_BLOCKED,
  AP_ROLE_ROUTE_ESCALATE_OWNER,
  AP_ROLE_ROUTE_INCOMPLETE,
  AP_ROLE_ROUTE_NOT_ALLOWED,
  AP_ROLE_ROUTE_PREFLIGHT_FAILED,
  AP_ROLE_VERDICT_INVALID,
  AP_TOOL_SURFACE_INCOMPLETE,
} from '../domain/refusals.js'

// ─────────────────────────────────────────────────────────────────────────────
// Reviewer verdict
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JSON schema handed to the host as the reviewer's `outputSchema`.
 *
 * Only the host's enforced subset is allowed here (dsh-tools `json-schema`:
 * type/oneOf/properties/required/additionalProperties/items/enum/const plus
 * annotations); rc.5 rejects anything else at `startActivation`, so a keyword
 * such as `minLength` fails every reviewer dispatch. Non-empty `subject` and
 * `summary` are enforced by {@link parseReviewVerdict} instead.
 */
export const REVIEW_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings', 'subject'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'needs-fix', 'blocked'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'summary'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          summary: { type: 'string', description: 'non-empty' },
          where: { type: 'string' },
        },
      },
    },
    subject: { type: 'string', description: 'non-empty' },
  },
} as const

export interface ParsedReviewVerdict {
  readonly verdict: ReviewVerdict
  readonly findings: readonly ReviewFinding[]
  readonly subject: string
}

const VERDICTS: readonly string[] = ['pass', 'needs-fix', 'blocked']
const SEVERITIES: readonly string[] = ['blocker', 'major', 'minor']

/**
 * Validate a reviewer's structured output at the write boundary. Returns the
 * parsed verdict or a string naming the first violated axis. A `pass` that
 * carries a blocker or major finding is internally inconsistent and is
 * rejected rather than recorded as a pass.
 */
export function parseReviewVerdict(structured: unknown): ParsedReviewVerdict | string {
  if (typeof structured !== 'object' || structured === null || Array.isArray(structured)) {
    return 'review verdict must be an object'
  }
  const record = structured as Record<string, unknown>
  const verdict = record['verdict']
  if (typeof verdict !== 'string' || !VERDICTS.includes(verdict)) {
    return `verdict must be one of ${VERDICTS.join(' | ')}`
  }
  const subject = record['subject']
  if (typeof subject !== 'string' || subject.trim().length === 0) return 'subject must be a non-empty string'
  const rawFindings = record['findings']
  if (!Array.isArray(rawFindings)) return 'findings must be an array'
  const findings: ReviewFinding[] = []
  for (const [index, raw] of rawFindings.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return `findings[${index}] must be an object`
    const entry = raw as Record<string, unknown>
    const severity = entry['severity']
    if (typeof severity !== 'string' || !SEVERITIES.includes(severity)) {
      return `findings[${index}].severity must be one of ${SEVERITIES.join(' | ')}`
    }
    const summary = entry['summary']
    if (typeof summary !== 'string' || summary.trim().length === 0) return `findings[${index}].summary must be a non-empty string`
    const where = entry['where']
    if (where !== undefined && typeof where !== 'string') return `findings[${index}].where must be a string when present`
    findings.push({
      severity: severity as ReviewFinding['severity'],
      summary: summary.trim(),
      ...(where !== undefined && where.trim().length > 0 ? { where: where.trim() } : {}),
    })
  }
  if (verdict === 'pass' && findings.some((finding) => finding.severity !== 'minor')) {
    return 'verdict pass is inconsistent with a blocker or major finding'
  }
  if (verdict === 'needs-fix' && findings.length === 0) return 'verdict needs-fix must carry at least one finding'
  return { verdict: verdict as ReviewVerdict, findings, subject: subject.trim() }
}
