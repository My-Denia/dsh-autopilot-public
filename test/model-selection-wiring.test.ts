/**
 * The user's `subagentModelSelection` setting reaches delegation routing
 * THROUGH `apply()`: a host-shaped `ctx.subagentModelSelection` service in, the
 * plugin as composed in `src/index.ts`, and a real `autopilot_delegate` tool
 * call out. The route is never injected into `roles/route.ts` here.
 *
 * Why this exists: `environment.modelSelection` was a port nothing supplied, so
 * an explicit user allowed-route list was ignored for plugin dispatches (which go
 * through `ctx.subagents.startActivation`, not the host's own enforcing tool).
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply, modelSelectionSettingOf } from '../src/index.js'
import { stubLlm } from './helpers.js'
import type { StubModel } from './helpers.js'

const MODELS: readonly StubModel[] = [
  { provider: 'alpha', id: 'm-a', contextWindow: 131072 },
  { provider: 'alpha', id: 'm-b', contextWindow: 131072 },
  { provider: 'beta', id: 'b-1', contextWindow: 200000 },
]

type Setting = { enabled: boolean; allowedModels: Array<{ provider: string; model: string }> }
type Event = { type: string; data: unknown }

async function mount(options: { setting?: () => Setting; service?: unknown; policy?: Array<{ provider: string; model: string }> | null }) {
  const storeRoot = mkdtempSync(join(tmpdir(), 'dsh-autopilot-selection-'))
  const tools: Array<{ name?: string; execute?: (args: unknown, exec: unknown) => Promise<unknown> }> = []
  const events: Event[] = []
  const starts: Array<{ provider: string; agentOptions?: { provider?: string; model?: string } }> = []
  const warnings: string[] = []
  const root = {
    id: 'root-1',
    options: { provider: 'fake', model: 'fake-model' },
    session: {
      header: {},
      snapshotEvents: () => events.slice(),
      append(type: string, data: unknown) { events.push({ type, data }) },
    },
    ctx: { tools: { register(definition: never) { tools.push(definition); return () => {} } } },
  }
  // The session policy as the host's projection answers it: null = native default (none recorded).
  const policy = options.policy === undefined ? null : options.policy
  const service = options.service ?? (options.setting === undefined ? undefined : { current: options.setting })
  const ctx = {
    ...(service === undefined ? {} : { subagentModelSelection: service }),
    llm: stubLlm(MODELS),
    sessionProjections: {
      stateOf: (_session: unknown, key: string) => (key === 'subagentModelSelectionPolicy' ? policy : undefined),
      register: () => () => {},
    },
    agents: { get: (id: string) => (id === root.id ? root : undefined), list: () => [root], roots: () => [root] },
    subagents: {
      async startActivation(spec: { childId?: string; provider: string; request: { agentOptions?: { provider?: string; model?: string } } }) {
        starts.push({ provider: spec.provider, ...(spec.request.agentOptions === undefined ? {} : { agentOptions: spec.request.agentOptions }) })
        return { childId: spec.childId ?? 'child-1', result: new Promise(() => {}), async dispose() {} }
      },
      async sendMessage() { return {} },
      interrupt() {},
      async drainChildren() { return {} },
    },
    systemPrompt: { section: () => () => {} },
    provide: () => () => {},
    logger: { warn(message: string) { warnings.push(message) } },
    on: () => () => {},
  }
  const dispose = await apply(ctx as never, { storeRoot, skillInstall: 'off' })
  const delegate = tools.find(tool => tool.name === 'autopilot_delegate')!
  const call = async (args: Record<string, unknown>) => {
    // A refusal is a thrown AutopilotError carrying its code; flatten both outcomes to text.
    try {
      return JSON.stringify(await delegate.execute!({ role: 'scout', task: 'look around', ...args }, { agent: root }))
    } catch (error) {
      return `${(error as { code?: string }).code ?? 'ERROR'}: ${(error as Error).message}`
    }
  }
  return { call, starts, warnings, dispose }
}

const ONLY_ALPHA_A: Setting = { enabled: true, allowedModels: [{ provider: 'alpha', model: 'm-a' }] }

describe('subagentModelSelection reaches delegation through apply()', () => {
  it('refuses an explicit route outside the user allowed list with AP_ROLE_ROUTE_NOT_ALLOWED, and dispatches nothing', async () => {
    const m = await mount({ setting: () => ONLY_ALPHA_A })
    const out = await m.call({ provider: 'beta', model: 'b-1' })
    expect(out).toContain('AP_ROLE_ROUTE_NOT_ALLOWED')
    expect(out).toContain('subagentModelSelection allowedModels')
    expect(m.starts).toEqual([])
    await m.dispose()
  })

  it('accepts an explicit route inside the allowed list and sends it', async () => {
    const m = await mount({ setting: () => ONLY_ALPHA_A })
    const out = await m.call({ provider: 'alpha', model: 'm-a' })
    expect(out).not.toContain('AP_ROLE_ROUTE_NOT_ALLOWED')
    expect(m.starts).toHaveLength(1)
    expect(m.starts[0]!.agentOptions).toMatchObject({ provider: 'alpha', model: 'm-a' })
    await m.dispose()
  })

  it('reads the setting live: a list changed after mount applies to the next dispatch', async () => {
    let current: Setting = ONLY_ALPHA_A
    const m = await mount({ setting: () => current })
    expect(await m.call({ provider: 'beta', model: 'b-1' })).toContain('AP_ROLE_ROUTE_NOT_ALLOWED')
    current = { enabled: true, allowedModels: [{ provider: 'beta', model: 'b-1' }] }
    expect(await m.call({ provider: 'beta', model: 'b-1' })).not.toContain('AP_ROLE_ROUTE_NOT_ALLOWED')
    await m.dispose()
  })

  it('never widens: a route in the setting but outside the recorded session policy is still refused', async () => {
    const m = await mount({
      setting: () => ({ enabled: true, allowedModels: [{ provider: 'alpha', model: 'm-a' }, { provider: 'beta', model: 'b-1' }] }),
      policy: [{ provider: 'alpha', model: 'm-a' }],
    })
    expect(await m.call({ provider: 'beta', model: 'b-1' })).toContain('AP_ROLE_ROUTE_NOT_ALLOWED')
    expect(m.starts).toEqual([])
    await m.dispose()
  })

  it.each([
    ['setting off', { service: { current: () => ({ enabled: false, allowedModels: [{ provider: 'alpha', model: 'm-a' }] }) } }],
    ['service absent', {}],
    ['service throws', { service: { current: () => { throw new Error('enabled subagent model selection requires at least one allowed model') } } }],
    ['malformed answer', { service: { current: () => ({ enabled: 'yes' }) } }],
  ])('%s: behavior is unchanged (an outside route is not refused by the setting)', async (_label, options) => {
    const m = await mount(options)
    const out = await m.call({ provider: 'beta', model: 'b-1' })
    expect(out).not.toContain('AP_ROLE_ROUTE_NOT_ALLOWED')
    expect(m.starts).toHaveLength(1)
    await m.dispose()
  })

  it('warns once, not per dispatch, when the setting is unreadable', async () => {
    const m = await mount({ service: { current: () => { throw new Error('boom') } } })
    await m.call({ provider: 'beta', model: 'b-1' })
    await m.call({ provider: 'alpha', model: 'm-b' })
    expect(m.warnings.filter(w => w.includes('subagentModelSelection'))).toHaveLength(1)
    await m.dispose()
  })
})

describe('modelSelectionSettingOf', () => {
  it('copies the host answer and survives a strict ctx that throws on an undeclared service', () => {
    const strict = new Proxy({}, { get() { throw new Error('cannot get property without inject') } })
    expect(modelSelectionSettingOf(strict)).toBeUndefined()
    const setting = modelSelectionSettingOf({ subagentModelSelection: { current: () => ONLY_ALPHA_A } })
    expect(setting).toEqual(ONLY_ALPHA_A)
    expect(setting?.allowedModels).not.toBe(ONLY_ALPHA_A.allowedModels)
  })
})
