/**
 * Outbound evidence manifest: parsing, validation, count-claim detection and
 * consumption archiving (CC `<run>/outbound/manifest.json`, ported).
 *
 * WHY this replaces v1's "one approval, one egress": an approval records that
 * a human said yes. It records nothing about whether the WORDS being sent are
 * still true. The CC harness learned that the expensive way — a "9 passed"
 * line shipped in a PR description for tests that were excluded from the run
 * and never executed. The number was not wrong when it was written; it went
 * stale, and nothing in the pipeline could observe that it had.
 *
 * So the obligation moves into the manifest: every CLAIM names exactly one
 * bearing ARTIFACT, and any count-shaped phrase inside a claim must also
 * appear in the text of the artifact that bears it. That is the rule which
 * catches a stale "83/83" surviving into an outbound message after the suite
 * moved on — the failure mode DESIGN.md §8 records as having actually
 * happened in this repository's own history.
 *
 * Validation runs BEFORE an egress command may even ask the owner: asking a
 * human to approve text whose claims have not been settled just launders an
 * unverified number through a person.
 *
 * Honest ceiling (DESIGN.md §6, carried over from CC verbatim): this proves
 * existence, containment, coverage, freshness and count agreement — NOT
 * artifact truthfulness. An agent that fabricates the artifact defeats every
 * rule here; catching that is the independent audit layer's jurisdiction.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { AutopilotError, errorMessage, OUTBOUND_STALE_MS,
  FUTURE_SKEW_MS, MIN_COVERS_LABEL_LENGTH, coversFloorProblems,
} from '../domain/types.js'
import { egressSegments } from '../gate/decide.js'
import type { OutboundArtifact, OutboundClaim, OutboundManifest } from '../domain/types.js'

// FUTURE_SKEW_MS now lives in ../domain/types.js so this bound and the usage
// artifact's capturedAt bound cannot drift apart.

/** Consuming commands are recorded, not trusted; long ones are truncated to keep the archive readable. */
const MAX_ARCHIVED_COMMAND = 500

/**
 * Count-shaped phrases, per-MATCH (so "92 of 92, 92 tests" is two phrases).
 * Deliberately an ENUMERATED, under-inclusive class, exactly as CC's is:
 * widening it changes what egress is refused, which is an owner decision, not
 * a maintenance detail. Alternation order matters — the percent form must be
 * tried before the ratio form so "92%" is not partially consumed.
 */
const COUNT_PATTERN =
  /\d+(?:\.\d+)?%|\b\d+\s*\/\s*\d+\b|\b\d+\s+of\s+\d+\b|\b\d+\s+(?:tests?|files?|cases?|items?)\b/gi

/** Environment variable pinning a manifest path explicitly; owner territory (CC `GAH_OUTBOUND_MANIFEST`). */
const MANIFEST_ENV = 'DSH_AUTOPILOT_OUTBOUND_MANIFEST'

/**
 * Specificity floor for a declared command entry: at least two whitespace-
 * separated tokens.
 *
 * WHY a floor exists at all: authorization was raw substring containment over
 * any non-blank string, so `commands: ['s']` validated for BOTH
 * `git push origin main` and `npm publish` — one manifest silently blanket-
 * authorizing every egress class, which is exactly what the per-command-class
 * rule below claims cannot happen. Every command class this gate recognises
 * (`git push`, `git send-email`, `gh pr create`, `npm publish`, …) is at least
 * two tokens, so the floor costs a legitimate manifest nothing.
 */
const MIN_COMMAND_TOKENS = 2

