/**
 * dsh-autopilot domain vocabulary: run identity, triage, snapshot, events.
 *
 * Design lineage: the CC goal-autopilot-harness state.json contract, rebuilt
 * as an event-sourced snapshot stream (the pattern proven by dsh's
 * experimental GAH package, reimplemented independently here).
 */

/** One autopilot run is rooted at one top-level Session; its id is the run id. */
export type RunId = string

/** Run size class. Lightweight runs skip mechanical enforcement (CC parity). */
export type Size = 'lightweight' | 'standard'

/** Risk classification, straight from the CC harness. */
export type Risk = 'low' | 'medium' | 'high' | 'critical'

/** WHO implements: the root context inline, or a dispatched continuable executor child. */
export type ExecutionMode = 'inline' | 'delegated'

/**
 * HOW gates are audited. `self-check` is only legal for lightweight+low and is
 * labeled honestly in the record. `external` is reserved (rejected at init in v1).
 */
export type AuditMode = 'self-check' | 'independent' | 'external'

/** Run phase. `closing` is new versus the CC vocabulary: executionGate pass lands here, `completed` requires a validated closeout. */
export type Phase =
  | 'planning'
  | 'plan-reviewing'
  | 'executing'
  | 'execution-reviewing'
  | 'replanning'
  | 'closing'
  | 'completed'
  | 'blocked'
  | 'needs-owner-decision'

/** Plan gate states (CC enum). */
export type PlanGate = 'pending' | 'pass' | 'needs-replan' | 'blocked' | 'needs-owner-decision'

/** Execution gate states (CC enum; adds needs-fix over the plan gate). */
export type ExecutionGate =
  | 'pending'
  | 'pass'
  | 'needs-fix'
  | 'needs-replan'
  | 'blocked'
  | 'needs-owner-decision'

/** Auditor verdict enum (union of both gates' decision spaces). */
export type Verdict = 'pass' | 'needs-fix' | 'needs-replan' | 'blocked' | 'needs-owner-decision'

/** Audit roles. `rules` is required when the run touches the operating layer or risk is high/critical. */
export type AuditRole = 'plan' | 'execution' | 'rules'

/** CC four-cell execution stance for log checkpoints. */
export type Stance = 'on-plan' | 'detour' | 'grind' | 'escalate'

/** Escalation target for `escalate` checkpoints. */
export type EscalationTarget = 'root-agent' | 'stronger-model' | 'owner' | 'external-review'

/** Blocking scope for `escalate` checkpoints. */
export type BlockingScope = 'none' | 'subtask' | 'milestone' | 'run'

/** Terminal phases: no operation may follow (needs-owner-decision is resumable, not terminal). */
export const TERMINAL_PHASES: readonly Phase[] = ['completed', 'blocked']

/** Protocol constant, not config: consecutive needs-replan rounds before forced owner escalation. */
export const MAX_REPLAN_ROUNDS = 2

/** Protocol constant, not config: turn-stop reminders per run before self-release. */
export const MAX_STOP_REMINDERS = 3

/**
 * Whether a dispatch achieved cross-family review, recorded per audit.
 *
 * `unknown-family` is what keeps this honest, and the reason the outcome is
 * four-valued rather than a boolean: when either side inherits the deployment
 * default (no `agentOptions`), this code CANNOT see which family it got, so it
 * must not claim `achieved`. Every previous "is the mechanism on?" field here
 * had to learn that lesson the expensive way (`enforcement.sandbox`,
 * `enforcement.approval`); this one is born knowing it.
 */
export type CrossFamilyOutcome = 'not-required' | 'achieved' | 'same-family' | 'unknown-family'

/** Provider/model route provenance for a dispatched child (auditor or executor). */
export interface RouteRecord {
  /** Subagent transport provider, or the literal 'self-check'. */
  readonly provider: string
  readonly routeProvider: string
  readonly routeModel: string
  readonly routeStatus: 'verified' | 'unverified'
  readonly routeDiagnostic?: string
  /**
   * Whether this dispatch reviewed from outside the builder's family. Absent on
   * routes where the question does not arise (self-check, external countersign,
   * the executor's own record).
   */
  readonly crossFamily?: CrossFamilyOutcome
}

/**
 * An owner-countersigned external review (`auditMode: 'external'`).
 *
 * HONEST CEILING, and the reason this shape exists at all: for `independent`
 * the harness DISPATCHED the auditor, so provenance is structural — nothing a
 * model says can forge it. For `external` a human types the verdict, and no
 * mechanism here can verify the review happened, that the named reviewer wrote
 * it, or that they read the same tree. What CAN be mechanized is refusing a
 * countersign that attaches nothing: `reviewRef` must name an artifact that
 * resolves INSIDE the run directory and is non-empty at completion, exactly
 * like a usage artifact. So this channel does not lower the bar to "an owner
 * said so"; it lowers it to "an owner said so AND left the review on disk".
 * Every downstream reader must treat an external pass as weaker than a
 * dispatched one — which is why the record keeps them distinguishable rather
 * than flattening both into `route.provider`.
 */
export interface ExternalReview {
  /** Who countersigned. Free text: the harness cannot verify identity, and says so. */
  readonly reviewer: string
  /** Run-directory-relative path to the review itself. Settled at completion. */
  readonly reviewRef: string
  /**
   * OPTIONAL: the work-tree the reviewer says they read, as a hash they
   * DECLARE.
   *
   * SAME TRUST CLASS AS `triage.baseline.commit`, AND FOR THE SAME REASON: this
   * package contains no `child_process` and no git, and a run records no work
   * tree at all, so the engine cannot MEASURE a tree hash to compare against.
   * Anything stored here is a string a human typed. Calling it "verified"
   * anywhere would be the exact over-claim the rest of this file exists to
   * prevent.
   *
   * WHAT IT NEVERTHELESS BUYS. The countersign channel's honest ceiling was
   * "an owner said so AND left the review on disk"; it could not say WHICH tree
   * the review was about. With this field the record carries the reviewer's own
   * answer to that question, and two DECLARATIONS can be compared with each
   * other even though neither can be checked against reality: a treeHash that
   * differs from `triage.baseline.commit` is surfaced as a diagnostic on the
   * audit's route record (see `AutopilotEngine.recordExternalAudit`). That is
   * deliberately INFORMATION and never a refusal — a run's tree legitimately
   * moves while the run is executing, so a mismatch is the normal case for an
   * execution-role countersign and only a reader can judge it.
   *
   * ABSENT IS LEGAL and is the default: every v1/v2 stream replays without it,
   * and a reviewer who did not record a hash must not be forced to invent one.
   */
  readonly treeHash?: string
}

/** One audit record. Provenance is in-band: the engine itself dispatched the auditor and received the structured verdict. */
export interface AuditRecord {
  readonly role: AuditRole
  /** 0-based append-only sequence. */
  readonly seq: number
  /** Run revision captured when the audit was started. */
  readonly runRevision: number
  /** Plan revision captured when the audit was started. */
  readonly planRevision: number
  /** Execution revision captured when the audit was started (0 before any executor/evidence). */
  readonly executionRevision: number
  /** Auditor child session id, or 'self-check'. */
  readonly auditorId: string
  readonly verdict: Verdict
  readonly note: string
  readonly route: RouteRecord
  /**
   * Present ONLY on an owner-countersigned external review. Its presence is
   * what distinguishes an external pass from a dispatched one at every reader;
   * `route.provider` alone would flatten them.
   */
  readonly external?: ExternalReview
}

