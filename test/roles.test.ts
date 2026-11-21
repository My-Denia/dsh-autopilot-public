import { describe, expect, it } from 'vitest'
import { ROLE_NAMES, ROLES, REVIEW_VERDICT_SCHEMA, parseReviewVerdict } from '../src/roles/index.js'
import {
  REQUIRED_READ_TOOLS,
  READ_ONLY_TOOLS,
  WEB_TOOLS,
  allowListDiagnostic,
  allowListFor,
  parseRestrictRejection,
  resolveToolAllow,
} from '../src/roles/tools.js'
import { AP_TOOL_SURFACE_INCOMPLETE } from '../src/domain/refusals.js'
import { AutopilotError } from '../src/domain/types.js'
import { REGISTERED_TOOLS } from './helpers.js'

describe('role specs', () => {
  it('has exactly the five outbound roles, in a stable order', () => {
    expect(ROLE_NAMES).toEqual(['scout', 'worker', 'executor-lead', 'planner', 'reviewer'])
    expect(Object.keys(ROLES).sort()).toEqual([...ROLE_NAMES].sort())
  })

  it('marks only worker and executor-lead as writers', () => {
    for (const name of ROLE_NAMES) {
      expect(ROLES[name].write, name).toBe(name === 'worker' || name === 'executor-lead')
    }
  })

  it('requires writePaths only for worker', () => {
    expect(ROLES.worker.requiresWritePaths).toBe(true)
    for (const name of ['scout', 'planner', 'reviewer', 'executor-lead'] as const) {
      expect(ROLES[name].requiresWritePaths, name).toBe(false)
    }
  })

  it('lets only an executor-lead dispatch, and only scout and worker', () => {
    expect(ROLES['executor-lead'].canDispatch).toEqual(['scout', 'worker'])
    expect(ROLES['executor-lead'].delegationTools).toEqual(['autopilot_delegate', 'autopilot_agents'])
    for (const name of ['scout', 'worker', 'planner', 'reviewer'] as const) {
      expect(ROLES[name].canDispatch, name).toEqual([])
      expect(ROLES[name].delegationTools, name).toEqual([])
    }
  })

  it('gives the executor-lead depth 2 and every leaf depth 1', () => {
    expect(ROLES['executor-lead'].maxDepth).toBe(2)
    for (const name of ['scout', 'worker', 'planner', 'reviewer'] as const) {
      expect(ROLES[name].maxDepth, name).toBe(1)
    }
  })

  it('keeps the reviewer one-shot and delivered to the caller', () => {
    expect(ROLES.reviewer.oneShot).toBe(true)
    expect(ROLES.reviewer.delivery).toBe('caller')
    expect(ROLES.worker.delivery).toBe('parent')
  })

  it('gives read-only roles no write surface and the writer roles the full one', () => {
    expect(ROLES.scout.requestedTools).toEqual([...READ_ONLY_TOOLS, ...WEB_TOOLS])
    expect(ROLES.planner.requestedTools).toEqual(READ_ONLY_TOOLS)
    expect(ROLES.reviewer.requestedTools).toEqual(READ_ONLY_TOOLS)
    expect(ROLES.worker.requestedTools).toBe('inherit')
    expect(ROLES['executor-lead'].requestedTools).toBe('inherit')
  })
})

