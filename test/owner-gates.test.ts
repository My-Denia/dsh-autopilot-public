/**
 * DESIGN §9 item 8: gate-level owner decisions and per-gate provenance.
 *
 * The gap this closes was registered rather than hidden: `autopilot_signal`
 * had `owner-approve` (one egress approval) and `owner-resolve` (unpause), but
 * no way for the owner to say "this gate is met" — and no record of WHO set a
 * gate. Two failure modes follow, and they are opposites:
 *
 *   - an owner ruling is silently overwritten by the next audit objection;
 *   - a withdrawn ruling comes quietly back into force.
 *
 * Neither is visible in a status that shows only the gate VALUE, so the source,
 * its generation (the plan revision) and its decision ordinal are recorded, the
 * write path honours the precedence WITHOUT losing the objection (a refused
 * commit would erase it — the one thing precedence must never do), and the
 * replay re-derives all of it and refuses a stream that disagrees.
 */
import { describe, expect, it } from 'vitest'
import { applyEvent } from '../src/domain/fold.js'
import { makeHarness, makeSnapshot, makeTriage, makeUsageEntry, stubSubagents, undeclaredSeed } from './helpers.js'
import type { Harness } from './helpers.js'
import type { AuditFinding, RunEvent, Snapshot } from '../src/domain/types.js'

const INLINE_MEDIUM = { size: 'standard', risk: 'medium', executionMode: 'inline', auditMode: 'independent' } as const

/** init + the usage answer + a submitted plan: planning, plan revision 1. */
async function toPlanSubmitted(h: Harness): Promise<void> {
  await h.engine.init(h.root, makeTriage(INLINE_MEDIUM), [undeclaredSeed('m1')])
  await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
  await h.engine.submitPlan(h.root, 'plan text')
}

/** The finding shape a needs-replan verdict must carry (a blocking plan-layer defect). */
const BLOCKING_PLAN: readonly AuditFinding[] = [
  { summary: 'the plan never says how the change is rolled back', severity: 'blocking', layer: 'plan' },
]

function thrownBy(operation: () => unknown): unknown {
  try {
    operation()
    return undefined
  } catch (error: unknown) {
    return error
  }
}

describe('gate provenance is recorded from the first revision on', () => {
  it('init records the pending reading of both gates', async () => {
    const h = makeHarness({ subagents: stubSubagents({ verdicts: [] }) })
    const snapshot = await h.engine.init(h.root, makeTriage(INLINE_MEDIUM), [undeclaredSeed('m1')])
    expect(snapshot.gateSources).toEqual({
      plan: { source: 'pending', planRevision: 0 },
      execution: { source: 'pending', planRevision: 0 },
    })
    expect(h.engine.projectStatus(snapshot).gateSources.plan?.source).toBe('pending')
  })

  it('a plan submission resets it to pending at the NEW generation', async () => {
    const h = makeHarness({ subagents: stubSubagents({ verdicts: [] }) })
    await toPlanSubmitted(h)
    const snapshot = h.engine.peek(h.root.id)
    expect(snapshot?.plan.revision).toBe(1)
    expect(snapshot?.gateSources).toEqual({
      plan: { source: 'pending', planRevision: 1 },
      execution: { source: 'pending', planRevision: 1 },
    })
  })

  it('a stream with no recorded provenance projects no-source — never a guess', () => {
    const h = makeHarness({ subagents: stubSubagents({ verdicts: [] }) })
    const status = h.engine.projectStatus(makeSnapshot({ runId: 'legacy-run' }))
    expect(status.gateSources).toEqual({
      plan: { source: 'no-source' },
      execution: { source: 'no-source' },
    })
  })
})

