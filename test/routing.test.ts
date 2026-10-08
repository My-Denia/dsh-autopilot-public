/**
 * M2 routing core — exact-decision tests over the plan v3 fixtures (a)…(h).
 *
 * Assertions are on the exact decision KIND (the repo's standing lesson from
 * `test/gate.test.ts`: never collapse an N-valued outcome to a boolean), and
 * every selector result asserts a non-empty `why` that NAMES the rules that
 * fired — the record must be reconstructable without the code.
 *
 * The host `ctx.llm` is stubbed at the structural boundary
 * (`LlmRuntimeSubset`); the compile-time bearer against the REAL
 * `LlmRuntime` lives in `test/routing-boundary.test.ts`.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RouteCatalog, catalogRank, providerIsLive, routeKey } from '../src/routing/catalog.js'
import type { LlmCallConfig, LlmRuntimeSubset } from '../src/routing/catalog.js'
import { independenceOf, isExplicitRoute, modelAxis, providerAxis, sameRoute, toRoutePin } from '../src/routing/identity.js'
import type { RoutePin } from '../src/routing/identity.js'
import { authorizedAutoRoutes, resolvePluginGrant } from '../src/routing/authorize.js'
import type { GrantSource, SessionPolicyState } from '../src/routing/authorize.js'
import { DEFAULT_ROLE_MIN_CONTEXT, selectRoute } from '../src/routing/select.js'
import type { Role, RoutePreference, RouteSelectionInput, RoleRouting, SelectionDecision } from '../src/routing/select.js'

// ── Stub at the structural boundary ──

interface StubModel {
  readonly provider: string
  readonly id: string
  readonly contextWindow?: number
  readonly efforts?: readonly string[]
  readonly defaultEffort?: string
}

interface StubOptions {
  /** Model ids whose `resolveCallConfig` rejects (fixture h). */
  readonly rejectPreflightFor?: readonly string[]
  /** Providers whose `listModels` throws (catalog degradation, still live). */
  readonly failListingFor?: readonly string[]
  /** When true, `listProviders` throws (the whole catalog is unavailable). */
  readonly failProviders?: boolean
}

function stubLlm(models: readonly StubModel[], options: StubOptions = {}): LlmRuntimeSubset & {
  readonly calls: { readonly preflight: LlmCallConfig[]; readonly listProviders: number; readonly listModels: number }
} {
  const calls = { preflight: [] as LlmCallConfig[], listProviders: 0, listModels: 0 }
  const providerIds = [...new Set(models.map((model) => model.provider))]
  const stub: LlmRuntimeSubset = {
    listProviders: () => {
      calls.listProviders += 1
      if (options.failProviders) throw new Error('listProviders: scripted failure')
      return providerIds.map((id) => ({ id, name: id }))
    },
    listModels: async (provider: string) => {
      calls.listModels += 1
      if (options.failListingFor?.includes(provider)) throw new Error(`listModels: scripted failure for ${provider}`)
      return models.filter((model) => model.provider === provider).map((model) => ({ provider, id: model.id, name: model.id }))
    },
    resolveModelInfo: async (provider: string, model: string) => {
      const hit = models.find((candidate) => candidate.provider === provider && candidate.id === model)
      if (hit === undefined) throw new Error(`resolveModelInfo: unknown route ${provider}/${model}`)
      const hasReasoning = (hit.efforts?.length ?? 0) > 0 || hit.defaultEffort !== undefined
      return {
        provider,
        id: model,
        name: model,
        ...(hit.contextWindow !== undefined ? { context: { contextWindow: hit.contextWindow } } : {}),
        ...(hasReasoning
          ? {
              reasoning: {
                efforts: (hit.efforts ?? []).map((effort) => ({ id: effort, name: effort })),
                ...(hit.defaultEffort !== undefined ? { defaultEffort: hit.defaultEffort } : {}),
              },
            }
          : {}),
      }
    },
    resolveCallConfig: async (config: LlmCallConfig) => {
      calls.preflight.push(config)
      if (options.rejectPreflightFor?.includes(config.model)) {
        throw new Error(`resolveCallConfig rejected ${config.provider}/${config.model}: scripted rejection`)
      }
      return { ...config }
    },
  }
  return Object.assign(stub, { calls })
}

function catalogOf(models: readonly StubModel[], options: StubOptions = {}): RouteCatalog {
  return new RouteCatalog(stubLlm(models, options))
}

// ── Input builders ──

function presentPolicy(...routes: readonly [string, string][]): SessionPolicyState {
  return { kind: 'present', routes: routes.map(([provider, model]) => ({ provider, model })) }
}

const ABSENT_POLICY: SessionPolicyState = { kind: 'absent' }
const UNREACHABLE_POLICY: SessionPolicyState = { kind: 'unreachable' }

const AUTO: RoleRouting = { mode: 'auto' }

function selection(over: Partial<RouteSelectionInput> = {}): RouteSelectionInput {
  return {
    role: 'execution-auditor',
    risk: 'medium',
    preference: 'balanced',
    roleRouting: AUTO,
    policy: presentPolicy(['alpha', 'm-a'], ['alpha', 'm-b']),
    catalog: catalogOf([
      { provider: 'alpha', id: 'm-a', contextWindow: 131072, efforts: ['high'], defaultEffort: 'high' },
      { provider: 'alpha', id: 'm-b', contextWindow: 131072 },
    ]),
    executorPin: { provider: 'alpha', model: 'm-a' },
    independenceFloor: 'medium',
    ...over,
  }
}

