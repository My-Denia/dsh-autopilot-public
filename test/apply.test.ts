/**
 * The plugin mount.
 *
 * `apply()` is where the split-brain window would live if it lived anywhere, so
 * the tests below assert the ORDER of observable effects, not just that nothing
 * threw: nothing autopilot-shaped may exist until the store has resolved, and
 * exactly one domain handle may ever be opened for one mount. They also drive the
 * 0.3.0 session-open work end to end: `agent/created` of a root runs the lost
 * marking and the lazy sandbox restore before the host's serial dispatch returns.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, RETIRED_CONFIG_KEYS } from '../src/index.js'
import * as autopilotModule from '../src/index.js'
import { FileLedgerStore, emptyLedger } from '../src/store/ledger.js'
import { delegation } from './helpers.js'

/** What the plugin registered on the fake host. */
interface Recorded {
  readonly toolNames: string[]
  readonly sections: string[]
  /** Every section DEFINITION, so a test can render one instead of only counting names. */
  readonly sectionDefs: Array<{ name: string; order?: number; text: (context: { agent?: unknown }) => string }>
  readonly provided: Record<string, unknown>
  /** Every tool DEFINITION, so a test can drive one instead of only counting names. */
  readonly toolDefs: Array<{ name?: string; execute?: (args: unknown, exec: unknown) => Promise<unknown> }>
  /** Everything the mount said through `ctx.logger.warn`. */
  readonly warnings: string[]
}

interface FakeOptions {
  storageDomain?: unknown
  llm?: unknown
  strictServiceAccess?: boolean
  /** The root agent's id (a legacy session id for the restore tests). */
  rootId?: string
  /** `sandbox/mode` (and other) events already in the root session's log. */
  rootEvents?: Array<{ type: string; data: unknown }>
  /** `ctx.sandboxPolicy.defaultMode`. */
  sandboxDefaultMode?: string
  /** The root is already live when the plugin mounts. */
  rootLiveAtMount?: boolean
  /** Ids the host still holds as live agents (children that survived). */
  residentIds?: readonly string[]
  /** `ctx.goals`, the native goal service (`get(agent)` returns the current goal view). */
  goals?: unknown
}

