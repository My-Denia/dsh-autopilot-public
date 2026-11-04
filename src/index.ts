/**
 * dsh-autopilot plugin entry (0.3.0).
 *
 * One Cordis plugin that composes:
 * - the AutopilotEngine (the slim per-session ledger writer; no run state machine)
 * - the per-root `autopilot_status` tool (read-only)
 * - the autopilot:policy prompt section (empty unless a host restart lost children)
 * - the routing wiring and onboarding section
 * - the bundled skill publication
 * - the read-only `ctx.autopilot` service and its web routes (ledger + legacy runs)
 *
 * The 0.2.x run state machine, gates, outbound manifest and executor-child
 * surface are retired. Their old run streams are still shown, read-only, by
 * `src/legacy`, and a session a 0.2.x run left read-only is restored once, lazily,
 * when it is opened.
 *
 * Config (all optional; the declared schema is `./config.js`). Every 0.2.x key is
 * still ACCEPTED so an old config loads; the retired ones have no effect and are
 * named once in a status note (`RETIRED_CONFIG_KEYS`).
 *   routing: { mode, preference, roles, ladder, workClasses } — model routing
 *   storeRoot: directory root for file ledgers and legacy run streams
 *   skillInstall: 'auto' | 'off' — publish the bundled SKILL.md
 */

import { AutopilotEngine } from './engine.js'
import type { NativeGoalView } from './engine.js'
import type { AgentOptionsLike, AgentRef, ResolvedConfig, ResolvedCostOverride, ResolvedLadder, ResolvedRouting, RoutingPorts } from './engine.js'
import { observeOnboardingReachability, renderRoutingOnboarding } from './routing/onboarding.js'
import type { WorkClassReachabilityReport } from './routing/coverage.js'
import { renderRootPolicy } from './policy.js'
import { createAutopilotService, registerAutopilotService } from './service.js'
import { installAutopilotRoutes } from './web.js'
import type { ProvideHost } from './service.js'
import { defaultStoreRoot } from './store/file.js'
import { AUTOPILOT_DOMAIN_SPEC, LEDGERS_TABLE, legacyDomainReaderOf } from './store/domain.js'
import type { DomainFacilityLike, DomainLike, KvTableLike } from './store/domain.js'
import { FileLedgerStore, legacySourcesOf } from './store/ledger.js'
import type { LedgerStoreLike } from './store/ledger.js'
import type { LegacySources } from './legacy/index.js'
import { installRootTools } from './tools.js'
import { DEFAULT_EXECUTOR_TOOLS, retiredConfigNote, retiredKeysIn } from './config.js'
import { BUNDLED_SKILL_PROVIDER_NAME, BUNDLED_SKILL_PROVIDER_RANK, publishBundledSkill } from './skill-register.js'
import type { SkillPublicationResult, SkillRegistryLike } from './skill-register.js'
import type { SkillSyncResult } from './skill-install.js'
import { DEFAULT_ROLE_MIN_CONTEXT } from './routing/select.js'
import type { Role, RoleRouting, RoutePreference } from './routing/select.js'
import { DEFAULT_WORK_CLASSES, WORK_CLASS_AXES, WORK_CLASS_NAMES } from './routing/work-class.js'
import type { ResolvedWorkClass, WorkClassAxis, WorkClassName, WorkClassTier } from './routing/work-class.js'
import { toRoutePin } from './routing/identity.js'
import { RouteCatalog } from './routing/catalog.js'
import type { LlmRuntimeSubset } from './routing/catalog.js'
import type { SessionPolicyState } from './routing/authorize.js'
import type { ModelSelectionSetting } from './roles/route.js'
import { errorMessage } from './domain/types.js'
import type { AuditRole, Risk } from './domain/types.js'

export * from './domain/types.js'
export * from './domain/ledger-types.js'
export { REFUSALS } from './domain/refusals.js'
export type { RefusalCode } from './domain/refusals.js'
export { AutopilotEngine, effectiveSandboxMode, observedRouteOf } from './engine.js'
export type { EnginePorts, EnvironmentProbes, NativeGoalView, ResolvedConfig, ResolvedRouting, RoutingPorts } from './engine.js'
export { defaultStoreRoot } from './store/file.js'
export { AUTOPILOT_DOMAIN_SPEC, legacyDomainReaderOf } from './store/domain.js'
export type { DomainFacilityLike } from './store/domain.js'
export { FileLedgerStore, emptyLedger } from './store/ledger.js'
export type { LedgerStoreLike } from './store/ledger.js'
export { installChildTools } from './tools.js'
export { Delegator, autoContinueFor, routeMatchOf } from './delegate.js'
export { findWriteConflict, pathsIntersect } from './roles/paths.js'
export { renderRootPolicy } from './policy.js'
export { createAutopilotService, registerAutopilotService } from './service.js'
export type { AutopilotReadOnly } from './service.js'
export {
  AUTOPILOT_API_PREFIX,
  installAutopilotRoutes,
  makeAutopilotRoutes,
  projectLedger,
  queryParam,
} from './web.js'
export type { AutopilotWebRoute } from './web.js'
export { Config, DEFAULT_EXECUTOR_TOOLS, LEGACY_KEYS_STILL_READ, RETIRED_CONFIG_KEYS, StoreKindSchema, retiredConfigNote, retiredKeysIn } from './config.js'
export type { Role, RoleRouting, RoutePreference } from './routing/select.js'
export { coverageReport, coverageRouteKey, workClassReachability } from './routing/coverage.js'
export type {
  CoverageCatalog,
  CoverageLadder,
  CoverageOutcome,
  CoverageReport,
  ModelReachability,
  ReachabilityOutcome,
  WorkClassReachabilityReport,
} from './routing/coverage.js'
export { DEFAULT_WORK_CLASSES, WORK_CLASS_AXES, WORK_CLASS_NAMES, resolveWorkClassSelection } from './routing/work-class.js'
export type { ResolvedWorkClass, WorkClassAxis, WorkClassName, WorkClassSelection, WorkClassTier } from './routing/work-class.js'
export { observeOnboardingReachability, renderRoutingOnboarding } from './routing/onboarding.js'
export type { RoutingOnboardingInput } from './routing/onboarding.js'
export type { ResolvedCostOverride, ResolvedLadder } from './engine.js'
export {
  BUNDLED_SKILL_REFERENCES,
  SKILL_HOME_ENV,
  SKILL_REFERENCES_DIR,
  SKILL_RELATIVE,
  bundledSkillPath,
  bundledSkillRoot,
  skillHome,
  syncBundledSkill,
  syncBundledSkillTree,
} from './skill-install.js'
export type {
  DestKind,
  SkillInstallStatus,
  SkillSyncIo,
  SkillSyncResult,
  SkillTreeFileResult,
  SkillTreeSyncResult,
} from './skill-install.js'
export {
  BUNDLED_SKILL_PROVIDER_NAME,
  BUNDLED_SKILL_PROVIDER_RANK,
  BUNDLED_SKILL_PROVIDER_SOURCE,
  FILE_SCAN_BUNDLED_RANK,
  createBundledSkillProvider,
  parseBundledSkillFrontmatter,
  publishBundledSkill,
} from './skill-register.js'
export type {
  BundledSkillLocator,
  ParsedBundledSkill,
  PublishBundledSkillOptions,
  SkillCandidate,
  SkillDefinition,
  SkillInvocationPolicy,
  SkillProvider,
  SkillProviderControl,
  SkillPublicationResult,
  SkillRegistryLike,
  SkillResourceBase,
  SkillSource,
  SkillSummary,
  SkillLookupOptions,
} from './skill-register.js'

/** Cordis plugin name. */
export const name = 'dsh-autopilot'
/**
 * Required services.
 *
 * `storageDomain` and `approval` are deliberately ABSENT. cordis 4's `Inject`
 * is `(keyof M)[] | { [K]?: config }` (`vendor/cordis/src/registry.ts:19`) —
 * there is no optional form, so every name listed here is a hard requirement.
 * `ctx.storageDomain` is mounted by the web-app bundle only and `ctx.approval`
 * by the base bundle; listing either would make the plugin fail to load on the
 * profiles that lack it. Both are PROBED at mount instead, and what the probe
 * saw is recorded in `Enforcement`.
 *
 * `llm` and `sessionProjections` (model routing, M3b) are absent FOR THE SAME
 * REASON and resolved the same way — through {@link lookupService}. Verified
 * against the installed packages: `llm` IS a declared Context key
 * (`@deepseek-ai/dsh-llm` 0.2.0-rc.2 `lib/types/index.d.ts` declares
 * `Context.llm: LlmRuntime`), but `@deepseek-ai/dsh-session-projection` is
 * NOT among this package's installed dependencies, so `sessionProjections`
 * has no declared Context key in the installed type universe at all. Both are
 * therefore PROBED: a hard `inject` entry is a fiber-blocking requirement
 * (cordis 4 keeps a plugin INACTIVE until every injected service exists —
 * `Fiber._checkImpl`/`_refresh`), so a profile or host mount harness without
 * the service must still get the plugin, with routing degrading to
 * 0.2.0/inherit dispatch behavior (see `RoutingPorts`).
 */
export const inject = ['agents', 'subagents', 'tools', 'systemPrompt']

