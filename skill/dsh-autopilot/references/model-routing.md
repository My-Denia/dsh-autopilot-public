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

The axis ordering above is the contract. It is not yet the default path; the
boundaries below say exactly where it stands.

## The ladder

`routing.ladder` is the owner's declared classification. Tier names are FIXED
because the config loader follows volatile references only so deep and refuses a
volatile leaf beneath a transform or a keyed dict; arbitrary owner-authored tier
names are therefore not expressible.

| field | shape | default when the owner is silent |
| --- | --- | --- |
| `tiers.economy` / `tiers.standard` / `tiers.reserve` | `provider/model` lists | empty — no member |
| `auditTier` | `economy` \| `standard` \| `reserve` \| `none` | `none` (no tier restriction) |
| `speedOrder` | `provider/model`, fastest first | empty — speed is unknown and is not ranked |
| `costOverrides` | `provider/model=inputPerM/outputPerM` | empty — the seed applies |

Owner values win; a declared default applies only where the owner is silent.
Nothing is derived from a model name or id. A malformed `costOverride` entry, or
an `auditTier` outside the fixed set, is REFUSED at resolution rather than
dropped: a silently ignored pricing instruction would leave the owner believing a
route costs what it does not.

The resolved ladder is recorded so a decision can cite what the owner said. Its
tiers are the owner-tier threshold and the coverage input; the boundaries below
record what is not yet wired.

## Recorded boundaries

The following are mechanical facts about the current implementation, stated here
so the sections above are not read as claims the plugin does not deliver. Where
they conflict with an intention stated elsewhere in the repository, these
boundaries win.

**(a) The `requirements` threshold input has no production producer, so it is
INERT in production.** The threshold side is expressed as a `requirements` input
covering effort permit set, modality, context floor, owner tier and ceiling. No
production dispatch site constructs one. It must never be described as
production enforcement. The thresholds that do run today are narrower: the role
`minContext` floor and the authorization intersection (session-policy routes ∩
live providers). Effort is read from the adapter's declared facts; the modality,
ceiling and owner-tier thresholds have no producer at a dispatch site.

**(b) A role holding a live pin does not re-select, so engine-level automatic
rotation is NOT delivered.** The engine reuses a role's recorded pin while its
provider is still live, its preflight still accepts and its authority still
covers it — stability over re-selection — and re-selects only a dead pin, with
`repinFrom` recorded. Any rotation is therefore confined to the selector; the
engine adds none. A coverage requirement that needs later dispatches to spread
work is not satisfied by this design, and is not claimed to be.

**(c) The `balanced` default and an explicitly written `balanced` are
indistinguishable through the config's explicitness ceiling, so the axis path
cannot yet be the default.** The resolver collapses `preference` to a plain
value, so nothing downstream can tell a shipped default from an owner
instruction. Making the axis path the default would silently change every
deployment that never wrote one, so it stays non-default until an explicit
preference source exists.

**(d) Coverage is TIER coverage over OBSERVED models, not work-class
reachability.** The coverage report names its metric `'tier-coverage'` and
answers one question: is every model the listing actually observed placed in some
configured tier? Its five outcomes exist so that "nothing was observed", "nothing
was configured", "a provider failed to list" and "some observed model is
unplaced" can never collapse into a pass. It does not answer "does every model
have a reachable work class", because no `workClass` input exists at any
dispatch site. A work-class table in a design document is a target, not a wired
behavior.

Also recorded: `routing.ladder` is resolved and owner-editable, but it is not yet
wired into dispatch membership; the only consumer of its tiers today is the
coverage report. Wiring it in is a separate change.

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