/** The packet's standing requirement: non-empty `why` naming the fired rules. */
function expectWhy(decision: SelectionDecision, ...patterns: readonly RegExp[]): void {
  if (decision.kind === 'escalate-owner') {
    expect(decision.reason.length > 0).toBe(true)
    return
  }
  const why = decision.kind === 'route' || decision.kind === 'inherit' || decision.kind === 'blocked' ? decision.why : undefined
  expect(why, `decision ${decision.kind} must carry why`).toBeDefined()
  expect(why!.length > 0, `why must be non-empty, got ${JSON.stringify(why)}`).toBe(true)
  for (const pattern of patterns) {
    expect(
      why!.some((entry) => pattern.test(entry)),
      `why must name ${pattern}, got ${JSON.stringify(why)}`,
    ).toBe(true)
  }
}

function expectRoute(decision: SelectionDecision): Extract<SelectionDecision, { kind: 'route' }> {
  expect(decision.kind).toBe('route')
  return decision as Extract<SelectionDecision, { kind: 'route' }>
}

// ── Catalog port ──

describe('RouteCatalog: the ctx.llm port', () => {
  it('an absent service is an EMPTY unavailable catalog, recorded — never a throw', async () => {
    const snapshot = await new RouteCatalog(undefined).snapshot()
    expect(snapshot.catalogStatus).toBe('unavailable')
    expect(snapshot.providers).toEqual([])
    expect(snapshot.listedModels).toEqual([])
    expect(snapshot.diagnostic).toBeDefined()
    expect(providerIsLive(snapshot, 'alpha')).toBe(false)
  })

  it('lists providers and models in adapter-preferred order', async () => {
    const catalog = catalogOf([
      { provider: 'alpha', id: 'm-1' },
      { provider: 'beta', id: 'm-2' },
      { provider: 'alpha', id: 'm-0' },
    ])
    const snapshot = await catalog.snapshot()
    expect(snapshot.catalogStatus).toBe('live')
    expect(snapshot.providers.map((provider) => provider.id)).toEqual(['alpha', 'beta'])
    expect(snapshot.listedModels.map((model) => `${model.provider}/${model.id}`)).toEqual(['alpha/m-1', 'alpha/m-0', 'beta/m-2'])
    expect(catalogRank(snapshot, 'alpha', 'm-1')).toBe(0)
    expect(catalogRank(snapshot, 'alpha', 'm-0')).toBe(1)
    expect(catalogRank(snapshot, 'beta', 'm-2')).toBe(2)
    expect(catalogRank(snapshot, 'alpha', 'm-unlisted')).toBeUndefined()
    expect(providerIsLive(snapshot, 'beta')).toBe(true)
    expect(providerIsLive(snapshot, 'gamma')).toBe(false)
  })

  it('caches the snapshot until invalidate() (llm/adapters-updated discipline)', async () => {
    const catalog = catalogOf([{ provider: 'alpha', id: 'm-1' }])
    const first = await catalog.snapshot()
    const second = await catalog.snapshot()
    expect(second).toBe(first)
    catalog.invalidate()
    const third = await catalog.snapshot()
    expect(third).not.toBe(first)
  })

  it('counts host reads: one read per snapshot generation', async () => {
    const stubbed = stubLlm([{ provider: 'alpha', id: 'm-1' }])
    const catalog = new RouteCatalog(stubbed)
    await catalog.snapshot()
    await catalog.snapshot()
    expect(stubbed.calls.listProviders).toBe(1)
    expect(stubbed.calls.listModels).toBe(1)
    catalog.invalidate()
    await catalog.snapshot()
    expect(stubbed.calls.listProviders).toBe(2)
  })

  it('a failed provider listing is recorded and the provider stays live (degradation is never silent)', async () => {
    const catalog = catalogOf([{ provider: 'alpha', id: 'm-1' }, { provider: 'beta', id: 'm-2' }], { failListingFor: ['beta'] })
    const snapshot = await catalog.snapshot()
    expect(snapshot.catalogStatus).toBe('live')
    expect(snapshot.providerErrors.get('beta')).toContain('scripted failure')
    expect(providerIsLive(snapshot, 'beta')).toBe(true)
    expect(snapshot.listedModels.map((model) => model.id)).toEqual(['m-1'])
  })

  it('a failing listProviders degrades the whole catalog to unavailable with a diagnostic', async () => {
    const catalog = catalogOf([{ provider: 'alpha', id: 'm-1' }], { failProviders: true })
    const snapshot = await catalog.snapshot()
    expect(snapshot.catalogStatus).toBe('unavailable')
    expect(snapshot.diagnostic).toContain('listProviders')
    expect(snapshot.providers).toEqual([])
  })

  it('resolveRoute rejects unknown routes; preflight echoes and records the call', async () => {
    const stubbed = stubLlm([{ provider: 'alpha', id: 'm-1', defaultEffort: 'high' }])
    const catalog = new RouteCatalog(stubbed)
    await expect(catalog.resolveRoute('alpha', 'm-nope')).rejects.toThrow('unknown route')
    const resolved = await catalog.preflight({ provider: 'alpha', model: 'm-1', reasoningEffort: 'high' })
    expect(resolved.model).toBe('m-1')
    expect(stubbed.calls.preflight).toHaveLength(1)
  })

  it('routeKey is trim-exact and collision-free', () => {
    expect(routeKey('alpha', 'm-1')).toBe(routeKey(' alpha ', ' m-1 '))
    expect(routeKey('alpha', 'm-1')).not.toBe(routeKey('alpha', 'm-2'))
    expect(routeKey('a/b', 'm')).not.toBe(routeKey('a', 'b/m'))
  })
})

// ── Identity: two axes, never one word ──