/** Raw config accepted from the patch layer. */
export interface ConfigInput {
  readonly auditProvider?: string
  readonly executorProvider?: string
  readonly auditors?: Partial<Record<AuditRole, { provider?: string; agentOptions?: AgentOptionsInput }>>
  readonly executor?: { agentOptions?: AgentOptionsInput; persona?: string; toolAllowList?: readonly string[] }
  /**
   * Cross-family review. A blind spot shared by one provider passes both gates
   * unchallenged, so past a risk floor the reviewer should not come from the
   * family that built. Strategy, not gate — the outcome is RECORDED per audit.
   */
  readonly crossFamily?: { enabled?: boolean; minRisk?: Risk; pool?: readonly AgentOptionsInput[] }
  /**
   * Role-true model routing (plan v3 "Config"). Legacy fields keep their 0.2.0
   * meaning; `routing` is the new surface, and `resolveConfig` maps legacy
   * explicit routes onto it (see {@link ResolvedRouting}).
   *
   * AT RUNTIME the loader path hands `apply()` these fields as volatile
   * references (cosmokit `Volatile`, read via `.get()`) because the schema
   * marks every routing leaf `.volatile()`; this interface stays the PLAIN
   * contract a programmatic caller writes, and `resolveConfig` unwraps
   * references structurally so both paths produce the same resolved config.
   */
  readonly routing?: RoutingInput
  /** RETIRED in 0.3.0 and ignored: the gates are gone. Accepted so an old config still loads. */
  readonly gate?: {
    sandboxCoupling?: boolean
    toolDeny?: boolean
    egressDeny?: boolean
    stopReminder?: boolean
    strictShell?: boolean
    restoreMode?: string
  }
  /**
   * RETIRED in 0.3.0 and ignored (reported once as a status note). The ledger
   * always goes to one file per root session under `<storeRoot>/ledgers/`;
   * legacy runs are read from the file root AND `ctx.storageDomain` regardless.
   */
  readonly storeKind?: 'auto' | 'file' | 'domain'
  readonly storeRoot?: string
  /**
   * Publish the bundled SKILL.md on mount (`auto`) or publish nothing
   * (`off`). Default `auto`. `auto` prefers the NATIVE skill registry:
   * when `ctx.skills` is observable, a provider serves the in-package file
   * (rank 700 — any file copy wins the duplicate name, so an installed or
   * drifted copy is never silently overridden) and NO filesystem copy is
   * made; a registration failure falls back to the 0.2.0 filesystem copy
   * with the failure warned. On a profile without the skill service the
   * filesystem copy is the channel, unchanged: drift never overwrites, and
   * a differing dest is a warning.
   */
  readonly skillInstall?: 'auto' | 'off'
  /** RETIRED in 0.3.0 and ignored (audit rounds and the egress policy no longer exist). */
  readonly governance?: {
    readonly maxAuditRoundsPerRole?: number
    readonly unattended?: boolean
  }
}

/**
 * Explicit LLM route for a dispatched child, widened at the config layer:
 * [R2-P3-1] adds `reasoningEffort`. `AgentOptionsLike` in `./engine.ts` is
 * widened to match since M3b, so this input shape and the engine's dispatch
 * shape carry the same field.
 */
export interface AgentOptionsInput extends AgentOptionsLike {
  readonly reasoningEffort?: string
}

/** One explicit route lock as a profile may write it (`routing.roles.<role>.lock`). */
export interface RouteLockInput {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Per-role routing as a profile may write it (`routing.roles.<role>`). */
export interface RoleRoutingInput {
  readonly mode?: 'auto' | 'inherit' | 'locked'
  readonly lock?: RouteLockInput
  readonly minContext?: number
  /**
   * The work class this role draws from (DESIGN §1.2). Absent = the role
   * default (`DEFAULT_ROLE_WORK_CLASS`: executor/planner `simple`, auditors
   * `audit`). Written alongside a resolved locked/inherit role it is dropped,
   * not honored — the same doctrine as `minContext`: those modes make no
   * selection, so no class governs them.
   */
  readonly workClass?: WorkClassName
}

/** One work class as a profile may override it (`routing.workClasses.<name>`). */
export interface WorkClassInput {
  /** The ladder tiers this class draws members from. Empty = entry by the class's own thresholds (mechanical). */
  readonly tiers?: readonly WorkClassTier[]
  /** The dominant ordering axis of the class. */
  readonly axis?: WorkClassAxis
}

/** The `routing` section as a profile may write it. */
export interface RoutingInput {
  readonly mode?: 'auto' | 'off'
  readonly preference?: 'balanced' | 'economy' | 'quality' | 'axis'
  /**
   * A2 (DESIGN section 9 item 13): the owner opt-in that lets the ordering-axis
   * path become the effective default. It applies ONLY when no explicit
   * preference is detectable (`preferenceSource === 'default'` — see
   * `resolveRouting` for why a written 'balanced' counts as default): an
   * owner who never picked a preference gets 'axis' instead of the provisional
   * 'balanced', while any explicit preference (including an explicit 'axis')
   * is untouched. Shipped default `false` — the plugin never flips a
   * deployment's ranking on its own.
   */
  readonly orderingAxisDefault?: boolean
  readonly roles?: {
    readonly executor?: RoleRoutingInput
    readonly planner?: RoleRoutingInput
    readonly planAuditor?: RoleRoutingInput
    readonly executionAuditor?: RoleRoutingInput
    readonly rulesAuditor?: RoleRoutingInput
  }
  readonly ladder?: {
    readonly tiers?: {
      readonly economy?: readonly string[]
      readonly standard?: readonly string[]
      readonly reserve?: readonly string[]
    }
    readonly auditTier?: 'economy' | 'standard' | 'reserve' | 'none'
    /**
     * Engine-level rotation (DESIGN §9 item 15). Volatile, default off: when
     * true a healthy pin yields to a full re-selection at the role's next
     * dispatch (repinFrom + reason rotation). An auditor's offset stays within
     * its independence class — never overriding independence; the executor's
     * offset is its own dispatch count within the ranked survivor list, and a
     * LIVE executor child is never re-routed (only `startExecutor` reaches the
     * resolver; `resumeExecutor` continues the child on its recorded route).
     */
    readonly rotation?: boolean
    readonly speedOrder?: readonly string[]
    readonly costOverrides?: readonly string[]
  }
  /**
   * Per-class overrides of the owner-table work classes (DESIGN §1.2). Class
   * names are fixed paths (the same schemastery volatile constraint as the
   * ladder tier names); a class absent here keeps the owner-table default.
   */
  readonly workClasses?: {
    readonly mechanical?: WorkClassInput
    readonly simple?: WorkClassInput
    readonly hard?: WorkClassInput
    readonly audit?: WorkClassInput
    readonly extreme?: WorkClassInput
  }
}

/**
 * Resolved routing is declared in `./engine.ts` (with `ResolvedConfig.routing`)
 * since M3b — the engine is its consumer — and re-exported above for API
 * stability; `resolveRouting` below is still the one place the `routing`
 * section and the legacy surfaces are mapped onto it.
 */

/**
 * An optional nested object, with EMPTY treated as ABSENT.
 *
 * WHY: the two config paths disagreed here, in the very defect class this
 * module's `resolveConfig`/`Config` split exists to eliminate. Schemastery's
 * `Schema.object({...})` defaults to `{}`, not to `undefined`, so
 * `resolveConfig(Config({}))` produced `auditors.plan = { agentOptions: {} }`
 * and `executor.agentOptions = {}` where `resolveConfig({})` produced
 * `undefined`. The engine then wrote `...(agentOptions === undefined ? {} :
 * { agentOptions })`, i.e. a REAL cordis deployment passed `agentOptions: {}`
 * to `subagents.start` while every test in the suite (plain path) omitted the
 * key. An empty options object carries no routing information by construction,
 * so collapsing it to absent makes the two paths produce the same
 * `ResolvedConfig` — which `test/config.test.ts` now asserts by deep equality
 * over the whole object rather than over one field.
 */
function presentOrAbsent<T extends object>(value: T | undefined): T | undefined {
  if (value === undefined) return undefined
  return Object.keys(value).length === 0 ? undefined : value
}

/** Normalize the auditor routing table, dropping roles that carry no routing at all. */
function compactAuditors(
  input: ConfigInput['auditors'],
): Partial<Record<AuditRole, { provider?: string; agentOptions?: AgentOptionsInput }>> {
  const out: Partial<Record<AuditRole, { provider?: string; agentOptions?: AgentOptionsInput }>> = {}
  for (const [role, route] of Object.entries(input ?? {}) as Array<[AuditRole, { provider?: string; agentOptions?: AgentOptionsInput } | undefined]>) {
    if (route === undefined) continue
    const agentOptions = presentOrAbsent(route.agentOptions)
    const entry = {
      ...(route.provider === undefined ? {} : { provider: route.provider }),
      ...(agentOptions === undefined ? {} : { agentOptions }),
    }
    if (Object.keys(entry).length === 0) continue
    out[role] = entry
  }
  return out
}

// ── Routing resolution (packet E2; plan v3 "Config" + "Roles and routing") ──

/**
 * Structural mirror of the volatile reference schemastery wraps every
 * `.volatile()` leaf's resolved value in (cosmokit `Volatile`; the loader
 * hands `apply()` these wrappers — measured against
 * @deepseek-ai/schemastery 3.18.4 and cordis's `resolveConfig`). Detected
 * through the shared registered symbol so no new dependency is introduced;
 * a plain value passes through unchanged, which is what every non-loader
 * caller hands us.
 */
interface VolatileRef {
  readonly get: () => unknown
}

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

function isVolatileRef(value: unknown): value is VolatileRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    VOLATILE_WRITE in value &&
    typeof (value as unknown as VolatileRef).get === 'function'
  )
}

/** Read one routing setting whether it arrived plain or as a volatile reference. */
function readSetting<T>(value: T | VolatileRef): T {
  return isVolatileRef(value) ? (value.get() as T) : value
}

/**
 * F2 (PR #2 Codex review): whether ANY leaf under the `routing` section
 * arrived as a volatile reference. Bounded depth (the section is three
 * levels deep: section → role → leaf) and cycle-safe by construction — a
 * volatile reference is returned on sight and never descended into.
 */
