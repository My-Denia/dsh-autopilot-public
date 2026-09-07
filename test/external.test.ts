/**
 * `auditMode: 'external'` — the owner-countersigned review channel.
 *
 * WHY THIS FILE IS SEPARATE. Every other verdict in this harness is produced by
 * the harness: `audit` dispatches a subagent and reads its structured output,
 * `self-check` is labelled same-context review behind its own fence. `external`
 * is the one path where a HUMAN asserts a verdict about work done outside this
 * process, so its whole design is about not letting that become a hole:
 *
 *   1. the tool refuses an agent-generated turn (otherwise the agent
 *      countersigns its own run and `external` is a self-check with better
 *      paperwork) — that half is borne in `test/tools.test.ts`;
 *   2. the countersign is validated ON REPLAY too, not only by the writer —
 *      the defect class this repo already paid for once;
 *   3. completion refuses a countersign whose review is not actually attached.
 *
 * What CANNOT be checked anywhere is whether the review happened, whether the
 * named reviewer wrote it, or whether it was about this tree (DESIGN.md §6).
 * The tests below assert the mechanisable half and say so where they stop.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyEvent } from '../src/domain/fold.js'
import { compareDeclaredTree, evaluateCompletion, validateExternalReview } from '../src/domain/types.js'
import type { AuditRecord, Operation, RunEvent, Snapshot, Triage } from '../src/domain/types.js'
import { settleExternalReviews } from '../src/domain/usage.js'
import { RunStore } from '../src/store/file.js'
import { makeHarness, makeSnapshot, makeTriage } from './helpers.js'

const EXTERNAL = { size: 'standard', risk: 'low', executionMode: 'inline', auditMode: 'external' } as const
const REVIEW = { reviewer: 'a named human', reviewRef: 'review/plan.md' }
const DECLARED = { id: 'm1', usageClass: 'internal', boundaryStates: [], artifacts: [], attempted: [] } as const

function auditRecord(over: Partial<AuditRecord> = {}): AuditRecord {
  return {
    role: 'plan',
    seq: 0,
    runRevision: 1,
    planRevision: 1,
    executionRevision: 0,
    auditorId: 'external',
    verdict: 'pass',
    note: 'reviewed',
    route: { provider: 'external', routeProvider: 'external', routeModel: 'external', routeStatus: 'unverified' },
    external: { ...REVIEW },
    ...over,
  }
}

describe('validateExternalReview: the replay-safe half', () => {
  it('accepts a well-formed countersign', () => {
    expect(validateExternalReview(REVIEW)).toEqual([])
  })

  it('refuses a countersign that attaches nothing', () => {
    expect(validateExternalReview({ reviewer: 'x', reviewRef: '   ' }).join(';'))
      .toMatch(/a countersign must attach the review/)
  })

  it('refuses an unnamed reviewer', () => {
    expect(validateExternalReview({ reviewer: '  ', reviewRef: 'r.md' }).join(';')).toMatch(/reviewer is empty/)
  })

  it('refuses refs that escape the run directory by shape', () => {
    for (const ref of ['../outside.md', '/etc/passwd', 'C:\\other\\r.md', 'a/../../b.md']) {
      expect(validateExternalReview({ reviewer: 'x', reviewRef: ref }).join(';'))
        .toMatch(/must be a run-directory-relative path/)
    }
    // Control: the shape rule must not reject an ordinary nested path, or the
    // four assertions above would pass on a checker that rejects everything.
    expect(validateExternalReview({ reviewer: 'x', reviewRef: 'review/round-2/plan.md' })).toEqual([])
  })
})

describe('the fold validates a countersign on REPLAY, not only where it was written', () => {
  function event(next: Snapshot, op: Operation): RunEvent {
    return { v: 1, op, revision: next.revision, time: new Date().toISOString(), snapshot: next }
  }

  it('refuses a countersign recorded on a run whose auditMode is not external', () => {
    const prior = makeSnapshot({}, { ...EXTERNAL, auditMode: 'independent' })
    const next = { ...prior, revision: 2, audits: [auditRecord()] }
    expect(() => applyEvent(prior, event(next, 'external-audit')))
      .toThrowError(/carries an external countersign but auditMode is independent/)
  })

  it('refuses a countersign whose review ref is malformed', () => {
    const prior = makeSnapshot({}, EXTERNAL)
    const next = { ...prior, revision: 2, audits: [auditRecord({ external: { reviewer: 'x', reviewRef: '' } })] }
    expect(() => applyEvent(prior, event(next, 'external-audit')))
      .toThrowError(/must attach the review/)
  })

  it('accepts a well-formed one (the positive control for both refusals above)', () => {
    const prior = makeSnapshot({}, EXTERNAL)
    const next = { ...prior, revision: 2, audits: [auditRecord()] }
    expect(() => applyEvent(prior, event(next, 'external-audit'))).not.toThrow()
  })
})

describe('settlement: a countersign must actually attach its review', () => {
  function runDirWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-autopilot-external-'))
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(dir, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, body, 'utf8')
    }
    return dir
  }

  it('accepts a review that exists and is non-empty', () => {
    const dir = runDirWith({ 'review/plan.md': 'I read the plan. It is coherent.\n' })
    expect(settleExternalReviews([auditRecord()], { runDir: dir })).toEqual([])
  })

  it('refuses a review that does not exist', () => {
    const dir = runDirWith({})
    expect(settleExternalReviews([auditRecord()], { runDir: dir }).join(';'))
      .toMatch(/does not exist or is unreadable/)
  })

  it('refuses a review that exists but is empty — attaching nothing', () => {
    const dir = runDirWith({ 'review/plan.md': '' })
    expect(settleExternalReviews([auditRecord()], { runDir: dir }).join(';')).toMatch(/is empty/)
  })

  it('settles only the LATEST record per role, so a corrected review is possible', () => {
    const dir = runDirWith({ 'review/second.md': 'the corrected review\n' })
    const superseded = auditRecord({ seq: 0, external: { reviewer: 'x', reviewRef: 'review/missing.md' } })
    const latest = auditRecord({ seq: 1, external: { reviewer: 'x', reviewRef: 'review/second.md' } })
    expect(settleExternalReviews([superseded, latest], { runDir: dir })).toEqual([])
    // Control: that same superseded record settled ALONE is refused, proving
    // the clean result above comes from supersession and not from a settler
    // that never looks at anything.
    expect(settleExternalReviews([superseded], { runDir: dir }).join(';')).toMatch(/does not exist/)
  })
})

describe('completion provenance under external mode', () => {
  const closeout = {
    summary: 'done',
    changedFiles: ['x'],
    commands: ['npx vitest run'],
    evidence: [{ criterion: 'tests pass', bearer: 'npx vitest run', status: 'proven' as const }],
    residualRisks: [],
    exclusions: [],
    workspaceCleanup: 'none',
    drift: 'none found',
  }
  function closing(audits: readonly AuditRecord[], triage: Partial<Triage> = EXTERNAL): Snapshot {
    return makeSnapshot({
      revision: 9,
      phase: 'closing',
      planGate: 'pass',
      executionGate: 'pass',
      audits: [...audits],
      closeout,
    }, triage)
  }

  it('accepts a countersigned pass for every required role', () => {
    const check = evaluateCompletion(closing([
      auditRecord({ role: 'plan', seq: 0 }),
      auditRecord({ role: 'execution', seq: 1 }),
    ]))
    expect(check.problems).toEqual([])
    expect(check.ok).toBe(true)
  })

  it('REFUSES a self-check pass — external mode is not a licence to self-review', () => {
    const selfCheck = auditRecord({
      role: 'execution',
      seq: 1,
      auditorId: 'self-check',
      external: undefined,
      route: { provider: 'self-check', routeProvider: 'self-check', routeModel: 'self-check', routeStatus: 'unverified' },
    })
    const check = evaluateCompletion(closing([auditRecord({ role: 'plan', seq: 0 }), selfCheck]))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/role execution latest pass is a self-check/)
  })

  it('ACCEPTS a dispatched auditor pass — a real dispatch is stronger, not weaker', () => {
    const dispatched = auditRecord({
      role: 'execution',
      seq: 1,
      auditorId: 'child-1',
      external: undefined,
      route: { provider: 'spawn', routeProvider: 'p', routeModel: 'm', routeStatus: 'verified' },
    })
    expect(evaluateCompletion(closing([auditRecord({ role: 'plan', seq: 0 }), dispatched])).ok).toBe(true)
  })

  it('REFUSES a countersign sitting in a run that is not external mode', () => {
    const snapshot = closing(
      [auditRecord({ role: 'plan', seq: 0 }), auditRecord({ role: 'execution', seq: 1 })],
      { ...EXTERNAL, auditMode: 'independent' },
    )
    expect(evaluateCompletion(snapshot).problems.join(';'))
      .toMatch(/carries an external countersign but the run's auditMode is independent/)
  })
})

describe('the engine channel', () => {
  it('refuses a countersign on a run whose auditMode is not external', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    await h.engine.submitPlan(h.root, 'plan')
    await expect(h.engine.recordExternalAudit(h.root, {
      role: 'plan', verdict: 'pass', note: 'n', review: REVIEW,
    })).rejects.toThrowError(/only legal on auditMode external/)
  })

  it('records the countersign under its own op, so the stream distinguishes provenance', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage(EXTERNAL), [DECLARED])
    await h.engine.submitPlan(h.root, 'plan')
    const outcome = await h.engine.recordExternalAudit(h.root, {
      role: 'plan', verdict: 'pass', note: 'reviewed offline', review: REVIEW,
    })
    expect(outcome.route.provider).toBe('external')
    expect(outcome.route.routeDiagnostic).toMatch(/cannot verify the review happened/)
    const snapshot = h.engine.peek(h.root.id)
    expect(snapshot?.planGate).toBe('pass')
    expect(snapshot?.audits[0]?.external).toEqual(REVIEW)
  })

  it('refuses a countersign that attaches nothing, leaving the run untouched', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage(EXTERNAL), [DECLARED])
    await h.engine.submitPlan(h.root, 'plan')
    const before = h.engine.peek(h.root.id)?.revision
    await expect(h.engine.recordExternalAudit(h.root, {
      role: 'plan', verdict: 'pass', note: 'n', review: { reviewer: 'x', reviewRef: '' },
    })).rejects.toThrowError(/must attach the review/)
    expect(h.engine.peek(h.root.id)?.revision).toBe(before)
    expect(h.engine.peek(h.root.id)?.planGate).toBe('pending')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — the declared tree hash
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The field is OWNER-DECLARED and the tests say so at every turn. Nothing here
 * checks that a hash names this tree, or any tree: this package has no
 * `child_process` and no git, and a run records no work tree, so the engine
 * cannot measure one. What IS mechanisable — and is therefore what these
 * bearers cover — is the shape floor, the blank-is-absent rule, replay
 * validation, and the declared-vs-declared comparison being INFORMATION rather
 * than a gate.
 */