describe('the projection reads provenance per gate', () => {
  it('an owner pass on ONE gate leaves the other reading no-source', () => {
    // A legacy stream's first owner decision records provenance for the NAMED
    // gate only. Substituting `no-source` for the whole field would then make a
    // claim about the gate it has no record for.
    const h = makeHarness({ subagents: stubSubagents({ verdicts: [] }) })
    const status = h.engine.projectStatus(makeSnapshot({
      runId: 'legacy-run',
      gateSources: { plan: { source: 'owner', planRevision: 1, ownerDecision: 1 } },
    }))
    expect(status.gateSources.plan).toMatchObject({ source: 'owner', ownerDecision: 1 })
    expect(status.gateSources.execution).toEqual({ source: 'no-source' })
  })
})

describe('owner-gate-pass', () => {
  it('records the owner, the generation and the ordinal, and moves only that gate', async () => {
    const h = makeHarness({ subagents: stubSubagents({ verdicts: [] }) })
    await toPlanSubmitted(h)
    const passed = await h.engine.ownerGatePass(h.root, { gate: 'plan', note: 'owner accepts the plan' })
    expect(passed.phase).toBe('executing')
    expect(passed.planGate).toBe('pass')
    // One owner decision, one gate: the execution gate is untouched.
    expect(passed.executionGate).toBe('pending')
    expect(passed.gateSources?.plan).toEqual({
      source: 'owner',
      planRevision: 1,
      ownerDecision: 1,
      note: 'owner accepts the plan',
    })
    expect(passed.gateSources?.execution).toEqual({ source: 'pending', planRevision: 1 })
    expect(h.engine.projectStatus(passed).gateSources.plan?.source).toBe('owner')
  })

  it('refuses the plan gate while the usage question is unanswered', async () => {
    const h = makeHarness({ subagents: stubSubagents({ verdicts: [] }) })
    await h.engine.init(h.root, makeTriage(INLINE_MEDIUM), [undeclaredSeed('m1')])
    await h.engine.submitPlan(h.root, 'plan text')
    await expect(h.engine.ownerGatePass(h.root, { gate: 'plan', note: 'looks fine' }))
      .rejects.toMatchObject({ code: 'AP_USAGE_UNDECLARED' })
    expect(h.engine.peek(h.root.id)?.planGate).toBe('pending')
  })

  it('refuses a plan pass with no plan, and an execution pass with no evidence', async () => {
    const h = makeHarness({ subagents: stubSubagents({ verdicts: [] }) })
    await h.engine.init(h.root, makeTriage(INLINE_MEDIUM), [undeclaredSeed('m1')])
    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    await expect(h.engine.ownerGatePass(h.root, { gate: 'plan', note: 'nothing to pass' }))
      .rejects.toMatchObject({ code: 'AP_OWNER_GATE_INVALID' })

    await h.engine.submitPlan(h.root, 'plan text')
    await h.engine.ownerGatePass(h.root, { gate: 'plan', note: 'accept' })
    // The execution gate is only passable from execution-reviewing (evidence in).
    await expect(h.engine.ownerGatePass(h.root, { gate: 'execution', note: 'accept the work' }))
      .rejects.toMatchObject({ code: 'AP_OWNER_GATE_INVALID' })
  })

  it('passes the execution gate once the evidence is in — and only that gate', async () => {
    const h = makeHarness({ subagents: stubSubagents({ verdicts: [] }) })
    await toPlanSubmitted(h)
    await h.engine.ownerGatePass(h.root, { gate: 'plan', note: 'accept' })
    await h.engine.submitExecutionEvidence(h.root, { report: 'did the work', residualRisks: [] })
    const passed = await h.engine.ownerGatePass(h.root, { gate: 'execution', note: 'the evidence is enough' })
    expect(passed.phase).toBe('closing')
    expect(passed.executionGate).toBe('pass')
    expect(passed.planGate).toBe('pass')
    expect(passed.gateSources?.plan?.source).toBe('owner')
    expect(passed.gateSources?.execution).toMatchObject({ source: 'owner', planRevision: 1, ownerDecision: 1 })
  })
})

