<p align="right"><b>English</b> · <a href="./README.zh-CN.md">简体中文</a></p>

# dsh-autopilot

A plan → execute → audit plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). It ports the goal-autopilot harness (GAH) workflow into dsh plugin hooks: the agent plans first, an independent subagent audits the plan, a delegated executor does the work, a second audit checks the result, and the run only closes with evidence for every acceptance criterion.

[![npm](https://img.shields.io/npm/v/dsh-goal-autopilot?style=flat-square)](https://www.npmjs.com/package/dsh-goal-autopilot)
[![CI](https://img.shields.io/github/actions/workflow/status/My-Denia/dsh-autopilot-public/ci.yml?branch=main&style=flat-square)](https://github.com/My-Denia/dsh-autopilot-public/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

> [!NOTE]
> The npm package is **`dsh-goal-autopilot`**. The unscoped `dsh-autopilot` on npm is an unrelated package.

## Install

Requires dsh `0.2.0` (or `0.1.2-rc.1` / `0.1.5-rc.1`) and Node 22+.

**Desktop:** Settings → Plugins → Add plugin, enter `dsh-goal-autopilot@0.2.0`, then Install and Enable.

**CLI / headless / web:**

```sh
dsh plugin --profile <name> add dsh-goal-autopilot@0.2.0
```

## Usage

In a chat on that profile:

```text
Use dsh-autopilot to implement <goal> and verify the result.
```

To drive the `autopilot_*` tools by hand, see the [operator reference](./docs/reference.md).

## How it works

<p align="center"><img src="./assets/workflow.svg" width="100%" alt="dsh-autopilot run loop"></p>

A run moves through `planning` → `plan-reviewing` → `executing` → `execution-reviewing` → `completed`. State lives under `$DSH_HOME/storages/dsh-autopilot/runs/<sessionId>/`.

- **Plan gate.** File writes and edits are blocked, and read-only sandbox mode is requested, until the plan audit passes. The plan states goal, scope, non-goals, risk, milestones and acceptance criteria, and declares observable usage states with `autopilot_usage`.
- **Independent audits.** Auditors are one-shot subagents with read-only tools and `maxDepth: 1`, returning `pass`, `needs-replan` or `blocked`.
- **Same-executor resume.** One continuable executor does the work; on `needs-fix` the same executor continues.
- **Egress guard.** `git push`, `gh release` and `npm publish` are intercepted and need a valid evidence manifest (`<run>/outbound/manifest.json`) plus owner approval.
- **Evidence-bound closeout.** `completed` is refused until both gates pass and every acceptance criterion has an artifact on disk.
- **Turn reminder.** Up to three nudges if the agent stops mid-run.

Design details: [DESIGN.md](./DESIGN.md).

## Status

Developer preview.

| | |
| --- | --- |
| Tested | Install, mount, skill registration, plan audit, delegated executor and needs-fix resume on WSL2 + dsh 0.2.0-rc.2 with a local mock model |
| Not yet tested | Full run with a real model, Desktop on macOS/Windows, native Windows, browser card rendering |
| Host range | dsh 0.2.0 line, 0.1.5-rc.1, 0.1.2-rc.1 (0.1.7 and 0.2.1 are outside the peer range) |
| Distribution | npm; GitHub Releases carry notes only |

See [docs/compatibility.md](./docs/compatibility.md) and [docs/security.md](./docs/security.md).

## Documentation

- [DESIGN.md](./DESIGN.md): architecture, GAH mapping, state machine
- [docs/compatibility.md](./docs/compatibility.md): dsh versions, Desktop notes, sandbox
- [docs/security.md](./docs/security.md): approvals, egress interception, sandbox
- [docs/reference.md](./docs/reference.md): `autopilot_*` tools, run state, usage classes
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
