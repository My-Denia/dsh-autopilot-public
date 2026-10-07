# dsh-autopilot

Governed plan-execute-audit for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
mechanical gates, owner-only egress, and evidence-bound closeout as an
out-of-tree plugin.

[![npm](https://img.shields.io/npm/v/dsh-goal-autopilot)](https://www.npmjs.com/package/dsh-goal-autopilot)
[![CI](https://github.com/My-Denia/dsh-autopilot-public/actions/workflows/ci.yml/badge.svg)](https://github.com/My-Denia/dsh-autopilot-public/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/My-Denia/dsh-autopilot-public)](./LICENSE)
[![node](https://img.shields.io/node/v/dsh-goal-autopilot)](https://www.npmjs.com/package/dsh-goal-autopilot)

The project name is **dsh-autopilot**. The npm package is
**dsh-goal-autopilot**. Unscoped `dsh-autopilot` on npm
belongs to a separate, independent project; install this plugin as
`dsh-goal-autopilot`.

> This is a **developer preview**. Experimental. Latest is **0.2.0**, which
> adapts the plugin to **`dsh` 0.2.0** (CLI and the Desktop app's bundled
> `dsh` command). On WSL2 + `dsh` `0.2.0-rc.2`, install, mount, and a
> delegated run through needs-fix resume are measured with a local mock
> model. Desktop is not run here, and Windows is not verified. Not a
> production release.

dsh-autopilot turns a natural-language goal into a gated run: plan, audit,
execute, audit, then close only when the evidence is bound. Design lineage is
the Claude Code `goal-autopilot-harness` skill, rebuilt on dsh plugin seams
so the gates are executable instead of prompt-only. Deep design:
[DESIGN.md](./DESIGN.md).

```mermaid
flowchart LR
  Goal --> Plan --> Audit1[Audit] --> Execute --> Audit2[Audit] --> Closeout
```

## Capabilities

- **Plan gate** — standard runs stay read-only until an independent plan
  audit passes.
- **Independent audits** — one-shot auditors, **structured** verdicts, no
  verdict means no gate flip.
- **Delegated executor** — a continuable child implements; the same child
  resumes on needs-fix.
- **Owner-only egress** — `git` / `gh` / publish writes need a manifest and
  owner authority.
- **Evidence-bound closeout** — `completed` needs both gates, required
  roles, and one **bearer** per acceptance criterion.
- **Usage + stop reminder** — standard runs must declare how a change was
  operated; a bounded **3x** nudge fires if a turn ends mid-execution.

## Quick Start

Requires [dsh](https://github.com/deepseek-ai/deepseek-harness) `0.2.0` (or
`0.1.2-rc.1` / `0.1.5-rc.1`) and **Node 22+**. On dsh Desktop, install
`dsh-goal-autopilot` from the plugin manager or with the bundled `dsh`
command.

```sh
dsh plugin --profile <name> add dsh-goal-autopilot
```

Pin the current release:

```sh
dsh plugin --profile <name> add dsh-goal-autopilot@0.2.0
```

Then ask, in natural language:

```text
Use dsh-autopilot to implement <goal> and verify the result.
```

You do not need the internal `autopilot_*` tool names to start. Operators
who want the full sequence can read [docs/reference.md](./docs/reference.md).

## How it works

A standard run is event-sourced (`planning` → review → `executing` →
review → close). The engine is the only writer. Audits are independent
subagents. Closeout refuses `completed` until the gates and evidence line
up.

That is the shape. The invariants, honest limits, and host traces live in
[DESIGN.md](./DESIGN.md).

## Status

| Topic | Current fact |
| --- | --- |
| Maturity | Experimental developer preview (not a production release) |
| npm | `dsh-goal-autopilot@0.2.0` |
| 0.2.0 | Adapts to `dsh` 0.2.0: peer range, executor resume, executor recognition, reminder source kind, PTC card events |
| Hosts | `dsh` `0.2.0` line, `0.1.5-rc.1`, `0.1.2-rc.1` (0.1.7 and 0.2.1 are outside the range) |
| WSL2 + 0.2.0-rc.2 | Install, mount, skill, plan audit → delegated executor → needs-fix resume measured with a mock model |
| Full NL write → execution audit → closeout | Not verified with a real model |
| Desktop (macOS / Windows) | Not run — not verified |
| Windows | Not verified — not claimed as supported |
| Security | Quality gates + fail-closed egress; not complete security |

Host matrix, Desktop notes, the 0.2.0 fixes, and the sandbox residual:
[docs/compatibility.md](./docs/compatibility.md).

## Documentation

| Doc | For |
| --- | --- |
| [DESIGN.md](./DESIGN.md) | Architecture, state machine, invariants, verification |
| [docs/compatibility.md](./docs/compatibility.md) | DSH versions, Desktop, WSL/Windows, 0.2.0 fixes |
| [docs/security.md](./docs/security.md) | Approval, egress, sandbox, non-goals |
| [docs/reference.md](./docs/reference.md) | Tool protocol, run state, usage classes |
| [CHANGELOG.md](./CHANGELOG.md) | Release history |

## Develop

From a local checkout:

```sh
pnpm install
pnpm run build
dsh plugin --profile <name> add .
```

```sh
pnpm run check   # typecheck
pnpm run test    # vitest
pnpm run build   # emit lib/
```

Client-half typecheck needs a dsh tree at `DSH_SRC` (default `~/dsh`). CI runs the host half only. See
[docs/compatibility.md](./docs/compatibility.md).

## License

[MIT](./LICENSE)
