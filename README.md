# dsh-autopilot

Native Goal Autopilot Harness for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness):
plan-execute-audit gates, mechanical enforcement, and evidence-bound closeout as an
out-of-tree plugin bundle. Design lineage: the Claude Code `goal-autopilot-harness`
skill, rebuilt on dsh's plugin seams so its gates are executable invariants instead
of prompt conventions. Full design: [DESIGN.md](./DESIGN.md).

The project name remains **dsh-autopilot** / Goal Autopilot Harness. The npm
distribution name is **dsh-goal-autopilot**. Unscoped `dsh-autopilot` on npm
belongs to a separate, independent project; this repository does not publish
under that name. Install this plugin as `dsh-goal-autopilot`.

This repository is an **experimental** **developer preview**. It is source you
can read, build, and try on Node 22+ against host `dsh` `0.1.2-rc.1` or
`0.1.5-rc.1`. `@deepseek-ai/dsh-tools` is a **host-provided peer**
(`0.1.2-rc.1 || >=0.1.5-rc.1 <0.1.6`), not a runtime dependency. **0.1.1**
fixes the 0.1.0 defect that installed a second `dsh-tools` copy, split the
module-instance `TOOL_RUNTIME_SCHEDULER` Symbol, and crashed host `skill`
load. It does not provide production-grade complete security and
does not provide remote exactly-once. Existing limits stay in force and are
not repaired in this snapshot: No structured verdict means a gate does not
flip; closeout keys off event format stamps, not `// bearerBase`; a
plugin remount while an executor is already live is warned, not vetoed.

On WSL2 with `dsh` `0.1.5-rc.1`, 0.1.1 has verified npm install, compose/mount,
skill install/load, autopilot entry, and plan/replan/audit through the plan
gate. The full write lifecycle remains unverified because the tested headless
model does not currently follow the host sandbox escalation contract for
ordinary workspace-write calls. That host/model mismatch is outside this
plugin's fix.

## What it does

- **Event-sourced run state machine** (`planning → plan-reviewing → executing →
  execution-reviewing → replanning → closing → completed | blocked | needs-owner-decision`)
  with strict fold validation; only the engine writes it (single-writer, live-root authority).
- **Plan gate, mechanically enforced**: standard runs deny write/edit tools until
  the plan audit passes, and append a read-only `sandbox/mode` session event
  UNCONDITIONALLY at init. What is conditional is the LABEL: the run records
  `enforcement.sandbox: active` only when a confine provider is observable, and
  `degraded` when it is not — the clamp is attempted either way, and shell is
  fail-open by default under `degraded`; set `gate.strictShell: true` to deny
  shell pre-plan-gate instead. The guard is a quality gate, not a permission
  boundary — with one exception: the owner-only egress branch fails CLOSED even
  when the snapshot read itself throws.
- **Usage evidence**: every standard run must answer, per change, how the change
  was actually OPERATED — not merely that it compiles. Undeclared entries block
  the plan gate AND completion, and write tools stay denied while any entry is
  unanswered. Artifacts declared by the artifact-requiring classes are settled
  against the filesystem at closeout.
- **Independent audits with in-band provenance**: one-shot auditor subagents with a
  structured verdict schema, read-only tool filter, and depth cap 1. No structured
  verdict — no gate flip, ever. This works on a stock node-only profile: the
  auditor filter names only tools such a deployment registers, and any name it does
  not register is dropped with a recorded diagnostic rather than aborting the
  dispatch. Until 2026-08-25 the filter named `ask_user_question`, which only a web
  client mounts, so every audit threw and a standard run could never leave
  read-only on a headless profile — see DESIGN.md §8.
- **Delegated executor**: continuable child; needs-fix resumes the SAME child;
  needs-replan drains before revoking. Packet submission CASes on
  `executionRevision` (`AP_PACKET_REVISION_REQUIRED` /
  `AP_PACKET_REVISION_MISMATCH`) in addition to the occupied-slot check
  (`AP_PACKET_EXISTS`) and childId identity. Resume still clears the slot; a
  delayed revision-1 packet after resume is refused. Fold-replay of streams
  that never stamped the field remains legal (legacy).
  The child answers through a private `autopilot_submit_packet` registered into its
  own scope, and that name is deliberately NOT in the tool filter: a scope's own
  registrations are exempt from restriction upstream, and naming one in a filter is
  what used to make every delegated start fail. Driven end to end on a real host
  2026-08-25 (start → running → packet → completed). The RESUME arm was driven on
  a real host 2026-08-27: one `resume-executor`, two packets, one childId,
  `executionRevision` 1→2 with `generation` unchanged, execution gate needs-fix →
  pass. What that trace bears is the same-child resume MECHANICS; what the
  auditor itself observed is not captured, and the `needs-replan` /
  generation-increment arm is still undriven — DESIGN.md §8.1.
