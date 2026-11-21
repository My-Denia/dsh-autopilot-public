# Security and boundaries

`dsh-goal-autopilot` 0.5.0 is configuration only. It configures five child presets and one delegation tool row in the running profile; it contains no code, no service and no storage. What it enforces is narrow, and saying so is the point of this page.

## What the bundle configures

- **Child tool surfaces.** A child composed from a goal preset gets exactly that preset's tool rows. `goal-scout`, `goal-planner` and `goal-reviewer` mount `tool-fs` with `write` and `edit` off, and no shell; `goal-worker` and `goal-executor-lead` mount the shell, jobs and file tools. A preset's surface is fixed at declaration time, and a child cannot reach a tool outside it.
- **Who may delegate.** The profile-level `delegate` row has an `allowedAgentPresets` allowlist of the five goal presets, and an absolute `maxDepth: 1`. A child at depth 1 inherits the row and is refused when it tries to delegate. The `goal-executor-lead` preset shadows the row with `maxDepth: 2` and the three leaf presets only.
- **Routes.** The row passes an explicit `provider`/`model` pair only when the caller names one, with `reasoning_effort` only alongside both. The host validates the route against the session policy; the bundle has no route, model or effort table.

## What the bundle does not gate

- **Sandbox and approval.** The host's approval and sandbox settings apply to every call, including a worker's writes and a root `git push`. The bundle adds no check and loosens none.
- **File scopes between concurrent writers.** The 0.4.0 `writePaths` conflict guard is gone. The host starts children without comparing their file scopes, so disjoint write scopes are the main agent's job to write into the briefs, and the main agent's job to review.
- **The review.** A `goal-reviewer` child returns a verdict in its completion notice. Nothing validates the verdict's shape, and the main agent cannot write one; the workflow depends on the main agent treating a `fail` as a finding to fix.
- **Outbound content.** Nothing scans or redacts a commit message, a pull request body or an issue comment.
- **External systems.** The package has no MCP client, no connector and no network call of its own.
- **Storage.** There is no ledger file, no storage domain, no web route and no client card. A delegation leaves no record beyond the transcript, the host's completion notice and `list_agents`.

## What the records are and are not

- A completion notice says what a child answered; it does not prove the answer is right.
- A reviewer verdict is evidence of one independent look, not proof that a change is correct.
- The depth cap bounds recursion; it is not a permission boundary. A child still runs with the host's sandbox and approval policy, and with whatever the preset grants it.

## Non-goals

- A sandbox, a permission system or a policy layer for the session.
- Redaction or scanning of outbound payloads.
- Durable delegation records or resume across a host restart.
- A cross-family or vendor guarantee for reviews.
- Compatibility with the 0.4.0 plugin's tools, refusal codes or configuration.
