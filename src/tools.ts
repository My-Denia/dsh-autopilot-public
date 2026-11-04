/**
 * Model-facing autopilot tools (root controller surface).
 *
 * 0.3.0 retired the run state machine and every tool that wrote it
 * (`autopilot_init`, `_amend_plan`, `_submit_plan`, `_audit`, `_self_check`,
 * `_external_audit`, `_usage`, `_log`, `_executor`, `_submit_evidence`, `_signal`,
 * `_submit_closeout`, and the child tools `_request_escalation` / `_submit_packet`).
 * What remains: `autopilot_status` (read-only apart from recording an issue or PR link),
 * `autopilot_delegate` and `autopilot_agents` (wait) on root agents and executor-leads, and
 * `autopilot_escalate` on delegated children. The native list_agents, send_message and
 * interrupt_agent tools already see and control children started through `startActivation`,
 * so the plugin adds no list, message or stop tool.
 * Registered per exact Agent scope.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { AP_NO_AGENT, AP_OWNER_AUTHORITY_REQUIRED } from './domain/refusals.js'
import { AutopilotError } from './domain/types.js'
import type { AgentRef, AutopilotEngine, SessionReadRef } from './engine.js'
import { ROLE_NAMES } from './roles/index.js'
import type { DelegationRoleName } from './domain/ledger-types.js'
import { WORK_CLASS_NAMES } from './routing/work-class.js'
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

const blank = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

const stringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const out = value.map(blank).filter((v): v is string => v !== undefined)
  return out.length === 0 ? undefined : out
}

/** Strip own `undefined` properties (dsh's lossless-JSON validator rejects them). */
const plain = (value: unknown): never => JSON.parse(JSON.stringify(value)) as never

function delegateTool(engine: AutopilotEngine) {
  return defineTool({
    name: 'autopilot_delegate',
    description: 'Start a delegated child: scout (read-only search), clerk (connector reads and writes), worker (implementation; declare writePaths), executor-lead (owns a chunk and can dispatch scout, clerk, worker), planner (read-only plan) or reviewer (independent one-shot review, different model family). Returns at once with the child id, the route chosen and where it came from; the child reports through the host settlement notice. The reviewer is the exception: the call waits and returns its verdict. Concurrent workers need disjoint writePaths. Give no provider, model or effort to let routing choose.',
    parameters: {
      role: { type: 'string', required: true, enum: [...ROLE_NAMES], description: 'The delegation role.' },
      task: { type: 'string', required: true, description: 'The brief: goal, constraints, what to return.' },
      writePaths: { type: 'array', items: { type: 'string' }, description: 'Files or prefixes (src/parser/**) the child may write. Required for worker.' },
      provider: { type: 'string', description: 'Explicit provider (with model). Beats every pin and the ladder.' },
      model: { type: 'string', description: 'Explicit model (with provider).' },
      effort: { type: 'string', description: 'Explicit reasoning effort.' },
      workClass: { type: 'string', enum: [...WORK_CLASS_NAMES], description: 'Override the role default work class.' },
      replaces: { type: 'string', description: 'Child id this dispatch replaces (escalation): same role, generation + 1.' },
      reviewedChildIds: { type: 'array', items: { type: 'string' }, description: 'Reviewer only: the delegations under review (default: every settled write delegation).' },
    },
    output: jsonOutput(JSON_VALUE),
    async execute(args, exec) {
      const agent = callingAgent(exec.agent, 'autopilot_delegate')
      const provider = blank(args.provider)
      const model = blank(args.model)
      const effort = blank(args.effort)
      const writePaths = stringList(args.writePaths)
      const replaces = blank(args.replaces)
      const reviewed = stringList(args.reviewedChildIds)
      const workClass = blank(args.workClass) as (typeof WORK_CLASS_NAMES)[number] | undefined
      const result = await engine.delegate(agent, {
        role: args.role,
        task: args.task,
        ...(writePaths === undefined ? {} : { writePaths }),
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(workClass === undefined ? {} : { workClass }),
        ...(replaces === undefined ? {} : { replaces }),
        ...(reviewed === undefined ? {} : { reviewedChildIds: reviewed }),
      })
      return plain(result)
    },
  })
}

