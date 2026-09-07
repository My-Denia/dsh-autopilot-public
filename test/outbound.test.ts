/**
 * Outbound evidence manifest tests.
 *
 * Checker-Resolution discipline (DESIGN.md §5): every rule gets BOTH a
 * positive and a negative fixture, and the negative asserts the rule's own
 * distinguishing phrase — never a problem COUNT, which cannot tell one fail
 * from another. Fixtures chosen "because they are invalid" assert in place
 * that they are still outside the accepted set.
 */

import { describe, expect, it } from 'vitest'
import { basename, join, resolve } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  WORKSPACE_MANIFEST_DIR,
  archiveConsumed,
  countClaims,
  isSandboxWritable,
  manifestCandidates,
  manifestPath,
  matchesAtTokenBoundary,
  missingManifestReason,
  parseManifest,
  renderManifestTemplate,
  sandboxWritableRoots,
  validateManifest,
} from '../src/outbound/manifest.js'
import type { ManifestContext } from '../src/outbound/manifest.js'
import { AutopilotError, OUTBOUND_STALE_MS } from '../src/domain/types.js'
import type { OutboundManifest } from '../src/domain/types.js'

/** Fixed validation clock: freshness must be asserted against an injected instant, never wall time. */
const NOW = Date.parse('2026-08-24T12:00:00.000Z')

/** Absolute run directory; containment is a path question, so no filesystem is needed. */
const RUN_DIR = resolve('outbound-fixture-run')

/** Map-backed artifact reader: refs are run-directory-relative, keys are the resolved absolute paths. */
function reader(files: Record<string, string>): ManifestContext['readArtifact'] {
  const map = new Map<string, { size: number; text: string }>()
  for (const [ref, text] of Object.entries(files)) {
    map.set(resolve(RUN_DIR, ref), { size: Buffer.byteLength(text, 'utf8'), text })
  }
  return absPath => map.get(absPath)
}

function makeManifest(overrides: Partial<OutboundManifest> = {}): OutboundManifest {
  return {
    v: 1,
    runId: 'run-1',
    target: 'PR description for milestone B',
    commands: ['git push'],
    claims: [{ text: 'the outbound gate validates manifests', bearer: 'evidence/gate.txt' }],
    artifacts: [{ ref: 'evidence/gate.txt', covers: ['gate'] }],
    createdAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  }
}

function makeCtx(overrides: Partial<ManifestContext> = {}): ManifestContext {
  return {
    runId: 'run-1',
    command: 'git push origin main',
    runDir: RUN_DIR,
    now: NOW,
    readArtifact: reader({ 'evidence/gate.txt': 'gate decision matrix output\n' }),
    ...overrides,
  }
}

/** Assert that at least one problem carries this rule's distinguishing phrase. */
function has(problems: readonly string[], phrase: string): boolean {
  return problems.some(problem => problem.includes(phrase))
}

describe('manifestPath', () => {
  it('defaults to <runDir>/outbound/manifest.json', () => {
    expect(manifestPath('/runs/r1', {})).toBe(join('/runs/r1', 'outbound', 'manifest.json'))
  })

  it('honours an absolute owner pin verbatim', () => {
    const pin = resolve('/owner/pinned-manifest.json')
    const pinned = manifestPath('/runs/r1', { DSH_AUTOPILOT_OUTBOUND_MANIFEST: pin })
    expect(pinned).toBe(pin)
    // Negative half: prove the override is observable, i.e. it really moved the path.
    expect(pinned).not.toBe(manifestPath('/runs/r1', {}))
  })

  it('ignores a blank pin rather than resolving it to the cwd', () => {
    expect(manifestPath('/runs/r1', { DSH_AUTOPILOT_OUTBOUND_MANIFEST: '   ' }))
      .toBe(join('/runs/r1', 'outbound', 'manifest.json'))
  })

  it('resolves a relative pin against the process cwd, not the run directory', () => {
    const result = manifestPath('/runs/r1', { DSH_AUTOPILOT_OUTBOUND_MANIFEST: 'pinned.json' })
    expect(result).toBe(resolve('pinned.json'))
    expect(result.includes(join('runs', 'r1'))).toBe(false)
  })
})

/**
 * THE 2026-08-25 DEPLOYMENT DEFECT. On the real host the gate denied egress
 * nine times with an instruction to write `<runDir>/outbound/manifest.json` —
 * a path under `$DSH_HOME`, while the fs/shell sandbox's workspace-write roots
 * are the session cwd plus the platform temp dirs. The boundary held; the
 * remediation was impossible to perform. These fix the two halves: a second,
 * WRITABLE candidate, and an annotation that says which is which.
 */
describe('manifestCandidates', () => {
  // Root-anchored, not cwd-relative: under a cwd inside the platform temp dir
  // (a mutation sandbox, a CI runner) a cwd-relative fixture lands under the
  // temp WRITABLE ROOT, and the negative half below stops proving containment.
  const WORKSPACE = resolve('/srv/workspace-fixture')

  it('consults the run directory FIRST and a workspace path SECOND', () => {
    const candidates = manifestCandidates('/runs/r1', { env: {}, workspaceRoot: WORKSPACE })
    expect(candidates).toEqual([
      join('/runs/r1', 'outbound', 'manifest.json'),
      join(WORKSPACE, WORKSPACE_MANIFEST_DIR, 'outbound', 'manifest.json'),
    ])
    // The point of the second entry: it is inside the sandbox's writable root
    // and the first one is not. Without this pair the list is just longer.
    expect(isSandboxWritable(candidates[1] as string, WORKSPACE)).toBe(true)
    expect(isSandboxWritable(candidates[0], WORKSPACE)).toBe(false)
  })

  it('an owner pin is EXCLUSIVE: no workspace fallback is offered beside it', () => {
    const pin = resolve('/owner/pinned.json')
    const candidates = manifestCandidates('/runs/r1', {
      env: { DSH_AUTOPILOT_OUTBOUND_MANIFEST: pin },
      workspaceRoot: WORKSPACE,
    })
    expect(candidates).toEqual([pin])
    // DETECTOR: with the pin removed the same call offers two.
    expect(manifestCandidates('/runs/r1', { env: {}, workspaceRoot: WORKSPACE })).toHaveLength(2)
  })

  it('lists ONE path when storeRoot already puts the run dir at the workspace location', () => {
    const runDir = join(WORKSPACE, WORKSPACE_MANIFEST_DIR)
    expect(manifestCandidates(runDir, { env: {}, workspaceRoot: WORKSPACE })).toEqual([
      join(runDir, 'outbound', 'manifest.json'),
    ])
  })

  it('manifestPath is the FIRST candidate, so the two answers cannot drift', () => {
    expect(manifestPath('/runs/r1', {})).toBe(manifestCandidates('/runs/r1', { env: {} })[0])
    const pin = resolve('/owner/pinned.json')
    expect(manifestPath('/runs/r1', { DSH_AUTOPILOT_OUTBOUND_MANIFEST: pin }))
      .toBe(manifestCandidates('/runs/r1', { env: { DSH_AUTOPILOT_OUTBOUND_MANIFEST: pin } })[0])
  })
})