/** Characters that may legally precede a command entry inside a shell line (`cd x && git push`). */
const TOKEN_BOUNDARY = /[\s;&|(]/

/** What `validateManifest` needs to know about the egress being attempted. */
export interface ManifestContext {
  /** The live run's id; a manifest declaring another run does not govern here. */
  readonly runId: string
  /** The full egress command text, as the guard saw it. */
  readonly command: string
  /** Absolute run directory; artifacts must settle inside it. */
  readonly runDir: string
  /** Validation clock (ms since epoch), injected so freshness is testable. */
  readonly now: number
  /** Artifact reader, injectable for tests; defaults to reading from disk. */
  readonly readArtifact?: (absPath: string) => { readonly size: number; readonly text: string } | undefined
}

/** Stamped into the archived copy: which egress spent this manifest, and when. */
export interface ConsumptionRecord {
  /** The consuming command, truncated to 500 characters. */
  readonly command: string
  /** ISO-8601 UTC consumption time. */
  readonly at: string
}

/** The archived shape written to `<runDir>/outbound/consumed/`. */
export interface ArchivedManifest extends OutboundManifest {
  readonly consumed: ConsumptionRecord
}

/** Injection seam for `archiveConsumed`, so tests never touch a real filesystem. */
export interface ArchiveOptions {
  /** Consumption clock (ms since epoch); defaults to now. */
  readonly now?: number
  /**
   * Per-consumption uniqueness token mixed into the archive filename; defaults
   * to a fresh `randomUUID()` prefix. Injectable ONLY so a test can pin it and
   * observe the collision rule directly.
   */
  readonly nonce?: string
  /** Filesystem seam; defaults to node:fs. */
  readonly fs?: {
    mkdirSync(path: string, options: { readonly recursive: true }): unknown
    writeFileSync(path: string, data: string, encoding: 'utf8'): void
  }
}

/**
 * Directory, relative to the session workspace root, holding the workspace
 * candidate. Dot-prefixed and harness-named so it is recognisable in a repo
 * listing and trivial for an owner to gitignore.
 */
export const WORKSPACE_MANIFEST_DIR = '.dsh-autopilot'

/** Where a manifest may be looked for, beyond the run directory itself. */
export interface ManifestLocationOptions {
  /** Environment carrying the owner's pin; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /**
   * The session's workspace root — the sandbox's `workspace-write` root. This
   * module cannot read `session.header.cwd` from where it stands, so the
   * process cwd is the default, which is also the value
   * `@deepseek-ai/dsh-sandbox-policy` itself falls back to for a call with no
   * session cwd.
   */
  readonly workspaceRoot?: string
}

/**
 * Every place the gate will look for this run's manifest, in consult order.
 *
 * CANDIDATES AND NOT ONE PATH, since 2026-08-25. `runDir` defaults under
 * `$DSH_HOME`, while the fs/shell sandbox's `workspace-write` root is the
 * SESSION's cwd: `@deepseek-ai/dsh-sandbox-policy` resolves
 * `workspaceRoot: session.header.cwd`, and `@deepseek-ai/dsh-sandbox`
 * `writableRoots` admits that root plus `/tmp` and `os.tmpdir()` — nothing
 * under `$DSH_HOME`. Measured on the real host across nine sessions: the gate
 * denied egress and told the agent to write a file the agent was structurally
 * unable to create. The boundary was right; the remediation was impossible to
 * follow. The second candidate sits inside the workspace, where the fs and
 * shell tools can actually write.
 *
 * WIDENING THE LOCATION GRANTS NOTHING, which is why it is safe. Every rule in
 * {@link validateManifest} — live-run id, freshness, per-segment command
 * declaration, artifact containment strictly inside `runDir`, non-emptiness,
 * covered labels, count agreement — is evaluated identically whichever file
 * the bytes came from, and a clean validation still only buys an `ask` that
 * the owner answers. What the workspace candidate deliberately does NOT move
 * is the EVIDENCE: artifact refs still have to resolve inside `runDir`, so an
 * agent that can now author the CLAIM document still cannot manufacture the
 * artifact that bears it.
 *
 * FIRST EXISTING WINS, not first VALID. Falling through from an owner-placed
 * manifest that failed validation to an agent-writable location would let the
 * second silently override the first.
 *
 * The env pin stays the OWNER's channel and stays EXCLUSIVE: a pin names a
 * path, and a pin that quietly fell back elsewhere would not be a pin. A
 * relative pin resolves against the process cwd, not the run directory — a pin
 * that rebased onto the run would not be an override at all.
 */
export function manifestCandidates(
  runDir: string,
  options: ManifestLocationOptions = {},
): readonly [string, ...string[]] {
  const env = options.env ?? process.env
  const pin = env[MANIFEST_ENV]
  if (pin !== undefined && pin.trim().length > 0) {
    return [isAbsolute(pin) ? pin : resolve(pin)]
  }
  const inRun = join(runDir, 'outbound', 'manifest.json')
  const inWorkspace = resolve(
    options.workspaceRoot ?? process.cwd(),
    WORKSPACE_MANIFEST_DIR,
    'outbound',
    'manifest.json',
  )
  // Deduplicated: with `storeRoot` pointed inside the workspace the two
  // spellings can name ONE file, and a deny message listing that file twice
  // reads as two places to look.
  return inRun === inWorkspace ? [inRun] : [inRun, inWorkspace]
}

/**
 * The canonical location: `<runDir>/outbound/manifest.json`, or the owner's
 * pin when one is set.
 *
 * Defined as the FIRST candidate rather than as a second spelling of the same
 * rule, so "where does this file go" and "where will the gate look first"
 * cannot drift apart. The env override is the OWNER's channel, not the
 * agent's: a terminal run whose binding session is gone has no agent-reachable
 * manifest path, and CC resolved that with the same escape hatch.
 */
export function manifestPath(runDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return manifestCandidates(runDir, { env })[0]
}

/**
 * Canonicalize a path whose tail may not exist yet: resolve the deepest
 * EXISTING ancestor and re-attach the missing components.
 *
 * WHY the walk rather than a bare `realpathSync`: every path this predicate is
 * asked about is one that does NOT exist (a manifest nobody has written; a run
 * directory nobody has created). A bare realpath throws for those, leaving the
 * spelling compared raw — which reads a symlinked or 8.3-aliased workspace as
 * being outside itself. `@deepseek-ai/dsh-fs-sandbox` resolves before it
 * compares, for the same reason.
 */
function canonicalPath(path: string): string {
  let head = resolve(path)
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpathSync.native(head)
      return tail.length === 0 ? real : join(real, ...tail)
    } catch {
      // `head` does not exist yet: try its parent.
    }
    const parent = dirname(head)
    if (parent === head) return resolve(path)
    tail.unshift(basename(head))
    head = parent
  }
}

