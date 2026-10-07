/**
 * The declared `Config` schema, exercised through the REAL loader path.
 *
 * WHY this file exists at all: every other test in this suite builds config as
 * a plain object and hands it straight to `resolveConfig`. cordis does not —
 * it runs `runtime.Config['~standard'].validate(config)` and passes the
 * DEFAULTED result to `apply()` (`vendor/cordis/src/fiber.ts`). Those are two
 * different inputs, and a defect that lives only in the difference is a defect
 * the whole suite is structurally unable to observe. So the assertions below
 * drive `resolveConfig(Config['~standard'].validate(x).value)` — the shape a
 * deployment actually gets — and never a hand-built object.
 */

import { describe, expect, it } from 'vitest'
import { Config, DEFAULT_EXECUTOR_TOOLS } from '../src/config.js'
import { SHELL_TOOLS, isEgressCommand } from '../src/gate/decide.js'
import { resolveConfig } from '../src/index.js'
import type { ConfigInput, ResolvedRouting } from '../src/index.js'
import { DEFAULT_ROLE_MIN_CONTEXT } from '../src/routing/select.js'

/** Run one raw profile fragment through the loader exactly as cordis would. */
function loaded(raw: unknown): { value?: ConfigInput; issues?: readonly { message: string }[] } {
  return Config['~standard'].validate(raw) as never
}

