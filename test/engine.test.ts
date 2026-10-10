/** Engine behavior: authority, gates, audits, executor lifecycle, closeout, enforcement. */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { AutopilotError, canonicalBearer } from '../src/domain/types.js'
import type { EvidenceKind } from '../src/domain/types.js'
import {
  AUDITOR_TOOL_ALLOW,
  AUDITOR_TOOL_REQUIRED,
  approvalAuthorizes,
  parseRestrictRejection,
  resolveToolAllow,
} from '../src/engine.js'
import { DEFAULT_EXECUTOR_TOOLS } from '../src/config.js'
import { fakeAgent, makeHarness, makeTriage, makeUsageEntry, stubSubagents, undeclaredSeed } from './helpers.js'

const GOOD_CLOSEOUT = {
  summary: 'done',
  changedFiles: ['a.ts'],
  commands: ['pnpm test - pass'],
  evidence: [{ criterion: 'tests pass', bearer: 'test-run.txt', status: 'proven' as const, kind: 'path' as const }],
  residualRisks: [],
  exclusions: [],
  workspaceCleanup: 'nothing created',
  drift: 'none found',
}

/** Drive a lightweight self-check run to `closing`, ready for a closeout. */
async function readyToClose(): Promise<ReturnType<typeof makeHarness>> {
  const h = makeHarness()
  await h.engine.init(h.root, makeTriage())
  await h.engine.submitPlan(h.root, 'plan')
  await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'ok' })
  await h.engine.submitExecutionEvidence(h.root, { report: 'r', residualRisks: [] })
  await h.engine.selfCheck(h.root, { role: 'execution', verdict: 'pass', note: 'ok' })
  return h
}

describe('authority', () => {
  it('rejects a caller that is not the live registered agent', async () => {
    const h = makeHarness()
    const impostor = fakeAgent('root-1') // same id, different object
    await expect(h.engine.init(impostor, makeTriage())).rejects.toThrowError(/not the live registered root/)
  })

  it('rejects a non-root caller', async () => {
    const h = makeHarness()
    const child = fakeAgent('child-1', 'root-1')
    h.agents.add(child)
    await expect(h.engine.init(child, makeTriage())).rejects.toThrowError(/must be top-level/)
  })
})

describe('inline self-check lightweight happy path', () => {
  it('runs init -> plan -> self-check pass -> evidence -> self-check pass -> closeout', async () => {
    const h = makeHarness()
    const init = await h.engine.init(h.root, makeTriage())
    expect(init.phase).toBe('planning')
    expect(init.enforcement.sandbox).toBe('off') // lightweight: no clamp

    await h.engine.submitPlan(h.root, 'milestone 1 - verify: pnpm test')
    const planCheck = await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'binary checks present' })
    expect(planCheck.verdict).toBe('pass')
    expect(h.engine.peek(h.root.id)?.phase).toBe('executing')
    expect(h.engine.peek(h.root.id)?.planGate).toBe('pass')

    await h.engine.log(h.root, { text: 'edited a.ts, pnpm test pass', stance: 'on-plan' })
    await h.engine.submitExecutionEvidence(h.root, { report: 'changed a.ts; pnpm test 12/12 pass', residualRisks: [] })
    expect(h.engine.peek(h.root.id)?.phase).toBe('execution-reviewing')

    await h.engine.selfCheck(h.root, { role: 'execution', verdict: 'pass', note: 'evidence matches criteria' })
    expect(h.engine.peek(h.root.id)?.phase).toBe('closing')
    expect(h.engine.peek(h.root.id)?.executionGate).toBe('pass')

    const done = await h.engine.submitCloseout(h.root, GOOD_CLOSEOUT)
    expect(done.phase).toBe('completed')
  })

  it('REFUSES a proven evidence entry with no kind, and commits nothing', async () => {
    // The WRITE path. `evaluateCompletion` would also refuse this, but only as
    // one line inside AP_COMPLETION_REFUSED; the specific code is what tells
    // the caller which field to fix.
    const h = await readyToClose()
    const error = await h.engine.submitCloseout(h.root, {
      ...GOOD_CLOSEOUT,
      evidence: [{ criterion: 'tests pass', bearer: 'test-run.txt', status: 'proven' as const }],
    }).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(AutopilotError)
    expect((error as AutopilotError).code).toBe('AP_EVIDENCE_KIND_REQUIRED')
    expect((error as AutopilotError).message).toMatch(/tests pass/)
    expect(h.engine.peek(h.root.id)?.phase).toBe('closing')
    expect(h.engine.peek(h.root.id)?.closeout).toBeUndefined()
  })

  it('ACCEPTS an unproven kind-less entry at the engine layer and still stamps evidenceKinds: 1', async () => {
    // Owner ruling on PR #5 (CodeRabbit asked for the opposite): the stamp is
    // "proven evidence kind validation v1", not "every item carries a kind".
    // An unproven entry bears no artifact, so the engine invents no kind for
    // it; the tool schema is the stricter surface and requires `kind` on
    // every item there. This pins the layer boundary so it cannot drift
    // silently in either direction.
    //
    // Governance pragmatics v1: an unproven criterion is now a PARTIAL
    // delivery, which requires a handoff mapping the open item. The layer
    // boundary under test (kind-less unproven accepted at the engine layer)
    // is unchanged; what changed is that the gap must be handed off, and the
    // outcome label is derived rather than defaulted to complete.
    const h = await readyToClose()
    const snapshot = await h.engine.submitCloseout(h.root, {
      ...GOOD_CLOSEOUT,
      evidence: [{ criterion: 'tests pass', bearer: '', status: 'unproven' as const }],
      handoff: {
        openItems: [{ criterion: 'tests pass', state: 'not-implemented' as const, note: 'gap handed to the follow-up run' }],
      },
    })
    expect(snapshot.phase).toBe('completed')
    expect(snapshot.closeout?.outcome).toBe('partial')
    const events = readFileSync(join(h.storeDir, 'runs', h.root.id, 'events.jsonl'), 'utf8')
      .trim().split(String.fromCharCode(10))
      .map(line => JSON.parse(line) as { op: string; detail?: { evidenceKinds?: unknown } })
    const closeouts = events.filter(event => event.op === 'submit-closeout')
    expect(closeouts).toHaveLength(1)
    expect(closeouts[0]?.detail?.evidenceKinds).toBe(1)
  })

  it('REFUSES an unknown evidence kind with its own code', async () => {
    const h = await readyToClose()
    const error = await h.engine.submitCloseout(h.root, {
      ...GOOD_CLOSEOUT,
      evidence: [{
        criterion: 'tests pass',
        bearer: 'test-run.txt',
        status: 'proven' as const,
        kind: 'sketch' as unknown as EvidenceKind,
      }],
    }).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(AutopilotError)
    expect((error as AutopilotError).code).toBe('AP_EVIDENCE_KIND_INVALID')
    expect(h.engine.peek(h.root.id)?.phase).toBe('closing')
  })

  it('stamps evidenceKinds on the committed submit-closeout event', async () => {
    // The stamp is what lets a later fold hold THIS event to the current rule
    // without holding pre-`kind` events to a rule that did not exist yet.
    const h = await readyToClose()
    const done = await h.engine.submitCloseout(h.root, GOOD_CLOSEOUT)
    expect(done.phase).toBe('completed')
    const lines = readFileSync(join(h.storeDir, 'runs', h.root.id, 'events.jsonl'), 'utf8')
      .trim().split(String.fromCharCode(10))
      .map(line => JSON.parse(line) as { op: string; detail?: { evidenceKinds?: unknown } })
    const closeoutEvents = lines.filter(entry => entry.op === 'submit-closeout')
    expect(closeoutEvents).toHaveLength(1)
    expect(closeoutEvents[0]?.detail?.evidenceKinds).toBe(1)
  })

  it('refuses closeout when evidence misses a criterion', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'ok' })
    await h.engine.submitExecutionEvidence(h.root, { report: 'r', residualRisks: [] })
    await h.engine.selfCheck(h.root, { role: 'execution', verdict: 'pass', note: 'ok' })
    await expect(h.engine.submitCloseout(h.root, GOOD_CLOSEOUT)).rejects.toThrowError(/no evidence entry: lint clean/)
  })
})

describe('triage validation and mode fences', () => {
  it('rejects illegal triage combinations at init', async () => {
    const h = makeHarness()
    // makeTriage defaults auditMode 'self-check'; medium risk may not self-review.
    await expect(h.engine.init(h.root, makeTriage({ risk: 'medium' })))
      .rejects.toThrowError(/may not self-review/)
  })

  it('rejects selfCheck on an independent run', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent' }))
    await h.engine.submitPlan(h.root, 'plan')
    await expect(h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'x' }))
      .rejects.toThrowError(/only legal on auditMode self-check/)
  })

  it('rejects audit dispatch on a self-check run', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    await h.engine.submitPlan(h.root, 'plan')
    await expect(h.engine.audit(h.root, { role: 'plan', prompt: 'audit it' }))
      .rejects.toThrowError(/requires auditMode independent/)
  })

  it('rejects inline evidence on a delegated run and packets on inline runs', async () => {
    const subagents = stubSubagents({ verdicts: [{ verdict: 'pass', note: 'plan ok' }] })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })
    await expect(h.engine.submitExecutionEvidence(h.root, { report: 'r', residualRisks: [] }))
      .rejects.toThrowError(/illegal on delegated runs/)
  })
})

