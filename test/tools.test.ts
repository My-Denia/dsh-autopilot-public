/**
 * The model-facing tool surface — and specifically the OWNER-AUTHORITY gate.
 *
 * THE DEFECT THIS FILE EXISTS FOR (found 2026-08-25, independent repair audit).
 * `src/tools.ts` had ZERO test imports: no test file mentioned
 * `installRootTools`, `hasDirectHumanTurn`, `AP_OWNER_AUTHORITY_REQUIRED` or
 * `autopilot_signal`. Three mutations, applied and restored one at a time, all
 * left 15 files / 394 tests green:
 *
 *   E1  `hasDirectHumanTurn` returns true unconditionally      -> SURVIVED
 *   E2  `requireDirectHumanTurn` made a no-op                   -> SURVIVED
 *   E3  'owner-approve' removed from the action enum            -> SURVIVED
 *
 * (Control in the same battery: renaming `autopilot_init` KILLED a test in
 * `test/apply.test.ts`, so the module was loaded and reachable — it simply had
 * no bearer for this rule.)
 *
 * Why that matters more than a coverage number: DESIGN.md §2/§5 state that
 * under `enforcement.approval: 'signal-only'` a direct-human-turn
 * `owner-approve` is the ONLY thing that can authorize an egress. That is the
 * single human-authored link the whole egress chain rests on, and the previous
 * round's fungible-approval fix is worth nothing if an approval can be
 * self-granted by the agent that wants it.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { AutopilotError, requiredRoles } from '../src/domain/types.js'
import { hasDirectHumanTurn, installRootTools, packetToolDefinition } from '../src/tools.js'
import type { ToolRegistryRef } from '../src/tools.js'
import type { AgentRef } from '../src/engine.js'
import { fakeAgent, makeHarness, makeSnapshot, makeTriage, makeUsageEntry, stubSubagents, undeclaredSeed } from './helpers.js'
import type { Harness } from './helpers.js'

interface ToolDef {
  name: string
  parameters: unknown
  output: {
    schema: unknown
    render(args: unknown, value: never): unknown
  }
  execute(args: unknown, exec: unknown): Promise<unknown>
}

/** Install the root tools and hand back the definitions by name. */
function installed(engine: unknown): { defs: Map<string, ToolDef>; disposals: number } {
  const defs = new Map<string, ToolDef>()
  let disposals = 0
  const registry: ToolRegistryRef = {
    register(definition: unknown) {
      const def = definition as ToolDef
      defs.set(def.name, def)
      return () => { disposals += 1 }
    },
  }
  installRootTools(registry, engine as never)
  return { defs, get disposals() { return disposals } }
}

function toolOf(engine: unknown, name: string): ToolDef {
  const def = installed(engine).defs.get(name)
  if (def === undefined) throw new Error(`${name} was not registered`)
  return def
}

/** Open a turn on this agent's session, carrying a message from `source`. */
function openTurn(agent: AgentRef, source: { kind: string }): void {
  // The engine's `SessionRef.append` names only `sandbox/mode`; the fake
  // accepts any event type so a turn can be scripted (see test/helpers.ts).
  const session = agent.session as AgentRef['session'] & { append(type: string, data: unknown): void }
  session.append('turn/start', {})
  session.append('user/message', { source })
}

const EXEC = (agent: unknown) => ({ agent, signal: new AbortController().signal })

describe('hasDirectHumanTurn', () => {
  it('true only for a user-sourced message inside the OPEN turn', () => {
    const agent = fakeAgent('root-1')
    expect(hasDirectHumanTurn(agent)).toBe(false)
    openTurn(agent, { kind: 'user' })
    expect(hasDirectHumanTurn(agent)).toBe(true)
  })

  it('false for an agent-generated turn', () => {
    const agent = fakeAgent('root-1')
    openTurn(agent, { kind: 'agent' })
    expect(hasDirectHumanTurn(agent)).toBe(false)
  })

  it('false once the turn that carried the human message has ENDED', () => {
    const agent = fakeAgent('root-1')
    openTurn(agent, { kind: 'user' })
    expect(hasDirectHumanTurn(agent)).toBe(true)
    agent.session.append('turn/end', {})
    // Authority does not persist past the turn it was granted in: the scan walks
    // back from the tail and a `turn/end` before any `turn/start` is a closed
    // window.
    expect(hasDirectHumanTurn(agent)).toBe(false)
  })

  it('false when a turn is open but carries no user message at all', () => {
    const agent = fakeAgent('root-1')
    agent.session.append('turn/start', {})
    agent.session.append('assistant/message', { source: { kind: 'user' } })
    expect(hasDirectHumanTurn(agent)).toBe(false)
  })

  it('false for a message whose source is missing entirely', () => {
    const agent = fakeAgent('root-1')
    agent.session.append('turn/start', {})
    agent.session.append('user/message', {})
    expect(hasDirectHumanTurn(agent)).toBe(false)
  })
})

describe('autopilot_signal owner-approve is owner-only', () => {
  it('records the approval when a direct human turn is open', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    openTurn(h.root, { kind: 'user' })

    const signal = toolOf(h.engine, 'autopilot_signal')
    await signal.execute({ action: 'owner-approve', note: 'git push origin main' }, EXEC(h.root))

    const approvals = h.engine.peek(h.root.id)?.enforcement.ownerApprovals ?? []
    expect(approvals).toHaveLength(1)
    expect(approvals[0]?.target).toBe('git push origin main')
    expect(approvals[0]?.consumedBy).toBeUndefined()
  })

  it('REFUSES on an agent-generated turn, and writes nothing', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    openTurn(h.root, { kind: 'agent' })
    const before = h.engine.peek(h.root.id)?.revision

    const signal = toolOf(h.engine, 'autopilot_signal')
    try {
      await signal.execute({ action: 'owner-approve', note: 'git push origin main' }, EXEC(h.root))
      expect.unreachable('an agent-generated turn must not grant owner authority')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AutopilotError)
      expect((error as AutopilotError).code).toBe('AP_OWNER_AUTHORITY_REQUIRED')
    }
    // Not merely "it threw": no approval exists and the run did not advance.
    expect(h.engine.peek(h.root.id)?.enforcement.ownerApprovals).toEqual([])
    expect(h.engine.peek(h.root.id)?.revision).toBe(before)
  })

  it('REFUSES with no open turn at all', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    const signal = toolOf(h.engine, 'autopilot_signal')
    await expect(signal.execute({ action: 'owner-approve', note: 'git push' }, EXEC(h.root)))
      .rejects.toThrowError(/direct human turn/)
    expect(h.engine.peek(h.root.id)?.enforcement.ownerApprovals).toEqual([])
  })

  it('owner-resolve carries the same gate', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    await h.engine.setOwnerDecision(h.root, 'the owner has to choose')
    const signal = toolOf(h.engine, 'autopilot_signal')

    openTurn(h.root, { kind: 'agent' })
    await expect(signal.execute(
      { action: 'owner-resolve', note: 'carry on', ownerDecision: 'resume-planning' },
      EXEC(h.root),
    )).rejects.toThrowError(/direct human turn/)
    expect(h.engine.peek(h.root.id)?.phase).toBe('needs-owner-decision')

    // and the human CAN resolve it, so the gate is a decision rather than a wall
    openTurn(h.root, { kind: 'user' })
    await signal.execute(
      { action: 'owner-resolve', note: 'carry on', ownerDecision: 'resume-planning' },
      EXEC(h.root),
    )
    expect(h.engine.peek(h.root.id)?.phase).toBe('planning')
  })

  it('the NON owner-only actions are ungated, so the gate is not a blanket one', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    const signal = toolOf(h.engine, 'autopilot_signal')
    // No turn is open at all, and replan still works: `requireDirectHumanTurn`
    // is applied to the two owner-only branches specifically.
    await signal.execute({ action: 'replan', note: 'reality moved' }, EXEC(h.root))
    expect(h.engine.peek(h.root.id)?.phase).toBe('replanning')
  })

  it('owner-approve is a DECLARED action of the tool, not only a switch case', async () => {
    // Bears the action enum itself: dropping 'owner-approve' from it makes every
    // call above fail argument validation before the gate is ever reached, which
    // is a different defect with the same green suite.
    const h = makeHarness()
    const signal = toolOf(h.engine, 'autopilot_signal')
    const schema = JSON.stringify(signal.parameters)
    for (const action of ['replan', 'block', 'owner-decision', 'owner-approve', 'owner-resolve']) {
      expect(schema).toContain(action)
    }
    // `.rejects.toThrowError()` alone would pass whether the refusal came from
    // the schema, from the switch's `default:` arm, or from something
    // unrelated — a checker whose pass carries no information (DESIGN.md §5).
    // Assert WHICH layer refused: measured 2026-08-25, the refusal is
    // defineTool's argument validation, so the `default:` arm is unreachable
    // through this surface and is defence in depth only.
    await expect(signal.execute({ action: 'not-an-action', note: 'x' }, EXEC(h.root)))
      .rejects.toThrowError(/invalid arguments.*"action" must be one of/)
  })

  it('every DECLARED action is handled by the switch — the enum and the switch cannot drift apart', async () => {
    // The reachable half of the `default:` arm. An action string outside the
    // enum never gets here (defineTool refuses it first, asserted above), but
    // an action ADDED to the enum and forgotten in the switch DOES reach
    // `default:` and would come back as a thrown 'unknown action'. Nothing
    // else in the suite can observe that drift, so this walks the declared
    // enum itself rather than a hand-copied list — a hardcoded list would
    // pass unchanged when someone adds the sixth action.
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    const signal = toolOf(h.engine, 'autopilot_signal')
    const declared = (signal.parameters as { properties?: { action?: { enum?: string[] } } })
      .properties?.action?.enum
    expect(declared).toBeDefined()
    expect(declared?.length).toBeGreaterThanOrEqual(5)
    for (const action of declared ?? []) {
      // Most of these legitimately reject for their OWN reasons (owner-only
      // gate, wrong phase). What must never happen is the switch not knowing
      // the action at all, so assert on the failure's identity, not on success.
      const outcome = await signal
        .execute({ action, note: 'drift probe', ownerDecision: 'block' }, EXEC(h.root))
        .then(() => undefined, (error: unknown) => error as Error)
      if (outcome !== undefined) {
        expect(outcome.message).not.toMatch(/unknown action/)
      }
    }
  })
})

