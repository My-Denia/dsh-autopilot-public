/**
 * Bundle smoke test: mount the plugin entry with a fake Cordis-shaped context
 * and assert the three tools register into the right agent scopes.
 *
 * The same assertions run against `lib/index.js` when the package has been
 * built, so a stale or broken build fails here instead of only at install time.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { apply, inject, name } from '../src/index.js'
import { FakeAgent, FakeAgents, FakeSubagents, FakeTools, FakeToolScope, flush } from './helpers.js'

interface ToolDefinitionLike {
  readonly name: string
  execute(args: unknown, exec: { readonly agent?: unknown }): Promise<unknown>
}

function toolNamed(scope: FakeToolScope, toolName: string): ToolDefinitionLike {
  const definition = scope.definitions.find(
    (entry): entry is ToolDefinitionLike => typeof entry === 'object' && entry !== null && (entry as { name?: unknown }).name === toolName,
  )
  if (definition === undefined) throw new Error(`tool ${toolName} was not registered; got ${scope.registered.join(', ')}`)
  return definition
}

class FakeCtx {
  readonly agents = new FakeAgents()
  readonly subagents = new FakeSubagents()
  readonly tools = new FakeTools()
  readonly logs: string[] = []
  private readonly listeners = new Map<string, Set<(payload: never) => unknown>>()
  skills: { registerProvider(create: () => unknown): () => void } | undefined

  get(service: string): unknown {
    if (service === 'logger') {
      return {
        warn: (message: string) => { this.logs.push(`warn:${message}`) },
        info: (message: string) => { this.logs.push(`info:${message}`) },
      }
    }
    if (service === 'tools') return this.tools
    if (service === 'skills') return this.skills
    return undefined
  }

  on(event: string, listener: (payload: never) => unknown): () => void {
    let set = this.listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return () => { set!.delete(listener) }
  }

  async emit(event: string, payload: unknown): Promise<void> {
    for (const listener of this.listeners.get(event) ?? []) await listener(payload as never)
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }
}

interface Mounted {
  readonly ctx: FakeCtx
  readonly root: FakeAgent
  readonly dispose: () => Promise<void>
}

async function mount(module: {
  apply(rawCtx: unknown, config?: { skillInstall?: 'auto' | 'off' }): Promise<() => Promise<void>>
}, skillInstall: 'auto' | 'off' = 'off'): Promise<Mounted> {
  const ctx = new FakeCtx()
  const root = new FakeAgent('root')
  ctx.agents.add(root)
  const dispose = await module.apply(ctx, { skillInstall })
  return { ctx, root, dispose }
}

/** The assertions every entry (source and built bundle) must satisfy. */
async function smoke(module: {
  readonly name?: unknown
  readonly inject?: unknown
  apply(rawCtx: unknown, config?: { skillInstall?: 'auto' | 'off' }): Promise<() => Promise<void>>
}): Promise<void> {
  expect(module.name).toBe('dsh-goal-autopilot')
  expect(module.inject).toEqual(['agents', 'subagents', 'tools'])

  const { ctx, root, dispose } = await mount(module)
  expect(root.tools.registered).toEqual(['autopilot_delegate', 'autopilot_agents'])
  expect(ctx.listenerCount('agent/created')).toBe(1)
  expect(ctx.listenerCount('agent/disposed')).toBe(1)

  // The delegate tool starts a child through the host seam.
  const pending = toolNamed(root.tools, 'autopilot_delegate').execute(
    { role: 'scout', task: 'Inventory the retry tests.', provider: 'example/provider-a', model: 'example/model-a', effort: 'low' },
    { agent: root },
  )
  await flush(2)
  expect(ctx.subagents.starts).toHaveLength(1)
  expect(ctx.subagents.starts[0]!.agentOptions).toEqual({
    provider: 'example/provider-a',
    model: 'example/model-a',
    reasoningEffort: 'low',
  })
  const accepted = ctx.subagents.accept()
  const delegated = await pending as { readonly childId: string; readonly role: string; readonly routeSource: string }
  expect(delegated.role).toBe('scout')
  expect(delegated.routeSource).toBe('call')

  // `agent/created` for that child gives it its own escalate tool and its
  // read-only restriction.
  const child = ctx.agents.add(new FakeAgent(delegated.childId, 'root'))
  await ctx.emit('agent/created', { agent: child })
  expect(child.tools.registered).toEqual(['autopilot_escalate'])
  expect(child.tools.restrictCalls).toHaveLength(1)

  // The escalation is recorded on the child's delegation record.
  const escalated = await toolNamed(child.tools, 'autopilot_escalate').execute(
    { reason: 'the retry helper is imported from two places' },
    { agent: child },
  ) as { readonly guidance: string }
  expect(escalated.guidance.startsWith('Recorded.')).toBe(true)

  // The wait tool reports the child still running, then its settled state.
  const waited = await toolNamed(root.tools, 'autopilot_agents').execute(
    { action: 'wait', timeoutSeconds: 0 },
    { agent: root },
  ) as { readonly timedOut: boolean; readonly delegations: ReadonlyArray<{ readonly state: string }> }
  expect(waited.timedOut).toBe(true)
  expect(waited.delegations.map((record) => record.state)).toEqual(['running'])
  await accepted.settle({ stopReason: 'completed' })
  const after = await toolNamed(root.tools, 'autopilot_agents').execute(
    { action: 'wait', timeoutSeconds: 0 },
    { agent: root },
  ) as { readonly timedOut: boolean; readonly delegations: ReadonlyArray<{ readonly state: string }> }
  expect(after.timedOut).toBe(false)
  expect(after.delegations.map((record) => record.state)).toEqual(['idle'])

  // A root agent created after the mount gets the controller surface too.
  const late = ctx.agents.add(new FakeAgent('late-root'))
  await ctx.emit('agent/created', { agent: late })
  expect(late.tools.registered).toEqual(['autopilot_delegate', 'autopilot_agents'])

  await dispose()
  expect(root.tools.registered).toEqual([])
  expect(ctx.listenerCount('agent/created')).toBe(0)
  expect(ctx.listenerCount('agent/disposed')).toBe(0)
}

describe('bundle smoke (source entry)', () => {
  it('registers the root and child tool surfaces', async () => {
    await smoke({ apply, name, inject })
  })

  it('publishes the skill through an injected registry', async () => {
    const ctx = new FakeCtx()
    ctx.agents.add(new FakeAgent('root'))
    let registered = false
    ctx.skills = {
      registerProvider() {
        registered = true
        return () => {}
      },
    }
    const dispose = await apply(ctx, { skillInstall: 'auto' })
    expect(registered).toBe(true)
    expect(ctx.logs.some((line) => line.includes('skill served by'))).toBe(true)
    await dispose()
  })

  it('does not touch a skill service when the config says off', async () => {
    const ctx = new FakeCtx()
    ctx.agents.add(new FakeAgent('root'))
    let registered = false
    ctx.skills = {
      registerProvider() {
        registered = true
        return () => {}
      },
    }
    const dispose = await apply(ctx, { skillInstall: 'off' })
    expect(registered).toBe(false)
    await dispose()
  })
})

describe('bundle smoke (built lib)', () => {
  const libPath = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'lib', 'index.js')

  it('the built entry is loadable and registers the same surfaces', async () => {
    if (!existsSync(libPath)) {
      // The suite runs before `pnpm run build` in CI; a local build exercises this branch.
      expect(existsSync(libPath)).toBe(false)
      return
    }
    const built = await import(/* @vite-ignore */ pathToFileURL(libPath).href) as Parameters<typeof smoke>[0]
    await smoke(built)
  })
})
