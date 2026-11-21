import { describe, expect, it } from 'vitest'
import { AP_INVALID_ARGUMENT, AP_WRITE_PATHS_REQUIRED, AP_ROLE_NOT_DISPATCHABLE, AP_WRITE_PATHS_CONFLICT, AP_UNKNOWN_CHILD, AP_DISPATCH_FAILED } from '../src/domain/refusals.js'
import { AutopilotError } from '../src/domain/types.js'
import { observedRouteOf } from '../src/delegator.js'
import { FakeAgent, makeHost, startDelegation } from './helpers.js'

const WORKER = {
  role: 'worker',
  task: 'Add the retry test.\nReports the command and its exit code.',
  writePaths: ['src/retry.ts'],
} as const

function rootHost() {
  const root = new FakeAgent('root')
  return { root, host: makeHost({ agents: [root] }) }
}

async function expectRefusal(promise: Promise<unknown>, code: string): Promise<AutopilotError> {
  let thrown: unknown
  try {
    await promise
  } catch (error: unknown) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(AutopilotError)
  expect((thrown as AutopilotError).code).toBe(code)
  return thrown as AutopilotError
}

describe('delegate: success shape', () => {
  it('starts a worker through the local provider and records it', async () => {
    const { root, host } = rootHost()
    const { delegator, promise } = await startDelegation(host, root, WORKER)
    const accepted = host.subagents.accept()
    const result = await promise

    expect(result.role).toBe('worker')
    expect(result.state).toBe('running')
    expect(result.generation).toBe(1)
    expect(result.route).toBeNull()
    expect(result.routeSource).toBe('inherit')
    expect(result.writePaths).toEqual(['src/retry.ts'])
    expect(result.tools).toBe('inherit')
    expect(result.maxDepth).toBe(1)
    expect(result.childId).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.review).toBeUndefined()

    expect(host.subagents.starts).toHaveLength(1)
    const start = host.subagents.starts[0]!
    expect(start.provider).toBe('spawn')
    expect(start.parent).toBe(root)
    expect(start.delivery).toBe('parent')
    expect(start.maxDepth).toBe(1)
    expect(start.childId).toBe(result.childId)
    expect(start.agentOptions).toBeUndefined()
    expect(start.outputSchema).toBeUndefined()
    expect(start.label.startsWith('worker: ')).toBe(true)
    expect(start.prompt).toHaveLength(1)
    const prompt = start.prompt[0]!.text
    expect(prompt).toContain('You are a worker')
    expect(prompt).toContain('Your writePaths (edit nothing outside them): src/retry.ts')
    expect(prompt).toContain('Add the retry test.')
    expect(host.warnings).toEqual([])

    const records = delegator.records('root')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      childId: result.childId,
      parentId: 'root',
      role: 'worker',
      state: 'running',
      title: 'Add the retry test.',
      writePaths: ['src/retry.ts'],
      maxDepth: 1,
      routeSource: 'inherit',
    })

    // A continuable child that settles a turn without a terminal stop is idle.
    await accepted.settle({ stopReason: 'completed' })
    expect(delegator.records('root')[0]!.state).toBe('idle')
    expect(delegator.records('root')[0]!.settledAt).toBeDefined()
  })

  it('sends an explicit route with provider, model and effort', async () => {
    const { root, host } = rootHost()
    const { promise } = await startDelegation(host, root, {
      ...WORKER,
      provider: 'example/provider-a',
      model: 'example/model-a',
      effort: 'low',
    })
    host.subagents.accept()
    const result = await promise

    expect(result.route).toEqual({ provider: 'example/provider-a', model: 'example/model-a', effort: 'low' })
    expect(result.routeSource).toBe('call')
    const start = host.subagents.starts[0]!
    expect(start.agentOptions).toEqual({
      provider: 'example/provider-a',
      model: 'example/model-a',
      reasoningEffort: 'low',
    })
  })

  it('omits effort from the host options when the call names none', async () => {
    const { root, host } = rootHost()
    const { promise } = await startDelegation(host, root, {
      ...WORKER,
      provider: 'example/provider-a',
      model: 'example/model-b',
    })
    host.subagents.accept()
    const result = await promise
    expect(result.route).toEqual({ provider: 'example/provider-a', model: 'example/model-b' })
    expect(host.subagents.starts[0]!.agentOptions).toEqual({ provider: 'example/provider-a', model: 'example/model-b' })
  })

  it('ignores writePaths for a read-only role', async () => {
    const { root, host } = rootHost()
    const { delegator, promise } = await startDelegation(host, root, {
      role: 'scout',
      task: 'Find every caller of the parser.',
      writePaths: ['src/ignored.ts'],
    })
    host.subagents.accept()
    const result = await promise
    expect(result.writePaths).toBeUndefined()
    expect(delegator.records('root')[0]!.writePaths).toBeUndefined()
    expect(result.maxDepth).toBe(1)
    expect(result.tools).toEqual(['read', 'glob', 'grep', 'read_image', 'web_fetch', 'web_search'])
  })
})

