/**
 * The adapter skill: one Markdown file shipped inside the package
 * (`skill/dsh-goal-autopilot/SKILL.md`) and published on mount.
 *
 * TWO CHANNELS, ONE ACTIVE. When the host composes the skill service
 * (`ctx.skills`), a provider serves the in-package file with rank 700 — above
 * every file-scan rank, so an installed or edited copy on disk always wins the
 * name and is never silently overridden. When the service is absent (or the
 * registration throws), the file is copied into `$DSH_AGENTS_HOME/skills`
 * instead, copy-if-absent, never overwriting a differing copy. Exactly one
 * channel runs: the file copy is skipped entirely when the provider registers.
 *
 * Structural mirrors, not imports: `@deepseek-ai/dsh-skill` is not a dependency
 * of this package, and a host without the service must still mount. A drifted
 * surface reads as `undefined` and degrades to the file channel.
 */

import { randomBytes } from 'node:crypto'
import { copyFileSync, linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lookupService } from './host.js'

/** Skill folder name = skill name: kebab-case, matching the registry grammar. */
export const SKILL_NAME = 'dsh-goal-autopilot'

/** Registry-unique provider name. */
export const SKILL_PROVIDER_NAME = 'dsh-goal-autopilot-bundled'

/** The provider's source label (prompt-visible metadata; precedence is the rank's job). */
export const SKILL_PROVIDER_SOURCE = SKILL_PROVIDER_NAME

/**
 * Rank 700: above every file-scan rank (project 100/200, custom 300, user
 * 400/500, bundled 600), because lower ranks win a duplicate name. The provider
 * is therefore a floor under availability, never an authority over a file copy.
 */
export const SKILL_PROVIDER_RANK = 700

/** The agents home whose `skills/` child dsh scans, when `$DSH_AGENTS_HOME` is unset. */
export const AGENTS_HOME_ENV = 'DSH_AGENTS_HOME'

// ── Structural mirrors of the host skill-provider surface ────────────────────

/** Invocation controls shared by skill discovery consumers. */
export interface SkillInvocationPolicy {
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

/** Invocation-neutral skill metadata. */
export interface SkillSummary {
  readonly path?: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicy
  readonly source: string
  readonly provider: string
  readonly resourceBase?: { readonly kind: 'directory'; readonly path: string }
}

/** One provider catalog entry. */
export interface SkillCandidate extends SkillSummary {
  readonly rank: number
  readonly locator: unknown
}

/** A complete loaded skill. */
export interface SkillDefinition extends SkillSummary {
  readonly content: string
}

/** Caller context for provider work. */
export interface SkillLookupOptions {
  readonly cwd?: string | undefined
  readonly signal?: AbortSignal | undefined
}

/** One source of skills. */
export interface SkillProvider {
  readonly name: string
  readonly list: (options: SkillLookupOptions) => Promise<readonly SkillCandidate[]>
  readonly get: (candidate: SkillCandidate, options: SkillLookupOptions) => Promise<SkillDefinition | undefined>
}

/** The `ctx.skills` surface this plugin touches. */
export interface SkillRegistryLike {
  registerProvider(create: () => SkillProvider): () => void
}

// ── The shipped file ─────────────────────────────────────────────────────────

/** `../skill/dsh-goal-autopilot/SKILL.md` from both `src/` and `lib/`. */
export function bundledSkillPath(fromUrl: string = import.meta.url): string {
  return join(dirname(fileURLToPath(fromUrl)), '..', 'skill', SKILL_NAME, 'SKILL.md')
}

/** The agents home dsh scans: `$DSH_AGENTS_HOME`, else `~/.agents`. */
export function agentsHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[AGENTS_HOME_ENV]?.trim()
  return configured !== undefined && configured.length > 0 ? configured : join(homedir(), '.agents')
}

function readBundledSkill(source?: () => string): string {
  return source?.() ?? readFileSync(bundledSkillPath(), 'utf8')
}

// ── Frontmatter (the subset the shipped file uses) ──────────────────────────

interface ParsedSkill {
  readonly name: string
  readonly description: string
  readonly content: string
}

