/**
 * Strict replay fold over a run's event stream.
 *
 * The fold is the invariant guardian: every event is validated against the
 * committed prefix before it is accepted, so an illegal stream (whether from a
 * buggy writer or a hand-edited file) is rejected loudly instead of folding
 * into a silently wrong state. Mirrors the CC rule that state.json is the only
 * canonical status, plus the experimental-GAH insight that replay must reject
 * malformed streams rather than tolerate them.
 */

import {
  AutopilotError,
  ROUTING_AUDITOR_ROLES,
  ROUTING_AUTHORIZATION_SOURCES,
  ROUTING_CANDIDATE_DISPOSITIONS,
  ROUTING_IDENTITY_AXES,
  ROUTING_INDEPENDENCE_OUTCOMES,
  ROUTING_ROLES,
  applyRoutingDecision,
  sameRoutingPins,
  validateExternalReview,
  TERMINAL_PHASES,
  evaluateCompletion,
  evidenceKindProblems,
  isAbsoluteShapedBearer,
  usageDeclarationProblems,
} from './types.js'
import type { AuditRole, Operation, Phase, RouteRecord, RunEvent, RoutingDecisionDetail, RoutingPin, Snapshot } from './types.js'

/** Operations legal from each phase (undefined prior state only admits init). */
const LEGAL_OPS: Record<Phase, readonly Operation[]> = {
  'planning': ['submit-plan', 'audit', 'self-check', 'external-audit', 'log', 'replan', 'set-blocked', 'set-owner-decision', 'owner-approve', 'consume-approval', 'consume-manifest', 'declare-usage', 'sandbox'],
  'plan-reviewing': ['audit', 'self-check', 'external-audit', 'log', 'set-blocked', 'set-owner-decision', 'owner-approve', 'consume-approval', 'consume-manifest', 'sandbox'],
  'executing': ['start-executor', 'resume-executor', 'submit-packet', 'submit-evidence', 'log', 'replan', 'set-blocked', 'set-owner-decision', 'owner-approve', 'consume-approval', 'consume-manifest', 'declare-usage', 'reminder', 'audit', 'self-check', 'external-audit', 'sandbox'],
  'execution-reviewing': ['audit', 'self-check', 'external-audit', 'log', 'replan', 'set-blocked', 'set-owner-decision', 'owner-approve', 'consume-approval', 'consume-manifest', 'reminder', 'sandbox'],
  'replanning': ['submit-plan', 'audit', 'self-check', 'external-audit', 'log', 'set-blocked', 'set-owner-decision', 'consume-manifest', 'declare-usage', 'sandbox'],
  // 'declare-usage' is legal here on purpose (added 2026-08-24): an entry
  // reverted to 'undeclared' during execution used to reach 'closing' with no
  // way back — `submit-closeout` refuses it and the entry could not be
  // re-declared, so the only exits were set-blocked or
  // set-owner-decision -> owner-resolve(resume-planning), which resets the plan
  // gate and forces the whole cycle to be redone. Answering the question late
  // is strictly better than a liveness dead end, and completion still refuses
  // until it IS answered.
  'closing': ['audit', 'self-check', 'external-audit', 'log', 'submit-closeout', 'set-blocked', 'set-owner-decision', 'owner-approve', 'consume-approval', 'consume-manifest', 'declare-usage', 'sandbox'],
  'completed': [],
  'blocked': [],
  'needs-owner-decision': ['owner-resolve', 'log', 'owner-approve', 'consume-approval', 'consume-manifest'],
}

function fail(message: string, code: string): never {
  throw new AutopilotError(message, code)
}

function assertStartExecutor(prior: Snapshot, next: Snapshot): void {
  const prev = prior.executor
  const folded = next.executor
  if (folded === undefined) fail('start-executor must carry an executor', 'AP_EXECUTOR_OP')
  if (prev === undefined || prev.state === 'completed' || prev.state === 'revoked') {
    if (folded.executionRevision !== 1) fail('start-executor executionRevision must be 1', 'AP_EXECUTOR_REVISION')
    if (folded.state !== 'starting') fail('start-executor from a predecessor must land in starting', 'AP_EXECUTOR_REVISION')
    const expectedGen = prev === undefined ? 1 : prev.generation + 1
    if (folded.generation !== expectedGen) {
      fail(
        `start-executor generation ${String(folded.generation)} is not ${String(expectedGen)}`,
        'AP_EXECUTOR_REVISION',
      )
    }
    if (prev !== undefined && folded.childId === prev.childId) {
      fail('start-executor must not reuse a predecessor childId', 'AP_EXECUTOR_REVISION')
    }
    return
  }
  if (prev.state === 'starting') {
    if (
      folded.childId !== prev.childId
      || folded.generation !== prev.generation
      || folded.executionRevision !== prev.executionRevision
    ) {
      fail(
        'start-executor starting transition must keep child identity and executionRevision',
        'AP_EXECUTOR_REVISION',
      )
    }
    if (folded.state !== 'running' && folded.state !== 'revoked') {
      fail(`start-executor from starting landed in ${folded.state}`, 'AP_EXECUTOR_REVISION')
    }
    return
  }
  fail(`start-executor cannot replace a live executor in state ${prev.state}`, 'AP_EXECUTOR_EXISTS')
}