describe('independent audits (stubbed subagents)', () => {
  it('passes the plan gate through a dispatched auditor and records route provenance', async () => {
    const subagents = stubSubagents({ verdicts: [{ verdict: 'pass', note: 'sound plan' }] })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent' }))
    await h.engine.submitPlan(h.root, 'plan text')
    const outcome = await h.engine.audit(h.root, { role: 'plan', prompt: 'bounded packet' })
    expect(outcome.verdict).toBe('pass')
    const snapshot = h.engine.peek(h.root.id)
    expect(snapshot?.planGate).toBe('pass')
    expect(snapshot?.phase).toBe('executing')
    // RE-SPECIFIED (plan v3 M4 / [R1-P1]): `verified` now requires an explicit
    // selection to have been honored end-to-end. This dispatch INHERITED the
    // deployment default (no routing decision pinned a route), so even with
    // creation and observed agreeing on stub-model the honest status is
    // `unverified` — no route claim was in play to verify. The old assertion
    // (`'verified'` from creation options alone) was exactly the creation-only
    // defect plan v3 fixes.
    expect(snapshot?.audits[0]?.route.routeStatus).toBe('unverified')
    expect(snapshot?.audits[0]?.route.routeModel).toBe('stub-model')
  })

  it('never passes a gate on a missing structured verdict', async () => {
    const subagents = stubSubagents({ verdicts: [{ stopReason: 'error' }] })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent' }))
    await h.engine.submitPlan(h.root, 'plan')
    await expect(h.engine.audit(h.root, { role: 'plan', prompt: 'p' })).rejects.toThrowError(/no structured verdict/)
    expect(h.engine.peek(h.root.id)?.planGate).toBe('pending')
  })
})

describe('bounded escalation', () => {
  it('keeps replanning past the budget instead of forcing an owner decision (governance pragmatics v1)', async () => {
    // The forced escalation was REMOVED deliberately: budget exhaustion is
    // not an owner-level question (the m6-live incident recorded the run it
    // stranded). The budget stays OBSERVED — visible in status and in the
    // diagnostic — and escalation is a deliberate autopilot_signal choice.
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    for (let round = 1; round <= 2; round++) {
      await h.engine.submitPlan(h.root, `plan v${round}`)
      await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'needs-replan', note: `round ${round}` })
      expect(h.engine.peek(h.root.id)?.phase).toBe('replanning')
    }
    await h.engine.submitPlan(h.root, 'plan v3')
    await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'needs-replan', note: 'round 3' })
    const snapshot = h.engine.peek(h.root.id)
    expect(snapshot?.phase).toBe('replanning')
    expect(snapshot?.diagnostic).toMatch(/replan budget exhausted/)
    expect(snapshot?.consecutiveReplans).toBe(3)
  })

  it('owner-resolve resumes planning and resets the budget', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    await h.engine.setOwnerDecision(h.root, 'need a ruling')
    const resumed = await h.engine.ownerResolve(h.root, { decision: 'resume-planning', note: 'proceed with option B' })
    expect(resumed.phase).toBe('planning')
    expect(resumed.consecutiveReplans).toBe(0)
  })
})

