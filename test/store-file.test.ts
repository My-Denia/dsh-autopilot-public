/**
 * The FILE backend of the run store: `src/store/file.ts`.
 *
 * WHY THIS FILE EXISTS. `test/store-domain.test.ts` bears the domain backend's
 * invariants — strict replay on load, canonical-before-projection write order,
 * the exact `log.md` line shape — through an injectable fake table. The file
 * backend had no equivalent, and it is the backend the `headless` profile
 * always gets. A 2026-08-25 mutation sweep measured the gap: replacing
 * `foldRun(events)` in `RunStore.load` with "trust the last event's embedded
 * snapshot", moving the projection write ABOVE the canonical append in
 * `commit`, turning `appendLog` into a no-op, swallowing its write errors,
 * widening `sanitize` so two run ids collide, and inverting either branch of
 * `defaultStoreRoot` EACH left the suite at 17 files / 468 passed. Every `it`
 * below is the bearer for one of those, and each was watched go red under its
 * own mutation before it was kept (DESIGN.md §5).
 *
 * WHY `vi.mock('node:fs')` RATHER THAN AN INJECTED SEAM. Two of the claims are
 * about the ORDER of side effects across different files (`events.jsonl` before
 * `snapshot.json`) and about a write FAILING (`log.md` on a full or read-only
 * disk). Neither is visible in the store's return values, and the store has no
 * fs seam to inject. The mock passes every call through to the real
 * implementation and only records it, so what is under test is still real
 * `node:fs` behaviour on a real temp directory — the mock is a tap, not a
 * substitute, and the assertions below re-read the real artifacts to prove it.
 * This mirrors `store-domain.test.ts`'s module-level `WRITE_LOG`, whose header
 * records that a per-table assertion could NOT see the order.
 *
 * Fixtures are local rather than imported from `./helpers.ts` for the same
 * reason that file gives: `helpers.ts` pulls in the engine and index modules,
 * and this file's fs tap should not reach further than the store under test.
 */

import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AutopilotError } from '../src/domain/types.js'
import type { RunEvent, Snapshot, Triage } from '../src/domain/types.js'

/**
 * The fs tap. `vi.mock` factories are hoisted above every import, so the log
 * and the failure switch are created with `vi.hoisted` and the factory closes
 * over them.
 */
const { FS_LOG, FS_FAIL } = vi.hoisted(() => ({
  /** Ordered `<verb> <basename>` record of every write the store performed. */
  FS_LOG: [] as string[],
  /** When set, the tap throws on a write whose basename matches. */
  FS_FAIL: { basename: undefined as string | undefined },
}))

vi.mock('node:fs', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs')>()
  const base = (path: unknown): string => String(path).split(/[\\/]/).pop() ?? ''
  const note = (verb: string, path: unknown): void => {
    const name = base(path)
    FS_LOG.push(`${verb} ${name}`)
    if (FS_FAIL.basename !== undefined && name === FS_FAIL.basename) {
      throw new Error(`injected write failure on ${name}`)
    }
  }
  const patched: typeof real = {
    ...real,
    appendFileSync: ((path: never, ...rest: never[]) => {
      note('append', path)
      return (real.appendFileSync as (...args: never[]) => void)(path, ...rest)
    }) as typeof real.appendFileSync,
    writeFileSync: ((path: never, ...rest: never[]) => {
      note('write', path)
      return (real.writeFileSync as (...args: never[]) => void)(path, ...rest)
    }) as typeof real.writeFileSync,
    renameSync: ((from: never, to: never) => {
      note('rename', to)
      return real.renameSync(from, to)
    }) as typeof real.renameSync,
  }
  return { ...patched, default: patched }
})

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { RunStore, defaultStoreRoot, expandHomePath, runDirFor } from '../src/store/file.js'

// -------------------------------------------------------------------- fixtures

function makeTriage(overrides: Partial<Triage> = {}): Triage {
  return {
    objective: 'file store round-trip',
    scope: ['src/store/'],
    nonGoals: ['src/engine.ts'],
    acceptanceCriteria: ['stream replays'],
    risk: 'low',
    size: 'lightweight',
    executionMode: 'inline',
    auditMode: 'self-check',
    touchesOperatingLayer: false,
    baseline: {},
    ...overrides,
  }
}

