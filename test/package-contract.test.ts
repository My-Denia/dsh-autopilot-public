/**
 * Package-contract regression: @deepseek-ai/dsh-tools must stay a
 * host-provided peer. Shipping it in runtime dependencies creates a
 * second module instance and splits TOOL_RUNTIME_SCHEDULER identity.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const TOOLS = '@deepseek-ai/dsh-tools'
// The 0.2.0 line only (`<0.2.1-0` keeps 0.2.1 prereleases OUT under dsh's
// includePrerelease compatibility check). dsh 0.1.7+ refuses to install a
// plugin whose dsh peers do not satisfy the running version, so this string is
// also the plugin's install gate (app-boot `plugin-compatibility.ts`).
const PEER = '0.1.2-rc.1 || >=0.1.5-rc.1 <0.1.6 || >=0.2.0-rc.1 <0.2.1-0'
const DEV_PIN = '0.2.0-rc.2'

describe('package contract: dsh-tools is host-provided', () => {
  it('does not list @deepseek-ai/dsh-tools in runtime dependencies', () => {
    expect(pkg.dependencies?.[TOOLS]).toBeUndefined()
    expect(Object.hasOwn(pkg.dependencies ?? {}, TOOLS)).toBe(false)
  })

  it('declares the bounded peer range that was live-tested', () => {
    expect(pkg.peerDependencies?.[TOOLS]).toBe(PEER)
    expect(pkg.peerDependencies?.[TOOLS]?.startsWith('>=')).toBe(false)
  })

  it('pins the test/build copy in devDependencies', () => {
    expect(pkg.devDependencies?.[TOOLS]).toBe(DEV_PIN)
  })
})
