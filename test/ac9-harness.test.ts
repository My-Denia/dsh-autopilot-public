/**
 * AC9 MANDATORY HARNESS TEST (plan v3 M7 / AC9 "zero-config").
 *
 * The claim under test: with the SHIPPED DEFAULT config (`resolveConfig({})`:
 * `routing.mode: 'auto'`, no locks) on a SINGLE-MODEL deployment (one provider,
 * one model in the live catalog) and NO session model-selection policy (the
 * native default), a full standard run reaches `completed` on the SAME
 * state-machine path 0.2.0 used — every dispatch INHERITING the deployment
 * default, nothing explicitly selected, every record honest about that.
 *
 * MOCK BOUNDARY, DECLARED: no LLM calls are made anywhere in this file. The
 * catalog port answers `LlmRuntimeSubset` reads from a one-model table; the
 * subagent stubs answer dispatches with scripted verdicts and echo the creation
 * options + `request/header` a healthy host would produce. What is REAL — and
 * is the bearer of AC9 — is the engine state machine, both gates, the routing
 * decisions and their durable `detail.routing` / RouteRecord / pin state, and
 * the fold that replays the committed stream. A real-host smoke run is NOT
 * claimed here (plan M7: optional; UNPROVEN if not run).
 *
 * Structure (per the M7 packet):
 *  1. the shipped-default premise, asserted on `resolveConfig({})` itself;
 *  2. the full standard-run drive to `completed` with inheritance-only
 *     semantics, RouteRecord legs asserted per the stub's echo, no pin
 *     anywhere, and a cold reload through the real fold;
 *  3. the 0.2.0-behavior parity claim, borne by driving the IDENTICAL
 *     deployment + op sequence under `routing.mode: 'off'` (the mode that
 *     reproduces the 0.2.0 flow verbatim on a no-policy deployment) and
 *     asserting the DECISIONS are identical — the only delta is additive
 *     provenance;
 *  4. the cheap second case: a session policy naming the single catalog route
 *     still selects nothing explicit (a one-route authorized set inherits),
 *     recorded honestly with the authority that produced that set.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AutopilotEngine } from '../src/engine.js'
import type { RoutingPorts } from '../src/engine.js'
import { resolveConfig } from '../src/index.js'
import { RouteCatalog } from '../src/routing/catalog.js'
import type { LlmCallConfig, LlmRuntimeSubset } from '../src/routing/catalog.js'
import type { SessionPolicyState } from '../src/routing/authorize.js'
import { RunStore } from '../src/store/file.js'
import type { RoutingDecisionDetail, RunEvent, Snapshot } from '../src/domain/types.js'
import { fakeAgent, makeHarness, makeTriage, stubSubagents, FakeAgents } from './helpers.js'
import type { Harness } from './helpers.js'

// ── The single-model deployment (structural stub, mirrors routing-integration) ──

const SOLE_PROVIDER = 'sole'
const SOLE_MODEL = 'sole-model'

/** One provider, one model — the zero-config deployment AC9 names. */
class SingleModelLlm implements LlmRuntimeSubset {
  public readonly preflights: LlmCallConfig[] = []

  listProviders() {
    return [{ id: SOLE_PROVIDER, name: SOLE_PROVIDER }]
  }

  async listModels(provider: string) {
    return provider === SOLE_PROVIDER ? [{ provider, id: SOLE_MODEL, name: SOLE_MODEL }] : []
  }

  async resolveModelInfo(provider: string, model: string) {
    if (provider !== SOLE_PROVIDER || model !== SOLE_MODEL) {
      throw new Error(`resolveModelInfo: unknown route ${provider}/${model}`)
    }
    return { provider, id: model, name: model, context: { contextWindow: 131072 } }
  }

  async resolveCallConfig(config: LlmCallConfig) {
    this.preflights.push(config)
    return { ...config }
  }
}

/** Stub ports at the structural boundary: a live single-model catalog + a policy reader. */
function singleModelPorts(policy: SessionPolicyState): RoutingPorts & { readonly llm: SingleModelLlm } {
  const llm = new SingleModelLlm()
  return { llm, catalog: new RouteCatalog(llm), policyReader: () => policy }
}

