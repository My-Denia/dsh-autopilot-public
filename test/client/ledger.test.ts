/**
 * The card's v3 ledger half (`src/client/ledger.ts`), driven by the synthetic
 * fixtures under `test/client/fixtures/`. Pure functions only: no DOM, no network.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  LEDGER_BUSY_POLL_MS, LEDGER_QUIET_POLL_MS, RESTART_NOTE, autoContinueView, delegationRows, fetchLedger,
  goalView, hostRestartLine, ledgerPollDelayMs, ledgerRouteUrl, legacyRunLines, legacySummaryRows,
  linkRows, readLedgerBody, readLegacyRunBody, reviewRows, routeText,
} from '../../src/client/ledger.js'
import type { LedgerProjection } from '../../src/domain/ledger-types.js'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown
}
function load(name: string): LedgerProjection {
  const p = readLedgerBody(fixture(name))
  if (p === undefined) throw new Error(`fixture ${name} did not parse`)
  return p
}
/** Deep-cloned raw ledger body from a fixture, for building variants. */
function raw(name: string): { ok: boolean; ledger: Record<string, unknown> } {
  return structuredClone(fixture(name)) as { ok: boolean; ledger: Record<string, unknown> }
}
const FIXTURES = ['active-parallel', 'restart-lost', 'mismatch', 'reduced', 'paused-no-driver', 'legacy-ledger']

describe('readLedgerBody', () => {
  it.each(FIXTURES)('parses %s', (name) => {
    const p = readLedgerBody(fixture(name))
    expect(p).toBeDefined()
    expect(p?.v).toBe(3)
    expect(p?.sessionId).toBe('session-synthetic-0001')
    expect(p?.revision).toBe(7)
  })

  it('rejects an error body, a wrong version, and non-objects', () => {
    expect(readLedgerBody({ ok: false, error: 'no-ledger' })).toBeUndefined()
    const v2 = raw('active-parallel')
    v2.ledger.v = 2
    expect(readLedgerBody(v2)).toBeUndefined()
    for (const bad of [null, undefined, 'x', 42, [], true]) expect(readLedgerBody(bad)).toBeUndefined()
  })

  it('keeps only the valid delegation row when one lacks childId', () => {
    const body = raw('active-parallel')
    const rows = body.ledger.delegations as Record<string, unknown>[]
    const bad = structuredClone(rows[0]) as Record<string, unknown>
    delete bad.childId
    body.ledger.delegations = [bad, rows[1]]
    const p = readLedgerBody(body)
    expect(p?.delegations.map(d => d.childId)).toEqual(['worker-bbbbbbbb-2222'])
  })

  it('drops rows with an unknown role or state', () => {
    const body = raw('active-parallel')
    const rows = body.ledger.delegations as Record<string, unknown>[]
    body.ledger.delegations = [
      { ...rows[0], role: 'wizard' },
      { ...rows[1], state: 'exploded' },
      rows[2],
    ]
    expect(readLedgerBody(body)?.delegations.map(d => d.childId)).toEqual(['scout-cccccccc-3333'])
  })

  it('preserves previousGoals', () => {
    const p = load('reduced')
    expect(p.previousGoals).toHaveLength(1)
    expect(p.previousGoals[0]).toMatchObject({ goalId: 'goal-synth-prev', status: 'complete', objective: 'Earlier goal A' })
  })
})

