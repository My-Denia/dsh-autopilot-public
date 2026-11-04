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
- **Delegated children** have a tool allow-list per role: scout, planner and
  reviewer get only `read`, `glob`, `grep` and `read_image` (scout also
  `web_fetch` and `web_search`); a clerk gets the same set as a scout
  today. Connector tools are not wired into delegation yet, so reads and writes
  of external systems stay with the main agent. A worker
  and an executor-lead have no allow-list. `writePaths` is a conflict guard,
  not a permission system: a worker is not stopped from writing outside its
  declared paths, but a dispatch whose `writePaths` intersect those of a
  writer that is still running (`starting` or `running`) under the same root is refused before it starts, and a worker
  dispatch without `writePaths` is refused. Only an executor-lead gets the
  delegation tools, and it may start only scout, clerk and worker.
  *Mechanical*: the allow-lists, the dispatch rule and the overlap check.
  *Not mechanical*: whether a worker's task text keeps to its brief and its
  declared paths.
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
the user changed after the clamp stays. A clamped legacy session was restored to its prior mode on a real host; the case where the user changed the mode after the clamp was not observed (see
[compatibility.md](compatibility.md#verified-on-a-real-host)).

## Enforcement labels (do not over-read)

- *Mechanical* means the plugin code refuses or filters the action: the role
  tool allow-lists, the `writePaths` overlap refusal, the direct-human-turn
  check on ledger owner actions, the read-only tool set of the reviewer.
- *Discipline* means the skill asks and a reviewer may catch it: redaction
  before outbound, completing a goal only when Done holds, keeping to a
  brief.
- The ledger's selected and observed routes are what the plugin and the host
  report. They show which model ran; they do not prove the work is right.
- A reviewer verdict is evidence of an independent look, not proof of
  correctness.

## Web routes

When the host has a web server, the plugin mounts three same-origin, GET-only
routes under `/api/autopilot`:

| route | answers |
| --- | --- |
| `GET /api/autopilot/ledger?session=<id>` | `200 {ok:true, ledger}`; `400 {ok:false, error:'missing-session'}` without `session`; `404 {ok:false, error:'no-ledger'}` when that session has no ledger and, if it is live, no native goal (a live session's goal is mirrored into a ledger on this read) |
| `GET /api/autopilot/runs` | `200 {ok:true, runs}`: every legacy 0.2.x run, from both backends |
| `GET /api/autopilot/run?id=<id>` | `200 {ok:true, run}`; `400 {ok:false, error:'missing-id'}` without `id`; `404 {ok:false, error:'no-run'}`. `id` is a run id, or a session id: then the last legacy run listed for that session is served |

Any other method answers `405 {ok:false, error:'method-not-allowed'}`; an
unexpected failure answers `500 {ok:false, error:'internal'}` with no store
path or exception text. Every route is fenced by the host's `connection`
service on each request (browser authentication and Host/Origin checks, `401`
or `403` when rejected). A host with a web server but no `connection` service
gets `503 {ok:false, error:'no-connection-service'}`, never an open route. The
fence is the host's; the plugin only applies it. A host with no web server
mounts nothing. Reading a ledger for a session found only in the legacy domain table copies it to its own file; the domain file is never written. The routes read through the read-only service and cannot
change the ledger.

## Explicit non-goals

- Not a sandbox or permission system for the whole session.
- Not complete production security.
- Not remote exactly-once delivery.
- Not a claim that a ledger entry, a timestamp or a reviewer verdict is true.
- Not a scanner of outbound content.
