/**
 * Usage evidence: the CC goal-autopilot-harness schema-9 dimension, ported as
 * pure functions over the vocabulary already declared in `./types.js`.
 *
 * WHY this dimension exists: the harness could always verify that code builds
 * and passes tests, and never once verified that a user-visible change was
 * OPERATED by anyone. A rule you must REMEMBER cannot repair a FORGETTING
 * failure, so the question is asked mechanically and asked BEFORE editing is
 * allowed - `usageDeclarationProblems` is the plan-gate precondition, and
 * `settleUsageArtifacts` is the completion-time settlement of what was
 * promised at declaration time.
 *
 * The split is deliberate and matches CC: declaration-time rules can only
 * inspect the CLAIM (`validateUsageEntry`), while containment, non-emptiness,
 * freshness and coverage require the artifact to actually exist and therefore
 * belong to settlement. Keeping both pure (disk access is injectable) is what
 * lets every branch carry a negative fixture, per the Checker-Resolution
 * invariant: a checker's pass carries no information until it has been proven
 * able to observe the corresponding fail.
 */

import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { BINARY_ARTIFACT_KINDS, USAGE_VISIBLE_CLASSES,
  FUTURE_SKEW_MS, coversFloorProblems, latestVerdicts, validateExternalReview,
} from './types.js'
import type {
  AuditRecord, UsageArtifact, UsageArtifactKind, UsageClass, UsageEntry, UsageEvidence,
} from './types.js'

/**
 * Classes whose entries must carry at least one artifact: the human-observable
 * surfaces plus `harness` (which additionally pins the artifact KIND). These
 * are exactly the entries settlement walks; `internal`/`docs`/`unsupported`/
 * `undeclared` promised no artifact, so settling one would invent an
 * obligation the declaration never made.
 */
const ARTIFACT_REQUIRED_CLASSES: readonly UsageClass[] = [...USAGE_VISIBLE_CLASSES, 'harness']

/** PNG magic number (first four bytes of the eight-byte signature). */
const PNG_MAGIC = '\x89PNG'

/** JPEG start-of-image plus the first marker byte. */
const JPEG_MAGIC = '\xFF\xD8\xFF'

/** The two GIF version signatures. */
const GIF_MAGICS: readonly string[] = ['GIF87a', 'GIF89a']

/** Matroska/WebM EBML header. */
const WEBM_MAGIC = '\x1A\x45\xDF\xA3'

/** ISO-BMFF (MP4/MOV) box type; it follows a four-byte size, so it is not at offset 0. */
const MP4_BOX = 'ftyp'

/** What settlement needs to know about one artifact file on disk. */
export interface UsageArtifactRead {
  /** Byte length. Zero is a settlement failure: an empty file bears nothing. */
  readonly size: number
  /**
   * File content decoded as text. Binary artifacts are decoded
   * byte-per-code-unit (latin1) so their magic numbers survive the decode.
   */
  readonly text: string
}

/** Settlement inputs. `readArtifact` is injectable so every branch is testable without fixtures on disk. */
export interface SettleUsageOptions {
  /** Absolute run directory. Artifact refs resolve against it and must stay inside it. */
  readonly runDir: string
  /** ISO-8601 UTC stamp of the FIRST plan-gate pass; the lower freshness bound. */
  readonly planGatePassedAt?: string
  /**
   * ISO-8601 UTC stamp of the moment settlement is being run. Supplying it
   * CLOSES the freshness window: `planGatePassedAt` bounds `capturedAt` from
   * below, this bounds it from above.
   *
   * WHY IT EXISTS: with only a lower bound the window is half-open, so the
   * cheapest fabrication for a model that has learned the freshness rule is a
   * stamp in the FUTURE - it satisfies "post-dates the gate" and can never be
   * contradicted. Observed live: a model pushed for artifact metadata invented
   * `capturedAt: '2025-02-14T00:00:00Z'`, a stamp with no relationship to the
   * run at all. The lower bound catches that one; nothing catches its mirror.
   *
   * WHY IT IS NOT DEFAULTED TO A CLOCK: `evaluateCompletion` is replayed, and a
   * checker that reads the wall clock answers differently on every replay of
   * the same stream - which would make an archived run stop settling. The
   * caller that knows settlement is happening NOW is the one that may say so.
   */
  readonly settledAt?: string
  /** Defaults to a resilient node:fs reader; an unreadable file returns undefined rather than throwing. */
  readonly readArtifact?: (absPath: string) => UsageArtifactRead | undefined
}

