/**
 * File-store path rules: `src/store/file.ts`.
 *
 * 0.3.0 removed the 0.2.x `RunStore` class and its writers, so what is left to
 * hold here is the shared root resolution (`defaultStoreRoot`, `expandHomePath`),
 * the run-directory rule (`runDirFor`, which the frozen legacy reader and the
 * domain migration still follow) and the session-index reader. The ledger
 * store itself is in `test/ledger-store.test.ts`.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultStoreRoot, expandHomePath, readSessionIndex, runDirFor } from '../src/store/file.js'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-autopilot-file-'))
}

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

describe('readSessionIndex', () => {
  it('reads a well-formed index and refuses every malformed shape', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'sessions'), { recursive: true })
    const put = (value: unknown): void => writeFileSync(join(root, 'sessions', 's1.json'), JSON.stringify(value), 'utf8')
    expect(readSessionIndex(root, 's1')).toBeUndefined()
    put({ v: 1, sessionId: 's1', currentRunId: 'r2', runIds: ['r1', 'r2'] })
    expect(readSessionIndex(root, 's1')).toEqual({ v: 1, sessionId: 's1', currentRunId: 'r2', runIds: ['r1', 'r2'] })
    put({ v: 2, sessionId: 's1', currentRunId: 'r2', runIds: ['r2'] })
    expect(readSessionIndex(root, 's1')).toBeUndefined()
    put({ v: 1, sessionId: 'other', currentRunId: 'r2', runIds: ['r2'] })
    expect(readSessionIndex(root, 's1')).toBeUndefined()
    put({ v: 1, sessionId: 's1', currentRunId: 'r9', runIds: ['r2'] })
    expect(readSessionIndex(root, 's1')).toBeUndefined()
    writeFileSync(join(root, 'sessions', 's1.json'), '{ not json', 'utf8')
    expect(readSessionIndex(root, 's1')).toBeUndefined()
  })
})
