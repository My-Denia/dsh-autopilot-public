# Operator reference

First-time users should start from the [README](../README.md) natural-language
path. This page is the operator / tool protocol that used to live on the
landing page.

Ownership is by LAYER. A document may **name** a rule another document owns; a
rule's defining text — its table, its menu, its contract — belongs to exactly one
place:

Two defining blocks are *mechanically* censused today (the usage-class table and
the boundary-state menu, by `test/references-contract.test.ts`), plus the 14
governance headings. Outside those anchors this is a review discipline, not an
invariant: the manual-install commands and the closeout/external-audit
summaries deliberately appear in more than one layer, because an operator
reading this page should not have to open the adapter to copy two files. Where
they overlap they are summaries; the contract itself is owned once, and
`references/refusals.md` is where a refusal's contract lives. The layer owners:

- `skill/dsh-autopilot/SKILL.md` is the in-session **adapter** — the DSH
  bindings and the order of operations.
- this page owns the **tool protocol** — tool names, parameters, phases and run
  state.
- [../skill/dsh-autopilot/references/governance-invariants.md](../skill/dsh-autopilot/references/governance-invariants.md)
  owns the **host-neutral rules** (risk, audit modes, the audit invariants,
  evidence sufficiency, closeout). The skill routes there rather than restating
  them. It is published into the skill directory, so the in-session reader
  reaches it too.
- [../skill/dsh-autopilot/references/refusals.md](../skill/dsh-autopilot/references/refusals.md)
  owns **every refusal**: what each `AP_*` code requires in advance and what to
  do when you get it.

## Tool sequence

1. `autopilot_init` — triage: objective, scope, non-goals, acceptance
   criteria, risk, size, executionMode (inline/delegated), auditMode
   (self-check/independent/external). Standard runs also seed usage ids
   (default: one entry, `m1`). Optionally declares `carryoverFromRunId` +
   `carryoverNote` + `carryoverInherits`: this run continues a COMPLETED
   predecessor's authorized work (refused when the predecessor is missing or
   not completed).
2. `autopilot_submit_plan` → `autopilot_usage` for every seeded id →
   `autopilot_audit role=plan` (or `autopilot_self_check` on
   lightweight+low, or `autopilot_external_audit` on `auditMode: external`).
   A pass verdict on a run with an undeclared entry is recorded and then
   refused at the gate flip. Auditors may return graded `findings`
   (`blocking`/`non-blocking` × `plan`/`execution`/`rules`): a `pass` may
   carry non-blocking findings; a `needs-replan` without a blocking
   plan-layer finding is refused pre-commit (`AP_AUDIT_FINDINGS_INVALID`) —
   executor-fixable defects belong in `needs-fix`.
3. Implement (inline), or `autopilot_executor action=start` (delegated; the
   child returns via private `autopilot_submit_packet`). Mid-execution plan
   refinement goes through `autopilot_amend_plan` (text + note): the plan
   revision bumps, execution state survives, and evidence/closeout are gated
   until a plan-role delta pass at the amended revision lands
   (`AP_AMEND_REAUDIT_REQUIRED`).
4. `autopilot_submit_evidence` (inline) → `autopilot_audit role=execution`
   (`role=rules` when the run touches the operating layer or risk ≥ high).
5. `autopilot_submit_closeout` — completes the run, or names what is
   missing. Unproven criteria make it a PARTIAL delivery:
   `handoffOpenItems` must map every unproven criterion to exactly one open
   item (`implemented-unverified` / `not-implemented` /
   `known-limitation`), optionally `handoffNextAuthorizedAction`; the
   outcome label (`complete`/`partial`) is DERIVED by the engine, never
   taken from the caller.

`autopilot_status` shows phase, gates, required roles, replan budget, and
enforcement. `autopilot_log` records four-cell checkpoints
(`on-plan|detour|grind|escalate`). `autopilot_signal` carries replan /
block / owner-decision / owner-approve / owner-resolve.
`owner-resolve` takes `resume-planning` (full reset), `resume-execution`
(restore the paused-from phase with gates/evidence untouched — requires a
pause that stamped it), or `block`. Replan-budget exhaustion never forces an
owner decision: the run stays in its replanning lane with the exhaustion
visible; escalation is deliberate.

**No structured verdict** means a gate does not flip.

## Closeout evidence kinds