describe('an owner pass stands against a later audit objection', () => {
  it('records the objection, leaves the owner-passed plan gate standing, and moves the other gate', async () => {
    const h = makeHarness({
      subagents: stubSubagents({
        // The FIRST audit this run dispatches is the objection: the plan gate
        // was passed by the owner, so no plan review ran before it.
        verdicts: [{ verdict: 'needs-replan', note: 'the plan is thin', findings: [...BLOCKING_PLAN] }],
      }),
    })
    await toPlanSubmitted(h)
    await h.engine.ownerGatePass(h.root, { gate: 'plan', note: 'owner accepts the plan' })
    await h.engine.submitExecutionEvidence(h.root, { report: 'did the work', residualRisks: [] })
    await h.engine.audit(h.root, { role: 'execution', prompt: 'audit packet' })
    // `audit()` returns the verdict it received, not the run state; the durable
    // snapshot is what the precedence rule is about.
    const after = h.engine.peek(h.root.id) as Snapshot

    // The objection IS the record: it was appended with its verdict and note.
    expect(after.audits.map(record => record.verdict)).toEqual(['needs-replan'])
    expect(after.audits[0]?.note).toBe('the plan is thin')
    // The gate the owner passed did not move; the one they did not pass did.
    expect(after.planGate).toBe('pass')
    expect(after.gateSources?.plan).toMatchObject({ source: 'owner', planRevision: 1, ownerDecision: 1 })
    expect(after.executionGate).toBe('needs-replan')
    expect(after.phase).toBe('replanning')
    expect(after.diagnostic).toContain('did not move the plan gate')
  })

  it('control: without the owner pass the very same objection moves the gate', async () => {
    const h = makeHarness({
      subagents: stubSubagents({
        verdicts: [
          { verdict: 'pass', note: 'plan ok' },
          { verdict: 'needs-replan', note: 'the plan is thin', findings: [...BLOCKING_PLAN] },
        ],
      }),
    })
    await toPlanSubmitted(h)
    await h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })
    await h.engine.submitExecutionEvidence(h.root, { report: 'did the work', residualRisks: [] })
    await h.engine.audit(h.root, { role: 'execution', prompt: 'audit packet' })
    const after = h.engine.peek(h.root.id) as Snapshot
    expect(after.planGate).toBe('needs-replan')
    expect(after.gateSources?.plan?.source).toBe('auditor')
  })
})

describe('a new generation supersedes the owner\'s ruling', () => {
  it('replan clears the owner pass: the gate belongs to the reviews again', async () => {
    const h = makeHarness({ subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'plan ok' }] }) })
    await toPlanSubmitted(h)
    await h.engine.ownerGatePass(h.root, { gate: 'plan', note: 'accept at revision 1' })
    expect(h.engine.peek(h.root.id)?.gateSources?.plan).toMatchObject({ source: 'owner', planRevision: 1 })

    const replanned = await h.engine.replan(h.root, 'round two')
    // The generation the owner ruled on is superseded: no ownerDecision, no
    // withdrawal — simply pending again, as a fresh plan submission resets it.
    expect(replanned.planGate).toBe('pending')
    expect(replanned.gateSources).toEqual({
      plan: { source: 'pending', planRevision: 1 },
      execution: { source: 'pending', planRevision: 1 },
    })
    expect(h.engine.projectStatus(replanned).gateSources.plan?.ownerDecision).toBeUndefined()

    // The next submitted plan is a NEW generation, and a pass on it is the
    // auditor's — the superseded owner ruling does not come with it.
    const submitted = await h.engine.submitPlan(h.root, 'plan v2')
    expect(submitted.plan.revision).toBe(2)
    expect(submitted.gateSources?.plan).toEqual({ source: 'pending', planRevision: 2 })
    await h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })
    const after = h.engine.peek(h.root.id) as Snapshot
    expect(after.planGate).toBe('pass')
    expect(after.gateSources?.plan).toMatchObject({ source: 'auditor', planRevision: 2 })
    expect(after.gateSources?.plan?.ownerDecision).toBeUndefined()
  })
})