const HASH = '0123456789abcdef0123456789abcdef01234567'

describe('validateExternalReview: the treeHash shape floor', () => {
  it('accepts absent — every existing stream replays, and no reviewer is forced to invent one', () => {
    expect(validateExternalReview(REVIEW)).toEqual([])
    expect(validateExternalReview({ ...REVIEW, treeHash: undefined })).toEqual([])
  })

  it('accepts the spellings git actually prints', () => {
    for (const hash of ['0123456', '0123456789abcdef', HASH, 'a'.repeat(64)]) {
      expect(validateExternalReview({ ...REVIEW, treeHash: hash })).toEqual([])
    }
  })

  it('refuses what is not a hash, so the record never carries prose as an identifier', () => {
    for (const hash of ['main', 'the main branch', '012345', 'a'.repeat(65), 'g'.repeat(8), '0123456!', ' 0123456', '01234 56']) {
      expect(validateExternalReview({ ...REVIEW, treeHash: hash }).join(';'))
        .toMatch(/treeHash must be 7-64 lowercase hex/)
    }
  })

  it('refuses UPPERCASE, because the one construction site lowercases before writing', () => {
    // A stored value in any other case did not come from this engine. The fold
    // says so rather than normalizing a foreign stream into looking native.
    expect(validateExternalReview({ ...REVIEW, treeHash: HASH.toUpperCase() }).join(';'))
      .toMatch(/treeHash must be 7-64 lowercase hex/)
  })

  it('refuses a NON-STRING, which the regex alone would have let through', () => {
    // `/^[0-9a-f]{7,64}$/.test(1234567)` is true — `test` stringifies. On the
    // replay path the declared type is a promise, not a fact, so the typeof
    // guard is the load-bearing half of this rule.
    const numeric = { ...REVIEW, treeHash: 1234567 } as unknown as typeof REVIEW
    expect(validateExternalReview(numeric).join(';')).toMatch(/treeHash must be a string, got number/)
    const nulled = { ...REVIEW, treeHash: null } as unknown as typeof REVIEW
    expect(validateExternalReview(nulled).join(';')).toMatch(/treeHash must be a string, got null/)
  })

  it('reports the treeHash problem ALONGSIDE the others, never instead of them', () => {
    const problems = validateExternalReview({ reviewer: '  ', reviewRef: '', treeHash: 'nope' })
    expect(problems.join(';')).toMatch(/reviewer is empty/)
    expect(problems.join(';')).toMatch(/must attach the review/)
    expect(problems.join(';')).toMatch(/treeHash/)
  })
})

