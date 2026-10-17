/**
 * First-use routing onboarding (DESIGN §9 item 12).
 *
 * When autonomous routing is on and the LIVE model catalog lists models no
 * tier-bound work class can reach, the root agent is told — once, in its
 * system prompt — which models those are and how to fix the ladder. The
 * notice is derived from the SAME work-class reachability report the engine
 * surfaces on the StatusView (coverage.ts): no second metric, no second
 * truth. Full reachability, an unobserved/unreadable catalog, or routing
 * switched off ⇒ the section renders ZERO tokens.
 *
 * The guidance points at the profile config's `routing.ladder.*` leaves,
 * which are VOLATILE: an edit applies to the next routing decision without
 * a restart. On a host exposing a config-edit surface (`ctx.configEditor` /
 * `ctx.settings.edit`) the agent may apply the edit itself after checking
 * current capability facts; on a host without one it reports the exact YAML
 * to the owner and asks them to edit the profile (the degrade path the plan
 * audit required). There is NO plugin-private policy file — the profile
 * config is the only place ladder truth lives.
 */

import type { SessionPolicyState } from './authorize.js'
import type { CatalogSnapshot } from './catalog.js'
import { workClassReachability } from './coverage.js'
import type { CoverageLadder, WorkClassReachabilityReport } from './coverage.js'
import type { ResolvedWorkClass, WorkClassName, WorkClassTier } from './work-class.js'

/** What the section renderer needs to decide; everything else stays out of the prompt path. */
export interface RoutingOnboardingInput {
  /** The live routing mode — `off` renders nothing no matter what the report says. */
  readonly mode: 'off' | 'auto'
  /**
   * The last OBSERVED reachability report, or `undefined` when the catalog
   * was never read (or its read failed). Absence is not reachability: an
   * unobserved catalog renders nothing rather than claiming coverage.
   */
  readonly report: WorkClassReachabilityReport | undefined
  /** Whether this host exposes a config-edit surface the agent may use. */
  readonly configEditorAvailable: boolean
  /**
   * The rendering session's model-selection policy state (the same value the
   * engine's authorization step reads). REQUIRED, because a policy-less
   * session cannot select at all: a notice that lists unreachable models
   * without saying so would read as if the ladder were governing dispatches.
   */
  readonly policyState: SessionPolicyState['kind']
}

/** How many unreachable models are named inline before the "+N more" tail. */
const NAME_LIMIT = 5

/**
 * Render the onboarding notice, or `''` (zero tokens) when there is nothing
 * honest to say. ONLY `outcome === 'unreachable-models'` triggers a notice:
 * `unobservable` / `incomplete` are absences of observation (never a finding
 * about the ladder), `unconfigured` on the shipped default is the normal
 * pre-ladder state rather than a misconfiguration worth prompt tokens, and
 * `reachable` needs no onboarding.
 */
export function renderRoutingOnboarding(input: RoutingOnboardingInput): string {
  if (input.mode !== 'auto') return ''
  const report = input.report
  if (report === undefined || report.outcome !== 'unreachable-models') return ''
  const named = report.unreachable.slice(0, NAME_LIMIT)
  const tail = report.unreachable.length - named.length
  const listing = tail > 0 ? `${named.join(', ')} (+${tail} more)` : named.join(', ')
  const editPath = input.configEditorAvailable
    ? 'apply the edit yourself with the host config editor (these leaves are volatile — the next routing decision sees them, no restart)'
    : 'you have no config-edit surface on this host: report the YAML block at the end of this notice to the owner (fill the tier in as the facts warrant) and ask them to edit the profile config (these leaves are volatile — the next routing decision sees the edit, no restart)'
  return [
    '## Routing onboarding — catalog models your ladder cannot reach',
    '',
    `The live model catalog lists ${report.unreachable.length} model(s) that NO tier-bound work class can reach: ${listing}.`,
    'Autonomous routing (routing.mode: auto) will never dispatch to them: a tier-bound class admits only members of `routing.ladder.tiers.*`, and these models sit in no tier the configured classes draw from.',
    '',
    'To make them dispatchable:',
    '1. Check CURRENT capability facts for these models — the provider\u2019s official docs/pricing, online — or ask the owner. Do NOT infer capabilities from model names (DESIGN §1.2 forbids name-based inference).',
    `2. Assign them to tiers in the profile config: add their \`provider/model\` ids to \`routing.ladder.tiers.economy\` / \`.standard\` / \`.reserve\` as the facts warrant (optionally order them via \`routing.ladder.speedOrder\` and adjust \`routing.ladder.costOverrides\`). Then ${editPath}.`,
    '',
    'This notice disappears by itself once every observed model is reachable by at least one tier-bound class. If you judge a model should stay unreachable (deprecated, unsafe, too expensive), say so to the owner instead of silently leaving the ladder as-is.',
    ...selectionPrerequisite(input.policyState),
    ...editBlock(input.configEditorAvailable, report.unreachable),
  ].join('\n')
}