describe('identity: two axes, never one word', () => {
  it('modelAxis: identical trim-exact ids are SAME across any providers (conservative same-family)', () => {
    expect(modelAxis({ provider: 'alpha', model: 'm-x' }, { provider: 'beta', model: 'm-x' })).toBe('same')
    expect(modelAxis({ provider: 'alpha', model: ' m-x ' }, { provider: 'beta', model: 'm-x' })).toBe('same')
  })

  it('modelAxis: different ids are distinct — claiming nothing about weights', () => {
    expect(modelAxis({ provider: 'alpha', model: 'm-1' }, { provider: 'alpha', model: 'm-2' })).toBe('distinct')
    expect(modelAxis({ provider: 'alpha', model: 'm-1' }, { provider: 'beta', model: 'm-2' })).toBe('distinct')
  })

  it('either side inheriting (no explicit model) makes the axis unknown', () => {
    expect(modelAxis(undefined, { provider: 'alpha', model: 'm-1' })).toBe('unknown')
    expect(modelAxis({ provider: 'alpha' }, { provider: 'alpha', model: 'm-1' })).toBe('unknown')
    expect(modelAxis({ provider: 'alpha', model: 'm-1' }, {})).toBe('unknown')
  })

  it('providerAxis: same/distinct/unknown for the route key (the 0.2.0 family)', () => {
    expect(providerAxis({ provider: 'alpha', model: 'm-1' }, { provider: 'alpha', model: 'm-2' })).toBe('same')
    expect(providerAxis({ provider: ' alpha ' }, { provider: 'alpha' })).toBe('same')
    expect(providerAxis({ provider: 'alpha', model: 'm-1' }, { provider: 'beta', model: 'm-2' })).toBe('distinct')
    expect(providerAxis(undefined, { provider: 'alpha' })).toBe('unknown')
    expect(providerAxis({ model: 'm-1' }, { provider: 'alpha' })).toBe('unknown')
  })

  it('sameRoute is trim-exact on both fields; toRoutePin normalizes or refuses', () => {
    expect(sameRoute({ provider: 'alpha', model: 'm-1' }, { provider: 'alpha', model: ' m-1 ' })).toBe(true)
    expect(sameRoute({ provider: 'alpha', model: 'm-1' }, { provider: 'beta', model: 'm-1' })).toBe(false)
    expect(isExplicitRoute({ provider: 'alpha', model: ' ' })).toBe(false)
    expect(toRoutePin({ provider: ' alpha ', model: ' m-1 ' })).toEqual({ provider: 'alpha', model: 'm-1' })
    expect(toRoutePin({ model: 'm-1' })).toBeUndefined()
  })

  it('independenceOf: achieved requires distinct on BOTH axes', () => {
    expect(independenceOf({ provider: 'beta', model: 'm-2' }, { provider: 'alpha', model: 'm-1' }, true)).toEqual({
      modelAxis: 'distinct',
      providerAxis: 'distinct',
      outcome: 'achieved',
    })
  })

  it('independenceOf: model-distinct with a shared provider is same-family, not achieved', () => {
    expect(independenceOf({ provider: 'alpha', model: 'm-2' }, { provider: 'alpha', model: 'm-1' }, true)).toEqual({
      modelAxis: 'distinct',
      providerAxis: 'same',
      outcome: 'same-family',
    })
  })

  it('independenceOf: the same model id behind a second provider is same-family, not achieved', () => {
    expect(independenceOf({ provider: 'beta', model: 'm-1' }, { provider: 'alpha', model: 'm-1' }, true)).toEqual({
      modelAxis: 'same',
      providerAxis: 'distinct',
      outcome: 'same-family',
    })
  })

  it('independenceOf: an unobservable executor pin is unknown-family; below the floor is not-required', () => {
    expect(independenceOf({ provider: 'beta', model: 'm-2' }, undefined, true).outcome).toBe('unknown-family')
    expect(independenceOf({ provider: 'beta', model: 'm-2' }, { model: 'm-9' }, true).outcome).toBe('unknown-family')
    expect(independenceOf({ provider: 'alpha', model: 'm-1' }, { provider: 'alpha', model: 'm-1' }, false)).toEqual({
      modelAxis: 'same',
      providerAxis: 'same',
      outcome: 'not-required',
    })
  })
})

// ── Authorization ──

describe('authorize: the session policy is the authority, never the settings', () => {
  const live = new Set(['alpha', 'beta'])

  it('present policy: the auto set is policy routes ∩ live providers, deduped, in policy order', () => {
    const authorization = authorizedAutoRoutes(
      {
        kind: 'present',
        routes: [
          { provider: 'alpha', model: 'm-1' },
          { provider: 'gamma', model: 'm-9' },
          { provider: 'alpha', model: ' m-1 ' },
          // Deliberately invalid entry: no provider. Authorization must drop it, not guess.
          { model: 'broken' } as unknown as RoutePin,
        ],
      },
      live,
    )
    expect(authorization.inheritOnly).toBe(false)
    expect(authorization.routes).toEqual([{ provider: 'alpha', model: 'm-1' }])
    expect(authorization.authorizationSource).toBe('session-policy')
    expectWhy({ kind: 'inherit', why: authorization.why }, /^authorization: session model-selection policy present/)
    expect(authorization.why.some((entry) => entry.includes('no live provider for gamma/m-9'))).toBe(true)
  })

  it('absent policy: inheritance only — the native default, named honestly', () => {
    const authorization = authorizedAutoRoutes(ABSENT_POLICY, live)
    expect(authorization.inheritOnly).toBe(true)
    expect(authorization.routes).toEqual([])
    expect(authorization.authorizationSource).toBeUndefined()
    expect(authorization.why.some((entry) => entry.includes('inheritance only'))).toBe(true)
  })

  it('unreachable projection: inheritance only, recorded as unreachable-inherit', () => {
    const authorization = authorizedAutoRoutes(UNREACHABLE_POLICY, live)
    expect(authorization.inheritOnly).toBe(true)
    expect(authorization.authorizationSource).toBe('unreachable-inherit')
    expect(authorization.why.some((entry) => entry.includes('unreachable-inherit'))).toBe(true)
  })

  it('a plugin-config grant is ALLOWED when no session policy exists (0.2.0 parity), for every source', () => {
    const sources: readonly GrantSource[] = ['routing-lock', 'legacy-role', 'legacy-pool']
    for (const source of sources) {
      for (const policy of [ABSENT_POLICY, UNREACHABLE_POLICY]) {
        const verdict = resolvePluginGrant({ provider: 'alpha', model: 'm-1', source }, policy)
        expect(verdict.kind).toBe('allowed')
        if (verdict.kind === 'allowed') expect(verdict.authorizationSource).toBe('plugin-config')
      }
    }
  })

  it('a grant INSIDE an existing policy is allowed as plugin-config', () => {
    const verdict = resolvePluginGrant({ provider: 'alpha', model: 'm-1', source: 'legacy-pool' }, presentPolicy(['alpha', 'm-1']))
    expect(verdict.kind).toBe('allowed')
  })

  it('a grant OUTSIDE an existing policy is a conflict naming BOTH grants — the same rule for every source and mode (fixture f)', () => {
    const policy = presentPolicy(['alpha', 'm-a'], ['alpha', 'm-b'])
    const sources: readonly GrantSource[] = ['routing-lock', 'legacy-role', 'legacy-pool']
    for (const source of sources) {
      const verdict = resolvePluginGrant({ provider: 'alpha', model: 'm-lock', source }, policy)
      expect(verdict.kind).toBe('conflict')
      if (verdict.kind === 'conflict') {
        expect(verdict.reason).toContain(source)
        expect(verdict.reason).toContain('alpha/m-lock')
        expect(verdict.reason).toContain('alpha/m-a')
        expect(verdict.reason).toContain('needs-owner-decision')
      }
    }
  })

  it('a non-explicit grant is refused, not guessed', () => {
    const verdict = resolvePluginGrant({ provider: '  ', model: 'm-1', source: 'routing-lock' }, ABSENT_POLICY)
    expect(verdict.kind).toBe('conflict')
  })
})

