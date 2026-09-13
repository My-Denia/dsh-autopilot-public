# Operator reference

First-time users should start from the [README](../README.md) natural-language
path. This page is the operator / tool protocol that used to live on the
landing page.

The skill file shipped with the plugin (`skill/dsh-autopilot/SKILL.md`) is
the in-session copy of the same pipeline.

## Tool sequence

1. `autopilot_init` — triage: objective, scope, non-goals, acceptance
   criteria, risk, size, executionMode (inline/delegated), auditMode
   (self-check/independent/external). Standard runs also seed usage ids
   (default: one entry, `m1`).
2. `autopilot_submit_plan` → `autopilot_usage` for every seeded id →
   `autopilot_audit role=plan` (or `autopilot_self_check` on
   lightweight+low, or `autopilot_external_audit` on `auditMode: external`).
   A pass verdict on a run with an undeclared entry is recorded and then
   refused at the gate flip.
3. Implement (inline), or `autopilot_executor action=start` (delegated; the
   child returns via private `autopilot_submit_packet`).
4. `autopilot_submit_evidence` (inline) → `autopilot_audit role=execution`
   (`role=rules` when the run touches the operating layer or risk ≥ high).
5. `autopilot_submit_closeout` — completes the run, or names what is
   missing.

`autopilot_status` shows phase, gates, required roles, replan budget, and
enforcement. `autopilot_log` records four-cell checkpoints
(`on-plan|detour|grind|escalate`). `autopilot_signal` carries replan /
block / owner-decision / owner-approve / owner-resolve.

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
operated. Last-wins per id.

| class | what it must carry |
| --- | --- |
| `gui`, `cli`, `api-behavior` | ≥2 boundary states (≥1 from the canonical menu) and ≥1 artifact |
| `harness` | ≥1 artifact of kind `test-run` |
| `internal`, `docs` | neither |
| `unsupported` | `unsupportedReason` plus a non-empty `attempted` list |
| `undeclared` | blocks the plan gate and completion |

Boundary-state menu: `empty`, `full`, `at-top`, `at-bottom`, `extreme-value`,
`interrupted`, `narrow-window`, `first-run`, `permission-denied`, `offline`,
`fallback`, `long-running`, `concurrent`, `error-path`.

Outbound evidence rules: [security.md](security.md).

## Skill copy fallback

When the plugin is not loaded, or hard-link publication is `unsupported`:

```sh
# macOS / Linux — fallback only
mkdir -p ~/.agents/skills/dsh-autopilot
cp skill/dsh-autopilot/SKILL.md ~/.agents/skills/dsh-autopilot/SKILL.md
```

```powershell
# Windows PowerShell — fallback only (not a Windows support claim)
New-Item -ItemType Directory -Force "$HOME\.agents\skills\dsh-autopilot" | Out-Null
Copy-Item skill\dsh-autopilot\SKILL.md "$HOME\.agents\skills\dsh-autopilot\SKILL.md"
```
