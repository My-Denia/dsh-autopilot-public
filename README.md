<p align="right"><b>English</b> · <a href="./README.zh-CN.md">简体中文</a></p>

# dsh-goal-autopilot

[![npm](https://img.shields.io/npm/v/dsh-goal-autopilot?style=flat-square)](https://www.npmjs.com/package/dsh-goal-autopilot)
[![CI](https://img.shields.io/github/actions/workflow/status/My-Denia/dsh-autopilot-public/ci.yml?branch=main&style=flat-square)](https://github.com/My-Denia/dsh-autopilot-public/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

A goal workflow adapter for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). When a goal is stated, the main agent keeps the decisions and the conversation, hands bounded work to role children of the host's own subagents, gets one independent review, and completes the goal only when its Done checks hold. The issue and the pull request are the record; the plugin keeps the delegation mechanics.

> [!NOTE]
> The npm package is **`dsh-goal-autopilot`**. The unscoped `dsh-autopilot` on npm is an unrelated package.

## Install

0.4.0 may not be the registry's `latest` tag yet. If `add` resolves to an older version, name this one:

```sh
dsh plugin --profile <name> add dsh-goal-autopilot
dsh plugin --profile <name> add dsh-goal-autopilot@0.4.0   # pin the pre-release
```

The package targets dsh `0.2.2-rc.5` and declares `engines.dsh` as `>=0.2.2-rc.5 <0.3.0-0`. Node 22 or newer is required. Older hosts cannot load 0.4.0; the 0.3.0 pre-releases were built for dsh `0.2.1-rc.5`, and `0.2.0` remains the last release for dsh `0.1.x` and `0.2.0`.

## When it starts

The adapter skill applies when the user states a goal, asks for autopilot, or hands over sustained multi-stage work: several stages, parallel pieces, a pull request to land. The agent reads the current goal with `get_goal` and, when none is current, calls `create_goal` with the Outcome as the objective.

Questions, small reversible edits and ordinary read-only reviews stay in the main thread. They make no goal call and no `autopilot_*` call.

## How a goal runs

- **Start.** The agent reads the project rules and the issue, writes Outcome, Done and Not in scope on the issue or PR, and works in a worktree.
- **Roles.** The main agent decides, integrates and talks to the user. It starts role children with `autopilot_delegate`:

  | role | what it does | tools |
  | --- | --- | --- |
  | `scout` | read-only search, inventory and log reading; returns compressed findings | `read`, `glob`, `grep`, `read_image`, `web_fetch`, `web_search` |
  | `planner` | read-only plan or diagnosis | `read`, `glob`, `grep`, `read_image` |
  | `worker` | one bounded piece of work; must declare `writePaths` | inherits the session tool set |
  | `executor-lead` | one chunk end to end; may start `scout` and `worker` children | inherits the session tool set, plus the delegation tools |
  | `reviewer` | one-shot read-only review in a fresh context; returns a verdict | `read`, `glob`, `grep`, `read_image`; cannot delegate |

- **Parallel delegation.** Independent children are started together in one turn. A new writer whose `writePaths` overlap a writer still running under the same root is refused before it starts.
- **One independent review.** `reviewer` is one-shot, read-only and runs in a fresh context. It gets the diff and the claim in `task`, not the author's reasoning, and returns `pass` or `fail` with `blocker` and `note` findings in-band, as the result of the same call. The main agent cannot write a verdict. The route is whatever the call names or the host default supplies; a same-model review is normal, and the result records the route that ran when the host exposes it.
- **Waiting.** `autopilot_agents` with `action: 'wait'` blocks until the listed children settle or the timeout fires (default 300 s, at most 600). Background jobs and CI watchers use the host's `job_output` with `wait`. Waiting happens inside the turn; the wait tools are not gates.
- **Done.** The agent calls `update_goal` with `action: 'complete'` only when every Done check holds. Finishing a stage, opening a PR or a green CI run does not complete the goal. The host's goal driver continues an armed goal between turns.
- **After a restart.** Running children are gone and an active goal is disarmed. Nothing resumes automatically: when the user says continue, the agent reads the goal with `get_goal` and rearms it with `update_goal` `resume`.

## Tools

| tool | callable by | what it does |
| --- | --- | --- |
| `autopilot_delegate` | root agent, `executor-lead` | starts one role child and returns at once with its child id, the route it was given, the route source (`call` or `inherit`) and the generation |
| `autopilot_agents` | root agent, `executor-lead` | `action: 'wait'` only: blocks until the listed children settle or the timeout fires, and returns `timedOut` plus the delegation records |
| `autopilot_escalate` | any delegated child except `reviewer` | records a request for a stronger route, more effort or a different split; the parent decides and re-dispatches with `replaces`. It never widens the role's permissions |

## Configuration

One key:

| key | values | meaning |
| --- | --- | --- |
| `skillInstall` | `auto` (default) | publishes the adapter skill through the host's skills service, or copies `skill/dsh-goal-autopilot/SKILL.md` into `$DSH_AGENTS_HOME/skills/dsh-goal-autopilot` when that service is unavailable |
|  | `off` | neither channel; the skill is not installed |

There are no model pins, ladders, catalogs or work classes. A route comes from the dispatch call (`provider` and `model` together, optional `effort`) or from the host default.

## What it deliberately does not do

- **No model routing policy.** No ladder, model catalog, work classes, coverage report, onboarding notice or cross-family vendor rule. The plugin cannot grant, filter or rank routes; it records the route asked for, where it came from, and, when the host exposes the child's log, the route that ran.
- **No persisted ledger.** Delegation records live in memory for one root session. A host restart loses them, and the children they describe are gone; there is no resume and no `lost` state.
- **No session card, client bundle or web routes.** There is no list, status or link tool; the host's `list_agents` and `send_message` cover the tree, and the issue and PR carry the record.
- **No external-system role.** The 0.2.x `clerk` role, the connector overlay and MCP write paths are not part of this package. Delegated work is local repository work; a `scout` may use the host's `web_search` and `web_fetch` for research, but there is no connector or external write path.
- **No legacy 0.2.x history.** It does not read, fold, display or continue runs written by plugin 0.2.x, and it keeps no compatibility shims for old tools or config keys.
- **No sandbox of its own.** Host approval and sandbox settings apply to every call; `writePaths` is a conflict guard between concurrent writers, not a permission system. See [docs/security.md](./docs/security.md).

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md): how the plugin divides work with the host
- [docs/reference.md](./docs/reference.md): exact tool parameters, refusals, configuration and host tools
- [docs/security.md](./docs/security.md): what the plugin gates and does not gate
- [skill/dsh-goal-autopilot/SKILL.md](./skill/dsh-goal-autopilot/SKILL.md): the in-session adapter
- [CHANGELOG.md](./CHANGELOG.md): release history and the 0.4.0 break
- [docs/release.md](./docs/release.md): how a release is built, published and tagged

## Development

Node 22 and pnpm 11.17.0.

```sh
git clone https://github.com/My-Denia/dsh-autopilot-public.git
cd dsh-autopilot-public
pnpm install
pnpm run build
pnpm run check
pnpm test
dsh plugin --profile dev add .
```

## License

[MIT](./LICENSE) © 2026 My-Denia
