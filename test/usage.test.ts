/**
 * Usage-evidence rules (CC schema-9 dimension).
 *
 * Every rule under test carries BOTH a passing and a failing fixture, and each
 * failure is asserted on the distinguishing phrase of its problem string rather
 * than on a non-empty array (Checker-Resolution: a checker's pass carries no
 * information until it is proven able to observe the corresponding fail, and a
 * `length > 0` assertion cannot tell one rule's fail from another's).
 *
 * Moving-Anchor: fixtures chosen "because they are invalid" assert IN PLACE
 * that they are still outside the known set, and no total test count is
 * hardcoded anywhere.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, parse, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  USAGE_UNDECLARED_ENTRY,
  hasFormatSignature,
  settleUsageArtifacts,
  usageDeclarationProblems,
  validateUsageEntry,
} from '../src/domain/usage.js'
import type { UsageArtifactRead } from '../src/domain/usage.js'
import { BOUNDARY_MENU, USAGE_VISIBLE_CLASSES, FUTURE_SKEW_MS } from '../src/domain/types.js'
import type { UsageArtifact, UsageEntry, UsageEvidence } from '../src/domain/types.js'
import { installRootTools } from '../src/tools.js'
import type { ToolRegistryRef } from '../src/tools.js'
import { makeHarness, makeTriage, undeclaredSeed } from './helpers.js'

/** Plan-gate anchor and two stamps either side of it. */
const ANCHOR = '2026-08-24T10:00:00.000Z'
const AFTER = '2026-08-24T11:00:00.000Z'
const BEFORE = '2026-08-24T09:00:00.000Z'

/** A run directory that is never created: injected readers keep settlement off disk. */
const RUN_DIR = resolve(process.cwd(), 'test', '__usage-run-fixture__')

const PNG_BYTES = '\x89PNG\r\n\x1a\n' + 'IHDR-and-the-rest'
const JPEG_BYTES = '\xFF\xD8\xFF\xE0' + 'JFIF'
const WEBM_BYTES = '\x1A\x45\xDF\xA3' + 'matroska'
const MP4_BYTES = '\x00\x00\x00\x20' + 'ftypisom' + 'more'

function artifact(over: Partial<UsageArtifact> = {}): UsageArtifact {
  return { kind: 'screenshot', ref: 'usage/shot.png', covers: ['empty'], capturedAt: AFTER, ...over }
}

function entry(over: Partial<UsageEntry> = {}): UsageEntry {
  return {
    id: 'm1',
    usageClass: 'gui',
    boundaryStates: ['empty', 'error-path'],
    artifacts: [artifact()],
    attempted: [],
    ...over,
  }
}

function usageOf(...entries: readonly UsageEntry[]): UsageEvidence {
  return { entries }
}

/** Reader that answers the same content for any path (each settlement fixture has one artifact). */
function constReader(size: number, text: string): (absPath: string) => UsageArtifactRead | undefined {
  return () => ({ size, text })
}

/** Reader that always fails to read, without throwing. */
const missingReader = (): UsageArtifactRead | undefined => undefined

function has(problems: readonly string[], phrase: string): boolean {
  return problems.some(problem => problem.includes(phrase))
}

describe('validateUsageEntry', () => {
  it('accepts a well-formed user-visible entry', () => {
    expect(validateUsageEntry(entry())).toEqual([])
  })

  it('rejects an empty id, and accepts a non-empty one', () => {
    expect(has(validateUsageEntry(entry({ id: '   ' })), 'usage entry id is empty')).toBe(true)
    expect(has(validateUsageEntry(entry({ id: 'm2' })), 'usage entry id is empty')).toBe(false)
  })

  it('rejects a visible class with exactly one boundary state (cardinality floor)', () => {
    // One state, and it IS on the menu: only the count rule may fire.
    expect(BOUNDARY_MENU).toContain('empty')
    const problems = validateUsageEntry(entry({ boundaryStates: ['empty'] }))
    expect(has(problems, 'needs >=2 boundary states, has 1')).toBe(true)
    expect(has(problems, 'drawn from BOUNDARY_MENU')).toBe(false)
  })

  it('rejects a visible class whose states are all off-menu (separate rule from the count)', () => {
    const offMenu = ['happy-path-only', 'looks-fine-to-me']
    // Moving-Anchor: these are fixtures BECAUSE they are outside the menu, so
    // assert that in place - the menu is a value that can move.
    for (const state of offMenu) expect(BOUNDARY_MENU).not.toContain(state)
    const problems = validateUsageEntry(entry({ boundaryStates: offMenu }))
    expect(has(problems, 'needs >=1 boundary state drawn from BOUNDARY_MENU, has none')).toBe(true)
    expect(has(problems, 'needs >=2 boundary states')).toBe(false)
  })

  it('rejects a visible class with no artifact, and accepts one with an artifact', () => {
    expect(has(validateUsageEntry(entry({ artifacts: [] })), 'needs >=1 artifact, has none')).toBe(true)
    expect(has(validateUsageEntry(entry()), 'needs >=1 artifact, has none')).toBe(false)
  })

  it('applies the visible-class rules to cli and api-behavior as well as gui', () => {
    for (const usageClass of ['gui', 'cli', 'api-behavior'] as const) {
      const problems = validateUsageEntry(entry({ usageClass, boundaryStates: [], artifacts: [] }))
      expect(has(problems, `class ${usageClass} needs >=1 artifact, has none`)).toBe(true)
    }
  })

  it('requires a test-run artifact for the harness class, and accepts one that has it', () => {
    const wrongKind = entry({ usageClass: 'harness', artifacts: [artifact({ kind: 'session-log', ref: 'usage/log.txt' })] })
    expect(has(validateUsageEntry(wrongKind), 'class harness needs >=1 artifact of kind test-run')).toBe(true)
    const rightKind = entry({ usageClass: 'harness', artifacts: [artifact({ kind: 'test-run', ref: 'usage/vitest.txt' })] })
    expect(validateUsageEntry(rightKind)).toEqual([])
  })

  it('requires nothing of internal and docs entries', () => {
    for (const usageClass of ['internal', 'docs'] as const) {
      expect(validateUsageEntry(entry({ usageClass, boundaryStates: [], artifacts: [] }))).toEqual([])
    }
  })

  it('requires an unsupportedReason for the unsupported terminal', () => {
    const unsupported = entry({ usageClass: 'unsupported', boundaryStates: [], artifacts: [], attempted: ['log:tried headless'] })
    expect(has(validateUsageEntry({ ...unsupported, unsupportedReason: '  ' }), 'needs a non-empty unsupportedReason')).toBe(true)
    expect(validateUsageEntry({ ...unsupported, unsupportedReason: 'no display server in CI' })).toEqual([])
  })

  it('requires a non-empty attempted[] for the unsupported terminal', () => {
    const unsupported = entry({
      usageClass: 'unsupported',
      boundaryStates: [],
      artifacts: [],
      unsupportedReason: 'no display server in CI',
    })
    expect(has(validateUsageEntry({ ...unsupported, attempted: [] }), 'needs a non-empty attempted[]')).toBe(true)
    expect(has(validateUsageEntry({ ...unsupported, attempted: ['  '] }), 'needs a non-empty attempted[]')).toBe(true)
    expect(validateUsageEntry({ ...unsupported, attempted: ['log:xvfb missing'] })).toEqual([])
  })

  it('holds an undeclared entry as legal at declaration time', () => {
    expect(validateUsageEntry(USAGE_UNDECLARED_ENTRY())).toEqual([])
    expect(validateUsageEntry(USAGE_UNDECLARED_ENTRY('m7'))).toEqual([])
  })

  it('rejects an artifact with an empty ref', () => {
    expect(has(validateUsageEntry(entry({ artifacts: [artifact({ ref: '  ' })] })), 'ref is empty')).toBe(true)
    expect(has(validateUsageEntry(entry()), 'ref is empty')).toBe(false)
  })

  it('rejects an artifact with empty covers', () => {
    expect(has(validateUsageEntry(entry({ artifacts: [artifact({ covers: [] })] })), 'covers is empty')).toBe(true)
    expect(has(validateUsageEntry(entry({ artifacts: [artifact({ covers: ['  '] })] })), 'covers is empty')).toBe(true)
    expect(has(validateUsageEntry(entry()), 'covers is empty')).toBe(false)
  })

  it('rejects an inheritedFrom that is not a <run-id>/<ref> citation', () => {
    // `inheritedFrom` switches settlement OFF for that artifact (no containment,
    // no freshness, no existence, no size, no covered labels). A free-form
    // string therefore buys a total exemption for the price of one character,
    // so the shape is checked at declaration time, where the claim is made.
    for (const bad of ['x', 'run-42', '/usage/shot.png', 'run-42/', 'run-42/../../etc/passwd']) {
      const problems = validateUsageEntry(entry({ artifacts: [artifact({ inheritedFrom: bad })] }))
      expect(has(problems, 'inheritedFrom')).toBe(true)
    }
    // Cardinality floor for the negative half above.
    expect(['x', 'run-42', '/usage/shot.png', 'run-42/', 'run-42/../../etc/passwd'].length).toBeGreaterThanOrEqual(5)
  })

  it('accepts a well-formed inheritedFrom citation (positive control)', () => {
    const problems = validateUsageEntry(entry({ artifacts: [artifact({ inheritedFrom: 'run-42/usage/shot.png' })] }))
    expect(has(problems, 'inheritedFrom')).toBe(false)
    // and an absent field is not an inheritance claim at all
    expect(has(validateUsageEntry(entry()), 'inheritedFrom')).toBe(false)
  })

  it('rejects an artifact whose capturedAt does not parse as a date', () => {
    const bad = validateUsageEntry(entry({ artifacts: [artifact({ capturedAt: 'yesterday-ish' })] }))
    expect(has(bad, 'capturedAt is not a parsable date: yesterday-ish')).toBe(true)
    expect(has(validateUsageEntry(entry()), 'capturedAt is not a parsable date')).toBe(false)
  })
})