/**
 * The entry state (CC default id `m1`). A run that has not answered the usage
 * question holds this, which is legal to HOLD and illegal to PASS the plan
 * gate with - that asymmetry is the whole mechanism.
 */
export function USAGE_UNDECLARED_ENTRY(id?: string): UsageEntry {
  return { id: id ?? 'm1', usageClass: 'undeclared', boundaryStates: [], artifacts: [], attempted: [] }
}

/**
 * Whether an artifact's bytes carry the format signature its kind claims.
 * Exported for direct testing, because a signature checker that silently
 * accepts everything is indistinguishable from no checker at all.
 *
 * Non-binary kinds return `false`: they settle on covered-label text, not on
 * magic bytes, and answering `true` for them would be a claim this function
 * cannot observe being false.
 */
export function hasFormatSignature(kind: UsageArtifactKind, text: string): boolean {
  const head = text.slice(0, 16)
  const isGif = GIF_MAGICS.some(magic => head.startsWith(magic))
  if (kind === 'screenshot') return head.startsWith(PNG_MAGIC) || head.startsWith(JPEG_MAGIC) || isGif
  // Animated GIF is a legitimate screencast container, so it is accepted here too.
  if (kind === 'screencast') return head.startsWith(WEBM_MAGIC) || head.slice(0, 12).includes(MP4_BOX) || isGif
  return false
}

/**
 * The declaration rules, re-exported from `./types.js`.
 *
 * They moved there so that `evaluateCompletion` and the replay fold — both of
 * which sit BELOW this module in the import order — can apply the same rules
 * rather than a second copy of them. `validateUsageEntry` followed
 * `usageDeclarationProblems` across in the 2026-08-24 round for exactly that
 * reason: the structural rules were enforced ONLY by the two writer sites, so a
 * hollow declaration (`usageClass:'gui'` with zero boundary states and zero
 * artifacts) folded clean on replay, flipped the plan gate, and completed.
 * Callers keep importing both from here, alongside their settlement sibling.
 */
export { usageDeclarationProblems, validateUsageEntry } from './types.js'

/**
 * COMPLETION-time settlement: every artifact promised by an artifact-requiring
 * entry must resolve inside the run directory, be non-empty, post-date the plan
 * gate, and actually bear what it claims to cover.
 *
 * `undefined` usage returns `[]` (legacy stream; see `usageDeclarationProblems`).
 */
export function settleUsageArtifacts(usage: UsageEvidence | undefined, options: SettleUsageOptions): string[] {
  if (usage === undefined) return []
  const problems: string[] = []
  const read = options.readArtifact ?? defaultReadArtifact
  const runDir = resolve(options.runDir)
  const settling = usage.entries.filter(entry => ARTIFACT_REQUIRED_CLASSES.includes(entry.usageClass))
  const artifactCount = settling.reduce((total, entry) => total + entry.artifacts.length, 0)

  const anchor = (options.planGatePassedAt ?? '').trim()
  if (artifactCount > 0 && anchor.length === 0) {
    // Without the anchor freshness is unobservable: an artifact captured before
    // the plan gate (i.e. one that depicts the OLD behaviour) would settle
    // clean. Passing here would record a confidence the code cannot observe
    // being false, so the missing anchor is itself the problem.
    problems.push('run has usage artifacts to settle but no planGatePassedAt: artifact freshness has no anchor')
  }
  const anchorMs = anchor.length > 0 ? Date.parse(anchor) : Number.NaN
  if (anchor.length > 0 && Number.isNaN(anchorMs)) {
    problems.push(`planGatePassedAt is not a parsable date: ${anchor}`)
  }

  const settledAt = (options.settledAt ?? '').trim()
  const settledMs = settledAt.length > 0 ? Date.parse(settledAt) : Number.NaN
  if (settledAt.length > 0 && Number.isNaN(settledMs)) {
    // Same fail-loud reason as the anchor: an unparsable upper bound would
    // silently disable the rule the caller asked for.
    problems.push(`settledAt is not a parsable date: ${settledAt}`)
  }

  for (const entry of settling) {
    for (const artifact of entry.artifacts) {
      problems.push(...settleArtifact(entry, artifact, runDir, anchorMs, settledMs, read))
    }
  }
  return problems
}