function assertExecutorLifecycle(prior: Snapshot, next: Snapshot, op: Operation): void {
  const prev = prior.executor
  const folded = next.executor
  if (prev === undefined && folded === undefined) return
  if (prev === undefined || folded === undefined) {
    fail('executor appeared or disappeared', 'AP_EXECUTOR_MUTATED')
  }
  if (
    folded.childId !== prev.childId
    || folded.generation !== prev.generation
    || folded.executionRevision !== prev.executionRevision
    || JSON.stringify(folded.route) !== JSON.stringify(prev.route)
  ) {
    fail('executor identity mutated', 'AP_EXECUTOR_MUTATED')
  }
  if (folded.state !== prev.state) {
    if (prev.state === 'completed' || prev.state === 'revoked') {
      fail(
        `executor state ${prev.state} is terminal and must not change to ${folded.state}`,
        'AP_EXECUTOR_MUTATED',
      )
    }
    if (folded.state !== 'completed' && folded.state !== 'revoked') {
      fail(
        `executor state ${prev.state} -> ${folded.state} is not a lifecycle terminal`,
        'AP_EXECUTOR_MUTATED',
      )
    }
    if (op === 'replan' && folded.state !== 'revoked') {
      fail(
        `replan cannot move executor ${prev.state} to ${folded.state}`,
        'AP_EXECUTOR_MUTATED',
      )
    }
    if (
      (op === 'audit' || op === 'self-check' || op === 'external-audit')
      && folded.state === 'completed'
    ) {
      const appended = next.audits.slice(prior.audits.length)
      const latest = appended[appended.length - 1]
      if (latest === undefined || latest.role !== 'execution' || latest.verdict !== 'pass') {
        fail(
          `executor completed without an execution-pass ${op}`,
          'AP_EXECUTOR_MUTATED',
        )
      }
    }
  }
}

/**
 * Packet CAS stamp on a submit-packet event.
 * Missing detail / missing executionRevision is legacy-exempt only when bearerBase is absent.
 * A present non-integer revision/generation, or a present non-string childId, is not.
 */
function packetIdentityStamp(detail: unknown):
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid'; readonly field: string; readonly raw: unknown }
  | {
      readonly kind: 'ok'
      readonly executionRevision: number
      readonly generation: number | undefined
      readonly childId: string | undefined
    } {
  if (detail === null || typeof detail !== 'object') return { kind: 'absent' }
  if (!('executionRevision' in detail)) return { kind: 'absent' }
  const claimed = (detail as { executionRevision?: unknown }).executionRevision
  if (typeof claimed !== 'number' || !Number.isInteger(claimed)) {
    return { kind: 'invalid', field: 'executionRevision', raw: claimed }
  }
  let generation: number | undefined
  if ('generation' in detail) {
    const raw = (detail as { generation?: unknown }).generation
    if (typeof raw !== 'number' || !Number.isInteger(raw)) {
      return { kind: 'invalid', field: 'generation', raw }
    }
    generation = raw
  }
  let childId: string | undefined
  if ('childId' in detail) {
    const raw = (detail as { childId?: unknown }).childId
    if (typeof raw !== 'string' || raw.length === 0) {
      return { kind: 'invalid', field: 'childId', raw }
    }
    childId = raw
  }
  return { kind: 'ok', executionRevision: claimed, generation, childId }
}

/**
 * Evidence-kind format stamp on a submit-closeout event.
 *
 * WHY A STAMP AND NOT `bearerBase`. The packet-identity rule above uses
 * "bearerBase present" as its current-format test, and that works there because
 * both landed in the same change. `EvidenceEntry.kind` did not: `bearerBase` has
 * been stamped since PR #4, so every closeout already completed on today's main
 * carries a base and no kinds. Reusing that test would stop those streams
 * replaying — the fold would reject history that was legal when it was written.
 * A stamp the WRITER puts on the event says exactly what the writer promised,
 * which is the only thing replay may hold it to.
 *
 * 'absent' = written before this change; 'v1' = "proven evidence kind
 * validation v1": every PROVEN entry carries a kind (an unproven entry bears
 * nothing and may omit it — the tool schema is stricter, replay is not);
 * anything else in the field is a corrupt stamp, not an old stream.
 */
function evidenceKindStamp(detail: unknown): 'absent' | 'invalid' | 'v1' {
  if (detail === null || typeof detail !== 'object') return 'absent'
  if (!('evidenceKinds' in detail)) return 'absent'
  return (detail as { evidenceKinds?: unknown }).evidenceKinds === 1 ? 'v1' : 'invalid'
}