describe('owner-gate-withdraw', () => {
  it('falls back to the reviews that actually ran, and keeps the ordinal it took back', async () => {
    const h = makeHarness({ subagents: stubSubagents({ verdicts: [] }) })
    await toPlanSubmitted(h)
    await h.engine.ownerGatePass(h.root, { gate: 'plan', note: 'accept' })
    const withdrawn = await h.engine.ownerGateWithdraw(h.root, { gate: 'plan', note: 'changed my mind' })
    // This generation was never reviewed, so the honest fallback is pending —
    // and the run returns to planning rather than pretending otherwise.
    expect(withdrawn.planGate).toBe('pending')
    expect(withdrawn.phase).toBe('planning')
    expect(withdrawn.gateSources?.plan).toEqual({
      source: 'pending',
      planRevision: 1,
      ownerDecision: 1,
      withdrawn: true,
      note: 'changed my mind',
    })
  })

  it('refuses a gate the owner never passed, and a decision already withdrawn', async () => {
    const h = makeHarness({ subagents: stubSubagents({ verdicts: [] }) })
    await toPlanSubmitted(h)
    await expect(h.engine.ownerGateWithdraw(h.root, { gate: 'plan', note: 'not mine to take' }))
      .rejects.toMatchObject({ code: 'AP_OWNER_GATE_NOT_PASSED' })

    await h.engine.ownerGatePass(h.root, { gate: 'plan', note: 'accept' })
    await h.engine.ownerGateWithdraw(h.root, { gate: 'plan', note: 'taken back' })
    await expect(h.engine.ownerGateWithdraw(h.root, { gate: 'plan', note: 'again' }))
      .rejects.toMatchObject({ code: 'AP_OWNER_GATE_NOT_PASSED' })
  })

  it('a later ordinary pass does not put the owner name back on the gate', async () => {
    const h = makeHarness({ subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'plan ok' }] }) })
    await toPlanSubmitted(h)
    await h.engine.ownerGatePass(h.root, { gate: 'plan', note: 'accept' })
    await h.engine.ownerGateWithdraw(h.root, { gate: 'plan', note: 'taken back' })
    await h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })
    const after = h.engine.peek(h.root.id) as Snapshot
    expect(after.planGate).toBe('pass')
    // The gate is passed again — by the AUDITOR, and the withdrawal stays on the
    // record instead of being quietly forgotten.
    expect(after.gateSources?.plan).toMatchObject({
      source: 'auditor',
      planRevision: 1,
      ownerDecision: 1,
      withdrawn: true,
    })
    // ...and the withdrawn decision is still not the owner's to withdraw again.
    await expect(h.engine.ownerGateWithdraw(h.root, { gate: 'plan', note: 'again' }))
      .rejects.toMatchObject({ code: 'AP_OWNER_GATE_NOT_PASSED' })
  })
})