describe('usageDeclarationProblems', () => {
  it('exempts an absent dimension (legacy v1 stream)', () => {
    expect(usageDeclarationProblems(undefined)).toEqual([])
  })

  it('refuses a present dimension that declared no entries', () => {
    const problems = usageDeclarationProblems(usageOf())
    expect(has(problems, 'an empty entries list is not legacy-exempt')).toBe(true)
  })

  it('names the undeclared entry that blocks the plan gate', () => {
    const problems = usageDeclarationProblems(usageOf(entry({ id: 'm4' }), USAGE_UNDECLARED_ENTRY('m5')))
    expect(has(problems, 'usage entry m5 is undeclared')).toBe(true)
    expect(has(problems, 'usage entry m4 is undeclared')).toBe(false)
  })

  it('passes once every entry declared a class', () => {
    expect(usageDeclarationProblems(usageOf(entry({ id: 'm1' }), entry({ id: 'm2', usageClass: 'docs' })))).toEqual([])
  })
})

describe('hasFormatSignature', () => {
  it('accepts real image magic bytes for a screenshot', () => {
    expect(hasFormatSignature('screenshot', PNG_BYTES)).toBe(true)
    expect(hasFormatSignature('screenshot', JPEG_BYTES)).toBe(true)
    expect(hasFormatSignature('screenshot', 'GIF89a' + 'pixels')).toBe(true)
  })

  it('rejects a screenshot that is really just text', () => {
    expect(hasFormatSignature('screenshot', 'I promise this is a screenshot')).toBe(false)
    expect(hasFormatSignature('screenshot', '')).toBe(false)
  })

  it('accepts WebM and MP4 magic bytes for a screencast', () => {
    expect(hasFormatSignature('screencast', WEBM_BYTES)).toBe(true)
    expect(hasFormatSignature('screencast', MP4_BYTES)).toBe(true)
  })

  it('rejects a screencast whose ftyp box is beyond the header window', () => {
    expect(hasFormatSignature('screencast', 'x'.repeat(40) + 'ftyp')).toBe(false)
    expect(hasFormatSignature('screencast', 'recorded, honest')).toBe(false)
  })

  it('never signature-passes a text kind, even on real PNG bytes', () => {
    expect(hasFormatSignature('session-log', PNG_BYTES)).toBe(false)
    expect(hasFormatSignature('test-run', PNG_BYTES)).toBe(false)
  })
})