// ── Selection fixtures ──

describe('select: fixture (a) — one provider, two models; auditor takes the next modelAxis-distinct candidate', () => {
  const models: readonly StubModel[] = [
    // Catalog order ranks the EXECUTOR's model first under balanced AND quality.
    { provider: 'alpha', id: 'm-exec', contextWindow: 200000, efforts: ['high', 'medium'], defaultEffort: 'high' },
    { provider: 'alpha', id: 'm-audit', contextWindow: 128000, efforts: ['low'], defaultEffort: 'low' },
  ]
  const policy = presentPolicy(['alpha', 'm-exec'], ['alpha', 'm-audit'])

  for (const preference of ['balanced', 'quality'] as const) {
    it(`auditor gets the next modelAxis-distinct candidate under ${preference}, providerAxis same, NO achieved claim`, async () => {
      const decision = await selectRoute(
        selection({
          preference,
          policy,
          catalog: catalogOf(models),
          executorPin: { provider: 'alpha', model: 'm-exec' },
        }),
      )
      const route = expectRoute(decision)
      expect(route.route.provider).toBe('alpha')
      expect(route.route.model).toBe('m-audit')
      expect(route.route.independence).toEqual({ modelAxis: 'distinct', providerAxis: 'same', outcome: 'same-family' })
      expect(route.route.independence?.outcome).not.toBe('achieved')
      expect(route.authorizationSource).toBe('session-policy')
      expect(route.fallbackFrom).toBeUndefined()
      expectWhy(decision, /^authorization:/, /^role-floor:/, new RegExp(`^preference: ${preference}`), /^independence: risk medium ≥ floor medium/, /^effort:/, /^preflight:/)
      const passed = route.candidatesConsidered.find((candidate) => candidate.model === 'm-exec')
      expect(passed?.independence).toEqual({ modelAxis: 'same', providerAxis: 'same', outcome: 'same-family' })
      expect(passed?.disposition).toBe('eligible')
      expect(route.candidatesConsidered.find((candidate) => candidate.model === 'm-audit')?.disposition).toBe('selected')
    })
  }

  it('below the risk floor the preference order is UNMODIFIED — the auditor runs on the executor\u2019s model, recorded not-required', async () => {
    const decision = await selectRoute(
      selection({ risk: 'low', policy, catalog: catalogOf(models), executorPin: { provider: 'alpha', model: 'm-exec' } }),
    )
    const route = expectRoute(decision)
    expect(route.route.model).toBe('m-exec')
    expect(route.route.independence).toEqual({ modelAxis: 'same', providerAxis: 'same', outcome: 'not-required' })
    expectWhy(decision, /^independence: risk low < floor medium/)
  })
})

describe('select: fixture (a2) — two providers, distinct models; both-axis-distinct ordering exercised', () => {
  const models: readonly StubModel[] = [
    { provider: 'alpha', id: 'm-1', contextWindow: 200000, efforts: ['high'] },
    { provider: 'beta', id: 'm-2', contextWindow: 128000, efforts: ['high'] },
  ]
  const policy = presentPolicy(['alpha', 'm-1'], ['beta', 'm-2'])

  it('the both-axis-distinct candidate outranks preference and is recorded achieved', async () => {
    const decision = await selectRoute(
      selection({ policy, catalog: catalogOf(models), executorPin: { provider: 'alpha', model: 'm-1' } }),
    )
    const route = expectRoute(decision)
    expect(route.route.provider).toBe('beta')
    expect(route.route.model).toBe('m-2')
    expect(route.route.independence).toEqual({ modelAxis: 'distinct', providerAxis: 'distinct', outcome: 'achieved' })
    const first = route.candidatesConsidered[0]
    expect(first?.model).toBe('m-2')
    expect(first?.disposition).toBe('selected')
    expectWhy(decision, /^independence: risk medium ≥ floor medium/)
  })

  it('axes are recomputed per dispatch against the CURRENT executor pin: a re-pinned executor flips the choice', async () => {
    const decision = await selectRoute(
      selection({ policy, catalog: catalogOf(models), executorPin: { provider: 'beta', model: 'm-2' } }),
    )
    const route = expectRoute(decision)
    expect(route.route.model).toBe('m-1')
    expect(route.route.independence).toEqual({ modelAxis: 'distinct', providerAxis: 'distinct', outcome: 'achieved' })
  })
})