/**
 * The routing decision on a dispatch commit's `detail.routing`, STRICTLY
 * validated (packet M3b): `{role, pin?, why, authorizationSource,
 * fallbackFrom?, repinFrom?, candidates?}` and nothing else. Malformed ⇒ fold
 * error — a routing decision is authorization-bearing state, and a hand-edited
 * or foreign stream must be rejected loudly rather than folded into a pin the
 * engine never wrote. The `candidates` set (execution-audit P2-2) is validated
 * with the same strictness: a fabricated considered set is as dishonest on
 * replay as a fabricated pin, entry by entry over closed vocabularies.
 *
 * F22 (PR #2 Codex round 10), ADDITIVE STRICTNESS: a decision whose
 * `authorizationSource` is `'unreachable-inherit'` must be PINLESS. That
 * source exists to label one thing — an inheritance-only result of an
 * unreadable policy projection — so it cannot be the recorded authority for
 * an explicit route; accepting the combination would persist an
 * authorization-bearing pin whose stated source cannot authorize it.
 * Replay-compat, stated here because the rule narrows what replays: it only
 * REJECTS combinations that (a) no 0.2.0 stream ever contained —
 * `detail.routing` itself is new in this branch, so every 0.2.0 event takes
 * the no-routing arm below and no historical fixture can carry the pair —
 * and (b) no stream this branch's engine writes can contain, because the
 * engine stamps `'unreachable-inherit'` only on inheritance resolutions,
 * which are pinless by construction (the no-catalog auto-inherit branch and
 * the selector's unreachable-projection inherit). The rule therefore rejects
 * only hand-edited or foreign streams; the 0.2.0 fixture replay stays green
 * (asserted alongside, and by the legacy suite).
 *
 * Returns the VALIDATED detail, or `undefined` when no routing decision is
 * present (the 0.2.0 shape — every historical fixture takes this arm).
 */
