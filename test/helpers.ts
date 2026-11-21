/**
 * Host-neutral fakes for the test suite.
 *
 * No dsh process, no network, no real subagent. The fakes implement exactly the
 * structural seam `src/host.ts` declares, so every behaviour under test is the
 * plugin's own logic: argument validation, the write-path guard, the prompt and
 * route handed to the host, the tool restriction applied on `agent/created`,
 * settlement bookkeeping and the in-band reviewer result.
 *
 * Route ids in tests are deliberately fake (`example/model-a`) so no real
 * provider or model name appears anywhere in the suite.
 */

import { Delegator } from '../src/delegator.js'
import type { DelegateArgs, DelegateResult } from '../src/delegator.js'
import type { AgentRef, AgentRegistryRef, ToolScopeRef } from '../src/host-types.js'
import type {
  ActivationRef,
  ActivationResultRef,
  HostSeam,
  StartActivationSpec,
  SubagentsRef,
  ToolsRef,
} from '../src/host.js'

/** Every tool name a plausible deployment registers. */
export const REGISTERED_TOOLS: readonly string[] = [
  'read',
  'glob',
  'grep',
  'read_image',
  'web_fetch',
  'web_search',
  'bash',
  'pwsh',
  'write',
  'edit',
  'list_agents',
  'send_message',
  'interrupt_agent',
  'autopilot_delegate',
  'autopilot_agents',
  'autopilot_escalate',
]

interface RestrictFilter {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}

/** One agent's scope-local tool registry. */
export class FakeToolScope implements ToolScopeRef {
  readonly registered: string[] = []
  /** Every definition handed to egister, in registration order. */
  readonly definitions: unknown[] = []
  readonly restrictCalls: Array<RestrictFilter & { readonly result: 'applied' | 'threw' }> = []
  /** When set, `restrict` throws this message instead of accepting the filter. */
  restrictError: string | undefined

  register(definition: unknown): () => void {
    this.definitions.push(definition)
    if (typeof definition === 'object' && definition !== null && 'name' in definition) {
      this.registered.push(String((definition as { name: unknown }).name))
    }
    return () => {
      for (let i = this.registered.length - 1; i >= 0; i -= 1) {
        if (this.registered[i] === String((definition as { name: unknown }).name)) {
          this.registered.splice(i, 1)
          return
        }
      }
    }
  }

  restrict(filter: RestrictFilter): unknown {
    if (this.restrictError !== undefined) {
      const message = this.restrictError
      this.restrictError = undefined
      this.restrictCalls.push({ ...filter, result: 'threw' })
      throw new Error(message)
    }
    this.restrictCalls.push({ ...filter, result: 'applied' })
    return () => {}
  }
}

/** One fake live agent. */
export class FakeAgent implements AgentRef {
  readonly tools = new FakeToolScope()
  readonly ctx = { tools: this.tools }
  /** Events the fake session log exposes to the plugin. */
  readonly sessionEvents: Array<{ type: string; data: unknown }> = []

  constructor(readonly id: string, readonly parentSession?: string) {}

  get session(): {
    readonly header: { readonly parentSession?: string }
    snapshotEvents(): ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  } {
    return {
      header: this.parentSession === undefined ? {} : { parentSession: this.parentSession },
      snapshotEvents: () => this.sessionEvents,
    }
  }

  /** Append one well-formed request header, as a real child session would. */
  recordRequest(provider: string, model: string, effort?: string): void {
    this.sessionEvents.push({
      type: 'request/header',
      data: { header: { config: { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) } } },
    })
  }
}

/** A minimal live-agent registry. */
export class FakeAgents implements AgentRegistryRef {
  private readonly agents = new Map<string, FakeAgent>()

  add(agent: FakeAgent): FakeAgent {
    this.agents.set(agent.id, agent)
    return agent
  }

  get(id: string): FakeAgent | undefined {
    return this.agents.get(id)
  }

  list(): Iterable<FakeAgent> {
    return [...this.agents.values()]
  }
}

interface PendingStart {
  readonly spec: StartActivationSpec
  readonly resolve: (activation: ActivationRef) => void
  readonly reject: (error: unknown) => void
}

/** One accepted activation whose result the test settles. */
export interface FakeActivation {
  readonly activation: ActivationRef
  /** Resolve the child's terminal result. */
  settle(result: ActivationResultRef): Promise<void>
  /** Reject the activation result (an infrastructure fault). */
  fail(error: unknown): Promise<void>
}