const TRIAGE = makeTriage()

function baseSnapshot(runId: string, overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    runId,
    revision: 1,
    triage: TRIAGE,
    plan: { revision: 0, text: '' },
    phase: 'planning',
    planGate: 'pending',
    executionGate: 'pending',
    audits: [],
    residualRisks: [],
    logCount: 0,
    consecutiveReplans: 0,
    enforcement: { sandbox: 'off', reminders: 0, ownerApprovals: [] },
    ...overrides,
  }
}

/** One stored line exactly as `RunStore.commit` would have written it. */
function line(op: RunEvent['op'], snapshot: Snapshot): string {
  const event: RunEvent = { v: 1, op, revision: snapshot.revision, time: '2026-08-25T00:00:00.000Z', snapshot }
  return `${JSON.stringify(event)}\n`
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-autopilot-file-'))
}

/** Hand-write a run's `events.jsonl`, bypassing `commit` — the hand-edited-file threat model. */
function seedStream(root: string, runId: string, lines: readonly string[]): void {
  const dir = runDirFor(root, runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'events.jsonl'), lines.join(''), 'utf8')
}

/** Assert a thrown AutopilotError BY CODE; a boolean "it threw" would not distinguish the failure modes. */
function expectCode(run: () => unknown, code: string): void {
  try {
    run()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AutopilotError)
    expect((error as AutopilotError).code).toBe(code)
    return
  }
  expect.unreachable(`expected an AutopilotError with code ${code}`)
}

beforeEach(() => {
  FS_LOG.length = 0
  FS_FAIL.basename = undefined
})

// ----------------------------------------------------------------------- tests

describe('RunStore.load replays the stream strictly', () => {
  /**
   * The invariant guardian at THIS layer. `store-domain.test.ts` already has
   * the matching case, named "rejects an illegal stream on load exactly as the
   * file backend does" — a name that asserted a symmetry the file side did not
   * actually bear. Codes are asserted BY VALUE so the failure modes stay
   * distinguishable; a bare "it threw" would survive collapsing them into one
   * generic error.
   */
  it('refuses a semantically illegal stream by code instead of folding it', () => {
    const root = tempRoot()
    const store = new RunStore(root)

    // (a) a revision gap: the writer skipped, or an event was cut out by hand.
    seedStream(root, 'run-gap', [
      line('init', baseSnapshot('run-gap')),
      line('log', baseSnapshot('run-gap', { revision: 3, logCount: 1 })),
    ])
    expectCode(() => store.load('run-gap'), 'AP_REVISION')

    // (b) the stream does not begin with init.
    seedStream(root, 'run-head', [line('log', baseSnapshot('run-head', { logCount: 1 }))])
    expectCode(() => store.load('run-head'), 'AP_FIRST_NOT_INIT')

    // (c) the triage was edited on disk after init — the run's contract changed
    // under its own audit trail.
    seedStream(root, 'run-triage', [
      line('init', baseSnapshot('run-triage')),
      line('log', baseSnapshot('run-triage', {
        revision: 2,
        logCount: 1,
        triage: makeTriage({ risk: 'critical', acceptanceCriteria: ['anything goes'] }),
      })),
    ])
    expectCode(() => store.load('run-triage'), 'AP_TRIAGE_MUTATED')

    // (d) an event appended after a terminal phase.
    seedStream(root, 'run-terminal', [
      line('init', baseSnapshot('run-terminal')),
      line('set-blocked', baseSnapshot('run-terminal', { revision: 2, phase: 'blocked' })),
      line('log', baseSnapshot('run-terminal', { revision: 3, phase: 'blocked', logCount: 1 })),
    ])
    expectCode(() => store.load('run-terminal'), 'AP_AFTER_TERMINAL')

    // Cardinality floor: four DISTINCT codes were observed, so no single
    // collapsed error could have satisfied the block above.
    expect(new Set(['AP_REVISION', 'AP_FIRST_NOT_INIT', 'AP_TRIAGE_MUTATED', 'AP_AFTER_TERMINAL']).size).toBe(4)

    // POSITIVE CONTROL on the same checker: the legal prefix of the same shape
    // loads, so the four rejections are not a checker that fails everything.
    seedStream(root, 'run-ok', [
      line('init', baseSnapshot('run-ok')),
      line('log', baseSnapshot('run-ok', { revision: 2, logCount: 1 })),
    ])
    expect(store.load('run-ok')?.revision).toBe(2)
    expect(store.load('run-ok')?.phase).toBe('planning')
  })

  /**
   * The mutation this is aimed at trusts `events[last].snapshot` verbatim. Such
   * a store returns the RIGHT answer on every legal stream, so a happy-path
   * round-trip cannot see it — but it also accepts a stream whose LAST line is
   * plausible and whose prefix is not, which is what this case is.
   */
  it('folds the whole prefix, not just the last line', () => {
    const root = tempRoot()
    // The last line is a perfectly well-formed revision-3 snapshot; the stream
    // that reaches it is illegal. A last-line-only reader answers 3.
    seedStream(root, 'run-prefix', [
      line('init', baseSnapshot('run-prefix')),
      line('log', baseSnapshot('run-prefix', { revision: 9, logCount: 1 })),
      line('log', baseSnapshot('run-prefix', { revision: 3, logCount: 2 })),
    ])
    expectCode(() => new RunStore(root).load('run-prefix'), 'AP_REVISION')
  })

  it('returns undefined for a run with no stream', () => {
    expect(new RunStore(tempRoot()).load('never-initialized')).toBeUndefined()
  })
})