function routingDecisionOf(op: Operation, detail: unknown): RoutingDecisionDetail | undefined {
  if (detail === null || typeof detail !== 'object' || !('routing' in detail)) return undefined
  const routing = (detail as { routing?: unknown }).routing
  if (routing === undefined) return undefined
  const where = `${op} detail.routing`
  const problems: string[] = []
  if (routing === null || typeof routing !== 'object' || Array.isArray(routing)) {
    fail(`${where} must be an object, got ${typeof routing}`, 'AP_ROUTING_DETAIL')
  }
  const record = routing as Record<string, unknown>
  const known: readonly string[] = ['role', 'pin', 'why', 'authorizationSource', 'fallbackFrom', 'repinFrom', 'candidates']
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) problems.push(`${where} has an unknown key "${key}"`)
  }
  const pinProblems = (label: string, value: unknown): string[] => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return [`${where}.${label} must be an object`]
    }
    const pin = value as Record<string, unknown>
    const out: string[] = []
    for (const key of Object.keys(pin)) {
      if (key !== 'provider' && key !== 'model' && key !== 'reasoningEffort') {
        out.push(`${where}.${label} has an unknown key "${key}"`)
      }
    }
    for (const field of ['provider', 'model'] as const) {
      const raw = pin[field]
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        out.push(`${where}.${label}.${field} must be a non-empty string`)
      }
    }
    const effort = pin.reasoningEffort
    if (effort !== undefined && (typeof effort !== 'string' || effort.trim().length === 0)) {
      out.push(`${where}.${label}.reasoningEffort must be a non-empty string when present`)
    }
    return out
  }
  const role = record.role
  if (typeof role !== 'string' || !ROUTING_ROLES.includes(role)) {
    problems.push(`${where}.role must be one of ${ROUTING_ROLES.join('|')}, got ${JSON.stringify(role)}`)
  } else if (op === 'start-executor') {
    if (role !== 'executor') problems.push(`${where}.role must be "executor" on a start-executor op, got "${role}"`)
  } else if (op === 'audit') {
    if (!ROUTING_AUDITOR_ROLES.includes(role)) {
      problems.push(`${where}.role must be an auditor role (${ROUTING_AUDITOR_ROLES.join('|')}) on an audit op, got "${role}"`)
    }
  }
  if ('pin' in record && record.pin !== undefined) problems.push(...pinProblems('pin', record.pin))
  const why = record.why
  if (!Array.isArray(why) || why.length === 0 || why.some((entry) => typeof entry !== 'string')) {
    problems.push(`${where}.why must be a non-empty array of strings`)
  }
  const source = record.authorizationSource
  if (source !== undefined) {
    if (typeof source !== 'string' || !ROUTING_AUTHORIZATION_SOURCES.includes(source)) {
      problems.push(
        `${where}.authorizationSource must be one of ${ROUTING_AUTHORIZATION_SOURCES.join('|')}, got ${JSON.stringify(source)}`,
      )
    } else if (source === 'unreachable-inherit' && record.pin !== undefined) {
      // F22 (see the doc comment above): the source names an inheritance-only
      // result of an unreadable policy projection — it cannot authorize a pin.
      problems.push(
        `${where}: authorizationSource "unreachable-inherit" cannot authorize the pin ${JSON.stringify(record.pin)} — `
          + 'that source marks an inheritance-only result of an unreadable policy projection; a decision carrying a pin must name an authority that can authorize it (session-policy or plugin-config) or carry no pin at all',
      )
    }
  } else if ('pin' in record && record.pin !== undefined) {
    // An explicit route always has an authority; an inherit under an absent
    // policy has none (see RoutingDecisionDetail). REQUIRE it exactly there.
    problems.push(`${where}.authorizationSource is required when a pin is present`)
  }
  if ('fallbackFrom' in record && record.fallbackFrom !== undefined) {
    const fallback = record.fallbackFrom
    if (!Array.isArray(fallback)) {
      problems.push(`${where}.fallbackFrom must be an array`)
    } else {
      for (const entry of fallback) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          problems.push(`${where}.fallbackFrom entries must be objects`)
          continue
        }
        const item = entry as Record<string, unknown>
        for (const key of Object.keys(item)) {
          if (key !== 'provider' && key !== 'model' && key !== 'reason') {
            problems.push(`${where}.fallbackFrom entry has an unknown key "${key}"`)
          }
        }
        for (const field of ['provider', 'model', 'reason'] as const) {
          const raw = item[field]
          if (typeof raw !== 'string' || raw.trim().length === 0) {
            problems.push(`${where}.fallbackFrom entry .${field} must be a non-empty string`)
          }
        }
      }
    }
  }
  if ('repinFrom' in record && record.repinFrom !== undefined) {
    problems.push(...pinProblems('repinFrom', record.repinFrom))
  }
  if ('candidates' in record && record.candidates !== undefined) {
    const candidates = record.candidates
    if (!Array.isArray(candidates)) {
      problems.push(`${where}.candidates must be an array`)
    } else {
      for (const entry of candidates) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          problems.push(`${where}.candidates entries must be objects`)
          continue
        }
        const item = entry as Record<string, unknown>
        const entryKeys: readonly string[] = ['provider', 'model', 'contextWindow', 'hasReasoningEfforts', 'independence', 'disposition', 'note']
        for (const key of Object.keys(item)) {
          if (!entryKeys.includes(key)) problems.push(`${where}.candidates entry has an unknown key "${key}"`)
        }
        for (const field of ['provider', 'model'] as const) {
          const raw = item[field]
          if (typeof raw !== 'string' || raw.trim().length === 0) {
            problems.push(`${where}.candidates entry .${field} must be a non-empty string`)
          }
        }
        const disposition = item.disposition
        if (typeof disposition !== 'string' || !ROUTING_CANDIDATE_DISPOSITIONS.includes(disposition)) {
          problems.push(
            `${where}.candidates entry .disposition must be one of ${ROUTING_CANDIDATE_DISPOSITIONS.join('|')}, got ${JSON.stringify(disposition)}`,
          )
        }
        const window = item.contextWindow
        if (window !== undefined && (typeof window !== 'number' || !Number.isInteger(window) || window <= 0)) {
          problems.push(`${where}.candidates entry .contextWindow must be a positive integer when present`)
        }
        if (typeof item.hasReasoningEfforts !== 'boolean') {
          problems.push(`${where}.candidates entry .hasReasoningEfforts must be a boolean`)
        }
        const note = item.note
        if (note !== undefined && (typeof note !== 'string' || note.trim().length === 0)) {
          problems.push(`${where}.candidates entry .note must be a non-empty string when present`)
        }
        const independence = item.independence
        if (independence !== undefined) {
          if (independence === null || typeof independence !== 'object' || Array.isArray(independence)) {
            problems.push(`${where}.candidates entry .independence must be an object`)
          } else {
            const axes = independence as Record<string, unknown>
            for (const key of Object.keys(axes)) {
              if (key !== 'modelAxis' && key !== 'providerAxis' && key !== 'outcome') {
                problems.push(`${where}.candidates entry .independence has an unknown key "${key}"`)
              }
            }
            for (const axis of ['modelAxis', 'providerAxis'] as const) {
              const raw = axes[axis]
              if (typeof raw !== 'string' || !ROUTING_IDENTITY_AXES.includes(raw)) {
                problems.push(
                  `${where}.candidates entry .independence.${axis} must be one of ${ROUTING_IDENTITY_AXES.join('|')}, got ${JSON.stringify(raw)}`,
                )
              }
            }
            const outcome = axes.outcome
            if (typeof outcome !== 'string' || !ROUTING_INDEPENDENCE_OUTCOMES.includes(outcome)) {
              problems.push(
                `${where}.candidates entry .independence.outcome must be one of ${ROUTING_INDEPENDENCE_OUTCOMES.join('|')}, got ${JSON.stringify(outcome)}`,
              )
            }
          }
        }
      }
    }
  }
  if (problems.length > 0) {
    fail(`${where} is malformed: ${problems.join('; ')}`, 'AP_ROUTING_DETAIL')
  }
  return record as unknown as RoutingDecisionDetail
}