/** Executor authorization record (delegated mode only). */
export interface ExecutorRecord {
  readonly childId: string
  readonly generation: number
  /**
   * Incremented on each needs-fix resume. Packet submission CASes on it:
   * `submitExecutionPacket` requires `executionRevision` equal to this value
   * and the fold refuses a `submit-packet` whose stamped detail disagrees.
   */
  readonly executionRevision: number
  readonly state: 'starting' | 'running' | 'completed' | 'revoked'
  readonly route: RouteRecord
}

/** Workspace baseline recorded at triage (CC Workspace Gate, self-declared and auditable). */
export interface Baseline {
  readonly commit?: string
  readonly branch?: string
  readonly dirty?: boolean
  readonly note?: string
}

/** One execution-log checkpoint (CC execution-log.md entry, made durable). */
export interface LogEntry {
  readonly seq: number
  readonly text: string
  readonly stance: Stance
  readonly note?: string
  readonly escalationTarget?: EscalationTarget
  readonly blockingScope?: BlockingScope
}

/** Evidence mapping for one acceptance criterion (CC Single-Bearer rule, field-ized). */
export interface EvidenceEntry {
  /** The acceptance criterion, verbatim. */
  readonly criterion: string
  /** The single bearing artifact (command output, file, diff, test run). Empty only when unproven. */
  readonly bearer: string
  /** 'proven' requires a non-empty bearer; an honest gap is 'unproven'. */
  readonly status: 'proven' | 'unproven'
  /**
   * What the bearer IS, so reverse Single-Bearer stops guessing.
   *
   * 'path' folds through {@link canonicalBearer} against `snapshot.bearerBase`;
   * 'command' is compared verbatim (after `trim()`) and is NEVER folded, so
   * `git status` and `./git status` stay two bearers.
   *
   * OPTIONAL AT THE TYPE LEVEL ON PURPOSE, and it is not laxity: `unproven`
   * entries carry no claim to classify, and streams written before this field
   * existed must still replay. Which of the two an absent `kind` means is
   * decided by the format stamp on the `submit-closeout` event, not by this
   * type — see {@link evidenceKindProblems}. Current-format WRITES require it.
   */
  readonly kind?: EvidenceKind
  readonly note?: string
}

/**
 * How a proven bearer is compared. An explicit field rather than a shape
 * heuristic: the heuristic split flipped twice under review (a spaced
 * extensionless filename and a spaced command are the same string shape), and
 * every flip moved a real closeout from "accepted" to "rejected as reused" or
 * back. The writer knows which it produced; the reader cannot.
 */
export type EvidenceKind = 'path' | 'command'

/** One `kind` defect, carrying the error code the write paths raise for it. */
export interface EvidenceKindProblem {
  readonly code: 'AP_EVIDENCE_KIND_REQUIRED' | 'AP_EVIDENCE_KIND_INVALID'
  readonly message: string
}

/**
 * Problems with the `kind` field of a closeout's evidence entries.
 *
 * Shared by all three seams that must agree — `evaluateCompletion` (the
 * structural check), `applyEvent` (replay of a stamped stream) and
 * `AutopilotEngine.submitCloseout` (the write) — so a stream cannot be legal
 * in one and illegal in another.
 *
 * An UNKNOWN kind is a problem regardless of `requireKind`: a string that is
 * neither 'path' nor 'command' is a corrupt entry, not an old one. A MISSING
 * kind on a PROVEN entry is a problem only under `requireKind`, which is what
 * the `evidenceKinds` stamp turns on; an unproven entry may omit it at this
 * layer (the tool schema above is stricter and requires it on every item).
 */
export function evidenceKindProblems(
  evidence: readonly EvidenceEntry[],
  options: { readonly requireKind: boolean } = { requireKind: false },
): readonly EvidenceKindProblem[] {
  const problems: EvidenceKindProblem[] = []
  for (const entry of evidence) {
    const kind: unknown = entry.kind
    if (kind === undefined) {
      // PROVEN entries only, by owner ruling (2026-09-04, CodeRabbit thread
      // on PR #5 declined): an unproven entry bears no artifact and has no
      // bearer to classify, so forcing a `kind` onto it would be a fiction.
      // The three layers are deliberately different in strictness:
      //   tool schema  — `kind` required on EVERY item (stricter call surface);
      //   engine/replay — `kind` semantically required on PROVEN items only;
      //   evidenceKinds: 1 — "proven evidence kind validation v1", NOT
      //                      "every item carries a non-empty kind".
      if (options.requireKind && entry.status === 'proven') {
        problems.push({
          code: 'AP_EVIDENCE_KIND_REQUIRED',
          message: `proven evidence entry has no kind: ${entry.criterion} (kind must be "path" or "command")`,
        })
      }
      continue
    }
    if (kind !== 'path' && kind !== 'command') {
      problems.push({
        code: 'AP_EVIDENCE_KIND_INVALID',
        message: `evidence kind is not "path" or "command": ${entry.criterion} ("${String(kind)}")`,
      })
    }
  }
  return problems
}

/** Structured closeout (CC Phase 5 contract). Completion is refused without it. */
export interface Closeout {
  readonly summary: string
  readonly changedFiles: readonly string[]
  readonly commands: readonly string[]
  readonly evidence: readonly EvidenceEntry[]
  readonly residualRisks: readonly string[]
  readonly exclusions: readonly string[]
  readonly workspaceCleanup: string
  /** Prompt/workspace drift: 'none found' or exact facts to update upstream. */
  readonly drift: string
}

/** One owner egress approval (v1 stand-in for the CC outbound evidence manifest). */
export interface OwnerApproval {
  readonly seq: number
  /** Human description of the approved egress. */
  readonly target: string
  /** Revision at which it was granted. */
  readonly grantedAtRevision: number
  /** Set when an egress consumed it; an approval authorizes exactly one egress. */
  readonly consumedBy?: string
}

/**
 * Usage-evidence class (CC schema-9 dimension). The harness verifies that code
 * builds and passes tests; it never verified that a user-visible change was
 * OPERATED by anyone. `undeclared` is the entry state and blocks the plan gate.
 * `unsupported` is an honest TERMINAL, not a failure.
 */
export type UsageClass =
  | 'gui' | 'cli' | 'api-behavior'
  | 'internal' | 'docs'
  | 'harness'
  | 'unsupported'
  | 'undeclared'

/** Classes that changed a human-observable surface: artifact required, >=2 boundary states. */
export const USAGE_VISIBLE_CLASSES: readonly UsageClass[] = ['gui', 'cli', 'api-behavior']

/**
 * Canonical boundary-state menu (CC `BOUNDARY_MENU`, ported verbatim). A
 * user-visible class needs >=2 declared states with >=1 drawn from this menu.
 */
export const BOUNDARY_MENU: readonly string[] = [
  'empty', 'full', 'at-top', 'at-bottom', 'extreme-value', 'interrupted',
  'narrow-window', 'first-run', 'permission-denied', 'offline', 'fallback',
  'long-running', 'concurrent', 'error-path',
]

/** Usage artifact kinds. `test-run` is the kind the `harness` class requires. */
export type UsageArtifactKind =
  | 'screenshot' | 'screencast' | 'session-log' | 'http-trace' | 'device-log' | 'test-run'

