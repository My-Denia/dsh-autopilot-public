/**
 * The three model-facing tools.
 *
 * `autopilot_delegate` and `autopilot_agents` are registered on the root agent
 * and on every executor-lead; `autopilot_escalate` on every delegated child
 * except the reviewer. Registration is per exact Agent scope: dsh has no
 * process-wide "tool visible only to the root" facility, so each surface is
 * installed into the agent's own scope on `agent/created` (see `./index.ts`).
 *
 * The plugin adds no list, message or stop tool: the host's native
 * `list_agents`, `send_message` and `interrupt_agent` already see and control
 * children started through `startActivation`. The one review verdict is
 * returned in-band from the same waiting call, so the main agent can never
 * write one.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { AP_NO_AGENT } from './domain/refusals.js'
import { AutopilotError } from './domain/types.js'
import { ROLE_NAMES } from './roles/index.js'
import type { Delegator } from './delegator.js'
import type { DelegationRoleName } from './ledger.js'
import type { AgentRef, ToolScopeRef } from './host-types.js'

/** JSON output helper: one canonical value rendered as its JSON text. */
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

const blank = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

const stringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const out = value.map(blank).filter((entry): entry is string => entry !== undefined)
  return out.length === 0 ? undefined : out
}

/** Strip own `undefined` properties: dsh's lossless-JSON output validator rejects them. */
const plain = (value: unknown): never => JSON.parse(JSON.stringify(value)) as never

function delegateTool(delegator: Delegator) {
  return defineTool({
    name: 'autopilot_delegate',
    description:
      'Start a delegated child in one role: scout (read-only search), worker (implementation; declare writePaths), executor-lead (owns a chunk; may dispatch scout and worker), planner (read-only plan) or reviewer (one-shot independent review). Returns at once with the child id, the route sent and whether that route came from the call or from the host default; the child reports through the host settlement notice. The reviewer is the exception: the call waits and returns its structured verdict in-band, and only the reviewer can produce that verdict. Concurrent writers need disjoint writePaths. Name no provider, model or effort to inherit the host route.',
    parameters: {
      role: { type: 'string', required: true, enum: [...ROLE_NAMES], description: 'The delegation role.' },
      task: { type: 'string', required: true, description: 'The brief: the outcome, the files in play, what may not be touched, and the checkable result.' },
      writePaths: { type: 'array', items: { type: 'string' }, description: 'Files or prefixes (src/parser/**) the child may write. Required for worker; ignored for read-only roles.' },
      provider: { type: 'string', description: 'Explicit provider (with model). Omit to inherit the host route.' },
      model: { type: 'string', description: 'Explicit model (with provider).' },
      effort: { type: 'string', description: 'Explicit reasoning effort. Requires provider and model.' },
      replaces: { type: 'string', description: 'Child id this dispatch replaces: same role, generation + 1.' },
    },
    output: jsonOutput(JSON_VALUE),
    async execute(args, exec) {
      const agent = callingAgent(exec.agent, 'autopilot_delegate')
      const writePaths = stringList(args.writePaths)
      const provider = blank(args.provider)
      const model = blank(args.model)
      const effort = blank(args.effort)
      const replaces = blank(args.replaces)
      const result = await delegator.delegate(agent, {
        role: args.role,
        task: args.task,
        ...(writePaths === undefined ? {} : { writePaths }),
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(replaces === undefined ? {} : { replaces }),
      })
      return plain(result)
    },
  })
}

function agentsTool(delegator: Delegator) {
  return defineTool({
    name: 'autopilot_agents',
    description:
      'Wait for delegated children to settle. Blocks until the listed children (default: all of yours still running) settle or the timeout fires, then returns timedOut and their records with the route each was given and how each ended. It is not a gate: it never refuses work. List, message and stop children with the native list_agents, send_message and interrupt_agent.',
    parameters: {
      action: { type: 'string', required: true, enum: ['wait'], description: 'Only wait.' },
      childIds: { type: 'array', items: { type: 'string' }, description: 'Children to wait for; default all of yours still running.' },
      timeoutSeconds: { type: 'integer', description: 'Default 300, at most 600.' },
    },
    output: jsonOutput(JSON_VALUE),
    async execute(args, exec) {
      const agent = callingAgent(exec.agent, 'autopilot_agents')
      const requested = typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : 300
      const timeout = Math.max(0, Math.min(600, Math.floor(requested)))
      const result = await delegator.wait(agent, stringList(args.childIds), timeout)
      return plain(result)
    },
  })
}

function escalateTool(delegator: Delegator) {
  return defineTool({
    name: 'autopilot_escalate',
    description:
      'Ask your parent for more: a stronger model, more effort, or a different split. Records the request on your delegation and returns; your parent decides and re-dispatches with replaces. It never widens your permissions. Say what stalled and what you tried.',
    parameters: { reason: { type: 'string', required: true, description: 'What stalled, and the evidence.' } },
    output: jsonOutput(JSON_VALUE),
    async execute(args, exec) {
      const agent = callingAgent(exec.agent, 'autopilot_escalate')
      return plain({ guidance: await delegator.escalate(agent, args.reason) })
    },
  })
}

/**
 * Install the root controller surface (delegate + wait) on one agent scope.
 * Returns a disposer that unregisters what this call registered.
 */
export function installRootTools(agentTools: ToolScopeRef, delegator: Delegator): () => void {
  const disposers: Array<() => unknown> = []
  try {
    disposers.push(agentTools.register(delegateTool(delegator)))
    disposers.push(agentTools.register(agentsTool(delegator)))
  } catch (error: unknown) {
    for (const dispose of [...disposers].reverse()) void dispose()
    throw error
  }
  return () => { for (const dispose of [...disposers].reverse()) void dispose() }
}

/**
 * The tools a delegated child gets in ITS OWN scope: an executor-lead dispatches
 * and waits; every non-reviewer child can escalate. Own-layer registrations are
 * exempt from the child's tool restriction, so they survive an allow-list that
 * does not name them.
 */
export function installChildTools(agentTools: ToolScopeRef, delegator: Delegator, role: DelegationRoleName): () => void {
  const disposers: Array<() => unknown> = []
  try {
    if (role === 'executor-lead') {
      disposers.push(agentTools.register(delegateTool(delegator)))
      disposers.push(agentTools.register(agentsTool(delegator)))
    }
    if (role !== 'reviewer') disposers.push(agentTools.register(escalateTool(delegator)))
  } catch (error: unknown) {
    for (const dispose of [...disposers].reverse()) void dispose()
    throw error
  }
  return () => { for (const dispose of [...disposers].reverse()) void dispose() }
}

/** Tool factories, exported for tests that want to inspect a definition directly. */
export const toolFactories = { delegateTool, agentsTool, escalateTool } as const
