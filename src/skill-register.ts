/**
 * Native publication of the bundled skill through `ctx.skills` (plan v3
 * "Skill"; M5), with the 0.2.0 filesystem copy as the fallback.
 *
 * WHY A PROVIDER AT ALL. `src/skill-install.ts` copies the in-package
 * SKILL.md into dsh's skill-scan root (`$DSH_AGENTS_HOME/skills/…`) so the
 * filesystem provider picks it up. A deployment that composes the skill
 * service (`ctx.skills`, `@deepseek-ai/dsh-skill`) does not need that write:
 * this module registers a provider that serves the SAME file straight from
 * the package — no filesystem mutation, no drift state, torn down with the
 * plugin. Exactly one path is ever active: `publishBundledSkill` skips the
 * file copy entirely when registration succeeds, and `apply()` records which
 * path published.
 *
 * ── PRECEDENCE — THE ANTI-SILENT-OVERRIDE RULE ──────────────────────────────
 *
 * The provider's candidates carry rank 700, STRICTLY GREATER than every rank
 * a file scan can produce: project-dsh 100, project-agents 200, custom 300,
 * user-dsh 400, user-agents 500, and the app's own bundled root 600
 * (`BUNDLED_SKILL_RANK`, mirrored below as {@link FILE_SCAN_BUNDLED_RANK}).
 * Upstream's registry sorts candidates by rank ASCENDING and keeps the FIRST
 * per duplicate name (`compareIndexedCandidates` + `collectLayer`'s seen-set,
 * `packages/skill/skill/src/index.ts`), so LOWER ranks win. Consequences,
 * all deliberate:
 *
 * - an owner's file-installed copy (`~/.agents/skills/dsh-autopilot/SKILL.md`,
 *   rank 500 — including one this plugin's own fallback wrote on an earlier
 *   mount) ALWAYS beats the in-package provider;
 * - a DRIFTED file copy (owner-edited, differing bytes) equally wins — the
 *   provider never silently overrides an edit the owner can see on disk;
 * - the provider serves the name only when NO file copy exists on any scanned
 *   root. It is a floor under the skill's availability, never an authority
 *   over it.
 *
 * ── MIRRORS, NOT IMPORTS ───────────────────────────────────────────────────
 *
 * Same doctrine as `src/routing/catalog.ts`: the types below are structural
 * hand-declared mirrors of the upstream skill-provider surface
 * (`packages/skill/skill/src/index.ts` lines 49-102 for
 * SkillSummary/Candidate/Definition, 231-270 for SkillProvider/Control,
 * `SkillRegistry.registerProvider` and the cordis `Context.skills`
 * augmentation + `skills/change` event). NOTHING is imported from a dsh
 * package here; a host surface that drifts shows up as a probe that reads
 * `undefined` (graceful degradation to the file path), not as a broken
 * module graph on profiles that compose no skill service at all.
 *
 * The frontmatter parser mirrors the FILE PROVIDER'S semantics — not its
 * code: `packages/skill/skill-filesystem/src/index.ts` `parseSkillFile` /
 * `parseFrontmatter` (fence at byte zero, `\r`-tolerant, body after the
 * closing fence), `stringField` (non-empty strings), `parseInvocationPolicy`
 * (`disable-model-invocation` / `user-invocable`, legacy keys rejected),
 * `optionalMetadata` (plain-object passthrough), and `content =
 * body.trim()`. It is deliberately a SUBSET of YAML — plain scalars, `>`/`|`
 * block scalars, and one level of nested `key: value` mapping for metadata.
 * Anything outside that subset makes the parse REFUSE (skill not served)
 * rather than serve something the file provider would not have delivered;
 * refusing is the honest terminal because the file path remains available as
 * the fallback.
 */

import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { errorMessage } from './domain/types.js'
import { bundledSkillPath, syncBundledSkill } from './skill-install.js'
import type { SkillSyncResult } from './skill-install.js'

