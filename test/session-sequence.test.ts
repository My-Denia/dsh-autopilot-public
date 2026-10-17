/**
 * One session, successive independent runs, and the dsh 0.2.1 child-start
 * surface. The finished run stays readable. The next run does not inherit
 * its approvals. A restarted engine follows the session index.
 */
import { describe, expect, it } from 'vitest'
import { AutopilotEngine } from '../src/engine.js'
import type { SubagentActivationRef, SubagentsRef } from '../src/engine.js'
import { AutopilotError } from '../src/domain/types.js'
import { resolveConfig } from '../src/index.js'
import { RunStore } from '../src/store/file.js'
import { FakeAgents, fakeAgent, makeHarness, makeTriage, makeUsageEntry, stubSubagents } from './helpers.js'

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

function activationHarness(startActivation: SubagentsRef['startActivation']): ReturnType<typeof makeHarness> {
  const subagents = {
    async sendMessage() { return 'm' },
    interrupt() {},
    startActivation,
  }
  return makeHarness({ subagents: subagents as unknown as ReturnType<typeof stubSubagents> })
}

describe('sequential runs in one session', () => {
  it('starts B after A, keeps A, and does not lend A its approval', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage({ objective: 'goal A' }))
    const approved = await h.engine.ownerApprove(h.root, 'ONLY goal A')
    expect(approved.enforcement.ownerApprovals).toHaveLength(1)
    await h.engine.submitPlan(h.root, 'plan A')
    await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'ok' })
    await h.engine.submitExecutionEvidence(h.root, { report: 'A', residualRisks: [] })
    await h.engine.selfCheck(h.root, { role: 'execution', verdict: 'pass', note: 'ok' })
    const doneA = await h.engine.submitCloseout(h.root, GOOD_CLOSEOUT)
    expect(doneA.runId).toBe(h.root.id)

    const startedB = await h.engine.init(h.root, makeTriage({ objective: 'goal B' }))
    expect(startedB.runId).not.toBe(h.root.id)
    expect(startedB.sessionId).toBe(h.root.id)
    expect(startedB.phase).toBe('planning')
    expect(startedB.planGate).toBe('pending')
    expect(startedB.executionGate).toBe('pending')
    expect(startedB.executor).toBeUndefined()
    expect(startedB.audits).toHaveLength(0)
    expect(startedB.enforcement.ownerApprovals).toHaveLength(0)
    expect(startedB.triage.objective).toBe('goal B')

    expect(h.engine.peek(h.root.id)?.phase).toBe('completed')
    expect(h.engine.peek(h.root.id)?.triage.objective).toBe('goal A')
    expect(h.engine.peek(h.root.id)?.enforcement.ownerApprovals).toHaveLength(1)
    expect(h.engine.peekActive(h.root.id)?.runId).toBe(startedB.runId)
    expect(h.engine.status(h.root)?.sessionRunIds).toEqual([h.root.id, startedB.runId])

    await h.engine.ownerApprove(h.root, 'ONLY goal B')
    expect(h.engine.peek(h.root.id)?.enforcement.ownerApprovals[0]?.target).toBe('ONLY goal A')
    expect(h.engine.peek(startedB.runId)?.enforcement.ownerApprovals[0]?.target).toBe('ONLY goal B')

    const agents = new FakeAgents()
    const coldRoot = fakeAgent(h.root.id)
    agents.add(coldRoot)
    const cold = new AutopilotEngine(
      agents,
      h.subagents,
      new RunStore(h.storeDir),
      resolveConfig(),
      () => true,
      {},
      {},
    )
    expect(cold.peekActive(h.root.id)?.runId).toBe(startedB.runId)
    expect(cold.peekActive(h.root.id)?.triage.objective).toBe('goal B')
    expect(cold.peek(h.root.id)?.triage.objective).toBe('goal A')
    expect(cold.status(coldRoot)?.runId).toBe(startedB.runId)
  })

  it('refuses a second init while the first run is still active', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    const error = await h.engine.init(h.root, makeTriage({ objective: 'too soon' })).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(AutopilotError)
    expect((error as AutopilotError).code).toBe('AP_ALREADY_ACTIVE')
    expect(h.engine.peek(h.root.id)?.triage.objective).toBe('test objective')
  })
})

describe('dsh 0.2.1 activation surface', () => {
  it('refuses a child start that never applies the armed allow-list', async () => {
    const h = activationHarness(async (): Promise<SubagentActivationRef> => ({
      childId: 'aud-1',
      result: Promise.resolve({ stopReason: 'completed', structured: { verdict: 'pass', note: 'ok' } }),
      async dispose() {},
    }))
    await h.engine.init(h.root, makeTriage({
      objective: 'audit via activation',
      size: 'standard',
      risk: 'medium',
      executionMode: 'inline',
      auditMode: 'independent',
      inlineReason: 'the test only checks child start',
    }))
    await h.engine.submitPlan(h.root, 'plan')
    const error = await h.engine.audit(h.root, { role: 'plan', prompt: 'check the plan' }).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(AutopilotError)
    expect((error as AutopilotError).code).toBe('AP_TOOL_ALLOW_UNAPPLIED')
  })

  it('accepts a child start that applies the armed allow-list', async () => {
    const seen: string[][] = []
    let engine: AutopilotEngine | undefined
    const h = activationHarness(async (spec): Promise<SubagentActivationRef> => {
      const parent = spec.request.parent as { id: string }
      engine!.restrictArmedChild(parent.id, allow => { seen.push([...allow]) })
      return {
        childId: 'aud-2',
        result: Promise.resolve({ stopReason: 'completed', structured: { verdict: 'pass', note: 'ok' } }),
        async dispose() {},
      }
    })
    engine = h.engine
    await h.engine.init(h.root, makeTriage({
      objective: 'audit via activation',
      size: 'standard',
      risk: 'medium',
      executionMode: 'inline',
      auditMode: 'independent',
      inlineReason: 'the test only checks child start',
    }))
    await h.engine.declareUsage(h.root, makeUsageEntry())
    await h.engine.submitPlan(h.root, 'plan')
    const audited = await h.engine.audit(h.root, { role: 'plan', prompt: 'check the plan' })
    expect(audited.verdict).toBe('pass')
    expect(h.engine.peekActive(h.root.id)?.planGate).toBe('pass')
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0]).not.toContain('web_search')
    expect(seen[0]).not.toContain('web_fetch')
  })
})
