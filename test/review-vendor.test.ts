import { describe, expect, it } from 'vitest'
import { neutralReview, reviewerVendor, reviewerVendorNote } from '../src/domain/review-vendor.js'
import { reviewRows } from '../src/client/ledger.js'
import { STRINGS } from '../src/client/i18n.js'
import type { LedgerProjection, ReviewRecord } from '../src/domain/ledger-types.js'
import { installRootTools, statusBody } from '../src/tools.js'
import type { ToolRegistryRef } from '../src/tools.js'
import { createAutopilotService } from '../src/service.js'
import { makeHarness } from './helpers.js'

const base = { reviewerChildId: 'r-1', reviewedChildIds: ['w-1'], subject: 's', verdict: 'pass', findings: [], at: '2026-11-05T00:00:00.000Z' } as const

const CASES: ReadonlyArray<[string, Pick<ReviewRecord, 'independence' | 'excludedFamilies' | 'independenceNote'>, 'same' | 'different' | 'unknown']> = [
  ['different: recorded outside the reviewed families', { independence: 'cross-family', excludedFamilies: ['alpha'] }, 'different'],
  ['same: recorded among the reviewed families', { independence: 'reduced', excludedFamilies: ['alpha'], independenceNote: 'the reviewer runs on provider family "alpha", which the reviewed work also used' }, 'same'],
  ['same: fallback ladder note, still observed', { independence: 'reduced', excludedFamilies: ['alpha'], independenceNote: 'no reviewer route outside provider families [alpha] was selectable; used the normal ladder' }, 'same'],
  ['unknown: reduced record, no observed reviewed family', { independence: 'reduced', excludedFamilies: [], independenceNote: 'the reviewed work has no observed provider family to exclude, so the vendor relation to it is not known' }, 'unknown'],
  ['unknown: reduced record, no note, no reviewed family', { independence: 'reduced', excludedFamilies: [] }, 'unknown'],
  ['unknown: reviewer route not observable', { independence: 'reduced', excludedFamilies: ['alpha'], independenceNote: 'the reviewer route is inherited from the host default, so its provider family is not observable' }, 'unknown'],
]

const BAD = /reduced independence|independence|独立性降低|cross-family review cannot/i

describe('reviewerVendor', () => {
  for (const [name, fields, expected] of CASES) {
    it(name, () => {
      expect(reviewerVendor(fields)).toBe(expected)
      // The session card derives its vendor text from the same record and must agree.
      const record = { ...base, ...fields } as ReviewRecord
      const row = reviewRows({ reviews: [record] } as unknown as LedgerProjection)[0]!
      const S = STRINGS.en
      const text = expected === 'different' ? S.vendorDifferent : expected === 'unknown' ? S.vendorUnknown : S.vendorSame(fields.excludedFamilies.join(', '))
      expect(row.vendorText).toBe(text)
      const model = neutralReview({ ...record, reviewerRoute: { provider: 'beta', model: 'm' } })
      expect(model.reviewerVendor).toBe(expected)
      expect(JSON.stringify(model)).not.toMatch(BAD)
      expect(reviewerVendorNote(fields, 'beta')).not.toMatch(BAD)
    })
  }

  it('the status tool result carries the neutral fields and no raw independence value', async () => {
    const h = makeHarness()
    await h.engine.mutate('root-1', l => ({ ...l, reviews: [{ ...base, independence: 'reduced', excludedFamilies: ['alpha'], independenceNote: 'x', reviewerRoute: { provider: 'alpha', model: 'm' } } as ReviewRecord] }))
    const service = createAutopilotService({ ledgers: h.ledgers, sources: h.sources })
    const body = await statusBody(service, 'root-1')
    const review = (body['ledger'] as { reviews: Array<Record<string, unknown>> }).reviews[0]!
    expect(review['reviewerVendor']).toBe('same')
    expect(review['reviewerVendorNote']).toBe('reviewer provider "alpha" is also a provider of the reviewed work (alpha)')
    expect(JSON.stringify(body)).not.toMatch(BAD)
  })

  it('tool descriptions never frame a same-vendor review as a defect', () => {
    const defs: Array<{ name: string }> = []
    const registry: ToolRegistryRef = { register(d: unknown) { defs.push(d as { name: string }); return () => undefined } }
    const h = makeHarness()
    installRootTools(registry, createAutopilotService({ ledgers: h.ledgers, sources: h.sources }), h.engine)
    expect(defs.map(d => d.name)).toContain('autopilot_delegate')
    expect(JSON.stringify(defs)).not.toMatch(/reduced independence|独立性降低|cross-family review cannot|different model family\)/i)
  })
})
