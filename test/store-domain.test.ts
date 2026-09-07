/**
 * DomainRunStore against an in-memory fake of `ctx.storageDomain`.
 *
 * The fake mirrors the measured upstream contract (dsh 0.1.1-rc.2): tables are
 * Map-backed with SYNCHRONOUS `get`/`entries`/`keys` and ASYNCHRONOUS `put`,
 * every stored record is run through the spec's `valueSchema.parse` at open,
 * and domain/table names are checked against `UNIT_NAME_RE`. Fixtures are
 * local rather than imported from `./helpers.ts` so this file does not depend
 * on the engine/index modules another milestone is rewriting.
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AUTOPILOT_DOMAIN_SPEC,
  DomainRunStore,
  EVENTS_TABLE,
  REVISION_KEY_WIDTH,
  RUNS_TABLE,
  eventKey,
  parseEventKey,
} from '../src/store/domain.js'
import type { DomainFacilityLike, DomainLike, DomainSpecLike, KvTableLike } from '../src/store/domain.js'
import { RunStore, runDirFor } from '../src/store/file.js'
import { AutopilotError } from '../src/domain/types.js'
import type { AuditRecord, Closeout, RunEvent, Snapshot, Triage } from '../src/domain/types.js'

/**
 * Upstream's name rule, transcribed from
 * `packages/storage/storage/src/backend.ts:10` (dsh 0.1.1-rc.2). Kept here so
 * the spec's names are checked against the medium's actual constraint rather
 * than against a habit.
 */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

// ---------------------------------------------------------------- fake domain

/**
 * Every `put` across every table, in the order it happened.
 *
 * WHY it is shared and module-level: the ordering claim
 * ("the canonical event lands BEFORE the runs projection", `commit`'s own
 * source comment calls it LOAD-BEARING) is a claim about two DIFFERENT tables,
 * so no per-table record can observe it. The test that carried that name
 * asserted only that both writes had happened, which holds under either order —
 * swapping the two awaits in `DomainRunStore.commit` left the suite green.
 */
const WRITE_LOG: Array<[string, string]> = []

class FakeTable implements KvTableLike {
  readonly records = new Map<string, unknown>()

  constructor(readonly tableName: string = '<unnamed>') {}

  get(key: string): unknown {
    return this.records.get(key)
  }

  entries(): IterableIterator<[string, unknown]> {
    return [...this.records.entries()][Symbol.iterator]()
  }

  keys(): IterableIterator<string> {
    return [...this.records.keys()][Symbol.iterator]()
  }

  async put(key: string, value: unknown): Promise<void> {
    WRITE_LOG.push([this.tableName, key])
    this.records.set(key, value)
  }

  async delete(key: string): Promise<boolean> {
    return this.records.delete(key)
  }
}

class FakeDomain implements DomainLike {
  readonly tables = new Map<string, FakeTable>()
  closed = false

  constructor(spec: DomainSpecLike, seed: Record<string, Record<string, unknown>>) {
    for (const [name, tableSpec] of Object.entries(spec.tables)) {
      if (!UNIT_NAME_RE.test(name)) throw new Error(`table name '${name}' must match ${String(UNIT_NAME_RE)}`)
      const table = new FakeTable(name)
      for (const [key, raw] of Object.entries(seed[name] ?? {})) {
        // Upstream validates every stored record at open; so does the fake.
        table.records.set(key, tableSpec.valueSchema.parse(raw))
      }
      this.tables.set(name, table)
    }
  }