describe('generation changes end an owner pass (the amend-plan regression)', () => {
  it('an amended plan frees the gate: a needs-replan delta audit MOVES it and keeps its verdict', async () => {
    // THE DEFECT THIS PINS: `amend-plan` advances the plan revision without
    // touching `gateSources`, and the fold's precedence guard once ignored the
    // generation while the engine's `ownerPassInForce` honoured it. The commit
    // that carried the auditor's verdict was therefore refused by the fold —
    // the objection was DISCARDED (the one outcome the write-path precedence
    // exists to prevent) and the run was left in `plan-reviewing`, a phase from
    // which neither `submit-plan` nor `replan` is legal.
    const h = makeHarness({
      subagents: stubSubagents({
        verdicts: [{ verdict: 'needs-replan', note: 'the amendment is thin', findings: [...BLOCKING_PLAN] }],
      }),
    })
    await toPlanSubmitted(h)
    await h.engine.ownerGatePass(h.root, { gate: 'plan', note: 'accept at revision 1' })
    const amended = await h.engine.amendPlan(h.root, { text: 'plan v2', note: 'narrow the scope' })
    expect(amended.plan.revision).toBe(2)
    expect(amended.planGate).toBe('pass')
    // The stale record is still READABLE, and it says which generation it
    // belongs to — it is simply no longer in force.
    expect(amended.gateSources?.plan).toMatchObject({ source: 'owner', planRevision: 1 })

    // The delta re-audit runs in an execution phase (the armed amendment opens
    // the plan role there) and its needs-replan must land.
    await h.engine.audit(h.root, { role: 'plan', prompt: 'delta packet' })
    const after = h.engine.peek(h.root.id) as Snapshot
    expect(after.audits.map(record => record.verdict)).toEqual(['needs-replan'])
    expect(after.planGate).toBe('needs-replan')
    expect(after.gateSources?.plan).toMatchObject({ source: 'auditor', planRevision: 2 })
    expect(after.gateSources?.plan?.ownerDecision).toBe(1)
  })

  it('a superseded pass cannot be withdrawn — there is nothing left to take back', async () => {
    const h = makeHarness({ subagents: stubSubagents({ verdicts: [] }) })
    await toPlanSubmitted(h)
    await h.engine.ownerGatePass(h.root, { gate: 'plan', note: 'accept at revision 1' })
    await h.engine.amendPlan(h.root, { text: 'plan v2', note: 'narrow the scope' })
    await expect(h.engine.ownerGateWithdraw(h.root, { gate: 'plan', note: 'take it back' }))
      .rejects.toMatchObject({ code: 'AP_OWNER_GATE_NOT_PASSED' })
  })
})