function containsVolatileRef(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== 'object' || depth > 4) return false
  if (isVolatileRef(value)) return true
  if (Array.isArray(value)) return value.some(item => containsVolatileRef(item, depth + 1))
  return Object.values(value as Record<string, unknown>).some(item => containsVolatileRef(item, depth + 1))
}

/**
 * F2 (PR #2 Codex review): the per-decision routing re-read for the engine.
 *
 * THE DEFECT THIS CLOSES: `resolveConfig` is evaluated ONCE at mount, and on
 * the Cordis loader path the routing leaves arrive as volatile REFERENCES —
 * precisely so a config PATCH can update them in place WITHOUT remounting the
 * plugin fiber. Unwrapping them into `ResolvedConfig.routing` at mount froze
 * mode/lock/preference at their mount values: a patched `routing.mode` or a
 * patched lock had no effect until a remount, while the legacy
 * `executor.agentOptions` surface stayed live through its own remount path.
 *
 * THE SHAPE, AND WHY NOT A FIELD ON `ResolvedRouting`: the raw `ConfigInput`
 * is kept and re-resolved by {@link resolveRouting} at each routing decision
 * (the packet's second suggested shape). Carrying the refs INSIDE
 * `ResolvedRouting` would put a live closure into a value the suite asserts
 * by deep equality against the plain path (`test/config.test.ts`), so the
 * accessor travels beside the resolved config instead — `apply()` hands it
 * to the engine as its optional `routingSource`, and the resolved config
 * stays pure data on BOTH paths.
 *
 * The PLAIN path is untouched by construction: no volatile references ⇒
 * `undefined` ⇒ the engine keeps reading its mount-time `config.routing`,
 * byte-identical to the pre-F2 behavior. On the loader path the closure
 * re-runs the SAME resolution (defaults, legacy mapping, fail-closed
 * validation), so a patch that makes the section invalid surfaces at the
 * next decision — where the engine degrades honestly instead of throwing
 * mid-commit (see the engine's `routingConfig`); the mount-time
 * fail-fast on an invalid INITIAL config is unchanged.
 */
export function volatileRoutingAccess(input?: ConfigInput): (() => ResolvedRouting) | undefined {
  if (!containsVolatileRef(input?.routing)) return undefined
  return () => resolveRouting(input)
}

/** The five per-role config keys, in schema declaration order. */
const ROLE_CONFIG_KEYS = ['executor', 'planner', 'planAuditor', 'executionAuditor', 'rulesAuditor'] as const

type RoleConfigKey = (typeof ROLE_CONFIG_KEYS)[number]

/** Config key → routing-core role name (`Role` uses the hyphenated auditor names). */
const ROLE_OF: Readonly<Record<RoleConfigKey, Role>> = {
  executor: 'executor',
  planner: 'planner',
  planAuditor: 'plan-auditor',
  executionAuditor: 'execution-auditor',
  rulesAuditor: 'rules-auditor',
}

/**
 * Shipped per-role mode defaults: the planner IS the root agent, so it
 * INHERITS unless opted in (plan "Roles and routing"); every other role
 * defaults to `auto` under the conservative authorization model.
 */
const DEFAULT_ROLE_MODE: Readonly<Record<Role, 'auto' | 'inherit'>> = {
  executor: 'auto',
  planner: 'inherit',
  'plan-auditor': 'auto',
  'execution-auditor': 'auto',
  'rules-auditor': 'auto',
}

/** Trimmed non-blank effort, or `undefined`. */
function effortOf(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
}

/** A lock input normalized to the routing core's locked shape, or `undefined` when it names no route. */
function lockRouteOf(lock: { provider?: string; model?: string; reasoningEffort?: string } | undefined):
  { provider: string; model: string; reasoningEffort?: string } | undefined {
  const pin = toRoutePin(lock)
  if (pin === undefined) return undefined
  const effort = effortOf(lock?.reasoningEffort)
  return { provider: pin.provider, model: pin.model, ...(effort !== undefined ? { reasoningEffort: effort } : {}) }
}

/**
 * The legacy explicit route for one role, if any ([R2-P1-1] surfaces:
 * `executor.agentOptions` and `auditors[role].agentOptions`). The planner has
 * no legacy surface — it did not exist as a routed role in 0.2.0.
 *
 * `maxTokens` (and any future non-route field) is deliberately NOT mapped:
 * a lock is a ROUTE grant; the legacy agentOptions object itself stays in
 * `ResolvedConfig` with its 0.2.0 meaning for the engine's dispatch
 * composition (packet E3). A legacy agentOptions with fields set but NO
 * explicit provider/model route (e.g. `maxTokens` alone) maps to NO lock —
 * there is no route to lock, and the routing core refuses to guess one
 * (`resolvePluginGrant`'s own rule); the role keeps its default mode.
 */
function legacyRouteFor(role: Role, input?: ConfigInput): { provider: string; model: string; reasoningEffort?: string } | undefined {
  const options: AgentOptionsInput | undefined =
    role === 'executor'
      ? input?.executor?.agentOptions
      : role === 'plan-auditor'
        ? input?.auditors?.plan?.agentOptions
        : role === 'execution-auditor'
          ? input?.auditors?.execution?.agentOptions
          : role === 'rules-auditor'
            ? input?.auditors?.rules?.agentOptions
            : undefined
  return lockRouteOf(options)
}

/**
 * Resolve the `routing` section onto exactly what the routing core consumes.
 *
 * LEGACY MAPPING (resolve-time, per the packet): a legacy explicit route maps
 * to `locked` and WINS over the shipped default mode; an explicit new
 * `routing.roles.<role>` route decision — a written lock, or a written mode
 * that differs from the role's default — wins over legacy. `minContext` alone
 * tunes a floor and names no route, so it does NOT displace a legacy lock.
 *
 * THE EXPLICITNESS CEILING, stated honestly: schemastery fills declared
 * defaults before `apply()` sees the value, so a mode WRITTEN as exactly the
 * role's default ('auto' for executor/auditors) is indistinguishable from an
 * absent one on the loader path — and resolveConfig must treat both paths
 * identically (the deep-equality fixture), so "written-default" deliberately
 * counts as not explicit and legacy wins. Writing a non-default mode
 * ('inherit' for executor/auditors, 'auto'/'locked' for planner) IS
 * distinguishable on both paths and wins.
 *
 * `mode: 'locked'` without a lock route throws (fail-closed: a locked role
 * with nothing to lock is an owner config error, and mount refuses rather
 * than silently auto-routing while claiming locked). A written lock alongside
 * an explicitly non-locked mode throws for the same reason — inert config is
 * the pseudo-active defect this repository keeps paying for. `minContext`
 * written alongside a resolved locked/inherit role is dropped, not honored:
 * the floor governs auto selections only (a locked route is an explicit
 * owner selection and an inherited dispatch runs on the deployment default).
 */
/**
 * Whether this host exposes a config-edit surface the root agent may use to
 * fix the routing ladder itself (DESIGN §9 item 12): the plan's
 * `ctx.configEditor.edit()` / `ctx.settings.edit()` surfaces, probed
 * structurally. A host without either (the desktop host this run targets
 * included) takes the owner-edit degrade path in the onboarding text.
 */
function probeConfigEditor(rawCtx: unknown): boolean {
  const hasEdit = (service: unknown) => typeof (service as { edit?: unknown } | undefined)?.edit === 'function'
  return hasEdit(lookupService(rawCtx, 'configEditor')) || hasEdit(lookupService(rawCtx, 'settings'))
}

function resolveRouting(input?: ConfigInput): ResolvedRouting {
  const routing = input?.routing
  const mode = readSetting(routing?.mode) ?? 'auto'
  const writtenPreference = readSetting(routing?.preference)
  const preference = writtenPreference ?? 'balanced'
  if (mode !== 'auto' && mode !== 'off') throw new Error(`routing.mode must be 'auto' or 'off' (got ${JSON.stringify(mode)})`)
  if (preference !== 'balanced' && preference !== 'economy' && preference !== 'quality' && preference !== 'axis') {
    throw new Error(`routing.preference must be 'balanced', 'economy', 'quality' or 'axis' (got ${JSON.stringify(preference)})`)
  }
  // A2 (DESIGN section 9 item 13): explicit-vs-default preference. The ceiling
  // documented above applies verbatim — a preference WRITTEN as exactly the
  // default is indistinguishable from an absent one on the loader path, so
  // only a non-'balanced' value counts as explicit, on BOTH paths (the
  // deep-equality fixture forbids path-dependent answers). The axis promotion
  // fires only on the default source AND the owner's explicit opt-in leaf:
  // the plugin never re-ranks a deployment that did not ask for it.
  const preferenceSource: 'explicit' | 'default' =
    writtenPreference !== undefined && writtenPreference !== 'balanced' ? 'explicit' : 'default'
  const axisDefault = readSetting(routing?.orderingAxisDefault) ?? false
  if (typeof axisDefault !== 'boolean') {
    throw new Error(`routing.orderingAxisDefault must be a boolean (got ${JSON.stringify(axisDefault)})`)
  }
  const effectivePreference = preferenceSource === 'explicit' ? preference : (axisDefault ? 'axis' : preference)
  const roles = {} as Record<Role, RoleRouting>
  for (const key of ROLE_CONFIG_KEYS) {
    const role = ROLE_OF[key]
    const entry = readSetting(routing?.roles?.[key])
    const entryMode = readSetting(entry?.mode)
    const lockRoute = lockRouteOf(readSetting(entry?.lock))
    const minContext = readSetting(entry?.minContext)
    const workClass = readSetting(entry?.workClass)
    if (workClass !== undefined && !WORK_CLASS_NAMES.includes(workClass as WorkClassName)) {
      throw new Error(`routing.roles.${key}.workClass must be one of ${WORK_CLASS_NAMES.join(' | ')} (got ${JSON.stringify(workClass)})`)
    }
    const modeIsExplicit = entryMode !== undefined && entryMode !== DEFAULT_ROLE_MODE[role]
    if (entryMode === 'locked' && lockRoute === undefined) {
      throw new Error(`routing.roles.${key}.mode is "locked" but lock names no provider/model route — refusing to guess a route`)
    }
    if (lockRoute !== undefined && modeIsExplicit && entryMode !== 'locked') {
      throw new Error(`routing.roles.${key}: mode "${entryMode}" contradicts a written lock — a lock selects a route only in locked mode`)
    }
    if (lockRoute !== undefined) {
      roles[role] = { mode: 'locked', ...lockRoute }
      continue
    }
    // Absent mode means the role's shipped default (the loader fills the same
    // default, so both paths land here identically); an explicit 'inherit'
    // wins over legacy for the same reason any explicit new mode does.
    const effectiveMode = entryMode ?? DEFAULT_ROLE_MODE[role]
    if (effectiveMode === 'inherit') {
      roles[role] = { mode: 'inherit' }
      continue
    }
    const legacy = legacyRouteFor(role, input)
    if (legacy !== undefined) {
      roles[role] = { mode: 'locked', ...legacy }
      continue
    }
    roles[role] = {
      mode: 'auto',
      minContext: minContext ?? DEFAULT_ROLE_MIN_CONTEXT[role],
      ...(workClass === undefined ? {} : { workClass: workClass as WorkClassName }),
    }
  }
  return { mode, preference: effectivePreference, preferenceSource, roles, ladder: resolveLadder(input), workClasses: resolveWorkClasses(input) }
}

