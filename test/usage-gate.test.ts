/**
 * The usage-evidence dimension wired into the engine: declaration atomicity,
 * the plan-gate refusal, the write-once freshness anchor, and settlement at
 * closeout.
 *
 * Every rule here is asserted with BOTH a fixture that must fail it and a
 * fixture that must pass it, because a gate whose fail nobody has observed
 * carries no information when it passes.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AutopilotError, BOUNDARY_MENU } from '../src/domain/types.js'
import { fakeAgent, makeHarness, makeTriage, makeUsageEntry, stubSubagents, undeclaredSeed } from './helpers.js'
import type { Harness } from './helpers.js'

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

const STANDARD = { size: 'standard' as const, risk: 'medium' as const, auditMode: 'independent' as const }

function eventLines(storeDir: string, runId: string): string[] {
  const raw = readFileSync(join(storeDir, 'runs', runId, 'events.jsonl'), 'utf8')
  return raw.split('\n').filter(line => line.trim().length > 0)
}

describe('declareUsage', () => {
  it('appends a new entry and replaces an existing one by id (last-wins)', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage(), [undeclaredSeed('m1')])
    expect(h.engine.peek(h.root.id)?.usage?.entries[0]?.usageClass).toBe('undeclared')

    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    const afterReplace = h.engine.peek(h.root.id)?.usage?.entries
    expect(afterReplace?.length).toBe(1)
    expect(afterReplace?.[0]?.usageClass).toBe('cli')

    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm2', usageClass: 'docs', boundaryStates: [], artifacts: [] }))
    const afterAppend = h.engine.peek(h.root.id)?.usage?.entries
    expect(afterAppend?.map(entry => entry.id)).toEqual(['m1', 'm2'])
  })

  it('REFUSES a malformed entry and leaves the event stream byte-identical', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage(), [undeclaredSeed()])
    const before = eventLines(h.storeDir, h.root.id)

    // Fixture chosen because it is invalid — asserted IN PLACE that it still is:
    // a gui change with a single off-menu boundary state.
    const offMenu = 'looked-fine-to-me'
    expect(BOUNDARY_MENU).not.toContain(offMenu)
    await expect(h.engine.declareUsage(h.root, makeUsageEntry({
      id: 'm1',
      usageClass: 'gui',
      boundaryStates: [offMenu],
      artifacts: [],
    }))).rejects.toThrowError(/usage declaration rejected/)

    const after = eventLines(h.storeDir, h.root.id)
    expect(after).toEqual(before)
    expect(h.engine.peek(h.root.id)?.usage?.entries[0]?.usageClass).toBe('undeclared')
  })

  it('carries a typed code so a caller can distinguish it from a phase error', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage(), [undeclaredSeed()])
    try {
      await h.engine.declareUsage(h.root, makeUsageEntry({ id: '', usageClass: 'docs', artifacts: [] }))
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(AutopilotError)
      expect((error as AutopilotError).code).toBe('AP_USAGE_INVALID')
    }
  })
})

describe('plan gate / usage coupling', () => {
  it('REFUSES the gate flip on a pass verdict while an entry is undeclared', async () => {
    const subagents = stubSubagents({ verdicts: [{ verdict: 'pass', note: 'sound plan' }] })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage(STANDARD), [undeclaredSeed()])
    await h.engine.submitPlan(h.root, 'plan text')

    await expect(h.engine.audit(h.root, { role: 'plan', prompt: 'packet' }))
      .rejects.toThrowError(/usage evidence must be declared/)

    const snapshot = h.engine.peek(h.root.id)
    // The GATE did not flip — that is the whole claim of the dimension.
    expect(snapshot?.planGate).toBe('pending')
    expect(snapshot?.phase).toBe('planning')
    expect(snapshot?.planGatePassedAt).toBeUndefined()
  })

  it('RECORDS the auditor verdict it refused to act on, rather than discarding it', async () => {
    const subagents = stubSubagents({ verdicts: [{ verdict: 'pass', note: 'sound plan' }] })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage(STANDARD), [undeclaredSeed()])
    await h.engine.submitPlan(h.root, 'plan text')
    await expect(h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })).rejects.toThrowError()

    const snapshot = h.engine.peek(h.root.id)
    expect(snapshot?.audits.length).toBe(1)
    expect(snapshot?.audits[0]?.role).toBe('plan')
    expect(snapshot?.audits[0]?.verdict).toBe('pass')
    expect(snapshot?.audits[0]?.auditorId).toBe('auditor-1')
    expect(snapshot?.diagnostic).toMatch(/plan gate refused despite a pass verdict/)
  })

  it('the same run passes once the usage question is answered', async () => {
    const subagents = stubSubagents({
      verdicts: [{ verdict: 'pass', note: 'first' }, { verdict: 'pass', note: 'second' }],
    })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage(STANDARD), [undeclaredSeed()])
    await h.engine.submitPlan(h.root, 'plan text')
    await expect(h.engine.audit(h.root, { role: 'plan', prompt: 'p' })).rejects.toThrowError()

    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    const outcome = await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    expect(outcome.verdict).toBe('pass')
    const snapshot = h.engine.peek(h.root.id)
    expect(snapshot?.planGate).toBe('pass')
    expect(snapshot?.phase).toBe('executing')
    expect(typeof snapshot?.planGatePassedAt).toBe('string')
  })

  it('a legacy run with no usage dimension passes the gate unchanged', async () => {
    const subagents = stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage(STANDARD))
    expect(h.engine.peek(h.root.id)?.usage).toBeUndefined()
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    expect(h.engine.peek(h.root.id)?.planGate).toBe('pass')
  })

  it('an EMPTY entries list is not legacy-exempt', async () => {
    const subagents = stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage(STANDARD), [])
    expect(h.engine.peek(h.root.id)?.usage?.entries).toEqual([])
    await h.engine.submitPlan(h.root, 'plan')
    await expect(h.engine.audit(h.root, { role: 'plan', prompt: 'p' })).rejects.toThrowError(/not legacy-exempt/)
    expect(h.engine.peek(h.root.id)?.planGate).toBe('pending')
  })

  it('a needs-replan verdict is still delivered on an undeclared run (refusal is scoped to the PASS flip)', async () => {
    const subagents = stubSubagents({ verdicts: [{ verdict: 'needs-replan', note: 'no binary checks' }] })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage(STANDARD), [undeclaredSeed()])
    await h.engine.submitPlan(h.root, 'plan')
    const outcome = await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    expect(outcome.verdict).toBe('needs-replan')
    expect(h.engine.peek(h.root.id)?.phase).toBe('replanning')
  })

  it('stamps planGatePassedAt ONCE and never restamps across a replan round', async () => {
    const subagents = stubSubagents({
      verdicts: [
        { verdict: 'pass', note: 'v1' },
        { verdict: 'needs-replan', note: 'reality disagreed' },
        { verdict: 'pass', note: 'v2' },
      ],
    })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage(STANDARD), [undeclaredSeed()])
    await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
    await h.engine.submitPlan(h.root, 'plan v1')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    const first = h.engine.peek(h.root.id)?.planGatePassedAt
    expect(typeof first).toBe('string')

    await h.engine.submitExecutionEvidence(h.root, { report: 'r', residualRisks: [] })
    await h.engine.audit(h.root, { role: 'execution', prompt: 'e' }) // needs-replan
    expect(h.engine.peek(h.root.id)?.phase).toBe('replanning')
    await h.engine.submitPlan(h.root, 'plan v2')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'p2' })

    expect(h.engine.peek(h.root.id)?.planGate).toBe('pass')
    expect(h.engine.peek(h.root.id)?.planGatePassedAt).toBe(first)
  })
})

describe('completion settlement', () => {
  /**
   * Drive a standard inline run to `closing` with one declared usage entry.
   * `duringExecution` runs while the phase is still `executing`, which is the
   * only window in which a NEW usage entry may legally be declared.
   */
  async function toClosing(
    artifacts: Array<{ ref: string; covers: string[]; capturedAt?: string }>,
    duringExecution?: (harness: Harness) => Promise<void>,
  ) {
    const subagents = stubSubagents({
      verdicts: [{ verdict: 'pass', note: 'plan ok' }, { verdict: 'pass', note: 'execution ok' }],
    })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage(STANDARD), [undeclaredSeed()])
    await h.engine.submitPlan(h.root, 'plan')
    // Declared BEFORE the gate, with artifact refs whose files are written after.
    await h.engine.declareUsage(h.root, makeUsageEntry({
      id: 'm1',
      artifacts: artifacts.map(artifact => ({
        kind: 'session-log' as const,
        ref: artifact.ref,
        covers: artifact.covers,
        capturedAt: artifact.capturedAt ?? new Date(Date.now() + 1000).toISOString(),
      })),
    }))
    await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    expect(h.engine.peek(h.root.id)?.phase).toBe('executing')
    if (duringExecution !== undefined) await duringExecution(h)
    await h.engine.submitExecutionEvidence(h.root, { report: 'r', residualRisks: [] })
    await h.engine.audit(h.root, { role: 'execution', prompt: 'e' })
    expect(h.engine.peek(h.root.id)?.phase).toBe('closing')
    return h
  }

  function writeArtifact(storeDir: string, runId: string, ref: string, body: string): void {
    const target = join(storeDir, 'runs', runId, ref)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body, 'utf8')
  }

  it('refuses completion when a declared artifact is missing from disk', async () => {
    const h = await toClosing([{ ref: 'usage/m1.log', covers: ['empty'] }])
    await expect(h.engine.submitCloseout(h.root, GOOD_CLOSEOUT))
      .rejects.toThrowError(/completion refused/)
  })

  it('refuses completion when the artifact exists but is empty', async () => {
    const h = await toClosing([{ ref: 'usage/m1.log', covers: ['empty'] }])
    writeArtifact(h.storeDir, h.root.id, 'usage/m1.log', '')
    await expect(h.engine.submitCloseout(h.root, GOOD_CLOSEOUT))
      .rejects.toThrowError(/is empty \(0 bytes\)/)
  })

  it('refuses completion when the artifact does not mention the label it covers', async () => {
    const h = await toClosing([{ ref: 'usage/m1.log', covers: ['empty'] }])
    writeArtifact(h.storeDir, h.root.id, 'usage/m1.log', 'ran the command, everything was fine\n')
    await expect(h.engine.submitCloseout(h.root, GOOD_CLOSEOUT))
      .rejects.toThrowError(/does not mention covered label: empty/)
  })

  it('completes when the artifact settles (the positive control for all three fails above)', async () => {
    const h = await toClosing([{ ref: 'usage/m1.log', covers: ['empty'] }])
    writeArtifact(h.storeDir, h.root.id, 'usage/m1.log', '$ tool list\n(empty) no entries yet\n')
    const done = await h.engine.submitCloseout(h.root, GOOD_CLOSEOUT)
    expect(done.phase).toBe('completed')
  })

  it('REFUSES a fabricated FUTURE capturedAt — the bearer must sit on the ENGINE path, not the domain fn', async () => {
    // Exists because of a defect measured on the real host 2026-08-25:
    // `settleUsageArtifacts` implemented this upper bound correctly and carried
    // 15 unit bearers for it, while `submitCloseout` passed no `settledAt` — so
    // in production the rule was INERT. A live run settled an artifact stamped
    // 2027-01-01 and still reached `completed`. All 15 bearers called the domain
    // function directly, so not one of them could observe the omission. This
    // bearer drives the ENGINE, the only place it was visible.
    const far = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString()
    const h = await toClosing([{ ref: 'usage/m1.log', covers: ['empty'], capturedAt: far }])
    writeArtifact(h.storeDir, h.root.id, 'usage/m1.log', '(empty) no entries yet')
    await expect(h.engine.submitCloseout(h.root, GOOD_CLOSEOUT))
      .rejects.toThrowError(/clock-skew tolerance/)
  })

  it('REFUSES completion while a usage entry declared AFTER the gate is still undeclared', async () => {
    // The plan gate answered the usage question once, for the entries that
    // existed then. `decideTool` explicitly anticipates a NEW entry appearing
    // mid-execution; without a completion-time re-ask, that entry rides all the
    // way to `completed` and the dimension's whole claim is void.
    const h = await toClosing(
      [{ ref: 'usage/m1.log', covers: ['empty'] }],
      async harness => { await harness.engine.declareUsage(harness.root, undeclaredSeed('m2')) },
    )
    writeArtifact(h.storeDir, h.root.id, 'usage/m1.log', '$ tool list\n(empty) no entries yet\n')
    expect(h.engine.peek(h.root.id)?.usage?.entries.map(entry => entry.usageClass)).toContain('undeclared')

    await expect(h.engine.submitCloseout(h.root, GOOD_CLOSEOUT))
      .rejects.toThrowError(/is undeclared/)
    expect(h.engine.peek(h.root.id)?.phase).toBe('closing')
  })

  it('REFUSES completion when a declared entry is downgraded back to undeclared', async () => {
    const h = await toClosing(
      [{ ref: 'usage/m1.log', covers: ['empty'] }],
      async harness => { await harness.engine.declareUsage(harness.root, undeclaredSeed('m1')) },
    )
    writeArtifact(h.storeDir, h.root.id, 'usage/m1.log', '$ tool list\n(empty) no entries yet\n')
    await expect(h.engine.submitCloseout(h.root, GOOD_CLOSEOUT))
      .rejects.toThrowError(/is undeclared/)
  })

  it('a legacy run with no usage dimension completes without any settlement', async () => {
    const subagents = stubSubagents({
      verdicts: [{ verdict: 'pass', note: 'plan ok' }, { verdict: 'pass', note: 'execution ok' }],
    })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage(STANDARD))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    await h.engine.submitExecutionEvidence(h.root, { report: 'r', residualRisks: [] })
    await h.engine.audit(h.root, { role: 'execution', prompt: 'e' })
    const done = await h.engine.submitCloseout(h.root, GOOD_CLOSEOUT)
    expect(done.phase).toBe('completed')
    expect(done.usage).toBeUndefined()
  })
})

describe('usage seeds at init', () => {
  it('rejects a malformed seed before the run exists at all', async () => {
    const h = makeHarness()
    await expect(h.engine.init(h.root, makeTriage(STANDARD), [
      { id: 'm1', usageClass: 'unsupported', boundaryStates: [], artifacts: [], attempted: [] },
    ])).rejects.toThrowError(/usage seed rejected/)
    expect(h.engine.peek(h.root.id)).toBeUndefined()
  })

  it('an executor child cannot declare usage: the surface is root-only', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage(), [undeclaredSeed()])
    const child = fakeAgent('child-1', h.root.id)
    h.agents.add(child)
    await expect(h.engine.declareUsage(child, makeUsageEntry()))
      .rejects.toThrowError(/must be top-level/)
  })
})
