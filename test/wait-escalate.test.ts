import { describe, expect, it } from 'vitest'
import { AP_INVALID_ARGUMENT, AP_ROLE_NOT_DISPATCHABLE, AP_UNKNOWN_CHILD } from '../src/domain/refusals.js'
import { AutopilotError } from '../src/domain/types.js'
import type { DelegateArgs } from '../src/delegator.js'
import { FakeAgent, makeHost, startDelegation } from './helpers.js'

function freshHost() {
  const root = new FakeAgent('root')
  return { root, host: makeHost({ agents: [root] }) }
}

async function dispatch(host: ReturnType<typeof freshHost>['host'], root: FakeAgent, args: DelegateArgs, existing?: import('../src/delegator.js').Delegator) {
  const { delegator, promise } = await startDelegation(host, root, args, existing)
  const accepted = host.subagents.accept()
  const result = await promise
  return { delegator, accepted, result }
}

const worker = (path: string): DelegateArgs => ({ role: 'worker', task: `Edit ${path}.`, writePaths: [path] })

describe('wait', () => {
  it('settles when every listed child settles', async () => {
    const { root, host } = freshHost()
    const first = await dispatch(host, root, worker('src/a.ts'))
    const second = await dispatch(host, root, worker('src/b.ts'), first.delegator)

    const waiting = first.delegator.wait(root, undefined, 5)
    await first.accepted.settle({ stopReason: 'completed' })
    let settled = false
    void waiting.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    await second.accepted.settle({ stopReason: 'completed' })
    const outcome = await waiting
    expect(outcome.timedOut).toBe(false)
    expect(outcome.delegations.map((record) => record.state)).toEqual(['idle', 'idle'])
    expect(outcome.delegations.every((record) => record.settledAt !== undefined)).toBe(true)
  })

  it('returns timedOut without settling the children', async () => {
    const { root, host } = freshHost()
    const dispatched = await dispatch(host, root, worker('src/a.ts'))
    const outcome = await dispatched.delegator.wait(root, undefined, 0)
    expect(outcome.timedOut).toBe(true)
    expect(outcome.delegations).toHaveLength(1)
    expect(outcome.delegations[0]!.state).toBe('running')
  })

  it('refuses an unknown child id', async () => {
    const { root, host } = freshHost()
    const dispatched = await dispatch(host, root, worker('src/a.ts'))
    let thrown: unknown
    try {
      await dispatched.delegator.wait(root, ['missing'], 1)
    } catch (error: unknown) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AutopilotError)
    expect((thrown as AutopilotError).code).toBe(AP_UNKNOWN_CHILD)
  })

  it('waits only for the named children', async () => {
    const { root, host } = freshHost()
    const first = await dispatch(host, root, worker('src/a.ts'))
    const second = await dispatch(host, root, worker('src/b.ts'), first.delegator)
    const waiting = first.delegator.wait(root, [second.result.childId], 0)
    const outcome = await waiting
    expect(outcome.delegations.map((record) => record.childId)).toEqual([second.result.childId])
  })

  it("defaults to the caller's own children, not the whole tree", async () => {
    const { root, host } = freshHost()
    const lead = await dispatch(host, root, { role: 'executor-lead', task: 'Own the chunk.' })
    const leadAgent = host.agents.add(new FakeAgent(lead.result.childId, 'root'))
    const leaf = await dispatch(host, leadAgent, { role: 'scout', task: 'Inventory the tests.' }, lead.delegator)

    const rootView = await leaf.delegator.wait(root, undefined, 0)
    expect(rootView.delegations.map((record) => record.role)).toEqual(['executor-lead'])

    const leadView = await leaf.delegator.wait(leadAgent, undefined, 0)
    expect(leadView.delegations.map((record) => record.role)).toEqual(['scout'])
    expect(leadView.timedOut).toBe(true)
  })

  it('reports a cancelled child as cancelled', async () => {
    const { root, host } = freshHost()
    const dispatched = await dispatch(host, root, worker('src/a.ts'))
    const waiting = dispatched.delegator.wait(root, undefined, 5)
    await dispatched.accepted.settle({ stopReason: 'aborted' })
    const outcome = await waiting
    expect(outcome.delegations[0]!.state).toBe('cancelled')
  })

  it('records a failed settlement with the host diagnostic', async () => {
    const { root, host } = freshHost()
    const dispatched = await dispatch(host, root, worker('src/a.ts'))
    const waiting = dispatched.delegator.wait(root, undefined, 5)
    await dispatched.accepted.settle({ stopReason: 'max-tokens', diagnostic: 'hit the token ceiling' })
    const outcome = await waiting
    expect(outcome.delegations[0]).toMatchObject({ state: 'failed', diagnostic: 'hit the token ceiling' })
  })
})