describe('delegate: refusals', () => {
  it('refuses an unknown role', async () => {
    const { root, host } = rootHost()
    await expectRefusal(startDelegation(host, root, { role: 'clerk', task: 'x' }).then(({ promise }) => promise), AP_INVALID_ARGUMENT)
    expect(host.subagents.starts).toHaveLength(0)
  })

  it('refuses an empty or blank task', async () => {
    const { root, host } = rootHost()
    await expectRefusal(startDelegation(host, root, { role: 'scout', task: '   ' }).then(({ promise }) => promise), AP_INVALID_ARGUMENT)
  })

  it('refuses a worker without writePaths', async () => {
    const { root, host } = rootHost()
    await expectRefusal(
      startDelegation(host, root, { role: 'worker', task: 'change something' }).then(({ promise }) => promise),
      AP_WRITE_PATHS_REQUIRED,
    )
    expect(host.subagents.starts).toHaveLength(0)
  })

  it('refuses provider without model, and effort without a route', async () => {
    const { root, host } = rootHost()
    await expectRefusal(
      startDelegation(host, root, { ...WORKER, provider: 'example/provider-a' }).then(({ promise }) => promise),
      AP_INVALID_ARGUMENT,
    )
    await expectRefusal(
      startDelegation(host, root, { ...WORKER, effort: 'high' }).then(({ promise }) => promise),
      AP_INVALID_ARGUMENT,
    )
    expect(host.subagents.starts).toHaveLength(0)
  })

  it('refuses a write scope that intersects a live writer', async () => {
    const { root, host } = rootHost()
    const first = await startDelegation(host, root, WORKER)
    host.subagents.accept()
    await first.promise

    await expectRefusal(
      startDelegation(host, root, { ...WORKER, task: 'Another edit in the same file.' }, first.delegator).then(({ promise }) => promise),
      AP_WRITE_PATHS_CONFLICT,
    )
    expect(host.subagents.starts).toHaveLength(1)
  })

  it('allows a disjoint writer and a settled writer awaits', async () => {
    const { root, host } = rootHost()
    const first = await startDelegation(host, root, WORKER)
    const accepted = host.subagents.accept()
    await first.promise
    await accepted.settle({ stopReason: 'completed' })

    const second = await startDelegation(host, root, { ...WORKER, task: 'Same file, after the first settled.' }, first.delegator)
    host.subagents.accept()
    const result = await second.promise
    expect(result.childId).not.toBe(first.promise)
    expect(host.subagents.starts).toHaveLength(2)
  })

  it('refuses a caller that is neither the root nor an executor-lead', async () => {
    const { root, host } = rootHost()
    const scout = await startDelegation(host, root, { role: 'scout', task: 'Read the tree.' })
    host.subagents.accept()
    const scoutResult = await scout.promise
    const child = host.agents.add(new FakeAgent(scoutResult.childId, 'root'))
    await expectRefusal(
      scout.delegator.delegate(child, { role: 'worker', task: 'x', writePaths: ['src/x.ts'] }),
      AP_ROLE_NOT_DISPATCHABLE,
    )
  })

  it('refuses a child the ledger does not know', async () => {
    const { root, host } = rootHost()
    const stranger = host.agents.add(new FakeAgent('stranger', 'root'))
    await expectRefusal(
      startDelegation(host, root, { role: 'scout', task: 'x' }).then(({ delegator }) => delegator.delegate(stranger, { role: 'scout', task: 'x' })),
      AP_ROLE_NOT_DISPATCHABLE,
    )
  })

  it('records a failed dispatch when the host refuses to start the child', async () => {
    const { root, host } = rootHost()
    const { delegator, promise } = await startDelegation(host, root, WORKER)
    await host.subagents.refuse(0, new Error('no capacity'))
    await expectRefusal(promise, AP_DISPATCH_FAILED)
    expect(delegator.records('root')[0]).toMatchObject({ state: 'failed', diagnostic: 'no capacity' })
  })

  it('refuses a replacement that names an unknown child or changes the role', async () => {
    const { root, host } = rootHost()
    const first = await startDelegation(host, root, WORKER)
    host.subagents.accept()
    const result = await first.promise
    await expectRefusal(
      first.delegator.delegate(root, { ...WORKER, replaces: 'missing-child' }),
      AP_UNKNOWN_CHILD,
    )
    const scout = await startDelegation(host, root, { role: 'scout', task: 'Look.' })
    host.subagents.accept()
    const scoutResult = await scout.promise
    await expectRefusal(
      scout.delegator.delegate(root, { ...WORKER, replaces: scoutResult.childId }),
      AP_INVALID_ARGUMENT,
    )
    expect(result.generation).toBe(1)
  })
})

