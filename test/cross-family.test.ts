/**
 * Cross-family review dispatch (roadmap §9.6).
 *
 * The rule inherited from the CC lineage is "the builder family is not the
 * reviewer family", and its reason is specific: a blind spot shared by one
 * provider passes BOTH gates unchallenged, so two green gates from one family
 * are less independent than they look.
 *
 * This is a routing STRATEGY, not a gate — a single-provider deployment is a
 * legitimate deployment. Which makes the recorded outcome the whole product:
 * the two ways cross-family can fail to happen (`same-family`,
 * `unknown-family`) must be distinguishable from the way it succeeds, or the
 * record claims an independence the dispatch never had. That is the
 * pseudo-active defect class this repo has now paid for three times
 * (`enforcement.sandbox`, `enforcement.approval`, and the domain-store
 * degrade), so the tests below spend most of their weight on the failure
 * shapes rather than on the happy path.
 */

import { describe, expect, it } from 'vitest'
import { familyOf, selectCrossFamily } from '../src/engine.js'
import type { CrossFamilyPolicy } from '../src/engine.js'
import { resolveConfig } from '../src/index.js'
import { makeHarness, makeTriage, stubSubagents } from './helpers.js'

const ALPHA = { provider: 'alpha', model: 'a-1' }
const ALPHA_OTHER_MODEL = { provider: 'alpha', model: 'a-2' }
const BETA = { provider: 'beta', model: 'b-1' }

function policy(over: Partial<CrossFamilyPolicy> = {}): CrossFamilyPolicy {
  return { enabled: true, minRisk: 'medium', pool: [], ...over }
}

describe('familyOf: the family is the PROVIDER, not the model', () => {
  it('reads the provider', () => {
    expect(familyOf(ALPHA)).toBe('alpha')
  })

  it('is undefined when the route inherits the deployment default', () => {
    expect(familyOf(undefined)).toBeUndefined()
    expect(familyOf({ model: 'a-1' })).toBeUndefined()
    expect(familyOf({ provider: '   ' })).toBeUndefined()
  })

  it('treats two models behind ONE provider as the SAME family', () => {
    // Not a detail: if this collapsed to the model, a deployment could satisfy
    // "cross-family" with two models that share a provider — and share its
    // blind spots — while the record claimed independent review.
    expect(familyOf(ALPHA)).toBe(familyOf(ALPHA_OTHER_MODEL))
  })
})

describe('selectCrossFamily: when the question does not arise', () => {
  it('is not-required below the risk floor', () => {
    const choice = selectCrossFamily({ risk: 'low', configured: ALPHA, executor: ALPHA, policy: policy() })
    expect(choice.outcome).toBe('not-required')
    expect(choice.agentOptions).toBe(ALPHA)
  })

  it('is not-required when disabled, even at critical risk', () => {
    const choice = selectCrossFamily({
      risk: 'critical', configured: ALPHA, executor: ALPHA, policy: policy({ enabled: false }),
    })
    expect(choice.outcome).toBe('not-required')
  })

  it('the floor is inclusive and ordered, not a special case for one value', () => {
    for (const risk of ['medium', 'high', 'critical'] as const) {
      expect(selectCrossFamily({ risk, configured: BETA, executor: ALPHA, policy: policy() }).outcome)
        .toBe('achieved')
    }
    expect(selectCrossFamily({ risk: 'low', configured: BETA, executor: ALPHA, policy: policy() }).outcome)
      .toBe('not-required')
    // And the floor itself moves: at minRisk 'high', medium stops qualifying.
    expect(selectCrossFamily({
      risk: 'medium', configured: BETA, executor: ALPHA, policy: policy({ minRisk: 'high' }),
    }).outcome).toBe('not-required')
  })
})