/** Binary artifact kinds settle on a format signature; the rest settle on covered-label text. */
export const BINARY_ARTIFACT_KINDS: readonly UsageArtifactKind[] = ['screenshot', 'screencast']

/** One usage artifact. `ref` resolves relative to the run directory. */
export interface UsageArtifact {
  readonly kind: UsageArtifactKind
  /** Run-directory-relative path. Containment is enforced at settlement. */
  readonly ref: string
  /** Boundary-state (or claim) labels this artifact bears. */
  readonly covers: readonly string[]
  /** ISO-8601 UTC capture time; must post-date `planGatePassedAt`. */
  readonly capturedAt: string
  /** `<run-id>/<ref>` citing a prior run's artifact; exempt from containment and freshness. */
  readonly inheritedFrom?: string
}

/** One usage-evidence entry. User-visibility is per-change, so entries are a LIST. */
export interface UsageEntry {
  readonly id: string
  readonly usageClass: UsageClass
  readonly boundaryStates: readonly string[]
  readonly artifacts: readonly UsageArtifact[]
  /** Required (with a non-empty `attempted`) for the `unsupported` terminal. */
  readonly unsupportedReason?: string
  readonly attempted: readonly string[]
}

/**
 * The run's usage-evidence dimension. ABSENT means a legacy (v1) stream that
 * predates the dimension: exempt, exactly like CC's `legacy_migrated`. An
 * empty `entries` list is NOT exempt — it is a run that declared nothing.
 */
export interface UsageEvidence {
  readonly entries: readonly UsageEntry[]
}

/** One claim asserted in outbound text, with the artifact that bears it. */
export interface OutboundClaim {
  readonly text: string
  /** Artifact ref (run-directory-relative) that can be observed to be false. */
  readonly bearer: string
}

/** One artifact referenced by an outbound manifest. */
export interface OutboundArtifact {
  readonly ref: string
  readonly covers: readonly string[]
}

/**
 * Outbound evidence manifest (CC `<run>/outbound/manifest.json`, ported).
 * Validated before any egress command may even ASK the owner for approval.
 */
export interface OutboundManifest {
  readonly v: 1
  /** Must equal the live run id: a manifest cannot shed one run's obligations onto another. */
  readonly runId: string
  readonly target: string
  /** Command substrings this manifest authorizes; the egress command must match one. */
  readonly commands: readonly string[]
  readonly claims: readonly OutboundClaim[]
  readonly artifacts: readonly OutboundArtifact[]
  /** ISO-8601 UTC; older than OUTBOUND_STALE_MS is refused. */
  readonly createdAt: string
}

/**
 * Protocol constant, not config: tolerance for a timestamp that sits slightly
 * AHEAD of the clock reading it. Wall clocks disagree, and an artifact captured
 * moments before closeout can legitimately carry a stamp a few hundred ms in
 * the future. Shared by the outbound manifest's `createdAt` upper bound and the
 * usage artifact's `capturedAt` upper bound so the two cannot drift apart — an
 * asymmetry between those siblings is what let the usage upper bound ship
 * inert, then fail on ordinary jitter the moment it was wired up (2026-08-25).
 * Wide enough for skew, far narrower than any plausible fabrication: a stamp
 * months ahead is still refused.
 */
export const FUTURE_SKEW_MS = 60_000

/**
 * Specificity floor for a usage/outbound `covers` label, in trimmed characters.
 * Shorter labels make the mention check unable to observe a miss (`a` is in any text).
 */
export const MIN_COVERS_LABEL_LENGTH = 3

/** Problems for covers labels that cannot fail a mention check. Disk-free; call before settlement early-returns. */
export function coversFloorProblems(where: string, covers: readonly string[]): string[] {
  const problems: string[] = []
  for (const covered of covers) {
    const needle = covered.trim()
    if (needle.length < MIN_COVERS_LABEL_LENGTH) {
      problems.push(
        `${where}: covers label is too unspecific ("${needle}"): a covers label needs >=${String(MIN_COVERS_LABEL_LENGTH)} characters, or the mention check cannot observe a miss`,
      )
    }
  }
  return problems
}

function isUncName(segment: string | undefined): segment is string {
  return segment !== undefined && segment.length > 0 && segment !== '.' && segment !== '..'
}

function collapseBearerSegments(body: string, absolute: boolean): string[] {
  const parts: string[] = []
  for (const segment of body.split('/')) {
    if (segment.length === 0 || segment === '.') continue
    if (segment === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      else if (!absolute) parts.push('..')
      continue
    }
    parts.push(segment)
  }
  return parts
}

function isAbsoluteBearer(s: string): boolean {
  return s.startsWith('//') || s.startsWith('/') || /^[A-Za-z]:\//.test(s)
}

/** True after slash-fold for POSIX `/`, UNC `//`, and Windows `X:/` (so `C:\work` counts). */
export function isAbsoluteShapedBearer(raw: string): boolean {
  return isAbsoluteBearer(raw.replaceAll('\\', '/'))
}

/**
 * True when a proven bearer should go through canonicalBearer, including spaced paths.
 *
 * THE LEGACY ARM. Since {@link EvidenceEntry.kind} exists this runs only for an
 * entry that declares no kind, i.e. one written before the field existed. It is
 * a shape guess and cannot be made right — `my report` and `git status` are the
 * same shape — which is exactly why the declared kind supersedes it. Do not
 * tune it further; tuning it is what flipped the classification twice.
 */
function isPathShapedBearer(raw: string): boolean {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return false
  if (!/\s/.test(trimmed)) return true
  if (
    trimmed.startsWith('/')
    || trimmed.startsWith('\\')
    || trimmed.startsWith('./')
    || trimmed.startsWith('../')
    || /^[A-Za-z]:/.test(trimmed)
  ) return true
  const first = trimmed.split(/\s+/).find(token => token.length > 0) ?? ''
  if (first.includes('/') || first.includes('\\')) return true
  const rest = trimmed.slice(first.length).trim()
  if (/[\\/]/.test(rest)) {
    const beforeSep = rest.split(/[\\/]/, 1)[0] ?? ''
    return !/\s/.test(beforeSep)
  }
  return rest.length > 0
}

/**
 * True when this bearer/cwd pair is to be read with Windows path rules.
 *
 * A leading `//` on the BEARER is deliberately NOT one of the signals. On a
 * POSIX host `//workspace/report.txt` and `/workspace/report.txt` are the same
 * file (POSIX leaves a leading `//` implementation-defined and Node resolves
 * both to one path), so treating the first as a UNC `\\workspace\report.txt`
 * let one artifact bear two criteria under two spellings. `\\` still says
 * Windows, because a backslash cannot be a POSIX separator; so does a
 * drive-qualified or UNC CWD, which is what makes `//server/share/x` still UNC
 * for a run rooted on Windows.
 *
 * LEGACY ARM (Codex 3932312256 on PR #5): an EMPTY cwd means a snapshot with
 * no `bearerBase` — fold refuses an empty base (`AP_BEARER_BASE_EMPTY`) and
 * `resolveBearerBase` never stamps one, so `''` is reachable only from streams
 * written before `bearerBase` existed. Those streams were folded with a raw
 * leading `//` read as UNC; a closeout that legitimately cited
 * `//server/share/x` and `/server/share/x` as two artifacts was valid when
 * written and must still replay, so under an empty cwd that reading is kept.
 */