/**
 * The roots a `workspace-write` confinement may write: the workspace root plus
 * the host `/tmp` and the per-user platform temp dir. Mirrors `writableRoots`
 * in `@deepseek-ai/dsh-sandbox` (`packages/sandbox/sandbox/src/roots.ts`,
 * dsh 0.1.1-rc.2), which is the ONE home of that mode's meaning for both the
 * Seatbelt profile and the in-process fs fence.
 *
 * WHY A LOCAL MIRROR AND NOT AN IMPORT: `@deepseek-ai/dsh-sandbox` is not a
 * dependency of this package, and taking a runtime coupling in order to
 * compute an ADVISORY sentence is a poor trade. Recorded as drift-prone: if
 * upstream widens the mode, this text goes stale in the harmless direction —
 * it explains a barrier that is no longer there. It cannot go stale in the
 * direction of allowing an egress, because nothing here decides anything.
 */
export function sandboxWritableRoots(workspaceRoot: string, tmp: string = tmpdir()): readonly string[] {
  return [...new Set([workspaceRoot, '/tmp', tmp].map(canonicalPath))]
}

/**
 * Whether `target` is somewhere a `workspace-write` tool call could create it.
 *
 * This is the LEXICAL half of `isPathUnder` in `@deepseek-ai/dsh-fs-sandbox`,
 * case-folded off win32 exactly as upstream is. Upstream additionally falls
 * back to comparing filesystem IDENTITY for alias spellings; this does not, so
 * an exotic alias can read as outside here where the sandbox would have
 * admitted it. That error direction only makes a deny message explain a
 * constraint that did not apply — it never suppresses one that did.
 */
export function isSandboxWritable(target: string, workspaceRoot: string, tmp?: string): boolean {
  const caseSensitive = process.platform !== 'win32'
  const compare = (value: string): string => (caseSensitive ? value : value.toLowerCase())
  const candidate = compare(canonicalPath(target))
  return sandboxWritableRoots(workspaceRoot, tmp).some(root => {
    const base = compare(root)
    if (candidate === base) return true
    const prefix = base.endsWith(sep) ? base : base + sep
    return candidate.startsWith(prefix)
  })
}

/** Command heads whose SECOND token names the egress class (`git push`, `gh pr`, `npm publish`). */
const EGRESS_HEADS: readonly string[] = ['git', 'gh', 'npm', 'pnpm', 'yarn']

/**
 * The `commands` entry a template should propose for one attempted command:
 * the egress binary and the token after it, skipping an env prefix, a `sudo`,
 * or a `cd x &&` that {@link egressSegments} has already split away.
 *
 * Falls back to the first two tokens, and to an explicit placeholder when even
 * that cannot reach {@link MIN_COMMAND_TOKENS} — a template must never propose
 * an entry the validator would reject as blanket authorization.
 */