/**
 * A fixture directory that is provably outside EVERY root
 * `sandboxWritableRoots` admits.
 *
 * WHY NOT `tmpdir()`, WHICH IS WHAT THIS FILE USED TO DO. The admitted roots
 * are `[workspaceRoot, '/tmp', tmp]`, and `'/tmp'` is a HARDCODED literal —
 * deliberately, because upstream's `writableRoots` hardcodes it too. The `tmp`
 * PARAMETER can be displaced (the `'/other-tmp'` arguments below do exactly
 * that), but nothing a test can pass will displace the literal. So on any
 * platform where `tmpdir()` IS `/tmp` — every Linux runner — a fixture under
 * `tmpdir()` sits inside an admitted root that cannot be argued away, and a
 * `..` escape from it lands in `/tmp` too, which is legitimately writable.
 *
 * Measured 2026-08-27 by CI's first run: `isSandboxWritable('/tmp/outside.json',
 * '/tmp/dsh-writable-XXX', '/other-tmp')` returns TRUE, and it is right to.
 * The implementation was correct; the fixture location made the assertion mean
 * something only on Windows, where `tmpdir()` is under the user profile. One
 * test of 826 went red on Linux, and the two below were the only cases
 * affected.
 *
 * The repository working directory is used instead: vitest runs with the repo
 * root as cwd, which is under neither `/tmp` nor `tmpdir()` on any platform
 * this suite runs on, and is never passed as a `workspaceRoot` here. That is an
 * assumption about the environment, so {@link expectOutsideEveryRoot} asserts
 * it instead of trusting it.
 */
const SCRATCH_PREFIX = join(process.cwd(), '.test-tmp')

/** Make a fixture directory under the repo working dir; caller removes it. */
function scratchDir(prefix: string): string {
  mkdirSync(SCRATCH_PREFIX, { recursive: true })
  return mkdtempSync(join(SCRATCH_PREFIX, prefix))
}

/**
 * Assert the PRECONDITION every containment negative below depends on: that the
 * fixture's parent is not itself an admitted root.
 *
 * This is the guard the original tests lacked. Without it the suite cannot tell
 * "the escape was refused because containment works" from "the escape was
 * admitted by a root nobody noticed", and the second reads as a pass on the
 * platform where it is false. Running the suite from a cwd inside `/tmp` makes
 * this fail loudly and by name rather than making the real assertions vacuous.
 */
function expectOutsideEveryRoot(dir: string): void {
  const parent = join(dir, '..')
  expect(isSandboxWritable(join(parent, 'probe.json'), resolve('/srv/unrelated-workspace'), '/other-tmp'))
    .toBe(false)
}

describe('isSandboxWritable — the workspace-write rule, mirrored', () => {
  // Root-anchored, not cwd-relative: under a cwd inside the platform temp dir
  // (a mutation sandbox, a CI runner) a cwd-relative fixture lands under the
  // temp WRITABLE ROOT, and the negative half below stops proving containment.
  const WORKSPACE = resolve('/srv/workspace-fixture')

  it('admits the workspace root and refuses a sibling of it', () => {
    expect(isSandboxWritable(join(WORKSPACE, 'a', 'b.json'), WORKSPACE)).toBe(true)
    expect(isSandboxWritable(resolve('/srv/workspace-fixture-elsewhere', 'b.json'), WORKSPACE, '/other-tmp')).toBe(false)
  })

  it('admits the platform temp dir, which is where the DEFAULT run dir is NOT', () => {
    // Upstream `writableRoots` adds `/tmp` and `os.tmpdir()` beside the
    // workspace; a mirror that dropped them would deny a legitimate location.
    expect(isSandboxWritable(join(tmpdir(), 'x.json'), WORKSPACE)).toBe(true)
    expect(isSandboxWritable(join('/tmp', 'x.json'), WORKSPACE, '/other-tmp')).toBe(true)
    // And the real default: `$DSH_HOME/storages/...` is under neither.
    expect(isSandboxWritable(resolve('/home/u/.dsh/storages/dsh-autopilot/runs/s1'), WORKSPACE, '/other-tmp'))
      .toBe(false)
  })

  it('resolves a path whose TAIL does not exist yet (the manifest never does)', () => {
    const real = scratchDir('dsh-writable-')
    try {
      mkdirSync(join(real, 'nested'))
      // `/other-tmp` displaces the tmp PARAMETER. It cannot displace the
      // hardcoded `'/tmp'` root — that literal mirrors upstream and is not a
      // knob — which is why the fixture has to live somewhere neither root
      // covers. See `scratchDir`; the precondition is asserted, not assumed.
      expectOutsideEveryRoot(real)
      expect(isSandboxWritable(join(real, 'nested', 'never', 'written', 'manifest.json'), real, '/other-tmp')).toBe(true)
      expect(isSandboxWritable(join(real, '..', 'outside.json'), real, '/other-tmp')).toBe(false)
    } finally {
      rmSync(real, { recursive: true, force: true })
    }
  })

  it('canonicalizes THROUGH a link even though the tail is missing', ctx => {
    // The case that makes the ancestor walk load-bearing rather than
    // decorative: the spelled path goes through a junction/symlink and ends in
    // components that do not exist. A bare `realpathSync` throws on the
    // missing tail, falls back to the raw spelling, and reports a path inside
    // the workspace as outside it — which would print the owner-only barrier
    // over a location the sandbox would have accepted.
    //
    // THE FIXTURE LOCATION IS PART OF THE CLAIM. Under `tmpdir()` on Linux this
    // assertion passed no matter what the ancestor walk did, because `/tmp` is
    // an admitted root in its own right — a positive that cannot fail says
    // nothing about the code it names. Off every admitted root, the ONLY way
    // the target can be writable is by canonicalizing through the link into
    // `real`, which is what makes the walk load-bearing here.
    const real = scratchDir('dsh-link-real-')
    const link = join(scratchDir('dsh-link-'), 'alias')
    try {
      symlinkSync(real, link, 'junction')
    } catch {
      // Unprivileged link creation is unavailable here; the walk cannot be
      // observed on this host, and asserting the weaker thing would be worse.
      rmSync(link, { recursive: true, force: true })
      rmSync(real, { recursive: true, force: true })
      ctx.skip()
      return
    }
    try {
      expectOutsideEveryRoot(real)
      expectOutsideEveryRoot(join(link, '..'))
      expect(isSandboxWritable(join(link, 'never', 'written', 'manifest.json'), real, '/other-tmp')).toBe(true)
      // The negative half the location now makes sayable: a sibling of the
      // link's own directory is refused, so the `true` above is the walk and
      // not a root admitting everything nearby.
      expect(isSandboxWritable(join(link, '..', 'outside.json'), real, '/other-tmp')).toBe(false)
    } finally {
      rmSync(join(link, '..'), { recursive: true, force: true })
      rmSync(real, { recursive: true, force: true })
    }
  })

  it('dedups the roots so one workspace inside tmp is not reported twice', () => {
    expect(sandboxWritableRoots('/tmp', '/tmp')).toHaveLength(1)
    expect(sandboxWritableRoots(WORKSPACE, '/other-tmp').length).toBeGreaterThanOrEqual(2)
  })
})

