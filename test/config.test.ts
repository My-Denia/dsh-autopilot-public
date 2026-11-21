import { describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/config.js'

interface StandardResult {
  readonly value?: { readonly skillInstall?: string; readonly [key: string]: unknown }
  readonly issues?: readonly unknown[]
}

interface StandardSchema {
  readonly '~standard': {
    validate(input: unknown): StandardResult | Promise<StandardResult>
  }
}

async function validate(input: unknown): Promise<StandardResult> {
  const schema = Config as unknown as StandardSchema
  return await schema['~standard'].validate(input)
}

describe('resolveConfig', () => {
  it('defaults to publishing the skill', () => {
    expect(resolveConfig()).toEqual({ skillInstall: 'auto' })
    expect(resolveConfig({})).toEqual({ skillInstall: 'auto' })
  })

  it('accepts off', () => {
    expect(resolveConfig({ skillInstall: 'off' })).toEqual({ skillInstall: 'off' })
  })

  it('treats an unknown mode as the default', () => {
    expect(resolveConfig({ skillInstall: 'sometimes' as never })).toEqual({ skillInstall: 'auto' })
  })
})

describe('Config schema', () => {
  it('declares one key with an auto default', async () => {
    const result = await validate({})
    expect(result.issues).toBeUndefined()
    expect(result.value?.skillInstall).toBe('auto')
  })

  it('accepts the off mode', async () => {
    const result = await validate({ skillInstall: 'off' })
    expect(result.value?.skillInstall).toBe('off')
  })

  it('rejects an unknown mode value', async () => {
    const result = await validate({ skillInstall: 'sometimes' })
    expect(result.issues?.length ?? 0).toBeGreaterThan(0)
  })

  it('ignores unknown keys rather than refusing the mount (documented clean break)', async () => {
    const result = await validate({ skillInstall: 'off', storeRoot: '/tmp/x', routing: { mode: 'auto' } })
    expect(result.issues).toBeUndefined()
    expect(result.value?.skillInstall).toBe('off')
  })
})