describe('settleUsageArtifacts', () => {
  const OPTIONS = { runDir: RUN_DIR, planGatePassedAt: ANCHOR }

  it('exempts an absent dimension (legacy v1 stream)', () => {
    expect(settleUsageArtifacts(undefined, OPTIONS)).toEqual([])
  })

  it('settles a clean binary artifact with no problems', () => {
    const usage = usageOf(entry())
    expect(settleUsageArtifacts(usage, { ...OPTIONS, readArtifact: constReader(PNG_BYTES.length, PNG_BYTES) })).toEqual([])
  })

  it('rejects an artifact that escapes the run directory, and accepts a nested one', () => {
    const escaped = usageOf(entry({ artifacts: [artifact({ ref: '../../elsewhere/shot.png' })] }))
    const problems = settleUsageArtifacts(escaped, { ...OPTIONS, readArtifact: constReader(9, PNG_BYTES) })
    expect(has(problems, 'resolves outside the run directory (containment)')).toBe(true)

    const nested = usageOf(entry({ artifacts: [artifact({ ref: 'usage/deep/shot.png' })] }))
    expect(has(settleUsageArtifacts(nested, { ...OPTIONS, readArtifact: constReader(9, PNG_BYTES) }), 'containment')).toBe(false)
  })

  it('rejects an absolute ref pointing outside the run directory', () => {
    const outside = resolve(RUN_DIR, '..', 'other-run', 'shot.png')
    const usage = usageOf(entry({ artifacts: [artifact({ ref: outside })] }))
    const problems = settleUsageArtifacts(usage, { ...OPTIONS, readArtifact: constReader(9, PNG_BYTES) })
    expect(has(problems, 'resolves outside the run directory (containment)')).toBe(true)
  })

  it('exempts an inherited artifact from containment and freshness, but not from a non-empty ref', () => {
    const inherited = usageOf(entry({
      artifacts: [artifact({ ref: '../previous/shot.png', capturedAt: BEFORE, inheritedFrom: 'run-42/usage/shot.png' })],
    }))
    // Would fail BOTH containment and freshness if it were not inherited.
    expect(settleUsageArtifacts(inherited, { ...OPTIONS, readArtifact: missingReader })).toEqual([])

    const notInherited = usageOf(entry({ artifacts: [artifact({ ref: '../previous/shot.png', capturedAt: BEFORE })] }))
    const problems = settleUsageArtifacts(notInherited, { ...OPTIONS, readArtifact: missingReader })
    expect(has(problems, 'containment')).toBe(true)

    const emptyRef = usageOf(entry({ artifacts: [artifact({ ref: '   ', inheritedFrom: 'run-42/usage/shot.png' })] }))
    expect(has(settleUsageArtifacts(emptyRef, { ...OPTIONS, readArtifact: missingReader }), 'ref is empty')).toBe(true)
  })

  it('rejects a zero-byte artifact, and accepts a non-empty one', () => {
    const usage = usageOf(entry())
    expect(has(settleUsageArtifacts(usage, { ...OPTIONS, readArtifact: constReader(0, '') }), 'is empty (0 bytes)')).toBe(true)
    expect(has(settleUsageArtifacts(usage, { ...OPTIONS, readArtifact: constReader(PNG_BYTES.length, PNG_BYTES) }), 'is empty (0 bytes)')).toBe(false)
  })

  it('rejects an artifact captured before the plan gate, and accepts one captured after', () => {
    const stale = usageOf(entry({ artifacts: [artifact({ capturedAt: BEFORE })] }))
    const problems = settleUsageArtifacts(stale, { ...OPTIONS, readArtifact: constReader(9, PNG_BYTES) })
    expect(has(problems, `capturedAt ${BEFORE} predates planGatePassedAt (freshness)`)).toBe(true)

    const fresh = usageOf(entry({ artifacts: [artifact({ capturedAt: AFTER })] }))
    expect(has(settleUsageArtifacts(fresh, { ...OPTIONS, readArtifact: constReader(9, PNG_BYTES) }), 'freshness')).toBe(false)
  })

  it('treats a missing planGatePassedAt as a problem when there are artifacts to settle', () => {
    const usage = usageOf(entry())
    const problems = settleUsageArtifacts(usage, { runDir: RUN_DIR, readArtifact: constReader(9, PNG_BYTES) })
    expect(has(problems, 'no planGatePassedAt: artifact freshness has no anchor')).toBe(true)
  })

  it('does not demand an anchor from a run with nothing to settle', () => {
    const usage = usageOf(entry({ usageClass: 'docs', boundaryStates: [], artifacts: [] }))
    expect(settleUsageArtifacts(usage, { runDir: RUN_DIR, readArtifact: constReader(9, PNG_BYTES) })).toEqual([])
  })

  it('reports an unparsable planGatePassedAt rather than silently skipping freshness', () => {
    const usage = usageOf(entry())
    const problems = settleUsageArtifacts(usage, { runDir: RUN_DIR, planGatePassedAt: 'after lunch', readArtifact: constReader(9, PNG_BYTES) })
    expect(has(problems, 'planGatePassedAt is not a parsable date: after lunch')).toBe(true)
  })

  it('REFUSES a short covers label on a binary artifact before the magic-byte return', () => {
    const usage = usageOf(entry({
      artifacts: [artifact({ kind: 'screenshot', covers: ['a'] })],
    }))
    expect(has(
      settleUsageArtifacts(usage, { ...OPTIONS, readArtifact: constReader(PNG_BYTES.length, PNG_BYTES) }),
      'too unspecific',
    )).toBe(true)
    const longEnough = usageOf(entry({
      artifacts: [artifact({ kind: 'screenshot', covers: ['empty'] })],
    }))
    expect(settleUsageArtifacts(longEnough, { ...OPTIONS, readArtifact: constReader(PNG_BYTES.length, PNG_BYTES) })).toEqual([])
  })

  it('REFUSES a blank covers member on a binary artifact beside a long-enough label', () => {
    const usage = usageOf(entry({
      artifacts: [artifact({ kind: 'screenshot', covers: ['empty', ''] })],
    }))
    expect(has(
      settleUsageArtifacts(usage, { ...OPTIONS, readArtifact: constReader(PNG_BYTES.length, PNG_BYTES) }),
      'too unspecific',
    )).toBe(true)
  })

  it('REFUSES a blank covers member on an inherited artifact beside a long-enough label', () => {
    const usage = usageOf(entry({
      artifacts: [artifact({ covers: ['empty', ''], inheritedFrom: 'run-42/usage/shot.png' })],
    }))
    expect(has(
      settleUsageArtifacts(usage, { ...OPTIONS, readArtifact: constReader(PNG_BYTES.length, PNG_BYTES) }),
      'too unspecific',
    )).toBe(true)
  })

  it('REFUSES a short covers label on an inherited artifact, which otherwise skips settlement', () => {
    const usage = usageOf(entry({
      artifacts: [artifact({ covers: ['a'], inheritedFrom: 'run-42/usage/shot.png' })],
    }))
    expect(has(
      settleUsageArtifacts(usage, { ...OPTIONS, readArtifact: constReader(PNG_BYTES.length, PNG_BYTES) }),
      'too unspecific',
    )).toBe(true)
    const longEnough = usageOf(entry({
      artifacts: [artifact({ covers: ['empty'], inheritedFrom: 'run-42/usage/shot.png' })],
    }))
    expect(settleUsageArtifacts(longEnough, { ...OPTIONS, readArtifact: constReader(PNG_BYTES.length, PNG_BYTES) })).toEqual([])
  })

  it('rejects a binary artifact without a format signature, and accepts one with it', () => {
    const usage = usageOf(entry())
    const lying = settleUsageArtifacts(usage, { ...OPTIONS, readArtifact: constReader(31, 'this file is definitely a png') })
    expect(has(lying, 'carries no screenshot format signature (magic bytes)')).toBe(true)
    expect(settleUsageArtifacts(usage, { ...OPTIONS, readArtifact: constReader(PNG_BYTES.length, PNG_BYTES) })).toEqual([])
  })

  it('rejects a text artifact that does not mention a covered label, and accepts one that mentions all', () => {
    const usage = usageOf(entry({
      artifacts: [artifact({ kind: 'session-log', ref: 'usage/cli.log', covers: ['empty', 'offline'] })],
    }))
    const partial = settleUsageArtifacts(usage, { ...OPTIONS, readArtifact: constReader(40, 'ran against an empty database, all good') })
    expect(has(partial, 'text does not mention covered label: offline')).toBe(true)
    expect(has(partial, 'text does not mention covered label: empty')).toBe(false)

    const full = settleUsageArtifacts(usage, { ...OPTIONS, readArtifact: constReader(48, 'Empty input handled; then OFFLINE mode exercised') })
    expect(full).toEqual([])
  })

  it('REFUSES a covers label shorter than MIN_COVERS_LABEL_LENGTH, even when the text contains it', () => {
    const unrelated = 'a totally unrelated transcript about cats and lasagne'
    for (const label of ['a', 'at']) {
      const usage = usageOf(entry({
        artifacts: [artifact({ kind: 'session-log', ref: 'usage/cli.log', covers: [label] })],
      }))
      expect(has(
        settleUsageArtifacts(usage, { ...OPTIONS, readArtifact: constReader(unrelated.length, unrelated) }),
        'too unspecific',
      )).toBe(true)
      expect(has(validateUsageEntry(entry({
        artifacts: [artifact({ kind: 'session-log', ref: 'usage/cli.log', covers: [label] })],
      })), 'too unspecific')).toBe(true)
    }
    const specific = usageOf(entry({
      artifacts: [artifact({ kind: 'session-log', ref: 'usage/cli.log', covers: ['3 of 3 shards migrated'] })],
    }))
    expect(has(
      settleUsageArtifacts(specific, { ...OPTIONS, readArtifact: constReader(unrelated.length, unrelated) }),
      'text does not mention covered label: 3 of 3 shards migrated',
    )).toBe(true)
    const tsc = usageOf(entry({
      artifacts: [artifact({ kind: 'session-log', ref: 'usage/cli.log', covers: ['tsc'] })],
    }))
    expect(settleUsageArtifacts(tsc, { ...OPTIONS, readArtifact: constReader(16, 'tsc exited 0\n') })).toEqual([])
  })

  it('does not settle artifacts attached to a class that promised none', () => {
    // A docs entry that carries a would-be-invalid artifact settles clean:
    // settlement enforces the promise made, it does not invent one.
    const usage = usageOf(entry({
      usageClass: 'docs',
      boundaryStates: [],
      artifacts: [artifact({ ref: '../escaped.png', capturedAt: BEFORE })],
    }))
    expect(settleUsageArtifacts(usage, { ...OPTIONS, readArtifact: missingReader })).toEqual([])
  })

  it('reports an unreadable artifact through the default node:fs reader instead of throwing', () => {
    const usage = usageOf(entry({ artifacts: [artifact({ ref: 'usage/never-written.png' })] }))
    let problems: readonly string[] = []
    expect(() => { problems = settleUsageArtifacts(usage, OPTIONS) }).not.toThrow()
    expect(has(problems, 'is unreadable at')).toBe(true)
  })

  it('settles a real on-disk text artifact through the default reader', () => {
    // The default reader is exercised against a file that genuinely exists in
    // this repo. Moving-Anchor: assert in place that the covered label is
    // actually present, rather than trusting a remembered file content.
    const runDir = process.cwd()
    const label = 'dsh-autopilot'
    expect(readFileSync(resolve(runDir, 'package.json'), 'utf8')).toContain(label)

    const usage = usageOf(entry({
      artifacts: [artifact({ kind: 'session-log', ref: 'package.json', covers: [label] })],
    }))
    expect(settleUsageArtifacts(usage, { runDir, planGatePassedAt: ANCHOR })).toEqual([])
  })
})