describe('renderManifestTemplate — a form, never evidence', () => {
  it('stamps the LIVE run id, the validation clock, and a >=2-token command class', () => {
    const raw = renderManifestTemplate('run-77', 'GIT_SSH_COMMAND="ssh -i k" git push origin main', NOW)
    const parsed = parseManifest(raw)
    expect(parsed.problems).toEqual([])
    expect(parsed.manifest?.runId).toBe('run-77')
    expect(parsed.manifest?.createdAt).toBe(new Date(NOW).toISOString())
    // Read off the egress binary, not off the env prefix that precedes it.
    expect(parsed.manifest?.commands).toEqual(['git push'])
  })

  it('proposes a class that actually matches the command it was rendered for', () => {
    for (const command of ['cd repo && git push origin main', 'npm publish --access public', 'gh pr create -t x']) {
      const proposed = parseManifest(renderManifestTemplate('run-1', command, NOW)).manifest?.commands ?? []
      expect(proposed).toHaveLength(1)
      expect(matchesAtTokenBoundary(command, proposed[0] as string)).toBe(true)
    }
  })

  it('FAILS validation when submitted unedited, which is the only safe direction', () => {
    const raw = renderManifestTemplate('run-1', 'git push origin main', NOW)
    const manifest = parseManifest(raw).manifest
    expect(manifest).toBeDefined()
    const problems = validateManifest(manifest as OutboundManifest, makeCtx({ readArtifact: () => undefined }))
    expect(has(problems, 'artifact does not exist or is unreadable')).toBe(true)
  })
})

describe('missingManifestReason — the denial as an agent can act on it', () => {
  // Root-anchored, not cwd-relative: under a cwd inside the platform temp dir
  // (a mutation sandbox, a CI runner) a cwd-relative fixture lands under the
  // temp WRITABLE ROOT, and the negative half below stops proving containment.
  const WORKSPACE = resolve('/srv/workspace-fixture')
  const OUTSIDE_RUN_DIR = resolve('/home/u/.dsh/storages/dsh-autopilot/runs/session-abc')

  function reasonFor(runDir: string): string {
    return missingManifestReason({
      runId: 'session-abc',
      command: 'git push origin main',
      runDir,
      candidates: manifestCandidates(runDir, { env: {}, workspaceRoot: WORKSPACE }),
      workspaceRoot: WORKSPACE,
      now: NOW,
      tmpDir: '/other-tmp',
    })
  }

  it('keeps the phrase the real host and the seam tests both key on', () => {
    expect(reasonFor(OUTSIDE_RUN_DIR)).toContain('no readable outbound evidence manifest')
  })

  it('names EVERY place it looked, and marks which one is writable', () => {
    const reason = reasonFor(OUTSIDE_RUN_DIR)
    expect(reason).toContain(join(OUTSIDE_RUN_DIR, 'outbound', 'manifest.json'))
    expect(reason).toContain(join(WORKSPACE, WORKSPACE_MANIFEST_DIR, 'outbound', 'manifest.json'))
    expect(reason).toContain('[writable by fs/shell tools]')
    expect(reason).toContain('owner-placed only')
  })

  it('carries a filled-in skeleton rather than a list of field names', () => {
    const reason = reasonFor(OUTSIDE_RUN_DIR)
    expect(reason).toContain('"runId":"session-abc"')
    expect(reason).toContain('"commands":["git push"]')
  })

  it('EXPLAINS the unwritable run directory, and names the one remedy that moves it', () => {
    const reason = reasonFor(OUTSIDE_RUN_DIR)
    expect(reason).toContain('OUTSIDE')
    expect(reason).toContain(OUTSIDE_RUN_DIR)
    expect(reason).toContain('storeRoot')
    // Names a citable artifact that exists WITHOUT any agent write: both store
    // backends append the run's `log.md` under the run directory themselves.
    expect(reason).toContain('log.md')
  })

  it('and STAYS SILENT about it when the run dir is already inside the workspace', () => {
    // The paragraph is computed, not boilerplate: printing it here would be a
    // false statement about the deployment the reader is standing in.
    const reason = reasonFor(join(WORKSPACE, '.autopilot-runs', 'session-abc'))
    expect(reason).not.toContain('storeRoot')
    expect(reason).not.toContain('OUTSIDE')
    // DETECTOR: the same call still produced the actionable half.
    expect(reason).toContain('no readable outbound evidence manifest')
    expect(reason).toContain('"runId":"session-abc"')
  })
})