describe('RunStore.commit', () => {
  /**
   * ORDER, which no return value can show. `commit`'s own comment calls the
   * order load-bearing and `install.test.ts` builds its whole rationale on it
   * ("appends the canonical event BEFORE the tmp+rename of the projection, so
   * a kill inside that window leaves exactly a partial last line") — but that
   * file writes the torn residue by hand and therefore asserts the CONSEQUENCE,
   * never the mechanism that makes the residue that shape. Reversed, a crash in
   * the window publishes a `snapshot.json` for an event that never became
   * durable, and `install.test.ts` stays green while its stated premise is
   * false.
   */
  it('appends the canonical event before publishing the projection, for EVERY event', async () => {
    const root = tempRoot()
    const store = new RunStore(root)
    const steps: Array<[RunEvent['op'], Snapshot]> = [['init', baseSnapshot('run-order')]]
    for (let revision = 2; revision <= 6; revision++) {
      steps.push(['log', baseSnapshot('run-order', { revision, logCount: revision - 1 })])
    }
    // Cardinality floor: a single-event run could not distinguish "the first
    // event is ordered correctly" from "every event is".
    expect(steps.length).toBeGreaterThanOrEqual(5)

    FS_LOG.length = 0
    for (const [op, snapshot] of steps) {
      const event = await store.commit('run-order', op, snapshot)
      expect(event.revision).toBe(snapshot.revision)
    }

    expect(FS_LOG).toEqual(
      steps.flatMap(() => ['append events.jsonl', 'write snapshot.json.tmp', 'rename snapshot.json']),
    )

    // The tap did not replace the filesystem: the real artifacts are on disk and
    // the real stream replays through the real fold.
    expect(store.load('run-order')?.revision).toBe(steps.length)
    const projected = JSON.parse(readFileSync(join(store.runDir('run-order'), 'snapshot.json'), 'utf8')) as Snapshot
    expect(projected.revision).toBe(steps.length)
  })
})

