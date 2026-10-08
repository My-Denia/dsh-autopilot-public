/**
 * The plugin mount.
 *
 * `apply()` is where the split-brain window would live if it lived anywhere, so
 * the tests below assert the ORDER of observable effects, not just that nothing
 * threw: nothing autopilot-shaped may exist until the store has resolved, and
 * exactly one store may ever be constructed for one mount.
 */

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import * as autopilotModule from '../src/index.js'

/**
 * What the plugin registered on the fake host.
 *
 * `guards` and `preExecuteListeners` are COUNTERS and are therefore not
 * `readonly`: the two `+=` sites below were TS2540 errors that neither gate
 * could see — `tsconfig.json` excluded `test/`, and vitest transpiles through
 * esbuild without typechecking. `tsconfig.test.json` now covers this tree, so
 * the declaration has to be honest about being mutated.
 */
interface Recorded {
  readonly toolNames: string[]
  guards: number
  readonly sections: string[]
  preExecuteListeners: number
  readonly provided: Record<string, unknown>
  childSetups: number
  /** Every tool DEFINITION, so a test can drive one instead of only counting names. */
  readonly toolDefs: Array<{ name?: string; execute?: (args: unknown, exec: unknown) => Promise<unknown> }>
  /** Every installed guard, so a test can ask it what it decides. */
  readonly guardFns: Array<(execution: { name: string; arguments: unknown }) => string | undefined>
  /** Everything the mount said through `ctx.logger.warn` — the store-degrade trace. */
  readonly warnings: string[]
}

/**
 * A fake host context that records what the plugin registers.
 *
 * There is no `effect` member any more, and its absence is the point: `apply()`
 * is now an ASYNC PLUGIN whose returned promise IS the fiber's lifecycle work
 * (see the real-cordis describe at the bottom of this file). A test inspects the
 * pre-store world simply by not awaiting the promise yet.
 */
/** Failure injection for the executor child a scripted `startContinuable` publishes. */
interface ChildInjection {
  registerThrows?: boolean
  guardThrows?: boolean
  disposerThrows?: ReadonlyArray<'seam' | 'packet-tool' | 'egress-guard'>
  /**
   * dsh 0.1.7+ child context: `get('agent')` is undefined and reading the
   * `agent` property throws, exactly as measured on a real 0.2.0-rc.2 host
   * (`cannot get property "agent" without inject`, cordis strict inject).
   */
  strictAgentAccess?: boolean
}

/** What the scripted child recorded: tool names, disposer order, and the agent object itself. */
interface RecordedChild {
  readonly toolNames: string[]
  readonly disposed: string[]
  agent?: unknown
}