describe('select: fixture (b) — the same model id behind two providers', () => {
  it('identity level: modelAxis is SAME across the two providers (trim-exact id, conservative)', () => {
    expect(modelAxis({ provider: 'alpha', model: 'm-x' }, { provider: 'beta', model: 'm-x' })).toBe('same')
  })

  it('selector level: the auditor SKIPS both copies to a distinct candidate when one exists', async () => {
    const models: readonly StubModel[] = [
      { provider: 'alpha', id: 'm-x', contextWindow: 200000, efforts: ['high'] },
      { provider: 'beta', id: 'm-x', contextWindow: 180000, efforts: ['high'] },
      { provider: 'gamma', id: 'm-y', contextWindow: 128000 },
    ]
    const decision = await selectRoute(
      selection({
        policy: presentPolicy(['alpha', 'm-x'], ['beta', 'm-x'], ['gamma', 'm-y']),
        catalog: catalogOf(models),
        executorPin: { provider: 'alpha', model: 'm-x' },
      }),
    )
    const route = expectRoute(decision)
    expect(route.route.provider).toBe('gamma')
    expect(route.route.model).toBe('m-y')
    expect(route.route.independence).toEqual({ modelAxis: 'distinct', providerAxis: 'distinct', outcome: 'achieved' })
    for (const candidate of route.candidatesConsidered) {
      if (candidate.model === 'm-x') expect(candidate.independence?.modelAxis).toBe('same')
    }
  })

  it('selector level: with NO distinct candidate, the honest record is same-family on the shared id', async () => {
    const models: readonly StubModel[] = [
      { provider: 'alpha', id: 'm-x', contextWindow: 200000, efforts: ['high'] },
      { provider: 'beta', id: 'm-x', contextWindow: 180000, efforts: ['high'] },
    ]
    const decision = await selectRoute(
      selection({
        policy: presentPolicy(['alpha', 'm-x'], ['beta', 'm-x']),
        catalog: catalogOf(models),
        executorPin: { provider: 'alpha', model: 'm-x' },
      }),
    )
    const route = expectRoute(decision)
    expect(route.route.model).toBe('m-x')
    expect(route.route.independence).toEqual({ modelAxis: 'same', providerAxis: 'same', outcome: 'same-family' })
    expect(route.route.independence?.outcome).not.toBe('achieved')
  })
})

describe('select: fixture (c) — a single-route authorized set inherits with an honest record', () => {
  it('nothing to choose between: inherit, no explicit selection, the route named in why', async () => {
    const decision = await selectRoute(
      selection({
        role: 'executor',
        policy: presentPolicy(['alpha', 'm-solo']),
        catalog: catalogOf([{ provider: 'alpha', id: 'm-solo', contextWindow: 200000, efforts: ['high'] }]),
        executorPin: undefined,
      }),
    )
    expect(decision.kind).toBe('inherit')
    if (decision.kind === 'inherit') {
      expectWhy(decision, /^authorization:/, /^eligibility: the authorized set holds a single route \(alpha\/m-solo\)/)
    }
  })
})

describe('select: fixture (d) — economy and quality flip on one fixed catalog', () => {
  const models: readonly StubModel[] = [
    { provider: 'alpha', id: 'm-big', contextWindow: 200000, efforts: ['high'], defaultEffort: 'high' },
    { provider: 'alpha', id: 'm-mid', contextWindow: 150000, efforts: ['high'] },
    { provider: 'alpha', id: 'm-small', contextWindow: 140000 },
  ]
  const policy = presentPolicy(['alpha', 'm-big'], ['alpha', 'm-mid'], ['alpha', 'm-small'])

  function flip(preference: RoutePreference): Promise<SelectionDecision> {
    return selectRoute(selection({ role: 'executor', preference, policy, catalog: catalogOf(models), executorPin: undefined }))
  }

  it('quality picks the efforts model with the largest window', async () => {
    const route = expectRoute(await flip('quality'))
    expect(route.route.model).toBe('m-big')
    expect(route.route.reasoningEffort).toBe('high')
    expectWhy(route, /^preference: quality/)
  })

  it('economy picks the smallest window at or above the floor — the flip', async () => {
    const route = expectRoute(await flip('economy'))
    expect(route.route.model).toBe('m-small')
    expect('reasoningEffort' in route.route).toBe(false) // never invented
    expectWhy(route, /^preference: economy/)
  })

  it('balanced prefers efforts, then window descending', async () => {
    const route = expectRoute(await flip('balanced'))
    expect(route.route.model).toBe('m-big')
  })
})

describe('select: fixture (e) — unknown contextWindow ranks last and is named', () => {
  const models: readonly StubModel[] = [
    { provider: 'alpha', id: 'm-known', contextWindow: 131072 },
    { provider: 'alpha', id: 'm-unknown', efforts: ['high'] }, // no contextWindow disclosed
  ]
  const policy = presentPolicy(['alpha', 'm-unknown'], ['alpha', 'm-known'])

  it('a known-sufficient candidate beats an unknown one even when the unknown has efforts', async () => {
    const decision = await selectRoute(
      selection({ role: 'executor', preference: 'balanced', policy, catalog: catalogOf(models), executorPin: undefined }),
    )
    const route = expectRoute(decision)
    expect(route.route.model).toBe('m-known')
    expectWhy(decision, /m-unknown contextWindow unknown — eligible, ranked after known-sufficient/)
    const unknown = route.candidatesConsidered.find((candidate) => candidate.model === 'm-unknown')
    expect(unknown?.contextWindow).toBeUndefined()
    expect(unknown?.note).toContain('contextWindow unknown')
  })

  it('unknown-only catalogs stay eligible: the unknown candidate is selected, not excluded', async () => {
    const decision = await selectRoute(
      selection({
        role: 'executor',
        policy: presentPolicy(['alpha', 'm-unknown'], ['alpha', 'm-unknown2']),
        catalog: catalogOf([{ provider: 'alpha', id: 'm-unknown' }, { provider: 'alpha', id: 'm-unknown2' }]),
        executorPin: undefined,
      }),
    )
    const route = expectRoute(decision)
    expect(route.route.model).toBe('m-unknown') // adapter-preferred order among equals
    expectWhy(decision, /contextWindow unknown/)
  })
})