describe('RunStore.appendLog', () => {
  /**
   * The file backend's `log.md`. `store-domain.test.ts` bears this for the
   * domain store line for line; the identical method here had no bearer at all,
   * so the headless profile could ship writing no execution log while every
   * mechanical gate still passed.
   */
  it('renders each checkpoint into log.md with its note, target and blocking scope', async () => {
    const root = tempRoot()
    const store = new RunStore(root)
    await store.appendLog('run-log', { seq: 0, text: 'first checkpoint', stance: 'on-plan' })
    await store.appendLog('run-log', {
      seq: 1,
      text: 'blocked',
      stance: 'escalate',
      note: 'needs owner',
      escalationTarget: 'owner',
      blockingScope: 'run',
    })

    const lines = readFileSync(join(store.runDir('run-log'), 'log.md'), 'utf8')
      .split('\n')
      .filter(entry => entry.length > 0)
    expect(lines.length).toBe(2)
    expect(lines[0]).toContain('[on-plan] first checkpoint')
    expect(lines[1]).toContain('[escalate] blocked note: needs owner -> owner (blocks: run)')
  })

  /**
   * A failed log write must reach the caller. Swallowing it is invisible on the
   * happy path and diverges only under exactly the disk/permission conditions
   * where an operator most needs the record — including `stance: 'escalate'`
   * lines, the ones carrying an escalation target.
   */
  it('propagates a write failure instead of dropping the checkpoint', async () => {
    const store = new RunStore(tempRoot())
    FS_FAIL.basename = 'log.md'
    await expect(
      store.appendLog('run-fail', { seq: 0, text: 'escalating', stance: 'escalate', escalationTarget: 'owner' }),
    ).rejects.toThrow(/injected write failure on log\.md/)

    // POSITIVE CONTROL: with the injected failure cleared, the same call
    // resolves — so the rejection above is the induced condition, not a fixture
    // that can never succeed.
    FS_FAIL.basename = undefined
    await expect(
      store.appendLog('run-fail', { seq: 1, text: 'recovered', stance: 'on-plan' }),
    ).resolves.toBeUndefined()
  })
})

describe('runDirFor', () => {
  /**
   * Injectivity, which the single existing shape assertion could not see: its
   * fixture (`run/with:unsafe`) has no ADJACENT unsafe characters, so widening
   * the matcher to `+` satisfies it identically while collapsing `a//b` onto
   * `a/b`. Two run ids sharing one directory interleave their canonical
   * streams, collide on `snapshot.json`, `log.md`, usage artifacts and the
   * outbound manifest.
   */
  it('maps distinct run ids to distinct directories', () => {
    const ids = ['a/b', 'a//b', 'a___b', 's:1', 's::1', 'r#1', 'r##1', '../escape', '..%2Fescape']
    const dirs = ids.map(id => runDirFor('/root', id))
    // Cardinality floor: the table must actually contain pairs that differ ONLY
    // in the length of a run of unsafe characters, or it proves nothing.
    expect(ids.length).toBeGreaterThanOrEqual(8)
    expect(new Set(dirs).size).toBe(ids.length)
    expect(runDirFor('/root', 'a/b')).not.toBe(runDirFor('/root', 'a//b'))
    expect(runDirFor('/root', 's:1')).not.toBe(runDirFor('/root', 's::1'))
  })

  /**
   * THE LIMIT OF THE CLAIM ABOVE, asserted rather than left implied. `sanitize`
   * escapes to `_`, so an id containing a literal `_` CAN collide with one
   * containing an unsafe character in the same position. That is what the
   * function's own doc means by "without losing uniqueness IN PRACTICE" — dsh
   * session ids do not contain `_` — and it is pre-existing, not something the
   * bearer above closes. Pinning it here keeps the injectivity test honest
   * about its scope: it forbids run-length collapsing, not every collision.
   */
  it('still collides an escaped character with a literal underscore (known limit)', () => {
    expect(runDirFor('/root', 's:1')).toBe(runDirFor('/root', 's_1'))
  })

  /**
   * The rule BY VALUE. Both backends now call this one function, so a
   * cross-backend equality assertion alone could never fail; what CAN still
   * fail is the shared mapping itself drifting — adding `.toLowerCase()`, say,
   * which would fold two ids differing only in case onto one directory and
   * orphan every artifact ref recorded under the other. Root session ids are
   * commonly mixed-case hex, so this is the reachable half.
   */
  it('is case-preserving and replaces each unsafe character one for one', () => {
    expect(runDirFor('/root', 'run/with:unsafe')).toBe(join('/root', 'runs', 'run_with_unsafe'))
    expect(runDirFor('/root', 'Run-A')).toBe(join('/root', 'runs', 'Run-A'))
    expect(runDirFor('/root', 'run-a')).toBe(join('/root', 'runs', 'run-a'))
    expect(runDirFor('/root', 'Run-A')).not.toBe(runDirFor('/root', 'run-a'))
    expect(runDirFor('/root', 'S3sS#aB.9_x-Y')).toBe(join('/root', 'runs', 'S3sS_aB.9_x-Y'))
  })

  it('is the rule RunStore itself uses', () => {
    const root = tempRoot()
    expect(new RunStore(root).runDir('Run/A:1')).toBe(runDirFor(root, 'Run/A:1'))
  })
})