describe('Config — the loader path', () => {
  it('hands the engine the real executor tool allow-list, not an empty one', () => {
    const result = loaded({ auditProvider: 'spawn' })
    expect(result.issues).toBeUndefined()
    const viaLoader = resolveConfig(result.value).executor.toolAllowList

    // Asserted BY VALUE against the shared constant rather than a count, so
    // adding a tool to the default surface cannot silently move this anchor.
    expect(viaLoader).toEqual([...DEFAULT_EXECUTOR_TOOLS])
    // The failing shape this test exists to catch: a schema default of []
    // survives `?? DEFAULT_EXECUTOR_TOOLS` and leaves the executor child with
    // nothing but its packet tool.
    expect(viaLoader.length).toBeGreaterThan(0)
    expect(viaLoader).toContain('read')
    expect(viaLoader).toContain('write')
    expect(viaLoader).toContain('bash')
  })

  it('agrees with the plain-object path the rest of the suite uses, FIELD FOR FIELD', () => {
    // This used to compare `.executor.toolAllowList` alone and was therefore
    // structurally unable to observe the divergence it exists to catch:
    // schemastery's `Schema.object({...})` defaults to `{}` rather than
    // `undefined`, so the loader produced `auditors.plan = { agentOptions: {} }`
    // and `executor.agentOptions = {}` where the plain path produced
    // `undefined` — and the engine's `...(agentOptions === undefined ? {} :
    // { agentOptions })` then sent `agentOptions: {}` to `subagents.start` on
    // every REAL deployment while every test in this suite omitted the key.
    // Deep equality over the whole ResolvedConfig is what makes the class of
    // defect unrepresentable rather than this one instance of it.
    expect(resolveConfig(loaded({}).value)).toEqual(resolveConfig({}))
    expect(resolveConfig(loaded({}).value)?.skillInstall).toBe('auto')
    // An ABSENT config (a deployment that writes no dsh-autopilot block at
    // all) validates to the same defaults — cordis hands `validate` the raw
    // undefined, and both halves of this schema must survive that.
    expect(resolveConfig(loaded(undefined).value)).toEqual(resolveConfig(undefined))
  })

  it('an empty nested object is ABSENT on both paths, so nothing reaches subagents.start', () => {
    const viaLoader = resolveConfig(loaded({}).value)
    expect(viaLoader.executor.agentOptions).toBeUndefined()
    expect('agentOptions' in viaLoader.executor).toBe(false)
    expect(viaLoader.auditors).toEqual({})
    // DETECTOR: a route that carries actual routing survives, on both paths.
    const routed = resolveConfig(loaded({ auditors: { plan: { agentOptions: { provider: 'p', model: 'm' } } } }).value)
    expect(routed.auditors.plan?.agentOptions).toEqual({ provider: 'p', model: 'm' })
    expect(routed.auditors.execution).toBeUndefined()
  })

  it('still honours an explicitly empty allow-list (the default is a default, not a floor)', () => {
    const result = loaded({ executor: { toolAllowList: [] } })
    expect(result.issues).toBeUndefined()
    expect(resolveConfig(result.value).executor.toolAllowList).toEqual([])
  })

  it('accepts a fully specified profile (positive control for every negative below)', () => {
    const result = loaded({
      auditProvider: 'spawn',
      executorProvider: 'spawn',
      auditors: { plan: { agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } },
      executor: { persona: 'lead', toolAllowList: ['read', 'write'] },
      crossFamily: { enabled: true, minRisk: 'high', pool: [{ provider: 'openai', model: 'gpt-6.1-sol' }] },
      routing: {
        mode: 'off',
        preference: 'quality',
        roles: {
          executor: { mode: 'locked', lock: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }, minContext: 200000 },
          planner: { mode: 'auto', minContext: 262144 },
          planAuditor: { mode: 'locked', lock: { provider: 'openai', model: 'gpt-6.1-sol' } },
          executionAuditor: { mode: 'inherit' },
          rulesAuditor: { mode: 'auto', minContext: 65536 },
        },
      },
      gate: { egressDeny: true, restoreMode: 'workspace-write' },
      storeKind: 'file',
      storeRoot: '/tmp/runs',
      skillInstall: 'off',
    })
    expect(result.value?.skillInstall).toBe('off')
    expect(result.issues).toBeUndefined()
    expect(result.value?.storeKind).toBe('file')
    // The fully-specified ROUTING section is part of the positive control:
    // every key the shape declares (and therefore every key CONFIG_KEY_SPEC
    // must mirror) is written here, so a drift in either half fails HERE
    // first — as an unknown-key refusal, not as a silently-dropped field.
    // (The raw loader value holds volatile REFERENCES for these leaves —
    // asserted as such below — so the value assertions go through
    // resolveConfig, which unwraps them.)
    expect(result.value?.routing).toBeDefined()
    const resolvedRouting = resolveConfig(result.value).routing
    expect(resolvedRouting.mode).toBe('off')
    expect(resolvedRouting.preference).toBe('quality')
    expect(resolvedRouting.roles['execution-auditor']).toEqual({ mode: 'inherit' })
  })

  it('REFUSES an unknown top-level key and names it', () => {
    const result = loaded({ storeKindd: 'domain' })
    // The exact failure the schema was introduced to eliminate: a typo that
    // silently defaults storeKind back to 'auto'.
    expect(result.issues?.length ?? 0).toBeGreaterThanOrEqual(1)
    expect(result.issues?.some(issue => issue.message.includes('storeKindd'))).toBe(true)
    expect(result.value).toBeUndefined()
  })

  it('REFUSES an unknown NESTED key and names its path', () => {
    const result = loaded({ gate: { egresDeny: false } })
    expect(result.issues?.some(issue => issue.message.includes('gate.egresDeny'))).toBe(true)
  })

  it('still rejects a value outside the storeKind enum', () => {
    const bogus = 'sqlite'
    // In-place assertion that the fixture is still outside the accepted set.
    expect(['auto', 'file', 'domain']).not.toContain(bogus)
    const result = loaded({ storeKind: bogus })
    expect(result.issues?.some(issue => issue.message.includes('storeKind'))).toBe(true)
  })

  it('still rejects a wrongly typed gate flag', () => {
    const result = loaded({ gate: { toolDeny: 'yes' } })
    expect(result.issues?.some(issue => issue.message.includes('toolDeny'))).toBe(true)
  })

  // ── The routing section (packet E2; plan v3 "Config") ──

  it('marks the routing leaves VOLATILE: they survive validation with defaults, as references read via get()', () => {
    // The plan's "backend + patch-writable" marking is schemastery's
    // `.volatile()`, whose resolved output for each leaf is a stable
    // reference (cosmokit `Volatile`), not a plain value. Asserting the
    // reference protocol here is asserting the marking itself — a leaf that
    // lost its `.volatile()` would come back as the bare string and fail the
    // `typeof .get` probe below.
    const raw = loaded({}).value as unknown as {
      routing: {
        mode: { get(): unknown }
        preference: { get(): unknown }
        roles: Record<string, { mode: { get(): unknown }; lock: { get(): unknown }; minContext: { get(): unknown } }>
      }
    }
    expect(raw?.routing).toBeDefined()
    expect(typeof raw.routing.mode.get).toBe('function')
    expect(raw.routing.mode.get()).toBe('auto')
    expect(raw.routing.preference.get()).toBe('balanced')
    expect(raw.routing.roles.executor?.mode.get()).toBe('auto')
    expect(raw.routing.roles.planner?.mode.get()).toBe('inherit')
    expect(raw.routing.roles.planAuditor?.mode.get()).toBe('auto')
    // Absent leaves survive as references too — reading one yields undefined,
    // which is what resolveConfig's structural unwrap observes.
    expect(raw.routing.roles.executor?.lock.get()).toBeUndefined()
    expect(raw.routing.roles.executor?.minContext.get()).toBeUndefined()
  })

  it('REFUSES the routing.modde typo and names it (fail loudly, not silently-default)', () => {
    const result = loaded({ routing: { modde: 'off' } })
    expect(result.issues?.some(issue => issue.message.includes('routing.modde'))).toBe(true)
    expect(result.value).toBeUndefined()
  })

  it('REFUSES unknown keys inside routing and inside routing.roles.<role>, naming the path', () => {
    const section = loaded({ routing: { preferance: 'quality' } })
    expect(section.issues?.some(issue => issue.message.includes('routing.preferance'))).toBe(true)
    const roleField = loaded({ routing: { roles: { executor: { loock: { provider: 'p', model: 'm' } } } } })
    expect(roleField.issues?.some(issue => issue.message.includes('routing.roles.executor.loock'))).toBe(true)
    // A role the section does not declare (the hyphenated core name is NOT a
    // config key) is an unknown key, not a silently-ignored one.
    const roleKey = loaded({ routing: { roles: { plan: { mode: 'auto' } } } })
    expect(roleKey.issues?.some(issue => issue.message.includes('routing.roles.plan'))).toBe(true)
    const lockField = loaded({ routing: { roles: { executor: { lock: { modell: 'm' } } } } })
    expect(lockField.issues?.some(issue => issue.message.includes('routing.roles.executor.lock.modell'))).toBe(true)
  })

  it('REFUSES a half lock: provider and model are required TOGETHER (schema refinement)', () => {
    const missingModel = loaded({ routing: { roles: { executor: { lock: { provider: 'p' } } } } })
    expect(missingModel.issues?.some(issue => issue.message.includes('lock requires provider and model together'))).toBe(true)
    expect(missingModel.issues?.some(issue => issue.message.includes('model'))).toBe(true)
    // Blank strings count as absent (trim-exact), so a blank model is the same refusal.
    const blankModel = loaded({ routing: { roles: { executor: { lock: { provider: 'p', model: '  ' } } } } })
    expect(blankModel.issues?.some(issue => issue.message.includes('lock requires provider and model together'))).toBe(true)
    // A lone reasoningEffort names tuning for a route that was never named — the
    // same silently-inert config class the guard exists for.
    const effortOnly = loaded({ routing: { roles: { executor: { lock: { reasoningEffort: 'high' } } } } })
    expect(effortOnly.issues?.some(issue => issue.message.includes('lock requires provider and model together'))).toBe(true)
  })

  it('still rejects values outside the routing enums', () => {
    const bogusPreference = 'fast'
    expect(['balanced', 'economy', 'quality']).not.toContain(bogusPreference)
    const preference = loaded({ routing: { preference: bogusPreference } })
    expect(preference.issues?.some(issue => issue.message.includes('routing.preference'))).toBe(true)
    const mode = loaded({ routing: { mode: 'on' } })
    expect(mode.issues?.some(issue => issue.message.includes('routing.mode'))).toBe(true)
    const roleMode = loaded({ routing: { roles: { executor: { mode: 'pinned' } } } })
    expect(roleMode.issues?.some(issue => issue.message.includes('mode'))).toBe(true)
    // minContext is a natural number (a token floor); negatives are refused.
    const floor = loaded({ routing: { roles: { executor: { minContext: -1 } } } })
    expect(floor.issues?.some(issue => issue.message.includes('minContext'))).toBe(true)
  })
})