describe('delegated executor lifecycle', () => {
  async function delegatedToExecuting() {
    const subagents = stubSubagents({
      verdicts: [
        { verdict: 'pass', note: 'plan ok' },
        { verdict: 'pass', note: 'execution ok' },
      ],
    })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })
    return h
  }

  it('runs start -> packet -> execution audit pass -> closing -> closeout', async () => {
    const h = await delegatedToExecuting()
    const signal = new AbortController().signal
    const started = await h.engine.startExecutor(h.root, { prompt: 'implement M1', signal })
    expect(started.executor?.state).toBe('running')
    const childId = started.executor?.childId as string

    const child = fakeAgent(childId, h.root.id)
    h.agents.add(child)
    const submitted = await h.engine.submitExecutionPacket(child, { packet: 'did the work; tests green', residualRisks: [], executionRevision: 1 })
    expect(submitted.phase).toBe('execution-reviewing')

    await h.engine.audit(h.root, { role: 'execution', prompt: 'audit packet' })
    const snapshot = h.engine.peek(h.root.id)
    expect(snapshot?.phase).toBe('closing')
    expect(snapshot?.executor?.state).toBe('completed')

    const done = await h.engine.submitCloseout(h.root, GOOD_CLOSEOUT)
    expect(done.phase).toBe('completed')
  })

  it('rejects a packet from a non-authorized child', async () => {
    const h = await delegatedToExecuting()
    const signal = new AbortController().signal
    await h.engine.startExecutor(h.root, { prompt: 'implement', signal })
    const stranger = fakeAgent('stranger', h.root.id)
    h.agents.add(stranger)
    await expect(h.engine.submitExecutionPacket(stranger, { packet: 'x', residualRisks: [], executionRevision: 1 }))
      .rejects.toThrowError(/not the authorized executor/)
  })

  it('records a revoked executor when continuable startup fails', async () => {
    const subagents = stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }], failContinuable: true })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    const signal = new AbortController().signal
    await expect(h.engine.startExecutor(h.root, { prompt: 'go', signal })).rejects.toThrowError(/scripted/)
    expect(h.engine.peek(h.root.id)?.executor?.state).toBe('revoked')
  })

  it('refuses resume when the execution gate is not needs-fix (no audit happened)', async () => {
    const h = await delegatedToExecuting()
    const signal = new AbortController().signal
    await h.engine.startExecutor(h.root, { prompt: 'go', signal })
    // No packet, no execution audit: gate is pending — resume must be refused.
    await expect(h.engine.resumeExecutor(h.root, { findings: 'x', nextPrompt: 'y', signal }))
      .rejects.toThrowError(/requires executionGate needs-fix/)
  })

  it('refuses a second resume before a new packet and audit round', async () => {
    const subagents = stubSubagents({
      verdicts: [
        { verdict: 'pass', note: 'plan ok' },
        { verdict: 'needs-fix', note: 'missing test' },
      ],
    })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    const signal = new AbortController().signal
    const started = await h.engine.startExecutor(h.root, { prompt: 'go', signal })
    const child = fakeAgent(started.executor?.childId as string, h.root.id)
    h.agents.add(child)
    await h.engine.submitExecutionPacket(child, { packet: 'work', residualRisks: [], executionRevision: 1 })
    await h.engine.audit(h.root, { role: 'execution', prompt: 'audit' }) // needs-fix
    await h.engine.resumeExecutor(h.root, { findings: 'f', nextPrompt: 'fix it', signal })
    // Execution revision advanced past the audited one: a second resume is stale.
    await expect(h.engine.resumeExecutor(h.root, { findings: 'f2', nextPrompt: 'again', signal }))
      .rejects.toThrowError(/needs-fix at the current execution revision/)
  })

  it('completes the FULL delegated loop: needs-fix -> same-child resume -> second packet -> pass -> closeout', async () => {
    const subagents = stubSubagents({
      verdicts: [
        { verdict: 'pass', note: 'plan ok' },
        { verdict: 'needs-fix', note: 'missing edge-case test' },
        { verdict: 'pass', note: 'fix verified' },
      ],
    })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'plan packet' })
    const signal = new AbortController().signal
    const started = await h.engine.startExecutor(h.root, { prompt: 'implement M1', signal })
    const childId = started.executor?.childId as string
    const child = fakeAgent(childId, h.root.id)
    h.agents.add(child)

    // Round 1: packet -> needs-fix.
    await h.engine.submitExecutionPacket(child, { packet: 'work v1', residualRisks: [], executionRevision: 1 })
    const firstAudit = await h.engine.audit(h.root, { role: 'execution', prompt: 'audit v1' })
    expect(firstAudit.verdict).toBe('needs-fix')
    expect(h.engine.peek(h.root.id)?.executionGate).toBe('needs-fix')

    // Resume the SAME child (positive path through the needs-fix gate).
    await h.engine.resumeExecutor(h.root, { findings: 'missing edge-case test', nextPrompt: 'add it', signal })
    const resumed = h.engine.peek(h.root.id)
    expect(resumed?.executor?.childId).toBe(childId)
    expect(resumed?.executor?.generation).toBe(1)
    expect(resumed?.executor?.executionRevision).toBe(2)

    // Round 2: second packet at the new execution revision -> pass -> closing.
    await h.engine.submitExecutionPacket(child, { packet: 'work v2 with edge-case test', residualRisks: [], executionRevision: 2 })
    const secondAudit = await h.engine.audit(h.root, { role: 'execution', prompt: 'audit v2' })
    expect(secondAudit.verdict).toBe('pass')
    const closing = h.engine.peek(h.root.id)
    expect(closing?.phase).toBe('closing')
    expect(closing?.executionGate).toBe('pass')
    expect(closing?.executor?.state).toBe('completed')

    const done = await h.engine.submitCloseout(h.root, GOOD_CLOSEOUT)
    expect(done.phase).toBe('completed')
    // The audit trail carries the full history: pass(plan), needs-fix, pass(execution).
    expect(done.audits.map(record => record.verdict)).toEqual(['pass', 'needs-fix', 'pass'])
  })

  it('keeps a completed executor when a later execution needs-replan fires from closing', async () => {
    const subagents = stubSubagents({
      verdicts: [
        { verdict: 'pass', note: 'plan ok' },
        { verdict: 'pass', note: 'execution ok' },
        { verdict: 'needs-replan', note: 'redo' },
      ],
    })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'plan packet' })
    const signal = new AbortController().signal
    const started = await h.engine.startExecutor(h.root, { prompt: 'implement M1', signal })
    const childId = started.executor?.childId as string
    const child = fakeAgent(childId, h.root.id)
    h.agents.add(child)
    await h.engine.submitExecutionPacket(child, { packet: 'work', residualRisks: [], executionRevision: 1 })
    await h.engine.audit(h.root, { role: 'execution', prompt: 'audit v1' })
    expect(h.engine.peek(h.root.id)?.phase).toBe('closing')
    expect(h.engine.peek(h.root.id)?.executor?.state).toBe('completed')
    const childIdAtPass = h.engine.peek(h.root.id)?.executor?.childId

    const outcome = await h.engine.audit(h.root, { role: 'execution', prompt: 'audit again' })
    expect(outcome.verdict).toBe('needs-replan')
    const after = h.engine.peek(h.root.id)
    expect(after?.phase).toBe('replanning')
    expect(after?.executor?.state).toBe('completed')
    expect(after?.executor?.childId).toBe(childIdAtPass)
  })

  it('a replan round cannot leak stale execution state into the next plan', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    await h.engine.submitPlan(h.root, 'plan v1')
    await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'ok' })
    await h.engine.submitExecutionEvidence(h.root, { report: 'old evidence', residualRisks: ['old risk'] })
    await h.engine.selfCheck(h.root, { role: 'execution', verdict: 'needs-replan', note: 'wrong approach' })
    expect(h.engine.peek(h.root.id)?.phase).toBe('replanning')

    await h.engine.submitPlan(h.root, 'plan v2')
    const snapshot = h.engine.peek(h.root.id)
    expect(snapshot?.executionGate).toBe('pending')
    expect(snapshot?.executionPacket).toBeUndefined()
    expect(snapshot?.residualRisks).toEqual([])
  })

  it('init stamps bearerBase to process.cwd()', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    expect(h.engine.peek(h.root.id)?.bearerBase).toBe(process.cwd())
  })

  it('init stamps bearerBase from the session workspace cwd', async () => {
    const h = makeHarness({ cwd: '/workspace' })
    await h.engine.init(h.root, makeTriage())
    expect(h.engine.peek(h.root.id)?.bearerBase).toBe('/workspace')
  })

  it('init does not stamp an empty session cwd', async () => {
    const h = makeHarness({ cwd: '  ' })
    await h.engine.init(h.root, makeTriage())
    expect(h.engine.peek(h.root.id)?.bearerBase).toBe(process.cwd())
  })

  it('init resolves a dot session cwd to process.cwd()', async () => {
    const h = makeHarness({ cwd: '.' })
    await h.engine.init(h.root, makeTriage())
    expect(h.engine.peek(h.root.id)?.bearerBase).toBe(process.cwd())
  })

  it('init stamps a session cwd with TRAILING whitespace verbatim', async () => {
    // Codex 3911097406: a POSIX directory may legitimately end in whitespace.
    // Trimming stamped `/workspace/project`, under which `report.txt` and
    // `/workspace/project /report.txt` were two artifacts instead of one.
    const h = makeHarness({ cwd: '/workspace/project ' })
    await h.engine.init(h.root, makeTriage())
    expect(h.engine.peek(h.root.id)?.bearerBase).toBe('/workspace/project ')
    // And the two spellings do fold together under that base.
    expect(canonicalBearer('report.txt', '/workspace/project '))
      .toBe(canonicalBearer('/workspace/project /report.txt', '/workspace/project '))
    expect(canonicalBearer('report.txt', '/workspace/project ')).toBe('/workspace/project /report.txt')
  })

  it('init still resolves a cwd with LEADING whitespace through canonicalBearer', async () => {
    // DETECTOR for the case above: whitespace is not blanket-preserved. A
    // leading space makes the header value non-absolute AS WRITTEN, so it goes
    // down the pre-existing resolve arm, which trims. Asserted against
    // `canonicalBearer` rather than a literal because that arm resolves a
    // rooted path against the CURRENT DRIVE on Windows and against `/` on
    // POSIX — both are what this arm already did.
    const h = makeHarness({ cwd: ' /workspace' })
    await h.engine.init(h.root, makeTriage())
    const stamped = h.engine.peek(h.root.id)?.bearerBase
    expect(stamped).toBe(canonicalBearer(' /workspace', process.cwd()))
    expect(stamped?.startsWith(' ')).toBe(false)
  })

  it('init joins a relative session cwd against process.cwd()', async () => {
    const h = makeHarness({ cwd: 'rel-dir' })
    await h.engine.init(h.root, makeTriage())
    const stamped = h.engine.peek(h.root.id)?.bearerBase
    expect(stamped).toBe(canonicalBearer('rel-dir', process.cwd()))
    expect(stamped).not.toBe('rel-dir')
  })

  it('does not advance executionRevision when the resume send fails, and retries', async () => {
    const subagents = stubSubagents({
      verdicts: [
        { verdict: 'pass', note: 'plan ok' },
        { verdict: 'needs-fix', note: 'missing test' },
      ],
      followupFails: 1,
    })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    const signal = new AbortController().signal
    const started = await h.engine.startExecutor(h.root, { prompt: 'go', signal })
    const child = fakeAgent(started.executor?.childId as string, h.root.id)
    h.agents.add(child)
    await h.engine.submitExecutionPacket(child, { packet: 'work', residualRisks: [], executionRevision: 1 })
    await h.engine.audit(h.root, { role: 'execution', prompt: 'audit' })
    await expect(h.engine.resumeExecutor(h.root, { findings: 'missing test', nextPrompt: 'add it', signal }))
      .rejects.toThrowError(/sendMessage failed/)
    expect(h.engine.peek(h.root.id)?.executor?.executionRevision).toBe(1)
    await h.engine.resumeExecutor(h.root, { findings: 'missing test', nextPrompt: 'add it', signal })
    expect(h.engine.peek(h.root.id)?.executor?.executionRevision).toBe(2)
  })

  it('needs-fix resumes the same child with an incremented execution revision', async () => {
    const subagents = stubSubagents({
      verdicts: [
        { verdict: 'pass', note: 'plan ok' },
        { verdict: 'needs-fix', note: 'missing test' },
      ],
    })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    const signal = new AbortController().signal
    const started = await h.engine.startExecutor(h.root, { prompt: 'go', signal })
    const childId = started.executor?.childId as string
    const child = fakeAgent(childId, h.root.id)
    h.agents.add(child)
    await h.engine.submitExecutionPacket(child, { packet: 'work', residualRisks: [], executionRevision: 1 })
    await h.engine.audit(h.root, { role: 'execution', prompt: 'audit' })
    expect(h.engine.peek(h.root.id)?.executionGate).toBe('needs-fix')
    expect(h.engine.peek(h.root.id)?.phase).toBe('executing')

    await h.engine.resumeExecutor(h.root, { findings: 'missing test', nextPrompt: 'add it', signal })
    const snapshot = h.engine.peek(h.root.id)
    expect(snapshot?.executor?.childId).toBe(childId)
    expect(snapshot?.executor?.generation).toBe(1)
    expect(snapshot?.executor?.executionRevision).toBe(2)
    expect(h.subagents.followups[0]?.childId).toBe(childId)
    expect(h.subagents.followups[0]?.text).toContain('executionRevision=2')
  })

  it('REFUSES a packet that CASes on a stale executionRevision after resume, and accepts the live one', async () => {
    const subagents = stubSubagents({
      verdicts: [
        { verdict: 'pass', note: 'plan ok' },
        { verdict: 'needs-fix', note: 'missing test' },
      ],
    })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    const signal = new AbortController().signal
    const started = await h.engine.startExecutor(h.root, { prompt: 'go', signal })
    const child = fakeAgent(started.executor?.childId as string, h.root.id)
    h.agents.add(child)
    await h.engine.submitExecutionPacket(child, { packet: 'work v1', residualRisks: [], executionRevision: 1 })
    await h.engine.audit(h.root, { role: 'execution', prompt: 'audit' })
    await h.engine.resumeExecutor(h.root, { findings: 'missing test', nextPrompt: 'add it', signal })
    expect(h.engine.peek(h.root.id)?.executor?.executionRevision).toBe(2)
    expect(h.engine.peek(h.root.id)?.executionPacket).toBeUndefined()

    const stale = await h.engine.submitExecutionPacket(child, { packet: 'stale v1', residualRisks: [], executionRevision: 1 })
      .then(() => undefined, error => error)
    expect(stale).toBeInstanceOf(AutopilotError)
    expect((stale as AutopilotError).code).toBe('AP_PACKET_REVISION_MISMATCH')
    expect(h.engine.peek(h.root.id)?.executionPacket).toBeUndefined()
    expect(h.engine.peek(h.root.id)?.phase).toBe('executing')

    const live = await h.engine.submitExecutionPacket(child, { packet: 'work v2', residualRisks: [], executionRevision: 2 })
    expect(live.executionPacket).toBe('work v2')
    expect(live.phase).toBe('execution-reviewing')
  })

  it('REFUSES a packet whose executionRevision is not an integer', async () => {
    const h = await delegatedToExecuting()
    const signal = new AbortController().signal
    const started = await h.engine.startExecutor(h.root, { prompt: 'go', signal })
    const child = fakeAgent(started.executor?.childId as string, h.root.id)
    h.agents.add(child)
    const error = await h.engine.submitExecutionPacket(child, {
      packet: 'work',
      residualRisks: [],
      executionRevision: Number.NaN,
    }).then(() => undefined, err => err)
    expect(error).toBeInstanceOf(AutopilotError)
    expect((error as AutopilotError).code).toBe('AP_PACKET_REVISION_REQUIRED')
    expect(h.engine.peek(h.root.id)?.executionPacket).toBeUndefined()
  })

  it('REFUSES a packet that omits executionRevision', async () => {
    const h = await delegatedToExecuting()
    const signal = new AbortController().signal
    const started = await h.engine.startExecutor(h.root, { prompt: 'go', signal })
    const child = fakeAgent(started.executor?.childId as string, h.root.id)
    h.agents.add(child)
    const error = await h.engine.submitExecutionPacket(child, {
      packet: 'work',
      residualRisks: [],
    } as never).then(() => undefined, err => err)
    expect(error).toBeInstanceOf(AutopilotError)
    expect((error as AutopilotError).code).toBe('AP_PACKET_REVISION_REQUIRED')
    expect(h.engine.peek(h.root.id)?.executionPacket).toBeUndefined()
  })
})

