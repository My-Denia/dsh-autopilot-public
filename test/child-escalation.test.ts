/**
 * M13 / M4a — the executor child's ONLY way to ask for a stronger model.
 *
 * THE GAP THIS FILE PINS, measured in the source before it was written: the
 * escalation request channel added in M12 is produced through `autopilot_log`,
 * which `installRootTools` registers into the ROOT agent's scope, and whose
 * engine entry point (`log`) resolves the caller through `resolveRoot` — which
 * throws `AP_NOT_ROOT` for ANY caller whose session has a `parentSession`. The
 * executor child's own tool surface carries exactly one tool
 * (`autopilot_submit_packet`). So a delegated executor that got stuck had no way
 * to ask for anything: the product promise ("when the working model cannot make
 * progress, it can request more ceiling") had no path for the one agent that
 * does the work.
 *
 * WHAT THE FIX IS, and what these cases hold:
 *  - a child-facing `autopilot_request_escalation` tool, installed into the
 *    child's own scope like the packet tool (so it does not depend on the
 *    owner's allow-list);
 *  - an engine entry point that accepts ONLY the live, authorized, RUNNING
 *    executor child, and records ONLY an `escalate`/`stronger-model` checkpoint
 *    — a child may not write arbitrary log entries, and may not request the
 *    governance exits (`owner`, `external-review`) that belong to the root;
 *  - the SAME register as the root path (`pendingEscalations`), consumed at the
 *    same point (`selectForRole`), so there is one channel with two entry points
 *    rather than two escalation semantics;
 *  - NO authorization widening: a request still only widens the candidate pool,
 *    which is still `policy ∩ live ∩ tier membership`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { RouteCatalog } from '../src/routing/catalog.js'
import type { LlmCallConfig, LlmRuntimeSubset } from '../src/routing/catalog.js'
import type { RoutingPorts } from '../src/engine.js'
import type { RoutingDecisionDetail, RunEvent } from '../src/domain/types.js'
import type { SessionPolicyState } from '../src/routing/authorize.js'
import { fakeAgent, makeHarness, makeTriage, stubSubagents } from './helpers.js'
import type { Harness } from './helpers.js'

// ── the routing fixture: a live catalog over three routes, all authorized ─────

interface StubModel {
  readonly provider: string
  readonly id: string
  readonly contextWindow?: number
  readonly efforts?: readonly string[]
  readonly defaultEffort?: string
}

/** The narrowest `llm` a {@link RouteCatalog} can be built over. */
class StubLlm implements LlmRuntimeSubset {
  constructor(private readonly models: readonly StubModel[]) {}

  listProviders(): readonly { id: string; name: string }[] {
    return [...new Set(this.models.map(model => model.provider))].map(id => ({ id, name: id }))
  }

  async listModels(provider: string): Promise<readonly { provider: string; id: string; name: string }[]> {
    return this.models.filter(model => model.provider === provider).map(model => ({ provider, id: model.id, name: model.id }))
  }

  async resolveModelInfo(provider: string, model: string): Promise<never> {
    const hit = this.models.find(candidate => candidate.provider === provider && candidate.id === model)
    if (hit === undefined) throw new Error(`resolveModelInfo: unknown route ${provider}/${model}`)
    const hasReasoning = (hit.efforts?.length ?? 0) > 0 || hit.defaultEffort !== undefined
    return {
      provider,
      id: model,
      name: model,
      ...(hit.contextWindow === undefined ? {} : { context: { contextWindow: hit.contextWindow } }),
      ...(hasReasoning
        ? {
            reasoning: {
              efforts: (hit.efforts ?? []).map(effort => ({ id: effort, name: effort })),
              ...(hit.defaultEffort === undefined ? {} : { defaultEffort: hit.defaultEffort }),
            },
          }
        : {}),
    } as never
  }

  async resolveCallConfig(config: LlmCallConfig): Promise<LlmCallConfig> {
    return { ...config }
  }
}

const MODELS: readonly StubModel[] = [
  { provider: 'alpha', id: 'm-a', contextWindow: 131072, efforts: ['high'], defaultEffort: 'high' },
  { provider: 'alpha', id: 'm-b', contextWindow: 131072 },
  { provider: 'beta', id: 'm-c', contextWindow: 200000, efforts: ['high'], defaultEffort: 'high' },
]

/** Every route authorized, so a widening is a RANKING question, not a grant one. */
const PRESENT_ABC: SessionPolicyState = {
  kind: 'present',
  routes: [
    { provider: 'alpha', model: 'm-a' },
    { provider: 'alpha', model: 'm-b' },
    { provider: 'beta', model: 'm-c' },
  ],
}