describe('selectCrossFamily: the two ways it can fail to happen', () => {
  it('same-family when the pool offers no alternative, and says what that costs', () => {
    const choice = selectCrossFamily({ risk: 'high', configured: ALPHA, executor: ALPHA, policy: policy() })
    expect(choice.outcome).toBe('same-family')
    expect(choice.agentOptions).toBe(ALPHA)
    expect(choice.diagnostic).toMatch(/passes both gates unchallenged/)
  })

  it('same-family is not defeated by a pool entry from the SAME provider', () => {
    const choice = selectCrossFamily({
      risk: 'high', configured: ALPHA, executor: ALPHA, policy: policy({ pool: [ALPHA_OTHER_MODEL] }),
    })
    expect(choice.outcome).toBe('same-family')
  })

  it('unknown-family when the EXECUTOR route is not observable', () => {
    // The trap this outcome exists for: with no executor agentOptions the
    // builder family is whatever the deployment defaults to, so an auditor
    // route that merely LOOKS different cannot be claimed to be different.
    const choice = selectCrossFamily({ risk: 'high', configured: BETA, executor: undefined, policy: policy() })
    expect(choice.outcome).toBe('unknown-family')
    expect(choice.diagnostic).toMatch(/inherits the deployment default/)
  })

  it('unknown-family when the AUDITOR route is not observable and the pool cannot help', () => {
    const choice = selectCrossFamily({ risk: 'high', configured: undefined, executor: ALPHA, policy: policy() })
    expect(choice.outcome).toBe('unknown-family')
    expect(choice.diagnostic).toMatch(/no configured auditor route/)
  })
})

describe('selectCrossFamily: when it does happen', () => {
  it('achieved when the configured auditor is already out of family', () => {
    const choice = selectCrossFamily({ risk: 'medium', configured: BETA, executor: ALPHA, policy: policy() })
    expect(choice.outcome).toBe('achieved')
    expect(choice.agentOptions).toBe(BETA)
  })

  it('achieved by drawing from the pool, and the drawn route is the one returned', () => {
    const choice = selectCrossFamily({
      risk: 'medium', configured: ALPHA, executor: ALPHA,
      policy: policy({ pool: [ALPHA_OTHER_MODEL, BETA] }),
    })
    expect(choice.outcome).toBe('achieved')
    // Not merely "it said achieved": the DISPATCH must actually change, and it
    // must skip the same-family pool entry rather than take the first one.
    expect(choice.agentOptions).toBe(BETA)
  })

  it('an unroutable pool entry cannot satisfy the rule', () => {
    const choice = selectCrossFamily({
      risk: 'medium', configured: ALPHA, executor: ALPHA, policy: policy({ pool: [{ model: 'nameless' }] }),
    })
    expect(choice.outcome).toBe('same-family')
  })
})

describe('the audit dispatch records the outcome on its route', () => {
  const STANDARD = { size: 'standard', risk: 'medium', executionMode: 'inline', auditMode: 'independent' } as const
  const SEED = { id: 'm1', usageClass: 'internal', boundaryStates: [], artifacts: [], attempted: [] } as const

  async function auditWith(config: Parameters<typeof resolveConfig>[0]) {
    const subagents = stubSubagents({ verdicts: [{ verdict: 'pass', note: 'ok' }] })
    const h = makeHarness({ subagents, config })
    await h.engine.init(h.root, makeTriage(STANDARD), [SEED])
    await h.engine.submitPlan(h.root, 'plan')
    const outcome = await h.engine.audit(h.root, { role: 'plan', prompt: 'packet' })
    return { outcome, snapshot: h.engine.peek(h.root.id) }
  }

  it('stamps achieved when the auditor is drawn out of family', async () => {
    const { outcome, snapshot } = await auditWith({
      executor: { agentOptions: ALPHA },
      crossFamily: { enabled: true, minRisk: 'medium', pool: [BETA] },
    })
    expect(outcome.route.crossFamily).toBe('achieved')
    expect(snapshot?.audits[0]?.route.crossFamily).toBe('achieved')
  })

  it('stamps same-family, and the diagnostic survives onto the durable record', async () => {
    const { snapshot } = await auditWith({
      executor: { agentOptions: ALPHA },
      auditors: { plan: { agentOptions: ALPHA } },
      crossFamily: { enabled: true, minRisk: 'medium', pool: [] },
    })
    expect(snapshot?.audits[0]?.route.crossFamily).toBe('same-family')
    expect(snapshot?.audits[0]?.route.routeDiagnostic).toMatch(/cross-family: /)
  })

  it('stamps unknown-family on a deployment that configured no routes at all', async () => {
    // The default shape of a fresh install. It must not read as `achieved`.
    const { snapshot } = await auditWith({})
    expect(snapshot?.audits[0]?.route.crossFamily).toBe('unknown-family')
  })
})