describe('rules role', () => {
  it('requires a rules pass for completion when the run touches the operating layer', async () => {
    const subagents = stubSubagents({
      verdicts: [
        { verdict: 'pass', note: 'plan ok' },
        { verdict: 'pass', note: 'execution ok' },
        { verdict: 'pass', note: 'rules ok' },
      ],
    })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage({
      size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'inline', touchesOperatingLayer: true,
    }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    await h.engine.submitExecutionEvidence(h.root, { report: 'r', residualRisks: [] })
    await h.engine.audit(h.root, { role: 'execution', prompt: 'e' })
    expect(h.engine.peek(h.root.id)?.phase).toBe('closing')

    // rules audit still missing: closeout refused.
    await expect(h.engine.submitCloseout(h.root, GOOD_CLOSEOUT)).rejects.toThrowError(/rules/)

    await h.engine.audit(h.root, { role: 'rules', prompt: 'rules packet' })
    const done = await h.engine.submitCloseout(h.root, GOOD_CLOSEOUT)
    expect(done.phase).toBe('completed')
  })
})

describe('enforcement bookkeeping', () => {
  it('standard runs clamp the session sandbox read-only at init and restore on plan pass', async () => {
    const subagents = stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent' }))
    expect(h.root.appended).toContainEqual({ type: 'sandbox/mode', data: { mode: 'read-only' } })
    expect(h.engine.peek(h.root.id)?.enforcement.sandbox).toBe('active')

    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    expect(h.root.appended).toContainEqual({ type: 'sandbox/mode', data: { mode: 'workspace-write' } })
  })

  it('restores the pre-run sandbox mode when one was set', async () => {
    const subagents = stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] })
    const h = makeHarness({ subagents })
    h.root.session.append('sandbox/mode', { mode: 'danger-full-access' })
    await h.engine.init(h.root, makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent' }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    const restores = h.root.appended.filter(entry => entry.type === 'sandbox/mode')
    expect(restores[restores.length - 1]).toEqual({ type: 'sandbox/mode', data: { mode: 'danger-full-access' } })
  })

  it('records degraded (never active) when no confine provider is observable, and still restores on plan pass', async () => {
    const subagents = stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] })
    const h = makeHarness({ subagents, sandboxAvailable: () => false })
    await h.engine.init(h.root, makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent' }))
    const enforcement = h.engine.peek(h.root.id)?.enforcement
    // Assert the exact three-valued state, not a boolean collapse.
    expect(enforcement?.sandbox).toBe('degraded')
    expect(enforcement?.modeAppended).toBe(true)
    expect(enforcement?.diagnostic).toMatch(/NOT OS-confined/)
    // The degraded clamp must still be released when the plan gate passes.
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    expect(h.root.appended).toContainEqual({ type: 'sandbox/mode', data: { mode: 'workspace-write' } })
  })

  it('a throwing probe reads as unavailable (degraded), never active', async () => {
    const h = makeHarness({ sandboxAvailable: () => { throw new Error('probe exploded') } })
    await h.engine.init(h.root, makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent' }))
    expect(h.engine.peek(h.root.id)?.enforcement.sandbox).toBe('degraded')
  })

  it('owner approvals are consumed exactly once, and only by the command they name', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    // The target used to be prose ('push the release branch') and was consumed
    // anyway; it now has to be the command class it authorizes.
    await h.engine.ownerApprove(h.root, 'git push origin main')
    expect(await h.engine.consumeApproval(h.root.id, 'cd repo && git push origin main')).toBe(0)
    expect(await h.engine.consumeApproval(h.root.id, 'git push origin main')).toBeUndefined()
  })

  it('an approval is NOT a fungible token: a non-matching target is left unconsumed', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    // Measured before the fix: `consumeApproval` took the first UNCONSUMED
    // approval regardless of its text, so this exact approval authorized
    // `git push origin main` and — because the pre-execute seam consumes
    // BEFORE it asks — the human saw no prompt at all.
    await h.engine.ownerApprove(h.root, 'ONLY the README typo fix, npm publish of nothing')
    expect(await h.engine.consumeApproval(h.root.id, 'git push origin main')).toBeUndefined()
    // It is still OPEN, so the owner can still be asked, and a matching
    // approval still works on the very same run.
    expect(h.engine.peek(h.root.id)?.enforcement.ownerApprovals[0]?.consumedBy).toBeUndefined()
    await h.engine.ownerApprove(h.root, 'git push origin')
    expect(await h.engine.consumeApproval(h.root.id, 'git push origin main')).toBe(1)
  })

  it('approvalAuthorizes: the rule, stated where a test can resolve each half', async () => {
    // Half 1 — the target must itself be an egress command. Prose grants nothing.
    expect(approvalAuthorizes('please push it for me', 'git push origin main')).toBe(false)
    expect(approvalAuthorizes('', 'git push origin main')).toBe(false)
    // Half 1, ISOLATED. Both fixtures above are over-determined: they fail half 2
    // as well, so deleting half 1 left the suite green and this test's own name
    // false. `'origin main'` passes half 2 (it occurs at a token boundary) and
    // fails only half 1, so it is the fixture that resolves the line.
    expect(approvalAuthorizes('origin main', 'git push origin main')).toBe(false)
    // Half 2 — token-boundary containment, the same rule the manifest uses.
    expect(approvalAuthorizes('git push', 'git push origin main')).toBe(true)
    expect(approvalAuthorizes('git push', 'cd repo && git push origin main')).toBe(true)
    expect(approvalAuthorizes('npm publish', 'git push origin main')).toBe(false)
    expect(approvalAuthorizes('git push', 'legit push origin main')).toBe(false)
  })

  it('CHAINED EGRESS: a push-only approval does not authorize a command that also publishes', async () => {
    // The approval half of the 2026-08-25 escape. `matchesAtTokenBoundary`
    // answers "does the approved class appear in this command"; the question an
    // authorization has to answer is "is every egress element of this command
    // approved".
    expect(approvalAuthorizes('git push', 'git push origin main && npm publish')).toBe(false)
    expect(approvalAuthorizes('git push', 'git push origin main && gh release create v1 --notes x')).toBe(false)
    // Positive control: the unchained command is still authorized, so this is a
    // decision about the second segment and not a blanket refusal.
    expect(approvalAuthorizes('git push', 'git push origin main')).toBe(true)
    // and a NON-egress second segment is not a second egress
    expect(approvalAuthorizes('git push', 'git push origin main && echo done')).toBe(true)
  })

  it('CHAINED EGRESS: the run refuses to consume a push approval for a push+publish command', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    await h.engine.ownerApprove(h.root, 'git push')
    expect(await h.engine.consumeApproval(h.root.id, 'git push origin main && npm publish')).toBeUndefined()
    // The approval is left OPEN, so the owner can still be asked about the real
    // command instead of having it authorized behind them.
    expect(h.engine.peek(h.root.id)?.enforcement.ownerApprovals[0]?.consumedBy).toBeUndefined()
    expect(await h.engine.consumeApproval(h.root.id, 'git push origin main')).toBe(0)
  })

  it('an approval for one egress class does not authorize a DIFFERENT class', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    await h.engine.ownerApprove(h.root, 'npm publish')
    expect(await h.engine.consumeApproval(h.root.id, 'git push origin main')).toBeUndefined()
    expect(await h.engine.consumeApproval(h.root.id, 'npm publish --access public')).toBe(0)
  })

  it('reminder budget self-releases after three rounds', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'ok' })
    expect(h.engine.peek(h.root.id)?.phase).toBe('executing')
    expect(await h.engine.bumpReminder(h.root.id)).toBe(1)
    expect(await h.engine.bumpReminder(h.root.id)).toBe(2)
    expect(await h.engine.bumpReminder(h.root.id)).toBe(3)
    expect(await h.engine.bumpReminder(h.root.id)).toBeUndefined()
  })
})