describe('select: fixture (f) — a locked route outside the policy escalates to the owner', () => {
  it('selector level: locked outside policy ⇒ escalate-owner, never a silent dispatch', async () => {
    const decision = await selectRoute(
      selection({
        roleRouting: { mode: 'locked', provider: 'alpha', model: 'm-lock' },
        policy: presentPolicy(['alpha', 'm-a'], ['alpha', 'm-b']),
        catalog: catalogOf([{ provider: 'alpha', id: 'm-lock' }, { provider: 'alpha', id: 'm-a' }]),
      }),
    )
    expect(decision.kind).toBe('escalate-owner')
    if (decision.kind === 'escalate-owner') {
      expect(decision.reason).toContain('outside the session model-selection policy')
      expect(decision.reason).toContain('needs-owner-decision')
    }
  })

  it('locked INSIDE the policy dispatches with authorizationSource plugin-config', async () => {
    const decision = await selectRoute(
      selection({
        roleRouting: { mode: 'locked', provider: 'alpha', model: 'm-a', reasoningEffort: 'low' },
        policy: presentPolicy(['alpha', 'm-a'], ['alpha', 'm-b']),
        catalog: catalogOf([{ provider: 'alpha', id: 'm-a', contextWindow: 131072, efforts: ['high', 'low'], defaultEffort: 'high' }]),
      }),
    )
    const route = expectRoute(decision)
    expect(route.authorizationSource).toBe('plugin-config')
    expect(route.route.model).toBe('m-a')
    expect(route.route.reasoningEffort).toBe('low') // the lock names it; the adapter default does not win
    expectWhy(decision, /named by the role lock/)
  })

  it('locked with NO policy dispatches (0.2.0 parity), still preflighted', async () => {
    const decision = await selectRoute(
      selection({
        roleRouting: { mode: 'locked', provider: 'alpha', model: 'm-lock' },
        policy: ABSENT_POLICY,
        catalog: catalogOf([{ provider: 'alpha', id: 'm-lock' }]),
      }),
    )
    const route = expectRoute(decision)
    expect(route.authorizationSource).toBe('plugin-config')
    expectWhy(decision, /^authorization: routing-lock alpha\/m-lock allowed by plugin config/)
  })

  it('locked onto a provider with no live catalog entry escalates (blocked + needs-owner-decision)', async () => {
    const decision = await selectRoute(
      selection({
        roleRouting: { mode: 'locked', provider: 'gamma', model: 'm-lock' },
        policy: ABSENT_POLICY,
        catalog: catalogOf([{ provider: 'alpha', id: 'm-a' }]),
      }),
    )
    expect(decision.kind).toBe('escalate-owner')
  })
})

describe('select: F14 (PR #2 round 6) — a catalog outage is not "provider gone" on a locked route', () => {
  it('catalogStatus unavailable ⇒ NOT escalated: the lock proceeds to preflight (the actual gate), why names the outage', async () => {
    const stubbed = stubLlm([{ provider: 'alpha', id: 'm-lock', contextWindow: 131072 }], { failProviders: true })
    const decision = await selectRoute(
      selection({
        roleRouting: { mode: 'locked', provider: 'alpha', model: 'm-lock' },
        policy: ABSENT_POLICY,
        catalog: new RouteCatalog(stubbed),
      }),
    )
    const route = expectRoute(decision)
    expect(route.route.provider).toBe('alpha')
    expect(route.route.model).toBe('m-lock')
    expect(route.authorizationSource).toBe('plugin-config')
    // The outage is recorded honestly — degradation is never silent, and the
    // record never claims the provider was proven live either.
    expectWhy(decision, /^catalog: snapshot unavailable/, /not evidence the provider is gone/)
    // Dispatch proceeded TO PREFLIGHT: resolveCallConfig was actually called
    // (the catalog READ failed, not the route's ability to serve).
    expect(stubbed.calls.preflight).toHaveLength(1)
    expect(stubbed.calls.preflight[0]?.provider).toBe('alpha')
  })

  it('unavailable + preflight failure ⇒ blocked with the existing reason shape (plus the outage named)', async () => {
    const decision = await selectRoute(
      selection({
        roleRouting: { mode: 'locked', provider: 'alpha', model: 'm-a' },
        policy: ABSENT_POLICY,
        catalog: catalogOf(
          [{ provider: 'alpha', id: 'm-a', contextWindow: 131072 }],
          { failProviders: true, rejectPreflightFor: ['m-a'] },
        ),
      }),
    )
    expect(decision.kind).toBe('blocked')
    if (decision.kind === 'blocked') {
      // The existing escalation shape, byte-for-byte in its clauses: a lock
      // has no fallback candidate, so the failure still blocks dispatch.
      expect(decision.reason).toContain('failed preflight')
      expect(decision.reason).toContain('a lock has no fallback candidate')
      expectWhy(decision, /preflight: resolveCallConfig rejected alpha\/m-a/, /^catalog: snapshot unavailable/)
    }
  })

  it('a LIVE read that lacks the provider still escalates — the outage carve-out does not weaken the gone case', async () => {
    const decision = await selectRoute(
      selection({
        roleRouting: { mode: 'locked', provider: 'gamma', model: 'm-lock' },
        policy: ABSENT_POLICY,
        catalog: catalogOf([{ provider: 'alpha', id: 'm-a' }]),
      }),
    )
    expect(decision.kind).toBe('escalate-owner')
    if (decision.kind === 'escalate-owner') {
      expect(decision.reason).toContain('no live provider in the catalog')
      expect(decision.reason).toContain('needs-owner-decision')
    }
  })
})

