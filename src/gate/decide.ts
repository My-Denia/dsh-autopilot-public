/**
 * Pure gate decision logic. Kept side-effect-free so the deny matrix is unit
 * testable, and the decision is an N-valued enum asserted on the value
 * (CC Checker-Resolution lesson: never collapse a multi-valued outcome into a
 * boolean the tests cannot resolve).
 *
 * THE v2 SPLIT, which is the reason this file changed shape:
 *
 * - The synchronous `ToolGuard` (this module's consumer) owns the ABSOLUTE
 *   denials — plan gate, usage declaration, executor bypass. Those are
 *   monotonic facts about the run: no human answer makes them false, so there
 *   is nothing to ask about and a synchronous seam is the right one.
 * - The asynchronous `tools/pre-execute` waterfall (`./preexecute.ts`) owns the
 *   ASK-able decisions — the outbound evidence manifest and owner authority
 *   for egress. Those need to read a file, validate it, and possibly put a
 *   question to a human; none of that fits in a guard whose contract is
 *   `(execution) => string | undefined`.
 *
 * Guards cannot force-allow, so the two seams cannot fight: whichever denies,
 * denies. That is also why the egress branch here MUST stand down when the
 * pre-execute seam is installed — an unconditional guard denial would override
 * the human's `allowed-once` and make the ask theatre.
 */

import { TERMINAL_PHASES } from '../domain/types.js'
import type { EgressChannel, Snapshot } from '../domain/types.js'

/** Tools whose only job is mutating files. */
const MUTATION_TOOLS: readonly string[] = ['write', 'edit']

/**
 * Shell-class tools (OS sandbox is the enforcement layer for these).
 *
 * EXPORTED, and imported by `./preexecute.ts` rather than duplicated there.
 * The two lists were byte-identical copies, which is the shape that drifts:
 * a name added to the guard's list and not to the seam's would open the
 * outbound boundary on one seam while the other still reported it closed.
 *
 * `run_terminal` was REMOVED because no dsh package defines it — it existed
 * only in the v1 `tool-gah` plugin this one replaces, so the entry gated
 * nothing. The real PTY surface is `terminal_open` / `terminal_send` /
 * `terminal_read` / `terminal_signal` / `terminal_close`; the two that can
 * carry command text (`terminal_open`'s `command`, `terminal_send`'s `text`)
 * are treated as ONE channel and both are listed here. Widening what the gate
 * SCANS is the fail-closed direction, which is why the same rename removed
 * `run_terminal` from the executor's default ALLOW list (`../config.ts`)
 * instead of substituting the terminal names there.
 */
export const SHELL_TOOLS: readonly string[] = [
  'bash', 'pwsh', 'run_code', 'terminal_open', 'terminal_send',
]

/**
 * Owner-only egress command patterns (CC outbound gate v1 command class).
 *
 * Honest ceiling (DESIGN.md §6): an ENUMERATED class. A subprocess spawned
 * inside a script, a renamed binary, or a channel nobody listed still leaves
 * the machine unobserved. The entries below are the ones this repository has
 * measured; three evasions INSIDE an already-enumerated channel were closed in
 * the 2026-08-24 round (`gh api` with field flags, `gh workflow run` /
 * `gh secret set`, and a backslash-continued `git … push`).
 */
const EGRESS_PATTERNS: readonly RegExp[] = [
  /\bgit\b[^\n&|;]*\bpush\b/,
  /\bgit\s+send-email\b/,
  /\bgh\s+(?:pr|issue|release|repo|gist)\b[^\n]*\b(?:create|merge|edit|close|delete|comment|publish|upload|fork)\b/,
  /\bgh\s+api\b[^\n]*(?:-X|--method)[\s=]*(?:POST|PUT|PATCH|DELETE)/i,
  // `gh api` MUTATES implicitly whenever a field/body flag is present (gh
  // switches the method to POST), and `graphql` carries its mutation in the
  // query rather than in a flag. Both miss the explicit-method pattern above.
  /\bgh\s+api\b[^\n]*(?:\s(?:-f|-F|--field|--raw-field|--input)\b|\bgraphql\b)/,
  // Repository-state mutations that are not `gh api` and not in the
  // pr|issue|release|repo|gist noun set.
  /\bgh\s+(?:workflow\s+run|secret\s+set|variable\s+set)\b/,
  /\b(?:npm|pnpm|yarn)\s+publish\b/,
]

