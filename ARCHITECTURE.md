# Architecture

`dsh-goal-autopilot` is a configuration-only dsh bundle. It ships one Cordis patch with six rows, one skill and documentation. There is no JavaScript plugin: no tool registration, no service, no storage, no client bundle.

## Why configuration only

dsh 0.2.2 already provides the mechanics the 0.4.0 plugin implemented itself:

- `@deepseek-ai/dsh-tool-subagent` starts a managed child, returns its name at once, and delivers the child's final answer in a completion notice. Its config exposes `agentPreset` and `allowedAgentPresets` (the model picks a child preset through `agent_preset`), `modelSelection` (explicit `provider`/`model`/`reasoning_effort`), `modelDiscovery` (`list_subagent_models`) and an absolute `maxDepth`.
- `@deepseek-ai/dsh-agent-preset` declares a child's composition as ordinary Cordis plugin rows: persona, prompt context and tools.
- `@deepseek-ai/dsh-tool-subagent-control` provides `list_agents`, `send_message` and `wait_agent` over the same tree.
- The goal service (`get_goal`, `create_goal`, `update_goal`) owns objective, rounds and continuation.

The plugin's three tools, its per-child role scoping with `ctx.tools.restrict`, its reviewer wait and its in-memory delegation ledger rebuilt those mechanisms beside the host. They drifted with every host release and added a maintenance surface with no behaviour the host lacked. Removing them removes the whole failure mode: this package cannot break because a host API changed, and there is no build, no typecheck and no runtime code to keep alive.

## Division of labour

| concern | owner |
| --- | --- |
| child lifecycle, completion notices, depth enforcement | dsh subagent runtime |
| child composition (persona and tools) | the five `@deepseek-ai/dsh-agent-preset` rows in this patch |
| goal state, revision, rounds, continuation | dsh goal service and its tools |
| routes and effort validation | host configuration and the session's route policy |
| approval, sandbox and file policy | host and profile settings |
| tool schemas and model-facing wording | `@deepseek-ai/dsh-tool-subagent` |
| skill discovery | `@deepseek-ai/dsh-skill-filesystem` roots |
| workflow order, role briefs, review and done discipline | the skill and the main agent |

The bundle does not read or store goal state, and it keeps no record of a delegation. The transcript, `list_agents` and the issue or pull request are the record; after a host restart the children are gone and work that must continue is started again.

## What the patch registers

| Loader id | package | what it configures |
| --- | --- | --- |
| `delegate` | `@deepseek-ai/dsh-tool-subagent` | profile-level `delegate` tool: spawn provider, `modelSelection`, `modelDiscovery`, the five preset ids as `allowedAgentPresets`, `maxDepth: 1` |
| `preset-goal-scout` | `@deepseek-ai/dsh-agent-preset` | read-only search role |
| `preset-goal-worker` | `@deepseek-ai/dsh-agent-preset` | bounded implementation role |
| `preset-goal-executor-lead` | `@deepseek-ai/dsh-agent-preset` | chunk owner with its own `delegate` row at `maxDepth: 2` |
| `preset-goal-planner` | `@deepseek-ai/dsh-agent-preset` | read-only diagnosis role |
| `preset-goal-reviewer` | `@deepseek-ai/dsh-agent-preset` | one-shot read-only review role |

Each preset composes `@deepseek-ai/dsh-persona` (its role brief), `@deepseek-ai/dsh-time-context`, and the tool rows copied from the shipped `standard` preset: `tool-fs` with `write: false` and `edit: false` for the read-only roles, shell, jobs and file tools for the write roles, and the platform-guarded `tool-bash`/`tool-pwsh` pair from upstream.

The rows assume the host composition mounts the agent-preset registry, the in-process `spawn` provider and the tool services the presets use. The Web and Desktop profiles do; a bare base profile mounts the spawn provider but not the preset registry.

## The depth cap

`maxDepth` is not a per-call budget. The tool sends a numeric cap to the provider, the provider records it on the child, and every later delegation checks the calling agent's current depth against the cap of the visible tool. A numeric cap requires a provider with the `depthLimit` capability; the in-process `spawn` provider has it.

The profile-level `delegate` row is capped at 1. A child started from the main agent sits at depth 1, inherits that row, and is refused when it calls `delegate` ("current 1, maximum 1"). The tool stays visible, so the refusal is a runtime error rather than a silent absence. The leaf presets also declare no delegation row of their own, so a leaf child has nothing to call but the inherited capped row.

`goal-executor-lead` is the single exception. Its preset mounts its own `delegate` row: the same tool name, a `maxDepth: 2` cap, and an allowlist of the three leaf presets. The scoped row shadows the profile-level row for agents on that preset, so a lead at depth 1 may start depth-2 leaves. Those leaves sit under the inherited depth-1 cap, and they cannot start children either.

The depth cap is the only delegation limit this package configures. It is not a permission system: a child still runs under the host's approval and sandbox policy, exactly as the main agent does.

## Preset tool surfaces

| preset | tools |
| --- | --- |
| `goal-scout` | `read`, `read_image`, `glob`, `grep` |
| `goal-worker` | `bash` or `pwsh` (platform), `jobs`, `read`, `read_image`, `write`, `edit`, `glob`, `grep` |
| `goal-executor-lead` | the worker's tools, `list_agents`, `send_message`, `wait_agent`, and `delegate` |
| `goal-planner` | `read`, `read_image`, `glob`, `grep` |
| `goal-reviewer` | `read`, `read_image`, `glob`, `grep` |

A preset is the deployment-wide way to scope a child: the child is composed from these rows and cannot reach a tool that is not in them. The bundle does not filter tools per child at runtime and does not re-check a profile's tool registry.

## What was removed in 0.5.0

- The three tools `autopilot_delegate`, `autopilot_agents` and `autopilot_escalate`, and the role scoping, `writePaths` conflict guard, `replaces` generations and escalation channel behind them.
- The in-memory delegation ledger and the per-session records, with the states `starting`, `running`, `idle`, `completed`, `failed` and `cancelled`.
- The reviewer wait and its in-band structured verdict. A review is now an ordinary child whose answer arrives in the completion notice.
- The refusal-code registry.
- The plugin's skill publishing and the `skillInstall` config key.
- The TypeScript sources, the `lib/` build, the vitest suite and every build, typecheck and code-generation script.

## Why there is no routing engine

Route choice depends on facts that live with the deployment: configured providers, usable accounts, model capabilities and what the user has allowed. A packaged ladder or catalog would go stale between releases and second-guess the host's own configuration. The presets pin nothing; the tool passes an explicit route only when the caller names one, and the host validates it.

An explicit `reasoning_effort` requires `provider` and `model` in the same call; an effort-only call is rejected before any child is created.

## Skill placement

The skill ships as a file, not as a plugin contribution: a bundle patch declares Loader rows and cannot copy files. Installing the bundle therefore does not install the skill. The documentation gives the one-time copy into a skill root that `@deepseek-ai/dsh-skill-filesystem` scans.

The patch deliberately does not add a `skill-filesystem` row that points at the packaged skill directory. That would put a path expression in the patch, break the package load if it failed to resolve in a given install layout, and override a row the user's profile may already configure.

## Boundary to a private binding

A deployment that wants more than this package configures: durable run state, a session card, model tiers, external-system roles, or a history of earlier plugin generations. Those are separate products built on the same host services: their own presets, tools, storage and configuration. This package does not import them, test against them or know they exist, and facts that change with one deployment's environment stay out of this repository.
