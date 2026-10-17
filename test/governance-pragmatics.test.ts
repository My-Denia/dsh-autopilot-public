/** Governance pragmatics v1 (engine layer): findings grading, amend-plan +
 * delta re-audit, owner-resume, partial delivery, carryover, audit round cap.
 *
 * The fold-level counterparts live in fold.test.ts; what this file pins is the
 * ENGINE write path: refusals happen before anything lands, stamps are written
 * by the writer the fold will later hold to them, and every deliberate
 * behavior change is asserted in its new shape.
 */

import { describe, expect, it } from 'vitest'
import { AutopilotError } from '../src/domain/types.js'
import { fakeAgent, makeHarness, makeTriage, stubSubagents } from './helpers.js'
import type { StubVerdictScript } from './helpers.js'

const INDEPENDENT_TRIAGE = {
  risk: 'high' as const,
  size: 'standard' as const,
  auditMode: 'independent' as const,
  executionMode: 'inline' as const,
}

/** Drive an independent-mode run to phase=executing with the plan gate passed. */
async function independentExecuting(verdicts: Array<StubVerdictScript | { stopReason: string }>) {
  const h = makeHarness({ subagents: stubSubagents({ verdicts }) })
  await h.engine.init(h.root, makeTriage(INDEPENDENT_TRIAGE))
  await h.engine.submitPlan(h.root, 'plan v1 - verify: pnpm test')
  await h.engine.audit(h.root, { role: 'plan', prompt: 'audit the plan' })
  return h
}

