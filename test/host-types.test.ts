/**
 * Mirror-vs-host bearers for the structural types the engine declares.
 *
 * WHY THIS FILE EXISTS. The engine talks to dsh through STRUCTURAL mirrors
 * (`SessionRef`, `AgentRef`, … in src/engine.ts) rather than imported types,
 * so a member the host removes does not fail `tsc` — the plugin keeps
 * compiling against its own interface and reads `undefined` at runtime. That
 * is precisely how dsh 0.1.2's removal of `Session.events` would have slipped
 * through: `hasDirectHumanTurn` and `effectiveSandboxMode` would have thrown
 * on `.length` of `undefined` on the first real host, with every unit test
 * green. The assignments below make the REAL `Session` prove it satisfies the
 * mirror at compile time (`pnpm run check` runs tsconfig.test.json), and the
 * runtime case drives the human-turn predicate through a real Session.
 *
 * DETECTOR (recorded once in the upgrade run's evidence/host-types.txt):
 * re-adding `readonly events: ReadonlyArray<…>` to `SessionRef` turns the
 * first assignment red with TS2741 — the failure mode that used to be silent.
 */
import { describe, expect, it } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'

import type { SessionReadRef } from '../src/engine.js'
import { hasDirectHumanTurn } from '../src/tools.js'

function realSession(id: string): Session {
  return Session.create(id as SessionId)
}

/** A user-role message with source kind 'user' — the human-turn discriminator. */
function humanMessage(text: string): never {
  return {
    id: 'm-1',
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as never
}

describe('host types satisfy the engine mirrors (dsh 0.1.2-rc.1)', () => {
  it('a real Session is assignable to SessionReadRef (compile-time bearer)', () => {
    // The assignment IS the assertion: if `Session` lost `snapshotEvents` or
    // `header`, or the mirror named a member the host no longer has (as
    // `events` was), this line fails typecheck. `append` is excluded from this
    // bearer for the reason stated on `SessionRef` in src/engine.ts: the
    // `sandbox/mode` event type is merged into the host's map by a package
    // this plugin does not install.
    const mirror: SessionReadRef = realSession('host-types-assign')
    expect(typeof mirror.snapshotEvents).toBe('function')
    expect(Array.isArray(mirror.snapshotEvents())).toBe(true)
    expect(mirror.header.cwd).toBeUndefined()
  })

  it('hasDirectHumanTurn reads a REAL session log: true inside an open turn with a user message', () => {
    const session = realSession('host-types-human')
    session.append('turn/start', { turn: 1 })
    session.append('user/message', humanMessage('hello'), { surfaceOp: 'append' })
    const agent: { session: SessionReadRef } = { session }
    expect(hasDirectHumanTurn(agent)).toBe(true)
  })

  it('… and false when the open turn carries no user-sourced message', () => {
    // DETECTOR for the case above: proves the predicate reads the log's
    // CONTENT, not merely that `snapshotEvents()` returned an array.
    const session = realSession('host-types-empty-turn')
    session.append('turn/start', { turn: 1 })
    const agent: { session: SessionReadRef } = { session }
    expect(hasDirectHumanTurn(agent)).toBe(false)
  })

  it('snapshotEvents is taken fresh: an append after the first read is visible on the next read', () => {
    const session = realSession('host-types-fresh')
    const before = session.snapshotEvents().length
    session.append('turn/start', { turn: 1 })
    expect(session.snapshotEvents().length).toBe(before + 1)
  })
})