describe('installRootTools registers the controller surface once, and disposes it', () => {
  it('registers every root tool and hands back one disposer per registration', () => {
    const h = makeHarness()
    const registry = installed(h.engine)
    for (const name of [
      'autopilot_init',
      'autopilot_usage',
      'autopilot_submit_plan',
      'autopilot_audit',
      'autopilot_self_check',
      'autopilot_executor',
      'autopilot_submit_evidence',
      'autopilot_signal',
      'autopilot_submit_closeout',
    ]) {
      expect(registry.defs.has(name)).toBe(true)
    }
    // and the packet tool is NOT part of the root surface: it is installed only
    // into the authorized executor child (fail-closed absence).
    expect(registry.defs.has('autopilot_submit_packet')).toBe(false)
  })

  it('a caller that is not an Agent is refused before anything is written', async () => {
    const h = makeHarness()
    const signal = toolOf(h.engine, 'autopilot_signal')
    await expect(signal.execute({ action: 'replan', note: 'x' }, { signal: new AbortController().signal }))
      .rejects.toThrowError(/requires a calling Agent/)
  })
})

/**
 * ── Round 4: the argument-mapping layer ──────────────────────────────────────
 *
 * Everything below bears a rule that lives ONLY in this file's mapping from
 * tool arguments to engine calls. The round-3 battery above proved the
 * owner-authority gate; a 2026-08-25 mutation sweep then showed that fifteen
 * further mutations to `src/tools.ts` left 17 files / 468 tests green, because
 * no test had ever driven a registered tool's `execute` for anything but
 * `autopilot_signal`. Each `it` below names the mutation it was watched to
 * kill, with the red count measured in a sandbox copy before it was written in.
 */

/** Delegated standard run, plan gate passed, phase `executing`, no executor yet. */
async function delegatedExecuting(): Promise<Harness> {
  const subagents = stubSubagents({ verdicts: [{ verdict: 'pass', note: 'plan ok' }] })
  const h = makeHarness({ subagents })
  await h.engine.init(
    h.root,
    makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' }),
    [undeclaredSeed('m1')],
  )
  await h.engine.declareUsage(h.root, makeUsageEntry({ id: 'm1' }))
  await h.engine.submitPlan(h.root, 'plan')
  await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
  return h
}

/** Inline lightweight run driven to `closing`, ready for a closeout submission. */
async function readyToClose(criteria: string[] = ['tests pass']): Promise<Harness> {
  const h = makeHarness()
  await h.engine.init(h.root, makeTriage({ acceptanceCriteria: criteria }))
  await h.engine.submitPlan(h.root, 'plan')
  await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'ok' })
  await h.engine.submitExecutionEvidence(h.root, { report: 'r', residualRisks: [] })
  await h.engine.selfCheck(h.root, { role: 'execution', verdict: 'pass', note: 'ok' })
  return h
}

/** The triage `autopilot_init` receives for a standard inline run. */
const STANDARD_INIT = {
  objective: 'ship the thing',
  scope: ['src/'],
  nonGoals: ['docs/'],
  acceptanceCriteria: ['tests pass'],
  risk: 'low',
  size: 'standard',
  executionMode: 'inline',
  auditMode: 'independent',
} as const

describe('hasDirectHumanTurn is a PER-TURN check, not a session-long grant', () => {
  /**
   * The two loops fail independently. The backward loop that finds the turn
   * boundary is guarded four ways by the tests above; the FORWARD loop that
   * reads the window was guarded by nothing — `for (let i = turnStart; …)` ->
   * `for (let i = 0; …)` computes `turnStart` and then ignores it, and every
   * one of those four tests stayed green. Any human message anywhere in session
   * history would then authorize every later agent turn's owner-approve.
   */
  it('false when the human message belongs to an EARLIER, closed turn', () => {
    const agent = fakeAgent('root-1')
    openTurn(agent, { kind: 'user' })
    agent.session.append('turn/end', {})
    agent.session.append('turn/start', {}) // the agent's own next turn
    expect(hasDirectHumanTurn(agent)).toBe(false)

    // …and the SAME log becomes true the moment the human speaks in the turn
    // that is actually open, so this is a window, not a wall.
    agent.session.append('user/message', { source: { kind: 'user' } })
    expect(hasDirectHumanTurn(agent)).toBe(true)
  })

  it('owner-approve is refused on the agent turn that FOLLOWS a human turn', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    openTurn(h.root, { kind: 'user' })
    h.root.session.append('turn/end', {})
    h.root.session.append('turn/start', {})

    const signal = toolOf(h.engine, 'autopilot_signal')
    await expect(signal.execute({ action: 'owner-approve', note: 'git push origin main' }, EXEC(h.root)))
      .rejects.toThrowError(/direct human turn/)
    expect(h.engine.peek(h.root.id)?.enforcement.ownerApprovals).toEqual([])
  })
})

