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

const CASES: ReadonlyArray<[string, Pick<ReviewRecord, 'independence' | 'excludedFamilies' | 'independenceNote' | 'reviewerRoute'>, 'same' | 'different' | 'unknown', string]> = [
  ['selected different, observed same', { independence: 'cross-family', excludedFamilies: ['alpha'], reviewerRoute: { provider: 'alpha', model: 'm' } }, 'same', 'reviewer provider "alpha" is also a provider of the reviewed work (alpha)'],
  ['selected same, observed different', { independence: 'reduced', excludedFamilies: ['alpha'], reviewerRoute: { provider: 'beta', model: 'm' } }, 'different', 'reviewer provider "beta" is not among the providers of the reviewed work (alpha)'],
  ['inherited unknown, observed later', { independence: 'reduced', excludedFamilies: ['alpha'], independenceNote: 'the reviewer route is inherited from the host default, so its provider family is not observable', reviewerRoute: { provider: 'alpha', model: 'm' } }, 'same', 'reviewer provider "alpha" is also a provider of the reviewed work (alpha)'],
  ['normal different', { independence: 'cross-family', excludedFamilies: ['alpha'], reviewerRoute: { provider: 'beta', model: 'm' } }, 'different', 'reviewer provider "beta" is not among the providers of the reviewed work (alpha)'],
  ['normal same', { independence: 'reduced', excludedFamilies: ['alpha'], reviewerRoute: { provider: 'alpha', model: 'm' } }, 'same', 'reviewer provider "alpha" is also a provider of the reviewed work (alpha)'],
  ['reviewer route missing in a legacy cross-family record', { independence: 'cross-family', excludedFamilies: ['alpha'] }, 'unknown', 'the reviewer provider is not observable, so the relation is not determined'],
  ['reviewer route missing in a legacy reduced record', { independence: 'reduced', excludedFamilies: ['alpha'], independenceNote: 'same family used' }, 'unknown', 'the reviewer provider is not observable, so the relation is not determined'],
  ['empty reviewer provider', { independence: 'cross-family', excludedFamilies: ['alpha'], reviewerRoute: { provider: '  ', model: 'm' } }, 'unknown', 'the reviewer provider is not observable, so the relation is not determined'],
  ['reviewed provider missing', { independence: 'cross-family', excludedFamilies: [], reviewerRoute: { provider: 'beta', model: 'm' } }, 'unknown', 'the reviewed work has no recorded provider, so the relation is not determined'],
  ['reviewed provider blank', { independence: 'cross-family', excludedFamilies: ['  '], reviewerRoute: { provider: 'beta', model: 'm' } }, 'unknown', 'the reviewed work has no recorded provider, so the relation is not determined'],
  ['one of multiple reviewed providers matches', { independence: 'cross-family', excludedFamilies: ['alpha', 'beta'], reviewerRoute: { provider: 'beta', model: 'm' } }, 'same', 'reviewer provider "beta" is also a provider of the reviewed work (alpha, beta)'],
  ['none of multiple reviewed providers matches', { independence: 'reduced', excludedFamilies: ['alpha', 'beta'], reviewerRoute: { provider: 'gamma', model: 'm' } }, 'different', 'reviewer provider "gamma" is not among the providers of the reviewed work (alpha, beta)'],
]

const BAD = /reduced independence|independence|独立性降低|cross-family review cannot/i

describe('reviewerVendor', () => {
  for (const [name, fields, expected, expectedNote] of CASES) {
    it(name, () => {
      const record: ReviewRecord = { ...base, ...fields }
      expect(reviewerVendor(record)).toBe(expected)
      expect(reviewerVendorNote(record)).toBe(expectedNote)
      // The card and the model-facing projection derive the relation from the same record.
      const row = reviewRows({ reviews: [record] } as unknown as LedgerProjection)[0]!
      const S = STRINGS.en
      const text = expected === 'different' ? S.vendorDifferent : expected === 'unknown' ? S.vendorUnknown : S.vendorSame(fields.reviewerRoute!.provider.trim())
      expect(row.vendorText).toBe(text)
      const model = neutralReview(record)
      expect(model).toMatchObject({ reviewerVendor: expected, reviewerVendorNote: expectedNote, verdict: base.verdict, findings: base.findings })
      expect(JSON.stringify(model)).not.toMatch(BAD)
    })
  }

  it.each([
    { name: 'a missing reviewed provider leaves a non-match unknown', complete: false, reviewer: 'beta', expected: 'unknown' },
    { name: 'a known matching provider proves same even if another is missing', complete: false, reviewer: 'alpha', expected: 'same' },
    { name: 'two children with the same known provider can still be different', complete: true, reviewer: 'beta', expected: 'different' },
    { name: 'an ambiguous old record does not imply every provider was known', complete: undefined, reviewer: 'beta', expected: 'unknown' },
  ] as const)('$name', ({ complete, reviewer, expected }) => {
    const record = {
      ...base, reviewedChildIds: ['w-1', 'w-2'], independence: 'cross-family' as const,
      excludedFamilies: ['alpha'], reviewerRoute: { provider: reviewer, model: 'm' },
      ...(complete === undefined ? {} : { reviewedProvidersComplete: complete }),
    }
    expect(reviewerVendor(record)).toBe(expected)
    const shown = neutralReview(record)
    expect(shown.reviewerVendor).toBe(expected)
    const card = reviewRows({ reviews: [record] } as unknown as LedgerProjection)[0]!
    expect(card.vendorText).toBe(expected === 'same' ? STRINGS.en.vendorSame('alpha') : expected === 'different' ? STRINGS.en.vendorDifferent : STRINGS.en.vendorUnknown)
  })

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