describe('tool allow-lists', () => {
  it('narrows a read-only role to what the deployment registers', () => {
    const allow = allowListFor(ROLES.scout, REGISTERED_TOOLS)
    expect(allow).toEqual([...READ_ONLY_TOOLS, ...WEB_TOOLS])
    for (const name of allow as readonly string[]) expect(REGISTERED_TOOLS).toContain(name)
  })

  it('inherits the whole surface for a writer', () => {
    expect(allowListFor(ROLES.worker, REGISTERED_TOOLS)).toBe('inherit')
    expect(allowListFor(ROLES['executor-lead'], REGISTERED_TOOLS)).toBe('inherit')
  })

  it('drops a non-required name but records the narrowing', () => {
    const allow = allowListFor(ROLES.scout, ['read', 'glob'])
    expect(allow).toEqual(['read', 'glob'])
    const diagnostic = allowListDiagnostic(ROLES.scout, ['read', 'glob'])
    expect(diagnostic).toContain('narrowed')
    expect(diagnostic).toContain('grep')
    expect(allowListDiagnostic(ROLES.scout, REGISTERED_TOOLS)).toBeUndefined()
  })

  it('passes the request through when the registry cannot be read', () => {
    expect(allowListFor(ROLES.reviewer, undefined)).toEqual(READ_ONLY_TOOLS)
    expect(allowListDiagnostic(ROLES.reviewer, undefined)).toBeUndefined()
  })

  it('refuses a read-only role that cannot read', () => {
    expect(REQUIRED_READ_TOOLS).toEqual(['read'])
    let thrown: unknown
    try {
      allowListFor(ROLES.reviewer, ['glob', 'grep'])
    } catch (error: unknown) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AutopilotError)
    expect((thrown as AutopilotError).code).toBe(AP_TOOL_SURFACE_INCOMPLETE)
    expect((thrown as Error).message).toContain('would still return a schema-valid answer having seen nothing')
  })

  it('resolves a required name straight through', () => {
    const resolved = resolveToolAllow(['read', 'missing'], ['read'], ['read'], 'the test agent')
    expect(resolved.allow).toEqual(['read'])
    expect(resolved.dropped).toEqual(['missing'])
    expect(resolved.diagnostic).toContain('"missing"')
  })
})

describe('restrict rejection parsing', () => {
  it('recovers the unknown names and the deployment registry', () => {
    const parsed = parseRestrictRejection(
      'tools.restrict() names unknown global tools "a", "b"; known global tools: read, grep, bash',
    )
    expect(parsed).toEqual({ unknown: ['a', 'b'], known: ['read', 'grep', 'bash'] })
  })

  it('reads an empty registry as none', () => {
    expect(parseRestrictRejection('tools.restrict() names unknown global tool "x"; known global tools: (none)')?.known).toEqual([])
  })

  it('returns undefined for an unrelated message', () => {
    expect(parseRestrictRejection('something else went wrong')).toBeUndefined()
  })
})

describe('reviewer verdict', () => {
  it('accepts the documented shapes', () => {
    expect(parseReviewVerdict({ verdict: 'pass', findings: [] })).toEqual({ verdict: 'pass', findings: [] })
    expect(parseReviewVerdict({
      verdict: 'fail',
      findings: [{ severity: 'blocker', note: 'null deref', file: 'src/a.ts', line: 12 }],
      summary: 'one blocker',
    })).toEqual({
      verdict: 'fail',
      findings: [{ severity: 'blocker', note: 'null deref', file: 'src/a.ts', line: 12 }],
      summary: 'one blocker',
    })
  })

  it('rejects a pass that carries a blocker', () => {
    expect(parseReviewVerdict({ verdict: 'pass', findings: [{ severity: 'blocker', note: 'broken' }] }))
      .toBe('verdict pass is inconsistent with a blocker finding')
  })

  it('rejects malformed verdicts', () => {
    expect(parseReviewVerdict(null)).toContain('must be an object')
    expect(parseReviewVerdict({ findings: [] })).toContain('verdict must be one of pass | fail')
    expect(parseReviewVerdict({ verdict: 'pass', findings: [{ severity: 'major', note: 'x' }] }))
      .toContain('severity must be one of blocker | note')
    expect(parseReviewVerdict({ verdict: 'pass', findings: [{ severity: 'note', note: '  ' }] }))
      .toContain('note must be a non-empty string')
    expect(parseReviewVerdict({ verdict: 'pass', findings: [{ severity: 'note', note: 'x', line: 0 }] }))
      .toContain('line must be a positive integer')
    expect(parseReviewVerdict({ verdict: 'pass', findings: [], summary: '' })).toContain('summary must be a non-empty string')
  })

  it('declares only the host-supported schema subset', () => {
    expect(REVIEW_VERDICT_SCHEMA.required).toEqual(['verdict', 'findings'])
    expect(REVIEW_VERDICT_SCHEMA.additionalProperties).toBe(false)
    expect(REVIEW_VERDICT_SCHEMA.properties.verdict.enum).toEqual(['pass', 'fail'])
    expect(REVIEW_VERDICT_SCHEMA.properties.findings.items.properties.severity.enum).toEqual(['blocker', 'note'])
  })
})
