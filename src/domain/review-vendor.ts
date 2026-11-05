/**
 * The vendor relation of one review, as a neutral fact. Pure and DOM-free: the
 * session card and the model-facing tool results derive it from the same ledger
 * record through this one function, so they cannot disagree.
 *
 * A same-vendor review is normal. Compare the settled reviewer route with the
 * reviewed providers recorded at dispatch. The earlier routing decision and its
 * note are historical; they may disagree with the reviewer's observed route.
 *
 * @module dsh-autopilot/domain/review-vendor
 */

export type ReviewerVendor = 'same' | 'different' | 'unknown'

/** The stored fields the relation is derived from (a `ReviewRecord` satisfies this). */
export interface ReviewVendorInput {
  readonly independence: string
  readonly excludedFamilies: readonly string[]
  readonly independenceNote?: string
  readonly reviewerRoute?: { readonly provider?: string }
  readonly reviewedChildIds?: readonly string[]
  readonly reviewedProvidersComplete?: boolean
}

/** Old records cannot distinguish duplicate providers from missing providers. */
function hasUnknownReviewedProvider(r: ReviewVendorInput, reviewed: readonly string[]): boolean {
  if (r.reviewedProvidersComplete !== undefined) return !r.reviewedProvidersComplete
  return new Set(r.reviewedChildIds ?? []).size > new Set(reviewed).size
}

export function reviewerVendor(r: ReviewVendorInput): ReviewerVendor {
  const provider = r.reviewerRoute?.provider?.trim()
  const reviewed = r.excludedFamilies.map(family => family.trim()).filter(Boolean)
  if (!provider || reviewed.length === 0) return 'unknown'
  if (reviewed.includes(provider)) return 'same'
  return hasUnknownReviewedProvider(r, reviewed) ? 'unknown' : 'different'
}

/** Facts for the model-facing result: who reviewed, and which providers the reviewed work used. */
export function reviewerVendorNote(r: ReviewVendorInput): string {
  const reviewed = r.excludedFamilies.map(family => family.trim()).filter(Boolean).join(', ')
  const reviewer = `reviewer provider "${r.reviewerRoute?.provider?.trim()}"`
  switch (reviewerVendor(r)) {
    case 'same': return `${reviewer} is also a provider of the reviewed work (${reviewed})`
    case 'different': return `${reviewer} is not among the providers of the reviewed work (${reviewed})`
    case 'unknown': return reviewed === ''
      ? 'the reviewed work has no recorded provider, so the relation is not determined'
      : !r.reviewerRoute?.provider?.trim()
        ? 'the reviewer provider is not observable, so the relation is not determined'
        : 'some reviewed work providers may not be recorded, so the relation is not determined'
  }
}

/** The model-facing shape of one review record: neutral vendor fields instead of the stored `independence` trio. */
export function neutralReview<T extends ReviewVendorInput>(
  r: T,
): Omit<T, 'independence' | 'excludedFamilies' | 'independenceNote' | 'reviewedProvidersComplete'> & { reviewerVendor: ReviewerVendor; reviewerVendorNote: string } {
  const { independence: _i, excludedFamilies: _e, independenceNote: _n, reviewedProvidersComplete: _c, ...rest } = r
  return { ...rest, reviewerVendor: reviewerVendor(r), reviewerVendorNote: reviewerVendorNote(r) }
}
