/**
 * Delegation roles (goal-workflow vocabulary): scout, worker, executor-lead,
 * planner, reviewer. The main agent decides and integrates; it is not a role.
 *
 * A role is DATA: a persona brief, a tool surface, a depth, a delivery mode and
 * whether it may dispatch. The delegator reads these to build one
 * `SubagentRuntime.startActivation` call per child. The host has no per-child
 * persona or tool filter, so the plugin applies the tool surface on
 * `agent/created` (see ./tools.ts) and hands the persona in the prompt.
 *
 * Pure module: no dsh imports, no I/O.
 */

import type { DelegationRoleName, ReviewFinding, ReviewVerdict } from '../ledger.js'
import { READ_ONLY_TOOLS, WEB_TOOLS } from './tools.js'

export type { DelegationRoleName } from '../ledger.js'

/** The role vocabulary in a fixed order (validation, tool enums, docs). */
export const ROLE_NAMES: readonly DelegationRoleName[] = ['scout', 'worker', 'executor-lead', 'planner', 'reviewer']

/** Tools only an executor-lead receives, so it can dispatch leaves. */
export const DELEGATION_TOOLS: readonly string[] = ['autopilot_delegate', 'autopilot_agents']

export interface RoleSpec {
  readonly name: DelegationRoleName
  /** Concise English brief handed to the child in its prompt. */
  readonly persona: string
  /** Whether the role may modify files / run mutating tools. */
  readonly write: boolean
  /** Requested tool names (narrowed to the registry), or `inherit` = no restriction. */
  readonly requestedTools: readonly string[] | 'inherit'
  /** Extra tools added on top of `requestedTools` (executor-lead only). */
  readonly delegationTools: readonly string[]
  /** Roles this role may dispatch itself. Empty = a leaf. */
  readonly canDispatch: readonly DelegationRoleName[]
  /** `maxDepth` relative to the child: 1 = leaf below its dispatcher, 2 = one level of leaves. */
  readonly maxDepth: number
  /** One turn, then done; no follow-up messages. */
  readonly oneShot: boolean
  /** Who receives the settlement: `parent` = the native settlement notice, `caller` = the dispatching call. */
  readonly delivery: 'parent' | 'caller'
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
    requiresWritePaths: true,
  },
  'executor-lead': {
    name: 'executor-lead',
    persona:
      'You are an executor-lead: you own one chunk end to end. Split it into leaves and dispatch them with autopilot_delegate as scout (read-only search) and worker (implementation); use autopilot_agents to wait for their state. ' +
      'Keep concurrent writers on DISJOINT writePaths. Do the small, directly-checkable steps yourself rather than splitting for its own sake. ' +
      "Integrate the leaves' results, validate the whole (run the checks, read the diff), and return a short summary with the commands you ran and their exit results, the changed paths, and what is unresolved. " +
      "You cannot dispatch planner, reviewer or another executor-lead, and you do not declare the goal done; the main agent decides and the independent review is the main agent's to request.",
    write: true,
    requestedTools: 'inherit',
    delegationTools: DELEGATION_TOOLS,
    canDispatch: ['scout', 'worker'],
    maxDepth: 2,
    oneShot: false,
    delivery: 'parent',
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
    requiresWritePaths: false,
  },
  reviewer: {
    name: 'reviewer',
    persona:
      'You are an independent reviewer. You are read-only and one-shot. Find what breaks, gets lost, leaks or is reported wrongly in the subject you are given; read the actual files and diff, do not trust the author\'s summary. ' +
      'Your verdict is yours alone: the main agent cannot override it, soften it or ask you to change it; it can only fix the subject and request a new review. ' +
      'Return the structured verdict exactly as the output schema requires: verdict pass | fail, findings with severity blocker | note plus a one-sentence note (and file/line when you can name them), and an optional summary. ' +
      'Use pass only when you found no blocker.',
    write: false,
    requestedTools: READ_ONLY_TOOLS,
    delegationTools: [],
    canDispatch: [],
    maxDepth: 1,
    oneShot: true,
    delivery: 'caller',
    requiresWritePaths: false,
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Reviewer verdict
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JSON schema handed to the host as the reviewer's `outputSchema`.
 *
 * Only the host's enforced subset is allowed here (type/oneOf/properties/
 * required/additionalProperties/items/enum/const plus annotations); the host
 * rejects anything else at `startActivation`, so a keyword such as `minLength`
 * would fail every reviewer dispatch. Non-empty strings are enforced by
 * {@link parseReviewVerdict} instead.
 */
export const REVIEW_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'note'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'note'] },
          note: { type: 'string', description: 'non-empty' },
          file: { type: 'string' },
          line: { type: 'integer' },
        },
      },
    },
    summary: { type: 'string' },
  },
} as const

const VERDICTS: readonly string[] = ['pass', 'fail']
const SEVERITIES: readonly string[] = ['blocker', 'note']

/**
 * Validate a reviewer's structured output at the write boundary. Returns the
 * parsed verdict or a string naming the first violated axis. A `pass` that
 * carries a blocker finding is internally inconsistent and is rejected rather
 * than recorded as a pass.
 */
export function parseReviewVerdict(structured: unknown): ReviewVerdict | string {
  if (typeof structured !== 'object' || structured === null || Array.isArray(structured)) {
    return 'review verdict must be an object'
  }
  const record = structured as Record<string, unknown>
  const verdict = record['verdict']
  if (typeof verdict !== 'string' || !VERDICTS.includes(verdict)) {
    return `verdict must be one of ${VERDICTS.join(' | ')}`
  }
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
    const note = entry['note']
    if (typeof note !== 'string' || note.trim().length === 0) return `findings[${index}].note must be a non-empty string`
    const file = entry['file']
    if (file !== undefined && (typeof file !== 'string' || file.trim().length === 0)) {
      return `findings[${index}].file must be a non-empty string when present`
    }
    const line = entry['line']
    if (line !== undefined && (typeof line !== 'number' || !Number.isInteger(line) || line < 1)) {
      return `findings[${index}].line must be a positive integer when present`
    }
    findings.push({
      severity: severity as ReviewFinding['severity'],
      note: note.trim(),
      ...(file === undefined ? {} : { file: file.trim() }),
      ...(line === undefined ? {} : { line }),
    })
  }
  const summary = record['summary']
  if (summary !== undefined && (typeof summary !== 'string' || summary.trim().length === 0)) {
    return 'summary must be a non-empty string when present'
  }
  if (verdict === 'pass' && findings.some((finding) => finding.severity === 'blocker')) {
    return 'verdict pass is inconsistent with a blocker finding'
  }
  return {
    verdict: verdict as ReviewVerdict['verdict'],
    findings,
    ...(summary === undefined ? {} : { summary: summary.trim() }),
  }
}
