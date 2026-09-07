/**
 * The autopilot:policy prompt section: zero tokens when no run is active;
 * when a run exists it injects the current state plus the phase-relevant
 * slice of the CC doctrine (compressed). The executor child gets its own
 * packet-contract text instead of the controller doctrine.
 */

import { MAX_REPLAN_ROUNDS, latestVerdicts, requiredRoles } from './domain/types.js'
import type { Snapshot } from './domain/types.js'

const COMMON = `You are running a dsh-autopilot goal run (plan-execute-audit harness, CC GAH lineage).
Rules that always hold:
- Prefer raw evidence over narrative claims; prefer current repo state over memory.
- Report visible progress at every phase transition ([TRIAGE]/[PLAN]/[PLAN-AUDIT]/[EXEC]/[AUDIT]/[CLOSEOUT] lines).
- Record as you go with autopilot_log (stance: on-plan|detour|grind|escalate; escalate needs a note) — an abandoned execution log is the most pervasive historical defect.
- Pause ONLY at owner-only boundaries: push/PR/release/publish, destructive or irreversible ops, credentials, payment, public-visible changes. Ordinary engineering steps never pause.
- Audit decisions are respected: needs-fix means fix it; do not argue a gate open.`

/**
 * Substituted at render time. The audit tools are NOT interchangeable:
 * `AutopilotEngine.audit` refuses any mode but `independent`,
 * `recordExternalAudit` refuses any mode but `external`, and `selfCheck`
 * refuses any mode but `self-check`. Injecting a fixed `autopilot_audit` told
 * every run to call the one tool its own mode might reject, which stalled an
 * `external` run at BOTH gates while it faithfully followed the policy it was
 * given (found in PR #3 review, 2026-08-27). Deliberately not a `${...}` form:
 * these phase strings are template literals, so a dollar-brace token would be
 * interpolated at module load instead of surviving to render time.
 */
const AUDIT_TOOL_TOKEN = '__AUDIT_TOOL__'

/** The only audit tool the engine will accept for this run's mode. */
function auditToolFor(mode: Snapshot['triage']['auditMode']): string {
  switch (mode) {
    case 'external': return 'autopilot_external_audit (owner-countersigned; needs a direct human turn, and the reviewRef file must exist in the run directory by closeout)'
    case 'self-check': return 'autopilot_self_check'
    default: return 'autopilot_audit'
  }
}

const PHASE_TEXT: Record<Snapshot['phase'], string> = {
  'planning': `Phase: PLANNING (read-only; mutations are gated).
Produce a plan with: ordered milestones each with a BINARY runnable validation check (a command, test, diff, or artifact check — never narrative); files likely touched; assumptions and how each is verified; rollback notes for risky changes. Submit with autopilot_submit_plan, then gate it with __AUDIT_TOOL__ role=plan.
USAGE EVIDENCE (standard runs): every change id must be answered with autopilot_usage before the plan gate can pass — a pass verdict on an undeclared run is RECORDED and the gate is still refused — and again before closeout, so an entry declared mid-execution cannot ride to completion unanswered. gui/cli/api-behavior need >=2 boundary states (>=1 from the menu) and >=1 artifact; harness needs a test-run artifact; internal/docs need neither; unsupported needs a reason plus what was attempted. "It builds" is not "it was operated".`,
  'plan-reviewing': `Phase: PLAN-REVIEWING. A plan auditor is running; wait for its verdict before any mutation.`,
  'executing': `Phase: EXECUTING.
Per-milestone loop: (1) state what you are about to change; (2) smallest coherent edit; (3) run the closest validation; (4) diagnose failures before moving on; (5) stop for replan when reality contradicts the plan. Continue autonomously while the next step is safe, reversible, in scope.
Inline run: implement directly, then autopilot_submit_evidence with the evidence report. Delegated run: dispatch via autopilot_executor action=start; the child returns its packet; resume the SAME child on needs-fix (action=resume), never a new one.`,
  'execution-reviewing': `Phase: EXECUTION-REVIEWING. Dispatch __AUDIT_TOOL__ role=execution with a bounded packet: goal contract, approved plan, changed files, diff summary, raw validation output — never your own reasoning or success claims. If the run touches the operating layer or risk is high/critical, also dispatch role=rules.`,
  'replanning': `Phase: REPLANNING. Reality or an auditor contradicted the plan. Rewrite the plan (autopilot_submit_plan) and pass the plan audit again. Bounded escalation: after ${MAX_REPLAN_ROUNDS} consecutive needs-replan rounds the next one forces needs-owner-decision.`,
  'closing': `Phase: CLOSING. Submit the structured closeout (autopilot_submit_closeout): summary, changed files, commands, EVIDENCE PER ACCEPTANCE CRITERION (exactly one bearing artifact each, or an honest "unproven"; one proven bearer may not carry two criteria — Single-Bearer both directions; unproven empty bearers do not occupy the map), residual risks, exclusions, workspace cleanup, drift ("none found" or exact upstream updates). Completion is refused mechanically until every required audit role's latest verdict is pass, and until every declared usage artifact settles (exists, non-empty, inside the run directory, captured after the plan gate, bearing the labels it claims).
OUTBOUND: any egress (push / PR / release / publish) needs <run>/outbound/manifest.json first — runId, target, the command substrings it authorizes, one bearing artifact per claim, createdAt within 6h. Every count you state in outbound text must appear in the artifact that bears it. The manifest is archived as spent when the egress dispatches; a second egress needs a new one.`,
  'completed': 'Phase: COMPLETED. The run is closed; no further run mutations are legal.',
  'blocked': 'Phase: BLOCKED (terminal). Report the blocker; a new run needs a new session.',
  'needs-owner-decision': 'Phase: NEEDS-OWNER-DECISION. The run is paused for the owner. Summarize the disagreement/decision needed and STOP. Only a direct human turn can resolve it (autopilot_signal action=owner-resolve).',
}

