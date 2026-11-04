# Security and boundaries

This plugin is an **experimental developer preview**. It is not a sandbox or a
permission system, and it does not provide remote **exactly-once** delivery.

Version 0.3.0 removed the plan gate, the read-only sandbox clamp, the egress
gate and the outbound manifest. The plugin no longer stands between the agent
and ordinary work. What remains is below, with the label for how each part is
enforced.

Deeper design and measurements: [DESIGN.md](../DESIGN.md).

## What the plugin gates

- **Nothing about outbound.** Commit, push, pull request and merge in the
  repository you are working on are ordinary work. The plugin adds no manifest,
  no egress check and no owner approval step. No `AP_*` refusal exists for them.
- **The reviewer** is read-only and one-shot. It runs in a fresh context with
  a read-only tool filter and cannot start children. *Mechanical*: the tool
  filter is applied to the child when the host announces it. The reviewer's
  verdict is returned in-band by the reviewer itself; the main agent cannot
  write one.
- **Delegated children** have a tool filter per role (scout, clerk, planner and
  reviewer are read-only; a worker writes only inside its `writePaths`).
  Workers with intersecting `writePaths` are refused before they start.
  *Mechanical*: the filter and the overlap check. *Not mechanical*: whether a
  worker's task text keeps to its brief.
- **Ledger owner actions.** Actions that change the ledger on the owner's behalf,
  such as clearing a legacy archive, require the owner's direct human turn.
  An agent-generated turn is refused. Goal creation, editing and resuming are
  checked by the host's own goal tool, not by this plugin.

## What the host's approval settings do

Whatever approval or sandbox settings the host and profile have still apply to
every tool call, including `git push` and `gh pr create`. The plugin neither
adds to them nor loosens them. A pending or refused approval is a question for
the user. Deploys, deletions of native content and anything spending money or
changing an external account need the owner's order for that action; that is
skill discipline, not a plugin check.

## Redaction before outbound

Before anything leaves the workspace (a PR body, an issue comment, an upload),
the skill tells the agent to remove credentials, tokens and private paths that
carry a user name. This is an instruction in the skill and a review item for
the reviewer ("a secret leaks"). It is **discipline**, not a gate: nothing in the
plugin scans or blocks an outbound payload.

## Legacy sandbox clamp

Runs from plugin 0.2.x could leave a session in read-only sandbox mode. When
such a session is opened or resumed, 0.3.0 restores the mode, but only if the
current mode is still read-only and the last sandbox event is the plugin's own
clamp. The target is the recorded prior mode, otherwise the host default. A mode
the user changed after the clamp stays. This has not yet been observed on a real
host (see [compatibility.md](compatibility.md#not-yet-verified-on-a-real-host)).

## Enforcement labels (do not over-read)

- *Mechanical* means the plugin code refuses or filters the action: the role
  tool filter, the `writePaths` overlap refusal, the direct-human-turn check on
  ledger owner actions, the read-only tool set of the reviewer.
- *Discipline* means the skill asks and a reviewer may catch it: redaction
  before outbound, completing a goal only when Done holds, recording "reduced
  independence", keeping to a brief.
- The ledger's selected and observed routes are what the plugin and the host
  report. They show which model ran; they do not prove the work is right.
- A reviewer verdict is evidence of an independent look, not proof of
  correctness.

## Web routes

`GET /api/autopilot/runs` and `/run` are fenced by the host's `connection`
service. A host with a web server but no `connection` service gets
`503 no-connection-service`, never an open route. The fence is the host's; the
plugin only applies it. The projection these routes return may change with the
0.3.0 ledger.

## Explicit non-goals

- Not a sandbox or permission system for the whole session.
- Not complete production security.
- Not remote exactly-once delivery.
- Not a claim that a ledger entry, a timestamp or a reviewer verdict is true.
- Not a scanner of outbound content.