describe('parseManifest', () => {
  const valid = JSON.stringify(makeManifest())

  it('accepts a well-formed manifest and returns the typed value', () => {
    const { manifest, problems } = parseManifest(valid)
    expect(problems).toEqual([])
    expect(manifest?.runId).toBe('run-1')
    expect(manifest?.commands).toEqual(['git push'])
    expect(manifest?.claims[0]?.bearer).toBe('evidence/gate.txt')
  })

  it('never throws on arbitrary junk and reports non-JSON distinctly', () => {
    const { manifest, problems } = parseManifest('{ not json at all')
    expect(manifest).toBeUndefined()
    expect(has(problems, 'not valid JSON')).toBe(true)
  })

  it('rejects a JSON value that is not an object', () => {
    expect(has(parseManifest('[]').problems, 'not a JSON object')).toBe(true)
    expect(has(parseManifest('null').problems, 'not a JSON object')).toBe(true)
    expect(has(parseManifest('"a string"').problems, 'not a JSON object')).toBe(true)
  })

  it('rejects a version other than 1', () => {
    const raw = JSON.stringify({ ...makeManifest(), v: 2 })
    const { manifest, problems } = parseManifest(raw)
    expect(manifest).toBeUndefined()
    expect(has(problems, 'v must be 1')).toBe(true)
  })

  it('rejects a missing or blank runId', () => {
    expect(has(parseManifest(JSON.stringify({ ...makeManifest(), runId: '   ' })).problems, 'runId is missing or blank')).toBe(true)
    const withoutRunId: Record<string, unknown> = { ...makeManifest() }
    delete withoutRunId.runId
    expect(has(parseManifest(JSON.stringify(withoutRunId)).problems, 'runId is missing or blank')).toBe(true)
  })

  it('rejects a missing or blank target', () => {
    expect(has(parseManifest(JSON.stringify({ ...makeManifest(), target: '' })).problems, 'target is missing or blank')).toBe(true)
  })

  it('rejects commands that are not a non-empty string array', () => {
    expect(has(parseManifest(JSON.stringify({ ...makeManifest(), commands: [] })).problems, 'commands must be a non-empty array')).toBe(true)
    expect(has(parseManifest(JSON.stringify({ ...makeManifest(), commands: 'git push' })).problems, 'commands must be a non-empty array')).toBe(true)
    // A blank entry would match every command as a substring: a vacuous authorization.
    expect(has(parseManifest(JSON.stringify({ ...makeManifest(), commands: [''] })).problems, 'commands[0] must be a non-empty string')).toBe(true)
  })

  it('rejects claims that are not an array, and malformed claim entries', () => {
    expect(has(parseManifest(JSON.stringify({ ...makeManifest(), claims: {} })).problems, 'claims must be an array')).toBe(true)
    expect(has(parseManifest(JSON.stringify({ ...makeManifest(), claims: [{ text: 1, bearer: 'a' }] })).problems, 'claims[0].text must be a string')).toBe(true)
    expect(has(parseManifest(JSON.stringify({ ...makeManifest(), claims: [{ text: 'a' }] })).problems, 'claims[0].bearer must be a string')).toBe(true)
  })

  it('rejects artifacts that are not an array, and malformed artifact entries', () => {
    expect(has(parseManifest(JSON.stringify({ ...makeManifest(), artifacts: 'evidence/gate.txt' })).problems, 'artifacts must be an array')).toBe(true)
    expect(has(parseManifest(JSON.stringify({ ...makeManifest(), artifacts: [{ ref: '', covers: [] }] })).problems, 'artifacts[0].ref must be a non-empty string')).toBe(true)
    expect(has(parseManifest(JSON.stringify({ ...makeManifest(), artifacts: [{ ref: 'a', covers: 'x' }] })).problems, 'artifacts[0].covers must be an array of strings')).toBe(true)
  })

  it('rejects an unparseable createdAt', () => {
    // In-place assertion that the fixture is still outside the accepted set.
    expect(Number.isNaN(Date.parse('last tuesday'))).toBe(true)
    expect(has(parseManifest(JSON.stringify({ ...makeManifest(), createdAt: 'last tuesday' })).problems, 'createdAt is not a parseable ISO date')).toBe(true)
    expect(has(parseManifest(JSON.stringify({ ...makeManifest(), createdAt: 17 })).problems, 'createdAt is not a parseable ISO date')).toBe(true)
  })

  it('distinguishes several simultaneous problems from one another', () => {
    const raw = JSON.stringify({ v: 3, runId: '', target: '', commands: [], claims: 1, artifacts: 1, createdAt: 'x' })
    const { problems } = parseManifest(raw)
    expect(has(problems, 'v must be 1')).toBe(true)
    expect(has(problems, 'runId is missing or blank')).toBe(true)
    expect(has(problems, 'target is missing or blank')).toBe(true)
    expect(has(problems, 'claims must be an array')).toBe(true)
    expect(has(problems, 'artifacts must be an array')).toBe(true)
  })
})

describe('countClaims', () => {
  it('finds the percentage shape', () => {
    expect(countClaims('coverage reached 92%')).toEqual(['92%'])
    expect(countClaims('coverage reached 92.5%')).toEqual(['92.5%'])
  })

  it('finds the ratio shape, spaced or compact', () => {
    expect(countClaims('the suite is 92/92')).toEqual(['92/92'])
    expect(countClaims('the suite is 92 / 92')).toEqual(['92 / 92'])
  })

  it('finds the N-of-M shape', () => {
    expect(countClaims('9 of 12 checks reported')).toEqual(['9 of 12'])
  })

  it('finds bare counts of tests, files, cases and items', () => {
    expect(countClaims('ran 92 tests')).toEqual(['92 tests'])
    expect(countClaims('touched 4 files')).toEqual(['4 files'])
    expect(countClaims('added 7 cases')).toEqual(['7 cases'])
    expect(countClaims('shipped 2 items')).toEqual(['2 items'])
  })

  it('returns every phrase, per match, in order of appearance', () => {
    expect(countClaims('ran 92 tests, 92/92, 100%')).toEqual(['92 tests', '92/92', '100%'])
  })

  it('returns an empty list for a plain sentence with no count', () => {
    expect(countClaims('The gate refuses an egress whose claims are unsettled.')).toEqual([])
    expect(countClaims('')).toEqual([])
  })

  it('is not stateful across calls', () => {
    const text = 'ran 92 tests'
    expect(countClaims(text)).toEqual(countClaims(text))
  })
})