describe('persistence', () => {
  it('a second engine over the same store resumes the run state', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'ok' })

    const { AutopilotEngine } = await import('../src/engine.js')
    const { RunStore } = await import('../src/store/file.js')
    const { resolveConfig } = await import('../src/index.js')
    const second = new AutopilotEngine(h.agents as never, h.subagents, new RunStore(h.storeDir), resolveConfig())
    const snapshot = second.peek(h.root.id)
    expect(snapshot?.phase).toBe('executing')
    expect(snapshot?.planGate).toBe('pass')
    expect(snapshot?.plan.revision).toBe(1)
  })

  it('errors are typed AutopilotError with stable codes', async () => {
    const h = makeHarness()
    try {
      await h.engine.submitPlan(h.root, 'plan')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(AutopilotError)
      expect((error as AutopilotError).code).toBe('AP_NOT_INITIALIZED')
    }
  })
})

describe('startExecutor re-asks the usage question', () => {
  /** A delegated run parked in `executing` with a properly declared entry. */
  async function delegatedDeclared() {
    const subagents = stubSubagents({ verdicts: [{ verdict: 'pass', note: 'plan ok' }] })
    const h = makeHarness({ subagents })
    await h.engine.init(
      h.root,
      makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' }),
      [undeclaredSeed('m1')],
    )
    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    return h
  }

  it('refuses an executor while an entry is reverted to undeclared', async () => {
    const h = await delegatedDeclared()
    const signal = new AbortController().signal
    // Re-open the question BEFORE the executor is ever started, so the refusal
    // cannot be attributed to AP_EXECUTOR_EXISTS. `declare-usage` is legal in
    // `executing`, the tool's class enum includes 'undeclared', and last-wins
    // makes this a legal event — which is exactly why `planGate === 'pass'`
    // cannot stand in for the usage answer beyond the flip instant.
    await h.engine.declareUsage(h.root, undeclaredSeed('m1'))
    expect(h.engine.peek(h.root.id)?.planGate).toBe('pass')
    expect(h.engine.peek(h.root.id)?.usage?.entries[0]?.usageClass).toBe('undeclared')

    try {
      await h.engine.startExecutor(h.root, { prompt: 'go', signal })
      expect.unreachable('an executor must not be authorized while usage is unanswered')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AutopilotError)
      expect((error as AutopilotError).code).toBe('AP_USAGE_UNDECLARED')
      expect((error as AutopilotError).message).toContain('m1')
    }
    // Nothing was written: no executor record at all, not even 'starting'.
    expect(h.engine.peek(h.root.id)?.executor).toBeUndefined()
  })

  it('positive control: the same run starts an executor once the entry is declared again', async () => {
    const h = await delegatedDeclared()
    const signal = new AbortController().signal
    await h.engine.declareUsage(h.root, undeclaredSeed('m1'))
    await expect(h.engine.startExecutor(h.root, { prompt: 'go', signal }))
      .rejects.toThrowError(/usage question is unanswered/)
    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    const started = await h.engine.startExecutor(h.root, { prompt: 'go', signal })
    expect(started.executor?.state).toBe('running')
  })
})

/**
 * `startExecutor` has FIVE preconditions and, until 2026-08-25, exactly one of
 * them had a bearer (the usage question, added the round before). Dropping any
 * of the other four left 394 tests green.
 *
 * `AP_EXECUTOR_EXISTS` is the sharpest of the four: without it a second
 * `startExecutor` on a run whose first child is still 'running' overwrites
 * `prior.executor` in place, orphaning a child that still holds the packet tool
 * and the egress guards bound to the same run.
 *
 * Each case below asserts the AutopilotError CODE (not a message shape) and
 * what the executor record looks like afterwards, because "the call threw" and
 * "nothing was authorized" are two different claims.
 */
describe('startExecutor: the four preconditions that had no bearer', () => {
  const signal = new AbortController().signal

  /** A DELEGATED standard run parked in `executing` with the usage question answered. */
  async function delegatedReady(extraVerdicts: Array<{ verdict: string; note: string }> = []) {
    const subagents = stubSubagents({ verdicts: [{ verdict: 'pass', note: 'plan ok' }, ...extraVerdicts] })
    const h = makeHarness({ subagents })
    await h.engine.init(
      h.root,
      makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' }),
      [undeclaredSeed('m1')],
    )
    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    return h
  }

  async function refusal(promise: Promise<unknown>): Promise<AutopilotError> {
    try {
      await promise
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AutopilotError)
      return error as AutopilotError
    }
    throw new Error('startExecutor resolved where it had to refuse')
  }

  it('AP_WRONG_EXECUTION_MODE: an INLINE run gets no executor child', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'ok' })
    // The fixture is in the phase and gate state a delegated run would start
    // from, so the refusal is about the MODE and nothing else.
    expect(h.engine.peek(h.root.id)?.phase).toBe('executing')
    expect(h.engine.peek(h.root.id)?.planGate).toBe('pass')
    const error = await refusal(h.engine.startExecutor(h.root, { prompt: 'go', signal }))
    expect(error.code).toBe('AP_WRONG_EXECUTION_MODE')
    expect(h.engine.peek(h.root.id)?.executor).toBeUndefined()
    expect(h.subagents.started).toEqual([])
  })

  it('AP_PLAN_GATE_NOT_PASS: an unapproved plan authorizes no implementer', async () => {
    const subagents = stubSubagents()
    const h = makeHarness({ subagents })
    await h.engine.init(
      h.root,
      makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' }),
      [undeclaredSeed('m1')],
    )
    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    await h.engine.submitPlan(h.root, 'plan')
    expect(h.engine.peek(h.root.id)?.planGate).toBe('pending')
    const error = await refusal(h.engine.startExecutor(h.root, { prompt: 'go', signal }))
    expect(error.code).toBe('AP_PLAN_GATE_NOT_PASS')
    expect(h.engine.peek(h.root.id)?.executor).toBeUndefined()
    expect(h.subagents.started).toEqual([])
  })

  it('AP_WRONG_PHASE: a run that left the execution phase cannot dispatch a fresh child', async () => {
    const h = await delegatedReady()
    await h.engine.setBlocked(h.root, 'owner stopped the run')
    expect(h.engine.peek(h.root.id)?.phase).toBe('blocked')
    expect(h.engine.peek(h.root.id)?.planGate).toBe('pass')
    const error = await refusal(h.engine.startExecutor(h.root, { prompt: 'go', signal }))
    expect(error.code).toBe('AP_WRONG_PHASE')
    expect(h.engine.peek(h.root.id)?.executor).toBeUndefined()
    expect(h.subagents.started).toEqual([])
  })

  it('AP_EXECUTOR_EXISTS: a live child is not silently replaced by a second one', async () => {
    const h = await delegatedReady()
    const first = await h.engine.startExecutor(h.root, { prompt: 'go', signal })
    const firstChild = first.executor?.childId
    expect(first.executor?.state).toBe('running')
    expect(h.subagents.started).toHaveLength(1)

    const error = await refusal(h.engine.startExecutor(h.root, { prompt: 'go again', signal }))
    expect(error.code).toBe('AP_EXECUTOR_EXISTS')
    // THE DAMAGE THE CHECK PREVENTS: `prior.executor` is overwritten in place,
    // so without it the first child — which still holds the packet tool and the
    // egress guards bound to this run — is orphaned rather than revoked.
    const after = h.engine.peek(h.root.id)?.executor
    expect(after?.childId).toBe(firstChild)
    expect(after?.generation).toBe(1)
    expect(after?.state).toBe('running')
    expect(h.subagents.started).toHaveLength(1)
  })

  it('positive control: a COMPLETED executor does not block the next generation', async () => {
    // The same clause read from its other side, so the refusal above is a
    // decision about the child's STATE and not about `executor !== undefined`.
    const h = await delegatedReady([{ verdict: 'pass', note: 'execution ok' }])
    const first = await h.engine.startExecutor(h.root, { prompt: 'go', signal })
    const childAgent = fakeAgent(first.executor?.childId as string, h.root.id)
    h.agents.add(childAgent)
    await h.engine.submitExecutionPacket(childAgent, { packet: 'done', residualRisks: [], executionRevision: 1 })
    await h.engine.audit(h.root, { role: 'execution', prompt: 'p' })
    expect(h.engine.peek(h.root.id)?.executor?.state).toBe('completed')
  })
})

/**
 * The executor route record: `routeStatus: 'verified'` is a claim an auditor
 * reads about WHICH MODEL ran the execution, and its condition had no bearer —
 * flipping the `&&` to `||` left the suite green, which is exactly the
 * configuration where only a provider is set and the record reads
 * `{ routeProvider: 'p', routeModel: undefined, routeStatus: 'verified' }`:
 * a confidence the code cannot observe being false.
 *
 * The configured-route record is the one written with the child in state
 * 'starting'. It is transient in the projection and PERMANENT in the canonical
 * event stream — which is what an auditor reads — so that is where it is
 * asserted from.
 */