function hasWindowsPathSemantics(raw: string, cwd: string): boolean {
  const cwdFolded = cwd.replaceAll('\\', '/')
  if (/^[A-Za-z]:/.test(cwdFolded) || cwdFolded.startsWith('//')) return true
  const trimmed = raw.trim()
  if (/^[A-Za-z]:/.test(trimmed)) return true
  if (trimmed.startsWith('\\')) return true
  if (cwd.length === 0 && trimmed.startsWith('//')) return true
  return false
}

function cwdUncSharePrefix(cwd: string): string | undefined {
  const posix = cwd.replaceAll('\\', '/')
  const unc = posix.match(/^\/\/([^/]+)\/([^/]+)(\/.*)?$/)
  if (unc !== null && isUncName(unc[1]) && isUncName(unc[2])) {
    return `//${unc[1]}/${unc[2]}`
  }
  return undefined
}

/**
 * @param trimInput - trim `raw` first. TRUE for bearers, which a model may hand
 * over with stray whitespace. FALSE for the CWD, because a directory may
 * legitimately end in a space: trimming it here (not in `resolveBearerBase`,
 * which was the obvious suspect) is what made `report.txt` and
 * `/workspace/project /report.txt` two artifacts under a base of
 * `/workspace/project `.
 */
function collapseBearer(raw: string, cwd: string, trimInput = true): string {
  const trimmed = trimInput ? raw.trim() : raw
  if (trimmed.length === 0) return trimmed
  // Windows `\foo` is `{currentDrive}:\foo` or `{uncShare}\foo`. Detect on the
  // raw string: after slash-fold it is indistinguishable from POSIX `/foo`.
  // UNC `\\server\share` is not this form. Host-only `\\server` is not a share.
  if (trimmed.startsWith('\\') && !trimmed.startsWith('\\\\')) {
    const cwdDrive = cwd.replaceAll('\\', '/').match(/^([A-Za-z]):/)
    if (cwdDrive !== null && cwdDrive[1] !== undefined) {
      return collapseBearer(`${cwdDrive[1].toUpperCase()}:${trimmed}`, cwd)
    }
    const uncShare = cwdUncSharePrefix(cwd)
    if (uncShare !== undefined) {
      return collapseBearer(`${uncShare}${trimmed.replaceAll('\\', '/')}`, cwd)
    }
  }
  // Windows `/foo` is `{currentDrive}:/foo` when cwd is drive-qualified, or
  // `{uncShare}/foo` when cwd is a UNC share. POSIX cwd keeps `/foo` as
  // POSIX-absolute. UNC `//server` is not this form.
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    const cwdDrive = cwd.replaceAll('\\', '/').match(/^([A-Za-z]):/)
    if (cwdDrive !== null && cwdDrive[1] !== undefined) {
      return collapseBearer(`${cwdDrive[1].toUpperCase()}:${trimmed}`, cwd)
    }
    const uncShare = cwdUncSharePrefix(cwd)
    if (uncShare !== undefined) {
      return collapseBearer(`${uncShare}${trimmed}`, cwd)
    }
  }
  const windows = hasWindowsPathSemantics(trimmed, cwd)
  const posix = windows ? trimmed.replaceAll('\\', '/') : trimmed
  // UNC is a WINDOWS reading of `//host/share`, so it is gated on Windows
  // semantics. Under a POSIX cwd the leading slashes are just slashes and the
  // segment collapse below folds `//workspace/x` onto `/workspace/x`.
  if (windows) {
    const unc = posix.match(/^\/\/([^/]+)\/([^/]+)(\/.*)?$/)
    if (unc !== null && isUncName(unc[1]) && isUncName(unc[2])) {
      const prefix = `//${unc[1].toLowerCase()}/${unc[2].toLowerCase()}`
      const joined = collapseBearerSegments(unc[3] ?? '', true).join('/').toLowerCase()
      return joined.length > 0 ? `${prefix}/${joined}` : prefix
    }
  }
  const driveMatch = posix.match(/^([A-Za-z]):\//)
  const drive = driveMatch !== null && driveMatch[1] !== undefined
    ? `${driveMatch[1].toUpperCase()}:`
    : ''
  const body = drive.length > 0 ? posix.slice(2) : posix
  const absolute = body.startsWith('/') || drive.length > 0
  const joined = collapseBearerSegments(body, absolute).join('/')
  if (drive.length > 0) {
    const folded = joined.toLowerCase()
    return folded.length > 0 ? `${drive}/${folded}` : `${drive}/`
  }
  return absolute ? `/${joined}` : joined
}

/**
 * Collapse path aliases so reverse Single-Bearer cannot be skipped by `./x` vs `x`.
 * Separators become `/` only under Windows path semantics (drive-qualified cwd
 * or bearer, UNC, or a leading `\`); POSIX `a\b` stays distinct from `a/b`.
 * `.` segments drop; `..` pops. POSIX `/`, Windows drive-qualified `X:/`
 * (drive letter uppercased, remainder lowercased), and UNC `//server/share`
 * (host, share, and remainder lowercased) roots discard leftover `..`. UNC is
 * read ONLY under Windows semantics: under a POSIX cwd a leading `//` collapses
 * to `/`, because there `//workspace/x` and `/workspace/x` are one file — except
 * under an EMPTY cwd (a legacy snapshot with no bearerBase), where the raw `//`
 * keeps the UNC reading those streams were written with. A raw
 * `\foo` (not UNC) is `{cwdDrive}:\foo` when cwd is drive-qualified, or
 * `{uncShare}/foo` when cwd is a UNC share. A raw `/foo` (not `//`) is
 * `{cwdDrive}:/foo` when cwd is drive-qualified, or `{uncShare}/foo` when cwd
 * is a UNC share. Host-only `\\server` is not a share root. A Windows
 * drive-relative `X:rest` (no slash after the colon) rewrites as `rest` when
 * cwd is on the same drive (letter compared case-insensitively). Nonempty
 * relatives join an absolute-shaped cwd, which is used VERBATIM — a directory
 * whose name ends in a space is a real directory. Empty collapse stays empty.
 * evaluateCompletion passes snapshot.bearerBase, never ambient process.cwd().
 * Not a filesystem resolve.
 */
export function canonicalBearer(raw: string, cwd: string = process.cwd()): string {
  const trimmed = raw.trim()
  const driveRelative = /^([A-Za-z]):(?![\\/])(.+)$/.exec(trimmed)
  if (driveRelative !== null) {
    const letter = driveRelative[1]
    const rest = driveRelative[2]
    if (letter !== undefined && rest !== undefined) {
      const cwdDrive = cwd.replaceAll('\\', '/').match(/^([A-Za-z]):/)
      if (
        cwdDrive !== null
        && cwdDrive[1] !== undefined
        && cwdDrive[1].toUpperCase() === letter.toUpperCase()
      ) {
        return canonicalBearer(rest, cwd)
      }
    }
  }
  const collapsed = collapseBearer(raw, cwd)
  if (collapsed.length === 0 || isAbsoluteBearer(collapsed)) return collapsed
  const cwdCollapsed = collapseBearer(cwd, cwd, false)
  if (!isAbsoluteBearer(cwdCollapsed)) return collapsed
  const joined = `${cwdCollapsed.replace(/\/$/, '')}/${collapsed}`
  return collapseBearer(joined, cwd)
}

