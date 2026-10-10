/**
 * dsh-autopilot plugin entry.
 *
 * One Cordis plugin that composes:
 * - the AutopilotEngine (event-sourced run state machine over a chosen store)
 * - per-root controller tools + tool guard + turn-stop reminder
 * - the native egress seam (tools/pre-execute + tools/execute) with the
 *   synchronous guard as its fail-closed fallback
 * - the autopilot:policy prompt section (root and executor-child flavors)
 * - the executor-child packet tool + guard (continuable setup)
 * - the read-only `ctx.autopilot` service
 *
 * Config (all optional; the declared schema is `./config.js`):
 *   auditProvider / executorProvider: subagent transport provider (default 'spawn')
 *   auditors: { plan|execution|rules: { provider?, agentOptions? { provider, model, maxTokens? } } }
 *   executor: { agentOptions?, persona?, toolAllowList? }
 *   crossFamily: { enabled?, minRisk?, pool? } — seek an auditor outside the executor's family
 *   routing: { mode? auto|off, preference? balanced|economy|quality, roles? { executor, planner,
 *             planAuditor, executionAuditor, rulesAuditor: { mode? auto|inherit|locked,
 *             lock? { provider, model, reasoningEffort? }, minContext? } } } — role-true model routing
 *   gate: { sandboxCoupling?, toolDeny?, egressDeny?, stopReminder?, strictShell?, restoreMode? }
 *   storeKind: 'auto' | 'file' | 'domain' (default 'auto')
 *   storeRoot: run directory root (default $DSH_HOME/storages/dsh-autopilot)
 *   skillInstall: 'auto' | 'off' (default 'auto') — publish the bundled SKILL.md through the
 *               native skill registry (ctx.skills) when that service is present, else copy it
 *               into the skill-scan root; 'off' publishes through neither channel
 */

import { AutopilotEngine } from './engine.js'
import type { AgentOptionsLike, AgentRef, EnvironmentProbes, ResolvedConfig, ResolvedCostOverride, ResolvedLadder, ResolvedRouting, RoutingPorts } from './engine.js'
import { installChildEgressGuard, installRootGate } from './gate/install.js'
import type { GateAgentRef } from './gate/install.js'
import { installPreExecuteGate } from './gate/preexecute.js'
import type { PreExecuteHost } from './gate/preexecute.js'
import { renderExecutorPolicy, renderRootPolicy } from './policy.js'
import { createAutopilotService, registerAutopilotService } from './service.js'
import { installAutopilotRoutes } from './web.js'
import type { ProvideHost } from './service.js'
import { RunStore, defaultStoreRoot } from './store/file.js'
import { DomainRunStore } from './store/domain.js'
import type { DomainFacilityLike } from './store/domain.js'
import type { RunStoreLike } from './store/types.js'
import { installRootTools, packetToolDefinition } from './tools.js'
import { DEFAULT_EXECUTOR_TOOLS } from './config.js'
import { BUNDLED_SKILL_PROVIDER_NAME, BUNDLED_SKILL_PROVIDER_RANK, publishBundledSkill } from './skill-register.js'
import type { SkillPublicationResult, SkillRegistryLike } from './skill-register.js'
import type { SkillSyncResult } from './skill-install.js'
import { DEFAULT_ROLE_MIN_CONTEXT } from './routing/select.js'
import type { Role, RoleRouting, RoutePreference } from './routing/select.js'
import { toRoutePin } from './routing/identity.js'
import { RouteCatalog } from './routing/catalog.js'
import type { LlmRuntimeSubset } from './routing/catalog.js'
import type { SessionPolicyState } from './routing/authorize.js'
import type { AuditRole, EgressChannel, StoreKind, Risk } from './domain/types.js'

export * from './domain/types.js'
export { foldRun, applyEvent } from './domain/fold.js'
export {
  USAGE_UNDECLARED_ENTRY,
  hasFormatSignature,
  settleUsageArtifacts,
  usageDeclarationProblems,
  validateUsageEntry,
} from './domain/usage.js'
export type { SettleUsageOptions, UsageArtifactRead } from './domain/usage.js'
export { AutopilotEngine, approvalAuthorizes, effectiveSandboxMode, routeRoleOf } from './engine.js'
export type { EnvironmentProbes, ResolvedConfig, ResolvedRouting, RoutingPorts, StatusView } from './engine.js'
export { RunStore, defaultStoreRoot } from './store/file.js'
export { AUTOPILOT_DOMAIN_SPEC, DomainRunStore, eventKey, parseEventKey } from './store/domain.js'
export type { DomainFacilityLike } from './store/domain.js'
export type { RunStoreLike } from './store/types.js'
export {
  EGRESS_FAIL_CLOSED_REASON,
  SHELL_TOOLS,
  commandTextOf,
  decideTool,
  egressCommandOf,
  egressSegments,
  isEgressCommand,
} from './gate/decide.js'
export type { GateConfig, GateDecision } from './gate/decide.js'
export { MAX_PENDING_EGRESS_AUTHORIZATIONS, decideEgress, installPreExecuteGate } from './gate/preexecute.js'
export type { PreDecision, PreExecuteHost, PreExecuteOptions } from './gate/preexecute.js'
export {
  archiveConsumed,
  countClaims,
  manifestPath,
  matchesAtTokenBoundary,
  parseManifest,
  validateManifest,
} from './outbound/manifest.js'
export { hasDirectHumanTurn } from './tools.js'
export { renderRootPolicy, renderExecutorPolicy } from './policy.js'
export { createAutopilotService, registerAutopilotService } from './service.js'
export type { AutopilotReadOnly } from './service.js'
export {
  AUTOPILOT_API_PREFIX,
  installAutopilotRoutes,
  makeAutopilotRoutes,
  projectEnforcement,
  projectRun,
  projectRuns,
  queryParam,
} from './web.js'
export type { AutopilotWebRoute, EnforcementProjection, RunProjection, RunsBody } from './web.js'
export { Config, DEFAULT_EXECUTOR_TOOLS, StoreKindSchema } from './config.js'
export type { Role, RoleRouting, RoutePreference } from './routing/select.js'
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
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
  SkillProviderObservation,
  SkillPublicationResult,
  SkillRegistryLike,
  SkillResourceBase,
  SkillSource,
  SkillSummary,
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
  readonly gate?: {
    sandboxCoupling?: boolean
    toolDeny?: boolean
    egressDeny?: boolean
    stopReminder?: boolean
    strictShell?: boolean
    restoreMode?: string
  }
  /** Which backend holds the canonical event stream; 'auto' probes for ctx.storageDomain. */
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
  /**
   * Governance pragmatics knobs (governance pragmatics v1), all optional:
   * `maxAuditRoundsPerRole` refuses further same-role audit dispatches beyond
   * the cap (AP_AUDIT_ROUND_CAP) — a brake on audit storms that never
   * escalates to the owner on its own.
   */
  readonly governance?: {
    readonly maxAuditRoundsPerRole?: number
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
}

