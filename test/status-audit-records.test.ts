/**
 * The Audit-Packet Rule's input.
 *
 * An audit packet embeds every required role's latest verdict read directly
 * from the run state, VERBATIM, with non-passes shown explicitly. A verdict
 * word cannot carry that: it loses the sequence, the revision the audit was
 * taken at, the auditor identity, the transport provider, whether the role is
 * even required, and a non-pass's own note.
 */

import { describe, expect, it } from 'vitest'
import { auditStatusRecords } from '../src/engine.js'
import type { AuditRecord } from '../src/domain/types.js'
import { makeSnapshot } from './helpers.js'

function audit(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    role: 'plan',
    seq: 0,
    runRevision: 1,
    planRevision: 1,
    executionRevision: 0,
    auditorId: 'child-1',
    verdict: 'pass',
    note: 'looks right',
    route: { provider: 'spawn', routeProvider: 'p', routeModel: 'm', routeStatus: 'verified' },
    ...overrides,
  }
}

describe('auditStatusRecords', () => {
  it('returns nothing when no role has a record', () => {
    expect(auditStatusRecords(makeSnapshot())).toEqual({})
  })

  it('carries the record verbatim rather than a verdict word', () => {
    const records = auditStatusRecords(makeSnapshot({
      audits: [audit({ role: 'plan', seq: 0, verdict: 'needs-replan', note: 'scope is vague' })],
    }, { risk: 'medium', size: 'standard', auditMode: 'independent' }))
    expect(records.plan).toEqual({
      role: 'plan',
      seq: 0,
      verdict: 'needs-replan',
      note: 'scope is vague',
      auditorId: 'child-1',
      runRevision: 1,
      planRevision: 1,
      executionRevision: 0,
      provider: 'spawn',
      required: true,
    })
  })

  it('keeps the latest record per role and surfaces a non-pass as itself', () => {
    const records = auditStatusRecords(makeSnapshot({
      audits: [
        audit({ role: 'plan', seq: 0, verdict: 'needs-replan', note: 'first' }),
        audit({ role: 'plan', seq: 1, verdict: 'pass', note: 'second' }),
        audit({ role: 'execution', seq: 2, verdict: 'needs-fix', note: 'still wrong', auditorId: 'child-2' }),
      ],
    }, { risk: 'medium', size: 'standard', auditMode: 'independent' }))
    expect(records.plan?.verdict).toBe('pass')
    expect(records.plan?.note).toBe('second')
    expect(records.execution?.verdict).toBe('needs-fix')
    expect(records.execution?.note).toBe('still wrong')
    expect(records.execution?.auditorId).toBe('child-2')
  })

  it('marks a role the current triage does not require', () => {
    const records = auditStatusRecords(makeSnapshot({
      audits: [audit({ role: 'rules', seq: 0 })],
    }, { risk: 'medium', size: 'standard', auditMode: 'independent', touchesOperatingLayer: false }))
    expect(records.rules?.required).toBe(false)
  })

  it('keeps an external countersign distinguishable from a dispatched pass', () => {
    const external = { reviewer: 'owner', reviewRef: 'review/plan.md' }
    const records = auditStatusRecords(makeSnapshot({
      audits: [audit({ role: 'plan', seq: 0, route: { provider: 'external', routeProvider: 'external', routeModel: 'external', routeStatus: 'unverified' }, external })],
    }, { risk: 'medium', size: 'standard', auditMode: 'external' }))
    expect(records.plan?.external).toEqual(external)
    expect(records.plan?.provider).toBe('external')
  })
})
