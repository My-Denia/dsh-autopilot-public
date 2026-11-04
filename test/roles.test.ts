/**
 * Delegation roles and the unified role routing entry (src/roles/**).
 *
 * The routing core is stubbed at the structural boundary (same shape as
 * test/routing.test.ts). Assertions are on exact values and refusal codes.
 */

import { describe, expect, it } from 'vitest'
import type { ResolvedRouting } from '../src/engine.js'
import { AutopilotError } from '../src/domain/types.js'
import type { DelegationRoleName } from '../src/domain/ledger-types.js'
import {
  AP_ROLE_ROUTE_INCOMPLETE,
  AP_ROLE_ROUTE_NOT_ALLOWED,
  AP_ROLE_ROUTE_PREFLIGHT_FAILED,
  REVIEW_VERDICT_SCHEMA,
  ROLES,
  ROLE_NAMES,
  parseReviewVerdict,
} from '../src/roles/index.js'
import { isRouteRefusal, routeForDelegation } from '../src/roles/route.js'
import type { RoleRoutingConfig, RouteDecision, RouteForDelegation } from '../src/roles/route.js'
import { allowListFor, parseRestrictRejection, resolveToolAllow } from '../src/roles/tools.js'
import { RouteCatalog } from '../src/routing/catalog.js'
import type { LlmCallConfig, LlmRuntimeSubset } from '../src/routing/catalog.js'
import type { SessionPolicyState } from '../src/routing/authorize.js'
import { DEFAULT_WORK_CLASSES } from '../src/routing/work-class.js'
import type { Role, RoleRouting } from '../src/routing/select.js'

// The engine's ResolvedRouting must stay assignable to the structural config the roles read.
const _contract = (resolved: ResolvedRouting): RoleRoutingConfig => resolved
void _contract

// ── Stub catalog ──

interface StubModel {
  readonly provider: string
  readonly id: string
  readonly contextWindow?: number
  readonly defaultEffort?: string
}

function stubLlm(models: readonly StubModel[], over: Partial<LlmRuntimeSubset> = {}): LlmRuntimeSubset {
  const providers = [...new Set(models.map((model) => model.provider))]
  return {
    listProviders: () => providers.map((id) => ({ id, name: id })),
    listModels: async (provider: string) =>
      models.filter((model) => model.provider === provider).map((model) => ({ provider, id: model.id, name: model.id })),
    resolveModelInfo: async (provider: string, model: string) => {
      const hit = models.find((candidate) => candidate.provider === provider && candidate.id === model)
      if (hit === undefined) throw new Error(`unknown route ${provider}/${model}`)
      return {
        provider,
        id: model,
        name: model,
        ...(hit.contextWindow !== undefined ? { context: { contextWindow: hit.contextWindow } } : {}),
        ...(hit.defaultEffort !== undefined
          ? { reasoning: { efforts: [{ id: hit.defaultEffort, name: hit.defaultEffort }], defaultEffort: hit.defaultEffort } }
          : {}),
      }
    },
    resolveCallConfig: async (config: LlmCallConfig) => ({ ...config }),
    ...over,
  }
}

const catalogOf = (models: readonly StubModel[], over: Partial<LlmRuntimeSubset> = {}): RouteCatalog =>
  new RouteCatalog(stubLlm(models, over))

const policyOf = (...routes: readonly [string, string][]): SessionPolicyState => ({
  kind: 'present',
  routes: routes.map(([provider, model]) => ({ provider, model })),
})
const ABSENT: SessionPolicyState = { kind: 'absent' }

function routingOf(roles: Partial<Record<Role, RoleRouting>> = {}, over: Partial<RoleRoutingConfig> = {}): RoleRoutingConfig {
  return {
    mode: 'auto',
    preference: 'balanced',
    roles: {
      executor: { mode: 'auto' },
      planner: { mode: 'auto' },
      'plan-auditor': { mode: 'auto' },
      'execution-auditor': { mode: 'auto' },
      'rules-auditor': { mode: 'auto' },
      ...roles,
    },
    ladder: { tiers: { economy: [], standard: [], reserve: [] }, auditTier: 'none', speedOrder: [], costOverrides: [] },
    workClasses: DEFAULT_WORK_CLASSES,
    ...over,
  }
}