describe('select: fixture (g) — no policy ⇒ inheritance only', () => {
  it('absent policy: auto mode inherits, multi-model catalog notwithstanding; settings never consulted', async () => {
    const decision = await selectRoute(
      selection({
        policy: ABSENT_POLICY,
        catalog: catalogOf([
          { provider: 'alpha', id: 'm-a', contextWindow: 200000, efforts: ['high'] },
          { provider: 'beta', id: 'm-b', contextWindow: 128000 },
        ]),
      }),
    )
    expect(decision.kind).toBe('inherit')
    if (decision.kind === 'inherit') {
      expectWhy(decision, /no session model-selection policy recorded/)
      expect(decision.authorizationSource).toBeUndefined()
    }
  })

  it('unreachable projection: inheritance only, recorded unreachable-inherit', async () => {
    const decision = await selectRoute(selection({ policy: UNREACHABLE_POLICY }))
    expect(decision.kind).toBe('inherit')
    if (decision.kind === 'inherit') {
      expect(decision.authorizationSource).toBe('unreachable-inherit')
      expectWhy(decision, /projection unreachable/)
    }
  })

  it('an empty intersection (all authorized providers dead) terminates to inheritance per eligibility rule 1', async () => {
    const decision = await selectRoute(
      selection({
        policy: presentPolicy(['gamma', 'm-1'], ['delta', 'm-2']),
        catalog: catalogOf([{ provider: 'alpha', id: 'm-a' }]),
      }),
    )
    expect(decision.kind).toBe('inherit')
    if (decision.kind === 'inherit') {
      expectWhy(decision, /authorized set is EMPTY after the live-catalog intersection/)
    }
  })
})

describe('select: fixture (h) — stubbed preflight rejection ⇒ next candidate + fallbackFrom', () => {
  const models: readonly StubModel[] = [
    { provider: 'alpha', id: 'm-first', contextWindow: 200000, efforts: ['high'], defaultEffort: 'high' },
    { provider: 'alpha', id: 'm-second', contextWindow: 131072 },
  ]
  const policy = presentPolicy(['alpha', 'm-first'], ['alpha', 'm-second'])

  it('the rejected favorite falls back to the next ranked candidate, chain recorded', async () => {
    const catalog = catalogOf(models, { rejectPreflightFor: ['m-first'] })
    const decision = await selectRoute(selection({ role: 'executor', policy, catalog, executorPin: undefined }))
    const route = expectRoute(decision)
    expect(route.route.model).toBe('m-second')
    expect(route.fallbackFrom).toEqual([
      { provider: 'alpha', model: 'm-first', reason: 'resolveCallConfig rejected alpha/m-first: scripted rejection' },
    ])
    expectWhy(decision, /m-first rejected \(.*scripted rejection.*\) — fell back to alpha\/m-second/)
    expect(route.candidatesConsidered.find((candidate) => candidate.model === 'm-first')?.disposition).toBe('preflight-rejected')
    expect(route.candidatesConsidered.find((candidate) => candidate.model === 'm-second')?.disposition).toBe('selected')
  })

  it('every candidate rejected ⇒ blocked with the full chain, never a silent dispatch', async () => {
    const catalog = catalogOf(models, { rejectPreflightFor: ['m-first', 'm-second'] })
    const decision = await selectRoute(selection({ role: 'executor', policy, catalog, executorPin: undefined }))
    expect(decision.kind).toBe('blocked')
    if (decision.kind === 'blocked') {
      expect(decision.reason).toContain('m-first')
      expect(decision.reason).toContain('m-second')
      expectWhy(decision, /rejected all 2 ranked candidate/)
    }
  })
})

// ── Selection edges the plan names ──

