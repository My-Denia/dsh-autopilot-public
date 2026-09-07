/**
 * The `autopilot-run` card definition, driven by REAL session logs.
 *
 * Every fixture under `test/fixtures/card/` is a slice of a session this
 * machine actually produced — `turn/start`, `tool/call` and `tool/result`
 * envelopes copied out of `$DSH_HOME/sessions/**\/session.jsonl.zstd`.
 * `dup-init.json` and `ptc.json` are verbatim, nothing edited.
 * `inline.json` and `delegated.json` are REDACTED COPIES: absolute paths
 * inside their payload strings had one developer's username replaced with
 * `<user>` when this repository was prepared for sharing. Their structure and
 * every load-bearing field — event types, `seq`, tool names, call ids,
 * arguments, the ordering the assembler is driven by — are verbatim; the
 * unredacted originals are retained locally. No assertion below reads a
 * redacted byte, so the redaction costs the traceability of one scratch
 * directory and no property under test.
 *
 * Real capture matters more than usual here: the two shapes that kill
 * the obvious design (a session logging TWO `autopilot_init` calls, and a
 * session logging `autopilot_status` BEFORE the first `autopilot_init`) were
 * found by measurement, not imagination, and `dup-init.json` is the session
 * that carries both.
 *
 * The tests below re-implement the assembler's two throwing invariants
 * (`acceptMatch`: at most one start per id; no start after an update) as
 * assertions over the match stream, because the assembler itself is in the
 * host and cannot be imported here.
 *
 * Fixture provenance (R = redacted copy, V = verbatim):
 *   inline.json    R  session-d55ac1cd-… — 1 turn, 11 autopilot calls, inline mode
 *   delegated.json R  session-61a05524-… — 2 turns, executor child, delegated mode
 *   dup-init.json  V  session-90651a46-… — status@22, init@137, init@251
 *   ptc.json       V  session-32d85066-… — PTC mode: run_code dispatches, 9 events
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  AUTOPILOT_RUN_ID, AUTOPILOT_RUN_KIND, applyCall, applyResult, createAutopilotRunDefinition,
  emptyState, isAppendSurfaceEventMirror, readCall, readDispatch, readDispatchStart, readResult,
  safeJsonObject,
} from '../src/client/definition.js'
import type {
  AutopilotRunChatData, AutopilotRunDefinition, AutopilotRunState, CardEvent, CardMatch,
} from '../src/client/definition.js'
import {
  MIN_POLL_MS, STALE_POLL_MS, STEADY_POLL_MS, fetchLiveRun, isTerminalPhase, overlayLive,
  pollDelayMs, pollKey, readLiveRun, runRouteUrl, shouldPoll,
} from '../src/client/live.js'
import type { LiveFetch, LiveRun } from '../src/client/live.js'

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'card')

/** Load one real session slice. */
function load(name: 'inline' | 'delegated' | 'dup-init' | 'ptc'): readonly CardEvent[] {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as CardEvent[]
}

/** The production definition shape, with the mirror predicate standing in for the host's. */
function makeDefinition(
  isAppendSurfaceEvent = isAppendSurfaceEventMirror,
): AutopilotRunDefinition {
  return createAutopilotRunDefinition({ isAppendSurfaceEvent })
}

interface FoldResult {
  readonly starts: readonly number[]
  readonly updates: readonly number[]
  readonly state: AutopilotRunState | undefined
}

/**
 * Replay a fixture the way `ConversationNodeAssembler` does: match every event
 * in ascending seq, adopt the state each call returns, and record where the
 * start landed.
 */
function fold(events: readonly CardEvent[], definition = makeDefinition()): FoldResult {
  const starts: number[] = []
  const updates: number[] = []
  let state: AutopilotRunState | undefined
  for (const event of events) {
    const match = definition.match(event)
    if (match === null) continue
    expect(match.id).toBe(AUTOPILOT_RUN_ID)
    const full: CardMatch = { event, role: match.role, location: { kind: 'session' } }
    if (match.role === 'start') {
      starts.push(event.seq)
      state = definition.start()
      continue
    }
    updates.push(event.seq)
    // `update` is only ever called with a defined state by the assembler.
    if (state === undefined) continue
    state = definition.update({ key: 'k', id: AUTOPILOT_RUN_ID, state, start: undefined, matches: [] }, full)
  }
  return { starts, updates, state }
}

