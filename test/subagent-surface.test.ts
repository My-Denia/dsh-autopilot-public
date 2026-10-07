/**
 * The subagent manager surface the engine calls, measured against the
 * INSTALLED `@deepseek-ai/dsh-subagent`, not against our own fakes.
 *
 * WHY. `SubagentsRef` is structural, so the compiler never compares it with the
 * host. The engine's needs-fix resume called `subagents.followup(...)` for
 * several releases while every fake in this suite implemented `followup` — and
 * the real manager has had no such method since at least dsh 0.1.2-rc.1
 * (checked against the published 0.1.2-rc.1, 0.1.5-rc.1, 0.1.7-rc.2 and
 * 0.2.0-rc.2 packages). On a real host the resume threw
 * `followup is not a function`. This file is the detector for that class of
 * drift: every method `SubagentsRef` names must exist on the real prototype.
 */
import { describe, expect, it } from 'vitest'
import * as subagent from '@deepseek-ai/dsh-subagent'
import type { SubagentsRef } from '../src/engine.js'

/** Every method of the structural ref, spelled once; a new member must be added here. */
const REQUIRED: ReadonlyArray<keyof SubagentsRef> = [
  'start',
  'startContinuable',
  'sendMessage',
  'interrupt',
  'drainContinuableChildren',
]

function managerPrototype(): Record<string, unknown> {
  const candidates = (Object.values(subagent) as unknown[]).filter(
    (value): value is { prototype: Record<string, unknown>; name: string } =>
      typeof value === 'function'
      && typeof (value as { prototype?: unknown }).prototype === 'object'
      && 'startContinuable' in (value as { prototype: object }).prototype,
  )
  expect(candidates.map(c => c.name)).toContain('SubagentRuntime')
  return candidates[0]!.prototype
}

describe('installed subagent manager surface', () => {
  it('has every method SubagentsRef calls', () => {
    const proto = managerPrototype()
    for (const name of REQUIRED) expect(typeof proto[name], name).toBe('function')
  })

  it('has no followup — the resume transport is sendMessage', () => {
    expect(managerPrototype().followup).toBeUndefined()
  })
})
