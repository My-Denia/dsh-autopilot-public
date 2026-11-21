import { describe, expect, it } from 'vitest'
import { REVIEW_VERDICT_SCHEMA } from '../src/roles/index.js'
import { AP_DISPATCH_FAILED, AP_ROLE_VERDICT_INVALID, AP_TOOL_SURFACE_INCOMPLETE } from '../src/domain/refusals.js'
import { AutopilotError } from '../src/domain/types.js'
import { FakeAgent, FakeTools, makeHost, startDelegation } from './helpers.js'

const REVIEW_TASK = 'Claim: the retry loop now caps attempts at three. Diff: src/retry.ts. Command: pnpm test.'

async function caught(promise: Promise<unknown>): Promise<AutopilotError> {
  try {
    await promise
    throw new Error('expected a refusal')
  } catch (error: unknown) {
    if (!(error instanceof AutopilotError)) throw error
    return error
  }
}

function rootHost(tools?: FakeTools) {
  const root = new FakeAgent('root')
  return { root, host: makeHost({ agents: [root], ...(tools === undefined ? {} : { tools }) }) }
}

describe('reviewer: in-band structured verdict', () => {
  it('waits for the reviewer and returns pass in-band', async () => {
    const { root, host } = rootHost()
    const { delegator, promise } = await startDelegation(host, root, { role: 'reviewer', task: REVIEW_TASK })
    const accepted = host.subagents.accept()

    const start = host.subagents.starts[0]!
    expect(start.delivery).toBe('caller')
    expect(start.outputSchema).toEqual(REVIEW_VERDICT_SCHEMA)
    expect(start.maxDepth).toBe(1)
    expect(start.prompt[0]!.text).toContain('independent reviewer')
    expect(start.prompt[0]!.text).toContain(REVIEW_TASK)

    await accepted.settle({ stopReason: 'completed', structured: { verdict: 'pass', findings: [] } })
    const result = await promise
    expect(result.review).toEqual({ verdict: 'pass', findings: [] })
    expect(result.state).toBe('completed')
    expect(delegator.records('root')[0]!.state).toBe('completed')
  })

  it('returns a failing verdict with its findings', async () => {
    const { root, host } = rootHost()
    const { delegator, promise } = await startDelegation(host, root, { role: 'reviewer', task: REVIEW_TASK })
    const accepted = host.subagents.accept()
    const verdict = {
      verdict: 'fail',
      findings: [
        { severity: 'blocker', note: 'attempts is not capped', file: 'src/retry.ts', line: 42 },
        { severity: 'note', note: 'error text lost the attempt count' },
      ],
      summary: 'the claim is not what the code does',
    }
    await accepted.settle({ stopReason: 'completed', structured: verdict })
    const result = await promise
    expect(result.review).toEqual(verdict)
    expect(delegator.records('root')[0]!.state).toBe('completed')
  })

  it('rejects a verdict that fails validation and records the child as failed', async () => {
    const { root, host } = rootHost()
    const { delegator, promise } = await startDelegation(host, root, { role: 'reviewer', task: REVIEW_TASK })
    const accepted = host.subagents.accept()
    await accepted.settle({ stopReason: 'completed', structured: { verdict: 'needs-fix', findings: [] } })
    const error = await caught(promise)
    expect(error.code).toBe(AP_ROLE_VERDICT_INVALID)
    expect(error.message).toContain('verdict must be one of pass | fail')
    expect(delegator.records('root')[0]).toMatchObject({ state: 'failed', diagnostic: 'verdict must be one of pass | fail' })
  })

  it('rejects a pass that carries a blocker', async () => {
    const { root, host } = rootHost()
    const { promise } = await startDelegation(host, root, { role: 'reviewer', task: REVIEW_TASK })
    const accepted = host.subagents.accept()
    await accepted.settle({
      stopReason: 'completed',
      structured: { verdict: 'pass', findings: [{ severity: 'blocker', note: 'broken' }] },
    })
    const error = await caught(promise)
    expect(error.code).toBe(AP_ROLE_VERDICT_INVALID)
    expect(error.message).toContain('inconsistent')
  })

  it('maps a non-completed reviewer run to a dispatch failure', async () => {
    const { root, host } = rootHost()
    const { delegator, promise } = await startDelegation(host, root, { role: 'reviewer', task: REVIEW_TASK })
    const accepted = host.subagents.accept()
    await accepted.settle({ stopReason: 'error', diagnostic: 'the model stream failed' })
    const error = await caught(promise)
    expect(error.code).toBe(AP_DISPATCH_FAILED)
    expect(error.message).toContain('the model stream failed')
    expect(delegator.records('root')[0]).toMatchObject({ state: 'failed', diagnostic: 'the model stream failed' })
  })

  it('maps a rejected activation to a dispatch failure', async () => {
    const { root, host } = rootHost()
    const { promise } = await startDelegation(host, root, { role: 'reviewer', task: REVIEW_TASK })
    const accepted = host.subagents.accept()
    await accepted.fail(new Error('transport reset'))
    const error = await caught(promise)
    expect(error.code).toBe(AP_DISPATCH_FAILED)
    expect(error.message).toContain('transport reset')
  })

  it('gives the reviewer only the registered read-only tools', async () => {
    const tools = new FakeTools(['read', 'grep', 'bash', 'write', 'autopilot_escalate'])
    const { root, host } = rootHost(tools)
    const { promise } = await startDelegation(host, root, { role: 'reviewer', task: REVIEW_TASK })
    const accepted = host.subagents.accept()
    await accepted.settle({ stopReason: 'completed', structured: { verdict: 'pass', findings: [] } })
    const result = await promise
    expect(result.tools).toEqual(['read', 'grep'])
  })
})

describe('reviewer: no read surface', () => {
  it('refuses to start a reviewer that could not read', async () => {
    const tools = new FakeTools(['glob', 'grep', 'bash'])
    const { root, host } = rootHost(tools)
    const error = await caught(startDelegation(host, root, { role: 'reviewer', task: REVIEW_TASK }).then(({ promise }) => promise))
    expect(error.code).toBe(AP_TOOL_SURFACE_INCOMPLETE)
    expect(host.subagents.starts).toHaveLength(0)
  })

  it('passes the request through when the registry cannot be read', async () => {
    const tools = new FakeTools(['read'], true)
    const { root, host } = rootHost(tools)
    const { promise } = await startDelegation(host, root, { role: 'reviewer', task: REVIEW_TASK })
    const accepted = host.subagents.accept()
    await accepted.settle({ stopReason: 'completed', structured: { verdict: 'pass', findings: [] } })
    const result = await promise
    expect(result.tools).toEqual(['read', 'glob', 'grep', 'read_image'])
  })
})

describe('reviewer: observed route', () => {
  it('records the route the reviewer actually used', async () => {
    const root = new FakeAgent('root')
    const host = makeHost({ agents: [root] })
    const { delegator, promise } = await startDelegation(host, root, { role: 'reviewer', task: REVIEW_TASK })
    const accepted = host.subagents.accept()
    const child = host.agents.add(new FakeAgent(accepted.activation.childId, 'root'))
    delegator.onChildCreated(child)
    child.recordRequest('example/provider-b', 'example/model-b', 'high')
    await accepted.settle({ stopReason: 'completed', structured: { verdict: 'pass', findings: [] } })
    const result = await promise
    expect(result.observed).toEqual({ provider: 'example/provider-b', model: 'example/model-b', effort: 'high' })
    expect(delegator.records('root')[0]!.observed).toEqual({ provider: 'example/provider-b', model: 'example/model-b', effort: 'high' })
  })
})