/** The `routing` section as a profile may write it. */
export interface RoutingInput {
  readonly mode?: 'auto' | 'off'
  readonly preference?: 'balanced' | 'economy' | 'quality' | 'axis'
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
    readonly speedOrder?: readonly string[]
    readonly costOverrides?: readonly string[]
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
function resolveRouting(input?: ConfigInput): ResolvedRouting {
  const routing = input?.routing
  const mode = readSetting(routing?.mode) ?? 'auto'
  const preference = readSetting(routing?.preference) ?? 'balanced'
  if (mode !== 'auto' && mode !== 'off') throw new Error(`routing.mode must be 'auto' or 'off' (got ${JSON.stringify(mode)})`)
  if (preference !== 'balanced' && preference !== 'economy' && preference !== 'quality' && preference !== 'axis') {
    throw new Error(`routing.preference must be 'balanced', 'economy', 'quality' or 'axis' (got ${JSON.stringify(preference)})`)
  }
  const roles = {} as Record<Role, RoleRouting>
  for (const key of ROLE_CONFIG_KEYS) {
    const role = ROLE_OF[key]
    const entry = readSetting(routing?.roles?.[key])
    const entryMode = readSetting(entry?.mode)
    const lockRoute = lockRouteOf(readSetting(entry?.lock))
    const minContext = readSetting(entry?.minContext)
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
    roles[role] = { mode: 'auto', minContext: minContext ?? DEFAULT_ROLE_MIN_CONTEXT[role] }
  }
  return { mode, preference, roles, ladder: resolveLadder(input) }
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
    speedOrder: ladderList(readSetting(raw?.speedOrder)),
    costOverrides: ladderList(readSetting(raw?.costOverrides)).map(parseCostOverride),
  }
}

