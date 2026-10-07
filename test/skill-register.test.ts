/**
 * Native skill registration (M5): the bundled-skill provider for `ctx.skills`,
 * the precedence rule that keeps an owner's file copy in charge, and the
 * apply() wiring — provider first, filesystem fallback, `off` = neither.
 *
 * The provider is exercised against the REAL shipped SKILL.md wherever the
 * packet says "real bundled body"; frontmatter-subset behavior is exercised
 * through injected sources so the parser's refusal terminals are reachable.
 */

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { bundledSkillPath } from '../src/skill-install.js'
import type { SkillSyncResult } from '../src/skill-install.js'
import {
  BUNDLED_SKILL_PROVIDER_NAME,
  BUNDLED_SKILL_PROVIDER_RANK,
  FILE_SCAN_BUNDLED_RANK,
  createBundledSkillProvider,
  publishBundledSkill,
} from '../src/skill-register.js'
import type { SkillCandidate, SkillProvider, SkillProviderControl, SkillRegistryLike, SkillSource } from '../src/skill-register.js'

const DEST = '/agents/skills/dsh-autopilot/SKILL.md'

/**
 * Read a provider's `list()` output the way upstream's registry does
 * (`normalizeProviderObservation`): a bare array is the complete shorthand,
 * an object is `{ candidates, complete }`. Narrowing here keeps the tests
 * honest about the mirror's union return type.
 */
async function listedCandidates(provider: SkillProvider): Promise<SkillCandidate[]> {
  const output = await provider.list({})
  return [...('candidates' in output ? output.candidates : output)]
}

// ── The shipped file, served by the real provider ────────────────────────────