function fakeCtx(storeRoot: string, options: { storageDomain?: unknown; seamThrows?: boolean; child?: ChildInjection; llm?: unknown } = {}) {
  const recorded: Recorded = {
    toolNames: [],
    guards: 0,
    sections: [],
    preExecuteListeners: 0,
    provided: {},
    childSetups: 0,
    toolDefs: [],
    guardFns: [],
    warnings: [],
  }
  let childSetup: ((childCtx: unknown) => () => void) | undefined

  const agentTools = {
    register(definition: unknown) {
      recorded.toolNames.push((definition as { name?: string }).name ?? '<unnamed>')
      recorded.toolDefs.push(definition as never)
      return () => {}
    },
    guard(fn?: (execution: { name: string; arguments: unknown }) => string | undefined) {
      recorded.guards += 1
      recorded.guardFns.push(fn as never)
      return () => {}
    },
  }
  const rootAgent = {
    id: 'root-session-1',
    session: { header: {}, snapshotEvents: () => [] as Array<{ type: string; data: unknown }>, append() {} },
    ctx: {
      tools: agentTools,
      on(event: string) {
        if (event === 'tools/pre-execute') {
          if (options.seamThrows === true) throw new Error('this host does not dispatch tools/pre-execute')
          recorded.preExecuteListeners += 1
        }
        return () => {}
      },
    },
    followup() {},
  }
  /** A second top-level agent, and one CHILD agent, for the admission-guard tests. */
  const otherRoot = {
    id: 'root-session-2',
    session: { header: {}, snapshotEvents: () => [] as Array<{ type: string; data: unknown }>, append() {} },
    ctx: { tools: agentTools, on: () => () => {} },
    followup() {},
  }
  const childAgent = {
    id: 'child-session-1',
    session: {
      header: { parentSession: 'root-session-1' },
      snapshotEvents: () => [] as Array<{ type: string; data: unknown }>,
      append() {},
    },
    ctx: { tools: agentTools, on: () => () => {} },
    followup() {},
  }
  const created: Array<(payload: { agent: unknown }) => void> = []
  const disposedListeners: Array<(payload: { agent: unknown }) => void> = []
  const recordedChild: RecordedChild = { toolNames: [], disposed: [] }
  /**
   * Every `ctx.on` subscription with its disposal count — F19 observes the
   * routing wiring's `llm/adapters-updated` listener through this ledger: a
   * listener the failed mount forgot to release keeps `disposals: 0`.
   */
  const subscriptions: Array<{ event: string; disposals: number }> = []
  /**
   * The rc.1 publication path, reduced to what the plugin can observe: the
   * subagent manager creates the child agent (setup, then `agent/created`
   * announced SYNCHRONOUSLY through the registered listeners) and a listener
   * that throws vetoes the creation, so `startContinuable` REJECTS. The child
   * is built from `spec.childId` — the engine mints that id — with the root as
   * its `parentSession` and its own `ctx` carrying `agent` as an own property
   * (cordis accessor semantics, see test/child-setup.test.ts).
   */
  const publishChild = (spec: { childId: string }): void => {
    const injection = options.child ?? {}
    const disposer = (step: 'seam' | 'packet-tool' | 'egress-guard') => () => {
      recordedChild.disposed.push(step)
      if (injection.disposerThrows?.includes(step)) throw new Error(`inject: ${step} disposer failed`)
    }
    const child: { id: string; session: unknown; options: unknown; ctx?: unknown } = {
      id: spec.childId,
      session: { header: { parentSession: rootAgent.id }, snapshotEvents: () => [], append() {} },
      options: {},
    }
    child.ctx = {
      ...(injection.strictAgentAccess === true ? {} : { agent: child }),
      get: () => undefined,
      tools: {
        register(definition: unknown) {
          if (injection.registerThrows === true) throw new Error('inject: child tools.register failed')
          recordedChild.toolNames.push((definition as { name?: string }).name ?? '<unnamed>')
          return disposer('packet-tool')
        },
        guard() {
          if (injection.guardThrows === true) throw new Error('inject: child tools.guard failed')
          return disposer('egress-guard')
        },
      },
      on: (event: string) => (event === 'tools/pre-execute' ? disposer('seam') : () => {}),
    }
    if (injection.strictAgentAccess === true) {
      Object.defineProperty(child.ctx, 'agent', {
        get() { throw new Error('cannot get property "agent" without inject') },
      })
    }
    recordedChild.agent = child
    for (const listener of created) listener({ agent: child })
  }

  const ctx = {
    ...(options.storageDomain === undefined ? {} : { storageDomain: options.storageDomain }),
    // F19: an `llm` runtime on the host makes `createRoutingWiring` build a
    // catalog and subscribe `llm/adapters-updated` — the listener whose
    // lifecycle the wiring-dispose tests below observe.
    ...(options.llm === undefined ? {} : { llm: options.llm }),
    agents: {
      get: (id: string) => (
        id === rootAgent.id ? rootAgent : id === otherRoot.id ? otherRoot : id === childAgent.id ? childAgent : undefined
      ),
      list: () => [rootAgent],
      // `otherRoot` is a top-level agent the host does NOT list as a root, which
      // is the third admission guard's fixture; `childAgent` carries a
      // parentSession, which is the second's.
      // `childAgent` IS listed as a root here on purpose: otherwise the
      // roots() guard would refuse it too and the parentSession fixture would be
      // over-determined — the exact shape that left half of `approvalAuthorizes`
      // unresolvable in the previous round.
      roots: () => [rootAgent as unknown, childAgent as unknown],
    },
    subagents: {
      registerContinuableSetup(setup: unknown) {
        // RECORDED, not swallowed. Since dsh 0.1.2 the plugin must NOT call
        // this (the host no longer has it); the counter proves it does not.
        recorded.childSetups += 1
        childSetup = setup as never
        return () => {}
      },
      // Scripted auditor: every dispatched audit passes (the plan audit that a
      // delegated run needs before `startExecutor`).
      async start(_provider: string, _request: unknown) {
        return {
          id: 'auditor-scripted',
          localAgent: { id: 'auditor-scripted', session: { header: {}, snapshotEvents: () => [], append() {} }, options: {} },
          result: Promise.resolve({ stopReason: 'completed', structured: { verdict: 'pass', note: 'scripted pass' } }),
          async dispose() {},
        }
      },
      // Publishes the executor child through the recorded `agent/created`
      // listeners; a synchronous listener throw rejects, as rc.1 does.
      async startContinuable(spec: { childId: string }) {
        publishChild(spec)
        return { childId: spec.childId, messageId: 'scripted-message' }
      },
      async sendMessage() { return 'scripted-message' },
      interrupt() {},
      async drainContinuableChildren() { return {} },
    },
    systemPrompt: {
      section(section: { name: string }) {
        recorded.sections.push(section.name)
        return () => {}
      },
    },
    provide(name: string, value: unknown) {
      recorded.provided[name] = value
      return () => { delete recorded.provided[name] }
    },
    // An own property of the real root Context rather than a provided service,
    // which is why the plugin reaches it through the property fallback.
    logger: {
      warn(message: string) { recorded.warnings.push(message) },
    },
    on(event: string, listener: (payload: { agent: unknown }) => void) {
      if (event === 'agent/created') created.push(listener)
      if (event === 'agent/disposed') disposedListeners.push(listener)
      const subscription = { event, disposals: 0 }
      subscriptions.push(subscription)
      return () => { subscription.disposals += 1 }
    },
  }

  return {
    ctx,
    recorded,
    rootAgent,
    storeRoot,
    childSetup: () => childSetup,
    otherRoot,
    childAgent,
    announce: (agent: unknown) => { for (const listener of created) listener({ agent }) },
    dispose: (agent: unknown) => { for (const listener of disposedListeners) listener({ agent }) },
    child: recordedChild,
    /** Disposal counts, in subscription order, for one host event (F19). */
    subscriptionDisposals: (event: string) => subscriptions.filter(s => s.event === event).map(s => s.disposals),
    /** How many listeners for one host event are still live (F19: no stale stacking). */
    liveSubscriptions: (event: string) => subscriptions.filter(s => s.event === event && s.disposals === 0).length,
  }
}

/** Counts how many times a domain was opened and closed, to catch a second store instance or a leaked name. */
function countingFacility() {
  let opens = 0
  let closes = 0
  return {
    opens: () => opens,
    closes: () => closes,
    facility: {
      open: async () => {
        opens += 1
        const tables = new Map<string, Map<string, unknown>>()
        return {
          table: (tableName: string) => {
            const store = tables.get(tableName) ?? new Map<string, unknown>()
            tables.set(tableName, store)
            return {
              get: (key: string) => store.get(key),
              entries: () => store.entries(),
              keys: () => store.keys(),
              put: async (key: string, value: unknown) => { store.set(key, value) },
            }
          },
          close: async () => { closes += 1 },
        }
      },
    },
  }
}

