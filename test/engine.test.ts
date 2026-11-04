/**
 * The slim v3 engine: the ledger writer (CAS, lanes, dispose), host-restart lost
 * marking, the zero-footprint rule, and the legacy-run link. The sandbox clamp
 * restore has its own file (`test/clamp-restore.test.ts`).
 */

import { describe, expect, it } from 'vitest'
import { AutopilotEngine } from '../src/engine.js'
import { AutopilotError } from '../src/domain/types.js'
import type { Ledger } from '../src/domain/ledger-types.js'
import { FileLedgerStore, emptyLedger, legacySourcesOf } from '../src/store/ledger.js'
import type { LedgerStoreLike } from '../src/store/ledger.js'
import { resolveConfig } from '../src/index.js'
import { FakeAgents, delegation, fakeAgent, makeHarness, stubSubagents } from './helpers.js'

const NOW = '2026-11-04T10:00:00.000Z'

function seeded(h: ReturnType<typeof makeHarness>, delegations: Ledger['delegations']): Promise<Ledger | undefined> {
  return h.engine.mutate('root-1', ledger => ({ ...ledger, delegations }))
}

describe('host-restart lost marking', () => {
  it('a running and a starting child the host no longer holds become lost, with the restart marker and released auto-continue', async () => {
    const h = makeHarness({ ports: { now: () => NOW } })
    await seeded(h, [delegation('w-run', 'running'), delegation('w-start', 'starting'), delegation('s-done', 'completed'), delegation('w-idle', 'idle')])

    const outcome = await h.engine.onRootOpened(h.root)

    expect(outcome.lostChildIds).toEqual(['w-run', 'w-start'])
    const ledger = h.engine.peekLedger('root-1')!
    expect(ledger.delegations.map(d => [d.childId, d.state])).toEqual([
      ['w-run', 'lost'], ['w-start', 'lost'], ['s-done', 'completed'], ['w-idle', 'idle'],
    ])
    expect(ledger.hostRestart).toEqual({ at: NOW, lostChildIds: ['w-run', 'w-start'] })
    expect(ledger.autoContinue).toEqual({ available: false, code: 'released-after-restart', reason: 'released after host restart' })
    expect(ledger.delegations[0]).toMatchObject({ settledAt: NOW })
  })

  it('a child that is still a live resident agent is untouched, and no marker is written for it', async () => {
    const h = makeHarness()
    await seeded(h, [delegation('w-live', 'running'), delegation('w-gone', 'running')])
    h.agents.add(fakeAgent('w-live', 'root-1'))

    const outcome = await h.engine.onRootOpened(h.root)

    expect(outcome.lostChildIds).toEqual(['w-gone'])
    const ledger = h.engine.peekLedger('root-1')!
    expect(ledger.delegations.find(d => d.childId === 'w-live')?.state).toBe('running')
    expect(ledger.hostRestart?.lostChildIds).toEqual(['w-gone'])
  })

  it('with every child resident nothing is written at all', async () => {
    const h = makeHarness()
    await seeded(h, [delegation('w-live', 'running')])
    h.agents.add(fakeAgent('w-live', 'root-1'))
    const before = h.engine.peekLedger('root-1')!.revision

    await h.engine.onRootOpened(h.root)

    expect(h.engine.peekLedger('root-1')!.revision).toBe(before)
    expect(h.engine.peekLedger('root-1')!.hostRestart).toBeUndefined()
  })

  it('is idempotent: a second open finds nothing running and writes nothing', async () => {
    const h = makeHarness()
    await seeded(h, [delegation('w-gone', 'running')])
    await h.engine.onRootOpened(h.root)
    const revision = h.engine.peekLedger('root-1')!.revision
    const second = await h.engine.onRootOpened(h.root)
    expect(second.lostChildIds).toEqual([])
    expect(h.engine.peekLedger('root-1')!.revision).toBe(revision)
  })

  it('skipChildIds protects a child the dispatch layer has in flight', async () => {
    const h = makeHarness()
    await seeded(h, [delegation('w-inflight', 'starting')])
    const outcome = await h.engine.onRootOpened(h.root, new Set(['w-inflight']))
    expect(outcome.lostChildIds).toEqual([])
    expect(h.engine.peekLedger('root-1')!.delegations[0]?.state).toBe('starting')
  })

  it('a second restart appends to the marker instead of replacing it', async () => {
    const h = makeHarness()
    await seeded(h, [delegation('w-1', 'running')])
    await h.engine.onRootOpened(h.root)
    await h.engine.mutate('root-1', ledger => ({ ...ledger, delegations: [...ledger.delegations, delegation('w-2', 'running')] }))
    await h.engine.onRootOpened(h.root)
    expect(h.engine.peekLedger('root-1')!.hostRestart?.lostChildIds).toEqual(['w-1', 'w-2'])
  })

  it('only the opened root\'s ledger is touched', async () => {
    const h = makeHarness()
    await seeded(h, [delegation('w-gone', 'running')])
    await h.engine.mutate('root-2', ledger => ({ ...ledger, delegations: [delegation('w-other', 'running', { parentId: 'root-2' })] }))
    await h.engine.onRootOpened(h.root)
    expect(h.engine.peekLedger('root-2')!.delegations[0]?.state).toBe('running')
  })
})

