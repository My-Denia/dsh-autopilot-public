/**
 * Governance pragmatics v2 (shared doctrine §9, 2026-10-09): the owner-facing
 * contract gains three recorded facts.
 *
 * 1. `inlineReason` — a medium+ risk run that implements INLINE must record
 *    WHY it does not delegate. The reason is recorded and surfaced, never
 *    gated on approval; its ABSENCE is the hard refusal, because an
 *    unrecorded inline choice at real risk is the quiet path around the
 *    executor/auditor separation.
 * 2. `ownerRequirements` — owner-verbatim requirement strings, recorded once
 *    at init and surfaced in status and the root policy, so an audit packet
 *    checks compliance against the owner's actual words, not a paraphrase.
 * 3. `commandRecords` — the closeout's structured counterpart to the
 *    free-text `commands` log: {command, cwd, exitStatus, coverage}.
 */
import { describe, expect, it } from 'vitest'
import { renderRootPolicy } from '../src/policy.js'
import { validateTriage } from '../src/domain/types.js'
import { makeHarness, makeTriage, makeUsageEntry, stubSubagents, undeclaredSeed } from './helpers.js'
import type { Harness } from './helpers.js'

const INLINE_MEDIUM = {
  size: 'standard', risk: 'medium', executionMode: 'inline', auditMode: 'independent',
} as const

/**
 * An inline medium triage with NO recorded reason. Built by widening the
 * low-risk fixture AFTER construction: `makeTriage` itself fills a fixture
 * reason for inline medium+ overrides (like a real caller must), so the
 * refusal path can only be exercised by bypassing that kindness.
 */
function noReasonTriage(): ReturnType<typeof makeTriage> {
  return { ...makeTriage(), ...INLINE_MEDIUM }
}

/** Drive an inline medium run to `closing` with both gates passed. */
async function toClosing(h: Harness, triage: Parameters<typeof makeTriage>[0]): Promise<void> {
  await h.engine.init(h.root, makeTriage(triage), [undeclaredSeed('m1')])
  // internal class: no artifacts to settle, so the closeout is about the
  // command records and nothing else.
  await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1', usageClass: 'internal', boundaryStates: [], artifacts: [] }))
  await h.engine.submitPlan(h.root, 'plan')
  await h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })
  await h.engine.submitExecutionEvidence(h.root, { report: 'did the work', residualRisks: [] })
  await h.engine.audit(h.root, { role: 'execution', prompt: 'audit packet' })
}

describe('the inline-at-medium+ recorded reason', () => {
  it('refuses an inline medium run with no inlineReason, by code', async () => {
    const h = makeHarness({ subagents: stubSubagents({ verdicts: [] }) })
    const failure = await h.engine.init(h.root, noReasonTriage()).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'AP_INLINE_REASON_REQUIRED' })
    expect((failure as Error).message).toContain('a reason, not an approval')
  })

  it('refuses a blank inlineReason the same way — whitespace is not a reason', async () => {
    const h = makeHarness({ subagents: stubSubagents({ verdicts: [] }) })
    await expect(h.engine.init(h.root, makeTriage({ ...INLINE_MEDIUM, inlineReason: '   ' })))
      .rejects.toMatchObject({ code: 'AP_INLINE_REASON_REQUIRED' })
  })

  it('accepts a recorded reason and surfaces it in status and the root policy', async () => {
    const h = makeHarness({ subagents: stubSubagents({ verdicts: [] }) })
    const snapshot = await h.engine.init(h.root, makeTriage({
      ...INLINE_MEDIUM, inlineReason: 'single-file fix; a child context would cost more than the change',
    }))
    const status = h.engine.projectStatus(snapshot)
    expect(status.inlineReason).toBe('single-file fix; a child context would cost more than the change')
    expect(renderRootPolicy(snapshot)).toContain(
      'Inline reason (recorded, not approved): single-file fix; a child context would cost more than the change')
  })

  it('asks nothing of a delegated medium run', async () => {
    const h = makeHarness({ subagents: stubSubagents({ verdicts: [] }) })
    const delegated = await h.engine.init(h.root, makeTriage({
      size: 'standard', risk: 'high', executionMode: 'delegated', auditMode: 'independent',
    }))
    expect(delegated.triage.inlineReason).toBeUndefined()
    expect(h.engine.projectStatus(delegated).inlineReason).toBeUndefined()
    expect(renderRootPolicy(delegated)).not.toContain('Inline reason')
  })

  it('asks nothing of a low-risk inline run', async () => {
    const h = makeHarness({ subagents: stubSubagents({ verdicts: [] }) })
    const low = await h.engine.init(h.root, makeTriage({}))
    expect(low.triage.inlineReason).toBeUndefined()
    expect(h.engine.projectStatus(low).inlineReason).toBeUndefined()
  })
})