/** Protocol constant, not config: outbound manifest staleness window (CC 6h). */
export const OUTBOUND_STALE_MS = 6 * 60 * 60 * 1000

/** Where the run's canonical event stream lives; recorded honestly, never assumed. */
export type StoreKind = 'domain' | 'file'

/** How owner authority for egress is obtained; recorded honestly. */
export type ApprovalChannel = 'native' | 'signal-only'

/** Which seam enforces the egress boundary; recorded honestly. */
export type EgressChannel = 'native-ask' | 'guard-deny' | 'off'

/** Mechanical enforcement bookkeeping. */
export interface Enforcement {
  /**
   * 'active': mode appended AND a confine provider is observable;
   * 'degraded': attempted but unverifiable/failed (fail-open, recorded);
   * 'off': lightweight run or disabled by config.
   */
  readonly sandbox: 'active' | 'degraded' | 'off'
  /** True when the read-only 'sandbox/mode' event was appended (drives restore on plan-gate pass). */
  readonly modeAppended?: boolean
  /** Effective sandbox mode observed before the run forced read-only (restored on plan-gate pass). */
  readonly priorSandboxMode?: string
  /** Turn-stop reminders issued so far (protocol cap MAX_STOP_REMINDERS). */
  readonly reminders: number
  readonly ownerApprovals: readonly OwnerApproval[]
  /**
   * Where this run's canonical event stream actually lives. ABSENT on legacy
   * (v1) streams, which were always file-backed. Recorded rather than assumed:
   * `ctx.storageDomain` is mounted by the web-app bundle only, so a headless
   * deployment runs 'file' and must say so.
   */
  readonly store?: StoreKind
  /**
   * How owner authority for egress was obtainable when the run started.
   * 'native': `ctx.approval` was observable, so the egress boundary can ASK.
   * 'signal-only': no approval service; only `autopilot_signal owner-approve`
   * (direct-human-turn) can authorize an egress.
   */
  readonly approval?: ApprovalChannel
  /** Which seam is actually enforcing egress (native ask, guard denial, or disabled). */
  readonly egress?: EgressChannel
  /**
   * Whether the read-only `ctx.autopilot` surface was actually provided at
   * mount. ABSENT on legacy (v1) streams, which predate the service.
   *
   * Recorded for the same reason as its siblings: registration can fail (a
   * host that already provides `autopilot`, or a context exposing neither
   * `provide` nor `reflect.provide`), the plugin deliberately survives that,
   * and a failure nothing writes down is a checker whose fail is unobservable
   * in production.
   */
  readonly service?: 'registered' | 'unavailable'
  /** Outbound manifests consumed (archived) by this run. */
  readonly outboundConsumed?: number
  readonly diagnostic?: string
}

/** Triage outputs (CC Phase 0), immutable after init. */
export interface Triage {
  readonly objective: string
  readonly scope: readonly string[]
  readonly nonGoals: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly risk: Risk
  readonly size: Size
  readonly executionMode: ExecutionMode
  readonly auditMode: AuditMode
  /** Self-declared: the run modifies rules/skills/hooks/agent config. Adds the `rules` audit role. */
  readonly touchesOperatingLayer: boolean
  readonly baseline: Baseline
}

/** The complete durable run snapshot, written on every event. */
export interface Snapshot {
  readonly runId: RunId
  readonly revision: number
  readonly triage: Triage
  readonly plan: { readonly revision: number; readonly text: string }
  readonly phase: Phase
  readonly planGate: PlanGate
  readonly executionGate: ExecutionGate
  readonly audits: readonly AuditRecord[]
  readonly executor?: ExecutorRecord
  /** Delegated: the executor's returned packet. Inline: the root's submitted evidence report. */
  readonly executionPacket?: string
  readonly residualRisks: readonly string[]
  readonly logCount: number
  /** Consecutive needs-replan verdicts; MAX_REPLAN_ROUNDS+1 forces needs-owner-decision. */
  readonly consecutiveReplans: number
  readonly closeout?: Closeout
  /**
   * Usage-evidence dimension. ABSENT marks a legacy (v1) stream that predates
   * the dimension and is exempt (CC `legacy_migrated`); an empty entries list
   * is NOT exempt.
   */
  readonly usage?: UsageEvidence
  /**
   * ISO-8601 UTC stamped when the plan gate FIRST passed. The freshness anchor
   * usage artifacts must post-date — events carry no gate marker, so this
   * field exists because there is nothing else to anchor to.
   */
  readonly planGatePassedAt?: string
  /**
   * Absolute-shaped cwd stamped at init. Present nonempty value must already
   * be absolute-shaped (slash-folded Windows `C:\work` counts); empty fails;
   * absence is legacy and means do not join. evaluateCompletion joins relative
   * proven bearers against this, never against ambient process.cwd().
   */
  readonly bearerBase?: string
  readonly enforcement: Enforcement
  readonly diagnostic?: string
}

/** Operation tags for the event log. */
export type Operation =
  | 'init'
  | 'submit-plan'
  | 'audit'
  | 'self-check'
  | 'external-audit'
  | 'start-executor'
  | 'resume-executor'
  | 'submit-packet'
  | 'submit-evidence'
  | 'log'
  | 'replan'
  | 'set-blocked'
  | 'set-owner-decision'
  | 'owner-approve'
  | 'owner-resolve'
  | 'consume-approval'
  | 'reminder'
  | 'sandbox'
  | 'declare-usage'
  | 'consume-manifest'
  | 'submit-closeout'

/** One durable event line in the run's events.jsonl. */
export interface RunEvent {
  readonly v: 1
  readonly op: Operation
  readonly revision: number
  /** ISO-8601 UTC. */
  readonly time: string
  readonly snapshot: Snapshot
  /** Op-specific payload (e.g. the LogEntry for 'log'). */
  readonly detail?: unknown
}

/** Typed engine error with a stable code. */
export class AutopilotError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'AutopilotError'
  }
}

/** Message for an AutopilotError or any thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The audit roles required for a run (CC risk-adaptive matrix). */
export function requiredRoles(triage: Triage): readonly AuditRole[] {
  const roles: AuditRole[] = ['plan', 'execution']
  if (triage.touchesOperatingLayer || triage.risk === 'high' || triage.risk === 'critical') {
    roles.push('rules')
  }
  return roles
}

/** Latest audit record per role (latest-wins: a stale pass followed by needs-fix must not open completion). */
export function latestVerdicts(audits: readonly AuditRecord[]): Partial<Record<AuditRole, AuditRecord>> {
  const latest: Partial<Record<AuditRole, AuditRecord>> = {}
  for (const record of audits) latest[record.role] = record
  return latest
}

/** Completion evaluation result. */
export interface CompletionCheck {
  readonly ok: boolean
  readonly problems: readonly string[]
}

/**
 * Optional usage-artifact settlement inputs for {@link evaluateCompletion}.
 *
 * WHY the settler is INJECTED rather than imported: `./usage.js` imports this
 * module for its vocabulary, so importing it back here would make the domain
 * layer circular. Injection keeps the dependency one-directional and, more
 * importantly, makes the second property explicit — settlement reads the
 * FILESYSTEM, and the strict replay fold must not. A stream that completed
 * last week must still replay after its screenshots were archived away, so
 * `applyEvent` calls this function with NO options and validates only the
 * structural claim; the engine passes the settler once, at the moment of
 * closeout, when the artifacts are supposed to exist.
 */