describe('zero footprint and the legacy link', () => {
  it('a session with no ledger, no legacy run and no lost child gets NO ledger', async () => {
    const h = makeHarness()
    const outcome = await h.engine.onRootOpened(h.root)
    expect(outcome).toEqual({ lostChildIds: [], restoredRunIds: [] })
    expect(h.ledgers.load('root-1')).toBeUndefined()
    expect(h.ledgers.list()).toEqual([])
  })

  it('records the legacy run ids of the session on its ledger, and only that session\'s', async () => {
    const h = makeHarness({ rootId: 'syn-session-a', legacyFixtures: ['amend-plan.jsonl', 'independent-clamped-completed.jsonl', 'external-audit.jsonl'] })
    await h.engine.onRootOpened(h.root)
    expect([...h.engine.peekLedger('syn-session-a')!.legacyRunIds].sort()).toEqual(['syn-amend-plan', 'syn-session-a'])
  })

  it('a second open does not write the legacy link again', async () => {
    const h = makeHarness({ rootId: 'syn-owner-gate', legacyFixtures: ['owner-gate-pass-withdraw.jsonl'] })
    await h.engine.onRootOpened(h.root)
    const revision = h.engine.peekLedger('syn-owner-gate')!.revision
    await h.engine.onRootOpened(h.root)
    expect(h.engine.peekLedger('syn-owner-gate')!.revision).toBe(revision)
  })

  it('a legacy store that cannot be read is a warning, never a rejection of the open', async () => {
    const h = makeHarness({ ports: {} })
    const explodingSources = { get fileRoot(): string { throw new Error('sources exploded') } }
    const broken = new AutopilotEngine(h.agents, h.subagents, h.ledgers, explodingSources, resolveConfig(), {
      warn: message => h.warnings.push(message),
    })
    await expect(broken.onRootOpened(h.root)).resolves.toEqual({ lostChildIds: [], restoredRunIds: [] })
    expect(h.warnings.join('\n')).toMatch(/sources exploded/)
  })
})

describe('mutate: single writer with compare-and-swap', () => {
  it('serializes concurrent writes on one session: both land, in call order', async () => {
    const h = makeHarness()
    const add = (ref: string) => h.engine.mutate('root-1', ledger => ({ ...ledger, links: [...ledger.links, { kind: 'pr', ref, at: NOW }] }))
    await Promise.all([add('#1'), add('#2'), add('#3')])
    const ledger = h.engine.peekLedger('root-1')!
    expect(ledger.links.map(l => l.ref)).toEqual(['#1', '#2', '#3'])
    expect(ledger.revision).toBe(3)
  })

  it('returns undefined and writes nothing when the function declines', async () => {
    const h = makeHarness()
    expect(await h.engine.mutate('root-1', () => undefined)).toBeUndefined()
    expect(h.ledgers.load('root-1')).toBeUndefined()
  })

  it('a writer outside this process: reload, re-run the function, keep the other writer\'s change', async () => {
    const h = makeHarness()
    const other = FileLedgerStore.open(h.storeDir)
    await other.write({ ...emptyLedger('root-1', NOW), links: [{ kind: 'issue', ref: 'MY-195', at: NOW }] }, 0)
    let calls = 0

    const stored = await h.engine.mutate('root-1', (ledger) => {
      calls += 1
      return { ...ledger, links: [...ledger.links, { kind: 'pr', ref: '#9', at: NOW }] }
    })

    expect(calls).toBe(2)
    expect(stored?.links.map(l => l.ref)).toEqual(['MY-195', '#9'])
    expect(stored?.revision).toBe(2)
  })

  it('gives up with AP_LEDGER_BUSY after a bounded number of conflicts', async () => {
    const conflicting: LedgerStoreLike = {
      kind: 'file',
      load: () => undefined,
      list: () => [],
      diagnostics: [],
      write: () => Promise.reject(new AutopilotError('conflict', 'AP_LEDGER_CONFLICT')),
    }
    const engine = new AutopilotEngine(new FakeAgents(), stubSubagents(), conflicting, legacySourcesOf(undefined), resolveConfig())
    let calls = 0
    await expect(engine.mutate('s', ledger => { calls += 1; return ledger })).rejects.toMatchObject({ code: 'AP_LEDGER_BUSY' })
    expect(calls).toBe(5)
  })

  it('a non-conflict store failure is not retried', async () => {
    let writes = 0
    const failing: LedgerStoreLike = {
      kind: 'file', load: () => undefined, list: () => [], diagnostics: [],
      write: () => { writes += 1; return Promise.reject(new Error('disk full')) },
    }
    const engine = new AutopilotEngine(new FakeAgents(), stubSubagents(), failing, legacySourcesOf(undefined), resolveConfig())
    await expect(engine.mutate('s', ledger => ledger)).rejects.toThrow('disk full')
    expect(writes).toBe(1)
  })

  it('after dispose a write is refused with AP_DISPOSED and dispose waits for queued writes', async () => {
    const h = makeHarness()
    const pending = h.engine.mutate('root-1', ledger => ({ ...ledger, links: [{ kind: 'pr', ref: '#1', at: NOW }] }))
    await h.engine.dispose()
    await pending
    expect(h.engine.peekLedger('root-1')!.links).toHaveLength(1)
    await expect(h.engine.mutate('root-1', ledger => ledger)).rejects.toMatchObject({ code: 'AP_DISPOSED' })
  })
})

describe('ledgerFor', () => {
  it('hands back the stored ledger, or a fresh revision-0 one that is not written', () => {
    const h = makeHarness()
    const fresh = h.engine.ledgerFor('root-1')
    expect(fresh.revision).toBe(0)
    expect(fresh.delegations).toEqual([])
    expect(h.ledgers.load('root-1')).toBeUndefined()
  })
})