/** A subagent runtime that records every start and lets tests settle it. */
export class FakeSubagents implements SubagentsRef {
  readonly starts: StartActivationSpec[] = []
  private readonly pending: PendingStart[] = []
  private minted = 0

  startActivation(spec: StartActivationSpec): Promise<ActivationRef> {
    this.starts.push(spec)
    return new Promise<ActivationRef>((resolve, reject) => {
      this.pending.push({ spec, resolve, reject })
    })
  }

  /** Accept the nth pending start (default the first), minting its activation. */
  accept(index = 0): FakeActivation {
    const pending = this.pending[index]
    if (pending === undefined) throw new Error(`no pending start at index ${index}`)
    this.pending.splice(index, 1)
    this.minted += 1
    let settleResult: (value: ActivationResultRef) => void = () => {}
    let failResult: (error: unknown) => void = () => {}
    const result = new Promise<ActivationResultRef>((resolve, reject) => {
      settleResult = resolve
      failResult = reject
    })
    const activation: ActivationRef = {
      childId: pending.spec.childId ?? `child-${this.minted}`,
      result,
      dispose: async () => {},
    }
    pending.resolve(activation)
    return {
      activation,
      settle: async (value) => {
        settleResult(value)
        await flush()
      },
      fail: async (error) => {
        failResult(error)
        await flush()
      },
    }
  }

  /** Reject the nth pending start outright (the host refused to start the child). */
  async refuse(index = 0, error: unknown = new Error('host refused')): Promise<void> {
    const pending = this.pending[index]
    if (pending === undefined) throw new Error(`no pending start at index ${index}`)
    this.pending.splice(index, 1)
    pending.reject(error)
    await flush()
  }
}

/** The `ctx.tools` registry view used to read registered names. */
export class FakeTools implements ToolsRef {
  constructor(public names: readonly string[] = REGISTERED_TOOLS, public unreadable = false) {}

  schemas(): readonly { readonly name?: unknown }[] {
    if (this.unreadable) throw new Error('tool registry unavailable')
    return this.names.map((name) => ({ name }))
  }
}

/** The host seam plus the fakes a test inspects. */
export interface FakeHost {
  readonly host: HostSeam
  readonly agents: FakeAgents
  readonly subagents: FakeSubagents
  readonly warnings: string[]
  readonly tools: FakeTools
}

/** Drain the microtask queue a few times so fire-and-forget settlement lands. */
export async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}

/** Build a host seam with a deterministic clock and a warning sink. */
export function makeHost(options: {
  readonly agents?: readonly FakeAgent[]
  readonly tools?: FakeTools | undefined
} = {}): FakeHost {
  const agents = new FakeAgents()
  for (const agent of options.agents ?? []) agents.add(agent)
  const subagents = new FakeSubagents()
  const warnings: string[] = []
  const tools = options.tools ?? new FakeTools()
  let tick = 0
  const host: HostSeam = {
    agents,
    subagents,
    tools,
    signal: new AbortController().signal,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    warn: (message) => { warnings.push(message) },
  }
  return { host, agents, subagents, warnings, tools }
}

/** A delegator bound to a fake host. */
export function makeDelegator(host: FakeHost): Delegator {
  return new Delegator(host.host)
}

/** Begin one delegate call; the start call is queued by the time this returns. */
export async function startDelegation(
  host: FakeHost,
  agent: FakeAgent,
  args: DelegateArgs,
  existing?: Delegator,
): Promise<{ delegator: Delegator; promise: Promise<DelegateResult> }> {
  const delegator = existing ?? makeDelegator(host)
  const promise = delegator.delegate(agent, args)
  // The caller may assert on the rejection later; keep Node from reporting it
  // as unhandled while the start call is still being observed.
  void promise.catch(() => {})
  await flush(2)
  return { delegator, promise }
}
/** A root agent and a delegated child of it, both registered in the fake host. */
export function makeTree(host: FakeHost, childId: string, parentId = 'root'): { root: FakeAgent; child: FakeAgent } {
  const existingRoot = host.agents.get(parentId)
  const root = existingRoot instanceof FakeAgent ? existingRoot : host.agents.add(new FakeAgent(parentId))
  const child = host.agents.add(new FakeAgent(childId, parentId))
  return { root, child }
}