/**
 * Resolve the five work classes (DESIGN §1.2). Owner values win per class; a
 * silent class keeps the owner-table default. A malformed tier or axis is
 * REFUSED with its path, never dropped — a silently ignored class override
 * would leave the owner believing a dispatch draws from tiers it does not.
 */
function resolveWorkClasses(input?: ConfigInput): Readonly<Record<WorkClassName, ResolvedWorkClass>> {
  const raw = input?.routing?.workClasses
  const out = {} as Record<WorkClassName, ResolvedWorkClass>
  for (const name of WORK_CLASS_NAMES) {
    const defaults = DEFAULT_WORK_CLASSES[name]
    const entry = readSetting(raw?.[name])
    const rawTiers = readSetting(entry?.tiers)
    let tiers: readonly WorkClassTier[] = defaults.tiers
    if (rawTiers !== undefined) {
      if (!Array.isArray(rawTiers)) {
        throw new Error(`routing.workClasses.${name}.tiers must be an array of 'economy' | 'standard' | 'reserve'`)
      }
      const seen: WorkClassTier[] = []
      for (const tier of rawTiers) {
        const value = readSetting(tier)
        if (value !== 'economy' && value !== 'standard' && value !== 'reserve') {
          throw new Error(`routing.workClasses.${name}.tiers entry must be 'economy', 'standard' or 'reserve' (got ${JSON.stringify(value)})`)
        }
        if (!seen.includes(value)) seen.push(value)
      }
      tiers = seen
    }
    const axis = readSetting(entry?.axis) ?? defaults.axis
    if (!WORK_CLASS_AXES.includes(axis as WorkClassAxis)) {
      throw new Error(`routing.workClasses.${name}.axis must be one of ${WORK_CLASS_AXES.join(' | ')} (got ${JSON.stringify(axis)})`)
    }
    out[name] = { name, tiers, axis: axis as WorkClassAxis }
  }
  return out
}

/** `provider/model=inputPerM/outputPerM`. Anything else is refused, never ignored. */
const COST_OVERRIDE_PATTERN = /^([^/=]+)\/([^=]+)=([0-9]+(?:\.[0-9]+)?)\/([0-9]+(?:\.[0-9]+)?)$/

/** Read an optional array-of-strings leaf, trim-exact, dropping blanks. */
function ladderList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim()).filter(entry => entry.length > 0)
}

function parseCostOverride(entry: string): ResolvedCostOverride {
  const match = COST_OVERRIDE_PATTERN.exec(entry.trim())
  const provider = (match?.[1] ?? '').trim()
  const model = (match?.[2] ?? '').trim()
  const inputPerM = Number(match?.[3])
  const outputPerM = Number(match?.[4])
  if (match === null || provider.length === 0 || model.length === 0
    || !Number.isFinite(inputPerM) || !Number.isFinite(outputPerM) || inputPerM <= 0 || outputPerM <= 0) {
    throw new Error(`routing.ladder.costOverrides entry ${JSON.stringify(entry)} is malformed — expected "provider/model=inputPerM/outputPerM" with positive prices`)
  }
  return { provider, model, inputPerM, outputPerM }
}

/**
 * Resolve the owner's ladder.
 *
 * Owner values win; a declared default applies only where the owner is silent.
 * Nothing here is derived from a model name or id, and a malformed cost
 * override is REFUSED rather than dropped, because a silently ignored pricing
 * instruction would leave the owner believing a route costs what it does not.
 */
function resolveLadder(input?: ConfigInput): ResolvedLadder {
  const raw = input?.routing?.ladder
  const tiers = readSetting(raw?.tiers)
  const auditTier = readSetting(raw?.auditTier)
  if (auditTier !== undefined && auditTier !== 'economy' && auditTier !== 'standard' && auditTier !== 'reserve' && auditTier !== 'none') {
    throw new Error(`routing.ladder.auditTier must be 'economy', 'standard', 'reserve' or 'none' (got ${JSON.stringify(auditTier)})`)
  }
  return {
    tiers: {
      economy: ladderList(readSetting(tiers?.economy)),
      standard: ladderList(readSetting(tiers?.standard)),
      reserve: ladderList(readSetting(tiers?.reserve)),
    },
    auditTier: auditTier ?? 'none',
    rotation: readSetting(raw?.rotation) === true,
    speedOrder: ladderList(readSetting(raw?.speedOrder)),
    costOverrides: ladderList(readSetting(raw?.costOverrides)).map(parseCostOverride),
  }
}

/** Resolve raw config with defaults (manual, defensive — the schema governs writes, this governs reads). */
export function resolveConfig(input?: ConfigInput): ResolvedConfig {
  const executorAgentOptions = presentOrAbsent(input?.executor?.agentOptions)
  // The retired 0.2.x keys (auditProvider, executorProvider, executor.persona, executor.toolAllowList, crossFamily.*)
  // are not read: they resolve to their shipped values whatever the input says, so the loader path and the plain
  // path agree. `executor.agentOptions` and `auditors.<role>.agentOptions` are still read, through `resolveRouting`.
  return {
    auditProvider: 'spawn',
    executorProvider: 'spawn',
    auditors: compactAuditors(input?.auditors),
    executor: {
      ...(executorAgentOptions === undefined ? {} : { agentOptions: executorAgentOptions }),
      persona: '',
      toolAllowList: [...DEFAULT_EXECUTOR_TOOLS],
    },
    crossFamily: { enabled: true, minRisk: 'medium', pool: [] },
    routing: resolveRouting(input),
    gate: {
      sandboxCoupling: input?.gate?.sandboxCoupling ?? true,
      toolDeny: input?.gate?.toolDeny ?? true,
      egressDeny: input?.gate?.egressDeny ?? true,
      stopReminder: input?.gate?.stopReminder ?? true,
      strictShell: input?.gate?.strictShell ?? false,
      restoreMode: input?.gate?.restoreMode ?? 'workspace-write',
    },
    skillInstall: input?.skillInstall ?? 'auto',
    // Mirrors the loader path field-for-field: an unset governance section
    // resolves to an EMPTY object on both paths (the engine reads
    // governance?.maxAuditRoundsPerRole / governance?.unattended and treats
    // absent as off).
    governance: {
      ...(input?.governance?.maxAuditRoundsPerRole === undefined
        ? {}
        : { maxAuditRoundsPerRole: input.governance.maxAuditRoundsPerRole }),
      ...(input?.governance?.unattended === undefined
        ? {}
        : { unattended: input.governance.unattended }),
    },
  }
}

/** Structural context subset the plugin needs (kept loose: dsh provides the real Context). */
interface PluginContext {
  agents: {
    get(id: string): unknown
    list(): Iterable<unknown>
    roots(): unknown[]
  }
  subagents: Record<string, unknown>
  systemPrompt: {
    section(section: {
      name: string
      order: number
      text: (context: { agent?: { id: string; session: { header: { parentSession?: string } } } }) => string
    }): () => void
  }
  on(event: string, listener: (payload: never) => void): () => void
}
/**
 * Look one service up on a raw context the way dsh itself does: `ctx.get(name)`
 * first (property reads on undeclared services are not reliable), falling back
 * to property access, with any failure reading as unavailable.
 *
 * Shared by every probe below so they cannot drift apart: a probe that is
 * stricter than its siblings would record a capability difference that reflects
 * the probe, not the deployment.
 */
function lookupService(rawCtx: unknown, name: string): unknown {
  const record = rawCtx as { get?: (name: string) => unknown } & Record<string, unknown>
  try {
    if (typeof record.get === 'function') {
      try {
        const viaGet = record.get(name)
        if (viaGet !== undefined && viaGet !== null) return viaGet
      } catch {
        // ctx.get failed for this name: fall through to property access.
      }
    }
    return record[name]
  } catch {
    return undefined
  }
}

/** A thrown value rendered for a diagnostic, without pretending it is an Error. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Emit one deployment diagnostic, defensively.
 *
 * `ctx.logger` is an own property of the root cordis Context rather than a
 * provided service, so {@link lookupService}'s property fallback is what finds
 * it; a deployment that has none must not fail to mount over a diagnostic.
 */