describe('the configured executor route says only what was configured', () => {
  const signal = new AbortController().signal

  async function startingRoute(agentOptions?: { provider?: string; model?: string }) {
    const subagents = stubSubagents({ verdicts: [{ verdict: 'pass', note: 'plan ok' }] })
    const h = makeHarness({
      subagents,
      ...(agentOptions === undefined ? {} : { config: { executor: { agentOptions } } }),
    })
    await h.engine.init(
      h.root,
      makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' }),
      [undeclaredSeed('m1')],
    )
    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    await h.engine.startExecutor(h.root, { prompt: 'go', signal })

    const lines = readFileSync(join(h.storeDir, 'runs', h.root.id, 'events.jsonl'), 'utf8')
      .trim().split(String.fromCharCode(10))
      .map(line => JSON.parse(line) as {
        op: string
        detail?: { stage?: string }
        snapshot: { executor?: { route: Record<string, unknown> } }
      })
    const starting = lines.find(event => event.op === 'start-executor' && event.detail?.stage === 'starting')
    if (starting === undefined) throw new Error('no starting start-executor event was recorded')
    return starting.snapshot.executor?.route
  }

  it('provider AND model configured: unverifiable at starting (creation-only is never verified — plan v3 M4 / R1-P1); the running record carries the observed leg', async () => {
    const route = await startingRoute({ provider: 'anthropic', model: 'claude-x' })
    // RE-SPECIFIED (plan v3 M4 / [R1-P1]): the starting record is written
    // BEFORE the child exists, so only the creation leg is present; a
    // creation-only record used to read `verified` — the confidence the code
    // could not observe. Under the new semantics it is honestly
    // `unverifiable`, naming that the observed route was not readable yet.
    expect(route?.routeStatus).toBe('unverifiable')
    expect(route?.routeProvider).toBe('anthropic')
    expect(route?.routeModel).toBe('claude-x')
    expect(route?.routeDiagnostic).toContain('observed route not readable')
  })

  it('provider ONLY: unverified, and neither half is presented as observed', async () => {
    const route = await startingRoute({ provider: 'anthropic' })
    expect(route?.routeStatus).toBe('unverified')
    // P2-1 (execution-audit r1): the ROUTELESS legacy object now rides the
    // inherit dispatch in auto mode exactly as mode off always dispatched it,
    // so the configured half is the honest creation leg. The protective claims
    // are unchanged: no selection leg, `unverified` status, the missing half
    // still named — a half-route is still never presented as verified/observed.
    expect(route?.routeProvider).toBe('anthropic')
    expect(route?.routeModel).toBe('unverified')
    // RE-SPECIFIED (plan v3 M4): the half-route diagnostic joins the shared
    // captureRoute vocabulary instead of the executor-only inherit text; a
    // partial creation route still inherits the missing half by default.
    expect(route?.routeDiagnostic).toContain('not available from durable Agent options')
  })

  it('model ONLY: unverified, the mirror of the case above', async () => {
    const route = await startingRoute({ model: 'claude-x' })
    expect(route?.routeStatus).toBe('unverified')
    // P2-1: the carried routeless object's model half is the creation leg.
    expect(route?.routeProvider).toBe('unverified')
    expect(route?.routeModel).toBe('claude-x')
  })

  it('NOTHING configured: unverified with the inherit diagnostic', async () => {
    const route = await startingRoute()
    expect(route?.routeStatus).toBe('unverified')
    expect(route?.routeDiagnostic).toContain('inherits the deployment default')
  })
})

/**
 * `captureRoute` — the helper that writes the route an auditor actually reads,
 * both for the running executor child and for every dispatched auditor — carries
 * the identical AND shape and had the identical hole: only its verified branch
 * had a fixture, so a durable Agent exposing HALF a route would have been
 * recorded as verified.
 */
describe('captureRoute records only what the durable Agent exposes', () => {
  const signal = new AbortController().signal

  /** Start a delegated executor whose child Agent exposes exactly these options. */
  async function runningRoute(options: { provider?: string; model?: string } | undefined) {
    const subagents = stubSubagents({ verdicts: [{ verdict: 'pass', note: 'plan ok' }] })
    const h = makeHarness({ subagents })
    // The child Agent is registered the moment the transport starts it, which is
    // the same moment the real host would have it resolvable by id.
    const withOptions = (childId: string) => {
      const child = fakeAgent(childId, h.root.id)
      h.agents.add({
        ...child,
        ...(options === undefined ? { options: undefined } : { options }),
      } as never)
    }
    ;(subagents as unknown as { startContinuable: (spec: { childId: string }) => Promise<unknown> })
      .startContinuable = async (spec) => { withOptions(spec.childId); return {} }

    await h.engine.init(
      h.root,
      makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' }),
      [undeclaredSeed('m1')],
    )
    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    const started = await h.engine.startExecutor(h.root, { prompt: 'go', signal })
    expect(started.executor?.state).toBe('running')
    return started.executor?.route
  }

  it('both halves observable on the child Agent but NO request/header: unverifiable (plan v3 M4 / R1-P1 — creation-only is never verified)', async () => {
    const route = await runningRoute({ provider: 'deepseek-official', model: 'deepseek-chat' })
    // RE-SPECIFIED (plan v3 M4 / [R1-P1]): this fake child exposes creation
    // options but its session logs NO `request/header`, so the observed leg is
    // unreadable. The old assertion (`verified`) was the creation-only defect
    // this milestone fixes; the honest record is `unverifiable`, naming the
    // failed read. The agreement case — creation AND a matching header — is
    // asserted in test/engine-route.test.ts (i).
    expect(route?.routeStatus).toBe('unverifiable')
    expect(route?.routeProvider).toBe('deepseek-official')
    expect(route?.routeModel).toBe('deepseek-chat')
    expect(route?.routeDiagnostic).toContain('no well-formed request/header event')
  })

  it('provider only: unverified, and the missing half says so', async () => {
    const route = await runningRoute({ provider: 'deepseek-official' })
    expect(route?.routeStatus).toBe('unverified')
    expect(route?.routeProvider).toBe('deepseek-official')
    expect(route?.routeModel).toBe('unverified')
    expect(route?.routeDiagnostic).toContain('not available from durable Agent options')
  })

  it('model only: unverified, the mirror', async () => {
    const route = await runningRoute({ model: 'deepseek-chat' })
    expect(route?.routeStatus).toBe('unverified')
    expect(route?.routeProvider).toBe('unverified')
    expect(route?.routeModel).toBe('deepseek-chat')
  })

  it('no options at all: unverified on both halves', async () => {
    const route = await runningRoute(undefined)
    expect(route?.routeStatus).toBe('unverified')
    expect(route?.routeProvider).toBe('unverified')
    expect(route?.routeModel).toBe('unverified')
  })
})

/**
 * ── THE TOOL-FILTER BOUNDARY, CROSSED FOR REAL ────────────────────────────
 *
 * WHY THIS BLOCK EXISTS AT ALL. Two high-severity defects survived seven audit
 * rounds, 556 green tests and >100 killed mutations, and both were found only
 * by running the harness against a real dsh host. The probes named the reason
 * themselves: the suite never ran a tool through dsh's real `ToolRuntime` and
 * never exercised `toolFilter` at all — `test/helpers.ts`'s `stubSubagents`
 * accepts `spec.request.toolFilter` and drops it on the floor. So every
 * allow-list this plugin sent was validated by nothing, and a list that kills
 * the whole dispatch on a real host looked identical to a correct one.
 *
 * A fixture that re-implements what I THINK `restrict()` does would reproduce
 * that exact failure. So the fixtures below drive the REAL
 * `@deepseek-ai/dsh-tools` `ToolRuntime` — the same package `package.json`
 * ships as a runtime dependency — and the REAL `@deepseek-ai/dsh-scope`
 * `createScope`, resolved through dsh-tools' own module resolution because that
 * is how dsh-tools itself reaches it. Every restrict rejection asserted here is
 * produced by upstream code, not by this file.
 *
 * `@deepseek-ai/dsh-scope` is a transitive dependency of dsh-tools rather than
 * a direct one, so it cannot be imported by bare specifier under pnpm's
 * isolated layout. Resolving it FROM dsh-tools is not a workaround for a
 * missing dependency — it is the only way to obtain the exact module instance
 * whose private `kScope` symbol the `ToolRuntime` under test compares against.
 * A second copy would produce contexts `restrict()` reads as unscoped.
 */

const requireFromTools = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools'))
const dshScope = await import(pathToFileURL(requireFromTools.resolve('@deepseek-ai/dsh-scope')).href) as {
  createScope: (ctx: unknown, key: symbol) => { ctx: RealCtx; dispose: () => unknown }
  scopeOf: (ctx: unknown) => unknown
}

/** The slice of a live dsh context these fixtures touch. */
interface RealCtx {
  provide(name: string, value: unknown, builtin?: boolean): void
  tools: {
    register(definition: unknown): () => void
    restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void
    schemas(scope?: unknown): Array<{ name: string }>
  }
}

