/**
 * The native egress seam.
 *
 * `decideEgress` is a THREE-valued outcome (allow / deny / ask) and is asserted
 * by value everywhere below, never as "did it block". The listener-level tests
 * additionally prove the two waterfalls do different jobs: pre-execute decides,
 * `tools/execute` consumes — and consumption happens only on a call that
 * actually dispatched.
 */

import { describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import { OUTBOUND_STALE_MS } from '../src/domain/types.js'
import type { OutboundManifest } from '../src/domain/types.js'
import { MAX_PENDING_EGRESS_AUTHORIZATIONS, decideEgress, installPreExecuteGate } from '../src/gate/preexecute.js'
import type { PreDecision, PreExecuteHost, PreExecuteOptions, PreExecution } from '../src/gate/preexecute.js'
import { makeHarness, makeTriage } from './helpers.js'

const NOW = Date.parse('2026-08-24T12:00:00.000Z')

function manifestFor(runId: string, overrides: Partial<OutboundManifest> = {}): OutboundManifest {
  return {
    v: 1,
    runId,
    target: 'github.com/example/repo main',
    commands: ['git push'],
    claims: [{ text: 'the suite is green', bearer: 'outbound/test-run.txt' }],
    artifacts: [{ ref: 'outbound/test-run.txt', covers: ['the suite is green'] }],
    createdAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  }
}

/**
 * Injection set: manifest text and one artifact, both in memory. The artifact
 * body carries the label the manifest says it covers, because `validateManifest`
 * settles `covers` against the artifact's own text.
 */
function options(raw: string | undefined, artifacts: Record<string, string> = {
  'outbound/test-run.txt': 'the suite is green: Test Files 1 passed\n',
}): PreExecuteOptions {
  return {
    readManifest: () => raw,
    readArtifact: (absPath: string) => {
      const hit = Object.entries(artifacts).find(([ref]) => absPath.replace(/\\/g, '/').endsWith(ref))
      if (hit === undefined) return undefined
      return { size: Buffer.byteLength(hit[1], 'utf8'), text: hit[1] }
    },
    now: () => NOW,
    env: {},
  }
}

/** A run parked in `executing` with the plan gate passed. */
async function runningHarness() {
  const h = makeHarness()
  await h.engine.init(h.root, makeTriage())
  await h.engine.submitPlan(h.root, 'plan')
  await h.engine.selfCheck(h.root, { role: 'plan', verdict: 'pass', note: 'ok' })
  return h
}

describe('decideEgress', () => {
  it('allows when no run is bound (fail-open parity with the guard)', async () => {
    const h = makeHarness()
    const { decision } = decideEgress(h.engine, 'no-such-run', 'git push', options(undefined))
    expect(decision.kind).toBe('allow')
  })

  it('denies when the manifest file is absent, and names the path it wanted', async () => {
    const h = await runningHarness()
    const { decision } = decideEgress(h.engine, h.root.id, 'git push origin main', options(undefined))
    expect(decision.kind).toBe('deny')
    if (decision.kind !== 'deny') throw new Error('unreachable')
    expect(decision.reason).toContain('no readable outbound evidence manifest')
    expect(decision.reason).toContain('manifest.json')
  })

  it('denies unparseable manifest text', async () => {
    const h = await runningHarness()
    const { decision } = decideEgress(h.engine, h.root.id, 'git push origin main', options('{ not json'))
    expect(decision.kind).toBe('deny')
    if (decision.kind !== 'deny') throw new Error('unreachable')
    expect(decision.reason).toContain('is invalid')
  })

  it('denies a manifest that belongs to a DIFFERENT run', async () => {
    const h = await runningHarness()
    const foreign = JSON.stringify(manifestFor('some-other-run'))
    const { decision } = decideEgress(h.engine, h.root.id, 'git push origin main', options(foreign))
    expect(decision.kind).toBe('deny')
    if (decision.kind !== 'deny') throw new Error('unreachable')
    expect(decision.reason).toContain('does not authorize this egress')
  })

  it('denies a manifest that does not cover the command being run', async () => {
    const h = await runningHarness()
    const raw = JSON.stringify(manifestFor(h.root.id, { commands: ['npm publish'] }))
    const { decision } = decideEgress(h.engine, h.root.id, 'git push origin main', options(raw))
    expect(decision.kind).toBe('deny')
  })

  it('denies a stale manifest', async () => {
    const h = await runningHarness()
    const raw = JSON.stringify(manifestFor(h.root.id, {
      createdAt: new Date(NOW - OUTBOUND_STALE_MS - 1).toISOString(),
    }))
    const { decision } = decideEgress(h.engine, h.root.id, 'git push origin main', options(raw))
    expect(decision.kind).toBe('deny')
  })

  it('denies when the bearing artifact is missing from disk', async () => {
    const h = await runningHarness()
    const raw = JSON.stringify(manifestFor(h.root.id))
    const { decision } = decideEgress(h.engine, h.root.id, 'git push origin main', options(raw, {}))
    expect(decision.kind).toBe('deny')
  })

  it('ASKS on a valid manifest, and hands back the manifest for archiving', async () => {
    const h = await runningHarness()
    const raw = JSON.stringify(manifestFor(h.root.id))
    const { decision, manifest } = decideEgress(h.engine, h.root.id, 'git push origin main', options(raw))
    // Three-valued: this is neither the allow of the no-run case nor any deny.
    expect(decision.kind).toBe('ask')
    if (decision.kind !== 'ask') throw new Error('unreachable')
    expect(decision.reason).toContain('github.com/example/repo main')
    expect(decision.reason).toContain('1 claim')
    expect(manifest?.runId).toBe(h.root.id)
  })

  it('allows unconditionally once the run is terminal', async () => {
    const h = await runningHarness()
    await h.engine.setBlocked(h.root, 'stopped')
    const { decision } = decideEgress(h.engine, h.root.id, 'git push origin main', options(undefined))
    expect(decision.kind).toBe('allow')
  })
})

/**
 * THE 2026-08-25 REAL-HOST DEFECT, at the seam.
 *
 * The gate held on nine sessions and denied every unbacked egress — while
 * telling the agent to write `<runDir>/outbound/manifest.json`, a path under
 * `$DSH_HOME` that the fs/shell sandbox (workspace-write root = the session
 * cwd, plus the platform temp dirs) does not let it create. The probe reached
 * the valid-manifest leg only by repointing `storeRoot` into the workspace by
 * hand. These tests pin the two halves of the repair: a SECOND candidate the
 * agent can actually write, and a denial that says where it looked, which of
 * those it can write, and what to put in the file.
 */
describe('decideEgress — where the manifest may be written', () => {
  const WORKSPACE = resolve('/srv/workspace-fixture')
  const WORKSPACE_MANIFEST = join(WORKSPACE, '.dsh-autopilot', 'outbound', 'manifest.json')

  /** Path-AWARE manifest reader: which candidate answered is the whole question here. */
  function at(files: Record<string, string>, env: NodeJS.ProcessEnv = {}): PreExecuteOptions {
    return {
      ...options(undefined),
      env,
      workspaceRoot: WORKSPACE,
      readManifest: (path: string) => files[path],
    }
  }

  it('reads the WORKSPACE candidate when the run directory holds none', async () => {
    const h = await runningHarness()
    const { decision, manifest } = decideEgress(
      h.engine,
      h.root.id,
      'git push origin main',
      at({ [WORKSPACE_MANIFEST]: JSON.stringify(manifestFor(h.root.id)) }),
    )
    // The leg the real host could only reach by patching storeRoot.
    expect(decision.kind).toBe('ask')
    expect(manifest?.runId).toBe(h.root.id)
  })

  it('FIRST EXISTING wins: an invalid run-dir manifest does not fall through to a valid workspace one', async () => {
    const h = await runningHarness()
    const runManifest = join(h.engine.runDirOf(h.root.id), 'outbound', 'manifest.json')
    const { decision } = decideEgress(h.engine, h.root.id, 'git push origin main', at({
      [runManifest]: JSON.stringify(manifestFor(h.root.id, { commands: ['npm publish'] })),
      [WORKSPACE_MANIFEST]: JSON.stringify(manifestFor(h.root.id)),
    }))
    // Otherwise an agent-writable location would silently override the
    // owner-placed one that failed.
    expect(decision.kind).toBe('deny')
    if (decision.kind !== 'deny') throw new Error('unreachable')
    expect(decision.reason).toContain(runManifest)
    expect(decision.reason).toContain('matches no declared command substring')
  })

  it('an owner pin stays EXCLUSIVE at the seam: the workspace copy is not consulted', async () => {
    const h = await runningHarness()
    const files = { [WORKSPACE_MANIFEST]: JSON.stringify(manifestFor(h.root.id)) }
    const pinned = decideEgress(h.engine, h.root.id, 'git push origin main', at(files, {
      DSH_AUTOPILOT_OUTBOUND_MANIFEST: resolve('/owner/pinned.json'),
    }))
    expect(pinned.decision.kind).toBe('deny')
    // DETECTOR: the very same file IS consulted once the pin is gone.
    expect(decideEgress(h.engine, h.root.id, 'git push origin main', at(files)).decision.kind).toBe('ask')
  })

  it('the denial names EVERY place it looked and carries a fill-in skeleton', async () => {
    const h = await runningHarness()
    const { decision } = decideEgress(h.engine, h.root.id, 'git push origin main', at({}))
    expect(decision.kind).toBe('deny')
    if (decision.kind !== 'deny') throw new Error('unreachable')
    expect(decision.reason).toContain('no readable outbound evidence manifest')
    expect(decision.reason).toContain(join(h.engine.runDirOf(h.root.id), 'outbound', 'manifest.json'))
    expect(decision.reason).toContain(WORKSPACE_MANIFEST)
    // Actionable, not a list of field names: the skeleton is stamped with the
    // live run and a command class read off the command that was refused.
    expect(decision.reason).toContain(`"runId":"${h.root.id}"`)
    expect(decision.reason).toContain('"commands":["git push"]')
  })
})

/** A host that captures the two listeners so a test can drive them directly. */
/**
 * A host that keys its listener map by EXACT event name and THROWS on an
 * unexpected one.
 *
 * It used to route every non-'tools/pre-execute' name to `host.exec`, so
 * renaming the dispatch listener to 'tools/executeXX' left the suite green —
 * the seam would have registered a listener the runtime never dispatches to,
 * silently un-archiving every egress. A cordis event bus accepts any name and
 * returns a disposer, so the NAME is the whole contract here.
 */
function fakeHost(disposerThrows?: readonly string[]): PreExecuteHost & {
  pre?: (exec: PreExecution, next: () => Promise<PreDecision>) => Promise<PreDecision>
  exec?: (exec: PreExecution, next: () => Promise<unknown>) => Promise<unknown>
  events: string[]
  disposed: number
  releases: string[]
  disposerThrows?: readonly string[]
} {
  const host = {
    disposed: 0,
    events: [] as string[],
    releases: [] as string[],
    ...(disposerThrows === undefined ? {} : { disposerThrows }),
    pre: undefined as never,
    exec: undefined as never,
    on(event: string, listener: unknown) {
      host.events.push(event)
      if (event === 'tools/pre-execute') host.pre = listener as never
      else if (event === 'tools/execute') host.exec = listener as never
      else throw new Error(`unexpected event name registered by the seam: ${event}`)
      const name = event
      return () => {
        host.disposed += 1
        host.releases.push(name)
        if (host.disposerThrows?.includes(name) === true) throw new Error(`inject: ${name} disposer failed`)
      }
    },
  }
  return host as never
}

describe('installPreExecuteGate', () => {
  // The seam is ONE entry in installExecutorChildSurface's unwind, so a listener this
  // disposer skips can never be rescued by the caller's per-entry try/catch.
  it('release attempts BOTH listeners and clears the map even when the first disposer throws', async () => {
    const h = await runningHarness()
    const host = fakeHost(['tools/execute'])
    const install = installPreExecuteGate(host, h.root.id, h.engine, options(undefined))
    expect(install.installed).toBe(true)
    let caught: unknown
    try {
      install.dispose()
    } catch (error: unknown) {
      caught = error
    }
    // Reverse order, both attempted, and the failure is reported rather than swallowed.
    expect(host.releases).toEqual(['tools/execute', 'tools/pre-execute'])
    expect(host.disposed).toBe(2)
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as Error).message).toContain('seam release failed')
  })

  it('a second release is a no-op: the disposers are drained, not re-run', async () => {
    const h = await runningHarness()
    const host = fakeHost()
    const install = installPreExecuteGate(host, h.root.id, h.engine, options(undefined))
    install.dispose()
    install.dispose()
    expect(host.disposed).toBe(2)
    expect(host.releases).toEqual(['tools/execute', 'tools/pre-execute'])
  })

  it('reports installed:false (not a throw) when the host refuses the listener', async () => {
    const h = await runningHarness()
    const hostile: PreExecuteHost = {
      on: () => { throw new Error('tools/pre-execute is not an event here') },
    } as never
    const install = installPreExecuteGate(hostile, h.root.id, h.engine)
    // This value is what selects the guard's fail-closed fallback, so it is
    // asserted directly rather than inferred from an absence of errors.
    expect(install.installed).toBe(false)
    expect(install.diagnostic).toContain('tools/pre-execute seam unavailable')
  })

  it('passes non-egress calls straight through to next()', async () => {
    const h = await runningHarness()
    const host = fakeHost()
    installPreExecuteGate(host, h.root.id, h.engine, options(undefined))
    const next = vi.fn(async (): Promise<PreDecision> => ({ kind: 'allow' }))
    const decision = await host.pre?.({ name: 'bash', arguments: { command: 'pnpm test' }, callId: 'c1' }, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(decision?.kind).toBe('allow')
  })

  it('consumes an existing owner-approve and ALLOWS instead of asking (v1 authority preserved)', async () => {
    const h = await runningHarness()
    await h.engine.ownerApprove(h.root, 'git push origin')
    const host = fakeHost()
    installPreExecuteGate(host, h.root.id, h.engine, options(JSON.stringify(manifestFor(h.root.id))))
    const next = vi.fn(async (): Promise<PreDecision> => ({ kind: 'allow' }))

    const first = await host.pre?.({ name: 'bash', arguments: { command: 'git push origin main' }, callId: 'c1' }, next)
    expect(first?.kind).toBe('allow')
    expect(next).not.toHaveBeenCalled()

    // Exactly one egress per approval: the second call falls back to asking.
    const second = await host.pre?.({ name: 'bash', arguments: { command: 'git push origin main' }, callId: 'c2' }, next)
    expect(second?.kind).toBe('ask')
  })

  it('an invalid manifest denies even when an owner approval is open', async () => {
    const h = await runningHarness()
    await h.engine.ownerApprove(h.root, 'git push origin')
    const host = fakeHost()
    installPreExecuteGate(host, h.root.id, h.engine, options('{ not json'))
    const next = vi.fn(async (): Promise<PreDecision> => ({ kind: 'allow' }))
    const decision = await host.pre?.({ name: 'bash', arguments: { command: 'git push origin main' }, callId: 'c1' }, next)
    expect(decision?.kind).toBe('deny')
    // The approval must NOT have been spent by a call that was refused.
    expect(h.engine.peek(h.root.id)?.enforcement.ownerApprovals[0]?.consumedBy).toBeUndefined()
  })

  it('archives and bumps outboundConsumed at DISPATCH, not at the ask', async () => {
    const h = await runningHarness()
    const host = fakeHost()
    const archived: Array<{ command: string }> = []
    installPreExecuteGate(host, h.root.id, h.engine, {
      ...options(JSON.stringify(manifestFor(h.root.id))),
      archive: (_runDir, _manifest, command) => {
        archived.push({ command })
        return 'outbound/consumed/stub.json'
      },
    })
    const call: PreExecution = { name: 'bash', arguments: { command: 'git push origin main' }, callId: 'c1' }

    const decision = await host.pre?.(call, async (): Promise<PreDecision> => ({ kind: 'allow' }))
    expect(decision?.kind).toBe('ask')
    // Asking spends nothing: an egress the human then rejects never happened.
    expect(archived.length).toBe(0)
    expect(h.engine.peek(h.root.id)?.enforcement.outboundConsumed ?? 0).toBe(0)

    const next = vi.fn(async () => 'dispatched')
    const result = await host.exec?.(call, next)
    expect(result).toBe('dispatched')
    expect(next).toHaveBeenCalledTimes(1)
    expect(archived).toEqual([{ command: 'git push origin main' }])
    expect(h.engine.peek(h.root.id)?.enforcement.outboundConsumed).toBe(1)
  })

  it('the dispatch seam ignores non-egress calls entirely', async () => {
    const h = await runningHarness()
    const host = fakeHost()
    installPreExecuteGate(host, h.root.id, h.engine, options(JSON.stringify(manifestFor(h.root.id))))
    const next = vi.fn(async () => 'dispatched')
    await host.exec?.({ name: 'bash', arguments: { command: 'ls' }, callId: 'c9' }, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(h.engine.peek(h.root.id)?.enforcement.outboundConsumed ?? 0).toBe(0)
  })

  it('DISPATCHES an egress untouched when no run is bound (both seams agree on fail-open)', async () => {
    const h = makeHarness()
    const host = fakeHost()
    installPreExecuteGate(host, 'no-such-run', h.engine, options(undefined))
    const call: PreExecution = { name: 'bash', arguments: { command: 'git push origin main' }, callId: 'c1' }

    const decision = await host.pre?.(call, async (): Promise<PreDecision> => ({ kind: 'allow' }))
    expect(decision?.kind).toBe('allow')

    // The composition, not each half: pre-execute allowed, so dispatch must
    // follow. A throw here would brick every egress in any session where the
    // plugin is mounted without a run.
    const next = vi.fn(async () => 'dispatched')
    const result = await host.exec?.(call, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(result).toBe('dispatched')
  })

  it('DISPATCHES an egress untouched once the run is terminal', async () => {
    const h = await runningHarness()
    await h.engine.setBlocked(h.root, 'stopped')
    // In-place assertion that the fixture really reached a terminal phase.
    expect(h.engine.peek(h.root.id)?.phase).toBe('blocked')

    const host = fakeHost()
    installPreExecuteGate(host, h.root.id, h.engine, options(undefined))
    const call: PreExecution = { name: 'bash', arguments: { command: 'npm publish' }, callId: 'c1' }

    const decision = await host.pre?.(call, async (): Promise<PreDecision> => ({ kind: 'allow' }))
    expect(decision?.kind).toBe('allow')
    const next = vi.fn(async () => 'dispatched')
    expect(await host.exec?.(call, next)).toBe('dispatched')
    expect(next).toHaveBeenCalledTimes(1)
    expect(h.engine.peek(h.root.id)?.enforcement.outboundConsumed ?? 0).toBe(0)
  })

  it('does NOT bump outboundConsumed when the dispatch itself fails', async () => {
    const h = await runningHarness()
    const host = fakeHost()
    const archived: string[] = []
    installPreExecuteGate(host, h.root.id, h.engine, {
      ...options(JSON.stringify(manifestFor(h.root.id))),
      archive: (_runDir, _manifest, command) => {
        archived.push(command)
        return 'outbound/consumed/stub.json'
      },
    })
    const call: PreExecution = { name: 'bash', arguments: { command: 'git push origin main' }, callId: 'c1' }
    await host.pre?.(call, async (): Promise<PreDecision> => ({ kind: 'allow' }))

    await expect(host.exec?.(call, async () => { throw new Error('dispatch aborted') }))
      .rejects.toThrowError(/dispatch aborted/)
    // The consumption counter is the run's claim about egresses that actually
    // left the machine; a dispatch that threw is not one of them.
    expect(h.engine.peek(h.root.id)?.enforcement.outboundConsumed ?? 0).toBe(0)
    // The archive DID go down first, by design — nothing may reach dispatch
    // unrecorded. The pairing is what distinguishes the two cases, so it is
    // asserted here rather than left implicit.
    expect(archived).toEqual(['git push origin main'])
  })

  it('does NOT bump outboundConsumed when the dispatch returns an error result', async () => {
    const h = await runningHarness()
    const host = fakeHost()
    installPreExecuteGate(host, h.root.id, h.engine, {
      ...options(JSON.stringify(manifestFor(h.root.id))),
      archive: () => 'outbound/consumed/stub.json',
    })
    const call: PreExecution = { name: 'bash', arguments: { command: 'git push origin main' }, callId: 'c1' }
    await host.pre?.(call, async (): Promise<PreDecision> => ({ kind: 'allow' }))

    // dsh returns `toolAbortedBeforeDispatchResult()` for a cancel that lands
    // after the last caller-cancelled check: the body never ran.
    const aborted = await host.exec?.(call, async () => ({ isError: true, content: [] }))
    expect((aborted as { isError: boolean }).isError).toBe(true)
    expect(h.engine.peek(h.root.id)?.enforcement.outboundConsumed ?? 0).toBe(0)
  })

  it('positive control: a dispatch that SUCCEEDS still bumps outboundConsumed', async () => {
    const h = await runningHarness()
    const host = fakeHost()
    installPreExecuteGate(host, h.root.id, h.engine, {
      ...options(JSON.stringify(manifestFor(h.root.id))),
      archive: () => 'outbound/consumed/stub.json',
    })
    const call: PreExecution = { name: 'bash', arguments: { command: 'git push origin main' }, callId: 'c1' }
    await host.pre?.(call, async (): Promise<PreDecision> => ({ kind: 'allow' }))
    await host.exec?.(call, async () => ({ isError: false, content: [] }))
    expect(h.engine.peek(h.root.id)?.enforcement.outboundConsumed).toBe(1)
  })

  it('ORDER: the archive is written BEFORE the dispatch, on the path where both orders agree', async () => {
    // The §6 claim is about ORDER, and its only bearer covered the throwing
    // dispatch — where the two orders differ in observable state. On the success
    // path they do not, so a swap was invisible there; a shared call-order log
    // is what makes the claim resolvable on the path the design sentence is
    // actually about ("an archived manifest with no matching consume-manifest
    // event was authorized and never dispatched").
    const h = await runningHarness()
    const host = fakeHost()
    const order: string[] = []
    installPreExecuteGate(host, h.root.id, h.engine, {
      ...options(JSON.stringify(manifestFor(h.root.id))),
      archive: () => { order.push('archive'); return 'outbound/consumed/stub.json' },
    })
    const call: PreExecution = { name: 'bash', arguments: { command: 'git push origin main' }, callId: 'c1' }
    await host.pre?.(call, async (): Promise<PreDecision> => ({ kind: 'allow' }))
    await host.exec?.(call, async () => { order.push('dispatch'); return { isError: false, content: [] } })
    expect(order).toEqual(['archive', 'dispatch'])
  })

  it('CHAINED EGRESS end to end: a push-only manifest + a push-only approval never reaches allow', async () => {
    // Driven through the real seam, because the escape was only visible end to
    // end: `decideEgress` asked, `consumeApproval` matched the push half, and
    // the listener returned `allow` for a command that also published — the
    // owner was never asked about the publish.
    const h = await runningHarness()
    await h.engine.ownerApprove(h.root, 'git push')
    const host = fakeHost()
    installPreExecuteGate(host, h.root.id, h.engine, options(JSON.stringify(manifestFor(h.root.id))))
    const chained: PreExecution = {
      name: 'bash',
      arguments: { command: 'git push origin main && npm publish' },
      callId: 'c1',
    }
    const decision = await host.pre?.(chained, async (): Promise<PreDecision> => ({ kind: 'allow' }))
    expect(decision?.kind).toBe('deny')
    expect((decision as { reason: string }).reason).toContain('npm publish')
    // The approval was NOT spent on it.
    expect(h.engine.peek(h.root.id)?.enforcement.ownerApprovals[0]?.consumedBy).toBeUndefined()
    // DETECTOR in the same run: the declared, unchained command still resolves
    // to allow on the very same approval, so the deny above is about the second
    // egress segment and not about the seam being broken.
    const plain: PreExecution = { name: 'bash', arguments: { command: 'git push origin main' }, callId: 'c2' }
    const allowed = await host.pre?.(plain, async (): Promise<PreDecision> => ({ kind: 'allow' }))
    expect(allowed?.kind).toBe('allow')
  })

  it('names the declared commands AND the command itself in the ask', async () => {
    const h = await runningHarness()
    const raw = JSON.stringify(manifestFor(h.root.id, { commands: ['git push origin'] }))
    const { decision } = decideEgress(h.engine, h.root.id, 'git push origin main', options(raw))
    expect(decision.kind).toBe('ask')
    if (decision.kind !== 'ask') throw new Error('unreachable')
    // The declared class...
    expect(decision.reason).toContain('command class(es) [git push origin]')
    // ...and the text that will actually run. The classes alone understate a
    // chained line, which is how the escape fixed on 2026-08-25 stayed invisible
    // to the human who was asked.
    expect(decision.reason).toContain('for command "git push origin main"')
  })

  it('evicts pending authorizations so a refused-egress session cannot grow without bound', async () => {
    const h = await runningHarness()
    const host = fakeHost()
    let raw: string | undefined = JSON.stringify(manifestFor(h.root.id))
    installPreExecuteGate(host, h.root.id, h.engine, {
      ...options(raw),
      readManifest: () => raw,
      archive: () => 'outbound/consumed/stub.json',
    })
    const ask = async (callId: string): Promise<void> => {
      await host.pre?.(
        { name: 'bash', arguments: { command: 'git push origin main' }, callId },
        async (): Promise<PreDecision> => ({ kind: 'allow' }),
      )
    }
    // The owner refuses every one of these: nothing reaches tools/execute, so
    // nothing is ever deleted on that path.
    await ask('evicted')
    // HARDCODED, and strictly greater than the pinned cap. The loop bound used
    // to BE the constant, so raising the cap made this loop longer instead of
    // making the test fail — a checker whose fail is unreachable by
    // construction. 70 > 64, asserted in place so the relation cannot rot.
    const drivenCalls = 70
    expect(drivenCalls).toBeGreaterThan(MAX_PENDING_EGRESS_AUTHORIZATIONS)
    for (let i = 0; i < drivenCalls; i++) await ask(`c${i}`)

    // Prove eviction by observing it: with the manifest file gone, only a call
    // whose authorization is still cached can be archived.
    raw = undefined
    await expect(host.exec?.(
      { name: 'bash', arguments: { command: 'git push origin main' }, callId: 'evicted' },
      async () => 'dispatched',
    )).rejects.toThrowError(/without a pre-execute authorization/)
    // Positive half: the newest entry survived, so the cap evicts the OLDEST
    // rather than simply dropping everything.
    expect(await host.exec?.(
      { name: 'bash', arguments: { command: 'git push origin main' }, callId: `c${drivenCalls - 1}` },
      async () => 'dispatched',
    )).toBe('dispatched')
    // and the entry that the cap must have evicted is refused, which is what
    // makes removing the cap break an ASSERTION rather than a loop length.
    await expect(host.exec?.(
      { name: 'bash', arguments: { command: 'git push origin main' }, callId: 'c0' },
      async () => 'dispatched',
    )).rejects.toThrowError(/without a pre-execute authorization/)
  })

  it('refuses to dispatch an egress whose authorizing manifest can no longer be resolved', async () => {
    const h = await runningHarness()
    const host = fakeHost()
    let raw: string | undefined = JSON.stringify(manifestFor(h.root.id))
    installPreExecuteGate(host, h.root.id, h.engine, {
      ...options(raw),
      readManifest: () => raw,
    })
    // No pre-execute pass at all, and no callId to have remembered one under:
    // this is the only case where the dispatch seam may still re-resolve, and
    // it refuses when the manifest is gone.
    raw = undefined
    const next = vi.fn(async () => 'dispatched')
    await expect(host.exec?.({ name: 'bash', arguments: { command: 'git push origin main' } }, next))
      .rejects.toThrowError(/no longer resolvable/)
    expect(next).not.toHaveBeenCalled()
  })
})

/**
 * Unobserved checkers on the outbound seam.
 *
 * All three were verified CORRECT in the shipped artifact — these are missing
 * bearers, not live defects — but each survived a mutation that would silently
 * open the outbound boundary while the suite still reported every test green.
 */
describe('the outbound seam, where its fails are observable', () => {
  it('FAILS CLOSED when the snapshot read throws', async () => {
    const h = await runningHarness()
    const host = fakeHost()
    // A store read can genuinely throw: RunStore.load raises AP_STORE_CORRUPT on
    // a torn events.jsonl line, and commit appends the canonical event BEFORE
    // the tmp+rename of the projection, so a kill in that window lands there.
    const exploding = new Proxy(h.engine, {
      get(target, property, receiver) {
        if (property === 'peek') return () => { throw new Error('store exploded') }
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    installPreExecuteGate(host, h.root.id, exploding, options(JSON.stringify(manifestFor(h.root.id))))
    const next = vi.fn(async (): Promise<PreDecision> => ({ kind: 'allow' }))
    const decision = await host.pre?.({ name: 'bash', arguments: { command: 'git push origin main' }, callId: 'c1' }, next)
    expect(decision?.kind).toBe('deny')
    if (decision?.kind !== 'deny') throw new Error('unreachable')
    expect(decision.reason).toContain('failed closed')
    expect(decision.reason).toContain('store exploded')
    expect(next).not.toHaveBeenCalled()
  })

  it('registers exactly the two event names the runtime dispatches', async () => {
    const h = await runningHarness()
    const host = fakeHost()
    const install = installPreExecuteGate(host, h.root.id, h.engine, options(undefined))
    expect(install.installed).toBe(true)
    expect(host.events).toEqual(['tools/pre-execute', 'tools/execute'])
    expect(typeof host.pre).toBe('function')
    expect(typeof host.exec).toBe('function')
  })

  it('denies a missing manifest on EVERY shell-class tool, not only bash', async () => {
    const h = await runningHarness()
    const calls: Array<{ name: string; arguments: unknown }> = [
      { name: 'bash', arguments: { command: 'git push origin main' } },
      { name: 'pwsh', arguments: { command: 'git push origin main' } },
      { name: 'run_code', arguments: { code: 'await $`git push origin main`' } },
      { name: 'terminal_open', arguments: { command: 'git push origin main' } },
      { name: 'terminal_send', arguments: { sessionId: 's1', text: 'git push origin main' } },
    ]
    for (const call of calls) {
      const host = fakeHost()
      installPreExecuteGate(host, h.root.id, h.engine, options(undefined))
      const next = vi.fn(async (): Promise<PreDecision> => ({ kind: 'allow' }))
      const decision = await host.pre?.({ ...call, callId: 'c1' }, next)
      expect(decision?.kind, call.name).toBe('deny')
      expect(next).not.toHaveBeenCalled()
    }
    // DETECTOR: a tool OUTSIDE the shell class falls through untouched, and so
    // does a shell tool carrying a benign command.
    const host = fakeHost()
    installPreExecuteGate(host, h.root.id, h.engine, options(undefined))
    const passed = vi.fn(async (): Promise<PreDecision> => ({ kind: 'allow' }))
    await host.pre?.({ name: 'python', arguments: { command: 'git push origin main' }, callId: 'c9' }, passed)
    await host.pre?.({ name: 'bash', arguments: { command: 'git status' }, callId: 'c10' }, passed)
    expect(passed).toHaveBeenCalledTimes(2)
  })

  it('asks on a VALID manifest for every shell-class tool (positive half of the same matrix)', async () => {
    const h = await runningHarness()
    const raw = JSON.stringify(manifestFor(h.root.id))
    for (const call of [
      { name: 'pwsh', arguments: { command: 'git push origin main' } },
      { name: 'terminal_send', arguments: { sessionId: 's1', text: 'git push origin main' } },
    ]) {
      const host = fakeHost()
      installPreExecuteGate(host, h.root.id, h.engine, options(raw))
      const next = vi.fn(async (): Promise<PreDecision> => ({ kind: 'allow' }))
      const decision = await host.pre?.({ ...call, callId: 'c1' }, next)
      expect(decision?.kind, call.name).toBe('ask')
    }
  })

  it('MAX_PENDING_EGRESS_AUTHORIZATIONS is pinned as a literal', () => {
    expect(MAX_PENDING_EGRESS_AUTHORIZATIONS).toBe(64)
  })

  it('a dispatch probe that THROWS reads as gated, so a broken read cannot open the boundary', async () => {
    const h = await runningHarness()
    const host = fakeHost()
    let peeks = 0
    const flaky = new Proxy(h.engine, {
      get(target, property, receiver) {
        if (property === 'peek') {
          return () => {
            peeks += 1
            throw new Error('store exploded mid-flight')
          }
        }
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    installPreExecuteGate(host, h.root.id, flaky, {
      ...options(JSON.stringify(manifestFor(h.root.id))),
      archive: () => 'outbound/consumed/stub.json',
    })
    const next = vi.fn(async () => 'dispatched')
    // `isGatedRun`'s catch answers TRUE, so dispatch stays inside the gated path
    // and refuses an unauthorized callId rather than calling next(). Inverting
    // that catch to `false` left the whole suite green.
    await expect(host.exec?.({ name: 'bash', arguments: { command: 'git push origin main' }, callId: 'unknown' }, next))
      .rejects.toThrowError(/without a pre-execute authorization/)
    expect(next).not.toHaveBeenCalled()
    expect(peeks).toBeGreaterThan(0)
  })

  it('the DISPATCH seam refuses a callId that never passed pre-execute', async () => {
    const h = await runningHarness()
    const host = fakeHost()
    // The manifest is present and perfectly valid: the ONLY thing missing is
    // this scope's own pre-execute authorization. Before the fix the seam
    // re-resolved the manifest from disk, archived, called next() and bumped
    // outboundConsumed — i.e. its safety was owned by upstream call ordering.
    installPreExecuteGate(host, h.root.id, h.engine, {
      ...options(JSON.stringify(manifestFor(h.root.id))),
      archive: () => 'outbound/consumed/stub.json',
    })
    const next = vi.fn(async () => 'dispatched')
    await expect(host.exec?.({ name: 'bash', arguments: { command: 'git push origin main' }, callId: 'smuggled' }, next))
      .rejects.toThrowError(/without a pre-execute authorization/)
    expect(next).not.toHaveBeenCalled()
    expect(h.engine.peek(h.root.id)?.enforcement.outboundConsumed ?? 0).toBe(0)
  })
})