// ── Structural mirrors of the upstream skill-provider surface ────────────────

/** Origin bucket for a skill contribution (mirror of upstream `SkillSource`). Prompt-visible metadata, not precedence. */
export type SkillSource = 'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | (string & {})

/** Provider-specific base for resolving a skill's relative resources (mirror of upstream `SkillResourceBase`). */
export type SkillResourceBase =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string }

/** Invocation controls shared by skill discovery consumers (mirror). */
export interface SkillInvocationPolicy {
  /** Whether model-facing catalogs and loaders include this skill. */
  readonly modelInvocable: boolean
  /** Whether human-facing command catalogs and loaders include this skill. */
  readonly userInvocable: boolean
}

/** Invocation-neutral skill metadata (mirror of upstream `SkillSummary`). */
export interface SkillSummary {
  /** Absolute instruction file path when supplied by the provider; absent for virtual skills. */
  readonly path?: string
  /** Kebab-case identifier used to address the skill. */
  readonly name: string
  /** Short routing description shown by discovery consumers. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** Resolved model and user invocation controls. */
  readonly invocation: SkillInvocationPolicy
  /** Discovery source that produced this winning skill. */
  readonly source: SkillSource
  /** Provider that owns this skill body. */
  readonly provider: string
  /** Provider-specific base for relative resources. */
  readonly resourceBase?: SkillResourceBase
}

