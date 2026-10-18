/**
 * The subagent service surface the engine calls, measured against the
 * INSTALLED `@deepseek-ai/dsh-subagent`, not against our own fakes.
 *
 * The 0.2.0 pin exposed `start` / `startContinuable` / `drainContinuableChildren`.
 * The 0.2.1-rc.2 pin replaced that trio with `startActivation` / `drainChildren`.
 * `sendMessage` and `interrupt` are on both. `followup` is on neither. This
 * file fails when the installed pin and the engine's branch disagree.
 */
import { describe, expect, it } from 'vitest'
import * as subagent from '@deepseek-ai/dsh-subagent'

function runtimePrototype(): Record<string, unknown> {
  const candidates = (Object.values(subagent) as unknown[]).filter(
    (value): value is { prototype: Record<string, unknown>; name: string } =>
      typeof value === 'function'
      && typeof (value as { prototype?: unknown }).prototype === 'object'
      && (
        'startActivation' in (value as { prototype: object }).prototype
        || 'startContinuable' in (value as { prototype: object }).prototype
      ),
  )
  expect(candidates.map(c => c.name)).toContain('SubagentRuntime')
  return candidates[0]!.prototype
}

describe('installed subagent service surface (dsh-subagent 0.2.1-rc.2)', () => {
  it('has the activation methods the engine calls, and not the 0.2.0 trio', () => {
    const proto = runtimePrototype()
    for (const name of ['startActivation', 'sendMessage', 'interrupt', 'drainChildren']) {
      expect(typeof proto[name], name).toBe('function')
    }
    expect(proto.start).toBeUndefined()
    expect(proto.startContinuable).toBeUndefined()
    expect(proto.drainContinuableChildren).toBeUndefined()
    expect(proto.followup).toBeUndefined()
  })
})