/**
 * Branches that were live in shipped code and unobservable by the suite.
 *
 * Each was confirmed reachable, then confirmed unguarded by mutation: flipping
 * it left the whole suite green. A checker whose fail nobody has observed
 * carries no information when it passes (DESIGN.md §5).
 */
describe('containment equality and the empty-needle matcher', () => {
  const OPTIONS = { runDir: RUN_DIR, planGatePassedAt: ANCHOR }

  it('the run directory is NOT inside itself', () => {
    // `resolve(runDir, '.') === runDir`. NOTE (measured 2026-08-25): for an
    // ordinary run directory this fixture is borne by the trailing-SEPARATOR
    // prefix, not by the equality guard — deleting `candidate === runDir`
    // alone leaves the whole suite green. The case that isolates the guard is
    // the separator-ending runDir below. A directory bears no evidence either way.
    const selfRef = usageOf(entry({ artifacts: [artifact({ ref: '.' })] }))
    expect(has(settleUsageArtifacts(selfRef, { ...OPTIONS, readArtifact: constReader(9, PNG_BYTES) }),
      'resolves outside the run directory (containment)')).toBe(true)
    // The same shape via a round trip, so the rule is not spelled '.'-specific.
    const roundTrip = usageOf(entry({ artifacts: [artifact({ ref: 'usage/..' })] }))
    expect(has(settleUsageArtifacts(roundTrip, { ...OPTIONS, readArtifact: constReader(9, PNG_BYTES) }),
      'resolves outside the run directory (containment)')).toBe(true)
    // DETECTOR: a genuinely nested ref is still clean.
    const nested = usageOf(entry({ artifacts: [artifact({ ref: 'usage/deep/shot.png' })] }))
    expect(has(settleUsageArtifacts(nested, { ...OPTIONS, readArtifact: constReader(9, PNG_BYTES) }), 'containment'))
      .toBe(false)
  })

  it('a BLANK covered label beside a satisfiable one is refused at the covers floor', () => {
    const mixed = usageOf(entry({
      usageClass: 'cli',
      artifacts: [artifact({ kind: 'session-log', ref: 'usage/run.log', covers: ['empty', ''] })],
    }))
    expect(has(validateUsageEntry(mixed.entries[0] as UsageEntry), 'too unspecific')).toBe(true)
    const problems = settleUsageArtifacts(mixed, { ...OPTIONS, readArtifact: constReader(20, 'empty state shown\n') })
    expect(has(problems, 'too unspecific')).toBe(true)
    const clean = usageOf(entry({
      usageClass: 'cli',
      artifacts: [artifact({ kind: 'session-log', ref: 'usage/run.log', covers: ['empty'] })],
    }))
    expect(settleUsageArtifacts(clean, { ...OPTIONS, readArtifact: constReader(20, 'empty state shown\n') })).toEqual([])
  })
  it('refuses a SIBLING whose name merely extends the run directory name (segment boundary)', () => {
    // Containment is separator-aware. `<runDir>-evil/shot.png` string-startsWith
    // runDir but is not inside it, and such a file genuinely exists and reads,
    // so nothing downstream reports it: the rule must fail on the PATH, before
    // the read. Dropping the trailing-separator append left all 17 files / 468
    // tests green on 2026-08-25 — the existing fixtures cover the
    // `..`-escapes-entirely half of this rule, never the boundary half.
    const relative = usageOf(entry({ artifacts: [artifact({ ref: `../${basename(RUN_DIR)}-evil/shot.png` })] }))
    expect(has(settleUsageArtifacts(relative, { ...OPTIONS, readArtifact: constReader(9, PNG_BYTES) }),
      'resolves outside the run directory (containment)')).toBe(true)

    // The same reach expressed as an absolute ref.
    const absolute = usageOf(entry({ artifacts: [artifact({ ref: `${RUN_DIR}-evil${sep}shot.png` })] }))
    expect(has(settleUsageArtifacts(absolute, { ...OPTIONS, readArtifact: constReader(9, PNG_BYTES) }),
      'resolves outside the run directory (containment)')).toBe(true)

    // DETECTOR: a ref that shares the '-evil' suffix but sits INSIDE the run
    // directory settles clean on identical bytes, so the assertions above are
    // about the segment boundary and not about the reader or the name.
    const inside = usageOf(entry({ artifacts: [artifact({ ref: 'shot-evil.png' })] }))
    expect(settleUsageArtifacts(inside, { ...OPTIONS, readArtifact: constReader(9, PNG_BYTES) })).toEqual([])
  })

  it('the run directory is not inside itself even when its path already ends in a separator', () => {
    // This is the fixture that ISOLATES the `candidate === runDir` guard. For
    // an ordinary runDir the guard is redundant with the trailing-separator
    // prefix; it is load-bearing exactly when runDir already ends in `sep` (a
    // filesystem root), where prefix === runDir and startsWith is trivially
    // true. Measured 2026-08-25: without this case, deleting the guard is free.
    const root = parse(process.cwd()).root
    expect(root.endsWith(sep)).toBe(true)
    const rootOptions = { runDir: root, planGatePassedAt: ANCHOR, readArtifact: constReader(9, PNG_BYTES) }

    const selfRef = usageOf(entry({ artifacts: [artifact({ ref: '.' })] }))
    expect(has(settleUsageArtifacts(selfRef, rootOptions),
      'resolves outside the run directory (containment)')).toBe(true)

    // DETECTOR: a genuinely nested ref under the same root settles clean, so
    // the assertion above is about self-equality and not about the root path.
    const nested = usageOf(entry({ artifacts: [artifact({ ref: `usage${sep}shot.png` })] }))
    expect(settleUsageArtifacts(nested, rootOptions)).toEqual([])
  })
})

