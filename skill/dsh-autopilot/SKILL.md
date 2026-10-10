---
name: dsh-autopilot
description: >-
  Run goal-driven engineering work as a governed plan-execute-audit run using
  the autopilot_* tools. Use by default for execution tasks that modify
  files/config/remote state, debug or repair systems, or require sustained
  autonomous progress; also when the user asks for goal mode, autopilot,
  autonomous implementation, or plan-execute-audit.
---

# dsh-autopilot (DSH adapter)

When this skill triggers, start a run immediately with `autopilot_init` — do not
wait for further instruction. Owner-only boundaries (push/PR/release/publish,
destructive ops, credentials, payment, public-visible changes) still pause for
the owner; autonomous start is not autonomous egress.

This file is an **adapter**. It supplies the DSH bindings — tool names, parameter
shapes, the order of operations — and routes to the reference layer for the
rules. It deliberately does not restate them.

| read this | it owns |
| --- | --- |
| [references/governance-invariants.md](references/governance-invariants.md) | risk and audit shape, the audit invariants, evidence sufficiency, sizing, delegation, state, closeout |
| [references/refusals.md](references/refusals.md) | every `AP_*` refusal: what it requires in advance, and the remedy |
| `docs/reference.md` (in the package, not the installed skill) | the full tool protocol, phases and run state |

Read `references/governance-invariants.md` before dispatching any audit. Read
`references/refusals.md` when a tool call returns an `AP_*` code — the code is
the machine-stable identity, the message is context, the reference is the
specification.

## Triage

Pick honestly; the engine enforces the combinations (`AP_TRIAGE_INVALID`), and
the accepted values are the contract.

- **size**: `lightweight` (≤3 files, single concern) or `standard`. Choosing
  `lightweight` waives the plan gate, the sandbox clamp AND the usage dimension
  for the whole run. Nothing checks that choice — do not use it to get out from
  under the gates.
- **risk**: `low` / `medium` / `high` / `critical`. There is no `auto` here;
  resolve it at init. Medium and above may not self-review.
- **executionMode**: `inline` (you implement) or `delegated` (standard only; a
  continuable executor child implements and returns a packet). Delegation is
  task-shaped — see the reference — but the mode is fixed at init.
- **auditMode**: `independent` (dispatched isolated auditor), `external`
  (owner-countersigned) or `self-check` (lightweight+low only). The engine keys
  off the disqualifier, not an allow-list: `validateTriage` in
  `src/domain/types.ts`.
  `external` is owner-only — an agent-generated turn is refused.
  `autopilot_external_audit` **records** a run-relative `reviewRef` but does not
  create it; the file must exist in the run directory by closeout or the run is
  refused there. An external pass is weaker evidence than a dispatched audit and
  the record keeps them distinguishable.
- **touchesOperatingLayer**: `true` when the run modifies rules/skills/hooks/
  agent config — it adds the required `rules` audit role.
- **usageIds**: one id per user-visible change this run will make. Default is a
  single `m1`. If the run changes three separate things a user can observe, seed
  three ids — one entry answered once is not three changes answered.
- **baseline**: record commit, branch and dirty state in the init call.

## Pipeline

1. `autopilot_init` — standard runs clamp the session read-only until the plan
   gate passes.
2. Investigate read-only; `autopilot_submit_plan` with milestones each carrying
   a BINARY runnable validation check.
3. `autopilot_usage` for every seeded id, BEFORE dispatching the plan audit.
   A pass verdict on a run with an undeclared entry is recorded and then refused
   at the gate flip — you pay for the auditor and the gate stays shut.
4. Gate the plan, by the mode picked at init — the tools are NOT interchangeable
   and the engine refuses a mismatch:
   - `independent` → `autopilot_audit role=plan` with a bounded packet (never
     your reasoning). Build it from `autopilot_status.latestAuditRecords`,
     which carries each role's latest record verbatim.
   - `external` → `autopilot_external_audit role=plan` on a direct human turn.
     `autopilot_audit` rejects every mode but `independent`, so an external run
     that calls it stalls here.
     Note the ordering trap on standard runs: writes are clamped until the plan
     gate passes, so a plan review file has to be written by the owner (or by
     any path the clamp does not cover), not by the run itself before the gate
     flips.
   - `self-check` (lightweight+low only) → `autopilot_self_check`.
   On needs-replan, revise. Auditors grade findings
   (`blocking`/`non-blocking` × `plan`/`execution`/`rules`): a `pass`
   with non-blocking findings still passes, and a `needs-replan` that carries
   findings but no blocking plan-layer defect is refused (streams without the
   findings field keep the legacy reading) — executor-fixable findings take
   `needs-fix`. The replan budget is observed, never auto-escalated:
   after 2 consecutive non-converging rounds, EXPLICITLY consider the owner
   channel or split the plan smaller; decide, do not let the meter decide.
5. Execute per milestone (state the change, smallest edit, closest validation,
   `autopilot_log` as you go). Delegated: `autopilot_executor action=start`.
   The child submits with `autopilot_submit_packet` **including**
   `executionRevision` equal to the live executor revision (1 at start, +1 on
   each needs-fix resume). A stale or missing value is refused.
   Mid-execution plan refinement (implementation detail, milestone shape —
   never objective/scope/criteria, which are immutable) goes through
   `autopilot_amend_plan`: execution state survives, and a plan-role delta
   pass at the amended revision re-opens evidence/closeout.
