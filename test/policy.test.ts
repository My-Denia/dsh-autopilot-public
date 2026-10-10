/**
 * The injected `autopilot:policy` prompt section.
 *
 * THE DEFECT THIS FILE EXISTS FOR (found 2026-08-25, independent repair audit).
 * `src/policy.ts` appeared in `test/` exactly once, as the STRING
 * `'autopilot:policy'` in `test/apply.test.ts` — an assertion that a section by
 * that name was registered, and not one word about its content. Both renderers
 * could be reduced to `return ''` with 15 files / 394 tests green.
 *
 * That is the delivery channel for DESIGN.md §5 — the invariants this plugin
 * cannot mechanize and therefore has to TELL a model about. A channel checked
 * for existence and not for content is a channel that can go silent unobserved,
 * so the assertions below are on the load-bearing phrases: the owner-only
 * boundary, the evidence discipline, the phase-specific obligation, and (for
 * the executor) the packet contract plus the boundary it must not cross.
 *
 * SECOND ROUND (2026-08-25, milestone 5). The phrase assertions above closed the
 * five deletion-shaped survivors, and a re-test in a sandbox copy confirmed that
 * — the umbrella `return ''` now turns five of them red. It also confirmed that
 * they left the PROJECTED values unguarded: with the whole file green,
 * `PHASE_TEXT['executing']` could still open `Phase: PLANNING`, the replan budget
 * could be reported as GROWING while it was spent, and the `rules` role could be
 * filtered out of the required-roles line — 17 files / 468 tests passed on every
 * one. Deleting doctrine is now observable; MISREPORTING state was not.
 *
 * The three bearers added below assert the projection, not the prose: the header
 * a slice must carry (derived from the phase key), the arithmetic properties of
 * the budget (derived from MAX_REPLAN_ROUNDS), and the role list (derived from
 * `requiredRoles`). Rewording any paragraph stays green; lying about which phase,
 * how much budget, or which auditors are required does not.
 */

import { describe, expect, it } from 'vitest'
import { renderExecutorPolicy, renderRootPolicy } from '../src/policy.js'
import { MAX_REPLAN_ROUNDS, requiredRoles } from '../src/domain/types.js'
import type { AuditRole, Phase, Snapshot, Triage } from '../src/domain/types.js'
import { makeSnapshot } from './helpers.js'

function at(phase: Phase, overrides: Partial<Snapshot> = {}): Snapshot {
  return makeSnapshot(
    { phase, ...overrides },
    { size: 'standard', risk: 'medium', auditMode: 'independent', objective: 'ship the outbound gate' },
  )
}

/**
 * Every member of the `Phase` union, enumerated once.
 *
 * `satisfies Record<Phase, null>` is the completeness gate: adding a phase to
 * the domain type without adding it here is a compile error, so a new phase
 * cannot arrive with an unasserted policy slice. The keys are the union's own
 * spelling, not a transcription of the prose in `PHASE_TEXT`.
 */
const ALL_PHASES = Object.keys({
  'planning': null,
  'plan-reviewing': null,
  'executing': null,
  'execution-reviewing': null,
  'replanning': null,
  'closing': null,
  'completed': null,
  'blocked': null,
  'needs-owner-decision': null,
} satisfies Record<Phase, null>) as readonly Phase[]

/** The header a phase slice must carry, derived from the phase key rather than copied from the text. */
function phaseHeader(phase: Phase): string {
  return `Phase: ${phase.toUpperCase()}`
}

/** The `replanBudget=` figure the section reports to the controller at a given consumption. */
function reportedReplanBudget(consecutiveReplans: number): number {
  const text = renderRootPolicy(at('replanning', { consecutiveReplans }))
  // `-?` deliberately: a budget that has gone negative must be READ and then
  // rejected, not silently missed by a digits-only match.
  const value = /replanBudget=(-?\d+)/.exec(text)?.[1]
  expect(value, `no replanBudget= in the section at consecutiveReplans=${consecutiveReplans}`).toBeDefined()
  return Number(value)
}