function proposeCommandEntry(command: string): string {
  const segments = egressSegments(command)
  const line = segments.length > 0 ? (segments[0] as string) : command
  const tokens = line.trim().split(/\s+/).filter(token => token.length > 0)
  const head = tokens.findIndex(token => EGRESS_HEADS.includes(token.replace(/^.*[/\\]/, '')))
  if (head >= 0 && head + 1 < tokens.length) return `${tokens[head] as string} ${tokens[head + 1] as string}`
  if (tokens.length >= MIN_COMMAND_TOKENS) return tokens.slice(0, MIN_COMMAND_TOKENS).join(' ')
  return '<command class, at least two tokens>'
}

/**
 * A copy-pasteable manifest skeleton for THIS run and THIS command.
 *
 * The three fields an author cannot guess are filled from facts the gate
 * already holds (the live run id; a command class read off the command being
 * attempted; a `createdAt` on the validation clock), and everything the
 * harness must not invent is left as an angle-bracket placeholder. The probe
 * that drove this gate on the real host reached the valid-manifest leg only by
 * hand-authoring the file against the source, which is a documentation gap the
 * denial itself can close.
 *
 * IT IS A FORM, NOT EVIDENCE. Submitted unedited it FAILS validation — the
 * placeholder bearer names an artifact that does not exist — which is the only
 * direction a template supplied by the checker is allowed to fail in.
 */
export function renderManifestTemplate(runId: string, command: string, now: number): string {
  const skeleton: OutboundManifest = {
    v: 1,
    runId,
    target: '<where this egress goes, e.g. github.com/owner/repo>',
    commands: [proposeCommandEntry(command)],
    claims: [{ text: '<a claim the outbound text makes>', bearer: '<artifact ref, relative to the run dir>' }],
    artifacts: [
      { ref: '<artifact ref, relative to the run dir>', covers: ['<a label that artifact text contains>'] },
    ],
    createdAt: new Date(now).toISOString(),
  }
  return JSON.stringify(skeleton)
}

/** What {@link missingManifestReason} needs in order to render an actionable denial. */
export interface MissingManifestContext {
  /** The live run, named so whoever writes the file knows which id to stamp. */
  readonly runId: string
  /** The egress command that was refused; the template's command class is read off it. */
  readonly command: string
  /** Absolute run directory — where artifact refs must resolve, writable or not. */
  readonly runDir: string
  /** Every path consulted, in order, from {@link manifestCandidates}. */
  readonly candidates: readonly string[]
  /** The sandbox's workspace-write root, used to annotate each candidate. */
  readonly workspaceRoot: string
  /** Clock for the template's `createdAt`. */
  readonly now: number
  /** Platform temp dir override; tests pin it, production takes `os.tmpdir()`. */
  readonly tmpDir?: string
}

/**
 * The denial an agent or an operator can actually act on.
 *
 * WHAT WAS WRONG WITH THE OLD ONE, verbatim across nine real-host sessions:
 * `no readable outbound evidence manifest at <runDir>/outbound/manifest.json.
 * Write one (v, runId, target, commands, claims with a bearer each, artifacts,
 * createdAt) before any egress.` Every clause of that is TRUE, and the
 * instruction is still impossible to follow in the default deployment, because
 * the path it names is outside the sandbox's writable roots. A remediation its
 * reader cannot perform is not a remediation: the agent retries or gives up,
 * and the operator learns nothing about why.
 *
 * So this message states three things where the old one stated one: WHERE the
 * gate looked and which of those places the reader can actually write; WHAT to
 * put in the file, as a filled-in skeleton rather than a list of field names;
 * and — ONLY when it is true — that the run directory holding the evidence is
 * outside the writable roots, together with the one owner action that moves it
 * inside. The sandbox paragraph is COMPUTED, never boilerplate: printing it
 * under a `storeRoot` that already sits in the workspace would be a false
 * statement about the deployment its reader is standing in.
 */
