/**
 * The synchronous guard installers.
 *
 * What is under test here is not the decision matrix (`test/gate.test.ts` owns
 * that) but what the guard says when the DECISION ITSELF throws — the one branch
 * that only exists in these two functions.
 *
 * THE DEFECT THIS FILE EXISTS FOR. Both installers wrapped `applyDecision` in
 * `try { … } catch { return undefined }`, and `applyDecision` starts with
 * `engine.peek`, which reaches `RunStore.load` and throws `AP_STORE_CORRUPT` on
 * a torn `events.jsonl` line. That state is reachable, not hypothetical:
 * `RunStore.commit` appends the canonical event BEFORE the tmp+rename of the
 * projection, so a kill inside that window leaves exactly a partial last line,
 * and the next cold start reads it. Under `egressSeam: 'guard-deny'` — by
 * definition the configuration in which no pre-execute seam exists and this
 * guard is the ONLY defense — the "unconditional" egress denial therefore
 * became a blanket ALLOW.
 *
 * Fail-open is still correct for the quality gates, so the catch is SPLIT
 * rather than inverted, and both halves are asserted below.
 */

import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AutopilotError } from '../src/domain/types.js'
import { AutopilotEngine } from '../src/engine.js'
import { resolveConfig } from '../src/index.js'
import { RunStore } from '../src/store/file.js'
import { installChildEgressGuard, installRootGate } from '../src/gate/install.js'
import type { GateAgentRef } from '../src/gate/install.js'
import { decideTool } from '../src/gate/decide.js'
import type { GateConfig } from '../src/gate/decide.js'
import { MAX_STOP_REMINDERS } from '../src/domain/types.js'
import type { Snapshot } from '../src/domain/types.js'
import { makeHarness, makeSnapshot, makeTriage, undeclaredSeed } from './helpers.js'

type Guard = (execution: { name: string; arguments: unknown }) => string | undefined

const GUARD_ONLY: GateConfig & { stopReminder: boolean } = {
  toolDeny: true,
  egressDeny: true,
  strictShell: false,
  egressSeam: 'guard-deny',
  stopReminder: false,
}

type StopListener = (payload: { agent: unknown; turn: number }) => Promise<void> | void

/**
 * A root agent that hands back BOTH seams `installRootGate` installs: the tool
 * guard and the `agent/turn-stopping` listener, plus every followup the
 * listener pushed.
 */
function capturingAgent(id: string): {
  agent: GateAgentRef
  guard: () => Guard
  stopListener: () => StopListener | undefined
  events: string[]
  followups: string[]
} {
  let captured: Guard | undefined
  let stopping: StopListener | undefined
  const events: string[] = []
  const followups: string[] = []
  const agent: GateAgentRef = {
    id,
    session: { header: {} },
    ctx: {
      tools: {
        guard(fn: Guard) {
          captured = fn
          return () => {}
        },
      },
      on(event: 'agent/turn-stopping', listener: StopListener) {
        events.push(event)
        stopping = listener
        return () => {}
      },
    },
    followup: (message) => { followups.push(message.content.map(block => block.text).join('')) },
  }
  return {
    agent,
    events,
    followups,
    guard: () => {
      if (captured === undefined) throw new Error('installRootGate registered no guard')
      return captured
    },
    stopListener: () => stopping,
  }
}

/**
 * An engine whose `peek` answers with a scripted snapshot and whose
 * `bumpReminder` counts, so each precondition of the turn-stop listener can be
 * isolated instead of being reached through a run that also satisfies the
 * others.
 */
function scriptedEngine(
  engine: AutopilotEngine,
  snapshot: Snapshot | undefined,
  bumps: number[] = [],
): AutopilotEngine {
  return new Proxy(engine, {
    get(target, property, receiver) {
      if (property === 'peek') return () => snapshot
      if (property === 'bumpReminder') {
        return async () => {
          bumps.push(bumps.length + 1)
          return bumps.length > MAX_STOP_REMINDERS ? undefined : bumps.length
        }
      }
      return Reflect.get(target, property, receiver) as unknown
    },
  })
}

/** A standard run mid-execution with the execution gate still open. */
function midExecution(overrides: Partial<Snapshot> = {}): Snapshot {
  return makeSnapshot(
    { phase: 'executing', planGate: 'pass', executionGate: 'pending', ...overrides },
    { size: 'standard', risk: 'medium', auditMode: 'independent' },
  )
}

/** An engine whose `peek` throws the way a torn event stream makes it throw. */
function corruptedPeek(engine: AutopilotEngine, message: string): AutopilotEngine {
  return new Proxy(engine, {
    get(target, property, receiver) {
      if (property === 'peek') {
        return () => { throw new AutopilotError(message, 'AP_STORE_CORRUPT') }
      }
      return Reflect.get(target, property, receiver) as unknown
    },
  })
}