describe('resolveConfig — the routing section', () => {
  it('resolves the fully-specified profile to EXACTLY this routing (the shape packet E3 consumes)', () => {
    // Written once, asserted once, consumed verbatim by the engine packets:
    // role keys in the routing-core vocabulary ('plan-auditor', not
    // 'planAuditor'), locks inlined as the RoleRouting locked variant, and
    // minContext resolved to a concrete floor for auto roles only.
    const expected: ResolvedRouting = {
      mode: 'off',
      preference: 'quality',
      roles: {
        executor: { mode: 'locked', provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
        planner: { mode: 'auto', minContext: 262144 },
        'plan-auditor': { mode: 'locked', provider: 'openai', model: 'gpt-6.1-sol' },
        'execution-auditor': { mode: 'inherit' },
        'rules-auditor': { mode: 'auto', minContext: 65536 },
      },
    }
    const viaLoader = resolveConfig(loaded({
      routing: {
        mode: 'off',
        preference: 'quality',
        roles: {
          executor: { mode: 'locked', lock: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }, minContext: 200000 },
          planner: { mode: 'auto', minContext: 262144 },
          planAuditor: { mode: 'locked', lock: { provider: 'openai', model: 'gpt-6.1-sol' } },
          executionAuditor: { mode: 'inherit' },
          rulesAuditor: { mode: 'auto', minContext: 65536 },
        },
      },
    }).value).routing
    expect(viaLoader).toEqual(expected)
    // The plain path resolves the same input to the same table — the
    // deep-equality doctrine, extended to the new section.
    expect(resolveConfig({
      routing: {
        mode: 'off',
        preference: 'quality',
        roles: {
          executor: { mode: 'locked', lock: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' } },
          planner: { mode: 'auto', minContext: 262144 },
          planAuditor: { mode: 'locked', lock: { provider: 'openai', model: 'gpt-6.1-sol' } },
          executionAuditor: { mode: 'inherit' },
          rulesAuditor: { mode: 'auto', minContext: 65536 },
        },
      },
    }).routing).toEqual(expected)
    // A minContext written alongside a LOCKED role is dropped, not honored:
    // the floor governs auto selections only (documented in resolveRouting).
    // The loader input above carried executor.minContext 200000; the resolved
    // executor carries the lock and no floor.
    expect('minContext' in viaLoader.roles.executor).toBe(false)
  })

  it('defaults: mode auto, preference balanced, planner INHERITS, floors are the plan constants', () => {
    const viaPlain = resolveConfig({}).routing
    const viaLoader = resolveConfig(loaded({}).value).routing
    expect(viaLoader).toEqual(viaPlain)
    expect(viaPlain).toEqual({
      mode: 'auto',
      preference: 'balanced',
      roles: {
        executor: { mode: 'auto', minContext: 131072 },
        planner: { mode: 'inherit' },
        'plan-auditor': { mode: 'auto', minContext: 65536 },
        'execution-auditor': { mode: 'auto', minContext: 65536 },
        'rules-auditor': { mode: 'auto', minContext: 65536 },
      },
    } as ResolvedRouting)
    // The floors are pinned BOTH by literal (the plan's declared values) and
    // against the constant the selector falls back to — one source of truth,
    // stated twice so neither can drift alone. (Narrow the union first: only
    // an 'auto' role carries a floor — the mode assertions ARE part of the
    // pin.)
    const executorRouting = viaPlain.roles.executor
    const planAuditorRouting = viaPlain.roles['plan-auditor']
    const rulesAuditorRouting = viaPlain.roles['rules-auditor']
    expect(executorRouting.mode).toBe('auto')
    expect(planAuditorRouting.mode).toBe('auto')
    expect(rulesAuditorRouting.mode).toBe('auto')
    if (executorRouting.mode !== 'auto' || planAuditorRouting.mode !== 'auto' || rulesAuditorRouting.mode !== 'auto') {
      throw new Error('unreachable: fixture narrowed above')
    }
    expect(executorRouting.minContext).toBe(DEFAULT_ROLE_MIN_CONTEXT.executor)
    expect(planAuditorRouting.minContext).toBe(DEFAULT_ROLE_MIN_CONTEXT['plan-auditor'])
    expect(executorRouting.minContext).toBe(131072)
    expect(rulesAuditorRouting.minContext).toBe(65536)
    // The planner floor exists in the declared constants even though the
    // DEFAULT planner routing is inherit (no selection, no floor application).
    expect(DEFAULT_ROLE_MIN_CONTEXT.planner).toBe(131072)
    // Planner opt-in: 'auto' is a non-default mode for the planner and wins.
    const optedIn = resolveConfig({ routing: { roles: { planner: { mode: 'auto' } } } }).routing.roles.planner
    expect(optedIn).toEqual({ mode: 'auto', minContext: DEFAULT_ROLE_MIN_CONTEXT.planner })
    // User-tuned floor is honored verbatim.
    const tuned = resolveConfig({ routing: { roles: { executor: { minContext: 999999 } } } }).routing.roles.executor
    expect(tuned).toEqual({ mode: 'auto', minContext: 999999 })
  })

  it('THROWS on locked mode with no lock route — on BOTH paths (fail-closed, never auto-route while claiming locked)', () => {
    const viaLoaderValue = loaded({ routing: { roles: { executor: { mode: 'locked' } } } }).value
    expect(() => resolveConfig(viaLoaderValue)).toThrow(/routing\.roles\.executor\.mode is "locked" but lock names no provider\/model route/)
    expect(() => resolveConfig({ routing: { roles: { executor: { mode: 'locked' } } } })).toThrow(/routing\.roles\.executor\.mode is "locked"/)
    // The schema alone cannot see mode from inside lock (field-level
    // volatility forbids a role-level transform), so the refusal is
    // resolve-time by design — and both paths refuse identically.
  })

  it('THROWS on a written lock contradicting an explicitly non-locked mode', () => {
    expect(() => resolveConfig({ routing: { roles: { executor: { mode: 'inherit', lock: { provider: 'p', model: 'm' } } } } }))
      .toThrow(/contradicts a written lock/)
    // 'auto' is the executor's DEFAULT, so executor 'auto' + lock is not
    // distinguishable from lock-alone (which resolves locked) — but for the
    // PLANNER 'auto' is an explicit non-default mode, and the contradiction
    // is observable and refused.
    expect(() => resolveConfig({ routing: { roles: { planner: { mode: 'auto', lock: { provider: 'p', model: 'm' } } } } }))
      .toThrow(/contradicts a written lock/)
  })
})

describe('resolveConfig — legacy explicit routes map to locked (documented, tested)', () => {
  it('auditors[role].agentOptions and executor.agentOptions resolve their roles as LOCKED on the legacy route', () => {
    const resolved = resolveConfig({
      auditors: {
        plan: { agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
        rules: { agentOptions: { provider: 'openai', model: 'gpt-6.1-sol', reasoningEffort: 'high' } },
      },
      executor: { agentOptions: { provider: 'anthropic', model: 'claude-x' } },
    })
    expect(resolved.routing.roles['plan-auditor']).toEqual({ mode: 'locked', provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    expect(resolved.routing.roles['rules-auditor']).toEqual({ mode: 'locked', provider: 'openai', model: 'gpt-6.1-sol', reasoningEffort: 'high' })
    expect(resolved.routing.roles.executor).toEqual({ mode: 'locked', provider: 'anthropic', model: 'claude-x' })
    // Untouched roles keep the shipped defaults; the planner has NO legacy surface.
    expect(resolved.routing.roles['execution-auditor']).toEqual({ mode: 'auto', minContext: 65536 })
    expect(resolved.routing.roles.planner).toEqual({ mode: 'inherit' })
    // The legacy fields themselves keep their 0.2.0 meaning and presence.
    expect(resolved.auditors.plan?.agentOptions).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    expect(resolved.executor.agentOptions).toEqual({ provider: 'anthropic', model: 'claude-x' })
  })

  it('an explicit new routing.roles.<role> route decision WINS over legacy; a minContext tune does not', () => {
    const legacy = { executor: { agentOptions: { provider: 'legacy-p', model: 'legacy-m' } } }
    // A new lock wins.
    const newLock = resolveConfig({
      ...legacy,
      routing: { roles: { executor: { lock: { provider: 'new-p', model: 'new-m' } } } },
    }).routing.roles.executor
    expect(newLock).toEqual({ mode: 'locked', provider: 'new-p', model: 'new-m' })
    // An explicit non-default mode wins (and leaves no lock behind).
    const optedOut = resolveConfig({
      ...legacy,
      routing: { roles: { executor: { mode: 'inherit' } } },
    }).routing.roles.executor
    expect(optedOut).toEqual({ mode: 'inherit' })
    // A floor tune names no route, so the legacy lock still applies.
    const tuned = resolveConfig({
      auditors: { plan: { agentOptions: { provider: 'lp', model: 'lm' } } },
      routing: { roles: { planAuditor: { minContext: 99999 } } },
    }).routing.roles['plan-auditor']
    expect(tuned).toEqual({ mode: 'locked', provider: 'lp', model: 'lm' })
  })

  it('legacy agentOptions with NO explicit route locks NOTHING (there is no route to lock) and is preserved verbatim', () => {
    // e.g. maxTokens alone: legal 0.2.0 config (a cap, not a route), so it
    // must keep its meaning — but it cannot become a lock, because a lock
    // without provider/model is exactly what the schema refuses above.
    const resolved = resolveConfig({
      auditors: { plan: { agentOptions: { maxTokens: 4096 } } },
      executor: { agentOptions: { maxTokens: 8192 } },
    })
    expect(resolved.routing.roles['plan-auditor']).toEqual({ mode: 'auto', minContext: 65536 })
    expect(resolved.routing.roles.executor).toEqual({ mode: 'auto', minContext: 131072 })
    expect(resolved.auditors.plan?.agentOptions).toEqual({ maxTokens: 4096 })
    expect(resolved.executor.agentOptions).toEqual({ maxTokens: 8192 })
  })

  it('crossFamily.pool entries are NOT mapped into locks (E3 handles pool as grants in off mode only)', () => {
    const resolved = resolveConfig({
      crossFamily: { pool: [{ provider: 'openai', model: 'gpt-6.1-sol' }, { provider: 'anthropic', model: 'claude-x' }] },
    })
    expect(resolved.routing).toEqual(resolveConfig({}).routing)
    expect(resolved.crossFamily.pool).toEqual([
      { provider: 'openai', model: 'gpt-6.1-sol' },
      { provider: 'anthropic', model: 'claude-x' },
    ])
  })

  it('the legacy→locked mapping agrees between the loader path and the plain path', () => {
    const raw = {
      auditors: { execution: { agentOptions: { provider: 'p', model: 'm' } } },
      executor: { agentOptions: { provider: 'e', model: 'm' } },
    }
    expect(resolveConfig(loaded(raw).value)).toEqual(resolveConfig(raw))
  })
})

/**
 * DEFAULT_EXECUTOR_TOOLS is the delegated executor child's tool allow-list.
 *
 * The loader test above asserts `viaLoader` equals `[...DEFAULT_EXECUTOR_TOOLS]`
 * — i.e. it compares the loader's output against the very constant it is
 * supposed to pin, so the list was unguarded in BOTH directions. Measured:
 * appending 'web_fetch','network_post' left the suite green, and dropping
 * 'glob','grep','read_image' left it green too. The ADDITIVE direction is the
 * security-relevant one — a harness whose purpose is owner-only egress control
 * must be able to observe a delegated child being granted network-capable tools
 * by default.
 */
describe('DEFAULT_EXECUTOR_TOOLS is pinned by value, in both directions', () => {
  it('is exactly this list, stated as a literal', () => {
    expect([...DEFAULT_EXECUTOR_TOOLS]).toEqual([
      'read', 'glob', 'grep', 'read_image',
      'write', 'edit', 'str_replace_editor',
      'bash', 'pwsh',
      'todo_write',
    ])
    expect(DEFAULT_EXECUTOR_TOOLS.length).toBe(10)
  })

  it('grants no tool that names an egress-capable transport', () => {
    // A name-shaped floor rather than a second copy of the list: an entry whose
    // NAME advertises the network is refused even if someone adds it "just for
    // this one deployment".
    const networkish = /fetch|http|curl|wget|network|upload|publish|webhook|browser|request/i
    for (const tool of DEFAULT_EXECUTOR_TOOLS) {
      expect(networkish.test(tool)).toBe(false)
    }
    // DETECTOR: the pattern is not vacuous.
    expect(networkish.test('web_fetch')).toBe(true)
    expect(networkish.test('network_post')).toBe(true)
  })

  it('no longer grants run_terminal, and does not substitute the real PTY names', () => {
    // `run_terminal` is defined by NO dsh package — it existed only in the v1
    // tool-gah plugin — so the entry granted nothing while documenting a
    // surface that does not exist. Removing it is the fail-closed repair;
    // substituting terminal_* would GRANT a capability the child never had.
    expect(DEFAULT_EXECUTOR_TOOLS).not.toContain('run_terminal')
    for (const tool of ['terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close']) {
      expect(DEFAULT_EXECUTOR_TOOLS).not.toContain(tool)
    }
    // The GATE went the other way: it scans the terminal channel it cannot allow.
    expect(SHELL_TOOLS).toContain('terminal_send')
    expect(isEgressCommand('git push origin main')).toBe(true)
    // The shell the executor DOES get is still the shell the gate scans.
    expect(DEFAULT_EXECUTOR_TOOLS.filter(tool => SHELL_TOOLS.includes(tool))).toEqual(['bash', 'pwsh'])
  })
})


/**
 * THE SHELL PAIR — the FIX 2 defect class asked about `bash`, which is not
 * registered on Windows.
 *
 * The base bundle splits one capability across two names by platform:
 * `tool-bash` carries `disabled: process.platform === 'win32'` and `tool-pwsh`
 * carries `disabled: process.platform !== 'win32'`
 * (`packages/bundle/base/cordis.patch.yml`). So on any given host exactly one of
 * them is registered and the other is INERT — which is a different thing from
 * `run_terminal`, which was defined by no dsh package on any platform and was
 * therefore DEAD.
 *
 * That difference decides the repair. An allow-list is a filter over tools the
 * host already registered: naming a tool the deployment does not have grants
 * nothing, while OMITTING one it does have leaves the delegated executor with no
 * shell at all — the same "the child starts with nothing" failure the shared
 * `DEFAULT_EXECUTOR_TOOLS` constant exists to prevent, only conditioned on the
 * host OS instead of on the config path. So both names stay, and the tests below
 * state the platform rule rather than the literal list, so a "fix" that deletes
 * the half that looks unused on the machine it was written on goes red.
 */
describe('DEFAULT_EXECUTOR_TOOLS: the platform shell pair', () => {
  /** The base bundle's own rule, restated as data. */
  const SHELL_FOR_PLATFORM = { win32: 'pwsh', other: 'bash' } as const

  it('grants the shell that IS registered, on every platform dsh ships a shell tool for', () => {
    for (const shell of Object.values(SHELL_FOR_PLATFORM)) {
      expect(DEFAULT_EXECUTOR_TOOLS).toContain(shell)
    }
    // Including the one this test process is running on, resolved by the same
    // predicate the bundle rows use.
    expect(DEFAULT_EXECUTOR_TOOLS)
      .toContain(SHELL_FOR_PLATFORM[process.platform === 'win32' ? 'win32' : 'other'])
  })

  it('grants that pair and nothing else as a shell', () => {
    expect(DEFAULT_EXECUTOR_TOOLS.filter(tool => SHELL_TOOLS.includes(tool))).toEqual(['bash', 'pwsh'])
  })

  it('every shell-shaped entry it grants is one the gate SCANS', () => {
    // The security floor behind keeping a two-name shell surface: a shell the
    // allow-list grants but `decideTool` does not scan is an egress channel with
    // no boundary on it. Name-shaped, like the networkish floor above, so a name
    // added "just for this one deployment" is caught rather than a list copied.
    const shellish = /^(bash|sh|zsh|ksh|fish|dash|pwsh|powershell|cmd|command|run_code|exec|shell|terminal)/i
    for (const tool of DEFAULT_EXECUTOR_TOOLS) {
      if (shellish.test(tool)) expect(SHELL_TOOLS).toContain(tool)
    }
    // DETECTOR: the pattern matches the shells it is meant to and not the rest.
    expect(shellish.test('bash')).toBe(true)
    expect(shellish.test('pwsh')).toBe(true)
    expect(shellish.test('zsh')).toBe(true)
    expect(shellish.test('read')).toBe(false)
    expect(shellish.test('str_replace_editor')).toBe(false)
    // and a shell the gate does NOT scan would fail the loop above.
    expect(SHELL_TOOLS).not.toContain('zsh')
  })

  it('names only tools some dsh package actually defines', () => {
    // Verified against the upstream registrations (2026-08-25): read/write/edit/
    // read_image `packages/fs/tool-fs`, glob/grep `packages/fs/tool-fs-search`,
    // str_replace_editor `packages/fs/tool-str-replace-editor`, todo_write
    // `packages/todo/tool-todo`, bash `packages/shell/tool-bash`, pwsh
    // `packages/shell/tool-pwsh`. The list is pinned by value one describe above;
    // this states what that pin MEANS, which is the thing `run_terminal` failed.
    expect([...DEFAULT_EXECUTOR_TOOLS].sort()).toEqual([
      'bash', 'edit', 'glob', 'grep', 'pwsh', 'read', 'read_image',
      'str_replace_editor', 'todo_write', 'write',
    ])
  })
})
