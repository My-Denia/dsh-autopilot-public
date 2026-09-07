/** Fold invariant matrix: legal transitions accepted, illegal streams rejected loudly. */

import { describe, expect, it } from 'vitest'
import { applyEvent, foldRun } from '../src/domain/fold.js'
import { AutopilotError, canonicalBearer, evaluateCompletion, validateTriage } from '../src/domain/types.js'
import type { AuditRecord, EvidenceKind, ExecutorRecord, RunEvent, Snapshot, UsageEntry } from '../src/domain/types.js'
import { makeSnapshot, makeTriage } from './helpers.js'

function event(op: RunEvent['op'], snapshot: Snapshot, revision = snapshot.revision, detail?: unknown): RunEvent {
  return {
    v: 1,
    op,
    revision,
    time: new Date().toISOString(),
    snapshot,
    ...(detail === undefined ? {} : { detail }),
  }
}

function passAudit(role: AuditRecord['role'], seq: number, overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    role,
    seq,
    runRevision: 1,
    planRevision: 1,
    executionRevision: 0,
    auditorId: `auditor-${seq}`,
    verdict: 'pass',
    note: 'ok',
    route: { provider: 'spawn', routeProvider: 'p', routeModel: 'm', routeStatus: 'verified' },
    ...overrides,
  }
}

