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

> This is a **developer preview**. Experimental. Latest is **0.1.1**, a
> **packaging** / runtime compatibility fix so hosts keep a single
> `@deepseek-ai/dsh-tools` **host-provided peer**. Not a production release.
> On WSL2 + `dsh` `0.1.5-rc.1`, install through the **plan gate** is
> measured; the full **write lifecycle** is not. Windows is not verified.

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

Requires [dsh](https://github.com/deepseek-ai/deepseek-harness) and **Node 22+**.

```sh
dsh plugin --profile <name> add dsh-goal-autopilot
```

Pin the current release:

```sh
dsh plugin --profile <name> add dsh-goal-autopilot@0.1.1
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
| npm | `dsh-goal-autopilot@0.1.1` |
| 0.1.1 | Packaging / runtime compatibility fix |
| Hosts | `dsh` `0.1.2-rc.1` or `0.1.5-rc.1` |
| WSL2 + 0.1.5-rc.1 | Install, mount, skill load, plan-gate path measured |
| Full NL write → execution audit → closeout | Not verified |
| Windows | Not verified — not claimed as supported |
| Security | Quality gates + fail-closed egress; not complete security |

Host matrix, the 0.1.0 duplicate-runtime fix, and the sandbox residual:
[docs/compatibility.md](./docs/compatibility.md).

## Documentation

| Doc | For |
| --- | --- |
| [DESIGN.md](./DESIGN.md) | Architecture, state machine, invariants, verification |
| [docs/compatibility.md](./docs/compatibility.md) | DSH versions, WSL/Windows, 0.1.1 runtime |
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

Client-half typecheck needs a built dsh checkout at `DSH_SRC` (default
`~/dsh`). CI runs the host half only. See
[docs/compatibility.md](./docs/compatibility.md).

## License

[MIT](./LICENSE)