describe('active-parallel', () => {
  const p = load('active-parallel')

  it('goal is active with automatic continuation', () => {
    const g = goalView(p)
    expect(g.phase).toBe('active')
    expect(g.label).toBe('active')
    expect(g.tone).toBe('success')
    expect(g.next).toContain('continue automatically')
    expect(g.objective).toBe('Ship the synthetic card fixture goal')
  })

  it('auto-continue is available and carries the restart note', () => {
    const a = autoContinueView(p)
    expect(a.available).toBe(true)
    expect(a.text).toBe('auto-continue available: goal round driver present')
    expect(a.tone).toBe('success')
    expect(a.restartNote).toBe(RESTART_NOTE)
  })

  it('orders delegations as a tree with the worker right after its lead', () => {
    const rows = delegationRows(p)
    expect(rows.map(r => r.childId)).toEqual([
      'lead-aaaaaaaa-1111', 'worker-bbbbbbbb-2222', 'scout-cccccccc-3333', 'scout-dddddddd-4444', 'reviewer-eeeeeeee-5555',
    ])
    expect(rows.map(r => r.indent)).toEqual([0, 1, 0, 0, 0])
    const scouts = rows.filter(r => r.role === 'scout')
    expect(scouts).toHaveLength(2)
    expect(scouts.every(r => r.state === 'running')).toBe(true)
  })

  it('states the source of the pinned worker', () => {
    const w = delegationRows(p)[1]
    expect(w?.source).toBe('model from role pin · effort from role pin')
    expect(w?.selected).toBe('kimi/kimi-k2 · effort high')
    expect(w?.matchText).toBe('observed matches selected')
    expect(w?.matchTone).toBe('success')
  })

  it('renders one cross-family review with the excluded family', () => {
    const r = reviewRows(p)
    expect(r).toHaveLength(1)
    expect(r[0]?.reduced).toBe(false)
    expect(r[0]?.independence).toBe('cross-family review (excluded: deepseek)')
    expect(r[0]?.verdict).toBe('pass')
    expect(r[0]?.verdictTone).toBe('success')
    expect(r[0]?.findings).toBe('1 minor')
  })

  it('only links http(s) urls', () => {
    const l = linkRows(p)
    expect(l).toHaveLength(3)
    expect(l[0]?.label).toBe('issue MY-195')
    expect(l[0]).not.toHaveProperty('href')
    expect(l[1]?.label).toBe('PR #12')
    expect(l[1]?.href).toBe('https://github.com/example/repo/pull/12')
    expect(l[2]?.label).toBe('PR #13')
    expect(l[2]).not.toHaveProperty('href')
  })
})

describe('restart-lost', () => {
  const p = load('restart-lost')

  it('says auto-continue is unavailable with the reason', () => {
    const a = autoContinueView(p)
    expect(a.available).toBe(false)
    expect(a.text).toBe('auto-continue unavailable: released after host restart')
    expect(a.tone).toBe('warn')
  })

  it('records the restart as history', () => {
    const line = hostRestartLine(p)
    expect(line).toContain('1 running child was lost')
    expect(line).toContain('not restarted automatically')
    expect(line).toContain('2026-11-04T09:50:00Z')
  })

  it('marks the lost child as an error with its diagnostic', () => {
    const row = delegationRows(p)[0]
    expect(row?.state).toBe('lost')
    expect(row?.stateTone).toBe('error')
    expect(row?.stateNote).toBe('lost after host restart, not restarted automatically')
    expect(row?.diagnostic).toBe('host restarted while running')
  })

  it('pluralises several lost children', () => {
    const body = raw('restart-lost')
    body.ledger.hostRestart = { at: 'T', lostChildIds: ['a', 'b'] }
    expect(hostRestartLine(readLedgerBody(body) as LedgerProjection)).toContain('2 running children were lost')
  })

  it('a hostRestart marker with auto-continue available is history only', () => {
    const body = raw('restart-lost')
    body.ledger.autoContinue = { available: true, reason: 'goal round driver present' }
    const resumed = readLedgerBody(body) as LedgerProjection
    expect(resumed.hostRestart).toBeDefined()
    const a = autoContinueView(resumed)
    expect(a.available).toBe(true)
    expect(a.text).not.toContain('unavailable')
    expect(a.text).toBe('auto-continue available: goal round driver present')
    expect(goalView(resumed).next).toContain('continue automatically')
  })

  it('has no restart line when the marker is absent', () => {
    expect(hostRestartLine(load('active-parallel'))).toBeUndefined()
  })
})