describe('autopilot_signal maps each action to its OWN engine transition', () => {
  it('block is TERMINAL and owner-decision is NOT — they are not interchangeable', async () => {
    const blocked = makeHarness()
    await blocked.engine.init(blocked.root, makeTriage())
    await toolOf(blocked.engine, 'autopilot_signal')
      .execute({ action: 'block', note: 'the premise is wrong' }, EXEC(blocked.root))
    expect(blocked.engine.peek(blocked.root.id)?.phase).toBe('blocked')

    const parked = makeHarness()
    await parked.engine.init(parked.root, makeTriage())
    await toolOf(parked.engine, 'autopilot_signal')
      .execute({ action: 'owner-decision', note: 'the owner has to choose' }, EXEC(parked.root))
    expect(parked.engine.peek(parked.root.id)?.phase).toBe('needs-owner-decision')
  })

  it('owner-resolve REFUSES a missing ruling instead of defaulting to resume', async () => {
    // `ownerDecision` is deliberately optional in the schema, which is exactly
    // why the runtime check exists: a truncated or malformed resolve must mean
    // "refuse", never "continue".
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    await h.engine.setOwnerDecision(h.root, 'the owner has to choose')
    openTurn(h.root, { kind: 'user' }) // a real human turn: only the ruling is missing

    const signal = toolOf(h.engine, 'autopilot_signal')
    try {
      await signal.execute({ action: 'owner-resolve', note: 'carry on' }, EXEC(h.root))
      expect.unreachable('a resolve with no ruling must not resume the run')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AutopilotError)
      expect((error as AutopilotError).code).toBe('AP_INVALID_ARGUMENT')
    }
    expect(h.engine.peek(h.root.id)?.phase).toBe('needs-owner-decision')
  })
})

describe('autopilot_init argument mapping', () => {
  it('seeds the usage question on STANDARD runs and exempts lightweight ones', async () => {
    // DESIGN.md §6 names this ternary as the sole home of the invariant: the
    // v2 usage dimension exists for standard runs and lightweight runs are
    // explicitly exempt. Inverting it evaporates the dimension for exactly the
    // runs it was built for.
    const standard = makeHarness()
    const created = await toolOf(standard.engine, 'autopilot_init')
      .execute({ ...STANDARD_INIT }, EXEC(standard.root)) as {
        usage?: { entries: Array<{ id: string; usageClass: string }> }
      }
    expect(created.usage?.entries.map(entry => [entry.id, entry.usageClass]))
      .toEqual([['m1', 'undeclared']])

    const light = makeHarness()
    const lightweight = await toolOf(light.engine, 'autopilot_init')
      .execute({ ...STANDARD_INIT, size: 'lightweight', auditMode: 'self-check' }, EXEC(light.root)) as {
        usage?: unknown
      }
    expect(lightweight.usage).toBeUndefined()
  })

  it('seeds one entry per declared usageId when the caller supplies them', async () => {
    const h = makeHarness()
    const created = await toolOf(h.engine, 'autopilot_init')
      .execute({ ...STANDARD_INIT, usageIds: ['cli-flag', 'error-path'] }, EXEC(h.root)) as {
        usage?: { entries: Array<{ id: string }> }
      }
    expect(created.usage?.entries.map(entry => entry.id)).toEqual(['cli-flag', 'error-path'])
  })

  it('defaults touchesOperatingLayer to FALSE, so no run silently acquires the rules auditor', async () => {
    const plain = makeHarness()
    await toolOf(plain.engine, 'autopilot_init').execute({ ...STANDARD_INIT }, EXEC(plain.root))
    expect(plain.engine.status(plain.root)?.requiredRoles).toEqual(['plan', 'execution'])

    // The positive half, so the default is a decision rather than an accident.
    const operating = makeHarness()
    await toolOf(operating.engine, 'autopilot_init')
      .execute({ ...STANDARD_INIT, touchesOperatingLayer: true }, EXEC(operating.root))
    expect(operating.engine.status(operating.root)?.requiredRoles).toContain('rules')
  })
})

describe('autopilot_usage files what was DECLARED', () => {
  it('records the declared class, and refuses an unmet one instead of downgrading it', async () => {
    const h = makeHarness()
    await toolOf(h.engine, 'autopilot_init').execute({ ...STANDARD_INIT }, EXEC(h.root))
    const usage = toolOf(h.engine, 'autopilot_usage')

    await usage.execute({ id: 'm1', usageClass: 'docs' }, EXEC(h.root))
    expect(h.engine.peek(h.root.id)?.usage?.entries[0]?.usageClass).toBe('docs')

    // A gui change with no evidence must be REFUSED. Rewriting the class to the
    // obligation-free `internal` would let it through with the declarer's
    // honest answer discarded.
    await expect(usage.execute({ id: 'm1', usageClass: 'gui' }, EXEC(h.root)))
      .rejects.toThrowError(/class gui needs >=1 artifact/)
    expect(h.engine.peek(h.root.id)?.usage?.entries[0]?.usageClass).toBe('docs')
  })

  it('does NOT fabricate boundary states for a declaration that supplied none', async () => {
    const h = makeHarness()
    await toolOf(h.engine, 'autopilot_init').execute({ ...STANDARD_INIT }, EXEC(h.root))
    // One artifact, zero boundary states: the ONLY problems left are the
    // boundary-state floors, so the error text resolves the mapping by value.
    // Defaulting to two canonical states makes this call succeed.
    await expect(toolOf(h.engine, 'autopilot_usage').execute({
      id: 'm1',
      usageClass: 'gui',
      artifacts: [{
        kind: 'screenshot',
        ref: 'usage/m1.png',
        covers: ['empty'],
        capturedAt: new Date().toISOString(),
      }],
    }, EXEC(h.root))).rejects.toThrowError(/class gui needs >=2 boundary states, has 0/)
  })
})

describe('autopilot_self_check records the verdict it was GIVEN', () => {
  it('an honest needs-fix is not rewritten to pass on the way to the engine', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'ok' })
    await h.engine.submitExecutionEvidence(h.root, { report: 'r', residualRisks: [] })

    await toolOf(h.engine, 'autopilot_self_check').execute(
      { role: 'execution', verdict: 'needs-fix', note: 'the CLI still crashes on empty input' },
      EXEC(h.root),
    )
    const snapshot = h.engine.peek(h.root.id)
    expect(snapshot?.audits[snapshot.audits.length - 1]?.verdict).toBe('needs-fix')
    // and the gate it drives moved with it, so the record is not merely stored
    expect(snapshot?.executionGate).toBe('needs-fix')
    expect(snapshot?.phase).not.toBe('closing')
  })
})

