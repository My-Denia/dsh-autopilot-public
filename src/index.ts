/**
 * dsh-goal-autopilot — a goal-workflow adapter for DeepSeek Harness.
 *
 * The plugin provides exactly three tools (`autopilot_delegate`,
 * `autopilot_agents`, `autopilot_escalate`), the per-role delegation mechanics
 * over the host's native subagents, and the adapter skill. It has no routing
 * engine, no model catalog, no ledger file, no storage, no UI card and no
 * legacy reader: the host owns models, sessions, tools and approvals, and this
 * mount only records what it started in memory for the life of the session.
 *
 * LIFETIME. One mount owns one `Delegator` (and therefore one in-memory
 * ledger). Root tool surfaces are installed per root agent on `agent/created`
 * (and on roots already live at mount); child surfaces are installed and
 * restricted in the same serial event, before the child sees its first prompt.
 * Unmount aborts every host call made with the mount signal and releases every
 * registration.
 */

import { resolveConfig } from './config.js'
import type { ConfigInput } from './config.js'
import { Delegator } from './delegator.js'
import { isRootAgent, lookupService } from './host.js'
import type { HostSeam, SubagentsRef, ToolsRef } from './host.js'
import type { AgentRef, AgentRegistryRef } from './host-types.js'
import { probeSkillRegistry, publishSkill } from './skill.js'
import type { SkillFileResult } from './skill.js'
import { installRootTools } from './tools.js'

/** Cordis plugin name. */
export const name = 'dsh-goal-autopilot'

/**
 * Required services. `skills` is deliberately ABSENT: the skill registry is
 * OPTIONAL on dsh profiles (a headless composition may not have one), and a
 * hard inject entry would make the plugin wait for it forever. It is probed at
 * mount, and the file-copy channel covers its absence.
 */
export const inject = ['agents', 'subagents', 'tools']

/** The plugin config schema (schemastery; one key). */
export { Config } from './config.js'

/** The structural context this plugin reaches. */
interface PluginContext {
  readonly agents: AgentRegistryRef
  readonly subagents: SubagentsRef
  on(event: 'agent/created', listener: (payload: { agent: AgentRef }) => void | Promise<void>): () => void
  on(event: 'agent/disposed', listener: (payload: { agent: AgentRef }) => void): () => void
}

/** Emit one deployment diagnostic, defensively. */
function warn(rawCtx: unknown, message: string): void {
  try {
    const logger = lookupService(rawCtx, 'logger') as { warn?: (text: string) => void } | undefined
    logger?.warn?.(`dsh-goal-autopilot: ${message}`)
  } catch {
    // A logger that throws is still only a logger.
  }
}

/** Emit one informational diagnostic, defensively. */
function info(rawCtx: unknown, message: string): void {
  try {
    const logger = lookupService(rawCtx, 'logger') as { info?: (text: string) => void } | undefined
    logger?.info?.(`dsh-goal-autopilot: ${message}`)
  } catch {
    // A logger that throws is still only a logger.
  }
}

/** Warn about a degraded filesystem skill install; a clean one is silent. */
function warnFileChannel(rawCtx: unknown, result: SkillFileResult): void {
  if (result.status !== 'error' && result.status !== 'drift') return
  warn(rawCtx, `skill install ${result.status}${result.detail === undefined ? '' : `: ${result.detail}`}`)
}

/**
 * Mount the plugin. Returns a disposer that tears the mount down in the reverse
 * order of registration.
 */