describe('mismatch', () => {
  const rows = delegationRows(load('mismatch'))

  it('flags the effort mismatch', () => {
    const m = rows[0]
    expect(m?.match).toBe('mismatch')
    expect(m?.matchTone).toBe('error')
    expect(m?.matchText).toContain('MISMATCH')
    expect(m?.selected).toContain('effort high')
    expect(m?.observed).toContain('effort medium')
    expect(m?.source).toBe('model from role pin · effort from call argument')
    expect(m?.generation).toBe(2)
    expect(m?.replaces).toBe('worker-8…')
  })

  it('shows a pending child as not observed yet', () => {
    const s = rows[1]
    expect(s?.match).toBe('pending')
    expect(s?.matchTone).toBe('neutral')
    expect(s?.observed).toBe('not observed yet')
    expect(s?.matchText).toContain('not observed yet')
    expect(s?.source).toBe('model from routing ladder · effort from host default')
  })

  it('routeText never prints undefined', () => {
    const route = { provider: 'p', model: 'm' }
    expect(routeText(route, 'selected')).toBe('p/m · no effort sent')
    expect(routeText(route, 'observed')).toBe('p/m · no effort observed')
    expect(routeText(undefined, 'selected')).toBe('nothing sent (host default)')
    expect(routeText(undefined, 'observed')).toBe('not observed yet')
    for (const r of delegationRows(load('mismatch'))) {
      expect(JSON.stringify(r)).not.toContain('undefined')
    }
  })
})

describe('reduced', () => {
  const p = load('reduced')

  it('flags reduced independence with the note', () => {
    const r = reviewRows(p)[0]
    expect(r?.reduced).toBe(true)
    expect(r?.independence).toContain('REDUCED INDEPENDENCE')
    expect(r?.independence).toContain('503')
    expect(r?.verdict).toBe('needs-fix')
    expect(r?.verdictTone).toBe('warn')
    expect(r?.findings).toBe('1 major')
    expect(r?.subject).toBe('commit 58b0ffa')
  })

  it('goal is complete', () => {
    const g = goalView(p)
    expect(g.phase).toBe('complete')
    expect(g.tone).toBe('success')
    expect(autoContinueView(p).restartNote).toBeUndefined()
  })
})

describe('goal phases', () => {
  const p = load('paused-no-driver')

  it('paused with no driver: only the owner resumes', () => {
    const g = goalView(p)
    expect(g.phase).toBe('paused')
    expect(g.tone).toBe('warn')
    expect(g.next).toContain('only you can resume')
    const a = autoContinueView(p)
    expect(a.available).toBe(false)
    expect(a.text).toBe('auto-continue unavailable: no goal round driver in this composition')
    expect(a.restartNote).toBeUndefined()
  })

  function withStatus(status: string | undefined): LedgerProjection {
    const body = raw('paused-no-driver')
    const goal = body.ledger.goal as Record<string, unknown>
    if (status === undefined) delete goal.status
    else goal.status = status
    return readLedgerBody(body) as LedgerProjection
  }

  it('blocked', () => {
    const g = goalView(withStatus('blocked'))
    expect(g.phase).toBe('blocked')
    expect(g.tone).toBe('error')
    expect(g.next).toContain('you can resume it')
  })

  it('unrecognised status is shown verbatim', () => {
    const g = goalView(withStatus('blocked:round-limit'))
    expect(g.phase).toBe('unrecognised')
    expect(g.label).toBe('blocked:round-limit')
    expect(g.tone).toBe('neutral')
  })

  it('missing status', () => {
    const g = goalView(withStatus(undefined))
    expect(g.phase).toBe('unrecognised')
    expect(g.label).toBe('status not read')
  })

  it('no goal', () => {
    const body = raw('paused-no-driver')
    delete body.ledger.goal
    const g = goalView(readLedgerBody(body) as LedgerProjection)
    expect(g.phase).toBe('no-goal')
    expect(g.label).toBe('no goal recorded')
  })

  it('active without a driver says it resumes on "continue"', () => {
    const g = goalView(withStatus('active'))
    expect(g.phase).toBe('active')
    expect(g.next).toContain('auto-continue is not running')
    expect(autoContinueView(withStatus('active')).restartNote).toBe(RESTART_NOTE)
  })
})