/**
 * The four `LlmRuntime` members `probeLlmRuntime` demands (F19 tests): gives
 * `createRoutingWiring` a catalog to build and an `llm/adapters-updated`
 * listener to subscribe. No member is ever called — these mounts never route.
 */
function stubLlmRuntime() {
  return {
    listProviders: () => [],
    listModels: async () => [],
    resolveModelInfo: async () => ({}),
    resolveCallConfig: async () => ({}),
  }
}

describe('apply', () => {
  it('registers NOTHING until the mount promise resolves (the split-brain window is empty)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const host = fakeCtx(root, {})
    const mount = apply(host.ctx, { storeRoot: root })

    // apply() has RETURNED (a pending promise) and suspended at its first await.
    // If any surface existed now, a run started in this window could bind to a
    // store the mount is about to replace.
    expect(typeof (mount as { then?: unknown }).then).toBe('function')
    expect(host.recorded.toolNames).toEqual([])
    expect(host.recorded.sections).toEqual([])
    expect(host.recorded.guards).toBe(0)
    expect(host.recorded.provided.autopilot).toBeUndefined()

    const dispose = await mount
    expect(host.recorded.sections).toEqual(['autopilot:policy'])
    expect(host.recorded.toolNames).toContain('autopilot_init')
    expect(host.recorded.toolNames).toContain('autopilot_usage')
    expect(host.recorded.guards).toBe(1)
    expect(host.recorded.preExecuteListeners).toBe(1)
    // dsh 0.1.2: the executor-child setup no longer goes through
    // `registerContinuableSetup` (the registry is gone upstream); it is
    // installed on `agent/created` for agents that carry a parentSession.
    // The registry stub therefore stays untouched, and announcing a child
    // must never throw (a throwing listener would veto the child's
    // publication). `test/child-setup.test.ts` owns what the setup does.
    expect(host.recorded.childSetups).toBe(0)
    expect(() => host.announce(host.childAgent)).not.toThrow()
    await dispose()
  })

  it('publishes a read-only ctx.autopilot that tracks the engine', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const host = fakeCtx(root, {})
    const dispose = await apply(host.ctx, { storeRoot: root })

    const service = host.recorded.provided.autopilot as {
      peek(id: string): unknown
      status(id: string): unknown
      list(): readonly string[]
      storeKind: string
    }
    expect(typeof service.peek).toBe('function')
    expect(service.storeKind).toBe('file')
    expect(service.peek('root-session-1')).toBeUndefined()
    expect(service.status('root-session-1')).toBeUndefined()
    expect(service.list()).toEqual([])
    // No mutator is exposed: the engine's single-writer authority rests on
    // proving the caller is the live root Agent, and a service handle has none.
    expect((service as unknown as Record<string, unknown>).init).toBeUndefined()
    expect((service as unknown as Record<string, unknown>).declareUsage).toBeUndefined()

    await dispose()
    expect(host.recorded.provided.autopilot).toBeUndefined()
  })

  it('opens the domain backend exactly ONCE under storeKind auto', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const counter = countingFacility()
    const host = fakeCtx(root, { storageDomain: counter.facility })
    const mount = apply(host.ctx, { storeRoot: root, storeKind: 'auto' })
    // The open STARTS synchronously inside apply() — `await resolveStore(…)`
    // evaluates the call before it suspends — but nothing autopilot-shaped
    // exists until the mount settles, which is the invariant that matters.
    expect(host.recorded.toolNames).toEqual([])

    const dispose = await mount
    expect(counter.opens()).toBe(1)
    expect((host.recorded.provided.autopilot as { storeKind: string }).storeKind).toBe('domain')
    await dispose()
    // Disposal does not re-open anything.
    expect(counter.opens()).toBe(1)
  })

  it('falls back to the file backend where no facility is mounted (headless parity)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const host = fakeCtx(root, {})
    const dispose = await apply(host.ctx, { storeRoot: root, storeKind: 'auto' })
    expect((host.recorded.provided.autopilot as { storeKind: string }).storeKind).toBe('file')
    await dispose()
  })

  it('CLOSES the domain store when a later registration throws, so the domain name is not left reserved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const counter = countingFacility()
    const host = fakeCtx(root, { storageDomain: counter.facility })
    // Anything after `await resolveStore(...)` can throw; the section registration
    // is simply the first such statement. Upstream `DomainFacility.open` refuses
    // an already-open name, so a store that is never closed downgrades EVERY
    // later mount in the process to the file backend.
    host.ctx.systemPrompt.section = () => { throw new Error('systemPrompt refused the section') }
    await expect(apply(host.ctx, { storeRoot: root, storeKind: 'auto' }))
      .rejects.toThrowError(/systemPrompt refused the section/)
    expect(counter.opens()).toBe(1)
    expect(counter.closes()).toBe(1)
  })

  // ── F19 (PR #2 Codex round 8): the routing wiring is released on failure ──
  //
  // `createRoutingWiring` subscribes `llm/adapters-updated` (and may register
  // the mirror projection) BEFORE any of the registrations that can throw. A
  // failed mount that forgot the wiring disposer left those host-surface
  // registrations behind, and every retry stacked one more stale listener.
  // The tests give the host an `llm` runtime so the wiring has something to
  // subscribe, and observe the subscription ledger above.
  it('F19: a mount that throws AFTER the wiring exists disposes it exactly once, closes the store, and rethrows unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const counter = countingFacility()
    const host = fakeCtx(root, { storageDomain: counter.facility, llm: stubLlmRuntime() })
    host.ctx.systemPrompt.section = () => { throw new Error('systemPrompt refused the section') }
    await expect(apply(host.ctx, { storeRoot: root, storeKind: 'auto', skillInstall: 'off' }))
      .rejects.toThrowError(/systemPrompt refused the section/)
    // The wiring subscribed exactly once and its disposer ran exactly once.
    expect(host.subscriptionDisposals('llm/adapters-updated')).toEqual([1])
    // The store discipline from the test above is unchanged by the new teardown.
    expect(counter.opens()).toBe(1)
    expect(counter.closes()).toBe(1)
  })

  it('F19: a CLEAN mount does not dispose the wiring at apply time — only at plugin lifecycle dispose', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const host = fakeCtx(root, { llm: stubLlmRuntime() })
    const dispose = await apply(host.ctx, { storeRoot: root, storeKind: 'file', skillInstall: 'off' })
    // Live after a successful mount: the subscription rides the lifecycle.
    expect(host.subscriptionDisposals('llm/adapters-updated')).toEqual([0])
    await dispose()
    expect(host.subscriptionDisposals('llm/adapters-updated')).toEqual([1])
  })

  it('F19: a remount after a failed mount accumulates no duplicate llm/adapters-updated listener', async () => {
    const failRoot = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const retryRoot = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const host = fakeCtx(failRoot, { llm: stubLlmRuntime() })
    const originalSection = host.ctx.systemPrompt.section.bind(host.ctx.systemPrompt)
    host.ctx.systemPrompt.section = () => { throw new Error('systemPrompt refused the section') }
    await expect(apply(host.ctx, { storeRoot: failRoot, storeKind: 'file', skillInstall: 'off' }))
      .rejects.toThrowError(/systemPrompt refused the section/)
    host.ctx.systemPrompt.section = originalSection
    const dispose = await apply(host.ctx, { storeRoot: retryRoot, storeKind: 'file', skillInstall: 'off' })
    // Two subscriptions were made, but only the SECOND is still live — the
    // failed mount's listener was released instead of stacking beneath it.
    expect(host.subscriptionDisposals('llm/adapters-updated')).toEqual([1, 0])
    expect(host.liveSubscriptions('llm/adapters-updated')).toBe(1)
    await dispose()
    expect(host.liveSubscriptions('llm/adapters-updated')).toBe(0)
  })

  it('positive control: a clean mount closes the store exactly once, at disposal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const counter = countingFacility()
    const host = fakeCtx(root, { storageDomain: counter.facility })
    const dispose = await apply(host.ctx, { storeRoot: root, storeKind: 'auto' })
    expect(counter.closes()).toBe(0)
    await dispose()
    expect(counter.closes()).toBe(1)
  })

  it('storeKind domain rejects the whole mount rather than mounting files behind the operator', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const host = fakeCtx(root, {})
    await expect(apply(host.ctx, { storeRoot: root, storeKind: 'domain' }))
      .rejects.toThrowError(/ctx.storageDomain is not observable/)
    // and nothing was registered on the way down
    expect(host.recorded.toolNames).toEqual([])
  })
})

