/**
 * The card's v3 ledger half (`src/client/ledger.ts`), driven by the synthetic
 * fixtures under `test/client/fixtures/`. Pure functions only: no DOM, no network.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  LEDGER_BUSY_POLL_MS, LEDGER_QUIET_POLL_MS, RESTART_NOTE, autoContinueView, delegationRows, fetchLedger,
  goalView, hostRestartLine, ledgerPollDelayMs, ledgerRouteUrl, legacyRunLines, legacySummaryRows,
  goalDetailRows, linkRows, readLedgerBody, readLegacyRunBody, retiredNotice, reviewRows, routeText, truncateTitle, visibleNotes,
} from '../../src/client/ledger.js'
import { STRINGS, formatTime, langFromTag } from '../../src/client/i18n.js'
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
    expect(r[0]?.vendorText).toBe('different vendor')
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
    // The instant is printed as local time now (the recorded ISO 2026-11-04T09:50:00Z); UTC pins it.
    const line = hostRestartLine(p, 'en', 'UTC')
    expect(line).toContain('1 running child was lost')
    expect(line).toContain('not restarted automatically')
    expect(line).toContain('Nov 4, 2026, 09:50:00')
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

  it('states the vendor relation as a neutral fact and keeps the recorded note in details', () => {
    const r = reviewRows(p)[0]
    expect(r?.reduced).toBe(true)
    expect(r?.vendorText).toMatch(/^same as the reviewed work/)
    expect(r?.details.find(d => d.label === 'Routing note')?.value).toContain('503')
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

  it('warns about unavailable auto-continue for an unrecognised status too', () => {
    const a = autoContinueView(withStatus('blocked:round-limit'))
    expect(a.warning).toContain('Will not auto-continue')
    expect(autoContinueView(withStatus(undefined)).warning).toBeDefined()
    expect(autoContinueView(withStatus('complete')).warning).toBeUndefined()
  })

  it('blocked', () => {
    const g = goalView(withStatus('blocked'))
    expect(g.phase).toBe('blocked')
    expect(g.tone).toBe('error')
    // The ledger carries no blockedReason, and a round-limit block re-blocks on
    // resume until the cap is raised, so the card must not promise resume works.
    expect(g.next).toContain('block reason is not recorded')
    expect(g.next).not.toContain('you can resume it')
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
    expect(g.next).toBe(`auto-continue is not running: ${withStatus('active').autoContinue.reason}`)
    expect(g.next).not.toContain('resumes when you say')
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

describe('reviewRows independence label renders the recorded reason', () => {
  function withReview(patch: Record<string, unknown>): LedgerProjection {
    const body = raw('reduced')
    const reviews = body.ledger['reviews'] as Record<string, unknown>[]
    delete reviews[0]!['independenceNote']
    Object.assign(reviews[0]!, patch)
    const p = readLedgerBody(body)
    if (p === undefined) throw new Error('variant did not parse')
    return p
  }

  it('cross-family', () => {
    const r = reviewRows(withReview({ independence: 'cross-family', excludedFamilies: ['alpha'] }))[0]
    expect(r?.reduced).toBe(false)
    expect(r?.vendorText).toBe('different vendor')
  })

  it('reduced because same family: shows that note', () => {
    const note = 'the reviewer runs on provider family "alpha", which the reviewed work also used'
    const r = reviewRows(withReview({ independence: 'reduced', excludedFamilies: ['alpha'], reviewerRoute: { provider: 'alpha', model: 'm' }, independenceNote: note }))[0]
    expect(r?.reduced).toBe(true)
    expect(r?.vendorText).toBe('same as the reviewed work (alpha)')
    expect(r?.details.find(d => d.label === 'Routing note')?.value).toBe(note)
  })

  it('reduced because no observed family: never claims "same provider family"', () => {
    const note = 'the reviewed work has no observed provider family to exclude, so the vendor relation to it is not known'
    const r = reviewRows(withReview({ independence: 'reduced', excludedFamilies: [], independenceNote: note }))[0]
    expect(r?.vendorText).toBe('not determined')
    expect(r?.details.find(d => d.label === 'Routing note')?.value).toBe(note)
  })

  it('an older record with multiple children and an ambiguous provider list stays unknown', () => {
    const r = reviewRows(withReview({ reviewedChildIds: ['w-1', 'w-2'], independence: 'cross-family', excludedFamilies: ['alpha'], reviewerRoute: { provider: 'beta', model: 'm' } }))[0]
    expect(r?.vendorText).toBe('not determined')
  })
})


describe('i18n helpers', () => {
  it('langFromTag', () => {
    expect(langFromTag('zh-CN')).toBe('zh')
    expect(langFromTag('zh')).toBe('zh')
    expect(langFromTag('ZH-tw')).toBe('zh')
    expect(langFromTag('en-US')).toBe('en')
    expect(langFromTag('fr')).toBe('en')
    expect(langFromTag('')).toBeUndefined()
    expect(langFromTag(undefined)).toBeUndefined()
  })

  it('formatTime prints local time in the requested zone and returns junk verbatim', () => {
    const iso = '2026-11-04T16:29:37.586Z'
    expect(formatTime(iso, 'zh', 'Asia/Shanghai')).toBe('2026/11/05 00:29:37')
    expect(formatTime(iso, 'zh', 'UTC')).toBe('2026/11/04 16:29:37')
    expect(formatTime(iso, 'en', 'UTC')).toBe('Nov 4, 2026, 16:29:37')
    expect(formatTime(iso, 'en', 'Asia/Shanghai')).toBe('Nov 5, 2026, 00:29:37')
    expect(formatTime('not a time', 'zh', 'UTC')).toBe('not a time')
  })

  it('both languages define every key', () => {
    expect(Object.keys(STRINGS.zh).sort()).toEqual(Object.keys(STRINGS.en).sort())
  })
})

describe('goal text per phase, both languages', () => {
  function withStatus(status: string | undefined, auto?: { available: boolean; reason: string }): LedgerProjection {
    const body = raw('paused-no-driver')
    const goal = body.ledger.goal as Record<string, unknown>
    if (status === undefined) delete goal.status
    else goal.status = status
    if (auto !== undefined) body.ledger.autoContinue = auto
    return readLedgerBody(body) as LedgerProjection
  }
  const driver = { available: true, reason: 'goal round driver present' }

  it('zh status and next sentence', () => {
    expect(goalView(withStatus('active', driver), 'zh').statusText).toBe('进行中')
    expect(goalView(withStatus('paused'), 'zh').statusText).toBe('已暂停')
    expect(goalView(withStatus('blocked'), 'zh').statusText).toBe('受阻')
    expect(goalView(withStatus('complete'), 'zh').statusText).toBe('已完成')
    expect(goalView(withStatus(undefined), 'zh').statusText).toBe('未读到状态')
    expect(goalView(withStatus('complete'), 'zh').nextText).toBe('目标已完成，可以在本会话里开始新目标。')
    expect(goalView(withStatus('paused'), 'zh').nextText).toBe('已暂停，只有你能恢复（说“继续”）。')
    expect(goalView(withStatus('blocked'), 'zh').nextText).toContain('受阻')
    expect(goalView(withStatus('active', driver), 'zh').nextText).toContain('自动继续')
  })

  it('en status and next sentence', () => {
    expect(goalView(withStatus('paused'), 'en').statusText).toBe('paused')
    expect(goalView(withStatus('complete'), 'en').nextText).toBe('Goal complete. You can start a new goal in this session.')
    expect(goalView(withStatus('paused'), 'en').nextText).toContain('Only you can resume')
  })

  it('an unrecognised status is verbatim in both languages', () => {
    for (const lang of ['zh', 'en'] as const) {
      expect(goalView(withStatus('blocked:round-limit'), lang).statusText).toBe('blocked:round-limit')
      expect(goalView(withStatus('blocked:round-limit'), lang).nextText).toBeUndefined()
    }
  })

  it('an active goal without a driver leaves the sentence to the auto-continue warning', () => {
    expect(goalView(withStatus('active', { available: false, reason: 'x' }), 'zh').nextText).toBeUndefined()
  })

  it('the details hold id, revision, first seen, last read (local) and the auto-continue line', () => {
    const rows = goalDetailRows(load('active-parallel'), 'zh', 'UTC')
    const by = (label: string) => rows.find(r => r.label === label)?.value
    expect(by('目标 ID')).toBe(load('active-parallel').goal?.goalId)
    expect(by('修订号')).toBeDefined()
    expect(by('首次看到')).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(by('最近读取')).toMatch(/^\d{4}\/\d{2}\/\d{2} /)
    expect(by('自动继续')).toBe('可用：goal round driver present')
    expect(goalDetailRows(load('active-parallel'), 'en', 'UTC').find(r => r.label === 'Auto-continue')?.value)
      .toBe('available: goal round driver present')
  })

  it('previous goals and non-default depth go to the details', () => {
    const body = raw('reduced')
    body.ledger.depth = { executorLead: 3, source: 'user-setting', note: 'raised' }
    const rows = goalDetailRows(readLedgerBody(body) as LedgerProjection, 'zh')
    expect(rows.find(r => r.label === '执行负责人层级深度')?.value).toBe('3 (user-setting) · raised')
    expect(rows.find(r => r.label === '以往目标')?.value).toContain('goal-synth-prev')
  })
})

describe('auto-continue warning only when it matters', () => {
  it('active and unavailable: warns, in both languages with the recorded reason', () => {
    const body = raw('paused-no-driver')
    ;(body.ledger.goal as Record<string, unknown>).status = 'active'
    const p = readLedgerBody(body) as LedgerProjection
    expect(autoContinueView(p, 'zh').warning).toBe(`不会自动继续：${p.autoContinue.reason}`)
    expect(autoContinueView(p, 'en').warning).toBe(`Will not auto-continue: ${p.autoContinue.reason}`)
  })

  it('paused and unavailable: warns', () => {
    expect(autoContinueView(load('paused-no-driver'), 'zh').warning).toContain('不会自动继续：')
  })

  it('complete goal, or available driver: no warning', () => {
    const body = raw('paused-no-driver')
    ;(body.ledger.goal as Record<string, unknown>).status = 'complete'
    expect(autoContinueView(readLedgerBody(body) as LedgerProjection, 'zh').warning).toBeUndefined()
    expect(autoContinueView(load('active-parallel'), 'zh').warning).toBeUndefined()
    expect(autoContinueView(load('active-parallel'), 'zh').restartNote).toBe(STRINGS.zh.restartNote)
  })

  it('the host restart line is localized and keeps the lost count', () => {
    const line = hostRestartLine(load('restart-lost'), 'zh', 'Asia/Shanghai')
    expect(line).toBe('宿主在 2026/11/04 17:50:00 重启：1 个运行中的子任务丢失（不会自动重启）')
  })
})

describe('delegation rows in plain words', () => {
  const rows = (lang: 'zh' | 'en') => delegationRows(load('mismatch'), lang)

  it('warns only for the mismatch row', () => {
    const [m, pending] = rows('en')
    expect(m?.warning).toContain('mismatch')
    expect(m?.warning).toContain('effort high')
    expect(m?.warning).toContain('effort medium')
    expect(pending?.warning).toBeUndefined()
    for (const r of delegationRows(load('active-parallel'), 'en')) {
      expect(r.warning).toBeUndefined()
      expect(r.ok).toBe(r.match === 'match')
    }
  })

  it('zh mismatch sentence and pending text', () => {
    const [m, pending] = rows('zh')
    expect(m?.warning).toMatch(/^实际模型与选定的不一致：选定 .+，实际 .+$/)
    expect(m?.warning).toContain('推理强度 高')
    expect(m?.warning).toContain('推理强度 中')
    expect(pending?.modelUsed).toContain('尚未观测到')
    expect(pending?.warning).toBeUndefined()
  })

  it('observed route is the model used when seen', () => {
    const w = delegationRows(load('active-parallel'), 'en')[1]
    expect(w?.modelUsed).toBe(w?.observed)
    expect(w?.ok).toBe(true)
  })

  it('role and state words, zh and en', () => {
    const zh = delegationRows(load('restart-lost'), 'zh')[0]
    expect(zh?.stateText).toBe('已丢失')
    expect(zh?.stateNote).toBe('宿主重启后丢失，不会自动重启')
    const roles = delegationRows(load('active-parallel'), 'zh').map(r => r.roleText)
    expect(roles).toContain('调研')
    expect(roles).toContain('执行负责人')
    expect(delegationRows(load('active-parallel'), 'en').map(r => r.roleText)).toContain('Executor lead')
  })

  it('details carry ids, generation, replaces, routes, sources and the match text', () => {
    const m = rows('zh')[0]!
    const values = Object.fromEntries(m.details.map(d => [d.label, d.value]))
    expect(values['子任务 ID']).toBe(m.childId)
    expect(values['代数']).toBe('2')
    expect(values['接替']).toBeDefined()
    expect(values['模型来源']).toBe('角色固定')
    expect(values['推理强度来源']).toBe('调用参数')
    expect(values['核对结果']).toContain('不一致')
  })

  it('long titles are cut for the line and kept whole in the details', () => {
    expect(truncateTitle('a'.repeat(61))).toBe(`${'a'.repeat(60)}…`)
    expect(truncateTitle('short')).toBe('short')
    const body = raw('active-parallel')
    ;(body.ledger.delegations as Record<string, unknown>[])[0]!.title = 'x'.repeat(100)
    const r = delegationRows(readLedgerBody(body) as LedgerProjection, 'en')[0]!
    expect(r.title).toHaveLength(100)
    expect(r.taskText).toBe(`${'x'.repeat(60)}…`)
    expect(r.details.find(d => d.label === 'Task')?.value).toHaveLength(100)
  })
})

describe('review rows in plain words', () => {
  function withReview(patch: Record<string, unknown>, findings?: unknown[]): LedgerProjection {
    const body = raw('reduced')
    const reviews = body.ledger['reviews'] as Record<string, unknown>[]
    Object.assign(reviews[0]!, patch)
    if (findings !== undefined) reviews[0]!['findings'] = findings
    return readLedgerBody(body) as LedgerProjection
  }
  const minor = (n: number) => Array.from({ length: n }, (_, i) => ({ severity: 'minor', summary: `m${i}` }))

  it('verdict plus counts', () => {
    const p = withReview({ verdict: 'pass', independence: 'cross-family' }, minor(4))
    const zh = reviewRows(p, 'zh')[0]!
    expect(zh.verdictText).toBe('审阅通过')
    expect(zh.findings).toBe('次要 4')
    const en = reviewRows(p, 'en')[0]!
    expect(en.verdictText).toBe('Review passed')
    expect(en.findings).toBe('4 minor')
    expect(reviewRows(withReview({ verdict: 'needs-fix' }, []), 'zh')[0]?.verdictText).toBe('需要修改')
    expect(reviewRows(withReview({ verdict: 'blocked' }, [{ severity: 'blocker', summary: 'b' }, { severity: 'major', summary: 'c' }]), 'zh')[0]?.findings)
      .toBe('阻断 1 · 主要 1')
  })

  it('vendor relation is a neutral detail row, never a body warning or the word reduced', () => {
    const diff = withReview({ independence: 'cross-family', excludedFamilies: ['alpha'] })
    expect(reviewRows(diff, 'zh')[0]?.vendorText).toBe('不同厂商')
    const same = withReview({ independence: 'reduced', excludedFamilies: ['alpha'], reviewerRoute: { provider: 'alpha', model: 'm' }, independenceNote: 'no reviewer route outside provider families [alpha]' })
    expect(reviewRows(same, 'zh')[0]?.vendorText).toBe('与被审工作相同（alpha）')
    expect(reviewRows(same, 'en')[0]?.vendorText).toBe('same as the reviewed work (alpha)')
    const other = withReview({ independence: 'reduced', excludedFamilies: ['alpha'], reviewerRoute: { provider: 'alpha', model: 'm' }, independenceNote: 'HTTP 503 from the pool' })
    const d = reviewRows(other, 'zh')[0]!.details
    expect(d.find(x => x.label === '审阅模型厂商')?.value).toBe('与被审工作相同（alpha）')
    expect(d.find(x => x.label === '路由记录')?.value).toBe('HTTP 503 from the pool')
    const labels = (lang: 'zh' | 'en') => JSON.stringify(reviewRows(other, lang).map(x => [x.vendorText, x.details]))
    expect(labels('zh')).not.toContain('降低')
    expect(labels('en')).not.toMatch(/[Rr]educed/)
    expect(reviewRows(withReview({ independence: 'reduced', excludedFamilies: [] }), 'en')[0]?.vendorText).toBe('not determined')
  })

  it('details hold the reviewer, local time and excluded providers', () => {
    const p = withReview({ independence: 'reduced', excludedFamilies: ['alpha', 'beta'] })
    const d = Object.fromEntries(reviewRows(p, 'zh', 'UTC')[0]!.details.map(x => [x.label, x.value]))
    expect(d['排除的厂商']).toBe('alpha, beta')
    expect(d['审阅时间']).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(d['审阅者 ID']).toBeDefined()
  })
})

describe('links', () => {
  it('only the issue label is localized', () => {
    const p = load('active-parallel')
    expect(linkRows(p, 'zh').map(l => l.label)).toEqual(['Issue MY-195', 'PR #12', 'PR #13'])
    expect(linkRows(p, 'en')[0]?.label).toBe('issue MY-195')
  })
})

describe('retired settings notice', () => {
  const NOTE = 'dsh-autopilot 0.3.0 ignores retired settings: governance.unattended, storeKind; they no longer have an effect and can be deleted from your config.'
  function withKeys(keys: string[] | undefined): LedgerProjection {
    const body = raw('active-parallel')
    body.ledger.notes = [NOTE, 'another note']
    if (keys !== undefined) body.ledger.retiredConfigKeys = keys
    return readLedgerBody(body) as LedgerProjection
  }

  it('words the notice in both languages and hides the matching English note', () => {
    const p = withKeys(['governance.unattended', 'storeKind'])
    expect(retiredNotice(p, 'zh')).toBe('配置里有已废弃的设置：governance.unattended、storeKind，可以删除，不影响运行。')
    expect(retiredNotice(p, 'en')).toBe('Your config has retired settings: governance.unattended, storeKind. You can delete them; they have no effect.')
    expect(visibleNotes(p)).toEqual(['another note'])
  })

  it('an older host without the keys keeps its English note and shows no structured notice', () => {
    const p = withKeys(undefined)
    expect(p.retiredConfigKeys).toBeUndefined()
    expect(retiredNotice(p, 'zh')).toBeUndefined()
    expect(visibleNotes(p)).toEqual([NOTE, 'another note'])
    expect(goalDetailRows(p, 'en').filter(r => r.value === NOTE)).toHaveLength(1)
  })

  it('an empty key list is no notice', () => {
    expect(retiredNotice(withKeys([]), 'en')).toBeUndefined()
  })
})

describe('zh plain wording: auto-continue code and effort values', () => {
  function withAuto(auto: Record<string, unknown>): LedgerProjection {
    const body = raw('paused-no-driver')
    ;(body.ledger.goal as Record<string, unknown>).status = 'active'
    body.ledger.autoContinue = auto
    return readLedgerBody(body) as LedgerProjection
  }
  const plain: Record<string, string> = {
    'driver-present': '会自动继续',
    'no-driver-in-composition': '当前宿主没有目标轮次驱动',
    'released-after-restart': '宿主重启后已释放',
    'not-yet-observed': '还没检测到目标轮次驱动',
    unknown: '无法检查宿主是否支持自动继续',
  }

  it('each known code is plain text in the zh warning; details keep the verbatim reason', () => {
    for (const [code, text] of Object.entries(plain)) {
      const p = withAuto({ available: false, code, reason: 'raw english reason' })
      expect(autoContinueView(p, 'zh').warning).toBe(`不会自动继续：${text}`)
      const row = goalDetailRows(p, 'zh', 'UTC').find(r => r.label === '自动继续')?.value
      expect(row).toBe(`不可用：${text}（raw english reason）`)
    }
  })

  it('no code or an unknown code falls back to the verbatim reason', () => {
    for (const auto of [{ available: false, reason: 'raw english reason' }, { available: false, code: 'brand-new', reason: 'raw english reason' }]) {
      const p = withAuto(auto)
      expect(autoContinueView(p, 'zh').warning).toBe('不会自动继续：raw english reason')
      expect(goalDetailRows(p, 'zh', 'UTC').find(r => r.label === '自动继续')?.value).toBe('不可用：raw english reason')
    }
  })

  it('English keeps the verbatim reason whatever the code', () => {
    const p = withAuto({ available: false, code: 'no-driver-in-composition', reason: 'raw english reason' })
    expect(autoContinueView(p, 'en').warning).toBe('Will not auto-continue: raw english reason')
    expect(goalDetailRows(p, 'en', 'UTC').find(r => r.label === 'Auto-continue')?.value).toBe('unavailable: raw english reason')
  })

  it('zh effort values are plain words in the body, with the raw id kept in details', () => {
    const [m] = delegationRows(load('mismatch'), 'zh')
    expect(m?.modelUsed).toContain('推理强度 中')
    expect(m?.warning).toContain('推理强度 高')
    expect(m?.warning).toContain('推理强度 中')
    expect(m?.warning).not.toMatch(/\b(high|medium)\b/)
    const values = Object.fromEntries((m?.details ?? []).map(d => [d.label, d.value]))
    expect(values['选定的模型']).toContain('推理强度 高（high）')
    expect(values['观测到的模型']).toContain('推理强度 中（medium）')
    const [en] = delegationRows(load('mismatch'), 'en')
    expect(en?.warning).toContain('effort high')
    expect(Object.fromEntries((en?.details ?? []).map(d => [d.label, d.value]))['Selected route']).toContain('effort high')
  })

  it('every known effort maps, an unknown one stays verbatim', () => {
    const e = STRINGS.zh.effortValue
    expect(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'turbo'].map(e)).toEqual(['最低', '低', '中', '高', '很高', '最高', 'turbo'])
    expect(STRINGS.zh.effortValueDetail('turbo')).toBe('turbo')
    expect(STRINGS.en.effortValue('xhigh')).toBe('xhigh')
  })

  it('zh labels use the full-width colon', () => {
    expect(STRINGS.zh.colon).toBe('：')
    expect(STRINGS.zh.autoWarn('x')).toContain('：')
  })
})