describe('the default artifact decoder (UTF-8 when valid, latin1 otherwise)', () => {
  const OPTIONS = { runDir: RUN_DIR, planGatePassedAt: ANCHOR }

  it('matches a NON-ASCII covered label, which latin1 alone would mangle', () => {
    // Every settlement fixture in this file is ASCII, so replacing the whole
    // decode body with `buffer.toString('latin1')` left the suite green. A
    // UTF-8 label is what distinguishes the two decoders.
    const text = Buffer.from('界面为空：empty state\n', 'utf8')
    const usage = usageOf(entry({
      usageClass: 'cli',
      artifacts: [artifact({ kind: 'session-log', ref: 'usage/run.log', covers: ['界面为空'] })],
    }))
    const utf8Reader = (): UsageArtifactRead => ({ size: text.length, text: text.toString('utf8') })
    expect(settleUsageArtifacts(usage, { ...OPTIONS, readArtifact: utf8Reader })).toEqual([])
    // DETECTOR: the SAME bytes read as latin1 no longer bear the label.
    const latin1Reader = (): UsageArtifactRead => ({ size: text.length, text: text.toString('latin1') })
    expect(has(settleUsageArtifacts(usage, { ...OPTIONS, readArtifact: latin1Reader }),
      'text does not mention covered label')).toBe(true)
  })

  it('preserves binary magic bytes, which a UTF-8 decode would collapse into U+FFFD', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe])
    const usage = usageOf(entry({ artifacts: [artifact({ kind: 'screenshot', ref: 'usage/shot.png' })] }))
    const latin1Reader = (): UsageArtifactRead => ({ size: png.length, text: png.toString('latin1') })
    expect(settleUsageArtifacts(usage, { ...OPTIONS, readArtifact: latin1Reader })).toEqual([])
    // DETECTOR: the same bytes forced through UTF-8 lose the signature.
    const utf8Reader = (): UsageArtifactRead => ({ size: png.length, text: png.toString('utf8') })
    expect(has(settleUsageArtifacts(usage, { ...OPTIONS, readArtifact: utf8Reader }),
      'carries no screenshot format signature')).toBe(true)
    // and the round-trip predicate the real decoder uses agrees with that split
    expect(Buffer.from(png.toString('utf8'), 'utf8').equals(png)).toBe(false)
    expect(Buffer.from(Buffer.from('界面为空', 'utf8').toString('utf8'), 'utf8')
      .equals(Buffer.from('界面为空', 'utf8'))).toBe(true)
  })
})

describe('usageDeclarationProblems applies the STRUCTURAL rules too', () => {
  it('refuses a hollow declaration, not only a literally undeclared one', () => {
    // Measured before the fix: `usageDeclarationProblems` reported ONLY entries
    // whose class was literally 'undeclared', so `{usageClass:'gui'}` with zero
    // boundary states and zero artifacts returned []. `validateUsageEntry` — on
    // the same entry — returned three problems, and was invoked at exactly two
    // writer sites and never on the replay path.
    const hollow: UsageEntry = { id: 'm1', usageClass: 'gui', boundaryStates: [], artifacts: [], attempted: [] }
    expect(validateUsageEntry(hollow).length).toBe(3)
    const problems = usageDeclarationProblems(usageOf(hollow))
    expect(has(problems, 'needs >=2 boundary states')).toBe(true)
    expect(has(problems, 'needs >=1 artifact')).toBe(true)
  })

  it('positive control: a sound entry, and the legacy exemption, are unchanged', () => {
    expect(usageDeclarationProblems(usageOf(entry()))).toEqual([])
    expect(usageDeclarationProblems(undefined)).toEqual([])
    expect(has(usageDeclarationProblems(usageOf(USAGE_UNDECLARED_ENTRY())), 'is undeclared')).toBe(true)
  })
})

