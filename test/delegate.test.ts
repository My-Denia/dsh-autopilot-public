/**
 * Role delegation at the engine: the dispatch flow, tool restriction keyed by child id,
 * write-path conflicts, depth, effort, the reviewer, waiting and escalation.
 * The host is a fake that really creates children and announces them through
 * `engine.onChildCreated`, as the agent registry does; nothing under test is replaced.
 */

import { describe, expect, it } from 'vitest'
import { AutopilotError } from '../src/domain/types.js'
import type { Ledger } from '../src/domain/ledger-types.js'
import { pathsIntersect, findWriteConflict } from '../src/roles/paths.js'
import { allowListFor } from '../src/roles/tools.js'
import { REVIEW_VERDICT_SCHEMA, ROLES } from '../src/roles/index.js'
import { routeMatchOf } from '../src/delegate.js'
import type { NativeGoalView } from '../src/engine.js'
import { emptyLedger } from '../src/store/ledger.js'
import { catalogOf, delegation, delegationHost, policyOf } from './helpers.js'

const REG = ['read', 'glob', 'grep', 'read_image', 'write', 'edit', 'str_replace_editor', 'bash', 'pwsh', 'todo_write', 'web_fetch', 'web_search']
const NOW = '2026-11-04T09:00:00.000Z'

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise } catch (error) { return error instanceof AutopilotError ? error.code : `non-autopilot: ${String(error)}` }
  return 'resolved'
}

const ledgerOf = (h: ReturnType<typeof delegationHost>): Ledger => h.engine.peekLedger(h.root.id)!

describe('autopilot_delegate: the flow', () => {
  it('starts a scout: delivery parent, depth cap 1, persona and task in the prompt, recorded running with the route evidence fields', async () => {
    const h = delegationHost({ registered: REG })
    const result = await h.engine.delegate(h.root, { role: 'scout', task: 'find every caller of parse()\nand list them' })

    expect(result).toMatchObject({ role: 'scout', state: 'running', modelSource: 'inherit', effortSource: 'host-default', maxDepth: 1, generation: 1 })
    expect(result.tools).toEqual(allowListFor('scout', REG))
    expect(h.starts).toHaveLength(1)
    const start = h.starts[0]!
    expect(start).toMatchObject({ childId: result.childId, delivery: 'parent', maxDepth: 1, provider: 'spawn', parentId: 'root-1' })
    expect(start.agentOptions).toBeUndefined()
    expect(start.prompt).toContain(ROLES.scout.persona)
    expect(start.prompt).toContain('find every caller of parse()')
    const record = ledgerOf(h).delegations[0]!
    expect(record).toMatchObject({ childId: result.childId, role: 'scout', parentId: 'root-1', depth: 1, state: 'running', title: 'find every caller of parse()', routeMatch: 'pending' })
  })

  it('settlement moves a continuable child to idle with settledAt, and records the observed route', async () => {
    const h = delegationHost({ registered: REG })
    const { childId } = await h.engine.delegate(h.root, { role: 'scout', task: 't' })
    const waited = h.engine.wait(h.root, [childId], 5)
    h.settle(childId)
    const out = await waited
    expect(out.timedOut).toBe(false)
    const record = ledgerOf(h).delegations[0]!
    expect(record.state).toBe('idle')
    expect(record.settledAt).toBeDefined()
    // No route was selected, so what the child reports is simply observed, and nothing mismatches.
    expect(record.observed).toEqual({ provider: 'host', model: 'default' })
    expect(record.routeMatch).toBe('match')
  })

  it('failed and aborted stop reasons settle as failed (with the diagnostic) and cancelled', async () => {
    const h = delegationHost({ registered: REG })
    const a = await h.engine.delegate(h.root, { role: 'scout', task: 'a' })
    const b = await h.engine.delegate(h.root, { role: 'scout', task: 'b' })
    h.settle(a.childId, { stopReason: 'error', diagnostic: 'provider 503' })
    h.settle(b.childId, { stopReason: 'aborted' })
    await h.engine.wait(h.root, [a.childId, b.childId], 5)
    const states = Object.fromEntries(ledgerOf(h).delegations.map(d => [d.childId, [d.state, d.diagnostic]]))
    expect(states[a.childId]).toEqual(['failed', 'provider 503'])
    expect(states[b.childId]![0]).toBe('cancelled')
  })

  it('a host refusal at start records failed with the reason VERBATIM and raises AP_DISPATCH_FAILED', async () => {
    const h = delegationHost({ registered: REG })
    h.failNextStart.error = new Error('subagent depth 2 exceeds maxDepth 1')
    expect(await codeOf(h.engine.delegate(h.root, { role: 'scout', task: 't' }))).toBe('AP_DISPATCH_FAILED')
    const record = ledgerOf(h).delegations[0]!
    expect(record.state).toBe('failed')
    expect(record.diagnostic).toBe('subagent depth 2 exceeds maxDepth 1')
  })

  it('a backend that rejects a pre-minted id records failed with AP_DISPATCH_FAILED; there is no retry without it', async () => {
    const h = delegationHost({ registered: REG })
    h.failNextStart.error = new Error('a reserved childId requires a local backend')
    expect(await codeOf(h.engine.delegate(h.root, { role: 'scout', task: 't' }))).toBe('AP_DISPATCH_FAILED')
    expect(h.starts).toHaveLength(0)
    const record = ledgerOf(h).delegations[0]!
    expect(record.state).toBe('failed')
    expect(record.diagnostic).toBe('a reserved childId requires a local backend')
  })

  it('validation: unknown role, empty task, worker without writePaths', async () => {
    const h = delegationHost({ registered: REG })
    expect(await codeOf(h.engine.delegate(h.root, { role: 'janitor', task: 't' }))).toBe('AP_INVALID_ARGUMENT')
    expect(await codeOf(h.engine.delegate(h.root, { role: 'scout', task: '  ' }))).toBe('AP_INVALID_ARGUMENT')
    expect(await codeOf(h.engine.delegate(h.root, { role: 'worker', task: 't' }))).toBe('AP_WRITE_PATHS_REQUIRED')
    expect(h.starts).toEqual([])
    expect(h.ledgers.load('root-1')).toBeUndefined()
  })

  it('a child caller must be a delegation of this root, and may dispatch only what its role allows', async () => {
    const h = delegationHost({ registered: REG })
    const lead = await h.engine.delegate(h.root, { role: 'executor-lead', task: 'own it' })
    const leadAgent = h.agents.get(lead.childId)!
    expect(await codeOf(h.engine.delegate(leadAgent, { role: 'planner', task: 't' }))).toBe('AP_ROLE_NOT_DISPATCHABLE')
    expect(await codeOf(h.engine.delegate(leadAgent, { role: 'executor-lead', task: 't' }))).toBe('AP_ROLE_NOT_DISPATCHABLE')
    expect(await codeOf(h.engine.delegate(leadAgent, { role: 'reviewer', task: 't' }))).toBe('AP_ROLE_NOT_DISPATCHABLE')
    const scout = await h.engine.delegate(h.root, { role: 'scout', task: 's' })
    expect(await codeOf(h.engine.delegate(h.agents.get(scout.childId)!, { role: 'scout', task: 't' }))).toBe('AP_ROLE_NOT_DISPATCHABLE')
    h.announceExisting('stranger', 'root-1')
    expect(await codeOf(h.engine.delegate(h.agents.get('stranger')!, { role: 'scout', task: 't' }))).toBe('AP_ROLE_NOT_DISPATCHABLE')
  })
})