/**
 * The audit role each auditor routing role names — the domain-side mirror of
 * the engine's `routeRoleOf` (the fold may not import the engine that imports
 * it; the mapping is the one rule both sides share, so it is stated once here
 * and must move with the role vocabularies).
 */
const AUDIT_ROLE_OF_ROUTING_ROLE: Readonly<Record<string, AuditRole>> = {
  'plan-auditor': 'plan',
  'execution-auditor': 'execution',
  'rules-auditor': 'rules',
}

/** Field-wise pin equality: provider, model, and effort (absent equals absent). */
function sameRoutePin(a: RoutingPin, b: RoutingPin): boolean {
  return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}

/**
 * F26 (PR #2 Codex round 13), ADDITIVE STRICTNESS: when one dispatch commit
 * carries BOTH a validated `detail.routing` AND a record the same commit
 * appends (an AuditRecord on `audit`, the ExecutorRecord on `start-executor`),
 * the two must agree — the detail's role names the appended record's role, and
 * the detail's pin and the record's `selected` route are the SAME route.
 * Before this, replay validated the detail and derived the pin state from it
 * but never compared it to the appended record, so a foreign event could
 * append an execution-auditor pass whose RouteRecord claims route B while the
 * validated detail names plan-auditor pin A — and the fold accepted the
 * contradictory canonical state.
 *
 * THE EXACT COMPARISON, per the engine's own stamp shapes (they define the
 * legal space): the writer merges the decision onto the record it appends
 * (`withRoutingRecord`), so an engine-written record's `selected` IS the
 * detail's pin — present iff the pin is — and an audit detail's role is
 * `routeRoleOf(record.role)`. Legitimate omissions are therefore exactly the
 * ones the writer can produce: the record carries route-evidence legs the
 * detail has no counterpart for (`observed`, `routeStatus`,
 * `routeProvider`/`routeModel`, `crossFamily`, …) and mirrors the detail's
 * decision fields under its own names (`why`, `authorizationSource`,
 * `fallbackFrom`, `candidatesConsidered`) — those pairs are deliberately NOT
 * compared. What is a genuine contradiction on either side: a role naming a
 * different dispatch than the record it appends, a `selected` route with no
 * pin behind it, a pin whose record carries a different `selected`, or the
 * two routes differing on any axis (provider, model, effort — absent effort
 * on one side and present on the other is a difference).
 *
 * Replay-compat, same argument as F22 above: the rule fires only when BOTH
 * sides are present. `detail.routing` is new in this branch, so no 0.2.0
 * event can carry it (every historical fixture takes the no-binding arm),
 * and this branch's writer satisfies the equality by construction. A
 * routing-detail-only event (a decision with no appended record) and every
 * record-only event (all of 0.2.0, self-check, external countersigns) fold
 * exactly as before.
 */
function bindRoutingDetailToRecords(
  event: RunEvent,
  routing: RoutingDecisionDetail,
  prior: Snapshot,
  next: Snapshot,
): void {
  if (event.op !== 'audit' && event.op !== 'start-executor') return // unreachable: callers pass only dispatch ops
  const op = event.op
  const pinEqualsSelected = (label: string, route: RouteRecord): void => {
    if (routing.pin === undefined && route.selected === undefined) return
    if (routing.pin !== undefined && route.selected !== undefined && sameRoutePin(routing.pin, route.selected)) return
    fail(
      `${op} detail.routing pins role "${routing.role}" to ${JSON.stringify(routing.pin)} but the appended ${label}'s route record carries selected ${JSON.stringify(route.selected)} — the decision and the record it stamps must name the same route, present on both or neither`,
      'AP_ROUTING_RECORD_MISMATCH',
    )
  }
  if (op === 'audit') {
    for (let i = prior.audits.length; i < next.audits.length; i++) {
      const record = next.audits[i]
      if (record === undefined) continue // the array is index-validated elsewhere; nothing to bind
      const expectedRole = AUDIT_ROLE_OF_ROUTING_ROLE[routing.role]
      if (expectedRole === undefined || expectedRole !== record.role) {
        fail(
          `audit detail.routing names role "${routing.role}" but appended audit record ${i} has role "${record.role}" — one dispatch, one role: the decision must bind the record it appends`,
          'AP_ROUTING_RECORD_MISMATCH',
        )
      }
      pinEqualsSelected(`audit record ${i}`, record.route)
    }
    return
  }
  // start-executor: `routingDecisionOf` already held the detail to the
  // 'executor' role on this op; the binding left to check is pin ↔ the
  // executor record's own route.
  if (next.executor !== undefined) pinEqualsSelected('executor record', next.executor.route)
}