describe('select: rule-table edges', () => {
  it('role mode inherit: no reroute, the deployment default applies', async () => {
    const decision = await selectRoute(selection({ roleRouting: { mode: 'inherit' } }))
    expect(decision.kind).toBe('inherit')
    if (decision.kind === 'inherit') expectWhy(decision, /mode is inherit/)
  })

  it('the declared role floors are the plan constants', () => {
    expect(DEFAULT_ROLE_MIN_CONTEXT.executor).toBe(131072)
    expect(DEFAULT_ROLE_MIN_CONTEXT.planner).toBe(131072)
    expect(DEFAULT_ROLE_MIN_CONTEXT['plan-auditor']).toBe(65536)
    expect(DEFAULT_ROLE_MIN_CONTEXT['execution-auditor']).toBe(65536)
    expect(DEFAULT_ROLE_MIN_CONTEXT['rules-auditor']).toBe(65536)
  })

  it('a KNOWN window below the role floor is excluded and named; the auditor floor is 65536', async () => {
    const models: readonly StubModel[] = [
      { provider: 'alpha', id: 'm-tiny', contextWindow: 32000, efforts: ['high'] },
      { provider: 'alpha', id: 'm-fit', contextWindow: 131072 },
    ]
    const decision = await selectRoute(
      selection({
        role: 'plan-auditor',
        policy: presentPolicy(['alpha', 'm-tiny'], ['alpha', 'm-fit']),
        catalog: catalogOf(models),
        executorPin: { provider: 'gamma', model: 'm-exec' },
      }),
    )
    const route = expectRoute(decision)
    expect(route.route.model).toBe('m-fit')
    expectWhy(decision, /excluded alpha\/m-tiny \(32000\)/)
    const excluded = route.candidatesConsidered.find((candidate) => candidate.model === 'm-tiny')
    expect(excluded?.disposition).toBe('excluded-below-floor')
    expect(excluded?.note).toContain('32000 < floor 65536')
  })

  it('a user-tuned minContext above every known window degrades to inheritance, exclusions named', async () => {
    const decision = await selectRoute(
      selection({
        role: 'executor',
        roleRouting: { mode: 'auto', minContext: 250000 },
        policy: presentPolicy(['alpha', 'm-a'], ['alpha', 'm-b']),
        catalog: catalogOf([
          { provider: 'alpha', id: 'm-a', contextWindow: 131072 },
          { provider: 'alpha', id: 'm-b', contextWindow: 200000 },
        ]),
        executorPin: undefined,
      }),
    )
    expect(decision.kind).toBe('inherit')
    if (decision.kind === 'inherit') expectWhy(decision, /no honest explicit selection exists/)
  })

  it('ties break in ADAPTER-PREFERRED catalog order, not policy order', async () => {
    const models: readonly StubModel[] = [
      { provider: 'alpha', id: 'm-a', contextWindow: 131072, efforts: ['high'] },
      { provider: 'alpha', id: 'm-b', contextWindow: 131072, efforts: ['high'] },
    ]
    const decision = await selectRoute(
      selection({
        role: 'executor',
        policy: presentPolicy(['alpha', 'm-b'], ['alpha', 'm-a']), // deliberately reversed
        catalog: catalogOf(models),
        executorPin: undefined,
      }),
    )
    const route = expectRoute(decision)
    expect(route.route.model).toBe('m-a')
  })

  it('an unlisted authorized route is eligible but tie-breaks after listed routes', async () => {
    const decision = await selectRoute(
      selection({
        role: 'executor',
        policy: presentPolicy(['alpha', 'm-unlisted'], ['alpha', 'm-listed']),
        catalog: catalogOf([{ provider: 'alpha', id: 'm-listed', contextWindow: 131072, efforts: ['high'] }]),
        executorPin: undefined,
      }),
    )
    // Both resolve to identical facts via resolveModelInfo; the LISTED route
    // wins the tie because it holds an adapter-preferred position.
    const route = expectRoute(decision)
    expect(route.route.model).toBe('m-listed')
  })

  it('an unobservable executor pin at/above the floor: axes unknown, order unmodified, unknown-family', async () => {
    const models: readonly StubModel[] = [
      { provider: 'alpha', id: 'm-big', contextWindow: 200000, efforts: ['high'] },
      { provider: 'beta', id: 'm-b', contextWindow: 128000 },
    ]
    const decision = await selectRoute(
      selection({
        policy: presentPolicy(['alpha', 'm-big'], ['beta', 'm-b']),
        catalog: catalogOf(models),
        executorPin: undefined,
      }),
    )
    const route = expectRoute(decision)
    expect(route.route.model).toBe('m-big') // preference order unmodified
    expect(route.route.independence?.outcome).toBe('unknown-family')
    expectWhy(decision, /executor route is not observable/)
  })

  it('planner is routed like any role, without an independence constraint', async () => {
    const decision = await selectRoute(
      selection({
        role: 'planner',
        policy: presentPolicy(['alpha', 'm-a'], ['alpha', 'm-b']),
        catalog: catalogOf([
          { provider: 'alpha', id: 'm-a', contextWindow: 131072, efforts: ['high'] },
          { provider: 'alpha', id: 'm-b', contextWindow: 131072 },
        ]),
        executorPin: { provider: 'alpha', model: 'm-a' },
      }),
    )
    const route = expectRoute(decision)
    expect(route.route.independence).toBeUndefined()
    expect(route.candidatesConsidered.every((candidate) => candidate.independence === undefined)).toBe(true)
  })

  it('locked route whose preflight rejects: blocked with the honest attempt recorded (no fallback from a lock)', async () => {
    const decision = await selectRoute(
      selection({
        roleRouting: { mode: 'locked', provider: 'alpha', model: 'm-a' },
        policy: ABSENT_POLICY,
        catalog: catalogOf([{ provider: 'alpha', id: 'm-a', contextWindow: 131072 }], { rejectPreflightFor: ['m-a'] }),
      }),
    )
    expect(decision.kind).toBe('blocked')
    if (decision.kind === 'blocked') {
      expect(decision.reason).toContain('failed preflight')
      expectWhy(decision, /preflight: resolveCallConfig rejected alpha\/m-a/)
    }
  })

  it('effort is the adapter-declared defaultEffort in auto mode, and preflight sees it', async () => {
    const stubbed = stubLlm([{ provider: 'alpha', id: 'm-a', contextWindow: 131072, efforts: ['high'], defaultEffort: 'high' }, { provider: 'alpha', id: 'm-b', contextWindow: 131072 }])
    const decision = await selectRoute(
      selection({ role: 'executor', catalog: new RouteCatalog(stubbed), executorPin: undefined }),
    )
    const route = expectRoute(decision)
    expect(route.route.model).toBe('m-a')
    expect(route.route.reasoningEffort).toBe('high')
    expect(stubbed.calls.preflight[0]?.reasoningEffort).toBe('high')
  })
})

// ── The packet's structural guards ──

describe('src/routing structural guards (AC1/AC2)', () => {
  const routingDir = fileURLToPath(new URL('../src/routing/', import.meta.url))

  it('imports nothing from dsh packages and never mentions the settings authority', () => {
    const files = readdirSync(routingDir).filter((name) => name.endsWith('.ts'))
    expect(files.length).toBeGreaterThanOrEqual(4)
    for (const name of files) {
      const source = readFileSync(`${routingDir}/${name}`, 'utf8')
      expect(source, `${name} must not import dsh packages`).not.toMatch(/from '@deepseek-ai\//)
      expect(source, `${name} must not consult settings as authority`).not.toMatch(/SubagentModelSelectionConfig|dsh-settings|model-selection-settings/)
    }
  })
})