function warn(rawCtx: unknown, message: string): void {
  try {
    const logger = lookupService(rawCtx, 'logger') as { warn?: (message: string) => void } | undefined
    logger?.warn?.(message)
  } catch {
    // A logger that throws is still only a logger.
  }
}

/**
 * Emit one deployment diagnostic at info level, defensively — the level a
 * SUCCESSFUL channel choice deserves (the {@link warn} channel is reserved
 * for degradations), with the same non-guarantees as its sibling: a host
 * without an `info` member drops the message and changes nothing else.
 * `apply()` uses it to say WHICH path published the bundled skill, so the
 * publication channel is diagnosable without waiting for a degrade.
 */
function info(rawCtx: unknown, message: string): void {
  try {
    const logger = lookupService(rawCtx, 'logger') as { info?: (message: string) => void } | undefined
    logger?.info?.(message)
  } catch {
    // A logger that throws is still only a logger.
  }
}
/**
 * The host's resolved default sandbox mode (`ctx.sandboxPolicy.defaultMode`), or
 * `undefined` when the service is absent or the value is not a string. The lazy
 * clamp restore writes it when a legacy run recorded no prior mode.
 */
/**
 * Every tool name the registry shows `scope`, or `undefined` when the registry
 * cannot be listed (or is empty).
 *
 * `scope` is the agent the names are read FOR (dsh-tools scope keys are the
 * Agent objects themselves). It is not optional in practice: on a preset
 * composition (dsh-web-app, the desktop app) the model-facing tools — `read`,
 * `grep`, `bash`, ... — are registered in the preset generation's scope layer,
 * not the global one, so the unscoped view lists none of them. A delegated
 * child joins its parent's generation, so the caller's view is the surface the
 * child inherits.
 */
export function registeredToolNamesOf(rawCtx: unknown, scope?: unknown): readonly string[] | undefined {
  try {
    const tools = lookupService(rawCtx, 'tools') as { schemas?: (scope?: unknown) => Array<{ name?: unknown }> } | undefined | null
    const names = tools?.schemas?.(scope).map(schema => schema.name).filter((name): name is string => typeof name === 'string')
    return names === undefined || names.length === 0 ? undefined : names
  } catch {
    return undefined
  }
}

/**
 * The native subagent `maxDepth` setting. `ctx.subagents.config.maxDepth` is a
 * volatile reference (`.get()`); a plain number is tolerated. Its shipped default
 * is 1, which cannot be told from an explicit 1.
 */