- **Owner-only egress boundary with an evidence manifest**: `git push` /
  `git send-email` / `gh pr|issue|release|repo|gist` writes / `gh api` with an
  explicit mutating method OR a field/body flag (`-f`, `-F`, `--field`,
  `--raw-field`, `--input`, `graphql`) / `gh workflow run` / `gh secret set` /
  `gh variable set` / `npm|pnpm|yarn publish` reach the network only after a
  manifest at `<run>/outbound/manifest.json` validates against the command being
  run, and then only on owner authority — either a standing direct-human-turn
  `owner-approve` whose `target` is itself an egress command that matches this
  command at a shell token boundary, or an approval obtained through dsh's own
  approval service. No manifest, no ask. Authorization is per SEGMENT: the
  command is split on the shell separators (`&&`, `||`, `;`, `|`, `&`, newline)
  and EVERY segment in the egress class must be covered by both the manifest and
  the approval, so a push-only manifest does not authorize
  `git push origin main && npm publish` (measured escape, fixed 2026-08-25). The
  command class is an ENUMERATED list and the segmenter is text splitting, not a
  shell parser (DESIGN.md §6): a subprocess inside a script, a renamed binary, or
  a second egress inside `$(...)` is out of scope. On a `bash` / `pwsh` /
  `terminal_open` line the match is now command-shaped rather than raw: text
  after an unquoted `#` and the interior word boundaries of a multi-word quoted
  argument are dropped first, so `grep -rn "git push" .` and
  `git commit -m "prep for git push"` are ALLOWED while `git push "origin" main`
  and `git "push" origin main` stay refused. What it still cannot tell apart is
  named in DESIGN.md §6 and pinned by fixtures: an UNQUOTED mention
  (`cat notes/git-push.md`, a heredoc body) is still refused; a program that
  runs a quoted argument but is not on the interpreter list (`mytool --run "git
  push"`) is now allowed, where `bash -c "git push"` is not; and `run_code` /
  `terminal_send` carry source and PTY keystrokes rather than a command line, so
  they keep verbatim matching and a mere mention there is still refused. The
  refusal states that it is a TEXT match and how far that match reaches, rather
  than claiming the command mutates anything.
