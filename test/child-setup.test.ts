/**
 * The delegated executor child's surface: packet tool + egress guard + native
 * egress seam, installed by `createContinuableChildSetup` (called on
 * `agent/created` with the child's own ctx since dsh 0.1.2; through the
 * `registerContinuableSetup` registry on dsh 0.1.1).
 *
 * THE DEFECT THIS FILE EXISTS FOR, and why nothing caught it. The callback was
 * an anonymous closure inside `apply()`, reachable only through
 * `ctx.subagents.registerContinuableSetup` — and the suite's fake host stubbed
 * that with `registerContinuableSetup: () => () => {}` and never invoked the
 * callback. `packetToolDefinition`, `installChildEgressGuard` and
 * `autopilot_submit_packet` appeared in no test file at all.
 *
 * Inside it, `childCtx.get('agent')` is UNCONDITIONALLY undefined on a real
 * cordis 4.0.1 context: dsh publishes the agent with
 * `ctx.accessor('agent', { get: … })` plus `root.extend({ agent })`, never
 * `ctx.provide('agent', …)`, and `Context.prototype.get` resolves only PROVIDED
 * services. So `rootId` stayed undefined, the setup returned `() => {}`, and a
 * delegated child received no `tools/pre-execute` egress seam, no egress guard,
 * and no `autopilot_submit_packet` — which is registered at exactly one site.
 * Delegated runs were BOTH ungated for egress AND unable to submit their packet.
 *
 * The fixture below therefore builds the child context the way a real host does:
 * `get(name)` answers undefined for 'agent', and `agent` is an OWN PROPERTY.
 */

import { describe, expect, it } from 'vitest'
import { createContinuableChildSetup, installExecutorChildSurface } from '../src/index.js'
import type { ContinuableChildContext } from '../src/index.js'
import type { AutopilotEngine } from '../src/engine.js'
import type { ResolvedConfig } from '../src/engine.js'
import { fakeAgent, makeHarness, makeTriage, makeUsageEntry, stubSubagents, undeclaredSeed } from './helpers.js'

const GATE: ResolvedConfig['gate'] = {
  sandboxCoupling: true,
  toolDeny: true,
  egressDeny: true,
  stopReminder: true,
  strictShell: false,
  restoreMode: 'workspace-write',
}

interface RecordedChild extends ContinuableChildContext {
  readonly toolNames: string[]
  readonly guards: number
  readonly events: string[]
  /** Disposer invocations in the order they happened: 'seam' | 'packet-tool' | 'egress-guard'. */
  readonly disposed: string[]
  pre?: (exec: { name: string; arguments: unknown; callId?: string }, next: () => Promise<unknown>) => Promise<unknown>
  guardFn?: (execution: { name: string; arguments: unknown }) => string | undefined
}

/** Failure injection for the transactional-install tests. */
interface ChildFailures {
  seamThrows?: boolean
  /** `tools.register` throws (the packet-tool step). */
  registerThrows?: boolean
  /** `tools.guard` throws (the egress-guard step). */
  guardThrows?: boolean
  /** These steps' DISPOSERS throw when invoked. */
  disposerThrows?: ReadonlyArray<'seam' | 'packet-tool' | 'egress-guard'>
  /** `tools.guard` throws a FROZEN error object (annotation with defineProperty would throw). */
  guardThrowsFrozen?: boolean
}

/**
 * A child context in the shape a real host produces.
 *
 * @param exposeVia - 'property' reproduces cordis 4.0.1 + dsh exactly (accessor
 * only: `get('agent')` is undefined, `.agent` is set). 'get' is the shape a host
 * that genuinely PROVIDED the service would produce. Both must work, which is
 * why `lookupService` tries `get` first and the property second.
 */