/**
 * `storeKind: 'auto'` degrading to files, and the trace it now leaves.
 *
 * `enforcement.store` records WHICH backend a run got. It cannot record what the
 * deployment was supposed to get, so 'file' reads identically on a headless
 * profile that has no `ctx.storageDomain` (nothing wrong) and on a web-app
 * profile whose facility threw (very wrong). The 'auto' branch used to swallow
 * the second in a bare `catch {}`: the thrown error — the only thing that said
 * WHAT broke — was discarded at the point it was caught.
 */
describe('apply: a degraded store says why', () => {
  it('names the missing facility when the deployment simply has none', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const host = fakeCtx(root, {})
    const dispose = await apply(host.ctx, { storeRoot: root, storeKind: 'auto', skillInstall: 'off' })
    expect(host.recorded.warnings).toHaveLength(1)
    expect(host.recorded.warnings[0]).toContain('storageDomain is not observable')
    expect(host.recorded.warnings[0]).toContain('file')
    await dispose()
  })

  it('carries the thrown reason through when a facility exists but cannot open', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const host = fakeCtx(root, {
      storageDomain: { open: async () => { throw new Error('domain "dsh-autopilot" is already open') } },
    })
    const dispose = await apply(host.ctx, { storeRoot: root, storeKind: 'auto', skillInstall: 'off' })
    // The run still starts — 'auto' means 'auto' — but the reason is no longer
    // indistinguishable from "this deployment has no storageDomain".
    expect((host.recorded.provided.autopilot as { storeKind: string }).storeKind).toBe('file')
    expect(host.recorded.warnings[0]).toContain('is already open')
    await dispose()
  })

  it('POSITIVE CONTROL: a mount that got the backend it wanted says nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const counter = countingFacility()
    const host = fakeCtx(root, { storageDomain: counter.facility })
    const dispose = await apply(host.ctx, { storeRoot: root, storeKind: 'auto', skillInstall: 'off' })
    expect(host.recorded.warnings).toEqual([])
    await dispose()

    // ...and so does an operator who ASKED for files.
    const plain = fakeCtx(root, { storageDomain: counter.facility })
    const disposePlain = await apply(plain.ctx, { storeRoot: root, storeKind: 'file', skillInstall: 'off' })
    expect(plain.recorded.warnings).toEqual([])
    await disposePlain()
  })

  it('does not persist SKILL.md when a later registration throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const destHome = mkdtempSync(join(tmpdir(), 'dsh-autopilot-skill-fail-'))
    const prev = process.env.DSH_AUTOPILOT_SKILL_HOME
    process.env.DSH_AUTOPILOT_SKILL_HOME = destHome
    try {
      const host = fakeCtx(root)
      host.ctx.systemPrompt.section = () => { throw new Error('systemPrompt refused the section') }
      await expect(apply(host.ctx, { storeRoot: root, storeKind: 'file' }))
        .rejects.toThrowError(/systemPrompt refused the section/)
      expect(existsSync(join(destHome, 'skills', 'dsh-autopilot', 'SKILL.md'))).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.DSH_AUTOPILOT_SKILL_HOME
      else process.env.DSH_AUTOPILOT_SKILL_HOME = prev
    }
  })

  it('skillInstall auto copies the bundled skill into a unique scan root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const destHome = mkdtempSync(join(tmpdir(), 'dsh-autopilot-skill-auto-'))
    const prev = process.env.DSH_AUTOPILOT_SKILL_HOME
    process.env.DSH_AUTOPILOT_SKILL_HOME = destHome
    try {
      const host = fakeCtx(root)
      const dispose = await apply(host.ctx, { storeRoot: root, storeKind: 'file' })
      const dest = join(destHome, 'skills', 'dsh-autopilot', 'SKILL.md')
      expect(existsSync(dest)).toBe(true)
      expect(host.recorded.warnings).toEqual([])
      await dispose()
    } finally {
      if (prev === undefined) delete process.env.DSH_AUTOPILOT_SKILL_HOME
      else process.env.DSH_AUTOPILOT_SKILL_HOME = prev
    }
  })

  it('skillInstall off does not copy into a unique skill home', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const destHome = mkdtempSync(join(tmpdir(), 'dsh-autopilot-skill-off-'))
    const prev = process.env.DSH_AUTOPILOT_SKILL_HOME
    process.env.DSH_AUTOPILOT_SKILL_HOME = destHome
    try {
      const host = fakeCtx(root)
      const dispose = await apply(host.ctx, { storeRoot: root, skillInstall: 'off' })
      expect(existsSync(join(destHome, 'skills', 'dsh-autopilot', 'SKILL.md'))).toBe(false)
      await dispose()
    } finally {
      if (prev === undefined) delete process.env.DSH_AUTOPILOT_SKILL_HOME
      else process.env.DSH_AUTOPILOT_SKILL_HOME = prev
    }
  })

  it('a host with no logger still mounts — a diagnostic may not decide whether the harness exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const host = fakeCtx(root, {})
    delete (host.ctx as { logger?: unknown }).logger
    const dispose = await apply(host.ctx, { storeRoot: root, storeKind: 'auto' })
    expect(host.recorded.toolNames).toContain('autopilot_init')
    await dispose()
  })
})

