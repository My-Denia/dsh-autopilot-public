/**
 * The vendor relation of one review, as a neutral fact. Pure and DOM-free: the
 * session card and the model-facing tool results derive it from the same ledger
 * record through this one function, so they cannot disagree.
 *
 * A same-vendor review is normal. The relation is only ever "same" when the
 * routing recorded the reviewer's provider among the reviewed work's observed
 * providers; "different" when it recorded it outside them; "unknown" when the
 * reviewed work has no observed provider or the reviewer's own is not observable.
 *
 * @module dsh-autopilot/domain/review-vendor
 */

export type ReviewerVendor = 'same' | 'different' | 'unknown'

/** The stored fields the relation is derived from (a `ReviewRecord` satisfies this). */
export interface ReviewVendorInput {
  readonly independence: string
  readonly excludedFamilies: readonly string[]
  readonly independenceNote?: string
}

/** Notes that mean the reviewer's vendor could not be observed, so "same" would be a guess. */
const UNOBSERVED_NOTE = /not observable|no observed provider family/

export function reviewerVendor(r: ReviewVendorInput): ReviewerVendor {
  if (r.independence !== 'reduced') return 'different'
  if (r.excludedFamilies.length === 0) return 'unknown'
  if (r.independenceNote !== undefined && UNOBSERVED_NOTE.test(r.independenceNote)) return 'unknown'
  return 'same'
}

/** Facts for the model-facing result: who reviewed, and which providers the reviewed work used. */
export function reviewerVendorNote(r: ReviewVendorInput, reviewerProvider?: string): string {
  const reviewed = r.excludedFamilies.join(', ')
  const reviewer = reviewerProvider === undefined || reviewerProvider === '' ? 'the reviewer' : `reviewer provider "${reviewerProvider}"`
  switch (reviewerVendor(r)) {
    case 'same': return `${reviewer} is also a provider of the reviewed work (${reviewed})`
    case 'different': return `${reviewer} is not among the providers of the reviewed work${reviewed === '' ? '' : ` (${reviewed})`}`
    case 'unknown': return r.excludedFamilies.length === 0
      ? 'the reviewed work has no observed provider, so the relation is not determined'
      : 'the reviewer provider is not observable, so the relation is not determined'
  }
}

/** The model-facing shape of one review record: neutral vendor fields instead of the stored `independence` trio. */
export function neutralReview<T extends ReviewVendorInput & { readonly reviewerRoute?: { readonly provider?: string } }>(
  r: T,
): Omit<T, 'independence' | 'excludedFamilies' | 'independenceNote'> & { reviewerVendor: ReviewerVendor; reviewerVendorNote: string } {
  const { independence: _i, excludedFamilies: _e, independenceNote: _n, ...rest } = r
  return { ...rest, reviewerVendor: reviewerVendor(r), reviewerVendorNote: reviewerVendorNote(r, r.reviewerRoute?.provider) }
}