describe('legacy', () => {
  it('summarises legacy runs', () => {
    const rows = legacySummaryRows(load('legacy-ledger').legacyRuns)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.rejected).toBe(false)
    expect(rows[0]?.text).toContain('phase executing')
    expect(rows[0]?.text).toContain('38 events')
    expect(rows[0]?.sandbox).toBe('sandbox restored to workspace-write')
    expect(rows[1]?.rejected).toBe(true)
    expect(rows[1]?.text).toContain('could not be read: unknown event type')
    expect(rows[1]?.text).toContain('5 events')
    expect(rows[1]?.sandbox).toBe('sandbox restore pending (session not opened since upgrade)')
  })

  it('renders one archived run as label/text lines', () => {
    const run = readLegacyRunBody(fixture('legacy-run'))
    expect(run).toBeDefined()
    const lines = legacyRunLines(run as NonNullable<typeof run>)
    const by = (label: string) => lines.find(l => l.label === label)
    expect(by('plan amendments')?.text).toBe('2 amendments')
    expect(by('owner decisions')?.text).toContain('owner passed the plan gate after amendment')
    expect(by('final phase')?.text).toBe('executing')
    expect(by('closeout')?.text).toBe('not submitted')
    expect(by('plan gate')?.text).toBe('pass')
    expect(by('verdicts')?.text).toBe('plan-auditor pass')
    expect(by('executor')?.text).toBe('running · gen 2')
  })

  it('rejects a legacy error body', () => {
    expect(readLegacyRunBody({ ok: false })).toBeUndefined()
  })
})

describe('polling and url', () => {
  it('is busy for an active goal or a running child', () => {
    expect(ledgerPollDelayMs(load('active-parallel'))).toBe(LEDGER_BUSY_POLL_MS)
    expect(ledgerPollDelayMs(load('restart-lost'))).toBe(LEDGER_BUSY_POLL_MS) // active goal, no live child
    const body = raw('reduced')
    body.ledger.delegations = (raw('active-parallel').ledger.delegations as unknown[]).slice(0, 1)
    expect(ledgerPollDelayMs(readLedgerBody(body))).toBe(LEDGER_BUSY_POLL_MS) // complete goal, running child
  })

  it('is quiet when nothing runs, and when there is no ledger', () => {
    expect(ledgerPollDelayMs(load('reduced'))).toBe(LEDGER_QUIET_POLL_MS)
    expect(ledgerPollDelayMs(load('paused-no-driver'))).toBe(LEDGER_QUIET_POLL_MS)
    expect(ledgerPollDelayMs(undefined)).toBe(LEDGER_QUIET_POLL_MS)
  })

  it('encodes the session id', () => {
    expect(ledgerRouteUrl('a&b#c')).toBe('/api/autopilot/ledger?session=a%26b%23c')
  })
})

describe('fetchLedger', () => {
  it('projects an ok body and asks the encoded url', async () => {
    const urls: string[] = []
    const p = await fetchLedger('session-synthetic-0001', async (url) => {
      urls.push(url)
      return { ok: true, json: async () => fixture('mismatch') }
    })
    expect(urls).toEqual(['/api/autopilot/ledger?session=session-synthetic-0001'])
    expect(p?.delegations).toHaveLength(2)
  })

  it('gives undefined for a non-ok response', async () => {
    expect(await fetchLedger('s', async () => ({ ok: false, json: async () => fixture('mismatch') }))).toBeUndefined()
  })

  it('gives undefined for an ok:false body', async () => {
    expect(await fetchLedger('s', async () => ({ ok: true, json: async () => ({ ok: false, error: 'no-ledger' }) }))).toBeUndefined()
  })

  it('gives undefined when json() throws or fetch rejects', async () => {
    expect(await fetchLedger('s', async () => ({ ok: true, json: async () => { throw new Error('bad json') } }))).toBeUndefined()
    expect(await fetchLedger('s', async () => { throw new Error('offline') })).toBeUndefined()
  })
})