/** The roles the section says are required, and the role tokens on its verdict line. */
function reportedRoles(snapshot: Snapshot): { listed: string[]; verdictTokens: string[] } {
  const text = renderRootPolicy(snapshot)
  const listed = /requiredRoles=\[([^\]]*)\]/.exec(text)?.[1]
  const verdicts = /latest: (.+)$/m.exec(text)?.[1]
  expect(listed, 'no requiredRoles=[…] in the section').toBeDefined()
  expect(verdicts, 'no "latest: …" verdict line in the section').toBeDefined()
  return {
    listed: (listed ?? '').split(', ').filter(part => part.length > 0),
    verdictTokens: (verdicts ?? '').split(' ').filter(part => part.length > 0),
  }
}

function triageRequiring(roles: readonly AuditRole[], overrides: Partial<Triage>): Snapshot {
  const snapshot = makeSnapshot({ phase: 'planning' }, overrides)
  // Guard the FIXTURE, not the renderer: if the risk matrix changes so this
  // triage no longer requires the roles the case is about, the case must fail
  // loudly rather than quietly stop exercising them.
  expect([...requiredRoles(snapshot.triage)]).toEqual([...roles])
  return snapshot
}

describe('renderRootPolicy', () => {
  it('delivers the always-on rules, including the owner-only boundary', () => {
    const text = renderRootPolicy(at('planning'))
    expect(text).toContain('dsh-autopilot goal run')
    expect(text).toContain('Prefer raw evidence over narrative claims')
    expect(text).toContain('autopilot_log')
    // The owner-only boundary is the one rule whose absence would read as
    // permission, so it is named explicitly rather than covered by a length check.
    expect(text).toContain('Pause ONLY at owner-only boundaries')
    expect(text).toContain('push/PR/release/publish')
    expect(text).toContain('Audit decisions are respected')
  })

  it('states the live run state, the triage contract and the objective', () => {
    const snapshot = at('planning', { planGate: 'pending', executionGate: 'pending' })
    const text = renderRootPolicy(snapshot)
    expect(text).toContain('phase=planning')
    expect(text).toContain('planGate=pending')
    expect(text).toContain('executionGate=pending')
    expect(text).toContain('size=standard')
    expect(text).toContain('risk=medium')
    expect(text).toContain('Objective: ship the outbound gate')
    // requiredRoles is projected, not narrated: an independent medium-risk run
    // needs a real auditor, and the section says which verdicts are outstanding.
    expect(text).toContain('requiredRoles=[')
    expect(text).toContain('plan=none')
  })

  it('non-goals appear when there are any, and the line is absent when there are none', () => {
    expect(renderRootPolicy(at('planning'))).toContain('Non-goals: docs/')
    const noneDeclared = makeSnapshot({ phase: 'planning' }, { nonGoals: [] })
    expect(renderRootPolicy(noneDeclared)).not.toContain('Non-goals:')
  })

  it('every phase gets its own obligation text, and each names what that phase must do', () => {
    // Cardinality floor plus per-value content: a renderer that dropped the phase
    // slice would still produce a long string, so each phase is asserted on a
    // phrase only that phase carries.
    const expected: Record<Phase, string> = {
      'planning': 'BINARY runnable validation check',
      'plan-reviewing': 'wait for its verdict before any mutation',
      'executing': 'smallest coherent edit',
      'execution-reviewing': 'never your own reasoning or success claims',
      'replanning': 'OBSERVED, never auto-escalated',
      'closing': 'EVIDENCE PER ACCEPTANCE CRITERION',
      'completed': 'no further run mutations are legal',
      'blocked': 'a new run needs a new session',
      'needs-owner-decision': 'Only a direct human turn can resolve it',
    }
    // `Record<Phase, string>` is the completeness check: a new phase in the type
    // is a compile error here, not a silently unasserted branch.
    const phases = Object.keys(expected) as Phase[]
    expect(phases).toHaveLength(9)
    for (const phase of phases) {
      const text = renderRootPolicy(at(phase))
      expect(text.length).toBeGreaterThan(200)
      expect(text).toContain(expected[phase])
    }
  })

  it('names the audit tool the ENGINE will accept for this run mode, at both gates', () => {
    // Found in PR #3 review (2026-08-27). The injected policy hard-coded
    // `autopilot_audit` at both gates, but `AutopilotEngine.audit` refuses any
    // mode but `independent` — so an `external` run stalled at its first gate
    // while faithfully obeying the instructions it had been handed. The bug was
    // invisible because every assertion in this file used the default
    // `independent` snapshot, for which the hard-coded name happened to be right.
    // Each mode is exercised, and each asserts the ABSENCE of the wrong tools,
    // because a policy that names two of them is as stalling as one that names
    // the wrong one.
    const modes = [
      { auditMode: 'independent' as const, want: 'autopilot_audit', banned: ['autopilot_external_audit', 'autopilot_self_check'] },
      { auditMode: 'external' as const, want: 'autopilot_external_audit', banned: ['autopilot_self_check'] },
      { auditMode: 'self-check' as const, want: 'autopilot_self_check', banned: ['autopilot_external_audit'] },
    ]
    for (const { auditMode, want, banned } of modes) {
      for (const phase of ['planning', 'execution-reviewing'] as const) {
        const text = renderRootPolicy(makeSnapshot(
          { phase },
          { size: 'standard', risk: 'medium', auditMode, objective: 'o' },
        ))
        expect(text, `${auditMode}/${phase} must name its own tool`).toContain(want)
        for (const wrong of banned) {
          expect(text, `${auditMode}/${phase} must not name ${wrong}`).not.toContain(wrong)
        }
        // The token must never survive to the model.
        expect(text).not.toContain('__AUDIT_TOOL__')
      }
    }
  })

  it('the planning slice carries the usage-evidence contract, and closing carries the outbound one', () => {
    const planning = renderRootPolicy(at('planning'))
    expect(planning).toContain('USAGE EVIDENCE')
    expect(planning).toContain('It builds')
    const closing = renderRootPolicy(at('closing'))
    expect(closing).toContain('OUTBOUND')
    expect(closing).toContain('outbound/manifest.json')
    expect(closing).toContain('Single-Bearer')
    expect(closing).toContain('may not carry two criteria')
  })

  it('each phase slice announces its OWN phase and never another one', () => {
    // The 2026-08-25 re-test: with the phrase assertions above already green,
    // `PHASE_TEXT['executing']` could still open `Phase: PLANNING (read-only;
    // mutations are gated).` and the suite stayed 17 files / 468 passed. A slice
    // that names the wrong phase has NO runtime symptom — no exception, no
    // refused gate — it just tells a run in EXECUTING that it is read-only, or
    // tells a planning run to start mutating before the plan gate has passed.
    //
    // The header, not the paragraph, is what is asserted: a rewrite of a slice's
    // body is an honest edit and stays green, while a header naming a phase the
    // snapshot is not in goes red. Both directions are checked, because the
    // negative half is what a copy-pasted slice fails.
    expect(ALL_PHASES).toHaveLength(9)
    for (const phase of ALL_PHASES) {
      const text = renderRootPolicy(at(phase))
      expect(text, `${phase} does not announce itself`).toContain(phaseHeader(phase))
      for (const other of ALL_PHASES) {
        if (other === phase) continue
        expect(text, `${phase} also announces ${other}`).not.toContain(phaseHeader(other))
      }
    }
  })

  it('the reported replan budget is spent as it is consumed and floors at zero', () => {
    // `replanBudget=` is the controller's only view of how much replanning it
    // has left before the engine forces needs-owner-decision. Inverting the
    // arithmetic to `MAX_REPLAN_ROUNDS + consecutiveReplans` — a budget that
    // GROWS as it is spent — kept the suite fully green, as did pinning it to a
    // constant. Neither breaks anything loudly; the run is simply told the
    // opposite of its real position and meets the escalation ceiling as a
    // surprise the prompt contradicted.
    //
    // Asserted as the four observable properties that together pin the figure
    // (full at the start, never grows, always spends while it has room, never
    // negative and exhausted exactly at the limit) rather than by restating the
    // expression, so the bearer survives any equivalent rewrite of it.
    let previous = reportedReplanBudget(0)
    expect(previous).toBe(MAX_REPLAN_ROUNDS)
    let samples = 1
    for (let spent = 1; spent <= MAX_REPLAN_ROUNDS + 2; spent++) {
      const current = reportedReplanBudget(spent)
      samples += 1
      expect(current, `budget went negative after ${spent} replans`).toBeGreaterThanOrEqual(0)
      expect(current, `budget grew after ${spent} replans`).toBeLessThanOrEqual(previous)
      if (previous > 0) {
        expect(current, `budget did not shrink after ${spent} replans`).toBeLessThan(previous)
      }
      previous = current
    }
    expect(samples).toBe(MAX_REPLAN_ROUNDS + 3)
    expect(reportedReplanBudget(MAX_REPLAN_ROUNDS)).toBe(0)
  })

  it('the required-roles line lists EVERY role the triage requires, in full', () => {
    // Filtering `rules` out of the rendered line kept the suite green: the
    // existing assertion only checks that `requiredRoles=[` appears at all.
    // Hidden from the status line, a mandatory role is never dispatched and its
    // verdict never seen, so a high-risk or operating-layer run believes it is
    // fully audited and then stalls at a closeout refusal that names nothing.
    // Truncating the line to its first role survived identically.
    //
    // Pinned to `requiredRoles(triage)` by value, so the risk matrix stays the
    // single source of truth and this does not become a hand-copied role list.
    const cases: readonly Snapshot[] = [
      triageRequiring(['plan', 'execution'], { risk: 'low', touchesOperatingLayer: false }),
      triageRequiring(['plan', 'execution', 'rules'], { risk: 'high', touchesOperatingLayer: false }),
      triageRequiring(['plan', 'execution', 'rules'], { risk: 'low', touchesOperatingLayer: true }),
    ]
    expect(cases).toHaveLength(3)
    for (const snapshot of cases) {
      const roles = [...requiredRoles(snapshot.triage)]
      const { listed, verdictTokens } = reportedRoles(snapshot)
      expect(listed).toEqual(roles)
      // Cardinality floor on the verdict line too: every required role must be
      // reported with a verdict, not merely named in the bracket above it.
      expect(verdictTokens).toHaveLength(roles.length)
      for (const role of roles) {
        expect(verdictTokens.some(token => token.startsWith(`${role}=`)), `no verdict for ${role}`).toBe(true)
      }
    }
  })
})