describe('compareDeclaredTree: two declarations, neither measured', () => {
  it('resolves git abbreviations the way every git UI does', () => {
    expect(compareDeclaredTree(HASH, HASH)).toBe('agrees')
    expect(compareDeclaredTree('0123456', HASH)).toBe('agrees')
    expect(compareDeclaredTree(HASH, '0123456')).toBe('agrees')
    // Case and surrounding whitespace on the BASELINE side are the run's own
    // free text, so they are normalized rather than reported as a mismatch.
    expect(compareDeclaredTree(HASH, `  ${HASH.toUpperCase()}  `)).toBe('agrees')
  })

  it('reports a real disagreement', () => {
    expect(compareDeclaredTree(HASH, 'fedcba9876543210')).toBe('differs')
    expect(compareDeclaredTree('0123456', 'fedcba9')).toBe('differs')
  })

  it('distinguishes "nothing to compare" from "they disagree"', () => {
    expect(compareDeclaredTree(undefined, HASH)).toBe('no-hash')
    expect(compareDeclaredTree(HASH, undefined)).toBe('no-baseline')
    expect(compareDeclaredTree(HASH, '   ')).toBe('no-baseline')
  })
})

describe('the fold validates a declared treeHash on REPLAY too', () => {
  function event(next: Snapshot, op: Operation): RunEvent {
    return { v: 1, op, revision: next.revision, time: new Date().toISOString(), snapshot: next }
  }

  it('refuses a malformed hash in a stored record', () => {
    const prior = makeSnapshot({}, EXTERNAL)
    const next = {
      ...prior,
      revision: 2,
      audits: [auditRecord({ external: { ...REVIEW, treeHash: 'not-a-hash' } })],
    }
    expect(() => applyEvent(prior, event(next, 'external-audit')))
      .toThrowError(/treeHash must be 7-64 lowercase hex/)
  })

  it('accepts a well-formed one — the positive control for the refusal above', () => {
    const prior = makeSnapshot({}, EXTERNAL)
    const next = {
      ...prior,
      revision: 2,
      audits: [auditRecord({ external: { ...REVIEW, treeHash: HASH } })],
    }
    expect(() => applyEvent(prior, event(next, 'external-audit'))).not.toThrow()
  })

  it('a MISMATCH against the baseline folds clean — it is information, not an illegal stream', () => {
    // The rule under test is that the fold does NOT gate on the comparison. A
    // run's tree legitimately moves while it executes, so an execution-role
    // countersign disagreeing with the init baseline is the normal case.
    const prior = makeSnapshot({}, { ...EXTERNAL, baseline: { commit: 'fedcba9876543210' } })
    const next = {
      ...prior,
      revision: 2,
      audits: [auditRecord({ external: { ...REVIEW, treeHash: HASH } })],
    }
    expect(compareDeclaredTree(HASH, 'fedcba9876543210')).toBe('differs')
    expect(() => applyEvent(prior, event(next, 'external-audit'))).not.toThrow()
  })
})