describe('the fold re-derives provenance and refuses what the writer cannot produce', () => {
  it('refuses a stream that resurrects a withdrawn owner decision', () => {
    const prior = makeSnapshot({
      plan: { revision: 1, text: 'plan text' },
      phase: 'planning',
      planGate: 'pending',
      gateSources: {
        plan: { source: 'pending', planRevision: 1, ownerDecision: 1, withdrawn: true },
        execution: { source: 'pending', planRevision: 1 },
      },
    })
    const event: RunEvent = {
      v: 1,
      op: 'owner-gate-pass',
      revision: prior.revision + 1,
      time: new Date().toISOString(),
      snapshot: {
        ...prior,
        revision: prior.revision + 1,
        phase: 'executing',
        planGate: 'pass',
        // The SAME ordinal the owner took back, put back into force by hand.
        gateSources: {
          ...prior.gateSources,
          plan: { source: 'owner', planRevision: 1, ownerDecision: 1 },
        },
      },
      detail: { gate: 'plan', note: 'again' },
    }
    expect(thrownBy(() => applyEvent(prior, event))).toMatchObject({ code: 'AP_OWNER_GATE_RESURRECTED' })
  })

  it('refuses a stream where an ordinary event moves a gate the owner passed', () => {
    const prior = makeSnapshot({
      plan: { revision: 1, text: 'plan text' },
      phase: 'executing',
      planGate: 'pass',
      gateSources: {
        plan: { source: 'owner', planRevision: 1, ownerDecision: 1 },
        execution: { source: 'pending', planRevision: 1 },
      },
    })
    const event: RunEvent = {
      v: 1,
      op: 'reminder',
      revision: prior.revision + 1,
      time: new Date().toISOString(),
      snapshot: { ...prior, revision: prior.revision + 1, planGate: 'needs-replan' },
    }
    expect(thrownBy(() => applyEvent(prior, event))).toMatchObject({ code: 'AP_OWNER_GATE_PRECEDENCE' })
  })

  it('refuses an INVENTED owner source — the writer has no freedom to author provenance', () => {
    // The mechanism the whole design rests on: `applyGateLedger` is the single
    // derivation both sides call, so a stream whose provenance the derivation
    // would never produce is refused. This is the FIRST test that reaches that
    // equality — the three shape checks all fire earlier in the fold.
    const prior = makeSnapshot({
      plan: { revision: 1, text: 'plan text' },
      phase: 'executing',
      planGate: 'pass',
      gateSources: {
        plan: { source: 'auditor', planRevision: 1 },
        execution: { source: 'pending', planRevision: 1 },
      },
    })
    const event: RunEvent = {
      v: 1,
      op: 'reminder',
      revision: prior.revision + 1,
      time: new Date().toISOString(),
      snapshot: {
        ...prior,
        revision: prior.revision + 1,
        gateSources: {
          plan: { source: 'owner', planRevision: 1, ownerDecision: 7 },
          execution: { source: 'pending', planRevision: 1 },
        },
      },
    }
    expect(thrownBy(() => applyEvent(prior, event))).toMatchObject({ code: 'AP_GATE_SOURCE_INVALID' })
  })

  it('refuses a stream that DROPS recorded provenance', () => {
    const prior = makeSnapshot({
      plan: { revision: 1, text: 'plan text' },
      phase: 'executing',
      planGate: 'pass',
      gateSources: {
        plan: { source: 'auditor', planRevision: 1 },
        execution: { source: 'pending', planRevision: 1 },
      },
    })
    const event: RunEvent = {
      v: 1,
      op: 'reminder',
      revision: prior.revision + 1,
      time: new Date().toISOString(),
      snapshot: { ...prior, revision: prior.revision + 1, gateSources: undefined },
    }
    // The SPECIFIC diagnosis, not the generic derivation mismatch: this rule has
    // to be checked before the equality or it can never fire (its own comment
    // says so, and the audit found it unreachable).
    expect(thrownBy(() => applyEvent(prior, event))).toMatchObject({ code: 'AP_GATE_SOURCE_SHRANK' })
  })

  it('refuses a DOCTORED executor dispatch count', () => {
    const prior = makeSnapshot({
      plan: { revision: 1, text: 'plan text' },
      phase: 'executing',
      planGate: 'pass',
      executorDispatches: 1,
      gateSources: {
        plan: { source: 'auditor', planRevision: 1 },
        execution: { source: 'pending', planRevision: 1 },
      },
    })
    const event: RunEvent = {
      v: 1,
      op: 'reminder',
      revision: prior.revision + 1,
      time: new Date().toISOString(),
      snapshot: { ...prior, revision: prior.revision + 1, executorDispatches: 4 },
    }
    expect(thrownBy(() => applyEvent(prior, event))).toMatchObject({ code: 'AP_EXECUTOR_DISPATCH_COUNT' })
  })

  it('refuses an owner decision that carries the other gate along', () => {
    const prior = makeSnapshot({
      plan: { revision: 1, text: 'plan text' },
      phase: 'planning',
      planGate: 'pending',
      gateSources: {
        plan: { source: 'pending', planRevision: 1 },
        execution: { source: 'pending', planRevision: 1 },
      },
    })
    const event: RunEvent = {
      v: 1,
      op: 'owner-gate-pass',
      revision: prior.revision + 1,
      time: new Date().toISOString(),
      snapshot: {
        ...prior,
        revision: prior.revision + 1,
        phase: 'executing',
        planGate: 'pass',
        // The side effect the rule forbids: the plan decision also passes the
        // execution gate.
        executionGate: 'pass',
        gateSources: {
          plan: { source: 'owner', planRevision: 1, ownerDecision: 1 },
          execution: { source: 'owner', planRevision: 1, ownerDecision: 1 },
        },
      },
      detail: { gate: 'plan', note: 'accept' },
    }
    expect(thrownBy(() => applyEvent(prior, event))).toMatchObject({ code: 'AP_OWNER_GATE_INVALID' })
  })
})