/** Resolve raw config with defaults (manual, defensive — the schema governs writes, this governs reads). */
export function resolveConfig(input?: ConfigInput): ResolvedConfig {
  const executorAgentOptions = presentOrAbsent(input?.executor?.agentOptions)
  return {
    auditProvider: input?.auditProvider ?? 'spawn',
    executorProvider: input?.executorProvider ?? 'spawn',
    auditors: compactAuditors(input?.auditors),
    executor: {
      ...(executorAgentOptions === undefined ? {} : { agentOptions: executorAgentOptions }),
      persona: input?.executor?.persona ?? '',
      toolAllowList: [...(input?.executor?.toolAllowList ?? DEFAULT_EXECUTOR_TOOLS)],
    },
    crossFamily: {
      enabled: input?.crossFamily?.enabled ?? true,
      minRisk: input?.crossFamily?.minRisk ?? 'medium',
      pool: [...(input?.crossFamily?.pool ?? [])],
    },
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
    // governance?.maxAuditRoundsPerRole and treats absent as off).
    governance: {
      ...(input?.governance?.maxAuditRoundsPerRole === undefined
        ? {}
        : { maxAuditRoundsPerRole: input.governance.maxAuditRoundsPerRole }),
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
  /**
   * dsh 0.1.2 removed `registerContinuableSetup` (the activation-setup
   * registry is gone; child composition is owned by the subagent manager's
   * private `setup` callback). The plugin reaches a child's scope through
   * `agent/created` instead — see the executor-child block in `apply`.
   */
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
 * Bearer for the enforcement 'active' claim: BOTH the confine provider
 * ('sandbox') and the policy service ('sandboxPolicy') must be observable on
 * the context — mode events fold through sandboxPolicy, and shell consumers
 * confine argv through sandbox, so read-only holds only when both exist.
 * Any probe failure reads as unavailable (degraded, honest).
 */
export function probeSandbox(rawCtx: unknown): boolean {
  try {
    const confine = lookupService(rawCtx, 'sandbox')
    const policy = lookupService(rawCtx, 'sandboxPolicy')
    return confine !== undefined && confine !== null && policy !== undefined && policy !== null
  } catch {
    return false
  }
}

/**
 * The event the approval service waterfalls to reach its answerers
 * (`packages/interaction/user-approval/src/index.ts`: `ctx.waterfall(…,
 * 'approval/request', req, () => 'unavailable')`). With NO listener registered
 * under this name the waterfall falls straight through to its fail-closed
 * default, so every ask on that deployment resolves 'unavailable'.
 */
const APPROVAL_REQUEST_EVENT = 'approval/request'

/**
 * The deployment default policy under which the service short-circuits every
 * ask to 'rejected' BEFORE dispatching to any answerer (`ApprovalService.decide`).
 * Reachable in a shipped profile, not a hypothetical: the base bundle sets
 * `policy: 'never'` whenever `DSH_PERMISSION_MODE === 'danger-full-access'`
 * (`packages/bundle/base/cordis.patch.yml`).
 */
const NEVER_POLICY = 'never'

/**
 * What the mount can actually SEE about the owner-approval channel.
 *
 * - 'answerable'   — a service is present, its deployment default policy can
 *                    prompt, and at least one answerer is composed.
 * - 'unanswerable' — a service is present but no ask can reach a human: the
 *                    default policy is 'never' (deterministic 'rejected'), or
 *                    the answerer chain is empty (fail-closed 'unavailable').
 * - 'absent'       — no approval service at all.
 *
 * WHY THREE STATES AND NOT THE OLD PRESENCE CHECK. `probeApproval` used to ask
 * only whether the service object was non-null, while both of its siblings
 * ({@link probeSandbox}, {@link probeStorageDomain}) ask whether the service can
 * do its job. Measured on the real host: one run recorded
 * `"approval":"native"` while every `approval/asked` in that same session
 * resolved `{"outcome":"unavailable"}` — the headless profile mounts the service
 * (base bundle) and composes no answerer (no ACP bridge, no api-proxy), so the
 * presence check was structurally unable to be false exactly where the claim was
 * false. That is the pseudo-active defect class DESIGN.md §6 was written about,
 * recurring in a new field after `enforcement.sandbox` already paid for the
 * lesson once.
 *
 * WHAT IS HONESTLY OBSERVABLE FROM HERE, AND WHAT IS NOT. The answerer chain IS
 * inspectable: `_hooks` is a declared field of cordis's `EventsService`
 * (`vendor/cordis/src/events.ts`) holding one array per event name, one
 * `EventsService` instance is shared by the root context and every context
 * extended from it, and every dsh answerer registers through the ordinary
 * `ctx.on('approval/request', …)` (`packages/acp/acp`, `packages/host/apiproxy`)
 * — so an empty entry is positive evidence that no ask can be answered. The
 * deployment default policy IS readable: `ApprovalService` keeps it as a public
 * `config` field. Two things are NOT observable from a bare context and are
 * therefore deliberately not claimed: the SESSION-level override
 * (`effectiveApprovalPolicy` folds the asking session's own log, which this
 * probe never sees) and whether a composed answerer's own scope filter admits
 * the asking agent. 'answerable' states that an ask can REACH an answerer, never
 * that a human will say yes — which is exactly what `Enforcement.approval`
 * claims and no more.
 *
 * Every read is defensive and every failure reads DOWN, so a probe that cannot
 * see cannot upgrade a claim.
 */
export type ApprovalObservation = 'answerable' | 'unanswerable' | 'absent'

/** Whether any listener is composed for {@link APPROVAL_REQUEST_EVENT}. */
function approvalAnswererComposed(rawCtx: unknown): boolean {
  try {
    const events = lookupService(rawCtx, 'events')
    if (events === null || typeof events !== 'object') return false
    const hooks = (events as { _hooks?: unknown })._hooks
    if (hooks === null || typeof hooks !== 'object') return false
    const listeners = (hooks as Record<string, unknown>)[APPROVAL_REQUEST_EVENT]
    return Array.isArray(listeners) && listeners.length > 0
  } catch {
    return false
  }
}

/**
 * Whether the service's DEPLOYMENT DEFAULT policy rejects every ask outright.
 *
 * An unreadable config is NOT treated as 'never': absence of the field is not
 * evidence of the value. The positive evidence this probe requires lives in
 * {@link approvalAnswererComposed}; this function only removes a claim the code
 * can see is false.
 */
function approvalPolicyRejectsEverything(approval: unknown): boolean {
  try {
    const config = (approval as { config?: unknown }).config
    if (config === null || typeof config !== 'object') return false
    return (config as { policy?: unknown }).policy === NEVER_POLICY
  } catch {
    return false
  }
}

/** See {@link ApprovalObservation}. */
export function observeApproval(rawCtx: unknown): ApprovalObservation {
  let approval: unknown
  try {
    approval = lookupService(rawCtx, 'approval')
  } catch {
    return 'absent'
  }
  if (approval === undefined || approval === null) return 'absent'
  if (approvalPolicyRejectsEverything(approval)) return 'unanswerable'
  return approvalAnswererComposed(rawCtx) ? 'answerable' : 'unanswerable'
}

/**
 * Bearer for `Enforcement.approval: 'native'`.
 *
 * BOOLEAN because `EnvironmentProbes.approvalAvailable` — and the two-state
 * `ApprovalChannel` the engine writes from it — is a boolean; the three-state
 * fact is {@link observeApproval}. Both non-'answerable' states collapse to the
 * same recorded value, and that value is TRUE of both: the only owner channel
 * left is the direct-human-turn `autopilot_signal owner-approve`, which is what
 * 'signal-only' names. Distinguishing "no service" from "a service nothing can
 * answer" in the durable record needs a third `ApprovalChannel` member, which
 * lives in `./domain/types.js` and `./engine.js`.
 */
export function probeApproval(rawCtx: unknown): boolean {
  return observeApproval(rawCtx) === 'answerable'
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
 * Which seam is actually enforcing egress, from what was observed — never from
 * what was configured.
 *
 * @param seamInstalled - whether `tools/pre-execute` accepted our listener for
 * the scope being asked about. `undefined` means no root scope has been
 * configured under that name yet, which reads as the less capable value: a run
 * must never record 'native-ask' on the strength of some OTHER scope's seam.
 * @param egressDeny - the owner's master switch.
 */
export function resolveEgressChannel(seamInstalled: boolean | undefined, egressDeny: boolean): EgressChannel {
  if (!egressDeny) return 'off'
  return seamInstalled === true ? 'native-ask' : 'guard-deny'
}

/**
 * What {@link resolveStore} chose and — when 'auto' did not get the domain
 * backend — WHY.
 *
 * The reason exists because `Enforcement.store: 'file'` is ambiguous by
 * construction: it reads identically on a deployment that mounts no
 * `ctx.storageDomain` at all (headless, by design, nothing wrong) and on one
 * that mounts a facility whose `open()` threw (a real degrade an operator needs
 * to know about). The 'auto' branch used to swallow the second case in a bare
 * `catch {}` and record nothing anywhere, so the two were indistinguishable
 * after the fact — and the thrown error, the only thing that said WHAT broke,
 * was discarded at the point it was caught.
 */
export interface StoreResolution {
  /** The backend the run's canonical event stream will use. */
  readonly store: RunStoreLike
  /**
   * Why 'auto' did not get the domain backend. ABSENT when nothing degraded:
   * files were what the operator asked for, or the domain opened.
   */
  readonly degraded?: string
}

/** No facility on this deployment at all — the expected headless shape. */
const NO_FACILITY_REASON = 'ctx.storageDomain is not observable on this deployment (it is mounted by the web-app bundle only)'

/**
 * Choose the store backend.
 *
 * 'domain' is a REQUIREMENT, not a preference: if the operator asked for it
 * and the facility is absent, mounting on files anyway would silently give the
 * deployment a backend it did not ask for. 'auto' is allowed to fall back,
 * because falling back is what 'auto' means — and it now returns WHY alongside
 * the store, so the fallback is visible rather than assumed.
 */
export async function resolveStore(
  rawCtx: unknown,
  kind: StoreKind | 'auto',
  root: string,
): Promise<StoreResolution> {
  if (kind === 'file') return { store: new RunStore(root) }
  const facility = probeStorageDomain(rawCtx)
  if (kind === 'domain') {
    if (facility === undefined) {
      throw new Error(`storeKind "domain" was configured but ${NO_FACILITY_REASON}`)
    }
    return { store: await DomainRunStore.open(facility, undefined, { root }) }
  }
  if (facility === undefined) return { store: new RunStore(root), degraded: NO_FACILITY_REASON }
  try {
    return { store: await DomainRunStore.open(facility, undefined, { root }) }
  } catch (error: unknown) {
    // 'auto' degrades to files; `Enforcement.store` will say 'file', and the
    // reason travels out with the store instead of dying in the catch.
    return {
      store: new RunStore(root),
      degraded: `ctx.storageDomain.open() threw: ${describeError(error)}`,
    }
  }
}

/**
 * The child's own scoped context (`agent.ctx` of the agent announced by
 * `agent/created`; on dsh 0.1.1 the same object reached us through the
 * `registerContinuableSetup` registry).
 *
 * `agent` is declared as an OWN PROPERTY alongside `get`, because that is the
 * shape dsh 0.1.1–0.1.5 produced — see {@link createContinuableChildSetup}.
 * On dsh 0.1.7+ reading it throws (strict inject); see
 * {@link recognizeExecutorChild}, which prefers the announced Agent.
 */
export interface ContinuableChildContext {
  get(name: string): unknown
  agent?: unknown
  tools: {
    register(definition: unknown): () => void
    guard(fn: (execution: { name: string; arguments: unknown }) => string | undefined): () => void
  }
}

/**
 * Build the executor-child setup callback: packet tool + egress guard + native
 * egress seam, bound to the PARENT run.
 *
 * EXTRACTED FROM `apply()` so it has a surface a test can drive. It used to be
 * reachable only through `ctx.subagents.registerContinuableSetup` (dsh 0.1.1;
 * since 0.1.2 `apply()` calls it on `agent/created` with the child's `ctx`),
 * and at that time it was covered by exactly nothing — the suite's fake host
 * stubbed the registry with `() => () => {}` and never invoked the callback —
 * and it was broken:
 *
 * `childCtx.get('agent')` is UNCONDITIONALLY undefined on a real cordis 4.0.1
 * context. dsh publishes the agent with `ctx.accessor('agent', { get: … })`
 * plus `root.extend({ agent })`, never `ctx.provide('agent', …)`; an accessor
 * installs a property, and `Context.prototype.get` resolves only PROVIDED
 * services. So `rootId` stayed undefined, this function returned `() => {}`,
 * and a delegated child received no `tools/pre-execute` egress seam, no
 * `installChildEgressGuard`, and no `autopilot_submit_packet` — which is
 * registered at exactly one site, here. Delegated runs were therefore BOTH
 * ungated for egress AND unable to submit their packet.
 *
 * The fix is the module's own {@link lookupService}, which documents this exact
 * hazard ("property reads on undeclared services are not reliable") and tries
 * `get` first and the property second — so a host that DOES provide the service
 * and a host that only extends the context both resolve.
 */
export function createContinuableChildSetup(
  engine: AutopilotEngine,
  gate: ResolvedConfig['gate'],
): (childCtx: ContinuableChildContext) => () => void {
  return (childCtx) => {
    const rootId = recognizeExecutorChild(engine, childCtx)
    if (rootId === undefined) return () => {}
    return installExecutorChildSurface(engine, gate, childCtx, rootId)
  }
}

/**
 * Is this child context the LIVE executor of a run this engine holds?
 *
 * Never throws: any lookup failure reads as "not recognized", because an
 * unrecognized child is a no-op by contract and must never veto its own
 * publication. Recognition works at announce time because `startExecutor`
 * commits `executor.state: 'starting'` with the minted childId BEFORE it calls
 * `startContinuable` (src/engine.ts).
 *
 * PREFER THE ANNOUNCED AGENT. `agent/created` hands the Agent itself to the
 * listener, and since dsh 0.1.7 that is the ONLY reliable way to reach it from
 * this plugin: on a real 0.2.0-rc.2 host `childCtx.get('agent')` is undefined
 * and the property read throws `cannot get property "agent" without inject`
 * (cordis strict-inject check; measured 2026-10-07, run
 * dsh-020-compat-20261007). The swallowed throw read as "not recognized", so
 * the delegated executor got no packet tool, no egress guard and no seam. The
 * context lookup stays only as the fallback for callers that hold nothing but
 * the context ({@link createContinuableChildSetup}).
 *
 * @param announced - the Agent from `agent/created`, when the caller has it.
 * @returns the parent run's root session id, or undefined.
 */
export function recognizeExecutorChild(
  engine: AutopilotEngine,
  childCtx: ContinuableChildContext,
  announced?: unknown,
): string | undefined {
  try {
    const child = (announced ?? lookupService(childCtx, 'agent') ?? childCtx.agent) as AgentRef | undefined
    if (child === undefined || child === null) return undefined
    const parentId = child.session.header.parentSession
    if (parentId === undefined) return undefined
    const run = engine.peek(parentId)
    if (run?.executor?.childId === child.id
      && (run.executor.state === 'running' || run.executor.state === 'starting')) {
      return parentId
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Cleanup failures collected while rolling back or disposing a child surface. */
export interface ChildSurfaceCleanupFailure {
  readonly step: 'seam' | 'packet-tool' | 'egress-guard'
  readonly error: unknown
}

/**
 * Install the recognized executor child's surface — pre-execute seam, packet
 * tool, egress guard — TRANSACTIONALLY.
 *
 * CONTRACT (owner ruling 2026-09-04, Codex P2 on PR #6):
 *  - the three steps install in order; each successful step's disposer is
 *    kept;
 *  - when a later step throws, every already-installed step is rolled back in
 *    REVERSE order, each in its own try/catch, and then the ORIGINAL error is
 *    rethrown. A cleanup failure never masks it: failures are attached to the
 *    error as a non-enumerable `rollbackFailures` array (when the error is an
 *    object) and handed to `onCleanupFailure`;
 *  - the returned disposer attempts EVERY disposer in reverse order, each in
 *    its own try/catch, and only after attempting all of them throws an
 *    `AggregateError` naming the failed steps — so nothing is left half
 *    registered and a direct caller still learns of a failure.
 *
 * Nothing is registered on the caller's side until this returns: the caller
 * records the disposer only after a complete, successful install.
 *
 * @param onCleanupFailure - receives each cleanup failure (rollback or dispose); used for the plugin's warn channel.
 *   It is a NOTIFICATION: it is invoked in its own try/catch, so a throwing
 *   reporter neither stops the remaining disposers nor replaces the error the
 *   caller must see.
 */
export function installExecutorChildSurface(
  engine: AutopilotEngine,
  gate: ResolvedConfig['gate'],
  childCtx: ContinuableChildContext,
  rootId: string,
  onCleanupFailure: (failure: ChildSurfaceCleanupFailure) => void = () => {},
): () => void {
  const installed: Array<{ step: ChildSurfaceCleanupFailure['step']; dispose: () => void }> = []
  const unwind = (): ChildSurfaceCleanupFailure[] => {
    const failures: ChildSurfaceCleanupFailure[] = []
    for (const entry of installed.splice(0).reverse()) {
      try {
        entry.dispose()
      } catch (error: unknown) {
        failures.push({ step: entry.step, error })
        // REPORTING NEVER STEERS UNWINDING (Codex P2 on PR #6). `onCleanupFailure`
        // is caller-supplied — the plugin passes a logger-backed warn — and a throw
        // from it would escape the loop with `installed` already drained, leaving the
        // remaining disposers unattempted and, on the rollback path, replacing the
        // original install error with the reporter's. It is a notification, not a step.
        try {
          onCleanupFailure({ step: entry.step, error })
        } catch {
          // a reporter that cannot report changes nothing about the unwind.
        }
      }
    }
    return failures
  }
  try {
    const childSeam = installPreExecuteGate(childCtx as unknown as PreExecuteHost, rootId, engine)
    installed.push({ step: 'seam', dispose: childSeam.dispose })
    installed.push({ step: 'packet-tool', dispose: childCtx.tools.register(packetToolDefinition(engine)) })
    installed.push({
      step: 'egress-guard',
      dispose: installChildEgressGuard(childCtx.tools, rootId, engine, {
        ...gate,
        egressSeam: resolveEgressChannel(childSeam.installed, gate.egressDeny),
      }),
    })
  } catch (error: unknown) {
    const failures = unwind()
    if (failures.length > 0 && typeof error === 'object' && error !== null) {
      // BEST EFFORT, and it must stay that way: a frozen or otherwise
      // non-extensible thrown value makes `defineProperty` throw, and letting
      // THAT escape would replace the install failure with a TypeError about
      // the annotation — exactly the masking this path exists to prevent
      // (Codex P2 on PR #6). The failures still reached `onCleanupFailure`.
      try {
        Object.defineProperty(error, 'rollbackFailures', { value: failures, enumerable: false, configurable: true })
      } catch {
        // annotation refused; the original error travels unchanged.
      }
    }
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const failures = unwind()
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(failure => failure.error),
        `child surface cleanup failed at ${failures.map(failure => failure.step).join(', ')} (every disposer was attempted)`,
      )
    }
  }
}

/**
 * Cordis plugin apply.
 *
 * ASYNC ON PURPOSE — that IS the fix for the mount-time race, and the seam is
 * the return value.
 *
 * WHAT CORDIS DOES WITH IT. A plugin's return value is its effect body: the
 * fiber's runner is `runtime.callback(this.ctx, this.config)`, `_execute()`
 * takes the `'then' in effect` branch for a thenable, and `_reload()` AWAITS
 * that before the fiber leaves LOADING (`vendor/cordis/src/fiber.ts`). So a
 * promise returned from here holds the fiber's `inertia` open, and every seam
 * that waits on a fiber therefore waits on this store:
 * `EntryTree.await()` collects `entry.fiber?.inertia`
 * (`vendor/loader/src/config/tree.ts`); `boot()` awaits `loader.await()` and
 * then refuses any entry that is not ACTIVE (`assertEntriesActivated`,
 * `packages/boot/app-boot/src/index.ts`); and the headless runner awaits
 * `ctx.get('loader')?.await()` in so many words BEFORE `agents.create()`
 * ("Loader siblings mount concurrently. Await the complete application before
 * creating an Agent so its scoped tools and adapters are not half-composed" —
 * `packages/bundle/headless/src/index.ts`).
 *
 * WHAT IT REPLACES, AND WHY THAT LOST THE RACE. Everything below used to be
 * registered inside `ctx.effect(async () => …)` while `apply` itself returned
 * `void`. An inner effect's setup promise is NOT what `_reload()` awaits — only
 * the plugin's own return value is — so the fiber reported ACTIVE with an EMPTY
 * autopilot surface, `loader.await()` returned, and the runner created the
 * session and composed the first request while `DomainRunStore.open` was still
 * doing tens of milliseconds of real fs I/O. Measured on the real host: 3 of 39
 * domain-backed boots lost that race and carried 25 tools / 0 `autopilot_*` in
 * `request/header` where a healthy boot carries 36 / 11; 0 of 20 file-store
 * boots lost it, only because `new RunStore()` constructs synchronously. The
 * store backend silently decided whether a run had a harness in it.
 *
 * WHY NOT REGISTER THE TOOLS SYNCHRONOUSLY AND LET THE STORE LAND BEHIND THEM.
 * That re-opens the split-brain window this comment used to be about: a run
 * admitted before the store resolves puts its first events in one backend and
 * the rest in another, and that stream folds to nothing coherent in either. It
 * trades a visible missing tool surface for an invisible corrupt event stream,
 * which is the worse of the two failures. The third option — failing closed —
 * is what this shape already gives for free: a store that cannot open rejects
 * `apply`, the fiber goes FAILED, and `boot()` refuses to start rather than
 * starting a harness with no harness in it.
 *
 * Exactly one store instance ever exists per mount, as before.
 */
export async function apply(rawCtx: unknown, config?: ConfigInput): Promise<() => Promise<void>> {
  const ctx = rawCtx as PluginContext
  const resolved = resolveConfig(config)

  const resolution = await resolveStore(
    rawCtx,
    config?.storeKind ?? 'auto',
    config?.storeRoot !== undefined && config.storeRoot.length > 0 ? config.storeRoot : defaultStoreRoot(),
  )
  const store = resolution.store
  if (resolution.degraded !== undefined) {
    // The one place a degrade is still visible. `enforcement.store` records
    // WHICH backend the run got; only this says what it was supposed to get and
    // what stopped it, which is the difference between "this deployment has no
    // storageDomain" and "this deployment's storageDomain is broken".
    warn(rawCtx, `dsh-autopilot: storeKind "auto" resolved to the ${store.kind} store: ${resolution.degraded}`)
  }

  // EVERY registration below can throw, and until the disposer exists there
  // is nothing to release the store. That matters because upstream
  // `DomainFacility.open` refuses a name that is already open: a partial
  // mount that never closed leaves the domain reserved for the life of the
  // process, and every later mount under storeKind "auto" quietly degrades
  // to the file backend. So the failure path closes what it opened, then
  // rethrows the original error unchanged. F19 (PR #2 Codex round 8): the
  // routing wiring is part of "what it opened" — once
  // `createRoutingWiring` has subscribed `llm/adapters-updated` (and possibly
  // registered the mirror projection), any LATER throw would leave those
  // host-surface registrations behind, and every retry would stack another
  // stale listener; the failure path holds its own reference and disposes it.
  let wiringForFailure: RoutingWiring | undefined
  try {
    // Seam installation is PER ROOT AGENT, so the record of it is too: one
    // root's `tools/pre-execute` registration can succeed while another's
    // throws, and each root's guard is already configured from its own result.
    // A single mount-wide flag would let whichever root was configured last
    // decide what EVERY run persists in `enforcement.egress` — a claim about a
    // scope the code was not observing. A root with no entry reads as
    // 'guard-deny', which is the honest answer for a scope not yet configured.
    const seamByRoot = new Map<string, boolean>()
    // Registration outcome for `ctx.autopilot`, resolved once below and read by
    // the probe. Declared here so the closure can see it before it is assigned.
    let serviceRegistered = false
    const probes: EnvironmentProbes = {
      approvalAvailable: () => probeApproval(rawCtx),
      egressChannel: (rootSessionId) => resolveEgressChannel(seamByRoot.get(rootSessionId), resolved.gate.egressDeny),
      serviceRegistered: () => serviceRegistered,
    }
    // Routing ports (M3b): the live catalog + the session policy reader, from
    // what this mount can actually see. Disposers (adapters-updated
    // subscription, mirror projection registration) ride the plugin lifecycle.
    const routing = createRoutingWiring(rawCtx, message => warn(rawCtx, message))
    wiringForFailure = routing
    // F3 (PR #2 Codex review): the planner installer port is a DYNAMIC
    // import away, and the engine must never be exposed before it is known —
    // a run entering planning at cold mount would otherwise record
    // `plannerRouting: 'unsupported'` for a healthy host and never retry
    // within the planning phase. `apply()` is already the async mount
    // barrier the store relies on (the fiber awaits it before the plugin is
    // ACTIVE), so the import settles HERE: the promise never rejects (an
    // unresolvable module keeps the port honestly `undefined`), hence this
    // await cannot unwind the mount.
    await routing.installerReady
    const engine = new AutopilotEngine(
      ctx.agents as never,
      ctx.subagents as never,
      store,
      resolved,
      () => probeSandbox(rawCtx),
      probes,
      routing.ports,
      // F2 (PR #2 Codex review): the per-decision routing re-read — wired
      // exactly when the routing leaves arrived as volatile references (the
      // Cordis loader path); `undefined` on the plain path, whose
      // `config.routing` snapshot is therefore still the live truth.
      volatileRoutingAccess(config),
    )

    // ── Policy prompt section (zero tokens without a run) ──────────────────
    const disposeSection = ctx.systemPrompt.section({
      name: 'autopilot:policy',
      order: 60,
      text: (context) => {
        const agent = context.agent
        if (agent === undefined) return ''
        const parentId = agent.session.header.parentSession
        if (parentId === undefined) {
          const snapshot = engine.peek(agent.id)
          return snapshot === undefined ? '' : renderRootPolicy(snapshot)
        }
        const parentRun = engine.peek(parentId)
        if (parentRun?.executor?.childId === agent.id && parentRun.executor.state !== 'revoked') {
          return renderExecutorPolicy(parentRun)
        }
        return ''
      },
    })

    // ── Read-only service surface ─────────────────────────────────────────
    // The outcome is READ, not dropped: registration can fail (a host that
    // already provides `autopilot`, or one exposing no provide surface), the
    // plugin deliberately survives that, and `enforcement.service` is where a
    // run says which of the two it got.
    const service = createAutopilotService(engine)
    const registration = registerAutopilotService(rawCtx as ProvideHost, service)
    serviceRegistered = registration.registered

    // ── Read-only HTTP surface (roadmap §9.3) ─────────────────────────────
    // Lazy: `installAutopilotRoutes` goes through `ctx.inject(['webServer'],
    // …)`, so on a profile with no api-gateway the callback never runs and
    // nothing about this mount changes.
    const disposeRoutes = installAutopilotRoutes(rawCtx, service)

    // ── Per-root controller surface (tools + guard + native egress seam) ───
    const installed = new Map<unknown, () => void>()
    const maybeInstall = (agent: unknown): void => {
      // `ctx` rides AgentRef itself since M6 ([R2-P3-1]); the intersection
      // here narrows it to the tools/pre-execute surface this mount touches.
      const rootAgent = agent as AgentRef & GateAgentRef & {
        ctx: { tools: { register(d: unknown): () => void } } & PreExecuteHost
      }
      if (installed.has(agent)) return
      if (rootAgent.session.header.parentSession !== undefined) return
      if (!ctx.agents.roots().includes(agent)) return
      const disposers: Array<() => void> = []
      try {
        // The native seam goes FIRST: whether it installed decides what the
        // synchronous guard does about egress, and the guard is what runs if
        // it did not.
        const seam = installPreExecuteGate(rootAgent.ctx, rootAgent.id, engine)
        seamByRoot.set(rootAgent.id, seam.installed)
        disposers.push(seam.dispose)
        disposers.push(installRootTools(rootAgent.ctx.tools, engine))
        disposers.push(installRootGate(rootAgent, engine, {
          ...resolved.gate,
          egressSeam: resolveEgressChannel(seam.installed, resolved.gate.egressDeny),
        }))
      } catch {
        for (const dispose of disposers.reverse()) dispose()
        return
      }
      installed.set(agent, () => {
        for (const dispose of disposers.reverse()) dispose()
      })
    }
    // ── Executor-child surface: packet tool + guard + native egress seam ───
    //
    // Until dsh 0.1.1 this went through `ctx.subagents.registerContinuableSetup`,
    // a registry the subagent manager applied inside each child's creation
    // window. dsh 0.1.2 removed that registry (measured on the real host:
    // `ctx.subagents.registerContinuableSetup is not a function`); the manager
    // now passes its own private `setup` to `agents.create()`. What a plugin
    // still gets is `agent/created`, which the agent registry announces for
    // EVERY agent — children included — after setup and `session/created`, and
    // BEFORE `agent/session-start` and the first prompt assembly (rc.1
    // `packages/core/agent-loop/src/index.ts` publication order:
    // sessions.enter → agents.enter → sessions.announce → agents.announce →
    // agent/session-start; `CreateAgentOptions.setup` doc). So the child
    // surface is installed there, on `agent.ctx` (the child's own scope), keyed
    // by agent and released on `agent/disposed`.
    //
    // THE LISTENER'S CONTRACT (owner ruling 2026-09-04, after Codex P2
    // 3933411711 on PR #6):
    //  - a child that is NOT this run's live executor is a harmless no-op:
    //    nothing is installed and nothing can throw, so an unrelated child is
    //    never vetoed;
    //  - a RECOGNIZED executor child is installed transactionally
    //    (`installExecutorChildSurface`): a failing step rolls back every
    //    step already installed, in reverse, and the original error is
    //    rethrown — DELIBERATELY out of this listener. On rc.1 a synchronous
    //    throw from an `agent/created` listener vetoes the child's publication
    //    (`AgentRegistry.announce()`), `startContinuable` rejects, and the
    //    engine records the executor as `revoked` with the failure as its
    //    startup diagnostic — a fail-closed start instead of a `running`
    //    executor that can never submit its packet;
    //  - `childInstalled` gains an entry ONLY after the complete surface
    //    installed; `agent/disposed` removes the entry first and then attempts
    //    every disposer, so one failing disposer neither keeps the entry nor
    //    skips the others.
    //
    // DECLARED RESIDUAL — the mount-time sweep below. On a plugin REMOUNT
    // while an executor is live (the persisted run says `running` with a
    // matching childId), a pre-existing child is recognized here, but there is
    // no publication left to veto and no plugin→engine revoke API; a failed
    // install on that one path is WARNED (run id + child id) and the executor
    // record is not corrected. The P2 condition can therefore persist across a
    // remount; recorded in DESIGN.md §6 and the PR body.
    const childInstalled = new Map<unknown, () => void>()
    const cleanupWarn = (agentId: string, rootId: string) => (failure: ChildSurfaceCleanupFailure): void => {
      warn(rawCtx, `dsh-autopilot: child surface cleanup failed at ${failure.step} (run ${rootId}, child ${agentId}): ${describeError(failure.error)}`)
    }
    const installChild = (agent: unknown): void => {
      const child = agent as Partial<AgentRef> & { ctx?: unknown }
      if (childInstalled.has(agent)) return
      if (child.session?.header?.parentSession === undefined) return
      if (child.ctx === undefined || child.ctx === null) return
      const childCtx = child.ctx as ContinuableChildContext
      const rootId = recognizeExecutorChild(engine, childCtx, agent)
      if (rootId === undefined) return
      const dispose = installExecutorChildSurface(engine, resolved.gate, childCtx, rootId, cleanupWarn(String(child.id), rootId))
      childInstalled.set(agent, dispose)
    }
    const disposeChild = (agent: unknown): void => {
      const dispose = childInstalled.get(agent)
      childInstalled.delete(agent)
      if (dispose === undefined) return
      try {
        dispose()
      } catch (error: unknown) {
        warn(rawCtx, `dsh-autopilot: child surface release failed for child ${String((agent as Partial<AgentRef>).id)}: ${describeError(error)}`)
      }
    }

    for (const agent of ctx.agents.list()) {
      maybeInstall(agent)
      try {
        installChild(agent)
      } catch (error: unknown) {
        // The declared residual: no publication to veto here.
        const child = agent as Partial<AgentRef>
        warn(rawCtx, `dsh-autopilot: executor child surface failed to install at mount for child ${String(child.id)} (run ${String(child.session?.header?.parentSession)}); the executor record cannot be corrected from here: ${describeError(error)}`)
      }
    }
    const disposeCreated = ctx.on('agent/created', (payload: { agent: unknown }) => {
      maybeInstall(payload.agent)
      installChild(payload.agent)
    })
    const disposeDisposed = ctx.on('agent/disposed', (payload: { agent: unknown }) => {
      installed.get(payload.agent)?.()
      installed.delete(payload.agent)
      disposeChild(payload.agent)
    })
    const disposeChildSetup = (): void => {
      for (const agent of [...childInstalled.keys()]) disposeChild(agent)
    }

    // ── Bundled-skill publication: native registry first, file fallback ───
    //
    // Skill publication is best-effort and runs only after every required
    // registration succeeded, so a failed mount persists nothing. Exactly one
    // channel is ever active (plan v3 "Skill"):
    //
    // - `ctx.skills` PROBED (never injected — see {@link probeSkillRegistry})
    //   and present ⇒ `registerProvider` serves the in-package SKILL.md with
    //   NO filesystem copy; the disposer rides the plugin lifecycle. Rank 700
    //   loses to every file-scan rank, so an owner's installed or drifted
    //   file copy still wins the name (the anti-silent-override rule,
    //   `src/skill-register.ts` module header).
    // - registration THREW ⇒ the 0.2.0 filesystem copy runs instead, with the
    //   failure recorded in the publication result and warned here.
    // - no skill service on this profile ⇒ the unchanged filesystem path.
    // - `skillInstall: 'off'` ⇒ none of the above (neither channel).
    let disposeSkillProvider: (() => void) | undefined
    if (resolved.skillInstall !== 'off') {
      const publication: SkillPublicationResult = publishBundledSkill(probeSkillRegistry(rawCtx))
      if (publication.status === 'provider-registered') {
        disposeSkillProvider = publication.dispose
        // WHICH path published — the honest diagnosis the packet requires;
        // info, not warn, because nothing degraded.
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
        // The filesystem result's own warning, byte-identical to the 0.2.0
        // behavior for the statuses where the model is NOT going to be told
        // to start a run on this host and a silent mount would hide that.
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
      registration.dispose()
      disposeRoutes()
      routing.dispose()
      disposeSkillProvider?.()
      disposeCreated()
      disposeDisposed()
      disposeChildSetup()
      for (const dispose of installed.values()) dispose()
      installed.clear()
      // Async tail: dispose waits (bounded) for in-flight transactions to settle.
      await engine.dispose()
      if (store instanceof DomainRunStore) await store.close()
    }
  } catch (error: unknown) {
    // F19 (PR #2 Codex round 8): release the wiring's host-surface
    // registrations (the `llm/adapters-updated` subscription, the mirror
    // projection) BEFORE the rethrow, alongside the store close — a failed
    // mount must not leave them behind for the next one to stack on. The
    // disposer is idempotent (`splice(0)` drains it once; the plugin
    // lifecycle disposer calls it again safely) and it already swallows each
    // inner disposer's throw; the belt-and-braces catch below only guards
    // against the loop itself failing, so teardown can never mask the error
    // that caused the unwind.
    try {
      wiringForFailure?.dispose()
    } catch {
      // A wiring teardown failure must not mask the original error.
    }
    if (store instanceof DomainRunStore) {
      try {
        await store.close()
      } catch {
        // A failing close must not mask the error that caused the unwind.
      }
    }
    throw error
  }
}