/** Settle one artifact. Split out so the per-rule early exits stay readable. */
function settleArtifact(
  entry: UsageEntry,
  artifact: UsageArtifact,
  runDir: string,
  anchorMs: number,
  settledMs: number,
  read: (absPath: string) => UsageArtifactRead | undefined,
): string[] {
  const problems: string[] = []
  const ref = artifact.ref.trim()
  const label = `entry ${entry.id} artifact ${ref.length > 0 ? ref : '<empty ref>'}`
  if (ref.length === 0) {
    problems.push(`${label}: ref is empty`)
    return problems
  }

  problems.push(...coversFloorProblems(label, artifact.covers))

  const inherited = (artifact.inheritedFrom ?? '').trim()
  if (inherited.length > 0) {
    // Honest ceiling: an inherited artifact cites ANOTHER run's folder (revert
    // and re-release cases). CC exempts it from containment and freshness; this
    // implementation additionally cannot observe its size or content, because
    // resolving a foreign run directory is outside this function's inputs.
    // Silence here means "not checked", not "checked and clean" - the audit
    // layer owns inherited artifacts.
    return problems
  }

  const absolute = resolve(runDir, ref)
  if (!isInsideRunDir(runDir, absolute)) {
    problems.push(`${label}: resolves outside the run directory (containment): ${absolute}`)
    return problems
  }

  // Freshness is a WINDOW, not a floor. The lower bound is the plan gate; the
  // upper bound exists only when the caller supplied `settledAt`, so with no
  // upper bound this is byte-for-byte the rule it has always been.
  if (!Number.isNaN(anchorMs) || !Number.isNaN(settledMs)) {
    const capturedMs = Date.parse(artifact.capturedAt)
    if (Number.isNaN(capturedMs)) {
      problems.push(`${label}: capturedAt is not a parsable date: ${artifact.capturedAt}`)
    } else {
      if (!Number.isNaN(anchorMs) && capturedMs < anchorMs) {
        problems.push(`${label}: capturedAt ${artifact.capturedAt} predates planGatePassedAt (freshness)`)
      }
      if (!Number.isNaN(settledMs) && capturedMs - settledMs > FUTURE_SKEW_MS) {
        problems.push(
          `${label}: capturedAt ${artifact.capturedAt} postdates settledAt ${new Date(settledMs).toISOString()} beyond the ${FUTURE_SKEW_MS}ms clock-skew tolerance (freshness): an artifact cannot have been captured after it was settled`,
        )
      }
    }
  }

  const content = read(absolute)
  if (content === undefined) {
    problems.push(`${label}: is unreadable at ${absolute}`)
    return problems
  }
  if (content.size <= 0) {
    problems.push(`${label}: is empty (0 bytes)`)
    return problems
  }

  if (BINARY_ARTIFACT_KINDS.includes(artifact.kind)) {
    if (!hasFormatSignature(artifact.kind, content.text)) {
      problems.push(`${label}: carries no ${artifact.kind} format signature (magic bytes)`)
    }
    return problems
  }

  for (const covered of artifact.covers) {
    if (!mentions(content.text, covered)) {
      problems.push(`${label}: text does not mention covered label: ${covered}`)
    }
  }
  return problems
}