describe('installRootGate: what the guard says when the snapshot read throws', () => {
  it('DETECTOR first: on a healthy store the guard denies this exact egress', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    const host = capturingAgent(h.root.id)
    installRootGate(host.agent, h.engine, GUARD_ONLY)
    const reason = host.guard()({ name: 'bash', arguments: { command: 'git push origin main' } })
    expect(reason).toContain('owner-only boundary')
  })

  it('still denies the egress when peek throws (fail-CLOSED on the outbound boundary)', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    const host = capturingAgent(h.root.id)
    installRootGate(host.agent, corruptedPeek(h.engine, 'events.jsonl line 2 is not valid JSON'), GUARD_ONLY)
    const guard = host.guard()
    expect(guard({ name: 'bash', arguments: { command: 'git push origin main' } })).toContain('owner-only boundary')
    // Every shell-class channel, so the fix cannot be a one-tool-name fix.
    expect(guard({ name: 'pwsh', arguments: { command: 'npm publish' } })).toContain('owner-only boundary')
    expect(guard({ name: 'run_code', arguments: { code: 'await $`git push`' } })).toContain('owner-only boundary')
    expect(guard({ name: 'terminal_send', arguments: { sessionId: 's', text: 'gh release create v1' } }))
      .toContain('owner-only boundary')
  })

  it('keeps failing OPEN for the quality gates, which is the doctrine that was right', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage(), [undeclaredSeed()])
    const host = capturingAgent(h.root.id)
    installRootGate(host.agent, corruptedPeek(h.engine, 'events.jsonl line 2 is not valid JSON'), GUARD_ONLY)
    const guard = host.guard()
    // A quality gate is not a permission system: a broken gate must not lock
    // the machine, so a write, a benign shell call and a child-control call all
    // pass through.
    expect(guard({ name: 'write', arguments: { path: 'x' } })).toBeUndefined()
    expect(guard({ name: 'bash', arguments: { command: 'git status' } })).toBeUndefined()
    expect(guard({ name: 'send_message', arguments: { agentId: 'someone' } })).toBeUndefined()
  })

  it('stands down on the outbound boundary when the pre-execute seam owns the call', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    const host = capturingAgent(h.root.id)
    installRootGate(host.agent, corruptedPeek(h.engine, 'boom'), { ...GUARD_ONLY, egressSeam: 'native-ask' })
    // A monotonic guard denial here would veto the human's allowed-once, and the
    // seam has its own fail-closed catch for exactly this case.
    expect(host.guard()({ name: 'bash', arguments: { command: 'git push origin main' } })).toBeUndefined()
  })

  it('respects the owner switch: egressDeny false means no boundary to fail closed on', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    const host = capturingAgent(h.root.id)
    installRootGate(host.agent, corruptedPeek(h.engine, 'boom'), { ...GUARD_ONLY, egressDeny: false, egressSeam: 'off' })
    expect(host.guard()({ name: 'bash', arguments: { command: 'git push origin main' } })).toBeUndefined()
  })
})

describe('installChildEgressGuard carries the same split catch', () => {
  it('denies egress on a throwing peek, and still fails open for writes', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    let captured: Guard | undefined
    installChildEgressGuard(
      { guard(fn: Guard) { captured = fn; return () => {} } },
      h.root.id,
      corruptedPeek(h.engine, 'events.jsonl line 2 is not valid JSON'),
      GUARD_ONLY,
    )
    if (captured === undefined) throw new Error('no child guard registered')
    expect(captured({ name: 'bash', arguments: { command: 'git push origin main' } })).toContain('owner-only boundary')
    expect(captured({ name: 'write', arguments: {} })).toBeUndefined()
  })
})

describe('the corruption is reachable from the store, not just from a Proxy', () => {
  it('a torn last line makes RunStore.load throw AP_STORE_CORRUPT on a cold read', async () => {
    // `commit` appends the canonical event and only THEN refreshes the
    // projection by tmp+rename; a kill between the two leaves a partial line.
    // This writes that residue directly rather than killing a process, so what
    // is proven is the CONSEQUENCE of the state, not its frequency — the
    // crash-window frequency stays UNPROVEN (DESIGN.md §8).
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    const events = join(h.storeDir, 'runs', h.root.id, 'events.jsonl')
    expect(readFileSync(events, 'utf8').trim().split(String.fromCharCode(10)).length).toBe(1)

    // Cold read BEFORE the tear: the same store folds cleanly.
    const cold = new RunStore(h.storeDir)
    expect(cold.load(h.root.id)?.phase).toBe('planning')

    appendFileSync(events, '{"v":1,"op":"log","revi', 'utf8')
    const torn = new RunStore(h.storeDir)
    try {
      torn.load(h.root.id)
      expect.unreachable('a torn line must not fold silently')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AutopilotError)
      expect((error as AutopilotError).code).toBe('AP_STORE_CORRUPT')
    }

    // And that is exactly the throw the guard now refuses egress on: the same
    // store, driven through the real installer rather than a Proxy.
    const engine = new AutopilotEngine(
      { get: () => undefined },
      {} as never,
      torn,
      resolveConfig({}),
      () => false,
      {},
    )
    const host = capturingAgent(h.root.id)
    installRootGate(host.agent, engine, GUARD_ONLY)
    expect(host.guard()({ name: 'bash', arguments: { command: 'git push origin main' } }))
      .toContain('owner-only boundary')
    expect(host.guard()({ name: 'write', arguments: {} })).toBeUndefined()
  })
})

