# Reference

This page covers version 0.5.0: the five agent presets and their tool surfaces, the `delegate` tool, the skill, and the shapes the host refuses. The tool list a session shows is authoritative if it differs from this page.

## Presets

A preset is a child composition declared by this bundle. The main agent picks one per delegation through the `agent_preset` argument. A session can also be started on one, but the leaf presets declare no delegation row of their own and are meant for children.

| preset id | Loader row | roster order | tools |
| --- | --- | --- | --- |
| `goal-scout` | `preset-goal-scout` | 10 | `read`, `read_image`, `glob`, `grep` |
| `goal-worker` | `preset-goal-worker` | 11 | `bash` or `pwsh` (per platform), `jobs`, `read`, `read_image`, `write`, `edit`, `glob`, `grep` |
| `goal-executor-lead` | `preset-goal-executor-lead` | 12 | the worker's tools, `list_agents`, `send_message`, `wait_agent`, and its own `delegate` |
| `goal-planner` | `preset-goal-planner` | 13 | `read`, `read_image`, `glob`, `grep` |
| `goal-reviewer` | `preset-goal-reviewer` | 14 | `read`, `read_image`, `glob`, `grep` |

Each one also composes `@deepseek-ai/dsh-persona` with its role brief and `@deepseek-ai/dsh-time-context`. The read-only presets (`goal-scout`, `goal-planner`, `goal-reviewer`) mount `tool-fs` with `read: true`, `readImage: true`, `write: false`, `edit: false`; the write presets mount `tool-fs` with the `standard` preset's `applyPatch: false`, plus `tool-fs-search` and `tool-jobs`.

### Delegation depth per preset

| where | tool | `maxDepth` | `allowedAgentPresets` |
| --- | --- | --- | --- |
| profile level | `delegate` | 1 | the five presets |
| `goal-executor-lead` | `delegate` (scoped row) | 2 | `goal-scout`, `goal-worker`, `goal-planner` |

The profile-level row is what a main-agent session sees. A depth-1 child inherits it and is refused when it calls it; the lead's scoped row shadows it for agents on that preset and allows one more level. A lead cannot start the reviewer or another lead.

### Host requirements

The patch assumes the profile composition mounts:

- `@deepseek-ai/dsh-agent-preset-registry`, which provides the preset service the declarations register on and the `agent_preset` selection needs. Without it the `delegate` row fails at load: `agent preset selection requires the agent-presets service`.
- `@deepseek-ai/dsh-subagent` and `@deepseek-ai/dsh-subagent-spawn-in-process` (provider `spawn`), with the `depthLimit` and `agentOptions` capabilities the numeric `maxDepth` and `modelSelection` need.
- The services the preset tool rows use: `tools`, the sandboxed filesystem, the shell provider, `jobs`, and the prompt and session projections.

The Web and Desktop profiles compose all of these. A bare base profile mounts the spawn provider but not the preset registry.

## `delegate`

The tool is `@deepseek-ai/dsh-tool-subagent` mounted with tool name `delegate`, provider `spawn`, `modelSelection: true` and `modelDiscovery: true`.

| parameter | type | meaning |
| --- | --- | --- |
| `description` | string | required; a short (3–5 word) label of the delegated task, for display, in the user's language |
| `prompt` | string | required; the brief: outcome, files and paths, what may not be touched, the checks to run, the result expected |
| `agent_preset` | enum | one of `goal-scout`, `goal-worker`, `goal-executor-lead`, `goal-planner`, `goal-reviewer`. Omit to inherit the parent's preset, which is not a goal role, so name it |
| `provider`, `model` | string | optional explicit route; give both or neither |
| `reasoning_effort` | string | optional; requires `provider` and `model` in the same call |
| `name` | string | optional child name: lower-case letters, digits and hyphens, at most 32 characters, unique among the caller's children; `lead` is reserved |
| `cwd` | string | optional child working directory; relative paths use the caller's current directory, omitted inherits it |

The call starts an independently managed child and returns at once. The canonical result is `{ kind: 'activation', name }`, rendered as `started subagent <name>`; it carries no final answer. The runtime delivers the child's completion notice to the calling agent when the child finishes, including the final answer unless the child sent a message just before finishing.

`list_subagent_models` is registered by the same row (`modelDiscovery: true`). It reports the provider/model routes and efforts the host and the session's route policy allow, and it wants `provider` and `model` together when both are given.

### Refused shapes