describe('validateManifest — acceptance', () => {
  it('accepts a minimal manifest whose single claim has a settled bearer', () => {
    expect(validateManifest(makeManifest(), makeCtx())).toEqual([])
  })

  it('accepts a count claim whose bearing artifact contains the same count phrase', () => {
    const manifest = makeManifest({
      claims: [{ text: 'the suite is green at 92/92', bearer: 'evidence/vitest.txt' }],
      artifacts: [{ ref: 'evidence/vitest.txt', covers: ['suite'] }],
    })
    const ctx = makeCtx({ readArtifact: reader({ 'evidence/vitest.txt': 'suite: Tests  92 passed (92/92)\n' }) })
    expect(validateManifest(manifest, ctx)).toEqual([])
  })

  it('accepts two claims when each has its own distinct bearer', () => {
    const manifest = makeManifest({
      claims: [
        { text: 'the gate denies unmatched commands', bearer: 'evidence/gate.txt' },
        { text: 'the fold rejects stale evidence', bearer: 'evidence/fold.txt' },
      ],
      artifacts: [
        { ref: 'evidence/gate.txt', covers: ['gate'] },
        { ref: 'evidence/fold.txt', covers: ['fold'] },
      ],
    })
    const ctx = makeCtx({
      readArtifact: reader({ 'evidence/gate.txt': 'gate deny matrix\n', 'evidence/fold.txt': 'fold output\n' }),
    })
    const problems = validateManifest(manifest, ctx)
    expect(problems).toEqual([])
    expect(has(problems, 'Single-Bearer')).toBe(false)
  })

  it('accepts a manifest exactly at the staleness boundary (the window is > , not >=)', () => {
    const manifest = makeManifest({ createdAt: new Date(NOW - OUTBOUND_STALE_MS).toISOString() })
    expect(validateManifest(manifest, makeCtx())).toEqual([])
  })

  it('accepts a createdAt inside the clock-skew tolerance', () => {
    const manifest = makeManifest({ createdAt: new Date(NOW + 59_000).toISOString() })
    expect(validateManifest(manifest, makeCtx())).toEqual([])
  })
})