describe('settlement and completion still see the countersign as one record', () => {
  it('a declared hash does not disturb the on-disk review check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-autopilot-treehash-'))
    mkdirSync(join(dir, 'review'), { recursive: true })
    writeFileSync(join(dir, 'review', 'plan.md'), 'I read the plan at that tree.\n', 'utf8')
    expect(settleExternalReviews([auditRecord({ external: { ...REVIEW, treeHash: HASH } })], { runDir: dir })).toEqual([])
  })

  it('completion refuses a malformed hash on the latest record per role', () => {
    // `evaluateCompletion` routes external records back through
    // `validateExternalReview`, so the shape floor is enforced at the gate too
    // and not only where the record was written.
    const snapshot = makeSnapshot({
      revision: 9,
      phase: 'closing',
      planGate: 'pass',
      executionGate: 'pass',
      audits: [
        auditRecord({ role: 'plan', seq: 0, external: { ...REVIEW, treeHash: 'zzzzzzz' } }),
        auditRecord({ role: 'execution', seq: 1 }),
      ],
      closeout: {
        summary: 'done',
        changedFiles: ['x'],
        commands: ['npx vitest run'],
        evidence: [{ criterion: 'tests pass', bearer: 'npx vitest run', status: 'proven' as const }],
        residualRisks: [],
        exclusions: [],
        workspaceCleanup: 'none',
        drift: 'none found',
      },
    }, EXTERNAL)
    expect(evaluateCompletion(snapshot).problems.join(';')).toMatch(/treeHash must be 7-64 lowercase hex/)
  })
})