/**
 * How much shell structure the scanned text is allowed to be read as.
 *
 * WHY THIS IS A PARAMETER AND NOT A CONSTANT. Two of the five shell-class
 * channels do not carry a shell command line at all:
 *
 * - `run_code`'s `code` is SOURCE in some language. `# TODO: git push` is a
 *   comment in Python and nothing in JavaScript; `"git push"` is an inert
 *   string literal until something hands it to `subprocess.run(..., shell=True)`
 *   or to a tagged template. There is no rule over the text that separates the
 *   mention from the performance, because the separation lives in code this
 *   module never sees.
 * - `terminal_send`'s `text` is keystrokes into a PTY whose foreground process
 *   is unknown to us. `#` opens a comment if a shell is reading, is a private
 *   field sigil if a Node REPL is, and is a literal if `cat` is.
 *
 * For those two the honest answer is that mention and performance CANNOT be
 * distinguished here, so they keep verbatim matching and stay over-inclusive —
 * recorded as a ceiling rather than papered over (DESIGN.md §6).
 *
 * `bash` / `pwsh` / `terminal_open` DO carry a command line, by their own
 * argument contract, and there the shell's own lexical rules say what is a
 * command and what is an argument. That is the difference this enum encodes.
 */
export type EgressScanMode = 'shell-line' | 'opaque-text'

/** The shell-class tools whose argument is definitionally a shell command line. */
const SHELL_LINE_TOOLS: readonly string[] = ['bash', 'pwsh', 'terminal_open']

/** Which reading applies to one tool's command text. Exported so a test can pin the split. */
export function egressScanModeOf(toolName: string): EgressScanMode {
  return SHELL_LINE_TOOLS.includes(toolName) ? 'shell-line' : 'opaque-text'
}

/**
 * Characters after which an unquoted `#` opens a comment.
 *
 * This is the shell's own rule — `#` comments only at the START OF A WORD — and
 * the reason it is a set rather than "any non-word character": `$#`, `${#v}`
 * and `https://x#frag` must NOT be read as comments, and each of those has its
 * `#` preceded by a character that is not in this set. Being wrong in the OTHER
 * direction is the only fail-open risk comment stripping carries, so the set is
 * deliberately small.
 */
const COMMENT_OPENS_AFTER: ReadonlySet<string> = new Set([' ', '\t', '\n', '\r', ';', '&', '|', '('])

/**
 * Command words whose whole job is to run a string of code someone hands them.
 *
 * WHY THIS LIST EXISTS — it is the trap the quoted-argument rule walks into.
 * `grep -rn "git push" docs/` and `bash -c "git push"` are the SAME TEXT SHAPE:
 * a quoted multi-word argument holding an egress phrase. What separates them is
 * entirely the semantics of the program in command position — grep treats the
 * argument as a pattern, bash executes it. No rule over the text can tell them
 * apart, so the split has to be an enumeration, and the enumeration has to fail
 * in the safe direction: when any of these words appears as a BARE word in the
 * line, the quoted-argument rule is switched OFF for that whole line and
 * matching falls back to verbatim.
 *
 * HONEST CEILING (DESIGN.md §6): a program NOT on this list that executes a
 * quoted argument (`mytool --run "git push"`, a wrapper script, a renamed
 * shell) is now allowed where it used to be denied. That is the price of the
 * fix, and it is the same enumerated-channel ceiling this module has carried
 * since v1 — a subprocess spawned inside a script was never observed either.
 * Detection runs against the SKELETON, not the raw text, so a mention inside a
 * quoted argument (`echo "run bash later"`) does not arm it.
 */