describe('owner-verbatim requirement traceability', () => {
  it('surfaces the declared requirements verbatim in status and policy', async () => {
    const h = makeHarness({ subagents: stubSubagents({ verdicts: [] }) })
    const snapshot = await h.engine.init(h.root, makeTriage({
      ...INLINE_MEDIUM,
      ownerRequirements: ['no merge to main', 'keep the M13 routing GUI'],
    }))
    const status = h.engine.projectStatus(snapshot)
    expect(status.ownerRequirements).toEqual(['no merge to main', 'keep the M13 routing GUI'])
    const policy = renderRootPolicy(snapshot)
    expect(policy).toContain('Owner requirements (verbatim')
    expect(policy).toContain('- no merge to main')
    expect(policy).toContain('- keep the M13 routing GUI')
  })

  it('projects nothing when none were declared — absence is the honest record', async () => {
    const h = makeHarness({ subagents: stubSubagents({ verdicts: [] }) })
    const snapshot = await h.engine.init(h.root, makeTriage(INLINE_MEDIUM))
    expect(h.engine.projectStatus(snapshot).ownerRequirements).toBeUndefined()
    expect(renderRootPolicy(snapshot)).not.toContain('Owner requirements')
  })

  it('refuses a blank entry at triage validation', () => {
    expect(validateTriage(makeTriage({ ownerRequirements: ['keep X', '  '] })).join(';'))
      .toContain('ownerRequirements entries must be non-blank strings')
    expect(validateTriage(makeTriage({ ownerRequirements: ['keep X'] }))).toEqual([])
  })
})

describe('structured closeout command records', () => {
  it('completes with well-formed records and persists them on the closeout', async () => {
    const h = makeHarness({
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'plan ok' }, { verdict: 'pass', note: 'exec ok' }] }),
    })
    await toClosing(h, INLINE_MEDIUM)
    const done = await h.engine.submitCloseout(h.root, {
      summary: 'done',
      changedFiles: ['src/x.ts'],
      commands: ['pnpm run test — 1534 passed'],
      commandRecords: [
        { command: 'pnpm run test', exitStatus: '0', coverage: 'full unit suite green' },
        { command: 'pnpm run check', cwd: '/repo', exitStatus: '0', coverage: 'typecheck' },
      ],
      evidence: [{ criterion: 'tests pass', bearer: 'pnpm run test', status: 'proven', kind: 'command' }],
      residualRisks: [],
      exclusions: [],
      workspaceCleanup: 'nothing left behind',
      drift: 'none found',
    })
    expect(done.phase).toBe('completed')
    expect(done.closeout?.commandRecords?.map(record => record.command))
      .toEqual(['pnpm run test', 'pnpm run check'])
  })

  it('refuses a record with an empty exitStatus — a record without its exit fact is a narrative', async () => {
    const h = makeHarness({
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'plan ok' }, { verdict: 'pass', note: 'exec ok' }] }),
    })
    await toClosing(h, INLINE_MEDIUM)
    await expect(h.engine.submitCloseout(h.root, {
      summary: 'done',
      changedFiles: ['src/x.ts'],
      commands: ['pnpm run test'],
      commandRecords: [{ command: 'pnpm run test', exitStatus: ' ' }],
      evidence: [{ criterion: 'tests pass', bearer: 'pnpm run test', status: 'proven', kind: 'command' }],
      residualRisks: [],
      exclusions: [],
      workspaceCleanup: 'nothing left behind',
      drift: 'none found',
    })).rejects.toMatchObject({ code: 'AP_INVALID_ARGUMENT' })
  })
})