describe('applyEvent', () => {
  it('accepts a legal init', () => {
    const snapshot = makeSnapshot()
    expect(applyEvent(undefined, event('init', snapshot))).toEqual(snapshot)
  })

  it('accepts init with an absolute-shaped Windows bearerBase', () => {
    const snapshot = makeSnapshot({ bearerBase: 'C:\\work' })
    expect(applyEvent(undefined, event('init', snapshot))).toEqual(snapshot)
  })

  it('accepts init with a POSIX absolute bearerBase', () => {
    const snapshot = makeSnapshot({ bearerBase: '/workspace' })
    expect(applyEvent(undefined, event('init', snapshot))).toEqual(snapshot)
  })

  it('accepts init with a bearerBase whose directory name ends in a space', () => {
    // Codex 3911097406. `isAbsoluteShapedBearer` already tolerated this; the
    // assertion exists so a future tightening of the fold cannot silently make
    // the engine's newly-verbatim stamp unfoldable.
    const snapshot = makeSnapshot({ bearerBase: '/workspace/project ' })
    expect(applyEvent(undefined, event('init', snapshot))).toEqual(snapshot)
  })

  it('refuses init with a relative bearerBase', () => {
    expect(() => applyEvent(undefined, event('init', makeSnapshot({ bearerBase: '.' })))).toThrowError(/absolute-shaped/)
  })

  it('refuses init with an empty bearerBase', () => {
    expect(() => applyEvent(undefined, event('init', makeSnapshot({ bearerBase: '' })))).toThrowError(/empty/)
  })

  it('rejects a first event that is not init', () => {
    expect(() => applyEvent(undefined, event('submit-plan', makeSnapshot()))).toThrowError(/first event must be init/)
  })

  it('rejects init with a non-1 revision', () => {
    expect(() => applyEvent(undefined, event('init', makeSnapshot({ revision: 2 })))).toThrowError(/init revision/)
  })

  it('rejects a second init', () => {
    const first = makeSnapshot()
    expect(() => applyEvent(first, event('init', makeSnapshot({ revision: 2 })))).toThrowError(/already initialized/)
  })

  it('rejects a revision skip', () => {
    const first = makeSnapshot()
    const next = makeSnapshot({ revision: 3, plan: { revision: 1, text: 'p' } })
    expect(() => applyEvent(first, event('submit-plan', next))).toThrowError(/non-monotonic revision/)
  })

  it('rejects triage mutation', () => {
    const first = makeSnapshot()
    const next = makeSnapshot({ revision: 2, triage: makeTriage({ objective: 'changed' }) })
    expect(() => applyEvent(first, event('submit-plan', next))).toThrowError(/triage is immutable/)
  })

  it('rejects ops illegal in the current phase', () => {
    const first = makeSnapshot() // planning
    const next = makeSnapshot({ revision: 2, phase: 'closing', closeout: undefined })
    expect(() => applyEvent(first, event('submit-closeout', next))).toThrowError(/illegal in phase planning/)
  })

  it('rejects shrunken audit history', () => {
    const withAudit = makeSnapshot({ audits: [passAudit('plan', 0)] })
    const next = makeSnapshot({ revision: 2, audits: [] })
    expect(() => applyEvent(withAudit, event('log', next))).toThrowError(/audit history shrank/)
  })

  it('rejects modified audit records', () => {
    const withAudit = makeSnapshot({ audits: [passAudit('plan', 0)] })
    const next = makeSnapshot({
      revision: 2,
      audits: [passAudit('plan', 0, { verdict: 'needs-replan' })],
    })
    expect(() => applyEvent(withAudit, event('log', next))).toThrowError(/audit record 0 was modified/)
  })

  it('rejects start-executor before planGate pass', () => {
    const first = makeSnapshot({ phase: 'executing' }) // planGate still pending (already illegal but tests the specific guard)
    const next = makeSnapshot({
      revision: 2,
      phase: 'executing',
      executor: { childId: 'c1', generation: 1, executionRevision: 1, state: 'starting', route: { provider: 'spawn', routeProvider: 'p', routeModel: 'm', routeStatus: 'verified' } },
    })
    expect(() => applyEvent(first, event('start-executor', next))).toThrowError(/executor before planGate pass/)
  })

  it('rejects executionGate pass without a latest execution-audit pass', () => {
    const reviewing = makeSnapshot({ phase: 'execution-reviewing', planGate: 'pass' })
    const next = makeSnapshot({
      revision: 2,
      phase: 'closing',
      planGate: 'pass',
      executionGate: 'pass',
      audits: [],
    })
    expect(() => applyEvent(reviewing, event('audit', next))).toThrowError(/executionGate pass without/)
  })

  it('rejects completed without a valid closeout', () => {
    const closing = makeSnapshot({
      phase: 'closing',
      planGate: 'pass',
      executionGate: 'pass',
      audits: [passAudit('plan', 0), passAudit('execution', 1)],
    })
    const next: Snapshot = { ...closing, revision: 2, phase: 'completed' }
    expect(() => applyEvent(closing, event('submit-closeout', next))).toThrowError(/completion check/)
  })

  it('rejects a plan submission that carries stale execution evidence', () => {
    const replanning = makeSnapshot({ phase: 'replanning', executionGate: 'needs-replan', executionPacket: 'old packet' })
    const staleNext = makeSnapshot({
      revision: 2,
      phase: 'planning',
      plan: { revision: 1, text: 'new plan' },
      executionGate: 'needs-replan',
      executionPacket: 'old packet',
    })
    expect(() => applyEvent(replanning, event('submit-plan', staleNext))).toThrowError(/must clear the execution packet/)

    const staleGateOnly = makeSnapshot({
      revision: 2,
      phase: 'planning',
      plan: { revision: 1, text: 'new plan' },
      executionGate: 'needs-replan',
    })
    expect(() => applyEvent(replanning, event('submit-plan', staleGateOnly))).toThrowError(/reset executionGate/)
  })

  it('rejects any event after a terminal phase', () => {
    const blocked = makeSnapshot({ phase: 'blocked' })
    const next = makeSnapshot({ revision: 2, phase: 'blocked' })
    expect(() => applyEvent(blocked, event('log', next))).toThrowError(/terminal phase/)
  })

  it('folds an empty stream to uninitialized', () => {
    expect(foldRun([]).snapshot).toBeUndefined()
  })

  const executorRoute = {
    provider: 'spawn', routeProvider: 'p', routeModel: 'm', routeStatus: 'verified' as const,
  }

  it('REFUSES a submit-packet whose stamped executionRevision is stale', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'execution-reviewing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
      executionPacket: 'stale v1',
    })
    expect(() => applyEvent(prior, event('submit-packet', next, 2, { executionRevision: 1 })))
      .toThrowError(/executionRevision 1 does not match live 2/)
  })

  it('a submit-packet with no stamped executionRevision still replays (legacy)', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
    })
    expect(prior.bearerBase).toBeUndefined()
    const next = makeSnapshot({
      revision: 2,
      phase: 'execution-reviewing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
      executionPacket: 'legacy packet',
    })
    expect(applyEvent(prior, event('submit-packet', next)).executionPacket).toBe('legacy packet')
  })

  it('REFUSES a submit-packet whose stamped executionRevision is present but not an integer', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'execution-reviewing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
      executionPacket: 'forged',
    })
    expect(() => applyEvent(prior, event('submit-packet', next, 2, { executionRevision: '2' })))
      .toThrowError(/executionRevision is not an integer/)
    expect(() => applyEvent(prior, event('submit-packet', next, 2, { executionRevision: 1.5 })))
      .toThrowError(/executionRevision is not an integer/)
  })

  it('REFUSES a submit-packet whose next snapshot mutates executionRevision', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'execution-reviewing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 1, state: 'running', route: executorRoute },
      executionPacket: 'forged rev',
    })
    expect(() => applyEvent(prior, event('submit-packet', next, 2, { executionRevision: 2 })))
      .toThrowError(/does not retain stamped live 2/)
    const nextHigh = makeSnapshot({
      ...next,
      executor: { childId: 'c1', generation: 1, executionRevision: 3, state: 'running', route: executorRoute },
    })
    expect(() => applyEvent(prior, event('submit-packet', nextHigh, 2, { executionRevision: 2 })))
      .toThrowError(/does not retain stamped live 2/)
  })

  it('a submit-packet stamped with the live executionRevision is accepted', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'execution-reviewing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
      executionPacket: 'work v2',
    })
    expect(applyEvent(prior, event('submit-packet', next, 2, { executionRevision: 2 })).executionPacket).toBe('work v2')
  })

  it('refuses a snapshot that changes bearerBase after init', () => {
    const prior = makeSnapshot({ bearerBase: '/a' })
    const next = makeSnapshot({ revision: 2, bearerBase: '/b' })
    expect(() => applyEvent(prior, event('log', next))).toThrowError(/bearerBase mutated/)
  })

  it('refuses a late fill of absent bearerBase', () => {
    const prior = makeSnapshot()
    const next = makeSnapshot({ revision: 2, bearerBase: '/a' })
    expect(() => applyEvent(prior, event('log', next))).toThrowError(/bearerBase mutated/)
  })

  it('refuses a log that changes executor executionRevision', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 1, state: 'running', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
    })
    expect(() => applyEvent(prior, event('log', next))).toThrowError(/executor mutated/)
  })

  it('refuses a log that swaps childId while keeping executionRevision', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 1, state: 'running', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c2', generation: 1, executionRevision: 1, state: 'running', route: executorRoute },
    })
    expect(() => applyEvent(prior, event('log', next))).toThrowError(/executor mutated/)
  })

  it('refuses a log that drops a live executor', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 1, state: 'running', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'executing',
      planGate: 'pass',
    })
    expect(() => applyEvent(prior, event('log', next))).toThrowError(/executor mutated/)
  })

  it('accepts replan that revokes a running executor with the same identity', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'replanning',
      planGate: 'pending',
      executionGate: 'pending',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'revoked', route: executorRoute },
    })
    expect(applyEvent(prior, event('replan', next)).executor?.state).toBe('revoked')
  })

  it('refuses a replan that completes a running executor', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'replanning',
      planGate: 'pending',
      executionGate: 'pending',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'completed', route: executorRoute },
    })
    expect(() => applyEvent(prior, event('replan', next))).toThrowError(/replan cannot move executor/)
  })

  it('accepts an audit that completes a running executor with the same identity', () => {
    const prior = makeSnapshot({
      phase: 'execution-reviewing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'closing',
      planGate: 'pass',
      executionGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'completed', route: executorRoute },
      audits: [passAudit('execution', 0)],
    })
    expect(applyEvent(prior, event('audit', next)).executor?.state).toBe('completed')
  })

  it('refuses a plan audit that completes a running executor', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'completed', route: executorRoute },
      audits: [passAudit('plan', 0)],
    })
    expect(() => applyEvent(prior, event('audit', next))).toThrowError(/execution-pass/)
  })

  it('refuses an audit that changes a revoked executor to completed', () => {
    const prior = makeSnapshot({
      phase: 'replanning',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'revoked', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'replanning',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'completed', route: executorRoute },
      audits: [passAudit('execution', 0)],
    })
    expect(() => applyEvent(prior, event('audit', next))).toThrowError(/terminal/)
  })

  it('refuses a replan that changes a completed executor to revoked', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'completed', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'replanning',
      planGate: 'pending',
      executionGate: 'pending',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'revoked', route: executorRoute },
    })
    expect(() => applyEvent(prior, event('replan', next))).toThrowError(/terminal/)
  })

  it('refuses an audit that changes a completed executor to revoked', () => {
    const prior = makeSnapshot({
      phase: 'closing',
      planGate: 'pass',
      executionGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'completed', route: executorRoute },
      audits: [passAudit('execution', 0)],
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'replanning',
      planGate: 'needs-replan',
      executionGate: 'needs-replan',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'revoked', route: executorRoute },
      audits: [
        passAudit('execution', 0),
        passAudit('execution', 1, { verdict: 'needs-replan' }),
      ],
    })
    expect(() => applyEvent(prior, event('audit', next))).toThrowError(/terminal/)
  })

  it('accepts resume-executor that increments executionRevision by 1', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 1, state: 'running', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
    })
    expect(applyEvent(prior, event('resume-executor', next)).executor?.executionRevision).toBe(2)
  })

  it('refuses resume-executor that swaps childId while incrementing revision', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 1, state: 'running', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c2', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
    })
    expect(() => applyEvent(prior, event('resume-executor', next))).toThrowError(/must keep childId and generation/)
  })

  it('refuses resume-executor that leaves running', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 1, state: 'running', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'completed', route: executorRoute },
    })
    expect(() => applyEvent(prior, event('resume-executor', next))).toThrowError(/running -> running/)
  })

  it('accepts start-executor that creates a starting executor from absent', () => {
    const prior = makeSnapshot({ phase: 'executing', planGate: 'pass' })
    const next = makeSnapshot({
      revision: 2,
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 1, state: 'starting', route: executorRoute },
    })
    expect(applyEvent(prior, event('start-executor', next)).executor?.state).toBe('starting')
  })

  it('accepts start-executor from a completed predecessor into starting at generation + 1', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'completed', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c2', generation: 2, executionRevision: 1, state: 'starting', route: executorRoute },
    })
    expect(applyEvent(prior, event('start-executor', next)).executor?.generation).toBe(2)
  })

  it('accepts start-executor starting-to-running with the same identity', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 1, state: 'starting', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'executing',
      planGate: 'pass',
      executor: {
        childId: 'c1',
        generation: 1,
        executionRevision: 1,
        state: 'running',
        route: { ...executorRoute, routeDiagnostic: 'dispatched' },
      },
    })
    expect(applyEvent(prior, event('start-executor', next)).executor?.state).toBe('running')
  })

  it('accepts start-executor starting-to-revoked with the same identity', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 1, state: 'starting', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'executing',
      planGate: 'pass',
      executor: {
        childId: 'c1',
        generation: 1,
        executionRevision: 1,
        state: 'revoked',
        route: { ...executorRoute, routeDiagnostic: 'executor startup failed' },
      },
      diagnostic: 'executor startup failed',
    })
    expect(applyEvent(prior, event('start-executor', next)).executor?.state).toBe('revoked')
  })

  it('refuses start-executor that resets a running executor to revision 1', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c2', generation: 2, executionRevision: 1, state: 'starting', route: executorRoute },
    })
    expect(() => applyEvent(prior, event('start-executor', next))).toThrowError(/cannot replace a live executor/)
  })

  it('refuses start-executor that keeps generation 1 after a completed generation-1 predecessor', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c1', generation: 1, executionRevision: 1, state: 'completed', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'executing',
      planGate: 'pass',
      executor: { childId: 'c2', generation: 1, executionRevision: 1, state: 'starting', route: executorRoute },
    })
    expect(() => applyEvent(prior, event('start-executor', next))).toThrowError(/generation 1 is not 2/)
  })

  it('REFUSES a submit-packet with no stamp when bearerBase is present', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      bearerBase: '/workspace',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'execution-reviewing',
      planGate: 'pass',
      bearerBase: '/workspace',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
      executionPacket: 'unstamped',
    })
    expect(() => applyEvent(prior, event('submit-packet', next)))
      .toThrowError(/required on current-format streams/)
  })

  it('REFUSES a current-format submit-packet that stamps revision without generation', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      bearerBase: '/workspace',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'execution-reviewing',
      planGate: 'pass',
      bearerBase: '/workspace',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
      executionPacket: 'partial stamp',
    })
    expect(() => applyEvent(prior, event('submit-packet', next, 2, { executionRevision: 2 })))
      .toThrowError(/generation is required/)
  })

  it('REFUSES a submit-packet whose generation matches a revoked predecessor not the live executor', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      bearerBase: '/workspace',
      executor: { childId: 'c2', generation: 2, executionRevision: 1, state: 'running', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'execution-reviewing',
      planGate: 'pass',
      bearerBase: '/workspace',
      executor: { childId: 'c2', generation: 2, executionRevision: 1, state: 'running', route: executorRoute },
      executionPacket: 'stale generation 1',
    })
    expect(() => applyEvent(prior, event('submit-packet', next, 2, {
      executionRevision: 1,
      generation: 1,
      childId: 'c1',
    }))).toThrowError(/generation 1 does not match live 2/)
  })

  it('accepts a current-format submit-packet stamped with live revision, generation, and childId', () => {
    const prior = makeSnapshot({
      phase: 'executing',
      planGate: 'pass',
      bearerBase: '/workspace',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
    })
    const next = makeSnapshot({
      revision: 2,
      phase: 'execution-reviewing',
      planGate: 'pass',
      bearerBase: '/workspace',
      executor: { childId: 'c1', generation: 1, executionRevision: 2, state: 'running', route: executorRoute },
      executionPacket: 'work v2',
    })
    expect(applyEvent(prior, event('submit-packet', next, 2, {
      executionRevision: 2,
      generation: 1,
      childId: 'c1',
    })).executionPacket).toBe('work v2')
  })
})