const INTERPRETER_WORD = /\b(?:bash|sh|zsh|dash|ksh|fish|pwsh|powershell|cmd|eval|python|python3|node|deno|bun|perl|ruby|php|ssh|xargs)\b/

/** Two readings of one command line, produced in a single quote-aware pass. */
interface ShellText {
  /**
   * What could be a COMMAND: comments dropped, quote characters dropped, and
   * whitespace that occurred INSIDE quotes fused to `_`.
   *
   * The fusing is the whole trick, and it is why this is not "strip quoted
   * strings". Stripping would hide `git push "origin" main`, because shell
   * quote removal makes `"origin"` the ordinary word `origin`. What quoting
   * actually decides is only whether whitespace SPLITS WORDS: `"git push"`
   * survives quote removal as ONE argument, which no program named `git` ever
   * receives as the subcommand `push`. Fusing that argument's spaces to `_`
   * destroys exactly the word boundary the patterns key on and destroys nothing
   * else — `_` is a `\w` character, so `\bgit\b` cannot match inside `git_push`.
   */
  readonly skeleton: string
  /** Comments dropped, everything else verbatim — the fallback when an interpreter is present. */
  readonly literal: string
}

/**
 * Read one command line under the shell's lexical rules, far enough to answer
 * "which of these characters could be a command word".
 *
 * NOT a shell parser, and it does not try to be: no expansion, no substitution,
 * no heredoc bodies, and no backslash escapes — a `\` outside quotes is left in
 * place, which keeps `git\ push` matching (over-inclusive, i.e. fail-closed)
 * and keeps a Windows path in a `pwsh` line from being rewritten out from under
 * the matcher. An unterminated quote runs to the end of the text, which puts
 * its contents in the skeleton: the fail-closed direction.
 */
function readShellText(command: string): ShellText {
  let skeleton = ''
  let literal = ''
  let quote = ''
  for (let index = 0; index < command.length; index++) {
    const char = command[index] as string
    if (quote === '') {
      if (char === "'" || char === '"') {
        quote = char
        literal += char
        continue
      }
      if (char === '#' && (index === 0 || COMMENT_OPENS_AFTER.has(command[index - 1] as string))) {
        // A comment runs to the end of its line; the newline itself is KEPT,
        // because `[^\n&|;]*` in the git pattern relies on it to stop two
        // unrelated lines fusing into one match.
        while (index < command.length && command[index] !== '\n') index++
        index--
        continue
      }
      skeleton += char
      literal += char
      continue
    }
    literal += char
    if (char === quote) {
      quote = ''
      continue
    }
    skeleton += /\s/.test(char) ? '_' : char
  }
  return { skeleton, literal }
}

/**
 * The fail-closed egress refusal.
 *
 * A single constant because THREE seams must say the same thing about the same
 * decision: `decideTool` when no pre-execute seam is installed, and the two
 * guard installers in `./install.ts` when the snapshot read itself throws. Two
 * spellings of one refusal would let a test observe one of them and report the
 * boundary closed.
 *
 * WHAT THE WORDING SAYS, AND WHY IT CHANGED (2026-08-25). It used to assert
 * that "this command mutates remote/public state". That is a claim about the
 * COMMAND, and the matcher cannot support it. The refusal says what was
 * actually observed — a TEXT match — because the string is shipped output a
 * human reads, and a recorded ceiling the product contradicts in its own output
 * is not recorded.
 *
 * SECOND REVISION, same day. The tail used to promise that "a quoted or
 * commented occurrence inside an otherwise ordinary command is refused too".
 * On a shell command line that is no longer true — `#` comments and the
 * contents of multi-word quoted arguments are excluded before matching — and a
 * refusal that overstates its own REACH is the same defect as one that
 * overstates the command's EFFECT. The tail now states the rule that runs,
 * including the two channels where verbatim matching survives.
 */