/** Split `---`-fenced frontmatter from the body; the fence must start at byte zero. */
function splitFrontmatter(raw: string): { readonly yaml: string; readonly body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  let lineStart = firstLineEnd + 1
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      const body = raw.slice(nextNewline < 0 ? raw.length : nextNewline + 1)
      return { yaml: raw.slice(firstLineEnd + 1, lineStart), body }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

/**
 * Parse the two frontmatter fields the catalog needs: `name` and
 * `description`. The description may be a plain one-line scalar or a folded
 * block (`>-`); nothing else is read, and anything that does not parse means
 * "not a skill file" (the provider serves nothing rather than guessing).
 */
export function parseSkillFrontmatter(raw: string): ParsedSkill | undefined {
  const split = splitFrontmatter(raw)
  if (split === undefined) return undefined
  const lines = split.yaml.split('\n')
  const fields: Record<string, string> = {}
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined || line.trim().length === 0) continue
    const entry = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line)
    if (entry === null) return undefined
    const key = entry[1] as string
    const inline = (entry[2] ?? '').trim()
    if (inline === '>' || inline === '>-' || inline === '>+') {
      const parts: string[] = []
      let cursor = index + 1
      while (cursor < lines.length) {
        const next = lines[cursor]
        if (next === undefined || next.trim().length === 0) break
        if (!/^[ \t]/.test(next)) break
        parts.push(next.trim())
        cursor += 1
      }
      fields[key] = parts.join(' ')
      index = cursor - 1
      continue
    }
    fields[key] = inline
  }
  const name = fields['name']
  const description = fields['description']
  if (name === undefined || name.length === 0 || description === undefined || description.length === 0) return undefined
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return undefined
  return { name, description, content: split.body.trim() }
}

// ── The provider ─────────────────────────────────────────────────────────────

const SKILL_LOCATOR = Object.freeze({ kind: 'dsh-goal-autopilot-bundled-skill' })

function summaryOf(parsed: ParsedSkill): SkillSummary {
  const path = bundledSkillPath()
  return {
    path,
    name: parsed.name,
    description: parsed.description,
    invocation: { modelInvocable: true, userInvocable: true },
    source: SKILL_PROVIDER_SOURCE,
    provider: SKILL_PROVIDER_NAME,
    resourceBase: { kind: 'directory', path: dirname(path) },
  }
}

/**
 * The provider for the bundled SKILL.md. `list` and `get` reread the source on
 * every call, so a package update on disk is visible without a registry
 * invalidation; an unparseable file serves nothing.
 */
export function createSkillProvider(source?: () => string): SkillProvider {
  return {
    name: SKILL_PROVIDER_NAME,
    list: async (options: SkillLookupOptions): Promise<readonly SkillCandidate[]> => {
      options.signal?.throwIfAborted()
      const parsed = parseSkillFrontmatter(readBundledSkill(source))
      if (parsed === undefined) return []
      return [{ ...summaryOf(parsed), rank: SKILL_PROVIDER_RANK, locator: SKILL_LOCATOR }]
    },
    get: async (candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> => {
      options.signal?.throwIfAborted()
      const parsed = parseSkillFrontmatter(readBundledSkill(source))
      if (parsed === undefined || parsed.name !== candidate.name) return undefined
      return { ...summaryOf(parsed), source: candidate.source, content: parsed.content }
    },
  }
}

// ── The filesystem fallback ─────────────────────────────────────────────────

/** What the file channel did. */
export type SkillFileStatus = 'copied' | 'unchanged' | 'drift' | 'error'

export interface SkillFileResult {
  readonly status: SkillFileStatus
  readonly dest?: string
  readonly detail?: string
}

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return (error as { code: string }).code
  }
  return error instanceof Error ? /\b(E[A-Z]+)\b/.exec(error.message)?.[1] : undefined
}

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function compareExisting(dest: string, bundled: string): SkillFileResult {
  const live = readFileSync(dest, 'utf8')
  if (live === bundled) return { status: 'unchanged', dest }
  return {
    status: 'drift',
    dest,
    detail: `bundled skill differs from ${dest}; not overwriting a possibly edited copy — refresh by replacing that file with the bundled SKILL.md`,
  }
}

