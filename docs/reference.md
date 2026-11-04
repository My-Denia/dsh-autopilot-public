# Operator reference

First-time users should start from the [README](../README.md). This page is for
operators: the tools the plugin registers, the ledger it keeps, the DSH tools
the workflow relies on, and configuration. The tool list the host shows in a
session is authoritative; the plugin's tool surface may still change while the
engine work lands, so check it before scripting against a name or parameter.

Who owns what:

- `skill/dsh-autopilot/SKILL.md` is the in-session adapter: when the workflow
  applies and the order of operations.
- This page owns tool names, parameters, the ledger and configuration.
- [../skill/dsh-autopilot/references/model-routing.md](../skill/dsh-autopilot/references/model-routing.md)
  owns work classes, the ladder, escalation and the routing contract.
- [../skill/dsh-autopilot/references/governance-invariants.md](../skill/dsh-autopilot/references/governance-invariants.md)
  owns the invariants that still hold (evidence, review findings, delegation).
- [../skill/dsh-autopilot/references/refusals.md](../skill/dsh-autopilot/references/refusals.md)
  owns every remaining `AP_*` refusal and its remedy.

There is no init step and no run phase. A goal is started by the owner through
the host's goal tools; the plugin tools below only start, follow and record
children.

## Plugin tools

### `autopilot_delegate`

Starts one role child. Parameters:

| parameter | meaning |
| --- | --- |
| `role` | `scout`, `clerk`, `worker`, `executor-lead`, `planner` or `reviewer` |
| `task` | the brief: outcome, files, what the child may not touch, a checkable result |
| `writePaths` | paths the child may write; read-only roles get none |
| `model`, `effort` | optional explicit route. Beats a profile pin and the plugin's choice |

Roles:

| role | what it is | tools |
| --- | --- | --- |
| `scout` | search, inventory, log reading; returns compressed findings | read-only, depth 1 |
| `clerk` | external reads and writes through connector tools present in the session; says so when none are | read-only plus the connector tools that exist |
| `worker` | one bounded piece with explicit `writePaths` | write access limited to its `writePaths`, depth 1 |
| `executor-lead` | owns one chunk end to end; may start scout, clerk and worker children; integrates and validates | depth 2 |
| `planner` | read-only plan or diagnosis | read-only |
| `reviewer` | independent one-shot review, fresh context, structured verdict | read-only, one-shot |

Children started in the same turn run in parallel. A `worker` whose
`writePaths` intersect those of a running worker is refused before anything
starts; this is a check, not an approval step. A child started by an
`executor-lead` is a child of that lead (depth 2). A lower explicit user
`maxDepth` is respected.

The reviewer returns its verdict in-band. The main agent cannot write a
verdict into the ledger. The reviewer is given a model family different from
the change when one is reachable; otherwise the record says "reduced
independence".

Every dispatch carries an explicit model and effort. The result reports the
selected route and the observed one; trust the observed one.

### `autopilot_agents`

Follows and steers the children the plugin started:
`action: list | wait | message | stop | escalate`. `wait` blocks for children
inside the turn (host-clamped, at most 10 minutes per wait). `escalate` is how a
child proposes a new dispatch on a higher route; the new child gets the same
contract and the role's eligibility is never widened.

The exact action set depends on whether the host's own `list_agents` and
`send_message` cover children started by the plugin runtime. That is not yet
verified (see [compatibility.md](compatibility.md#not-yet-verified-on-a-real-host)),
so this tool may shrink.

### `autopilot_status`

Shows the ledger for the current session: delegations, routes, reviewer
verdicts, links, legacy runs, and a one-time note when a removed config key was
supplied.

### Other plugin tools

`autopilot_log` and `autopilot_request_escalation` may still be registered;
check the tool list the host shows. They are not part of the contract above.

## Ledger

The issue and the PR are the record. The ledger is a display aid for execution,
cancel, resume and history. It is not a todo list and not a completion
judgement. Each delegation record holds:

| field | meaning |
| --- | --- |
| `role` | the role it was started as |
| child id | the host's id for the child |
| generation | the child's generation; a replacement child gets the next one |
| selected route, source | the model and effort the plugin or the call chose, and why: pin, ladder, call argument or adapter default |
| observed route | the model and effort the host reports the child actually ran on |
| `state` | where the child is now, including `lost` for a child that was running when the host restarted |
| `writePaths` | the paths a worker may write |
| reviewer verdict | the verdict text and the model family, as evidence of independence |
| links | the issue and PR the goal belongs to |

The ledger also carries the goal id and revision it was started under and
markers for legacy runs.

Legacy runs written by plugin 0.2.x stay readable. They are shown read-only on
the card, are not continued, and no new event is written to their streams. The
`autopilot_status` view lists them.

## DSH tools the workflow uses

These belong to the host, not the plugin.

| tool | use |
| --- | --- |
| `get_goal` | read the current goal with its `goal_id` and `revision` |
| `create_goal` | create the goal with the Outcome as its objective. Needs the owner's direct top-level turn |
| `update_goal` | `complete` or `blocked` (also allowed in an autonomous goal round), `resume`, edit, pause. Needs the exact `goal_id` and `revision` from `get_goal`; all but `complete`/`blocked` need the owner's direct turn |
| `job_output` | `job_id`, optional `wait` and `timeout_ms` (default wait 30 s, cap 10 minutes) for a background command or CI watcher |
| `list_agents`, `send_message` | the host's own view of and channel to agents |
| `schedule_create` | set a delayed reminder (`after_seconds` and related). Only the main agent may call it; a child is refused (`subagent_session`) |

A goal stays disarmed after a session resume, fork or host restart until the
owner says "continue" (`update_goal` with `action: resume`). A reminder from
`schedule_create` is delivered into the session after a restart but does not
re-arm the goal. The goal round cap defaults to 256 and ends in the blocker
code `round-limit`.

## Configuration

`routing.*` keeps working: mode, preference, roles, ladder and work classes.
See
[model-routing.md](../skill/dsh-autopilot/references/model-routing.md) for the
shape and how roles map to work classes. `skillInstall` (`auto` or `off`) and `storeRoot` are kept.

Removed keys are accepted and ignored: `gate.*`, `governance.*`, `storeKind` and
`crossFamily`. A profile that still sets
them loads without error, and `autopilot_status` notes this once. Legacy
`storeKind` file and domain backends stay readable for history. The root can
still be set with `storeRoot` or `DSH_AUTOPILOT_HOME` (both accept a leading
`~`).

For a web profile, include the web app bundle and the npm package name:

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

## Skill copy fallback

When the plugin is not loaded, or hard-link publication is `unsupported`:

```sh
# macOS / Linux, fallback only
mkdir -p ~/.agents/skills/dsh-autopilot/references
cp skill/dsh-autopilot/SKILL.md ~/.agents/skills/dsh-autopilot/SKILL.md
cp skill/dsh-autopilot/references/*.md ~/.agents/skills/dsh-autopilot/references/
```

```powershell
# Windows PowerShell, fallback only
New-Item -ItemType Directory -Force "$HOME\.agents\skills\dsh-autopilot\references" | Out-Null
Copy-Item skill\dsh-autopilot\SKILL.md "$HOME\.agents\skills\dsh-autopilot\SKILL.md"
Copy-Item skill\dsh-autopilot\references\*.md "$HOME\.agents\skills\dsh-autopilot\references\"
```

Copying only `SKILL.md` installs an adapter whose routed references are absent:
the adapter's links then point at nothing.