  table(name: string): KvTableLike {
    const table = this.tables.get(name)
    if (table === undefined) throw new Error(`domain declares no table '${name}'`)
    return table
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

class FakeFacility implements DomainFacilityLike {
  domain: FakeDomain | undefined

  constructor(private readonly seed: Record<string, Record<string, unknown>> = {}) {}

  async open(spec: DomainSpecLike): Promise<DomainLike> {
    if (!UNIT_NAME_RE.test(spec.name)) throw new Error(`domain name '${spec.name}' must match ${String(UNIT_NAME_RE)}`)
    const domain = new FakeDomain(spec, this.seed)
    this.domain = domain
    return domain
  }
}

// -------------------------------------------------------------------- fixtures

function makeTriage(overrides: Partial<Triage> = {}): Triage {
  return {
    objective: 'domain store round-trip',
    scope: ['src/store/'],
    nonGoals: ['src/engine.ts'],
    acceptanceCriteria: ['stream replays'],
    risk: 'low',
    size: 'lightweight',
    executionMode: 'inline',
    auditMode: 'self-check',
    touchesOperatingLayer: false,
    baseline: {},
    ...overrides,
  }
}

const TRIAGE = makeTriage()

function baseSnapshot(runId: string, overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    runId,
    revision: 1,
    triage: TRIAGE,
    plan: { revision: 0, text: '' },
    phase: 'planning',
    planGate: 'pending',
    executionGate: 'pending',
    audits: [],
    residualRisks: [],
    logCount: 0,
    consecutiveReplans: 0,
    enforcement: { sandbox: 'off', reminders: 0, ownerApprovals: [] },
    ...overrides,
  }
}

function selfCheck(role: AuditRecord['role'], seq: number, planRevision: number, executionRevision: number): AuditRecord {
  return {
    role,
    seq,
    runRevision: 1,
    planRevision,
    executionRevision,
    auditorId: 'self-check',
    verdict: 'pass',
    note: 'ok',
    route: {
      provider: 'self-check',
      routeProvider: 'self-check',
      routeModel: 'self-check',
      routeStatus: 'verified',
    },
  }
}

const CLOSEOUT: Closeout = {
  summary: 'domain-backed run closed',
  changedFiles: ['src/store/domain.ts'],
  commands: ['npx vitest run test/store-domain.test.ts'],
  evidence: [{ criterion: 'stream replays', bearer: 'this test file', status: 'proven' }],
  residualRisks: [],
  exclusions: [],
  workspaceCleanup: 'nothing to clean',
  drift: 'none found',
}

/**
 * One legal transition sequence, long enough that the events cross the
 * single-digit revision boundary (the key-padding boundary this store depends
 * on). Returned as `[op, snapshot]` pairs so the caller can commit them in
 * order; the cardinality floor is asserted at the call sites, not here.
 */
function legalSequence(runId: string): Array<[RunEvent['op'], Snapshot]> {
  const steps: Array<[RunEvent['op'], Snapshot]> = []
  let revision = 1
  steps.push(['init', baseSnapshot(runId, { revision })])

  revision += 1
  steps.push(['sandbox', baseSnapshot(runId, {
    revision,
    enforcement: { sandbox: 'degraded', reminders: 0, ownerApprovals: [], modeAppended: true },
  })])

  // Seven checkpoints: cheap legal events that keep the run in `planning`.
  for (let i = 1; i <= 7; i++) {
    revision += 1
    steps.push(['log', baseSnapshot(runId, {
      revision,
      logCount: i,
      enforcement: { sandbox: 'degraded', reminders: 0, ownerApprovals: [], modeAppended: true },
    })])
  }

  const carried = {
    logCount: 7,
    enforcement: { sandbox: 'degraded' as const, reminders: 0, ownerApprovals: [], modeAppended: true },
  }

  revision += 1
  steps.push(['submit-plan', baseSnapshot(runId, {
    ...carried,
    revision,
    phase: 'plan-reviewing',
    plan: { revision: 1, text: 'the plan' },
  })])

  const planAudit = selfCheck('plan', 0, 1, 0)
  revision += 1
  steps.push(['self-check', baseSnapshot(runId, {
    ...carried,
    revision,
    phase: 'executing',
    plan: { revision: 1, text: 'the plan' },
    planGate: 'pass',
    planGatePassedAt: '2026-08-24T00:00:00.000Z',
    audits: [planAudit],
  })])

  revision += 1
  steps.push(['submit-evidence', baseSnapshot(runId, {
    ...carried,
    revision,
    phase: 'execution-reviewing',
    plan: { revision: 1, text: 'the plan' },
    planGate: 'pass',
    planGatePassedAt: '2026-08-24T00:00:00.000Z',
    audits: [planAudit],
    executionPacket: 'inline evidence report',
  })])

  const executionAudit = selfCheck('execution', 1, 1, 1)
  revision += 1
  steps.push(['self-check', baseSnapshot(runId, {
    ...carried,
    revision,
    phase: 'closing',
    plan: { revision: 1, text: 'the plan' },
    planGate: 'pass',
    planGatePassedAt: '2026-08-24T00:00:00.000Z',
    executionGate: 'pass',
    audits: [planAudit, executionAudit],
    executionPacket: 'inline evidence report',
  })])

  revision += 1
  steps.push(['submit-closeout', baseSnapshot(runId, {
    ...carried,
    revision,
    phase: 'completed',
    plan: { revision: 1, text: 'the plan' },
    planGate: 'pass',
    planGatePassedAt: '2026-08-24T00:00:00.000Z',
    executionGate: 'pass',
    audits: [planAudit, executionAudit],
    executionPacket: 'inline evidence report',
    closeout: CLOSEOUT,
  })])

  return steps
}

function storedEvent(runId: string, op: RunEvent['op'], snapshot: Snapshot): RunEvent {
  return { v: 1, op, revision: snapshot.revision, time: '2026-08-24T00:00:00.000Z', snapshot }
}

/** Assert a thrown AutopilotError BY CODE; a boolean "it threw" would not distinguish the failure modes. */
function expectCode(run: () => unknown, code: string): void {
  try {
    run()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AutopilotError)
    expect((error as AutopilotError).code).toBe(code)
    return
  }
  expect.unreachable(`expected an AutopilotError with code ${code}`)
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-autopilot-domain-'))
}