/**
 * The YAML the degrade path promises. Rendered only when BOTH hold: the host
 * has NO config-edit surface (the agent-edit path names the leaves instead,
 * because a block it could apply itself would be redundant) AND at least one
 * unreachable id was actually observed (the block's whole value is the observed
 * ids; with none there is nothing to hand over). The `economy:` key is a
 * STARTING SHAPE, not a tier verdict — the comment inside tells the owner to
 * pick among economy/standard/reserve as the capability facts warrant, and
 * `routing.workClasses.<class>.tiers` stays owner-editable. The ids are the OBSERVED
 * unreachable ones (never invented) and the tier is deliberately left blank:
 * which tier they belong in is a capability FACT the agent must check first,
 * so the block hands the owner the exact shape with the values it actually
 * knows.
 */
function editBlock(configEditorAvailable: boolean, unreachable: readonly string[]): string[] {
  if (configEditorAvailable || unreachable.length === 0) return []
  return [
    '',
    'YAML for the owner (profile `cordis.patch.yml`; repeat `storeKind: file` beside `routing` — a patch entry replaces, never merges, the packaged config):',
    '',
    '```yaml',
    '- id: autopilot',
    '  name: dsh-goal-autopilot',
    '  config:',
    '    storeKind: file',
    '    routing:',
    '      ladder:',
    '        tiers:',
    '          # pick ONE of economy / standard / reserve per model, as the facts warrant',
    '          economy:',
    ...unreachable.map(id => `            - ${id}`),
    '```',
  ]
}

/**
 * MEASURED ON A REAL 0.2.0 HOST (2026-10-10): a session with no recorded
 * subagent model-selection policy authorizes NOTHING, so auto mode performs
 * inheritance only and the ladder never picks a route — the engine's own
 * `why` says `authorization: no session model-selection policy recorded (the
 * native default) — auto mode performs inheritance only`. The host's switch
 * is its own subagent model selection, and it applies to NEW sessions, so a
 * ladder can be fully configured, coverage can complain, and dispatch can
 * still be pure inheritance. Saying so here is the difference between a
 * first-use notice and a notice that implies routing is live when it is not.
 */
function selectionPrerequisite(policyState: SessionPolicyState['kind']): string[] {
  if (policyState === 'present') return []
  const cause = policyState === 'absent'
    ? 'Blocker to know before editing the ladder: this session has NO recorded subagent model-selection policy, and in auto mode that means INHERITANCE ONLY — the engine dispatches the deployment default and the ladder selects nothing at all. The switch is the host\u2019s own subagent model selection ("Allow agents to choose models for Subagents"), which applies to NEW sessions: ask the owner to enable it and start a fresh session when the ladder should govern dispatch rather than the deployment default.'
    : 'Blocker to know before editing the ladder: this profile\u2019s session model-selection policy projection is UNREACHABLE (the engine records it as `unreachable-inherit`), so auto mode performs INHERITANCE ONLY and the ladder selects nothing at all. Nothing this session can do turns selection on — say so to the owner instead of reading the ladder above as live.'
  return [
    '',
    `${cause} Tier edits stay worth making either way: they decide this notice and the candidate set the moment a policy exists.`,
  ]
}

/**
 * Read the catalog ONCE and compute the onboarding report. Never throws:
 * any read failure yields `undefined` (unobserved ⇒ the section renders
 * nothing), because a failed read is not evidence of reachability.
 */
export async function observeOnboardingReachability(
  catalog: { snapshot(): Promise<CatalogSnapshot> },
  ladder: CoverageLadder & { auditTier?: WorkClassTier | 'none' },
  workClasses: Readonly<Record<WorkClassName, ResolvedWorkClass>>,
): Promise<WorkClassReachabilityReport | undefined> {
  let snapshot: CatalogSnapshot
  try {
    snapshot = await catalog.snapshot()
  } catch {
    return undefined
  }
  return workClassReachability(
    {
      catalogStatus: snapshot.catalogStatus,
      models: snapshot.listedModels,
      failedProviders: [...snapshot.providerErrors.keys()],
    },
    { tiers: ladder.tiers },
    workClasses,
    ladder.auditTier,
  )
}