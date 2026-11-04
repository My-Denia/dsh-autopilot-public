/**
 * The card anchors on native goal tool calls (create_goal / get_goal /
 * update_goal) as well as `autopilot_*`, so a goal-only session shows its
 * ledger. One card per session; the ledger is requested for the ROOT session.
 */
import { describe, expect, it } from 'vitest'
import {
  createAutopilotRunDefinition, isAppendSurfaceEventMirror, readCall, readDispatchStart,
} from '../../src/client/definition.js'
import type { CardEvent } from '../../src/client/definition.js'
import { fetchLedger, ledgerRouteUrl, ledgerSessionId } from '../../src/client/ledger.js'

const call = (seq: number, name: string, callId = `c${seq}`): CardEvent =>
  ({ type: 'tool/call', seq, time: seq, data: { name, callId, arguments: '{}' } })
const turn1: CardEvent = { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } }

function fold(events: readonly CardEvent[]) {
  const def = createAutopilotRunDefinition({ isAppendSurfaceEvent: isAppendSurfaceEventMirror })
  const key = 'autopilot-run:run'
  let state: ReturnType<typeof def.start> | undefined
  let starts = 0
  for (const event of events) {
    const m = def.match(event)
    if (m === null) continue
    if (m.role === 'start') { starts += 1; state = def.start(); continue }
    state = def.update({ key, id: 'run', state: state!, start: undefined, matches: [] },
      { event, role: 'update', location: { kind: 'session' } })
  }
  return { starts, node: def.buildViewNode({ key, id: 'run', state, start: undefined, matches: [] }) }
}

describe('goal-call anchor', () => {
  it.each(['create_goal', 'get_goal', 'update_goal'])('%s anchors a card with no autopilot call', (name) => {
    expect(readCall(call(5, name))?.name).toBe(name)
    const { starts, node } = fold([turn1, call(5, name)])
    expect(starts).toBe(1)
    expect(node?.anchorSeq).toBe(5)
    expect(node?.data.calls).toEqual([])
  })

  it('anchors on a PTC dispatch of a goal tool', () => {
    const ev: CardEvent = { type: 'tool/ptc-dispatch-start', seq: 7, time: 7, data: { name: 'get_goal', subCallId: 'x:code:1', arguments: {} } }
    expect(readDispatchStart(ev)?.name).toBe('get_goal')
    expect(fold([turn1, ev]).node?.anchorSeq).toBe(7)
  })

  it('stays one card, at the first call, when goal and autopilot calls mix', () => {
    const { starts, node } = fold([turn1, call(3, 'get_goal'), call(9, 'autopilot_status'), call(11, 'update_goal')])
    expect(starts).toBe(1)
    expect(node?.anchorSeq).toBe(3)
    expect(node?.data.calls.map(c => c.name)).toEqual(['autopilot_status'])
    const reversed = fold([turn1, call(3, 'autopilot_status'), call(9, 'get_goal')])
    expect(reversed.node?.anchorSeq).toBe(3)
  })

  it('does not anchor on foreign tools', () => {
    expect(fold([turn1, call(4, 'read'), call(5, 'goal_note')]).node).toBeNull()
  })
})

describe('root session id and no-ledger', () => {
  it('prefers the root id over the child session id', () => {
    expect(ledgerSessionId({ sessionId: 'child-1', rootSessionId: 'root-1' })).toBe('root-1')
    expect(ledgerSessionId({ sessionId: 'root-1' })).toBe('root-1')
    expect(ledgerSessionId({ sessionId: 'child-1', rootSessionId: ' ' })).toBe('child-1')
  })

  it('requests the ledger route for that id and survives 404 no-ledger', async () => {
    const urls: string[] = []
    const miss = async (url: string) => {
      urls.push(url)
      return { ok: false, status: 404, json: async () => ({ ok: false, error: 'no-ledger' }) }
    }
    await expect(fetchLedger('root-1', miss as never)).resolves.toBeUndefined()
    expect(urls).toEqual([ledgerRouteUrl('root-1')])
    const throws = async () => { throw new Error('offline') }
    await expect(fetchLedger('root-1', throws as never)).resolves.toBeUndefined()
  })
})