Every evidence item carries `kind: 'path' | 'command'`. The tool refuses an
item without it. Three layers, deliberately different:

- TOOL SCHEMA requires `kind` on every item.
- ENGINE and REPLAY require it only on `proven` items.
- The `evidenceKinds: 1` stamp on the closeout event means "proven evidence
  kind validation v1", not "every item carries a non-empty kind".

Closeout keys off event format stamps, not `// bearerBase`. Each proven
bearer is exactly one acceptance criterion.

An artifact citing a prior run via `inheritedFrom` returns from settlement
unchecked; the exemption is visible in the snapshot, and the audit layer
owns it.

## External audit

`auditMode: external` is owner-countersigned: `autopilot_external_audit` on
a direct human turn. An agent-generated turn is refused. `reviewRef` names a
file inside the run directory. The optional `treeHash` is **declared, never
verified** — this package contains no git. An external pass is weaker
evidence than a dispatched audit; the record keeps them distinguishable.
`self-check` remains refused in this mode.

## Delegated executor

The child is continuable. `needs-fix` resumes the **same** child;
`needs-replan` drains before revoking. Packet submission CASes on
`executionRevision` (`AP_PACKET_REVISION_REQUIRED` /
`AP_PACKET_REVISION_MISMATCH`) plus the occupied-slot check.

Install of the child's packet tool, egress guard, and native seam is
**transactional** from `agent/created`. A plugin **remount** while an
executor is already live is **warned, not vetoed** — there is no publication
to refuse. Details: [DESIGN.md §6](../DESIGN.md).

On a stock node-only profile the auditor filter names only tools such a
deployment registers; any name it does not register is **dropped** with a
recorded diagnostic rather than aborting the dispatch.

## Run state

Run state lives under `$DSH_HOME/storages/dsh-autopilot/runs/<sessionId>/`
(`events.jsonl` canonical, `snapshot.json` + `log.md` projections).

This is **not** part of the dsh Session log. Upstream
`KNOWN_SESSION_EVENT_TYPES` is closed to out-of-tree plugins
([DESIGN.md §4](../DESIGN.md)). **Two processes** sharing one run are out of
contract and surface as loud fold failures.

`storeKind` is `auto` in the schema, but this bundle's `cordis.patch.yml`
pins `storeKind: file` so a web profile and a headless profile do not split
the canonical medium. Override the root with `storeRoot` in config, or with
`DSH_AUTOPILOT_HOME` in the environment; both accept a leading `~`.

For a web profile, include the web app bundle (it mounts `ctx.storageDomain`)
and the npm package name:

```json
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "dsh-goal-autopilot"
] } }
```

Runs stranded in domain tables can be exported on demand with
`node lib/tools/migrate-domain-runs.js` (dry run by default; `--apply`
writes). It never deletes a domain record and never overwrites a file-backed
run.

Config is a Schemastery `Config` with explicit **unknown-key** refusal. See
[DESIGN.md §7](../DESIGN.md).

## Usage classes

`autopilot_usage` answers, per change id, how the change was actually
operated. Last-wins per id; the question is re-asked at closeout.

The class table and the boundary-state menu are owned once, by the adapter the
agent is actually routed to:
[Usage classes](../skill/dsh-autopilot/SKILL.md#usage-classes-autopilot_usage). This page deliberately does
not carry a second copy — two copies of a table is how the two copies start
disagreeing.

Outbound evidence rules: [security.md](security.md).

## Skill copy fallback

When the plugin is not loaded, or hard-link publication is `unsupported`:

```sh
# macOS / Linux — fallback only
mkdir -p ~/.agents/skills/dsh-autopilot/references
cp skill/dsh-autopilot/SKILL.md ~/.agents/skills/dsh-autopilot/SKILL.md
cp skill/dsh-autopilot/references/*.md ~/.agents/skills/dsh-autopilot/references/
```

```powershell
# Windows PowerShell — fallback only (not a Windows support claim)
New-Item -ItemType Directory -Force "$HOME\.agents\skills\dsh-autopilot\references" | Out-Null
Copy-Item skill\dsh-autopilot\SKILL.md "$HOME\.agents\skills\dsh-autopilot\SKILL.md"
Copy-Item skill\dsh-autopilot\references\*.md "$HOME\.agents\skills\dsh-autopilot\references\"
```

Copying only `SKILL.md` installs an adapter whose routed references are absent —
the adapter's links then point at nothing.