function childContext(
  agent: unknown,
  exposeVia: 'property' | 'get' | 'neither',
  options: ChildFailures = {},
): RecordedChild {
  const toolNames: string[] = []
  const events: string[] = []
  const disposed: string[] = []
  const disposer = (step: 'seam' | 'packet-tool' | 'egress-guard') => () => {
    disposed.push(step)
    if (options.disposerThrows?.includes(step)) throw new Error(`inject: ${step} disposer failed`)
  }
  const child: RecordedChild = {
    toolNames,
    events,
    disposed,
    guards: 0,
    get(name: string) {
      return exposeVia === 'get' && name === 'agent' ? agent : undefined
    },
    ...(exposeVia === 'property' ? { agent } : {}),
    tools: {
      register(definition: unknown) {
        if (options.registerThrows === true) throw new Error('inject: tools.register failed')
        toolNames.push((definition as { name?: string }).name ?? '<unnamed>')
        return disposer('packet-tool')
      },
      guard(fn: (execution: { name: string; arguments: unknown }) => string | undefined) {
        if (options.guardThrowsFrozen === true) throw Object.freeze(new Error('inject: frozen tools.guard failure'))
        if (options.guardThrows === true) throw new Error('inject: tools.guard failed')
        ;(child as { guards: number }).guards += 1
        child.guardFn = fn
        return disposer('egress-guard')
      },
    },
  } as RecordedChild
  // The pre-execute seam registers through `on`, which the child context also
  // carries in the real runtime; it is added here rather than in the literal so
  // the structural cast stays readable. Its disposer is the SEAM step's.
  ;(child as unknown as { on: (event: string, listener: unknown) => () => void }).on = (event, listener) => {
    if (event === 'tools/pre-execute' && options.seamThrows === true) {
      throw new Error('this host does not dispatch tools/pre-execute')
    }
    events.push(event)
    if (event === 'tools/pre-execute') child.pre = listener as never
    return event === 'tools/pre-execute' ? disposer('seam') : () => {}
  }
  return child
}

/** A delegated run parked in `executing` with a live executor child. */
async function delegatedRunning(extraVerdicts: Array<{ verdict: string; note: string }> = []) {
  const subagents = stubSubagents({ verdicts: [{ verdict: 'pass', note: 'plan ok' }, ...extraVerdicts] })
  const h = makeHarness({ subagents })
  await h.engine.init(
    h.root,
    makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' }),
    [undeclaredSeed('m1')],
  )
  await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
  await h.engine.submitPlan(h.root, 'plan')
  await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
  const started = await h.engine.startExecutor(h.root, { prompt: 'go', signal: new AbortController().signal })
  const childId = started.executor?.childId as string
  const childAgent = fakeAgent(childId, h.root.id)
  h.agents.add(childAgent)
  return { ...h, childAgent, childId }
}