describe('delegate: replacement generation', () => {
  it('starts the same role again with generation + 1', async () => {
    const { root, host } = rootHost()
    const first = await startDelegation(host, root, WORKER)
    host.subagents.accept()
    const firstResult = await first.promise

    const replacement = await startDelegation(host, root, { ...WORKER, task: 'Retry with the bigger model.', replaces: firstResult.childId }, first.delegator)
    host.subagents.accept()
    const second = await replacement.promise
    expect(second.generation).toBe(2)
    expect(second.childId).not.toBe(firstResult.childId)
    const record = replacement.delegator.records('root').find((entry) => entry.childId === second.childId)
    expect(record?.replaces).toBe(firstResult.childId)
  })
})

describe('delegate: executor-lead', () => {
  it('gets depth 2 and may dispatch a scout', async () => {
    const { root, host } = rootHost()
    const lead = await startDelegation(host, root, { role: 'executor-lead', task: 'Own the parser chunk.' })
    host.subagents.accept()
    const leadResult = await lead.promise
    expect(leadResult.maxDepth).toBe(2)
    expect(host.subagents.starts[0]!.maxDepth).toBe(2)

    const leadAgent = host.agents.add(new FakeAgent(leadResult.childId, 'root'))
    const leaf = await startDelegation(host, leadAgent, { role: 'scout', task: 'Inventory the parser tests.' }, lead.delegator)
    host.subagents.accept(0)
    const leafResult = await leaf.promise
    expect(leafResult.role).toBe('scout')
    expect(leafResult.maxDepth).toBe(2)
    expect(leaf.delegator.records('root').find((record) => record.childId === leafResult.childId)?.parentId).toBe(leadResult.childId)
  })

  it('may not dispatch a reviewer or another lead', async () => {
    const { root, host } = rootHost()
    const lead = await startDelegation(host, root, { role: 'executor-lead', task: 'Own the chunk.' })
    host.subagents.accept()
    const leadResult = await lead.promise
    const leadAgent = host.agents.add(new FakeAgent(leadResult.childId, 'root'))
    await expectRefusal(lead.delegator.delegate(leadAgent, { role: 'reviewer', task: 'Review.' }), AP_ROLE_NOT_DISPATCHABLE)
    await expectRefusal(lead.delegator.delegate(leadAgent, { role: 'executor-lead', task: 'Own more.' }), AP_ROLE_NOT_DISPATCHABLE)
    await expectRefusal(lead.delegator.delegate(leadAgent, { role: 'planner', task: 'Plan.' }), AP_ROLE_NOT_DISPATCHABLE)
  })
})

describe('observed route reader', () => {
  it('reads the last well-formed request header', () => {
    const session = {
      snapshotEvents: () => [
        { type: 'request/header', data: { header: { config: { provider: 'example/provider-a', model: 'example/model-a' } } } },
        { type: 'user/message', data: {} },
        { type: 'request/header', data: { header: { config: { provider: 'example/provider-b', model: 'example/model-b', reasoningEffort: 'high' } } } },
      ],
    }
    expect(observedRouteOf(session)).toEqual({ provider: 'example/provider-b', model: 'example/model-b', effort: 'high' })
  })

  it('returns undefined when no log is exposed, the read fails, or the header is malformed', () => {
    expect(observedRouteOf(undefined)).toBeUndefined()
    expect(observedRouteOf({})).toBeUndefined()
    expect(observedRouteOf({ snapshotEvents: () => { throw new Error('gone') } })).toBeUndefined()
    expect(observedRouteOf({ snapshotEvents: () => [{ type: 'request/header', data: { header: { config: { provider: 3 } } } }] })).toBeUndefined()
    expect(observedRouteOf({ snapshotEvents: () => [{ type: 'request/header', data: {} }] })).toBeUndefined()
  })
})