export function subagentMaxDepthOf(rawCtx: unknown): number | undefined {
  try {
    const subagents = lookupService(rawCtx, 'subagents') as { config?: { maxDepth?: unknown } } | undefined | null
    const setting = subagents?.config?.maxDepth
    const value = typeof setting === 'number' ? setting : (setting as { get?: () => unknown } | undefined)?.get?.()
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** The session's native goal view from `ctx.goals.get(agent)` (dsh-goal), or `undefined` when there is no service or no goal. */
export function readNativeGoal(rawCtx: unknown, root: unknown): NativeGoalView | undefined {
  const goals = lookupService(rawCtx, 'goals') as { get?: (agent: unknown) => unknown } | undefined | null
  const view = goals?.get?.(root) as Partial<NativeGoalView> | undefined
  if (view === undefined || view === null || typeof view.id !== 'string') return undefined
  return {
    id: view.id,
    revision: typeof view.revision === 'number' ? view.revision : 0,
    objective: typeof view.objective === 'string' ? view.objective : '',
    phase: typeof view.phase === 'string' ? view.phase : 'unknown',
    maxGoalRounds: typeof view.maxGoalRounds === 'number' ? view.maxGoalRounds : 0,
    roundsStarted: typeof view.roundsStarted === 'number' ? view.roundsStarted : 0,
    activation: view.activation === 'armed' ? 'armed' : 'disarmed',
    ...(view.blockedReason === undefined ? {} : { blockedReason: view.blockedReason }),
  }
}

/**
 * Whether the composition mounts an enabled goal round driver
 * (`@deepseek-ai/dsh-goal-round-driver`, loader entry id `goal-round-driver`).
 * The driver provides no service, so the only evidence is the loader's entry
 * tree. `undefined` means the tree could not be inspected, which is NOT the same
 * as false.
 */
export function goalDriverPresentIn(rawCtx: unknown): boolean | undefined {
  try {
    const loader = lookupService(rawCtx, 'loader') as { tree?: { entries?: () => Iterable<unknown> }; entries?: () => Iterable<unknown> } | undefined | null
    const entries = loader?.tree?.entries?.() ?? loader?.entries?.()
    if (entries === undefined) return undefined
    for (const raw of entries) {
      const entry = raw as { options?: { name?: unknown; id?: unknown; disabled?: unknown }; fiber?: { state?: unknown } }
      const name = entry.options?.name
      const id = entry.options?.id
      const isDriver = (typeof name === 'string' && /goal-round-driver$/.test(name)) || id === 'goal-round-driver'
      if (!isDriver) continue
      if (entry.options?.disabled === true) continue
      // An entry whose fiber has not loaded (or failed) is not a driver that will run.
      if (typeof entry.fiber?.state === 'number' && entry.fiber.state !== 2) continue
      return true
    }
    return false
  } catch {
    return undefined
  }
}

/**
 * The user's `subagentModelSelection` setting, read live from the host's
 * `ctx.subagentModelSelection` service (`current()` returns
 * `{ enabled, allowedModels }`). The setting is only ever a RESTRICTION on
 * delegation routing (see `roles/route.ts`); it is never selection authority.
 * `undefined` when the service is absent, throws (the host rejects an enabled
 * list with no routes), or answers a malformed shape: routing then behaves as
 * if the setting did not exist. `onUnreadable` fires only for a throw or a
 * malformed answer, never for a plainly absent service.
 */
export function modelSelectionSettingOf(rawCtx: unknown, onUnreadable: (message: string) => void = () => {}): ModelSelectionSetting | undefined {
  let service: unknown
  try {
    service = lookupService(rawCtx, 'subagentModelSelection')
  } catch {
    return undefined
  }
  if (service === null || typeof service !== 'object') return undefined
  const current = (service as { current?: unknown }).current
  if (typeof current !== 'function') return undefined
  try {
    const value = (current as () => unknown).call(service) as { enabled?: unknown; allowedModels?: unknown } | null | undefined
    if (value === null || typeof value !== 'object' || typeof value.enabled !== 'boolean' || !Array.isArray(value.allowedModels)) {
      onUnreadable('dsh-autopilot: the subagentModelSelection setting answered an unexpected shape; delegation routing ignores it')
      return undefined
    }
    const allowedModels: Array<{ provider: string; model: string }> = []
    for (const entry of value.allowedModels as unknown[]) {
      const route = entry as { provider?: unknown; model?: unknown } | null
      if (route === null || typeof route !== 'object' || typeof route.provider !== 'string' || typeof route.model !== 'string') {
        onUnreadable('dsh-autopilot: the subagentModelSelection setting lists a malformed route; delegation routing ignores it')
        return undefined
      }
      allowedModels.push({ provider: route.provider, model: route.model })
    }
    return { enabled: value.enabled, allowedModels }
  } catch (error) {
    onUnreadable(`dsh-autopilot: the subagentModelSelection setting is unreadable (${describeError(error)}); delegation routing ignores it`)
    return undefined
  }
}

export function sandboxDefaultModeOf(rawCtx: unknown): string | undefined {
  try {
    const policy = lookupService(rawCtx, 'sandboxPolicy') as { defaultMode?: unknown } | undefined | null
    return typeof policy?.defaultMode === 'string' ? policy.defaultMode : undefined
  } catch {
    return undefined
  }
}

/**
 * Bearer for the domain store: `ctx.storageDomain` must be observable AND must
 * expose the one method the store actually calls. A truthy service that cannot
 * `open` is not a backend, and treating it as one would swap a working file
 * store for a broken domain store.
 * @returns the facility, or undefined when this deployment has none.
 */
export function probeStorageDomain(rawCtx: unknown): DomainFacilityLike | undefined {
  try {
    const facility = lookupService(rawCtx, 'storageDomain')
    if (facility === null || typeof facility !== 'object') return undefined
    const candidate = facility as { open?: unknown }
    if (typeof candidate.open !== 'function') return undefined
    return facility as DomainFacilityLike
  } catch {
    return undefined
  }
}

// ── Model-routing wiring (M3b): the two probed services feeding `RoutingPorts` ──

/**
 * The four `LlmRuntime` members the catalog port touches — the probe's proof
 * that what `ctx.get('llm')` returned is really a runtime and not a truthy
 * stand-in. The compile-time bearer for the MEMBER shapes lives in
 * `test/routing-boundary.test.ts`; this is the runtime presence check.
 * @returns the runtime subset, or `undefined` when the service is absent or malformed.
 */
export function probeLlmRuntime(rawCtx: unknown): LlmRuntimeSubset | undefined {
  try {
    const llm = lookupService(rawCtx, 'llm')
    if (llm === null || typeof llm !== 'object') return undefined
    const candidate = llm as Record<string, unknown>
    for (const member of ['listProviders', 'listModels', 'resolveModelInfo', 'resolveCallConfig'] as const) {
      if (typeof candidate[member] !== 'function') return undefined
    }
    return llm as LlmRuntimeSubset
  } catch {
    return undefined
  }
}

/** The structural mirror of `SessionProjectionRegistry` the policy reader touches. */
interface SessionProjectionRegistryLike {
  stateOf(session: unknown, key: string): unknown
  register(definition: unknown): () => void
}

/**
 * The registry behind `ctx.sessionProjections`, or `undefined` when the
 * service is absent/malformed on this profile. `sessionProjections` is NOT a
 * declared Context key in the installed type universe (see {@link inject}),
 * so this probe is the only read path.
 */
export function probeSessionProjections(rawCtx: unknown): SessionProjectionRegistryLike | undefined {
  try {
    const service = lookupService(rawCtx, 'sessionProjections')
    if (service === null || typeof service !== 'object') return undefined
    const candidate = service as { stateOf?: unknown; register?: unknown }
    if (typeof candidate.stateOf !== 'function' || typeof candidate.register !== 'function') return undefined
    return service as SessionProjectionRegistryLike
  } catch {
    return undefined
  }
}

/**
 * The `ctx.skills` registry (`@deepseek-ai/dsh-skill`'s `SkillRegistry`),
 * or `undefined` when the service is absent/malformed on this profile.
 * Probed through {@link lookupService} for the same reason every sibling is
 * (see {@link inject}): a hard `inject` entry would make the plugin a
 * fiber-blocking REQUIREMENT consumer of a service the headless profile
 * does not compose, and the skill must degrade to the file copy there —
 * never block the mount. The member check (`registerProvider` is a
 * function) is the same proof {@link probeLlmRuntime} demands: a truthy
 * service that cannot register providers is not a registry, and treating it
 * as one would silently skip the file copy with nothing published instead.
 */
export function probeSkillRegistry(rawCtx: unknown): SkillRegistryLike | undefined {
  try {
    const registry = lookupService(rawCtx, 'skills')
    if (registry === null || typeof registry !== 'object') return undefined
    if (typeof (registry as { registerProvider?: unknown }).registerProvider !== 'function') return undefined
    return registry as SkillRegistryLike
  } catch {
    return undefined
  }
}

/** The projection key and session event the durable model-selection policy lives behind (upstream names, mirrored). */
const MODEL_SELECTION_POLICY_KEY = 'subagentModelSelectionPolicy'
const MODEL_SELECTION_POLICY_EVENT = 'subagent/model-selection-policy'

/**
 * Whether a value is a policy route list: non-empty entries of non-empty
 * `{provider, model}` and nothing else. A structural mirror of upstream's
 * `assertAllowedModelRoutes` + the zod state schema
 * (`packages/subagent/tool-subagent/src/model-selection-state.ts`, read
 * 2026-10-07) — NOTHING is imported from a dsh package.
 */
function validPolicyRoutes(value: unknown): value is readonly { provider: string; model: string }[] {
  if (!Array.isArray(value) || value.length === 0) return false
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false
    const route = entry as Record<string, unknown>
    if (Object.keys(route).some(key => key !== 'provider' && key !== 'model')) return false
    if (typeof route.provider !== 'string' || route.provider.length === 0) return false
    if (typeof route.model !== 'string' || route.model.length === 0) return false
  }
  return true
}

/**
 * GAH's own projection over the durable `subagent/model-selection-policy`
 * event, registered ONLY when the key is not already served — the shape
 * mirrors upstream's `subagentModelSelectionProjectionDefinition` structurally
 * (same key, same `stateVersion: 1`, write-once apply, non-empty strict
 * routes; `stateSchema.parse` mirrors zod's parse-or-throw over restored
 * cache rows). Same key + same version means a later native registration
 * MERGES with ours by ref-count instead of conflicting.
 */
const MIRROR_MODEL_SELECTION_PROJECTION = {
  key: MODEL_SELECTION_POLICY_KEY,
  stateVersion: 1,
  stateSchema: {
    parse(value: unknown): unknown {
      if (value === null) return null
      if (!validPolicyRoutes(value)) {
        throw new Error(`${MODEL_SELECTION_POLICY_KEY}: persisted state must be null or a non-empty array of {provider, model} routes`)
      }
      return value
    },
  },
  init: () => null,
  apply: (state: unknown, event: { readonly type: string; readonly data: unknown }) => {
    if (state !== null || event.type !== MODEL_SELECTION_POLICY_EVENT) return state
    const data = event.data as { allowedModels?: unknown } | undefined
    const routes = data?.allowedModels
    if (!validPolicyRoutes(routes)) {
      throw new Error(`${MODEL_SELECTION_POLICY_EVENT} requires at least one non-empty {provider, model} route`)
    }
    return routes.map((route: { provider: string; model: string }) => ({ provider: route.provider, model: route.model }))
  },
}

/** What {@link createRoutingWiring} built, for the engine and the lifecycle. */
export interface RoutingWiring {
  readonly ports: RoutingPorts
  /**
   * F3 (PR #2 Codex review): settles when the late-bound planner installer
   * import has resolved OR irrecoverably failed — never rejects. `apply()`
   * AWAITS this before constructing the engine, so the engine is never
   * exposed before the installer port is known: a run entering planning at
   * cold mount can no longer record `plannerRouting: 'unsupported'` because
   * the dynamic import had not settled yet (the fire-and-forget race).
   * Direct constructor callers (tests) that never await it keep the previous
   * semantics — the port simply appears when the import lands.
   */
  readonly installerReady: Promise<void>
  /**
   * The session policy KIND for one agent's session, read through the SAME
   * reader the engine authorizes with. The M5 onboarding notice needs it:
   * `absent`/`unreachable` means the ladder selects nothing in this session,
   * and a notice about unreachable models that stayed silent about that would
   * read as if autonomous selection were live.
   */
  readonly policyStateFor: (root: { session: unknown }) => SessionPolicyState['kind']
  /** Releases the mirror projection registration and the adapters-updated subscription. */
  dispose: () => void
}

/** The host's `installModelSelection` as this plugin may call it (M6). */
type HostModelSelectionInstall = (
  agentCtx: unknown,
  selection: {
    current: { provider: string; model: string; reasoningEffort?: string } | undefined
    assembled: unknown
  },
) => () => void

/**
 * Build the engine's routing ports from what the mount can actually SEE:
 *
 * - `catalog` from probed `ctx.llm` (absent ⇒ NO catalog port ⇒ the engine's
 *   0.2.0/inherit parity path, not an empty-but-present catalog that would
 *   escalate every locked route); `llm/adapters-updated` (payload-free by
 *   design) drops the snapshot cache, whose disposers ride the plugin lifecycle.
 * - `policyReader` from probed `ctx.sessionProjections`: `stateOf` on
 *   `'subagentModelSelectionPolicy'`; when the key is not registered (the
 *   subagent tool package is not composed on this profile), GAH registers its
 *   own structurally-mirrored projection over the same durable event. A
 *   service that is absent, fails to register, or answers unreadably is
 *   `'unreachable'` — inheritance only, recorded honestly.
 * - `modelSelectionInstaller` (M6) from the host's own `installModelSelection`
 *   export, late-bound by DYNAMIC import (see the wiring below); absence of
 *   the export leaves the port `undefined` and the engine records the
 *   degradation only when a non-inherit planner decision makes it matter.
 *   F3 (PR #2 Codex review): the import is AWAITED during mount through the
 *   returned `installerReady` promise, so a run entering planning at cold
 *   mount finds the port already resolved (or honestly `undefined`) — the
 *   fire-and-forget race that could permanently record `unsupported` for a
 *   healthy host is closed at the only place ordering is enforceable.
 */
export function createRoutingWiring(rawCtx: unknown, onWarn: (message: string) => void = () => {}): RoutingWiring {
  const llm = probeLlmRuntime(rawCtx)
  const catalog = llm === undefined ? undefined : new RouteCatalog(llm)
  const projections = probeSessionProjections(rawCtx)
  const disposers: Array<() => void> = []
  if (catalog !== undefined && llm !== undefined) {
    try {
      disposers.push(
        (rawCtx as { on?: (event: string, listener: () => void) => () => void }).on?.('llm/adapters-updated', () => {
          catalog.invalidate()
        }) ?? (() => {}),
      )
    } catch {
      // A host that cannot be subscribed keeps its cached catalog — recorded
      // by the projection's own diagnostics, never by a crash at mount.
    }
  }
  let mirrorRegistered = false
  let warnedUnreachable = false
  const policyReader = (root: AgentRef): SessionPolicyState => {
    if (projections === undefined) return { kind: 'unreachable' }
    try {
      const session = root.session
      let state = projections.stateOf(session, MODEL_SELECTION_POLICY_KEY)
      if (state === undefined && !mirrorRegistered) {
        mirrorRegistered = true
        try {
          disposers.push(projections.register(MIRROR_MODEL_SELECTION_PROJECTION))
        } catch (error) {
          onWarn(`dsh-autopilot: could not register the model-selection policy projection (${describeError(error)}); treating the policy as unreachable`)
        }
        state = projections.stateOf(session, MODEL_SELECTION_POLICY_KEY)
      }
      if (state === undefined) {
        if (!warnedUnreachable) {
          warnedUnreachable = true
          onWarn('dsh-autopilot: sessionProjections answered no state for subagentModelSelectionPolicy; treating the policy as unreachable')
        }
        return { kind: 'unreachable' }
      }
      if (state === null) return { kind: 'absent' }
      if (validPolicyRoutes(state)) {
        return { kind: 'present', routes: state.map((route: { provider: string; model: string }) => ({ provider: route.provider, model: route.model })) }
      }
      return { kind: 'unreachable' }
    } catch {
      return { kind: 'unreachable' }
    }
  }
  const ports: {
    catalog?: RouteCatalog
    policyReader?: (root: AgentRef) => SessionPolicyState
    modelSelectionInstaller?: RoutingPorts['modelSelectionInstaller']
  } = {
    ...(catalog === undefined ? {} : { catalog }),
    policyReader,
  }
  // M6 planner install port (engine-local role routing): the host's
  // `installModelSelection`, late-bound by DYNAMIC import — never a static
  // import, because this plugin must keep mounting on hosts whose package
  // graph resolves differently from its own declared dependencies (the
  // plugin runs INSIDE the host process, so the host's own copy answers).
  // Absence of the export, or an unresolvable module, leaves the port
  // `undefined` — the engine then records `plannerRouting: 'unsupported'`
  // and continues with inheritance; the mount NEVER fails over this.
  //
  // F3 (PR #2 Codex review): the promise is RETURNED as `installerReady` and
  // `apply()` awaits it BEFORE constructing the engine. It used to be
  // fire-and-forget (`void import(...)`), and a run entering planning before
  // it settled recorded `plannerRouting: 'unsupported'` — never retried
  // within the planning phase — on a perfectly healthy host; awaiting the
  // port at mount is the decided fix (the alternative, re-arming planner
  // selections when the installer arrives, would have to un-write the
  // already-recorded `unsupported` state, which is exactly the kind of
  // record-rewriting this repository refuses).
  const installerReady: Promise<void> = import('@deepseek-ai/dsh-agent').then((module) => {
    const install = (module as { installModelSelection?: unknown }).installModelSelection as HostModelSelectionInstall | undefined
    if (typeof install !== 'function') return
    ports.modelSelectionInstaller = (agentCtx, route) => {
      // The host contract wants a MUTABLE selection ref the caller owns:
      // `current` is the planner route for every step that enters prompt
      // assembly while the install is live. The returned disposer is wrapped
      // so clearing the selection rides the engine's dispose too.
      const selection: {
        current: { provider: string; model: string; reasoningEffort?: string } | undefined
        assembled: unknown
      } = {
        current: {
          provider: route.provider,
          model: route.model,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
        },
        assembled: undefined,
      }
      const hostDispose = install(agentCtx, selection)
      return () => {
        selection.current = undefined
        hostDispose()
      }
    }
  }, () => {
    // Not resolvable from this plugin's location on this deployment — the
    // normal shape for a host profile without the agent package above it.
    // The degradation is recorded by the engine ('unsupported') exactly
    // when a non-inherit planner decision makes it matter, not here.
  })
  return {
    ports,
    installerReady,
    /**
     * The rendering session's policy KIND, for the M5 onboarding notice: the
     * same reader the engine authorizes with, so the notice and the dispatch
     * can never disagree about whether this session can select at all.
     */
    policyStateFor: (root: { session: unknown }): SessionPolicyState['kind'] => policyReader(root as AgentRef).kind,
    dispose: () => {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch {
          // A disposer that throws on teardown must not block its siblings.
        }
      }
    },
  }
}