/**
 * The global tool names the shipped headless dsh profile actually registers.
 *
 * Transcribed from the live rejection this fix exists for — `known global
 * tools: create_goal, edit, exit_plan_mode, get_goal, glob, grep,
 * interrupt_agent, job_kill, job_list, job_output, list_agents, pwsh, ralph,
 * read, read_image, send_message, skill, str_replace_editor…` — so the fixture
 * asserts against a deployment that was observed, not one that was imagined.
 *
 * The live list was elided after `str_replace_editor`, but the same rejection
 * names EXACTLY `"bash"` and `"autopilot_submit_packet"` as the unknown ones —
 * which proves the other requested names, `write` and `todo_write`, were in the
 * elided tail. They are restored here rather than guessed away: dropping them
 * would make the fixture harsher than the deployment and would let a narrowing
 * assertion pass for the wrong reason.
 *
 * What is genuinely ABSENT and was requested anyway: `ask_user_question` and
 * `bash`.
 */
const HEADLESS_PROFILE_TOOLS: readonly string[] = [
  'create_goal', 'edit', 'exit_plan_mode', 'get_goal', 'glob', 'grep',
  'interrupt_agent', 'job_kill', 'job_list', 'job_output', 'list_agents',
  'pwsh', 'ralph', 'read', 'read_image', 'send_message', 'skill',
  'str_replace_editor', 'todo_write', 'write',
]

function toolDefinition(name: string): unknown {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: {} }, render: () => [] },
    execute: () => Promise.resolve({}),
  }
}

/**
 * A real `ToolRuntime` over a real cordis context, with `registered` mounted as
 * GLOBAL tools and child agent scopes available on top.
 *
 * `systemPrompt` is stubbed because `ToolRuntime` injects it and nothing at this
 * boundary depends on prompt assembly. Everything the assertions actually rest
 * on — name validation, the restrictable set, the own-layer exemption — is
 * upstream's own code.
 */
function realHost(registered: readonly string[]) {
  const ctx = new CordisContext() as unknown as RealCtx
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} }, true)
  new ToolRuntime(ctx as never, {})
  for (const name of registered) ctx.tools.register(toolDefinition(name))
  return {
    ctx,
    /**
     * Compose one child the way dsh does: a fresh scope, then the filter.
     * `childOwnTools` are registered into the CHILD'S OWN LAYER first, which is
     * the strongest form of the question — if a name is still rejected after
     * being registered, no reordering of the host's setup could ever admit it.
     */
    child(childOwnTools: readonly string[] = []) {
      const scope = dshScope.createScope(ctx, Symbol('child-agent'))
      for (const name of childOwnTools) scope.ctx.tools.register(toolDefinition(name))
      return {
        restrict: (allow: readonly string[]) => scope.ctx.tools.restrict({ allow }),
        visible: () => ctx.tools.schemas(dshScope.scopeOf(scope.ctx)).map(schema => schema.name).sort(),
      }
    },
  }
}

describe('tool allow-lists against the real dsh ToolRuntime', () => {
  it('AUDITOR_TOOL_ALLOW is accepted verbatim by the real restrict() on the headless profile', () => {
    const child = realHost(HEADLESS_PROFILE_TOOLS).child()
    // The whole of defect (a) in one line: this threw
    // `names unknown global tool "ask_user_question"` on every audit dispatch,
    // and with 'independent' the only audit mode a standard or delegated run
    // may hold, no such run could reach a passing plan gate — or 'completed'.
    expect(() => child.restrict([...AUDITOR_TOOL_ALLOW])).not.toThrow()
  })

  it('reproduces the live defect (a) rejection when ask_user_question is named', () => {
    const child = realHost(HEADLESS_PROFILE_TOOLS).child()
    expect(() => child.restrict([...AUDITOR_TOOL_ALLOW, 'ask_user_question']))
      .toThrowError(/names unknown global tool "ask_user_question"/)
  })

  it('a child-scope tool is NEVER restrictable, even when registered before restrict() runs', () => {
    // The ordering fact (setup contributions run after applyChildComposition) is
    // TRUE but is not the whole reason, and this is the stronger one: `view()`
    // builds `restrictableNames` from the INHERITED surface only and explicitly
    // skips the scope's own layer. So even a host that registered the packet
    // tool FIRST would still reject the name. No seam admits it; the allow-list
    // must simply not carry it.
    const child = realHost(HEADLESS_PROFILE_TOOLS).child(['autopilot_submit_packet'])
    expect(() => child.restrict(['read', 'autopilot_submit_packet']))
      .toThrowError(/names unknown global tool "autopilot_submit_packet"/)
  })

  it('and is still visible to the child after a legal restrict that never names it', () => {
    // WHAT GUARANTEES THE EXECUTOR CAN STILL SUBMIT ITS PACKET. Upstream applies
    // the filter to the inherited surface and then re-adds the scope's OWN
    // registrations to `visible`, documented there as the exemption that keeps
    // "a filter naming the capabilities the child may use" from stripping "the
    // machinery it answers through". Removing the name from the allow-list
    // therefore costs the child nothing.
    const child = realHost(HEADLESS_PROFILE_TOOLS).child(['autopilot_submit_packet'])
    child.restrict(['read', 'pwsh'])
    expect(child.visible()).toEqual(['autopilot_submit_packet', 'pwsh', 'read'])
  })

  it('parseRestrictRejection recovers the deployment registry from the REAL rejection text', () => {
    const child = realHost(HEADLESS_PROFILE_TOOLS).child(['autopilot_submit_packet'])
    let message = ''
    try {
      child.restrict([...DEFAULT_EXECUTOR_TOOLS, 'autopilot_submit_packet'])
    } catch (error: unknown) {
      message = (error as Error).message
    }
    // The live defect (b) message, verbatim, from upstream code.
    expect(message).toContain('names unknown global tools "bash", "autopilot_submit_packet"')
    const parsed = parseRestrictRejection(message)
    // The repair path is worth nothing if this regex does not match what dsh
    // actually emits — which is precisely the class of blind spot that let both
    // defects ship. Asserting it against a hand-written string would prove
    // nothing about the host.
    expect(parsed?.unknown).toEqual(['bash', 'autopilot_submit_packet'])
    expect(parsed?.known).toEqual([...HEADLESS_PROFILE_TOOLS].sort())
  })

  it('AUDITOR_TOOL_REQUIRED is a subset of what the auditor asks for', () => {
    // A required name absent from the request could never survive narrowing,
    // so the pair would refuse every dispatch on every host.
    for (const name of AUDITOR_TOOL_REQUIRED) expect(AUDITOR_TOOL_ALLOW).toContain(name)
  })
})

/**
 * A subagent transport that VALIDATES the filter the engine sends, by handing it
 * to the real `ToolRuntime.restrict` over a fixture registry.
 *
 * This is the bearer the suite was missing. `stubSubagents` accepts
 * `spec.request.toolFilter` and ignores it, so this file could assert every
 * gate, phase and verdict in the state machine while the harness was, on a real
 * host, incapable of dispatching either child. Here an unregistered name fails
 * the dispatch with upstream's own error, exactly as production did.
 *
 * (Built here rather than in `test/helpers.ts` deliberately: helpers.ts is
 * shared with seventeen other test files being edited concurrently, and this
 * fix owns `src/engine.ts` and `test/engine.test.ts` only. The right long-term
 * home is helpers.ts.)
 */
function filterCheckingSubagents(
  registry: readonly string[],
  script: Parameters<typeof stubSubagents>[0] = {},
): ReturnType<typeof stubSubagents> & { filters: string[][] } {
  const inner = stubSubagents(script)
  const host = realHost(registry)
  const filters: string[][] = []
  const check = (allow: readonly string[] | undefined, childOwn: readonly string[]): void => {
    if (allow === undefined) throw new Error('dispatch sent no toolFilter at all')
    filters.push([...allow])
    host.child(childOwn).restrict(allow)
  }
  return {
    ...inner,
    filters,
    async start(provider, request) {
      check(request.toolFilter.allow, [])
      return inner.start(provider, request)
    },
    async startContinuable(spec) {
      // The executor child owns the packet tool, so the fixture registers it
      // into the child's layer before restricting — the same shape the real
      // `registerContinuableSetup` contribution produces.
      check(spec.request.toolFilter?.allow, ['autopilot_submit_packet'])
      return inner.startContinuable(spec)
    },
  }
}

const toolSignal = new AbortController().signal

async function delegatedToPlanGate(
  subagents: ReturnType<typeof stubSubagents>,
  registeredToolNames?: () => readonly string[],
) {
  const h = makeHarness({
    subagents,
    ...(registeredToolNames === undefined ? {} : { environment: { registeredToolNames } }),
  })
  await h.engine.init(
    h.root,
    makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' }),
    [undeclaredSeed('m1')],
  )
  await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
  await h.engine.submitPlan(h.root, 'plan')
  await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
  return h
}

