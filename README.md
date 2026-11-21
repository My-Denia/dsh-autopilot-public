<p align="right"><b>English</b> · <a href="./README.zh-CN.md">简体中文</a></p>

# dsh-goal-autopilot

[![npm](https://img.shields.io/npm/v/dsh-goal-autopilot?style=flat-square)](https://www.npmjs.com/package/dsh-goal-autopilot)
[![CI](https://img.shields.io/github/actions/workflow/status/My-Denia/dsh-autopilot-public/ci.yml?branch=main&style=flat-square)](https://github.com/My-Denia/dsh-autopilot-public/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

A goal workflow for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh), shipped as configuration only. Five agent presets carry the roles, one profile-level `delegate` tool starts a child on one of them, and one skill tells the main agent when and how to run a goal.

There is no plugin code. No tools of its own, no service, no storage, no client bundle: the host starts the children, owns the goal, validates routes and applies the sandbox.

> [!NOTE]
> The npm package is **`dsh-goal-autopilot`**. The unscoped `dsh-autopilot` on npm is an unrelated package.

## What is in the box

| piece | what it is |
| --- | --- |
| `cordis.patch.yml` | the bundle patch: one `delegate` row and five `@deepseek-ai/dsh-agent-preset` declarations |
| `skill/dsh-goal-autopilot/SKILL.md` | the adapter skill: when a goal applies, the order of work, the roles, the review, the done checks |
| presets | `goal-scout`, `goal-worker`, `goal-executor-lead`, `goal-planner`, `goal-reviewer` |

The manifest sets `dsh.bundle.patch`, so `dsh plugin add` composes the patch into the profile.

## Install

0.5.0 targets dsh `>=0.2.2-rc.5 <0.3.0-0`. Node 22 or newer is required to run the test suite; the profile process is the host's.

```sh
dsh plugin --profile <name> add dsh-goal-autopilot@0.5.0
```

Pin the version when the registry's `latest` tag is an older release.

After the profile loads, a session gains a `delegate` tool and the preset roster gains the five role presets. Keep your usual preset for the session you talk to; the role presets are child presets.

The depth cap is deliberate. The profile-level `delegate` row sets `maxDepth: 1`, an absolute cap enforced by the host against the calling agent's depth. A child started at depth 1 inherits the tool and is refused when it tries to delegate, so scout, worker, planner and reviewer children cannot spawn a tree of their own. Only `goal-executor-lead` mounts its own `delegate` row, with `maxDepth: 2` and the three leaf presets.

The skill is a file in the package. A bundle patch declares Loader rows and cannot copy files, so installing the bundle does not install the skill. Copy the directory into a root dsh scans with `@deepseek-ai/dsh-skill-filesystem`:

```sh
mkdir -p "$DSH_AGENTS_HOME/skills"
cp -r skill/dsh-goal-autopilot "$DSH_AGENTS_HOME/skills/"
```

Use `<project>/.dsh/skills/` instead to scope it to one repository. Without the skill the presets and `delegate` still work; the skill is what tells the main agent the workflow.

## How a goal runs

- **Start.** The main agent reads the project rules and the issue, writes Outcome, Done and Not in scope on the issue or pull request, and works in a worktree.
- **Delegate.** `delegate` takes a short `description`, the `prompt` (the brief), and `agent_preset`. It starts a managed child and returns at once with the child's name; the child's final answer arrives later in the host's completion notice.
- **Roles.** The main agent decides, integrates and talks to the user. Each child gets its preset's tools only:

  | preset | role | tools |
  | --- | --- | --- |
  | `goal-scout` | read-only search, inventory and log reading | `read`, `read_image`, `glob`, `grep` |
  | `goal-worker` | one bounded implementation piece | shell (`bash` or `pwsh`), `jobs`, `read`, `read_image`, `write`, `edit`, `glob`, `grep` |
  | `goal-executor-lead` | one chunk end to end; may start the three leaf roles | the worker's tools, plus `list_agents`, `send_message`, `wait_agent` and its own `delegate` |
  | `goal-planner` | read-only diagnosis and a decision-complete plan | `read`, `read_image`, `glob`, `grep` |
  | `goal-reviewer` | one-shot read-only review in a fresh context | `read`, `read_image`, `glob`, `grep` |

- **Parallel work.** Independent children start in one message; the main agent keeps working while they run. The host does not compare file scopes, so disjoint write scopes belong in the briefs the main agent writes.
- **One independent review.** `goal-reviewer` runs read-only in a fresh context and returns `pass` or `fail` with blocker and note findings in the completion notice. The main agent cannot write that verdict; a `fail` is fixed and re-reviewed.
- **Waiting.** While a goal is armed, wait inside the turn with `wait_agent` or `job_output` instead of ending the turn to wait for a child.
- **Done.** The main agent calls `update_goal` with `complete` only when every Done check passes on the final tree and the review is `pass`. After a session resume, an active goal is disarmed until `update_goal` `resume` rearms it.

## Routes

The route comes from the user's own configuration. Omit `provider`, `model` and `reasoning_effort` to inherit the host default, or name `provider` and `model` together and `reasoning_effort` only with both; the host rejects an effort on its own. The presets pin no model, no provider and no effort, and the package ships no routing table.

`list_subagent_models` reports the routes and efforts the host and the user allow.

## Configuration

The bundle has no configuration keys and no code. To change a row, target its Loader id in the profile's own `cordis.patch.yml` (`delegate`, `preset-goal-scout`, `preset-goal-worker`, `preset-goal-executor-lead`, `preset-goal-planner`, `preset-goal-reviewer`). A targeted row replaces its whole `config`, so restate every field the row needs.

## Supported host

| what | range |
| --- | --- |
| dsh | `>=0.2.2-rc.5 <0.3.0-0` |
| Node | `>=22` (tests) |

The package convention that carries an agent preset, a delegation tool's `agentPreset`/`allowedAgentPresets` and an absolute `maxDepth` first shipped in the 0.2.2 pre-releases this range starts from.

The profile must mount the agent-preset registry (`@deepseek-ai/dsh-agent-preset-registry`) and the in-process `spawn` subagent provider. The Web and Desktop profiles mount both; a bare base profile does not, and without the preset service the `delegate` row fails to load with `agent preset selection requires the agent-presets service`.

## Development

Node 22 and pnpm 11.17.0.

```sh
git clone https://github.com/My-Denia/dsh-autopilot-public.git
cd dsh-autopilot-public
pnpm install
node --test
dsh plugin --profile dev add .
```

The test suite parses `cordis.patch.yml` with the `yaml` package, checks the preset declarations, the delegation rows, the skill frontmatter and the package manifest. It needs no host and no network.

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md): why the product is configuration, what the host owns, and the depth-cap reasoning
- [docs/reference.md](./docs/reference.md): the preset ids and tool surfaces, the `delegate` parameters, the skill, and refused shapes
- [docs/security.md](./docs/security.md): what the bundle configures and what stays with the host
- [skill/dsh-goal-autopilot/SKILL.md](./skill/dsh-goal-autopilot/SKILL.md): the in-session adapter
- [CHANGELOG.md](./CHANGELOG.md): release history and the 0.5.0 break
- [docs/release.md](./docs/release.md): how a release is gated, published and tagged

## License

[MIT](./LICENSE) © 2026 My-Denia