describe('RunStore.currentRevision — the freshness probe', () => {
  it('reads the PUBLISHED revision and follows commits', async () => {
    const store = new RunStore(tempRoot())
    expect(store.currentRevision('run-1')).toBeUndefined() // no run at all
    const first = baseSnapshot('run-1')
    await store.commit('run-1', 'init', first)
    expect(store.currentRevision('run-1')).toBe(1)
    await store.commit('run-1', 'log', { ...first, revision: 2, logCount: 1 })
    expect(store.currentRevision('run-1')).toBe(2)
  })

  it('answers undefined — "cannot tell" — rather than throwing, on every unreadable shape', async () => {
    // A freshness probe that throws converts a cosmetic staleness into a failed
    // read. The engine treats undefined as "keep what you have", which is the
    // honest floor: nothing was observed to be stale.
    const root = tempRoot()
    const store = new RunStore(root)
    await store.commit('run-1', 'init', baseSnapshot('run-1'))
    const projection = join(runDirFor(root, 'run-1'), 'snapshot.json')

    writeFileSync(projection, '{ not json', 'utf8')
    expect(store.currentRevision('run-1')).toBeUndefined()
    writeFileSync(projection, '{"runId":"run-1"}', 'utf8') // no revision key
    expect(store.currentRevision('run-1')).toBeUndefined()
    writeFileSync(projection, '{"revision":"7"}', 'utf8') // right key, wrong type
    expect(store.currentRevision('run-1')).toBeUndefined()
    writeFileSync(projection, '{"revision":null}', 'utf8')
    expect(store.currentRevision('run-1')).toBeUndefined()
    // Control: a well-formed projection still answers, so the four cases above
    // are not passing on a probe that always says undefined.
    writeFileSync(projection, '{"revision":7}', 'utf8')
    expect(store.currentRevision('run-1')).toBe(7)
  })
})