/**
 * What {@link resolveStore} chose, and what it opened.
 *
 * The domain is opened AT MOST ONCE: upstream `DomainFacility.open` refuses a
 * name that is already open, so the legacy reader and the ledger migration share
 * one handle, and `close` releases it exactly once.
 */
export interface StoreResolution {
  /** Where ledgers are written: always one file per root session under `<root>/ledgers/`. */
  readonly ledgers: LedgerStoreLike
  /** Where the frozen legacy reader looks: the file root AND the domain when there is one, always. */
  readonly sources: LegacySources
  /** Why the domain could not be read (legacy history and ledger migration), when a facility was expected to give it. */
  readonly degraded?: string
  /** Release what was opened. Idempotent. */
  readonly close: () => Promise<void>
}

/** No facility on this deployment at all, the expected headless shape. */
const NO_FACILITY_REASON = 'ctx.storageDomain is not observable on this deployment (it is mounted by the web-app bundle only)'

/**
 * Open the ledger store and the legacy sources.
 *
 * Ledgers always go to `<root>/ledgers/<id>.json`. The domain is still opened
 * when the host mounts one, READ-ONLY: its `events`/`runs` tables are legacy
 * history, and its `ledgers` table is what earlier 0.3.0 builds wrote, migrated
 * to files on first load of each session. The host's JSON backend keeps the whole
 * domain in one file that each process republishes on any put, so writing it from
 * two processes lost rows; nothing here writes it any more. A facility that is
 * present but cannot open says why in `degraded`; the ledgers are unaffected.
 */
export async function resolveStore(rawCtx: unknown, root: string): Promise<StoreResolution> {
  const facility = probeStorageDomain(rawCtx)
  let domain: DomainLike | undefined
  let degraded: string | undefined
  if (facility === undefined) {
    degraded = NO_FACILITY_REASON
  } else {
    try {
      domain = await facility.open(AUTOPILOT_DOMAIN_SPEC)
    } catch (error: unknown) {
      degraded = `ctx.storageDomain.open() threw: ${describeError(error)}`
    }
  }
  const sources = legacySourcesOf(root, domain === undefined ? undefined : legacyDomainReaderOf(domain))
  let closed = false
  const close = async (): Promise<void> => {
    if (closed || domain === undefined) return
    closed = true
    await domain.close()
  }
  let migrateFrom: KvTableLike | undefined
  if (domain !== undefined) {
    try { migrateFrom = domain.table(LEDGERS_TABLE) } catch { migrateFrom = undefined }
  }
  const ledgers = FileLedgerStore.open(root, migrateFrom === undefined ? {} : { migrateFrom })
  return { ledgers, sources, ...(degraded === undefined ? {} : { degraded }), close }
}

/**
 * Cordis plugin apply.
 *
 * ASYNC ON PURPOSE: the returned promise holds the fiber's `inertia` open, and
 * every seam that waits on a fiber (`loader.await()`, `boot()`'s activation
 * check, the headless runner creating its first Agent) therefore waits for the
 * ledger store to open. Registering the surface synchronously and letting the
 * store land behind it would let a root session be admitted with half a plugin;
 * a store that cannot open rejects `apply` and fails the mount instead (the
 * fiber goes FAILED and `boot()` refuses to start). Exactly one store instance
 * ever exists per mount.
 */