/**
 * The DEFAULT reader and its decoder, driven over a real filesystem.
 *
 * Every other settlement fixture in this file injects `readArtifact`, so the
 * production reader — and the UTF-8-when-valid / latin1-otherwise round trip
 * inside it — was never executed by the suite at all: replacing the whole
 * decode body with `buffer.toString('latin1')` left every test green. These two
 * write real bytes and omit `readArtifact` entirely.
 */
describe('defaultReadArtifact over real files', () => {
  function runDirWith(files: Record<string, Buffer>): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-autopilot-usage-'))
    for (const [ref, bytes] of Object.entries(files)) {
      const target = join(dir, ref)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes)
    }
    return dir
  }

  it('reads a UTF-8 log off disk and matches a NON-ASCII covered label', () => {
    const dir = runDirWith({ 'usage/run.log': Buffer.from('界面为空: empty state shown' + String.fromCharCode(10), 'utf8') })
    const usage = usageOf(entry({
      usageClass: 'cli',
      artifacts: [artifact({ kind: 'session-log', ref: 'usage/run.log', covers: ['界面为空'] })],
    }))
    expect(settleUsageArtifacts(usage, { runDir: dir, planGatePassedAt: ANCHOR })).toEqual([])
    // DETECTOR: a label the file does not carry is still refused, off the same disk.
    const missing = usageOf(entry({
      usageClass: 'cli',
      artifacts: [artifact({ kind: 'session-log', ref: 'usage/run.log', covers: ['错误路径'] })],
    }))
    expect(has(settleUsageArtifacts(missing, { runDir: dir, planGatePassedAt: ANCHOR }),
      'text does not mention covered label')).toBe(true)
  })

  it('reads real PNG bytes off disk with their magic number intact', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01])
    const dir = runDirWith({ 'usage/shot.png': png, 'usage/not-a-png.png': Buffer.from('plain text, no magic' + String.fromCharCode(10), 'utf8') })
    const good = usageOf(entry({ artifacts: [artifact({ kind: 'screenshot', ref: 'usage/shot.png' })] }))
    expect(settleUsageArtifacts(good, { runDir: dir, planGatePassedAt: ANCHOR })).toEqual([])
    // DETECTOR: a file WITHOUT the magic number fails on the same path.
    const bad = usageOf(entry({ artifacts: [artifact({ kind: 'screenshot', ref: 'usage/not-a-png.png' })] }))
    expect(has(settleUsageArtifacts(bad, { runDir: dir, planGatePassedAt: ANCHOR }),
      'carries no screenshot format signature')).toBe(true)
    // and a ref that is not there at all is unreadable rather than silently clean
    const absent = usageOf(entry({ artifacts: [artifact({ kind: 'screenshot', ref: 'usage/gone.png' })] }))
    expect(has(settleUsageArtifacts(absent, { runDir: dir, planGatePassedAt: ANCHOR }), 'is unreadable')).toBe(true)
  })
})

/**
 * PRESENT-BUT-BLANK OPTIONAL STRINGS.
 *
 * Found on the real dsh host, not here: the model this profile runs emits every
 * optional key of a tool schema, so `inheritedFrom: ''` arrived on ORDINARY
 * declarations, and `validateUsageEntry` rejected it as malformed. Three live
 * sessions died on the same line:
 *
 *   Error: usage declaration rejected: entry m1 artifact usage-note.txt:
 *   inheritedFrom is present but blank
 *
 * Artifacts are carried by exactly the classes that REQUIRE evidence
 * (gui|cli|api-behavior|harness), so one blank string made all four unreachable
 * and left only the classes that require none. The suite could not see it
 * because every fixture in this file constructs entries in TypeScript, where an
 * optional key that is not wanted is simply not written.
 */
describe('a present-but-blank optional string is ABSENT, not malformed', () => {
  const OPTIONS = { runDir: RUN_DIR, planGatePassedAt: ANCHOR }

  it('accepts a blank inheritedFrom on an otherwise sound artifact-bearing entry', () => {
    for (const blank of ['', ' ', '\t', '   \n  ']) {
      const declared = entry({ artifacts: [artifact({ inheritedFrom: blank })] })
      // The WHOLE entry, not merely the absence of the inheritedFrom phrase:
      // the live failure was that this array was non-empty at all.
      expect(validateUsageEntry(declared)).toEqual([])
      expect(usageDeclarationProblems(usageOf(declared))).toEqual([])
    }
  })

  it('applies to every artifact-requiring class, which is the set the defect emptied', () => {
    // Moving-Anchor: the classes are enumerated from the rule that defines
    // them, so a class added to USAGE_VISIBLE_CLASSES cannot silently escape.
    for (const usageClass of [...USAGE_VISIBLE_CLASSES, 'harness'] as const) {
      const kind = usageClass === 'harness' ? 'test-run' as const : 'screenshot' as const
      const declared = entry({ usageClass, artifacts: [artifact({ kind, inheritedFrom: '' })] })
      expect(validateUsageEntry(declared)).toEqual([])
    }
    expect([...USAGE_VISIBLE_CLASSES, 'harness'].length).toBeGreaterThanOrEqual(4)
  })

  it('DETECTOR: a citation that is present and genuinely malformed is still refused', () => {
    // The repair must not be "stop checking inheritedFrom". Blank is absent;
    // anything with content still has to read as `<run-id>/<ref>`.
    for (const bad of ['x', 'run-42', '/usage/shot.png', 'run-42/', '  run-42/  ', 'run-42/../../etc/passwd']) {
      const problems = validateUsageEntry(entry({ artifacts: [artifact({ inheritedFrom: bad })] }))
      expect(has(problems, 'inheritedFrom')).toBe(true)
    }
    // and the well-formed citation is still accepted
    expect(validateUsageEntry(entry({ artifacts: [artifact({ inheritedFrom: 'run-42/usage/shot.png' })] }))).toEqual([])
  })

  it('a blank citation buys NO settlement exemption: the artifact settles in full', () => {
    // This is why blank-is-absent is safe rather than merely lenient. Had the
    // two sides been reconciled the other way - blank counts as a citation -
    // an empty string would have switched containment, freshness, existence,
    // size and covered-label checking OFF for the artifact it was written on.
    const blank = usageOf(entry({
      artifacts: [artifact({ ref: '../previous/shot.png', capturedAt: BEFORE, inheritedFrom: '  ' })],
    }))
    const problems = settleUsageArtifacts(blank, { ...OPTIONS, readArtifact: missingReader })
    expect(has(problems, 'resolves outside the run directory (containment)')).toBe(true)

    // DETECTOR: the SAME artifact with a real citation is exempt, so the
    // assertion above is about the blank and not about the ref.
    const cited = usageOf(entry({
      artifacts: [artifact({ ref: '../previous/shot.png', capturedAt: BEFORE, inheritedFrom: 'run-42/usage/shot.png' })],
    }))
    expect(settleUsageArtifacts(cited, { ...OPTIONS, readArtifact: missingReader })).toEqual([])
  })

  it('declaration and settlement now agree about what blank means', () => {
    // The defect was an ASYMMETRY, not a missing rule: `settleArtifact` already
    // read `(inheritedFrom ?? '').trim()` and treated blank as absent, while
    // the declaration rule keyed on `!== undefined`. Assert the agreement
    // directly, driving both real functions over one artifact.
    const blankCited = entry({ artifacts: [artifact({ ref: 'usage/shot.png', inheritedFrom: '' })] })
    const absent = entry({ artifacts: [artifact({ ref: 'usage/shot.png' })] })
    expect(validateUsageEntry(blankCited)).toEqual(validateUsageEntry(absent))
    // Compared on an artifact that FAILS settlement, because two clean
    // settlements agree trivially whether or not the blank was exempted: the
    // divergence only becomes observable when there is a problem to lose.
    const settledBlank = settleUsageArtifacts(usageOf(blankCited), { ...OPTIONS, readArtifact: missingReader })
    expect(has(settledBlank, 'is unreadable at')).toBe(true)
    expect(settledBlank).toEqual(settleUsageArtifacts(usageOf(absent), { ...OPTIONS, readArtifact: missingReader }))
    // and the clean case agrees too
    const read = constReader(PNG_BYTES.length, PNG_BYTES)
    expect(settleUsageArtifacts(usageOf(blankCited), { ...OPTIONS, readArtifact: read }))
      .toEqual(settleUsageArtifacts(usageOf(absent), { ...OPTIONS, readArtifact: read }))
  })
})