describe('autopilot_audit declares every role the domain can require', () => {
  it('the role enum equals the AuditRole set, derived rather than hand-copied', () => {
    const h = makeHarness()
    const roles = requiredRoles(makeTriage({
      touchesOperatingLayer: true,
      risk: 'high',
      auditMode: 'independent',
    }))
    expect(roles.length).toBe(3) // cardinality floor: a shrinking union must fail here too
    const declared = (toolOf(h.engine, 'autopilot_audit').parameters as {
      properties: { role: { enum: string[] } }
    }).properties.role.enum
    expect([...declared].sort()).toEqual([...roles].sort())
  })

  it('a rules audit really dispatches through the tool', async () => {
    const subagents = stubSubagents({
      verdicts: [{ verdict: 'pass', note: 'plan ok' }, { verdict: 'pass', note: 'rules ok' }],
    })
    const h = makeHarness({ subagents })
    await h.engine.init(h.root, makeTriage({
      risk: 'high',
      auditMode: 'independent',
      touchesOperatingLayer: true,
    }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    await h.engine.submitExecutionEvidence(h.root, { report: 'r', residualRisks: [] })

    await toolOf(h.engine, 'autopilot_audit')
      .execute({ role: 'rules', prompt: 'contract + plan + diff + raw output' }, EXEC(h.root))
    expect(h.engine.peek(h.root.id)?.audits.some(record => record.role === 'rules')).toBe(true)
  })
})

describe('autopilot_executor routes each action to its own engine method', () => {
  it("start creates a child; resume with no child is refused, not silently started", async () => {
    const h = await delegatedExecuting()
    const executor = toolOf(h.engine, 'autopilot_executor')

    // Swapping the branches makes THIS call start a fresh child instead — the
    // continuity the continuable-child design exists for, destroyed silently.
    await expect(executor.execute({ action: 'resume', prompt: 'carry on' }, EXEC(h.root)))
      .rejects.toThrowError(/no executor to resume/)
    expect(h.engine.peek(h.root.id)?.executor).toBeUndefined()

    await executor.execute({ action: 'start', prompt: 'go' }, EXEC(h.root))
    expect(typeof h.engine.peek(h.root.id)?.executor?.childId).toBe('string')
  })
})

describe('autopilot_submit_packet goes through the EXECUTOR path, not the inline one', () => {
  it('an authorized child submits, and a stranger child is refused by identity', async () => {
    const h = await delegatedExecuting()
    await toolOf(h.engine, 'autopilot_executor').execute({ action: 'start', prompt: 'go' }, EXEC(h.root))
    const childId = h.engine.peek(h.root.id)?.executor?.childId as string
    const childAgent = fakeAgent(childId, h.root.id)
    h.agents.add(childAgent)

    const packet = packetToolDefinition(h.engine as never) as ToolDef
    await packet.execute(
      { packet: 'changed a.ts; pnpm test 12/12 pass', residualRisks: ['flaky on windows'], executionRevision: 1 },
      EXEC(childAgent),
    )
    const snapshot = h.engine.peek(h.root.id)
    expect(snapshot?.phase).toBe('execution-reviewing')
    expect(snapshot?.executionPacket).toBe('changed a.ts; pnpm test 12/12 pass')
    expect(snapshot?.residualRisks).toEqual(['flaky on windows'])

    // The identity half of the same route: routing this through the INLINE
    // evidence method would fail here on "not the live root" rather than on the
    // executor binding, so the code resolves which path ran.
    const stranger = fakeAgent('some-other-child', h.root.id)
    h.agents.add(stranger)
    try {
      await packet.execute({ packet: 'mine now', residualRisks: [], executionRevision: 1 }, EXEC(stranger))
      expect.unreachable('an unauthorized child must not land a packet')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AutopilotError)
      expect((error as AutopilotError).code).toBe('AP_EXECUTOR_MISMATCH')
    }
  })

  it('REFUSES a packet execute that omits executionRevision', async () => {
    const h = await delegatedExecuting()
    await toolOf(h.engine, 'autopilot_executor').execute({ action: 'start', prompt: 'go' }, EXEC(h.root))
    const childId = h.engine.peek(h.root.id)?.executor?.childId as string
    const childAgent = fakeAgent(childId, h.root.id)
    h.agents.add(childAgent)
    const packet = packetToolDefinition(h.engine as never) as ToolDef
    await expect(packet.execute({ packet: 'changed a.ts', residualRisks: [] }, EXEC(childAgent)))
      .rejects.toThrowError(/invalid arguments.*executionRevision/)
    expect(h.engine.peek(h.root.id)?.executionPacket).toBeUndefined()
  })
})

describe('closeout and evidence argument mapping', () => {
  it('submit_evidence carries the declared residual risks into execution review', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'ok' })

    await toolOf(h.engine, 'autopilot_submit_evidence').execute(
      { report: 'changed a.ts', residualRisks: ['the retry path is untested'] },
      EXEC(h.root),
    )
    expect(h.engine.peek(h.root.id)?.residualRisks).toEqual(['the retry path is untested'])
  })

  it('the closeout persists drift and residual risks VERBATIM', async () => {
    // `drift` is the field whose whole purpose is to carry findings out of the
    // run; substituting a constant destroys the information at the tool
    // boundary, after the model honestly produced it.
    const h = await readyToClose()
    await toolOf(h.engine, 'autopilot_submit_closeout').execute({
      summary: 'done',
      changedFiles: ['a.ts'],
      commands: ['pnpm test - pass'],
      evidence: [{ criterion: 'tests pass', bearer: 'test-run.txt', status: 'proven', kind: 'path' }],
      residualRisks: ['the retry path is untested'],
      workspaceCleanup: 'nothing created',
      drift: 'README badge points at the old workflow name',
    }, EXEC(h.root))

    const closeout = h.engine.peek(h.root.id)?.closeout
    expect(closeout?.drift).toBe('README badge points at the old workflow name')
    expect(closeout?.residualRisks).toEqual(['the retry path is untested'])
    expect(h.engine.peek(h.root.id)?.phase).toBe('completed')
  })

  it('REFUSES an evidence entry with no criterion, so a bearer cannot bind to nothing', async () => {
    // Measured, not assumed: `evaluateCompletion` walks the CRITERIA and checks
    // each has exactly one entry, so a criterion-less EXTRA entry is invisible
    // to it. With the schema's `required: true` dropped, this exact closeout
    // completes the run (revision 6, phase 'completed') carrying a bearer bound
    // to nothing. The schema flag is the only refusal, which is why the
    // `as never` cast that hid it from `tsc` is gone as well.
    const h = await readyToClose()
    await expect(toolOf(h.engine, 'autopilot_submit_closeout').execute({
      summary: 'done',
      changedFiles: ['a.ts'],
      commands: ['pnpm test - pass'],
      evidence: [
        { criterion: 'tests pass', bearer: 'test-run.txt', status: 'proven', kind: 'path' },
        { bearer: 'unbound.txt', status: 'proven', kind: 'path' },
      ],
      workspaceCleanup: 'nothing created',
      drift: 'none found',
    }, EXEC(h.root))).rejects.toThrowError(/criterion/)
    expect(h.engine.peek(h.root.id)?.phase).toBe('closing')
    expect(h.engine.peek(h.root.id)?.closeout).toBeUndefined()
  })

  it('the closeout schema DECLARES kind as required, with exactly the two domain values', async () => {
    // Read off the declared schema rather than inferred from a call, because
    // the call cannot see this flag: unlike the criterion case above, the
    // ENGINE also refuses a kind-less proven entry, so dropping `required` here
    // leaves the behavioural test below green (measured: it stayed green under
    // exactly that mutation). The schema flag is defence in depth, and this is
    // the only assertion that observes it. The enum is asserted against the
    // domain type's two values so a third one cannot appear in the schema
    // alone — `pnpm run check` covers the other direction.
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    const item = (toolOf(h.engine, 'autopilot_submit_closeout').parameters as {
      properties: {
        evidence: {
          items: {
            required?: string[]
            properties: Record<string, { enum?: string[] }>
          }
        }
      }
    }).properties.evidence.items
    // `defineTool` compiles the per-property `required: true` into a JSON
    // Schema `required` LIST on the item, so that is where it is read from.
    expect(item.required).toContain('kind')
    expect([...(item.properties.kind?.enum ?? [])].sort()).toEqual(['command', 'path'])
  })

  it('REFUSES an evidence entry with no kind, so the bearer comparison cannot be guessed', async () => {
    // The tool CALL PATH refuses — asserted end to end, deliberately without
    // pinning which layer did it, because TWO layers do and which one you get
    // depends on the schema. Measured both ways:
    //   schema flag PRESENT — dsh's own args validator refuses first
    //     (ToolArgsError / INVALID_ARGS,
    //      `invalid arguments: missing required property "evidence[0].kind"`);
    //   schema flag DROPPED — the engine refuses instead
    //     (AutopilotError / AP_EVIDENCE_KIND_REQUIRED,
    //      `closeout refused: proven evidence entry has no kind: …`).
    // Either way this test stays green, which is exactly why the schema half
    // has its own assertion above instead of a claim here it cannot support.
    // Without `kind` the comparison falls back to a shape heuristic that cannot
    // tell a file named `git status` from the command `git status`.
    const h = await readyToClose()
    await expect(toolOf(h.engine, 'autopilot_submit_closeout').execute({
      summary: 'done',
      changedFiles: ['a.ts'],
      commands: ['pnpm test - pass'],
      evidence: [{ criterion: 'tests pass', bearer: 'test-run.txt', status: 'proven' }],
      workspaceCleanup: 'nothing created',
      drift: 'none found',
    }, EXEC(h.root))).rejects.toThrowError(/kind/)
    expect(h.engine.peek(h.root.id)?.phase).toBe('closing')
    expect(h.engine.peek(h.root.id)?.closeout).toBeUndefined()
    // Nothing reached the medium either: a refused closeout must leave no
    // event behind for a later fold to trip over.
    const path = join(h.storeDir, 'runs', h.root.id, 'events.jsonl')
    const ops = readFileSync(path, 'utf8').trim().split(String.fromCharCode(10))
      .map(line => (JSON.parse(line) as { op: string }).op)
    expect(ops.filter(op => op === 'submit-closeout')).toHaveLength(0)
  })

  it('ACCEPTS an evidence entry with kind command and stamps the committed event', async () => {
    // DETECTOR for the refusal above: the tool is rejecting the MISSING field,
    // not rejecting closeouts generally, and `command` is a real accepted value
    // rather than a shape the schema happens to tolerate.
    const h = await readyToClose()
    await toolOf(h.engine, 'autopilot_submit_closeout').execute({
      summary: 'done',
      changedFiles: ['a.ts'],
      commands: ['pnpm test - pass'],
      evidence: [{ criterion: 'tests pass', bearer: 'pnpm test - 962 pass', status: 'proven', kind: 'command' }],
      workspaceCleanup: 'nothing created',
      drift: 'none found',
    }, EXEC(h.root))

    expect(h.engine.peek(h.root.id)?.phase).toBe('completed')
    expect(h.engine.peek(h.root.id)?.closeout?.evidence[0]?.kind).toBe('command')
    const path = join(h.storeDir, 'runs', h.root.id, 'events.jsonl')
    const closeouts = readFileSync(path, 'utf8').trim().split(String.fromCharCode(10))
      .map(line => JSON.parse(line) as { op: string; detail?: { evidenceKinds?: unknown } })
      .filter(event => event.op === 'submit-closeout')
    expect(closeouts).toHaveLength(1)
    expect(closeouts[0]?.detail?.evidenceKinds).toBe(1)
  })
})

