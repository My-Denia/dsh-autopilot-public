/**
 * The host seam: the structural subset of the dsh 0.2.2-rc.5 services this
 * plugin reaches, plus the probes that read optional services.
 *
 * Deliberately structural, not imported. `@deepseek-ai/dsh-agent`,
 * `-subagent` and `-tools` are dev/peer dependencies used for types, but the
 * plugin talks to the live objects through these mirrors so a host surface
 * that drifts shows up as a probe that reads `undefined` (graceful degrade)
 * instead of a broken module graph. The one exception is `defineTool` in
 * `./tools.ts`, which comes from the peer package so no second copy is ever
 * bundled.
 */

import type { AgentRef, AgentRegistryRef } from './host-types.js'

export type { AgentContextRef, AgentRef, AgentRegistryRef, ToolScopeRef } from './host-types.js'

/** One model-facing tool schema, as `ctx.tools.schemas()` projects it. */
export interface ToolSchemaRef {
  readonly name?: unknown
}

/** The `ctx.tools` registry subset used to read registered names. */
export interface ToolsRef {
  schemas(scope?: unknown): readonly ToolSchemaRef[]
}

/** The terminal outcome of one child run, as the activation resolves it. */
export interface ActivationResultRef {
  readonly stopReason: string
  readonly structured?: unknown
  readonly diagnostic?: string
}

/** One managed child activation. */
export interface ActivationRef {
  readonly childId: string
  readonly result: Promise<ActivationResultRef>
  dispose(): Promise<void>
}

/** The `SubagentRuntime.startActivation` request (rc.5 shape, no wrapper). */
export interface StartActivationSpec {
  readonly provider: string
  readonly label: string
  /** Pre-minted child id; the local (`spawn`) backend reserves it. */
  readonly childId?: string
  readonly prompt: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>
  readonly parent: AgentRef
  readonly maxDepth?: number
  readonly agentOptions?: {
    readonly provider?: string
    readonly model?: string
    readonly reasoningEffort?: string
    readonly maxTokens?: number
  }
  readonly outputSchema?: object
  readonly signal: AbortSignal
  readonly delivery: 'parent' | 'caller'
}

/** The `ctx.subagents` registry subset this plugin uses. */
export interface SubagentsRef {
  startActivation(spec: StartActivationSpec): Promise<ActivationRef>
}

/** Everything the delegator needs from the live host. */
export interface HostSeam {
  readonly agents: AgentRegistryRef
  readonly subagents: SubagentsRef
  /** The tool registry, or undefined when it cannot be read. */
  readonly tools: ToolsRef | undefined
  /** Aborted when the plugin unmounts; every host call carries it. */
  readonly signal: AbortSignal
  /** ISO-8601 clock. */
  now(): string
  /** Plain diagnostic channel; never a refusal. */
  warn(message: string): void
}

/** The local backend: the only provider that accepts a pre-minted child id. */
export const LOCAL_PROVIDER = 'spawn'

/**
 * Look one service up the way dsh itself does: `ctx.get(name)` first (property
 * reads on undeclared services are not reliable), falling back to property
 * access, with any failure reading as unavailable.
 */
export function lookupService(rawCtx: unknown, name: string): unknown {
  const record = rawCtx as { get?: (key: string) => unknown } & Record<string, unknown>
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

/**
 * Every tool name the registry shows `scope`, or `undefined` when the registry
 * cannot be listed (or is empty). dsh-tools scope keys are the Agent objects
 * themselves, so the caller passes the dispatching agent: a child joins its
 * parent's composition, and that view is the surface the child inherits.
 */
export function registeredToolNamesOf(tools: ToolsRef | undefined, scope?: unknown): readonly string[] | undefined {
  if (tools === undefined) return undefined
  try {
    const names = tools.schemas(scope)
      .map((schema) => schema.name)
      .filter((name): name is string => typeof name === 'string')
    return names.length === 0 ? undefined : names
  } catch {
    return undefined
  }
}

/** Whether an agent is a top-level agent (a session with no subagent parent). */
export function isRootAgent(agent: AgentRef): boolean {
  return agent.session.header.parentSession === undefined
}