/**
 * The three ROOT-ADMISSION guards in `apply()`'s `maybeInstall`, none of which
 * had a bearer before 2026-08-25: removing any one of them left 394 tests green.
 *
 * What each one prevents is different, and neither is cosmetic:
 * - the idempotency guard stops a re-announced root from stacking a SECOND
 *   guard, a second seam and a second copy of every tool, so one tool call gets
 *   decided twice and every deny reason is emitted twice;
 * - the parentSession guard stops a CHILD agent from receiving the full ROOT
 *   wiring (root tools, a root gate, a pre-execute seam registered against the
 *   child's own id);
 * - the roots() guard stops the same for an agent the host does not consider a
 *   root at all.
 */
describe('apply: which agents get the root surface', () => {
  async function mounted() {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const host = fakeCtx(root, {})
    const dispose = await apply(host.ctx, { storeRoot: root })
    return { host, dispose }
  }

  it('a re-announced root is installed ONCE, not stacked', async () => {
    const { host, dispose } = await mounted()
    const toolsAfterFirst = host.recorded.toolNames.length
    expect(host.recorded.guards).toBe(1)
    expect(host.recorded.preExecuteListeners).toBe(1)

    host.announce(host.rootAgent)
    host.announce(host.rootAgent)

    expect(host.recorded.guards).toBe(1)
    expect(host.recorded.preExecuteListeners).toBe(1)
    expect(host.recorded.toolNames).toHaveLength(toolsAfterFirst)
    await dispose()
  })

  it('a CHILD agent gets no root surface at all', async () => {
    const { host, dispose } = await mounted()
    // The host DOES list it as a root, so the parentSession guard is the only
    // thing that can refuse it.
    expect(host.ctx.agents.roots()).toContain(host.childAgent as unknown)
    expect(host.childAgent.session.header.parentSession).toBe('root-session-1')
    const before = {
      tools: host.recorded.toolNames.length,
      guards: host.recorded.guards,
      seams: host.recorded.preExecuteListeners,
    }
    host.announce(host.childAgent)
    expect(host.recorded.toolNames).toHaveLength(before.tools)
    expect(host.recorded.guards).toBe(before.guards)
    expect(host.recorded.preExecuteListeners).toBe(before.seams)
    await dispose()
  })

  it('a top-level agent the host does not list as a root gets no root surface either', async () => {
    const { host, dispose } = await mounted()
    const before = {
      tools: host.recorded.toolNames.length,
      guards: host.recorded.guards,
      seams: host.recorded.preExecuteListeners,
    }
    // No parentSession, so only `ctx.agents.roots()` can tell it apart — and
    // `childAgent` is listed as a root, so only the parentSession guard can tell
    // THAT one apart. Neither fixture is refused twice.
    expect(host.otherRoot.session.header).toEqual({})
    host.announce(host.otherRoot)
    expect(host.recorded.toolNames).toHaveLength(before.tools)
    expect(host.recorded.guards).toBe(before.guards)
    expect(host.recorded.preExecuteListeners).toBe(before.seams)
    await dispose()
  })
})