/**
 * Discriminating tiers: `standard` — the audit class's own mapping — holds m-a
 * alone, so the first execution audit pins m-a deterministically, while m-b
 * (economy) and m-c (reserve) stay outside that class's mapping until a
 * request's floor adds every tier.
 *
 * ROTATION IS LEFT OFF (the default) ON PURPOSE: with rotation on, every auditor
 * dispatch re-selects anyway, so a re-selection could not be attributed to the
 * request.
 */
const LADDER = { tiers: { economy: ['alpha/m-b'], standard: ['alpha/m-a'], reserve: ['beta/m-c'] } }

function ports(): RoutingPorts {
  const policy = PRESENT_ABC
  return { catalog: new RouteCatalog(new StubLlm(MODELS)), policyReader: () => policy }
}

function eventsOf(h: Harness): RunEvent[] {
  return readFileSync(join(h.storeDir, 'runs', h.root.id, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as RunEvent)
}

function auditorDetails(h: Harness): RoutingDecisionDetail[] {
  return eventsOf(h)
    .filter(event => (event.detail as { routing?: unknown } | undefined)?.routing !== undefined)
    .map(event => (event.detail as { routing: RoutingDecisionDetail }).routing)
    .filter(detail => detail.role === 'execution-auditor')
}

/** The `escalate`/`stronger-model` checkpoints the run's OWN stream records. */
function escalationEntries(h: Harness): Array<{ seq: number; note?: string }> {
  return eventsOf(h)
    .filter(event => event.op === 'log')
    .map(event => event.detail as { seq: number; stance?: string; escalationTarget?: string; note?: string })
    .filter(entry => entry.stance === 'escalate' && entry.escalationTarget === 'stronger-model')
}

/**
 * Drive a delegated run to `execution-reviewing` with the execution-auditor
 * ALREADY PINNED by its first audit (which is what makes a later re-selection
 * able to record `repinFrom`), the executor child live and running, and the
 * execution gate at `needs-fix` so a resume is legal.
 *
 * @returns the harness, the registered executor child, and the pin the first
 *   execution audit settled on.
 */
async function pinnedExecutorRun(): Promise<{ h: Harness; childId: string; preRequestPin: unknown }> {
  const subagents = stubSubagents({
    verdicts: [
      { verdict: 'pass', note: 'plan ok' },
      { verdict: 'needs-fix', note: 'keep the executor running for the probe' },
      { verdict: 'needs-fix', note: 'the re-audit after the request' },
    ],
  })
  const h = makeHarness({
    routing: ports(),
    config: { routing: { mode: 'auto', ladder: LADDER } },
    subagents,
  })
  await h.engine.init(h.root, makeTriage({
    size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated',
  }))
  await h.engine.submitPlan(h.root, 'plan')
  await h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })

  const signal = new AbortController().signal
  const started = await h.engine.startExecutor(h.root, { prompt: 'do the work', signal })
  const childId = started.executor?.childId as string
  const child = fakeAgent(childId, h.root.id)
  h.agents.add(child)
  await h.engine.submitExecutionPacket(child, { packet: 'first pass', residualRisks: [], executionRevision: 1 })
  await h.engine.audit(h.root, { role: 'execution', prompt: 'first execution audit' })

  const pinned = h.engine.peek(h.root.id)?.routingPins?.['execution-auditor']
  expect(pinned).toBeDefined()
  // The first selection has NO `repinFrom` — which is exactly why the case below
  // pins this role BEFORE escalating: a first dispatch could never satisfy the
  // "repinFrom equals the pre-request pin" claim.
  expect(auditorDetails(h).at(-1)?.repinFrom).toBeUndefined()
  return { h, childId, preRequestPin: pinned }
}