export const EGRESS_FAIL_CLOSED_REASON =
  'autopilot owner-only boundary: this command TEXT matches the owner-only egress command class (push, PR, release, publish) and the native pre-execute seam that validates the outbound evidence manifest is not installed on this call. Egress is refused unconditionally (fail-closed). The match is textual, over a command-shaped reading: on a bash/pwsh/terminal_open command line, "#" comments and the contents of multi-word quoted arguments are excluded first, but a line that hands a string to an interpreter (bash -c, sh -c, ssh, python, xargs, ...) is matched verbatim; for run_code and terminal_send the text is not a shell command line at all, so it is matched verbatim and a mere mention is refused too (DESIGN.md §6).'

/** Subagent-control tools that could drive a child directly. */
const CHILD_CONTROL_TOOLS: readonly string[] = ['send_message', 'interrupt_agent']

/** N-valued gate decision. */
export type GateDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'allow-degraded'; readonly note: string }
  | { readonly kind: 'defer-egress'; readonly note: string }
  | { readonly kind: 'deny-plan-gate'; readonly reason: string }
  | { readonly kind: 'deny-usage-undeclared'; readonly reason: string }
  | { readonly kind: 'deny-egress'; readonly reason: string }
  | { readonly kind: 'deny-executor-bypass'; readonly reason: string }

export interface GateConfig {
  readonly toolDeny: boolean
  readonly egressDeny: boolean
  readonly strictShell: boolean
  /**
   * Which seam is actually enforcing egress for this mount, resolved at
   * install time and recorded in `Enforcement.egress`.
   *
   * 'native-ask' — `./preexecute.ts` installed: the guard DEFERS, because a
   * monotonic guard denial would silently veto the human's approval.
   * 'guard-deny' — the seam could not be installed: the guard denies every
   * egress unconditionally, fail-closed.
   * 'off' — `egressDeny: false`, the owner disabled the boundary.
   */
  readonly egressSeam: EgressChannel
}

/**
 * Extract the command-ish text from a shell-class tool call.
 *
 * Three argument keys, because the three channels spell it differently:
 * `run_code` carries `code`, bash/pwsh/`terminal_open` carry `command`, and
 * `terminal_send` carries `{ sessionId, text }`. A gate that knew only
 * `command` read `terminal_send` as "no command text" and passed it straight
 * through — the whole PTY channel, unscanned.
 */
export function commandTextOf(toolName: string, args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  if (toolName === 'run_code') return typeof record.code === 'string' ? record.code : undefined
  if (typeof record.command === 'string') return record.command
  if (typeof record.text === 'string') return record.text
  return undefined
}

/**
 * Whether a command matches the owner-only egress class.
 *
 * A backslash-newline is normalised to a space FIRST. `\bgit\b[^\n&|;]*\bpush\b`
 * excludes `\n` from the gap on purpose (so two unrelated commands on two lines
 * do not fuse into a match), which meant a shell line continuation split one
 * genuine `git … push` across the boundary and evaded it. Joining the
 * continuation is what the shell itself does before executing.
 *
 * THE ALLOW DIRECTION (2026-08-25, measured). Until this round the answer was
 * a raw `RegExp.test` over the text, so a phrase appearing as DATA counted as a
 * phrase being PERFORMED. Eight ordinary commands were measured denied on a
 * gated run: `grep -rn "git push" docs/`, `cat "notes/git push.md"`,
 * `git commit -m "docs: explain why we git push"` (a purely local commit),
 * `git diff HEAD~1 -- "src/**" # no push here` (denied by a trailing COMMENT),
 * `# git push origin main` (an entirely commented-out line),
 * `jq '.scripts["npm publish"]' package.json`, `history | grep 'git send-email'`
 * and `rg --fixed-strings "npm publish" .`. Under `egressSeam: 'guard-deny'`
 * each is refused outright; under `'native-ask'` each escalates to a human for
 * a read. The deny direction is the safety property and the allow direction is
 * a usability property, so the tightening is confined to two things that
 * PROVABLY cannot execute on a shell command line — text after an unquoted `#`,
 * and the interior word boundaries of a multi-word quoted argument — plus the
 * {@link INTERPRETER_WORD} escape hatch that hands the whole line back to
 * verbatim matching the moment something on it could run a string.
 *
 * `mode` decides which reading applies; see {@link EgressScanMode} for why two
 * of the five channels do not get one.
 */
