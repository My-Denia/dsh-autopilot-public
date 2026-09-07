/**
 * Bundled-skill install into the dsh skill-scan root.
 *
 * apply() must never fail the mount over a skill copy, so every status is a
 * return value. Injected IO means none of these tests touch ~/.agents.
 */

import { describe, expect, it } from 'vitest'
import {
  SKILL_RELATIVE,
  skillHome,
  syncBundledSkill,
} from '../src/skill-install.js'
import type { DestKind, SkillSyncIo } from '../src/skill-install.js'

const BUNDLED = '# dsh-autopilot\n\nstart a run with autopilot_init\n'
const DEST = '/agents/skills/dsh-autopilot/SKILL.md'
const SOURCE = '/pkg/skill/dsh-autopilot/SKILL.md'

function io(
  files: Record<string, string>,
  options: {
    writes?: string[]
    mkdirs?: string[]
    links?: Array<[string, string]>
    unlinks?: string[]
    kinds?: Record<string, DestKind>
    failAfterWrite?: string
    destAppearsOnLink?: string
    linkError?: string
    /** Dest appears (edited by someone else) at the moment link fails. */
    racedDestOnLink?: string
  } = {},
): SkillSyncIo {
  const writes = options.writes ?? []
  const mkdirs = options.mkdirs ?? []
  const links = options.links ?? []
  const unlinks = options.unlinks ?? []
  const store = files
  const kinds = { ...options.kinds }
  let destAppeared = false
  return {
    readFile: path => {
      const found = store[path]
      if (found === undefined) throw new Error(`ENOENT: ${path}`)
      return found
    },
    writeFile: (path, content) => {
      writes.push(path)
      store[path] = content
      if (options.failAfterWrite !== undefined) throw new Error(options.failAfterWrite)
    },
    mkdir: path => { mkdirs.push(path) },
    lstat: path => {
      if (path === DEST && destAppeared) return 'file'
      return kinds[path] ?? (path in store ? 'file' : 'absent')
    },
    link: (from, to) => {
      if (options.linkError !== undefined) {
        links.push([from, to])
        if (options.racedDestOnLink !== undefined) {
          store[to] = options.racedDestOnLink
          destAppeared = true
        }
        const error = new Error(`${options.linkError}: ${to}`) as NodeJS.ErrnoException
        error.code = options.linkError
        throw error
      }
      if (options.destAppearsOnLink !== undefined) {
        links.push([from, to])
        store[to] = options.destAppearsOnLink
        destAppeared = true
        const error = new Error(`EEXIST: ${to}`) as NodeJS.ErrnoException
        error.code = 'EEXIST'
        throw error
      }
      if (to in store) {
        const error = new Error(`EEXIST: ${to}`) as NodeJS.ErrnoException
        error.code = 'EEXIST'
        throw error
      }
      const found = store[from]
      if (found === undefined) throw new Error(`ENOENT link: ${from}`)
      links.push([from, to])
      store[to] = found
    },
    unlink: path => {
      unlinks.push(path)
      delete store[path]
    },
  }
}

describe('skillHome', () => {
  it('prefers DSH_AUTOPILOT_SKILL_HOME over DSH_AGENTS_HOME over the homedir default', () => {
    expect(skillHome({ DSH_AUTOPILOT_SKILL_HOME: '/pin', DSH_AGENTS_HOME: '/agents' })).toBe('/pin')
    expect(skillHome({ DSH_AGENTS_HOME: '/agents' })).toBe('/agents')
    expect(skillHome({ DSH_AUTOPILOT_SKILL_HOME: '  ' })).toContain('.agents')
  })
})

describe('SkillSyncIo', () => {
  it('offers no copy seam at all', () => {
    // The type half is enforced by `pnpm run check`: `io()` above is declared
    // as `SkillSyncIo`, so re-adding a `copy` member there is an excess-property
    // error. This is the runtime half — nothing may reach for `io.copy`.
    const probe: SkillSyncIo = io({})
    expect('copy' in probe).toBe(false)
    expect(Object.keys(probe).sort()).toEqual(['link', 'lstat', 'mkdir', 'readFile', 'unlink', 'writeFile'])
  })
})