export interface CompletionOptions {
  /** Absolute run directory; artifacts resolve against it and must stay inside it. */
  readonly runDir?: string
  /**
   * ISO-8601 UTC stamp of the moment completion is being evaluated, forwarded
   * to the settler as the UPPER freshness bound (see `SettleUsageOptions`).
   * Optional and never defaulted here: this function is also run on the replay
   * path, and reading a clock would make the same stream answer differently on
   * every replay.
   */
  readonly settledAt?: string
  /**
   * Settle every external countersign's `reviewRef` against the filesystem,
   * wired by the engine. Same asymmetry as `settleUsage` and for the same
   * reason: the replay path must not depend on disk state, so the fold calls
   * `evaluateCompletion` WITHOUT this and gets the structural claim only.
   */
  readonly settleExternal?: (
    audits: readonly AuditRecord[],
    options: { readonly runDir: string },
  ) => readonly string[]
  /** `settleUsageArtifacts` from `./usage.js`, wired by the engine. */
  readonly settleUsage?: (
    usage: UsageEvidence | undefined,
    options: { readonly runDir: string; readonly planGatePassedAt?: string; readonly settledAt?: string },
  ) => readonly string[]
  /**
   * Refuse a proven evidence entry that carries no `kind` (unproven entries
   * are exempt at this layer; the tool schema requires it on every item).
   *
   * OFF BY DEFAULT, because this function also runs on the replay path over
   * streams written before `EvidenceEntry.kind` existed. The engine passes
   * `true` at the write, and `applyEvent` passes `true` only for an event that
   * stamped `evidenceKinds: 1` — so which arm a stream gets is decided by what
   * the stream itself says, never by the build that happens to be reading it.
   */
  readonly requireKind?: boolean
}

/**
 * Evaluate whether a snapshot may enter `completed`.
 * Mechanizes CC validate_goal_run.py: closeout present, gates pass,
 * required roles latest-pass with mode-consistent provenance,
 * evidence covers every acceptance criterion (with a cardinality floor).
 *
 * With {@link CompletionOptions} supplied it ALSO settles the run's usage
 * artifacts on disk. Without them it checks the structural claim only — see
 * the interface doc for why that asymmetry is deliberate and not a gap.
 */
export function evaluateCompletion(snapshot: Snapshot, options: CompletionOptions = {}): CompletionCheck {
  const problems: string[] = []
  const { triage, closeout } = snapshot

  if (snapshot.planGate !== 'pass') problems.push(`planGate is ${snapshot.planGate}, must be pass`)
  if (snapshot.executionGate !== 'pass') problems.push(`executionGate is ${snapshot.executionGate}, must be pass`)
  if (closeout === undefined) {
    problems.push('closeout not submitted')
  } else {
    // Checker-Resolution invariant: quantifiers need cardinality floors.
    if (triage.acceptanceCriteria.length < 1) problems.push('acceptance criteria list is empty')
    if (closeout.evidence.length < 1) problems.push('evidence list is empty')
    for (const entry of closeout.evidence) {
      if (entry.status !== 'proven' && entry.status !== 'unproven') {
        problems.push(`evidence status is not proven or unproven: ${entry.criterion} ("${String(entry.status)}")`)
      }
    }
    problems.push(
      ...evidenceKindProblems(closeout.evidence, { requireKind: options.requireKind === true })
        .map(problem => problem.message),
    )
    for (const criterion of triage.acceptanceCriteria) {
      const entries = closeout.evidence.filter(entry => entry.criterion === criterion)
      if (entries.length === 0) problems.push(`criterion has no evidence entry: ${criterion}`)
      if (entries.length > 1) problems.push(`criterion has ${entries.length} evidence entries (Single-Bearer: exactly one): ${criterion}`)
      const entry = entries[0]
      if (entry !== undefined && entry.status === 'proven' && entry.bearer.trim().length === 0) {
        problems.push(`proven criterion has an empty bearer: ${criterion}`)
      }
    }
    // Reverse Single-Bearer: one criterion cannot have two entries (above);
    // one proven bearer also cannot carry two criteria. Unproven entries do
    // not occupy the map — an honest gap is not a claim the artifact bears.
    const provenByBearer = new Map<string, string[]>()
    for (const entry of closeout.evidence) {
      if (entry.status !== 'proven') continue
      const raw = entry.bearer.trim()
      if (raw.length === 0) continue
      // Declared kind first, heuristic only as the legacy arm. A 'command'
      // bearer is the trimmed text and nothing else — folding it is what made
      // `git status` and `./git status` the same artifact.
      const effectiveKind: 'path' | 'command' = entry.kind === 'command'
        ? 'command'
        : entry.kind === 'path' || isPathShapedBearer(raw)
          ? 'path'
          : 'command'
      const bearer = effectiveKind === 'path' ? canonicalBearer(raw, snapshot.bearerBase ?? '') : raw
      if (bearer.length === 0) {
        problems.push(`proven criterion has a bearer that canonicalizes to empty: ${entry.criterion} ("${raw}")`)
        continue
      }
      // The key carries the kind (Codex 3932312241 on PR #5): a command whose
      // text happens to equal a path's canonical form is a different artifact,
      // not that path reused. Collisions are detected within one kind only.
      const key = `${effectiveKind} ${bearer}`
      const criteria = provenByBearer.get(key) ?? []
      criteria.push(entry.criterion)
      provenByBearer.set(key, criteria)
    }
    for (const [key, criteria] of provenByBearer) {
      if (criteria.length > 1) {
        problems.push(
          `artifact ${key} bears ${String(criteria.length)} proven criteria (Single-Bearer: one artifact bearing two criteria cannot be observed false for either independently): ${criteria.join('; ')}`,
        )
      }
    }
    if (closeout.summary.trim().length === 0) problems.push('closeout summary is empty')
    if (closeout.workspaceCleanup.trim().length === 0) problems.push('closeout workspaceCleanup is empty')
    if (closeout.drift.trim().length === 0) problems.push('closeout drift is empty (use "none found")')
  }

  const roles = requiredRoles(triage)
  const latest = latestVerdicts(snapshot.audits)
  for (const role of roles) {
    const record = latest[role]
    if (record === undefined) {
      problems.push(`required audit role has no record: ${role}`)
      continue
    }
    if (record.verdict !== 'pass') {
      problems.push(`required role ${role} latest verdict is ${record.verdict}, must be pass`)
    }
    if (triage.auditMode === 'independent' && record.route.provider === 'self-check') {
      problems.push(`role ${role} latest pass is a self-check; independent mode requires a dispatched auditor`)
    }
    if (triage.auditMode === 'external') {
      // A role may close by a countersigned external review OR by a dispatched
      // auditor — a real dispatch is STRONGER than a countersign, so accepting
      // it here is not a loophole. What is refused is the same thing
      // `independent` refuses: the run reviewing itself.
      if (record.route.provider === 'self-check') {
        problems.push(`role ${role} latest pass is a self-check; external mode requires a countersigned review or a dispatched auditor`)
      } else if (record.external !== undefined) {
        problems.push(...validateExternalReview(record.external).map(p => `role ${role}: ${p}`))
      }
    }
    if (record.external !== undefined && triage.auditMode !== 'external') {
      // A countersign carries less evidence than the mode it would be sitting
      // in claims. Refuse the mismatch rather than silently honouring it.
      problems.push(`role ${role} carries an external countersign but the run's auditMode is ${triage.auditMode}`)
    }
  }

  if (triage.executionMode === 'delegated') {
    if (snapshot.executor === undefined) problems.push('delegated run has no executor record')
    else if (snapshot.executor.state !== 'completed') {
      problems.push(`delegated executor state is ${snapshot.executor.state}, must be completed`)
    }
  }

  // The usage question is re-asked HERE, not only at the plan gate. The gate
  // answers for the entries that existed when it flipped; `decideTool`
  // explicitly anticipates a NEW entry appearing mid-execution, and an entry
  // may also be re-declared back to `undeclared` (last-wins is legal). Without
  // this line the dimension's whole claim — "a run that finished answered the
  // usage question" — held only for entries that happened to predate the gate.
  // Legacy streams (usage absent) stay exempt inside the function itself.
  problems.push(...usageDeclarationProblems(snapshot.usage))

  // Usage settlement: a declared artifact that is missing, empty, outside the
  // run directory, stale, or carrying none of the labels it claims has not
  // borne anything. Legacy streams (usage absent) stay exempt inside
  // `settleUsageArtifacts` itself, so no guard is needed here.
  if (options.runDir !== undefined && options.settleExternal !== undefined) {
    problems.push(...options.settleExternal(snapshot.audits, { runDir: options.runDir }))
  }
  if (options.runDir !== undefined && options.settleUsage !== undefined) {
    problems.push(...options.settleUsage(snapshot.usage, {
      runDir: options.runDir,
      ...(snapshot.planGatePassedAt === undefined ? {} : { planGatePassedAt: snapshot.planGatePassedAt }),
      ...(options.settledAt === undefined ? {} : { settledAt: options.settledAt }),
    }))
  }

  return { ok: problems.length === 0, problems }
}