/**
 * The same defect across the REAL writer boundary.
 *
 * Every other fixture in this file hands `validateUsageEntry` an object built
 * in TypeScript - which is precisely why the suite could be 556-green while the
 * host rejected every artifact-bearing declaration. The blank does not
 * originate in the domain: it originates in a JSON tool argument, and
 * `autopilot_usage` forwards it verbatim because its mapping drops a key only
 * when it is literally `undefined` (`src/tools.ts`, the `inheritedFrom` and
 * `unsupportedReason` spreads). These drive the REAL tool over the REAL engine
 * with model-shaped args, so the mapping is exercised rather than assumed.
 */
describe('autopilot_usage over the real engine, with model-shaped JSON args', () => {
  interface ToolDef { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }

  /** Install the REAL root tools against a real engine and return one by name. */
  function toolOf(engine: unknown, name: string): ToolDef {
    const defs = new Map<string, ToolDef>()
    const registry: ToolRegistryRef = {
      register(definition: unknown) {
        const def = definition as ToolDef
        defs.set(def.name, def)
        return () => {}
      },
    }
    installRootTools(registry, engine as never)
    const found = defs.get(name)
    if (found === undefined) throw new Error(name + ' was not registered')
    return found
  }

  const EXEC = (agent: unknown) => ({ agent, signal: new AbortController().signal })

  /** The args a model that emits EVERY optional key actually sends. */
  function everyOptionalKeyBlank(): Record<string, unknown> {
    return {
      id: 'm1',
      usageClass: 'cli',
      boundaryStates: ['empty', 'error-path'],
      artifacts: [{
        kind: 'session-log',
        ref: 'usage-note.txt',
        covers: ['empty'],
        capturedAt: new Date().toISOString(),
        inheritedFrom: '',
      }],
      unsupportedReason: '',
      attempted: [],
    }
  }

  async function started() {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage(), [undeclaredSeed()])
    return h
  }

  it('accepts the declaration the real host rejected three times', async () => {
    const h = await started()
    await toolOf(h.engine, 'autopilot_usage').execute(everyOptionalKeyBlank(), EXEC(h.root))
    const snapshot = h.engine.peek(h.root.id)
    const stored = snapshot?.usage?.entries.find(item => item.id === 'm1')
    expect(stored?.usageClass).toBe('cli')
    // The blank reached the domain rather than being scrubbed on the way in -
    // which is why the rule, not the writer, had to be the thing that changed.
    expect(stored?.artifacts[0]?.inheritedFrom).toBe('')
  })

  it('DETECTOR: the same call with a malformed citation is still refused, with the live error text', async () => {
    const h = await started()
    const args = everyOptionalKeyBlank()
    const artifacts = args.artifacts as Array<Record<string, unknown>>
    args.artifacts = artifacts.map(item => ({ ...item, inheritedFrom: 'run-42' }))
    await expect(toolOf(h.engine, 'autopilot_usage').execute(args, EXEC(h.root)))
      .rejects.toThrowError(/usage declaration rejected: .*inheritedFrom must be/)
  })

  it('DETECTOR: a blank unsupportedReason is still refused for the unsupported terminal', async () => {
    // The blank-is-absent repair is scoped to fields whose ABSENCE is legal.
    // `unsupportedReason` is REQUIRED by its class, so blank must stay fatal -
    // and it already was, because that rule was written with `.trim()`.
    const h = await started()
    await expect(toolOf(h.engine, 'autopilot_usage').execute({
      ...everyOptionalKeyBlank(),
      usageClass: 'unsupported',
      boundaryStates: [],
      artifacts: [],
      attempted: ['log:tried headless'],
    }, EXEC(h.root))).rejects.toThrowError(/needs a non-empty unsupportedReason/)
  })
})

/**
 * FRESHNESS IS A WINDOW, NOT A FLOOR.
 *
 * Live behaviour behind this: pushed for artifact metadata, the model invented
 * `capturedAt: '2025-02-14T00:00:00Z'` - a stamp with no relationship to the
 * run. The plan-gate anchor catches THAT one. It cannot catch its mirror: once
 * a model has learned "capturedAt must post-date the gate", the cheapest
 * fabrication is a stamp in the FUTURE, which satisfies a half-open window by
 * construction and can never be contradicted.
 *
 * `settledAt` is opt-in and is NOT defaulted to a clock, because
 * `evaluateCompletion` is also run on the replay path (see `SettleUsageOptions`).
 * Deployment is therefore a caller decision, and the last test here records
 * exactly what the rule does NOT do while no caller supplies it.
 */
