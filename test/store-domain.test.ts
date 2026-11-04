/**
 * The domain declaration and the legacy-reader adapter: `src/store/domain.ts`.
 *
 * 0.3.0 removed `DomainRunStore` (its commit / load / log.md paths); the
 * `events` and `runs` tables are now read only by `src/legacy`. What remains
 * here is the spec (medium-safe names, permissive record shape, the additive
 * `ledgers` table) and the adapter that hands the `events` table to the reader. The ledger
 * store over this domain is tested in `test/ledger-store.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import {
  AUTOPILOT_DOMAIN_SPEC,
  EVENTS_TABLE,
  LEDGERS_TABLE,
  RUNS_TABLE,
  legacyDomainReaderOf,
} from '../src/store/domain.js'
import type { DomainLike, KvTableLike } from '../src/store/domain.js'
import { AutopilotError } from '../src/domain/types.js'

/**
 * Upstream's name rule, transcribed from
 * `packages/storage/storage/src/backend.ts:10` (dsh 0.1.1-rc.2).
 */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

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
    expect(Object.keys(AUTOPILOT_DOMAIN_SPEC.tables).sort()).toEqual([EVENTS_TABLE, LEDGERS_TABLE, RUNS_TABLE].sort())
  })

  it('keeps the 0.2.x tables and the domain version, so an existing medium still opens', () => {
    expect(AUTOPILOT_DOMAIN_SPEC.name).toBe('dsh_autopilot')
    expect(AUTOPILOT_DOMAIN_SPEC.version).toBe(1)
    expect(LEDGERS_TABLE).toBe('ledgers')
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

describe('legacyDomainReaderOf: the adapter from an open domain to the frozen reader', () => {
  const table = (rows: Array<[string, unknown]>): KvTableLike => ({
    get: (key) => rows.find(([k]) => k === key)?.[1],
    entries: () => rows[Symbol.iterator]() as IterableIterator<[string, unknown]>,
    keys: () => rows.map(([k]) => k)[Symbol.iterator](),
    put: async () => {},
  })

  it('lists every record of the named table as { key, value }, and nothing of another table', async () => {
    const domain: DomainLike = {
      table: (name) => table(name === EVENTS_TABLE ? [['run-1#000000000001', { op: 'init' }], ['run-1#000000000002', { op: 'log' }]] : [['x', 1]]),
      close: async () => {},
    }
    const reader = legacyDomainReaderOf(domain)
    expect(await reader.list(EVENTS_TABLE)).toEqual([
      { key: 'run-1#000000000001', value: { op: 'init' } },
      { key: 'run-1#000000000002', value: { op: 'log' } },
    ])
  })

  it('reads a table the domain does not declare as empty instead of throwing', async () => {
    const domain: DomainLike = { table: () => { throw new Error('no such table') }, close: async () => {} }
    expect(await legacyDomainReaderOf(domain).list('nope')).toEqual([])
  })
})
