/**
 * Install the bundled skill into dsh's skill-scan root.
 *
 * dsh scans `$DSH_AGENTS_HOME/skills/<name>/SKILL.md` (default `~/.agents`),
 * not the plugin package. Without this copy the gates exist and the model is
 * never told to start a run. apply() calls {@link syncBundledSkill}; it must
 * never fail the mount.
 *
 * Copy-if-absent, no-op if identical, warn-and-do-not-overwrite on drift, and
 * `unsupported` (nothing written) on a filesystem that cannot hard-link.
 * Override the dest root with `DSH_AUTOPILOT_SKILL_HOME` (tests) or
 * `DSH_AGENTS_HOME` (the scan root dsh itself uses).
 */

import { randomBytes } from 'node:crypto'
import { linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Env pin for the skill-scan HOME (the directory that contains `skills/`). */
export const SKILL_HOME_ENV = 'DSH_AUTOPILOT_SKILL_HOME'

/** Path under the skill home where this plugin's SKILL.md must live. */
export const SKILL_RELATIVE = join('skills', 'dsh-autopilot', 'SKILL.md')

/**
 * 'unsupported': the skill home cannot publish this file safely (no hard-link
 * support), so THIS CALL WROTE NOTHING TO DEST. It is separate from 'error'
 * because nothing went wrong — the filesystem simply cannot offer what
 * publication requires, and the remedy is a manual copy. Note the claim is
 * about this call, not about the state of the path: no process can promise a
 * destination is absent, because a concurrent writer may create it at any time.
 */
export type SkillInstallStatus = 'copied' | 'unchanged' | 'drift' | 'skipped' | 'unsupported' | 'error'

export interface SkillSyncResult {
  readonly status: SkillInstallStatus
  readonly dest?: string
  readonly detail?: string
}

export type DestKind = 'absent' | 'file' | 'symlink' | 'other'

export interface SkillSyncIo {
  readonly readFile: (path: string) => string
  readonly writeFile: (path: string, content: string) => void
  readonly mkdir: (path: string) => void
  /** lstat, not stat: a dangling symlink is a symlink, not absent. */
  readonly lstat: (path: string) => DestKind
  /**
   * Hard-link publish: fails with EEXIST instead of replacing dest.
   *
   * The ONLY publish primitive, deliberately. There is no `copy` sibling any
   * more — see the link-unsupported arm of {@link syncBundledSkill} for why an
   * exclusive copy is not an acceptable second choice.
   */
  readonly link: (from: string, to: string) => void
  readonly unlink: (path: string) => void
}

const defaultIo: SkillSyncIo = {
  readFile: path => readFileSync(path, 'utf8'),
  writeFile: (path, content) => { writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' }) },
  mkdir: path => { mkdirSync(path, { recursive: true }) },
  lstat: path => {
    try {
      const st = lstatSync(path)
      if (st.isSymbolicLink()) return 'symlink'
      if (st.isFile()) return 'file'
      return 'other'
    } catch {
      return 'absent'
    }
  },
  link: (from, to) => { linkSync(from, to) },
  unlink: path => { unlinkSync(path) },
}

function installTempPath(dest: string): string {
  return `${dest}.${randomBytes(6).toString('hex')}.tmp`
}

function removeTemp(io: SkillSyncIo, temp: string): void {
  try { io.unlink(temp) } catch { /* leftover temp is not dest; never drift */ }
}

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return (error as { code: string }).code
  }
  if (error instanceof Error) {
    const match = /^(E[A-Z]+)\b/.exec(error.message)
    return match?.[1]
  }
  return undefined
}

function isLinkUnsupported(error: unknown): boolean {
  const code = errorCode(error)
  if (code === 'EPERM' || code === 'ENOTSUP' || code === 'ENOSYS' || code === 'EOPNOTSUPP') return true
  return error instanceof Error && /\b(EPERM|ENOTSUP|ENOSYS|EOPNOTSUPP)\b/.test(error.message)
}

function refuseNonFile(dest: string, kind: DestKind): SkillSyncResult {
  return {
    status: 'error',
    dest,
    detail: `destination is a ${kind}, not a regular file; refusing to write through ${dest}`,
  }
}

function existingDestResult(io: SkillSyncIo, dest: string, bundled: string): SkillSyncResult {
  const live = io.readFile(dest)
  if (live === bundled) return { status: 'unchanged', dest }
  return {
    status: 'drift',
    dest,
    detail: `bundled skill differs from ${dest}; not overwriting a possibly edited copy — refresh by replacing that file with the bundled SKILL.md`,
  }
}