/** Provider catalog entry (mirror of upstream `SkillCandidate`). */
export interface SkillCandidate extends SkillSummary {
  /** Lower ranks win duplicate skill names before provider registration order is considered. */
  readonly rank: number
  /** Opaque provider-owned handle passed back to `provider.get()`. */
  readonly locator: unknown
  /** Parsed optional metadata object from provider-specific skill frontmatter. */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Complete parsed skill definition (mirror of upstream `SkillDefinition`). */
export interface SkillDefinition extends SkillSummary {
  /** Markdown instruction body after any provider-specific metadata removal. */
  readonly content: string
  /** Parsed optional metadata object from frontmatter. */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Caller context for cwd-sensitive and abortable provider work (mirror of upstream `SkillLookupOptions`). */
export interface SkillLookupOptions {
  /** Workspace selector for the current lookup. */
  readonly cwd?: string | undefined
  /** Abort discovery or loading work for the current caller. */
  readonly signal?: AbortSignal | undefined
}

/** Provider candidates plus whether the current discovery is authoritative (mirror of upstream `SkillProviderObservation`). */
export interface SkillProviderObservation {
  /** Candidates available from the current provider discovery. */
  readonly candidates: readonly SkillCandidate[]
  /** Whether discovery completed and these candidates may be cached. */
  readonly complete: boolean
}

/** One source of skills (mirror of upstream `SkillProvider`). */
export interface SkillProvider {
  /** Unique provider name in the `ctx.skills` registry. */
  readonly name: string
  /**
   * List available skill candidates. The bundled skill is
   * workspace-independent, so `cwd` is ignored; an unparseable body yields an
   * EMPTY list (the file provider's "file ignored" terminal), while a source
   * that cannot be read at all rejects — upstream's registry contains that as
   * a warn + incomplete observation, which is the honest outcome.
   */
  readonly list: (options: SkillLookupOptions) => Promise<readonly SkillCandidate[] | SkillProviderObservation>
  /**
   * Load the complete body for a previously listed candidate, or `undefined`
   * when it is no longer loadable (unreadable, unparseable, or its name no
   * longer matches the candidate the registry selected).
   */
  readonly get: (candidate: SkillCandidate, options: SkillLookupOptions) => Promise<SkillDefinition | undefined>
}

/** Registration-scoped lifecycle capability (mirror of upstream `SkillProviderControl`). */
export interface SkillProviderControl {
  /** Aborts if registration fails or when the exact provider registration is disposed. */
  readonly signal: AbortSignal
  /** Invalidate completed catalogs while the exact registration remains active. */
  readonly invalidate: () => void
}

/** The `ctx.skills` surface this plugin touches (mirror of `SkillRegistry.registerProvider`). */
export interface SkillRegistryLike {
  registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void
}

// ── Ranks and identity ───────────────────────────────────────────────────────

/**
 * Upstream's standard rank for the packaged app's bundled file-scan root
 * (`BUNDLED_SKILL_RANK`, skill/src/index.ts) — the WEAKEST file rank, and
 * still below ours. Mirrored, not imported, so the precedence rule below can
 * be stated and tested against the number that actually governs it.
 */
export const FILE_SCAN_BUNDLED_RANK = 600

/**
 * This provider's rank: STRICTLY greater than {@link FILE_SCAN_BUNDLED_RANK}
 * and than every other file-scan rank (100–500), so any file copy —
 * installed or drifted — beats it. See the module header: the provider is a
 * floor under availability, never an authority over an owner's file copy.
 */
export const BUNDLED_SKILL_PROVIDER_RANK = 700

/** Registry-unique provider name. */
export const BUNDLED_SKILL_PROVIDER_NAME = 'dsh-autopilot-bundled'

/**
 * Honest `source` label: the provider itself. None of the upstream buckets
 * ('user-agents', 'bundled', …) is true of an in-package plugin copy, and
 * `SkillSource` is an open `(string & {})` vocabulary precisely so a
 * provider can name itself instead of borrowing a bucket it did not come
 * from. Prompt-visible metadata only; precedence is the rank's job.
 */
export const BUNDLED_SKILL_PROVIDER_SOURCE: SkillSource = BUNDLED_SKILL_PROVIDER_NAME

/** Opaque locator handed back by the registry on `get()` (identity only; reads always go through the source). */
export interface BundledSkillLocator {
  readonly kind: 'dsh-autopilot-bundled-skill'
}

const BUNDLED_SKILL_LOCATOR: BundledSkillLocator = Object.freeze({ kind: 'dsh-autopilot-bundled-skill' })

/** The skill-name grammar upstream enforces (`SKILL_NAME` regex, mirrored). */
const SKILL_NAME_GRAMMAR = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// ── Frontmatter subset parser (mirror of the file provider's semantics) ──────

/** What {@link parseBundledSkillFrontmatter} delivers for a parseable SKILL.md. */
export interface ParsedBundledSkill {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicy
  readonly metadata?: Record<string, unknown>
  readonly content: string
}

/**
 * Split `---`-fenced frontmatter, mirroring upstream `parseFrontmatter`:
 * the fence must sit at byte zero (first line exactly `---`, `\r`-tolerant),
 * the closing fence is the first later line that is exactly `---`, and the
 * body starts after that line. No fence ⇒ `undefined`.
 */
function splitFrontmatter(raw: string): { readonly yaml: string; readonly body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  const start = firstLineEnd + 1
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      return { yaml: raw.slice(start, lineStart), body: raw.slice(nextNewline < 0 ? raw.length : nextNewline + 1) }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

/** The first unconsumed-line index and value of a block following `key:` (empty inline value). */
interface Consumed<T> {
  readonly value: T
  readonly next: number
}

/**
 * Consume an indented block-scalar body (the lines after `key: >`/`|-`/…):
 * blank lines and more-indented lines belong to the block; the first
 * non-blank non-indented line ends it. Interior blank lines are kept as
 * empty parts (folded away by the caller) and trailing blanks are dropped.
 */
function takeBlockScalar(lines: readonly string[], start: number): Consumed<readonly string[]> | undefined {
  const body: string[] = []
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined) break
    if (line.trim().length === 0) {
      body.push('')
      index += 1
      continue
    }
    if (!/^[ \t]/.test(line)) break
    body.push(line.replace(/^[ \t]+/, ''))
    index += 1
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop()
  while (body.length > 0 && body[0] === '') body.shift()
  return { value: body, next: index }
}

/**
 * Consume a one-level nested mapping (the shape `metadata:` uses): indented
 * `key: value` lines with PLAIN inline values only. A nested block scalar, a
 * deeper mapping, or any indented non-entry line is outside the subset ⇒
 * `undefined` (the whole parse refuses rather than drop what it cannot
 * deliver — see the module header).
 */
function takeNestedMapping(lines: readonly string[], start: number): Consumed<Readonly<Record<string, string>>> | undefined {
  const map: Record<string, string> = {}
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined) break
    if (line.trim().length === 0) {
      index += 1
      continue
    }
    if (!/^[ \t]/.test(line)) break
    const entry = /^[ \t]+([^\s:]+):[ \t]*(.*)$/.exec(line)
    const value = entry?.[2]?.trim() ?? ''
    if (entry === null || value.length === 0 || /^[>|][+-]?$/.test(value)) return undefined
    map[entry[1] as string] = unquoteScalar(value)
    index += 1
  }
  return { value: map, next: index }
}