describe('governance pragmatics v1 (engine)', () => {
  describe('findings grading', () => {
    it('the refusal is typed and names the remedy', async () => {
      const h = makeHarness({ subagents: stubSubagents({ verdicts: [
        { verdict: 'needs-replan', note: 'gap', findings: [{ severity: 'blocking', layer: 'execution', summary: 'x' }] },
      ] }) })
      await h.engine.init(h.root, makeTriage(INDEPENDENT_TRIAGE))
      await h.engine.submitPlan(h.root, 'plan')
      const error = await h.engine.audit(h.root, { role: 'plan', prompt: 'audit' })
        .then(() => null, (thrown: unknown) => thrown)
      expect(error).toBeInstanceOf(AutopilotError)
      expect((error as AutopilotError).code).toBe('AP_AUDIT_FINDINGS_INVALID')
      expect((error as AutopilotError).message).toMatch(/needs-fix/)
      // Pre-commit: no audit record landed.
      expect(h.engine.peek(h.root.id)?.audits).toHaveLength(0)
    })

    it('records pass with non-blocking findings without burning anything', async () => {
      const h = await independentExecuting([
        { verdict: 'pass', note: 'minimum-sufficient', findings: [{ severity: 'non-blocking', layer: 'plan', summary: 'suggest naming the rollback command' }] },
      ])
      const snapshot = h.engine.peek(h.root.id)
      expect(snapshot?.phase).toBe('executing')
      expect(snapshot?.planGate).toBe('pass')
      expect(snapshot?.audits[0]?.findings).toHaveLength(1)
      expect(snapshot?.audits[0]?.findings?.[0]?.severity).toBe('non-blocking')
    })

    it('accepts needs-replan justified by a blocking plan-layer finding', async () => {
      const h = await independentExecuting([
        { verdict: 'needs-replan', note: 'objective unreachable', findings: [{ severity: 'blocking', layer: 'plan', summary: 'acceptance criterion not falsifiable' }] },
      ])
      expect(h.engine.peek(h.root.id)?.phase).toBe('replanning')
    })
  })

  describe('amend-plan and the delta re-audit', () => {
    it('amends without destroying execution state and gates evidence until the delta pass', async () => {
      const h = await independentExecuting([
        { verdict: 'pass', note: 'ok', findings: [{ severity: 'non-blocking', layer: 'plan', summary: 'minor' }] },
      ])
      const amended = await h.engine.amendPlan(h.root, { text: 'plan v2 (amended detail)', note: 'implementation detail clarified' })
      expect(amended.phase).toBe('executing')
      expect(amended.planGate).toBe('pass')
      expect(amended.plan.revision).toBe(2)
      expect(amended.planAmendedAtRevision).toBe(2)
      // Evidence is gated on the delta re-audit.
      const refused = await h.engine.submitExecutionEvidence(h.root, { report: 'r', residualRisks: [] })
        .then(() => null, (thrown: unknown) => thrown)
      expect(refused).toBeInstanceOf(AutopilotError)
      expect((refused as AutopilotError).message).toMatch(/delta re-audit/)
      expect(h.engine.peek(h.root.id)?.phase).toBe('executing')
    })

    it('the delta plan pass from executing disarms the binding and evidence lands', async () => {
      // Second stub verdict serves the dispatched delta re-audit: on an
      // independent run the delta pass must come from a dispatched plan
      // auditor, and assertAuditPhase opens the plan role to executing while
      // the amendment is armed.
      const h = await independentExecuting([
        { verdict: 'pass', note: 'ok' },
        { verdict: 'pass', note: 'delta approved' },
      ])
      await h.engine.amendPlan(h.root, { text: 'plan v2', note: 'detail' })
      await h.engine.audit(h.root, { role: 'plan', prompt: 'delta re-audit of the amendment' })
      const snapshot = h.engine.peek(h.root.id)
      expect(snapshot?.phase).toBe('executing')
      expect(snapshot?.planAmendedAtRevision).toBeUndefined()
      const next = await h.engine.submitExecutionEvidence(h.root, { report: 'r', residualRisks: [] })
      expect(next.phase).toBe('execution-reviewing')
    })

    it('refuses amendment outside the executing phases', async () => {
      const h = makeHarness()
      await h.engine.init(h.root, makeTriage())
      const error = await h.engine.amendPlan(h.root, { text: 'x', note: 'n' })
        .then(() => null, (thrown: unknown) => thrown)
      expect(error).toBeInstanceOf(AutopilotError)
      expect((error as AutopilotError).code).toBe('AP_WRONG_PHASE')
    })
  })

  describe('owner pause and resume-execution', () => {
    it('stamps pausedFrom and resume-execution restores the phase without touching state', async () => {
      const h = await independentExecuting([{ verdict: 'pass', note: 'ok' }])
      await h.engine.submitExecutionEvidence(h.root, { report: 'r', residualRisks: [] })
      const paused = await h.engine.setOwnerDecision(h.root, 'genuine question: extend authorization to staging?')
      expect(paused.phase).toBe('needs-owner-decision')
      expect(paused.pausedFrom).toBe('execution-reviewing')
      const resumed = await h.engine.ownerResolve(h.root, {
        decision: 'resume-execution',
        note: 'no; continue inside the original scope',
      })
      expect(resumed.phase).toBe('execution-reviewing')
      expect(resumed.pausedFrom).toBeUndefined()
      expect(resumed.planGate).toBe('pass')
      expect(resumed.executionGate).toBe('pending')
    })

    it('resume-planning still fully resets (the legacy reading)', async () => {
      const h = await independentExecuting([{ verdict: 'pass', note: 'ok' }])
      await h.engine.setOwnerDecision(h.root, 'question')
      const reset = await h.engine.ownerResolve(h.root, { decision: 'resume-planning', note: 'redo the plan' })
      expect(reset.phase).toBe('planning')
      expect(reset.planGate).toBe('pending')
      expect(reset.executionGate).toBe('pending')
    })
  })

  describe('partial delivery at closeout', () => {
    it('derives outcome and refuses unproven criteria without a handoff', async () => {
      const h = makeHarness()
      await h.engine.init(h.root, makeTriage())
      await h.engine.submitPlan(h.root, 'plan')
      await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'ok' })
      await h.engine.submitExecutionEvidence(h.root, { report: 'r', residualRisks: [] })
      await h.engine.selfCheck(h.root, { role: 'execution', verdict: 'pass', note: 'ok' })
      const error = await h.engine.submitCloseout(h.root, {
        summary: 's', changedFiles: [], commands: [],
        evidence: [{ criterion: 'tests pass', bearer: '', status: 'unproven' as const }],
        residualRisks: [], exclusions: [], workspaceCleanup: 'k', drift: 'none found',
      }).then(() => null, (thrown: unknown) => thrown)
      expect(error).toBeInstanceOf(AutopilotError)
      expect((error as AutopilotError).code).toBe('AP_HANDOFF_INVALID')
      expect(h.engine.peek(h.root.id)?.phase).toBe('closing')

      const done = await h.engine.submitCloseout(h.root, {
        summary: 's', changedFiles: [], commands: [],
        evidence: [{ criterion: 'tests pass', bearer: '', status: 'unproven' as const }],
        handoff: {
          openItems: [{ criterion: 'tests pass', state: 'not-implemented' as const, note: 'handed to follow-up' }],
          nextAuthorizedAction: 'follow-up run completes the criterion',
        },
        residualRisks: [], exclusions: [], workspaceCleanup: 'k', drift: 'none found',
      })
      expect(done.phase).toBe('completed')
      expect(done.closeout?.outcome).toBe('partial')
    })
  })

  describe('carryover', () => {
    it('refuses an unknown predecessor', async () => {
      const h = makeHarness()
      const error = await h.engine.init(h.root, makeTriage({
        carryover: { fromRunId: 'run-nowhere', note: 'n', inherits: ['x'] },
      })).then(() => null, (thrown: unknown) => thrown)
      expect(error).toBeInstanceOf(AutopilotError)
      expect((error as AutopilotError).code).toBe('AP_CARRYOVER_UNKNOWN')
    })

    it('refuses a predecessor that has not completed', async () => {
      const h = makeHarness()
      await h.engine.init(h.root, makeTriage()) // root-1: alive, planning
      const successor = fakeAgent('root-2')
      h.agents.add(successor)
      const error = await h.engine.init(successor, makeTriage({
        carryover: { fromRunId: 'root-1', note: 'n', inherits: ['x'] },
      })).then(() => null, (thrown: unknown) => thrown)
      expect(error).toBeInstanceOf(AutopilotError)
      expect((error as AutopilotError).code).toBe('AP_CARRYOVER_NOT_COMPLETED')
    })

    it('accepts a completed predecessor', async () => {
      const h = makeHarness()
      await h.engine.init(h.root, makeTriage())
      await h.engine.submitPlan(h.root, 'plan')
      await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'ok' })
      await h.engine.submitExecutionEvidence(h.root, { report: 'r', residualRisks: [] })
      await h.engine.selfCheck(h.root, { role: 'execution', verdict: 'pass', note: 'ok' })
      await h.engine.submitCloseout(h.root, {
        summary: 's', changedFiles: [], commands: [],
        evidence: [{ criterion: 'tests pass', bearer: 'x.txt', status: 'proven' as const, kind: 'path' as const }],
        residualRisks: [], exclusions: [], workspaceCleanup: 'k', drift: 'none found',
      })
      const successor = fakeAgent('root-2')
      h.agents.add(successor)
      const init = await h.engine.init(successor, makeTriage({
        carryover: { fromRunId: 'root-1', note: 'stage 2', inherits: ['verified results'] },
      }))
      expect(init.phase).toBe('planning')
      expect(init.triage.carryover?.fromRunId).toBe('root-1')
    })
  })

  describe('audit round cap', () => {
    it('refuses same-role dispatches beyond the configured cap', async () => {
      const h = makeHarness({
        config: { governance: { maxAuditRoundsPerRole: 1 } },
        subagents: stubSubagents({ verdicts: [
          { verdict: 'needs-replan', note: 'fix it', findings: [{ severity: 'blocking', layer: 'plan', summary: 'criterion unmeasurable' }] },
        ] }),
      })
      await h.engine.init(h.root, makeTriage(INDEPENDENT_TRIAGE))
      await h.engine.submitPlan(h.root, 'plan v1')
      await h.engine.audit(h.root, { role: 'plan', prompt: 'round 1' }) // lands, replanning
      await h.engine.submitPlan(h.root, 'plan v2')
      const error = await h.engine.audit(h.root, { role: 'plan', prompt: 'round 2' })
        .then(() => null, (thrown: unknown) => thrown)
      expect(error).toBeInstanceOf(AutopilotError)
      expect((error as AutopilotError).code).toBe('AP_AUDIT_ROUND_CAP')
      expect((error as AutopilotError).message).toMatch(/maxAuditRoundsPerRole/)
    })
  })
})
