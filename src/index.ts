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
 *   gate: { sandboxCoupling?, toolDeny?, egressDeny?, stopReminder?, strictShell?, restoreMode? }
 *   storeKind: 'auto' | 'file' | 'domain' (default 'auto')
 *   storeRoot: run directory root (default $DSH_HOME/storages/dsh-autopilot)
 *   skillInstall: 'auto' | 'off' (default 'auto') — copy bundled SKILL.md into the skill-scan root
 */

import { AutopilotEngine } from './engine.js'
import type { AgentOptionsLike, AgentRef, EnvironmentProbes, ResolvedConfig } from './engine.js'
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
import { syncBundledSkill } from './skill-install.js'
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
export { AutopilotEngine, approvalAuthorizes, effectiveSandboxMode } from './engine.js'
export type { EnvironmentProbes, ResolvedConfig, StatusView } from './engine.js'
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
export {
  SKILL_HOME_ENV,
  SKILL_RELATIVE,
  bundledSkillPath,
  skillHome,
  syncBundledSkill,
} from './skill-install.js'
export type { DestKind, SkillInstallStatus, SkillSyncIo, SkillSyncResult } from './skill-install.js'

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
 */
export const inject = ['agents', 'subagents', 'tools', 'systemPrompt']

/** Raw config accepted from the patch layer. */
export interface ConfigInput {
  readonly auditProvider?: string
  readonly executorProvider?: string
  readonly auditors?: Partial<Record<AuditRole, { provider?: string; agentOptions?: AgentOptionsLike }>>
  readonly executor?: { agentOptions?: AgentOptionsLike; persona?: string; toolAllowList?: readonly string[] }
  /**
   * Cross-family review. A blind spot shared by one provider passes both gates
   * unchallenged, so past a risk floor the reviewer should not come from the
   * family that built. Strategy, not gate — the outcome is RECORDED per audit.
   */
  readonly crossFamily?: { enabled?: boolean; minRisk?: Risk; pool?: readonly AgentOptionsLike[] }
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
   * Copy the bundled SKILL.md into dsh's skill-scan root on mount (`auto`),
   * or leave the scan root untouched (`off`). Default `auto`. Drift never
   * overwrites; a differing dest is a warning.
   */
  readonly skillInstall?: 'auto' | 'off'
}

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
): Partial<Record<AuditRole, { provider?: string; agentOptions?: AgentOptionsLike }>> {
  const out: Partial<Record<AuditRole, { provider?: string; agentOptions?: AgentOptionsLike }>> = {}
  for (const [role, route] of Object.entries(input ?? {}) as Array<[AuditRole, { provider?: string; agentOptions?: AgentOptionsLike } | undefined]>) {
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
    gate: {
      sandboxCoupling: input?.gate?.sandboxCoupling ?? true,
      toolDeny: input?.gate?.toolDeny ?? true,
      egressDeny: input?.gate?.egressDeny ?? true,
      stopReminder: input?.gate?.stopReminder ?? true,
      strictShell: input?.gate?.strictShell ?? false,
      restoreMode: input?.gate?.restoreMode ?? 'workspace-write',
    },
    skillInstall: input?.skillInstall ?? 'auto',
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
  // rethrows the original error unchanged.
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
    const engine = new AutopilotEngine(
      ctx.agents as never,
      ctx.subagents as never,
      store,
      resolved,
      () => probeSandbox(rawCtx),
      probes,
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

    // Skill-scan install is best-effort and runs only after every required
    // registration succeeded, so a failed mount does not persist SKILL.md.
    // Drift never overwrites.
    if (resolved.skillInstall !== 'off') {
      const skill = syncBundledSkill({ enabled: true })
      // 'unsupported' warns for the same reason the other two do: the model is
      // NOT going to be told to start a run on this host, and a silent mount
      // would hide that. The mount itself still succeeds.
      if (skill.status === 'drift' || skill.status === 'error' || skill.status === 'unsupported') {
        warn(
          rawCtx,
          `dsh-autopilot: skill install ${skill.status}${skill.detail !== undefined ? `: ${skill.detail}` : ''}`,
        )
      }
    }

    return async () => {
      disposeSection()
      registration.dispose()
      disposeRoutes()
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
