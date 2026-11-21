import { describe, expect, it } from 'vitest'
import {
  AP_DISPATCH_FAILED,
  AP_INVALID_ARGUMENT,
  AP_NO_AGENT,
  AP_ROLE_NOT_DISPATCHABLE,
  AP_ROLE_VERDICT_INVALID,
  AP_TOOL_SURFACE_INCOMPLETE,
  AP_UNKNOWN_CHILD,
  AP_WRITE_PATHS_CONFLICT,
  AP_WRITE_PATHS_REQUIRED,
  REFUSALS,
} from '../src/domain/refusals.js'
import { AutopilotError, errorMessage } from '../src/domain/types.js'

const EXPECTED = [
  'AP_NO_AGENT',
  'AP_INVALID_ARGUMENT',
  'AP_ROLE_NOT_DISPATCHABLE',
  'AP_WRITE_PATHS_REQUIRED',
  'AP_WRITE_PATHS_CONFLICT',
  'AP_UNKNOWN_CHILD',
  'AP_TOOL_SURFACE_INCOMPLETE',
  'AP_DISPATCH_FAILED',
  'AP_ROLE_VERDICT_INVALID',
] as const

describe('refusal registry', () => {
  it('holds exactly the codes the plugin can raise', () => {
    expect(Object.keys(REFUSALS).sort()).toEqual([...EXPECTED].sort())
  })

  it('keeps every exported constant in step with the registry', () => {
    expect([
      AP_NO_AGENT,
      AP_INVALID_ARGUMENT,
      AP_ROLE_NOT_DISPATCHABLE,
      AP_WRITE_PATHS_REQUIRED,
      AP_WRITE_PATHS_CONFLICT,
      AP_UNKNOWN_CHILD,
      AP_TOOL_SURFACE_INCOMPLETE,
      AP_DISPATCH_FAILED,
      AP_ROLE_VERDICT_INVALID,
    ]).toEqual([...EXPECTED])
    for (const code of EXPECTED) expect(REFUSALS[code].length).toBeGreaterThan(10)
  })

  it('carries the code in the message the model sees', () => {
    const error = new AutopilotError('task must not be empty', AP_INVALID_ARGUMENT)
    expect(error.code).toBe(AP_INVALID_ARGUMENT)
    expect(error.message).toBe('AP_INVALID_ARGUMENT: task must not be empty')
    expect(error.name).toBe('AutopilotError')
    expect(errorMessage(error)).toBe(error.message)
  })

  it('renders a non-Error thrown value', () => {
    expect(errorMessage('plain')).toBe('plain')
    expect(errorMessage(42)).toBe('42')
  })
})