/**
 * Copy the bundled skill into `<agentsHome>/skills/dsh-goal-autopilot/SKILL.md`,
 * copy-if-absent.
 *
 * Publication goes through an exclusively created temp file and a hard link, so
 * the destination either does not exist or holds the complete bytes and a raced
 * destination is refused rather than replaced. On a filesystem without hard
 * links the temp is copied with `COPYFILE_EXCL`, which still refuses to
 * overwrite. IO failures become `error` instead of throwing, so a mount can warn
 * and continue.
 */
export function syncSkillFile(options: { readonly source?: () => string; readonly home?: string; readonly dest?: string } = {}): SkillFileResult {
  const dest = options.dest ?? join(options.home ?? agentsHome(), 'skills', SKILL_NAME, 'SKILL.md')
  let bundled: string
  try {
    bundled = readBundledSkill(options.source)
  } catch (error: unknown) {
    return { status: 'error', dest, detail: `cannot read the bundled SKILL.md: ${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    if (exists(dest)) return compareExisting(dest, bundled)
    mkdirSync(dirname(dest), { recursive: true })
    const temp = `${dest}.${randomBytes(6).toString('hex')}.tmp`
    try {
      writeFileSync(temp, bundled, { encoding: 'utf8', flag: 'wx' })
      if (exists(dest)) return compareExisting(dest, bundled)
      try {
        linkSync(temp, dest)
      } catch (error: unknown) {
        if (exists(dest)) return compareExisting(dest, bundled)
        const code = errorCode(error)
        if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'ENOSYS' && code !== 'EOPNOTSUPP') throw error
        copyFileSync(temp, dest, 1 /* COPYFILE_EXCL */)
      }
    } finally {
      try { unlinkSync(temp) } catch { /* the temp is ours; a leftover never touches dest */ }
    }
    return { status: 'copied', dest }
  } catch (error: unknown) {
    return { status: 'error', dest, detail: error instanceof Error ? error.message : String(error) }
  }
}

// ── Publication ─────────────────────────────────────────────────────────────

/** What {@link publishSkill} did. */
export type SkillPublishResult =
  | { readonly status: 'provider-registered'; readonly provider: string; readonly path: string; readonly dispose: () => void }
  | { readonly status: 'provider-failed-fallback'; readonly provider: string; readonly failure: string; readonly fallback: SkillFileResult }
  | ({ readonly channel: 'file' } & SkillFileResult)
  | { readonly status: 'skipped' }

/** The `ctx.skills` registry, when the host composes one and it looks like a registry. */
export function probeSkillRegistry(rawCtx: unknown): SkillRegistryLike | undefined {
  try {
    const registry = lookupService(rawCtx, 'skills')
    if (registry === null || typeof registry !== 'object') return undefined
    if (typeof (registry as { registerProvider?: unknown }).registerProvider !== 'function') return undefined
    return registry as SkillRegistryLike
  } catch {
    return undefined
  }
}

/**
 * Publish the adapter skill through exactly one channel.
 *
 * @param registry the probed `ctx.skills`, or undefined when the host has none.
 * @param options `enabled: false` publishes nothing; `source` and `home` are test seams.
 */
export function publishSkill(
  registry: SkillRegistryLike | undefined,
  options: { readonly enabled?: boolean; readonly source?: () => string; readonly home?: string } = {},
): SkillPublishResult {
  if (options.enabled === false) return { status: 'skipped' }
  if (registry !== undefined) {
    try {
      const dispose = registry.registerProvider(() => createSkillProvider(options.source))
      return { status: 'provider-registered', provider: SKILL_PROVIDER_NAME, path: bundledSkillPath(), dispose }
    } catch (error: unknown) {
      const failure = error instanceof Error ? error.message : String(error)
      return {
        status: 'provider-failed-fallback',
        provider: SKILL_PROVIDER_NAME,
        failure,
        fallback: syncSkillFile({ ...(options.source === undefined ? {} : { source: options.source }), ...(options.home === undefined ? {} : { home: options.home }) }),
      }
    }
  }
  return { channel: 'file', ...syncSkillFile({ ...(options.source === undefined ? {} : { source: options.source }), ...(options.home === undefined ? {} : { home: options.home }) }) }
}
