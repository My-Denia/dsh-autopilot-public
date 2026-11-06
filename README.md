<p align="right"><b>English</b> · <a href="./README.zh-CN.md">简体中文</a></p>

# dsh-autopilot

The [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) adapter of the goal-workflow. When the owner states a goal, the main agent keeps the decisions and the conversation, hands other work to role children started with an explicit model and effort (or, with routing off or no catalog, the host route, recorded as inherited), gets an independent review, and keeps the goal going until its Done checks hold. The issue and the pull request are the record; the plugin keeps only a small ledger of who was started, on what route, and how it ended.

[![npm](https://img.shields.io/npm/v/dsh-goal-autopilot?style=flat-square)](https://www.npmjs.com/package/dsh-goal-autopilot)
[![CI](https://img.shields.io/github/actions/workflow/status/My-Denia/dsh-autopilot-public/ci.yml?branch=main&style=flat-square)](https://github.com/My-Denia/dsh-autopilot-public/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

> [!NOTE]
> The npm package is **`dsh-goal-autopilot`**. The unscoped `dsh-autopilot` on npm is an unrelated package.

## Install

This source is version `0.3.0` (`0.3.0-rc.1` and `0.3.0-rc.3` to `0.3.0-rc.7` were published to npm; `next` points to `0.3.0-rc.7`; stable is unreleased). It targets dsh `0.2.1-rc.5` only and has been tested on no other host. Node 22+ is required. The Windows desktop app and the WSL CLI are each treated as a native environment, not as one standing in for the other.

Hosts older than `0.2.1-rc.5` (`0.1.x`, `0.2.0`) should stay on `dsh-goal-autopilot@0.2.0`, the last version for them. npm `latest` is still `0.2.0` today; stable `0.3.0` is not published; install a pre-release with `next` or a tarball built from this source.

```sh
# a host on 0.1.x or 0.2.0
dsh plugin --profile <name> add dsh-goal-autopilot@0.2.0
```

If a WSL CLI profile has to go back to the older host, keep a backup of the profile first, then `npm i -g @deepseek-ai/dsh@0.1.5-rc.1`.

## What starts it

The skill applies only when the owner states a goal, asks for autopilot, or hands over sustained multi-stage work (several stages, parallel pieces, a pull request to land). Then the agent calls `get_goal` and, if none is current, `create_goal` with the Outcome as the objective.

Questions, small reversible edits and ordinary read-only reviews stay in the main thread. They make no goal call and no `autopilot_*` call.

## How a goal runs

- **Start.** The agent reads the project rules and the issue, writes Outcome, Done and Not in scope on the issue or PR, and works in a worktree.
- **Roles.** The main agent decides, integrates and talks to the owner. `autopilot_delegate` starts `scout` (read-only search), `clerk` (external reads and writes through the MCP connector, MCP resource and web tools registered in the session, while local repository access stays read-only), `worker` (a bounded piece with its own `writePaths`), `executor-lead` (one chunk end to end, may start scout, clerk and worker children), `planner` (read-only plan or diagnosis) and `reviewer`. Children are followed with `autopilot_agents` (`wait` only) and the host's `list_agents`, `send_message` and `interrupt_agent`; a stalled child calls `autopilot_escalate`.
- **Parallel delegation.** Independent children are started together in one turn. Workers whose `writePaths` overlap are refused before anything starts.
- **Independent review.** The `reviewer` is one-shot, read-only, in a fresh context, and sees the diff and the claim. It uses a different model family from the change when one is reachable; otherwise the same vendor is used, which is normal.
- **Model and effort.** Every dispatch names a model and an effort. An explicit value in the call or a pin in the profile beats the plugin's choice. The ledger and the card show the selected route and the observed one.
- **Goal persistence.** The goal lives in dsh's own `get_goal` / `create_goal` / `update_goal` and is continued by the host's goal round driver. Finishing a stage, opening a PR or a green CI does not complete the goal; the agent completes it only when all Done checks hold. Waiting for children or background jobs happens inside the turn (`autopilot_agents` `wait`, `job_output` with `wait`).
- **After a restart.** Running children are gone and the goal stays disarmed until the owner says "continue". A `schedule_create` reminder is delivered after the restart but does not re-arm the goal.
- **Legacy runs.** Runs written by 0.2.x stay readable and are shown read-only on the card. They are not continued.

The tool parameters, the ledger and the configuration are in the [operator reference](./docs/reference.md).

## Status

Developer preview. `0.3.0-rc.7` is on npm under the `next` tag; `latest` is still `0.2.0`. The [verified list](./docs/compatibility.md#verified-on-a-real-host) is what was observed with dsh `0.2.1-rc.5` on Windows: a headless profile, the owner's daily desktop app (prompts pasted by an agent through the GUI), and an isolated Web Session host (prompts sent by an agent through the API), with one provider family. The [not-verified list](./docs/compatibility.md#not-verified-on-a-real-host) is what was not (among them a cross-family reviewer, which needs a second provider family). Passing tests, mock runs and status reads are not counted as observation. The earlier measurements in [docs/compatibility.md](./docs/compatibility.md) are for plugin `0.2.x`.

## Documentation

- [docs/reference.md](./docs/reference.md): tools, ledger, configuration
- [examples/clerk-connectors.patch.yml](./examples/clerk-connectors.patch.yml): reusable no-secret MCP connector overlay for `clerk`
- [docs/compatibility.md](./docs/compatibility.md): hosts, history, what is and is not verified
- [docs/security.md](./docs/security.md): what the plugin does and does not gate
- [skill/dsh-autopilot/SKILL.md](./skill/dsh-autopilot/SKILL.md): the in-session adapter
- [skill/dsh-autopilot/references/model-routing.md](./skill/dsh-autopilot/references/model-routing.md): work classes, ladder, escalation
- [skill/dsh-autopilot/references/refusals.md](./skill/dsh-autopilot/references/refusals.md): remaining `AP_*` refusals
- [DESIGN.md](./DESIGN.md): architecture and design history
- [CHANGELOG.md](./CHANGELOG.md)

## Development

```sh
git clone https://github.com/My-Denia/dsh-autopilot-public.git
cd dsh-autopilot-public
pnpm install
npm run build
npm run check
npm test
dsh plugin --profile dev add .
```

## License

[MIT](./LICENSE) © 2026 My-Denia
