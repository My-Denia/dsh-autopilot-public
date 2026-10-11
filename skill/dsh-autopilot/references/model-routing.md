# Model routing

Model routing decides which model a role dispatches on. This file owns that
contract for the DSH adapter: the authority order over routing facts, the
separation between sufficiency thresholds and ranking axes, the owner's
`routing.ladder`, the boundaries of what is actually implemented, and the
provenance of the generated cost seed.

It does NOT own the tool protocol, the phase machine or the refusal codes — those
are in [reference.md](../../../docs/reference.md) and
[refusals.md](./refusals.md) — nor the host-neutral governance rules in
[governance-invariants.md](./governance-invariants.md). The engine's routing
record and pin contract (what a `detail.routing` decision must look like, and
when `routingPins` may move) is [refusals.md](./refusals.md) §10.

## Authority order

Routing facts come from four sources, highest first. A higher source always
overrides a lower one, and every fact carries the source that produced it, so a
decision can be audited after the fact.

| # | source | what it may decide |
| --- | --- | --- |
| 1 | owner explicit configuration (`routing.*`, `routing.ladder.*`) | anything below; an owner value is never overridden by the plugin |
| 2 | latest host or fetched facts (the host's `resolveModelInfo`: permitted efforts, input modalities, context window; a live catalog or price lookup recorded with `source` + `observedAt`) | eligibility and thresholds, and the axes wherever the fact is current |
| 3 | the generated cost seed (`seed-cost@<date>`, a bootstrap snapshot) | price only, and only where sources 1 and 2 are silent |
| 4 | unknown | nothing. It is recorded as `unknown` and never replaced by a proxy |

Bans that follow from the order (a violation is a defect, not a style choice):

- **No hard-coded capability, speed or quality table.** A model generation
  changes in months; a table compiled into the plugin is wrong quickly and
  silently.
- **Nothing is inferred from a model-name root.** `highspeed`, `flash`, `pro`
  and `turbo` imply nothing about speed, capability or price. Inferring from a
  name is guessing, and a guess is not a fact.
- **The agent's own prior or training knowledge is not evidence.** It is stale by
  construction. A routing fact without a traceable source and observation time is
  `unknown`, not a default.

Staleness: any fact from source 2 or 3 carries `source` + `observedAt`. A
catalog change (`llm/adapters-updated`) or an expired observation makes it stale;
it must be re-fetched or returned to the owner. A stale prior must not be used as
a fact.

## Sufficiency thresholds and ranking axes

These are two different operations and must not be mixed.

**Sufficiency thresholds pass or fail, and are NEVER ranked.** A candidate that
fails a threshold is not "a little worse"; it is not a candidate. The threshold
set is:

| threshold | meaning |
| --- | --- |
| effort permit set | the route must permit the effort the role needs |
| modality | the route must accept the input modality the task carries |
| context floor | the route's context window must cover the task's real need; the role `minContext` is the declared floor (executor and planner 131072, auditors 65536) |
| owner tier | where the owner's ladder restricts a role to a tier, membership in that tier is a pass/fail gate |
| ceiling | the route's ceiling must reach the task's difficulty; a route below it is out, not ranked low |

**Ranking axes order only the survivors.** They apply after every threshold,
never instead of one:

1. price — the cheapest surviving route first, from owner `costOverrides` at
   source 1, else the seeded price at source 3;
2. owner-declared speed — the `speedOrder` the owner wrote, earliest first.

**Unknown never ranks.** A route whose price or speed is unknown is not treated
as cheap, fast, expensive or slow. It is recorded as unknown and, where the rule
needs it, sorted after every known-sufficient candidate with the reason named.

Two consequences, each of which corrects a proxy that once stood in code:

- **Price is not capability.** Price says what a call costs, not what a model can
  do. A newer, stronger model can be cheaper.
- **Context window is not capability.** Two routes can carry the same model at
  different windows (`k3-256k` and `k3`). The window is a threshold — enough or
  not enough — and bigger is not better.

The axis ordering above is the contract. It applies when the owner writes
`routing.preference: 'axis'` explicitly, or sets `routing.orderingAxisDefault:
true` to promote it to the deployment default — the owner chose the promotion,
not axis itself, so the recorded source stays `default`. Without either, the
shipped default stays `balanced`, byte-identical to what it was before.

## The ladder

`routing.ladder` is the owner's declared classification. Tier names are FIXED
because the config loader follows volatile references only so deep and refuses a
volatile leaf beneath a transform or a keyed dict; arbitrary owner-authored tier
names are therefore not expressible.

| field | shape | default when the owner is silent |
| --- | --- | --- |
| `tiers.economy` / `tiers.standard` / `tiers.reserve` | `provider/model` lists | empty — no member |
| `auditTier` | `economy` \| `standard` \| `reserve` \| `none` | `none` (no tier restriction) |
| `rotation` | boolean | `false` — pins keep their shipped stability semantics |
| `speedOrder` | `provider/model`, fastest first | empty — speed is unknown and is not ranked |
| `costOverrides` | `provider/model=inputPerM/outputPerM` | empty — the seed applies |

Owner values win; a declared default applies only where the owner is silent.
Nothing is derived from a model name or id. A malformed `costOverride` entry, or
an `auditTier` outside the fixed set, is REFUSED at resolution rather than
dropped: a silently ignored pricing instruction would leave the owner believing a
route costs what it does not.

`rotation: true` is an explicit owner opt-in to engine-level re-selection for
AUDITOR roles: a healthy pin yields to a full re-selection at the next dispatch
of the same role, offset by the audit-count ordinal within its independence
class (rotation never overrides cross-family independence). Executor never
rotates this way — see boundary (b) below.

The resolved ladder is recorded so a decision can cite what the owner said. Its
tiers feed the owner-tier threshold, work-class dispatch membership, and both
coverage metrics; boundary (b) below records the one rotation surface that is
still not delivered.

## Work classes

The owner's task table (DESIGN §1.2) decides which axis dominates a dispatch and
which ladder tiers it draws from. Five fixed classes:

| class | dominant axis | default tiers | default roles |
| --- | --- | --- | --- |
| `mechanical` | speed (a real permitted `low` effort) | none — fact permit | — (no auto role defaults here) |
| `simple` | price + speed | `economy` | executor, planner |
| `hard` | try economy first (the escalation request channel is a documented non-goal, so the pool does NOT widen on its own) | `economy` | — |
| `audit` | ceiling + independence | `standard` | audit-plan, audit-execution, audit-rules |
| `extreme` | ceiling | `reserve` | — |

`routing.roles.<role>.workClass` overrides a role's class; `routing.workClasses`
overrides a class's `tiers` mapping per class. A class not named there keeps
this table's default. The ladder engages — actually restricts candidates — only
when it is configured or the owner overrode a class; with an empty ladder and no
overrides the selection is recorded, not applied (0.2.0 parity).

A tier-bound class whose mapped tiers leave ZERO reachable routes is a
configuration error, not an empty answer: the dispatch blocks with
`AP_ROUTE_NO_REACHABLE_WORK_CLASS` and the run pauses through the routing
escalation path. `mechanical` is not tier-bound (its gate is the fact permit),
so it cannot fire that code.

Coverage is two metrics. `coverageReport` (`kind: 'tier-coverage'`) answers "is
every observed model claimed by some configured tier". The work-class
reachability report (`kind: 'work-class-reachability'`, exposed on StatusView as
`routingReachability` — absent means never observed, never claimed) answers
"does every observed model have at least one reachable tier-bound class", with
the same non-empty observation floor (`unobservable` / `unconfigured` /
`incomplete` / `unreachable-models` / `reachable`).

## Recorded boundaries

The following are mechanical facts about the current implementation, stated here
so the sections above are not read as claims the plugin does not deliver. Where
they conflict with an intention stated elsewhere in the repository, these
boundaries win.

**(a) The `requirements` threshold input has ONE production producer (the
mechanical class's effort license); the rest of the threshold side is still
unproduced.** As of the work-class change, the engine constructs
`requirements: { effortIds: ['low'] }` at the production dispatch site for the
mechanical class — DESIGN §1.2's own entry gate ("holders of a real `low`
effort"), which is a fail-closed sufficiency threshold, not a ranking axis. The
ladder's tier membership is also applied at that site (a class's candidate set
is the union of its mapped tiers), which is the owner-tier threshold in its
delivered form. Everything else on the threshold side remains unproduced and
must never be described as production enforcement: modality, the context floor
beyond the role `minContext` default, and the ceiling have no producer at a
dispatch site. Effort beyond the mechanical licence is read from the adapter's
declared facts.

**(b) A role holding a live pin does not re-select by default; AUDITOR roles may
opt into engine-level rotation.** The engine reuses a role's recorded pin while
its provider is still live, its preflight still accepts and its authority still
covers it — stability over re-selection — and re-selects only a dead pin, with
`repinFrom` recorded. With `routing.ladder.rotation: true` (explicit owner
opt-in, off by default) an auditor role re-selects in full at the next dispatch
of the same role: the why line names rotation as the cause, the ordinal comes
from the run's own audit records (replay-safe), and the offset lands within the
audit independence class, so rotation never overrides independence. Executor
never enters that branch, and the reason is mechanical rather than incidental:
`AUDIT_ROLE_OF_ROUTING_ROLE` has no executor entry, so the engine supplies no
rotation ordinal for it and the engine's rotation branch is gated on
`AUDITOR_ROLE_SET` — no executor NO-OP line is ever recorded. Stability weighs
higher. Engine-level executor rotation is a recorded known limitation, not a
silent gap.

**(c) The `balanced` default and an explicitly written `balanced` are still
indistinguishable through the config's explicitness ceiling; the axis path is
the default only by explicit opt-in.** schemastery fills defaults before
`apply()`, and the loader and plain config paths must resolve identically, so a
written `balanced` equal to the default records `preferenceSource: 'default'`
honestly on both paths. A2's delivered form is `routing.orderingAxisDefault:
true`: it promotes the axis path (price, then owner-declared speed) to the
deployment default; the effective preference records `axis` with source
`default`, and untouched deployments are unchanged byte for byte.

**(d) Coverage is two metrics: tier coverage AND work-class reachability.** The
coverage report (`kind: 'tier-coverage'`) keeps its five outcomes and its
question: is every observed model claimed by some configured tier? The
work-class reachability report (`kind: 'work-class-reachability'`) answers the
second question — does every observed model have at least one reachable
tier-bound work class — over the same observation floor (`unobservable` /
`unconfigured` / `incomplete` / `unreachable-models` / `reachable`), with
`auditTier` overrides reflected and non-tier-bound classes (mechanical) named
but not counted. StatusView exposes it as `routingReachability`, and it is read
from the CURRENT routing section, never from the last selection's config: a
selection refreshes it from the same cached catalog snapshot that decision
reads, and the status read path refreshes it before projecting (both through the
same `workClassReachability` metric, absent = never observed, never claimed).
The status path is what covers a pin REUSE, which runs no selection.
The correction is measured: until the M7b fix the report had exactly one writer,
inside the selection path, so a healthy-pin REUSE after a config edit served the
pre-edit ladder while the onboarding section — reading the same
`volatileRoutingAccess` closure — already reported the new one.

Also recorded: `routing.ladder` is resolved, owner-editable, and wired into
dispatch membership — a tier-bound work class's candidate set is exactly the
members of its mapped tiers, **whenever a selection happens at all**.

**(e) A session with no subagent model-selection policy cannot select, so the
ladder governs nothing there.** Measured on two real 0.2.0 hosts (2026-10-10):
neither the desktop session nor a fresh headless session had a
`subagent/model-selection-policy` event, and auto mode then performed
INHERITANCE ONLY — the engine's own why line reads `authorization: no session
model-selection policy recorded (the native default) — auto mode performs
inheritance only; settings are never consulted as authority`. The ladder was
fully configured in the same session, coverage reported an unreachable model,
and every dispatch still went to the deployment default: no candidates, no
rotation, no ladder membership. A `present` policy (the host's own subagent
model selection — UI wording "Allow agents to choose models for Subagents",
which APPLIES TO NEW SESSIONS only) is what creates the authorized set the
ladder intersects; `unreachable` (the projection cannot be read) is recorded as
`unreachable-inherit` and also inherits. Plugin config grants (a role lock, a
legacy pick) stay allowed while the policy is absent — the 0.2.0 parity rule —
but a grant is not a selection. The M5 onboarding notice says this out loud in
exactly these sessions, with different wording for `absent` and `unreachable`,
so a configured ladder is never read as live routing. Onboarding: when routing is on and the live catalog
holds a model no tier-bound class can reach, the `autopilot:routing-onboarding`
system-prompt section (root agents only) tells the agent to check current
capability facts online or ask the owner — never to infer from model names — and
to assign the models to `routing.ladder.tiers.*` (volatile leaves, no restart);
on hosts without a config-edit surface it names the exact YAML for the owner to
edit. Fully covered, unobserved catalog, or routing off all render zero tokens.

## Cost seed provenance

The seed carries the one routing column the host does not publish: token price.
The host's `resolveModelInfo` publishes permitted efforts, modalities and the
context window, but not price.

- Identity: `seed-cost@2026-10-09`.
- Source: generated 2026-10-09 from the harness's own provider catalogs,
  `@earendil-works/pi-ai/dist/providers/data/<provider>.json`. It is a snapshot
  of a verifiable source, not this project's judgment, and it is always
  overridable by owner configuration.
- Scope: `token price only — never a capability ranking, never a dispatch
  authority`.
- Shape: 153 routes / 136 model ids / 15 first-party providers. Free and
  subscription routes (both prices 0) are omitted: "0" there is a billing
  arrangement, not a price.
- Keying: a provider-blind model-identity index. Resolution runs from the
  specific to the general and REPORTS the step that answered: `route` (exact
  `provider/model`), `model` (the id matched under some other provider; the
  generator refuses an id two providers price differently), `model-case-folded`
  (a near-miss recovered and LABELLED, so a typo stays visible), or absent
  (`cost: unknown`, never a proxy).

The seed is a bootstrap, not a fact for all time. Once a live or owner source
answers, it outranks the seed, and the recorded `source` shows which one
answered.