describe('validateManifest — rejection', () => {
  it('rejects a manifest declaring another run, naming both ids', () => {
    const problems = validateManifest(makeManifest({ runId: 'run-other' }), makeCtx())
    expect(has(problems, 'does not govern live run')).toBe(true)
    expect(has(problems, 'run-other')).toBe(true)
    expect(has(problems, 'run-1')).toBe(true)
  })

  it('rejects a manifest one millisecond past the staleness window', () => {
    const createdAt = new Date(NOW - OUTBOUND_STALE_MS - 1).toISOString()
    const problems = validateManifest(makeManifest({ createdAt }), makeCtx())
    expect(has(problems, 'manifest is stale')).toBe(true)
    // Not misfiled as future-dated: the two clock rules must be distinguishable.
    expect(has(problems, 'future-dated')).toBe(false)
  })

  it('rejects a future-dated manifest beyond the skew tolerance', () => {
    const createdAt = new Date(NOW + 61_000).toISOString()
    const problems = validateManifest(makeManifest({ createdAt }), makeCtx())
    expect(has(problems, 'future-dated')).toBe(true)
    expect(has(problems, 'manifest is stale')).toBe(false)
  })

  it('rejects an egress command that no declared substring covers', () => {
    const ctx = makeCtx({ command: 'gh release create v0.2.0' })
    const problems = validateManifest(makeManifest(), ctx)
    expect(has(problems, 'matches no declared command substring')).toBe(true)
    // Positive half in place: the same manifest covers the command it declared.
    expect(has(validateManifest(makeManifest(), makeCtx()), 'matches no declared command substring')).toBe(false)
  })

  it('rejects a manifest with zero claims (cardinality floor)', () => {
    const problems = validateManifest(makeManifest({ claims: [] }), makeCtx())
    expect(has(problems, 'declares zero claims')).toBe(true)
  })

  it('rejects a claim with an empty bearer', () => {
    const manifest = makeManifest({ claims: [{ text: 'the gate works', bearer: '   ' }] })
    const problems = validateManifest(manifest, makeCtx())
    expect(has(problems, 'empty bearer')).toBe(true)
    expect(has(problems, 'Single-Bearer')).toBe(true)
  })

  it('rejects a bearer that names no declared artifact', () => {
    const manifest = makeManifest({ claims: [{ text: 'the gate works', bearer: 'evidence/ghost.txt' }] })
    const problems = validateManifest(manifest, makeCtx())
    expect(has(problems, 'names no declared artifact')).toBe(true)
    expect(has(problems, 'evidence/ghost.txt')).toBe(true)
  })

  it('rejects two claims sharing one bearer, and says why', () => {
    const manifest = makeManifest({
      claims: [
        { text: 'the gate denies unmatched commands', bearer: 'evidence/gate.txt' },
        { text: 'the gate also archives consumption', bearer: 'evidence/gate.txt' },
      ],
    })
    const problems = validateManifest(manifest, makeCtx())
    expect(has(problems, 'bears 2 claims')).toBe(true)
    expect(has(problems, 'cannot be observed false for either independently')).toBe(true)
  })

  it('rejects an artifact ref that escapes the run directory', () => {
    const escaping = '../../etc/passwd'
    // In-place assertion that this fixture really leaves the run directory.
    expect(resolve(RUN_DIR, escaping).startsWith(RUN_DIR)).toBe(false)
    const manifest = makeManifest({
      claims: [{ text: 'system file cited', bearer: escaping }],
      artifacts: [{ ref: escaping, covers: ['x'] }],
    })
    const problems = validateManifest(manifest, makeCtx())
    expect(has(problems, 'escapes the run directory')).toBe(true)
  })

  it('rejects an artifact that does not exist', () => {
    const manifest = makeManifest({
      claims: [{ text: 'missing evidence', bearer: 'evidence/absent.txt' }],
      artifacts: [{ ref: 'evidence/absent.txt', covers: ['x'] }],
    })
    const problems = validateManifest(manifest, makeCtx({ readArtifact: reader({}) }))
    expect(has(problems, 'does not exist or is unreadable')).toBe(true)
  })

  it('rejects an artifact that exists but is empty', () => {
    const manifest = makeManifest({
      claims: [{ text: 'empty evidence', bearer: 'evidence/gate.txt' }],
    })
    const ctx = makeCtx({ readArtifact: reader({ 'evidence/gate.txt': '' }) })
    const problems = validateManifest(manifest, ctx)
    expect(has(problems, 'is empty (size 0)')).toBe(true)
  })

  it('rejects a stale count that survived into the outbound text', () => {
    // The regression this rule exists for: the suite moved to 92 and the words
    // still said 83, with an artifact that could never have borne them.
    const manifest = makeManifest({
      claims: [{ text: 'regression baseline is 83/83', bearer: 'evidence/vitest.txt' }],
      artifacts: [{ ref: 'evidence/vitest.txt', covers: ['suite'] }],
    })
    const ctx = makeCtx({ readArtifact: reader({ 'evidence/vitest.txt': 'Tests  92 passed (92/92)\n' }) })
    const problems = validateManifest(manifest, ctx)
    expect(has(problems, 'count phrase "83/83"')).toBe(true)
    expect(has(problems, 'absent from its bearing artifact')).toBe(true)
  })

  it('rejects a BLANKET command entry that would authorize unrelated egress classes', () => {
    // The defect this rule exists for: `commands: ['s']` is a non-blank string,
    // and raw substring containment made it authorize BOTH of these.
    const blanket = 's'
    expect('git push origin main'.includes(blanket)).toBe(true)
    expect('npm publish'.includes(blanket)).toBe(true)

    const parsed = parseManifest(JSON.stringify({ ...makeManifest(), commands: [blanket] }))
    expect(has(parsed.problems, 'commands[0]')).toBe(true)
    expect(has(parsed.problems, 'too unspecific')).toBe(true)
    expect(parsed.manifest).toBeUndefined()
  })

  it('positive control: a two-token command entry is specific enough to parse', () => {
    const parsed = parseManifest(JSON.stringify({ ...makeManifest(), commands: ['npm publish'] }))
    expect(parsed.problems).toEqual([])
    expect(parsed.manifest?.commands).toEqual(['npm publish'])
  })

  it('rejects a command entry that only matches mid-token', () => {
    // `'it push'` is a raw substring of `'git push origin main'`; anchoring the
    // match at a token boundary is what tells the two apart.
    const midToken = 'it push'
    expect('git push origin main'.includes(midToken)).toBe(true)
    const problems = validateManifest(makeManifest({ commands: [midToken] }), makeCtx())
    expect(has(problems, 'matches no declared command')).toBe(true)
  })

  it('positive control: the same command matches when the entry starts at a token boundary', () => {
    expect(validateManifest(makeManifest({ commands: ['git push'] }), makeCtx())).toEqual([])
    // and a shell prefix does not defeat it
    expect(validateManifest(makeManifest({ commands: ['git push'] }), makeCtx({
      command: 'cd repo && git push origin main',
    }))).toEqual([])
  })

  it('rejects an artifact whose declared covers label is absent from its own text', () => {
    const manifest = makeManifest({
      claims: [{ text: 'the gate denies unmatched commands', bearer: 'evidence/gate.txt' }],
      artifacts: [{ ref: 'evidence/gate.txt', covers: ['rollback-clean'] }],
    })
    const ctx = makeCtx({ readArtifact: reader({ 'evidence/gate.txt': 'gate decision matrix output\n' }) })
    const problems = validateManifest(manifest, ctx)
    expect(has(problems, 'does not bear its covered label: rollback-clean')).toBe(true)
  })

  it('rejects an artifact that declares no covered labels at all', () => {
    const manifest = makeManifest({ artifacts: [{ ref: 'evidence/gate.txt', covers: [] }] })
    const problems = validateManifest(manifest, makeCtx())
    expect(has(problems, 'declares no covered labels')).toBe(true)
  })

  it('REFUSES a covers label shorter than MIN_COVERS_LABEL_LENGTH even when the text contains it', () => {
    const unrelated = 'a totally unrelated transcript about cats and lasagne'
    for (const label of ['a', 'at']) {
      const manifest = makeManifest({
        claims: [{ text: 'the gate denies unmatched commands', bearer: 'evidence/gate.txt' }],
        artifacts: [{ ref: 'evidence/gate.txt', covers: [label] }],
      })
      const problems = validateManifest(manifest, makeCtx({
        readArtifact: reader({ 'evidence/gate.txt': unrelated }),
      }))
      expect(has(problems, 'too unspecific')).toBe(true)
    }
    const tsc = makeManifest({
      claims: [{ text: 'typecheck is clean', bearer: 'evidence/gate.txt' }],
      artifacts: [{ ref: 'evidence/gate.txt', covers: ['tsc'] }],
    })
    expect(validateManifest(tsc, makeCtx({
      readArtifact: reader({ 'evidence/gate.txt': 'tsc exited 0\n' }),
    }))).toEqual([])
  })

  it('positive control: an artifact bearing every label it declares is accepted', () => {
    const manifest = makeManifest({
      claims: [{ text: 'the gate denies unmatched commands', bearer: 'evidence/gate.txt' }],
      artifacts: [{ ref: 'evidence/gate.txt', covers: ['gate', 'decision matrix'] }],
    })
    const ctx = makeCtx({ readArtifact: reader({ 'evidence/gate.txt': 'gate decision matrix output\n' }) })
    expect(validateManifest(manifest, ctx)).toEqual([])
  })

  it('rejects each count phrase separately when a claim carries several', () => {
    const manifest = makeManifest({
      claims: [{ text: 'ran 92 tests at 100%', bearer: 'evidence/vitest.txt' }],
      artifacts: [{ ref: 'evidence/vitest.txt', covers: ['suite'] }],
    })
    const ctx = makeCtx({ readArtifact: reader({ 'evidence/vitest.txt': 'ran 92 tests, coverage unrecorded\n' }) })
    const problems = validateManifest(manifest, ctx)
    expect(has(problems, 'count phrase "100%"')).toBe(true)
    expect(has(problems, 'count phrase "92 tests"')).toBe(false)
  })
})

/** Recording filesystem seam: archiving is proven without writing to a real disk. */
function fakeFs(fail?: string) {
  const dirs: string[] = []
  const files: Array<{ path: string; data: string }> = []
  return {
    dirs,
    files,
    mkdirSync(path: string, _options: { readonly recursive: true }): unknown {
      if (fail === 'mkdir') throw new Error('EACCES: mkdir denied')
      dirs.push(path)
      return undefined
    },
    writeFileSync(path: string, data: string): void {
      if (fail === 'write') throw new Error('ENOSPC: no space left')
      files.push({ path, data })
    },
  }
}