export function missingManifestReason(ctx: MissingManifestContext): string {
  const annotate = (candidate: string): string =>
    isSandboxWritable(candidate, ctx.workspaceRoot, ctx.tmpDir)
      ? `${candidate} [writable by fs/shell tools]`
      : `${candidate} [outside this session's workspace-write roots: owner-placed only]`
  const parts = [
    `autopilot outbound gate: no readable outbound evidence manifest for run ${ctx.runId}, so this egress is refused.`,
    `Looked for it, in order, at: ${ctx.candidates.map(annotate).join(' ; ')}.`,
    `Write ONE of those as JSON, then retry. Skeleton for this run and command: ${renderManifestTemplate(ctx.runId, ctx.command, ctx.now)}`,
  ]
  if (!isSandboxWritable(ctx.runDir, ctx.workspaceRoot, ctx.tmpDir)) {
    parts.push(
      `Artifact refs resolve strictly inside the run directory ${ctx.runDir}, which is OUTSIDE this session's workspace-write roots (workspace ${ctx.workspaceRoot}, plus the platform temp dirs), so fs/shell tools cannot create evidence files there: either cite an artifact the harness itself already wrote under that directory (the run's own log.md is one), or ask the owner to set this plugin's storeRoot to a directory inside the workspace, which moves the run directory, its artifacts and this manifest together.`,
    )
  }
  return parts.join(' ')
}

/** True when `value` is a plain (non-array, non-null) object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A present, non-blank string. */
function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Parse a manifest strictly. TOTAL: never throws, for any input, because this
 * runs inside a tool guard where an exception would be indistinguishable from
 * a decision. Every rejection carries its own distinguishable message so a
 * test can prove the checker observed THAT fail and not some other one.
 */
export function parseManifest(raw: string): { manifest?: OutboundManifest; problems: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error: unknown) {
    return { problems: [`manifest is not valid JSON: ${errorMessage(error)}`] }
  }
  if (!isRecord(parsed)) {
    return { problems: ['manifest is not a JSON object'] }
  }

  const problems: string[] = []
  const record = parsed

  if (record.v !== 1) problems.push(`manifest v must be 1, got ${JSON.stringify(record.v)}`)
  if (!isFilledString(record.runId)) problems.push('manifest runId is missing or blank')
  if (!isFilledString(record.target)) problems.push('manifest target is missing or blank')

  const commands = record.commands
  if (!Array.isArray(commands) || commands.length === 0) {
    problems.push('manifest commands must be a non-empty array of strings')
  } else {
    for (const [index, entry] of commands.entries()) {
      if (!isFilledString(entry)) {
        problems.push(`manifest commands[${index}] must be a non-empty string`)
        continue
      }
      if (entry.trim().split(/\s+/).length < MIN_COMMAND_TOKENS) {
        problems.push(
          `manifest commands[${index}] is too unspecific ("${entry.trim()}"): a command entry needs >=${MIN_COMMAND_TOKENS} tokens, or it blanket-authorizes unrelated egress classes`,
        )
      }
    }
  }

  const claims = record.claims
  if (!Array.isArray(claims)) {
    problems.push('manifest claims must be an array')
  } else {
    for (const [index, entry] of claims.entries()) {
      if (!isRecord(entry)) {
        problems.push(`manifest claims[${index}] must be an object`)
        continue
      }
      if (typeof entry.text !== 'string') problems.push(`manifest claims[${index}].text must be a string`)
      if (typeof entry.bearer !== 'string') problems.push(`manifest claims[${index}].bearer must be a string`)
    }
  }

  const artifacts = record.artifacts
  if (!Array.isArray(artifacts)) {
    problems.push('manifest artifacts must be an array')
  } else {
    for (const [index, entry] of artifacts.entries()) {
      if (!isRecord(entry)) {
        problems.push(`manifest artifacts[${index}] must be an object`)
        continue
      }
      if (!isFilledString(entry.ref)) problems.push(`manifest artifacts[${index}].ref must be a non-empty string`)
      if (!Array.isArray(entry.covers) || entry.covers.some(item => typeof item !== 'string')) {
        problems.push(`manifest artifacts[${index}].covers must be an array of strings`)
      }
    }
  }

  const createdAt = record.createdAt
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
    problems.push('manifest createdAt is not a parseable ISO date')
  }

  if (problems.length > 0) return { problems }
  return {
    manifest: {
      v: 1,
      runId: record.runId as string,
      target: record.target as string,
      commands: (commands as string[]).slice(),
      claims: (claims as OutboundClaim[]).map(claim => ({ text: claim.text, bearer: claim.bearer })),
      artifacts: (artifacts as OutboundArtifact[]).map(artifact => ({
        ref: artifact.ref,
        covers: artifact.covers.slice(),
      })),
      createdAt: createdAt as string,
    },
    problems,
  }
}