export async function apply(rawCtx: unknown, config?: ConfigInput): Promise<() => Promise<void>> {
  const ctx = rawCtx as PluginContext
  const resolved = resolveConfig(config)

  const resolution = await resolveStore(
    rawCtx,
    config?.storeRoot !== undefined && config.storeRoot.length > 0 ? config.storeRoot : defaultStoreRoot(),
  )
  // A deployment with no storage-domain facility at all is the expected headless shape and says
  // nothing (`ctx.autopilot.storeKind` already reads "file"). A facility that is present but cannot
  // open is a real degrade, and only the thrown reason tells the two apart afterwards.
  if (resolution.degraded !== undefined && probeStorageDomain(rawCtx) !== undefined) {
    warn(rawCtx, `dsh-autopilot: legacy history and ledger migration from the storage domain are unavailable: ${resolution.degraded}`)
  }

  // Retired settings are accepted and ignored; say so once, here and on the status surfaces.
  const retiredKeys = retiredKeysIn(config)
  const retiredNote = retiredConfigNote(retiredKeys)
  if (retiredNote !== undefined) warn(rawCtx, retiredNote)

  // EVERY registration below can throw, and until the disposer exists nothing
  // releases the domain. Upstream `DomainFacility.open` refuses a name that is
  // already open, so a partial mount that never closed would leave the domain
  // reserved for the life of the process and every later mount would quietly fall
  // back to files. The failure path therefore closes what it opened and rethrows
  // the original error unchanged. The routing wiring is part of "what it opened":
  // once `createRoutingWiring` has subscribed `llm/adapters-updated`, a later
  // throw would leave that listener behind and every retry would stack another.
  let wiringForFailure: RoutingWiring | undefined
  let onboardingRefreshForFailure: (() => void) | undefined
  let goalListenersForFailure: (() => void) | undefined
  try {
    const routing = createRoutingWiring(rawCtx, message => warn(rawCtx, message))
    // The setting is read per dispatch; an unreadable one is warned once, not per call.
    let settingWarned = false
    const warnSettingOnce = (message: string): void => {
      if (settingWarned) return
      settingWarned = true
      warn(rawCtx, message)
    }
    wiringForFailure = routing
    // The planner installer port is a dynamic import away; settle it here so the
    // engine is never exposed before it is known. The promise never rejects.
    await routing.installerReady
    // Hoisted so the onboarding section below reads the SAME live routing the
    // engine re-resolves per decision (volatile leaves, HMR applies).
    const liveRouting = volatileRoutingAccess(config)
    const engine = new AutopilotEngine(
      ctx.agents as never,
      ctx.subagents as never,
      resolution.ledgers,
      resolution.sources,
      resolved,
      {
        routing: routing.ports,
        ...(liveRouting === undefined ? {} : { liveRouting }),
        environment: {
          sandboxDefaultMode: () => sandboxDefaultModeOf(rawCtx),
          registeredToolNames: scope => registeredToolNamesOf(rawCtx, scope),
          subagentMaxDepth: () => subagentMaxDepthOf(rawCtx),
          modelSelection: () => modelSelectionSettingOf(rawCtx, warnSettingOnce),
          readGoal: root => readNativeGoal(rawCtx, root),
          goalDriverPresent: () => goalDriverPresentIn(rawCtx),
        },
        warn: message => warn(rawCtx, message),
      },
    )

    // ── Policy prompt section (zero tokens unless a host restart lost children) ──
    const disposeSection = ctx.systemPrompt.section({
      name: 'autopilot:policy',
      order: 60,
      text: (context) => {
        const agent = context.agent
        if (agent === undefined) return ''
        if (agent.session.header.parentSession !== undefined) return ''
        return renderRootPolicy(engine.peekLedger(agent.id))
      },
    })

    // ── Routing onboarding section (DESIGN §9 item 12) ────────────────────
    // Zero tokens unless the LIVE catalog lists models no tier-bound work class
    // can reach. The report is cached at mount and on `llm/adapters-updated`, and
    // revalidated stale-by-one when a rendered notice fires: the sync renderer
    // cannot await a catalog read.
    let onboardingReport: WorkClassReachabilityReport | undefined
    const refreshOnboarding = (): void => {
      const catalog = routing.ports.catalog
      if (catalog === undefined) {
        onboardingReport = undefined
        return
      }
      const current = liveRouting?.() ?? resolved.routing
      void observeOnboardingReachability(catalog, current.ladder, current.workClasses)
        .then((report) => { onboardingReport = report })
    }
    refreshOnboarding()
    let disposeOnboardingRefresh: () => void = () => {}
    try {
      disposeOnboardingRefresh =
        (rawCtx as { on?: (event: string, listener: () => void) => () => void }).on?.('llm/adapters-updated', () => {
          refreshOnboarding()
        }) ?? (() => {})
      onboardingRefreshForFailure = disposeOnboardingRefresh
    } catch {
      // A host that cannot be subscribed keeps the mount-time reading only.
    }
    const disposeOnboardingSection = ctx.systemPrompt.section({
      name: 'autopilot:routing-onboarding',
      order: 61,
      text: (context) => {
        const agent = context.agent
        if (agent === undefined) return ''
        if (agent.session.header.parentSession !== undefined) return ''
        const current = liveRouting?.() ?? resolved.routing
        const text = renderRoutingOnboarding({
          mode: current.mode,
          report: onboardingReport,
          configEditorAvailable: probeConfigEditor(rawCtx),
          // The same reader the engine authorizes with, for THIS rendering
          // agent: a policy-less session selects nothing, and the notice says so.
          policyState: routing.policyStateFor({ session: agent.session } as AgentRef),
        })
        if (text !== '') refreshOnboarding()
        return text
      },
    })

    // ── Read-only service surface ─────────────────────────────────────────
    const service = createAutopilotService({
      ledgers: resolution.ledgers,
      sources: resolution.sources,
      notes: () => (retiredNote === undefined ? [] : [retiredNote]),
      retiredKeys: () => retiredKeys,
      // A goal-only session (create_goal, no autopilot_* call) has no ledger until its goal is mirrored.
      syncSession: async (sessionId) => {
        const live = ctx.agents.roots().find(agent => (agent as AgentRef).id === sessionId)
        if (live !== undefined) await engine.syncGoal(live as AgentRef)
      },
    })
    const registration = registerAutopilotService(rawCtx as ProvideHost, service)
    if (!registration.registered && registration.diagnostic !== undefined) {
      warn(rawCtx, `dsh-autopilot: ${registration.diagnostic}`)
    }

    // ── Read-only HTTP surface ────────────────────────────────────────────
    // Lazy: `installAutopilotRoutes` goes through `ctx.inject(['webServer'], …)`,
    // so on a profile with no api-gateway the callback never runs.
    const disposeRoutes = installAutopilotRoutes(rawCtx, service)

    // ── Per-root surface: the status tool, and the session-open work ─────────
    const installed = new Map<unknown, () => void>()
    /** Install the root tool surface on a top-level agent, once. */
    const installRoot = (agent: unknown): boolean => {
      const rootAgent = agent as AgentRef & { ctx: { tools: { register(d: unknown): () => void } } }
      if (installed.has(agent)) return true
      if (rootAgent.session.header.parentSession !== undefined) return false
      if (!ctx.agents.roots().includes(agent)) return false
      try {
        installed.set(agent, installRootTools(rootAgent.ctx.tools, service, engine))
      } catch (error: unknown) {
        warn(rawCtx, `dsh-autopilot: the root tool surface failed to install for ${rootAgent.id}: ${errorMessage(error)}`)
        return false
      }
      return true
    }

    // Roots already live at mount are open sessions: install on them and run the
    // per-session open work (lost marking, legacy link, lazy restore). Never bulk:
    // sessions that are not open are not touched.
    for (const agent of ctx.agents.list()) {
      if (installRoot(agent)) await engine.onRootOpened(agent as AgentRef)
    }
    // `agent/created` is announced for EVERY agent, after setup and before the first
    // prompt, through a serial dispatch the host awaits: so the restore lands before
    // the first request, and a listener that threw would veto the agent's
    // publication. Hence `onRootOpened` never rejects. A child agent is the opposite case:
    // its restriction must fail closed.
    const disposeCreated = ctx.on('agent/created', async (payload: { agent: unknown }) => {
      const agent = payload.agent as AgentRef
      if (agent.session?.header?.parentSession !== undefined) {
        // A child: its tool allow-list and own tools, keyed by ITS id. A throw here is deliberate: it
        // vetoes the child's publication (fail closed), and the delegation is recorded as failed.
        engine.onChildCreated(agent)
        return
      }
      if (installRoot(payload.agent)) await engine.onRootOpened(agent)
    })
    // ── Native goal changes: mirror them now, not at the next route read ──
    // dsh-goal emits `goal/changed` (agent-scoped, after the `goal/change` session
    // event committed) for every accepted mutation, and app-level
    // `goal/activation-changed` when a round arms or disarms. Only a ROOT's goal is
    // mirrored: a child's would create a ledger keyed by the child id. `syncGoal`
    // never rejects; route reads still sync too.
    const onGoalEvent = (rawCtx as { on?: (event: string, listener: (payload: unknown) => void) => () => void }).on
    const syncRootGoal = (agent: unknown): void => {
      const candidate = agent as AgentRef | undefined
      if (candidate === undefined || candidate.session?.header?.parentSession !== undefined) return
      if (!ctx.agents.roots().includes(agent)) return
      void engine.syncGoal(candidate)
    }
    let disposeGoalChanged: () => void = () => {}
    let disposeGoalActivation: () => void = () => {}
    try {
      disposeGoalChanged = onGoalEvent?.call(rawCtx, 'goal/changed', (payload) => {
        syncRootGoal((payload as { agent?: unknown } | undefined)?.agent)
      }) ?? (() => {})
      disposeGoalActivation = onGoalEvent?.call(rawCtx, 'goal/activation-changed', (payload) => {
        const sessionId = (payload as { sessionId?: unknown } | undefined)?.sessionId
        if (typeof sessionId !== 'string') return
        syncRootGoal(ctx.agents.roots().find(agent => (agent as AgentRef).id === sessionId))
      }) ?? (() => {})
    } catch {
      // A host that cannot be subscribed keeps the open-time and route-read syncs.
    }
    goalListenersForFailure = () => { disposeGoalChanged(); disposeGoalActivation() }

    const disposeDisposed = ctx.on('agent/disposed', (payload: { agent: unknown }) => {
      installed.get(payload.agent)?.()
      installed.delete(payload.agent)
      const agent = payload.agent as AgentRef
      if (agent.session?.header?.parentSession !== undefined) engine.onChildDisposed(agent)
    })

    // ── Bundled-skill publication: native registry first, file fallback ───
    //
    // Best-effort, after every required registration succeeded, so a failed mount
    // persists nothing. Exactly one channel is ever active:
    // - `ctx.skills` PROBED (never injected; see {@link probeSkillRegistry}) and
    //   present: `registerProvider` serves the in-package SKILL.md with no
    //   filesystem copy; rank 700 loses to every file-scan rank, so an installed or
    //   drifted file copy still wins the name (the anti-silent-override rule).
    // - registration THREW: the filesystem copy runs instead, the failure warned.
    // - no skill service on this profile: the unchanged filesystem path.
    // - `skillInstall: 'off'`: neither channel.
    let disposeSkillProvider: (() => void) | undefined
    if (resolved.skillInstall !== 'off') {
      const publication: SkillPublicationResult = publishBundledSkill(probeSkillRegistry(rawCtx))
      if (publication.status === 'provider-registered') {
        disposeSkillProvider = publication.dispose
        info(
          rawCtx,
          `dsh-autopilot: bundled skill published through the native skill registry (provider "${BUNDLED_SKILL_PROVIDER_NAME}", rank ${BUNDLED_SKILL_PROVIDER_RANK}; serving ${publication.path}); no filesystem copy was made`,
        )
      } else {
        if (publication.status === 'provider-failed-fallback') {
          warn(
            rawCtx,
            `dsh-autopilot: native skill registration failed (${publication.failure}); fell back to the filesystem skill copy`,
          )
        }
        const skill: SkillSyncResult = publication.status === 'provider-failed-fallback' ? publication.fallback : publication
        if (skill.status === 'drift' || skill.status === 'error' || skill.status === 'unsupported') {
          warn(
            rawCtx,
            `dsh-autopilot: skill install ${skill.status}${skill.detail !== undefined ? `: ${skill.detail}` : ''}`,
          )
        }
      }
    }

    return async () => {
      disposeSection()
      disposeOnboardingSection()
      disposeOnboardingRefresh()
      registration.dispose()
      disposeRoutes()
      routing.dispose()
      disposeSkillProvider?.()
      disposeCreated()
      disposeDisposed()
      disposeGoalChanged()
      disposeGoalActivation()
      for (const dispose of installed.values()) dispose()
      installed.clear()
      // Async tail: dispose waits (bounded) for in-flight session opens and ledger writes.
      await engine.dispose()
      await resolution.close()
    }
  } catch (error: unknown) {
    // Release the wiring's host-surface registrations BEFORE the rethrow, alongside
    // the domain close. The disposer is idempotent and swallows each inner
    // disposer's throw; the catch below only guards against the loop itself failing,
    // so teardown can never mask the error that caused the unwind.
    try {
      wiringForFailure?.dispose()
      onboardingRefreshForFailure?.()
      goalListenersForFailure?.()
    } catch {
      // A wiring teardown failure must not mask the original error.
    }
    try {
      await resolution.close()
    } catch {
      // A failing close must not mask the error that caused the unwind.
    }
    throw error
  }
}
