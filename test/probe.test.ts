/**
 * The deployment probes the 0.3.0 plugin still keeps, each a bearer for a claim it
 * makes: the storage-domain facility (legacy history and ledger migration), the sandbox policy's
 * default mode (what the lazy clamp restore may write), and the store resolution.
 * Every probe has a fixture where it says yes and one where it says no.
 *
 * Retired with the run machine: the sandbox-confine and approval-answerer probes
 * (they fed the `Enforcement` record) and the egress-channel resolver.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { probeStorageDomain, resolveStore, sandboxDefaultModeOf } from '../src/index.js'
import { FileLedgerStore, emptyLedger } from '../src/store/ledger.js'
import { listLegacyRuns } from '../src/legacy/index.js'
import { AUTOPILOT_DOMAIN_SPEC } from '../src/store/domain.js'

describe('sandboxDefaultModeOf', () => {
  it('reads the default mode of the sandbox policy service through ctx.get', () => {
    expect(sandboxDefaultModeOf({ get: (name: string) => (name === 'sandboxPolicy' ? { defaultMode: 'workspace-write' } : undefined) }))
      .toBe('workspace-write')
  })

  it('falls back to property access when ctx.get is absent', () => {
    expect(sandboxDefaultModeOf({ sandboxPolicy: { defaultMode: 'read-only' } })).toBe('read-only')
  })

  it('undefined when the service is missing, or the field is not a string', () => {
    expect(sandboxDefaultModeOf({})).toBeUndefined()
    expect(sandboxDefaultModeOf({ sandboxPolicy: {} })).toBeUndefined()
    expect(sandboxDefaultModeOf({ sandboxPolicy: { defaultMode: 3 } })).toBeUndefined()
  })

  it('a fully hostile ctx reads as undefined instead of throwing', () => {
    expect(sandboxDefaultModeOf(new Proxy({}, { get: () => { throw new Error('boom') } }))).toBeUndefined()
  })
})

describe('probeStorageDomain', () => {
  it('returns the facility when it exposes open()', () => {
    const facility = { open: async () => ({}) }
    expect(probeStorageDomain({ get: (name: string) => (name === 'storageDomain' ? facility : undefined) }))
      .toBe(facility)
  })

  it('undefined when the deployment mounts no storageDomain (the headless profile)', () => {
    expect(probeStorageDomain({ get: () => undefined })).toBeUndefined()
    expect(probeStorageDomain({})).toBeUndefined()
  })

  it('undefined for a truthy service that cannot open: presence is not capability', () => {
    expect(probeStorageDomain({ storageDomain: {} })).toBeUndefined()
    expect(probeStorageDomain({ storageDomain: { open: 'not a function' } })).toBeUndefined()
    expect(probeStorageDomain({ storageDomain: 'yes' })).toBeUndefined()
  })

  it('undefined on a hostile context', () => {
    expect(probeStorageDomain(new Proxy({}, { get: () => { throw new Error('boom') } }))).toBeUndefined()
  })
})

describe('resolveStore', () => {
  /** A minimal in-memory stand-in for the storage-domain facility; counts opens like the real one refuses a second. */
  function fakeFacility(seed: Record<string, Array<[string, unknown]>> = {}) {
    const tables = new Map<string, Map<string, unknown>>(Object.entries(seed).map(([name, rows]) => [name, new Map(rows)]))
    const state = { opens: 0, closes: 0 }
    return {
      state,
      open: async () => {
        state.opens += 1
        if (state.opens > 1) throw new Error('domain "dsh_autopilot" is already open')
        return {
          table: (name: string) => {
            const store = tables.get(name) ?? new Map<string, unknown>()
            tables.set(name, store)
            return {
              get: (key: string) => store.get(key),
              entries: () => store.entries(),
              keys: () => store.keys(),
              put: async (key: string, value: unknown) => { store.set(key, value) },
            }
          },
          close: async () => { state.closes += 1 },
        }
      },
    }
  }

  const freshRoot = (): string => mkdtempSync(join(tmpdir(), 'dsh-autopilot-store-'))

  // Changed with the cross-process fix: the domain's JSON backend republishes one whole file per put,
  // so two processes writing ledger rows there lost rows. The ledger now always goes to its own file.
  it('with a facility the ledger still goes to files under the root, and nothing degraded', async () => {
    const resolution = await resolveStore({ storageDomain: fakeFacility() }, freshRoot())
    expect(resolution.ledgers).toBeInstanceOf(FileLedgerStore)
    expect(resolution.ledgers.kind).toBe('file')
    expect(resolution.degraded).toBeUndefined()
  })

  /**
   * A facility over a REAL single-file JSON medium, the shape of the host's `single`
   * layout (`dsh-storage-json` `SingleJsonUnit`): the whole domain is one document,
   * read at open and republished whole on every put. So any put, of any table,
   * rewrites the bytes of the file that also holds the legacy v1 runs.
   */
  function fileFacility(path: string) {
    return {
      open: async () => {
        const doc = JSON.parse(readFileSync(path, 'utf8')) as { version: number; tables: Record<string, Record<string, unknown>> }
        return {
          table: (name: string) => {
            const rows = (doc.tables[name] ??= {})
            return {
              get: (key: string) => rows[key],
              entries: () => Object.entries(rows)[Symbol.iterator](),
              keys: () => Object.keys(rows)[Symbol.iterator](),
              put: async (key: string, value: unknown) => {
                rows[key] = value
                writeFileSync(path, JSON.stringify(doc))
              },
            }
          },
          close: async () => {},
        }
      },
    }
  }

  it('the domain file (legacy runs and an earlier ledger row) stays byte-equal through migration, writes, legacy reads and close', async () => {
    const root = freshRoot()
    const storages = freshRoot()
    const domainFile = join(storages, 'dsh_autopilot.json')
    const legacyEvent = (runId: string) => ({ v: 1, op: 'init', revision: 1, time: '2026-03-01T09:01:00.000Z', snapshot: {
      runId, revision: 1, plan: { revision: 0, text: '' }, phase: 'planning', planGate: 'pending', executionGate: 'pending',
      audits: [], residualRisks: [], logCount: 0, consecutiveReplans: 0, enforcement: { sandbox: 'off', reminders: 0, ownerApprovals: [] },
      triage: { objective: 'o', scope: [], nonGoals: [], acceptanceCriteria: ['a'], risk: 'low', size: 'lightweight', executionMode: 'inline', auditMode: 'self-check', touchesOperatingLayer: false, baseline: {} },
    } })
    const earlier = { ...emptyLedger('old-session', '2026-11-01T00:00:00.000Z'), revision: 3 }
    writeFileSync(domainFile, JSON.stringify({ version: 1, tables: {
      events: { 'run-1#000000000001': legacyEvent('run-1'), 'run-2#000000000001': legacyEvent('run-2') },
      runs: { 'run-1': { runId: 'run-1' }, 'run-2': { runId: 'run-2' } },
      ledgers: { 'old-session': earlier },
    } }))
    const before = readFileSync(domainFile)

    const resolution = await resolveStore({ storageDomain: fileFacility(domainFile) }, root)
    expect(resolution.ledgers.load('old-session')).toEqual(earlier) // migrated to its file
    expect(existsSync(join(root, 'ledgers', 'old-session.json'))).toBe(true)
    await resolution.ledgers.write(earlier, 3)
    await resolution.ledgers.write(emptyLedger('new-session', '2026-11-04T00:00:00.000Z'), 0)
    expect((await listLegacyRuns(resolution.sources)).map(run => run.runId).sort()).toEqual(['run-1', 'run-2'])
    await resolution.close()

    expect(readFileSync(domainFile).equals(before)).toBe(true)
    expect(resolution.ledgers.list().map(l => [l.sessionId, l.revision]).sort()).toEqual([['new-session', 1], ['old-session', 4]])
  })

  it('without a facility the ledger goes to files under the root, and says why', async () => {
    const resolution = await resolveStore({}, freshRoot())
    expect(resolution.ledgers).toBeInstanceOf(FileLedgerStore)
    expect(resolution.ledgers.kind).toBe('file')
    expect(resolution.degraded).toMatch(/storageDomain is not observable/)
  })

  it('a facility whose open() rejects falls back to files, and the two reasons are distinguishable', async () => {
    const none = await resolveStore({}, freshRoot())
    const broken = await resolveStore({ storageDomain: { open: async () => { throw new Error('backend unavailable') } } }, freshRoot())
    expect(broken.ledgers.kind).toBe('file')
    expect(broken.degraded).toContain('backend unavailable')
    expect(broken.degraded).not.toBe(none.degraded)
    const odd = await resolveStore({ storageDomain: { open: async () => { throw 'domain name already open' } } }, freshRoot())
    expect(odd.degraded).toContain('domain name already open')
  })

  it('the domain is opened ONCE and closed once: the ledger store and the legacy reader share the handle', async () => {
    const facility = fakeFacility()
    const resolution = await resolveStore({ storageDomain: facility }, freshRoot())
    expect(facility.state.opens).toBe(1)
    await listLegacyRuns(resolution.sources)
    await resolution.ledgers.write(emptyLedger('s-1', '2026-11-04T00:00:00.000Z'), 0)
    expect(facility.state.opens).toBe(1)
    await resolution.close()
    await resolution.close()
    expect(facility.state.closes).toBe(1)
  })

  it('legacy sources always include BOTH the file root and the domain, whichever backend holds the ledger', async () => {
    const root = freshRoot()
    // A 0.2.x run in the file tree, and a different one in the domain events table.
    mkdirSync(join(root, 'runs', 'file-run'), { recursive: true })
    const event = (runId: string) => ({ v: 1, op: 'init', revision: 1, time: '2026-03-01T09:01:00.000Z', snapshot: {
      runId, revision: 1, plan: { revision: 0, text: '' }, phase: 'planning', planGate: 'pending', executionGate: 'pending',
      audits: [], residualRisks: [], logCount: 0, consecutiveReplans: 0, enforcement: { sandbox: 'off', reminders: 0, ownerApprovals: [] },
      triage: { objective: 'o', scope: [], nonGoals: [], acceptanceCriteria: ['a'], risk: 'low', size: 'lightweight', executionMode: 'inline', auditMode: 'self-check', touchesOperatingLayer: false, baseline: {} },
    } })
    writeFileSync(join(root, 'runs', 'file-run', 'events.jsonl'), `${JSON.stringify(event('file-run'))}\n`)
    const facility = fakeFacility({ events: [['domain-run#000000000001', event('domain-run')]] })

    const withDomain = await resolveStore({ storageDomain: facility }, root)
    expect(withDomain.ledgers.kind).toBe('file')
    expect((await listLegacyRuns(withDomain.sources)).map(run => [run.runId, run.backend])).toEqual([['domain-run', 'domain'], ['file-run', 'file']])

    const filesOnly = await resolveStore({}, root)
    expect(filesOnly.ledgers.kind).toBe('file')
    expect((await listLegacyRuns(filesOnly.sources)).map(run => run.runId)).toEqual(['file-run'])
  })

  it('the spec the domain is opened with declares the events table, or the legacy rows would never materialize', async () => {
    expect(Object.keys(AUTOPILOT_DOMAIN_SPEC.tables)).toContain('events')
  })
})