/**
 * Declaration-time rules for one entry. Returns one problem per violated rule
 * and never throws: the caller decides whether to refuse a transition or merely
 * report. An empty array means the CLAIM is well-formed - it says nothing yet
 * about whether the artifacts exist, which is settlement's job.
 */
export function validateUsageEntry(entry: UsageEntry): string[] {
  const problems: string[] = []
  const id = entry.id.trim()
  if (id.length === 0) problems.push('usage entry id is empty')
  const label = id.length > 0 ? id : '<empty id>'
  const usageClass = entry.usageClass

  if (USAGE_VISIBLE_CLASSES.includes(usageClass)) {
    // Cardinality floor: two states, at least one drawn from the canonical
    // menu, so "declare the easy state and ship" costs at least one named
    // boundary. The residual is an audit target, not a mechanical one.
    if (entry.boundaryStates.length < 2) {
      problems.push(`entry ${label}: class ${usageClass} needs >=2 boundary states, has ${entry.boundaryStates.length}`)
    }
    if (!entry.boundaryStates.some(state => BOUNDARY_MENU.includes(state))) {
      problems.push(`entry ${label}: class ${usageClass} needs >=1 boundary state drawn from BOUNDARY_MENU, has none`)
    }
    if (entry.artifacts.length < 1) {
      problems.push(`entry ${label}: class ${usageClass} needs >=1 artifact, has none`)
    }
  }

  if (usageClass === 'harness' && !entry.artifacts.some(item => item.kind === 'test-run')) {
    problems.push(`entry ${label}: class harness needs >=1 artifact of kind test-run`)
  }

  if (usageClass === 'unsupported') {
    // `unsupported` is an honest TERMINAL, not a failure - but only when it
    // says what could not be run and what was tried. Without both, "we did not
    // run it" and "we could not run it" stay indistinguishable, which is the
    // exact ambiguity this dimension exists to remove.
    if ((entry.unsupportedReason ?? '').trim().length === 0) {
      problems.push(`entry ${label}: class unsupported needs a non-empty unsupportedReason`)
    }
    if (!entry.attempted.some(item => item.trim().length > 0)) {
      problems.push(`entry ${label}: class unsupported needs a non-empty attempted[]`)
    }
  }

  for (const [index, artifact] of entry.artifacts.entries()) {
    const ref = artifact.ref.trim()
    const where = `entry ${label} artifact ${ref.length > 0 ? ref : `#${index}`}`
    if (ref.length === 0) problems.push(`${where}: ref is empty`)
    if (!artifact.covers.some(item => item.trim().length > 0)) problems.push(`${where}: covers is empty`)
    problems.push(...coversFloorProblems(where, artifact.covers))
    if (Number.isNaN(Date.parse(artifact.capturedAt))) {
      problems.push(`${where}: capturedAt is not a parsable date: ${artifact.capturedAt}`)
    }
    // `inheritedFrom` switches settlement OFF for this artifact entirely (see
    // `settleArtifact`), so an unconstrained string buys a total exemption for
    // the price of one character. The shape is therefore checked where the
    // CLAIM is made; whether the cited run really holds that artifact is not
    // observable from here and stays an audit-layer obligation (DESIGN.md §6).
    //
    // PRESENT-BUT-BLANK IS ABSENT, NOT MALFORMED. This read `!== undefined`,
    // and on the real host it rejected EVERY artifact-bearing declaration with
    // `inheritedFrom is present but blank`. The model emits every optional key
    // in the tool schema, and `autopilot_usage` forwards the blank verbatim (it
    // drops the key only when it is literally `undefined`). Artifacts are
    // carried by exactly the classes that REQUIRE evidence, so one empty string
    // made gui|cli|api-behavior|harness unreachable and left only the classes
    // that require none - the dimension defeated by a character nobody typed.
    // Reading blank as absent costs nothing: `settleArtifact` ALREADY reads a
    // blank citation as absent, so a blank buys no exemption and the artifact
    // settles in full. The two sides now agree, and a citation that is present
    // and genuinely malformed is still refused below.
    const inheritedFrom = artifact.inheritedFrom?.trim() ?? ''
    if (inheritedFrom.length > 0) problems.push(...inheritedFromProblems(where, inheritedFrom))
  }

  return problems
}

/**
 * Rules for a NON-BLANK `inheritedFrom` citation: it must read as
 * `<run-id>/<ref>` and stay inside that run.
 *
 * There is deliberately no branch for the blank case: the caller treats blank
 * as absent and never calls in with one, and a branch that cannot be reached is
 * a rule that can never be observed to fire - which is the same as no rule.
 */
function inheritedFromProblems(where: string, raw: string): string[] {
  const cited = raw.trim()
  const cut = cited.indexOf('/')
  const runId = cited.slice(0, cut).trim()
  const ref = cited.slice(cut + 1).trim()
  if (cut <= 0 || runId.length === 0 || ref.length === 0) {
    return [`${where}: inheritedFrom must be "<run-id>/<ref>", got: ${cited}`]
  }
  if (ref.split(/[\\/]/).some(segment => segment === '..')) {
    return [`${where}: inheritedFrom ref escapes the cited run directory: ${cited}`]
  }
  return []
}

/**
 * The usage-declaration rule: these problems must be empty before the plan
 * gate may pass, AND before a run may enter `completed`.
 *
 * `undefined` returns `[]` — an ABSENT dimension marks a legacy (v1) stream
 * that predates the rule and is exempt, exactly like CC's `legacy_migrated`.
 * A PRESENT dimension with an empty `entries` list is NOT exempt: that is a
 * run which was asked the question and declared nothing, which is precisely
 * the failure mode the exemption must not cover.
 *
 * WHY IT LIVES IN THE VOCABULARY MODULE rather than in `./usage.js` with its
 * settlement siblings: {@link evaluateCompletion} and the replay fold both
 * have to apply it, and both live below `./usage.js` in the import order.
 * The rule is pure over the vocabulary declared here and touches no
 * filesystem, so it belongs on this side of that line; `./usage.js` re-exports
 * it so the declaration-time caller still reads as one module.
 */