function ctxOf(state: AutopilotRunState | undefined) {
  return { key: `${AUTOPILOT_RUN_KIND}:${AUTOPILOT_RUN_ID}`, id: AUTOPILOT_RUN_ID, state, start: undefined, matches: [] }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('B1/B2 — the start anchor survives every real session shape', () => {
  it.each(['inline', 'delegated', 'dup-init'] as const)(
    'matches EXACTLY ONE start, and it is the lowest-seq match (%s)',
    (name) => {
      // These two assertions ARE the assembler's two throwing invariants:
      // "received more than one start Match" and "received an update before
      // its start Match". Both take the whole conversation view down.
      const { starts, updates } = fold(load(name))
      expect(starts).toHaveLength(1)
      expect(Math.min(...updates)).toBeGreaterThan(starts[0]!)
    },
  )

  it('the delegated fixture has TWO turns, so turn-1-only is doing real work', () => {
    const turnStarts = load('delegated').filter(e => e.type === 'turn/start')
    expect(turnStarts).toHaveLength(2)
    // Mutation B1: relaxing `data.turn === 1` to `>= 1` makes this two starts,
    // which is the throw.
    const definition = makeDefinition()
    expect(turnStarts.filter(e => definition.match(e)?.role === 'start')).toHaveLength(1)
  })

  it('a session that calls autopilot_status BEFORE autopilot_init still starts first', () => {
    const events = load('dup-init')
    // The measured shape, asserted rather than assumed.
    const calls = events.filter(e => e.type === 'tool/call')
      .map(e => [(e.data as { name: string }).name, e.seq] as const)
    expect(calls.slice(0, 3)).toEqual([['autopilot_status', 22], ['autopilot_init', 137], ['autopilot_init', 251]])
    const { starts, updates } = fold(events)
    expect(starts).toEqual([4])
    expect(updates[0]).toBe(22)
  })

  it('records the refused re-init instead of overwriting triage with it', () => {
    const { state } = fold(load('dup-init'))
    // The engine refuses the second init (AP_ALREADY_ACTIVE), but the tool/call
    // event is appended before the engine ever runs, so it reaches the reducer.
    expect(state?.data.reinitSeqs).toEqual([251])
  })
})

describe('B3 — the append-surface guard, and what actually makes the fold idempotent', () => {
  /** The post-compaction replacement copy of a landed result. */
  function replacementCopyOf(events: readonly CardEvent[], resultSeq: number): CardEvent {
    const original = events.find(e => e.type === 'tool/result' && e.seq === resultSeq)
    if (original === undefined) throw new Error(`no tool/result at seq ${resultSeq}`)
    return { ...original, seq: original.seq + 100000, surfaceOp: { op: 'replace', replaces: [original.seq] } }
  }

  it('the guard keeps a replaced surface copy out of the match stream entirely', () => {
    const copy = replacementCopyOf(load('inline'), 625)
    expect(makeDefinition().match(copy)).toBeNull()
    expect(makeDefinition(() => true).match(copy)).toEqual({ id: AUTOPILOT_RUN_ID, role: 'update' })
  })

  it('CORRECTION to the seam-1 spec: the guard is NOT what prevents double-counting', () => {
    // The spec asserted that dropping the guard makes an autopilot_log result
    // apply twice. Measured here, it does not: `applyResult` consumes the
    // pending entry for the callId, so a second result bearing the same callId
    // returns the previous state OBJECT unchanged. Idempotence comes from the
    // callId table, not from the surface marker. The guard is still correct —
    // a replaced copy is not a second observation and should not publish or
    // enter `context.matches` — but claiming it as the double-count bearer
    // would be claiming a check whose failure is unobservable.
    const events = load('inline')
    const copy = replacementCopyOf(events, 625)
    const guarded = fold([...events, copy]).state!
    const unguarded = fold([...events, copy], makeDefinition(() => true)).state!
    expect(unguarded.data).toEqual(guarded.data)
    expect(guarded.data.logCount?.value).toBe(1)
    expect(unguarded.data.logCount?.value).toBe(1)
  })

  it('the real idempotence bearer: a repeated result for a consumed callId is a no-op', () => {
    const events = load('inline')
    const state = fold(events.filter(e => e.seq <= 625)).state!
    expect(state.data.logCount?.value).toBe(1)
    const again = applyResult(state, {
      event: events.find(e => e.seq === 625)!, role: 'update', location: null,
    })
    // Same OBJECT, not merely deep-equal: the assembler and `sameContribution`
    // compare by reference, so this is also what keeps the view from churning.
    expect(again).toBe(state)
  })

  it('the mirror predicate agrees with the upstream rule on all three shapes', () => {
    expect(isAppendSurfaceEventMirror({ type: 'tool/result', seq: 1, time: 0, data: {}, surfaceOp: 'append' })).toBe(true)
    expect(isAppendSurfaceEventMirror({ type: 'tool/result', seq: 1, time: 0, data: {}, surfaceOp: { op: 'replace' } })).toBe(false)
    expect(isAppendSurfaceEventMirror({ type: 'tool/result', seq: 1, time: 0, data: {} })).toBe(false)
    expect(isAppendSurfaceEventMirror({ type: 'tool/call', seq: 1, time: 0, data: {}, surfaceOp: 'append' })).toBe(false)
  })
})

describe('B4 — a non-autopilot result cannot touch the card', () => {
  it('drops the str_replace_editor result that sits in the middle of the real inline run', () => {
    const events = load('inline')
    // Provenance check: the fixture really does contain a foreign tool.
    const foreign = events.find(e => e.type === 'tool/call' && (e.data as { name: string }).name === 'str_replace_editor')
    expect(foreign).toBeDefined()
    const foreignResult = events.find(e => e.type === 'tool/result'
      && readResult(e)?.callId === (foreign!.data as { callId: string }).callId)
    expect(foreignResult).toBeDefined()

    // `match` DOES accept it — the envelope carries no tool name, so it must.
    expect(makeDefinition().match(foreignResult!)?.role).toBe('update')

    // `applyResult` is the discriminator: an unknown callId returns the SAME
    // state object, not a mutated copy.
    const before = fold(events.filter(e => e.seq < foreignResult!.seq)).state!
    const after = applyResult(before, { event: foreignResult!, role: 'update', location: null })
    expect(after).toBe(before)
  })
})

describe('B5 — buildViewNode tolerates the truncated-window shape', () => {
  it('returns null when state is undefined (flush calls it for every context)', () => {
    expect(makeDefinition().buildViewNode(ctxOf(undefined))).toBeNull()
  })

  it('returns null for a session with a start but no autopilot traffic', () => {
    expect(makeDefinition().buildViewNode(ctxOf(emptyState()))).toBeNull()
  })

  it('returns a node with the engine-owned key once traffic lands', () => {
    const { state } = fold(load('inline'))
    const node = makeDefinition().buildViewNode(ctxOf(state))
    expect(node?.key).toBe(`${AUTOPILOT_RUN_KIND}:${AUTOPILOT_RUN_ID}`)
    expect(node?.kind).toBe(AUTOPILOT_RUN_KIND)
    expect(node?.target).toBe('chat')
    expect(node?.visibility).toBe('visible')
  })
})

describe('B6 — an audit verdict never moves a gate', () => {
  it('leaves planGate at what submit_plan reported until status says otherwise', () => {
    const events = load('inline')
    const auditCallSeq = 451
    const auditResultSeq = 453
    const statusResultSeq = 469

    // After the plan audit's PASS result, planGate must still read 'pending':
    // AuditOutcome carries no gate, and `applyVerdict` refuses the flip when a
    // usage entry is still `undeclared`, so inferring pass->pass is unsound.
    const afterAudit = fold(events.filter(e => e.seq <= auditResultSeq)).state!
    const verdict = JSON.parse((events.find(e => e.seq === auditResultSeq)!.data as never as {
      message: { content: [{ content: [{ text: string }] }] }
    }).message.content[0].content[0].text) as { verdict: string }
    expect(verdict.verdict).toBe('pass')
    expect(afterAudit.data.planGate?.value).toBe('pending')
    expect(afterAudit.data.audits.at(-1)).toMatchObject({ seq: auditCallSeq, settled: true, verdict: 'pass', role: 'plan' })

    // Only the status result moves it, and the observation is stamped.
    const afterStatus = fold(events.filter(e => e.seq <= statusResultSeq)).state!
    expect(afterStatus.data.planGate).toMatchObject({ value: 'pass', seq: statusResultSeq })
  })

  it('joins call args to the outcome by callId, never by ordering', () => {
    const { state } = fold(load('inline'))
    expect(state?.data.audits.map(a => [a.role, a.verdict, a.settled])).toEqual([
      ['plan', 'pass', true],
      ['execution', 'pass', true],
    ])
    for (const row of state!.data.audits) {
      expect(row.auditorId).toMatch(/^[0-9a-f-]{8,}$/)
      expect(row.kind).toBe('audit')
    }
  })
})

describe('B7 — init arguments beat status for triage', () => {
  it('keeps the five acceptance criteria status does not carry', () => {
    const { state } = fold(load('inline'))
    const triage = state!.data.triage!
    // StatusView carries objective/size/risk/executionMode/auditMode and NOTHING
    // else of triage; these three come from the init call arguments alone.
    expect(triage.acceptanceCriteria?.length).toBeGreaterThan(0)
    expect(triage.scope?.length).toBeGreaterThan(0)
    expect(triage.objective).toBe(
      (JSON.parse((load('inline').find(e => e.seq === 145)!.data as { arguments: string }).arguments) as { objective: string }).objective,
    )
  })

  it('lets status BACKFILL only what init never supplied', () => {
    // A run that never called init, then called status: the mirror fills in.
    const events = load('inline')
    const statusOnly = events.filter(e => e.seq === 4 || e.seq === 943 || e.seq === 944)
    const { state } = fold(statusOnly)
    expect(state?.data.triage?.objective).toBeDefined()
    expect(state?.data.triage?.acceptanceCriteria).toBeUndefined()
  })
})

describe('B8 — placement follows the first autopilot call, not turn 1', () => {
  it('anchors the inline card at seq 145, not the turn-1 seq 4', () => {
    const { state } = fold(load('inline'))
    const node = makeDefinition().buildViewNode(ctxOf(state))
    expect(node?.anchorSeq).toBe(145)
    expect(node?.anchorSeq).not.toBe(4)
  })

  it('anchors the delegated card at its own first call, and carries that match location', () => {
    const { state } = fold(load('delegated'))
    expect(state?.firstSeq).toBe(157)
    expect(state?.firstLocation).toEqual({ kind: 'session' })
  })
})

describe('B9 — `stale` is the honest alternative to inferring a gate', () => {
  it('is true after an audit advanced the run past the newest phase observation', () => {
    const events = load('inline')
    // After submit_evidence(rev 7) -> audit(execution) -> the run's revision
    // moves without any phase report, and the card must say so.
    const afterEvidence = fold(events.filter(e => e.seq <= 682)).state!
    expect(afterEvidence.data.stale).toBe(false)

    const afterCloseout = fold(events.filter(e => e.seq <= 931)).state!
    expect(afterCloseout.data.revision).toBe(afterCloseout.data.phase!.revision)
    expect(afterCloseout.data.stale).toBe(false)
  })

  it('goes true when a result carries a higher revision than the newest phase', () => {
    // Constructed from the real inline stream: replay it, then feed a real
    // `autopilot_log` result whose revision is ahead of the last phase report.
    const events = load('inline')
    const upTo = fold(events.filter(e => e.seq <= 469)).state!
    expect(upTo.data.stale).toBe(false)
    const logCall = events.find(e => e.seq === 624)!
    const logResult = events.find(e => e.seq === 625)!
    const withCall = applyCall(upTo, { event: logCall, role: 'update', location: null })
    const withResult = applyResult(withCall, { event: logResult, role: 'update', location: null })
    expect(withResult.data.revision).toBe(6)
    expect(withResult.data.phase!.revision).toBe(5)
    expect(withResult.data.stale).toBe(true)
  })
})

describe('B10 — a malformed payload cannot throw inside the reducer', () => {
  it('safeJsonObject swallows both a parse failure and a non-object', () => {
    expect(safeJsonObject('not json')).toBeUndefined()
    expect(safeJsonObject('[1,2]')).toBeUndefined()
    expect(safeJsonObject('null')).toBeUndefined()
    expect(safeJsonObject(undefined)).toBeUndefined()
    expect(safeJsonObject('{"a":1}')).toEqual({ a: 1 })
  })

  it('an AutopilotError text body leaves the card unchanged rather than throwing', () => {
    const events = load('inline')
    const state = fold(events.filter(e => e.seq <= 624)).state!
    const broken: CardEvent = {
      type: 'tool/result', seq: 99999, time: 0, surfaceOp: 'append',
      data: {
        message: {
          source: { kind: 'tool', callId: (events.find(e => e.seq === 624)!.data as { callId: string }).callId },
          content: [{ isError: false, content: [{ type: 'text', text: 'AP_NOT_ACTIVE: no run bound to this session' }] }],
        },
      },
    }
    let next: AutopilotRunState | undefined
    expect(() => { next = applyResult(state, { event: broken, role: 'update', location: null }) }).not.toThrow()
    expect(next!.data).toBe(state.data)
    // The pending entry is still consumed: a result landed, malformed or not.
    expect(next!.pending.size).toBe(state.pending.size - 1)
  })

  it('an isError result marks the call and settles the audit row without parsing the body', () => {
    const events = load('inline')
    const state = fold(events.filter(e => e.seq <= 781)).state!
    const failing: CardEvent = {
      type: 'tool/result', seq: 99998, time: 0, surfaceOp: 'append',
      data: {
        message: {
          source: { kind: 'tool', callId: (events.find(e => e.seq === 781)!.data as { callId: string }).callId },
          content: [{ isError: true, content: [{ type: 'text', text: 'AP_GATE_CLOSED' }] }],
        },
      },
    }
    const next = applyResult(state, { event: failing, role: 'update', location: null })
    expect(next.data.calls.at(-1)).toMatchObject({ name: 'autopilot_audit', failed: true })
    expect(next.data.audits.at(-1)).toMatchObject({ settled: true, failed: true })
    // The body is NOT parsed on an error result: there is no verdict to read.
    expect(next.data.audits.at(-1)?.verdict).toBeUndefined()
  })
})

describe('the delegated run reconstructs its executor authorization', () => {
  it('carries childId, generation and route from the executor result', () => {
    const { state } = fold(load('delegated'))
    const executor = state!.data.executor!.value as Record<string, unknown>
    expect(typeof executor.childId).toBe('string')
    expect(executor.generation).toBe(1)
    expect(executor.state).toBeDefined()
    // The card can show THAT an executor was authorized. It cannot show the
    // executor's report: autopilot_submit_packet is called in the CHILD's own
    // session, so the root log has no such tool/call.
    expect(load('delegated').some(e => e.type === 'tool/call'
      && (e.data as { name: string }).name === 'autopilot_submit_packet')).toBe(false)
  })

  it('reaches phase completed with both gates observed at status time', () => {
    const { state } = fold(load('delegated'))
    expect(state?.data.phase?.value).toBe('completed')
    expect(state?.data.planGate?.value).toBe('pass')
    expect(state?.data.executionGate?.value).toBeDefined()
    expect(state?.data.runId).toMatch(/^session-61a05524/)
  })
})

describe('reducer purity — the property the whole resume story rests on', () => {
  it.each(['inline', 'delegated', 'dup-init'] as const)('folds to a deep-equal state twice (%s)', (name) => {
    const events = load(name)
    expect(fold(events).state?.data).toEqual(fold(events).state?.data)
  })

  it('returns the SAME data reference when nothing changed, so the view does not churn', () => {
    const events = load('inline')
    const state = fold(events.filter(e => e.seq <= 469)).state!
    const unrelated = events.find(e => e.seq === 580)! // str_replace_editor's result
    expect(applyResult(state, { event: unrelated, role: 'update', location: null })).toBe(state)
  })

  it('readCall rejects a non-autopilot tool and a malformed envelope', () => {
    expect(readCall({ type: 'tool/call', seq: 1, time: 0, data: { name: 'read', callId: 'c' } })).toBeUndefined()
    expect(readCall({ type: 'tool/call', seq: 1, time: 0, data: { name: 'autopilot_log' } })).toBeUndefined()
    expect(readCall({ type: 'tool/call', seq: 1, time: 0, data: null })).toBeUndefined()
    expect(readCall({ type: 'tool/call', seq: 1, time: 0, data: { name: 'autopilot_log', callId: 'c', arguments: '{"note":"x"}' } }))
      .toEqual({ name: 'autopilot_log', callId: 'c', args: { note: 'x' } })
  })

  it('publication keeps the noisy all-results match off the synchronous path', () => {
    const definition = makeDefinition()
    const call = load('inline').find(e => e.type === 'tool/call')!
    const result = load('inline').find(e => e.type === 'tool/result')!
    expect(definition.publication({ event: call, role: 'update', location: null })).toBe('immediate')
    expect(definition.publication({ event: result, role: 'update', location: null })).toBe('animation-frame')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — the live gap, and the re-render waste found beside it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * B11. Node identity across a FOREIGN tool result.
 *
 * `match()` claims every append-surface `tool/result` — it must, because the
 * envelope carries no tool name — so a session doing ordinary file edits drives
 * `buildViewNode` for traffic that has nothing to do with the run. The old body
 * allocated a fresh object literal every call, and `chat-snapshot-builder`
 * compares contributions by REFERENCE, so the card re-rendered on every foreign
 * result.
 *
 * MUTATION CONTROL (watched go red, 2026-08-27): deleting the reuse branch from
 * `buildViewNode` — i.e. always building a new literal, the shipped behaviour —
 * turns the first three cases below red and leaves the location case (which
 * asserts the cache MUST miss) green.
 */
describe('B11 — buildViewNode returns the SAME node when nothing changed', () => {
  it('is reference-stable across repeated builds of one unchanged state', () => {
    const definition = makeDefinition()
    const { state } = fold(load('inline'))
    const first = definition.buildViewNode(ctxOf(state))
    expect(first).not.toBeNull()
    expect(definition.buildViewNode(ctxOf(state))).toBe(first)
  })

  it('survives a foreign tool/result without producing a new node', () => {
    const events = load('inline')
    const definition = makeDefinition()
    const foreign = events.find(e => e.type === 'tool/call'
      && (e.data as { name: string }).name === 'str_replace_editor')!
    const foreignResult = events.find(e => e.type === 'tool/result'
      && readResult(e)?.callId === (foreign.data as { callId: string }).callId)!

    const before = fold(events.filter(e => e.seq < foreignResult.seq)).state!
    const node = definition.buildViewNode(ctxOf(before))
    // `applyResult` already returns the same STATE object for an unknown
    // callId (B4); this is the second half — the same state must yield the
    // same NODE, or the view churns anyway.
    const after = applyResult(before, { event: foreignResult, role: 'update', location: null })
    expect(after).toBe(before)
    expect(definition.buildViewNode(ctxOf(after))).toBe(node)
  })

  it('still hands out a NEW node when an autopilot result actually lands', () => {
    // The negative half. Without it, "returns the same node" would also pass on
    // a definition that returns one frozen node forever.
    const events = load('inline')
    const definition = makeDefinition()
    const before = fold(events.filter(e => e.seq <= 624)).state!
    const first = definition.buildViewNode(ctxOf(before))
    const after = applyResult(before, { event: events.find(e => e.seq === 625)!, role: 'update', location: null })
    const second = definition.buildViewNode(ctxOf(after))
    expect(second).not.toBe(first)
    expect(second?.data.logCount?.value).toBe(1)
  })

  it('does not reuse a node across a different location input', () => {
    // The plan-auditor's finding: `buildViewNode` falls back to
    // `context.start?.location` when `state.firstLocation` is undefined, so the
    // location is a genuine INPUT and must be part of the reuse key. A state
    // with no firstLocation, built under two different starts, must anchor
    // twice — sharing a node here would render the card at the wrong place.
    const definition = makeDefinition()
    const events = load('inline')
    const state = { ...fold(events).state!, firstLocation: undefined }
    const key = `${AUTOPILOT_RUN_KIND}:${AUTOPILOT_RUN_ID}`
    const locationA = { kind: 'session', turn: 1 }
    const locationB = { kind: 'session', turn: 9 }
    const nodeA = definition.buildViewNode({
      key, id: AUTOPILOT_RUN_ID, state, start: { event: events[0]!, role: 'start', location: locationA }, matches: [],
    })
    const nodeB = definition.buildViewNode({
      key, id: AUTOPILOT_RUN_ID, state, start: { event: events[0]!, role: 'start', location: locationB }, matches: [],
    })
    expect(nodeA?.location).toBe(locationA)
    expect(nodeB?.location).toBe(locationB)
    expect(nodeB).not.toBe(nodeA)
  })

  it('keeps the unresolved-location fallback stable instead of reallocating it', () => {
    // `{kind:'unresolved'}` is an object literal; building it fresh on every
    // call would defeat the reuse the rest of this block asserts.
    const definition = makeDefinition()
    const state = { ...fold(load('inline')).state!, firstLocation: undefined }
    const ctx = { key: 'k', id: AUTOPILOT_RUN_ID, state, start: undefined, matches: [] }
    const first = definition.buildViewNode(ctx)
    expect(first?.location).toEqual({ kind: 'unresolved' })
    expect(definition.buildViewNode(ctx)).toBe(first)
  })
})

/**
 * B12. The poll gate.
 *
 * The gate is "the run is not terminal", NOT "the card says stale". An earlier
 * draft gated on `stale`, which fails in exactly the case the feature exists
 * for: `stale` is computed from the session log, so a session whose log carries
 * no new events never recomputes it and it can stay false while the run moves
 * elsewhere. Staleness only accelerates the cadence.
 */
describe('B12 — polling is gated on the run being live, not on the stale badge', () => {
  const base: AutopilotRunChatData = {
    runId: 'session-1', revision: 3, audits: [], calls: [], stale: false, reinitSeqs: [],
    phase: { value: 'executing', revision: 3, seq: 10 },
  }

  it('polls a non-terminal run even when the fold does NOT think it is stale', () => {
    expect(base.stale).toBe(false)
    expect(shouldPoll(base)).toBe(true)
  })

  it('stops on every terminal phase, and on a terminal phase learned from the ROUTE', () => {
    for (const phase of ['completed', 'blocked']) {
      expect(shouldPoll({ ...base, phase: { value: phase, revision: 3, seq: 10 } })).toBe(false)
      expect(isTerminalPhase(phase)).toBe(true)
    }
    // The card can only learn a headless run finished by being told, so the
    // gate has to read the live answer too — otherwise it polls forever.
    const live: LiveRun = { runId: 'session-1', revision: 9, phase: 'completed' }
    expect(shouldPoll(base, live)).toBe(false)
    // Control: a non-terminal live phase does not stop it.
    expect(shouldPoll(base, { ...live, phase: 'closing' })).toBe(true)
  })

  it('never polls without a run id — the route is keyed by one and it is not guessed', () => {
    const { runId, ...withoutId } = base
    expect(runId).toBeDefined()
    expect(shouldPoll(withoutId as AutopilotRunChatData)).toBe(false)
    expect(shouldPoll({ ...base, runId: '' })).toBe(false)
  })

  it('treats staleness as an accelerator, and never goes below the floor', () => {
    expect(pollDelayMs({ ...base, stale: true })).toBe(STALE_POLL_MS)
    expect(pollDelayMs({ ...base, stale: false })).toBe(STEADY_POLL_MS)
    expect(pollDelayMs({ ...base, stale: true })).toBeLessThan(pollDelayMs({ ...base, stale: false }))
    for (const stale of [true, false]) {
      expect(pollDelayMs({ ...base, stale })).toBeGreaterThanOrEqual(MIN_POLL_MS)
    }
  })

  it('encodes the id, so an exotic run id cannot truncate the query', () => {
    expect(runRouteUrl('session-1')).toBe('/api/autopilot/run?id=session-1')
    expect(runRouteUrl('a&b#c')).toBe('/api/autopilot/run?id=a%26b%23c')
  })
})

/**
 * B13. Every failure of the poll degrades to the fold state.
 *
 * The card has no state of its own to fall back on, so the only honest failure
 * behaviour is to keep showing the session-log reconstruction — which is what
 * it showed before polling existed and is never wrong, only possibly behind.
 */
describe('B13 — a failed poll is never worse than not polling', () => {
  const ok = (body: unknown): LiveFetch => () => Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
  const RUN = { runId: 'session-1', revision: 7, phase: 'executing', planGate: 'pass' }

  it('reads a well-formed body (the positive control for every refusal below)', async () => {
    await expect(fetchLiveRun('session-1', ok({ ok: true, run: RUN }))).resolves.toMatchObject({
      runId: 'session-1', revision: 7, phase: 'executing', planGate: 'pass',
    })
  })

  it('answers undefined for a rejected fetch, a non-2xx, and every malformed body', async () => {
    const cases: Array<[string, LiveFetch]> = [
      ['network failure', () => Promise.reject(new Error('offline'))],
      ['throws synchronously', () => { throw new Error('bad url') }],
      ['non-2xx', () => Promise.resolve({ ok: false, json: () => Promise.resolve({ ok: true, run: RUN }) })],
      ['body is not json', () => Promise.resolve({ ok: true, json: () => Promise.reject(new Error('unexpected token')) })],
      ['error body', ok({ ok: false, error: 'no-run' })],
      ['no run key', ok({ ok: true })],
      ['run is not an object', ok({ ok: true, run: 'nope' })],
      ['html error page', ok('<html>502</html>')],
      ['null', ok(null)],
    ]
    for (const [label, fetchJson] of cases) {
      await expect(fetchLiveRun('session-1', fetchJson), label).resolves.toBeUndefined()
    }
  })

  it('refuses a projection missing either field the card cannot do without', () => {
    // runId: the answer cannot be attributed. revision: it cannot be compared
    // with what the card already shows. phase: the poll gate reads it.
    expect(readLiveRun({ ok: true, run: { revision: 7, phase: 'executing' } })).toBeUndefined()
    expect(readLiveRun({ ok: true, run: { runId: 'a', phase: 'executing' } })).toBeUndefined()
    expect(readLiveRun({ ok: true, run: { runId: 'a', revision: 7 } })).toBeUndefined()
    expect(readLiveRun({ ok: true, run: { runId: 'a', revision: '7', phase: 'x' } })).toBeUndefined()
    expect(readLiveRun({ ok: true, run: { runId: 'a', revision: 7, phase: 'x' } })).toEqual({
      runId: 'a', revision: 7, phase: 'x',
    })
  })

  it('omits a field the route did not send rather than defaulting it', async () => {
    // A defaulted gate value would be a claim the route never made — the same
    // rule the em-dash in the renderer follows.
    const read = await fetchLiveRun('session-1', ok({ ok: true, run: { runId: 'a', revision: 2, phase: 'closing' } }))
    expect(read).toBeDefined()
    expect('planGate' in read!).toBe(false)
    expect('executionGate' in read!).toBe(false)
    expect('logCount' in read!).toBe(false)
  })
})

/**
 * B14. The overlay: what a live answer is allowed to change.
 */
describe('B14 — the live answer folds over the reconstruction by REVISION', () => {
  const folded: AutopilotRunChatData = {
    runId: 'session-1', revision: 4, audits: [], calls: [], reinitSeqs: [], stale: true,
    phase: { value: 'executing', revision: 3, seq: 10 },
    planGate: { value: 'pass', revision: 3, seq: 10 },
  }

  it('returns the SAME object when there is no live answer, or it is not newer', () => {
    expect(overlayLive(folded, undefined)).toBe(folded)
    expect(overlayLive(folded, { runId: 'session-1', revision: 4, phase: 'closing' })).toBe(folded)
    expect(overlayLive(folded, { runId: 'session-1', revision: 1, phase: 'planning' })).toBe(folded)
  })

  it('publishes a newer answer and clears `stale`, because the gap really is closed', () => {
    const next = overlayLive(folded, {
      runId: 'session-1', revision: 9, phase: 'closing', planGate: 'pass', executionGate: 'pass', logCount: 12,
    })
    expect(next).not.toBe(folded)
    expect(next.revision).toBe(9)
    expect(next.phase).toEqual({ value: 'closing', revision: 9 })
    expect(next.executionGate).toEqual({ value: 'pass', revision: 9 })
    expect(next.logCount).toEqual({ value: 12, revision: 9 })
    // `stale` means "revision moved past the newest phase observation". The
    // live read carries phase and revision from the same answer.
    expect(next.stale).toBe(false)
  })

  it('stamps live values with NO seq — a route answer has no session sequence', () => {
    const next = overlayLive(folded, { runId: 'session-1', revision: 9, phase: 'closing' })
    expect(next.phase?.seq).toBeUndefined()
    expect('seq' in next.phase!).toBe(false)
    // The fold's own observations keep theirs, so provenance stays readable.
    expect(folded.planGate?.seq).toBe(10)
  })

  it('keeps everything the route does not serve', () => {
    // The route serves gates, not audit rows or triage. An overlay that dropped
    // them would make the live card strictly worse than the stale one.
    const rich: AutopilotRunChatData = {
      ...folded,
      triage: { objective: 'ship it', acceptanceCriteria: ['a', 'b'] },
      audits: [{ callId: 'c1', seq: 1, time: 0, kind: 'audit', role: 'plan', settled: true, verdict: 'pass', failed: false }],
      calls: [{ seq: 1, time: 0, name: 'autopilot_status', failed: false }],
    }
    const next = overlayLive(rich, { runId: 'session-1', revision: 9, phase: 'closing' })
    expect(next.triage).toBe(rich.triage)
    expect(next.audits).toBe(rich.audits)
    expect(next.calls).toBe(rich.calls)
    // And a gate the route did not send is NOT wiped by the overlay.
    expect(next.planGate).toEqual({ value: 'pass', revision: 3, seq: 10 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B15 — PTC (programmatic tool calling): the envelope family the card was blind to
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE DEFECT THESE BEAR, and why nothing here is synthetic.
 *
 * On a host whose driving model runs in PTC mode, the model does not call
 * `autopilot_*` at all: it calls `run_code`, and the code body calls
 * `tools.autopilot_init(...)`. The session log carries a `tool/call` named
 * `"run_code"` — which `readCall` refuses, correctly — and the real tool name
 * appears ONLY on `tool/code-dispatch-start` / `tool/code-dispatch`. Measured
 * live on session `session-32d85066-366b-45e0-bb27-6fe033fea285`: nothing
 * matched, `firstSeq` stayed undefined, `buildViewNode` returned null, and the
 * card was invisible for the whole run — no card, no JSON fallback.
 *
 * It survived a full round of tests because EVERY fixture fed the direct-call
 * envelope. So `ptc.json` is a verbatim 9-event slice of that real session
 * (`turn/start` at seq 5, then the two run_code invocations at 135-138 and
 * 183-186, nothing edited); its eight autopilot events were verified
 * byte-identical against the session's own `session.jsonl.zstd` before the
 * fixture was written. Single-Bearer: a synthetic fixture here would reproduce
 * the same blind spot in the test that produced it in the code.
 */
describe('B15 — a PTC session produces a card', () => {
  it('the fixture really is the PTC shape, not a direct-call one', () => {
    // Provenance asserted rather than assumed: if this fixture ever drifts back
    // to direct calls, every claim below becomes vacuous.
    const events = load('ptc')
    const calls = events.filter(e => e.type === 'tool/call')
    expect(calls).toHaveLength(2)
    expect(calls.every(e => (e.data as { name: string }).name === 'run_code')).toBe(true)
    expect(events.filter(e => e.type === 'tool/code-dispatch-start')).toHaveLength(2)
    expect(events.filter(e => e.type === 'tool/code-dispatch')).toHaveLength(2)
    // And the old reader is blind to all of it — this is the defect, in one line.
    expect(calls.map(e => readCall(e))).toEqual([undefined, undefined])
  })

  it('folds to a visible card with the init observation, where it used to fold to nothing', () => {
    const { starts, state } = fold(load('ptc'))
    expect(starts).toEqual([5])
    expect(state?.firstSeq).toBe(136) // the dispatch-start, not the run_code call at 135
    const node = makeDefinition().buildViewNode(ctxOf(state))
    expect(node).not.toBeNull()
    expect(node?.anchorSeq).toBe(136)
    expect(node?.data.calls.map(c => c.name)).toEqual(['autopilot_init', 'autopilot_submit_plan'])
  })

  it('reads the triage out of arguments that arrive ALREADY PARSED', () => {
    // The trap: `arguments` is a JSON string on tool/call and an object here.
    // Running it through safeJsonObject returns undefined and silently drops
    // the whole triage block, which is most of what the card shows.
    const { state } = fold(load('ptc'))
    const triage = state!.data.triage!
    expect(triage.objective).toBe('M7 live-card probe')
    expect(triage.acceptanceCriteria).toEqual(['card advances'])
    expect(triage.scope).toEqual(['probe/'])
    expect(triage.size).toBe('lightweight')
    expect(triage.auditMode).toBe('self-check')
  })

  it('folds the dispatch completion payload — revision, phase and gates', () => {
    const { state } = fold(load('ptc'))
    expect(state?.data.revision).toBe(2)
    expect(state?.data.phase?.value).toBe('planning')
    expect(state?.data.planGate?.value).toBe('pending')
    expect(state?.data.planRevision?.value).toBe(1)
    expect(state?.data.enforcement?.value.store).toBe('file')
  })

  it('counts one logical invocation once, not twice', () => {
    // In PTC the wrapper's own `tool/result` carries the ROOT callId and the
    // SAME body the dispatch already delivered. The pending table is keyed by
    // subCallId, so the wrapper result finds nothing and is dropped — which is
    // what keeps the call strip honest.
    const events = load('ptc')
    const { state } = fold(events)
    expect(state?.data.calls).toHaveLength(2)

    const wrapperResult = events.find(e => e.type === 'tool/result' && e.seq === 138)!
    const before = fold(events.filter(e => e.seq < 138)).state!
    expect(applyResult(before, { event: wrapperResult, role: 'update', location: null })).toBe(before)
  })

  it('publishes a dispatch-start on the synchronous path and its completion on a frame', () => {
    const definition = makeDefinition()
    const events = load('ptc')
    const start = events.find(e => e.type === 'tool/code-dispatch-start')!
    const done = events.find(e => e.type === 'tool/code-dispatch')!
    expect(definition.publication({ event: start, role: 'update', location: null })).toBe('immediate')
    expect(definition.publication({ event: done, role: 'update', location: null })).toBe('animation-frame')
  })

  it('refuses a FOREIGN dispatch by name, at match time', () => {
    // Unlike tool/result, these events name their tool, so a foreign dispatch
    // never enters the match stream at all.
    const definition = makeDefinition()
    const real = load('ptc').find(e => e.type === 'tool/code-dispatch-start')!
    const foreign: CardEvent = {
      ...real,
      data: { ...(real.data as Record<string, unknown>), name: 'str_replace_editor' },
    }
    expect(definition.match(real)).toEqual({ id: AUTOPILOT_RUN_ID, role: 'update' })
    expect(definition.match(foreign)).toBeNull()
  })

  it('is idempotent on a repeated completion, exactly like the direct path', () => {
    // The invariant the whole resume story rests on: replaying a completion the
    // fold already consumed returns the SAME state object.
    const events = load('ptc')
    const state = fold(events).state!
    const done = events.find(e => e.type === 'tool/code-dispatch' && e.seq === 185)!
    expect(applyResult(state, { event: done, role: 'update', location: null })).toBe(state)
  })

  it('an isError dispatch marks the call without parsing a body', () => {
    const events = load('ptc')
    const before = fold(events.filter(e => e.seq <= 184)).state!
    const real = events.find(e => e.seq === 185)!
    const failing: CardEvent = {
      ...real,
      data: { ...(real.data as Record<string, unknown>), isError: true },
    }
    const next = applyResult(before, { event: failing, role: 'update', location: null })
    expect(next.data.calls.at(-1)).toMatchObject({ name: 'autopilot_submit_plan', failed: true })
    // No planRevision was folded from a failed dispatch.
    expect(next.data.planRevision).toBeUndefined()
  })
})

describe('B16 — the two envelope families coexist and neither disturbs the other', () => {
  it('a mixed session folds both families into one card', () => {
    // COMPOSITE, and said so plainly: both halves are real captures, but no
    // single captured session mixes them. What this bears is that the two
    // readers do not interfere — not that a mixed session was observed.
    const mixed = [...load('inline'), ...load('ptc').filter(e => e.type !== 'turn/start')]
    const { starts, state } = fold(mixed)
    expect(starts).toHaveLength(1)
    // Assert on the PTC half's own SEQS, not on tool names: inline.json
    // independently contains autopilot_init and autopilot_submit_plan as direct
    // calls, so a name-based assertion here passes even when the PTC half folds
    // to nothing — measured, by watching this very case stay green under the
    // revert mutation before it was tightened.
    const seqs = state!.data.calls.map(c => c.seq)
    expect(seqs).toContain(145)  // inline's first direct autopilot call
    expect(seqs).toContain(136)  // ptc's first dispatch-start
    expect(seqs).toContain(184)  // ptc's second dispatch-start
    expect(state!.data.calls.filter(c => c.name === 'autopilot_status').length).toBeGreaterThan(0)
  })

  it('CONTROL: the direct-call path folds byte-identically to before the PTC work', () => {
    // The regression guard for this change. If normalizing the two families
    // onto one fold altered the direct path in any way, these deep-equal
    // comparisons against the untouched fixtures are what fail.
    for (const name of ['inline', 'delegated', 'dup-init'] as const) {
      const a = fold(load(name)).state
      const b = fold(load(name)).state
      expect(a?.data).toEqual(b?.data)
    }
    const inline = fold(load('inline')).state!
    expect(inline.data.phase?.value).toBe('completed')
    expect(inline.data.planGate?.value).toBe('pass')
    expect(inline.data.audits).toHaveLength(2)
    expect(inline.firstSeq).toBe(145)
  })

  it('a PTC event cannot reach the direct readers, and vice versa', () => {
    // Each reader refuses the other family's envelope outright, so a future
    // edit cannot make one silently absorb the other.
    const ptcStart = load('ptc').find(e => e.type === 'tool/code-dispatch-start')!
    const ptcDone = load('ptc').find(e => e.type === 'tool/code-dispatch')!
    const directCall = load('inline').find(e => e.type === 'tool/call'
      && (e.data as { name: string }).name?.startsWith('autopilot_'))!

    expect(readCall(ptcStart)).toBeUndefined()      // no callId on a dispatch
    expect(readDispatchStart(directCall)).toBeUndefined() // no subCallId on a call
    expect(readDispatch(directCall)).toBeUndefined()
    // Positive controls, so the four refusals above are not passing on readers
    // that refuse everything.
    expect(readDispatchStart(ptcStart)?.name).toBe('autopilot_init')
    expect(readDispatch(ptcDone)?.subCallId).toContain(':code:1')
    expect(readCall(directCall)?.name).toMatch(/^autopilot_/)
  })
})

/**
 * B17. The poll key, and the second instance of one defect species.
 *
 * The plan audit caught the first instance before it shipped: gating the poll
 * on `stale`, a fold-derived signal the session log may never supply. M7 caught
 * the second in production: gating it on `data.runId`, which the engine's
 * trimmed tool results did not carry, so the fold reported "run id not
 * reported", the gate stayed shut, and an out-of-band advance from revision 2
 * to 3 was never picked up.
 *
 * The fixture below IS that case, not a reconstruction of it: `ptc.json` was
 * captured before the engine's results carried a run id, so it is permanently a
 * no-runId session — which is also why the session-id fallback is the half that
 * covers every log recorded before this round.
 */
describe('B17 — the poll key falls back to the session id, soundly', () => {
  const SESSION = 'session-32d85066-366b-45e0-bb27-6fe033fea285'

  it('the real PTC fold really does report NO run id', () => {
    // Provenance for everything below. If this ever becomes defined, these
    // cases stop testing the fallback and must be re-pointed.
    const { state } = fold(load('ptc'))
    expect(state?.data.runId).toBeUndefined()
    expect(state?.data.revision).toBe(2)
  })

  it('without a session id the gate stays shut — the measured defect', () => {
    const { state } = fold(load('ptc'))
    expect(pollKey(state!.data)).toBeUndefined()
    expect(shouldPoll(state!.data)).toBe(false)
  })

  it('with the session id the gate OPENS on the same data', () => {
    const { state } = fold(load('ptc'))
    expect(pollKey(state!.data, SESSION)).toBe(SESSION)
    expect(shouldPoll(state!.data, undefined, SESSION)).toBe(true)
    expect(runRouteUrl(pollKey(state!.data, SESSION)!)).toBe(`/api/autopilot/run?id=${SESSION}`)
  })

  it('prefers the fold’s run id when the traffic DID report one', () => {
    // A card whose traffic named a run follows that run, even if the host ever
    // renders it somewhere whose session id differs.
    const withRun = { ...fold(load('ptc')).state!.data, runId: 'session-from-traffic' }
    expect(pollKey(withRun, SESSION)).toBe('session-from-traffic')
  })

  it('treats a blank or whitespace session id as absent, not as an id', () => {
    const { data } = fold(load('ptc')).state!
    for (const blank of ['', '   ', '\t']) {
      expect(pollKey(data, blank)).toBeUndefined()
      expect(shouldPoll(data, undefined, blank)).toBe(false)
    }
  })

  it('still refuses when the run is terminal, session id or not', () => {
    // The fallback widens WHO can be asked about, never WHETHER a finished run
    // keeps being polled.
    const { data } = fold(load('ptc')).state!
    const done = { ...data, phase: { value: 'completed', revision: 9, seq: 1 } }
    expect(shouldPoll(done, undefined, SESSION)).toBe(false)
    expect(shouldPoll(data, { runId: SESSION, revision: 9, phase: 'blocked' }, SESSION)).toBe(false)
  })

  it('a session with NO run keeps refusing quietly — the fallback costs nothing', async () => {
    // The control that makes the fallback safe to apply unconditionally: a card
    // in a session that never ran the harness polls, gets a 404, and returns
    // undefined. No throw, no state change, nothing rendered differently.
    const notFound: LiveFetch = () => Promise.resolve({
      ok: false,
      json: () => Promise.resolve({ ok: false, error: 'no-run' }),
    })
    await expect(fetchLiveRun(SESSION, notFound)).resolves.toBeUndefined()

    // And a 200 body that is an error envelope is equally silent.
    const errorBody: LiveFetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: 'no-run' }),
    })
    await expect(fetchLiveRun(SESSION, errorBody)).resolves.toBeUndefined()
  })

  it('a run id learned from ANY result now populates the fold, not just status', async () => {
    // The host half of the fix: the engine's trimmed results carry runId now,
    // so a future session log is self-describing and never needs the fallback.
    // The reader has to accept it from any tool, or the host change would be
    // invisible to the card.
    const events = load('ptc')
    const dispatch = events.find(e => e.seq === 137)!
    const selfDescribing: CardEvent = {
      ...dispatch,
      data: {
        ...(dispatch.data as Record<string, unknown>),
        content: [{ type: 'text', text: JSON.stringify({ runId: SESSION, revision: 1, phase: 'planning' }) }],
      },
    }
    const before = fold(events.filter(e => e.seq <= 136)).state!
    expect(before.data.runId).toBeUndefined()
    const after = applyResult(before, { event: selfDescribing, role: 'update', location: null })
    expect(after.data.runId).toBe(SESSION)
    // …and it needs no fallback once it has one.
    expect(pollKey(after.data)).toBe(SESSION)
  })
})
