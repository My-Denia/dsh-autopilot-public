/**
 * The model-facing tool surface in 0.3.0: one read-only tool. The tool-output
 * contract against the real validator lives in `test/boundary.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import { createAutopilotService } from '../src/service.js'
import { installRootTools, statusBody } from '../src/tools.js'
import type { ToolRegistryRef } from '../src/tools.js'
import { FileLedgerStore, legacySourcesOf } from '../src/store/ledger.js'
import { makeHarness, writeLegacyFixture } from './helpers.js'

interface ToolDef {
  name: string
  parameters: unknown
  execute(args: unknown, exec: unknown): Promise<unknown>
}

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
