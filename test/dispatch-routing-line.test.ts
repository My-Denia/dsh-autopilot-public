/**
 * The dispatch-packet routing line (shared doctrine 2026-10-09, ceiling clause
 * 2026-10-10): every executor dispatch AND resume packet states the child's
 * provider/model and reasoning effort — or names inheritance — because a child
 * that cannot see its own tier cannot judge when escalation is the honest
 * answer. A route with no adjustable effort must say its fixed setting IS the
 * ceiling; the line must never imply a higher effort exists on a route that
 * publishes none.
 */
import { describe, expect, it } from 'vitest'
import { fakeAgent, makeHarness, makeTriage, stubSubagents } from './helpers.js'
import type { Harness } from './helpers.js'

const SIGNAL = new AbortController().signal

/** Drive a delegated medium run through the plan gate and start the executor; return its dispatch prompt. */
async function dispatchPrompt(h: Harness): Promise<string> {
  await h.engine.init(h.root, makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' }))
  await h.engine.submitPlan(h.root, 'plan')
  await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
  const started = await h.engine.startExecutor(h.root, { prompt: 'go', signal: SIGNAL })
  expect(started.executor?.state).toBe('running')
  const prompt = h.subagents.continuablePrompts[0]
  if (prompt === undefined) throw new Error('expected a captured dispatch prompt')
  return prompt
}

describe('the executor dispatch packet states the child route', () => {
  it('an explicit route with a pinned effort: the prompt names provider/model and the effort', async () => {
    const h = makeHarness({
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'plan ok' }] }),
      config: { executor: { agentOptions: { provider: 'beta', model: 'm-c', reasoningEffort: 'high' } } },
    })
    const prompt = await dispatchPrompt(h)
    expect(prompt).toContain('[autopilot] routing: dispatched as beta/m-c (reasoning effort: high)')
    expect(prompt).toContain('Escalation, if needed, is a NEW dispatch')
  })

  it('an explicit route with NO adjustable effort: the prompt says the fixed setting IS the ceiling', async () => {
    const h = makeHarness({
      subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'plan ok' }] }),
      config: { executor: { agentOptions: { provider: 'beta', model: 'm-c' } } },
    })
    const prompt = await dispatchPrompt(h)
    expect(prompt).toContain('[autopilot] routing: dispatched as beta/m-c (reasoning effort: none pinned')
    expect(prompt).toContain('IS the ceiling')
    expect(prompt).not.toContain('(reasoning effort: high')
  })

  it('an inherit dispatch: the prompt names inheritance instead of fabricating a route', async () => {
    const h = makeHarness({ subagents: stubSubagents({ verdicts: [{ verdict: 'pass', note: 'plan ok' }] }) })
    const prompt = await dispatchPrompt(h)
    expect(prompt).toContain('[autopilot] routing: inherited')
    expect(prompt).not.toContain('dispatched as')
  })

  it('the RESUME packet restates the recorded route of the same child', async () => {
    const subagents = stubSubagents({
      verdicts: [
        { verdict: 'pass', note: 'plan ok' },
        { verdict: 'needs-fix', note: 'missing test' },
      ],
    })
    const h = makeHarness({
      subagents,
      config: { executor: { agentOptions: { provider: 'beta', model: 'm-c', reasoningEffort: 'high' } } },
    })
    await h.engine.init(h.root, makeTriage({ size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' }))
    await h.engine.submitPlan(h.root, 'plan')
    await h.engine.audit(h.root, { role: 'plan', prompt: 'p' })
    const started = await h.engine.startExecutor(h.root, { prompt: 'go', signal: SIGNAL })
    const child = fakeAgent(started.executor?.childId as string, h.root.id)
    h.agents.add(child)
    await h.engine.submitExecutionPacket(child, { packet: 'work', residualRisks: [], executionRevision: 1 })
    await h.engine.audit(h.root, { role: 'execution', prompt: 'audit' })
    await h.engine.resumeExecutor(h.root, { findings: 'missing test', nextPrompt: 'add it', signal: SIGNAL })
    const resume = subagents.followups[subagents.followups.length - 1]?.text ?? ''
    expect(resume).toContain('[audit findings]')
    expect(resume).toContain('[autopilot] routing: dispatched as beta/m-c (reasoning effort: high)')
    expect(resume).toContain('executionRevision=2')
  })
})