describe('renderExecutorPolicy', () => {
  it('names the packet obligation and the boundary the child must not cross', () => {
    const text = renderExecutorPolicy(at('executing'))
    expect(text).toContain('autopilot_submit_packet')
    expect(text).toContain('executionRevision=')
    expect(text).toContain('never audit or approve your own work')
    // The egress boundary stays with the owner: a child that read this section
    // as silence on the subject is the failure this assertion exists for.
    expect(text).toContain('Owner-only boundaries')
    expect(text).toContain('do not cross them')
  })

  it('carries the contract the child is bound by: objective, scope, non-goals', () => {
    const text = renderExecutorPolicy(at('executing'))
    expect(text).toContain('Objective: ship the outbound gate')
    expect(text).toContain('Scope: src/')
    expect(text).toContain('Non-goals (must not change): docs/')
  })

  it('an empty scope degrades to the plan rather than to a blank line', () => {
    const text = renderExecutorPolicy(makeSnapshot({ phase: 'executing' }, { scope: [], nonGoals: [] }))
    expect(text).toContain('(as per plan)')
    expect(text).not.toContain('Non-goals')
  })

  it('is NOT the controller policy: the child gets no phase machine and no gate state', () => {
    // The two renderers are different documents on purpose; asserting that keeps
    // a future "just reuse the root text" from silently handing the child the
    // controller's authority language.
    const text = renderExecutorPolicy(at('executing'))
    expect(text).not.toContain('autopilot_submit_plan')
    expect(text).not.toContain('phase=')
    expect(text).toContain('Executor Lead')
  })
})