/** Render the policy section for the root controller. */
export function renderRootPolicy(snapshot: Snapshot): string {
  const triage = snapshot.triage
  const roles = requiredRoles(triage)
  const latest = latestVerdicts(snapshot.audits)
  const verdictLine = roles
    .map(role => `${role}=${latest[role]?.verdict ?? 'none'}`)
    .join(' ')
  return [
    COMMON,
    '',
    `Run state: phase=${snapshot.phase} planGate=${snapshot.planGate} executionGate=${snapshot.executionGate} planRev=${snapshot.plan.revision} replanBudget=${Math.max(0, MAX_REPLAN_ROUNDS - snapshot.consecutiveReplans)}`,
    `Triage: size=${triage.size} risk=${triage.risk} exec=${triage.executionMode} audit=${triage.auditMode} requiredRoles=[${roles.join(', ')}] latest: ${verdictLine}`,
    `Objective: ${triage.objective}`,
    triage.nonGoals.length > 0 ? `Non-goals: ${triage.nonGoals.join('; ')}` : '',
    '',
    PHASE_TEXT[snapshot.phase].replaceAll(AUDIT_TOOL_TOKEN, auditToolFor(triage.auditMode)),
  ].filter(line => line.length > 0).join('\n')
}

/** Render the policy section for the authorized executor child. */
export function renderExecutorPolicy(snapshot: Snapshot): string {
  return [
    'You are the autopilot Executor Lead: an independently dispatched implementer inside an approved contract.',
    `Objective: ${snapshot.triage.objective}`,
    `Scope: ${snapshot.triage.scope.join('; ') || '(as per plan)'}`,
    snapshot.triage.nonGoals.length > 0 ? `Non-goals (must not change): ${snapshot.triage.nonGoals.join('; ')}` : '',
    '',
    `Contract: implement within the approved plan with free choice of means; run the closest validation after each coherent edit; never audit or approve your own work. When done (or when you need a planner/owner decision), submit your execution packet with autopilot_submit_packet: what changed, commands run with results, validation evidence, residual risks, AND executionRevision=${String(snapshot.executor?.executionRevision ?? 1)} (the live executor revision; a stale or missing value is refused). Your final message must BE your deliverable, never a status update. Owner-only boundaries (push/PR/release/credentials/destructive) stay with the owner — do not cross them.`,
  ].filter(line => line.length > 0).join('\n')
}