export function isEgressCommand(command: string, mode: EgressScanMode = 'shell-line'): boolean {
  const joined = command.replace(/\\\r?\n/g, ' ')
  const matches = (text: string): boolean => EGRESS_PATTERNS.some(pattern => pattern.test(text))
  if (mode === 'opaque-text') return matches(joined)
  const { skeleton, literal } = readShellText(joined)
  // An interpreter on the line means a quoted argument may be code, so the
  // command-shaped reading is abandoned rather than trusted.
  if (INTERPRETER_WORD.test(skeleton)) return matches(literal)
  return matches(skeleton)
}

/**
 * The shell separators one command line may chain several commands with.
 *
 * ORDER IS LOAD-BEARING: `&&` is listed before `&` and `||` before `|`, so the
 * alternation cannot split a two-character separator into two empty halves. A
 * backslash-newline is joined before splitting, for the same reason
 * {@link isEgressCommand} joins it: the shell joins it too.
 *
 * The single `&` is here because backgrounding chains just as well as `&&` does
 * — `git push origin main & npm publish` runs both — and the git-push pattern
 * excludes `&` from its gap, so without this entry the whole line matched the
 * push declaration and the publish rode along undeclared.
 *
 * HONEST CEILING (DESIGN.md §6): this is text splitting, not shell parsing. A
 * separator inside quotes splits anyway (fail-closed), and a chaining construct
 * that uses none of these characters — command substitution, `xargs`, a
 * subprocess inside a script — is not segmented at all. That last case is the
 * enumerated-class ceiling this module has carried since v1, not a new one.
 */
const SEGMENT_SEPARATORS = /&&|\|\||;|\||&|\r?\n/

/**
 * Every EGRESS-CLASSIFIED segment of one command line.
 *
 * WHY THIS EXISTS (2026-08-25 independent repair audit). Authorization — the
 * outbound manifest's command-class rule and the owner approval's target rule
 * alike — used to ask "does the declared entry appear somewhere in this
 * command". That question is answerable YES by a command that carries a
 * SECOND, undeclared egress of a different class: a push-only manifest plus a
 * push-only owner approval authorized `git push origin main && npm publish`,
 * and the owner was never asked about the publish. The invariant both sites
 * state — authorization is per-command-class, not blanket — was false.
 *
 * The question that has to be answered instead is "is EVERY egress element of
 * this command covered", so the command is split first and each egress segment
 * is authorized on its own. A non-egress segment (`cd repo`, `pnpm build`) is
 * not an egress and needs no declaration; that is what keeps `cd repo && git
 * push` working.
 *
 * FAIL-CLOSED TAIL: if the whole line classifies as egress but no individual
 * segment does — a shape the splitter did not anticipate — the whole line is
 * returned as one segment, so it must be covered in full rather than slipping
 * through an empty list.
 */
export function egressSegments(command: string, mode: EgressScanMode = 'shell-line'): readonly string[] {
  const joined = command.replace(/\\\r?\n/g, ' ')
  const segments = joined
    .split(SEGMENT_SEPARATORS)
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0 && isEgressCommand(segment, mode))
  if (segments.length === 0 && isEgressCommand(joined, mode)) return [joined.trim()]
  return segments
}

