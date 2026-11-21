import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SKILL_NAME,
  SKILL_PROVIDER_NAME,
  SKILL_PROVIDER_RANK,
  agentsHome,
  bundledSkillPath,
  createSkillProvider,
  parseSkillFrontmatter,
  publishSkill,
  syncSkillFile,
} from '../src/skill.js'
import type { SkillProvider } from '../src/skill.js'

const SOURCE = [
  '---',
  'name: dsh-goal-autopilot',
  'description: >-',
  '  Goal workflow for DSH. Use when the user states a goal.',
  '---',
  '',
  '# adapter',
  '',
  'Use autopilot_delegate.',
  '',
].join('\n')

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-skill-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const destOf = (root: string): string => join(root, 'skills', SKILL_NAME, 'SKILL.md')

describe('bundled SKILL.md', () => {
  it('ships one parseable file with a kebab-case name', () => {
    const path = bundledSkillPath()
    expect(existsSync(path)).toBe(true)
    const parsed = parseSkillFrontmatter(readFileSync(path, 'utf8'))
    expect(parsed).toBeDefined()
    expect(parsed!.name).toBe(SKILL_NAME)
    expect(parsed!.description).toContain('Goal workflow for DSH')
    expect(parsed!.content).toContain('## Roles')
    expect(parsed!.content).toContain('autopilot_delegate')
    expect(parsed!.content).toContain('autopilot_agents')
    expect(parsed!.content).toContain('autopilot_escalate')
  })

  it('refuses a body without frontmatter or a name', () => {
    expect(parseSkillFrontmatter('# no frontmatter')).toBeUndefined()
    expect(parseSkillFrontmatter('---\ndescription: x\n---\nbody')).toBeUndefined()
    expect(parseSkillFrontmatter('---\nname: Bad_Name\ndescription: x\n---\nbody')).toBeUndefined()
  })
})

describe('skill provider', () => {
  it('serves one candidate at the documented rank above every file copy', async () => {
    const provider = createSkillProvider(() => SOURCE)
    expect(provider.name).toBe(SKILL_PROVIDER_NAME)
    const candidates = await provider.list({})
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ name: SKILL_NAME, rank: SKILL_PROVIDER_RANK, provider: SKILL_PROVIDER_NAME })
    expect(SKILL_PROVIDER_RANK).toBeGreaterThan(600)

    const loaded = await provider.get(candidates[0]!, {})
    expect(loaded?.content).toContain('Use autopilot_delegate.')
    expect(loaded?.name).toBe(SKILL_NAME)
  })

  it('serves nothing for an unparseable source and refuses a mismatched candidate', async () => {
    expect(await createSkillProvider(() => 'nothing here').list({})).toEqual([])
    const provider = createSkillProvider(() => SOURCE)
    const candidate = (await provider.list({}))[0]!
    expect(await provider.get({ ...candidate, name: 'other-skill' }, {})).toBeUndefined()
    await expect(provider.get(candidate, { signal: AbortSignal.abort() })).rejects.toThrow()
  })
})

describe('filesystem fallback', () => {
  it('copies only when absent, then reports unchanged', () => {
    const first = syncSkillFile({ source: () => SOURCE, home })
    expect(first.status).toBe('copied')
    expect(first.dest).toBe(destOf(home))
    expect(readFileSync(first.dest!, 'utf8')).toBe(SOURCE)

    const second = syncSkillFile({ source: () => SOURCE, home })
    expect(second.status).toBe('unchanged')
  })

  it('never overwrites a copy that differs from the bundled file', () => {
    syncSkillFile({ source: () => SOURCE, home })
    const dest = destOf(home)
    writeFileSync(dest, 'local changes the plugin must not clobber', 'utf8')
    const result = syncSkillFile({ source: () => SOURCE, home })
    expect(result.status).toBe('drift')
    expect(readFileSync(dest, 'utf8')).toBe('local changes the plugin must not clobber')
  })

  it('reports an unreadable source as an error instead of throwing', () => {
    const result = syncSkillFile({ source: () => { throw new Error('missing file') }, home })
    expect(result.status).toBe('error')
    expect(result.detail).toContain('missing file')
  })

  it('defaults the home to $DSH_AGENTS_HOME, then ~/.agents', () => {
    expect(agentsHome({ DSH_AGENTS_HOME: '/tmp/agents-home' })).toBe('/tmp/agents-home')
    expect(agentsHome({})).toBe(join(homedir(), '.agents'))
  })
})

describe('publication chooses exactly one channel', () => {
  it('registers the provider and makes no file copy', async () => {
    let factory: (() => SkillProvider) | undefined
    let disposed = false
    const registry = {
      registerProvider(create: () => SkillProvider) {
        factory = create
        return () => { disposed = true }
      },
    }
    const result = publishSkill(registry, { home })
    expect(result.status).toBe('provider-registered')
    expect(existsSync(destOf(home))).toBe(false)
    expect(factory).toBeDefined()
    const candidates = await factory!().list({})
    expect(candidates[0]!.name).toBe(SKILL_NAME)
    if (result.status === 'provider-registered') result.dispose()
    expect(disposed).toBe(true)
  })

  it('falls back to the file channel when registration throws', () => {
    const registry = {
      registerProvider() { throw new Error('reserved name') },
    }
    const result = publishSkill(registry, { home })
    expect(result.status).toBe('provider-failed-fallback')
    if (result.status !== 'provider-failed-fallback') throw new Error('unreachable')
    expect(result.failure).toContain('reserved name')
    expect(result.fallback.status).toBe('copied')
    expect(existsSync(destOf(home))).toBe(true)
  })

  it('uses the file channel when the host has no skill service', () => {
    const result = publishSkill(undefined, { home })
    expect(result.status).toBe('copied')
    expect(existsSync(destOf(home))).toBe(true)
  })

  it('publishes nothing when the config says off', () => {
    const result = publishSkill(undefined, { enabled: false, home })
    expect(result.status).toBe('skipped')
    expect(existsSync(join(home, 'skills'))).toBe(false)
  })
})