function agentsTool(engine: AutopilotEngine) {
  return defineTool({
    name: 'autopilot_agents',
    description: 'Wait for delegated children to settle. Returns their states and observed routes. Waits until the listed children (default: all your active ones) settle or the timeout fires; not a gate. List, message and stop children with the native list_agents, send_message and interrupt_agent.',
    parameters: {
      action: { type: 'string', required: true, enum: ['wait'], description: 'Only wait.' },
      childIds: { type: 'array', items: { type: 'string' }, description: 'Children to wait for; default all your active children.' },
      timeoutSeconds: { type: 'integer', description: 'Default 300, at most 600.' },
    },
    output: jsonOutput(JSON_VALUE),
    async execute(args, exec) {
      const agent = callingAgent(exec.agent, 'autopilot_agents')
      const requested = typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : 300
      const timeout = Math.max(0, Math.min(600, Math.floor(requested)))
      const out = await engine.wait(agent, stringList(args.childIds), timeout)
      return plain({ timedOut: out.timedOut, delegations: out.delegations })
    },
  })
}

function escalateTool(engine: AutopilotEngine) {
  return defineTool({
    name: 'autopilot_escalate',
    description: 'Ask your parent for more: a stronger model, more effort or a different split. Records the request and returns; your parent decides and re-dispatches. Say what stalled and what you tried.',
    parameters: { reason: { type: 'string', required: true, description: 'What stalled, and the evidence.' } },
    output: jsonOutput(JSON_VALUE),
    async execute(args, exec) {
      const agent = callingAgent(exec.agent, 'autopilot_escalate')
      return plain({ guidance: await engine.escalate(agent, args.reason) })
    },
  })
}

/**
 * The tools a delegated child gets in ITS OWN scope: an executor-lead dispatches
 * and waits; every non-reviewer can escalate. Own-layer registrations are exempt
 * from the child's tool restriction, so they survive an allow-list that does not
 * name them.
 */
export function installChildTools(agentTools: ToolRegistryRef, engine: AutopilotEngine, role: DelegationRoleName): () => void {
  const disposers: Array<() => unknown> = []
  try {
    if (role === 'executor-lead') {
      disposers.push(agentTools.register(delegateTool(engine)))
      disposers.push(agentTools.register(agentsTool(engine)))
    }
    if (role !== 'reviewer') disposers.push(agentTools.register(escalateTool(engine)))
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) void dispose()
    throw error
  }
  return () => { for (const dispose of disposers.reverse()) void dispose() }
}

/** Install the root controller tools on one agent scope; returns a disposer. */
export function installRootTools(
  agentTools: ToolRegistryRef,
  service: AutopilotReadOnly,
  engine?: AutopilotEngine,
): () => void {
  const disposers: Array<() => unknown> = []
  const register = (definition: unknown): void => { disposers.push(agentTools.register(definition)) }

  try {
    register(defineTool({
      name: 'autopilot_status',
      description: 'Read this session\'s autopilot ledger: delegated children (role, selected and observed route, state), reviews, links, whether auto-continue is available, legacy 0.2.x runs of this session, and one-time notes. Read-only.',
      parameters: {
        link: {
          type: 'object',
          additionalProperties: false,
          description: 'Optional: record an issue or PR link on this session\'s ledger (idempotent on kind and ref).',
          properties: {
            kind: { type: 'string', required: true, enum: ['issue', 'pr'] },
            ref: { type: 'string', required: true, description: 'e.g. MY-195, #12.' },
            url: { type: 'string' },
          },
        },
      },
      output: jsonOutput(JSON_VALUE),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'autopilot_status')
        if (engine !== undefined) {
          const link = args.link as { kind?: 'issue' | 'pr'; ref?: string; url?: string } | undefined
          const ref = blank(link?.ref)
          if (link !== undefined && ref !== undefined && (link.kind === 'issue' || link.kind === 'pr')) {
            const url = blank(link.url)
            await engine.addLink(agent.id, { kind: link.kind, ref, ...(url === undefined ? {} : { url }) })
          }
          await engine.syncGoal(agent)
          await engine.refreshRoutes(agent.id)
        }
        return await statusBody(service, agent.id) as never
      },
    }))
    if (engine !== undefined) {
      register(delegateTool(engine))
      register(agentsTool(engine))
    }
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) void dispose()
    throw error
  }

  return () => {
    for (const dispose of disposers.reverse()) void dispose()
  }
}