| shape | when it is refused | remedy |
| --- | --- | --- |
| `agent_preset` outside the five ids | rejected by the tool before a child starts: `agent_preset must be one of: …` | use a declared id |
| `reasoning_effort` without `provider` and `model` | rejected before route lookup or child creation | name both, or drop the effort |
| `provider`/`model` the session policy does not allow | rejected by the route preflight | use a configured route, or `list_subagent_models` |
| delegation at the depth cap | errored result at every attempt; the tool stays visible | do the work directly, or delegate from the main agent |
| unknown or unloadable preset id in a call | errored result without starting a child | fix the id or the bundle |
| `fork` provider with preset selection | mount fails: a fork child inherits context and cannot select a preset | use `spawn` |
| numeric `maxDepth` with a provider without the `depthLimit` capability | mount fails loud | use `spawn`, or a provider-managed cap |
| duplicate or empty `allowedAgentPresets` | mount fails: duplicate or empty preset ids | keep ids unique and non-empty |
| a second `modelDiscovery` owner in one scope | registration fails | enable discovery on one row per scope |
| agent preset id omitted | not refused, but the child inherits the parent's preset | always name the role |

There are no plugin refusal codes in 0.5.0; every error is the host's own tool error.

## Skill

`skill/dsh-goal-autopilot/SKILL.md` is the adapter: when the workflow applies, how to start a goal, the roles and their briefs, the independent review, waiting inside an armed goal, and the done checks.

- Frontmatter: `name: dsh-goal-autopilot`, and a `description` that names the trigger (a stated goal, autopilot, sustained multi-stage work).
- It is a single file with no references directory.
- It is not installed by the bundle. Copy the directory into a root `@deepseek-ai/dsh-skill-filesystem` scans: `$DSH_AGENTS_HOME/skills/` for every project, `<project>/.dsh/skills/` for one repository, or the matching `user-dsh` root for a profile.
- The skill states that the route comes from the user's own configuration and that the host rejects an effort without provider and model.

## Configuration

The bundle has no configuration keys. Its whole configuration is `cordis.patch.yml`.

A profile can override a row by Loader id in its own `cordis.patch.yml`. A targeted row replaces the entire `config`, so restate every field:

```yaml
- id: delegate
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: delegate
    modelSelection: true
    modelDiscovery: true
    allowedAgentPresets: [goal-scout, goal-worker, goal-executor-lead, goal-planner, goal-reviewer]
    maxDepth: 1
```

The preset declaration rows are `preset-goal-scout`, `preset-goal-worker`, `preset-goal-executor-lead`, `preset-goal-planner` and `preset-goal-reviewer`; their `config.id` values are the preset identities.

## DSH host tools the workflow uses

These belong to the host, not the bundle.

| tool | parameters | use in the workflow |
| --- | --- | --- |
| `get_goal` | none | read the current goal with its `id` and `revision`; returns `{ goal: null }` when none is current |
| `create_goal` | `objective`, optional `max_goal_rounds` | create the goal from the user's Outcome; the host accepts it from a direct human turn |
| `update_goal` | `goal_id`, `revision`, `action`, optional `objective`, `max_goal_rounds`, `blocked_reason` | `complete` or `blocked` when the goal round has authority; `resume`, `edit` and `pause` need a direct human turn |
| `list_agents` | none | the agent tree with names and live status |
| `send_message` | `agent`, `message` | message a child by name; an inactive child is resumed by the message |
| `wait_agent` | optional `timeout_ms` | wait for the caller's next-step inbox inside the turn |
| `job_output` | `job_id`, optional `wait`, `timeout_ms` | wait for a background command or CI watcher inside the turn |
| `interrupt_agent` | `agent` | off in the shipped base and `standard` presets and in this bundle's lead row; the workflow does not depend on it |

`wait_agent` is composed by `@deepseek-ai/dsh-tool-subagent-control`; it is present in the `goal-executor-lead` preset (with `interrupt: false`) and in the main agent's preset when that preset mounts the control tools.

## Goal disarm and resume

The goal is durable in the host; whether continuation is armed is process-local. After a session resume, a fork or a host restart, an active goal is disarmed: the agent does not continue on its own.

When the user says continue, in any wording, the agent reads the goal with `get_goal` and rearms it with `update_goal` and `action: 'resume'`. A text reply alone does not rearm it.

A durable paused goal is the user's: the model's `resume` is refused, and the user resumes it from the client. The round cap bounds automatic continuation; reaching it stops the goal in the host.

## Removed in 0.5.0

- `autopilot_delegate`, `autopilot_agents` and `autopilot_escalate`, with the role scoping, `writePaths` conflict guard, generations, escalation channel and in-memory ledger they used.
- The reviewer wait and its in-band verdict schema.
- The plugin refusal codes (`AP_*`).
- The `skillInstall` config key and plugin-side skill publishing.

See [CHANGELOG.md](../CHANGELOG.md) for the migration.