// ----------------------------------------------------------------------- tests

describe('AUTOPILOT_DOMAIN_SPEC', () => {
  it('names the domain and its tables inside the medium-safe alphabet', () => {
    expect(UNIT_NAME_RE.test(AUTOPILOT_DOMAIN_SPEC.name)).toBe(true)
    for (const table of Object.keys(AUTOPILOT_DOMAIN_SPEC.tables)) {
      expect(UNIT_NAME_RE.test(table)).toBe(true)
    }
    // In-place proof that the rule carries information: the hyphenated package
    // name (the obvious choice) is still outside the accepted set, so the
    // assertion above is not vacuously true of any string.
    expect(UNIT_NAME_RE.test('dsh-autopilot')).toBe(false)
    expect(Object.keys(AUTOPILOT_DOMAIN_SPEC.tables).sort()).toEqual([EVENTS_TABLE, RUNS_TABLE].sort())
  })

  it('keeps record validation permissive in shape but not inert', () => {
    const schema = AUTOPILOT_DOMAIN_SPEC.tables[EVENTS_TABLE]?.valueSchema
    expect(schema).toBeDefined()
    // Positive: an arbitrary object passes untouched — the fold, not the
    // schema, owns the Snapshot invariants.
    const record = { v: 1, op: 'init', anythingElse: true }
    expect(schema?.parse(record)).toBe(record)
    // Negative: the same checker rejects a non-record, so its pass means something.
    expectCode(() => schema?.parse('not an object'), 'AP_STORE_CORRUPT')
    expectCode(() => schema?.parse(null), 'AP_STORE_CORRUPT')
  })
})

describe('event keys', () => {
  it('round-trips a run id and revision, including a run id containing #', () => {
    const key = eventKey('sess#42', 7)
    expect(parseEventKey(key)).toEqual({ runId: 'sess#42', revision: 7 })
  })

  it('sorts lexically in revision order past 9 and past 99', () => {
    const revisions = Array.from({ length: 120 }, (_, index) => index + 1)
    // Cardinality floor asserted in place: the range must actually cross both
    // padding boundaries, otherwise this test proves nothing about padding.
    expect(revisions.length).toBeGreaterThanOrEqual(12)
    expect(revisions.some(revision => revision > 9)).toBe(true)
    expect(revisions.some(revision => revision > 99)).toBe(true)

    const shuffled = [...revisions].reverse()
    const padded = shuffled.map(revision => eventKey('run-1', revision)).sort()
    expect(padded.map(key => parseEventKey(key).revision)).toEqual(revisions)

    // Negative control: without the fixed-width padding the SAME sort
    // misorders, which is what makes REVISION_KEY_WIDTH load-bearing rather
    // than decorative.
    const unpadded = shuffled.map(revision => `run-1#${revision}`).sort()
    expect(unpadded.map(key => Number(key.slice('run-1#'.length)))).not.toEqual(revisions)
  })

  it('refuses a revision that would overflow the key width instead of misordering', () => {
    const overflow = 10 ** REVISION_KEY_WIDTH
    expect(String(overflow).length).toBeGreaterThan(REVISION_KEY_WIDTH)
    expectCode(() => eventKey('run-1', overflow), 'AP_STORE_KEY')
    expectCode(() => eventKey('run-1', 0), 'AP_STORE_KEY')
  })

  it('rejects a malformed key rather than guessing at it', () => {
    expectCode(() => parseEventKey('run-1'), 'AP_STORE_CORRUPT')
    expectCode(() => parseEventKey('run-1#7'), 'AP_STORE_CORRUPT')
    expectCode(() => parseEventKey('#000000000001'), 'AP_STORE_CORRUPT')
    expectCode(() => parseEventKey('run-1#00000000000x'), 'AP_STORE_CORRUPT')
  })
})