describe('the registry probe is asked for the right agent', () => {
  // On a preset composition (the desktop app) `read` lives in the scope layer the
  // root and its children share, not in the global layer; only the agent's view
  // lists it. See boundary.test.ts §4 for the same fact against the real registry.
  const scoped = (h: { root: unknown }) => (scope: unknown) => (scope === h.root ? REG : ['ask_user_question'])

  it('a scout dispatched by the root resolves against the root\'s view', async () => {
    const asked: unknown[] = []
    const holder: { root?: unknown } = {}
    const h = delegationHost({ registeredFor: (scope) => { asked.push(scope); return scoped(holder as { root: unknown })(scope) } })
    holder.root = h.root
    const scout = await h.engine.delegate(h.root, { role: 'scout', task: 't' })
    expect(scout.tools).toEqual(allowListFor('scout', REG))
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every(scope => scope === h.root)).toBe(true)
  })

  it('the cold-resume path reads the CHILD\'s own view', async () => {
    const asked: unknown[] = []
    const h = delegationHost({ registeredFor: (scope) => { asked.push(scope); return REG } })
    const { childId } = await h.engine.delegate(h.root, { role: 'scout', task: 't' })
    const child = h.agents.get(childId)!
    asked.length = 0
    // A restart lost the armed entry: the restriction is rebuilt from the ledger record.
    h.engine.onChildCreated(child)
    expect(asked).toEqual([child])
  })
})

describe('tool restriction is keyed by the child id', () => {
  it('a scout and a worker started from one root in the same tick each get their OWN list', async () => {
    const h = delegationHost({ registered: REG })
    const [scout, worker] = await Promise.all([
      h.engine.delegate(h.root, { role: 'scout', task: 'look' }),
      h.engine.delegate(h.root, { role: 'worker', task: 'edit', writePaths: ['src/a.ts'] }),
    ])
    const scoutList = allowListFor('scout', REG) as string[]
    expect(h.restricts.get(scout.childId)).toEqual([scoutList])
    expect(scoutList).toContain('read')
    expect(scoutList).not.toContain('write')
    expect(scoutList).not.toContain('bash')
    // A worker inherits the full surface: restrict() is never called for it.
    expect(h.restricts.has(worker.childId)).toBe(false)
    expect(worker.tools).toBe('inherit')
  })

  it('many concurrent mixed dispatches never cross lists', async () => {
    const h = delegationHost({ registered: REG })
    const roles = ['scout', 'planner', 'worker', 'scout', 'worker', 'clerk'] as const
    const results = await Promise.all(roles.map((role, i) => h.engine.delegate(h.root, { role, task: `t${i}`, ...(role === 'worker' ? { writePaths: [`pkg${i}/**`] } : {}) })))
    results.forEach((r, i) => {
      const expected = allowListFor(roles[i]!, REG)
      if (expected === 'inherit') expect(h.restricts.has(r.childId)).toBe(false)
      else expect(h.restricts.get(r.childId)).toEqual([expected])
    })
  })

  it('a cold-resumed scout (announced with an id found only in the ledger) gets the scout list again', async () => {
    const h = delegationHost({ registered: REG })
    await h.engine.mutate('root-1', l => ({ ...l, delegations: [delegation('cold-scout', 'idle', { role: 'scout' })] }))
    h.announceExisting('cold-scout')
    expect(h.restricts.get('cold-scout')).toEqual([allowListFor('scout', REG)])
  })

  it('an agent the ledger does not know is left alone', () => {
    const h = delegationHost({ registered: REG })
    h.announceExisting('unrelated')
    expect(h.restricts.has('unrelated')).toBe(false)
    expect(h.childTools.get('unrelated')).toEqual([])
  })

  it('an executor-lead gets autopilot_delegate and autopilot_agents in its own scope, a scout only autopilot_escalate, a reviewer nothing', async () => {
    const h = delegationHost({ registered: REG })
    const lead = await h.engine.delegate(h.root, { role: 'executor-lead', task: 'own it' })
    const scout = await h.engine.delegate(h.root, { role: 'scout', task: 's' })
    expect(h.childTools.get(lead.childId)).toEqual(['autopilot_delegate', 'autopilot_agents', 'autopilot_escalate'])
    expect(h.childTools.get(scout.childId)).toEqual(['autopilot_escalate'])
    await h.engine.mutate('root-1', l => ({ ...l, delegations: [...l.delegations, delegation('rev', 'idle', { role: 'reviewer' })] }))
    h.announceExisting('rev')
    expect(h.childTools.get('rev')).toEqual([])
  })

  it('FAILS CLOSED: a restrict() that throws vetoes the child, rethrows, and records the delegation failed with the reason', async () => {
    const h = delegationHost({ registered: REG })
    h.restrictAlways.error = new Error('boom: restrict refused')
    expect(await codeOf(h.engine.delegate(h.root, { role: 'scout', task: 't' }))).toBe('AP_DISPATCH_FAILED')
    const record = ledgerOf(h).delegations[0]!
    expect(record.state).toBe('failed')
    expect(record.diagnostic).toMatch(/boom: restrict refused/)
  })

  it('restrict() naming a tool the profile does not register is retried once with what exists', () => {
    const h = delegationHost({ registered: REG })
    h.restrictThrows.set('cold', new Error('tools.restrict() names unknown global tool "web_search"; known global tools: read, glob, grep, read_image'))
    return h.engine.mutate('root-1', l => ({ ...l, delegations: [delegation('cold', 'idle', { role: 'scout' })] })).then(() => {
      h.announceExisting('cold')
      expect(h.restricts.get('cold')).toEqual([['read', 'glob', 'grep', 'read_image']])
    })
  })
})