describe('installRootTools is all-or-nothing', () => {
  it('rolls back every prior registration when one throws, leaking no partial surface', () => {
    // The success half of this property is asserted in test/apply.test.ts ("the
    // split-brain window is empty"); the FAILURE half had no bearer, so a host
    // could be left with autopilot_init installed and autopilot_submit_closeout
    // absent, with no disposer able to clean it up.
    const disposed: number[] = []
    let registered = 0
    const registry: ToolRegistryRef = {
      register() {
        registered += 1
        if (registered === 5) throw new Error('this host refuses the fifth tool')
        const index = registered
        return () => { disposed.push(index) }
      },
    }
    const h = makeHarness()
    expect(() => installRootTools(registry, h.engine as never)).toThrowError(/refuses the fifth tool/)
    // Every disposer handed back before the throw ran, newest first.
    expect(disposed).toEqual([4, 3, 2, 1])
  })
})

/**
 * ── Round 8: THE TOOL-OUTPUT CONTRACT, crossed for real ──────────────────────
 *
 * THE DEFECT THIS SECTION EXISTS FOR (found 2026-08-25 on the REAL dsh host,
 * 100% reproduction across 11+ live sessions, zero reproduction in 556 green
 * tests). `autopilot_init` returned `usage: snapshot.usage`, and `usage` is
 * seeded STANDARD-ONLY. Every lightweight run therefore returned an own
 * enumerable property holding `undefined`, and dsh answered:
 *
 *   Error: tool "autopilot_init" returned invalid output: value is not lossless JSON
 *
 * AFTER the run was already created — so the retry met "an autopilot run is
 * already active on this session". The model was told the harness had failed
 * while the harness had in fact succeeded.
 *
 * THE RULE, read from the real source (packages/core/session/src/json.ts in the
 * upstream dsh tree). `walkJsonValue` visits every OWN ENUMERABLE STRING key
 * (`enumerableStringKeys` rejects symbol and non-enumerable own keys outright)
 * and accepts only: null, boolean, string, finite non-negative-zero number,
 * intrinsic-prototyped dense array, plain/null-prototype object. `undefined`
 * matches none of those arms and falls through to
 * `if (typeof current !== 'object') return undefined` — the whole value is
 * rejected. An ABSENT key is never visited. So `{ usage: undefined }` fails and
 * `{}` passes, even though `JSON.stringify` cannot tell them apart. That
 * asymmetry is precisely why a suite that stringifies tool output cannot see
 * this class of defect.
 *
 * WHY THE OLD TESTS COULD NOT CATCH IT. They called `def.execute()` and asserted
 * on the returned object. dsh never hands that object to the model: it goes
 * through `ToolRuntime.createSuccessResult`, which snapshots it
 * (`snapshotToolValue` -> `snapshotJsonValue`), schema-validates the SNAPSHOT,
 * and renders it. Nothing below `execute` was ever exercised.
 *
 * HOW REAL THIS CROSSING IS. `snapshotJsonValue` is imported from
 * `@deepseek-ai/dsh-util-values` (its home since dsh 0.1.2; dsh-session
 * before) and `validateJsonSchemaValue` from `@deepseek-ai/dsh-tools` — the
 * SAME symbols, at the same installed versions (0.1.2-rc.1), that
 * `createSuccessResult` calls; nothing here re-implements the
 * rule. `commitThroughDsh` is that method's body minus the parts that need a
 * live cordis Context (canonicality marking, `deepFreeze`, presentation `meta`,
 * and the `tools/result` event append). `ToolRuntime` is itself a cordis
 * `Service` with `static inject` and cannot be constructed without the host, so
 * it is the one link in this chain still absent — see DESIGN.md §6.
 */

/** dsh's own validated-commit path over one tool result. Real symbols, real rule. */
function commitThroughDsh(def: ToolDef, args: unknown, candidate: unknown): unknown {
  const detached = snapshotJsonValue(candidate)
  if (detached === undefined) {
    // Verbatim the message the live host produced (`ToolOutputError` formats as
    // `tool "<name>" returned invalid output: <violations>`).
    throw new Error(`tool "${def.name}" returned invalid output: value is not lossless JSON`)
  }
  const violations = validateJsonSchemaValue(def.output.schema as never, detached as never, 'value')
  if (violations.length > 0) {
    throw new Error(`tool "${def.name}" returned invalid output: ${violations.join('; ')}`)
  }
  const rendered = def.output.render(args, detached as never)
  if (snapshotJsonValue(rendered) === undefined) {
    throw new Error(`tool "${def.name}" output.render returned non-lossless JSON`)
  }
  return detached
}

/** Call a tool the way dsh does: execute, then commit the value through the real boundary. */
async function callThroughDsh(def: ToolDef, args: unknown, exec: unknown): Promise<unknown> {
  return commitThroughDsh(def, args, await def.execute(args, exec))
}