function racedDestResult(io: SkillSyncIo, dest: string, bundled: string): SkillSyncResult | undefined {
  const raced = io.lstat(dest)
  if (raced === 'file') return existingDestResult(io, dest, bundled)
  if (raced === 'symlink' || raced === 'other') return refuseNonFile(dest, raced)
  return undefined
}

/** Bundled SKILL.md: `../skill/dsh-autopilot/SKILL.md` from both `src/` and `lib/`. */
export function bundledSkillPath(fromUrl: string = import.meta.url): string {
  return join(dirname(fileURLToPath(fromUrl)), '..', 'skill', 'dsh-autopilot', 'SKILL.md')
}

/** Skill-scan HOME: pin, then dsh's own agents home, then `~/.agents`. */
export function skillHome(env: NodeJS.ProcessEnv = process.env): string {
  const pinned = env[SKILL_HOME_ENV]?.trim()
  if (pinned !== undefined && pinned.length > 0) return pinned
  const agents = env.DSH_AGENTS_HOME?.trim()
  if (agents !== undefined && agents.length > 0) return agents
  return join(homedir(), '.agents')
}

/**
 * Copy the bundled skill into the scan root, or explain why not.
 *
 * `enabled: false` is `skipped` and does not touch IO. IO failures become
 * `error` rather than a throw, so apply() can warn and still mount. A skill
 * home without hard links is `unsupported`: the temp is removed, this call
 * writes nothing to `dest`, and `detail` names it plus the manual remedy.
 */
export function syncBundledSkill(options: {
  readonly enabled: boolean
  readonly source?: string
  readonly dest?: string
  readonly io?: SkillSyncIo
} = { enabled: true }): SkillSyncResult {
  if (!options.enabled) return { status: 'skipped' }
  const source = options.source ?? bundledSkillPath()
  const dest = options.dest ?? join(skillHome(), SKILL_RELATIVE)
  const io = options.io ?? defaultIo
  try {
    const bundled = io.readFile(source)
    const kind = io.lstat(dest)
    if (kind === 'symlink' || kind === 'other') return refuseNonFile(dest, kind)
    if (kind === 'file') return existingDestResult(io, dest, bundled)
    io.mkdir(dirname(dest))
    const temp = installTempPath(dest)
    try {
      io.writeFile(temp, bundled)
      const kindAfter = io.lstat(dest)
      if (kindAfter === 'file') {
        removeTemp(io, temp)
        return existingDestResult(io, dest, bundled)
      }
      if (kindAfter === 'symlink' || kindAfter === 'other') {
        removeTemp(io, temp)
        return refuseNonFile(dest, kindAfter)
      }
      try {
        io.link(temp, dest)
      } catch (error: unknown) {
        const raced = racedDestResult(io, dest, bundled)
        if (raced !== undefined) {
          removeTemp(io, temp)
          return raced
        }
        if (isLinkUnsupported(error)) {
          // A skill home with no hard links gets NO automatic install, and
          // that is the honest terminal rather than a limitation of effort.
          // Publishing needs two properties at once — all-bytes-or-nothing,
          // and refuse-a-raced-destination — and no cross-platform primitive
          // has both. `fs.rename` is atomic but REPLACES the destination on
          // both platforms — "In the case that `newPath` already exists, it
          // will be overwritten" (Node `fs.rename` docs; POSIX rename(2), and
          // MoveFileExW with MOVEFILE_REPLACE_EXISTING through libuv on
          // Windows) — so it would silently destroy an edited copy, with no
          // no-clobber variant to ask for. `copyFileSync` with
          // COPYFILE_EXCL refuses the race but creates the destination BEFORE
          // the bytes are complete, so a concurrent skill scan or a crash
          // leaves a partial SKILL.md that later mounts read as drift. Both
          // were shipped and both drew the same finding. Writing nothing to
          // `dest` and saying so is the only terminal that lies about nothing;
          // the caller warns and the operator copies the file by hand. What is
          // promised is what THIS CALL did, not that the path stays empty — a
          // concurrent writer could create it a moment later, and no terminal
          // here could honestly rule that out.
          removeTemp(io, temp)
          return {
            status: 'unsupported',
            dest,
            detail: `skill home does not support hard links, and no atomic no-clobber publish is available without them; nothing was written to ${dest} — copy ${source} there manually to install`,
          }
        }
        removeTemp(io, temp)
        throw error
      }
      removeTemp(io, temp)
      return { status: 'copied', dest }
    } catch (error: unknown) {
      removeTemp(io, temp)
      throw error
    }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return { status: 'error', dest, detail }
  }
}

/** Subdirectory of the skill directory holding the reference layer. */
export const SKILL_REFERENCES_DIR = 'references'