describe('createContinuableChildSetup', () => {
  it('installs the whole child surface when the agent is reachable only as a PROPERTY', async () => {
    const h = await delegatedRunning()
    const child = childContext(h.childAgent, 'property')
    // The shape assertion that makes this fixture a claim about reality: the
    // service is NOT resolvable through `get`, exactly as on a real host.
    expect(child.get('agent')).toBeUndefined()
    expect(child.agent).toBe(h.childAgent)

    const dispose = createContinuableChildSetup(h.engine as AutopilotEngine, GATE)(child)
    expect(child.toolNames).toEqual(['autopilot_submit_packet'])
    expect(child.guards).toBe(1)
    expect(child.events).toEqual(['tools/pre-execute', 'tools/execute'])
    expect(() => dispose()).not.toThrow()
  })

  it('the installed child guard actually gates egress for the PARENT run', async () => {
    const h = await delegatedRunning()
    const child = childContext(h.childAgent, 'property')
    createContinuableChildSetup(h.engine as AutopilotEngine, GATE)(child)
    const guard = child.guardFn
    if (guard === undefined) throw new Error('no child guard was installed')
    // The seam installed, so the guard DEFERS rather than denying — asserted as
    // "no reason" beside a branch that does produce one, so this is not just
    // "nothing happened".
    expect(guard({ name: 'bash', arguments: { command: 'git push origin main' } })).toBeUndefined()
    // The child is bound to the PARENT's run, which is what makes the plan-gate
    // and usage clamps apply to it at all.
    expect(h.engine.peek(h.root.id)?.executor?.childId).toBe(h.childId)
  })

  it('the installed pre-execute seam denies an egress with no manifest', async () => {
    const h = await delegatedRunning()
    const child = childContext(h.childAgent, 'property')
    createContinuableChildSetup(h.engine as AutopilotEngine, GATE)(child)
    if (child.pre === undefined) throw new Error('no pre-execute listener was installed')
    const decision = await child.pre(
      { name: 'bash', arguments: { command: 'git push origin main' }, callId: 'c1' },
      async () => ({ kind: 'allow' }),
    ) as { kind: string; reason?: string }
    expect(decision.kind).toBe('deny')
    expect(decision.reason).toContain('no readable outbound evidence manifest')
    // DETECTOR: a non-egress call falls through to next().
    const passed = await child.pre(
      { name: 'bash', arguments: { command: 'pnpm test' }, callId: 'c2' },
      async () => ({ kind: 'allow' }),
    ) as { kind: string }
    expect(passed.kind).toBe('allow')
  })

  it('also works when the host genuinely PROVIDES the agent service', async () => {
    const h = await delegatedRunning()
    const child = childContext(h.childAgent, 'get')
    expect(child.get('agent')).toBe(h.childAgent)
    expect(child.agent).toBeUndefined()
    createContinuableChildSetup(h.engine as AutopilotEngine, GATE)(child)
    expect(child.toolNames).toEqual(['autopilot_submit_packet'])
    expect(child.guards).toBe(1)
  })

  it('installs NOTHING for a child the run does not recognise', async () => {
    const h = await delegatedRunning()
    // Same parent, wrong child id: this is not the authorized executor, so it
    // gets no packet tool and no seam. The negative half is what proves the
    // positive half above is a decision and not an unconditional install.
    const stranger = fakeAgent('some-other-child', h.root.id)
    const child = childContext(stranger, 'property')
    const dispose = createContinuableChildSetup(h.engine as AutopilotEngine, GATE)(child)
    expect(child.toolNames).toEqual([])
    expect(child.guards).toBe(0)
    expect(child.events).toEqual([])
    expect(() => dispose()).not.toThrow()
  })

  it('installs NOTHING when the agent is not reachable at all, and does not throw', async () => {
    const h = await delegatedRunning()
    const child = childContext(h.childAgent, 'neither')
    expect(child.get('agent')).toBeUndefined()
    expect(child.agent).toBeUndefined()
    const dispose = createContinuableChildSetup(h.engine as AutopilotEngine, GATE)(child)
    expect(child.toolNames).toEqual([])
    expect(child.guards).toBe(0)
    expect(() => dispose()).not.toThrow()
  })

  it('installs NOTHING for a TOP-LEVEL agent that wandered into the child setup', async () => {
    const h = await delegatedRunning()
    const child = childContext(h.root, 'property')
    createContinuableChildSetup(h.engine as AutopilotEngine, GATE)(child)
    expect(child.toolNames).toEqual([])
    expect(child.guards).toBe(0)
  })

  it('the packet tool it registers is the one an executor child submits through', async () => {
    const h = await delegatedRunning()
    const child = childContext(h.childAgent, 'property')
    createContinuableChildSetup(h.engine as AutopilotEngine, GATE)(child)
    expect(child.toolNames).toContain('autopilot_submit_packet')
    // and the engine really accepts a packet from that child, so the tool name
    // is not the only thing being asserted.
    const after = await h.engine.submitExecutionPacket(h.childAgent, { packet: 'done', residualRisks: [], executionRevision: 1 })
    expect(after.executionPacket).toBe('done')
    expect(after.phase).toBe('execution-reviewing')
  })
})

/**
 * The child-binding conjunction has TWO halves and only the identity half was
 * beared (2026-08-25): deleting `&& (state === 'running' || state ===
 * 'starting')` left 394 tests green. Without it a child whose executor record
 * has already been REVOKED or COMPLETED is still bound to the parent run —
 * receiving the packet tool, the child egress guard and the pre-execute seam —
 * so a revoked executor could submit a packet or attempt an egress charged to a
 * run that has already written it off.
 */
