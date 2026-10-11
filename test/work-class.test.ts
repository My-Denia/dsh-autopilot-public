/**
 * Work classes (DESIGN §1.2; §9 items 13/14) — the owner table as data, and
 * the selector behavior it drives.
 *
 * Assertions are on exact decision KINDS and on the why/reason text that
 * NAMES the rule that fired: the record must be reconstructable without the
 * code. The catalog is stubbed at the structural boundary, as in
 * `test/routing.test.ts`.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RouteCatalog } from '../src/routing/catalog.js'
import type { LlmCallConfig, LlmRuntimeSubset } from '../src/routing/catalog.js'
import { selectRoute } from '../src/routing/select.js'
import type { RoleRouting, RouteSelectionInput, SelectionDecision } from '../src/routing/select.js'
import type { SessionPolicyState } from '../src/routing/authorize.js'
import {
  DEFAULT_ROLE_WORK_CLASS,
  DEFAULT_WORK_CLASSES,
  WORK_CLASS_AXES,
  WORK_CLASS_NAMES,
  resolveWorkClassSelection,
} from '../src/routing/work-class.js'
import type { WorkClassName, WorkClassSelection, WorkClassTier } from '../src/routing/work-class.js'

// ── Stub at the structural boundary (same shape as routing.test.ts) ──

interface StubModel {
  readonly provider: string
  readonly id: string
  readonly contextWindow?: number
  readonly efforts?: readonly string[]
  readonly defaultEffort?: string
}

function catalogOf(models: readonly StubModel[]): RouteCatalog {
  const providerIds = [...new Set(models.map((model) => model.provider))]
  const stub: LlmRuntimeSubset = {
    listProviders: () => providerIds.map((id) => ({ id, name: id })),
    listModels: async (provider: string) =>
      models.filter((model) => model.provider === provider).map((model) => ({ provider, id: model.id, name: model.id })),
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
    resolveCallConfig: async (config: LlmCallConfig) => ({ ...config }),
  }
  return new RouteCatalog(stub)
}

// ── Input builders ──

function presentPolicy(...routes: readonly [string, string][]): SessionPolicyState {
  return { kind: 'present', routes: routes.map(([provider, model]) => ({ provider, model })) }
}

const AUTO: RoleRouting = { mode: 'auto' }

const EMPTY_TIERS: Readonly<Record<WorkClassTier, readonly string[]>> = { economy: [], standard: [], reserve: [] }

/** Resolve a class against the given ladder exactly as the engine producer would. */
function selection(
  name: WorkClassName,
  tiers: Readonly<Record<WorkClassTier, readonly string[]>>,
  auditTier?: WorkClassTier | 'none',
  ownerOverridden?: boolean,
): WorkClassSelection {
  return resolveWorkClassSelection(DEFAULT_WORK_CLASSES, tiers, name, auditTier, ownerOverridden)
}

function input(over: Partial<RouteSelectionInput> = {}): RouteSelectionInput {
  return {
    role: 'executor',
    risk: 'low',
    preference: 'balanced',
    roleRouting: AUTO,
    policy: presentPolicy(['alpha', 'm-a'], ['alpha', 'm-b']),
    catalog: catalogOf([
      { provider: 'alpha', id: 'm-a', contextWindow: 131072 },
      { provider: 'alpha', id: 'm-b', contextWindow: 131072 },
    ]),
    ...over,
  }
}

function whyOf(decision: SelectionDecision): readonly string[] {
  if (decision.kind === 'route' || decision.kind === 'inherit' || decision.kind === 'blocked') return decision.why
  throw new Error(`decision ${decision.kind} carries no why list`)
}

function expectWhy(decision: SelectionDecision, ...patterns: readonly RegExp[]): void {
  const why = whyOf(decision)
  expect(why.length > 0, `decision ${decision.kind} must carry a non-empty why`).toBe(true)
  for (const pattern of patterns) {
    expect(why.some((entry) => pattern.test(entry)), `why must name ${pattern}, got ${JSON.stringify(why)}`).toBe(true)
  }
}

