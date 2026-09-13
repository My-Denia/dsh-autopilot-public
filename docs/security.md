# Security and boundaries

This plugin is an **experimental developer preview**. It does not provide
production-grade complete security and does not provide remote **exactly-once**.

The plan-gate / sandbox clamp is a **quality gate**, not a permission
boundary — with one exception: the owner-only **egress** branch
**fail-closed** even when the snapshot read itself throws.

Deeper design and measurements: [DESIGN.md §4 / §6](../DESIGN.md).

## What is in scope

- Mechanical **plan gate**: standard runs deny write/edit tools until the
  plan audit passes.
- A read-only `sandbox/mode` session event is appended **unconditionally** at
  init. The label is conditional: `enforcement.sandbox: active` only when a
  confine provider is observable, otherwise `degraded`.
- Shell is fail-open by default under `degraded`. Set `gate.strictShell: true`
  to deny shell pre-plan-gate instead.
- Owner-only egress requires a validating evidence manifest **and** owner
  authority (`owner-approve` or dsh's approval service). No manifest, no ask.
- `gate.egressDeny: false` disables the egress boundary entirely
  (`enforcement.egress: 'off'`). It is not a way to loosen it.

## Sandbox assumptions

Sandbox clamp depends on dsh's platform backend (Windows ACL / Landlock /
Seatbelt). `enforcement.sandbox: 'active'` means a mode event was appended
**and** a confine service is observable. Detection is an existence check; a
backend that silently no-ops on an unsupported OS is why `strictShell`
exists.

The current 0.1.1 residual on WSL / current DSH is a **host/model**
interoperability issue: the tested headless model does not follow the
sandbox escalation contract for ordinary workspace-write calls. That is
documented in [compatibility.md](compatibility.md). It is not claimed as
fixed.

## Owner-only egress

`git push` / `git send-email` / `gh pr|issue|release|repo|gist` writes /
`gh api` with an explicit mutating method or field/body flag / `gh workflow
run` / `gh secret set` / `gh variable set` / `npm|pnpm|yarn publish` reach
the network only after `<run>/outbound/manifest.json` validates against the
command, and then only on owner authority.

Authorization is per **segment** (`&&`, `||`, `;`, `|`, `&`, newline). A
push-only manifest does not authorize `git push origin main && npm publish`.

The command class is an **enumerated list** and the segmenter is text
splitting, not a shell parser. A subprocess inside a script, a renamed
binary, or a second egress inside `$(...)` is out of scope.

On a `bash` / `pwsh` / `terminal_open` line the match is command-shaped:
text after an unquoted `#` and the interior of a multi-word quoted argument
are dropped first. What it still cannot tell apart is named in DESIGN.md §6,
including an unquoted mention and a quoted-separator hole:
`git -c http.extraHeader="Cookie: a=1; b=2" push origin main` is **not**
classified as egress.

The egress boundary applies to a **LIVE run only**. With no autopilot run, or
after `completed`/`blocked`, both seams allow egress — mounting this plugin
does not turn every session into a gated one.

## Manifest location

First existing file wins (first-existing, not first-valid):

1. `<run>/outbound/manifest.json`
2. `<workspaceRoot>/.dsh-autopilot/outbound/manifest.json`

`DSH_AUTOPILOT_OUTBOUND_MANIFEST` replaces both candidates. Relative values
resolve against process cwd, not the run directory.

The workspace candidate lets an agent author the **claim**. Artifact refs
must still resolve strictly inside the run directory, so the agent cannot
manufacture the **artifact**.

## Manifest rules (summary)

```json
{
  "v": 1,
  "runId": "<the live run's session id>",
  "target": "github.com/owner/repo PR #12",
  "commands": ["git push", "gh pr create"],
  "claims": [
    { "text": "typecheck is clean", "bearer": "evidence/tsc.txt" }
  ],
  "artifacts": [
    { "ref": "evidence/tsc.txt", "covers": ["tsc"] }
  ],
  "createdAt": "2026-08-24T21:40:00.000Z"
}
```

- `runId` must equal the live run.
- Each `commands[i]` needs ≥2 whitespace tokens and must match at a shell
  token boundary.
- `createdAt` must be within **6h** and not future-dated beyond 60s of clock
  skew.
- ≥1 claim. Exactly one artifact per claim.
- Each artifact must exist, be non-empty, stay inside the run directory, and
  contain every `covers` label.
- A `covers` label shorter than `MIN_COVERS_LABEL_LENGTH` (3 trimmed
  characters) is refused.
- Count-shaped phrases in a claim must appear in the bearing artifact.

The manifest proves each claim **has** a bearing artifact that mentions what
it claims to cover — **never that the artifact is truthful**.

When the manifest validates, a standing `owner-approve` is consumed only if
its `target` is itself an egress command and matches this command at a shell
token boundary. Otherwise the seam returns `ask`.

Only a call that reached dispatch archives the manifest to
`<run>/outbound/consumed/`. `enforcement.outboundConsumed` bumps when
`next()` returns without an error result. `isErrorResult` keys on
`isError === true`; a shell tool that exits non-zero without that flag still
counts. Read the counter as "dispatched, and the runtime did not flag an
error" — not "the egress went out".

## Usage-evidence honesty

A usage artifact's `capturedAt` is **self-reported**. Closeout enforces a
lower bound (plan-gate pass) and an upper bound (settlement clock +
`FUTURE_SKEW_MS`). Whether the timestamp is truthful is unverifiable.

Usage classes, entry counts, and the `lightweight` exemption are
**SELF-DECLARED**. Nothing observes a GUI change declared as `internal`.

## Enforcement labels (do not over-read)

- `enforcement.egress: 'native-ask'` means the pre-execute listener
  registered without throwing — an existence bearer, not proof the runtime
  dispatches to it. A genuinely absent seam **fail-closed**: the synchronous
  guard denies all egress (`guard-deny`).
- `enforcement.approval: 'native'` means an approval service is present, its
  session policy is not `'never'`, **and** at least one listener is
  subscribed to `approval/request`. Anything else records `'signal-only'`.
  That is not proof an ask gets answered.

## Web routes

`GET /api/autopilot/runs` and `/run` are fenced by the host's `connection`
service. A host with a web server but no `connection` service gets
`503 no-connection-service`, never an open route. The fence is the host's;
the plugin only applies it.

## Explicit non-goals

- Not a sandbox or permission system for the whole session.
- Not complete production security.
- Not remote exactly-once delivery.
- Not a claim that artifacts or timestamps are truthful.
- Not coverage of renamed binaries, in-script subprocesses, or unenumerated
  channels.