describe('canonicalBearer', () => {
  it('clamps parent segments at an absolute root', () => {
    expect(canonicalBearer('/test-run.txt', '/workspace')).toBe('/test-run.txt')
    expect(canonicalBearer('/../test-run.txt', '/workspace')).toBe('/test-run.txt')
  })

  it('keeps parent segments on a relative path, which names a different artifact', () => {
    const cwd = '/workspace/dsh-autopilot'
    expect(canonicalBearer('../test-run.txt', cwd)).not.toBe(canonicalBearer('test-run.txt', cwd))
    expect(canonicalBearer('../test-run.txt', cwd)).toBe('/workspace/test-run.txt')
  })

  it('reduces dot and self-canceling relative paths to empty', () => {
    expect(canonicalBearer('.')).toBe('')
    expect(canonicalBearer('foo/..')).toBe('')
  })

  it('clamps parent segments at a Windows drive-qualified root', () => {
    expect(canonicalBearer('C:\\test-run.txt')).toBe('C:/test-run.txt')
    expect(canonicalBearer('C:\\..\\test-run.txt')).toBe('C:/test-run.txt')
    expect(canonicalBearer('C:\\test-run.txt')).toBe(canonicalBearer('C:\\..\\test-run.txt'))
  })

  it('does not treat a drive letter without a slash as a root', () => {
    expect(canonicalBearer('C:foo', '/workspace')).toBe('/workspace/C:foo')
    expect(canonicalBearer('C:foo', '/workspace')).not.toBe('C:/foo')
  })

  it('treats a same-drive relative path as cwd-relative', () => {
    expect(canonicalBearer('C:foo', 'C:\\work')).toBe(canonicalBearer('foo', 'C:\\work'))
    expect(canonicalBearer('c:foo', 'C:\\work')).toBe(canonicalBearer('foo', 'C:\\work'))
    expect(canonicalBearer('C:foo', 'C:\\work')).toBe('C:/work/foo')
    expect(canonicalBearer('D:foo', 'C:\\work')).not.toBe(canonicalBearer('foo', 'C:\\work'))
  })

  it('treats a backslash-rooted path as current-drive relative when cwd has a drive', () => {
    expect(canonicalBearer('\\test-run.txt', 'C:\\work')).toBe('C:/test-run.txt')
    expect(canonicalBearer('\\test-run.txt', 'C:\\work')).toBe(canonicalBearer('C:\\test-run.txt'))
    expect(canonicalBearer('\\test-run.txt', '/home/runner')).toBe('/test-run.txt')
  })

  it('keeps a POSIX backslash in a relative bearer distinct from a slash', () => {
    expect(canonicalBearer('a\\b', '/workspace')).not.toBe(canonicalBearer('a/b', '/workspace'))
    expect(canonicalBearer('a\\b', 'C:\\work')).toBe(canonicalBearer('a/b', 'C:\\work'))
  })

  it('treats a forward-slash-rooted path as current-drive relative when cwd has a drive', () => {
    expect(canonicalBearer('/test-run.txt', 'C:\\work')).toBe('C:/test-run.txt')
    expect(canonicalBearer('/test-run.txt', 'C:\\work')).toBe(canonicalBearer('C:\\test-run.txt'))
    expect(canonicalBearer('/test-run.txt', 'C:\\work')).toBe(canonicalBearer('\\test-run.txt', 'C:\\work'))
    expect(canonicalBearer('/test-run.txt', '/workspace')).toBe('/test-run.txt')
    expect(canonicalBearer('//server/share/foo', 'C:\\work')).toBe('//server/share/foo')
  })

  it('treats rooted \\ and / as the UNC share root when cwd is a UNC share', () => {
    const cwd = '\\\\server\\share\\work'
    expect(canonicalBearer('\\report.txt', cwd)).toBe('//server/share/report.txt')
    expect(canonicalBearer('/report.txt', cwd)).toBe('//server/share/report.txt')
    expect(canonicalBearer('\\report.txt', cwd)).toBe(canonicalBearer('\\\\server\\share\\report.txt'))
    expect(canonicalBearer('/report.txt', cwd)).toBe(canonicalBearer('\\report.txt', cwd))
    expect(canonicalBearer('report.txt', cwd)).toBe('//server/share/work/report.txt')
    expect(canonicalBearer('\\report.txt', '\\\\server')).toBe('/report.txt')
  })

  it('uppercases a Windows drive letter so mixed-case aliases collide', () => {
    expect(canonicalBearer('c:\\test-run.txt')).toBe('C:/test-run.txt')
    expect(canonicalBearer('C:\\test-run.txt')).toBe(canonicalBearer('c:\\test-run.txt'))
  })

  it('lowercases remaining Windows drive path components', () => {
    expect(canonicalBearer('C:\\Run\\Evidence.txt')).toBe('C:/run/evidence.txt')
    expect(canonicalBearer('C:\\Run\\Evidence.txt')).toBe(canonicalBearer('c:\\run\\evidence.txt'))
  })

  it('keeps relative and POSIX-absolute path case under a POSIX cwd', () => {
    expect(canonicalBearer('Evidence.txt', '/workspace')).not.toBe(canonicalBearer('evidence.txt', '/workspace'))
    expect(canonicalBearer('/Evidence.txt', '/workspace')).not.toBe(canonicalBearer('/evidence.txt', '/workspace'))
  })

  it('resolves a nonempty relative bearer against an absolute cwd', () => {
    expect(canonicalBearer('test-run.txt', '/workspace/dsh-autopilot')).toBe(
      canonicalBearer('/workspace/dsh-autopilot/test-run.txt', '/workspace/dsh-autopilot'),
    )
    expect(canonicalBearer('test-run.txt', '/workspace/dsh-autopilot')).toBe(
      '/workspace/dsh-autopilot/test-run.txt',
    )
  })

  it('collapses a POSIX double slash instead of reading it as a UNC share', () => {
    // Codex 3911097402: on a POSIX host Node resolves both spellings to one
    // file, so keeping `//workspace/...` as a UNC share let one artifact bear
    // two criteria.
    expect(canonicalBearer('//workspace/report.txt', '/workspace')).toBe('/workspace/report.txt')
    expect(canonicalBearer('//workspace/report.txt', '/workspace'))
      .toBe(canonicalBearer('/workspace/report.txt', '/workspace'))
    expect(canonicalBearer('//server/share/x', '/home/runner')).toBe('/server/share/x')
  })

  it('still reads // as a UNC share when Windows semantics are established', () => {
    // DETECTOR for the case above: the UNC branch was gated, not deleted. A
    // UNC cwd, a drive-qualified cwd, or a backslash bearer each still say
    // Windows.
    expect(canonicalBearer('//srv/share/report.txt', '\\\\srv\\share'))
      .toBe(canonicalBearer('\\\\srv\\share\\report.txt', '\\\\srv\\share'))
    expect(canonicalBearer('//srv/share/report.txt', '\\\\srv\\share')).toBe('//srv/share/report.txt')
    expect(canonicalBearer('//srv/share/x', 'C:\\work')).toBe('//srv/share/x')
    // Legacy arm (Codex 3932312256): an empty cwd is a snapshot with no
    // bearerBase, which was folded with `//` read as UNC when it was written.
    expect(canonicalBearer('//server/share/x', '')).toBe('//server/share/x')
    expect(canonicalBearer('//server/share/x', '/home/runner')).toBe('/server/share/x')
  })

  it('clamps parent segments at a UNC share root', () => {
    expect(canonicalBearer('\\\\server\\share\\foo.txt')).toBe('//server/share/foo.txt')
    expect(canonicalBearer('\\\\server\\share\\..\\foo.txt')).toBe('//server/share/foo.txt')
    expect(canonicalBearer('\\\\server\\share\\foo.txt')).toBe(
      canonicalBearer('\\\\server\\share\\..\\foo.txt'),
    )
  })

  it('does not treat a host-only UNC as a share root', () => {
    expect(canonicalBearer('\\\\server')).toBe('/server')
    expect(canonicalBearer('\\\\server\\')).toBe('/server')
  })

  it('lowercases UNC host, share, and remainder', () => {
    expect(canonicalBearer('\\\\Server\\Share\\Foo.txt')).toBe('//server/share/foo.txt')
    expect(canonicalBearer('\\\\Server\\Share\\Foo.txt')).toBe(
      canonicalBearer('\\\\server\\share\\foo.txt'),
    )
  })
})