describe('escalate', () => {
  it('records the request on the child record and returns guidance', async () => {
    const { root, host } = freshHost()
    const dispatched = await dispatch(host, root, { role: 'scout', task: 'Inventory the parser.' })
    const child = host.agents.add(new FakeAgent(dispatched.result.childId, 'root'))

    const guidance = await dispatched.delegator.escalate(child, '  the parser has two entry points and I cannot tell which is live  ')
    expect(guidance.startsWith('Recorded.')).toBe(true)

    const record = dispatched.delegator.records('root')[0]!
    expect(record.escalation?.reason).toBe('the parser has two entry points and I cannot tell which is live')
    expect(record.escalation?.at).toBeDefined()
  })

  it('refuses the root agent', async () => {
    const { root, host } = freshHost()
    const dispatched = await dispatch(host, root, { role: 'scout', task: 'x' })
    await expect(dispatched.delegator.escalate(root, 'need more')).rejects.toMatchObject({ code: AP_UNKNOWN_CHILD })
  })

  it('refuses an unknown child and an empty reason', async () => {
    const { root, host } = freshHost()
    const dispatched = await dispatch(host, root, { role: 'scout', task: 'x' })
    const stranger = host.agents.add(new FakeAgent('stranger', 'root'))
    await expect(dispatched.delegator.escalate(stranger, 'x')).rejects.toMatchObject({ code: AP_UNKNOWN_CHILD })

    const child = host.agents.add(new FakeAgent(dispatched.result.childId, 'root'))
    await expect(dispatched.delegator.escalate(child, '   ')).rejects.toMatchObject({ code: AP_INVALID_ARGUMENT })
  })

  it('refuses an escalation from the reviewer', async () => {
    const { root, host } = freshHost()
    const { delegator, promise } = await startDelegation(host, root, { role: 'reviewer', task: 'Review.' })
    const accepted = host.subagents.accept()
    const reviewer = host.agents.add(new FakeAgent(accepted.activation.childId, 'root'))
    await accepted.settle({ stopReason: 'completed', structured: { verdict: 'pass', findings: [] } })
    await promise
    await expect(delegator.escalate(reviewer, 'need a bigger model')).rejects.toMatchObject({ code: AP_ROLE_NOT_DISPATCHABLE })
  })

  it('shows the escalation on the wait record', async () => {
    const { root, host } = freshHost()
    const dispatched = await dispatch(host, root, { role: 'scout', task: 'x' })
    const child = host.agents.add(new FakeAgent(dispatched.result.childId, 'root'))
    await dispatched.delegator.escalate(child, 'blocked')
    const outcome = await dispatched.delegator.wait(root, undefined, 0)
    expect(outcome.delegations[0]!.escalation?.reason).toBe('blocked')
  })
})

describe('wait: observed route', () => {
  it('records the route the child actually used', async () => {
    const { root, host } = freshHost()
    const dispatched = await dispatch(host, root, worker('src/a.ts'))
    const child = host.agents.add(new FakeAgent(dispatched.result.childId, 'root'))
    dispatched.delegator.onChildCreated(child)
    child.recordRequest('example/provider-a', 'example/model-a', 'low')
    const waiting = dispatched.delegator.wait(root, undefined, 5)
    await dispatched.accepted.settle({ stopReason: 'completed' })
    const outcome = await waiting
    expect(outcome.delegations[0]!.observed).toEqual({ provider: 'example/provider-a', model: 'example/model-a', effort: 'low' })
  })
})