describe('DomainRunStore', () => {
  it('records its own backend kind', async () => {
    const store = await DomainRunStore.open(new FakeFacility(), AUTOPILOT_DOMAIN_SPEC, { root: tempRoot() })
    expect(store.kind).toBe('domain')
  })

  it('round-trips a full run through commit and load', async () => {
    const facility = new FakeFacility()
    const store = await DomainRunStore.open(facility, AUTOPILOT_DOMAIN_SPEC, { root: tempRoot() })
    const steps = legalSequence('run-alpha')
    // Cardinality floor: the sequence has to cross the single-digit key
    // boundary for the round-trip to exercise the padding at all.
    expect(steps.length).toBeGreaterThanOrEqual(12)

    for (const [op, snapshot] of steps) {
      const event = await store.commit('run-alpha', op, snapshot, { op })
      expect(event.revision).toBe(snapshot.revision)
    }

    const loaded = store.load('run-alpha')
    expect(loaded?.revision).toBe(steps.length)
    expect(loaded?.phase).toBe('completed')
    expect(loaded?.planGate).toBe('pass')
    expect(loaded?.executionGate).toBe('pass')
    expect(loaded?.audits.map(audit => audit.role)).toEqual(['plan', 'execution'])
    expect(loaded?.closeout?.summary).toBe(CLOSEOUT.summary)

    const events = facility.domain?.tables.get(EVENTS_TABLE)
    expect(events?.records.size).toBe(steps.length)
  })

  it('writes the canonical event before the runs projection', async () => {
    const facility = new FakeFacility()
    const store = await DomainRunStore.open(facility, AUTOPILOT_DOMAIN_SPEC, { root: tempRoot() })
    const snapshot = baseSnapshot('run-order')
    WRITE_LOG.length = 0
    await store.commit('run-order', 'init', snapshot)

    const events = facility.domain?.tables.get(EVENTS_TABLE)
    const runs = facility.domain?.tables.get(RUNS_TABLE)
    expect(events?.records.has(eventKey('run-order', 1))).toBe(true)
    expect(runs?.records.get('run-order')).toEqual(snapshot)
    // THE ORDER ITSELF, which the two assertions above cannot see: an ordered
    // write log across both tables. A projection written first would be a
    // snapshot no canonical event yet justifies.
    expect(WRITE_LOG).toEqual([
      [EVENTS_TABLE, eventKey('run-order', 1)],
      [RUNS_TABLE, 'run-order'],
    ])
  })

  it('keeps that order for EVERY event in a run, not only the first', async () => {
    const facility = new FakeFacility()
    const store = await DomainRunStore.open(facility, AUTOPILOT_DOMAIN_SPEC, { root: tempRoot() })
    const steps = legalSequence('run-order-all')
    WRITE_LOG.length = 0
    for (const [op, snapshot] of steps) await store.commit('run-order-all', op, snapshot)
    expect(WRITE_LOG.length).toBe(steps.length * 2)
    for (let i = 0; i < steps.length; i++) {
      expect(WRITE_LOG[i * 2]?.[0]).toBe(EVENTS_TABLE)
      expect(WRITE_LOG[i * 2 + 1]?.[0]).toBe(RUNS_TABLE)
    }
  })

  it('folds in revision order even when the medium hands the keys back out of order', async () => {
    const steps = legalSequence('run-rev')
    expect(steps.length).toBeGreaterThanOrEqual(12)
    const seeded: Record<string, unknown> = {}
    for (const [op, snapshot] of [...steps].reverse()) {
      seeded[eventKey('run-rev', snapshot.revision)] = storedEvent('run-rev', op, snapshot)
    }
    const facility = new FakeFacility({ [EVENTS_TABLE]: seeded })
    const store = await DomainRunStore.open(facility, AUTOPILOT_DOMAIN_SPEC, { root: tempRoot() })

    // In-place proof that the fixture is genuinely out of order: the medium's
    // own key order is descending, so a load that trusted iteration order
    // would hand the fold a stream starting at the last revision.
    const rawOrder = [...(facility.domain?.tables.get(EVENTS_TABLE)?.keys() ?? [])]
    expect(rawOrder).not.toEqual([...rawOrder].sort())
    expect(store.load('run-rev')?.revision).toBe(steps.length)
    expect(store.load('run-rev')?.phase).toBe('completed')
  })

  it('returns undefined for a run with no stream', async () => {
    const store = await DomainRunStore.open(new FakeFacility(), AUTOPILOT_DOMAIN_SPEC, { root: tempRoot() })
    expect(store.load('never-initialized')).toBeUndefined()
  })

  it('ignores well-formed keys belonging to other runs', async () => {
    const store = await DomainRunStore.open(new FakeFacility(), AUTOPILOT_DOMAIN_SPEC, { root: tempRoot() })
    await store.commit('run-a', 'init', baseSnapshot('run-a'))
    await store.commit('run-b', 'init', baseSnapshot('run-b'))
    await store.commit('run-b', 'log', baseSnapshot('run-b', { revision: 2, logCount: 1 }))

    expect(store.load('run-a')?.revision).toBe(1)
    expect(store.load('run-a')?.runId).toBe('run-a')
    expect(store.load('run-b')?.revision).toBe(2)
  })

  it('raises loudly on a key outside the scheme instead of skipping it', async () => {
    const facility = new FakeFacility({
      [EVENTS_TABLE]: {
        [eventKey('run-a', 1)]: storedEvent('run-a', 'init', baseSnapshot('run-a')),
        'run-a#7': { v: 1, op: 'log', revision: 7, snapshot: baseSnapshot('run-a') },
      },
    })
    const store = await DomainRunStore.open(facility, AUTOPILOT_DOMAIN_SPEC, { root: tempRoot() })
    expectCode(() => store.load('run-a'), 'AP_STORE_CORRUPT')
  })

  it('raises loudly on a record that is not a RunEvent', async () => {
    const facility = new FakeFacility({
      [EVENTS_TABLE]: {
        [eventKey('run-a', 1)]: { v: 2, op: 'init', revision: 1, snapshot: baseSnapshot('run-a') },
      },
    })
    const store = await DomainRunStore.open(facility, AUTOPILOT_DOMAIN_SPEC, { root: tempRoot() })
    expectCode(() => store.load('run-a'), 'AP_STORE_CORRUPT')
  })

  it('raises when a record contradicts the revision in its own key', async () => {
    const facility = new FakeFacility({
      [EVENTS_TABLE]: {
        [eventKey('run-a', 1)]: storedEvent('run-a', 'init', baseSnapshot('run-a', { revision: 3 })),
      },
    })
    const store = await DomainRunStore.open(facility, AUTOPILOT_DOMAIN_SPEC, { root: tempRoot() })
    expectCode(() => store.load('run-a'), 'AP_STORE_CORRUPT')
  })

  it('rejects an illegal stream on load exactly as the file backend does', async () => {
    // Checker-Resolution: the domain path keeps the fold as its invariant
    // guardian, so a revision gap is refused BY VALUE (AP_REVISION), not
    // folded into a plausible-looking state.
    const gapped = new FakeFacility({
      [EVENTS_TABLE]: {
        [eventKey('run-gap', 1)]: storedEvent('run-gap', 'init', baseSnapshot('run-gap')),
        [eventKey('run-gap', 3)]: storedEvent('run-gap', 'log', baseSnapshot('run-gap', { revision: 3, logCount: 1 })),
      },
    })
    const gapStore = await DomainRunStore.open(gapped, AUTOPILOT_DOMAIN_SPEC, { root: tempRoot() })
    expectCode(() => gapStore.load('run-gap'), 'AP_REVISION')

    // A stream whose first event is not `init` is a different failure, and the
    // checker distinguishes them rather than collapsing both to "invalid".
    const headless = new FakeFacility({
      [EVENTS_TABLE]: {
        [eventKey('run-head', 1)]: storedEvent('run-head', 'log', baseSnapshot('run-head', { logCount: 1 })),
      },
    })
    const headStore = await DomainRunStore.open(headless, AUTOPILOT_DOMAIN_SPEC, { root: tempRoot() })
    expectCode(() => headStore.load('run-head'), 'AP_FIRST_NOT_INIT')

    // Positive control on the same checker: the legal prefix of the same run
    // loads, so the rejections above are not a checker that fails everything.
    const legal = new FakeFacility({
      [EVENTS_TABLE]: {
        [eventKey('run-ok', 1)]: storedEvent('run-ok', 'init', baseSnapshot('run-ok')),
        [eventKey('run-ok', 2)]: storedEvent('run-ok', 'log', baseSnapshot('run-ok', { revision: 2, logCount: 1 })),
      },
    })
    const okStore = await DomainRunStore.open(legal, AUTOPILOT_DOMAIN_SPEC, { root: tempRoot() })
    expect(okStore.load('run-ok')?.revision).toBe(2)
  })

  it('keeps log.md on the filesystem under a stable run directory', async () => {
    const root = tempRoot()
    const store = await DomainRunStore.open(new FakeFacility(), AUTOPILOT_DOMAIN_SPEC, { root })
    expect(store.runDir('run/with:unsafe')).toBe(join(root, 'runs', 'run_with_unsafe'))

    await store.appendLog('run-log', { seq: 0, text: 'first checkpoint', stance: 'on-plan' })
    await store.appendLog('run-log', {
      seq: 1,
      text: 'blocked',
      stance: 'escalate',
      note: 'needs owner',
      escalationTarget: 'owner',
      blockingScope: 'run',
    })

    const lines = readFileSync(join(store.runDir('run-log'), 'log.md'), 'utf8')
      .split('\n')
      .filter(line => line.length > 0)
    expect(lines.length).toBe(2)
    expect(lines[0]).toContain('[on-plan] first checkpoint')
    expect(lines[1]).toContain('[escalate] blocked note: needs owner -> owner (blocks: run)')
  })

  /**
   * THE CROSS-BACKEND PATH RULE. This module's header promises that both
   * backends resolve one run id to the SAME directory, because
   * `UsageArtifact.ref` containment, the outbound manifest lookup and
   * `log.md` all resolve against it — a deployment that switches profiles must
   * not orphan its artifacts. That promise used to rest on two identical
   * private copies of `sanitize` and NOTHING compared them: adding
   * `.toLowerCase()` to the domain copy left the whole suite green, and the one
   * existing assertion (`'run/with:unsafe'`) is all-lowercase so it could not
   * see the divergence.
   *
   * The copy is now gone — both backends call the shared `runDirFor` — so the
   * equality half of this test can no longer fail on its own. The half that
   * CAN fail is the value: the table is deliberately mixed-case, so re-forking
   * a local rule (or lowercasing the shared one) turns this red rather than
   * silently splitting the two backends' artifact roots.
   */
  it('resolves the SAME run directory as the file backend, case included', async () => {
    const root = tempRoot()
    const domainStore = await DomainRunStore.open(new FakeFacility(), AUTOPILOT_DOMAIN_SPEC, { root })
    const fileStore = new RunStore(root)

    const cases: Array<readonly [string, string]> = [
      ['run-a', 'run-a'],
      ['Run-A', 'Run-A'],
      ['S3sSiOn#4F2a', 'S3sSiOn_4F2a'],
      ['run/with:unsafe', 'run_with_unsafe'],
      ['../escape', '.._escape'],
      ['a//b', 'a__b'],
      ['ID.With_Mixed-Case', 'ID.With_Mixed-Case'],
    ]
    // Cardinality floor plus the property that makes the table adversarial: at
    // least one pair differing ONLY in case must be present, or a lowercasing
    // divergence would pass unobserved.
    expect(cases.length).toBeGreaterThanOrEqual(6)
    expect(cases.some(([id]) => id !== id.toLowerCase())).toBe(true)

    for (const [id, expected] of cases) {
      const wanted = join(root, 'runs', expected)
      expect(domainStore.runDir(id)).toBe(wanted)
      expect(fileStore.runDir(id)).toBe(wanted)
      expect(domainStore.runDir(id)).toBe(fileStore.runDir(id))
      expect(domainStore.runDir(id)).toBe(runDirFor(root, id))
    }

    // In-place proof the table is not vacuous: two ids differing only in case
    // must land in DIFFERENT directories under BOTH backends.
    expect(domainStore.runDir('Run-A')).not.toBe(domainStore.runDir('run-a'))
    expect(fileStore.runDir('Run-A')).not.toBe(fileStore.runDir('run-a'))
  })

  it('releases the domain handle on close', async () => {
    const facility = new FakeFacility()
    const store = await DomainRunStore.open(facility, AUTOPILOT_DOMAIN_SPEC, { root: tempRoot() })
    expect(facility.domain?.closed).toBe(false)
    await store.close()
    expect(facility.domain?.closed).toBe(true)
  })
})
