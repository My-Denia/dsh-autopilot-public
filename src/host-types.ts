/**
 * The agent-facing structural types shared by the seam and the delegator.
 *
 * Split from `./host.ts` so the two never form an import cycle: the seam
 * imports these types, and the delegator imports both.
 */

/** The tool registry as one agent scope sees it. */
export interface ToolScopeRef {
  register(definition: unknown): () => void
  restrict?(filter: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }): unknown
}

/** One agent's scope-local context (its `ctx`, which is that Agent's scope). */
export interface AgentContextRef {
  readonly tools?: ToolScopeRef
}

/** One durable session event, structurally (only `type` and `data` are read). */
export interface SessionEventRef {
  readonly type: string
  readonly data: unknown
}

/** One live agent. */
export interface AgentRef {
  readonly id: string
  readonly session: {
    readonly header: {
      /** Direct creator of a subagent session; absent on a root session. */
      readonly parentSession?: string
    }
    /** A detached copy of the session log; absent on a host that cannot expose it. */
    snapshotEvents?(): ReadonlyArray<SessionEventRef>
  }
  readonly ctx: AgentContextRef
}

/** The `ctx.agents` registry subset. */
export interface AgentRegistryRef {
  get(id: string): AgentRef | undefined
  list(): Iterable<AgentRef>
}