/** Assert one event is a legal successor of the prior snapshot; returns the new snapshot. */
export function applyEvent(prior: Snapshot | undefined, event: RunEvent): Snapshot {
  if (event.v !== 1) fail(`unsupported event version ${String((event as { v: unknown }).v)}`, 'AP_EVENT_VERSION')
  const next = event.snapshot

  if (prior === undefined) {
    if (event.op !== 'init') fail(`first event must be init, got ${event.op}`, 'AP_FIRST_NOT_INIT')
    if (event.revision !== 1 || next.revision !== 1) fail('init revision must be 1', 'AP_INIT_REVISION')
    if (next.phase !== 'planning') fail(`init phase must be planning, got ${next.phase}`, 'AP_INIT_PHASE')
    if (next.planGate !== 'pending' || next.executionGate !== 'pending') fail('init gates must be pending', 'AP_INIT_GATES')
    if (next.audits.length !== 0) fail('init audits must be empty', 'AP_INIT_AUDITS')
    if (next.executor !== undefined) fail('init executor must be absent', 'AP_INIT_EXECUTOR')
    if (next.routingPins !== undefined) {
      fail('init routingPins must be absent — pins derive from dispatch detail.routing only', 'AP_INIT_ROUTING_PINS')
    }
    if (next.bearerBase !== undefined) {
      if (next.bearerBase.length === 0) fail('init bearerBase must not be empty when present', 'AP_BEARER_BASE_EMPTY')
      if (!isAbsoluteShapedBearer(next.bearerBase)) {
        fail('init bearerBase must be absolute-shaped when present', 'AP_BEARER_BASE_RELATIVE')
      }
    }
    return next
  }

  if (event.op === 'init') fail('run is already initialized', 'AP_ALREADY_INITIALIZED')
  if (TERMINAL_PHASES.includes(prior.phase)) fail(`no events after terminal phase ${prior.phase}`, 'AP_AFTER_TERMINAL')
  if (event.revision !== prior.revision + 1 || next.revision !== event.revision) {
    fail(`non-monotonic revision: prior ${prior.revision}, event ${event.revision}, snapshot ${next.revision}`, 'AP_REVISION')
  }
  if (next.runId !== prior.runId) fail('runId changed mid-stream', 'AP_RUN_ID')
  if (JSON.stringify(next.triage) !== JSON.stringify(prior.triage)) fail('triage is immutable after init', 'AP_TRIAGE_MUTATED')
  if (prior.bearerBase !== next.bearerBase) fail('bearerBase mutated', 'AP_BEARER_BASE_MUTATED')
  if (!LEGAL_OPS[prior.phase].includes(event.op)) {
    fail(`op ${event.op} is illegal in phase ${prior.phase}`, 'AP_ILLEGAL_OP')
  }

  // Routing pins derive from dispatch-op `detail.routing` ONLY (plan "Route
  // records and stability", refined pinning delta): last-wins per role — set on
  // a `route` decision, cleared on an `inherit`. The engine builds the committed
  // snapshot with the SAME shared derivation (`applyRoutingDecision`), so this
  // check holds every event to the one rule rather than trusting the writer's
  // arithmetic. Events without `detail.routing` replay exactly as 0.2.0: the
  // pin state must be byte-stable across them, which is also what makes a
  // legacy stream with no pins at all fold unchanged.
  const dispatchRouting = event.op === 'audit' || event.op === 'start-executor'
    ? routingDecisionOf(event.op, event.detail)
    : undefined
  if (event.op === 'audit' || event.op === 'start-executor') {
    const expected = dispatchRouting !== undefined ? applyRoutingDecision(prior.routingPins, dispatchRouting) : prior.routingPins
    if (!sameRoutingPins(expected, next.routingPins)) {
      fail(
        dispatchRouting !== undefined
          ? `routingPins do not match detail.routing for role "${dispatchRouting.role}" (expected ${JSON.stringify(expected)}, got ${JSON.stringify(next.routingPins)})`
          : `routingPins mutated without a routing decision (expected ${JSON.stringify(prior.routingPins)}, got ${JSON.stringify(next.routingPins)})`,
        'AP_ROUTING_PINS',
      )
    }
  } else if (!sameRoutingPins(prior.routingPins, next.routingPins)) {
    fail(
      `routingPins mutated via op ${event.op} (pins derive from audit/start-executor detail.routing only)`,
      'AP_ROUTING_PINS_MUTATED',
    )
  }

  // Audit history is append-only.
  if (next.audits.length < prior.audits.length) fail('audit history shrank', 'AP_AUDITS_SHRANK')
  for (let i = 0; i < prior.audits.length; i++) {
    if (JSON.stringify(next.audits[i]) !== JSON.stringify(prior.audits[i])) {
      fail(`audit record ${i} was modified`, 'AP_AUDITS_MODIFIED')
    }
  }

  // F26: bind a present routing detail to the record(s) this same commit
  // appends (see bindRoutingDetailToRecords for the exact comparison and the
  // replay-compat argument). Fires only when BOTH sides are present.
  if (dispatchRouting !== undefined) {
    bindRoutingDetailToRecords(event, dispatchRouting, prior, next)
  }

  // An owner countersign is validated ON REPLAY, not only where it was written.
  // This repo already paid for the other arrangement once: a class obligation
  // enforced solely by the writer, so a hand-edited or foreign stream carried
  // it straight through the fold. The FILESYSTEM half (does the review exist?)
  // deliberately stays out — replay must not depend on disk state, so that half
  // settles at completion in the engine.
  for (let i = prior.audits.length; i < next.audits.length; i++) {
    const record = next.audits[i]
    if (record?.external === undefined) continue
    if (next.triage.auditMode !== 'external') {
      fail(
        `audit record ${i} carries an external countersign but auditMode is ${next.triage.auditMode}`,
        'AP_EXTERNAL_WRONG_MODE',
      )
    }
    const problems = validateExternalReview(record.external)
    if (problems.length > 0) fail(`audit record ${i}: ${problems.join('; ')}`, 'AP_EXTERNAL_INVALID')
  }

  // Plan revision is monotonic.
  if (next.plan.revision < prior.plan.revision) fail('plan revision decreased', 'AP_PLAN_REVISION')

  // Usage evidence is append-or-replace, never subtractive. An id that was
  // once declared names a real user-visible change; letting it vanish would
  // let a run answer the usage question by deleting the question. Replacement
  // (last-wins on the same id) is the legal way to upgrade a declaration.
  if (prior.usage !== undefined) {
    if (next.usage === undefined) fail('usage evidence disappeared', 'AP_USAGE_SHRANK')
    const ids = new Set(next.usage.entries.map(entry => entry.id))
    for (const entry of prior.usage.entries) {
      if (!ids.has(entry.id)) fail(`usage entry ${entry.id} was dropped`, 'AP_USAGE_SHRANK')
    }
  }

  // The plan-gate timestamp is the freshness anchor every usage artifact is
  // measured against. Restamping it would silently re-validate artifacts that
  // predate the gate, so it is write-once for the life of the run.
  if (prior.planGatePassedAt !== undefined && next.planGatePassedAt !== prior.planGatePassedAt) {
    fail('planGatePassedAt was restamped', 'AP_GATE_STAMP_MUTATED')
  }

  // A new plan submission must not carry stale execution evidence or gate
  // values into the next round (evidence chains restart per plan revision).
  if (event.op === 'submit-plan') {
    if (next.executionPacket !== undefined) fail('submit-plan must clear the execution packet', 'AP_STALE_EVIDENCE')
    if (next.executionGate !== 'pending') fail('submit-plan must reset executionGate to pending', 'AP_STALE_EVIDENCE')
  }

  // Stamped packet identity must match the live executor. Absent detail is
  // legacy-exempt only when bearerBase is absent. A present non-integer
  // revision/generation is a corrupt stamp, not an old stream. Current-format
  // streams also require generation and childId so a replacement executor at
  // revision 1 cannot accept a delayed packet from the revoked generation.
  if (event.op === 'submit-packet') {
    const stamp = packetIdentityStamp(event.detail)
    if (stamp.kind === 'invalid') {
      if (stamp.field === 'executionRevision') {
        fail(
          `submit-packet executionRevision is not an integer: ${String(stamp.raw)}`,
          'AP_PACKET_REVISION_REQUIRED',
        )
      }
      fail(
        `submit-packet ${stamp.field} is not valid: ${String(stamp.raw)}`,
        'AP_PACKET_REVISION_REQUIRED',
      )
    }
    if (stamp.kind === 'absent' && prior.bearerBase !== undefined) {
      fail(
        'submit-packet executionRevision is required on current-format streams',
        'AP_PACKET_REVISION_REQUIRED',
      )
    }
    if (stamp.kind === 'ok') {
      if (prior.bearerBase !== undefined) {
        if (stamp.generation === undefined) {
          fail(
            'submit-packet generation is required on current-format streams',
            'AP_PACKET_REVISION_REQUIRED',
          )
        }
        if (stamp.childId === undefined) {
          fail(
            'submit-packet childId is required on current-format streams',
            'AP_PACKET_REVISION_REQUIRED',
          )
        }
      }
      const liveRev = prior.executor?.executionRevision
      if (liveRev !== stamp.executionRevision) {
        fail(
          `submit-packet executionRevision ${String(stamp.executionRevision)} does not match live ${String(liveRev)}`,
          'AP_PACKET_REVISION_MISMATCH',
        )
      }
      const foldedRev = next.executor?.executionRevision
      if (foldedRev !== stamp.executionRevision) {
        fail(
          `submit-packet snapshot executionRevision ${String(foldedRev)} does not retain stamped live ${String(stamp.executionRevision)}`,
          'AP_PACKET_REVISION_MUTATED',
        )
      }
      if (stamp.generation !== undefined && stamp.generation !== prior.executor?.generation) {
        fail(
          `submit-packet generation ${String(stamp.generation)} does not match live ${String(prior.executor?.generation)}`,
          'AP_PACKET_REVISION_MISMATCH',
        )
      }
      if (stamp.childId !== undefined && stamp.childId !== prior.executor?.childId) {
        fail(
          `submit-packet childId ${stamp.childId} does not match live ${String(prior.executor?.childId)}`,
          'AP_PACKET_REVISION_MISMATCH',
        )
      }
    }
  }

  // No executor before the plan gate has ever passed (start-executor requires it right now).
  if (event.op === 'start-executor' && prior.planGate !== 'pass') {
    fail('executor before planGate pass', 'AP_EXECUTOR_BEFORE_GATE')
  }
  if (next.executor !== undefined && prior.executor === undefined && event.op !== 'start-executor') {
    fail(`executor appeared via op ${event.op}`, 'AP_EXECUTOR_OP')
  }
  if (event.op === 'resume-executor') {
    const prev = prior.executor
    const folded = next.executor
    if (prev === undefined || folded === undefined) {
      fail('resume-executor requires a live running executor', 'AP_EXECUTOR_REVISION')
    }
    if (prev.state !== 'running' || folded.state !== 'running') {
      fail(
        `resume-executor state ${prev.state} -> ${folded.state} is not running -> running`,
        'AP_EXECUTOR_REVISION',
      )
    }
    if (folded.childId !== prev.childId || folded.generation !== prev.generation) {
      fail('resume-executor must keep childId and generation', 'AP_EXECUTOR_REVISION')
    }
    if (folded.executionRevision !== prev.executionRevision + 1) {
      fail(
        `resume-executor executionRevision ${String(folded.executionRevision)} is not prior ${String(prev.executionRevision)} + 1`,
        'AP_EXECUTOR_REVISION',
      )
    }
  } else if (event.op === 'start-executor') {
    assertStartExecutor(prior, next)
  } else if (
    event.op === 'replan'
    || event.op === 'audit'
    || event.op === 'self-check'
    || event.op === 'external-audit'
  ) {
    assertExecutorLifecycle(prior, next, event.op)
  } else if (JSON.stringify(prior.executor) !== JSON.stringify(next.executor)) {
    fail('executor mutated', 'AP_EXECUTOR_MUTATED')
  }

  // Plan gate pass requires the usage question to have been answered. The
  // coupling used to live ONLY in `AutopilotEngine.applyVerdict`, which is the
  // writer — so a stream that arrived any other way (a hand-edited file, a
  // buggy writer, an older build) folded clean and became the live snapshot on
  // a cold resume, after which `start-executor` sees `planGate === 'pass'` and
  // proceeds. The executionGate rule below already carried its invariant into
  // the fold; this is the missing symmetric half.
  if (next.planGate === 'pass' && prior.planGate !== 'pass') {
    const undeclared = usageDeclarationProblems(next.usage)
    if (undeclared.length > 0) {
      fail(`planGate pass with unanswered usage evidence: ${undeclared.join('; ')}`, 'AP_GATE_WITH_UNDECLARED_USAGE')
    }
  }

  // Execution gate pass requires a matching latest execution-audit pass in the record.
  if (next.executionGate === 'pass' && prior.executionGate !== 'pass') {
    const executionAudits = next.audits.filter(record => record.role === 'execution')
    const latest = executionAudits[executionAudits.length - 1]
    if (latest === undefined || latest.verdict !== 'pass') {
      fail('executionGate pass without a latest execution-audit pass', 'AP_GATE_WITHOUT_AUDIT')
    }
  }

  // Evidence kinds, BEFORE the completion re-check below. Order is the point:
  // a kind-less proven entry also fails `evaluateCompletion`, and if that ran
  // first the stream would be rejected as AP_INCOMPLETE_COMPLETION — true but
  // useless. The specific code is what tells a reader which rule was broken.
  if (event.op === 'submit-closeout') {
    const stamp = evidenceKindStamp(event.detail)
    if (stamp === 'invalid') {
      const raw = (event.detail as { evidenceKinds?: unknown }).evidenceKinds
      fail(
        `submit-closeout evidenceKinds stamp is not the integer 1: ${String(raw)}`,
        'AP_EVIDENCE_KIND_STAMP_INVALID',
      )
    }
    if (stamp === 'v1') {
      const problems = evidenceKindProblems(next.closeout?.evidence ?? [], { requireKind: true })
      const first = problems[0]
      if (first !== undefined) {
        fail(
          `submit-closeout stamped evidenceKinds 1: ${problems.map(problem => problem.message).join('; ')}`,
          first.code,
        )
      }
    }
  }

  // Completion is structurally validated, not asserted.
  if (next.phase === 'completed') {
    const check = evaluateCompletion(next)
    if (!check.ok) {
      fail(`completed snapshot fails completion check: ${check.problems.join('; ')}`, 'AP_INCOMPLETE_COMPLETION')
    }
  }

  return next
}

/** Fold result. */
export interface FoldState {
  readonly snapshot: Snapshot | undefined
  readonly eventCount: number
}

/**
 * Replay a full event stream strictly. Throws AutopilotError on the first
 * illegal event. An empty stream folds to an uninitialized state.
 */
export function foldRun(events: readonly RunEvent[]): FoldState {
  let snapshot: Snapshot | undefined
  for (const event of events) {
    snapshot = applyEvent(snapshot, event)
  }
  return { snapshot, eventCount: events.length }
}
