/**
 * Model-facing autopilot tools (root controller surface).
 *
 * 0.3.0 retired the run state machine and every tool that wrote it
 * (`autopilot_init`, `_amend_plan`, `_submit_plan`, `_audit`, `_self_check`,
 * `_external_audit`, `_usage`, `_log`, `_executor`, `_submit_evidence`, `_signal`,
 * `_submit_closeout`, and the child tools `_request_escalation` / `_submit_packet`).
 * What remains is one read-only tool; stage 2 adds the role delegation tools.
 * Registered per exact top-level Agent scope.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { AP_NO_AGENT, AP_OWNER_AUTHORITY_REQUIRED } from './domain/refusals.js'
import { AutopilotError } from './domain/types.js'
import type { AgentRef, SessionReadRef } from './engine.js'
import type { AutopilotReadOnly } from './service.js'

/** JSON output helper (tool-gah pattern). */
function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

const JSON_VALUE = { type: 'json' } as const

/** Recover the exact calling agent from a tool execution. */
function callingAgent(agent: unknown, toolName: string): AgentRef {
  if (agent === undefined) throw new AutopilotError(`${toolName} requires a calling Agent`, AP_NO_AGENT)
  return agent as AgentRef
}

/**
 * Direct-human-turn authority: the current open turn window of the ROOT agent
 * must contain a user/message whose source kind is 'user'
 * (dsh goal-tool authority pattern, reimplemented).
 */
export function hasDirectHumanTurn(agent: { readonly session: SessionReadRef }): boolean {
  // Whole-log snapshot (dsh 0.1.2: `Session.events` is gone). Taken fresh on
  // every call; never cached, because `append` invalidates it.
  const events = agent.session.snapshotEvents()
  let turnStart = -1
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i]?.type
    if (type === 'turn/start') { turnStart = i; break }
    if (type === 'turn/end') return false
  }
  if (turnStart < 0) return false
  for (let i = turnStart; i < events.length; i++) {
    const event = events[i]
    if (event?.type !== 'user/message') continue
    const data = event.data as { source?: { kind?: string } } | undefined
    if (data?.source?.kind === 'user') return true
  }
  return false
}

export function requireDirectHumanTurn(agent: AgentRef, action: string): void {
  if (hasDirectHumanTurn(agent)) return
  throw new AutopilotError(
    `${action} is owner-only: it requires a direct human turn on the top-level agent (not an agent-generated turn)`,
    AP_OWNER_AUTHORITY_REQUIRED,
  )
}


/**
 * The body of `autopilot_status`: the session's ledger projection, its legacy run
 * summaries and the one-time notes. Read-only, and total: a session with no
 * ledger answers with `ledger: null` instead of a refusal.
 *
 * The result goes through a JSON round trip because dsh's lossless-JSON tool
 * output validator rejects an own property that holds `undefined`.
 */
export async function statusBody(service: AutopilotReadOnly, sessionId: string): Promise<Record<string, unknown>> {
  const ledger = await service.ledger(sessionId)
  const legacyRuns = ledger === undefined
    ? (await service.legacyRuns()).filter(run => run.sessionId === sessionId)
    : ledger.legacyRuns
  return JSON.parse(JSON.stringify({
    sessionId,
    storeKind: service.storeKind,
    ledger: ledger ?? null,
    legacyRuns,
    notes: service.notes(),
  })) as Record<string, unknown>
}

/** Structural tool registry for one scope. */
export interface ToolRegistryRef {
  register(definition: unknown): () => void
}

/** Install the root controller tools on one agent scope; returns a disposer. */
export function installRootTools(
  agentTools: ToolRegistryRef,
  service: AutopilotReadOnly,
): () => void {
  const disposers: Array<() => unknown> = []
  const register = (definition: unknown): void => { disposers.push(agentTools.register(definition)) }

  try {
    register(defineTool({
      name: 'autopilot_status',
      description: 'Read this session\'s autopilot ledger: delegated children (role, selected and observed route, state), reviews, links, whether auto-continue is available, legacy 0.2.x runs of this session, and one-time notes. Read-only.',
      parameters: {},
      output: jsonOutput(JSON_VALUE),
      async execute(_args, exec) {
        const agent = callingAgent(exec.agent, 'autopilot_status')
        return await statusBody(service, agent.id) as never
      },
    }))
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) void dispose()
    throw error
  }

  return () => {
    for (const dispose of disposers.reverse()) void dispose()
  }
}