function decision(result: RouteForDelegation): RouteDecision {
  if (isRouteRefusal(result)) throw new Error(`expected a decision, got refusal ${result.refused}: ${result.detail}`)
  return result
}

function refusal(result: RouteForDelegation): { refused: string; detail: string } {
  if (!isRouteRefusal(result)) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`)
  return result
}

// ── Role table ──

describe('ROLES', () => {
  it('names exactly the six goal-workflow roles, each keyed by its own name', () => {
    expect([...ROLE_NAMES].sort()).toEqual(['clerk', 'executor-lead', 'planner', 'reviewer', 'scout', 'worker'])
    for (const name of ROLE_NAMES) expect(ROLES[name].name).toBe(name)
  })

  it('depth, delivery, one-shot and dispatch rights are as designed', () => {
    const shape = (name: DelegationRoleName) => {
      const spec = ROLES[name]
      return [spec.maxDepth, spec.delivery, spec.oneShot, spec.canDispatch.join('+'), spec.write, spec.requiresWritePaths, spec.defaultWorkClass]
    }
    expect(shape('scout')).toEqual([1, 'parent', false, '', false, false, 'mechanical'])
    expect(shape('clerk')).toEqual([1, 'parent', false, '', false, false, 'mechanical'])
    expect(shape('worker')).toEqual([1, 'parent', false, '', true, true, 'simple'])
    expect(shape('executor-lead')).toEqual([2, 'parent', false, 'scout+clerk+worker', true, false, 'hard'])
    expect(shape('planner')).toEqual([1, 'parent', false, '', false, false, 'hard'])
    expect(shape('reviewer')).toEqual([1, 'caller', true, '', false, false, 'audit'])
  })

  it('only the executor-lead gets the delegation tools; read-only roles request no write tool', () => {
    expect(ROLES['executor-lead'].delegationTools).toEqual(['autopilot_delegate', 'autopilot_agents'])
    for (const name of ROLE_NAMES) {
      if (name !== 'executor-lead') expect(ROLES[name].delegationTools).toEqual([])
      const spec = ROLES[name]
      if (!spec.write && spec.requestedTools !== 'inherit') {
        for (const tool of ['write', 'edit', 'bash']) expect(spec.requestedTools).not.toContain(tool)
      }
    }
    expect(ROLES.scout.requestedTools).toEqual(['read', 'glob', 'grep', 'read_image', 'web_fetch', 'web_search'])
    expect(ROLES.reviewer.requestedTools).toEqual(['read', 'glob', 'grep', 'read_image'])
    expect(ROLES.worker.requestedTools).toBe('inherit')
  })

  it('the persona states the role constraint that matters', () => {
    expect(ROLES.worker.persona).toMatch(/ONLY inside your declared writePaths/)
    expect(ROLES['executor-lead'].persona).toMatch(/DISJOINT writePaths/)
    expect(ROLES.reviewer.persona).toMatch(/cannot override/)
  })
})

describe('parseReviewVerdict', () => {
  const ok = { verdict: 'needs-fix', subject: 'PR 12', findings: [{ severity: 'major', summary: ' leaks a key ', where: 'src/a.ts:4' }] }

  it('accepts a well-formed verdict and trims text', () => {
    expect(parseReviewVerdict(ok)).toEqual({
      verdict: 'needs-fix',
      subject: 'PR 12',
      findings: [{ severity: 'major', summary: 'leaks a key', where: 'src/a.ts:4' }],
    })
    expect(parseReviewVerdict({ verdict: 'pass', subject: 's', findings: [{ severity: 'minor', summary: 'nit' }] })).toEqual({
      verdict: 'pass',
      subject: 's',
      findings: [{ severity: 'minor', summary: 'nit' }],
    })
  })

  it.each([
    ['not an object', 'x', /must be an object/],
    ['bad verdict', { ...ok, verdict: 'ok' }, /verdict must be one of/],
    ['empty subject', { ...ok, subject: ' ' }, /subject/],
    ['findings not an array', { ...ok, findings: 'none' }, /findings must be an array/],
    ['bad severity', { ...ok, findings: [{ severity: 'huge', summary: 'x' }] }, /findings\[0\]\.severity/],
    ['empty summary', { ...ok, findings: [{ severity: 'minor', summary: '' }] }, /findings\[0\]\.summary/],
    ['pass with a blocker', { verdict: 'pass', subject: 's', findings: [{ severity: 'blocker', summary: 'x' }] }, /inconsistent/],
    ['needs-fix without findings', { verdict: 'needs-fix', subject: 's', findings: [] }, /at least one finding/],
  ])('rejects %s', (_name, value, pattern) => {
    const result = parseReviewVerdict(value)
    expect(typeof result).toBe('string')
    expect(result as string).toMatch(pattern)
  })

  it('the exported schema lists the same axes the parser enforces', () => {
    expect(REVIEW_VERDICT_SCHEMA.required).toEqual(['verdict', 'findings', 'subject'])
    expect(REVIEW_VERDICT_SCHEMA.properties.verdict.enum).toEqual(['pass', 'needs-fix', 'blocked'])
    expect(REVIEW_VERDICT_SCHEMA.properties.findings.items.properties.severity.enum).toEqual(['blocker', 'major', 'minor'])
  })
})

// ── Tool allow-lists ──

describe('allowListFor', () => {
  const REGISTERED = ['read', 'glob', 'grep', 'read_image', 'web_fetch', 'write', 'edit', 'bash', 'autopilot_delegate']

  it('narrows a read-only role to registered names (web_search is not registered here)', () => {
    expect(allowListFor('scout', REGISTERED)).toEqual(['read', 'glob', 'grep', 'read_image', 'web_fetch'])
    expect(allowListFor('reviewer', REGISTERED)).toEqual(['read', 'glob', 'grep', 'read_image'])
  })

  it('passes the request through when the registry is unknown', () => {
    expect(allowListFor('planner', undefined)).toEqual(['read', 'glob', 'grep', 'read_image'])
  })

  it('write roles are unrestricted; the delegation tools are read from ROLES by the engine', () => {
    expect(allowListFor('worker', REGISTERED)).toBe('inherit')
    expect(allowListFor('executor-lead', REGISTERED)).toBe('inherit')
  })

  it('a clerk may add the connector tools that are actually present', () => {
    expect(allowListFor('clerk', [...REGISTERED, 'mcp__linear__get_issue'], ['mcp__linear__get_issue', 'mcp__gone__x'])).toEqual([
      'read', 'glob', 'grep', 'read_image', 'web_fetch', 'mcp__linear__get_issue',
    ])
  })

  it('refuses (AP_TOOL_SURFACE_INCOMPLETE) a read-only role when `read` is not registered', () => {
    let error: unknown
    try { allowListFor('reviewer', ['glob', 'grep']) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(AutopilotError)
    expect((error as AutopilotError).code).toBe('AP_TOOL_SURFACE_INCOMPLETE')
  })

  it('resolveToolAllow records every drop and refuses a lost whole family', () => {
    const resolved = resolveToolAllow(['read', 'bash', 'pwsh'], ['read', 'pwsh'], ['read'], 'x')
    expect(resolved.allow).toEqual(['read', 'pwsh'])
    expect(resolved.dropped).toEqual(['bash'])
    expect(resolved.diagnostic).toMatch(/does not register "bash"/)
    expect(() => resolveToolAllow(['read', 'bash'], ['read'], ['read'], 'x')).toThrow(/none of the shell tools/)
  })

  it('parseRestrictRejection recovers the registry from the upstream message and nothing else', () => {
    expect(parseRestrictRejection('tools.restrict() names unknown global tools "a", "b"; known global tools: c, d, e')).toEqual({
      unknown: ['a', 'b'],
      known: ['c', 'd', 'e'],
    })
    expect(parseRestrictRejection('something else')).toBeUndefined()
  })
})

// ── Routing ──

const TWO_ALPHA = [
  { provider: 'alpha', id: 'm-a', contextWindow: 200000 },
  { provider: 'alpha', id: 'm-b', contextWindow: 131072 },
] as const

describe('routeForDelegation: effort, three concrete cases', () => {
  const alphaPolicy = policyOf(['alpha', 'm-a'], ['alpha', 'm-b'])

  it('explicit: the call effort is sent as given, effortSource arg, and a differing preflight-carried value never replaces it', async () => {
    const carrying = catalogOf(TWO_ALPHA, {
      resolveCallConfig: async (config: LlmCallConfig) => ({ ...config, reasoningEffort: 'high' }),
    })
    const result = decision(await routeForDelegation({
      role: 'worker',
      arg: { provider: 'alpha', model: 'm-a', effort: 'low' },
      routing: routingOf(),
      ports: { catalog: carrying, policy: ABSENT },
    }))
    expect(result.selected).toEqual({ provider: 'alpha', model: 'm-a', reasoningEffort: 'low' })
    expect(result.reasoningEffort).toBe('low')
    expect(result.modelSource).toBe('arg')
    expect(result.effortSource).toBe('arg')
  })

  it('explicit: an owner pin effort is sent as given, effortSource pin', async () => {
    const result = decision(await routeForDelegation({
      role: 'worker',
      routing: routingOf({ executor: { mode: 'locked', provider: 'alpha', model: 'm-a', reasoningEffort: 'medium' } }),
      ports: { catalog: catalogOf([{ provider: 'alpha', id: 'm-a', contextWindow: 200000, defaultEffort: 'high' }]), policy: ABSENT },
    }))
    expect(result.selected).toEqual({ provider: 'alpha', model: 'm-a', reasoningEffort: 'medium' })
    expect(result.modelSource).toBe('pin')
    expect(result.effortSource).toBe('pin')
  })

  it('catalog default: the adapter-declared defaultEffort is sent, effortSource catalog-default', async () => {
    const result = decision(await routeForDelegation({
      role: 'worker',
      arg: { provider: 'alpha', model: 'm-a' },
      routing: routingOf(),
      ports: { catalog: catalogOf([{ provider: 'alpha', id: 'm-a', contextWindow: 200000, defaultEffort: 'high' }]), policy: ABSENT },
    }))
    expect(result.selected).toEqual({ provider: 'alpha', model: 'm-a', reasoningEffort: 'high' })
    expect(result.reasoningEffort).toBe('high')
    expect(result.effortSource).toBe('catalog-default')
  })

  it('unspecified: no explicit and no catalog default -> reasoningEffort omitted, effortSource host-default', async () => {
    const result = decision(await routeForDelegation({
      role: 'worker',
      arg: { provider: 'alpha', model: 'm-a' },
      routing: routingOf(),
      ports: { catalog: catalogOf([{ provider: 'alpha', id: 'm-a', contextWindow: 200000 }]), policy: ABSENT },
    }))
    expect(result.selected).toEqual({ provider: 'alpha', model: 'm-a' })
    expect('reasoningEffort' in result).toBe(false)
    expect(result.effortSource).toBe('host-default')
  })

  it('an effort-only arg keeps the ladder model and is preflighted for it', async () => {
    const seen: LlmCallConfig[] = []
    const catalog = catalogOf(TWO_ALPHA, {
      resolveCallConfig: async (config: LlmCallConfig) => { seen.push(config); return { ...config } },
    })
    const result = decision(await routeForDelegation({
      role: 'planner',
      arg: { effort: 'xhigh' },
      routing: routingOf(),
      ports: { catalog, policy: alphaPolicy },
    }))
    expect(result.modelSource).toBe('ladder')
    expect(result.selected?.model).toBe('m-a')
    expect(result.selected?.reasoningEffort).toBe('xhigh')
    expect(result.effortSource).toBe('arg')
    expect(seen.at(-1)).toEqual({ provider: 'alpha', model: 'm-a', reasoningEffort: 'xhigh' })
  })

  it('an effort rejected by preflight refuses instead of falling back to the default', async () => {
    const catalog = catalogOf(TWO_ALPHA, {
      resolveCallConfig: async (config: LlmCallConfig) => {
        if (config.reasoningEffort === 'bogus') throw new Error('unsupported effort')
        return { ...config }
      },
    })
    const result = refusal(await routeForDelegation({
      role: 'worker',
      arg: { provider: 'alpha', model: 'm-a', effort: 'bogus' },
      routing: routingOf(),
      ports: { catalog, policy: ABSENT },
    }))
    expect(result.refused).toBe(AP_ROLE_ROUTE_PREFLIGHT_FAILED)
  })

  it('an inherited model with an explicit effort still sends the effort', async () => {
    const result = decision(await routeForDelegation({
      role: 'scout',
      arg: { effort: 'low' },
      routing: routingOf(),
      ports: { catalog: catalogOf(TWO_ALPHA), policy: ABSENT },
    }))
    expect(result.selected).toBeUndefined()
    expect(result.modelSource).toBe('inherit')
    expect(result.reasoningEffort).toBe('low')
    expect(result.effortSource).toBe('arg')
  })
})

describe('routeForDelegation: precedence and one entry for every role', () => {
  const catalog = () => catalogOf([
    ...TWO_ALPHA,
    { provider: 'beta', id: 'b-1', contextWindow: 200000 },
  ])
  const policy = policyOf(['alpha', 'm-a'], ['alpha', 'm-b'], ['beta', 'b-1'])

  it('call arg beats the owner pin, which beats the ladder', async () => {
    const pinned = routingOf({ executor: { mode: 'locked', provider: 'alpha', model: 'm-b' } })
    const viaArg = decision(await routeForDelegation({
      role: 'worker', arg: { provider: 'beta', model: 'b-1' }, routing: pinned, ports: { catalog: catalog(), policy },
    }))
    expect([viaArg.modelSource, viaArg.selected?.model]).toEqual(['arg', 'b-1'])
    const viaPin = decision(await routeForDelegation({
      role: 'worker', routing: pinned, ports: { catalog: catalog(), policy },
    }))
    expect([viaPin.modelSource, viaPin.selected?.model]).toEqual(['pin', 'm-b'])
    const viaLadder = decision(await routeForDelegation({
      role: 'worker', routing: routingOf(), ports: { catalog: catalog(), policy },
    }))
    expect(viaLadder.modelSource).toBe('ladder')
  })

  it('pins map from the legacy roles: executor -> worker and executor-lead, planner -> planner, scout and clerk have none', async () => {
    const routing = routingOf({
      executor: { mode: 'locked', provider: 'alpha', model: 'm-b' },
      planner: { mode: 'locked', provider: 'beta', model: 'b-1' },
    })
    const sourceOf = async (role: DelegationRoleName) =>
      decision(await routeForDelegation({ role, routing, ports: { catalog: catalog(), policy } }))
    expect((await sourceOf('worker')).selected?.model).toBe('m-b')
    expect((await sourceOf('executor-lead')).selected?.model).toBe('m-b')
    expect((await sourceOf('planner')).selected?.model).toBe('b-1')
    expect((await sourceOf('scout')).modelSource).toBe('ladder')
    expect((await sourceOf('clerk')).modelSource).toBe('ladder')
  })

  it('the reviewer pin is the plan-auditor, else the execution-auditor, else the rules-auditor', async () => {
    const run = async (roles: Partial<Record<Role, RoleRouting>>) =>
      decision(await routeForDelegation({ role: 'reviewer', excludeFamilies: ['zeta'], routing: routingOf(roles), ports: { catalog: catalog(), policy } }))
    const all = await run({
      'plan-auditor': { mode: 'locked', provider: 'alpha', model: 'm-a' },
      'execution-auditor': { mode: 'locked', provider: 'alpha', model: 'm-b' },
      'rules-auditor': { mode: 'locked', provider: 'beta', model: 'b-1' },
    })
    expect(all.selected?.model).toBe('m-a')
    const noPlan = await run({
      'execution-auditor': { mode: 'locked', provider: 'alpha', model: 'm-b' },
      'rules-auditor': { mode: 'locked', provider: 'beta', model: 'b-1' },
    })
    expect(noPlan.selected?.model).toBe('m-b')
    const rulesOnly = await run({ 'rules-auditor': { mode: 'locked', provider: 'beta', model: 'b-1' } })
    expect(rulesOnly.selected?.model).toBe('b-1')
  })

  it('the planner goes through the work class and the ladder (MY-127): a ladder tier restricts its candidates', async () => {
    const routing = routingOf({}, {
      ladder: { tiers: { economy: ['beta/b-1'], standard: [], reserve: [] }, auditTier: 'none', speedOrder: [], costOverrides: [] },
    })
    const result = decision(await routeForDelegation({
      role: 'planner', workClass: 'simple', routing, ports: { catalog: catalog(), policy },
    }))
    expect(result.modelSource).toBe('ladder')
    expect(result.selected).toEqual({ provider: 'beta', model: 'b-1' })
    expect(result.why.some((line) => /work class: simple restricts dispatch membership to tier\(s\) economy/.test(line))).toBe(true)
  })

  it('a role with nothing configured and no session policy inherits, and says why', async () => {
    const result = decision(await routeForDelegation({
      role: 'scout', routing: routingOf(), ports: { catalog: catalog(), policy: ABSENT },
    }))
    expect(result.modelSource).toBe('inherit')
    expect(result.selected).toBeUndefined()
    expect(result.effortSource).toBe('host-default')
    expect(result.why.join(' ')).toMatch(/no session model-selection policy/)
  })

  it('routing mode off and a missing catalog both inherit', async () => {
    const off = decision(await routeForDelegation({
      role: 'worker', routing: routingOf({}, { mode: 'off' }), ports: { catalog: catalog(), policy },
    }))
    expect(off.modelSource).toBe('inherit')
    const none = decision(await routeForDelegation({ role: 'worker', routing: routingOf(), ports: { policy } }))
    expect(none.modelSource).toBe('inherit')
  })

  it('a half-named route is refused, not guessed', async () => {
    const result = refusal(await routeForDelegation({
      role: 'worker', arg: { model: 'm-a' }, routing: routingOf(), ports: { catalog: catalog(), policy },
    }))
    expect(result.refused).toBe(AP_ROLE_ROUTE_INCOMPLETE)
  })
})

describe('routeForDelegation: the subagentModelSelection allowlist', () => {
  const catalog = () => catalogOf([...TWO_ALPHA, { provider: 'beta', id: 'b-1', contextWindow: 200000 }])
  const setting = { enabled: true, allowedModels: [{ provider: 'alpha', model: 'm-a' }] }

  it('an arg outside the allowed models is refused with AP_ROLE_ROUTE_NOT_ALLOWED, even with no session policy', async () => {
    const result = refusal(await routeForDelegation({
      role: 'worker', arg: { provider: 'beta', model: 'b-1' }, routing: routingOf(),
      ports: { catalog: catalog(), policy: ABSENT, modelSelection: setting },
    }))
    expect(result.refused).toBe(AP_ROLE_ROUTE_NOT_ALLOWED)
    expect(result.detail).toMatch(/subagentModelSelection allowedModels \[alpha\/m-a\]/)
  })

  it('an arg inside it passes; a disabled setting constrains nothing', async () => {
    const inside = decision(await routeForDelegation({
      role: 'worker', arg: { provider: 'alpha', model: 'm-a' }, routing: routingOf(),
      ports: { catalog: catalog(), policy: ABSENT, modelSelection: setting },
    }))
    expect(inside.selected?.model).toBe('m-a')
    const disabled = decision(await routeForDelegation({
      role: 'worker', arg: { provider: 'beta', model: 'b-1' }, routing: routingOf(),
      ports: { catalog: catalog(), policy: ABSENT, modelSelection: { ...setting, enabled: false } },
    }))
    expect(disabled.selected?.model).toBe('b-1')
  })

  it('an owner pin outside the allowlist is refused too', async () => {
    const result = refusal(await routeForDelegation({
      role: 'planner',
      routing: routingOf({ planner: { mode: 'locked', provider: 'beta', model: 'b-1' } }),
      ports: { catalog: catalog(), policy: ABSENT, modelSelection: setting },
    }))
    expect(result.refused).toBe(AP_ROLE_ROUTE_NOT_ALLOWED)
  })

  it('ladder selection draws only from the session policy intersected with the setting', async () => {
    const two = { enabled: true, allowedModels: [{ provider: 'alpha', model: 'm-a' }, { provider: 'beta', model: 'b-1' }] }
    const result = decision(await routeForDelegation({
      role: 'scout', routing: routingOf(),
      ports: { catalog: catalog(), policy: policyOf(['alpha', 'm-a'], ['alpha', 'm-b'], ['beta', 'b-1']), modelSelection: two },
    }))
    expect(result.modelSource).toBe('ladder')
    expect(['m-a', 'b-1']).toContain(result.selected?.model)
    expect(result.why.join(' ')).toMatch(/2 route\(s\) after normalization/)
  })

  it('an arg outside the session policy is refused as well', async () => {
    const result = refusal(await routeForDelegation({
      role: 'worker', arg: { provider: 'beta', model: 'b-1' }, routing: routingOf(),
      ports: { catalog: catalog(), policy: policyOf(['alpha', 'm-a']) },
    }))
    expect(result.refused).toBe(AP_ROLE_ROUTE_NOT_ALLOWED)
  })
})

describe('routeForDelegation: reviewer independence', () => {
  const MODELS = [
    { provider: 'alpha', id: 'm-a', contextWindow: 200000 },
    { provider: 'alpha', id: 'm-b', contextWindow: 131072 },
    { provider: 'beta', id: 'b-1', contextWindow: 150000 },
    { provider: 'gamma', id: 'g-1', contextWindow: 150000 },
  ] as const

  it('excludes the reviewed families and records cross-family', async () => {
    const result = decision(await routeForDelegation({
      role: 'reviewer', excludeFamilies: ['alpha'], routing: routingOf(),
      ports: { catalog: catalogOf(MODELS), policy: policyOf(['alpha', 'm-a'], ['alpha', 'm-b'], ['beta', 'b-1'], ['gamma', 'g-1']) },
    }))
    expect(result.selected?.provider).not.toBe('alpha')
    expect(result.independence).toBe('cross-family')
    expect(result.excludedFamilies).toEqual(['alpha'])
    expect(result.independenceNote).toBeUndefined()
  })

  it('a SINGLE route outside the excluded family is selected explicitly, never inherited', async () => {
    const result = decision(await routeForDelegation({
      role: 'reviewer', excludeFamilies: ['alpha'], routing: routingOf(),
      ports: { catalog: catalogOf(MODELS), policy: policyOf(['alpha', 'm-a'], ['alpha', 'm-b'], ['beta', 'b-1']) },
    }))
    expect(result.modelSource).toBe('ladder')
    expect(result.selected).toEqual({ provider: 'beta', model: 'b-1' })
    expect(result.independence).toBe('cross-family')
  })

  it('no candidate outside the excluded families -> same family, reduced, with a note', async () => {
    const result = decision(await routeForDelegation({
      role: 'reviewer', excludeFamilies: ['alpha'], routing: routingOf(),
      ports: { catalog: catalogOf(MODELS), policy: policyOf(['alpha', 'm-a'], ['alpha', 'm-b']) },
    }))
    expect(result.selected?.provider).toBe('alpha')
    expect(result.independence).toBe('reduced')
    expect(result.independenceNote).toMatch(/no reviewer route outside provider families \[alpha\]/)
  })

  it('an inherited reviewer route cannot be claimed cross-family', async () => {
    const result = decision(await routeForDelegation({
      role: 'reviewer', excludeFamilies: ['alpha'], routing: routingOf(),
      ports: { catalog: catalogOf(MODELS), policy: ABSENT },
    }))
    expect(result.selected).toBeUndefined()
    expect(result.independence).toBe('reduced')
    expect(result.independenceNote).toMatch(/not observable/)
  })

  it('an owner pin or arg inside an excluded family wins but is recorded as reduced', async () => {
    const result = decision(await routeForDelegation({
      role: 'reviewer', excludeFamilies: ['alpha'], arg: { provider: 'alpha', model: 'm-a' }, routing: routingOf(),
      ports: { catalog: catalogOf(MODELS), policy: ABSENT },
    }))
    expect(result.modelSource).toBe('arg')
    expect(result.independence).toBe('reduced')
    expect(result.independenceNote).toMatch(/family "alpha"/)
    const out = decision(await routeForDelegation({
      role: 'reviewer', excludeFamilies: ['alpha'], arg: { provider: 'beta', model: 'b-1' }, routing: routingOf(),
      ports: { catalog: catalogOf(MODELS), policy: ABSENT },
    }))
    expect(out.independence).toBe('cross-family')
  })

  it('nothing to exclude means cross-family cannot be claimed', async () => {
    const result = decision(await routeForDelegation({
      role: 'reviewer', routing: routingOf(),
      ports: { catalog: catalogOf(MODELS), policy: policyOf(['alpha', 'm-a'], ['beta', 'b-1']) },
    }))
    expect(result.independence).toBe('reduced')
    expect(result.independenceNote).toMatch(/no observed provider family/)
  })

  it('non-reviewer roles carry no independence', async () => {
    const result = decision(await routeForDelegation({
      role: 'worker', excludeFamilies: ['alpha'], routing: routingOf(), ports: { catalog: catalogOf(MODELS), policy: ABSENT },
    }))
    expect(result.independence).toBeUndefined()
    expect(result.excludedFamilies).toEqual([])
  })
})