function fakeCtx(storeRoot: string, options: FakeOptions = {}) {
  const recorded: Recorded = { toolNames: [], sections: [], sectionDefs: [], provided: {}, toolDefs: [], warnings: [] }
  const agentTools = {
    register(definition: unknown) {
      recorded.toolNames.push((definition as { name?: string }).name ?? '<unnamed>')
      recorded.toolDefs.push(definition as never)
      return () => {}
    },
  }
  const events: Array<{ type: string; data: unknown }> = [...(options.rootEvents ?? [])]
  const rootAgent = {
    id: options.rootId ?? 'root-session-1',
    session: {
      header: {},
      snapshotEvents: () => events.slice(),
      append(type: string, data: unknown) { events.push({ type, data }) },
    },
    ctx: { tools: agentTools, on: () => () => {} },
  }
  /** A second top-level agent the host does NOT list as a root, and one CHILD agent. */
  const otherRoot = {
    id: 'root-session-2',
    session: { header: {}, snapshotEvents: () => [] as Array<{ type: string; data: unknown }>, append() {} },
    ctx: { tools: agentTools, on: () => () => {} },
  }
  const childAgent = {
    id: 'child-session-1',
    session: { header: { parentSession: rootAgent.id }, snapshotEvents: () => [] as Array<{ type: string; data: unknown }>, append() {} },
    ctx: { tools: agentTools, on: () => () => {} },
  }
  const created: Array<(payload: { agent: unknown }) => unknown> = []
  const disposedListeners: Array<(payload: { agent: unknown }) => void> = []
  /** Every `ctx.on` subscription with its disposal count (F19 observes the wiring's listener through it). */
  const subscriptions: Array<{ event: string; disposals: number }> = []
  /** Every listener by event, so a test can emit a host event the plugin subscribed to. */
  const listeners: Array<{ event: string; listener: (payload: never) => unknown; subscription: { disposals: number } }> = []
  const resident = new Set(options.residentIds ?? [])

  const ctx = {
    ...(options.storageDomain === undefined ? {} : { storageDomain: options.storageDomain }),
    ...(options.llm === undefined ? {} : { llm: options.llm }),
    ...(options.goals === undefined ? {} : { goals: options.goals }),
    ...(options.sandboxDefaultMode === undefined ? {} : { sandboxPolicy: { defaultMode: options.sandboxDefaultMode } }),
    agents: {
      get: (id: string) => (
        id === rootAgent.id ? rootAgent
          : id === otherRoot.id ? otherRoot
            : id === childAgent.id ? childAgent
              : resident.has(id) ? { id, session: { header: { parentSession: rootAgent.id }, snapshotEvents: () => [], append() {} } }
                : undefined
      ),
      list: () => (options.rootLiveAtMount === false ? [] : [rootAgent]),
      // `childAgent` IS listed as a root on purpose: otherwise the roots() guard would refuse it too and
      // the parentSession fixture would be over-determined.
      roots: () => [rootAgent as unknown, childAgent as unknown],
    },
    subagents: {},
    systemPrompt: {
      section(section: { name: string; order?: number; text: (context: { agent?: unknown }) => string }) {
        recorded.sections.push(section.name)
        recorded.sectionDefs.push(section)
        return () => {}
      },
    },
    provide(name: string, value: unknown) {
      recorded.provided[name] = value
      return () => { delete recorded.provided[name] }
    },
    // An own property of the real root Context rather than a provided service.
    logger: {
      warn(message: string) { recorded.warnings.push(message) },
    },
    on(event: string, listener: (payload: { agent: unknown }) => unknown) {
      if (event === 'agent/created') created.push(listener)
      if (event === 'agent/disposed') disposedListeners.push(listener as never)
      const subscription = { event, disposals: 0 }
      subscriptions.push(subscription)
      listeners.push({ event, listener: listener as never, subscription })
      return () => { subscription.disposals += 1 }
    },
  }

  /**
   * cordis reads an UNDECLARED service through a strict accessor that THROWS
   * (`cannot get property "x" without inject`), which a plain object fake cannot
   * reproduce. Measured on a real headless 0.2.0 host, a bare property read took
   * the whole plugin down at first render; this mode keeps the fake honest.
   * cordis's own Context API is exempt: only UNDECLARED SERVICE reads throw.
   */
  const contextApi = new Set(['get', 'set', 'inject', 'on', 'provide', 'effect', 'then', 'toJSON', 'inspect', 'constructor'])
  const strictCtx = options.strictServiceAccess === true
    ? new Proxy(ctx, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && !(prop in target) && !contextApi.has(prop)) {
          throw new Error(`cannot get property "${prop}" without inject`)
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    : ctx

  return {
    ctx: strictCtx,
    recorded,
    rootAgent,
    rootEvents: events,
    storeRoot,
    otherRoot,
    childAgent,
    /** The host's serial `agent/created` dispatch: every listener is awaited, a rejection propagates. */
    announce: async (agent: unknown) => { for (const listener of created) await listener({ agent }) },
    dispose: (agent: unknown) => { for (const listener of disposedListeners) listener({ agent }) },
    subscriptionDisposals: (event: string) => subscriptions.filter(s => s.event === event).map(s => s.disposals),
    liveSubscriptions: (event: string) => subscriptions.filter(s => s.event === event && s.disposals === 0).length,
    /** A host `ctx.emit` to every live listener of `event`, as the host's emit does (results not awaited). */
    emit: (event: string, payload: unknown) => {
      for (const entry of listeners) if (entry.event === event && entry.subscription.disposals === 0) void entry.listener(payload as never)
    },
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


/** The root tool surface: status, delegate, wait (agents). Children get their own scope tools. */
const ROOT_TOOLS = ['autopilot_status', 'autopilot_delegate', 'autopilot_agents']

const tmp = (label = 'apply'): string => mkdtempSync(join(tmpdir(), `dsh-autopilot-${label}-`))
const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'legacy-synthetic')

function putLegacyRun(root: string, name: string): string {
  const raw = readFileSync(join(FIXTURES, name), 'utf8')
  const runId = (JSON.parse(raw.split('\n')[0]!) as { snapshot: { runId: string } }).snapshot.runId
  mkdirSync(join(root, 'runs', runId), { recursive: true })
  writeFileSync(join(root, 'runs', runId, 'events.jsonl'), raw)
  return runId
}

const mode = (value: string) => ({ type: 'sandbox/mode', data: { mode: value } })

describe('apply', () => {
  it('registers NOTHING until the mount promise resolves (the split-brain window is empty)', async () => {
    const root = tmp()
    const host = fakeCtx(root, {})
    const mount = apply(host.ctx, { storeRoot: root })

    // apply() has RETURNED (a pending promise) and suspended at its first await. If any surface existed
    // now, a session admitted in this window could bind to a store the mount is about to replace.
    expect(typeof (mount as { then?: unknown }).then).toBe('function')
    expect(host.recorded.toolNames).toEqual([])
    expect(host.recorded.sections).toEqual([])
    expect(host.recorded.provided.autopilot).toBeUndefined()

    const dispose = await mount
    expect(host.recorded.sections).toEqual(['autopilot:policy', 'autopilot:routing-onboarding'])
    expect(host.recorded.toolNames).toEqual(ROOT_TOOLS)
    await expect(host.announce(host.childAgent)).resolves.toBeUndefined()
    await dispose()
  })

  it('publishes a read-only ctx.autopilot over the ledger store and the legacy runs', async () => {
    const root = tmp()
    putLegacyRun(root, 'external-audit.jsonl')
    const host = fakeCtx(root, {})
    const dispose = await apply(host.ctx, { storeRoot: root })

    const service = host.recorded.provided.autopilot as {
      ledger(id: string): Promise<unknown>
      ledgers(): Promise<readonly unknown[]>
      legacyRuns(): Promise<ReadonlyArray<{ runId: string }>>
      legacyRun(id: string): Promise<{ runId: string } | undefined>
      notes(): readonly string[]
      storeKind: string
    }
    expect(service.storeKind).toBe('file')
    expect(await service.ledger('root-session-1')).toBeUndefined()
    expect(await service.ledgers()).toEqual([])
    expect((await service.legacyRuns()).map(run => run.runId)).toEqual(['syn-external-audit'])
    expect((await service.legacyRun('syn-external-audit'))?.runId).toBe('syn-external-audit')
    expect(service.notes()).toEqual([])
    // No mutator is exposed: the ledger is written by the engine alone, under the live root Agent.
    for (const name of ['init', 'mutate', 'write', 'declareUsage']) {
      expect((service as unknown as Record<string, unknown>)[name]).toBeUndefined()
    }

    await dispose()
    expect(host.recorded.provided.autopilot).toBeUndefined()
  })

  // The ledger used to go into the domain's `ledgers` table when a facility was mounted. The host's
  // JSON backend republishes that whole domain file on every put, so two processes lost each other's
  // rows; the ledger now always goes to its own file, and the domain is opened only to read.
  it('opens the domain exactly ONCE, to read; the ledger store reports "file" even with a facility', async () => {
    const root = tmp()
    const counter = countingFacility()
    const host = fakeCtx(root, { storageDomain: counter.facility })
    const mount = apply(host.ctx, { storeRoot: root })
    expect(host.recorded.toolNames).toEqual([])

    const dispose = await mount
    expect(counter.opens()).toBe(1)
    expect((host.recorded.provided.autopilot as { storeKind: string }).storeKind).toBe('file')
    await dispose()
    expect(counter.opens()).toBe(1)
  })

  it('falls back to the file backend where no facility is mounted (headless parity)', async () => {
    const root = tmp()
    const host = fakeCtx(root, {})
    const dispose = await apply(host.ctx, { storeRoot: root })
    expect((host.recorded.provided.autopilot as { storeKind: string }).storeKind).toBe('file')
    await dispose()
  })

  it('CLOSES the domain store when a later registration throws, so the domain name is not left reserved', async () => {
    const root = tmp()
    const counter = countingFacility()
    const host = fakeCtx(root, { storageDomain: counter.facility })
    // Upstream `DomainFacility.open` refuses an already-open name, so a store that is never closed
    // downgrades EVERY later mount in the process to the file backend.
    host.ctx.systemPrompt.section = () => { throw new Error('systemPrompt refused the section') }
    await expect(apply(host.ctx, { storeRoot: root })).rejects.toThrowError(/systemPrompt refused the section/)
    expect(counter.opens()).toBe(1)
    expect(counter.closes()).toBe(1)
  })

  // ── the routing wiring is released on a failed mount (F19) ───────────────
  it('F19: a mount that throws AFTER the wiring exists disposes it exactly once, closes the store, and rethrows unchanged', async () => {
    const root = tmp()
    const counter = countingFacility()
    const host = fakeCtx(root, { storageDomain: counter.facility, llm: stubLlmRuntime() })
    host.ctx.systemPrompt.section = () => { throw new Error('systemPrompt refused the section') }
    await expect(apply(host.ctx, { storeRoot: root, skillInstall: 'off' })).rejects.toThrowError(/systemPrompt refused the section/)
    expect(host.subscriptionDisposals('llm/adapters-updated')).toEqual([1])
    expect(counter.opens()).toBe(1)
    expect(counter.closes()).toBe(1)
  })

  it('F19: a CLEAN mount does not dispose the wiring at apply time, only at plugin lifecycle dispose', async () => {
    const root = tmp()
    const host = fakeCtx(root, { llm: stubLlmRuntime() })
    const dispose = await apply(host.ctx, { storeRoot: root, skillInstall: 'off' })
    expect(host.subscriptionDisposals('llm/adapters-updated')).toEqual([0, 0])
    await dispose()
    expect(host.subscriptionDisposals('llm/adapters-updated')).toEqual([1, 1])
  })

  it('F19: a remount after a failed mount accumulates no duplicate llm/adapters-updated listener', async () => {
    const failRoot = tmp()
    const retryRoot = tmp()
    const host = fakeCtx(failRoot, { llm: stubLlmRuntime() })
    const originalSection = host.ctx.systemPrompt.section.bind(host.ctx.systemPrompt)
    host.ctx.systemPrompt.section = () => { throw new Error('systemPrompt refused the section') }
    await expect(apply(host.ctx, { storeRoot: failRoot, skillInstall: 'off' })).rejects.toThrowError(/systemPrompt refused the section/)
    host.ctx.systemPrompt.section = originalSection
    const dispose = await apply(host.ctx, { storeRoot: retryRoot, skillInstall: 'off' })
    expect(host.subscriptionDisposals('llm/adapters-updated')).toEqual([1, 0, 0])
    expect(host.liveSubscriptions('llm/adapters-updated')).toBe(2)
    await dispose()
    expect(host.liveSubscriptions('llm/adapters-updated')).toBe(0)
  })

  // M7 live-host regression: cordis answers an undeclared service read by THROWING, at first section render.
  it('M7: renders the onboarding section on a host whose undeclared service reads throw (cordis inject semantics)', async () => {
    const root = tmp()
    const host = fakeCtx(root, { strictServiceAccess: true, llm: stubLlmRuntime() })
    const dispose = await apply(host.ctx, {
      storeRoot: root,
      skillInstall: 'off',
      routing: { mode: 'auto', ladder: { tiers: { economy: ['p/m'], standard: [], reserve: [] } } },
    })
    const section = host.recorded.sectionDefs.find(s => s.name === 'autopilot:routing-onboarding')
    expect(section).toBeDefined()
    expect(() => section?.text({ agent: host.rootAgent })).not.toThrow()
    expect(() => section?.text({ agent: host.childAgent })).not.toThrow()
    expect(section?.text({ agent: host.childAgent })).toBe('')
    await dispose()
  })

  it('positive control: a clean mount closes the store exactly once, at disposal', async () => {
    const root = tmp()
    const counter = countingFacility()
    const host = fakeCtx(root, { storageDomain: counter.facility })
    const dispose = await apply(host.ctx, { storeRoot: root })
    expect(counter.closes()).toBe(0)
    await dispose()
    expect(counter.closes()).toBe(1)
  })
})

/**
 * A degraded store says why. `ledgers.kind` records WHICH backend holds the
 * ledgers; it cannot record what the deployment was supposed to get, so 'file'
 * reads identically on a headless profile (nothing wrong) and on a web-app
 * profile whose facility threw (very wrong).
 */
describe('apply: a degraded store says why', () => {
  it('says NOTHING when the deployment simply has no facility: that is the headless shape, and storeKind reads "file"', async () => {
    const root = tmp()
    const host = fakeCtx(root, {})
    const dispose = await apply(host.ctx, { storeRoot: root, skillInstall: 'off' })
    expect(host.recorded.warnings).toEqual([])
    expect((host.recorded.provided.autopilot as { storeKind: string }).storeKind).toBe('file')
    await dispose()
  })

  it('carries the thrown reason through when a facility exists but cannot open', async () => {
    const root = tmp()
    const host = fakeCtx(root, { storageDomain: { open: async () => { throw new Error('domain "dsh_autopilot" is already open') } } })
    const dispose = await apply(host.ctx, { storeRoot: root, skillInstall: 'off' })
    expect((host.recorded.provided.autopilot as { storeKind: string }).storeKind).toBe('file')
    expect(host.recorded.warnings[0]).toContain('is already open')
    await dispose()
  })

  it('POSITIVE CONTROL: a mount that got the backend it wanted says nothing', async () => {
    const root = tmp()
    const counter = countingFacility()
    const host = fakeCtx(root, { storageDomain: counter.facility })
    const dispose = await apply(host.ctx, { storeRoot: root, skillInstall: 'off' })
    expect(host.recorded.warnings).toEqual([])
    await dispose()
  })

  it('does not persist SKILL.md when a later registration throws', async () => {
    const root = tmp()
    const destHome = tmp('skill-fail')
    const prev = process.env.DSH_AUTOPILOT_SKILL_HOME
    process.env.DSH_AUTOPILOT_SKILL_HOME = destHome
    try {
      const host = fakeCtx(root)
      host.ctx.systemPrompt.section = () => { throw new Error('systemPrompt refused the section') }
      await expect(apply(host.ctx, { storeRoot: root })).rejects.toThrowError(/systemPrompt refused the section/)
      expect(existsSync(join(destHome, 'skills', 'dsh-autopilot', 'SKILL.md'))).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.DSH_AUTOPILOT_SKILL_HOME
      else process.env.DSH_AUTOPILOT_SKILL_HOME = prev
    }
  })

  it('skillInstall auto copies the bundled skill into a unique scan root', async () => {
    const root = tmp()
    const destHome = tmp('skill-auto')
    const prev = process.env.DSH_AUTOPILOT_SKILL_HOME
    process.env.DSH_AUTOPILOT_SKILL_HOME = destHome
    try {
      const host = fakeCtx(root)
      const dispose = await apply(host.ctx, { storeRoot: root })
      expect(existsSync(join(destHome, 'skills', 'dsh-autopilot', 'SKILL.md'))).toBe(true)
      expect(host.recorded.warnings).toEqual([])
      await dispose()
    } finally {
      if (prev === undefined) delete process.env.DSH_AUTOPILOT_SKILL_HOME
      else process.env.DSH_AUTOPILOT_SKILL_HOME = prev
    }
  })

  it('skillInstall off does not copy into a unique skill home', async () => {
    const root = tmp()
    const destHome = tmp('skill-off')
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

  it('a host with no logger still mounts: a diagnostic may not decide whether the plugin exists', async () => {
    const root = tmp()
    const host = fakeCtx(root, {})
    delete (host.ctx as { logger?: unknown }).logger
    const dispose = await apply(host.ctx, { storeRoot: root })
    expect(host.recorded.toolNames).toEqual(ROOT_TOOLS)
    await dispose()
  })
})

/**
 * The root-admission guards in `apply()`'s `installRoot`: removing any one of
 * them used to leave the suite green.
 * - the idempotency guard stops a re-announced root from stacking a second copy of the tool;
 * - the parentSession guard stops a CHILD agent from receiving the root surface;
 * - the roots() guard stops the same for an agent the host does not consider a root.
 */
/**
 * The ledger follows the native goal as it changes. Before this, `update_goal`
 * complete left the persisted ledger at the old revision and `active` until the
 * next route read or session open (observed on a real host).
 */
describe('apply: native goal changes reach the ledger file without a route read', () => {
  function goalHost() {
    const views = new Map<unknown, Record<string, unknown>>()
    const goals = { get: (agent: unknown) => views.get(agent) }
    const root = tmp('goal')
    const host = fakeCtx(root, { goals, rootLiveAtMount: true })
    const ledgerOnDisk = (id: string): { revision: number; goal?: { revision: number; status: string; activation: string } } | undefined => {
      const path = join(root, 'ledgers', `${id}.json`)
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
    }
    return { host, root, views, ledgerOnDisk }
  }
  const view = (over: Record<string, unknown> = {}) => ({
    id: 'g-1', revision: 1, objective: 'ship', phase: 'active', maxGoalRounds: 10, roundsStarted: 0, activation: 'disarmed', ...over,
  })

  it('goal/changed of a root writes the new goal status and revision at once', async () => {
    const { host, views, ledgerOnDisk } = goalHost()
    views.set(host.rootAgent, view())
    const dispose = await apply(host.ctx, { storeRoot: host.storeRoot, skillInstall: 'off' })
    expect(ledgerOnDisk('root-session-1')?.goal).toMatchObject({ revision: 1, status: 'active' })

    views.set(host.rootAgent, view({ revision: 2, phase: 'complete' }))
    host.emit('goal/changed', { agent: host.rootAgent, change: { operation: 'complete', ref: { id: 'g-1', revision: 2 } } })
    await vi.waitFor(() => expect(ledgerOnDisk('root-session-1')?.goal).toMatchObject({ revision: 2, status: 'complete' }))
    await dispose()
  })

  it('goal/activation-changed (keyed by session id) mirrors the activation', async () => {
    const { host, views, ledgerOnDisk } = goalHost()
    views.set(host.rootAgent, view())
    const dispose = await apply(host.ctx, { storeRoot: host.storeRoot, skillInstall: 'off' })
    views.set(host.rootAgent, view({ activation: 'armed' }))
    host.emit('goal/activation-changed', { sessionId: 'root-session-1', goal: { id: 'g-1', revision: 1, activation: 'armed' } })
    await vi.waitFor(() => expect(ledgerOnDisk('root-session-1')?.goal?.activation).toBe('armed'))
    await dispose()
  })

  it('a CHILD goal change writes nothing (no ledger keyed by a child id), and dispose unsubscribes', async () => {
    const { host, views, ledgerOnDisk } = goalHost()
    const dispose = await apply(host.ctx, { storeRoot: host.storeRoot, skillInstall: 'off' })
    views.set(host.childAgent, view())
    host.emit('goal/changed', { agent: host.childAgent, change: { operation: 'create' } })
    host.emit('goal/activation-changed', { sessionId: 'child-session-1' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(ledgerOnDisk('child-session-1')).toBeUndefined()
    expect(host.liveSubscriptions('goal/changed')).toBe(1)
    expect(host.liveSubscriptions('goal/activation-changed')).toBe(1)
    await dispose()
    expect(host.liveSubscriptions('goal/changed')).toBe(0)
    expect(host.liveSubscriptions('goal/activation-changed')).toBe(0)
  })
})

describe('apply: which agents get the root surface', () => {
  async function mounted() {
    const root = tmp()
    const host = fakeCtx(root, {})
    const dispose = await apply(host.ctx, { storeRoot: root })
    return { host, dispose }
  }

  it('a re-announced root is installed ONCE, not stacked', async () => {
    const { host, dispose } = await mounted()
    expect(host.recorded.toolNames).toEqual(ROOT_TOOLS)
    await host.announce(host.rootAgent)
    await host.announce(host.rootAgent)
    expect(host.recorded.toolNames).toEqual(ROOT_TOOLS)
    await dispose()
  })

  it('a CHILD agent gets no root surface at all', async () => {
    const { host, dispose } = await mounted()
    // The host DOES list it as a root, so the parentSession guard is the only thing that can refuse it.
    expect(host.ctx.agents.roots()).toContain(host.childAgent as unknown)
    await host.announce(host.childAgent)
    expect(host.recorded.toolNames).toEqual(ROOT_TOOLS)
    await dispose()
  })

  it('a top-level agent the host does not list as a root gets no root surface either', async () => {
    const { host, dispose } = await mounted()
    expect(host.otherRoot.session.header).toEqual({})
    await host.announce(host.otherRoot)
    expect(host.recorded.toolNames).toEqual(ROOT_TOOLS)
    await dispose()
  })

  it('agent/disposed releases the root surface so a re-created root installs again', async () => {
    const { host, dispose } = await mounted()
    host.dispose(host.rootAgent)
    await host.announce(host.rootAgent)
    expect(host.recorded.toolNames).toEqual([...ROOT_TOOLS, ...ROOT_TOOLS])
    await dispose()
  })
})

describe('apply: retired settings', () => {
  /** Every retired key, written the way an old profile wrote it. */
  const OLD_CONFIG = {
    gate: { sandboxCoupling: false, toolDeny: false, egressDeny: false, stopReminder: false, strictShell: true, restoreMode: 'read-only' },
    governance: { maxAuditRoundsPerRole: 3, unattended: true },
    storeKind: 'file' as const,
    auditProvider: 'spawn',
    executorProvider: 'spawn',
    executor: { persona: 'lead', toolAllowList: ['read'], agentOptions: { maxTokens: 10 } },
    auditors: {
      plan: { provider: 'spawn', agentOptions: { maxTokens: 10 } },
      execution: { provider: 'spawn', agentOptions: { maxTokens: 10 } },
      rules: { provider: 'spawn', agentOptions: { maxTokens: 10 } },
    },
    crossFamily: { enabled: false, minRisk: 'high' as const, pool: [{ provider: 'p', model: 'm' }] },
  }

  it('the fixture really writes every retired key (so a newly retired key cannot be forgotten here)', () => {
    const paths: string[] = []
    const walk = (value: unknown, path: string): void => {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value)) walk(v, path === '' ? k : `${path}.${k}`)
      } else paths.push(path)
    }
    walk(OLD_CONFIG, '')
    expect(paths.sort()).toEqual([...RETIRED_CONFIG_KEYS].sort())
  })

  it('an old config carrying every retired key mounts, and yields exactly ONE note (service) and ONE warning', async () => {
    const root = tmp()
    const host = fakeCtx(root, {})
    const dispose = await apply(host.ctx, { storeRoot: root, skillInstall: 'off', ...OLD_CONFIG })
    const service = host.recorded.provided.autopilot as { notes(): readonly string[] }
    const notes = service.notes()
    expect(notes).toHaveLength(1)
    for (const key of RETIRED_CONFIG_KEYS) expect(notes[0]).toContain(key)
    expect(host.recorded.warnings.filter(w => w.includes('ignores retired settings'))).toEqual([notes[0]])
    await dispose()
  })

  it('a config without retired keys carries no note and no warning about them', async () => {
    const root = tmp()
    const host = fakeCtx(root, {})
    const dispose = await apply(host.ctx, { storeRoot: root, skillInstall: 'off' })
    expect((host.recorded.provided.autopilot as { notes(): readonly string[] }).notes()).toEqual([])
    expect(host.recorded.warnings.some(w => w.includes('retired'))).toBe(false)
    await dispose()
  })

  it('storeKind "domain" no longer rejects the mount on a deployment without a facility: the key is ignored', async () => {
    const root = tmp()
    const host = fakeCtx(root, {})
    const dispose = await apply(host.ctx, { storeRoot: root, skillInstall: 'off', storeKind: 'domain' })
    expect((host.recorded.provided.autopilot as { storeKind: string }).storeKind).toBe('file')
    await dispose()
  })
})

describe('apply: opening a root session', () => {
  it('agent/created of a root restores the clamp BEFORE the host\'s serial dispatch returns', async () => {
    const root = tmp()
    putLegacyRun(root, 'independent-clamped-completed.jsonl')
    const host = fakeCtx(root, { rootId: 'syn-session-a', rootLiveAtMount: false, rootEvents: [mode('workspace-write'), mode('read-only')] })
    const dispose = await apply(host.ctx, { storeRoot: root, skillInstall: 'off' })
    expect(host.rootEvents.filter(e => e.type === 'sandbox/mode')).toHaveLength(2)

    await host.announce(host.rootAgent)

    expect(host.rootEvents.filter(e => e.type === 'sandbox/mode').map(e => e.data)).toEqual([
      { mode: 'workspace-write' }, { mode: 'read-only' }, { mode: 'workspace-write' },
    ])
    const service = host.recorded.provided.autopilot as { ledger(id: string): Promise<{ legacyRuns: Array<{ runId: string; sandboxRestore: { state: string } }> } | undefined> }
    const projection = await service.ledger('syn-session-a')
    expect(projection?.legacyRuns.find(run => run.runId === 'syn-session-a')?.sandboxRestore.state).toBe('restored')
    await dispose()
  })

  it('a root already live at mount is opened at mount: its clamp is restored, no other session is touched', async () => {
    const root = tmp()
    putLegacyRun(root, 'independent-clamped-completed.jsonl')
    putLegacyRun(root, 'clamped-no-prior-mode.jsonl')
    const host = fakeCtx(root, { rootId: 'syn-session-a', rootEvents: [mode('workspace-write'), mode('read-only')] })
    const dispose = await apply(host.ctx, { storeRoot: root, skillInstall: 'off' })
    expect(host.rootEvents.filter(e => e.type === 'sandbox/mode').pop()?.data).toEqual({ mode: 'workspace-write' })
    const store = FileLedgerStore.open(root)
    expect(store.list().map(l => l.sessionId)).toEqual(['syn-session-a'])
    await dispose()
  })

  it('no prior recorded: the host default read from ctx.sandboxPolicy is written', async () => {
    const root = tmp()
    putLegacyRun(root, 'clamped-no-prior-mode.jsonl')
    const host = fakeCtx(root, { rootId: 'syn-clamped-no-prior', rootLiveAtMount: false, rootEvents: [mode('read-only')], sandboxDefaultMode: 'danger-full-access' })
    const dispose = await apply(host.ctx, { storeRoot: root, skillInstall: 'off' })
    await host.announce(host.rootAgent)
    expect(host.rootEvents.filter(e => e.type === 'sandbox/mode').pop()?.data).toEqual({ mode: 'danger-full-access' })
    await dispose()
  })

  it('a listener that cannot read the session log still resolves: a rejection would veto the agent\'s publication', async () => {
    const root = tmp()
    putLegacyRun(root, 'independent-clamped-completed.jsonl')
    const host = fakeCtx(root, { rootId: 'syn-session-a', rootLiveAtMount: false })
    host.rootAgent.session.snapshotEvents = () => { throw new Error('log unreadable') }
    const dispose = await apply(host.ctx, { storeRoot: root, skillInstall: 'off' })
    await expect(host.announce(host.rootAgent)).resolves.toBeUndefined()
    await dispose()
  })

  it('a session with no legacy run and no ledger leaves no ledger behind', async () => {
    const root = tmp()
    const host = fakeCtx(root, { rootLiveAtMount: false })
    const dispose = await apply(host.ctx, { storeRoot: root, skillInstall: 'off' })
    await host.announce(host.rootAgent)
    expect(await (host.recorded.provided.autopilot as { ledgers(): Promise<unknown[]> }).ledgers()).toEqual([])
    expect(existsSync(join(root, 'ledgers'))).toBe(false)
    await dispose()
  })

  it('children the ledger believes are running but the host lost are marked lost when the root opens', async () => {
    const root = tmp()
    const seeded = FileLedgerStore.open(root)
    await seeded.write({
      ...emptyLedger('root-session-1', '2026-11-04T00:00:00.000Z'),
      delegations: [delegation('w-gone', 'running', { parentId: 'root-session-1' }), delegation('w-live', 'running', { parentId: 'root-session-1' })],
    }, 0)
    const host = fakeCtx(root, { residentIds: ['w-live'], rootLiveAtMount: false })
    const dispose = await apply(host.ctx, { storeRoot: root, skillInstall: 'off' })
    await host.announce(host.rootAgent)
    const ledger = FileLedgerStore.open(root).load('root-session-1')!
    expect(ledger.delegations.map(d => [d.childId, d.state])).toEqual([['w-gone', 'lost'], ['w-live', 'running']])
    expect(ledger.hostRestart?.lostChildIds).toEqual(['w-gone'])
    await dispose()
  })

  it('the policy section is empty for an ordinary session and names the lost children after a restart', async () => {
    const root = tmp()
    const seeded = FileLedgerStore.open(root)
    await seeded.write({
      ...emptyLedger('root-session-1', '2026-11-04T00:00:00.000Z'),
      delegations: [delegation('w-gone', 'running', { parentId: 'root-session-1', title: 'port the parser' })],
    }, 0)
    const host = fakeCtx(root, { rootLiveAtMount: false })
    const dispose = await apply(host.ctx, { storeRoot: root, skillInstall: 'off' })
    const section = host.recorded.sectionDefs.find(s => s.name === 'autopilot:policy')!
    // Before the root is opened nothing is marked, so the section is silent.
    expect(section.text({ agent: host.rootAgent })).toBe('')
    await host.announce(host.rootAgent)
    const text = section.text({ agent: host.rootAgent })
    expect(text).toContain('worker w-gone (port the parser)')
    expect(text).toContain('released after host restart')
    // A child agent never gets the notice, and a context with no agent renders nothing.
    expect(section.text({ agent: host.childAgent })).toBe('')
    expect(section.text({})).toBe('')
    await dispose()
  })
})

/**
 * The mount through a REAL cordis fiber. cordis's `_reload()` awaits a plugin's
 * returned promise, so a promise returned from `apply` holds the fiber's
 * `inertia` open and every seam that waits on a fiber (`loader.await()`,
 * `boot()`'s activation check, the headless runner creating its first Agent)
 * waits for the ledger store. Registering inside an async `ctx.effect` instead
 * put the store behind a promise nothing awaits, and the fiber reported mounted
 * with an empty surface.
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

  /** A real root Context carrying the services the plugin declares. */
  function realHost(storageDomain?: unknown) {
    const toolNames: string[] = []
    const agentTools = {
      register(definition: unknown) {
        toolNames.push((definition as { name?: string }).name ?? '<unnamed>')
        return () => {}
      },
    }
    const rootAgent = {
      id: 'root-session-real',
      session: { header: {}, snapshotEvents: () => [] as Array<{ type: string; data: unknown }>, append() {} },
      ctx: { tools: agentTools, on: () => () => {} },
    }
    const ctx = new Context()
    ctx.provide('agents', {
      get: (id: string) => (id === rootAgent.id ? rootAgent : undefined),
      list: () => [rootAgent],
      roots: () => [rootAgent as unknown],
    })
    ctx.provide('subagents', {})
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
    const root = tmp('real')
    const gated = gatedFacility()
    const { ctx, toolNames } = realHost(gated.facility)

    const fiber = mount(ctx, { storeRoot: root })

    // The host's own wait, in flight. Nothing may complete it while `open()` is gated.
    let mounted = false
    const hostWait = (async () => { await fiber; mounted = true })()
    await new Promise((resolve) => { setTimeout(resolve, 25) })
    expect(mounted).toBe(false)
    expect(toolNames).toEqual([])

    gated.release()
    await hostWait
    expect(mounted).toBe(true)

    // The assertion that needs no timing: by the time the host's wait has returned, the tool surface EXISTS.
    // Assert the SET, not a count: a bare length is a moving anchor that is cheapest to "fix" by bumping it.
    expect(toolNames.filter(tool => tool.startsWith('autopilot_')).sort()).toEqual([...ROOT_TOOLS].sort())

    await ctx.fiber.dispose()
  })

  it('a facility that cannot open falls back to files and the mount still completes', async () => {
    const root = tmp('real')
    const { ctx, toolNames } = realHost({ open: async () => { throw new Error('backend down') } })
    await mount(ctx, { storeRoot: root })
    expect(toolNames).toEqual(ROOT_TOOLS)
    await ctx.fiber.dispose()
  })

  it('REFUSES a profile the declared schema does not accept, through the real cordis validation', async () => {
    const root = tmp('real')
    const { ctx, toolNames } = realHost()
    // cordis validates `runtime.Config` before it ever calls apply, so a typo in a profile cannot reach
    // this plugin as a silent default. `test/config.test.ts` drives the same schema directly; this is the
    // half that proves cordis actually consults it.
    const fiber = mount(ctx, { storeRoot: root, storeKindd: 'domain' })
    await expect((async () => { await fiber })()).rejects.toThrowError(/storeKindd/)
    expect(toolNames).toEqual([])
    await ctx.fiber.dispose()
  })

  it('a profile with no retired key carries NO note once cordis has validated it and filled its defaults', async () => {
    const root = tmp('real')
    const { ctx } = realHost()
    await mount(ctx, { storeRoot: root })
    const service = (ctx as unknown as { get(name: string): { notes(): readonly string[] } | undefined }).get('autopilot')
    expect(service).toBeDefined()
    expect(service?.notes()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('every retired key is still accepted by the real cordis validation', async () => {
    const root = tmp('real')
    const { ctx, toolNames } = realHost()
    await mount(ctx, {
      storeRoot: root,
      storeKind: 'domain',
      gate: { sandboxCoupling: false, toolDeny: false, egressDeny: false, stopReminder: false, strictShell: true, restoreMode: 'read-only' },
      governance: { maxAuditRoundsPerRole: 3, unattended: true },
    })
    expect(toolNames).toEqual(ROOT_TOOLS)
    await ctx.fiber.dispose()
  })
})