describe('evaluateCompletion', () => {
  const goodCloseout = {
    summary: 'done',
    changedFiles: ['a.ts'],
    commands: ['pnpm test - pass'],
    evidence: [{ criterion: 'tests pass', bearer: 'test-run.txt', status: 'proven' as const }],
    residualRisks: [],
    exclusions: [],
    workspaceCleanup: 'nothing created',
    drift: 'none found',
  }

  function completable(overrides: Partial<Snapshot> = {}): Snapshot {
    return makeSnapshot({
      phase: 'closing',
      planGate: 'pass',
      executionGate: 'pass',
      audits: [passAudit('plan', 0), passAudit('execution', 1)],
      closeout: goodCloseout,
      ...overrides,
    })
  }

  it('passes a complete snapshot', () => {
    const check = evaluateCompletion(completable())
    expect(check.problems).toEqual([])
    expect(check.ok).toBe(true)
  })

  it('fails without closeout', () => {
    const check = evaluateCompletion(completable({ closeout: undefined }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/closeout not submitted/)
  })

  it('fails when a criterion has no evidence entry', () => {
    const check = evaluateCompletion(completable({
      closeout: { ...goodCloseout, evidence: [{ criterion: 'other', bearer: 'x', status: 'proven' }] },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/no evidence entry/)
  })

  it('fails when a criterion has two evidence entries (Single-Bearer)', () => {
    const check = evaluateCompletion(completable({
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'a', status: 'proven' },
          { criterion: 'tests pass', bearer: 'b', status: 'proven' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/exactly one/)
  })

  it('fails a proven bearer that canonicalizes to empty, including two that would otherwise skip the reuse map', () => {
    const one = evaluateCompletion(completable({
      closeout: {
        ...goodCloseout,
        evidence: [{ criterion: 'tests pass', bearer: '.', status: 'proven' }],
      },
    }))
    expect(one.ok).toBe(false)
    expect(one.problems.join(';')).toMatch(/canonicalizes to empty/)

    const two = evaluateCompletion(completable({
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: '.', status: 'proven' },
          { criterion: 'lint clean', bearer: 'foo/..', status: 'proven' },
        ],
      },
    }))
    expect(two.ok).toBe(false)
    expect(two.problems.join(';')).toMatch(/canonicalizes to empty/)
    expect(two.problems.join(';')).not.toMatch(/bears 2 proven criteria/)
  })

  it('fails two proven criteria whose absolute bearers differ only by a root parent segment', () => {
    const check = evaluateCompletion(completable({
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: '/test-run.txt', status: 'proven' },
          { criterion: 'lint clean', bearer: '/../test-run.txt', status: 'proven' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('fails two proven criteria whose bearers are path aliases of one artifact', () => {
    const check = evaluateCompletion(completable({
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'test-run.txt', status: 'proven' },
          { criterion: 'lint clean', bearer: './test-run.txt', status: 'proven' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('fails two proven criteria that share a UNC share-root alias', () => {
    const check = evaluateCompletion(completable({
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: '\\\\server\\share\\foo.txt', status: 'proven' },
          { criterion: 'lint clean', bearer: '\\\\server\\share\\..\\foo.txt', status: 'proven' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('fails two proven criteria that share a Windows drive-root-relative alias', () => {
    const check = evaluateCompletion(completable({
      bearerBase: 'C:\\work',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'C:\\test-run.txt', status: 'proven' },
          { criterion: 'lint clean', bearer: '\\test-run.txt', status: 'proven' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('fails two proven criteria that share a UNC share-root-relative alias', () => {
    const check = evaluateCompletion(completable({
      bearerBase: '\\\\server\\share\\work',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: '\\\\server\\share\\report.txt', status: 'proven' },
          { criterion: 'lint clean', bearer: '\\report.txt', status: 'proven' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('fails two proven criteria that share a forward-slash Windows current-drive root', () => {
    const check = evaluateCompletion(completable({
      bearerBase: 'C:\\work',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'C:\\test-run.txt', status: 'proven' },
          { criterion: 'lint clean', bearer: '/test-run.txt', status: 'proven' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('fails two proven criteria that share a relative path and its cwd-absolute twin', () => {
    const check = evaluateCompletion(completable({
      bearerBase: '/workspace/dsh-autopilot',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'test-run.txt', status: 'proven' },
          { criterion: 'lint clean', bearer: '/workspace/dsh-autopilot/test-run.txt', status: 'proven' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('joins relatives against stamped bearerBase, not process.cwd()', () => {
    const collide = evaluateCompletion(completable({
      bearerBase: '/a',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'x', status: 'proven' },
          { criterion: 'lint clean', bearer: '/a/x', status: 'proven' },
        ],
      },
    }))
    expect(collide.ok).toBe(false)
    expect(collide.problems.join(';')).toMatch(/bears 2 proven criteria/)
    const distinct = evaluateCompletion(completable({
      bearerBase: '/b',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'x', status: 'proven' },
          { criterion: 'lint clean', bearer: '/a/x', status: 'proven' },
        ],
      },
    }))
    expect(distinct.problems.join(';')).not.toMatch(/bears 2 proven criteria/)
  })

  it('collides a multi-component spaced relative path with its bearerBase-absolute twin', () => {
    const check = evaluateCompletion(completable({
      bearerBase: '/workspace',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'dir name/sub dir/file.txt', status: 'proven' },
          { criterion: 'lint clean', bearer: '/workspace/dir name/sub dir/file.txt', status: 'proven' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('collides an extensionless spaced filename with its bearerBase-absolute twin', () => {
    const check = evaluateCompletion(completable({
      bearerBase: '/workspace',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'release notes', status: 'proven' },
          { criterion: 'lint clean', bearer: '/workspace/release notes', status: 'proven' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('does not collide POSIX backslash and slash relatives under a POSIX bearerBase', () => {
    const check = evaluateCompletion(completable({
      bearerBase: '/workspace',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'a\\b', status: 'proven' },
          { criterion: 'lint clean', bearer: 'a/b', status: 'proven' },
        ],
      },
    }))
    expect(check.problems.join(';')).not.toMatch(/bears 2 proven criteria/)
  })

  it('collides Windows backslash and slash relatives under a drive-qualified bearerBase', () => {
    const check = evaluateCompletion(completable({
      bearerBase: 'C:\\work',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'a\\b', status: 'proven' },
          { criterion: 'lint clean', bearer: 'a/b', status: 'proven' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('does not collide a whitespace command bearer with a path-shaped name', () => {
    const check = evaluateCompletion(completable({
      bearerBase: '/ws',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'git diff a/../b', status: 'proven' },
          { criterion: 'lint clean', bearer: 'b', status: 'proven' },
        ],
      },
    }))
    expect(check.problems.join(';')).not.toMatch(/bears 2 proven criteria/)
  })

  it('collides a spaced directory relative path with its bearerBase-absolute twin', () => {
    const check = evaluateCompletion(completable({
      bearerBase: '/workspace',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'dir name/file.txt', status: 'proven' },
          { criterion: 'lint clean', bearer: '/workspace/dir name/file.txt', status: 'proven' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('collides a spaced relative path with its bearerBase-absolute twin', () => {
    const check = evaluateCompletion(completable({
      bearerBase: '/workspace',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'my file.txt', status: 'proven' },
          { criterion: 'lint clean', bearer: '/workspace/my file.txt', status: 'proven' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('collides spaced path aliases that start with ./ or contain a slash in the first token', () => {
    const dotted = evaluateCompletion(completable({
      bearerBase: '/workspace',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: './my file.txt', status: 'proven' },
          { criterion: 'lint clean', bearer: 'my file.txt', status: 'proven' },
        ],
      },
    }))
    expect(dotted.ok).toBe(false)
    expect(dotted.problems.join(';')).toMatch(/bears 2 proven criteria/)
    const nested = evaluateCompletion(completable({
      bearerBase: '/ws',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'foo/my file.txt', status: 'proven' },
          { criterion: 'lint clean', bearer: '/ws/foo/my file.txt', status: 'proven' },
        ],
      },
    }))
    expect(nested.ok).toBe(false)
    expect(nested.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('collides a spaced Windows drive path with its slash-folded twin', () => {
    const check = evaluateCompletion(completable({
      bearerBase: 'C:\\work',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'C:\\my dir\\file.txt', status: 'proven' },
          { criterion: 'lint clean', bearer: 'C:/my dir/file.txt', status: 'proven' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('still collides path-shaped aliases after collapsing parent segments', () => {
    const check = evaluateCompletion(completable({
      bearerBase: '/ws',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'a/../b', status: 'proven' },
          { criterion: 'lint clean', bearer: 'b', status: 'proven' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('does not join relatives when bearerBase is absent', () => {
    const abs = canonicalBearer('x', process.cwd())
    if (abs === 'x') return
    const check = evaluateCompletion(completable({
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'x', status: 'proven' },
          { criterion: 'lint clean', bearer: abs, status: 'proven' },
        ],
      },
    }))
    expect(check.problems.join(';')).not.toMatch(/bears 2 proven criteria/)
  })

  it('fails two proven criteria that share mixed-case Windows path components', () => {
    const check = evaluateCompletion(completable({
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'C:\\Run\\Evidence.txt', status: 'proven' },
          { criterion: 'lint clean', bearer: 'c:\\run\\evidence.txt', status: 'proven' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('fails two proven criteria that share mixed-case Windows drive aliases', () => {
    const check = evaluateCompletion(completable({
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'C:\\test-run.txt', status: 'proven' },
          { criterion: 'lint clean', bearer: 'c:\\test-run.txt', status: 'proven' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('fails two proven criteria that share a Windows drive-root alias', () => {
    const check = evaluateCompletion(completable({
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'C:\\test-run.txt', status: 'proven' },
          { criterion: 'lint clean', bearer: 'C:\\..\\test-run.txt', status: 'proven' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('fails two proven criteria that share one bearer (reverse Single-Bearer)', () => {
    const check = evaluateCompletion(completable({
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'test-run.txt', status: 'proven' },
          { criterion: 'lint clean', bearer: 'test-run.txt', status: 'proven' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('two unproven criteria with empty bearers do not collide on the reverse Single-Bearer map', () => {
    const check = evaluateCompletion(completable({
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: '', status: 'unproven' },
          { criterion: 'lint clean', bearer: '', status: 'unproven' },
        ],
      },
    }))
    expect(check.problems.join(';')).not.toMatch(/bears \d+ proven criteria/)
    expect(check.ok).toBe(true)
  })

  it('fails a proven entry with an empty bearer', () => {
    const check = evaluateCompletion(completable({
      closeout: { ...goodCloseout, evidence: [{ criterion: 'tests pass', bearer: '  ', status: 'proven' }] },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/empty bearer/)
  })

  it('fails an evidence status that is not proven or unproven', () => {
    const check = evaluateCompletion(completable({
      closeout: {
        ...goodCloseout,
        evidence: [{ criterion: 'tests pass', bearer: 'x', status: 'proved' as 'proven' }],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/not proven or unproven/)
  })

  it('latest-wins: a stale execution pass behind a needs-fix does not complete', () => {
    const check = evaluateCompletion(completable({
      audits: [
        passAudit('plan', 0),
        passAudit('execution', 1),
        passAudit('execution', 2, { verdict: 'needs-fix' }),
      ],
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/execution latest verdict is needs-fix/)
  })

  it('independent mode refuses a self-check pass as provenance', () => {
    const check = evaluateCompletion(completable({
      triage: makeTriage({ auditMode: 'independent', size: 'standard', risk: 'medium' }),
      audits: [
        passAudit('plan', 0),
        passAudit('execution', 1, {
          auditorId: 'self-check',
          route: { provider: 'self-check', routeProvider: 'self-check', routeModel: 'self-check', routeStatus: 'unverified' },
        }),
      ],
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/self-check; independent mode requires/)
  })

  it('requires the rules role when the run touches the operating layer', () => {
    const check = evaluateCompletion(completable({
      triage: makeTriage({ touchesOperatingLayer: true }),
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/required audit role has no record: rules/)
  })

  // --- Checks that were live in shipped code and unobservable by the suite.
  //
  // Every rule below was confirmed unguarded by mutation against the
  // 2026-08-25 tree: deleting the line it names left all 17 files / 468 tests
  // green. Each new case asserts the EXACT problems array rather than a
  // non-empty count, so it resolves its own rule by value and cannot be
  // satisfied by some neighbouring check firing instead (DESIGN.md §5).

  it('refuses completion while either gate is still pending', () => {
    expect(evaluateCompletion(completable({ planGate: 'pending' })).problems)
      .toEqual(['planGate is pending, must be pass'])
    expect(evaluateCompletion(completable({ executionGate: 'pending' })).problems)
      .toEqual(['executionGate is pending, must be pass'])
    // DETECTOR: both gates passing is the only difference from the cases above.
    expect(evaluateCompletion(completable()).problems).toEqual([])
  })

  it('refuses an empty acceptance-criteria list (cardinality floor)', () => {
    // DESIGN.md §5 cites this exact line as this repository's own worked
    // example of the Checker-Resolution invariant. Without it the
    // per-criterion loop iterates zero times, so nothing else looks at the
    // list and a run completes having proven nothing.
    const check = evaluateCompletion(completable({ triage: makeTriage({ acceptanceCriteria: [] }) }))
    expect(check.ok).toBe(false)
    expect(check.problems).toEqual(['acceptance criteria list is empty'])
  })

  it('refuses an empty evidence list, separately from the per-criterion rule', () => {
    // Two distinct problems, so deleting EITHER line alone still turns this red.
    const check = evaluateCompletion(completable({ closeout: { ...goodCloseout, evidence: [] } }))
    expect(check.ok).toBe(false)
    expect(check.problems).toEqual([
      'evidence list is empty',
      'criterion has no evidence entry: tests pass',
    ])
  })

  it('refuses a closeout whose discipline fields are blank', () => {
    const blanks = [
      [{ ...goodCloseout, summary: '  ' }, 'closeout summary is empty'],
      [{ ...goodCloseout, workspaceCleanup: '' }, 'closeout workspaceCleanup is empty'],
      [{ ...goodCloseout, drift: '	' }, 'closeout drift is empty (use "none found")'],
    ] as const
    // Cardinality floor: one case per mandatory closeout field.
    expect(blanks.length).toBe(3)
    for (const [closeout, message] of blanks) {
      expect(evaluateCompletion(completable({ closeout })).problems).toEqual([message])
    }
    // DETECTOR: the same closeout with all three populated completes clean.
    expect(evaluateCompletion(completable()).problems).toEqual([])
  })

  it('refuses a delegated run whose executor is missing or unfinished', () => {
    // The engine's happy path rewrites the executor to 'completed' when the
    // execution audit passes, so no engine test can reach either arm; both are
    // reachable only on the replay path this function defends (a hand-edited
    // stream, a buggy writer, an older build) with a child that was revoked or
    // abandoned mid-flight.
    const delegated = makeTriage({ size: 'standard', executionMode: 'delegated', auditMode: 'independent' })
    const executor = (state: ExecutorRecord['state']): ExecutorRecord => ({
      childId: 'child-1',
      generation: 1,
      executionRevision: 1,
      state,
      route: { provider: 'spawn', routeProvider: 'p', routeModel: 'm', routeStatus: 'verified' },
    })

    expect(evaluateCompletion(completable({ triage: delegated })).problems)
      .toEqual(['delegated run has no executor record'])

    const unfinished = ['starting', 'running', 'revoked'] as const
    // Cardinality floor: every non-'completed' state of ExecutorRecord.
    expect(unfinished.length).toBe(3)
    for (const state of unfinished) {
      expect(evaluateCompletion(completable({ triage: delegated, executor: executor(state) })).problems)
        .toEqual([`delegated executor state is ${state}, must be completed`])
    }

    // DETECTOR: the same run with a completed executor has nothing to report,
    // so the three assertions above are about the STATE, not about delegation.
    expect(evaluateCompletion(completable({ triage: delegated, executor: executor('completed') })).problems)
      .toEqual([])
  })

  it('collides a POSIX double-slash alias with its single-slash twin', () => {
    const check = evaluateCompletion(completable({
      bearerBase: '/workspace',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: '//workspace/report.txt', status: 'proven', kind: 'path' },
          { criterion: 'lint clean', bearer: '/workspace/report.txt', status: 'proven', kind: 'path' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('collides a forward-slash UNC alias with its backslash twin under a UNC bearerBase', () => {
    // DETECTOR: the POSIX fold above did not cost the UNC reading.
    const check = evaluateCompletion(completable({
      bearerBase: '\\\\srv\\share',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: '//srv/share/report.txt', status: 'proven', kind: 'path' },
          { criterion: 'lint clean', bearer: '\\\\srv\\share\\report.txt', status: 'proven', kind: 'path' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('collides a relative bearer with its absolute twin under a bearerBase ending in a space', () => {
    // Codex 3911097406, at the seam the finding is actually about.
    const check = evaluateCompletion(completable({
      bearerBase: '/workspace/project ',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'report.txt', status: 'proven', kind: 'path' },
          { criterion: 'lint clean', bearer: '/workspace/project /report.txt', status: 'proven', kind: 'path' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  // --- Declared evidence kinds (Codex 3911205493). The shape heuristic could
  // not tell `git status` from a file called `git status`, and every attempt to
  // tune it moved real closeouts between "accepted" and "rejected as reused".
  // The writer declares which it produced; nothing here guesses.

  it('does not collide a command bearer with a path bearer of the same text', () => {
    const check = evaluateCompletion(completable({
      bearerBase: '/ws',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'git status', status: 'proven', kind: 'command' },
          { criterion: 'lint clean', bearer: './git status', status: 'proven', kind: 'path' },
        ],
      },
    }))
    // The exact pre-`kind` defect: both folded to `/ws/git status`.
    expect(check.problems).toEqual([])
    expect(check.ok).toBe(true)
  })

  it('collides two command bearers whose text is byte-identical', () => {
    // DETECTOR for the case above: 'command' is not "never compared", it is
    // "compared verbatim". One command output cannot bear two criteria.
    const check = evaluateCompletion(completable({
      bearerBase: '/ws',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: 'git status', status: 'proven', kind: 'command' },
          { criterion: 'lint clean', bearer: 'git status', status: 'proven', kind: 'command' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('collides two declared path kinds that name one file under bearerBase', () => {
    const check = evaluateCompletion(completable({
      bearerBase: '/ws',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: './x/y.txt', status: 'proven', kind: 'path' },
          { criterion: 'lint clean', bearer: '/ws/x/y.txt', status: 'proven', kind: 'path' },
        ],
      },
    }))
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('refuses a proven entry with no kind under requireKind, and leaves unproven entries alone', () => {
    const check = evaluateCompletion(completable({
      bearerBase: '/ws',
      closeout: {
        ...goodCloseout,
        evidence: [{ criterion: 'tests pass', bearer: 'test-run.txt', status: 'proven' }],
      },
    }), { requireKind: true })
    expect(check.ok).toBe(false)
    expect(check.problems).toEqual([
      'proven evidence entry has no kind: tests pass (kind must be "path" or "command")',
    ])

    // An honest gap claims no artifact, so there is no kind to declare. This
    // is the CONTRACT, ruled by the owner on PR #5 (CodeRabbit asked for the
    // opposite): the stamp means "proven evidence kind validation v1", the
    // tool schema is the stricter surface that requires `kind` on every item,
    // and the engine/replay layer does not invent a kind for an empty bearer.
    const unproven = evaluateCompletion(completable({
      bearerBase: '/ws',
      closeout: {
        ...goodCloseout,
        evidence: [{ criterion: 'tests pass', bearer: '', status: 'unproven' }],
      },
    }), { requireKind: true })
    expect(unproven.problems).toEqual([])
  })

  it('does not read a command whose text equals a path\'s folded form as that path reused', () => {
    // Codex 3932312241 on PR #5: the reverse Single-Bearer key carries the
    // kind, so `command` "/ws/check" and `path` "/ws/check" are two artifacts.
    const check = evaluateCompletion(completable({
      bearerBase: '/ws',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: '/ws/check', status: 'proven', kind: 'command' },
          { criterion: 'lint clean', bearer: './check', status: 'proven', kind: 'path' },
        ],
      },
    }))
    expect(check.problems.join(';')).not.toMatch(/bears 2 proven criteria/)

    // DETECTOR: within one kind the collision is still observed, and the
    // message names the kind.
    const same = evaluateCompletion(completable({
      bearerBase: '/ws',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: '/ws/check', status: 'proven', kind: 'path' },
          { criterion: 'lint clean', bearer: './check', status: 'proven', kind: 'path' },
        ],
      },
    }))
    expect(same.problems.join(';')).toMatch(/artifact path \/ws\/check bears 2 proven criteria/)
  })

  it('keeps the UNC reading of a raw // bearer on a legacy snapshot with no bearerBase', () => {
    // Codex 3932312256 on PR #5: a pre-bearerBase closeout that cited
    // //server/share/x and /server/share/x as two artifacts was valid when
    // written; the POSIX fold must not retroactively refuse it.
    for (const kind of ['path', undefined] as const) {
      const check = evaluateCompletion(completable({
        triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
        closeout: {
          ...goodCloseout,
          evidence: [
            { criterion: 'tests pass', bearer: '//server/share/x', status: 'proven', ...(kind === undefined ? {} : { kind }) },
            { criterion: 'lint clean', bearer: '/server/share/x', status: 'proven', ...(kind === undefined ? {} : { kind }) },
          ],
        },
      }))
      expect(check.problems.join(';')).not.toMatch(/bears 2 proven criteria/)
    }

    // DETECTOR: with a POSIX base the same pair IS one artifact.
    const based = evaluateCompletion(completable({
      bearerBase: '/workspace',
      triage: makeTriage({ acceptanceCriteria: ['tests pass', 'lint clean'] }),
      closeout: {
        ...goodCloseout,
        evidence: [
          { criterion: 'tests pass', bearer: '//server/share/x', status: 'proven', kind: 'path' },
          { criterion: 'lint clean', bearer: '/server/share/x', status: 'proven', kind: 'path' },
        ],
      },
    }))
    expect(based.problems.join(';')).toMatch(/bears 2 proven criteria/)
  })

  it('falls back to the shape heuristic for a kind-less proven entry when requireKind is off', () => {
    // The legacy arm, and the reason `kind` is optional on the type: a stream
    // written before the field existed still evaluates.
    const check = evaluateCompletion(completable({
      bearerBase: '/ws',
      closeout: {
        ...goodCloseout,
        evidence: [{ criterion: 'tests pass', bearer: 'test-run.txt', status: 'proven' }],
      },
    }))
    expect(check.problems).toEqual([])
    expect(check.ok).toBe(true)
  })

  it('refuses an unknown kind whether requireKind is on or off', () => {
    // A string that is neither value is a CORRUPT entry, not an old one, so
    // the legacy arm must not absorb it.
    const closeout = {
      ...goodCloseout,
      evidence: [{
        criterion: 'tests pass',
        bearer: 'test-run.txt',
        status: 'proven' as const,
        kind: 'sketch' as unknown as EvidenceKind,
      }],
    }
    const expected = ['evidence kind is not "path" or "command": tests pass ("sketch")']
    expect(evaluateCompletion(completable({ bearerBase: '/ws', closeout })).problems).toEqual(expected)
    expect(evaluateCompletion(completable({ bearerBase: '/ws', closeout }), { requireKind: true }).problems)
      .toEqual(expected)
  })
})

describe('submit-closeout evidence-kind stamp', () => {
  // WHY THE STAMP EXISTS: `bearerBase` has been stamped since PR #4, so it
  // cannot serve as the current-format test for `kind` the way it does for the
  // packet identity stamp — every closeout already completed on main carries a
  // base and no kinds, and reusing that test would stop history replaying.

  function closeoutWith(kind?: EvidenceKind) {
    return {
      summary: 'done',
      changedFiles: ['a.ts'],
      commands: ['pnpm test - pass'],
      evidence: [{
        criterion: 'tests pass',
        bearer: 'test-run.txt',
        status: 'proven' as const,
        ...(kind === undefined ? {} : { kind }),
      }],
      residualRisks: [],
      exclusions: [],
      workspaceCleanup: 'nothing created',
      drift: 'none found',
    }
  }

  const base = {
    planGate: 'pass' as const,
    executionGate: 'pass' as const,
    audits: [passAudit('plan', 0), passAudit('execution', 1)],
    bearerBase: '/ws',
  }
  const closing = (): Snapshot => makeSnapshot({ ...base, revision: 9, phase: 'closing' })
  const completed = (kind?: EvidenceKind): Snapshot =>
    makeSnapshot({ ...base, revision: 10, phase: 'completed', closeout: closeoutWith(kind) })

  function codeOf(run: () => unknown): string {
    try {
      run()
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AutopilotError)
      return (error as AutopilotError).code
    }
    throw new Error('expected a throw')
  }

  it('refuses a kind-less proven entry on a stamped event', () => {
    expect(codeOf(() => applyEvent(closing(), event('submit-closeout', completed(), 10, { evidenceKinds: 1 }))))
      .toBe('AP_EVIDENCE_KIND_REQUIRED')
  })

  it('accepts the same stamped event once the entry declares its kind', () => {
    // DETECTOR: the stamp is not refusing every closeout, only kind-less ones.
    const folded = applyEvent(closing(), event('submit-closeout', completed('path'), 10, { evidenceKinds: 1 }))
    expect(folded.phase).toBe('completed')
  })

  it('replays an UNSTAMPED closeout carrying the same kind-less entry', () => {
    // The whole point: streams written before this change still fold. Note the
    // snapshot also carries a bearerBase, which is what makes this case
    // impossible to answer with the packet stamp's "bearerBase present" test.
    const folded = applyEvent(closing(), event('submit-closeout', completed(), 10))
    expect(folded.phase).toBe('completed')
    expect(folded.closeout?.evidence[0]?.kind).toBeUndefined()
  })

  it('refuses a stamp that is not the integer 1', () => {
    for (const stamped of [2, '1', true, null, 1.5]) {
      expect(codeOf(() => applyEvent(
        closing(),
        event('submit-closeout', completed('path'), 10, { evidenceKinds: stamped }),
      ))).toBe('AP_EVIDENCE_KIND_STAMP_INVALID')
    }
  })

  it('refuses an unknown kind on a stamped event with the INVALID code, not the REQUIRED one', () => {
    const snapshot = makeSnapshot({
      ...base,
      revision: 10,
      phase: 'completed',
      closeout: {
        ...closeoutWith(),
        evidence: [{
          criterion: 'tests pass',
          bearer: 'test-run.txt',
          status: 'proven' as const,
          kind: 'sketch' as unknown as EvidenceKind,
        }],
      },
    })
    expect(codeOf(() => applyEvent(closing(), event('submit-closeout', snapshot, 10, { evidenceKinds: 1 }))))
      .toBe('AP_EVIDENCE_KIND_INVALID')
  })
})

describe('usage-evidence fold rules', () => {
  const declared = { id: 'm1', usageClass: 'cli' as const, boundaryStates: ['empty'], artifacts: [], attempted: [] }
  const second = { id: 'm2', usageClass: 'docs' as const, boundaryStates: [], artifacts: [], attempted: [] }

  it('accepts declare-usage from planning, replanning and executing', () => {
    for (const phase of ['planning', 'replanning', 'executing'] as const) {
      const prior = makeSnapshot({ phase, usage: { entries: [] } }, { size: 'standard', risk: 'medium', auditMode: 'independent' })
      const next = makeSnapshot(
        { phase, revision: 2, usage: { entries: [declared] } },
        { size: 'standard', risk: 'medium', auditMode: 'independent' },
      )
      expect(applyEvent(prior, event('declare-usage', next)).usage?.entries.length).toBe(1)
    }
  })

  it('ACCEPTS declare-usage from closing (answering late beats a liveness dead end)', () => {
    // `closing` used to refuse it, which made one sequence unrecoverable: an
    // entry reverted to 'undeclared' during execution reaches `closing`, where
    // `submit-closeout` refuses it AND the entry cannot be re-declared. The only
    // exits were set-blocked, or set-owner-decision -> owner-resolve
    // (resume-planning), which resets the plan gate and forces the whole cycle
    // to be redone — and the refusal message named neither.
    const prior = makeSnapshot({ phase: 'closing', usage: { entries: [] } }, { size: 'standard', risk: 'medium', auditMode: 'independent' })
    const next = makeSnapshot(
      { phase: 'closing', revision: 2, usage: { entries: [declared] } },
      { size: 'standard', risk: 'medium', auditMode: 'independent' },
    )
    expect(applyEvent(prior, event('declare-usage', next)).usage?.entries.length).toBe(1)
  })

  it('rejects declare-usage from the review phases (nothing is being planned or built there)', () => {
    for (const phase of ['plan-reviewing', 'execution-reviewing'] as const) {
      const prior = makeSnapshot({ phase, usage: { entries: [] } }, { size: 'standard', risk: 'medium', auditMode: 'independent' })
      const next = makeSnapshot(
        { phase, revision: 2, usage: { entries: [declared] } },
        { size: 'standard', risk: 'medium', auditMode: 'independent' },
      )
      expect(() => applyEvent(prior, event('declare-usage', next))).toThrowError(/is illegal in phase/)
    }
  })

  it('accepts an appended entry and a replaced entry', () => {
    const prior = makeSnapshot({ usage: { entries: [declared] } })
    const appended = makeSnapshot({ revision: 2, usage: { entries: [declared, second] } })
    expect(applyEvent(prior, event('declare-usage', appended)).usage?.entries.length).toBe(2)

    const upgraded = { ...declared, usageClass: 'gui' as const, boundaryStates: ['empty', 'error-path'] }
    const replaced = makeSnapshot({ revision: 2, usage: { entries: [upgraded] } })
    expect(applyEvent(prior, event('declare-usage', replaced)).usage?.entries[0]?.usageClass).toBe('gui')
  })

  it('rejects a dropped entry id — a run may not answer the usage question by deleting it', () => {
    const prior = makeSnapshot({ usage: { entries: [declared, second] } })
    const shrunk = makeSnapshot({ revision: 2, usage: { entries: [second] } })
    expect(() => applyEvent(prior, event('declare-usage', shrunk))).toThrowError(/usage entry m1 was dropped/)
  })

  it('rejects the whole dimension disappearing', () => {
    const prior = makeSnapshot({ usage: { entries: [declared] } })
    const gone = makeSnapshot({ revision: 2 })
    expect(gone.usage).toBeUndefined()
    expect(() => applyEvent(prior, event('log', gone))).toThrowError(/usage evidence disappeared/)
  })

  it('leaves a legacy stream (no usage at all) untouched by any of these rules', () => {
    const prior = makeSnapshot()
    expect(prior.usage).toBeUndefined()
    const next = makeSnapshot({ revision: 2, logCount: 1 })
    expect(applyEvent(prior, event('log', next)).logCount).toBe(1)
  })
})

describe('planGatePassedAt is write-once', () => {
  const FIRST = '2026-08-24T10:00:00.000Z'

  it('accepts the first stamp', () => {
    const prior = makeSnapshot({ plan: { revision: 1, text: 'p' } })
    const next = makeSnapshot({ revision: 2, plan: { revision: 1, text: 'p' }, planGatePassedAt: FIRST })
    expect(applyEvent(prior, event('audit', next)).planGatePassedAt).toBe(FIRST)
  })

  it('accepts carrying the same stamp forward', () => {
    const prior = makeSnapshot({ planGatePassedAt: FIRST })
    const next = makeSnapshot({ revision: 2, planGatePassedAt: FIRST, logCount: 1 })
    expect(applyEvent(prior, event('log', next)).planGatePassedAt).toBe(FIRST)
  })

  it('rejects a restamp — re-anchoring would silently re-admit pre-gate artifacts', () => {
    const prior = makeSnapshot({ planGatePassedAt: FIRST })
    const next = makeSnapshot({ revision: 2, planGatePassedAt: '2026-08-24T11:00:00.000Z' })
    expect(() => applyEvent(prior, event('audit', next))).toThrowError(/planGatePassedAt was restamped/)
  })

  it('rejects clearing the stamp', () => {
    const prior = makeSnapshot({ planGatePassedAt: FIRST })
    const next = makeSnapshot({ revision: 2 })
    expect(() => applyEvent(prior, event('log', next))).toThrowError(/planGatePassedAt was restamped/)
  })
})

describe('plan gate / usage coupling in the FOLD', () => {
  /** A run parked in plan-reviewing whose single usage entry is still undeclared. */
  function undeclaredPrior(): Snapshot {
    return makeSnapshot({
      phase: 'plan-reviewing',
      plan: { revision: 1, text: 'p' },
      usage: { entries: [{ id: 'm1', usageClass: 'undeclared', boundaryStates: [], artifacts: [], attempted: [] }] },
    })
  }

  it('rejects a plan-gate PASS carrying an undeclared usage entry', () => {
    // The invariant "planGate === pass implies the usage question was answered"
    // lived only inside the engine method. A stream is what an auditor reads and
    // what a cold resume replays, so the fold has to be able to refuse it too.
    const prior = undeclaredPrior()
    const next = makeSnapshot({
      revision: 2,
      phase: 'executing',
      planGate: 'pass',
      plan: { revision: 1, text: 'p' },
      audits: [passAudit('plan', 0)],
      usage: prior.usage!,
      planGatePassedAt: new Date().toISOString(),
    })
    expect(() => applyEvent(prior, event('audit', next))).toThrowError(/undeclared/)
  })

  it('accepts the same flip once the entry is declared (positive control)', () => {
    const prior = undeclaredPrior()
    const next = makeSnapshot({
      revision: 2,
      phase: 'executing',
      planGate: 'pass',
      plan: { revision: 1, text: 'p' },
      audits: [passAudit('plan', 0)],
      usage: { entries: [{ id: 'm1', usageClass: 'docs', boundaryStates: [], artifacts: [], attempted: [] }] },
      planGatePassedAt: new Date().toISOString(),
    })
    expect(applyEvent(prior, event('audit', next)).planGate).toBe('pass')
  })

  it('leaves a legacy stream with no usage dimension alone', () => {
    const prior = makeSnapshot({ phase: 'plan-reviewing', plan: { revision: 1, text: 'p' } })
    expect(prior.usage).toBeUndefined()
    const next = makeSnapshot({
      revision: 2,
      phase: 'executing',
      planGate: 'pass',
      plan: { revision: 1, text: 'p' },
      audits: [passAudit('plan', 0)],
    })
    expect(applyEvent(prior, event('audit', next)).planGate).toBe('pass')
  })
})

describe('consume-manifest legality', () => {
  it('is legal in every non-terminal phase, because egress can be attempted from any of them', () => {
    const phases = ['planning', 'plan-reviewing', 'executing', 'execution-reviewing', 'replanning', 'closing', 'needs-owner-decision'] as const
    // Cardinality floor: this rule is about breadth, so the breadth is asserted.
    expect(phases.length).toBeGreaterThanOrEqual(7)
    for (const phase of phases) {
      const prior = makeSnapshot({ phase })
      const next = makeSnapshot({
        phase,
        revision: 2,
        enforcement: { sandbox: 'off', reminders: 0, ownerApprovals: [], outboundConsumed: 1 },
      })
      expect(applyEvent(prior, event('consume-manifest', next)).enforcement.outboundConsumed).toBe(1)
    }
  })

  it('is refused after a terminal phase like every other op', () => {
    const prior = makeSnapshot({ phase: 'completed' })
    const next = makeSnapshot({ phase: 'completed', revision: 2 })
    expect(() => applyEvent(prior, event('consume-manifest', next))).toThrowError(/no events after terminal phase/)
  })
})

describe('validateTriage', () => {
  it('accepts lightweight+low self-check inline', () => {
    expect(validateTriage(makeTriage())).toEqual([])
  })
  it('rejects self-check on standard size', () => {
    expect(validateTriage(makeTriage({ size: 'standard' })).join(';')).toMatch(/self-check is only legal/)
  })
  it('rejects medium risk that would SELF-review, and accepts either non-self mode', () => {
    // The rule is "medium and up may not review themselves". It used to be
    // spelled `!== 'independent'` because independent was the only alternative;
    // adding `external` made that spelling say something narrower than the rule.
    // So this asserts the rule in BOTH directions rather than the old wording.
    expect(validateTriage(makeTriage({ risk: 'medium', auditMode: 'self-check' })).join(';'))
      .toMatch(/may not self-review/)
    expect(validateTriage(makeTriage({ risk: 'medium', auditMode: 'independent' })).join(';'))
      .not.toMatch(/self-review/)
    expect(validateTriage(makeTriage({ risk: 'medium', auditMode: 'external' })).join(';'))
      .not.toMatch(/self-review/)
  })
  it('rejects delegated lightweight runs', () => {
    expect(validateTriage(makeTriage({ executionMode: 'delegated' })).join(';')).toMatch(/always inline/)
  })
  it('ACCEPTS external audit mode — it stopped being a reserved word when the channel shipped', () => {
    // Through v1 and most of v2 this asserted the opposite, and that was right:
    // `external` was rejected at init as an honest terminal while the channel
    // did not exist. Keeping the rejection after building the channel would
    // have made the refusal itself the false statement.
    expect(validateTriage(makeTriage({ auditMode: 'external', size: 'standard', risk: 'low' })))
      .toEqual([])
    // Self-check keeps its own fence, so accepting external did not open that one.
    expect(validateTriage(makeTriage({ auditMode: 'self-check', size: 'standard', risk: 'low' })).join(';'))
      .toMatch(/only legal for lightweight/)
  })
})

/**
 * The structural usage rules, enforced on the REPLAY path.
 *
 * `validateUsageEntry` used to be invoked at exactly two sites, both writers
 * (`AutopilotEngine.init`'s seeds and `declareUsage`). The fold's plan-gate
 * coupling and `evaluateCompletion` both called only
 * `usageDeclarationProblems`, which reported entries whose class was literally
 * 'undeclared' and nothing else — so a structurally HOLLOW declaration folded
 * clean, flipped the plan gate, walked zero artifacts at settlement, and
 * completed. That is precisely the threat model the fold's own comment names:
 * a hand-edited file, a buggy writer, an older build.
 */
describe('replay enforces the declaration rules, not just the class label', () => {
  const STANDARD = { size: 'standard' as const, risk: 'medium' as const, auditMode: 'independent' as const }
  /** class 'gui' with zero boundary states and zero artifacts: every visible-class rule violated. */
  const hollow: UsageEntry = { id: 'm1', usageClass: 'gui', boundaryStates: [], artifacts: [], attempted: [] }
  /** The same id, declared the way `validateUsageEntry` requires. */
  const sound: UsageEntry = {
    id: 'm1',
    usageClass: 'gui',
    boundaryStates: ['empty', 'error-path'],
    artifacts: [{ kind: 'screenshot' as const, ref: 'usage/m1.png', covers: ['empty'], capturedAt: '2026-08-24T00:00:00.000Z' }],
    attempted: [],
  }

  /** A closeout-ready snapshot, local to this block (the sibling helper is scoped to its own describe). */
  function completable(overrides: Partial<Snapshot> = {}): Snapshot {
    return makeSnapshot({
      phase: 'closing',
      planGate: 'pass',
      executionGate: 'pass',
      planGatePassedAt: '2026-08-23T00:00:00.000Z',
      audits: [passAudit('plan', 0), passAudit('execution', 1)],
      closeout: {
        summary: 'done',
        changedFiles: ['a.ts'],
        commands: ['pnpm test - pass'],
        evidence: [{ criterion: 'tests pass', bearer: 'test-run.txt', status: 'proven' as const }],
        residualRisks: [],
        exclusions: [],
        workspaceCleanup: 'nothing created',
        drift: 'none found',
      },
      ...overrides,
    }, STANDARD)
  }

  function flip(entry: UsageEntry): RunEvent {
    const prior = makeSnapshot(
      { phase: 'plan-reviewing', planGate: 'pending', usage: { entries: [entry] } },
      STANDARD,
    )
    const next = makeSnapshot(
      { phase: 'executing', revision: 2, planGate: 'pass', usage: { entries: [entry] }, audits: [passAudit('plan', 0)] },
      STANDARD,
    )
    return event('audit', next, 2)
  }

  it('REFUSES a plan-gate flip carrying a hollow declaration', () => {
    const prior = makeSnapshot({ phase: 'plan-reviewing', planGate: 'pending', usage: { entries: [hollow] } }, STANDARD)
    expect(() => applyEvent(prior, flip(hollow)))
      .toThrowError(/planGate pass with unanswered usage evidence/)
    try {
      applyEvent(prior, flip(hollow))
    } catch (error: unknown) {
      // The message names WHICH rules, so this fail is distinguishable from the
      // literal-'undeclared' fail the same checker also reports.
      expect((error as Error).message).toMatch(/needs >=2 boundary states/)
      expect((error as Error).message).toMatch(/needs >=1 artifact/)
    }
  })

  it('positive control: the byte-identical flip with a SOUND declaration is accepted', () => {
    const prior = makeSnapshot({ phase: 'plan-reviewing', planGate: 'pending', usage: { entries: [sound] } }, STANDARD)
    expect(applyEvent(prior, flip(sound)).planGate).toBe('pass')
  })

  it('DETECTOR: the same flip with the entry left literally undeclared still fails, differently', () => {
    const undeclared: UsageEntry = { id: 'm1', usageClass: 'undeclared', boundaryStates: [], artifacts: [], attempted: [] }
    const prior = makeSnapshot({ phase: 'plan-reviewing', planGate: 'pending', usage: { entries: [undeclared] } }, STANDARD)
    expect(() => applyEvent(prior, flip(undeclared))).toThrowError(/is undeclared/)
  })

  it('completion refuses a hollow declaration too, not only the gate', () => {
    const done = completable({ usage: { entries: [hollow] } })
    const check = evaluateCompletion(done)
    expect(check.ok).toBe(false)
    expect(check.problems.join(';')).toMatch(/needs >=1 artifact/)
    // Positive control on the same snapshot shape.
    expect(evaluateCompletion(completable({ usage: { entries: [sound] } })).ok).toBe(true)
  })
})