describe('createBundledSkillProvider against the shipped SKILL.md', () => {
  const provider = createBundledSkillProvider()

  it('lists exactly one candidate with the honest shape', async () => {
    const listed = await listedCandidates(provider)
    expect(listed).toHaveLength(1)
    const candidate = listed[0]
    if (candidate === undefined) throw new Error('expected the bundled candidate')
    expect(candidate.name).toBe('dsh-autopilot')
    // The shipped description is a `>-` folded scalar; the file provider's
    // YAML delivers it as ONE line, and so must the mirror.
    expect(candidate.description).toMatch(/^Run goal-driven engineering work/)
    expect(candidate.description).not.toContain('\n')
    expect(candidate.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    // Honest source: the provider itself — no file-origin bucket is borrowed.
    expect(candidate.source).toBe(BUNDLED_SKILL_PROVIDER_NAME)
    expect(candidate.provider).toBe(BUNDLED_SKILL_PROVIDER_NAME)
    // Resolved EXACTLY the way skill-install.ts resolves its copy source.
    expect(candidate.path).toBe(bundledSkillPath())
    expect(isAbsolute(candidate.path ?? '')).toBe(true)
    expect(candidate.locator).toBeDefined()
  })

  it('carries rank 700 — strictly greater than the file-scan bundled rank 600', async () => {
    const candidate = (await listedCandidates(provider))[0]
    expect(candidate?.rank).toBe(BUNDLED_SKILL_PROVIDER_RANK)
    expect(BUNDLED_SKILL_PROVIDER_RANK).toBeGreaterThan(FILE_SCAN_BUNDLED_RANK)
  })

  it('get() returns the real bundled body with the frontmatter parsed off', async () => {
    const candidate = (await listedCandidates(provider))[0]
    if (candidate === undefined) throw new Error('expected the bundled candidate')
    const definition = await provider.get(candidate, {})
    if (definition === undefined) throw new Error('expected the bundled definition')
    expect(definition.name).toBe('dsh-autopilot')
    expect(definition.description).toBe(candidate.description)
    expect(definition.content.startsWith('# dsh-autopilot')).toBe(true)
    expect(definition.content).toContain('autopilot_init')
    // The fence block is metadata, never body.
    expect(definition.content).not.toContain('name: dsh-autopilot')
    expect(definition.path).toBe(bundledSkillPath())
    expect(definition.source).toBe(candidate.source)
    expect(definition.provider).toBe(BUNDLED_SKILL_PROVIDER_NAME)
    expect(definition.resourceBase).toEqual({ kind: 'directory', path: dirname(bundledSkillPath()) })
    expect(definition.metadata).toBeUndefined()
  })

  it('get() refuses a candidate that is not the bundled skill', async () => {
    const foreign: SkillCandidate = {
      name: 'other-skill',
      description: 'someone else',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'custom',
      provider: 'other',
      rank: 1,
      locator: {},
    }
    expect(await provider.get(foreign, {})).toBeUndefined()
  })

  it('get() honors an already-aborted signal with the signal’s reason', async () => {
    const candidate = (await listedCandidates(provider))[0]
    if (candidate === undefined) throw new Error('expected the bundled candidate')
    const controller = new AbortController()
    controller.abort(new Error('lookup cancelled'))
    await expect(provider.get(candidate, { signal: controller.signal })).rejects.toThrow('lookup cancelled')
  })
})

// ── Frontmatter subset parsing — the file provider's semantics mirrored ──────

/** A frontmatter fixture with every construct the subset delivers. */
const RICH_SOURCE = [
  '---',
  'name: test-skill',
  'description: >-',
  '  folded one',
  '  folded two',
  'whenToUse: reach for it when testing',
  'user-invocable: false',
  'metadata:',
  '  owner: autopilot',
  '  tier: "m5"',
  '---',
  '',
  '# Body',
  '',
  'instructions here',
  '',
].join('\n')

describe('frontmatter subset parsing (file-provider semantics)', () => {
  it('folds `>-` scalars, passes metadata through, and parses invocation policy', async () => {
    const provider = createBundledSkillProvider(() => RICH_SOURCE)
    const listed = await listedCandidates(provider)
    expect(listed).toHaveLength(1)
    const candidate = listed[0]
    if (candidate === undefined) throw new Error('expected the candidate')
    expect(candidate.name).toBe('test-skill')
    expect(candidate.description).toBe('folded one folded two')
    expect(candidate.whenToUse).toBe('reach for it when testing')
    expect(candidate.invocation).toEqual({ modelInvocable: true, userInvocable: false })
    expect(candidate.metadata).toEqual({ owner: 'autopilot', tier: 'm5' })
    const definition = await provider.get(candidate, {})
    expect(definition?.content).toBe('# Body\n\ninstructions here')
    expect(definition?.metadata).toEqual({ owner: 'autopilot', tier: 'm5' })
  })

  it('keeps line breaks in `|` literal scalars', async () => {
    const provider = createBundledSkillProvider(() => [
      '---',
      'name: test-skill',
      'description: |-',
      '  line one',
      '  line two',
      '---',
      'body',
    ].join('\n'))
    const candidate = (await listedCandidates(provider))[0]
    expect(candidate?.description).toBe('line one\nline two')
  })

  it('parses `disable-model-invocation: true` as not model-invocable', async () => {
    const provider = createBundledSkillProvider(() => [
      '---',
      'name: test-skill',
      'description: d',
      'disable-model-invocation: true',
      '---',
      'body',
    ].join('\n'))
    const candidate = (await listedCandidates(provider))[0]
    expect(candidate?.invocation).toEqual({ modelInvocable: false, userInvocable: true })
  })

  it.each([
    ['missing description', '---\nname: test-skill\n---\nbody\n'],
    ['no frontmatter fence', '# just markdown\n'],
    ['unclosed fence', '---\nname: test-skill\n'],
    ['off-grammar name', '---\nname: DSH_Autopilot\ndescription: d\n---\nbody\n'],
    ['legacy invocation key', '---\nname: test-skill\ndescription: d\nmodelInvocable: true\n---\nbody\n'],
    ['non-boolean invocation field', '---\nname: test-skill\ndescription: d\nuser-invocable: maybe\n---\nbody\n'],
    ['metadata deeper than one level', '---\nname: test-skill\ndescription: d\nmetadata:\n  outer:\n    inner: v\n---\nbody\n'],
  ])('refuses (%s): the file provider would have ignored this file', async (_label, source) => {
    const provider = createBundledSkillProvider(() => source)
    await expect(provider.list({})).resolves.toEqual([])
  })
})

// ── Duplicate-name precedence, documented by test ────────────────────────────

/**
 * The registry's duplicate-name rule, mirrored from upstream
 * `compareIndexedCandidates` + `collectLayer` (`packages/skill/skill/src/index.ts`):
 * sort candidates by rank ASCENDING (provider registration order breaks ties),
 * then the FIRST candidate per name wins. This local mirror exists so the
 * precedence between file copies and this provider is pinned BY TEST against
 * the rule that actually governs it — lower rank wins.
 */
function registryWinners(entries: ReadonlyArray<{ candidate: SkillCandidate; order: number }>): SkillCandidate[] {
  const sorted = [...entries].sort(
    (left, right) => left.candidate.rank - right.candidate.rank || left.order - right.order,
  )
  const seen = new Set<string>()
  const winners: SkillCandidate[] = []
  for (const { candidate } of sorted) {
    if (seen.has(candidate.name)) continue
    seen.add(candidate.name)
    winners.push(candidate)
  }
  return winners
}

/** A file-scan candidate for `dsh-autopilot` at a given rank, as `dsh-skill-filesystem` would list it. */
function fileScanCandidate(rank: number, source: SkillSource): SkillCandidate {
  return {
    name: 'dsh-autopilot',
    description: 'file-scan copy of the skill',
    invocation: { modelInvocable: true, userInvocable: true },
    source,
    provider: 'filesystem',
    path: DEST,
    rank,
    locator: { path: DEST, directory: '/agents/skills/dsh-autopilot' },
  }
}

describe('duplicate-name precedence: an owner file copy always beats the provider', () => {
  it('a rank-600 file-scan copy (upstream BUNDLED_SKILL_RANK) wins over the rank-700 provider', async () => {
    const ours = (await listedCandidates(createBundledSkillProvider()))[0]
    if (ours === undefined) throw new Error('expected the bundled candidate')
    // Registered FIRST (order 0) — rank, not registration order, decides.
    const winners = registryWinners([
      { candidate: ours, order: 0 },
      { candidate: fileScanCandidate(FILE_SCAN_BUNDLED_RANK, 'bundled'), order: 1 },
    ])
    expect(winners).toHaveLength(1)
    expect(winners[0]?.source).toBe('bundled')
    expect(winners[0]?.provider).toBe('filesystem')
  })

  it('a rank-500 user-agents copy (where the filesystem fallback installs) also wins', async () => {
    const ours = (await listedCandidates(createBundledSkillProvider()))[0]
    if (ours === undefined) throw new Error('expected the bundled candidate')
    const winners = registryWinners([
      { candidate: ours, order: 0 },
      { candidate: fileScanCandidate(500, 'user-agents'), order: 1 },
    ])
    expect(winners[0]?.source).toBe('user-agents')
  })

  it('the provider serves only when no file copy exists — it still loses to nothing above it', async () => {
    const ours = (await listedCandidates(createBundledSkillProvider()))[0]
    if (ours === undefined) throw new Error('expected the bundled candidate')
    // No file candidate at all: the provider is the only source for the name.
    expect(registryWinners([{ candidate: ours, order: 0 }])).toEqual([ours])
  })
})

// ── publishBundledSkill: provider first, file fallback, absent registry ──────

/** A stub `ctx.skills` capturing registrations the way the real registry retains them. */
function stubRegistry(script: { registerProviderError?: unknown } = {}): {
  readonly registry: SkillRegistryLike
  readonly providers: SkillProvider[]
  readonly controls: SkillProviderControl[]
} {
  const providers: SkillProvider[] = []
  const controls: SkillProviderControl[] = []
  const registry: SkillRegistryLike = {
    registerProvider(create) {
      if (script.registerProviderError !== undefined) throw script.registerProviderError
      const control: SkillProviderControl = { signal: new AbortController().signal, invalidate: () => {} }
      const provider = create(control)
      providers.push(provider)
      controls.push(control)
      return () => {
        const index = providers.indexOf(provider)
        if (index >= 0) providers.splice(index, 1)
      }
    },
  }
  return { registry, providers, controls }
}

describe('publishBundledSkill', () => {
  it('registry absent: returns the filesystem result unchanged (the 0.2.0 path)', () => {
    const file = (): SkillSyncResult => ({ status: 'copied', dest: DEST })
    expect(publishBundledSkill(undefined, { fileFallback: file })).toEqual({ status: 'copied', dest: DEST })
  })

  it('registry present: registers the provider and never touches the filesystem fallback', () => {
    const { registry, providers } = stubRegistry()
    let fileRuns = 0
    const result = publishBundledSkill(registry, {
      fileFallback: () => {
        fileRuns += 1
        return { status: 'error', dest: DEST, detail: 'must not happen' }
      },
    })
    expect(result.status).toBe('provider-registered')
    if (result.status !== 'provider-registered') throw new Error('unreachable')
    expect(result.provider).toBe(BUNDLED_SKILL_PROVIDER_NAME)
    expect(result.path).toBe(bundledSkillPath())
    expect(fileRuns).toBe(0)
    expect(providers).toHaveLength(1)
    expect(providers[0]?.name).toBe(BUNDLED_SKILL_PROVIDER_NAME)
    result.dispose()
    expect(providers).toHaveLength(0)
  })

  it('registerProvider throwing: records the failure and falls back to the file path', () => {
    const { registry } = stubRegistry({ registerProviderError: new Error('a provider named "dsh-autopilot-bundled" is already registered') })
    const result = publishBundledSkill(registry, { fileFallback: () => ({ status: 'unchanged', dest: DEST }) })
    expect(result).toEqual({
      status: 'provider-failed-fallback',
      provider: BUNDLED_SKILL_PROVIDER_NAME,
      failure: 'a provider named "dsh-autopilot-bundled" is already registered',
      fallback: { status: 'unchanged', dest: DEST },
    })
  })
})

// ── apply() wiring: probe, exactly-one-channel, lifecycle, off ───────────────

/**
 * The smallest host `apply()` mounts on (the `apply-skill-unsupported` shape)
 * plus a `get` that resolves `skills` — the probe's FIRST read path — and a
 * logger recording info-level diagnostics alongside warnings.
 */
function mountHost(skills: unknown): {
  readonly ctx: unknown
  readonly warnings: string[]
  readonly infos: string[]
} {
  const warnings: string[] = []
  const infos: string[] = []
  const ctx = {
    get: (name: string) => (name === 'skills' ? skills : undefined),
    agents: { list: () => [], roots: () => [] as unknown[] },
    subagents: {},
    systemPrompt: { section: () => () => {} },
    provide: () => () => {},
    logger: {
      warn: (message: string) => { warnings.push(message) },
      info: (message: string) => { infos.push(message) },
    },
    on: () => () => {},
  }
  return { ctx, warnings, infos }
}

/** Pin the skill-scan home to a fresh temp dir for the duration of one test body. */
async function withSkillHome(body: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-autopilot-skill-register-'))
  const prev = process.env.DSH_AUTOPILOT_SKILL_HOME
  process.env.DSH_AUTOPILOT_SKILL_HOME = home
  try {
    await body(home)
  } finally {
    if (prev === undefined) delete process.env.DSH_AUTOPILOT_SKILL_HOME
    else process.env.DSH_AUTOPILOT_SKILL_HOME = prev
  }
}

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('apply() wiring', () => {
  it('ctx.skills present: registers the provider, skips the file copy, and disposes with the plugin', async () => {
    await withSkillHome(async home => {
      const { registry, providers } = stubRegistry()
      const host = mountHost(registry)
      const dispose = await apply(host.ctx, { storeRoot: tempRoot('dsh-autopilot-apply-skill-'), storeKind: 'file' })
      try {
        expect(providers).toHaveLength(1)
        expect(providers[0]?.name).toBe(BUNDLED_SKILL_PROVIDER_NAME)
        // Exactly one channel: no filesystem copy alongside the registration.
        expect(existsSync(join(home, 'skills', 'dsh-autopilot', 'SKILL.md'))).toBe(false)
        // WHICH path published — diagnosable without waiting for a degrade.
        expect(host.infos).toHaveLength(1)
        expect(host.infos[0]).toContain('native skill registry')
        expect(host.infos[0]).toContain(BUNDLED_SKILL_PROVIDER_NAME)
        expect(host.warnings).toEqual([])
      } finally {
        await dispose()
      }
      // The registration disposer rides the plugin lifecycle.
      expect(providers).toHaveLength(0)
    })
  })

  it('ctx.skills present: the registered provider serves the real bundled skill', async () => {
    const { registry, providers } = stubRegistry()
    const host = mountHost(registry)
    const dispose = await apply(host.ctx, { storeRoot: tempRoot('dsh-autopilot-apply-skill-serve-'), storeKind: 'file' })
    try {
      const provider = providers[0]
      if (provider === undefined) throw new Error('expected the registered provider')
      const candidate = (await listedCandidates(provider))[0]
      expect(candidate?.name).toBe('dsh-autopilot')
      expect(candidate?.rank).toBe(BUNDLED_SKILL_PROVIDER_RANK)
      const definition = candidate === undefined ? undefined : await provider.get(candidate, {})
      expect(definition?.content.startsWith('# dsh-autopilot')).toBe(true)
    } finally {
      await dispose()
    }
  })

  it('registerProvider throwing: the file copy runs instead and the failure is recorded', async () => {
    await withSkillHome(async home => {
      const { registry } = stubRegistry({ registerProviderError: new Error('registry refused: duplicate name') })
      const host = mountHost(registry)
      const dispose = await apply(host.ctx, { storeRoot: tempRoot('dsh-autopilot-apply-skill-fallback-'), storeKind: 'file' })
      try {
        const dest = join(home, 'skills', 'dsh-autopilot', 'SKILL.md')
        expect(existsSync(dest)).toBe(true)
        expect(host.warnings).toHaveLength(1)
        expect(host.warnings[0]).toContain('native skill registration failed')
        expect(host.warnings[0]).toContain('registry refused: duplicate name')
        expect(host.warnings[0]).toContain('fell back to the filesystem skill copy')
        expect(host.infos).toEqual([])
      } finally {
        await dispose()
      }
    })
  })

  it('ctx.skills absent: the file path is taken, unchanged', async () => {
    await withSkillHome(async home => {
      const host = mountHost(undefined)
      const dispose = await apply(host.ctx, { storeRoot: tempRoot('dsh-autopilot-apply-skill-file-'), storeKind: 'file' })
      try {
        expect(existsSync(join(home, 'skills', 'dsh-autopilot', 'SKILL.md'))).toBe(true)
        expect(host.warnings).toEqual([])
        expect(host.infos).toEqual([])
      } finally {
        await dispose()
      }
    })
  })

  it("skillInstall 'off': neither channel — no registration, no copy, no diagnostics", async () => {
    await withSkillHome(async home => {
      const { registry, providers } = stubRegistry()
      const host = mountHost(registry)
      const dispose = await apply(host.ctx, {
        storeRoot: tempRoot('dsh-autopilot-apply-skill-off-'),
        storeKind: 'file',
        skillInstall: 'off',
      })
      try {
        expect(providers).toHaveLength(0)
        expect(existsSync(join(home, 'skills', 'dsh-autopilot', 'SKILL.md'))).toBe(false)
        expect(host.warnings).toEqual([])
        expect(host.infos).toEqual([])
      } finally {
        await dispose()
      }
    })
  })
})
