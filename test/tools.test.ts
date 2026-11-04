/**
 * The model-facing tool surface in 0.3.0: one read-only tool, plus the
 * direct-human-turn helpers that stay exported.
 *
 * `hasDirectHumanTurn` is the single human-authored link ledger owner actions
 * rest on (dsh's goal tool uses the same pattern), so its window rules keep a
 * bearer: a closed turn, an agent-generated turn and a missing source must all
 * read false. The tool-output contract against the real validator lives in
 * `test/boundary.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import { AutopilotError } from '../src/domain/types.js'
import { createAutopilotService } from '../src/service.js'
import { hasDirectHumanTurn, installRootTools, requireDirectHumanTurn, statusBody } from '../src/tools.js'
import type { ToolRegistryRef } from '../src/tools.js'
import type { AgentRef } from '../src/engine.js'
import { FileLedgerStore, legacySourcesOf } from '../src/store/ledger.js'
import { fakeAgent, makeHarness, writeLegacyFixture } from './helpers.js'

interface ToolDef {
  name: string
  parameters: unknown
  execute(args: unknown, exec: unknown): Promise<unknown>
}

/** Open a turn on this agent's session, carrying a message from `source`. */
function openTurn(agent: AgentRef, source: { kind: string }): void {
  // The engine's `SessionRef.append` names only `sandbox/mode`; the fake accepts any type.
  const session = agent.session as AgentRef['session'] & { append(type: string, data: unknown): void }
  session.append('turn/start', {})
  session.append('user/message', { source })
}

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

  it('is a PER-TURN check: false when the human message belongs to an EARLIER, closed turn', () => {
    // The backward loop finds the turn boundary; the forward loop reads the window. A bug in
    // the forward loop (starting at 0) would let any human message in history authorize every
    // later agent turn.
    const agent = fakeAgent('root-1')
    openTurn(agent, { kind: 'user' })
    agent.session.append('turn/end', {})
    agent.session.append('turn/start', {})
    expect(hasDirectHumanTurn(agent)).toBe(false)
    agent.session.append('user/message', { source: { kind: 'user' } })
    expect(hasDirectHumanTurn(agent)).toBe(true)
  })
})

describe('requireDirectHumanTurn', () => {
  it('passes on a human turn and refuses an agent turn with the owner-authority code', () => {
    const human = fakeAgent('root-1')
    openTurn(human, { kind: 'user' })
    expect(() => requireDirectHumanTurn(human, 'clearing the archive')).not.toThrow()

    const agent = fakeAgent('root-2')
    openTurn(agent, { kind: 'agent' })
    try {
      requireDirectHumanTurn(agent, 'clearing the archive')
      expect.unreachable('expected a refusal')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AutopilotError)
      expect((error as AutopilotError).code).toBe('AP_OWNER_AUTHORITY_REQUIRED')
      expect((error as Error).message).toMatch(/direct human turn/)
    }
  })
})

describe('installRootTools registers autopilot_status, and nothing else', () => {
  function install() {
    const defs = new Map<string, ToolDef>()
    let disposals = 0
    const registry: ToolRegistryRef = {
      register(definition: unknown) {
        const def = definition as ToolDef
        defs.set(def.name, def)
        return () => { disposals += 1 }
      },
    }
    const h = makeHarness()
    const service = createAutopilotService({ ledgers: h.ledgers, sources: h.sources, notes: () => ['a note'] })
    const dispose = installRootTools(registry, service)
    return { defs, h, dispose, get disposals() { return disposals } }
  }

  it('the surface is exactly [autopilot_status]; every retired tool name is absent', () => {
    const { defs } = install()
    expect([...defs.keys()]).toEqual(['autopilot_status'])
    for (const retired of [
      'autopilot_init', 'autopilot_amend_plan', 'autopilot_submit_plan', 'autopilot_audit', 'autopilot_self_check',
      'autopilot_external_audit', 'autopilot_usage', 'autopilot_log', 'autopilot_executor', 'autopilot_submit_evidence',
      'autopilot_signal', 'autopilot_submit_closeout', 'autopilot_request_escalation', 'autopilot_submit_packet',
    ]) expect(defs.has(retired)).toBe(false)
  })

  it('dispose releases the registration', () => {
    const t = install()
    t.dispose()
    expect(t.disposals).toBe(1)
  })

  it('the tool needs the calling agent: no agent is a refusal with a stable code, not a crash', async () => {
    const { defs } = install()
    await expect(defs.get('autopilot_status')!.execute({}, { agent: undefined })).rejects.toMatchObject({ code: 'AP_NO_AGENT' })
  })

  it('answers for the calling session from the ledger, the legacy runs and the notes', async () => {
    const t = install()
    await t.h.engine.mutate('root-1', ledger => ({ ...ledger, links: [{ kind: 'pr', ref: '#12', at: '2026-11-04T00:00:00.000Z' }] }))
    const body = await t.defs.get('autopilot_status')!.execute({}, { agent: t.h.root }) as {
      sessionId: string; ledger: { links: Array<{ ref: string }> } | null; notes: string[]
    }
    expect(body.sessionId).toBe('root-1')
    expect(body.ledger?.links[0]?.ref).toBe('#12')
    expect(body.notes).toEqual(['a note'])
  })
})

describe('statusBody', () => {
  it('with no ledger it still lists the legacy runs of THAT session only, and says ledger is null', async () => {
    const h = makeHarness()
    const mine = writeLegacyFixture(h.storeDir, 'independent-clamped-completed.jsonl')
    writeLegacyFixture(h.storeDir, 'external-audit.jsonl')
    const service = createAutopilotService({ ledgers: FileLedgerStore.open(h.storeDir), sources: legacySourcesOf(h.storeDir), notes: () => [] })
    const body = await statusBody(service, mine) as { ledger: unknown; legacyRuns: Array<{ runId: string }>; storeKind: string }
    expect(body.ledger).toBeNull()
    expect(body.storeKind).toBe('file')
    expect(body.legacyRuns.map(run => run.runId)).toEqual([mine])
  })

  it('contains no own undefined property anywhere (the lossless-JSON rule)', async () => {
    const h = makeHarness()
    await h.engine.mutate('root-1', ledger => ({ ...ledger }))
    const service = createAutopilotService({ ledgers: h.ledgers, sources: h.sources })
    const body = await statusBody(service, 'root-1')
    expect(JSON.stringify(body)).toBe(JSON.stringify(JSON.parse(JSON.stringify(body))))
    const undefinedPaths: string[] = []
    const walk = (value: unknown, path: string): void => {
      if (value === undefined) { undefinedPaths.push(path); return }
      if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`)
    }
    walk(body, 'body')
    expect(undefinedPaths).toEqual([])
  })
})