describe('M4a — an executor child can ASK for a stronger model, and only that', () => {
  it('the authorized running executor child\'s request is consumed by the next auto dispatch of the pinned auditor role', async () => {
    const { h, childId, preRequestPin } = await pinnedExecutorRun()
    const child = h.agents.get(childId)!
    const signal = new AbortController().signal
    expect(h.engine.peek(h.root.id)?.executionGate).toBe('needs-fix')

    // The resume the audit asked for: the child returns for revision 2 …
    await h.engine.resumeExecutor(h.root, { findings: 'fix it', nextPrompt: 'retry', signal })
    // … and, stuck, asks for a higher ceiling. THIS is the call with no code
    // path before M4a: `log` refuses a child as AP_NOT_ROOT.
    await h.engine.requestEscalation(child, {
      text: 'stalled: the third attempt at the same edit failed',
      note: 'max effort still failing after three attempts',
    })
    const entries = escalationEntries(h)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.note).toBe('max effort still failing after three attempts')

    await h.engine.submitExecutionPacket(child, { packet: 'second pass', residualRisks: [], executionRevision: 2 })
    await h.engine.audit(h.root, { role: 'execution', prompt: 're-audit after the request' })

    const last = auditorDetails(h).at(-1)
    // The pin was HEALTHY: this is a requested widening, not a death repin.
    expect(last?.repinFrom).toEqual(preRequestPin)
    expect(last?.why?.some(entry => entry.includes(`escalation request: seq ${String(entries[0]?.seq)}`))).toBe(true)
    expect(last?.why?.some(entry => entry.includes('the working model asked for a higher ceiling'))).toBe(true)
    // The widened pool really became the candidate set: members the audit class
    // would have excluded are considered now.
    const considered = (last?.candidates ?? []).map(candidate => `${candidate.provider}/${candidate.model}`)
    expect(considered).toContain('alpha/m-b')
    expect(considered).toContain('beta/m-c')
  })

  it('is ONE channel: the root path still works, unchanged (M12 regression)', async () => {
    const { h } = await pinnedExecutorRun()
    const signal = new AbortController().signal
    await h.engine.log(h.root, {
      text: 'stalled', stance: 'escalate', escalationTarget: 'stronger-model', note: 'root asks',
    })
    await h.engine.resumeExecutor(h.root, { findings: 'f', nextPrompt: 'p', signal })
    const child = h.agents.get(h.engine.peek(h.root.id)?.executor?.childId as string)!
    await h.engine.submitExecutionPacket(child, { packet: 'again', residualRisks: [], executionRevision: 2 })
    await h.engine.audit(h.root, { role: 'execution', prompt: 'root-requested widening' })
    const last = auditorDetails(h).at(-1)
    expect(last?.why?.some(entry => entry.includes(`escalation request: seq ${String(escalationEntries(h)[0]?.seq)}`))).toBe(true)
    expect(last?.repinFrom).toBeDefined()
  })

  it('refuses a child that is NOT this run\'s authorized executor', async () => {
    const { h } = await pinnedExecutorRun()
    const stranger = fakeAgent('stranger-child', h.root.id)
    h.agents.add(stranger)
    await expect(h.engine.requestEscalation(stranger, { text: 'let me up', note: 'n' }))
      .rejects.toThrowError(/not the authorized executor/)
  })

  it('refuses a COMPLETED executor: an agent that is no longer running cannot ask for anything', async () => {
    const subagents = stubSubagents({
      verdicts: [
        { verdict: 'pass', note: 'plan ok' },
        { verdict: 'needs-fix', note: 'fix it' },
        { verdict: 'pass', note: 'done' },
      ],
    })
    const h = makeHarness({ routing: ports(), config: { routing: { mode: 'auto', ladder: LADDER } }, subagents })
    await h.engine.init(h.root, makeTriage({
      size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated',
    }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })
    const signal = new AbortController().signal
    const started = await h.engine.startExecutor(h.root, { prompt: 'work', signal })
    const child = fakeAgent(started.executor?.childId as string, h.root.id)
    h.agents.add(child)
    await h.engine.submitExecutionPacket(child, { packet: 'one', residualRisks: [], executionRevision: 1 })
    await h.engine.audit(h.root, { role: 'execution', prompt: 'first' })
    await h.engine.resumeExecutor(h.root, { findings: 'f', nextPrompt: 'p', signal })
    await h.engine.submitExecutionPacket(child, { packet: 'two', residualRisks: [], executionRevision: 2 })
    await h.engine.audit(h.root, { role: 'execution', prompt: 'second' })
    expect(h.engine.peek(h.root.id)?.executor?.state).toBe('completed')
    await expect(h.engine.requestEscalation(child, { text: 'still here?', note: 'n' }))
      .rejects.toThrowError(/not the authorized executor|not running/)
  })

  it('keeps `log` ROOT-ONLY: a child cannot write arbitrary checkpoints into the run', async () => {
    const { h, childId } = await pinnedExecutorRun()
    const child = h.agents.get(childId)!
    await expect(h.engine.log(child, { text: 'I am the executor', stance: 'on-plan' }))
      .rejects.toThrowError(/parent session/)
    await expect(h.engine.log(child, {
      text: 'let me escalate', stance: 'escalate', escalationTarget: 'stronger-model', note: 'n',
    })).rejects.toThrowError(/parent session/)
  })

  it('refuses an empty text or note, like every escalate checkpoint', async () => {
    const { h, childId } = await pinnedExecutorRun()
    const child = h.agents.get(childId)!
    await expect(h.engine.requestEscalation(child, { text: '   ', note: 'n' }))
      .rejects.toThrowError(/empty/)
    await expect(h.engine.requestEscalation(child, { text: 'stuck', note: '   ' }))
      .rejects.toThrowError(/note/)
  })
})