describe('createContinuableChildSetup: the executor STATE half of the binding', () => {
  it('installs NOTHING for a REVOKED executor, even with the right childId', async () => {
    const h = await delegatedRunning()
    // A replan drains and revokes the child; the childId is unchanged, so
    // identity alone still matches and only the state clause can refuse.
    await h.engine.replan(h.root, 'reality contradicted the plan')
    expect(h.engine.peek(h.root.id)?.executor?.childId).toBe(h.childId)
    expect(h.engine.peek(h.root.id)?.executor?.state).toBe('revoked')

    const child = childContext(h.childAgent, 'property')
    const dispose = createContinuableChildSetup(h.engine as AutopilotEngine, GATE)(child)
    expect(child.toolNames).toEqual([])
    expect(child.guards).toBe(0)
    expect(child.events).toEqual([])
    expect(() => dispose()).not.toThrow()
  })

  it('installs NOTHING for a COMPLETED executor, even with the right childId', async () => {
    const h = await delegatedRunning([{ verdict: 'pass', note: 'execution ok' }])
    await h.engine.submitExecutionPacket(h.childAgent, { packet: 'done', residualRisks: [], executionRevision: 1 })
    await h.engine.audit(h.root, { role: 'execution', prompt: 'p' })
    expect(h.engine.peek(h.root.id)?.executor?.childId).toBe(h.childId)
    expect(h.engine.peek(h.root.id)?.executor?.state).toBe('completed')

    const child = childContext(h.childAgent, 'property')
    createContinuableChildSetup(h.engine as AutopilotEngine, GATE)(child)
    expect(child.toolNames).toEqual([])
    expect(child.guards).toBe(0)
    expect(child.events).toEqual([])
  })

  it('positive control: the SAME child, still running, gets the whole surface', async () => {
    const h = await delegatedRunning()
    expect(h.engine.peek(h.root.id)?.executor?.state).toBe('running')
    const child = childContext(h.childAgent, 'property')
    createContinuableChildSetup(h.engine as AutopilotEngine, GATE)(child)
    expect(child.toolNames).toEqual(['autopilot_submit_packet'])
    expect(child.guards).toBe(1)
  })
})

/**
 * The child mirror of the seam-status wiring (2026-08-25): the child's guard is
 * configured from `resolveEgressChannel(childSeam.installed, …)`, and nothing
 * observed that it is fed the seam status this child actually got. On a host
 * that refuses `tools/pre-execute` the child must fall back to the
 * unconditional guard denial, not stand down for a seam that is not there.
 */
describe('createContinuableChildSetup: what the child guard does when the seam refuses to install', () => {
  it('falls back to guard-deny, so egress is refused rather than deferred to nothing', async () => {
    const h = await delegatedRunning()
    const child = childContext(h.childAgent, 'property', { seamThrows: true })
    createContinuableChildSetup(h.engine as AutopilotEngine, GATE)(child)
    const guard = child.guardFn
    if (guard === undefined) throw new Error('no child guard was installed')
    expect(child.pre).toBeUndefined()
    expect(guard({ name: 'bash', arguments: { command: 'git push origin main' } }))
      .toContain('owner-only boundary')
    // The quality gates still fail open, so this is the egress branch and not a
    // broken child surface.
    expect(guard({ name: 'write', arguments: { path: 'x' } })).toBeUndefined()
  })

  it('DETECTOR: the same child on a host that ACCEPTS the seam defers instead', async () => {
    const h = await delegatedRunning()
    const child = childContext(h.childAgent, 'property')
    createContinuableChildSetup(h.engine as AutopilotEngine, GATE)(child)
    expect(child.guardFn?.({ name: 'bash', arguments: { command: 'git push origin main' } })).toBeUndefined()
  })
})

/**
 * TRANSACTIONAL INSTALL — failure injection (owner ruling 2026-09-04, Codex P2
 * 3933411711 on PR #6). Every case names what the observer would see if the
 * property were false: a leaked seam, a disposer that ran twice, an original
 * error replaced by a cleanup error.
 */
