/**
 * Bundled-skill install into the dsh skill-scan root.
 *
 * apply() must never fail the mount over a skill copy, so every status is a
 * return value. Injected IO means none of these tests touch ~/.agents.
 */

import { describe, expect, it } from 'vitest'
import {
  BUNDLED_SKILL_REFERENCES,
  SKILL_REFERENCES_DIR,
  SKILL_RELATIVE,
  skillHome,
  syncBundledSkill,
  syncBundledSkillTree,
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
    /** Per-DESTINATION link failure, keyed by destination path. */
    linkErrors?: Record<string, string>
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
      const perDest = options.linkErrors?.[to]
      if (perDest !== undefined) {
        links.push([from, to])
        const error = new Error(`${perDest}: ${to}`) as NodeJS.ErrnoException
        error.code = perDest
        throw error
      }
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

const TREE_ROOT = '/pkg/skill/dsh-autopilot'
const TREE_DEST = '/agents/skills/dsh-autopilot'
const GOV_REF_REL = `${SKILL_REFERENCES_DIR}/governance-invariants.md`
const GOV_REF_DEST = `${TREE_DEST}/${GOV_REF_REL}`
const REFUSALS_REF_DEST = `${TREE_DEST}/${SKILL_REFERENCES_DIR}/refusals.md`

/**
 * Source tree for a fully installable skill, DERIVED from the shipped list.
 *
 * WHY DERIVED rather than naming the reference files here: this fixture used to
 * spell them out, so adding a file to `BUNDLED_SKILL_REFERENCES` made the
 * publisher plan a source the fixture had never heard of, the read threw ENOENT,
 * and every tree test went red for a reason that had nothing to do with the
 * installer. One list, one owner — a second hand-kept copy is the defect.
 */
function treeSources(): Record<string, string> {
  const sources: Record<string, string> = { [`${TREE_ROOT}/SKILL.md`]: BUNDLED }
  for (const name of BUNDLED_SKILL_REFERENCES) {
    sources[`${TREE_ROOT}/${SKILL_REFERENCES_DIR}/${name}`] = `# ${name}\n`
  }
  return sources
}

/** A destination tree whose every file already matches the bundle. */
function installedDest(): Record<string, string> {
  const sources = treeSources()
  const dest: Record<string, string> = { [DEST]: BUNDLED }
  for (const name of BUNDLED_SKILL_REFERENCES) {
    dest[`${TREE_DEST}/${SKILL_REFERENCES_DIR}/${name}`] = sources[`${TREE_ROOT}/${SKILL_REFERENCES_DIR}/${name}`] as string
  }
  return dest
}

/** One status per planned file: SKILL.md first, then every reference. */
function perFile(status: string, ...refStatuses: string[]): readonly string[] {
  return [status, ...(refStatuses.length > 0 ? refStatuses : BUNDLED_SKILL_REFERENCES.map(() => status))]
}

describe('syncBundledSkillTree', () => {
  it('publishes SKILL.md AND the reference layer on a fresh install', () => {
    const store = treeSources()
    const result = syncBundledSkillTree({ enabled: true, root: TREE_ROOT, destRoot: TREE_DEST, io: io(store) })
    expect(result.status).toBe('copied')
    expect(result.dest).toBe(DEST)
    expect(result.files.map(file => file.relative)).toEqual([
      'SKILL.md',
      ...BUNDLED_SKILL_REFERENCES.map(name => `${SKILL_REFERENCES_DIR}/${name}`),
    ])
    expect(result.files.map(file => file.status)).toEqual(perFile('copied'))
    // The whole point: a SKILL.md whose links resolve.
    expect(store[DEST]).toBe(BUNDLED)
    expect(store[GOV_REF_DEST]).toBeDefined()
    expect(store[REFUSALS_REF_DEST]).toBeDefined()
  })

  it('is unchanged when every file already matches', () => {
    // Sources AND destinations: the publish reads each source before it looks
    // at the destination, so a dest-only store is a different failure.
    const store = { ...treeSources(), ...installedDest() }
    const result = syncBundledSkillTree({ enabled: true, root: TREE_ROOT, destRoot: TREE_DEST, io: io(store) })
    expect(result.status).toBe('unchanged')
    expect(result.files.map(file => file.status)).toEqual(perFile('unchanged'))
  })

  it('upgrades a 0.1.x single-file install by adding only the missing references', () => {
    // SKILL.md present and identical, references absent — the real upgrade path.
    const store: Record<string, string> = { ...treeSources(), [DEST]: BUNDLED }
    const result = syncBundledSkillTree({ enabled: true, root: TREE_ROOT, destRoot: TREE_DEST, io: io(store) })
    expect(result.status).toBe('copied')
    expect(result.files.map(file => file.status)).toEqual(perFile('unchanged', ...BUNDLED_SKILL_REFERENCES.map(() => 'copied')))
  })

  it('writes nothing, and undoes what it wrote, when a reference has drifted', () => {
    const unlinks: string[] = []
    const store: Record<string, string> = { ...treeSources(), [GOV_REF_DEST]: '# edited by hand\n' }
    const result = syncBundledSkillTree({ enabled: true, root: TREE_ROOT, destRoot: TREE_DEST, io: io(store, { unlinks }) })
    expect(result.status).toBe('drift')
    // SKILL.md was published first, then rolled back: a half-installed skill
    // whose adapter expects references that were refused is worse than none.
    expect(store[DEST]).toBeUndefined()
    expect(unlinks).toContain(DEST)
    expect(result.detail).toContain('undid 1 of 1 file(s)')
    // refusals.md was never reached at all.
    expect(store[REFUSALS_REF_DEST]).toBeUndefined()
  })

  it('reports a rollback it could not complete instead of claiming a clean undo', () => {
    const unlinks: string[] = []
    const store: Record<string, string> = { ...treeSources(), [GOV_REF_DEST]: '# edited by hand\n' }
    const base = io(store, { unlinks })
    // The undo itself fails: the published SKILL.md survives. Reporting
    // 'rolled back 1 file(s)' here would be a false claim about the disk.
    const stubborn: SkillSyncIo = {
      ...base,
      unlink: (target: string) => { unlinks.push(target); throw Object.assign(new Error('EPERM: ' + target), { code: 'EPERM' }) },
    }
    const result = syncBundledSkillTree({ enabled: true, root: TREE_ROOT, destRoot: TREE_DEST, io: stubborn })
    expect(result.status).toBe('drift')
    expect(result.detail).toContain('undid 0 of 1 file(s)')
    expect(result.detail).toContain('FAILED to remove')
    expect(result.detail).toContain(DEST)
    expect(store[DEST]).toBeDefined()
  })

  it('writes nothing when the filesystem cannot hard-link a reference', () => {
    const unlinks: string[] = []
    const store = treeSources()
    const result = syncBundledSkillTree({
      enabled: true, root: TREE_ROOT, destRoot: TREE_DEST,
      io: io(store, { unlinks, linkErrors: { [GOV_REF_DEST]: 'ENOTSUP' } }),
    })
    expect(result.status).toBe('unsupported')
    expect(store[DEST]).toBeUndefined()
    expect(unlinks).toContain(DEST)
  })

  it('skips without touching IO when disabled', () => {
    const store = treeSources()
    const result = syncBundledSkillTree({ enabled: false, root: TREE_ROOT, destRoot: TREE_DEST, io: io(store) })
    expect(result).toEqual({ status: 'skipped', files: [] })
  })
})