describe('the freshness window: settledAt bounds capturedAt from above', () => {
  const SETTLED = '2026-08-24T12:00:00.000Z'
  const FABRICATED_FUTURE = '2027-06-01T00:00:00.000Z'
  const OPTIONS = { runDir: RUN_DIR, planGatePassedAt: ANCHOR, settledAt: SETTLED }

  // Moving-Anchor: the fixtures are ordered BECAUSE of what they are, so assert
  // the ordering in place rather than trusting four remembered literals.
  it('the fixture stamps really do straddle the window', () => {
    expect(Date.parse(BEFORE)).toBeLessThan(Date.parse(ANCHOR))
    expect(Date.parse(ANCHOR)).toBeLessThan(Date.parse(AFTER))
    expect(Date.parse(AFTER)).toBeLessThan(Date.parse(SETTLED))
    expect(Date.parse(SETTLED)).toBeLessThan(Date.parse(FABRICATED_FUTURE))
  })

  it('rejects an artifact captured AFTER settlement, and accepts one inside the window', () => {
    const fabricated = usageOf(entry({ artifacts: [artifact({ capturedAt: FABRICATED_FUTURE })] }))
    const problems = settleUsageArtifacts(fabricated, { ...OPTIONS, readArtifact: constReader(9, PNG_BYTES) })
    expect(has(problems, 'capturedAt ' + FABRICATED_FUTURE + ' postdates settledAt ' + SETTLED)).toBe(true)

    const inside = usageOf(entry({ artifacts: [artifact({ capturedAt: AFTER })] }))
    expect(settleUsageArtifacts(inside, { ...OPTIONS, readArtifact: constReader(9, PNG_BYTES) })).toEqual([])
  })

  it('tolerates clock skew above settledAt, which is the whole reason the bound is not a hard <=', () => {
    // Wired into production 2026-08-25: `submitCloseout` now passes
    // `settledAt: new Date().toISOString()`. A hard `>` immediately failed a
    // real closeout whose artifact was stamped ~1s ahead of the settling clock,
    // so the bound carries the same tolerance as its sibling — the outbound
    // manifest's `createdAt` upper bound — from the one shared constant.
    // Moving-Anchor: derive the stamps FROM the constant, never from literals
    // that would silently stop straddling it if the constant changed.
    const jitter = new Date(Date.parse(SETTLED) + FUTURE_SKEW_MS - 1).toISOString()
    const beyond = new Date(Date.parse(SETTLED) + FUTURE_SKEW_MS + 1000).toISOString()
    expect(Date.parse(jitter)).toBeGreaterThan(Date.parse(SETTLED))
    expect(Date.parse(beyond)).toBeGreaterThan(Date.parse(jitter))

    const tolerated = usageOf(entry({ artifacts: [artifact({ capturedAt: jitter })] }))
    expect(settleUsageArtifacts(tolerated, { ...OPTIONS, readArtifact: constReader(9, PNG_BYTES) })).toEqual([])

    const refused = usageOf(entry({ artifacts: [artifact({ capturedAt: beyond })] }))
    expect(has(
      settleUsageArtifacts(refused, { ...OPTIONS, readArtifact: constReader(9, PNG_BYTES) }),
      'clock-skew tolerance',
    )).toBe(true)
  })

  it('keeps the LOWER bound while the upper one is in force (both ends, one artifact each)', () => {
    const stale = usageOf(entry({ artifacts: [artifact({ capturedAt: BEFORE })] }))
    const problems = settleUsageArtifacts(stale, { ...OPTIONS, readArtifact: constReader(9, PNG_BYTES) })
    expect(has(problems, 'capturedAt ' + BEFORE + ' predates planGatePassedAt (freshness)')).toBe(true)
    expect(has(problems, 'postdates settledAt')).toBe(false)
  })

  it('bounds capturedAt from above even with NO plan-gate anchor at all', () => {
    // The two bounds are independent rules. Without this, an upper bound that
    // was accidentally nested inside the anchor branch would still pass.
    const fabricated = usageOf(entry({ artifacts: [artifact({ capturedAt: FABRICATED_FUTURE })] }))
    const problems = settleUsageArtifacts(fabricated, {
      runDir: RUN_DIR, settledAt: SETTLED, readArtifact: constReader(9, PNG_BYTES),
    })
    expect(has(problems, 'postdates settledAt')).toBe(true)
    // the anchor is still separately demanded, and the two problems are distinct
    expect(has(problems, 'no planGatePassedAt: artifact freshness has no anchor')).toBe(true)
  })

  it('reports an unparsable settledAt rather than silently dropping the upper bound', () => {
    const usage = usageOf(entry())
    const problems = settleUsageArtifacts(usage, {
      runDir: RUN_DIR, planGatePassedAt: ANCHOR, settledAt: 'just now', readArtifact: constReader(9, PNG_BYTES),
    })
    expect(has(problems, 'settledAt is not a parsable date: just now')).toBe(true)
  })

  it('an unparsable capturedAt is reported when EITHER bound is in force', () => {
    const usage = usageOf(entry({ artifacts: [artifact({ capturedAt: 'sometime tuesday' })] }))
    const anchorOnly = settleUsageArtifacts(usage, { runDir: RUN_DIR, planGatePassedAt: ANCHOR, readArtifact: constReader(9, PNG_BYTES) })
    expect(has(anchorOnly, 'capturedAt is not a parsable date: sometime tuesday')).toBe(true)
    const settledOnly = settleUsageArtifacts(usage, { runDir: RUN_DIR, settledAt: SETTLED, readArtifact: constReader(9, PNG_BYTES) })
    expect(has(settledOnly, 'capturedAt is not a parsable date: sometime tuesday')).toBe(true)
  })

  it('RECORDED CEILING: with no settledAt supplied, a fabricated future stamp settles clean', () => {
    // The honest statement of what is deployed TODAY. `AutopilotEngine` passes
    // `settleUsage` without a `settledAt`, so the shipped window is still
    // half-open and this artifact - captured, on its own claim, in 2027 -
    // settles with no problems at all.
    const fabricated = usageOf(entry({ artifacts: [artifact({ capturedAt: FABRICATED_FUTURE })] }))
    expect(settleUsageArtifacts(fabricated, {
      runDir: RUN_DIR, planGatePassedAt: ANCHOR, readArtifact: constReader(9, PNG_BYTES),
    })).toEqual([])
    // DETECTOR in the same shape: supplying the bound DOES observe it, so the
    // pass above is a statement about deployment and not about the rule.
    expect(has(settleUsageArtifacts(fabricated, {
      runDir: RUN_DIR, planGatePassedAt: ANCHOR, settledAt: SETTLED, readArtifact: constReader(9, PNG_BYTES),
    }), 'postdates settledAt')).toBe(true)
  })
})