export async function apply(rawCtx: unknown, config?: ConfigInput): Promise<() => Promise<void>> {
  const ctx = rawCtx as PluginContext
  const resolved = resolveConfig(config)
  const lifecycle = new AbortController()
  const host: HostSeam = {
    agents: ctx.agents,
    subagents: ctx.subagents,
    tools: lookupService(rawCtx, 'tools') as ToolsRef | undefined,
    signal: lifecycle.signal,
    now: () => new Date().toISOString(),
    warn: (message) => warn(rawCtx, message),
  }
  const delegator = new Delegator(host)
  const installed = new Map<AgentRef, () => void>()

  /** Install the root surface on a top-level agent, once. Never throws. */
  const installRoot = (agent: AgentRef): void => {
    if (!isRootAgent(agent) || installed.has(agent)) return
    const agentTools = agent.ctx.tools
    if (agentTools === undefined) {
      warn(rawCtx, `the root tool surface is unavailable for ${agent.id}: its scope has no tool registry`)
      return
    }
    try {
      installed.set(agent, installRootTools(agentTools, delegator))
    } catch (error: unknown) {
      warn(rawCtx, `the root tool surface failed to install for ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Roots already live at mount are open sessions.
  try {
    for (const agent of ctx.agents.list()) installRoot(agent)
  } catch (error: unknown) {
    warn(rawCtx, `could not enumerate live agents at mount: ${error instanceof Error ? error.message : String(error)}`)
  }

  // `agent/created` is serial and awaited before the first prompt: the child's
  // restriction must land here, and a throw vetoes the child's publication
  // (fail closed). A root install failure is only a deployment diagnostic.
  const disposeCreated = ctx.on('agent/created', (payload) => {
    const agent = payload.agent
    if (isRootAgent(agent)) {
      installRoot(agent)
      return
    }
    delegator.onChildCreated(agent)
  })

  const disposeDisposed = ctx.on('agent/disposed', (payload) => {
    const agent = payload.agent
    installed.get(agent)?.()
    installed.delete(agent)
    if (!isRootAgent(agent)) delegator.onChildDisposed(agent)
  })

  // Publish the adapter skill through exactly one channel.
  const publication = publishSkill(probeSkillRegistry(rawCtx), { enabled: resolved.skillInstall !== 'off' })
  if (publication.status === 'provider-registered') {
    info(rawCtx, `skill served by ${publication.provider}`)
  } else if (publication.status === 'provider-failed-fallback') {
    warn(rawCtx, `native skill registration failed (${publication.failure}); fell back to the filesystem copy`)
    warnFileChannel(rawCtx, publication.fallback)
  } else if (publication.status !== 'skipped') {
    warnFileChannel(rawCtx, publication)
  }

  return async () => {
    lifecycle.abort()
    try { disposeCreated() } catch { /* teardown is best-effort */ }
    try { disposeDisposed() } catch { /* teardown is best-effort */ }
    for (const dispose of [...installed.values()].reverse()) {
      try { dispose() } catch { /* teardown is best-effort */ }
    }
    installed.clear()
    if (publication.status === 'provider-registered') {
      try { publication.dispose() } catch { /* teardown is best-effort */ }
    }
  }
}

// ── Public surface (types and pure helpers; no second runtime) ───────────────

export { resolveConfig } from './config.js'
export type { ConfigInput, ResolvedConfig, SkillInstallMode } from './config.js'
export { Delegator, observedRouteOf, promptOf } from './delegator.js'
export type { DelegateArgs, DelegateResult, WaitResult } from './delegator.js'
export { LedgerStore } from './ledger.js'
export type {
  DelegationRecord,
  DelegationRoleName,
  DelegationState,
  ReviewFinding,
  ReviewVerdict,
  Route,
  RouteSource,
} from './ledger.js'
export { REVIEW_VERDICT_SCHEMA, ROLES, ROLE_NAMES, parseReviewVerdict } from './roles/index.js'
export type { RoleSpec } from './roles/index.js'
export {
  READ_ONLY_TOOLS,
  REQUIRED_READ_TOOLS,
  WEB_TOOLS,
  allowListFor,
  allowListDiagnostic,
  parseRestrictRejection,
  resolveToolAllow,
} from './roles/tools.js'
export { findWriteConflict, pathsIntersect } from './roles/paths.js'
export type { WriteConflict, WriteScope } from './roles/paths.js'
export {
  AGENTS_HOME_ENV,
  SKILL_NAME,
  SKILL_PROVIDER_NAME,
  SKILL_PROVIDER_RANK,
  agentsHome,
  bundledSkillPath,
  createSkillProvider,
  parseSkillFrontmatter,
  probeSkillRegistry,
  publishSkill,
  syncSkillFile,
} from './skill.js'
export type { SkillCandidate, SkillDefinition, SkillFileResult, SkillProvider, SkillPublishResult, SkillSummary } from './skill.js'
export { installChildTools, installRootTools, toolFactories } from './tools.js'
export { isRootAgent, lookupService, registeredToolNamesOf } from './host.js'
export type { ActivationRef, ActivationResultRef, HostSeam, StartActivationSpec, SubagentsRef, ToolsRef } from './host.js'
export type { AgentRef, AgentRegistryRef, ToolScopeRef } from './host-types.js'
export { REFUSALS } from './domain/refusals.js'
export type { RefusalCode } from './domain/refusals.js'
export { AutopilotError, errorMessage } from './domain/types.js'