/**
 * The seam-status -> `enforcement.egress` path, end to end through the real
 * mount (2026-08-25). `resolveEgressChannel` had unit fixtures for (true) and
 * (false); what nobody observed was that the CALL SITES are fed the seam status
 * actually measured for THIS root. Mutating `seamByRoot.set(id, true)` or
 * hardcoding the argument left the suite green, and the run would then persist
 * 'native-ask' for a boundary nothing was enforcing.
 */
describe('apply: enforcement.egress reports the seam this root actually got', () => {
  async function initRun(host: ReturnType<typeof fakeCtx>) {
    const init = host.recorded.toolDefs.find(definition => definition.name === 'autopilot_init')
    if (init?.execute === undefined) throw new Error('autopilot_init was not registered')
    await init.execute({
      objective: 'probe the egress channel',
      scope: ['src/'],
      nonGoals: ['docs/'],
      acceptanceCriteria: ['the record is honest'],
      risk: 'low',
      size: 'lightweight',
      executionMode: 'inline',
      auditMode: 'self-check',
    }, { agent: host.rootAgent, signal: new AbortController().signal })
    const service = host.recorded.provided.autopilot as {
      peek(id: string): { enforcement: { egress: string } } | undefined
    }
    return service.peek(host.rootAgent.id)?.enforcement.egress
  }

  it('records native-ask when the seam installed on this root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const host = fakeCtx(root, {})
    const dispose = await apply(host.ctx, { storeRoot: root })
    expect(host.recorded.preExecuteListeners).toBe(1)
    expect(await initRun(host)).toBe('native-ask')
    await dispose()
  })

  it('records guard-deny when the host refuses the pre-execute listener, and the guard then denies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const host = fakeCtx(root, { seamThrows: true })
    const dispose = await apply(host.ctx, { storeRoot: root })
    // The seam did NOT install, and the rest of the root surface still did —
    // this is the fail-closed configuration, not a failed mount.
    expect(host.recorded.preExecuteListeners).toBe(0)
    expect(host.recorded.guards).toBe(1)
    expect(host.recorded.toolNames).toContain('autopilot_init')
    expect(await initRun(host)).toBe('guard-deny')

    // AND the GUARD this root got is configured from the same observation: it
    // denies the egress outright instead of standing down for a seam that is not
    // there. Recording 'guard-deny' while the guard defers would be the same
    // defect wearing an honest label.
    const guard = host.recorded.guardFns[0]
    if (guard === undefined) throw new Error('no root guard was installed')
    expect(guard({ name: 'bash', arguments: { command: 'git push origin main' } }))
      .toContain('owner-only boundary')
    expect(guard({ name: 'write', arguments: { path: 'x' } })).toBeUndefined()
    await dispose()
  })

  it('DETECTOR: with the seam installed the same guard DEFERS instead of denying', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const host = fakeCtx(root, {})
    const dispose = await apply(host.ctx, { storeRoot: root })
    await initRun(host)
    const guard = host.recorded.guardFns[0]
    if (guard === undefined) throw new Error('no root guard was installed')
    expect(guard({ name: 'bash', arguments: { command: 'git push origin main' } })).toBeUndefined()
    await dispose()
  })
})


/**
 * THE MOUNT-TIME RACE, CROSSED THROUGH THE REAL CORDIS FIBER.
 *
 * Every test above drives `apply()` directly, so none of them can observe the
 * thing that actually broke on the real dsh host: WHEN the host considers this
 * plugin mounted. That is not a property of `apply()`, it is a property of the
 * fiber cordis wraps it in, and the fake host in this file has no fiber at all.
 * So this block builds a REAL `Context` from `@deepseek-ai/cordis`, mounts the
 * REAL module through its REAL `Config` schema (cordis validates config on the
 * way in), and asks the exact question the host asks.
 *
 * The seam under test, stated as the chain the production code depends on:
 * `boot()` awaits `loader.await()` and then refuses any entry that is not ACTIVE
 * (`packages/boot/app-boot/src/index.ts`); `EntryTree.await()` waits on
 * `entry.fiber?.inertia` (`vendor/loader/src/config/tree.ts`); `inertia` is the
 * `_reload()` promise, and `_reload()` awaits `_execute(runner)`, whose runner is
 * `runtime.callback(ctx, config)` — this module's `apply` — taking the
 * `'then' in effect` branch when it returns a promise
 * (`vendor/cordis/src/fiber.ts`). The headless runner leans on that same chain in
 * so many words before it creates the first Agent
 * (`packages/bundle/headless/src/index.ts`).
 *
 * WHAT THE OLD SHAPE DID. Registering inside `ctx.effect(async …)` and returning
 * `void` put the store behind a promise NOTHING in that chain awaits, so the
 * fiber reported mounted with an empty surface and the runner composed its first
 * request with 25 tools and 0 `autopilot_*` instead of 36 and 11. Under that
 * shape the timing-free assertion below reads an empty array.
 */