export function usageDeclarationProblems(usage: UsageEvidence | undefined): string[] {
  if (usage === undefined) return []
  const problems: string[] = []
  if (usage.entries.length === 0) {
    problems.push('usage evidence is present but declares no entries; an empty entries list is not legacy-exempt')
  }
  for (const entry of usage.entries) {
    if (entry.usageClass === 'undeclared') {
      const id = entry.id.trim()
      problems.push(`usage entry ${id.length > 0 ? id : '<empty id>'} is undeclared; the usage question must be answered for every entry`)
    }
    // STRUCTURE IS RE-CHECKED ON THE REPLAY PATH, not only at the writer.
    // {@link validateUsageEntry} used to be invoked at exactly two sites, both
    // of them writers (`AutopilotEngine.init`'s seeds and `declareUsage`), and
    // this function reported only the literal class 'undeclared'. So a
    // structurally hollow declaration — `usageClass:'gui'` with zero boundary
    // states and zero artifacts — folded clean, flipped the plan gate, walked
    // zero artifacts at settlement and completed. That is precisely the threat
    // model the fold's own rule names: a hand-edited file, a buggy writer, an
    // older build. A rule enforced only by the writer is not an invariant of
    // the stream, and the stream is what an auditor reads.
    problems.push(...validateUsageEntry(entry))
  }
  return problems
}

/**
 * Pure, replay-safe checks on one external review. Everything here can be
 * answered from the record alone, so the FOLD can enforce it too — the
 * writer-only-validation defect this repo already paid for (a class obligation
 * checked at declare time and nowhere else) must not be repeated here.
 * Whether the referenced file EXISTS is deliberately NOT asked here: that
 * needs the filesystem and would make replay depend on disk state.
 */
export function validateExternalReview(review: ExternalReview): string[] {
  const problems: string[] = []
  if (review.reviewer.trim().length === 0) problems.push('external review: reviewer is empty')
  const ref = review.reviewRef.trim()
  if (ref.length === 0) {
    problems.push('external review: reviewRef is empty — a countersign must attach the review')
  } else if (ref.startsWith('/') || /^[a-zA-Z]:/.test(ref) || ref.includes('..')) {
    // Containment is settled against the real path at completion; this is the
    // shape floor, refusing the obvious escapes before anything is recorded.
    problems.push(`external review: reviewRef must be a run-directory-relative path, got ${ref}`)
  }
  problems.push(...treeHashProblems(review.treeHash))
  return problems
}

/**
 * The shape floor for a declared {@link ExternalReview.treeHash}. Absent is
 * legal; present means it has to LOOK like a hash.
 *
 * WHAT THIS CAN AND CANNOT DO. It cannot tell whether the hash names this tree,
 * or any tree — nothing in this package can (see the field's own doc). What it
 * can do is refuse a value that is not a hash at all, so the record never
 * carries `treeHash: "the main branch"` and no reader is invited to treat that
 * as an identifier. 7 is git's own abbreviation floor; 64 admits sha-256 object
 * names, so the rule does not quietly assume sha-1 forever.
 *
 * LOWERCASE ONLY, because the single construction site lowercases before
 * writing: a stored value in any other case did not come from this engine, and
 * the fold's job is to say so rather than to normalize a foreign stream into
 * looking native.
 *
 * THE `typeof` GUARD IS LOAD-BEARING, not defensive habit. This runs on the
 * REPLAY path against JSON that may have been hand-edited, where the declared
 * type is a promise rather than a fact — and `/^[0-9a-f]{7,64}$/.test(1234567)`
 * is `true`, because `test` stringifies its argument. Without the guard a
 * numeric `treeHash` would fold clean and then read as a hash everywhere
 * downstream.
 */
function treeHashProblems(treeHash: unknown): string[] {
  if (treeHash === undefined) return []
  if (typeof treeHash !== 'string') {
    return [`external review: treeHash must be a string, got ${treeHash === null ? 'null' : typeof treeHash}`]
  }
  if (!/^[0-9a-f]{7,64}$/.test(treeHash)) {
    return [`external review: treeHash must be 7-64 lowercase hex characters, got ${JSON.stringify(treeHash)}`]
  }
  return []
}

/**
 * Compare two DECLARATIONS of which tree was reviewed.
 *
 * Neither side is measured, so this is not verification and its result is never
 * a gate: `triage.baseline.commit` is a string the run typed at init and
 * `treeHash` is a string the reviewer typed at countersign time. What the
 * comparison IS good for is catching the two declarations disagreeing, which a
 * human reader can act on and no mechanism here can.
 *
 * ABBREVIATION-TOLERANT: git prints 7-, 8- and 40-character spellings of the
 * same commit, so a strict equality would report a mismatch between two names
 * for one object. The shorter is compared as a prefix of the longer, which is
 * how every git UI resolves the same question.
 *
 * @param treeHash - the reviewer's declared hash, already normalized.
 * @param baselineCommit - `triage.baseline.commit`, as declared at init.
 * @returns 'no-hash' | 'no-baseline' | 'agrees' | 'differs'.
 */
export function compareDeclaredTree(
  treeHash: string | undefined,
  baselineCommit: string | undefined,
): 'no-hash' | 'no-baseline' | 'agrees' | 'differs' {
  if (treeHash === undefined || treeHash.length === 0) return 'no-hash'
  const baseline = baselineCommit?.trim().toLowerCase() ?? ''
  if (baseline.length === 0) return 'no-baseline'
  const [shorter, longer] = treeHash.length <= baseline.length ? [treeHash, baseline] : [baseline, treeHash]
  return longer.startsWith(shorter) ? 'agrees' : 'differs'
}

/** Validate triage combinations at init (CC risk-adaptive rules). */
export function validateTriage(triage: Triage): string[] {
  const problems: string[] = []
  if (triage.objective.trim().length === 0) problems.push('objective is empty')
  if (triage.acceptanceCriteria.length < 1) problems.push('at least one acceptance criterion is required')
  // `external` was rejected outright through v1 and most of v2 — a deliberate
  // honest terminal while the channel did not exist. It exists now, so the
  // rejection would itself be the false statement.

  if (triage.auditMode === 'self-check' && !(triage.size === 'lightweight' && triage.risk === 'low')) {
    problems.push('auditMode self-check is only legal for lightweight+low runs')
  }
  if ((triage.risk === 'medium' || triage.risk === 'high' || triage.risk === 'critical')
    && triage.auditMode === 'self-check') {
    // The rule this encodes is "medium and up may not review THEMSELVES", and
    // it used to be spelled `!== 'independent'` because independent was the
    // only alternative. `external` is also not self-review, so keying off the
    // disqualifier rather than the allow-list is what keeps the rule meaning
    // the same thing now that a third mode exists.
    problems.push(`risk ${triage.risk} may not self-review; use independent or external`)
  }
  if (triage.executionMode === 'delegated' && triage.size === 'lightweight') {
    problems.push('lightweight runs are always inline (CC parity)')
  }
  return problems
}