/**
 * The reference files published alongside `SKILL.md`.
 *
 * A static list rather than a directory scan: the install path must stay
 * deterministic and observable through injected IO. `test/references-contract.test.ts`
 * asserts it equals the real directory listing, so it cannot rot.
 */
export const BUNDLED_SKILL_REFERENCES: readonly string[] = [
  'governance-invariants.md',
  'model-routing.md',
  'refusals.md',
]

/**
 * Bundled skill DIRECTORY: `../skill/dsh-autopilot` from both `src/` and `lib/`.
 *
 * The same directory the 0.2.0 provider serves as its `resourceBase`, so the
 * filesystem fallback and the provider publish the same set.
 */
export function bundledSkillRoot(fromUrl: string = import.meta.url): string {
  return dirname(bundledSkillPath(fromUrl))
}

/** One file's outcome inside a {@link SkillTreeSyncResult}. */
export interface SkillTreeFileResult {
  /** Path relative to the skill directory, slash-separated. */
  readonly relative: string
  readonly dest: string
  readonly status: SkillInstallStatus
  readonly detail?: string
}

export interface SkillTreeSyncResult {
  /** Aggregate: `copied` if this call published any file, else the refusing status. */
  readonly status: SkillInstallStatus
  /** The `SKILL.md` destination, for callers that only track one path. */
  readonly dest?: string
  readonly detail?: string
  readonly files: readonly SkillTreeFileResult[]
}

/**
 * Publish the whole bundled skill — `SKILL.md` plus the reference layer — into
 * the skill-scan root.
 *
 * Same guarantees as {@link syncBundledSkill}, held across the SET rather than
 * one file: a dest that is not a regular file, a destination that already
 * differs, or a filesystem that cannot hard-link writes NOTHING and reports why.
 * A partial publish is undone by unlinking exactly the destinations THIS call
 * created; a destination that was already there is never touched. The undo is
 * best-effort, and when an unlink FAILS the returned detail says so and names
 * the surviving path rather than reporting a clean rollback.
 *
 * Mixed states are handled rather than refused: an upgrade from the 0.1.x
 * single-file install has SKILL.md present and identical while the reference
 * layer is absent, and that publishes the absent files only.
 */
export function syncBundledSkillTree(
  options: {
    readonly enabled: boolean
    readonly root?: string
    readonly destRoot?: string
    readonly io?: SkillSyncIo
  } = { enabled: true },
): SkillTreeSyncResult {
  if (!options.enabled) return { status: 'skipped', files: [] }
  const root = options.root ?? bundledSkillRoot()
  const destRoot = options.destRoot ?? join(skillHome(), 'skills', 'dsh-autopilot')
  const io = options.io ?? defaultIo
  const skillDest = join(destRoot, 'SKILL.md')
  const plan = [
    { relative: 'SKILL.md', source: join(root, 'SKILL.md'), dest: skillDest },
    ...BUNDLED_SKILL_REFERENCES.map(name => ({
      relative: `${SKILL_REFERENCES_DIR}/${name}`,
      source: join(root, SKILL_REFERENCES_DIR, name),
      dest: join(destRoot, SKILL_REFERENCES_DIR, name),
    })),
  ]
  const files: SkillTreeFileResult[] = []
  const created: string[] = []
  const rollback = (): string | undefined => {
    if (created.length === 0) return undefined
    const stuck: string[] = []
    for (const dest of created) {
      // Best effort AND REPORTED. An unlink that fails leaves the destination
      // on disk, which is a real half-published skill — describing that as a
      // clean undo would be the exact false claim this whole return value
      // exists to avoid.
      try { io.unlink(dest) } catch { stuck.push(dest) }
    }
    const undone = created.length - stuck.length
    const parts = [`undid ${String(undone)} of ${String(created.length)} file(s) this call had published`]
    if (stuck.length > 0) {
      parts.push(`FAILED to remove ${stuck.join(', ')} — still on disk, so the skill is only partly published`)
    }
    return parts.join('; ')
  }
  try {
    for (const entry of plan) {
      const result = syncBundledSkill({ enabled: true, source: entry.source, dest: entry.dest, io })
      files.push({
        relative: entry.relative,
        dest: entry.dest,
        status: result.status,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      })
      if (result.status === 'copied') { created.push(entry.dest); continue }
      if (result.status === 'unchanged') continue
      const undo = rollback()
      return {
        status: result.status,
        dest: skillDest,
        detail: [result.detail, undo].filter((part): part is string => part !== undefined).join('; ') || undefined,
        files,
      }
    }
  } catch (error: unknown) {
    const undo = rollback()
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'error', dest: skillDest, detail: [message, undo].filter((part): part is string => part !== undefined).join('; '), files }
  }
  return { status: created.length > 0 ? 'copied' : 'unchanged', dest: skillDest, files }
}
