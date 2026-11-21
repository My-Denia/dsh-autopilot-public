import { describe, expect, it } from 'vitest'
import { AP_TOOL_SURFACE_INCOMPLETE } from '../src/domain/refusals.js'
import { AutopilotError } from '../src/domain/types.js'
import type { DelegationRoleName } from '../src/ledger.js'
import { READ_ONLY_TOOLS } from '../src/roles/tools.js'
import type { Delegator } from '../src/delegator.js'
import { FakeAgent, makeDelegator, makeHost, startDelegation } from './helpers.js'

interface Dispatched {
  readonly delegator: Delegator
  readonly child: FakeAgent
  readonly childId: string
}

function freshHost() {
  const root = new FakeAgent('root')
  return makeHost({ agents: [root] })
}

async function dispatchRole(host: ReturnType<typeof freshHost>, role: DelegationRoleName): Promise<Dispatched> {
  const root = host.agents.get('root')!
  const args = role === 'worker'
    ? { role, task: 'Do the work.', writePaths: ['src/a.ts'] }
    : { role, task: 'Do the work.' }
  const { delegator, promise } = await startDelegation(host, root, args)
  host.subagents.accept()
  const result = await promise
  const child = host.agents.add(new FakeAgent(result.childId, 'root'))
  return { delegator, child, childId: result.childId }
}

describe('agent/created: per-role tool scoping', () => {
  it('restricts a scout to the registered read-only surface and gives it escalate', async () => {
    const host = freshHost()
    const { delegator, child } = await dispatchRole(host, 'scout')
    delegator.onChildCreated(child)
    expect(child.tools.restrictCalls).toHaveLength(1)
    expect(child.tools.restrictCalls[0]!.allow).toEqual([
      'read', 'glob', 'grep', 'read_image', 'web_fetch', 'web_search',
    ])
    expect(child.tools.registered).toEqual(['autopilot_escalate'])
  })

  it('leaves a worker unrestricted and gives it escalate', async () => {
    const host = freshHost()
    const { delegator, child } = await dispatchRole(host, 'worker')
    delegator.onChildCreated(child)
    expect(child.tools.restrictCalls).toEqual([])
    expect(child.tools.registered).toEqual(['autopilot_escalate'])
  })

  it('gives an executor-lead delegate + wait + escalate and no restriction', async () => {
    const host = freshHost()
    const { delegator, child } = await dispatchRole(host, 'executor-lead')
    delegator.onChildCreated(child)
    expect(child.tools.restrictCalls).toEqual([])
    expect(child.tools.registered).toEqual(['autopilot_delegate', 'autopilot_agents', 'autopilot_escalate'])
  })

  it('gives the planner the read-only surface and escalate', async () => {
    const host = freshHost()
    const { delegator, child } = await dispatchRole(host, 'planner')
    delegator.onChildCreated(child)
    expect(child.tools.restrictCalls[0]!.allow).toEqual([...READ_ONLY_TOOLS])
    expect(child.tools.registered).toEqual(['autopilot_escalate'])
  })

  it('gives the reviewer no own tools and a read-only surface', async () => {
    const host = freshHost()
    const root = host.agents.get('root')!
    const { delegator, promise } = await startDelegation(host, root, { role: 'reviewer', task: 'Review the diff.' })
    const accepted = host.subagents.accept()
    const child = host.agents.add(new FakeAgent(accepted.activation.childId, 'root'))
    delegator.onChildCreated(child)
    expect(child.tools.restrictCalls[0]!.allow).toEqual([...READ_ONLY_TOOLS])
    expect(child.tools.registered).toEqual([])
    await accepted.settle({ stopReason: 'completed', structured: { verdict: 'pass', findings: [] } })
    await promise
  })

  it('releases the own-scope tools when the child is disposed', async () => {
    const host = freshHost()
    const { delegator, child } = await dispatchRole(host, 'worker')
    delegator.onChildCreated(child)
    expect(child.tools.registered).toEqual(['autopilot_escalate'])
    delegator.onChildDisposed(child)
    expect(child.tools.registered).toEqual([])
  })

  it('ignores an agent that has no delegation record', () => {
    const host = freshHost()
    const root = host.agents.get('root')!
    const delegator = makeDelegator(host)
    const stranger = host.agents.add(new FakeAgent('ghost', root.id))
    expect(() => delegator.onChildCreated(stranger)).not.toThrow()
    expect(stranger.tools.restrictCalls).toEqual([])
    expect(stranger.tools.registered).toEqual([])
  })
})

describe('agent/created: restriction failures fail closed', () => {
  it('retries once with the registry named by the host rejection', async () => {
    const host = freshHost()
    const { delegator, child } = await dispatchRole(host, 'scout')
    child.tools.restrictError = 'tools.restrict() names unknown global tools "web_fetch", "web_search"; known global tools: read, glob, grep, read_image'
    delegator.onChildCreated(child)
    expect(child.tools.restrictCalls).toHaveLength(2)
    expect(child.tools.restrictCalls[1]).toMatchObject({ allow: ['read', 'glob', 'grep', 'read_image'], result: 'applied' })
    expect(child.tools.registered).toEqual(['autopilot_escalate'])
  })

  it('records the delegation as failed and rethrows when the restriction cannot be applied', async () => {
    const host = freshHost()
    const { delegator, child, childId } = await dispatchRole(host, 'scout')
    child.tools.restrictError = 'this deployment has no restriction surface at all'
    let thrown: unknown
    try {
      delegator.onChildCreated(child)
    } catch (error: unknown) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    const record = delegator.records('root').find((entry) => entry.childId === childId)
    expect(record?.state).toBe('failed')
    expect(record?.diagnostic).toContain('tool restriction failed')
    expect(child.tools.registered).toEqual([])
  })

  it('refuses a child whose scope has no restrict member', async () => {
    const host = freshHost()
    const { delegator, child, childId } = await dispatchRole(host, 'scout')
    const bare = {
      id: child.id,
      session: { header: { parentSession: 'root' } },
      ctx: { tools: { register: () => () => {} } },
    }
    let thrown: unknown
    try {
      delegator.onChildCreated(bare as unknown as FakeAgent)
    } catch (error: unknown) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AutopilotError)
    expect((thrown as AutopilotError).code).toBe(AP_TOOL_SURFACE_INCOMPLETE)
    expect(delegator.records('root').find((entry) => entry.childId === childId)?.state).toBe('failed')
  })

  it('re-applies from the ledger record when the armed entry is gone (cold resume)', async () => {
    const host = freshHost()
    const { delegator, child } = await dispatchRole(host, 'scout')
    delegator.onChildCreated(child)
    expect(child.tools.restrictCalls).toHaveLength(1)
    // A resumed agent re-emits agent/created; the armed entry is gone.
    delegator.onChildCreated(child)
    expect(child.tools.restrictCalls).toHaveLength(2)
    expect(child.tools.restrictCalls[1]!.allow).toEqual([
      'read', 'glob', 'grep', 'read_image', 'web_fetch', 'web_search',
    ])
  })
})