describe('the engine dispatches filters a real deployment can honour', () => {
  it('starts a delegated executor on the headless profile (live defect (b), end to end)', async () => {
    const subagents = filterCheckingSubagents(HEADLESS_PROFILE_TOOLS, {
      verdicts: [{ verdict: 'pass', note: 'plan ok' }],
    })
    const h = await delegatedToPlanGate(subagents)
    const started = await h.engine.startExecutor(h.root, { prompt: 'go', signal: toolSignal })
    expect(started.executor?.state).toBe('running')
    // Never named: it is not restrictable at any instant, on any host.
    expect(subagents.filters.at(-1)).not.toContain('autopilot_submit_packet')
    // Narrowed, and SAID SO rather than silently.
    expect(subagents.filters.at(-1)).not.toContain('bash')
    expect(subagents.filters.at(-1)).toContain('pwsh')
    expect(started.executor?.route.routeDiagnostic).toContain('tool surface narrowed for executor child')
    expect(started.executor?.route.routeDiagnostic).toContain('does not register "bash"')
    expect(started.executor?.route.routeDiagnostic).toContain('kept 9 of 10')
  })

  it('learns the registry from the host rejection when no probe is wired, and retries once', async () => {
    const subagents = filterCheckingSubagents(HEADLESS_PROFILE_TOOLS, {
      verdicts: [{ verdict: 'pass', note: 'plan ok' }],
    })
    // No `registeredToolNames`: the shipped deployment's exact situation. The
    // first executor dispatch is rejected by upstream, the engine parses the
    // registry out of that rejection, re-resolves, and the second succeeds.
    const h = await delegatedToPlanGate(subagents)
    const before = subagents.filters.length
    await h.engine.startExecutor(h.root, { prompt: 'go', signal: toolSignal })
    expect(subagents.filters.length - before).toBe(2)
    expect(subagents.filters.at(-2)).toContain('bash')
    expect(subagents.filters.at(-1)).not.toContain('bash')
  })

  it('with the probe wired, the same run costs no failed dispatch', async () => {
    const subagents = filterCheckingSubagents(HEADLESS_PROFILE_TOOLS, {
      verdicts: [{ verdict: 'pass', note: 'plan ok' }],
    })
    const h = await delegatedToPlanGate(subagents, () => HEADLESS_PROFILE_TOOLS)
    const before = subagents.filters.length
    await h.engine.startExecutor(h.root, { prompt: 'go', signal: toolSignal })
    expect(subagents.filters.length - before).toBe(1)
  })

  it('refuses rather than narrowing an executor onto a deployment with no shell at all', async () => {
    const noShell = HEADLESS_PROFILE_TOOLS.filter(name => name !== 'pwsh')
    const subagents = filterCheckingSubagents(noShell, { verdicts: [{ verdict: 'pass', note: 'plan ok' }] })
    const h = await delegatedToPlanGate(subagents)
    await expect(h.engine.startExecutor(h.root, { prompt: 'go', signal: toolSignal }))
      .rejects.toThrowError(/registers none of the shell tools/)
    // AND the refusal is durable on the executor record, not only thrown: a
    // revoked executor is what a later reader inspects to ask why delegation
    // never started.
    const executor = h.engine.peek(h.root.id)?.executor
    expect(executor?.state).toBe('revoked')
    expect(executor?.route.routeDiagnostic).toContain('registers none of the shell tools')
  })

  it('refuses rather than narrowing an auditor that would lose read', async () => {
    const noRead = HEADLESS_PROFILE_TOOLS.filter(name => name !== 'read')
    const subagents = filterCheckingSubagents(noRead, { verdicts: [{ verdict: 'pass', note: 'plan ok' }] })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent' }), [undeclaredSeed('m1')])
    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    await h.engine.submitPlan(h.root, 'plan')
    // The one narrowing that must never happen quietly: a blind auditor still
    // returns a schema-valid `pass` and the gate would accept it.
    await expect(h.engine.audit(h.root, { role: 'plan', prompt: 'p' }))
      .rejects.toThrowError(/plan auditor cannot be dispatched: this deployment does not register "read"/)
  })

  it('records the auditor narrowing on the audit route when a droppable name is missing', async () => {
    const noImage = HEADLESS_PROFILE_TOOLS.filter(name => name !== 'read_image')
    const subagents = filterCheckingSubagents(noImage, { verdicts: [{ verdict: 'pass', note: 'plan ok' }] })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent' }), [undeclaredSeed('m1')])
    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    await h.engine.submitPlan(h.root, 'plan')
    const outcome = await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    expect(outcome.verdict).toBe('pass')
    expect(outcome.route.routeDiagnostic).toContain('tool surface narrowed for plan auditor')
    expect(outcome.route.routeDiagnostic).toContain('"read_image"')
    expect(h.engine.peek(h.root.id)?.audits.at(-1)?.route.routeDiagnostic).toContain('"read_image"')
  })
})

describe('resolveToolAllow', () => {
  it('passes the request through UNCHANGED when the registry cannot be observed', () => {
    // Absent must not mean "narrow to nothing": that would blind every dispatch
    // on a host that simply cannot be asked, and would claim a narrowing the
    // code never observed.
    const resolution = resolveToolAllow(['read', 'nope'], undefined, ['read'], 'x')
    expect(resolution.allow).toEqual(['read', 'nope'])
    expect(resolution.dropped).toEqual([])
    expect(resolution.diagnostic).toBeUndefined()
  })

  it('narrows and names every dropped tool', () => {
    const resolution = resolveToolAllow(['read', 'bash', 'pwsh'], ['read', 'pwsh'], [], 'x')
    expect(resolution.allow).toEqual(['read', 'pwsh'])
    expect(resolution.dropped).toEqual(['bash'])
    expect(resolution.diagnostic).toContain('"bash"')
  })

  it('imposes nothing for a family the request never named', () => {
    // `executor.toolAllowList: []` is a legal config (test/config.test.ts pins
    // it), and a read-only executor must stay startable.
    expect(resolveToolAllow([], ['read'], [], 'x').allow).toEqual([])
    expect(resolveToolAllow(['read'], ['read'], [], 'x').dropped).toEqual([])
  })

  it('accepts a family that survives under a different spelling', () => {
    const resolution = resolveToolAllow(['bash', 'pwsh'], ['pwsh'], [], 'x')
    expect(resolution.allow).toEqual(['pwsh'])
  })

  it('refuses when a whole requested family is emptied', () => {
    expect(() => resolveToolAllow(['write', 'edit'], ['read'], [], 'x'))
      .toThrowError(/registers none of the file-write tools/)
  })
})

/**
 * ── DIAGNOSTIC SCOPING ────────────────────────────────────────────────────
 *
 * Live observation this pins: revisions 5 and 6 of a real run both carried
 * "plan gate refused despite a pass verdict", while revision 6 already had
 * `planGate: 'pass'`. Every commit builds its snapshot by spreading the prior
 * one, so a refusal string outlived the condition that produced it and the
 * status a model reads contradicted the gate it reported.
 */
describe('diagnostic is scoped to the transition that produced it', () => {
  it('does not carry a plan-gate refusal into the revision where the gate passes', async () => {
    const subagents = stubSubagents({
      verdicts: [{ verdict: 'pass', note: 'plan ok' }, { verdict: 'pass', note: 'plan ok' }],
    })
    const h = makeHarness({ subagents })
    await h.engine.init(
      h.root,
      makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent' }),
      [undeclaredSeed('m1')],
    )
    await h.engine.submitPlan(h.root, 'plan')
    // First plan audit passes but usage is still undeclared: recorded refusal.
    await expect(h.engine.audit(h.root, { role: 'plan', prompt: 'p' }))
      .rejects.toThrowError(/usage evidence must be declared/)
    const refused = h.engine.peek(h.root.id)
    expect(refused?.diagnostic).toContain('plan gate refused despite a pass verdict')

    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    await h.engine.submitPlan(h.root, 'plan v2')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    const passed = h.engine.peek(h.root.id)
    expect(passed?.planGate).toBe('pass')
    // The whole point: a snapshot may not say the gate refused while reporting
    // that it passed.
    expect(passed?.diagnostic).toBeUndefined()
    expect(h.engine.status(h.root)?.diagnostic).toBeUndefined()
  })
})

describe('listRuns answers from the STORE, not from what this process happens to remember', () => {
  /** Build an engine that has never seen any run, over an existing directory. */
  async function coldEngineOver(storeDir: string) {
    const { AutopilotEngine } = await import('../src/engine.js')
    const { RunStore } = await import('../src/store/file.js')
    const { resolveConfig } = await import('../src/index.js')
    const { FakeAgents, stubSubagents } = await import('./helpers.js')
    return new AutopilotEngine(
      new FakeAgents() as never,
      stubSubagents() as never,
      new RunStore(storeDir),
      resolveConfig(),
    )
  }

  it('a COLD engine over a populated directory enumerates runs it never touched', async () => {
    // The shipped answer was `[...this.cache.keys()]`. Measured on the real web
    // profile 2026-08-25: a freshly booted server served `/api/autopilot/runs`
    // -> `[]` against a populated store, and the list grew only as individual
    // ids were probed — enumeration was hydration-order dependent. No unit test
    // could see it, because every unit test asks the SAME engine that just
    // created the run, where cache and store agree. This one does not.
    const warm = makeHarness()
    await warm.engine.init(warm.root, makeTriage())
    expect(warm.engine.listRuns()).toContain(warm.root.id)

    const cold = await coldEngineOver(warm.storeDir)
    expect(cold.listRuns()).toContain(warm.root.id)
  })

  it('a cold engine over an EMPTY directory enumerates nothing (the negative half)', async () => {
    // Without this, the assertion above would also pass on an implementation
    // that returned a constant non-empty list.
    const empty = makeHarness()
    const cold = await coldEngineOver(empty.storeDir)
    expect(cold.listRuns()).toEqual([])
  })
})