- **Evidence-bound closeout**: `completed` is refused unless both gates pass, every
  required audit role's latest verdict is pass (with mode-consistent provenance), and
  the closeout maps exactly one bearing artifact (or an honest `unproven`) to every
  acceptance criterion. Each proven bearer declares its `kind` — `path` (folded
  against the run's workspace, so `./x` and `/ws/x` are one artifact) or `command`
  (compared verbatim, so `git status` and `./git status` stay two). No artifact may
  bear two criteria under either reading.
- **Turn-stop reminder**: a bounded (3x) nudge when a turn tries to end mid-execution
  with the execution gate open.

## Install

```sh
dsh plugin --profile <name> add dsh-goal-autopilot
```

Pin a version:

```sh
dsh plugin --profile <name> add dsh-goal-autopilot@0.1.1
```

From a local checkout (development):

```sh
pnpm install
pnpm run build
dsh plugin --profile <name> add .
```

For a web profile, ensure the profile's `package.json` bundles include the web app
(that bundle is what mounts `ctx.storageDomain`, so it is also what makes
`storeKind: auto` resolve to the domain backend). After `dsh plugin add`, the
bundle name is the npm package name:

```json
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "dsh-goal-autopilot"
] } }
```

**dsh version (support matrix, not a wish).**

| Host `dsh` CLI | How it was established | Install / mount | Full NL run to closeout |
| --- | --- | --- | --- |
| `0.1.2-rc.1` | Original package pin / earlier real-host work | claimed by this snapshot's design notes | earlier host traces in DESIGN.md §8 (not re-run this round) |
| `0.1.5-rc.1` | WSL2 live CLI, 2026-09-13, **not downgraded** | **0.1.1 peer-layout:** compose/mount + skill load + `autopilot_init` without a nested `dsh-tools` runtime. **0.1.0** installed a second runtime and broke host `skill`. | **not verified:** write lifecycle. Tested headless model sends redundant `sandbox_permissions=workspace-write` |
| Windows | out of scope this round | **not verified** | **not verified** |

On a 0.1.5 profile, `dsh plugin add` may print a pnpm peer WARN because
`dsh-tools@0.1.2-rc.1` still wants 0.1.2-era peers. The add still exited 0 in
the WSL measurement; `pnpm peers check` lists the missing names. That WARN
alone is not a signal to downgrade the host CLI.

The 0.1.2 CLI remains the **minimum** line this source was written against:
dsh 0.1.2 removed
`Session.events` (the plugin reads `snapshotEvents()`), the
`@deepseek-ai/dsh-client-runtime` package (the client half now injects only
`dsh-client-ui-slots` and `dsh-client-ui-conversation`, and registers its card
through `ctx.uiConversation.events`), and `ctx.subagents.registerContinuableSetup`.
The executor child's surface (packet tool, egress guard, native seam) is now
installed from the plugin's `agent/created` listener with this contract: a child
that is not the run's live executor is a harmless no-op; a recognized executor
child is installed transactionally — a failing step rolls back every step
already installed, in reverse, and the original error is rethrown out of the
listener, which on dsh 0.1.2 vetoes the child's publication so the engine
records the executor as `revoked` with that failure as its startup diagnostic
instead of a `running` executor that can never submit its packet. One declared
residual: on a plugin remount while an executor is already live there is no
publication to veto, so a failed install on that path is only warned (run id and
child id named) and the executor record is not corrected. If you keep an
older dsh tree side by side, never run profiles from both CLIs at once: the
shared `$DSH_HOME/profiles/node_modules` is re-pointed by whichever CLI boots
last, so a live process from the other tree would resolve modules across
versions. DESIGN.md §6 records the measurements.

On mount, `apply()` copies `skill/dsh-autopilot/SKILL.md` into the skill-scan
root (`$DSH_AGENTS_HOME/skills/dsh-autopilot/SKILL.md`, default `~/.agents/skills`)
if the dest is absent. Identical bytes are a no-op. A dest that differs is a
drift warning naming that path, never an overwrite (`skillInstall: 'off'` skips
this). After upgrading, refresh a drifted copy by replacing the dest with the
bundled file, or delete the dest and remount.

Publication goes through a hard link from a fully written temp file, which is the
only primitive that is both all-or-nothing and refuses to clobber a destination
that appeared meanwhile. On a skill home whose filesystem does not support hard
links the install is reported as `unsupported` — a warning naming the destination,
and **this call writes nothing to it**. (That is a statement about the call, not a
guarantee the path stays empty; another process could create it at any moment.)
That is deliberate: a rename would replace a copy
someone had edited, and an exclusive copy would make the destination visible before
all the bytes arrived, so a concurrent scan or a crash could leave a partial
`SKILL.md`. The mount still succeeds; copy the file by hand to install it.

Manual copy is also the fallback when the plugin is not loaded:

```sh
# macOS / Linux — fallback only
mkdir -p ~/.agents/skills/dsh-autopilot
cp skill/dsh-autopilot/SKILL.md ~/.agents/skills/dsh-autopilot/SKILL.md
```

```powershell
# Windows PowerShell — fallback only
New-Item -ItemType Directory -Force "$HOME\.agents\skills\dsh-autopilot" | Out-Null
Copy-Item skill\dsh-autopilot\SKILL.md "$HOME\.agents\skills\dsh-autopilot\SKILL.md"
```

## Use

Ask the agent to run a goal through the harness, or instruct it directly:

1. `autopilot_init` — triage: objective, scope, non-goals, acceptance criteria,
   risk, size, executionMode (inline/delegated), auditMode
   (self-check/independent/external).
   Standard runs also seed the usage dimension: pass `usageIds` for the
   user-visible changes this run will make (default: one entry, `m1`).
2. `autopilot_submit_plan` → `autopilot_usage` for every seeded id →
   `autopilot_audit role=plan` (or `autopilot_self_check` on lightweight+low runs,
   or `autopilot_external_audit` on `auditMode: external` runs).
   The order matters: a pass verdict on a run with an undeclared entry is recorded
   and then refused at the gate flip, which costs one auditor dispatch.
3. Implement (inline), or `autopilot_executor action=start` (delegated; the child
   returns via its private `autopilot_submit_packet` tool).
4. `autopilot_submit_evidence` (inline) → `autopilot_audit role=execution`
   (+ `role=rules` when the run touches the operating layer or risk ≥ high).
5. `autopilot_submit_closeout` — completes the run, or tells you exactly what is
   missing. Every evidence item carries `kind: 'path' | 'command'`; the tool
   refuses an item without it. Three layers, deliberately different in
   strictness: the TOOL SCHEMA requires `kind` on every item (the stricter call
   surface); the ENGINE and REPLAY require it only on `proven` items, because an
   `unproven` entry bears no artifact and has no bearer to classify; and the
   `evidenceKinds: 1` stamp on the closeout event means
   "proven evidence kind validation v1", not "every item carries a non-empty kind".

**`auditMode: external`** is the owner-countersigned channel: a human reviewed the
work outside this harness and signs for it with `autopilot_external_audit`. It is
owner-only in the same sense `owner-approve` is — the tool refuses an
agent-generated turn, because otherwise the agent driving the run would be signing
for a review of its own work. The review must be ATTACHED: `reviewRef` names a file
inside the run directory, refused at completion if it is missing, empty, or outside.
What the harness cannot check is whether the review happened, who wrote it, or
whether it was about this tree — so an external pass is weaker evidence than a
dispatched audit, and the record keeps the two distinguishable rather than flattening
them (see [DESIGN.md](./DESIGN.md) §6). `self-check` remains refused in this mode:
external is not a licence to self-review.

The optional `treeHash` parameter lets the reviewer say WHICH tree they read. It is
DECLARED, never verified: this package contains no git and a run records no work
tree, so the engine cannot measure a hash to compare against — it sits in exactly
the same trust class as `triage.baseline`. What it does buy is a comparison between
two declarations: a hash that disagrees with the run's declared baseline commit is
reported on the audit's route diagnostic. That is deliberately INFORMATION and never
a refusal, because a run's tree legitimately moves while it executes. Omit it rather
than guessing; a blank is treated as absent, never as a hash that names nothing.

`autopilot_status` shows phase, gates, required roles with latest verdicts, replan
budget, and enforcement state at any time. `autopilot_log` records four-cell
checkpoints (`on-plan|detour|grind|escalate`). `autopilot_signal` carries
replan / block / owner-decision / owner-approve / owner-resolve.

### Where run state lives

Run state lives under `$DSH_HOME/storages/dsh-autopilot/runs/<sessionId>/`
(`events.jsonl` canonical, `snapshot.json` + `log.md` projections).

`storeKind` is `auto` in the SCHEMA — probe for `ctx.storageDomain`, use it when
present, record the backend actually obtained in `enforcement.store` — but this
bundle's own `cordis.patch.yml` pins `storeKind: file`, and the reason is a
measured deployment fact rather than a preference. Both profiles resolve the
same run root, so under `auto` a web profile (which mounts `ctx.storageDomain`)
and a headless profile (which does not) end up with two canonical media that
cannot see each other — 41 file-backed runs and 5 domain-table runs, measured on
one machine. The domain backend cannot be the shared medium either: its json
backing is read-once-at-open plus whole-file republish, so two processes on one
unit clobber rather than interleave. A profile that wants the domain backend
overrides the row by id; pinning sets the default, not a ceiling. See DESIGN.md
§6 and §7.

`log.md`, usage artifacts and the outbound manifest stay on the same filesystem
path under either backend, so an artifact ref never changes meaning when the
event backend does. Override the root with `storeRoot` in config, or with
`DSH_AUTOPILOT_HOME` in the environment; both accept a leading `~`, expanded the
same way dsh's own `resolveDshHome` expands it.

Runs stranded in the domain tables by an earlier `auto` deployment can be
exported on demand — never at mount — with
`node lib/tools/migrate-domain-runs.js` (dry run by default; `--apply` writes).
It only ever creates new files: it never deletes a domain record, never
overwrites a run the file store already holds, and never writes a stream that
does not survive the strict fold.

### Usage evidence

`autopilot_usage` answers, per change id, how the change was actually OPERATED.
Last-wins per id; a new id may be declared mid-run.

| class | what it must carry |
|---|---|
| `gui`, `cli`, `api-behavior` | ≥2 boundary states (≥1 from the canonical menu) and ≥1 artifact |
| `harness` | ≥1 artifact of kind `test-run` |
| `internal`, `docs` | neither |
| `unsupported` | `unsupportedReason` plus a non-empty `attempted` list (an honest terminal, not a failure) |
| `undeclared` | the entry state; blocks the plan gate and completion |

Boundary-state menu: `empty`, `full`, `at-top`, `at-bottom`, `extreme-value`,
`interrupted`, `narrow-window`, `first-run`, `permission-denied`, `offline`,
`fallback`, `long-running`, `concurrent`, `error-path`.

At closeout, every artifact belonging to an artifact-requiring class
(`gui`/`cli`/`api-behavior`/`harness`) is settled against the filesystem: it must
resolve strictly inside the run directory, exist, be non-empty, carry a
`capturedAt` at or after the plan-gate pass (the only anchor for the LOWER bound
— a run with artifacts and no recorded pass fails on that alone) and at or before
the settlement clock the engine passes in, within `FUTURE_SKEW_MS`, and —
for text kinds — actually contain each label it claims to cover. Binary kinds
(`screenshot`, `screencast`) settle on a format signature only, so their
`covers` labels are never checked against content. An artifact citing a prior
run via `inheritedFrom` returns from settlement unchecked; the exemption is
visible in the snapshot, and the audit layer owns it.

### Outbound evidence manifest

Egress goes through the native `tools/pre-execute` seam, which reads a manifest
before anything is sent and before the owner is even asked.

**Where the file goes.** Two candidates are consulted in order, and the FIRST ONE
THAT EXISTS is the one used (first-existing, not first-valid — otherwise a
failing owner-placed manifest could be silently overridden by a second file):

1. `<run>/outbound/manifest.json` — that is
   `$DSH_HOME/storages/dsh-autopilot/runs/<sessionId>/outbound/manifest.json`
   under the default root. Usually outside the session's workspace-write roots,
   so in practice owner-placed.
2. `<workspaceRoot>/.dsh-autopilot/outbound/manifest.json` — inside the workspace,
   so an agent's own fs/shell tools can write it.

The owner (not the agent) can pin a single path with
`DSH_AUTOPILOT_OUTBOUND_MANIFEST`, which then replaces both candidates outright;
a relative value resolves against the process cwd, deliberately not against the
run directory.

The second candidate is a deliberate loosening (2026-08-25) and it is the only
one in that direction. It does not move the boundary: every validation rule is
applied identically wherever the bytes came from, a clean manifest still only
buys an `ask` the owner answers, and artifact refs must still resolve strictly
inside the run directory — so an agent that can now author the CLAIM still cannot
manufacture the ARTIFACT bearing it. Measured negative control: a manifest left
in the workspace candidate carrying a previous run's id is refused by run id AND
by its unreadable artifact. DESIGN.md §6 records what it costs.

**What it must contain.**

```json
{
  "v": 1,
  "runId": "<the live run's session id>",
  "target": "github.com/owner/repo PR #12",
  "commands": ["git push", "gh pr create"],
  "claims": [
    { "text": "the migration ran on 3 of 3 shards", "bearer": "evidence/migrate.txt" },
    { "text": "typecheck is clean", "bearer": "evidence/tsc.txt" }
  ],
  "artifacts": [
    { "ref": "evidence/migrate.txt", "covers": ["3 of 3", "shards"] },
    { "ref": "evidence/tsc.txt", "covers": ["tsc"] }
  ],
  "createdAt": "2026-08-24T21:40:00.000Z"
}
```

Every rule the validator applies, and the reason each exists:

- `runId` must equal the live run — a manifest cannot shed one run's obligations
  onto another.
- Each `commands[i]` needs ≥2 whitespace tokens and must match the actual command
  at a shell token boundary. `cd repo && git push` matches `git push`;
  `["s"]` and `["it push"]` do not match anything.
- `createdAt` must be within 6h and not future-dated beyond 60s of clock skew.
- ≥1 claim. A manifest with zero claims discharges nothing.
- Exactly one artifact per claim: `bearer` must name a declared artifact, and two
  claims may not share one bearer.
- Each artifact must exist, be non-empty, resolve strictly inside the run
  directory, declare at least one `covers` label, and its text must contain every
  label it declares.
- Every count-shaped phrase inside a claim (`N%`, `N/M`, `N of M`, and a bare
  number followed by tests/files/cases/items) must appear in the text of its
  bearing artifact — whitespace- and case-insensitively. This is the rule that
  catches a stale number surviving into a PR description after the thing it
  counted moved on.

**What happens when it is missing, stale, or mismatched.** The pre-execute seam
returns a `deny` naming every path it consulted — each annotated with whether
this session can write there — plus, when the manifest is simply absent, a
filled-in JSON skeleton stamped with the live run id, a `createdAt` on the
validation clock, and a command class read off the refused command. The denial
states the constraint and the remedy rather than restating a rule. It names every
problem it found, and the
call never reaches the approval prompt — asking a human to approve unsettled text
just launders an unverified number through a person. When the manifest validates,
the seam either consumes a standing `autopilot_signal owner-approve` — but only
one whose `target` is itself an egress command AND matches the live command at a
shell token boundary, so an approval is not a fungible token (v1's
one-approval-per-egress semantics, preserved; the matching rule is new) — or
returns `ask`, which dsh resolves
through `ctx.approval`; with no approval service composed, the runtime degrades
the ask to a deny by itself. A call that carries a callId and did not pass this scope's
pre-execute waterfall is REFUSED at dispatch rather than re-resolved, so the
seam's safety is not owned by upstream call ordering. Only a call that reached
dispatch archives the manifest to `<run>/outbound/consumed/` (under a filename
carrying a per-consumption nonce; the archive is a record, NOT replay
protection — see DESIGN.md §6), and only one that dispatched without an
error result bumps `enforcement.outboundConsumed`. Read that counter as
"dispatched, and the runtime did not flag an error" — NOT as "the egress went
out": `isErrorResult` keys on `isError === true`, and a shell tool that exits
non-zero without setting that flag still counts (measured 2026-08-27, four
failed pushes incremented it; see DESIGN.md §6). The archive/event pairing is
correspondingly weak in BOTH directions: an archive with no matching
`consume-manifest` event means only that `next()` returned an error result, and
`next()` may well have run the command and reached the remote before erroring —
so that shape does NOT identify the authorized-but-never-dispatched case either.
Treat the pairing as "authorized" vs "authorized and the runtime reported an
error", and read neither as a statement about whether the egress left.

### Boundaries

Deliberate and documented in [DESIGN.md](./DESIGN.md) §4/§6. In v2 reality:

- `GET /api/autopilot/runs` and `/run` are fenced by the host's `connection`
  service (`requestRejection`, the same Host/Origin fence plus browser
  authentication the in-tree gateway applies to its own `/api` prefix), looked
  up on every request. A host with a web server but no `connection` service gets
  `503 no-connection-service`, never an open route. The fence is the host's; the
  plugin only applies it and cannot make it stronger.

- Run state is NOT part of the dsh Session log — session export/fork does not
  carry it. This is an upstream constraint, re-measured 2026-08-24, not a
  preference: the persisted session event vocabulary is closed to out-of-tree
  plugins by construction (DESIGN.md §4 quotes the source).
- Two processes sharing one run are out of contract and surface as loud fold
  failures, not silent merges.
- The outbound manifest proves each claim HAS a bearing artifact that mentions
  what it claims to cover — never that the artifact is truthful. A `covers` label
  shorter than 3 trimmed characters is refused at declaration and at both
  settlement sites (`MIN_COVERS_LABEL_LENGTH`). Labels that are long enough but
  still occur in unrelated text remain an audit-layer question. Command matching is text
  matching with a token floor and a text-level segmenter: a renamed binary, an
  in-script subprocess, a second egress inside `$(...)`, or an unenumerated
  channel is out of scope. So is a shell separator sitting inside a quoted
  option value between the verb and its subcommand — `git -c
  http.extraHeader="Cookie: a=1; b=2" push origin main` is NOT classified as
  egress (measured 2026-08-25; a pre-existing hole, not a regression from this
  round's tightening, and now recorded in DESIGN.md §6).
- The egress boundary applies to a LIVE run only. With no autopilot run on the
  session, or after one reached `completed`/`blocked`, both seams allow egress —
  mounting this plugin does not turn every session into a gated one. Both seams
  answer that question the same way on purpose; disagreeing would brick `git push`
  for every session that merely has the plugin loaded.
- A usage artifact's `capturedAt` is SELF-REPORTED. Both bounds are enforced at
  closeout: the lower one against the moment the plan gate passed, and the upper
  one against a settlement clock the engine passes in (with a `FUTURE_SKEW_MS`
  tolerance), so a future-dated stamp no longer settles. What remains unverifiable
  is whether the timestamp is TRUTHFUL — nothing here can tell a genuinely fresh
  artifact from one restamped to look fresh. (The earlier round in which the engine
  passed no clock, measured 2026-08-25 with a 2027 timestamp, is history; see
  DESIGN.md §8.)
- Usage classes, entry counts, and the `lightweight` exemption are all
  SELF-DECLARED. Nothing can observe a GUI change declared as `internal`, a
  three-change run that seeded one entry, or a standard run triaged lightweight.
  The question is asked mechanically; the answer is not verified mechanically.
- `enforcement.egress: 'native-ask'` means the pre-execute listener registered
  without throwing — an existence bearer, not proof that the runtime dispatches
  to it. The genuinely absent case does fail closed: no seam means the
  synchronous guard denies ALL egress unconditionally (stricter than v1 — a
  standing owner approval no longer opens it) and the run records `'guard-deny'`.
- `enforcement.approval: 'native'` means an approval service is present, its
  session policy is not `'never'`, AND at least one listener is subscribed to
  `approval/request`; anything else records `'signal-only'`. That is a real
  narrowing (before 2026-08-25 it recorded `'native'` on the mere presence of the
  service, including on hosts where every ask resolved `unavailable`), but it is
  still not proof that an ask gets ANSWERED: a subscribed listener that declines
  every request reads as answerable, so `'native'` can still overstate the
  channel. It errs safe in the other direction. DESIGN.md §6 has the measurements.
- The domain store backend exists only where the web-app bundle is mounted (or
  where a profile patch adds the storage rows); headless deployments run the file
  path by default. The plugin's `apply` is async and returns its disposer
  directly, so the host's own loader wait covers the store opening before any
  session is created — measured 2026-08-25 as 21 of 21 domain boots carrying the
  full tool surface, where before the fix 3 of 39 boots silently exposed no
  autopilot tools at all. What the domain backend still lacks is a full run: it
  has been driven to `autopilot_init` and no further, so artifact settlement,
  the revision-key overflow guard and the corrupt-key path are file-backend
  evidence only.

## Config

See the annotated example in [DESIGN.md §7](./DESIGN.md) — per-role auditor/executor
model routing, gate toggles, `storeKind`, store root, and the three
owner-channel environment variables. The plugin exports a real Schemastery
`Config` with an explicit unknown-key refusal, so a mistyped key in a profile —
at the top level or nested — is named by the loader instead of silently
defaulted. Note that `gate.egressDeny: false` disables the egress boundary
entirely (`enforcement.egress: 'off'`); it is not a way to loosen it.

## Develop

```sh
pnpm run check   # typecheck
pnpm run test    # vitest (the current suite count lives in DESIGN.md §8, measured per audit round)
pnpm run build   # emit lib/
```

The client half types and bundle-tests itself against a BUILT dsh source
checkout at the same version as the pins: set `DSH_SRC` to that tree (default
`~/dsh`) and `DSH_STORE` to its pnpm store (`<DSH_SRC>/node_modules/.pnpm`)
before `check:client`, `build:client` and `test:client-bundle`. With the pins at
`0.1.2-rc.1` the checkout must be tag `dsh-v0.1.2-rc.1` built with
`pnpm install && pnpm run build`; an older tree lacks
`packages/client/ui-conversation/lib/types/client/index.d.ts` and
`check-client-types.mjs` refuses by name.

Requires Node 22+. `src/` imports exactly two non-relative PACKAGES; every other
non-relative import is a `node:` builtin (measured 2026-08-25: 15 non-relative
value imports across 16 files — 13 builtins plus the two packages). The two are
`@deepseek-ai/dsh-tools` (a **peer**, range
`0.1.2-rc.1 || >=0.1.5-rc.1 <0.1.6`; the test/build pin stays in
`devDependencies`) for `defineTool`, and `@deepseek-ai/schemastery` (also a
`peerDependencies` entry the host already provides) for the `Config` export.
`@deepseek-ai/cordis` is a devDependency only — no file in `src/` imports it,
so it is not declared as a peer. Shipping `dsh-tools` in runtime
`dependencies` (0.1.0) created a second module instance and split
`TOOL_RUNTIME_SCHEDULER`. 0.1.1 keeps a single host copy. Other dsh surfaces
reach the plugin through injected services and local structural types.