describe('createContinuableChildSetup: transactional, fail-closed install', () => {
  it('(a) packet-tool registration throws after the seam installed: seam rolled back, the SAME error propagates, nothing stays installed', async () => {
    const h = await delegatedRunning()
    const child = childContext(h.childAgent, 'property', { registerThrows: true })
    let caught: unknown
    try {
      createContinuableChildSetup(h.engine as AutopilotEngine, GATE)(child)
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('inject: tools.register failed')
    // The seam had installed (both listeners) and was rolled back — exactly once.
    expect(child.events).toEqual(['tools/pre-execute', 'tools/execute'])
    expect(child.disposed).toEqual(['seam'])
    expect(child.toolNames).toEqual([])
    expect(child.guards).toBe(0)
    // No cleanup failed, so nothing was attached.
    expect((caught as { rollbackFailures?: unknown }).rollbackFailures).toBeUndefined()
  })

  it('(b) guard registration throws after seam + packet tool: rolled back in REVERSE order [packet-tool, seam], the error propagates', async () => {
    const h = await delegatedRunning()
    const child = childContext(h.childAgent, 'property', { guardThrows: true })
    expect(() => createContinuableChildSetup(h.engine as AutopilotEngine, GATE)(child)).toThrow('inject: tools.guard failed')
    expect(child.toolNames).toEqual(['autopilot_submit_packet'])
    expect(child.disposed).toEqual(['packet-tool', 'seam'])
    expect(child.guards).toBe(0)
  })

  it('(c) full success: no disposer runs until the returned disposer is called; then each exactly once, in reverse; a second call is a no-op', async () => {
    const h = await delegatedRunning()
    const child = childContext(h.childAgent, 'property')
    const dispose = createContinuableChildSetup(h.engine as AutopilotEngine, GATE)(child)
    expect(child.toolNames).toEqual(['autopilot_submit_packet'])
    expect(child.guards).toBe(1)
    expect(child.disposed).toEqual([])
    dispose()
    expect(child.disposed).toEqual(['egress-guard', 'packet-tool', 'seam'])
    dispose()
    expect(child.disposed).toEqual(['egress-guard', 'packet-tool', 'seam'])
  })

  it('(d) an unrelated child is a no-op: nothing registered, nothing thrown — even with every injection armed', async () => {
    const h = await delegatedRunning()
    const stranger = fakeAgent('not-the-executor', h.root.id)
    const child = childContext(stranger, 'property', { registerThrows: true, guardThrows: true, seamThrows: true })
    const dispose = createContinuableChildSetup(h.engine as AutopilotEngine, GATE)(child)
    expect(child.events).toEqual([])
    expect(child.toolNames).toEqual([])
    expect(child.guards).toBe(0)
    expect(() => dispose()).not.toThrow()
  })

  it('(e) a disposer that throws does not stop the others: every disposer is attempted, then an AggregateError names the failed step', async () => {
    const h = await delegatedRunning()
    const child = childContext(h.childAgent, 'property', { disposerThrows: ['packet-tool'] })
    const dispose = createContinuableChildSetup(h.engine as AutopilotEngine, GATE)(child)
    let caught: unknown
    try {
      dispose()
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).message).toMatch(/cleanup failed at packet-tool/)
    expect((caught as AggregateError).errors.map(error => (error as Error).message)).toEqual(['inject: packet-tool disposer failed'])
    // The seam disposer still ran AFTER the failing one.
    expect(child.disposed).toEqual(['egress-guard', 'packet-tool', 'seam'])
    // Second call: nothing left to attempt, nothing thrown.
    expect(() => dispose()).not.toThrow()
    expect(child.disposed).toHaveLength(3)
  })

  it('(f) a cleanup failure during rollback never masks the ORIGINAL install error; it is attached as rollbackFailures', async () => {
    const h = await delegatedRunning()
    // guard throws -> rollback disposes packet-tool then seam; the seam disposer itself throws.
    const child = childContext(h.childAgent, 'property', { guardThrows: true, disposerThrows: ['seam'] })
    const cleanupFailures: string[] = []
    let caught: unknown
    try {
      installExecutorChildSurface(h.engine as AutopilotEngine, GATE, child, h.root.id, failure => cleanupFailures.push(failure.step))
    } catch (error: unknown) {
      caught = error
    }
    expect((caught as Error).message).toBe('inject: tools.guard failed')
    expect(child.disposed).toEqual(['packet-tool', 'seam'])
    expect(cleanupFailures).toEqual(['seam'])
    const attached = (caught as { rollbackFailures?: Array<{ step: string; error: Error }> }).rollbackFailures
    expect(attached?.map(failure => failure.step)).toEqual(['seam'])
    // The seam releases BOTH its listeners and reports their failures together, so what
    // surfaces here is that aggregate — with the injected failure inside it, not replaced.
    const seamFailure = attached?.[0]?.error as AggregateError
    expect(seamFailure).toBeInstanceOf(AggregateError)
    expect(seamFailure.message).toContain('seam release failed')
    expect((seamFailure.errors as Error[]).map(inner => inner.message)).toContain('inject: seam disposer failed')
    // Non-enumerable: a JSON-serialised error still reads as the original.
    expect(Object.keys(caught as object)).not.toContain('rollbackFailures')
  })

  it('(g) a FROZEN install error survives a failing rollback: the annotation is best-effort, the original value is rethrown', async () => {
    const h = await delegatedRunning()
    // The guard step throws a frozen Error; rollback then fails on the seam disposer, so the
    // annotation path runs against a non-extensible value and defineProperty would throw.
    const child = childContext(h.childAgent, 'property', { guardThrowsFrozen: true, disposerThrows: ['seam'] })
    const cleanupFailures: string[] = []
    let caught: unknown
    try {
      installExecutorChildSurface(h.engine as AutopilotEngine, GATE, child, h.root.id, failure => cleanupFailures.push(failure.step))
    } catch (error: unknown) {
      caught = error
    }
    // The ORIGINAL failure, not a TypeError about the annotation.
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('inject: frozen tools.guard failure')
    expect(Object.isFrozen(caught)).toBe(true)
    expect((caught as { rollbackFailures?: unknown }).rollbackFailures).toBeUndefined()
    // Rollback still ran and still reported, which is where the failures actually live.
    expect(child.disposed).toEqual(['packet-tool', 'seam'])
    expect(cleanupFailures).toEqual(['seam'])
  })

  it('(h) a THROWING onCleanupFailure during rollback stops nothing: every disposer is attempted and the ORIGINAL error propagates', async () => {
    const h = await delegatedRunning()
    // guard throws -> rollback must dispose packet-tool then seam; BOTH disposers throw and
    // the reporter throws on the first failure it is handed.
    const child = childContext(h.childAgent, 'property', { guardThrows: true, disposerThrows: ['seam', 'packet-tool'] })
    const seen: string[] = []
    let caught: unknown
    try {
      installExecutorChildSurface(h.engine as AutopilotEngine, GATE, child, h.root.id, failure => {
        seen.push(failure.step)
        throw new Error('inject: reporter failed')
      })
    } catch (error: unknown) {
      caught = error
    }
    expect((caught as Error).message).toBe('inject: tools.guard failed')
    // Both steps were attempted despite the reporter throwing on the first one.
    expect(child.disposed).toEqual(['packet-tool', 'seam'])
    expect(seen).toEqual(['packet-tool', 'seam'])
    const attached = (caught as { rollbackFailures?: Array<{ step: string }> }).rollbackFailures
    expect(attached?.map(failure => failure.step)).toEqual(['packet-tool', 'seam'])
  })

  it('(i) a THROWING onCleanupFailure on the returned disposer: every disposer is attempted and the AggregateError still names the failed steps', async () => {
    const h = await delegatedRunning()
    const child = childContext(h.childAgent, 'property', { disposerThrows: ['seam', 'egress-guard'] })
    const seen: string[] = []
    const dispose = installExecutorChildSurface(h.engine as AutopilotEngine, GATE, child, h.root.id, failure => {
      seen.push(failure.step)
      throw new Error('inject: reporter failed')
    })
    let caught: unknown
    try {
      dispose()
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as Error).message).toContain('egress-guard')
    expect((caught as Error).message).toContain('seam')
    expect(child.disposed).toEqual(['egress-guard', 'packet-tool', 'seam'])
    expect(seen).toEqual(['egress-guard', 'seam'])
  })
})