6. `autopilot_submit_evidence` (inline) or the child's packet → gate execution
   with the SAME mode-specific tool as step 4, `role=execution` (`role=rules`
   when required).
7. `autopilot_submit_closeout` — one bearing artifact per acceptance criterion
   or an honest `unproven`; every evidence item declares
   `kind: 'path' | 'command'` (`path` folds against the run workspace, so
   `./x` and `/ws/x` are one artifact; `command` compares verbatim, so
   `git status` and `./git status` stay two; the tool schema refuses an item
   with no `kind`; the engine and replay require it only on `proven` items,
   since an unproven entry has no bearer to classify); a proven bearer may not
   carry two criteria of the same kind; workspace cleanup; drift (`none found`
   or exact facts). Any `unproven` criterion makes this a PARTIAL delivery:
   `handoffOpenItems` maps each unproven criterion to exactly one open item
   (`implemented-unverified` / `not-implemented` / `known-limitation`), and
   the engine derives the outcome label. A follow-up run continues the work by
   declaring `carryoverFromRunId` at init.

Report `[TRIAGE]/[PLAN]/[USAGE]/[PLAN-AUDIT]/[EXEC]/[AUDIT]/[CLOSEOUT]` progress
lines at every phase transition. `autopilot_status` is the canonical state; never
narrate a status that contradicts it.

## Usage classes (`autopilot_usage`)

Answers how a change was OPERATED, not that it built. Last-wins per id; a new id
may be declared mid-run. The question is re-asked at closeout, so an entry
downgraded back to `undeclared` blocks completion too.

| class | what it must carry |
| --- | --- |
| `gui`, `cli`, `api-behavior` | ≥2 boundary states (≥1 from the menu) and ≥1 artifact |
| `harness` | ≥1 artifact of kind `test-run` |
| `internal`, `docs` | no artifact required |
| `unsupported` | `unsupportedReason` plus a non-empty `attempted` list |
| `undeclared` | blocks the plan gate and completion |

Boundary-state menu: `empty`, `full`, `at-top`, `at-bottom`, `extreme-value`,
`interrupted`, `narrow-window`, `first-run`, `permission-denied`, `offline`,
`fallback`, `long-running`, `concurrent`, `error-path`.

Artifact refs are run-directory-relative and must post-date the plan-gate pass;
they are settled against the filesystem at closeout. Pick the class that is TRUE.
Nothing can observe a GUI change declared `internal` — that check is the
auditor's, and declaring around the obligation is the failure this dimension
exists to catch.

## Egress (push / PR / release / publish)

Write `<run>/outbound/manifest.json` BEFORE attempting the command. It must
carry `v: 1`, the live `runId`, a `target`, `commands` (each ≥2 tokens,
matching the command you will actually run at a shell token boundary), ≥1
`claims` each naming exactly one bearing artifact, the `artifacts` with their
`covers` labels, and a `createdAt` under 6h old. `commands` must cover EVERY
egress segment of the line you run: the command is split on `&&`, `||`, `;`,
`|`, `&` and newlines, and a push-only manifest will not authorize
`git push origin main && npm publish` — declare both, or run them as two
commands with a manifest each. Every count-shaped phrase in a claim must appear
verbatim in the artifact that bears it.

If the manifest is missing, stale, mismatched, does not cover every egress
segment, or any artifact is empty/absent/outside the run directory, the call is
DENIED before the owner is ever asked — so a rejection here is a manifest to
fix, not an approval to chase. When it validates, the owner is asked through
dsh's approval service and the manifest is archived as spent on dispatch. Never
re-word a claim to get past the gate.

What trips the matcher is TEXT, read command-shaped. On a `bash` / `pwsh` /
`terminal_open` line an unquoted `#` comment and the inside of a multi-word
quoted argument are dropped before matching, so `grep -rn "git push" .` and a
commit message that mentions pushing do not trip it. An UNQUOTED mention still
does (`cat notes/git-push.md`), and inside `run_code` source or
`terminal_send` keystrokes ANY occurrence does, because neither is a shell
command line. A read-only command refused that way is the over-inclusion
recorded in DESIGN.md §6 — say so and move on; do not reshape the command to
slip past it.

## Installing this skill

`apply()` publishes the bundled skill into the skill-scan root
(`$DSH_AGENTS_HOME/skills/dsh-autopilot/`, default `~/.agents`): `SKILL.md`
plus `references/`. A destination that already differs is a warning, not an
overwrite (`skillInstall: 'off'` skips the copy); a filesystem that cannot
hard-link is `unsupported` and writes nothing, with the manual remedy in
`detail`. After upgrading the plugin, refresh a drifted copy by hand.

Manual copy is the fallback when the plugin is not loaded:

```sh
# macOS / Linux — fallback only
mkdir -p ~/.agents/skills/dsh-autopilot/references
cp skill/dsh-autopilot/SKILL.md ~/.agents/skills/dsh-autopilot/SKILL.md
cp skill/dsh-autopilot/references/*.md ~/.agents/skills/dsh-autopilot/references/
```

```powershell
# Windows PowerShell — fallback only
New-Item -ItemType Directory -Force "$HOME\.agents\skills\dsh-autopilot\references" | Out-Null
Copy-Item skill\dsh-autopilot\SKILL.md "$HOME\.agents\skills\dsh-autopilot\SKILL.md"
Copy-Item skill\dsh-autopilot\references\*.md "$HOME\.agents\skills\dsh-autopilot\references\"
```