describe('apply through a REAL cordis fiber', () => {
  /** A facility whose `open()` cannot resolve until the test releases it. */
  function gatedFacility() {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    return {
      release: () => { release() },
      facility: {
        open: async () => {
          await gate
          const tables = new Map<string, Map<string, unknown>>()
          return {
            table: (tableName: string) => {
              const store = tables.get(tableName) ?? new Map<string, unknown>()
              tables.set(tableName, store)
              return {
                get: (key: string) => store.get(key),
                entries: () => store.entries(),
                keys: () => store.keys(),
                put: async (key: string, value: unknown) => { store.set(key, value) },
              }
            },
            close: async () => {},
          }
        },
      },
    }
  }

  /** A real root Context carrying the four injected services the plugin declares. */
  function realHost(storageDomain?: unknown) {
    const toolNames: string[] = []
    const agentTools = {
      register(definition: unknown) {
        toolNames.push((definition as { name?: string }).name ?? '<unnamed>')
        return () => {}
      },
      guard() { return () => {} },
    }
    const rootAgent = {
      id: 'root-session-real',
      session: { header: {}, snapshotEvents: () => [] as Array<{ type: string; data: unknown }>, append() {} },
      ctx: { tools: agentTools, on: () => () => {} },
      followup() {},
    }
    const ctx = new Context()
    ctx.provide('agents', {
      get: (id: string) => (id === rootAgent.id ? rootAgent : undefined),
      list: () => [rootAgent],
      roots: () => [rootAgent as unknown],
    })
    ctx.provide('subagents', { registerContinuableSetup: () => () => {} })
    ctx.provide('tools', {})
    ctx.provide('systemPrompt', { section: () => () => {} })
    if (storageDomain !== undefined) ctx.provide('storageDomain', storageDomain)
    return { ctx, toolNames }
  }

  /** Mount the real module on a real fiber; `await`ing the result is the host's own wait. */
  function mount(ctx: Context, config: unknown) {
    return ctx.plugin(autopilotModule as unknown as Parameters<typeof ctx.plugin>[0], config)
  }

  it('does not report the plugin mounted until the store resolved, then carries the whole root tool surface', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-real-'))
    const gated = gatedFacility()
    const { ctx, toolNames } = realHost(gated.facility)

    const fiber = mount(ctx, { storeRoot: root, storeKind: 'auto' })

    // The host's own wait, in flight. Nothing may complete it while `open()` is
    // gated — and this test holds the gate, so the delay below is bounded by an
    // explicit fact rather than by hope.
    let mounted = false
    const hostWait = (async () => { await fiber; mounted = true })()
    await new Promise((resolve) => { setTimeout(resolve, 25) })
    expect(mounted).toBe(false)
    expect(toolNames).toEqual([])

    gated.release()
    await hostWait
    expect(mounted).toBe(true)

    // The assertion that needs no timing at all: by the time the host's wait has
    // returned, the tool surface EXISTS. This is the one the live defect failed.
    // Assert the SET, not the count. A bare length is a moving anchor: it goes
    // red when a tool is added and the cheapest way to make it green again is
    // to bump the number, which is exactly how a surface silently loses a tool
    // in the other direction. Naming them makes every change deliberate.
    const autopilotTools = toolNames.filter(tool => tool.startsWith('autopilot_')).sort()
    expect(autopilotTools).toEqual([
      'autopilot_audit',
      'autopilot_external_audit',
      'autopilot_executor',
      'autopilot_init',
      'autopilot_log',
      'autopilot_self_check',
      'autopilot_signal',
      'autopilot_status',
      'autopilot_submit_closeout',
      'autopilot_submit_evidence',
      'autopilot_submit_plan',
      'autopilot_usage',
    ].sort())

    await ctx.fiber.dispose()
  })

  it('a store that cannot open FAILS the mount instead of booting a harness with no harness in it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-real-'))
    // storeKind 'domain' on a deployment with no facility: the operator asked for
    // a backend this deployment does not have. The fiber rejects, which is what
    // `assertEntriesActivated` turns into a refusal to boot. Fail-closed beats
    // starting a harness with no harness in it.
    const { ctx, toolNames } = realHost()
    const fiber = mount(ctx, { storeRoot: root, storeKind: 'domain' })
    await expect((async () => { await fiber })()).rejects.toThrowError(/ctx.storageDomain is not observable/)
    expect(toolNames).toEqual([])
    await ctx.fiber.dispose()
  })

  it('REFUSES a profile the declared schema does not accept, through the real cordis validation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-real-'))
    const { ctx, toolNames } = realHost()
    // cordis validates `runtime.Config` before it ever calls apply, so a typo in
    // a profile cannot reach this plugin as a silent default. `test/config.test.ts`
    // drives the same schema through `['~standard'].validate` directly; this is
    // the half that proves cordis actually consults it.
    const fiber = mount(ctx, { storeRoot: root, storeKindd: 'domain' })
    await expect((async () => { await fiber })()).rejects.toThrowError(/storeKindd/)
    expect(toolNames).toEqual([])
    await ctx.fiber.dispose()
  })
})

/**
 * The executor child published through agent/created — the rc.1 publication
 * path reduced to what the plugin can observe (owner ruling 2026-09-04, Codex
 * P2 3933411711 on PR #6). `test/host-publication.test.ts` measures, against
 * the REAL rc.1 `AgentRegistry`, that a throwing `agent/created` listener
 * vetoes `announce()`; these cases pick up from there: the scripted
 * `startContinuable` publishes the child through the plugin's own listener and
 * rejects on a throw, so what the ENGINE records is observable.
 */
