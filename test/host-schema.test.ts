/**
 * Every JSON schema this plugin hands the host as a subagent `outputSchema` must
 * pass the host's OWN validator. dsh 0.2.1-rc.5 runs `assertObjectJsonSchema`
 * (dsh-tools) inside `startActivation` and rejects any keyword outside its
 * enforced subset, so a schema that only looks right fails every dispatch on the
 * real host. The validator here is the real one from the pinned devDependency
 * `@deepseek-ai/dsh-tools`, not a stub.
 */

import { describe, expect, it } from 'vitest'
import { assertObjectJsonSchema, assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { REVIEW_VERDICT_SCHEMA, parseReviewVerdict } from '../src/roles/index.js'

/** Every outputSchema the plugin sends (delegate.ts passes only the reviewer's). */
// The plugin sends these as plain `object`; its `as const` literal is readonly, the host's type is not.
const HOST_REVIEW_SCHEMA = REVIEW_VERDICT_SCHEMA as unknown as Parameters<typeof validateJsonSchemaValue>[0]

const OUTPUT_SCHEMAS: ReadonlyArray<readonly [string, object]> = [['REVIEW_VERDICT_SCHEMA', REVIEW_VERDICT_SCHEMA]]

describe('outputSchemas are inside the host JSON schema subset', () => {
  it.each(OUTPUT_SCHEMAS)('%s is accepted by the host validator', (_name, schema) => {
    expect(() => assertSupportedJsonSchema(schema)).not.toThrow()
    expect(() => assertObjectJsonSchema(schema)).not.toThrow()
  })

  it('the host validator does reject a keyword outside the subset (the rc.5 failure)', () => {
    expect(() => assertObjectJsonSchema({ type: 'object', properties: { s: { type: 'string', minLength: 1 } } })).toThrow(/minLength is not a supported keyword/)
  })

  it('a well-formed verdict passes the host value check and the plugin parse', () => {
    const verdict = { verdict: 'needs-fix', subject: 'PR 12', findings: [{ severity: 'major', summary: 'leaks a key', where: 'a.ts:4' }] }
    expect(validateJsonSchemaValue(HOST_REVIEW_SCHEMA, verdict)).toEqual([])
    expect(typeof parseReviewVerdict(verdict)).toBe('object')
  })

  it('an empty subject or summary, which the host schema can no longer refuse, is refused by the plugin parse', () => {
    const empty = { verdict: 'needs-fix', subject: '', findings: [{ severity: 'major', summary: ' ' }] }
    expect(validateJsonSchemaValue(HOST_REVIEW_SCHEMA, empty)).toEqual([])
    expect(parseReviewVerdict(empty)).toMatch(/subject/)
    expect(parseReviewVerdict({ ...empty, subject: 's' })).toMatch(/findings\[0\]\.summary/)
  })
})