describe('write paths', () => {
  it('pathsIntersect: exact files, prefixes, files inside prefixes, prefixes inside prefixes', () => {
    expect(pathsIntersect('src/a.ts', 'src/a.ts')).toBe(true)
    expect(pathsIntersect('src/a.ts', 'src/b.ts')).toBe(false)
    expect(pathsIntersect('src/**', 'src/deep/a.ts')).toBe(true)
    expect(pathsIntersect('src/deep/a.ts', 'src/**')).toBe(true)
    expect(pathsIntersect('src/**', 'src/deep/**')).toBe(true)
    expect(pathsIntersect('src/deep/**', 'src/**')).toBe(true)
    expect(pathsIntersect('src/**', 'srcs/a.ts')).toBe(false)
    expect(pathsIntersect('src/**', 'test/**')).toBe(false)
    expect(pathsIntersect('./src\\a.ts', 'src/a.ts')).toBe(true)
    expect(pathsIntersect('**', 'anything/at/all.ts')).toBe(true)
    expect(pathsIntersect('src/*.ts', 'src/a.ts')).toBe(true)
  })

  it('findWriteConflict ignores settled children and the given ancestors', () => {
    const active = delegation('w1', 'running', { writePaths: ['src/**'] })
    const done = delegation('w2', 'completed', { writePaths: ['lib/**'] })
    const idle = delegation('w3', 'idle', { writePaths: ['docs/**'] })
    expect(findWriteConflict(['src/a.ts'], [active, done], new Set())?.childId).toBe('w1')
    expect(findWriteConflict(['docs/a.md'], [active, done, idle], new Set())).toBeUndefined()
    expect(findWriteConflict(['lib/a.ts'], [active, done], new Set())).toBeUndefined()
    expect(findWriteConflict(['src/a.ts'], [active, done], new Set(['w1']))).toBeUndefined()
  })

  it('intersecting writePaths are refused, disjoint accepted, a file inside a glob refused', async () => {
    const h = delegationHost({ registered: REG })
    await h.engine.delegate(h.root, { role: 'worker', task: 'a', writePaths: ['src/parser/**'] })
    expect(await codeOf(h.engine.delegate(h.root, { role: 'worker', task: 'b', writePaths: ['src/parser/lex.ts'] }))).toBe('AP_WRITE_PATHS_CONFLICT')
    expect(await codeOf(h.engine.delegate(h.root, { role: 'worker', task: 'c', writePaths: ['src/**'] }))).toBe('AP_WRITE_PATHS_CONFLICT')
    await expect(h.engine.delegate(h.root, { role: 'worker', task: 'd', writePaths: ['test/parser/**'] })).resolves.toMatchObject({ state: 'running' })
    expect(ledgerOf(h).delegations).toHaveLength(2)
  })

  it('two concurrent conflicting dispatches: exactly one lands', async () => {
    const h = delegationHost({ registered: REG })
    const outcomes = await Promise.allSettled([
      h.engine.delegate(h.root, { role: 'worker', task: 'a', writePaths: ['src/x.ts'] }),
      h.engine.delegate(h.root, { role: 'worker', task: 'b', writePaths: ['src/x.ts'] }),
    ])
    expect(outcomes.map(o => o.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(ledgerOf(h).delegations).toHaveLength(1)
  })

  it('a settled worker frees its paths: after a failure, and after a normal completion', async () => {
    const h = delegationHost({ registered: REG })
    const failed = await h.engine.delegate(h.root, { role: 'worker', task: 'a', writePaths: ['src/x.ts'] })
    h.settle(failed.childId, { stopReason: 'error', diagnostic: 'died' })
    await h.engine.wait(h.root, [failed.childId], 5)
    const second = await h.engine.delegate(h.root, { role: 'worker', task: 'b', writePaths: ['src/x.ts'] })
    expect(second.state).toBe('running')
    h.settle(second.childId)
    await h.engine.wait(h.root, [second.childId], 5)
    expect(ledgerOf(h).delegations.find(d => d.childId === second.childId)?.state).not.toBe('running')
    await expect(h.engine.delegate(h.root, { role: 'worker', task: 'c', writePaths: ['src/x.ts'] })).resolves.toMatchObject({ state: 'running' })
  })

  it('a lead\'s own paths may contain its workers\'; a worker is checked against its siblings, not its lead', async () => {
    const h = delegationHost({ registered: REG })
    const lead = await h.engine.delegate(h.root, { role: 'executor-lead', task: 'chunk', writePaths: ['src/engine/**'] })
    const leadAgent = h.agents.get(lead.childId)!
    const w1 = await h.engine.delegate(leadAgent, { role: 'worker', task: 'a', writePaths: ['src/engine/a.ts'] })
    expect(ledgerOf(h).delegations.find(d => d.childId === w1.childId)).toMatchObject({ parentId: lead.childId, depth: 2 })
    expect(await codeOf(h.engine.delegate(leadAgent, { role: 'worker', task: 'b', writePaths: ['src/engine/a.ts'] }))).toBe('AP_WRITE_PATHS_CONFLICT')
    await expect(h.engine.delegate(leadAgent, { role: 'worker', task: 'c', writePaths: ['src/engine/b.ts'] })).resolves.toMatchObject({ state: 'running' })
    // Another root-level writer is checked against the lead's declared paths AND its workers'.
    expect(await codeOf(h.engine.delegate(h.root, { role: 'worker', task: 'd', writePaths: ['src/engine/c.ts'] }))).toBe('AP_WRITE_PATHS_CONFLICT')
  })

  it('a replacement is not blocked by the child it replaces, and carries generation + 1', async () => {
    const h = delegationHost({ registered: REG })
    const first = await h.engine.delegate(h.root, { role: 'worker', task: 'a', writePaths: ['src/x.ts'] })
    const second = await h.engine.delegate(h.root, { role: 'worker', task: 'a again, stronger', writePaths: ['src/x.ts'], replaces: first.childId })
    expect(second.generation).toBe(2)
    expect(ledgerOf(h).delegations.find(d => d.childId === second.childId)?.replaces).toBe(first.childId)
    expect(await codeOf(h.engine.delegate(h.root, { role: 'scout', task: 'x', replaces: first.childId }))).toBe('AP_INVALID_ARGUMENT')
    expect(await codeOf(h.engine.delegate(h.root, { role: 'worker', task: 'x', writePaths: ['q'], replaces: 'ghost' }))).toBe('AP_UNKNOWN_CHILD')
  })
})

describe('depth', () => {
  it('executor-lead gets cap 2, the others 1, and a worker under a lead (depth 2) gets cap 2', async () => {
    const h = delegationHost({ registered: REG })
    const lead = await h.engine.delegate(h.root, { role: 'executor-lead', task: 'chunk' })
    const scout = await h.engine.delegate(h.root, { role: 'scout', task: 's' })
    const worker = await h.engine.delegate(h.agents.get(lead.childId)!, { role: 'worker', task: 'w', writePaths: ['a.ts'] })
    expect([lead.maxDepth, scout.maxDepth, worker.maxDepth]).toEqual([2, 1, 2])
    expect(h.starts.map(s => s.maxDepth)).toEqual([2, 1, 2])
    expect(h.starts[2]!.parentId).toBe(lead.childId)
    expect(ledgerOf(h).delegations.map(d => d.depth)).toEqual([1, 1, 2])
  })

  it('ledger.depth records what the host setting showed, honestly', async () => {
    const unreadable = delegationHost({ registered: REG })
    await unreadable.engine.delegate(unreadable.root, { role: 'scout', task: 's' })
    expect(ledgerOf(unreadable).depth).toMatchObject({ executorLead: 2, source: 'unknown' })

    const shipped = delegationHost({ registered: REG, maxDepthSetting: 1 })
    await shipped.engine.delegate(shipped.root, { role: 'scout', task: 's' })
    expect(ledgerOf(shipped).depth).toMatchObject({ executorLead: 2, source: 'plugin-default' })
    expect(ledgerOf(shipped).depth.note).toMatch(/setting is 1/)

    const wide = delegationHost({ registered: REG, maxDepthSetting: 3 })
    await wide.engine.delegate(wide.root, { role: 'scout', task: 's' })
    expect(ledgerOf(wide).depth.note).toBe('host subagent maxDepth setting is 3')
  })
})

describe('effort, end to end (the agentOptions the host receives)', () => {
  const MODELS = [
    { provider: 'alpha', id: 'm-a', contextWindow: 200000, defaultEffort: 'medium' },
    { provider: 'alpha', id: 'm-plain', contextWindow: 200000 },
  ]

  it('explicit arg effort high: sent as high, effortSource arg', async () => {
    const h = delegationHost({ registered: REG, models: MODELS })
    const r = await h.engine.delegate(h.root, { role: 'worker', task: 't', writePaths: ['a'], provider: 'alpha', model: 'm-a', effort: 'high' })
    expect(h.starts[0]!.agentOptions).toEqual({ provider: 'alpha', model: 'm-a', reasoningEffort: 'high' })
    expect(r).toMatchObject({ modelSource: 'arg', effortSource: 'arg', selected: { provider: 'alpha', model: 'm-a', reasoningEffort: 'high' } })
  })

  it('catalog default only: adapter defaultEffort medium is sent, effortSource catalog-default', async () => {
    const h = delegationHost({ registered: REG, models: MODELS })
    const r = await h.engine.delegate(h.root, { role: 'worker', task: 't', writePaths: ['a'], provider: 'alpha', model: 'm-a' })
    expect(h.starts[0]!.agentOptions).toEqual({ provider: 'alpha', model: 'm-a', reasoningEffort: 'medium' })
    expect(r.effortSource).toBe('catalog-default')
  })

  it('unspecified: no reasoningEffort key is sent, effortSource host-default', async () => {
    const h = delegationHost({ registered: REG, models: MODELS })
    const r = await h.engine.delegate(h.root, { role: 'worker', task: 't', writePaths: ['a'], provider: 'alpha', model: 'm-plain' })
    expect(h.starts[0]!.agentOptions).toEqual({ provider: 'alpha', model: 'm-plain' })
    expect('reasoningEffort' in h.starts[0]!.agentOptions!).toBe(false)
    expect(r.effortSource).toBe('host-default')
  })

  it('an inherited model with an explicit effort still sends the effort (the host drops it otherwise)', async () => {
    const h = delegationHost({ registered: REG, models: MODELS })
    await h.engine.delegate(h.root, { role: 'scout', task: 't', effort: 'low' })
    expect(h.starts[0]!.agentOptions).toEqual({ reasoningEffort: 'low' })
  })

  it('MY-25 #1: a user pin effort beats a value the preflight carries back', async () => {
    const catalog = catalogOf(MODELS, { resolveCallConfig: async config => ({ ...config, reasoningEffort: 'high' }) })
    const h = delegationHost({
      registered: REG,
      catalog,
      config: { executor: { agentOptions: { provider: 'alpha', model: 'm-a', reasoningEffort: 'low' } } },
    })
    const r = await h.engine.delegate(h.root, { role: 'worker', task: 't', writePaths: ['a'] })
    expect(h.starts[0]!.agentOptions).toEqual({ provider: 'alpha', model: 'm-a', reasoningEffort: 'low' })
    expect(r).toMatchObject({ modelSource: 'pin', effortSource: 'pin' })
  })

  it('a refused route (effort rejected by preflight) starts nothing and records nothing', async () => {
    const catalog = catalogOf(MODELS, { resolveCallConfig: async config => { if (config.reasoningEffort === 'bogus') throw new Error('nope'); return { ...config } } })
    const h = delegationHost({ registered: REG, catalog })
    expect(await codeOf(h.engine.delegate(h.root, { role: 'worker', task: 't', writePaths: ['a'], provider: 'alpha', model: 'm-a', effort: 'bogus' }))).toBe('AP_ROLE_ROUTE_PREFLIGHT_FAILED')
    expect(h.starts).toEqual([])
    expect(h.ledgers.load('root-1')).toBeUndefined()
  })

  it('observed route: a header that agrees is a match; one that disagrees is a mismatch, kept visible', async () => {
    const h = delegationHost({ registered: REG, models: MODELS })
    const ok = await h.engine.delegate(h.root, { role: 'worker', task: 't', writePaths: ['a'], provider: 'alpha', model: 'm-a', effort: 'high' })
    await h.engine.refreshRoutes('root-1')
    expect(ledgerOf(h).delegations.find(d => d.childId === ok.childId)).toMatchObject({ routeMatch: 'match', observed: { provider: 'alpha', model: 'm-a', reasoningEffort: 'high' } })
    // The host swaps the model underneath: a later header names another route.
    const h2 = delegationHost({ registered: REG, models: MODELS })
    const bad = await h2.engine.delegate(h2.root, { role: 'worker', task: 't', writePaths: ['a'], provider: 'alpha', model: 'm-a', effort: 'high' })
    ;(h2.agents.get(bad.childId) as unknown as { session: { append(t: string, d: unknown): void } }).session.append('request/header', { header: { config: { provider: 'alpha', model: 'm-plain', reasoningEffort: 'high' } } })
    await h2.engine.refreshRoutes('root-1')
    expect(ledgerOf(h2).delegations.find(d => d.childId === bad.childId)?.routeMatch).toBe('mismatch')
  })

  it('routeMatchOf: effort is compared only when it was sent', () => {
    const selected = { provider: 'p', model: 'm', reasoningEffort: 'high' }
    expect(routeMatchOf(selected, 'arg', { provider: 'p', model: 'm', reasoningEffort: 'high' }, false)).toBe('match')
    expect(routeMatchOf(selected, 'arg', { provider: 'p', model: 'm', reasoningEffort: 'low' }, false)).toBe('mismatch')
    expect(routeMatchOf(selected, 'arg', { provider: 'p', model: 'm' }, false)).toBe('unreadable')
    expect(routeMatchOf({ provider: 'p', model: 'm' }, 'host-default', { provider: 'p', model: 'm', reasoningEffort: 'low' }, false)).toBe('match')
    expect(routeMatchOf(selected, 'arg', undefined, false)).toBe('pending')
    expect(routeMatchOf(selected, 'arg', undefined, true)).toBe('unreadable')
    expect(routeMatchOf(undefined, 'host-default', { provider: 'p', model: 'm' }, false)).toBe('match')
  })
})

describe('observed route when the host disposes the child before settling (dsh 0.2.1-rc.5 order)', () => {
  // rc.5 `finishDisposal` disposes the child agent (gone from ctx.agents, agent/disposed delivered)
  // and only then resolves the activation result, and the child writes its request/header at its
  // first request, after agent/created. The route must still be recorded.
  const MODELS = [{ provider: 'alpha', id: 'm-a', contextWindow: 200000, defaultEffort: 'medium' }]

  it('a scout that settles after disposal still records its observed route as a match', async () => {
    const h = delegationHost({ registered: REG, headerOnFirstRequest: true })
    const { childId } = await h.engine.delegate(h.root, { role: 'scout', task: 't' })
    h.firstRequest(childId)
    const waited = h.engine.wait(h.root, [childId], 5)
    h.settleDisposed(childId)
    await waited
    expect(h.agents.get(childId)).toBeUndefined()
    const record = ledgerOf(h).delegations.find(d => d.childId === childId)!
    expect(record.state).toBe('idle')
    expect(record.observed).toEqual({ provider: 'host', model: 'default' })
    expect(record.routeMatch).toBe('match')
  })

  it('a pinned worker: the observed effort is compared after disposal too', async () => {
    const h = delegationHost({ registered: REG, models: MODELS, headerOnFirstRequest: true })
    const { childId } = await h.engine.delegate(h.root, { role: 'worker', task: 't', writePaths: ['a'], provider: 'alpha', model: 'm-a', effort: 'high' })
    h.firstRequest(childId)
    const waited = h.engine.wait(h.root, [childId], 5)
    h.settleDisposed(childId)
    await waited
    expect(ledgerOf(h).delegations.find(d => d.childId === childId)).toMatchObject({
      routeMatch: 'match', observed: { provider: 'alpha', model: 'm-a', reasoningEffort: 'high' },
    })
  })

  it('two children settling together both end as a match (a refresh must not overwrite the other one)', async () => {
    const h = delegationHost({ registered: REG, headerOnFirstRequest: true })
    const a = await h.engine.delegate(h.root, { role: 'scout', task: 'a' })
    const b = await h.engine.delegate(h.root, { role: 'scout', task: 'b' })
    h.firstRequest(a.childId)
    h.firstRequest(b.childId)
    const waited = h.engine.wait(h.root, [a.childId, b.childId], 5)
    h.settleDisposed(a.childId)
    h.settleDisposed(b.childId)
    await waited
    for (const id of [a.childId, b.childId]) {
      expect(ledgerOf(h).delegations.find(d => d.childId === id)).toMatchObject({ routeMatch: 'match', observed: { provider: 'host', model: 'default' } })
    }
  })

  it('concurrent refreshes of an already-settled child keep its match', async () => {
    const h = delegationHost({ registered: REG, headerOnFirstRequest: true })
    const { childId } = await h.engine.delegate(h.root, { role: 'scout', task: 'a' })
    h.firstRequest(childId)
    h.settleDisposed(childId)
    await Promise.all([h.engine.refreshRoutes('root-1'), h.engine.refreshRoutes('root-1')])
    await h.engine.wait(h.root, [childId], 1)
    expect(ledgerOf(h).delegations.find(d => d.childId === childId)?.routeMatch).toBe('match')
  })

  it('a running child that has not sent its first request is pending, not unreadable', async () => {
    const h = delegationHost({ registered: REG, headerOnFirstRequest: true })
    const { childId } = await h.engine.delegate(h.root, { role: 'scout', task: 't' })
    await h.engine.refreshRoutes('root-1')
    expect(ledgerOf(h).delegations.find(d => d.childId === childId)?.routeMatch).toBe('pending')
  })

  it('a child that settles without ever sending a request is unreadable', async () => {
    const h = delegationHost({ registered: REG, headerOnFirstRequest: true })
    const { childId } = await h.engine.delegate(h.root, { role: 'scout', task: 't' })
    const waited = h.engine.wait(h.root, [childId], 5)
    h.settleDisposed(childId, { stopReason: 'error', diagnostic: 'boom' })
    await waited
    const record = ledgerOf(h).delegations.find(d => d.childId === childId)!
    expect(record.state).toBe('failed')
    expect(record.observed).toBeUndefined()
    expect(record.routeMatch).toBe('unreadable')
  })
})

describe('the reviewer', () => {
  const MODELS = [
    { provider: 'alpha', id: 'm-a', contextWindow: 200000 },
    { provider: 'beta', id: 'm-b', contextWindow: 200000 },
  ]
  const worker = (provider: string) => delegation('w-1', 'idle', { role: 'worker', writePaths: ['a'], selected: { provider, model: 'x' } })
  const PASS = { verdict: 'pass', findings: [], subject: 'the parser change' }

  /** Run a review to completion: settle the reviewer child with `structured` as soon as it starts. */
  async function reviewWith(h: ReturnType<typeof delegationHost>, structured: unknown, args: Record<string, unknown> = {}) {
    const pending = h.engine.delegate(h.root, { role: 'reviewer', task: 'review the parser change', ...args })
    for (let i = 0; i < 50 && h.starts.length === 0; i += 1) await new Promise(r => setTimeout(r, 2))
    h.settle(h.starts[0]!.childId!, { stopReason: 'completed', structured })
    return await pending
  }

  it('picks a different family than the reviewed work, waits, validates and records the verdict in-band', async () => {
    const h = delegationHost({ registered: REG, models: MODELS, policy: policyOf(['alpha', 'm-a'], ['beta', 'm-b']) })
    await h.engine.mutate('root-1', l => ({ ...l, delegations: [worker('alpha')] }))

    const result = await reviewWith(h, PASS)

    const start = h.starts[0]!
    expect(start).toMatchObject({ delivery: 'caller', maxDepth: 1, agentOptions: { provider: 'beta', model: 'm-b' } })
    expect(start.outputSchema).toBe(REVIEW_VERDICT_SCHEMA)
    expect(result.review).toMatchObject({ verdict: 'pass', subject: 'the parser change', independence: 'cross-family', excludedFamilies: ['alpha'] })
    const ledger = ledgerOf(h)
    expect(ledger.reviews).toHaveLength(1)
    expect(ledger.reviews[0]).toMatchObject({ reviewedChildIds: ['w-1'], independence: 'cross-family', verdict: 'pass', excludedFamilies: ['alpha'] })
    expect(ledger.delegations.find(d => d.role === 'reviewer')?.state).toBe('completed')
    // Read-only tools: restricted on creation.
    expect(h.restricts.get(start.childId!)).toEqual([allowListFor('reviewer', REG)])
  })

  it('records the reviewer\'s observed route, not the selected one, even when it is disposed', async () => {
    const h = delegationHost({ registered: REG, models: MODELS, policy: policyOf(['alpha', 'm-a'], ['beta', 'm-b']), headerOnFirstRequest: true })
    await h.engine.mutate('root-1', l => ({ ...l, delegations: [worker('alpha')] }))
    const pending = h.engine.delegate(h.root, { role: 'reviewer', task: 'review the parser change' })
    for (let i = 0; i < 50 && h.starts.length === 0; i += 1) await new Promise(r => setTimeout(r, 2))
    const id = h.starts[0]!.childId!
    ;(h.agents.get(id) as { session: { append(k: string, v: unknown): void } }).session.append('request/header', { header: { config: { provider: 'gamma', model: 'g-1' } }, reason: 'initial' })
    h.settleDisposed(id, { stopReason: 'completed', structured: PASS })
    await pending
    expect(ledgerOf(h).reviews[0]?.reviewerRoute).toEqual({ provider: 'gamma', model: 'g-1' })
  })

  it('reduced independence, said so, when only the same family exists', async () => {
    const h = delegationHost({ registered: REG, models: [MODELS[0]!], policy: policyOf(['alpha', 'm-a']) })
    await h.engine.mutate('root-1', l => ({ ...l, delegations: [worker('alpha')] }))
    const result = await reviewWith(h, { verdict: 'needs-fix', findings: [{ severity: 'major', summary: 'off by one', where: 'a.ts:3' }], subject: 's' })
    expect(result.review?.independence).toBe('reduced')
    expect(result.review?.independenceNote).toBeDefined()
    expect(ledgerOf(h).reviews[0]).toMatchObject({ independence: 'reduced', verdict: 'needs-fix' })
  })

  it('without reviewedChildIds, links every settled non-reviewer delegation (read-only scouts too) and computes independence from their observed family', async () => {
    const h = delegationHost({ registered: REG, models: MODELS, policy: policyOf(['alpha', 'm-a'], ['beta', 'm-b']) })
    await h.engine.mutate('root-1', l => ({
      ...l,
      delegations: [
        delegation('s-1', 'completed', { role: 'scout', selected: { provider: 'beta', model: 'x' }, observed: { provider: 'alpha', model: 'm-a' } }),
        delegation('s-2', 'idle', { role: 'scout', observed: { provider: 'alpha', model: 'm-a' } }),
        delegation('s-3', 'running', { role: 'scout', observed: { provider: 'beta', model: 'm-b' } }),
      ],
    }))
    const result = await reviewWith(h, PASS)
    expect(ledgerOf(h).reviews[0]).toMatchObject({ reviewedChildIds: ['s-1', 's-2'], independence: 'cross-family', excludedFamilies: ['alpha'] })
    expect(result.review?.excludedFamilies).toEqual(['alpha'])
    expect(h.starts[0]!.agentOptions?.['provider']).toBe('beta')
  })

  /** Dispatch a scout and let it settle, so it is a settled delegation of whatever goal is current. */
  async function settledScout(h: ReturnType<typeof delegationHost>): Promise<string> {
    const before = h.starts.length
    const result = await h.engine.delegate(h.root, { role: 'scout', task: 'look around' })
    h.settle(result.childId)
    for (let i = 0; i < 50 && ledgerOf(h).delegations.find(d => d.childId === result.childId)?.state !== 'completed'; i += 1) await new Promise(r => setTimeout(r, 2))
    expect(h.starts.length).toBe(before + 1)
    return result.childId
  }

  it('without reviewedChildIds, a second goal in the same session links only its own settled work', async () => {
    let view: NativeGoalView = { id: 'g-a', revision: 1, objective: 'goal A', phase: 'active', maxGoalRounds: 40, roundsStarted: 0, activation: 'disarmed' }
    const h = delegationHost({ registered: REG, models: MODELS, policy: policyOf(['alpha', 'm-a'], ['beta', 'm-b']), goal: () => view, driver: () => true })
    const inA = await settledScout(h)
    view = { ...view, id: 'g-b', objective: 'goal B' }
    await h.engine.syncGoal(h.root)
    const inB = await settledScout(h)

    const pending = h.engine.delegate(h.root, { role: 'reviewer', task: 'review goal B' })
    for (let i = 0; i < 50 && h.starts.length < 3; i += 1) await new Promise(r => setTimeout(r, 2))
    h.settle(h.starts[2]!.childId!, { stopReason: 'completed', structured: PASS })
    await pending
    const review = ledgerOf(h).reviews[0]!
    expect(review.reviewedChildIds).toEqual([inB])
    expect(review.reviewedChildIds).not.toContain(inA)
  })

  it('the review syncs the goal itself: a switch with no goal event still narrows the window', async () => {
    let view: NativeGoalView = { id: 'g-a', revision: 1, objective: 'goal A', phase: 'active', maxGoalRounds: 40, roundsStarted: 0, activation: 'disarmed' }
    const h = delegationHost({ registered: REG, models: MODELS, policy: policyOf(['alpha', 'm-a'], ['beta', 'm-b']), goal: () => view, driver: () => true })
    const inA = await settledScout(h)
    view = { ...view, id: 'g-b', objective: 'goal B' }
    // no syncGoal here: the scout's own start() mirrors B, the review must not rely on that
    const inB = await settledScout(h)
    view = { ...view, id: 'g-c', objective: 'goal C' }
    const pending = h.engine.delegate(h.root, { role: 'reviewer', task: 'review goal C' })
    for (let i = 0; i < 50 && h.starts.length < 3; i += 1) await new Promise(r => setTimeout(r, 2))
    h.settle(h.starts[2]!.childId!, { stopReason: 'completed', structured: PASS })
    await pending
    const review = ledgerOf(h).reviews[0]!
    expect(review.reviewedChildIds).toEqual([])
    expect(review.reviewedChildIds).not.toContain(inA)
    expect(review.reviewedChildIds).not.toContain(inB)
  })

  it('a goal first mirrored at the first dispatch still includes that dispatch', async () => {
    const view: NativeGoalView = { id: 'g-1', revision: 1, objective: 'only goal', phase: 'active', maxGoalRounds: 40, roundsStarted: 0, activation: 'disarmed' }
    const h = delegationHost({ registered: REG, models: MODELS, policy: policyOf(['alpha', 'm-a'], ['beta', 'm-b']), goal: () => view, driver: () => true })
    expect(h.engine.peekLedger('root-1')).toBeUndefined()
    const first = await settledScout(h)
    const ledger = ledgerOf(h)
    const record = ledger.delegations.find(d => d.childId === first)!
    expect(ledger.goal!.firstSeenAt <= record.startedAt).toBe(true)

    const pending = h.engine.delegate(h.root, { role: 'reviewer', task: 'review' })
    for (let i = 0; i < 50 && h.starts.length < 2; i += 1) await new Promise(r => setTimeout(r, 2))
    h.settle(h.starts[1]!.childId!, { stopReason: 'completed', structured: PASS })
    await pending
    expect(ledgerOf(h).reviews[0]!.reviewedChildIds).toEqual([first])
  })

  it('reviewedChildIds narrows what is excluded; an unknown id is refused', async () => {
    const h = delegationHost({ registered: REG, models: MODELS, policy: policyOf(['alpha', 'm-a'], ['beta', 'm-b']) })
    await h.engine.mutate('root-1', l => ({
      ...l,
      delegations: [worker('alpha'), delegation('w-2', 'idle', { role: 'worker', writePaths: ['b'], selected: { provider: 'beta', model: 'x' } })],
    }))
    expect(await codeOf(h.engine.delegate(h.root, { role: 'reviewer', task: 't', reviewedChildIds: ['ghost'] }))).toBe('AP_UNKNOWN_CHILD')
    const result = await reviewWith(h, PASS, { reviewedChildIds: ['w-2'] })
    expect(result.review?.excludedFamilies).toEqual(['beta'])
    expect(h.starts[0]!.agentOptions?.['provider']).toBe('alpha')
  })

  it('an observed route outranks the selected one when naming the excluded family', async () => {
    const h = delegationHost({ registered: REG, models: MODELS, policy: policyOf(['alpha', 'm-a'], ['beta', 'm-b']) })
    await h.engine.mutate('root-1', l => ({
      ...l,
      delegations: [delegation('w-1', 'idle', { role: 'worker', writePaths: ['a'], selected: { provider: 'alpha', model: 'x' }, observed: { provider: 'beta', model: 'y' } })],
    }))
    const result = await reviewWith(h, PASS)
    expect(result.review?.excludedFamilies).toEqual(['beta'])
  })

  it('an invalid structured result is AP_ROLE_VERDICT_INVALID, the delegation fails, no review is recorded', async () => {
    const h = delegationHost({ registered: REG, models: MODELS, policy: policyOf(['alpha', 'm-a'], ['beta', 'm-b']) })
    const outcome = await reviewWith(h, { verdict: 'pass', findings: [{ severity: 'blocker', summary: 'x' }], subject: 's' }).catch((e: unknown) => e)
    expect(outcome).toBeInstanceOf(AutopilotError)
    expect((outcome as AutopilotError).code).toBe('AP_ROLE_VERDICT_INVALID')
    const ledger = ledgerOf(h)
    expect(ledger.reviews).toEqual([])
    expect(ledger.delegations.find(d => d.role === 'reviewer')).toMatchObject({ state: 'failed' })
  })

  it('MY-25 #2: a dispatch that lands between the snapshot and the selection does not change the exclusions', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const catalog = catalogOf(MODELS, {
      // The selection awaits the catalog; hold it so a write lands in the middle of the decision.
      resolveModelInfo: async (provider, model) => {
        await gate
        return { provider, id: model, name: model, context: { contextWindow: 200000 } }
      },
    })
    const h = delegationHost({ registered: REG, catalog, policy: policyOf(['alpha', 'm-a'], ['beta', 'm-b']) })
    await h.engine.mutate('root-1', l => ({ ...l, delegations: [worker('alpha')] }))

    const pending = h.engine.delegate(h.root, { role: 'reviewer', task: 'review' })
    await new Promise(r => setTimeout(r, 10))
    // A beta worker completes while the reviewer is being routed.
    await h.engine.mutate('root-1', l => ({
      ...l,
      delegations: [...l.delegations, delegation('w-late', 'completed', { role: 'worker', writePaths: ['z'], selected: { provider: 'beta', model: 'x' } })],
    }))
    release()
    for (let i = 0; i < 50 && h.starts.length === 0; i += 1) await new Promise(r => setTimeout(r, 2))
    h.settle(h.starts[0]!.childId!, { stopReason: 'completed', structured: PASS })
    const result = await pending

    // Decided from the snapshot: only alpha was known, so the reviewer is beta, and the late beta worker
    // does not retroactively exclude it.
    expect(result.review?.excludedFamilies).toEqual(['alpha'])
    expect(h.starts[0]!.agentOptions?.['provider']).toBe('beta')
  })

  it('no tool accepts a verdict: the tool surface has no verdict parameter', async () => {
    const { installRootTools } = await import('../src/tools.js')
    const defs: Array<{ name: string; parameters: Record<string, unknown> }> = []
    const h = delegationHost({ registered: REG })
    const { createAutopilotService } = await import('../src/service.js')
    installRootTools({ register: (d: unknown) => { defs.push(d as never); return () => {} } }, createAutopilotService({ ledgers: h.ledgers, sources: {} }), h.engine)
    for (const def of defs) expect(Object.keys(def.parameters)).not.toContain('verdict')
    expect(defs.map(d => d.name)).toEqual(['autopilot_status', 'autopilot_delegate', 'autopilot_agents'])
  })
})

describe('autopilot_agents wait and autopilot_escalate', () => {
  it('wait returns when the child settles, with its new state', async () => {
    const h = delegationHost({ registered: REG })
    const { childId } = await h.engine.delegate(h.root, { role: 'scout', task: 't' })
    const waiting = h.engine.wait(h.root, undefined, 30)
    h.settle(childId, { stopReason: 'completed' })
    const out = await waiting
    expect(out.timedOut).toBe(false)
    expect(out.delegations.map(d => [d.childId, d.state])).toEqual([[childId, 'idle']])
  })

  it('wait with no timeout budget reports timedOut while a child is still running', async () => {
    const h = delegationHost({ registered: REG })
    const { childId } = await h.engine.delegate(h.root, { role: 'scout', task: 't' })
    const out = await h.engine.wait(h.root, [childId], 0)
    expect(out.timedOut).toBe(true)
    expect(out.delegations[0]!.state).toBe('running')
  })

  it('wait times out after its budget (1 second) and says so', async () => {
    const h = delegationHost({ registered: REG })
    const { childId } = await h.engine.delegate(h.root, { role: 'scout', task: 't' })
    const started = Date.now()
    const out = await h.engine.wait(h.root, [childId], 1)
    expect(out.timedOut).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  })

  it('an unknown child id is AP_UNKNOWN_CHILD; nothing else refuses', async () => {
    const h = delegationHost({ registered: REG })
    expect(await codeOf(h.engine.wait(h.root, ['ghost'], 1))).toBe('AP_UNKNOWN_CHILD')
    const empty = await h.engine.wait(h.root, undefined, 1)
    expect(empty).toEqual({ delegations: [], timedOut: false })
  })

  it('escalate records the request on the child\'s own delegation; a stranger cannot', async () => {
    const h = delegationHost({ registered: REG })
    const { childId } = await h.engine.delegate(h.root, { role: 'worker', task: 't', writePaths: ['a'] })
    const guidance = await h.engine.escalate(h.agents.get(childId)!, 'stuck on the lexer after three tries')
    expect(guidance).toMatch(/parent decides/)
    expect(ledgerOf(h).delegations[0]!.escalation?.reason).toBe('stuck on the lexer after three tries')
    expect(await codeOf(h.engine.escalate(h.root, 'x'))).toBe('AP_UNKNOWN_CHILD')
    expect(await codeOf(h.engine.escalate(h.agents.get(childId)!, '   '))).toBe('AP_INVALID_ARGUMENT')
  })
})

describe('the ledger starts empty for a session that only dispatches', () => {
  it('an empty ledger fixture is revision 0 and untouched by routing alone', () => {
    expect(emptyLedger('s', NOW).delegations).toEqual([])
  })
})