describe('apply: executor child published through agent/created (transactional, fail-closed)', () => {
  const EXEC = (agent: unknown) => ({ agent, signal: new AbortController().signal })

  /** Drive a standard delegated run to the plan-gate pass, then start the executor. */
  async function startExecutor(host: ReturnType<typeof fakeCtx>): Promise<unknown> {
    const tool = (name: string) => {
      const def = host.recorded.toolDefs.find(definition => definition.name === name)
      if (def?.execute === undefined) throw new Error(`${name} was not registered`)
      return def.execute
    }
    await tool('autopilot_init')({
      objective: 'publish the executor child',
      scope: ['src/'],
      nonGoals: ['docs/'],
      acceptanceCriteria: ['the child can submit its packet'],
      risk: 'medium',
      size: 'standard',
      executionMode: 'delegated',
      auditMode: 'independent',
      usageIds: ['m1'],
    }, EXEC(host.rootAgent))
    await tool('autopilot_usage')({ id: 'm1', usageClass: 'internal' }, EXEC(host.rootAgent))
    await tool('autopilot_submit_plan')({ text: 'one milestone' }, EXEC(host.rootAgent))
    await tool('autopilot_audit')({ role: 'plan', prompt: 'audit the plan' }, EXEC(host.rootAgent))
    return tool('autopilot_executor')({ action: 'start', prompt: 'go' }, EXEC(host.rootAgent))
  }

  function executorOf(host: ReturnType<typeof fakeCtx>) {
    const service = host.recorded.provided.autopilot as {
      peek(id: string): { executor?: { state: string; childId: string; route?: { routeDiagnostic?: string } }; diagnostic?: string } | undefined
    }
    return service.peek(host.rootAgent.id)
  }

  it('(g) a recognized executor whose surface fails to install is REVOKED, never running, with the failure as its diagnostic', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const host = fakeCtx(root, { child: { registerThrows: true } })
    const dispose = await apply(host.ctx, { storeRoot: root })

    await expect(startExecutor(host)).rejects.toThrow('inject: child tools.register failed')
    const run = executorOf(host)
    expect(run?.executor?.state).toBe('revoked')
    expect(run?.executor?.route?.routeDiagnostic ?? '').toMatch(/executor startup failed: .*inject: child tools.register failed/)
    // The seam had installed before the packet tool threw, and was rolled back.
    expect(host.child.toolNames).toEqual([])
    expect(host.child.disposed).toEqual(['seam'])
    // Nothing is tracked for that child: its `agent/disposed` disposes NOTHING
    // and warns NOTHING — the observable for "childInstalled has no entry".
    const warningsBefore = host.recorded.warnings.length
    host.dispose(host.child.agent)
    expect(host.child.disposed).toEqual(['seam'])
    expect(host.recorded.warnings).toHaveLength(warningsBefore)
    await dispose()
  })

  it('(h) a healthy executor child runs with autopilot_submit_packet in ITS scope and is released exactly once on agent/disposed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const host = fakeCtx(root, {})
    const dispose = await apply(host.ctx, { storeRoot: root })

    await startExecutor(host)
    const run = executorOf(host)
    expect(run?.executor?.state).toBe('running')
    expect(host.child.toolNames).toEqual(['autopilot_submit_packet'])
    expect(host.child.disposed).toEqual([])
    host.dispose(host.child.agent)
    expect(host.child.disposed).toEqual(['egress-guard', 'packet-tool', 'seam'])
    host.dispose(host.child.agent)
    expect(host.child.disposed).toHaveLength(3)
    expect(host.recorded.warnings.filter(w => w.includes('child surface'))).toEqual([])
    await dispose()
  })

  it('(h2) on a dsh 0.2 child context (reading ctx.agent throws) the executor is still recognized from the announced agent', async () => {
    // RED before the fix: recognition read `childCtx.agent`, the throw was
    // swallowed as "not recognized", and the executor ran with NO packet tool.
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const host = fakeCtx(root, { child: { strictAgentAccess: true } })
    const dispose = await apply(host.ctx, { storeRoot: root })

    await startExecutor(host)
    expect(executorOf(host)?.executor?.state).toBe('running')
    expect(host.child.toolNames).toEqual(['autopilot_submit_packet'])
    host.dispose(host.child.agent)
    expect(host.child.disposed).toEqual(['egress-guard', 'packet-tool', 'seam'])
    await dispose()
  })

  it('(i) an unrelated child announced with every injection armed is a no-op: nothing installed, nothing thrown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const host = fakeCtx(root, { child: { registerThrows: true, guardThrows: true } })
    const dispose = await apply(host.ctx, { storeRoot: root })
    // No run at all: any child is unrelated. Publish one directly.
    const stranger = {
      id: 'stranger-child',
      session: { header: { parentSession: host.rootAgent.id }, snapshotEvents: () => [], append() {} },
      options: {},
      ctx: {
        agent: undefined as unknown,
        get: () => undefined,
        tools: { register() { throw new Error('must not be called') }, guard() { throw new Error('must not be called') } },
        on: () => () => {},
      },
    }
    stranger.ctx.agent = stranger
    expect(() => host.announce(stranger)).not.toThrow()
    expect(() => host.dispose(stranger)).not.toThrow()
    expect(host.recorded.warnings.filter(w => w.includes('child surface'))).toEqual([])
    await dispose()
  })

  it('(j) a disposer that throws on agent/disposed: the other disposers still run, one release warn (the step-level cleanup warn also fires once), the listener does not throw, the entry is gone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-apply-'))
    const host = fakeCtx(root, { child: { disposerThrows: ['packet-tool'] } })
    const dispose = await apply(host.ctx, { storeRoot: root })

    await startExecutor(host)
    expect(executorOf(host)?.executor?.state).toBe('running')
    expect(() => host.dispose(host.child.agent)).not.toThrow()
    expect(host.child.disposed).toEqual(['egress-guard', 'packet-tool', 'seam'])
    const releaseWarnings = host.recorded.warnings.filter(w => w.includes('child surface release failed'))
    expect(releaseWarnings).toHaveLength(1)
    expect(releaseWarnings[0]).toMatch(/packet-tool/)
    // Entry removed: a second agent/disposed does nothing at all.
    host.dispose(host.child.agent)
    expect(host.child.disposed).toHaveLength(3)
    expect(host.recorded.warnings.filter(w => w.includes('child surface release failed'))).toHaveLength(1)
    await dispose()
  })
})