/** Consume the value of a `key:` line with an empty inline value: a nested mapping, an implicit folded plain scalar, or null. */
function takeValueBlock(lines: readonly string[], start: number): Consumed<Readonly<Record<string, string>> | string | null> | undefined {
  let index = start
  while (index < lines.length && lines[index]?.trim().length === 0) index += 1
  const first = lines[index]
  if (first === undefined || !/^[ \t]/.test(first)) return { value: null, next: index }
  if (/^[ \t]+[^\s:]+:[ \t]*.*$/.test(first)) {
    const nested = takeNestedMapping(lines, index)
    return nested === undefined ? undefined : { value: nested.value, next: nested.next }
  }
  const block = takeBlockScalar(lines, index)
  if (block === undefined) return undefined
  return { value: block.value.filter(part => part.length > 0).join(' '), next: block.next }
}

/** Strip one symmetric pair of quotes, the only quoting the subset understands. */
function unquoteScalar(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Parse the YAML SUBSET this provider delivers (see the module header):
 * top-level `key: value` entries where a value is a plain scalar, an explicit
 * `>`/`|` block scalar, a one-level nested string mapping, or null.
 * `undefined` means "outside the subset" — refuse, never guess.
 */
function parseYamlSubset(yaml: string): Record<string, unknown> | undefined {
  const lines = yaml.split('\n')
  const data: Record<string, unknown> = {}
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined) break
    if (line.trim().length === 0) {
      index += 1
      continue
    }
    const entry = /^([^\s:]+):[ \t]*(.*)$/.exec(line)
    if (entry === null) return undefined
    const key = entry[1] as string
    const inline = (entry[2] ?? '').trim()
    if (inline === '>' || inline === '>-' || inline === '>+' || inline === '|' || inline === '|-' || inline === '|+') {
      const block = takeBlockScalar(lines, index + 1)
      if (block === undefined) return undefined
      data[key] = inline.startsWith('>')
        ? block.value.filter(part => part.length > 0).join(' ')
        : block.value.join('\n')
      index = block.next
      continue
    }
    if (inline.length === 0) {
      const nested = takeValueBlock(lines, index + 1)
      if (nested === undefined) return undefined
      if (nested.value !== null) data[key] = nested.value
      index = nested.next
      continue
    }
    data[key] = unquoteScalar(inline)
    index += 1
  }
  return data
}