describe('the crossing itself has teeth', () => {
  /**
   * A checker that accepts everything is indistinguishable from no checker
   * (DESIGN.md §5), and every test below is worthless if `commitThroughDsh`
   * cannot reject. So: the exact shipped shape, and the exact shipped message.
   */
  it('rejects an own property holding undefined, with the live error text', () => {
    // The REAL shipped definition, so the schema under test is the one
    // `defineTool` compiled (measured: `{ type: 'json' }` compiles to `{}`), not
    // a schema invented here.
    const def = toolOf(makeHarness().engine, 'autopilot_init')
    expect(() => commitThroughDsh(def, {}, { revision: 1, phase: 'planning', usage: undefined }))
      .toThrowError('tool "autopilot_init" returned invalid output: value is not lossless JSON')
    // …and the SAME body with the key OMITTED passes, so the rule under test is
    // "own undefined property", not "an object with three keys".
    expect(commitThroughDsh(def, {}, { revision: 1, phase: 'planning' }))
      .toEqual({ revision: 1, phase: 'planning' })
  })

  it('agrees with the upstream rule on the other rejected shapes', () => {
    const def = toolOf(makeHarness().engine, 'autopilot_status')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    for (const bad of [{ n: Number.NaN }, { n: -0 }, { f: () => 1 }, cyclic, { d: new Date() }]) {
      expect(() => commitThroughDsh(def, {}, bad)).toThrowError(/not lossless JSON/)
    }
  })
})

describe('THE SHIPPED DEFECT: autopilot_init output survives dsh', () => {
  /**
   * MUTATION WATCHED: restore `usage: snapshot.usage` (the shipped line) in
   * `src/tools.ts`. Measured in a sandbox copy 2026-08-25 — the suite went red
   * HERE, with the verbatim live message.
   */
  it('a LIGHTWEIGHT init — the 100%-reproduction case — commits cleanly', async () => {
    const h = makeHarness()
    const init = toolOf(h.engine, 'autopilot_init')
    const args = { ...STANDARD_INIT, size: 'lightweight', auditMode: 'self-check' }
    const committed = await callThroughDsh(init, args, EXEC(h.root)) as Record<string, unknown>

    // Not merely "it did not throw": the key is ABSENT, not present-and-null.
    expect(Object.prototype.hasOwnProperty.call(committed, 'usage')).toBe(false)
    expect(committed.phase).toBe('planning')
    // The run really was created, which is what made the live failure so bad:
    // the model saw an error for a run that exists.
    expect(h.engine.peek(h.root.id)?.revision).toBe(1)
  })

  it('a STANDARD init still carries the seeded usage question through the boundary', async () => {
    // The other half: omission must be CONDITIONAL. Deleting the `usage` key
    // outright would pass the test above and silently destroy the v2 usage
    // dimension on exactly the runs it exists for.
    const h = makeHarness()
    const committed = await callThroughDsh(
      toolOf(h.engine, 'autopilot_init'),
      { ...STANDARD_INIT },
      EXEC(h.root),
    ) as { usage?: { entries: Array<{ id: string; usageClass: string }> } }
    expect(committed.usage?.entries).toEqual([
      { id: 'm1', usageClass: 'undeclared', boundaryStates: [], artifacts: [], attempted: [] },
    ])
  })
})

describe('EVERY tool output survives dsh, not just the one that was reported', () => {
  /**
   * The audit the reported defect asks for. One tool fixed is one tool fixed;
   * this drives the whole surface — including the executor-child packet tool —
   * through the real serializer in one realistic run, so a future output
   * property that can hold `undefined` fails here rather than on a live host.
   */
  it('drives a full delegated standard run tool-by-tool through the boundary', async () => {
    const subagents = stubSubagents({
      verdicts: [{ verdict: 'pass', note: 'plan ok' }, { verdict: 'pass', note: 'execution ok' }],
    })
    const h = makeHarness({ subagents })
    const tool = (name: string) => toolOf(h.engine, name)

    await callThroughDsh(tool('autopilot_status'), {}, EXEC(h.root)) // the NO-run branch
    await callThroughDsh(tool('autopilot_init'), {
      ...STANDARD_INIT,
      auditMode: 'independent',
      executionMode: 'delegated',
      baselineCommit: 'abc123',
      usageIds: ['m1'],
    }, EXEC(h.root))
    await callThroughDsh(tool('autopilot_status'), {}, EXEC(h.root)) // the LIVE-run branch
    await callThroughDsh(tool('autopilot_usage'), {
      id: 'm1',
      usageClass: 'cli',
      boundaryStates: ['empty', 'error-path'],
      artifacts: [{
        kind: 'session-log',
        ref: 'usage/m1.log',
        covers: ['empty'],
        capturedAt: new Date().toISOString(),
      }],
    }, EXEC(h.root))
    await callThroughDsh(tool('autopilot_log'), { text: 'ran the thing', stance: 'on-plan' }, EXEC(h.root))
    await callThroughDsh(tool('autopilot_signal'), { action: 'replan', note: 'reality moved' }, EXEC(h.root))
    await callThroughDsh(tool('autopilot_submit_plan'), { text: 'plan' }, EXEC(h.root))
    await callThroughDsh(tool('autopilot_audit'), { role: 'plan', prompt: 'packet' }, EXEC(h.root))
    await callThroughDsh(tool('autopilot_executor'), { action: 'start', prompt: 'go' }, EXEC(h.root))

    const childId = h.engine.peek(h.root.id)?.executor?.childId as string
    const child = fakeAgent(childId, h.root.id)
    h.agents.add(child)
    await callThroughDsh(
      packetToolDefinition(h.engine as never) as ToolDef,
      { packet: 'changed a.ts', residualRisks: ['flaky'], executionRevision: 1 },
      EXEC(child),
    )
    await callThroughDsh(tool('autopilot_audit'), { role: 'execution', prompt: 'packet' }, EXEC(h.root))
    expect(h.engine.peek(h.root.id)?.phase).toBe('closing')
  })

  it('the self-check, evidence, closeout and owner-signal outputs commit too', async () => {
    const h = await readyToClose()
    openTurn(h.root, { kind: 'user' })
    await callThroughDsh(
      toolOf(h.engine, 'autopilot_signal'),
      { action: 'owner-approve', note: 'git push origin main' },
      EXEC(h.root),
    )
    await callThroughDsh(toolOf(h.engine, 'autopilot_submit_closeout'), {
      summary: 'done',
      changedFiles: ['a.ts'],
      commands: ['npx vitest run - pass'],
      evidence: [{ criterion: 'tests pass', bearer: 'test-run.txt', status: 'proven', kind: 'path' }],
      workspaceCleanup: 'nothing created',
      drift: 'none found',
    }, EXEC(h.root))
    expect(h.engine.peek(h.root.id)?.phase).toBe('completed')

    const inline = makeHarness()
    await inline.engine.init(inline.root, makeTriage())
    await inline.engine.submitPlan(inline.root, 'plan')
    await callThroughDsh(
      toolOf(inline.engine, 'autopilot_self_check'),
      { role: 'plan', verdict: 'pass', note: 'ok' },
      EXEC(inline.root),
    )
    await callThroughDsh(
      toolOf(inline.engine, 'autopilot_submit_evidence'),
      { report: 'changed a.ts', residualRisks: [] },
      EXEC(inline.root),
    )
    expect(inline.engine.peek(inline.root.id)?.phase).toBe('execution-reviewing')
  })
})