describe('defaultStoreRoot', () => {
  /**
   * All documented branches, by value, over an INJECTED env record — the
   * function takes one, so no global mutation is needed. Before this block the
   * function was entirely unexercised: grep found no reference to it or to
   * `DSH_AUTOPILOT_HOME` anywhere under `test/`, and BOTH backends resolve
   * their artifact root through it.
   */
  /**
   * The expectations below are written as `resolve(...)` rather than as path
   * LITERALS on purpose (changed 2026-08-27 with the tilde fix). `/scratch/ap`
   * is absolute on POSIX and drive-relative on Windows, so a literal would pin
   * the assertion to one platform's spelling of the answer; what the function
   * actually promises is "dsh's own two steps, in dsh's order", and `resolve`
   * is the second of those steps.
   */
  it('lets the explicit override win over DSH_HOME', () => {
    expect(defaultStoreRoot({ DSH_AUTOPILOT_HOME: '/scratch/ap', DSH_HOME: '/home/u/.dsh' })).toBe(resolve('/scratch/ap'))
    expect(defaultStoreRoot({ DSH_AUTOPILOT_HOME: '/scratch/ap' })).toBe(resolve('/scratch/ap'))
  })

  it('falls through to DSH_HOME when the override is absent or blank', () => {
    const viaDshHome = join(resolve('/home/u/.dsh'), 'storages', 'dsh-autopilot')
    expect(defaultStoreRoot({ DSH_HOME: '/home/u/.dsh' })).toBe(viaDshHome)
    // '' is the ordinary result of an unset variable in a shell wrapper or a CI
    // matrix; taking it as a root would write `runs/<id>` relative to whatever
    // the process cwd happens to be.
    expect(defaultStoreRoot({ DSH_AUTOPILOT_HOME: '', DSH_HOME: '/home/u/.dsh' })).toBe(viaDshHome)
    expect(defaultStoreRoot({ DSH_AUTOPILOT_HOME: '   ', DSH_HOME: '/home/u/.dsh' })).toBe(viaDshHome)
  })

  it('falls back to the home directory when neither variable is usable', () => {
    const viaHome = join(homedir(), '.dsh', 'storages', 'dsh-autopilot')
    expect(defaultStoreRoot({})).toBe(viaHome)
    expect(defaultStoreRoot({ DSH_AUTOPILOT_HOME: '', DSH_HOME: '' })).toBe(viaHome)
    expect(defaultStoreRoot({ DSH_AUTOPILOT_HOME: '  ', DSH_HOME: '  ' })).toBe(viaHome)
  })

  it('never resolves a blank override to a relative root', () => {
    const cases: Array<Record<string, string | undefined>> = [
      {},
      { DSH_AUTOPILOT_HOME: '' },
      { DSH_AUTOPILOT_HOME: '   ' },
      { DSH_HOME: '' },
      { DSH_AUTOPILOT_HOME: '', DSH_HOME: '/home/u/.dsh' },
    ]
    expect(cases.length).toBeGreaterThanOrEqual(5)
    for (const env of cases) expect(isAbsolute(defaultStoreRoot(env))).toBe(true)
  })

  /**
   * THE DIVERGENCE THIS BLOCK BEARS. dsh resolves its own home with
   * `resolve(expandHomePath(selected))`; this function used to return `DSH_HOME`
   * RAW, so `DSH_HOME=~/.dsh` — a spelling dsh accepts — put the host's
   * storages under the real home and this plugin's under a literal `~`
   * directory beside the process cwd. Both halves would then report "the
   * default root" while writing to different trees.
   *
   * Mutation control: deleting the `expandHomePath` call from either branch of
   * `defaultStoreRoot` turns the first two cases red (the answer keeps a
   * literal `~` segment); deleting the `resolve` call turns the DSH_HOME case
   * red on Windows. Watched go red before this block was kept.
   */
  it('expands a tilde home the way dsh does, in both env positions', () => {
    expect(defaultStoreRoot({ DSH_AUTOPILOT_HOME: '~/scratch/ap' })).toBe(join(homedir(), 'scratch', 'ap'))
    expect(defaultStoreRoot({ DSH_HOME: '~/.dsh' })).toBe(join(homedir(), '.dsh', 'storages', 'dsh-autopilot'))
    // The same answer the no-variable default gives, which is the point: the
    // two spellings of one home must not resolve to two roots.
    expect(defaultStoreRoot({ DSH_HOME: '~/.dsh' })).toBe(defaultStoreRoot({}))
    expect(defaultStoreRoot({ DSH_AUTOPILOT_HOME: '~' })).toBe(resolve(homedir()))
  })

  it('expandHomePath expands ONLY the prefixes dsh expands', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/x')).toBe(join(homedir(), 'x'))
    expect(expandHomePath('~\\x')).toBe(join(homedir(), 'x'))
    // The negative half, and it is the load-bearing one: per-user tilde
    // expansion is a SHELL feature no Node API implements, so `~someone` must
    // pass through untouched rather than become a home that does not exist.
    // A `~` that is not the first character is an ordinary path character.
    expect(expandHomePath('~someone/x')).toBe('~someone/x')
    expect(expandHomePath('/opt/a~b')).toBe('/opt/a~b')
    expect(expandHomePath('')).toBe('')
    expect(expandHomePath('/already/absolute')).toBe('/already/absolute')
  })

  it('a tilde that is not a home prefix is not expanded by defaultStoreRoot either', () => {
    // Control for the block above at the caller's level: if `expandHomePath`
    // were widened to "replace every ~", this expectation is what would catch it.
    expect(defaultStoreRoot({ DSH_AUTOPILOT_HOME: '/opt/a~b' })).toBe(resolve('/opt/a~b'))
  })
})