describe('archiveConsumed', () => {
  const manifest = makeManifest()

  it('writes into <runDir>/outbound/consumed with a filesystem-safe name', () => {
    const fs = fakeFs()
    const target = archiveConsumed(RUN_DIR, manifest, 'git push origin main', { now: NOW, fs })
    expect(target.startsWith(join(RUN_DIR, 'outbound', 'consumed'))).toBe(true)
    expect(fs.dirs).toEqual([join(RUN_DIR, 'outbound', 'consumed')])
    expect(fs.files.map(file => file.path)).toEqual([target])
    const name = basename(target)
    expect(name.includes(':')).toBe(false)
    // <instant>-<content hash>-<per-consumption nonce>. The first two halves are
    // functions of (manifest, command) alone, which is why the third exists.
    expect(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-[a-zA-Z0-9]{1,8}\.json$/.test(name)).toBe(true)
  })

  it('embeds the consuming command and the consumption time in the archived copy', () => {
    const fs = fakeFs()
    archiveConsumed(RUN_DIR, manifest, 'git push origin main', { now: NOW, fs })
    const written = JSON.parse(fs.files[0]!.data) as Record<string, unknown>
    const consumed = written.consumed as { command: string; at: string }
    expect(consumed.command).toBe('git push origin main')
    expect(consumed.at).toBe(new Date(NOW).toISOString())
    expect(written.runId).toBe('run-1')
    expect(written.v).toBe(1)
  })

  it('truncates a long consuming command to 500 characters', () => {
    const long = 'x'.repeat(600)
    // In-place assertion that this fixture is actually over the limit.
    expect(long.length).toBe(600)
    const fs = fakeFs()
    archiveConsumed(RUN_DIR, manifest, long, { now: NOW, fs })
    const consumed = (JSON.parse(fs.files[0]!.data) as { consumed: { command: string } }).consumed
    expect(consumed.command.length).toBe(500)
  })

  it('does not collide when two egresses are consumed in the same millisecond', () => {
    const fs = fakeFs()
    const first = archiveConsumed(RUN_DIR, manifest, 'git push origin main', { now: NOW, fs })
    const second = archiveConsumed(RUN_DIR, manifest, 'git push origin release', { now: NOW, fs })
    expect(second).not.toBe(first)
  })

  it('does not collide when the SAME manifest is spent twice by the SAME command', () => {
    // This used to assert the opposite ("the same input at the same instant is
    // deterministic"), which was the collision, not a property. Both halves of
    // the old name — the instant and sha256(manifest + command) — are identical
    // across two consumptions of one manifest by one command, and nothing in
    // this module prevents that from happening (see the no-replay ceiling in
    // the function's own doc and DESIGN.md §6). So the second write silently
    // overwrote the first and two authorized dispatches left ONE archive file.
    const fs = fakeFs()
    const first = archiveConsumed(RUN_DIR, manifest, 'git push origin main', { now: NOW, fs })
    const again = archiveConsumed(RUN_DIR, manifest, 'git push origin main', { now: NOW, fs })
    expect(again).not.toBe(first)
    expect(fs.files.length).toBe(2)
    expect(new Set(fs.files.map(file => file.path)).size).toBe(2)
  })

  it('the nonce is the ONLY differing part, so the archive is still identifiable', () => {
    const fs = fakeFs()
    const a = basename(archiveConsumed(RUN_DIR, manifest, 'git push origin main', { now: NOW, fs, nonce: 'aaaa1111' }))
    const b = basename(archiveConsumed(RUN_DIR, manifest, 'git push origin main', { now: NOW, fs, nonce: 'bbbb2222' }))
    expect(a).not.toBe(b)
    expect(a.replace('aaaa1111', 'N')).toBe(b.replace('bbbb2222', 'N'))
  })

  it('raises a typed error when the archive cannot be written', () => {
    expect(() => archiveConsumed(RUN_DIR, manifest, 'git push', { now: NOW, fs: fakeFs('write') }))
      .toThrowError(AutopilotError)
    try {
      archiveConsumed(RUN_DIR, manifest, 'git push', { now: NOW, fs: fakeFs('mkdir') })
      expect.unreachable('archiveConsumed must not swallow a failed mkdir')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AutopilotError)
      expect((error as AutopilotError).code).toBe('AP_OUTBOUND_ARCHIVE')
    }
  })
})

/**
 * The staleness WINDOW, not just the staleness RELATION.
 *
 * Every existing freshness fixture derives its date from the constant itself
 * (`new Date(NOW - OUTBOUND_STALE_MS - 1)`), so the fixture re-anchors to
 * whatever the constant becomes: multiplying `OUTBOUND_STALE_MS` by a thousand
 * left the whole suite green. That is a Moving-Anchor violation (DESIGN.md §5)
 * on the single value defending against the stale-evidence incident §8 records
 * as having actually happened.
 */
describe('OUTBOUND_STALE_MS is pinned, not merely referenced', () => {
  it('is exactly six hours, stated as a literal', () => {
    expect(OUTBOUND_STALE_MS).toBe(6 * 60 * 60 * 1000)
    expect(OUTBOUND_STALE_MS).toBe(21_600_000)
  })

  it('refuses a manifest hardcoded SEVEN hours before the clock', () => {
    const sevenHours = 7 * 60 * 60 * 1000
    const stale = makeManifest({ createdAt: new Date(NOW - sevenHours).toISOString() })
    const problems = validateManifest(stale, makeCtx())
    expect(problems.join(';')).toMatch(/manifest is stale/)
  })

  it('accepts a manifest hardcoded FIVE hours before the clock', () => {
    const fiveHours = 5 * 60 * 60 * 1000
    const fresh = makeManifest({ createdAt: new Date(NOW - fiveHours).toISOString() })
    expect(validateManifest(fresh, makeCtx())).toEqual([])
  })
})

