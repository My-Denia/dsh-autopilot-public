/**
 * Gate wiring: per-agent tool guards and the turn-stop reminder.
 *
 * These are the CC hook equivalents rebuilt on native seams:
 * - PreToolUse plan-gate hook  -> agent-scoped tools.guard
 * - PreToolUse usage-evidence  -> the same guard's usage branch
 * - PreToolUse outbound gate   -> `./preexecute.ts` (async, ask-able), with
 *   this guard as the fail-closed fallback when that seam is unavailable
 * - Stop-hook execution nudge  -> agent/turn-stopping listener with a bounded followup
 *
 * The guard no longer consumes owner approvals. Consumption needs to await a
 * store write and, in the native path, to follow a human's answer; a
 * `(execution) => string | undefined` guard can do neither. See `./decide.ts`
 * for the full statement of the guard/pre-execute split.
 */

import { randomUUID } from 'node:crypto'
import { MAX_STOP_REMINDERS } from '../domain/types.js'
import type { AutopilotEngine } from '../engine.js'
import { EGRESS_FAIL_CLOSED_REASON, decideTool, egressCommandOf } from './decide.js'
import type { GateConfig } from './decide.js'

/** Structural subset of an agent-scoped context the gate touches. */
export interface GateAgentRef {
  readonly id: string
  readonly session: { readonly header: { readonly parentSession?: string } }
  readonly ctx: {
    tools: {
      guard(fn: (execution: { name: string; arguments: unknown }) => string | undefined): () => void
    }
    on(event: 'agent/turn-stopping', listener: (payload: { agent: unknown; turn: number }) => Promise<void> | void): () => void
  }
  followup(message: {
    id: string
    role: 'user'
    content: Array<{ type: 'text'; text: string }>
    source: { kind: 'plugin'; plugin: string; form: 'notice'; summary: string }
  }): void
}

/** Install the tool guard + stop reminder on one ROOT agent. Returns a disposer. */
export function installRootGate(
  agent: GateAgentRef,
  engine: AutopilotEngine,
  config: GateConfig & { stopReminder: boolean },
): () => void {
  const disposers: Array<() => unknown> = []

  disposers.push(agent.ctx.tools.guard((execution) => {
    try {
      return applyDecision(engine, agent.id, execution.name, execution.arguments, config)
    } catch {
      return failClosedEgressReason(execution.name, execution.arguments, config)
    }
  }))

  if (config.stopReminder) {
    disposers.push(agent.ctx.on('agent/turn-stopping', async () => {
      try {
        const snapshot = engine.peek(agent.id)
        if (snapshot === undefined) return
        if (snapshot.triage.size !== 'standard') return
        if (snapshot.phase !== 'executing' && snapshot.phase !== 'execution-reviewing') return
        if (snapshot.executionGate === 'pass') return
        const count = await engine.bumpReminder(agent.id)
        if (count === undefined) return
        agent.followup({
          id: randomUUID(),
          role: 'user',
          content: [{
            type: 'text',
            text: `[autopilot ${count}/${MAX_STOP_REMINDERS}] The run is mid-execution and the execution gate is "${snapshot.executionGate}". Before ending: submit execution evidence/packet and run the execution audit, or move the run to blocked / needs-owner-decision. (This reminder self-releases after ${MAX_STOP_REMINDERS} rounds.)`,
          }],
          source: { kind: 'plugin', plugin: 'dsh-autopilot', form: 'notice', summary: 'autopilot execution-gate reminder' },
        })
      } catch {
        // Fail-open by design.
      }
    }))
  }

  return () => {
    for (const dispose of disposers.reverse()) void dispose()
  }
}

/** Install the egress guard on an EXECUTOR CHILD context (child tools bind to the parent run). */
export function installChildEgressGuard(
  childTools: { guard(fn: (execution: { name: string; arguments: unknown }) => string | undefined): () => void },
  rootSessionId: string,
  engine: AutopilotEngine,
  config: GateConfig,
): () => void {
  return childTools.guard((execution) => {
    try {
      return applyDecision(engine, rootSessionId, execution.name, execution.arguments, config)
    } catch {
      return failClosedEgressReason(execution.name, execution.arguments, config)
    }
  })
}

/**
 * What a guard says when the DECISION ITSELF threw.
 *
 * SPLIT CATCH, and why the split is the whole fix. `applyDecision` starts with
 * `engine.peek`, which reaches `RunStore.load` and throws `AP_STORE_CORRUPT` on
 * a torn `events.jsonl` line — a state `RunStore.commit` can genuinely leave
 * behind, because it appends the canonical event BEFORE the tmp+rename of the
 * projection and a kill in that window lands exactly there. A single
 * `catch { return undefined }` turned that into a blanket ALLOW, and under
 * `egressSeam: 'guard-deny'` — by definition the configuration where no
 * pre-execute seam exists — the "unconditional" egress denial became an allow
 * on the one path where this guard is the only defense.
 *
 * So the fail-OPEN doctrine is kept where it belongs (plan gate, usage clamp,
 * executor bypass: quality gates, and a broken gate must not lock the machine)
 * and dropped where it never belonged (the owner-only boundary). The
 * classification below reads the CALL only — tool name and arguments — because
 * a snapshot read is the thing that just failed.
 */
function failClosedEgressReason(
  toolName: string,
  args: unknown,
  config: GateConfig,
): string | undefined {
  if (!config.egressDeny) return undefined
  // 'native-ask' means the pre-execute seam installed and owns this call; a
  // monotonic guard denial here would veto the human's allowed-once even
  // though the seam is perfectly able to reach its own fail-closed catch.
  if (config.egressSeam !== 'guard-deny') return undefined
  if (egressCommandOf(toolName, args) === undefined) return undefined
  return EGRESS_FAIL_CLOSED_REASON
}

/**
 * Convert a pure decision into the guard's deny-reason contract.
 *
 * Every branch is enumerated rather than defaulted, so adding a decision kind
 * without deciding its guard meaning is a compile error (`never` exhaustion)
 * instead of a silent allow.
 */
function applyDecision(
  engine: AutopilotEngine,
  rootSessionId: string,
  toolName: string,
  args: unknown,
  config: GateConfig,
): string | undefined {
  const snapshot = engine.peek(rootSessionId)
  const decision = decideTool(snapshot, toolName, args, config)
  switch (decision.kind) {
    case 'allow':
      return undefined
    case 'allow-degraded':
      return undefined
    case 'defer-egress':
      // The pre-execute seam owns this call. A guard denial here would be
      // monotonic and would override the human's allowed-once.
      return undefined
    case 'deny-plan-gate':
      return decision.reason
    case 'deny-usage-undeclared':
      return decision.reason
    case 'deny-egress':
      return decision.reason
    case 'deny-executor-bypass':
      return decision.reason
    default: {
      const exhaustive: never = decision
      throw new Error(`unhandled gate decision ${String(exhaustive)}`)
    }
  }
}