describe('syncBundledSkill', () => {
  it('skipped when disabled, and does not read or write', () => {
    const writes: string[] = []
    const result = syncBundledSkill({
      enabled: false,
      source: SOURCE,
      dest: DEST,
      io: io({ [SOURCE]: BUNDLED }, { writes }),
    })
    expect(result).toEqual({ status: 'skipped' })
    expect(writes).toEqual([])
  })

  it('copies when the dest is absent', () => {
    const writes: string[] = []
    const mkdirs: string[] = []
    const links: Array<[string, string]> = []
    const unlinks: string[] = []
    const files: Record<string, string> = { [SOURCE]: BUNDLED }
    const result = syncBundledSkill({
      enabled: true,
      source: SOURCE,
      dest: DEST,
      io: io(files, { writes, mkdirs, links, unlinks }),
    })
    expect(result.status).toBe('copied')
    expect(result.dest).toBe(DEST)
    expect(writes).toHaveLength(1)
    const temp = writes[0]
    if (temp === undefined) throw new Error('expected a temp write')
    expect(temp).not.toBe(DEST)
    expect(temp.startsWith(`${DEST}.`)).toBe(true)
    expect(temp.endsWith('.tmp')).toBe(true)
    expect(links).toEqual([[temp, DEST]])
    expect(unlinks).toEqual([temp])
    expect(files[DEST]).toBe(BUNDLED)
    expect(files[temp]).toBeUndefined()
    expect(mkdirs.some(path => path.includes('dsh-autopilot'))).toBe(true)
  })

  it.each(['EPERM', 'ENOTSUP', 'EOPNOTSUPP'])(
    'writes nothing to dest and reports unsupported when link fails with %s',
    code => {
      // Codex 3911205501. The two earlier terminals both published something
      // they could not publish safely: a rename replaces a raced destination,
      // and an exclusive copy makes the destination visible before the bytes
      // are all there. Writing nothing is the only honest answer left.
      const writes: string[] = []
      const links: Array<[string, string]> = []
      const unlinks: string[] = []
      const files: Record<string, string> = { [SOURCE]: BUNDLED }
      const result = syncBundledSkill({
        enabled: true,
        source: SOURCE,
        dest: DEST,
        io: io(files, { writes, links, unlinks, linkError: code }),
      })
      expect(result.status).toBe('unsupported')
      expect(result.dest).toBe(DEST)
      expect(result.detail).toContain(DEST)
      expect(result.detail).toMatch(/manually/)
      // Nothing published, and no temp left behind to be scanned as a skill.
      expect(files[DEST]).toBeUndefined()
      expect(writes).toHaveLength(1)
      const temp = writes[0]
      if (temp === undefined) throw new Error('expected a temp write')
      expect(links).toEqual([[temp, DEST]])
      expect(unlinks).toEqual([temp])
      expect(unlinks).not.toContain(DEST)
      expect(files[temp]).toBeUndefined()
    },
  )

  it('keeps a raced dest, rather than reporting unsupported, when one appears as the link fails', () => {
    // DETECTOR: 'unsupported' is not swallowing a destination that exists. The
    // race check runs first and still reports the edited file as drift.
    const writes: string[] = []
    const unlinks: string[] = []
    const edited = '# edited by the owner\n'
    const files: Record<string, string> = { [SOURCE]: BUNDLED }
    const result = syncBundledSkill({
      enabled: true,
      source: SOURCE,
      dest: DEST,
      io: io(files, { writes, unlinks, linkError: 'EPERM', racedDestOnLink: edited }),
    })
    expect(result.status).toBe('drift')
    expect(files[DEST]).toBe(edited)
    expect(unlinks).not.toContain(DEST)
  })

  it('does not replace dest when link fails because dest appeared', () => {
    const writes: string[] = []
    const links: Array<[string, string]> = []
    const unlinks: string[] = []
    const edited = '# edited by the owner\n'
    const files: Record<string, string> = { [SOURCE]: BUNDLED }
    const result = syncBundledSkill({
      enabled: true,
      source: SOURCE,
      dest: DEST,
      io: io(files, { writes, links, unlinks, destAppearsOnLink: edited }),
    })
    expect(result.status).toBe('drift')
    expect(result.detail).toMatch(/not overwriting/)
    expect(files[DEST]).toBe(edited)
    expect(unlinks).toEqual(writes)
  })

  it('unlinks the temp and writes nothing to dest when the exclusive write throws', () => {
    const writes: string[] = []
    const unlinks: string[] = []
    const files: Record<string, string> = { [SOURCE]: BUNDLED }
    const result = syncBundledSkill({
      enabled: true,
      source: SOURCE,
      dest: DEST,
      io: io(files, { writes, unlinks, failAfterWrite: 'ENOSPC' }),
    })
    expect(result.status).toBe('error')
    expect(result.detail).toMatch(/ENOSPC/)
    expect(writes).toHaveLength(1)
    expect(writes[0]).not.toBe(DEST)
    expect(unlinks).toEqual(writes)
    expect(files[DEST]).toBeUndefined()
  })

  it('is a no-op when dest already matches the bundle', () => {
    const writes: string[] = []
    const result = syncBundledSkill({
      enabled: true,
      source: SOURCE,
      dest: DEST,
      io: io({ [SOURCE]: BUNDLED, [DEST]: BUNDLED }, { writes }),
    })
    expect(result).toEqual({ status: 'unchanged', dest: DEST })
    expect(writes).toEqual([])
  })

  it('reports drift and does not overwrite a differing dest', () => {
    const writes: string[] = []
    const result = syncBundledSkill({
      enabled: true,
      source: SOURCE,
      dest: DEST,
      io: io({ [SOURCE]: BUNDLED, [DEST]: '# edited by the owner\n' }, { writes }),
    })
    expect(result.status).toBe('drift')
    expect(result.detail).toMatch(/not overwriting/)
    expect(result.detail).toContain(DEST)
    expect(result.detail).toMatch(/refresh/)
    expect(writes).toEqual([])
  })

  it('refuses to write when dest is a symlink, even if exists would say absent', () => {
    const writes: string[] = []
    const result = syncBundledSkill({
      enabled: true,
      source: SOURCE,
      dest: DEST,
      io: io({ [SOURCE]: BUNDLED }, { writes, kinds: { [DEST]: 'symlink' } }),
    })
    expect(result.status).toBe('error')
    expect(result.detail).toMatch(/symlink/)
    expect(writes).toEqual([])
  })

  it('returns error instead of throwing when the source is unreadable', () => {
    const result = syncBundledSkill({
      enabled: true,
      source: SOURCE,
      dest: DEST,
      io: io({}),
    })
    expect(result.status).toBe('error')
    expect(result.detail).toMatch(/ENOENT/)
  })
})

describe('SKILL_RELATIVE', () => {
  it('is the dsh skill-scan shape: skills/<name>/SKILL.md', () => {
    expect(SKILL_RELATIVE.replaceAll('\\', '/')).toBe('skills/dsh-autopilot/SKILL.md')
  })
})