/**
 * Every count-shaped phrase in a piece of claim text, in order of appearance.
 *
 * Supported shapes: percentages (`92%`), ratios (`92/92`), `N of M`, and a
 * bare number followed by tests/files/cases/items. The ratio shape is
 * knowingly over-inclusive (a date fragment like `2026/08` matches) — that
 * errs toward DENYING an egress, which is the safe direction for a gate;
 * erring the other way is how the stale-number incident happened.
 */
export function countClaims(text: string): string[] {
  const found: string[] = []
  // A fresh lastIndex per call: a module-level /g regex is stateful, and a
  // checker whose result depends on call order cannot be resolved by tests.
  const pattern = new RegExp(COUNT_PATTERN.source, COUNT_PATTERN.flags)
  let match = pattern.exec(text)
  while (match !== null) {
    found.push(match[0])
    match = pattern.exec(text)
  }
  return found
}

/**
 * Whether `entry` occurs in `command` starting at a shell token boundary
 * (string start, whitespace, or one of `;&|(`).
 *
 * EXPORTED since 2026-08-24: `AutopilotEngine.consumeApproval` needs the same
 * rule, because an owner approval whose `target` is not matched against the
 * command it authorizes is a fungible token rather than an authorization. One
 * implementation, so the manifest path and the approval path cannot disagree
 * about what "this approval covers this command" means.
 */
export function matchesAtTokenBoundary(command: string, entry: string): boolean {
  const needle = entry.trim()
  if (needle.length === 0) return false
  let from = command.indexOf(needle)
  while (from >= 0) {
    const before = from === 0 ? undefined : command[from - 1]
    if (before === undefined || TOKEN_BOUNDARY.test(before)) return true
    from = command.indexOf(needle, from + 1)
  }
  return false
}

/** Covered-label match; case-insensitive because an artifact writing `Gate` still bears `gate`. */
function bears(text: string, covered: string): boolean {
  const needle = covered.trim()
  if (needle.length === 0) return false
  return text.toLowerCase().includes(needle.toLowerCase())
}

/** Whitespace-insensitive, case-insensitive form used to compare a count phrase against artifact text. */
function normalizeCount(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase()
}

/**
 * Separator-aware containment: `ref` must resolve to something strictly
 * inside `runDir`. Built on path.relative rather than string prefixing so
 * `..`, mixed separators and `evidence/../../etc` are all handled by the
 * platform's own path semantics.
 */
