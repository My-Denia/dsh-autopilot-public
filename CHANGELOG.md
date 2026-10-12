# Changelog

Host and packaging bounds that outlive a single release are in
[docs/compatibility.md](docs/compatibility.md).

## Unreleased

Realigns the plugin with the current goal-autopilot-harness design, where a host
adapter stays thin and the host-neutral rules live in one reference layer.

### Added (the routing block in the card; 2026-10-12 M13)

- The desktop card now RENDERS the routing status instead of leaving it to the
  API. Four separately labelled lines: `routing` (mode, effective preference and
  its source, the policy state, the engine's `dispatch` verdict), `roles` (each
  role's effective routing and the work class it consults), `dispatched` (the
  routes THIS RUN's own dispatches settled on), and `candidate coverage` — the
  reachability report, labelled in the line itself as **not** a dispatch record.
  `GET /api/autopilot/run` gained the `routingReachability` field the last line
  needs, served SEPARATELY from `routing` for exactly that reason.
- The policy triple `{policyState, policyRouteCount, dispatch}` moves as ONE
  value. The host route has no session to read a policy for, so it always answers
  `unobserved`; a card that let that fresher answer win would print "cannot
  observe" over a policy the engine really read. A session-observed state
  therefore stands, the line says `[read in this session]` where it came from,
  and the route's word is used only when no session observation exists.
- A `mode: off` deployment renders NO routing block at all (the engine serves
  none), and the card adds no "routing off" substitute.

### Added (the executor child's escalation channel; 2026-10-12 M13)

- `autopilot_request_escalation({ text, note })` — the executor child's OWN way
  to ask for a stronger model. Until this existed the request channel had exactly
  one door, `autopilot_log`, which is registered into the ROOT agent's scope and
  whose engine path refuses any caller with a parent session (`AP_NOT_ROOT`): the
  one agent doing the work could not ask for anything. The child entry is
  deliberately narrow — accepted only from the run's live, authorized, `running`
  executor (`AP_ESCALATION_NOT_EXECUTOR` otherwise), with `stance` fixed to
  `escalate` and `escalationTarget` fixed to `stronger-model`, so a child can
  neither write arbitrary checkpoints nor request the governance exits that
  belong to the root. Both doors land at the same single register site, so this
  is one channel with two entry points, and a request still only widens the
  candidate pool: the session-policy intersection, tier membership and the
  independence rules are untouched.

### Fixed (the card folded NOTHING on a real 0.2.0 host; 2026-10-12 M13)

- `readResult` knew only the WRAPPED tool-result envelope
  (`message.content[0].content[0].text`, `isError` on the wrapper). The current
  host delivers the FLAT shape (`message.content[0]` is the text block,
  `isError` on the message), so every result folded to `payload: undefined` and
  the card rendered as a hollow shell — revision 0, no phase, no gates, no audit
  verdicts, no routing block — with no error anywhere to notice it. Both shapes
  are now read (legacy replay included), and both are pinned by unit cases.
- A routing block older than the card's own revision is now RECONCILED from the
  host route once, even for a run that has stopped. Measured: the fold reached
  revision 10 through the closeout result while its routing block came from a
  status at revision 5, so the card listed one dispatched auditor while two had
  run. The routing block is compared against its OWN observation, so an answer
  that is not newer than the card can still correct it — and only it.

### Added (routing status + the escalation request channel; 2026-10-11 M12)

- The run status now carries a `routing` block answering "is routing live on this
  deployment": effective `mode`, `preference` and its source, the session policy
  state (`present` / `absent` / `unreachable` / `unobserved` — an unreadable
  policy is never reported as absent), each role's effective routing and work
  class, the run's own pins, and the ladder's shape. `mode: 'off'` projects
  nothing. It is served on `GET /api/autopilot/run` (the route the desktop card
  polls) and on `autopilot_status`.
- The work-class escalation request channel (DESIGN §1.2 "升档是请求，不是预测"):
  `autopilot_log({ stance: 'escalate', escalationTarget: 'stronger-model', note })`
  widens the next auto dispatch that RUNS A SELECTION — a first dispatch, a
  dead-pin re-selection, rotation, or a healthy pin forced to re-select — to
  `economy + standard + reserve` (an owner-written
  `routing.workClasses.<class>.tiers` still wins). The dispatch names the request
  in its `why` trace and records the replaced pin as `repinFrom`. It is consumed
  once, is left open by a dispatch that runs no selection, and never widens an
  authorization: the candidate set is still the session-policy intersection,
  still filtered by tier membership, and still ordered by the auditor
  independence rules.

### Fixed (plan-reviewing wedge, P0; 2026-10-11 M10)

- A refused plan audit no longer leaves the run wedged in `plan-reviewing`.
  Pre-dispatch phase and both baseline revisions are captured before the
  auditor is dispatched; when the verdict path refuses the audit
  (`AP_AUDIT_NO_VERDICT`, `AP_AUDIT_INVALID_VERDICT`, `AP_AUDIT_FINDINGS_INVALID`)
  and the live state still matches the captured baseline, the engine commits a
  recovery event (op `audit`, detail `{role, stage:'rejected', error:{code,
  message}, auditorId}`) that restores the pre-dispatch phase. No `audits[]`
  entry is appended and no gate is touched; the refusal still rethrows. A stale
  audit (`AP_STALE_AUDIT`) deliberately does NOT roll back. Measured on the real
  host: a `needs-replan` carrying only an execution-layer finding used to wedge
  the run in `plan-reviewing` (every further plan audit refused by
  `assertAuditPhase`); post-fix the phase recovers to `planning` and the
  re-dispatch passes. Red→green in `test/plan-audit-wedge.test.ts`; real-boot
  evidence in `goal-runs/m10-desktop-reliability/evidence/p0-wedge-recovery.json`.

### Added (unattended egress, P1; 2026-10-11 M10)

- `governance.unattended` (boolean, default off; mirrored in `CONFIG_KEY_SPEC`).
  When on, a validated egress manifest no longer asks the owner mid-run: the
  gate DENIES the egress before spawn, naming the command and target, stating
  the manifest still stands, giving the recovery path (owner runs
  `autopilot_signal owner-approve`, then the agent retries — `consumeApproval`
  honors it), and noting other authorized non-egress work continues. When off,
  the ask path is byte-identical to before. Every egress ask/deny is recorded on
  the run (`enforcement.egressDecisions`, outcome `asked` /
  `denied-unattended`) so an unattended refusal is visible and recoverable
  rather than an infinite wait. Doctrine in `src/policy.ts` and
  `skill/dsh-autopilot/SKILL.md`. Tests in `test/preexecute.test.ts` and
  `test/policy.test.ts`.



- `run_code` program source now gets a CODE-AWARE egress reading instead of
  verbatim mention-refusal: tagged templates and enumerated sink-call arguments
  (exec/execSync/execFile/spawn/system/popen/runCommand) are performances and
  still match verbatim; mentions inside ordinary strings, comments and untagged
  templates are data and pass. Nested pwsh/bash/run_code dispatches stay gated
  at their own call; `terminal_send` keeps verbatim matching (one Enter from
  execution). Measured motivation: two legitimate operations were refused
  because audit packets QUOTED egress phrases from the owner's ruling.

### Fixed (routing reachability refresh, M7b; 2026-10-10)

- `routingReachability` is now read from the CURRENT routing section instead of
  from the config the last FRESH selection happened to run under. The report had
  exactly one writer, inside the selection path (`selectForRole`); a healthy-pin
  REUSE never reached it, so after a profile edit the StatusView served the
  pre-edit ladder while the onboarding section — reading the same
  `volatileRoutingAccess` closure — already reported the new one. The engine now
  refreshes the report on each routing decision and again on the status read
  path (`autopilot_status` awaits `refreshReachability()` before projecting).
  Measured pre-fix: the regression test in `test/routing-integration.test.ts`
  read `reachable` where the live config said `unreachable-models`.
- Corrected a claim the fix made false:
  `skill/dsh-autopilot/references/model-routing.md` said the engine refreshes
  the report "on every selection"; it now says the report is read from the
  current routing section, refreshed by every routing decision and by the status
  read path. The dispatch-membership claim was checked and kept: dispatch does
  read the live config (`routingSource`).
- DESIGN.md §9 item 12 carries the same boundary (the predecessor M7 probe's
  "engine kept a mount-time snapshot" reading is falsified — no dispatch in that
  window read the config at all).

### Added (governance pragmatics v1)

- Graded audit findings: auditors may return `findings`
  (`blocking`/`non-blocking` × `plan`/`execution`/`rules`); a `pass` may carry
  non-blocking findings without burning a round; a `needs-replan` without a
  blocking plan-layer finding is refused pre-commit (`AP_AUDIT_FINDINGS_INVALID`)
  and executor-fixable defects are steered to the existing `needs-fix` lane.
- `autopilot_amend_plan` — amend the passed plan mid-execution without
  destroying execution state; a plan-role delta re-audit at the amended revision
  re-opens evidence/closeout (`AP_AMEND_REAUDIT_REQUIRED` while pending,
  fold-derived `planAmendedAtRevision`).
- Partial delivery: unproven criteria at closeout require a structured handoff
  (`handoffOpenItems` bijectively mapping every unproven criterion, optional
  `handoffNextAuthorizedAction`); the engine derives the `complete`/`partial`
  outcome label, stamped `closeoutHandoff: 1`; legacy closeouts keep their
  reading.
- Cross-run carryover: `autopilot_init` accepts `carryoverFromRunId` +
  `carryoverNote` + `carryoverInherits`, validated against the store (the
  predecessor must exist and be completed).
- Owner-decision narrowing: replan-budget exhaustion no longer forces
  `needs-owner-decision` (visible diagnostic instead; escalation is
  deliberate); `owner-resolve` gains `resume-execution`, restoring the
  paused-from phase with gates/evidence untouched (`pausedFrom` derivation).
- `governance.maxAuditRoundsPerRole` config (default off): refuses same-role
  dispatches beyond the cap (`AP_AUDIT_ROUND_CAP`) — a brake on audit storms
  that never invents an owner question.
- Governance docs: five new invariant sections (Audit Findings Grading,
  Minimum-Sufficient Admission, Plan Amendment and Delta Re-audit, Partial
  Delivery and Carryover, Owner-Decision Boundaries) with heading census;
  refusals.md documents the 13 new codes in a new section 16 with the
  bidirectional census; docs/reference.md and SKILL.md tool sequences updated;
  DESIGN.md §8.5 records the decisions and their honest limits.

### Added (model routing, DESIGN §9 items 11–16; 2026-10-10)

- Work-class dispatch membership: five fixed task classes (`mechanical` /
  `simple` / `hard` / `audit` / `extreme`) with role defaults, per-role
  override via `routing.roles.<role>.workClass`, per-class tier remapping via
  `routing.workClasses`; a tier-bound class whose mapped tiers leave zero
  reachable routes blocks the dispatch with
  `AP_ROUTE_NO_REACHABLE_WORK_CLASS` (routing-escalation pause) instead of
  silently shelving. The ladder engages only when configured or overridden —
  otherwise the selection is recorded, not applied (0.2.0 parity).
- First-use onboarding: the `autopilot:routing-onboarding` system-prompt
  section (root agents only, zero tokens when fully covered / unobserved /
  routing off) names the models no tier-bound class can reach and instructs
  the agent to check current capability facts online or ask the owner — never
  to infer from model names — then to assign `provider/model` ids to
  `routing.ladder.tiers.*` (volatile leaves, no restart); hosts without a
  config-edit surface get the exact YAML to hand to the owner.
- Explicit preference provenance (A2): `routing.preferenceSource` is resolved
  and selection records carry `preferenceSource`; the explicit opt-in
  `routing.orderingAxisDefault: true` promotes the ordering-axis path (price,
  then owner-declared speed) to the deployment default without touching
  deployments that never wrote it.
- Engine-level auditor rotation (A4, DESIGN §9-15, auditor roles only):
  `routing.ladder.rotation: true` (default off) makes a healthy auditor pin
  yield to a full re-selection at the next same-role dispatch, offset by the
  audit-count ordinal within its independence class — rotation never overrides
  cross-family independence, and executor engine-level rotation stays an
  explicitly recorded known limitation.
- Coverage upgraded to work-class reachability: `workClassReachability`
  (`kind: 'work-class-reachability'`, five outcomes over the same non-empty
  observation floor, `auditTier` overrides reflected, non-tier-bound classes
  named not counted), refreshed by the engine from the same cached catalog
  snapshot and exposed on StatusView as `routingReachability` (absent = never
  observed).
- Deployment hazard documented (measured on Windows Desktop 0.2.0-rc.2): a
  profile patch entry that re-declares `id: autopilot` REPLACES the packaged
  bundle layer's config, so the packaged `storeKind: file` pin must be repeated
  — without it the medium silently flips to the `storageDomain` backend and a
  session loses the file-backed run it was working on. See
  [docs/compatibility.md](docs/compatibility.md).
- Live-host hardening from M7 acceptance: the onboarding probe now reads the
  host's config-edit surface through `ctx.get` instead of a bare property read
  — cordis THROWS on an undeclared service read (`cannot get property
  "configEditor" without inject`), which took the whole mount down at first
  section render on a real 0.2.0 host while `apply.test.ts`'s permissive fake
  saw nothing; `fakeCtx` gained a `strictServiceAccess` mode (undeclared
  service reads throw, context-API members pass) and a regression test now
  fails against the old probe.
- The onboarding notice states the selection prerequisite (M7 finding on two
  real hosts): a session with no `subagent/model-selection-policy` record —
  and every session measured so far — authorizes nothing, so auto mode only
  inherits and the ladder selects nothing at all. The notice says
  "INHERITANCE ONLY" for `absent` (pointing at the host's own subagent model
  selection, which applies to new sessions) and its own wording for an
  unreachable projection, and stays silent when a policy is present.
- Rules-audit corrections (2026-10-10, all three were shipped contracts that
  were false of the code): `hard`'s default candidate pool is now **economy
  only** — DESIGN §1.2's "try economy first; widen only when the working model
  asks" plus a request channel that is a documented non-goal left the shipped
  `economy + standard + reserve` seed silently widening a `hard` dispatch to the
  ceiling, so the seed and the table now agree and a new census test compares
  the routed class→tier table against `DEFAULT_WORK_CLASSES` both ways;
  recorded boundary (a) was rewritten to the delivered producer set (the
  mechanical `requirements: { effortIds: ['low'] }` licence plus ladder-tier
  membership are produced at the dispatch site; modality, the extended context
  floor and the ceiling still are not); and the onboarding notice's owner-edit
  path now really emits the YAML block it promises, carrying the observed
  unreachable ids with the tier left to the capability facts (asserted in
  `test/routing-onboarding.test.ts`, and `SKILL.md` now routes readers to
  `references/model-routing.md`).
- Docs: DESIGN.md §1.2/§9 items 11–16 updated in place (§9-15 marked
  partial-for-executor); model-routing.md owns the work-class table, rotation
  leaf, onboarding behavior and the updated recorded boundaries, now including
  the no-policy inheritance boundary; refusals.md §10 documents
  `AP_ROUTE_NO_REACHABLE_WORK_CLASS`.

### Added

- `skill/dsh-autopilot/references/governance-invariants.md` — the host-neutral governance rules
  (risk and audit shape, the audit invariants, evidence sufficiency, sizing,
  delegation, closeout), each labelled with what actually enforces it. Shipped
  in the npm package.
- `skill/dsh-autopilot/references/refusals.md` — the single routed owner of what the engine refuses:
  the contracts behind all `AP_*` codes, with the remedy for each.
- `autopilot_status` now returns `latestAuditRecords`: the latest audit record
  per role, verbatim, so an audit packet can be built from the run state instead
  of from a verdict word retyped by hand.
- `skill/dsh-autopilot/references/model-routing.md` — the routed owner of the DSH
  routing contract: the authority order (owner explicit config > latest host or
  fetched facts > the generated cost seed > unknown), the pass/fail thresholds
  versus the ranking axes, the owner's ladder, the recorded boundaries, and the
  cost seed's provenance.
- `routing.ladder` — the owner's classification: fixed `economy`/`standard`/
  `reserve` tiers, `auditTier`, an owner-declared `speedOrder`, and
  `costOverrides` written `provider/model=inputPerM/outputPerM` (a malformed entry
  is refused, never dropped). Sufficiency thresholds pass or fail, and only the
  survivors are ranked — on price, then on the owner's declared speed. Unknown
  never ranks; price is not capability, and context window is not capability.
- The cost seed (`seed-cost@2026-10-09`) — one price column generated from the
  harness's own provider catalogs and keyed by model identity rather than route,
  with the matching step labelled (`route` / `model` / `model-case-folded`) and an
  unmatched route recorded as `unknown` rather than proxied.
- Tier coverage (`coverageReport`) — a `'tier-coverage'` verdict over the models a
  live catalog actually observed, with five outcomes so an unobserved,
  unconfigured or incompletely listed catalog can never read as coverage.

### Changed

- `skill/dsh-autopilot/SKILL.md` is now a thin adapter. It supplies the DSH
  bindings and routes to the reference layer for the rules, instead of restating
  them.
- `docs/reference.md` no longer claims to be a second copy of the skill; the
  two now have distinct, stated owners.
- DESIGN.md §1.2 originally recorded the routing boundaries as they stood then:
  the `requirements` threshold input had no production producer; a role holding a
  live pin did not re-select, so engine-level automatic rotation was not
  delivered; a `balanced` default and an explicitly written `balanced` were
  indistinguishable, so the axis path could not yet be the default; and coverage
  was tier coverage of observed models, not work-class reachability. **The
  work-class release below moved all four**: `requirements` now has one producer
  (the mechanical effort licence) and the ladder's tier membership is applied at
  the dispatch site; **auditor** rotation is delivered as an explicit owner
  opt-in (executor rotation remains the recorded known limitation); A2 ships as
  the explicit `routing.orderingAxisDefault` opt-in; and coverage is two metrics
  (tier coverage plus work-class reachability). Read the "已记录的边界" section
  of DESIGN.md, not this historical line, for the delivered set.

### Fixed

- 69 of the 78 engine refusal codes were stated nowhere a caller is routed to.
  `test/refusals-contract.test.ts` now censuses the codes in both directions so
  a new gate cannot ship without its contract.

## 0.2.0 — 2026-10-07

Adapts the plugin to DeepSeek Harness (`dsh`) 0.2.0, the CLI and the Desktop
app's bundled `dsh` command. Measured on WSL2 against a real `dsh`
0.2.0-rc.2 with a local mock model; Desktop itself was not run. Details:
[docs/compatibility.md](docs/compatibility.md),
[DESIGN.md §8.4](DESIGN.md).

### Fixed

- Installable on dsh 0.2. The `@deepseek-ai/dsh-tools` peer now also allows
  `>=0.2.0-rc.1 <0.2.1-0`; dsh 0.1.7+ refuses plugins whose dsh peers do not
  match the running version, and refused 0.1.1.
- Needs-fix executor resume. It called `subagents.followup`, which no
  published dsh has (0.1.2-rc.1 through 0.2.0-rc.2); it now uses
  `subagents.sendMessage`.
- Executor child recognition on dsh 0.2. Reading `ctx.agent` on the child
  context throws there, so the executor ran without
  `autopilot_submit_packet`, egress guard, or seam. Recognition now uses the
  agent announced by `agent/created`.
- The stop reminder no longer exits dsh 0.2. Its message source kind is now
  `dsh-autopilot`; session format v4 refuses the retired `kind: 'plugin'`.
- The npm package now ships `docs/` and `CHANGELOG.md`. The README links
  to them, and in an installed package those links were dead.
- The run card follows PTC calls on dsh 0.1.7+, which renamed
  `tool/code-dispatch(-start)` to `tool/ptc-dispatch(-start)`. Both names
  are accepted.

### Changed

- Test/build pins: `@deepseek-ai/dsh-*` `0.2.0-rc.2`, cordis `4.0.4`,
  schemastery `3.18.4`.
- New tests check the installed subagent manager surface, the dsh 0.2 child
  context shape, the reminder source kind, and the renamed PTC events.

### Not verified

Desktop on macOS/Windows, Windows in general, a full run with a real model
through closeout, executor re-recognition after a cold-resumed child, and
the card rendering in a browser.

## 0.1.1 — 2026-09-13

Packaging / runtime compatibility release. Parent of the version bump is
`ff7ccaef` (keep `dsh-tools` a host-provided peer).

0.1.0 shipped `@deepseek-ai/dsh-tools` in runtime `dependencies`; that is the
defect this release repairs. No separate 0.1.0 changelog date is recorded
here.

### Fixed

- Stop shipping `@deepseek-ai/dsh-tools` in runtime `dependencies`.
- That second copy split the module-instance `TOOL_RUNTIME_SCHEDULER` Symbol
  and crashed host `skill` (`scheduler.prepare` undefined).
- Bounded peer kept as `0.1.2-rc.1 || >=0.1.5-rc.1 <0.1.6`. The test/build
  pin stays in `devDependencies`.

### Compatibility (WSL2, `dsh` `0.1.5-rc.1`)

Verified: npm install, compose/mount, skill install/load, autopilot entry,
plan/replan/audit through the plan gate.

Not verified: full write lifecycle. The tested headless model does not currently follow the host sandbox escalation contract for ordinary workspace-write calls. That mismatch is a host/model contract issue, not this plugin's 0.1.1 scope.