function expectRoute(decision: SelectionDecision): Extract<SelectionDecision, { kind: 'route' }> {
  expect(decision.kind).toBe('route')
  return decision as Extract<SelectionDecision, { kind: 'route' }>
}

function expectBlocked(decision: SelectionDecision): Extract<SelectionDecision, { kind: 'blocked' }> {
  expect(decision.kind).toBe('blocked')
  return decision as Extract<SelectionDecision, { kind: 'blocked' }>
}

// ── The owner table, as data ──

describe('work classes — the owner table (DESIGN §1.2)', () => {
  it('declares exactly the five fixed classes, in table order', () => {
    expect(WORK_CLASS_NAMES).toEqual(['mechanical', 'simple', 'hard', 'audit', 'extreme'])
    expect(WORK_CLASS_AXES).toEqual(['speed', 'speed-cost', 'economy-first', 'ceiling-independence', 'ceiling'])
  })

  it('pins the owner-table defaults verbatim (tier mapping + dominant axis per class)', () => {
    expect(DEFAULT_WORK_CLASSES).toEqual({
      mechanical: { name: 'mechanical', tiers: [], axis: 'speed' },
      simple: { name: 'simple', tiers: ['economy'], axis: 'speed-cost' },
      hard: { name: 'hard', tiers: ['economy'], axis: 'economy-first' },
      audit: { name: 'audit', tiers: ['standard'], axis: 'ceiling-independence' },
      extreme: { name: 'extreme', tiers: ['reserve'], axis: 'ceiling' },
    })
  })

  /**
   * The doc↔code census for this table (rules-audit finding, 2026-10-10): the
   * shipped `model-routing.md` advertised `hard` → `economy` + `standard` while
   * the seed carried `economy` + `standard` + `reserve` — a behavioural
   * divergence nobody could see, because only the refusal codes had a census.
   * This pins the CLASS → TIER column of the routed reference against
   * `DEFAULT_WORK_CLASSES` in both directions: a seed change without the table
   * (or a table edit without the seed) fails here.
   */
  it('keeps the routed class→tier table (model-routing.md) equal to the shipped seed', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const doc = readFileSync(join(root, 'skill', 'dsh-autopilot', 'references', 'model-routing.md'), 'utf8')
    const table = [...doc.matchAll(/^\|\s*`(mechanical|simple|hard|audit|extreme)`\s*\|([^|]*)\|([^|]*)\|/gm)]
    expect(table.length).toBe(5)
    const tiersOf = (column: string): readonly WorkClassTier[] => {
      if (/\bnone\b/.test(column)) return []
      const found = column.match(/`(economy|standard|reserve)`/g) ?? []
      return found.map(token => token.replace(/`/g, '') as WorkClassTier)
    }
    const documented = Object.fromEntries(
      table.map(row => [row[1] ?? '', tiersOf(row[3] ?? '')]),
    )
    const shipped = Object.fromEntries(
      WORK_CLASS_NAMES.map(name => [name, [...DEFAULT_WORK_CLASSES[name].tiers]]),
    )
    expect(documented).toEqual(shipped)
  })

  it('pins the role defaults: implementation rides simple, auditors ride audit', () => {
    expect(DEFAULT_ROLE_WORK_CLASS).toEqual({
      executor: 'simple',
      planner: 'simple',
      'plan-auditor': 'audit',
      'execution-auditor': 'audit',
      'rules-auditor': 'audit',
    })
  })
})

// ── resolveWorkClassSelection ──

describe('resolveWorkClassSelection', () => {
  it('unions the mapped tiers trim-exact, deduped, in tier order (a class widened by an owner override)', () => {
    // The DEFAULT `hard` pool is economy-only (DESIGN's first-try rule; the
    // escalation request channel is a non-goal), so the union across tiers is
    // exercised through the OWNER's override — the shape the machinery must
    // handle when `routing.workClasses.hard.tiers` names several tiers.
    const widened = {
      ...DEFAULT_WORK_CLASSES,
      hard: { ...DEFAULT_WORK_CLASSES.hard, tiers: ['economy', 'standard', 'reserve'] as const },
    }
    const resolved = resolveWorkClassSelection(widened, {
      economy: ['alpha/m-a', ' beta/m-b ', 'alpha/m-a'],
      standard: ['beta/m-b', 'gamma/m-c'],
      reserve: [],
    }, 'hard')
    expect(resolved.tiers).toEqual(['economy', 'standard', 'reserve'])
    expect(resolved.members).toEqual(['alpha/m-a', 'beta/m-b', 'gamma/m-c'])
    expect(resolved.ladderConfigured).toBe(true)
    expect(resolved.engaged).toBe(true)
    expect(resolved.tierOverride).toBeUndefined()
    expect(resolved.axis).toBe('economy-first')
  })

  it('records an EMPTY ladder as unconfigured — blank entries count as absent; the machinery is DISENGAGED unless the owner overrode', () => {
    const resolved = selection('simple', { economy: ['  '], standard: [], reserve: [] })
    expect(resolved.ladderConfigured).toBe(false)
    expect(resolved.members).toEqual([])
    expect(resolved.engaged).toBe(false)
    // An owner override engages the machinery even on an empty ladder.
    expect(selection('simple', EMPTY_TIERS, undefined, true).engaged).toBe(true)
  })

  it('applies routing.ladder.auditTier to the AUDIT class only, and says so', () => {
    const audit = selection('audit', { economy: ['alpha/m-a'], standard: ['alpha/m-b'], reserve: ['alpha/m-c'] }, 'reserve')
    expect(audit.tiers).toEqual(['reserve'])
    expect(audit.members).toEqual(['alpha/m-c'])
    expect(audit.tierOverride).toBe('reserve')
    // A non-audit class never takes the audit-tier override.
    const simple = selection('simple', { economy: ['alpha/m-a'], standard: [], reserve: ['alpha/m-c'] }, 'reserve')
    expect(simple.tiers).toEqual(['economy'])
    expect(simple.tierOverride).toBeUndefined()
    // 'none' and undefined leave the class mapping alone.
    expect(selection('audit', EMPTY_TIERS, 'none').tierOverride).toBeUndefined()
    expect(selection('audit', EMPTY_TIERS).tierOverride).toBeUndefined()
  })
})

// ── Selector: dispatch membership restriction ──

describe('selectRoute — work-class membership restriction', () => {
  it('keeps only mapped-tier members and NAMES the restriction in why', async () => {
    const workClass = selection('simple', { economy: ['alpha/m-a', 'alpha/m-b'], standard: [], reserve: [] })
    const decision = await selectRoute(input({
      policy: presentPolicy(['alpha', 'm-a'], ['alpha', 'm-b'], ['alpha', 'm-c']),
      catalog: catalogOf([
        { provider: 'alpha', id: 'm-a', contextWindow: 131072 },
        { provider: 'alpha', id: 'm-b', contextWindow: 131072 },
        { provider: 'alpha', id: 'm-c', contextWindow: 131072 },
      ]),
      workClass,
    }))
    const route = expectRoute(decision)
    expect(['alpha/m-a', 'alpha/m-b']).toContain(`${route.route.provider}/${route.route.model}`)
    expectWhy(decision, /work class: simple restricts dispatch membership to tier\(s\) economy/, /1 authorized route\(s\) outside the mapping/)
  })

  it('the shipped-default shape (empty ladder, no override) is RECORDED, NOT applied — 0.2.0 parity verbatim', async () => {
    const workClass = selection('simple', EMPTY_TIERS)
    const decision = await selectRoute(input({ workClass }))
    expectRoute(decision)
    expectWhy(decision, /work class: simple \(axis speed-cost\) recorded but NOT applied/)
    // No restriction ran and no class ranking line exists: the preference
    // path answers exactly as 0.2.0 did.
    const why = whyOf(decision)
    expect(why.some((entry) => entry.includes('restricts dispatch membership'))).toBe(false)
    expect(why.some((entry) => entry.includes('dominant axis'))).toBe(false)
  })

  it('an EMPTY ladder under an ENGAGED class restricts NOTHING, and why says so', async () => {
    const workClass = selection('simple', EMPTY_TIERS, undefined, true)
    const decision = await selectRoute(input({ workClass }))
    expectRoute(decision)
    expectWhy(decision, /the ladder declares no members anywhere — an empty ladder restricts nothing/)
  })

  it('a class with NO tier mapping (mechanical) restricts nothing here; entry is its own thresholds', async () => {
    const workClass = selection('mechanical', EMPTY_TIERS, undefined, true)
    const decision = await selectRoute(input({ workClass }))
    expectRoute(decision)
    expectWhy(decision, /entry is gated by the class's own thresholds and dominant axis \(speed\)/)
  })

  it('ZERO reachable on a configured ladder with EMPTY mapped tiers is BLOCKED with AP_ROUTE_NO_REACHABLE_WORK_CLASS', async () => {
    // The ladder is configured (standard holds a member) but the class maps
    // to economy, which declares no members.
    const workClass = selection('simple', { economy: [], standard: ['alpha/m-z'], reserve: [] })
    const decision = await selectRoute(input({ workClass }))
    const blocked = expectBlocked(decision)
    expect(blocked.reason).toContain('AP_ROUTE_NO_REACHABLE_WORK_CLASS')
    expect(blocked.reason).toContain('work class "simple" maps to ladder tier(s) economy')
    expect(blocked.reason).toContain('those tiers declare no members')
    expect(blocked.reason).toContain('routing.workClasses.simple.tiers')
    expectWhy(decision, /zero reachable routes after applying the tier mapping/)
  })

  it('members that exist but are NOT in the authorized live set are BLOCKED, with the counts named', async () => {
    const workClass = selection('simple', { economy: ['beta/m-x'], standard: [], reserve: [] })
    const decision = await selectRoute(input({ workClass }))
    const blocked = expectBlocked(decision)
    expect(blocked.reason).toContain('AP_ROUTE_NO_REACHABLE_WORK_CLASS')
    expect(blocked.reason).toContain('none of the 2 authorized live route(s) is a member of them')
  })

  it('the auditTier override is NAMED in the membership why line', async () => {
    const workClass = selection('audit', { economy: [], standard: [], reserve: ['alpha/m-a', 'alpha/m-b'] }, 'reserve')
    const decision = await selectRoute(input({ role: 'execution-auditor', workClass }))
    expectRoute(decision)
    expectWhy(decision, /owner auditTier override: reserve/)
  })

  // ── M11: single-member tier collapse must SELECT, not inherit ──
  // Found by M10 probe c (session-4ad4975f): the eligibleRoutes.length === 1
  // short-circuit fired AFTER the tier filter, so a class mapping that
  // collapses eligibility to exactly one route inherited the deployment
  // default — a route OUTSIDE the class mapping — instead of selecting the
  // surviving member. The gate (tierMembershipApplied) keeps inheritance for
  // the unrestricted 0.2.0-parity arm only.
  it('M11 (a): a tier mapping that collapses eligibility to ONE member SELECTS it explicitly — never inheritance', async () => {
    const workClass = selection('audit', { economy: [], standard: ['alpha/m-b'], reserve: [] })
    const decision = await selectRoute(input({
      role: 'plan-auditor',
      // Two authorized live routes; only m-b is a standard member, so the
      // membership filter narrows eligibility to exactly one route.
      policy: presentPolicy(['alpha', 'm-a'], ['alpha', 'm-b']),
      catalog: catalogOf([
        { provider: 'alpha', id: 'm-a', contextWindow: 131072 },
        { provider: 'alpha', id: 'm-b', contextWindow: 131072 },
      ]),
      workClass,
    }))
    const route = expectRoute(decision)
    expect(`${route.route.provider}/${route.route.model}`).toBe('alpha/m-b')
    expect(route.authorizationSource).not.toBe('inheritance')
    expectWhy(
      decision,
      /work class: audit restricts dispatch membership to tier\(s\) standard/,
      /1 authorized route\(s\) outside the mapping are not members of this dispatch/,
    )
  })

  it('M11 (b): parity arm — a single authorized route with NO tier restriction still INHERITS (0.2.0 unchanged)', async () => {
    // Same two-route catalog, but the policy authorizes exactly one route and
    // the class maps nothing restrictive: the unrestricted single-route arm is
    // the operator's own identical choice, and inheritance stays the honest
    // record exactly as 0.2.0 shipped it.
    const engagedUnmapped = selection('audit', EMPTY_TIERS, undefined, true)
    const decision = await selectRoute(input({
      role: 'plan-auditor',
      policy: presentPolicy(['alpha', 'm-b']),
      catalog: catalogOf([
        { provider: 'alpha', id: 'm-a', contextWindow: 131072 },
        { provider: 'alpha', id: 'm-b', contextWindow: 131072 },
      ]),
      workClass: engagedUnmapped,
    }))
    expect(decision.kind).toBe('inherit')
    // The single-route short-circuit returns its own honest why: nothing was
    // restricted, so inheritance claims no choice and no class line exists.
    expectWhy(decision, /the authorized set holds a single route \(alpha\/m-b\)/)
  })
})

// ── Selector: class dominant-axis ranking ──

describe('selectRoute — class dominant-axis ranking', () => {
  it('mechanical ranks SPEED first even under preference balanced (faster beats more efforts)', async () => {
    const workClass = selection('mechanical', EMPTY_TIERS, undefined, true)
    const decision = await selectRoute(input({
      catalog: catalogOf([
        { provider: 'alpha', id: 'm-a', contextWindow: 131072, efforts: ['low'] },
        { provider: 'alpha', id: 'm-b', contextWindow: 262144, efforts: ['low', 'high'], defaultEffort: 'high' },
      ]),
      speedOrder: ['alpha/m-a', 'alpha/m-b'],
      requirements: { effortIds: ['low'] },
      workClass,
    }))
    const route = expectRoute(decision)
    expect(`${route.route.provider}/${route.route.model}`).toBe('alpha/m-a')
    expectWhy(decision, /work class: mechanical ranks on its dominant axis "speed"/, /cost is NOT an axis for this class/)
  })

  it('simple (speed-cost): speed first, cost breaks ties — and an ABSENT speedOrder leaves cost to decide', async () => {
    const workClass = selection('simple', { economy: ['alpha/m-a', 'alpha/m-b'], standard: [], reserve: [] })
    const catalog = catalogOf([
      { provider: 'alpha', id: 'm-a', contextWindow: 131072 },
      { provider: 'alpha', id: 'm-b', contextWindow: 131072 },
    ])
    // m-b is faster and pricier; m-a slower and cheaper. Speed first wins.
    const fastFirst = await selectRoute(input({
      catalog,
      speedOrder: ['alpha/m-b', 'alpha/m-a'],
      costOverrides: { 'alpha/m-a': { inputPerM: 1, outputPerM: 1 }, 'alpha/m-b': { inputPerM: 9, outputPerM: 9 } },
      workClass,
    }))
    expect(`${expectRoute(fastFirst).route.provider}/${expectRoute(fastFirst).route.model}`).toBe('alpha/m-b')
    expectWhy(fastFirst, /ranks on its dominant axis "speed-cost"/)
    // No declared speed order: every route is unknown speed, so cost decides.
    const costDecides = await selectRoute(input({
      catalog,
      costOverrides: { 'alpha/m-a': { inputPerM: 1, outputPerM: 1 }, 'alpha/m-b': { inputPerM: 9, outputPerM: 9 } },
      workClass,
    }))
    expect(`${expectRoute(costDecides).route.provider}/${expectRoute(costDecides).route.model}`).toBe('alpha/m-a')
    expectWhy(costDecides, /speedOrder is ABSENT, so every route is unknown speed and cost decides/)
  })

  it('hard (economy-first) ranks effective COST first even under preference quality (cheapest mapped tier tried first)', async () => {
    const workClass = selection('hard', { economy: ['alpha/m-a', 'alpha/m-b'], standard: [], reserve: [] })
    const decision = await selectRoute(input({
      preference: 'quality',
      catalog: catalogOf([
        { provider: 'alpha', id: 'm-a', contextWindow: 131072 },
        { provider: 'alpha', id: 'm-b', contextWindow: 262144, efforts: ['high'], defaultEffort: 'high' },
      ]),
      costOverrides: { 'alpha/m-a': { inputPerM: 1, outputPerM: 1 }, 'alpha/m-b': { inputPerM: 9, outputPerM: 9 } },
      workClass,
    }))
    const route = expectRoute(decision)
    expect(`${route.route.provider}/${route.route.model}`).toBe('alpha/m-a')
    expectWhy(decision, /work class: hard ranks on its dominant axis "economy-first"/, /the cheapest mapped tier is tried first/)
  })

  it('audit (ceiling-independence) adds NO ranking of its own — the preference line stands', async () => {
    const workClass = selection('audit', { economy: [], standard: ['alpha/m-a', 'alpha/m-b'], reserve: [] })
    const decision = await selectRoute(input({ role: 'execution-auditor', workClass }))
    expectRoute(decision)
    const why = whyOf(decision)
    expect(why.some((entry) => entry.startsWith('preference: balanced'))).toBe(true)
    expect(why.some((entry) => entry.includes('dominant axis'))).toBe(false)
  })
})

// ── Selector: the class requirement gate (mechanical's low-effort license) ──

describe('selectRoute — class requirement gates', () => {
  // m-b carries the LARGER window so balanced (efforts, then window
  // descending) ranks it first — that is what makes the control meaningful.
  const catalog = () => catalogOf([
    { provider: 'alpha', id: 'm-a', contextWindow: 131072, efforts: ['low'] },
    { provider: 'alpha', id: 'm-b', contextWindow: 262144, efforts: ['high'], defaultEffort: 'high' },
  ])

  it('a class ASSIGNED enforces its thresholds under ANY preference: the non-low route is excluded', async () => {
    const workClass = selection('mechanical', EMPTY_TIERS, undefined, true)
    const decision = await selectRoute(input({
      catalog: catalog(),
      requirements: { effortIds: ['low'] },
      workClass,
    }))
    const route = expectRoute(decision)
    expect(`${route.route.provider}/${route.route.model}`).toBe('alpha/m-a')
    expectWhy(decision, /m-b does not publish required reasoning effort id\(s\) low/)
  })

  it('control: the same requirements are INERT under preference balanced with no class assigned', async () => {
    const decision = await selectRoute(input({
      catalog: catalog(),
      requirements: { effortIds: ['low'] },
    }))
    // Balanced prefers efforts: m-b (with high) ranks first and wins.
    const route = expectRoute(decision)
    expect(`${route.route.provider}/${route.route.model}`).toBe('alpha/m-b')
  })

  it('control: a DISENGAGED class (empty ladder, no override) leaves the thresholds inert too', async () => {
    const decision = await selectRoute(input({
      catalog: catalog(),
      requirements: { effortIds: ['low'] },
      workClass: selection('mechanical', EMPTY_TIERS),
    }))
    const route = expectRoute(decision)
    expect(`${route.route.provider}/${route.route.model}`).toBe('alpha/m-b')
    expectWhy(decision, /recorded but NOT applied/)
  })

  it('when every member fails the license, the honest record is INHERITANCE (existing requirements semantics), not blocked', async () => {
    const workClass = selection('mechanical', EMPTY_TIERS, undefined, true)
    const decision = await selectRoute(input({
      catalog: catalogOf([
        { provider: 'alpha', id: 'm-a', contextWindow: 131072, efforts: ['high'], defaultEffort: 'high' },
        { provider: 'alpha', id: 'm-b', contextWindow: 131072, efforts: ['medium'] },
      ]),
      requirements: { effortIds: ['low'] },
      workClass,
    }))
    expect(decision.kind).toBe('inherit')
    expectWhy(decision, /every eligible route fails a declared sufficiency threshold/)
  })
})