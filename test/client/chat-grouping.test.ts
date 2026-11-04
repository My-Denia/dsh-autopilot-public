/**
 * The card must stand OUTSIDE the turn's process groups on dsh 0.2.1-rc.5.
 *
 * rc.5's Chat view (`dsh-client-ui-chat`) puts every node of a turn that does
 * not declare a `groupTree` at or outside "process" into a collapsed activity
 * group ("ran commands, called tools, read files"), and on a completed turn the
 * whole process is folded again under "done, took N min". The card anchors at
 * the session's first autopilot or goal call, which is a tool call in the
 * middle of turn 1, so without a `groupTree` it became the second member of
 * the first collapsed group — on the desktop app that is where the card of a
 * real goal session was: present, and never on screen.
 *
 * The grouping rule is a verbatim excerpt of the rc.5 bundle
 * (`test/fixtures/rc5-ui-chat/grouping.js`, provenance in its header); the
 * node is built by the shipped definition from the event shape of that
 * session (turn 1 starts at seq 5, `get_goal` is called at seq 26, step 2).
 */
import { describe, expect, it } from 'vitest'
import { createAutopilotRunDefinition, isAppendSurfaceEventMirror } from '../../src/client/definition.js'
import type { CardEvent, CardViewNode } from '../../src/client/definition.js'
import { groupTurn, isAtOrOutside } from '../fixtures/rc5-ui-chat/grouping.js'

const step = (turn: number, s: number) => ({ kind: 'step', turn: { turn, data: {} }, step: s })
const call = (seq: number, name: string): CardEvent =>
  ({ type: 'tool/call', seq, time: seq, data: { turn: 1, step: 2, name, callId: `c${seq}`, arguments: '{}' } })

/** Fold the events the way the assembler does and build the card node at its first-call location. */
function cardNode(events: readonly CardEvent[]): CardViewNode {
  const def = createAutopilotRunDefinition({ isAppendSurfaceEvent: isAppendSurfaceEventMirror })
  const key = 'autopilot-run:run'
  let state: ReturnType<typeof def.start> | undefined
  for (const event of events) {
    const m = def.match(event)
    if (m === null) continue
    if (m.role === 'start') { state = def.start(); continue }
    state = def.update({ key, id: 'run', state: state!, start: undefined, matches: [] },
      { event, role: 'update', location: step(1, 2) } as never)
  }
  const node = def.buildViewNode({ key, id: 'run', state, start: undefined, matches: [] })
  if (node === null) throw new Error('the definition built no card for a goal session')
  return node
}

const goalSession: readonly CardEvent[] = [
  { type: 'turn/start', seq: 5, time: 5, data: { turn: 1 } },
  call(26, 'get_goal'),
  call(104, 'create_goal'),
  call(117, 'autopilot_delegate'),
  call(351, 'autopilot_agents'),
]

describe('the card on the rc.5 Chat grouping', () => {
  it('UPSTREAM CANARY: a node without groupTree joins the activity group; groupTree "turn" stands outside it', () => {
    const tool = { kind: 'tool-call' }
    const notice = { kind: 'turn-error', groupTree: 'turn' }
    const nodes: Record<string, { kind: string; groupTree?: string }> = { a: tool, n: notice, b: tool }
    expect(groupTurn(['a', 'n', 'b'], key => nodes[key]!)).toEqual([
      { kind: 'group', members: ['a'] },
      { kind: 'node', key: 'n' },
      { kind: 'group', members: ['b'] },
    ])
    expect(isAtOrOutside({}, 'turn')).toBe(false)
    expect(isAtOrOutside({ groupTree: 'turn' }, 'turn')).toBe(true)
  })

  it('a goal session\'s card is a root entry of turn 1, not a member of a collapsed tool group', () => {
    const card = cardNode(goalSession)
    expect(card.anchorSeq).toBe(26)
    const nodes: Record<string, { kind: string; groupTree?: string }> = {
      'tool:get_goal': { kind: 'tool-call' },
      [card.key]: card,
      'tool:create_goal': { kind: 'tool-call' },
      'tool:autopilot_delegate': { kind: 'tool-call' },
    }
    const roots = groupTurn(['tool:get_goal', card.key, 'tool:create_goal', 'tool:autopilot_delegate'], key => nodes[key]!)
    expect(roots).toContainEqual({ kind: 'node', key: card.key })
    for (const entry of roots) if (entry.kind === 'group') expect(entry.members).not.toContain(card.key)
  })

  it('a completed turn\'s process fold does not take the card with it', () => {
    // ChatNodeSeat marks a node a fold member only when !isAtOrOutside(node, "turn").
    expect(isAtOrOutside(cardNode(goalSession), 'turn')).toBe(true)
  })
})
