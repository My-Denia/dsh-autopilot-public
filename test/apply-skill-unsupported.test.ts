/**
 * The mount's reaction to a skill home that cannot be published to.
 *
 * WHY ITS OWN FILE. `apply()` does not inject skill IO — it calls
 * `syncBundledSkill` against the real filesystem — so the only way to observe
 * the `unsupported` terminal end to end is to mock the module. Doing that
 * inside `test/apply.test.ts` would put every other mount test on a mocked
 * module, and those tests are specifically about what really lands on disk.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const DEST = '/agents/skills/dsh-autopilot/SKILL.md'

vi.mock('../src/skill-install.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/skill-install.js')>()
  return {
    ...actual,
    // The mount publishes the whole skill directory, so THIS is the symbol the
    // fallback calls. Mocking syncBundledSkill would leave the real tree
    // publish running against the operator's skill home.
    syncBundledSkillTree: () => ({
      status: 'unsupported' as const,
      dest: DEST,
      detail: `skill home does not support hard links; nothing was written to ${DEST} — copy /pkg/skill/dsh-autopilot/SKILL.md there manually to install`,
      files: [],
    }),
  }
})

const { apply } = await import('../src/index.js')

/**
 * The smallest host `apply()` will mount on: no agents, so the per-root tool
 * and guard surface never installs and nothing here has to fake it. Only the
 * warning channel and the returned disposer are under test.
 */
function tinyCtx(): { ctx: unknown; warnings: string[] } {
  const warnings: string[] = []
  const ctx = {
    agents: { list: () => [], roots: () => [] },
    subagents: { registerContinuableSetup: () => () => {} },
    systemPrompt: { section: () => () => {} },
    provide: () => () => {},
    logger: { warn: (message: string) => { warnings.push(message) } },
    on: () => () => {},
  }
  return { ctx, warnings }
}

describe('apply() with a skill home that cannot be published to', () => {
  it('warns and still resolves with a working disposer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-skill-unsupported-'))
    const host = tinyCtx()

    const dispose = await apply(host.ctx, { storeRoot: root, storeKind: 'file' })

    // Mounted: the failure to install a skill never fails the mount.
    expect(typeof dispose).toBe('function')
    expect(host.warnings).toHaveLength(1)
    expect(host.warnings[0]).toContain('skill install unsupported')
    // The operator is told WHERE and WHAT TO DO, not just that something failed.
    expect(host.warnings[0]).toContain(DEST)
    expect(host.warnings[0]).toMatch(/manually/)

    await dispose()
  })

  it('is the only status among drift/error/unsupported that the mount adds', async () => {
    // DETECTOR: the warning above is attributable to the new status, not to
    // some other degrade this host shape happens to produce. The same host with
    // the skill install turned off says nothing at all.
    const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-skill-unsupported-off-'))
    const host = tinyCtx()

    const dispose = await apply(host.ctx, { storeRoot: root, storeKind: 'file', skillInstall: 'off' })

    expect(host.warnings).toEqual([])
    await dispose()
  })
})