// ── The full standard-run path, mirroring the existing full-lifecycle engine test ──

/**
 * start → submit plan → plan audit pass → executor start → packet → execution
 * audit pass → closeout → completed. The exact op sequence of the delegated
 * full-lifecycle test in `test/engine.test.ts` ("runs start -> packet ->
 * execution audit pass -> closing -> closeout"), including the usage-evidence
 * shape that test declares (none — standard runs without usage entries are
 * legacy-exempt) and registering the executor child only after `startExecutor`
 * resolves, exactly as that test does.
 */
const STANDARD_DELEGATED = { size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' } as const

const CLOSEOUT = {
  summary: 'done',
  changedFiles: ['a.ts'],
  commands: ['pnpm vitest run - pass'],
  evidence: [{ criterion: 'tests pass', bearer: 'test-run.txt', status: 'proven' as const, kind: 'path' as const }],
  residualRisks: [],
  exclusions: [],
  workspaceCleanup: 'nothing created',
  drift: 'none found',
}

async function driveFullStandardRun(h: Harness): Promise<Snapshot> {
  await h.engine.init(h.root, makeTriage(STANDARD_DELEGATED))
  await h.engine.submitPlan(h.root, 'plan')
  await h.engine.audit(h.root, { role: 'plan', prompt: 'bounded packet' })
  const signal = new AbortController().signal
  const started = await h.engine.startExecutor(h.root, { prompt: 'implement M1', signal })
  const childId = started.executor?.childId as string
  const child = fakeAgent(childId, h.root.id)
  h.agents.add(child)
  await h.engine.submitExecutionPacket(child, { packet: 'did the work; tests green', residualRisks: [], executionRevision: 1 })
  await h.engine.audit(h.root, { role: 'execution', prompt: 'audit packet' })
  return await h.engine.submitCloseout(h.root, CLOSEOUT)
}

function verdicts(): ReturnType<typeof stubSubagents> {
  return stubSubagents({ verdicts: [
    { verdict: 'pass', note: 'plan ok' },
    { verdict: 'pass', note: 'execution ok' },
  ] })
}

// ── Durable-stream readers (the canonical record an auditor reads) ──

function eventsOf(h: Harness): RunEvent[] {
  return readFileSync(join(h.storeDir, 'runs', h.root.id, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as RunEvent)
}

/** Every routing decision stamped on a dispatch commit, in stream order. */
function dispatchRouting(h: Harness): RoutingDecisionDetail[] {
  return eventsOf(h)
    .filter(event => event.op === 'audit' || event.op === 'start-executor')
    .map(event => (event.detail as { routing?: RoutingDecisionDetail } | undefined)?.routing)
    .filter((routing): routing is RoutingDecisionDetail => routing !== undefined)
}

describe('AC9 harness: shipped default on a single-model, no-policy deployment', () => {
  it('the zero-config premise: resolveConfig({}) is routing auto, balanced, no locks anywhere', () => {
    const config = resolveConfig({})
    expect(config.routing.mode).toBe('auto')
    expect(config.routing.preference).toBe('balanced')
    // Every dispatched role defaults to auto WITH NO ROUTE (auto carries only a
    // context floor — a lock would carry provider/model); the planner (the root
    // agent) inherits by default.
    expect(config.routing.roles.executor.mode).toBe('auto')
    expect(config.routing.roles['plan-auditor'].mode).toBe('auto')
    expect(config.routing.roles['execution-auditor'].mode).toBe('auto')
    expect(config.routing.roles['rules-auditor'].mode).toBe('auto')
    expect(config.routing.roles.planner.mode).toBe('inherit')
    // No legacy explicit routes either — the pool is empty, so nothing can
    // surface as a plugin-config grant on this deployment.
    expect(config.crossFamily.pool).toEqual([])
    expect(config.auditors).toEqual({})
    expect(config.executor.agentOptions).toBeUndefined()
  })

  it('drives the full standard-run path to completed on inheritance alone — no explicit selection, honest records, no pins, clean replay', async () => {
    const policy: SessionPolicyState = { kind: 'absent' }
    const ports = singleModelPorts(policy)
    const h = makeHarness({ config: {}, routing: ports, subagents: verdicts() })

    const done = await driveFullStandardRun(h)

    // ── The run reached completed with both gates passed ──
    expect(done.phase).toBe('completed')
    expect(done.planGate).toBe('pass')
    expect(done.executionGate).toBe('pass')
    expect(done.executor?.state).toBe('completed')

    // ── NO dispatch made an explicit route selection (rule 1 inheritance) ──
    // The transport-level bearer: no agentOptions reached ANY subagent start —
    // both auditor dispatches and the continuable executor start inherited.
    expect(h.subagents.auditOptions).toEqual([undefined, undefined])
    expect(h.subagents.continuableOptions).toEqual([undefined])
    // The selection machinery never even preflew a candidate: inheritance
    // decides before preflight, and a preflight call would mean a selection
    // was attempted.
    expect(ports.llm.preflights).toEqual([])

    // ── The durable decisions record the inheritance path honestly ──
    // Four dispatch commits carry a routing decision (plan-audit verdict,
    // executor starting, executor running, execution-audit verdict). Every one
    // is an inherit: no pin, and — under an ABSENT policy, the native default —
    // no authorization named at all (there is no authority to cite).
    const decisions = dispatchRouting(h)
    expect(decisions).toHaveLength(4)
    for (const decision of decisions) {
      expect(decision.pin, `decision for ${decision.role} pinned a route`).toBeUndefined()
      expect(decision.authorizationSource, `decision for ${decision.role} named an authority`).toBeUndefined()
      expect(
        decision.why.some(entry => entry.includes('no session model-selection policy recorded')),
        `decision for ${decision.role} does not name the absent policy`,
      ).toBe(true)
      expect(
        decision.why.some(entry => entry.includes('inheritance only')),
        `decision for ${decision.role} does not state inheritance-only semantics`,
      ).toBe(true)
    }

    // ── RouteRecords exist and carry the inheritance truth ──
    // Both auditor records show the stub's echo: creation options and an
    // agreeing `request/header` observed leg — but NO `selected` leg and no
    // `verified` claim: without a selection there is no three-leg agreement to
    // verify, and the honest status is `unverified` saying exactly that.
    for (const audit of done.audits) {
      expect(audit.verdict).toBe('pass')
      expect(audit.route.selected).toBeUndefined()
      expect(audit.route.routeProvider).toBe('stub-llm') // creation leg, per the stub's echo
      expect(audit.route.routeModel).toBe('stub-model')
      expect(audit.route.observed).toEqual({ provider: 'stub-llm', model: 'stub-model' })
      expect(audit.route.routeStatus).toBe('unverified')
      expect(audit.route.routeDiagnostic).toContain('inheritance')
      expect(audit.route.why?.some(entry => entry.includes('inheritance only'))).toBe(true)
    }
    // The executor's own record is asserted as the fold state actually is, not
    // a shape we wish for: this mirrored sequence registers the child only
    // after `startExecutor` resolves, so at the running commit neither the
    // creation nor the observed leg was readable — honestly `unverified` with
    // both read failures named, never a fabricated leg.
    const executorRoute = done.executor?.route
    expect(executorRoute?.selected).toBeUndefined()
    expect(executorRoute?.routeStatus).toBe('unverified')
    expect(executorRoute?.routeProvider).toBe('unverified')
    expect(executorRoute?.routeModel).toBe('unverified')
    expect(executorRoute?.routeDiagnostic).toContain('not available from durable Agent options')
    expect(executorRoute?.routeDiagnostic).toContain('observed route not readable')
    // The pre-dispatch starting record (permanent in the stream, transient in
    // the projection) says the executor route INHERITS the deployment default.
    const starting = eventsOf(h).find(
      event => event.op === 'start-executor' && (event.detail as { stage?: string } | undefined)?.stage === 'starting',
    )
    expect(starting?.snapshot.executor?.route.routeDiagnostic).toContain('executor route inherits the deployment default')
    // No route anywhere on this run claims `verified` — there was never a
    // selection to verify (the three-leg agreement rule's honest floor).
    const statuses = [
      ...done.audits.map(audit => audit.route.routeStatus),
      executorRoute?.routeStatus,
      starting?.snapshot.executor?.route.routeStatus,
    ]
    expect(statuses).not.toContain('verified')

    // ── Pins are absent — inheritance writes no pin, at any revision ──
    expect(done.routingPins).toBeUndefined()
    // Asserted per-event against the committed stream, which is what a reload
    // replays: no snapshot in the whole run ever carried a pin.
    for (const event of eventsOf(h)) {
      expect(event.snapshot.routingPins, `${event.op} at revision ${event.revision} carried pins`).toBeUndefined()
    }

    // ── Reload: the full event stream replays cleanly through the real fold ──
    // A cold engine over the same store re-folds events.jsonl from scratch
    // (`RunStore.load` → `foldRun`); a malformed decision, an illegal op or a
    // pin drift would throw here. The replayed run must BE the completed run.
    const agents = new FakeAgents()
    agents.add(fakeAgent(h.root.id))
    const cold = new AutopilotEngine(
      agents,
      stubSubagents(),
      new RunStore(h.storeDir),
      resolveConfig({}),
      () => true,
      {},
      { catalog: ports.catalog, policyReader: () => policy },
    )
    const replayed = cold.peek(h.root.id)
    expect(replayed?.phase).toBe('completed')
    expect(replayed?.planGate).toBe('pass')
    expect(replayed?.executionGate).toBe('pass')
    expect(replayed?.routingPins).toBeUndefined()
    expect(replayed?.audits.map(audit => audit.route.routeStatus)).toEqual(['unverified', 'unverified'])
    expect(replayed).toEqual(done)
  })

  it('0.2.0-behavior parity: routing.mode off (the 0.2.0-verbatim flow) on the same deployment makes the IDENTICAL decisions', async () => {
    // The parity claim needs a 0.2.0 to compare against. `routing.mode: 'off'`
    // on a no-policy deployment is the mode the design defines as reproducing
    // 0.2.0 exactly ("the 0.2.0 flow VERBATIM"); same single-model catalog,
    // same absent policy, same op sequence, same scripted verdicts.
    const policy: SessionPolicyState = { kind: 'absent' }
    const shipped = makeHarness({ config: {}, routing: singleModelPorts(policy), subagents: verdicts() })
    const legacy = makeHarness({
      config: { routing: { mode: 'off' } },
      routing: singleModelPorts(policy),
      subagents: verdicts(),
    })
    const doneShipped = await driveFullStandardRun(shipped)
    const doneLegacy = await driveFullStandardRun(legacy)
    expect(doneLegacy.phase).toBe('completed')

    // DECISION 1 — what reached the dispatches: no explicit agentOptions in
    // EITHER run (inheritance on both sides of the comparison).
    expect(legacy.subagents.auditOptions).toEqual([undefined, undefined])
    expect(legacy.subagents.continuableOptions).toEqual([undefined])
    expect(shipped.subagents.auditOptions).toEqual(legacy.subagents.auditOptions)
    expect(shipped.subagents.continuableOptions).toEqual(legacy.subagents.continuableOptions)

    // DECISION 2 — the committed op sequence is identical.
    expect(eventsOf(shipped).map(event => event.op)).toEqual(eventsOf(legacy).map(event => event.op))

    // DECISION 3 — the audited route-evidence legs are identical: verdict,
    // status, creation and observed routes, no selection, same cross-family
    // outcome word. (`why` lists and diagnostic WORDING differ by design —
    // they are additive provenance, not decisions — so they are excluded and
    // named here rather than silently dropped.)
    const legsOf = (snapshot: Snapshot) => snapshot.audits.map(audit => ({
      role: audit.role,
      verdict: audit.verdict,
      selected: audit.route.selected,
      routeStatus: audit.route.routeStatus,
      routeProvider: audit.route.routeProvider,
      routeModel: audit.route.routeModel,
      observed: audit.route.observed,
      crossFamily: audit.route.crossFamily,
    }))
    expect(legsOf(doneShipped)).toEqual(legsOf(doneLegacy))

    // DECISION 4 — the terminal state a 0.2.0 reader cares about is identical.
    expect({
      phase: doneLegacy.phase,
      planGate: doneLegacy.planGate,
      executionGate: doneLegacy.executionGate,
      executorState: doneLegacy.executor?.state,
      executorGeneration: doneLegacy.executor?.generation,
      executionRevision: doneLegacy.executor?.executionRevision,
      routingPins: doneLegacy.routingPins,
    }).toEqual({
      phase: 'completed',
      planGate: 'pass',
      executionGate: 'pass',
      executorState: 'completed',
      executorGeneration: 1,
      executionRevision: 1,
      routingPins: undefined,
    })

    // The ONE difference, named: the shipped default carries an inherit routing
    // decision on each of its four dispatch commits (additive provenance with
    // no pin); the off-mode run carries none at all — which is precisely the
    // 0.2.0 event shape. Decisions equal, records strictly additive.
    const shippedDecisions = dispatchRouting(shipped)
    expect(shippedDecisions).toHaveLength(4)
    expect(shippedDecisions.every(decision => decision.pin === undefined)).toBe(true)
    const legacyDecisionDetails = eventsOf(legacy)
      .filter(event => event.op === 'audit' || event.op === 'start-executor')
      .map(event => (event.detail as { routing?: unknown } | undefined)?.routing)
    expect(legacyDecisionDetails.every(detail => detail === undefined)).toBe(true)
  })
})

describe('AC9 harness: a single-route session policy still selects nothing explicit', () => {
  it('a policy naming the one catalog route ⇒ inheritance-only semantics, the authority recorded honestly', async () => {
    // The cheap second case the packet allows: same harness, policy PRESENT but
    // naming exactly the single catalog route. A one-route authorized set has
    // nothing to choose between, so auto mode still selects NOTHING explicit —
    // and the decision honestly names 'session-policy' as the authority that
    // produced the one-route set (vs the absent-policy case, which names none).
    const policy: SessionPolicyState = { kind: 'present', routes: [{ provider: SOLE_PROVIDER, model: SOLE_MODEL }] }
    const ports = singleModelPorts(policy)
    const h = makeHarness({ config: {}, routing: ports, subagents: verdicts() })

    const done = await driveFullStandardRun(h)

    expect(done.phase).toBe('completed')
    expect(done.planGate).toBe('pass')
    expect(done.executionGate).toBe('pass')

    // Still inheritance-only: no agentOptions on any dispatch, no preflight.
    expect(h.subagents.auditOptions).toEqual([undefined, undefined])
    expect(h.subagents.continuableOptions).toEqual([undefined])
    expect(ports.llm.preflights).toEqual([])

    // Recorded honestly: every dispatch decision inherits (no pin), cites the
    // session policy as the authority behind the one-route set, and names the
    // single-route rule as the reason nothing was selected.
    const decisions = dispatchRouting(h)
    expect(decisions).toHaveLength(4)
    for (const decision of decisions) {
      expect(decision.pin).toBeUndefined()
      expect(decision.authorizationSource).toBe('session-policy')
      expect(decision.why.some(entry => entry.includes('session model-selection policy present'))).toBe(true)
      expect(decision.why.some(entry => entry.includes('single route'))).toBe(true)
      expect(decision.why.some(entry => entry.includes('inheritance is the honest record'))).toBe(true)
    }
    // And no pin ever existed, on any committed revision.
    expect(done.routingPins).toBeUndefined()
    for (const event of eventsOf(h)) {
      expect(event.snapshot.routingPins).toBeUndefined()
    }
    // The auditor records stay honest: no verified claim (nothing was selected
    // to verify) and the authority is named on the record itself.
    expect(done.audits.map(audit => audit.route.routeStatus)).toEqual(['unverified', 'unverified'])
    expect(done.audits.every(audit => audit.route.selected === undefined)).toBe(true)
    expect(done.audits.every(audit => audit.route.authorizationSource === 'session-policy')).toBe(true)
  })
})