function isContained(runDir: string, ref: string): boolean {
  const base = resolve(runDir)
  const target = resolve(base, ref)
  const rel = relative(base, target)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Default artifact reader: the production path, reading from disk. */
function readArtifactFromDisk(absPath: string): { size: number; text: string } | undefined {
  try {
    const text = readFileSync(absPath, 'utf8')
    return { size: Buffer.byteLength(text, 'utf8'), text }
  } catch {
    return undefined
  }
}

/**
 * Validate a parsed manifest against the egress being attempted. Returns the
 * problems; an empty list is the only thing that may open the approval path.
 *
 * Each rule carries its own message because a checker's pass carries no
 * information until it is proven able to observe the corresponding fail, and
 * a shared message makes two different fails indistinguishable to the test
 * that would prove it (DESIGN.md §5, Checker-Resolution).
 */
export function validateManifest(manifest: OutboundManifest, ctx: ManifestContext): string[] {
  const problems: string[] = []
  const read = ctx.readArtifact ?? readArtifactFromDisk

  // A manifest cannot shed one run's obligations onto another: CC's transplant
  // forgery surface. Both ids are named so the record shows what was swapped.
  if (manifest.runId !== ctx.runId) {
    problems.push(`manifest runId ${manifest.runId} does not govern live run ${ctx.runId}`)
  }

  const created = Date.parse(manifest.createdAt)
  if (!Number.isFinite(ctx.now)) {
    // A MISSING CLOCK MUST REFUSE, NOT EXEMPT. `created - ctx.now` and
    // `ctx.now - created` both evaluate to NaN when `now` is absent, and every
    // NaN comparison is false — so a caller that simply omitted the field got
    // BOTH freshness branches silently disabled and a year-2999 manifest
    // validated clean. The field is typed as required, so no current TS caller
    // can reach this; a fail-closed boundary should still fail loudly rather
    // than totally and silently on a missing input.
    problems.push('manifest freshness could not be evaluated: no usable validation clock was supplied (ctx.now)')
  } else if (Number.isNaN(created)) {
    problems.push('manifest createdAt is not a parseable ISO date')
  } else if (created - ctx.now > FUTURE_SKEW_MS) {
    // Refused for the reason the staleness rule exists: a forward-stamped
    // manifest would never age out, so freshness could never observe a fail.
    problems.push(
      `manifest createdAt ${manifest.createdAt} is future-dated beyond the ${FUTURE_SKEW_MS}ms clock-skew tolerance`,
    )
  } else if (ctx.now - created > OUTBOUND_STALE_MS) {
    problems.push(`manifest is stale: created ${manifest.createdAt}, older than the ${OUTBOUND_STALE_MS}ms window`)
  }

  // Authorization is per-command-class, not blanket: a manifest written for a
  // release must not silently authorize a push. Matching is anchored at a shell
  // token boundary so a declared entry cannot land mid-word — `'it push'` is a
  // raw substring of `'git push origin main'`, and treating that as a match is
  // the same blanket-authorization hole the token floor closes from the other
  // side. A leading `cd repo && ` still matches, because the boundary set
  // includes the shell separators.
  //
  // EVERY EGRESS SEGMENT, not "the command somewhere". Asking whether a
  // declared entry occurs in the command is answerable YES by a command that
  // carries a SECOND, undeclared egress: a push-only manifest authorized
  // `git push origin main && npm publish` and the sentence above was false
  // (measured 2026-08-25, independent repair audit). `egressSegments` splits on
  // the shell separators and returns only the segments that are themselves in
  // the egress class, so each of them has to be declared on its own while a
  // non-egress segment (`cd repo`, `pnpm build`) still needs nothing. A command
  // that classifies as egress nowhere falls back to the whole-line question,
  // which is the only question there is to ask about it.
  const segments = egressSegments(ctx.command)
  const targets = segments.length > 0 ? segments : [ctx.command]
  for (const segment of targets) {
    if (!manifest.commands.some(entry => matchesAtTokenBoundary(segment, entry))) {
      problems.push(`egress command matches no declared command substring: ${segment.slice(0, 200)}`)
    }
  }

  // Cardinality floor (Checker-Resolution): a manifest with zero claims
  // discharges nothing, so an empty claims list is a vacuous pass, not a pass.
  if (manifest.claims.length < 1) {
    problems.push('manifest declares zero claims: nothing to discharge')
  }

  const refs = new Set(manifest.artifacts.map(artifact => artifact.ref))
  const bearerUse = new Map<string, number>()

  for (const artifact of manifest.artifacts) {
    if (!isContained(ctx.runDir, artifact.ref)) {
      problems.push(`artifact ref escapes the run directory: ${artifact.ref}`)
      continue
    }
    const found = read(resolve(ctx.runDir, artifact.ref))
    if (found === undefined) {
      problems.push(`artifact does not exist or is unreadable: ${artifact.ref}`)
      continue
    }
    if (found.size <= 0) {
      problems.push(`artifact is empty (size 0), so it can bear nothing: ${artifact.ref}`)
      continue
    }
    // `covers` used to be REQUIRED by `parseManifest` and then read by no rule
    // at all — the worst of the three options, because the manifest looked like
    // it bound artifacts to what they show while binding nothing. It is now
    // settled the same way `settleUsageArtifacts` settles a text usage
    // artifact: a label the artifact does not contain is a label it does not
    // bear. (Honest ceiling, DESIGN.md §6: this proves the artifact MENTIONS
    // the label, never that the label is true of the run.)
    if (!artifact.covers.some(label => label.trim().length > 0)) {
      problems.push(`artifact declares no covered labels, so nothing binds it to a claim: ${artifact.ref}`)
      continue
    }
    problems.push(...coversFloorProblems(`artifact ${artifact.ref}`, artifact.covers))
    for (const covered of artifact.covers) {
      const needle = covered.trim()
      if (needle.length < MIN_COVERS_LABEL_LENGTH) continue
      if (!bears(found.text, covered)) {
        problems.push(`artifact ${artifact.ref} does not bear its covered label: ${covered}`)
      }
    }
  }

  for (const claim of manifest.claims) {
    const label = claim.text.trim().length > 0 ? claim.text.slice(0, 120) : '<blank claim text>'
    if (claim.bearer.trim().length === 0) {
      problems.push(`claim has an empty bearer (Single-Bearer: exactly one artifact per claim): ${label}`)
      continue
    }
    bearerUse.set(claim.bearer, (bearerUse.get(claim.bearer) ?? 0) + 1)
    if (!refs.has(claim.bearer)) {
      problems.push(`claim bearer names no declared artifact: ${claim.bearer}`)
      continue
    }

    const phrases = countClaims(claim.text)
    if (phrases.length === 0) continue
    if (!isContained(ctx.runDir, claim.bearer)) continue // already reported as an escape
    const found = read(resolve(ctx.runDir, claim.bearer))
    if (found === undefined) continue // already reported as missing
    const haystack = normalizeCount(found.text)
    for (const phrase of phrases) {
      if (!haystack.includes(normalizeCount(phrase))) {
        // The stale-"83/83" rule: the number in the words must be the number
        // in the artifact, or the words assert something no artifact can be
        // observed to contradict.
        problems.push(`count phrase "${phrase}" in claim is absent from its bearing artifact ${claim.bearer}: ${label}`)
      }
    }
  }

  for (const [bearer, uses] of bearerUse) {
    if (uses > 1) {
      problems.push(
        `artifact ${bearer} bears ${uses} claims (Single-Bearer: one artifact bearing two claims cannot be observed false for either independently)`,
      )
    }
  }

  return problems
}

/**
 * Archive a consumed manifest to `<runDir>/outbound/consumed/`.
 *
 * WHY archive rather than delete: the evidence that authorized an egress stays
 * in the run it authorized, where a later audit can find it.
 *
 * NO REPLAY PROTECTION IS CLAIMED HERE, and the previous version of this
 * comment claimed one ("replay protection is the archived MARKER"). Nothing
 * reads `<runDir>/outbound/consumed/`: `validateManifest` never opens it, and
 * the manifest file is neither deleted nor renamed at archive time. One
 * manifest therefore authorizes unbounded egresses of its declared command
 * class for the whole {@link OUTBOUND_STALE_MS} window, each one asked
 * separately of the owner and each one archived. What the archive IS: a record
 * of what authorized each authorized dispatch ATTEMPT, readable by an auditor
 * and pairable against the run's `consume-manifest` events. Recorded as a
 * ceiling in DESIGN.md §6 rather than described as a defense.
 *
 * The filename carries the consumption instant with filesystem-safe
 * separators, a short content hash, and a PER-CONSUMPTION nonce. The first two
 * are functions of (manifest, command) alone and are therefore IDENTICAL
 * across two consumptions of one manifest by one command — precisely the case
 * the no-replay ceiling makes reachable — so without the nonce the second
 * archive silently overwrote the first and two dispatches left one file.
 */
export function archiveConsumed(
  runDir: string,
  manifest: OutboundManifest,
  command: string,
  opts: ArchiveOptions = {},
): string {
  const fs = opts.fs ?? { mkdirSync, writeFileSync }
  const at = new Date(opts.now ?? Date.now()).toISOString()
  const truncated = command.length > MAX_ARCHIVED_COMMAND ? command.slice(0, MAX_ARCHIVED_COMMAND) : command
  const archived: ArchivedManifest = { ...manifest, consumed: { command: truncated, at } }
  const body = `${JSON.stringify(archived, null, 2)}\n`
  const hash = createHash('sha256').update(`${JSON.stringify(manifest)}\n${truncated}`).digest('hex').slice(0, 8)
  const nonce = (opts.nonce ?? randomUUID()).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)
  const dir = join(runDir, 'outbound', 'consumed')
  const target = join(dir, `${at.replace(/[:.]/g, '-')}-${hash}-${nonce}.json`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(target, body, 'utf8')
  } catch (error: unknown) {
    // Archive-first-then-allow: a failed archive must not leave an egress
    // authorized by a manifest that nothing recorded as spent.
    throw new AutopilotError(
      `failed to archive consumed manifest to ${target}: ${errorMessage(error)}`,
      'AP_OUTBOUND_ARCHIVE',
    )
  }
  return target
}