describe('the engine channel carries the hash exactly once, and says what it means', () => {
  async function externalRun(baseline: Record<string, string> = {}) {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage({ ...EXTERNAL, baseline }), [DECLARED])
    await h.engine.submitPlan(h.root, 'plan')
    return h
  }

  it('ABSENT when not supplied — the shape :228 already pins, restated for the new field', () => {
    // This is the regression bearer for the blank-forward class: if the engine
    // ever writes `treeHash: undefined` or `treeHash: ''`, this toEqual breaks.
    return externalRun().then(async (h) => {
      await h.engine.recordExternalAudit(h.root, {
        role: 'plan', verdict: 'pass', note: 'reviewed offline', review: REVIEW,
      })
      const record = h.engine.peek(h.root.id)?.audits[0]
      expect(record?.external).toEqual(REVIEW)
      expect('treeHash' in (record?.external ?? {})).toBe(false)
    })
  })

  it('a BLANK hash is dropped, not stored and not reported as malformed', () => {
    // The `autopilot_usage` regression class: a blank optional string must
    // become an absent field, NOT a validation failure — refusing here would
    // break every provider that force-fills its schema.
    return externalRun().then(async (h) => {
      for (const blank of ['', '   ', '\t\n']) {
        const fresh = await externalRun()
        await fresh.engine.recordExternalAudit(fresh.root, {
          role: 'plan', verdict: 'pass', note: 'n', review: { ...REVIEW, treeHash: blank },
        })
        expect(fresh.engine.peek(fresh.root.id)?.audits[0]?.external).toEqual(REVIEW)
      }
      expect(h.engine.peek(h.root.id)?.planGate).toBe('pending')
    })
  })

  it('stores the hash trimmed and lowercased, once, on the record', async () => {
    const h = await externalRun()
    await h.engine.recordExternalAudit(h.root, {
      role: 'plan', verdict: 'pass', note: 'n', review: { ...REVIEW, treeHash: `  ${HASH.toUpperCase()}  ` },
    })
    expect(h.engine.peek(h.root.id)?.audits[0]?.external).toEqual({ ...REVIEW, treeHash: HASH })
  })

  it('refuses a malformed hash and leaves the run untouched', async () => {
    const h = await externalRun()
    const before = h.engine.peek(h.root.id)?.revision
    await expect(h.engine.recordExternalAudit(h.root, {
      role: 'plan', verdict: 'pass', note: 'n', review: { ...REVIEW, treeHash: 'main' },
    })).rejects.toThrowError(/treeHash must be 7-64 lowercase hex/)
    expect(h.engine.peek(h.root.id)?.revision).toBe(before)
    expect(h.engine.peek(h.root.id)?.planGate).toBe('pending')
  })

  it('surfaces agreement, disagreement and "nothing to compare" on the route diagnostic', async () => {
    const agreeing = await externalRun({ commit: HASH })
    const agreed = await agreeing.engine.recordExternalAudit(agreeing.root, {
      role: 'plan', verdict: 'pass', note: 'n', review: { ...REVIEW, treeHash: '0123456' },
    })
    expect(agreed.route.routeDiagnostic).toMatch(/consistent with the run's declared baseline commit/)
    expect(agreed.route.routeDiagnostic).toMatch(/both are declarations, neither is measured/)

    const differing = await externalRun({ commit: 'fedcba9876543210' })
    const differed = await differing.engine.recordExternalAudit(differing.root, {
      role: 'plan', verdict: 'pass', note: 'n', review: { ...REVIEW, treeHash: HASH },
    })
    expect(differed.route.routeDiagnostic).toMatch(/differs from the run's declared baseline commit/)
    expect(differed.route.routeDiagnostic).toMatch(/INFORMATION, not a refusal/)
    // AND IT IS NOT A GATE: the verdict still landed and the gate still moved.
    expect(differed.verdict).toBe('pass')
    expect(differing.engine.peek(differing.root.id)?.planGate).toBe('pass')

    const noBaseline = await externalRun()
    const none = await noBaseline.engine.recordExternalAudit(noBaseline.root, {
      role: 'plan', verdict: 'pass', note: 'n', review: { ...REVIEW, treeHash: HASH },
    })
    expect(none.route.routeDiagnostic).toMatch(/declared no baseline commit to compare it with/)
  })

  it('says nothing about a tree when no hash was declared', async () => {
    // The negative control for the block above: the diagnostic must not grow a
    // clause about a field the countersign never carried.
    const h = await externalRun({ commit: HASH })
    const outcome = await h.engine.recordExternalAudit(h.root, {
      role: 'plan', verdict: 'pass', note: 'n', review: REVIEW,
    })
    expect(outcome.route.routeDiagnostic).toMatch(/cannot verify the review happened/)
    expect(outcome.route.routeDiagnostic).not.toMatch(/treeHash/)
  })

  it('the stored diagnostic is never re-synthesized, so the append-only fold holds', async () => {
    // The fold compares committed audit records by JSON.stringify, which is
    // sensitive to key ORDER as well as to values. This drives a second event
    // after the countersign and reloads the whole stream through the strict
    // fold: a rebuilt record would fail `AP_AUDITS_MODIFIED` here.
    const h = await externalRun({ commit: HASH })
    await h.engine.recordExternalAudit(h.root, {
      role: 'plan', verdict: 'pass', note: 'n', review: { ...REVIEW, treeHash: HASH },
    })
    const written = h.engine.peek(h.root.id)?.audits[0]
    await h.engine.log(h.root, { text: 'after the countersign', stance: 'on-plan' })
    const replayed = new RunStore(h.storeDir).load(h.root.id)
    expect(replayed?.audits[0]).toEqual(written)
    expect(JSON.stringify(replayed?.audits[0])).toBe(JSON.stringify(written))
  })
})