/**
 * Separator-aware containment. The run directory itself is NOT inside itself
 * (a directory bears no evidence), and the comparison is case-SENSITIVE even on
 * Windows: both sides derive from the same `resolve` base, so a case mismatch
 * means the ref reached in from outside by an absolute path, and refusing it is
 * the fail-closed direction.
 */
/**
 * Settle every owner-countersigned external review against the filesystem.
 *
 * The pure half of the rule lives in `validateExternalReview` and is enforced
 * on the replay path too; this is the half that needs disk, so it runs only
 * where a real run directory exists — the same split, and the same reason, as
 * `settleUsageArtifacts`.
 *
 * WHAT THIS CAN AND CANNOT SAY, because the difference is the whole point of
 * the external channel: it can refuse a countersign whose review is missing,
 * empty, or outside the run directory. It CANNOT tell whether the review was
 * read, written by the named reviewer, or about this tree. An external pass is
 * therefore weaker evidence than a dispatched audit by construction, not by
 * accident (DESIGN.md §6).
 *
 * Only the LATEST record per role is settled: an earlier countersign that was
 * superseded is history, and failing completion on a stale one would make a
 * corrected review impossible.
 */
export function settleExternalReviews(
  audits: readonly AuditRecord[],
  options: { readonly runDir: string; readonly readArtifact?: (absPath: string) => UsageArtifactRead | undefined },
): string[] {
  const read = options.readArtifact ?? defaultReadArtifact
  const problems: string[] = []
  const latest = latestVerdicts(audits)
  for (const [role, record] of Object.entries(latest)) {
    const review = record?.external
    if (review === undefined) continue
    const label = `role ${role} external review ${review.reviewRef}`
    problems.push(...validateExternalReview(review).map(p => `${label}: ${p}`))
    const abs = resolve(options.runDir, review.reviewRef)
    if (!isInsideRunDir(options.runDir, abs)) {
      problems.push(`${label}: resolves outside the run directory`)
      continue
    }
    const file = read(abs)
    if (file === undefined) {
      problems.push(`${label}: does not exist or is unreadable`)
    } else if (file.size <= 0) {
      problems.push(`${label}: is empty — an attached review with no content attaches nothing`)
    }
  }
  return problems
}

function isInsideRunDir(runDir: string, candidate: string): boolean {
  if (candidate === runDir) return false
  const prefix = runDir.endsWith(sep) ? runDir : runDir + sep
  return candidate.startsWith(prefix)
}

/** Covered-label match for text artifacts; case-insensitive because a log writing `Offline` still bears `offline`. */
function mentions(text: string, covered: string): boolean {
  const needle = covered.trim()
  if (needle.length === 0) return false
  return text.toLowerCase().includes(needle.toLowerCase())
}

/**
 * Default reader. Resilient by contract: a missing, unreadable or
 * permission-denied artifact returns `undefined` (which settlement reports as a
 * problem) and never throws, because an exception here would abort the whole
 * settlement and turn one bad artifact into an unexamined run.
 *
 * Reads the whole file: run-directory evidence artifacts are small by
 * construction, and anything else should inject its own reader.
 */
function defaultReadArtifact(absPath: string): UsageArtifactRead | undefined {
  try {
    const buffer = readFileSync(absPath)
    return { size: buffer.length, text: decode(buffer) }
  } catch {
    return undefined
  }
}

/**
 * Decode for content checks. UTF-8 when the bytes ARE valid UTF-8 (so
 * non-ASCII covered labels match), latin1 otherwise (so binary magic numbers
 * survive instead of collapsing into U+FFFD). The round-trip test is exact,
 * not a heuristic.
 */
function decode(buffer: Buffer): string {
  const utf8 = buffer.toString('utf8')
  return Buffer.from(utf8, 'utf8').equals(buffer) ? utf8 : buffer.toString('latin1')
}