describe('output shaping is TOTAL over the declared Snapshot type', () => {
  /**
   * `Snapshot.usage` and `Snapshot.executor` are OPTIONAL in `domain/types.ts`.
   * The engine happens to set both on every path that returns normally today,
   * so `usage: snapshot.usage` in `autopilot_usage` and `executor:
   * snapshot.executor` in `autopilot_executor` were unreachable-undefined
   * THROUGH THE ENGINE — which is exactly the reasoning that shipped the
   * `autopilot_init` failure. `snapshot.usage` was "obviously always set" there
   * too, until seeding became standard-only.
   *
   * So this bearer substitutes the ENGINE (a structural collaborator these tests
   * already stub) while keeping the BOUNDARY real, and hands the tool a
   * `makeSnapshot()` — a legal value of the declared return type with both
   * optionals absent. The tool must be total over its own declared input type.
   *
   * MUTATIONS WATCHED (sandbox copy, 2026-08-25):
   *   `...(snapshot.usage === undefined ? {} : { usage: … })` -> `usage: snapshot.usage`
   *   `executorOutput`'s conditional spread   -> `executor: snapshot.executor`
   */
  const bareEngine = {
    declareUsage: () => Promise.resolve(makeSnapshot()),
    startExecutor: () => Promise.resolve(makeSnapshot()),
    resumeExecutor: () => Promise.resolve(makeSnapshot()),
  }

  it('autopilot_usage omits an absent usage dimension instead of emitting undefined', async () => {
    const def = toolOf(bareEngine, 'autopilot_usage')
    const args = { id: 'm1', usageClass: 'docs' }
    const committed = await callThroughDsh(def, args, EXEC(fakeAgent('root-1'))) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(committed, 'usage')).toBe(false)
    expect(committed.revision).toBe(1)
  })

  it('autopilot_executor omits an absent executor record on BOTH actions', async () => {
    const def = toolOf(bareEngine, 'autopilot_executor')
    for (const action of ['start', 'resume']) {
      const args = { action, prompt: 'go' }
      const committed = await callThroughDsh(def, args, EXEC(fakeAgent('root-1'))) as Record<string, unknown>
      expect(Object.prototype.hasOwnProperty.call(committed, 'executor')).toBe(false)
      expect(committed.phase).toBe('planning')
    }
  })

  it('and still CARRIES the record when the engine has one', async () => {
    // Omission must be conditional. Unconditionally dropping `executor` would
    // pass the test above while destroying the only channel that tells the
    // model which child it just authorized.
    const h = await delegatedExecuting()
    const committed = await callThroughDsh(
      toolOf(h.engine, 'autopilot_executor'),
      { action: 'start', prompt: 'go' },
      EXEC(h.root),
    ) as { executor?: { childId?: string; state?: string } }
    expect(committed.executor?.state).toBe('running')
    expect(typeof committed.executor?.childId).toBe('string')
  })
})

describe('audit routing is a DEPLOYMENT fact, not a model argument', () => {
  /**
   * A live model called `autopilot_audit` with `provider: 'openai/gpt-5.6'`
   * (2026-08-25). `provider` names a subagent TRANSPORT registered at mount
   * (`SubagentManager.list()`, e.g. 'spawn'), never a model — and the model has
   * no way to enumerate a deployment's transports. Upstream
   * `SubagentManager.expectProvider` throws `SubagentError NO_PROVIDER` for an
   * unregistered name; a registered-but-WRONG name is worse, because the name is
   * written verbatim into `RouteRecord.provider`, the one field the audit trail
   * uses to say where a verdict came from.
   *
   * The parameter is therefore gone from the model surface. `defineTool`
   * compiles parameters to an OPEN object root (measured 2026-08-25:
   * `validateArgs` returns `[]` for an undeclared property), so a model that
   * still emits `provider` has it IGNORED and falls back to config routing —
   * fail-safe, and the provenance stays true.
   *
   * MUTATION WATCHED: re-declare `provider` on `autopilot_audit` and restore the
   * `...(args.provider === undefined ? {} : { provider: args.provider })`
   * spread. Sandbox copy 2026-08-25 — the route record then reads
   * 'openai/gpt-5.6' and this test fails.
   */
  it('a hallucinated provider reaches neither the transport NOR the provenance record', async () => {
    const subagents = stubSubagents({ verdicts: [{ verdict: 'pass', note: 'plan ok' }] })
    const h = makeHarness({ subagents, config: { auditProvider: 'spawn' } })
    await h.engine.init(h.root, makeTriage({ risk: 'medium', auditMode: 'independent' }))
    await h.engine.submitPlan(h.root, 'plan')

    await callThroughDsh(
      toolOf(h.engine, 'autopilot_audit'),
      { role: 'plan', prompt: 'packet', provider: 'openai/gpt-5.6' },
      EXEC(h.root),
    )
    const record = h.engine.peek(h.root.id)?.audits.at(-1)
    expect(record?.verdict).toBe('pass')
    expect(record?.route.provider).toBe('spawn')
  })

  it('neither audit nor executor DECLARES a provider parameter any more', () => {
    const h = makeHarness()
    for (const name of ['autopilot_audit', 'autopilot_executor']) {
      const properties = (toolOf(h.engine, name).parameters as {
        properties: Record<string, unknown>
      }).properties
      expect(Object.keys(properties)).not.toContain('provider')
    }
    // …and the parameters they DO declare are still there, so this is a removal
    // rather than a schema that stopped compiling.
    const audit = (toolOf(h.engine, 'autopilot_audit').parameters as {
      properties: Record<string, unknown>
    }).properties
    expect(Object.keys(audit).sort()).toEqual(['prompt', 'role'])
  })
})

describe('log fidelity: what a real model sends must not become a false record', () => {
  it('an ON-PLAN checkpoint drops escalation fields and a blank note', async () => {
    // Both halves come from one real-host observation (2026-08-25): the driving
    // model filled every optional key, and log.md rendered an on-plan step as
    // `... note:  -> root-agent (blocks: none)` — an escalation the step never
    // had. The enum values were LEGAL, so the schema could not refuse them;
    // only the stance makes them meaningless. The blank note is the other half,
    // and `x === undefined` never asked the right question about it.
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    const log = toolOf(h.engine, 'autopilot_log')
    await log.execute(
      { text: 'ONPLAN probe', stance: 'on-plan', note: '   ', escalationTarget: 'root-agent', blockingScope: 'none' },
      EXEC(h.root),
    )
    const rendered = readFileSync(join(h.storeDir, 'runs', h.root.id, 'log.md'), 'utf8')
    expect(rendered).toContain('ONPLAN probe')
    expect(rendered).not.toContain('note:')
    expect(rendered).not.toContain('-> root-agent')
    expect(rendered).not.toContain('(blocks:')
  })

  it('an ESCALATE checkpoint still carries all three — the positive control', async () => {
    // Without this, the assertions above would pass on a renderer that simply
    // dropped escalation fields everywhere.
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage())
    const log = toolOf(h.engine, 'autopilot_log')
    await log.execute(
      { text: 'ESCALATE probe', stance: 'escalate', note: 'blocked on an owner decision', escalationTarget: 'owner', blockingScope: 'run' },
      EXEC(h.root),
    )
    const rendered = readFileSync(join(h.storeDir, 'runs', h.root.id, 'log.md'), 'utf8')
    expect(rendered).toContain('note: blocked on an owner decision')
    expect(rendered).toContain('-> owner')
    expect(rendered).toContain('(blocks: run)')
  })
})

