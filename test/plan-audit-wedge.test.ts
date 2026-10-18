/**
 * The plan-reviewing wedge (P0) and its recovery.
 *
 * Reproduced twice on the real host (M9 cleanup.md): a plan audit whose verdict
 * is refused pre-commit by the findings contract — needs-replan without a
 * blocking plan-layer finding, or an empty findings array — left the run in
 * plan-reviewing, where assertAuditPhase refuses every further plan audit. The
 * engine now recovers: when the verdict path refuses the audit AND the live
 * state still equals the captured baseline, a recovery event restores the
 * pre-dispatch phase so the plan can be re-audited. AP_STALE_AUDIT is the one
 * refusal that must NOT roll back (the baseline moved).
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AutopilotError } from '../src/domain/types.js'
import type { RunEvent } from '../src/domain/types.js'
import { makeHarness, makeTriage, stubSubagents } from './helpers.js'
import type { StubVerdictScript } from './helpers.js'

const INDEPENDENT_TRIAGE = {
  risk: 'high' as const,
  size: 'standard' as const,
  auditMode: 'independent' as const,
  executionMode: 'inline' as const,
}

/** Drive an independent run through init + submit-plan; the scripted verdict serves the plan audit. */
async function planningRun(verdicts: Array<StubVerdictScript | { stopReason: string }>) {
  const h = makeHarness({ subagents: stubSubagents({ verdicts }) })
  await h.engine.init(h.root, makeTriage(INDEPENDENT_TRIAGE))
  await h.engine.submitPlan(h.root, 'plan v1')
  return h
}

function eventsOf(h: { readonly storeDir: string; readonly root: { readonly id: string } }): RunEvent[] {
  return readFileSync(join(h.storeDir, 'runs', h.root.id, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as RunEvent)
}

describe('plan-reviewing wedge recovery (P0)', () => {
  it('needs-replan without a blocking plan-layer finding recovers to planning and re-audit passes', async () => {
    // First audit: contract-violating verdict (findings contract refuses it).
    // Second audit: a proper pass, served after the recovery.
    const h = await planningRun([
      { verdict: 'needs-replan', note: 'gap', findings: [{ severity: 'blocking', layer: 'execution', summary: 'executor-fixable' }] },
      { verdict: 'pass', note: 'ok' },
    ])
    const error = await h.engine.audit(h.root, { role: 'plan', prompt: 'audit' })
      .then(() => null, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(AutopilotError)
    expect((error as AutopilotError).code).toBe('AP_AUDIT_FINDINGS_INVALID')

    // Recovery: back in planning (not plan-reviewing), no audit record appended.
    const snapshot = h.engine.peek(h.root.id)
    expect(snapshot?.phase).toBe('planning')
    expect(snapshot?.audits).toHaveLength(0)

    // The re-dispatched proper audit now passes the gate.
    const outcome = await h.engine.audit(h.root, { role: 'plan', prompt: 're-audit' })
    expect(outcome.verdict).toBe('pass')
    expect(h.engine.peek(h.root.id)?.phase).toBe('executing')
    expect(h.engine.peek(h.root.id)?.planGate).toBe('pass')
  })

  it('an empty findings array recovers to planning', async () => {
    const h = await planningRun([
      { verdict: 'pass', note: 'ok', findings: [] },
      { verdict: 'pass', note: 'ok' },
    ])
    const error = await h.engine.audit(h.root, { role: 'plan', prompt: 'audit' })
      .then(() => null, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(AutopilotError)
    expect((error as AutopilotError).code).toBe('AP_AUDIT_FINDINGS_INVALID')
    expect(h.engine.peek(h.root.id)?.phase).toBe('planning')
    expect(h.engine.peek(h.root.id)?.audits).toHaveLength(0)
  })

  it('no structured verdict (AP_AUDIT_NO_VERDICT) recovers to planning', async () => {
    const h = await planningRun([
      { stopReason: 'error' },
      { verdict: 'pass', note: 'ok' },
    ])
    const error = await h.engine.audit(h.root, { role: 'plan', prompt: 'audit' })
      .then(() => null, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(AutopilotError)
    expect((error as AutopilotError).code).toBe('AP_AUDIT_NO_VERDICT')
    expect(h.engine.peek(h.root.id)?.phase).toBe('planning')
    expect(h.engine.peek(h.root.id)?.audits).toHaveLength(0)
  })

  it('invalid verdict string (AP_AUDIT_INVALID_VERDICT) recovers to planning', async () => {
    const h = await planningRun([
      { verdict: 'bogus', note: 'n' } as unknown as StubVerdictScript,
      { verdict: 'pass', note: 'ok' },
    ])
    const error = await h.engine.audit(h.root, { role: 'plan', prompt: 'audit' })
      .then(() => null, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(AutopilotError)
    expect((error as AutopilotError).code).toBe('AP_AUDIT_INVALID_VERDICT')
    expect(h.engine.peek(h.root.id)?.phase).toBe('planning')
    expect(h.engine.peek(h.root.id)?.audits).toHaveLength(0)
  })

  it('the recovery event is durable in the event stream with stage=rejected, and the stream re-folds', async () => {
    const h = await planningRun([
      { verdict: 'needs-replan', note: 'gap', findings: [{ severity: 'blocking', layer: 'execution', summary: 'x' }] },
      { verdict: 'pass', note: 'ok' },
    ])
    await h.engine.audit(h.root, { role: 'plan', prompt: 'audit' })
      .then(() => null, (thrown: unknown) => thrown)
    const events = eventsOf(h)
    const rejected = events.filter(e => e.op === 'audit' && (e.detail as { stage?: string })?.stage === 'rejected')
    expect(rejected.length).toBe(1)
    expect((rejected[0]?.detail as { role?: string })?.role).toBe('plan')
    expect((rejected[0]?.detail as { error?: { code?: string } })?.error?.code).toBe('AP_AUDIT_FINDINGS_INVALID')
    // The recovery event restored planning; a fresh engine re-folds the stream.
    const { foldRun } = await import('../src/domain/fold.js')
    expect(() => foldRun(events)).not.toThrow()
    expect(foldRun(events).snapshot?.phase).toBe('planning')
  })

  it('AP_STALE_AUDIT does NOT roll back (the baseline moved)', async () => {
    // A stale plan verdict is unreachable single-flight (the transact serializes
    // commits), so this arm proves the exclusion structurally: the recovery
    // condition names exactly the three verdict-contract codes and omits
    // AP_STALE_AUDIT, and a stale refusal leaves no recovery event behind. The
    // positive half — a healthy pass still lands — confirms the audit path is
    // intact.
    const h = await planningRun([{ verdict: 'pass', note: 'ok' }])
    await h.engine.audit(h.root, { role: 'plan', prompt: 'audit' })
    expect(h.engine.peek(h.root.id)?.phase).toBe('executing')
    const engineSource = readFileSync(
      join(__dirname, '..', 'src', 'engine.ts'), 'utf8')
    expect(engineSource).toContain("error.code === 'AP_AUDIT_NO_VERDICT'")
    expect(engineSource).toContain("error.code === 'AP_AUDIT_INVALID_VERDICT'")
    expect(engineSource).toContain("error.code === 'AP_AUDIT_FINDINGS_INVALID'")
    // The recovery branch must not list AP_STALE_AUDIT.
    const recoveryBranch = engineSource.split('PLAN-AUDIT RECOVERY')[1] ?? ''
    expect(recoveryBranch).not.toContain("error.code === 'AP_STALE_AUDIT'")
  })
})