/**
 * THE SECOND DEFECT THIS FILE NOW COVERS (2026-08-25 independent repair audit).
 *
 * `applyDecision` translates a pure decision into the guard's
 * `string | undefined` contract, and three of its four deny branches were
 * DECORATIVE: turning each of them into `return undefined` left the whole suite
 * green, because only `deny-egress` had a guard-level bearer. `decide.ts` still
 * said deny; `install.ts` threw the reason away and the tool call proceeded.
 *
 * Each case below pins the decision KIND first (so the fixture is proven to
 * reach the branch under test) and then asserts that the GUARD hands back that
 * decision's own reason string.
 */
describe('installRootGate: every deny decision survives translation into a guard reason', () => {
  function guardOver(snapshot: Snapshot, config = GUARD_ONLY): Guard {
    const h = makeHarness()
    const host = capturingAgent(h.root.id)
    installRootGate(host.agent, scriptedEngine(h.engine, snapshot), config)
    return host.guard()
  }

  it('deny-plan-gate reaches the caller as the plan gate own reason', () => {
    const snapshot = makeSnapshot(
      { planGate: 'pending', enforcement: { sandbox: 'active', reminders: 0, ownerApprovals: [] } },
      { size: 'standard', risk: 'medium', auditMode: 'independent' },
    )
    const call = { name: 'write', arguments: { path: 'x.ts' } }
    // The fixture reaches the branch under test...
    const decision = decideTool(snapshot, call.name, call.arguments, GUARD_ONLY)
    expect(decision.kind).toBe('deny-plan-gate')
    if (decision.kind !== 'deny-plan-gate') throw new Error('unreachable')
    // ...and the guard does not drop it.
    const reason = guardOver(snapshot)(call)
    expect(reason).toBe(decision.reason)
    expect(reason).toContain('plan gate is pending')
  })

  it('deny-usage-undeclared reaches the caller as the usage gate own reason', () => {
    const snapshot = makeSnapshot(
      {
        planGate: 'pass',
        phase: 'executing',
        usage: { entries: [undeclaredSeed('m1')] },
        enforcement: { sandbox: 'active', reminders: 0, ownerApprovals: [] },
      },
      { size: 'standard', risk: 'medium', auditMode: 'independent' },
    )
    const call = { name: 'edit', arguments: { path: 'x.ts' } }
    const decision = decideTool(snapshot, call.name, call.arguments, GUARD_ONLY)
    expect(decision.kind).toBe('deny-usage-undeclared')
    if (decision.kind !== 'deny-usage-undeclared') throw new Error('unreachable')
    const reason = guardOver(snapshot)(call)
    expect(reason).toBe(decision.reason)
    expect(reason).toContain('usage gate')
  })

  it('deny-executor-bypass reaches the caller as the single-control-loop reason', () => {
    const snapshot = makeSnapshot(
      {
        planGate: 'pass',
        phase: 'executing',
        executor: {
          childId: 'child-7',
          generation: 1,
          executionRevision: 1,
          state: 'running',
          route: { provider: 'p', routeProvider: 'p', routeModel: 'm', routeStatus: 'verified' },
        },
      },
      { size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' },
    )
    const call = { name: 'send_message', arguments: { agentId: 'child-7', text: 'do it' } }
    const decision = decideTool(snapshot, call.name, call.arguments, GUARD_ONLY)
    expect(decision.kind).toBe('deny-executor-bypass')
    if (decision.kind !== 'deny-executor-bypass') throw new Error('unreachable')
    const reason = guardOver(snapshot)(call)
    expect(reason).toBe(decision.reason)
    expect(reason).toContain('single-control-loop')
  })

  it('allow-degraded is a PERMIT, and stays one', () => {
    // The fourth branch, unbeared in the DENY direction: a degraded-but-permitted
    // call could start being blocked and nothing would notice.
    const snapshot = makeSnapshot(
      { planGate: 'pending', enforcement: { sandbox: 'off', reminders: 0, ownerApprovals: [] } },
      { size: 'standard', risk: 'medium', auditMode: 'independent' },
    )
    const call = { name: 'bash', arguments: { command: 'pnpm test' } }
    const decision = decideTool(snapshot, call.name, call.arguments, GUARD_ONLY)
    expect(decision.kind).toBe('allow-degraded')
    expect(guardOver(snapshot)(call)).toBeUndefined()
  })

  it('positive control: an ordinary allow is undefined too, so undefined is not the only answer here', () => {
    const snapshot = makeSnapshot({ planGate: 'pass', phase: 'executing' })
    expect(guardOver(snapshot)({ name: 'read', arguments: { path: 'x.ts' } })).toBeUndefined()
  })
})

/**
 * THE THIRD DEFECT (2026-08-25): the turn-stop reminder listener — one of the
 * four seams this module's docstring advertises — had ZERO bearers. The suite's
 * only `GateConfig` set `stopReminder: false`, so nothing ever entered the
 * branch: deleting the size check, the phase check, the execution-gate check or
 * the `config.stopReminder` guard itself all left 394 tests green.
 * `engine.bumpReminder` IS covered, which is what made the gap easy to miss —
 * the counter had a bearer, the listener that calls it did not.
 */
describe('installRootGate: the turn-stop reminder listener', () => {
  const WITH_REMINDER: GateConfig & { stopReminder: boolean } = { ...GUARD_ONLY, stopReminder: true }

  function install(snapshot: Snapshot | undefined, config = WITH_REMINDER) {
    const h = makeHarness()
    const host = capturingAgent(h.root.id)
    const bumps: number[] = []
    installRootGate(host.agent, scriptedEngine(h.engine, snapshot, bumps), config)
    return { host, bumps }
  }

  it('nudges a standard run that is mid-execution with the gate still open', async () => {
    const { host, bumps } = install(midExecution())
    expect(host.events).toEqual(['agent/turn-stopping'])
    const listener = host.stopListener()
    if (listener === undefined) throw new Error('no agent/turn-stopping listener was installed')
    await listener({ agent: {}, turn: 1 })
    expect(bumps).toEqual([1])
    expect(host.followups).toHaveLength(1)
    expect(host.followups[0]).toContain('[autopilot 1/' + String(MAX_STOP_REMINDERS) + ']')
    expect(host.followups[0]).toContain('execution gate is')
    expect(host.followups[0]).toContain('pending')
  })

  it('says NOTHING for a lightweight run', async () => {
    const { host, bumps } = install(makeSnapshot({ phase: 'executing', planGate: 'pass' }))
    await host.stopListener()?.({ agent: {}, turn: 1 })
    expect(bumps).toEqual([])
    expect(host.followups).toEqual([])
  })

  it('says NOTHING outside the execution phases', async () => {
    const { host, bumps } = install(midExecution({ phase: 'planning', planGate: 'pending' }))
    await host.stopListener()?.({ agent: {}, turn: 1 })
    expect(bumps).toEqual([])
    expect(host.followups).toEqual([])
    // and the sibling execution phase IS covered, so this is a phase decision
    // rather than "only 'executing' ever nudges".
    const reviewing = install(midExecution({ phase: 'execution-reviewing' }))
    await reviewing.host.stopListener()?.({ agent: {}, turn: 1 })
    expect(reviewing.host.followups).toHaveLength(1)
  })

  it('says NOTHING once the execution gate has passed', async () => {
    const { host, bumps } = install(midExecution({ executionGate: 'pass' }))
    await host.stopListener()?.({ agent: {}, turn: 1 })
    expect(bumps).toEqual([])
    expect(host.followups).toEqual([])
  })

  it('says NOTHING when there is no run at all', async () => {
    const { host, bumps } = install(undefined)
    await host.stopListener()?.({ agent: {}, turn: 1 })
    expect(bumps).toEqual([])
    expect(host.followups).toEqual([])
  })

  it('registers NO listener when the owner turned the reminder off', () => {
    const { host } = install(midExecution(), GUARD_ONLY)
    expect(host.events).toEqual([])
    expect(host.stopListener()).toBeUndefined()
  })

  it('self-releases: nothing is sent once the budget is spent', async () => {
    const { host, bumps } = install(midExecution())
    const listener = host.stopListener()
    if (listener === undefined) throw new Error('no listener')
    for (let round = 0; round < MAX_STOP_REMINDERS + 1; round += 1) await listener({ agent: {}, turn: round })
    expect(bumps).toHaveLength(MAX_STOP_REMINDERS + 1)
    expect(host.followups).toHaveLength(MAX_STOP_REMINDERS)
  })
})