describe('autopilot_external_audit carries the SAME owner gate as owner-approve', () => {
  const EXTERNAL = { size: 'standard', risk: 'low', executionMode: 'inline', auditMode: 'external' } as const
  const SEED = { id: 'm1', usageClass: 'internal', boundaryStates: [], artifacts: [], attempted: [] } as const

  it('REFUSES an agent-generated turn, and the plan gate does not move', async () => {
    // If this gate is missing, `external` is not an external review at all: the
    // agent driving the run signs for a review of its own work, and the record
    // says a human did. That is strictly worse than `self-check`, which at
    // least labels itself honestly.
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage(EXTERNAL), [SEED])
    await h.engine.submitPlan(h.root, 'plan')
    openTurn(h.root, { kind: 'agent' })
    const before = h.engine.peek(h.root.id)?.revision

    const tool = toolOf(h.engine, 'autopilot_external_audit')
    try {
      await tool.execute({
        role: 'plan', verdict: 'pass', note: 'looks fine to me',
        reviewer: 'definitely a human', reviewRef: 'review/plan.md',
      }, EXEC(h.root))
      expect.unreachable('an agent-generated turn must not countersign')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AutopilotError)
      expect((error as AutopilotError).code).toBe('AP_OWNER_AUTHORITY_REQUIRED')
    }
    // Not merely "it threw": nothing was recorded and the gate stayed shut.
    expect(h.engine.peek(h.root.id)?.audits).toEqual([])
    expect(h.engine.peek(h.root.id)?.planGate).toBe('pending')
    expect(h.engine.peek(h.root.id)?.revision).toBe(before)
  })

  it('ACCEPTS a user-sourced turn — the positive control for the refusal above', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage(EXTERNAL), [SEED])
    await h.engine.submitPlan(h.root, 'plan')
    openTurn(h.root, { kind: 'user' })

    const tool = toolOf(h.engine, 'autopilot_external_audit')
    await tool.execute({
      role: 'plan', verdict: 'pass', note: 'reviewed the plan offline',
      reviewer: 'a named human', reviewRef: 'review/plan.md',
    }, EXEC(h.root))
    expect(h.engine.peek(h.root.id)?.planGate).toBe('pass')
    expect(h.engine.peek(h.root.id)?.audits[0]?.external?.reviewer).toBe('a named human')
  })

  /**
   * The blank-forward regression class, driven through the surface a provider
   * actually calls.
   *
   * The providers this harness runs fill EVERY optional property a tool schema
   * declares, so an omitted `treeHash` arrives as `""` — not as `undefined`.
   * This repository has paid for that twice (`autopilot_usage`'s
   * `inheritedFrom`, which rejected every artifact-bearing declaration, and
   * `autopilot_log`'s `note`, which rendered an escalation target for steps
   * that had none).
   *
   * WHAT THIS CASE BEARS, precisely: the END-TO-END behaviour from the tool
   * surface. It does NOT bear the `blankToAbsent` call in `tools.ts` — measured
   * 2026-08-27 by replacing that call with `args.treeHash` and watching this
   * case stay GREEN, because `AutopilotEngine.recordExternalAudit` normalizes
   * again before it writes. The engine's `normalizeTreeHash` is the bearer for
   * the rule (removing THAT turns the engine-channel case in
   * `test/external.test.ts` red); the tool-layer call is a redundant seam kept
   * for consistency, and this comment says so rather than letting the case be
   * read as proof of a line it cannot see.
   */
  it('drops a blank treeHash instead of recording a countersign that names nothing', async () => {
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage(EXTERNAL), [SEED])
    await h.engine.submitPlan(h.root, 'plan')
    openTurn(h.root, { kind: 'user' })

    await toolOf(h.engine, 'autopilot_external_audit').execute({
      role: 'plan', verdict: 'pass', note: 'reviewed the plan offline',
      reviewer: 'a named human', reviewRef: 'review/plan.md',
      // Exactly what a force-filling provider sends for a field the human left
      // alone. It must not become a present-but-empty hash, and it must not be
      // refused as malformed either.
      treeHash: '   ',
    }, EXEC(h.root))

    const external = h.engine.peek(h.root.id)?.audits[0]?.external
    expect(external).toEqual({ reviewer: 'a named human', reviewRef: 'review/plan.md' })
    expect('treeHash' in (external ?? {})).toBe(false)
    expect(h.engine.peek(h.root.id)?.planGate).toBe('pass')
  })

  it('carries a real treeHash through the tool, normalized once', async () => {
    // The positive control for the drop above: the parameter is wired, not
    // merely tolerated.
    const h = makeHarness()
    await h.engine.init(h.root, makeTriage(EXTERNAL), [SEED])
    await h.engine.submitPlan(h.root, 'plan')
    openTurn(h.root, { kind: 'user' })

    await toolOf(h.engine, 'autopilot_external_audit').execute({
      role: 'plan', verdict: 'pass', note: 'reviewed at that tree',
      reviewer: 'a named human', reviewRef: 'review/plan.md',
      treeHash: '  0123456789ABCDEF0123456789abcdef01234567  ',
    }, EXEC(h.root))

    expect(h.engine.peek(h.root.id)?.audits[0]?.external?.treeHash)
      .toBe('0123456789abcdef0123456789abcdef01234567')
  })
})

/**
 * The trimmed tool results name their run.
 *
 * WHY THIS BLOCK EXISTS. Until 2026-08-27 every autopilot tool answered with a
 * trimmed snapshot that omitted `runId`, so a session log recorded what the run
 * DID without ever recording WHICH run it was. M7 measured the downstream cost
 * on a live host: the card folded `runId: undefined`, rendered "run id not
 * reported", and its live poll — which is keyed by run id — never started at
 * all, so an out-of-band advance went unseen for the whole session.
 *
 * The trim philosophy is unchanged: these results are still a narrow projection
 * and NOT the snapshot. One identifying field is added, because a record that
 * cannot say what it is about is not a smaller record, it is an ambiguous one.
 *
 * These cases are also the bearer for that field. Before they existed the
 * addition was unobservable — the only exact-shape assertion in this file
 * builds its body by hand to exercise the lossless-JSON validator and never
 * sees a real tool result. Removing `runId: snapshot.runId` from any site below
 * turns the corresponding case red.
 */
describe('every trimmed tool result is self-describing', () => {
  it('autopilot_init names the run it just created', async () => {
    const h = makeHarness()
    const out = await toolOf(h.engine, 'autopilot_init').execute({
      objective: 'name the run', scope: ['src/'], nonGoals: ['docs/'],
      acceptanceCriteria: ['tests pass'], risk: 'low', size: 'lightweight',
      executionMode: 'inline', auditMode: 'self-check',
    }, EXEC(h.root)) as unknown as Record<string, unknown>
    // The run id IS the root session id — the same identity `engine.ts` binds
    // at init, which is what makes the card's session-id poll key sound.
    expect(out.runId).toBe(h.root.id)
    expect(out.revision).toBe(1)
    // Still a TRIM, not the snapshot: no plan text, no audits, no closeout.
    // `usage` is absent because a lightweight run has no usage dimension at all
    // (the legacy-exempt shape, §6) — not because the trim dropped it.
    expect(Object.keys(out).sort()).toEqual(['enforcement', 'phase', 'revision', 'runId'])
  })

  it('the tools a run actually drives all name it too', async () => {
    const h = makeHarness()
    await toolOf(h.engine, 'autopilot_init').execute({
      objective: 'name the run', scope: ['src/'], nonGoals: ['docs/'],
      acceptanceCriteria: ['tests pass'], risk: 'low', size: 'lightweight',
      executionMode: 'inline', auditMode: 'self-check',
    }, EXEC(h.root))

    const plan = await toolOf(h.engine, 'autopilot_submit_plan')
      .execute({ text: 'one milestone' }, EXEC(h.root)) as unknown as Record<string, unknown>
    expect(plan.runId).toBe(h.root.id)

    const log = await toolOf(h.engine, 'autopilot_log')
      .execute({ text: 'a checkpoint', stance: 'on-plan' }, EXEC(h.root)) as unknown as Record<string, unknown>
    expect(log.runId).toBe(h.root.id)

    const status = await toolOf(h.engine, 'autopilot_status')
      .execute({}, EXEC(h.root)) as unknown as Record<string, unknown>
    expect(status.runId).toBe(h.root.id)
  })

  it('a run id survives the lossless-JSON boundary the results cross', () => {
    // `runId` is a plain string, so this is not in doubt — but the boundary is
    // where an added field would fail if it ever stopped being one, and this
    // file already owns that rule.
    const def = toolOf(makeHarness().engine, 'autopilot_init')
    expect(commitThroughDsh(def, {}, { runId: 'session-1', revision: 1, phase: 'planning' }))
      .toEqual({ runId: 'session-1', revision: 1, phase: 'planning' })
  })
})