/** Non-empty string field, or `undefined` (mirror of upstream `stringField`). */
function stringField(data: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Upstream's tolerant frontmatter boolean over the subset (strings only; the subset parser emits no numbers). */
function frontmatterBoolean(data: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
      case '1':
        return true
      case 'false':
      case 'no':
      case 'off':
      case '0':
        return false
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

/** Legacy invocation keys are refused, not aliased (mirror of upstream `rejectLegacyInvocationKey`). */
function rejectLegacyInvocationKey(data: Readonly<Record<string, unknown>>, legacy: string, canonical: string): void {
  if (Object.hasOwn(data, legacy)) {
    throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`)
  }
}

/** Invocation policy from frontmatter, defaulting both surfaces to invocable (mirror of upstream `parseInvocationPolicy`). */
function parseInvocationPolicy(data: Readonly<Record<string, unknown>>): SkillInvocationPolicy {
  rejectLegacyInvocationKey(data, 'disableModelInvocation', 'disable-model-invocation')
  rejectLegacyInvocationKey(data, 'modelInvocable', 'disable-model-invocation')
  rejectLegacyInvocationKey(data, 'userInvocable', 'user-invocable')
  const disableModelInvocation = frontmatterBoolean(data, 'disable-model-invocation')
  const userInvocable = frontmatterBoolean(data, 'user-invocable')
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  }
}

/** Plain-object `metadata` passthrough, or nothing (mirror of upstream `optionalMetadata`). */
function optionalMetadata(data: Readonly<Record<string, unknown>>): { metadata?: Record<string, unknown> } {
  const value = data.metadata
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return { metadata: value as Record<string, unknown> }
  }
  return {}
}

/**
 * Parse a SKILL.md body the way the file provider would deliver it. `undefined`
 * is the file provider's "file ignored" terminal — missing fence, unparseable
 * subset, missing name/description, an off-grammar name, or invalid invocation
 * frontmatter all refuse here, so a caller never serves a definition the file
 * provider would have dropped.
 */
export function parseBundledSkillFrontmatter(raw: string): ParsedBundledSkill | undefined {
  const split = splitFrontmatter(raw)
  if (split === undefined) return undefined
  let data: Record<string, unknown>
  try {
    const parsed = parseYamlSubset(split.yaml)
    if (parsed === undefined) return undefined
    data = parsed
  } catch {
    return undefined
  }
  const name = stringField(data, 'name')
  const description = stringField(data, 'description')
  if (name === undefined || description === undefined) return undefined
  if (!SKILL_NAME_GRAMMAR.test(name)) return undefined
  const whenToUse = stringField(data, 'whenToUse')
  let invocation: SkillInvocationPolicy
  try {
    invocation = parseInvocationPolicy(data)
  } catch {
    return undefined
  }
  return {
    name,
    description,
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    invocation,
    ...optionalMetadata(data),
    content: split.body.trim(),
  }
}

// ── The provider ─────────────────────────────────────────────────────────────

/** Default source: read the in-package SKILL.md, resolved exactly the way `skill-install.ts` resolves its copy source. */
function readBundledSkill(): string {
  return readFileSync(bundledSkillPath(), 'utf8')
}

/** The summary fields candidate and definition share. */
function skillBase(parsed: ParsedBundledSkill): SkillSummary {
  return {
    name: parsed.name,
    description: parsed.description,
    ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
    invocation: parsed.invocation,
    source: BUNDLED_SKILL_PROVIDER_SOURCE,
    provider: BUNDLED_SKILL_PROVIDER_NAME,
    resourceBase: { kind: 'directory', path: dirname(bundledSkillPath()) },
    path: bundledSkillPath(),
  }
}

/**
 * The skill provider for the bundled SKILL.md.
 *
 * `list`/`get` parse the SAME source on every call — the shipped file is
 * static per mount, so there is nothing to invalidate (upstream's
 * `SkillProviderControl` drives file-watching providers; this one ignores
 * it, and a plugin reload re-registers fresh). Both parse failures and
 * aborts mirror the file provider's terminals: unparseable ⇒ not served
 * (`[]` / `undefined`), aborted ⇒ the signal's reason is thrown.
 *
 * @param source - reads the SKILL.md body; defaults to the in-package file.
 */
export function createBundledSkillProvider(source: () => string = readBundledSkill): SkillProvider {
  return {
    name: BUNDLED_SKILL_PROVIDER_NAME,
    list: async (): Promise<readonly SkillCandidate[]> => {
      const parsed = parseBundledSkillFrontmatter(source())
      if (parsed === undefined) return []
      return [{ ...skillBase(parsed), rank: BUNDLED_SKILL_PROVIDER_RANK, locator: BUNDLED_SKILL_LOCATOR, ...optionalMetadataOf(parsed) }]
    },
    get: async (candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> => {
      options.signal?.throwIfAborted()
      const parsed = parseBundledSkillFrontmatter(source())
      if (parsed === undefined) return undefined
      if (parsed.name !== candidate.name) return undefined
      return {
        ...skillBase(parsed),
        source: candidate.source,
        ...optionalMetadataOf(parsed),
        content: parsed.content,
      }
    },
  }
}

function optionalMetadataOf(parsed: ParsedBundledSkill): { metadata?: Record<string, unknown> } {
  return parsed.metadata === undefined ? {} : { metadata: parsed.metadata }
}

// ── Publication: native provider first, filesystem fallback ──────────────────

/**
 * What {@link publishBundledSkill} did, additively beside
 * {@link SkillSyncResult}: the two new statuses name the NATIVE path's
 * outcome, and every other status IS a `SkillSyncResult` from the unchanged
 * filesystem path — old consumers of `SkillSyncResult` keep working because
 * that type and its vocabulary are untouched.
 */
export type SkillPublicationResult =
  | {
    /** `ctx.skills.registerProvider` accepted the bundled provider; NO filesystem copy was made. */
    readonly status: 'provider-registered'
    readonly provider: string
    /** The in-package SKILL.md the provider serves. */
    readonly path: string
    /** Unregisters the provider; rides the plugin lifecycle. */
    readonly dispose: () => void
  }
  | {
    /** `registerProvider` threw; the filesystem copy ran instead, with the failure recorded here. */
    readonly status: 'provider-failed-fallback'
    readonly provider: string
    /** The registration failure, rendered. */
    readonly failure: string
    /** What the filesystem fallback did. */
    readonly fallback: SkillSyncResult
  }
  | SkillSyncResult

/** Options for {@link publishBundledSkill}; both members are test seams over the shipped defaults. */
export interface PublishBundledSkillOptions {
  /** Reads the SKILL.md body the provider serves; default reads the in-package file. */
  readonly source?: () => string
  /**
   * The 0.2.0 filesystem fallback. Default: `syncBundledSkill({ enabled: true })`
   * — the exact call `apply()` made before this module existed.
   */
  readonly fileFallback?: () => SkillSyncResult
}

/**
 * Publish the bundled skill through the best channel this mount can see.
 * Never throws: a registration failure falls back to the filesystem copy and
 * is recorded in the result, because a skill that cannot publish must not
 * fail the mount (the {@link syncBundledSkill} contract this replaces).
 *
 * @param registry - the probed `ctx.skills`, or `undefined` when this profile
 * composes no skill service ⇒ the unchanged filesystem path.
 */
export function publishBundledSkill(
  registry: SkillRegistryLike | undefined,
  options: PublishBundledSkillOptions = {},
): SkillPublicationResult {
  const fileFallback = options.fileFallback ?? ((): SkillSyncResult => syncBundledSkill({ enabled: true }))
  if (registry === undefined) return fileFallback()
  const source = options.source ?? readBundledSkill
  try {
    // The control (abort/invalidate) is ignored on purpose: the shipped
    // SKILL.md is static per mount, so there is nothing to invalidate and a
    // plugin reload re-registers fresh. See createBundledSkillProvider.
    const dispose = registry.registerProvider(() => createBundledSkillProvider(source))
    return { status: 'provider-registered', provider: BUNDLED_SKILL_PROVIDER_NAME, path: bundledSkillPath(), dispose }
  } catch (error: unknown) {
    return {
      status: 'provider-failed-fallback',
      provider: BUNDLED_SKILL_PROVIDER_NAME,
      failure: errorMessage(error),
      fallback: fileFallback(),
    }
  }
}