/**
 * The egress command text of one tool call, or undefined when the call is not
 * a shell-class call in the egress command class.
 *
 * Exported because three call sites need exactly this question answered the
 * same way: `decideTool`, the pre-execute seam's `egressCommandOf`, and the
 * guards' fail-closed catch — which must classify the call WITHOUT reading the
 * snapshot, since a throwing snapshot read is precisely the case it handles.
 */
export function egressCommandOf(toolName: string, args: unknown): string | undefined {
  if (!SHELL_TOOLS.includes(toolName)) return undefined
  const command = commandTextOf(toolName, args)
  if (command === undefined || !isEgressCommand(command, egressScanModeOf(toolName))) return undefined
  return command
}

/** Whether the call is a file mutation the plan gate and usage gate both govern. */
function isMutation(toolName: string, args: unknown): boolean {
  if (MUTATION_TOOLS.includes(toolName)) return true
  if (toolName !== 'str_replace_editor') return false
  return (args as Record<string, unknown> | null)?.command !== 'view'
}

/**
 * Decide one tool execution against the run snapshot.
 *
 * `defer-egress` is a decision VALUE rather than a plain allow so a test can
 * prove the guard stood down deliberately, and not because the egress matcher
 * failed to fire.
 */
export function decideTool(
  snapshot: Snapshot | undefined,
  toolName: string,
  args: unknown,
  config: GateConfig,
): GateDecision {
  // No run, or a finished run: the harness does not gate (CC fail-open parity).
  if (snapshot === undefined || TERMINAL_PHASES.includes(snapshot.phase)) return { kind: 'allow' }

  // Owner-only egress boundary is absolute across sizes and phases.
  // Routed through `egressCommandOf` rather than re-spelling
  // `commandTextOf` + `isEgressCommand` inline: the per-channel scan mode is a
  // second thing the two spellings could disagree about, and a guard that
  // classified `run_code` under shell rules while the pre-execute seam
  // classified it verbatim would deny and defer the same call differently.
  if (config.egressDeny && SHELL_TOOLS.includes(toolName)) {
    const command = egressCommandOf(toolName, args)
    if (command !== undefined) {
      if (config.egressSeam === 'native-ask') {
        return {
          kind: 'defer-egress',
          note: 'outbound manifest validation and owner approval are handled by the tools/pre-execute seam',
        }
      }
      // DELIBERATE BEHAVIOR CHANGE vs v1: without the pre-execute seam this
      // denies unconditionally instead of consuming a stored owner approval.
      // A synchronous guard cannot read and validate the outbound evidence
      // manifest, so allowing an egress here would authorize it on strictly
      // less evidence than v2 promises. Fail-closed is the honest reading.
      return { kind: 'deny-egress', reason: EGRESS_FAIL_CLOSED_REASON }
    }
  }

  // Single control loop: while a delegated executor is authorized, generic
  // child-control tools must not drive it — autopilot_executor (resume gated
  // on a needs-fix audit) is the only sanctioned channel. Matching is by the
  // executor childId appearing anywhere in the call arguments.
  if (snapshot.executor !== undefined
    && (snapshot.executor.state === 'running' || snapshot.executor.state === 'starting')
    && CHILD_CONTROL_TOOLS.includes(toolName)) {
    const argsText = JSON.stringify(args ?? {})
    if (argsText.includes(snapshot.executor.childId)) {
      return {
        kind: 'deny-executor-bypass',
        reason: `autopilot single-control-loop rule: "${toolName}" may not target the authorized executor child directly. Use autopilot_executor action=resume (requires a needs-fix execution audit) or autopilot_signal action=replan.`,
      }
    }
  }

  // Plan-gate clamp: standard runs only (CC: lightweight runs are not gated).
  if (config.toolDeny && snapshot.triage.size === 'standard' && snapshot.planGate !== 'pass') {
    if (MUTATION_TOOLS.includes(toolName)) {
      return {
        kind: 'deny-plan-gate',
        reason: `autopilot plan gate is ${snapshot.planGate}: file mutations are blocked until the plan audit passes (phase ${snapshot.phase}). Submit a plan and pass the plan audit first.`,
      }
    }
    if (toolName === 'str_replace_editor') {
      const command = (args as Record<string, unknown> | null)?.command
      if (command !== 'view') {
        return {
          kind: 'deny-plan-gate',
          reason: `autopilot plan gate is ${snapshot.planGate}: str_replace_editor "${String(command)}" is blocked until the plan audit passes (only "view" is allowed).`,
        }
      }
    }
    if (SHELL_TOOLS.includes(toolName)) {
      if (snapshot.enforcement.sandbox === 'active') {
        // The OS sandbox holds the session read-only; shell stays available for investigation.
        return { kind: 'allow' }
      }
      if (config.strictShell) {
        return {
          kind: 'deny-plan-gate',
          reason: `autopilot plan gate is ${snapshot.planGate} and the sandbox coupling is ${snapshot.enforcement.sandbox}: shell is blocked pre-plan-gate (strictShell). Pass the plan audit first.`,
        }
      }
      return {
        kind: 'allow-degraded',
        note: `sandbox coupling is ${snapshot.enforcement.sandbox}; shell allowed pre-plan-gate without OS confinement (documented CC-style blind spot, fail-open)`,
      }
    }
  }

  // Usage-declaration clamp.
  //
  // KEYED OFF THE DIMENSION, NOT THE SIZE. It used to read
  // `triage.size === 'standard'`, justified by "lightweight runs never carry a
  // usage dimension at all" — but `autopilot_usage` has no size gate and
  // `declareUsage` builds from `prior.usage?.entries ?? []`, so a lightweight
  // run can CREATE the dimension, after which the ENGINE refuses the plan gate
  // for an undeclared entry (`usageDeclarationProblems` is size-blind) while
  // this guard exempted every mutation by size. Two layers disagreeing about
  // the same run is the defect; asking `does this run have a usage dimension`
  // is the question both layers already answer the same way.
  //
  // This outlives the plan gate on purpose: a run may declare a NEW milestone
  // entry mid-execution, and an entry that says `undeclared` is a change whose
  // user-visibility nobody has answered for. Blocking mutations is what makes
  // answering cheaper than not answering.
  if (config.toolDeny && snapshot.usage !== undefined) {
    const undeclared = snapshot.usage.entries.filter(entry => entry.usageClass === 'undeclared')
    if (undeclared.length > 0) {
      const names = undeclared.map(entry => entry.id).join(', ')
      const reason = `autopilot usage gate: ${undeclared.length} usage entry/entries are still undeclared (${names}). Declare each with autopilot_usage (class gui|cli|api-behavior|internal|docs|harness|unsupported) before mutating files.`
      if (isMutation(toolName, args)) return { kind: 'deny-usage-undeclared', reason }
      // SHELL PARITY WITH THE PLAN-GATE CLAMP ABOVE. Without this branch a run
      // holding an undeclared entry was denied `write` and `edit` and then
      // mutated the same workspace through `bash` — the clamp read as a
      // workspace boundary and was a three-tool-name boundary. The ladder is
      // the plan gate's, for the same reason: an OS sandbox holding the
      // session read-only already enforces what this clamp is trying to say,
      // and shell stays available for investigation when it does.
      if (SHELL_TOOLS.includes(toolName)) {
        if (snapshot.enforcement.sandbox === 'active') return { kind: 'allow' }
        if (config.strictShell) {
          return {
            kind: 'deny-usage-undeclared',
            reason: `${reason} (sandbox coupling is ${snapshot.enforcement.sandbox}: shell is blocked while usage is undeclared, strictShell)`,
          }
        }
        return {
          kind: 'allow-degraded',
          note: `sandbox coupling is ${snapshot.enforcement.sandbox}; shell allowed with ${undeclared.length} undeclared usage entry/entries and no OS confinement (documented fail-open, DESIGN.md §6)`,
        }
      }
    }
  }

  return { kind: 'allow' }
}
