/**
 * The lazy, one-time restore of the read-only clamp a 0.2.x run left on a session.
 *
 * Fixtures: `syn-session-a` (clamped, recorded prior `workspace-write`, completed)
 * and `syn-clamped-no-prior` (clamped, no prior recorded). The root agent's id is
 * the session id, as in 0.2.x. Each case scripts the session's `sandbox/mode`
 * events and asserts the CONCRETE value appended (or that nothing was).
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AutopilotEngine } from '../src/engine.js'
import { resolveConfig } from '../src/index.js'
import { FileLedgerStore, legacySourcesOf } from '../src/store/ledger.js'
import { FakeAgents, fakeAgent, makeHarness, stubSubagents } from './helpers.js'
import type { FakeAgent } from './helpers.js'

const SESSION = 'syn-session-a'
const CLAMPED = 'independent-clamped-completed.jsonl'
const NO_PRIOR_SESSION = 'syn-clamped-no-prior'
const NO_PRIOR = 'clamped-no-prior-mode.jsonl'

const mode = (value: string, extra: Record<string, unknown> = {}) => ({ type: 'sandbox/mode', data: { mode: value, ...extra } })

function script(root: FakeAgent, events: Array<{ type: string; data: unknown }>): void {
  for (const event of events) root.session.append(event.type, event.data)
}

const appendedModes = (root: FakeAgent): unknown[] => root.appended.filter(e => e.type === 'sandbox/mode').map(e => e.data)

function open(options: { rootId: string; fixtures: readonly string[]; env?: () => string | undefined }) {
  const h = makeHarness({
    rootId: options.rootId,
    legacyFixtures: options.fixtures,
    ...(options.env === undefined ? {} : { environment: { sandboxDefaultMode: options.env } }),
    ports: { now: () => '2026-11-04T10:00:00.000Z' },
  })
  return h
}

describe('restore with a recorded prior mode', () => {
  it('(1) the clamp is still last: the prior mode is appended and recorded as restored', async () => {
    const h = open({ rootId: SESSION, fixtures: [CLAMPED] })
    script(h.root, [mode('workspace-write'), mode('read-only')])

    const outcome = await h.engine.onRootOpened(h.root)

    expect(appendedModes(h.root)).toEqual([{ mode: 'workspace-write' }, { mode: 'read-only' }, { mode: 'workspace-write' }])
    expect(outcome.restoredRunIds).toEqual([SESSION])
    expect(h.engine.peekLedger(SESSION)!.legacyRestores).toEqual({
      [SESSION]: { state: 'restored', mode: 'workspace-write', at: '2026-11-04T10:00:00.000Z' },
    })
  })

  it('(1b) a terminal-phase run whose clamp is still last is restored too (the fixture run is completed)', async () => {
    const h = open({ rootId: SESSION, fixtures: [CLAMPED] })
    script(h.root, [mode('workspace-write'), mode('read-only')])
    await h.engine.onRootOpened(h.root)
    expect(h.engine.peekLedger(SESSION)!.legacyRestores?.[SESSION]?.state).toBe('restored')
  })

  it('(2) the user changed the mode AFTER the clamp: nothing is appended', async () => {
    const h = open({ rootId: SESSION, fixtures: [CLAMPED] })
    script(h.root, [mode('workspace-write'), mode('read-only'), mode('danger-full-access')])

    await h.engine.onRootOpened(h.root)

    expect(appendedModes(h.root)).toEqual([{ mode: 'workspace-write' }, { mode: 'read-only' }, { mode: 'danger-full-access' }])
    expect(h.engine.peekLedger(SESSION)!.legacyRestores?.[SESSION]).toMatchObject({ state: 'untouched-user-changed' })
  })

  it('(2b) KNOWN LIMIT of the positional rule: a user read-only that directly follows the recorded prior mode looks like the clamp', async () => {
    // [workspace-write, read-only(clamp), workspace-write(lifted), read-only(user)]: the last two events
    // are shaped exactly like a fresh clamp (read-only, no source, right after the prior mode), and the
    // log carries nothing else to tell them apart. The rule restores here. Pinned so a change is deliberate.
    const h = open({ rootId: SESSION, fixtures: [CLAMPED] })
    script(h.root, [mode('workspace-write'), mode('read-only'), mode('workspace-write'), mode('read-only')])
    await h.engine.onRootOpened(h.root)
    expect(appendedModes(h.root).slice(-1)).toEqual([{ mode: 'workspace-write' }])
  })

  it('(2c) the last read-only carries a source field: it is not the plugin\'s clamp, nothing is appended', async () => {
    const h = open({ rootId: SESSION, fixtures: [CLAMPED] })
    script(h.root, [mode('workspace-write'), mode('read-only', { source: 'permission-preset' })])
    await h.engine.onRootOpened(h.root)
    expect(appendedModes(h.root)).toHaveLength(2)
    expect(h.engine.peekLedger(SESSION)!.legacyRestores?.[SESSION]?.state).toBe('untouched-user-changed')
  })

  it('(2d) the event before the clamp is not the recorded prior: nothing is appended', async () => {
    const h = open({ rootId: SESSION, fixtures: [CLAMPED] })
    script(h.root, [mode('danger-full-access'), mode('read-only')])
    await h.engine.onRootOpened(h.root)
    expect(appendedModes(h.root)).toHaveLength(2)
    expect(h.engine.peekLedger(SESSION)!.legacyRestores?.[SESSION]?.state).toBe('untouched-user-changed')
  })

  it('(2e) the old engine already restored the session (terminal run): last event is not read-only, nothing appended', async () => {
    const h = open({ rootId: SESSION, fixtures: [CLAMPED] })
    script(h.root, [mode('workspace-write'), mode('read-only'), mode('workspace-write')])
    await h.engine.onRootOpened(h.root)
    expect(appendedModes(h.root)).toHaveLength(3)
    expect(h.engine.peekLedger(SESSION)!.legacyRestores?.[SESSION]?.state).toBe('untouched-user-changed')
  })

  it('a session whose log holds no sandbox/mode event at all is recorded not-clamped', async () => {
    const h = open({ rootId: SESSION, fixtures: [CLAMPED] })
    await h.engine.onRootOpened(h.root)
    expect(appendedModes(h.root)).toEqual([])
    expect(h.engine.peekLedger(SESSION)!.legacyRestores?.[SESSION]).toMatchObject({ state: 'not-clamped' })
  })
})

describe('restore with NO recorded prior mode', () => {
  it('(3a) the host default is written, recorded as default-written with the mode (the host has no way to clear an override)', async () => {
    const h = open({ rootId: NO_PRIOR_SESSION, fixtures: [NO_PRIOR], env: () => 'workspace-write' })
    script(h.root, [mode('read-only')])

    await h.engine.onRootOpened(h.root)

    expect(appendedModes(h.root)).toEqual([{ mode: 'read-only' }, { mode: 'workspace-write' }])
    expect(h.engine.peekLedger(NO_PRIOR_SESSION)!.legacyRestores?.[NO_PRIOR_SESSION]).toEqual({
      state: 'default-written', mode: 'workspace-write', at: '2026-11-04T10:00:00.000Z',
    })
  })

  it('(3b) the host default cannot be read: failed with a plain note, no mode is invented', async () => {
    const h = open({ rootId: NO_PRIOR_SESSION, fixtures: [NO_PRIOR], env: () => undefined })
    script(h.root, [mode('read-only')])

    await h.engine.onRootOpened(h.root)

    expect(appendedModes(h.root)).toEqual([{ mode: 'read-only' }])
    const record = h.engine.peekLedger(NO_PRIOR_SESSION)!.legacyRestores?.[NO_PRIOR_SESSION]
    expect(record?.state).toBe('failed')
    expect(record?.note).toMatch(/host default mode is not readable/)
    expect(record?.mode).toBeUndefined()
  })

  it('(3c) a default that is not a known sandbox mode is treated as unreadable', async () => {
    const h = open({ rootId: NO_PRIOR_SESSION, fixtures: [NO_PRIOR], env: () => 'yolo' })
    script(h.root, [mode('read-only')])
    await h.engine.onRootOpened(h.root)
    expect(appendedModes(h.root)).toEqual([{ mode: 'read-only' }])
    expect(h.engine.peekLedger(NO_PRIOR_SESSION)!.legacyRestores?.[NO_PRIOR_SESSION]?.state).toBe('failed')
  })

  it('(3d) a read-only default means the session already behaves as the default: recorded, nothing written', async () => {
    const h = open({ rootId: NO_PRIOR_SESSION, fixtures: [NO_PRIOR], env: () => 'read-only' })
    script(h.root, [mode('read-only')])
    await h.engine.onRootOpened(h.root)
    expect(appendedModes(h.root)).toEqual([{ mode: 'read-only' }])
    expect(h.engine.peekLedger(NO_PRIOR_SESSION)!.legacyRestores?.[NO_PRIOR_SESSION]).toMatchObject({ state: 'default-written', mode: 'read-only' })
  })

  it('(3e) with no prior recorded, a read-only that follows another mode event is not proven to be the clamp', async () => {
    const h = open({ rootId: NO_PRIOR_SESSION, fixtures: [NO_PRIOR], env: () => 'workspace-write' })
    script(h.root, [mode('danger-full-access'), mode('read-only')])
    await h.engine.onRootOpened(h.root)
    expect(appendedModes(h.root)).toHaveLength(2)
    expect(h.engine.peekLedger(NO_PRIOR_SESSION)!.legacyRestores?.[NO_PRIOR_SESSION]?.state).toBe('untouched-user-changed')
  })
})

describe('idempotence and failure', () => {
  it('(4) a second open appends nothing and rewrites nothing', async () => {
    const h = open({ rootId: SESSION, fixtures: [CLAMPED] })
    script(h.root, [mode('workspace-write'), mode('read-only')])
    await h.engine.onRootOpened(h.root)
    const appended = appendedModes(h.root).length
    const revision = h.engine.peekLedger(SESSION)!.revision

    // The user locks the session read-only again afterwards; the recorded outcome still wins.
    h.root.session.append('sandbox/mode', { mode: 'read-only' })
    const second = await h.engine.onRootOpened(h.root)

    expect(second.restoredRunIds).toEqual([])
    expect(appendedModes(h.root)).toHaveLength(appended + 1)
    expect(h.engine.peekLedger(SESSION)!.revision).toBe(revision)
  })

  it('(4b) a NEW engine over the same store (a restart) does not restore again', async () => {
    const h = open({ rootId: SESSION, fixtures: [CLAMPED] })
    script(h.root, [mode('workspace-write'), mode('read-only')])
    await h.engine.onRootOpened(h.root)
    h.root.session.append('sandbox/mode', { mode: 'read-only' })
    const before = appendedModes(h.root).length

    const restarted = new AutopilotEngine(h.agents, stubSubagents(), FileLedgerStore.open(h.storeDir), legacySourcesOf(h.storeDir), resolveConfig())
    await restarted.onRootOpened(h.root)

    expect(appendedModes(h.root)).toHaveLength(before)
  })

  it('(4c) two CONCURRENT opens of one session append once', async () => {
    const h = open({ rootId: SESSION, fixtures: [CLAMPED] })
    script(h.root, [mode('workspace-write'), mode('read-only')])
    const [a, b] = await Promise.all([h.engine.onRootOpened(h.root), h.engine.onRootOpened(h.root)])
    expect(appendedModes(h.root)).toEqual([{ mode: 'workspace-write' }, { mode: 'read-only' }, { mode: 'workspace-write' }])
    expect([a.restoredRunIds, b.restoredRunIds].flat()).toEqual([SESSION])
  })

  it('(5) an append that throws is recorded as failed with the reason, and is not retried', async () => {
    const h = open({ rootId: SESSION, fixtures: [CLAMPED] })
    script(h.root, [mode('workspace-write'), mode('read-only')])
    const original = h.root.session.append
    let attempts = 0
    h.root.session.append = (type: string, data: unknown) => {
      if (type === 'sandbox/mode' && data !== undefined && (data as { mode: string }).mode === 'workspace-write') {
        attempts += 1
        throw new Error('session is closed')
      }
      original(type, data)
    }

    await h.engine.onRootOpened(h.root)
    await h.engine.onRootOpened(h.root)

    expect(attempts).toBe(1)
    const record = h.engine.peekLedger(SESSION)!.legacyRestores?.[SESSION]
    expect(record?.state).toBe('failed')
    expect(record?.note).toMatch(/session is closed/)
  })

  it('a prior mode the host does not know is not written', async () => {
    // Same clamp layout, but the "event before" carries an unknown mode string that equals the recorded prior.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-clamp-'))
    const raw = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'legacy-synthetic', CLAMPED), 'utf8')
      .replaceAll('"priorSandboxMode":"workspace-write"', '"priorSandboxMode":"yolo"')
    mkdirSync(join(dir, 'runs', SESSION), { recursive: true })
    writeFileSync(join(dir, 'runs', SESSION, 'events.jsonl'), raw)
    const agents = new FakeAgents()
    const root = fakeAgent(SESSION)
    agents.add(root)
    script(root, [mode('yolo'), mode('read-only')])
    const engine = new AutopilotEngine(agents, stubSubagents(), FileLedgerStore.open(dir), legacySourcesOf(dir), resolveConfig())
    await engine.onRootOpened(root)
    expect(appendedModes(root)).toHaveLength(2)
    expect(engine.peekLedger(SESSION)!.legacyRestores?.[SESSION]?.state).toBe('failed')
  })
})

describe('several legacy runs on one session', () => {
  /** A second clamped run of the same session: the fixture with another run id and an explicit session id. */
  function secondRun(root: string): string {
    const raw = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'legacy-synthetic', CLAMPED), 'utf8')
      .replaceAll('"runId":"syn-session-a"', `"runId":"syn-session-b","sessionId":"${SESSION}"`)
    mkdirSync(join(root, 'runs', 'syn-session-b'), { recursive: true })
    writeFileSync(join(root, 'runs', 'syn-session-b', 'events.jsonl'), raw)
    return 'syn-session-b'
  }

  it('both clamped runs prove the same prior: ONE event is appended and both are recorded restored', async () => {
    const h = open({ rootId: SESSION, fixtures: [CLAMPED] })
    const other = secondRun(h.storeDir)
    script(h.root, [mode('workspace-write'), mode('read-only')])

    const outcome = await h.engine.onRootOpened(h.root)

    expect(appendedModes(h.root)).toEqual([{ mode: 'workspace-write' }, { mode: 'read-only' }, { mode: 'workspace-write' }])
    expect([...outcome.restoredRunIds].sort()).toEqual([other, SESSION].sort())
    const restores = h.engine.peekLedger(SESSION)!.legacyRestores!
    expect(restores[SESSION]?.state).toBe('restored')
    expect(restores[other]?.state).toBe('restored')
  })

  it('a run of ANOTHER session is never examined when this root opens', async () => {
    const h = open({ rootId: SESSION, fixtures: [CLAMPED, NO_PRIOR] })
    script(h.root, [mode('workspace-write'), mode('read-only')])
    await h.engine.onRootOpened(h.root)
    expect(Object.keys(h.engine.peekLedger(SESSION)!.legacyRestores ?? {})).toEqual([SESSION])
  })
})