describe('branches that were live but unobservable', () => {
  it('refuses an artifact ref that resolves to the run directory ITSELF', () => {
    // Containment's equality branch: `resolve(runDir, '.') === runDir`. A
    // directory bears no evidence, and the branch survived mutation to `true`.
    const manifest = makeManifest({
      claims: [{ text: 'x', bearer: '.' }],
      artifacts: [{ ref: '.', covers: ['gate'] }],
    })
    expect(validateManifest(manifest, makeCtx()).join(';')).toMatch(/artifact ref escapes the run directory: \./)
  })

  it('refuses a BLANK covered label sitting beside a satisfiable one', () => {
    const manifest = makeManifest({ artifacts: [{ ref: 'evidence/gate.txt', covers: ['gate', ''] }] })
    const problems = validateManifest(manifest, makeCtx())
    expect(problems.join(';')).toMatch(/too unspecific/)
    expect(validateManifest(makeManifest(), makeCtx())).toEqual([])
  })

  it('REFUSES when no usable validation clock was supplied', () => {
    // `created - ctx.now` and `ctx.now - created` are both NaN without a clock,
    // and every NaN comparison is false — so omitting `now` silently disabled
    // BOTH freshness branches. Measured before the fix: a 7-hour-old manifest
    // AND a year-2999 manifest both validated clean.
    const ctx = { ...makeCtx() } as Record<string, unknown>
    delete ctx.now
    const stale = makeManifest({ createdAt: new Date(NOW - 7 * 60 * 60 * 1000).toISOString() })
    expect(validateManifest(stale, ctx as unknown as ManifestContext).join(';'))
      .toMatch(/freshness could not be evaluated/)
    const future = makeManifest({ createdAt: '2999-01-01T00:00:00.000Z' })
    expect(validateManifest(future, ctx as unknown as ManifestContext).join(';'))
      .toMatch(/freshness could not be evaluated/)
    // DETECTOR: with the clock present those two produce their OWN distinct fails.
    expect(validateManifest(stale, makeCtx()).join(';')).toMatch(/manifest is stale/)
    expect(validateManifest(future, makeCtx()).join(';')).toMatch(/future-dated/)
  })

  it('normalizeCount is whitespace-insensitive on BOTH sides, with a spaced/unspaced pair', () => {
    // Live behaviour with no bearer until now: the claim writes '92 / 92' and
    // the artifact writes '92/92'. Dropping the whitespace strip left the suite
    // green because every fixture happened to spell both sides the same way.
    const manifest = makeManifest({
      claims: [{ text: 'the suite is 92 / 92 green', bearer: 'evidence/gate.txt' }],
      artifacts: [{ ref: 'evidence/gate.txt', covers: ['gate'] }],
    })
    const spaced = makeCtx({ readArtifact: reader({ 'evidence/gate.txt': 'gate run: 92/92 passed\n' }) })
    expect(validateManifest(manifest, spaced)).toEqual([])
    // DETECTOR: a genuinely different number is still refused.
    const wrong = makeCtx({ readArtifact: reader({ 'evidence/gate.txt': 'gate run: 91/92 passed\n' }) })
    expect(validateManifest(manifest, wrong).join(';')).toMatch(/count phrase "92 \/ 92" in claim is absent/)
  })

  it('matchesAtTokenBoundary is the exported rule the approval path reuses', () => {
    expect(matchesAtTokenBoundary('git push origin main', 'git push')).toBe(true)
    expect(matchesAtTokenBoundary('cd repo && git push origin main', 'git push')).toBe(true)
    expect(matchesAtTokenBoundary('legit push origin main', 'git push')).toBe(false)
    expect(matchesAtTokenBoundary('git push origin main', '   ')).toBe(false)
  })

  it('CHAINED EGRESS: a push-only manifest does not authorize a command that also publishes', () => {
    // THE ESCAPE THIS RULE EXISTS FOR (2026-08-25 independent repair audit).
    // Authorization used to ask "does the declared entry appear somewhere in
    // the command", never "is every egress element of the command covered". A
    // push-only manifest therefore authorized a command carrying a SECOND,
    // undeclared egress of a different class, falsifying the invariant this
    // file's own `validateManifest` docstring states.
    const problems = validateManifest(
      makeManifest({ commands: ['git push'] }),
      makeCtx({ command: 'git push origin main && npm publish' }),
    )
    expect(has(problems, 'matches no declared command substring')).toBe(true)
    expect(has(problems, 'npm publish')).toBe(true)
    // and the covered half is NOT what is being complained about
    expect(problems.some(problem => problem.includes('git push origin main'))).toBe(false)
  })

  it('CHAINED EGRESS: declaring both classes authorizes the chain', () => {
    // The positive half, so the rule above is a decision rather than a blanket
    // refusal of every `&&`.
    expect(validateManifest(
      makeManifest({ commands: ['git push', 'npm publish'] }),
      makeCtx({ command: 'git push origin main && npm publish' }),
    )).toEqual([])
  })

  it('RECORDED CEILING: a command substitution is NOT a second declared segment', () => {
    // The manifest side of the ceiling written up in DESIGN.md §6: `$(...)`
    // chains without any separator the splitter knows, so a push-only manifest
    // validates this command clean. Pinned as measured on 2026-08-25 — this is
    // the current behaviour, not the desired one.
    expect(validateManifest(makeManifest({ commands: ['git push'] }), makeCtx({
      command: 'git push origin main $(npm publish)',
    }))).toEqual([])
    // DETECTOR: the same second egress behind a separator the splitter DOES know
    // is refused, so the pass above is about `$(...)` specifically.
    expect(has(validateManifest(makeManifest({ commands: ['git push'] }), makeCtx({
      command: 'git push origin main; npm publish',
    })), 'npm publish')).toBe(true)
  })

  it('CHAINED EGRESS: every shell separator splits, and a non-egress segment needs no declaration', () => {
    for (const command of [
      'git push origin main && npm publish',
      'git push origin main; npm publish',
      'git push origin main || npm publish',
      'git push origin main | npm publish',
      'git push origin main & npm publish',
      'git push origin main\nnpm publish',
    ]) {
      expect(has(validateManifest(makeManifest({ commands: ['git push'] }), makeCtx({ command })), 'npm publish'))
        .toBe(true)
    }
    // A non-egress segment beside a declared one is not a second egress and is
    // not required to be declared — otherwise `cd repo && git push` would break.
    expect(validateManifest(makeManifest({ commands: ['git push'] }), makeCtx({
      command: 'cd repo && pnpm build && git push origin main',
    }))).toEqual([])
  })

  it('manifestPath defaults its env to process.env', () => {
    // The `env = process.env` default was unreached in production (every caller
    // passes one) and unobserved by tests, so replacing it with `{}` was free.
    const previous = process.env.DSH_AUTOPILOT_OUTBOUND_MANIFEST
    process.env.DSH_AUTOPILOT_OUTBOUND_MANIFEST = join(RUN_DIR, 'pinned.json')
    try {
      expect(manifestPath(RUN_DIR)).toBe(join(RUN_DIR, 'pinned.json'))
    } finally {
      if (previous === undefined) delete process.env.DSH_AUTOPILOT_OUTBOUND_MANIFEST
      else process.env.DSH_AUTOPILOT_OUTBOUND_MANIFEST = previous
    }
    // DETECTOR: with the pin removed the default path is the run-relative one.
    expect(manifestPath(RUN_DIR, {})).toBe(join(RUN_DIR, 'outbound', 'manifest.json'))
  })
})
