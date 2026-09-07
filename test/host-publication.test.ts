/**
 * The rc.1 publication path, with the REAL `AgentRegistry`.
 *
 * WHY. Since dsh 0.1.2 the executor child's surface is installed from an
 * `agent/created` listener. The whole fail-closed contract of that listener
 * rests on one host fact: a SYNCHRONOUS throw from an `agent/created`
 * listener vetoes the agent's publication (`AgentRegistry.announce()`,
 * `packages/core/agent/src/index.ts`: "A synchronous creation failure vetoes
 * publication and rolls back"), so `agents.create()` rejects, the subagent
 * manager's `startContinuable()` rejects, and the engine records the executor
 * as `revoked`. If that fact were false, a throwing listener would merely be
 * logged and the executor would run without its packet tool — the exact P2
 * this file exists to make observable. So the fact is measured here against
 * the installed `@deepseek-ai/dsh-agent`, not cited.
 *
 * The registry is mounted through `ctx.plugin(AgentRegistry)` because its
 * constructor registers effects and a lazy inject and therefore needs a fiber;
 * the agent is a structural stand-in (`id === session.id`, a `ctx` of its own)
 * — `enter()`/`announce()` read nothing else from it.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'

function structuralAgent(ctx: Context, id: string): Agent {
  const agentCtx = ctx.extend({})
  const agent = {
    id,
    ctx: agentCtx,
    session: { id, header: { id, cwd: undefined } },
    options: {},
  }
  return agent as unknown as Agent
}

async function mountRegistry(): Promise<{ ctx: Context; registry: AgentRegistry }> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  const registry = (ctx as Context & { agents: AgentRegistry }).agents
  expect(registry).toBeInstanceOf(AgentRegistry)
  return { ctx, registry }
}

describe('rc.1 AgentRegistry publication path', () => {
  it('a synchronous throw from an agent/created listener VETOES announce()', async () => {
    const { ctx, registry } = await mountRegistry()
    const seen: string[] = []
    ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
      seen.push(agent.id)
      throw new Error('inject: child surface installation failed')
    })
    const agent = structuralAgent(ctx, 'session-veto')
    const detach = registry.enter(agent, undefined)
    expect(() => registry.announce(agent)).toThrow('inject: child surface installation failed')
    expect(seen).toEqual(['session-veto'])
    detach()
  })

  it('… and a listener that returns normally lets announce() complete', async () => {
    // DETECTOR for the case above: the veto is the listener's doing, not the
    // registry refusing every announce.
    const { ctx, registry } = await mountRegistry()
    const seen: string[] = []
    ctx.on('agent/created', ({ agent }: { agent: Agent }) => { seen.push(agent.id) })
    const agent = structuralAgent(ctx, 'session-ok')
    const detach = registry.enter(agent, undefined)
    expect(() => registry.announce(agent)).not.toThrow()
    expect(seen).toEqual(['session-ok'])
    expect(registry.get(agent.id)).toBe(agent)
    detach()
  })
})
