/**
 * Package-contract regression: @deepseek-ai/dsh-tools must stay a
 * host-provided peer. Shipping it in runtime dependencies creates a
 * second module instance and splits TOOL_RUNTIME_SCHEDULER identity.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
  files?: string[]
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

/**
 * The installed package's README must not link into files the tarball lacks.
 *
 * README sends readers to docs/*.md and CHANGELOG.md, and those link onward.
 * Before 0.2.0 `files` shipped neither, so every such link was dead in
 * `node_modules/dsh-goal-autopilot/README.md` while working on GitHub.
 * npm always ships package.json, README and LICENSE; everything else must be
 * covered by a `files` entry (a file name or a directory prefix).
 */
describe('package contract: README navigation ships with the package', () => {
  const root = dirname(pkgPath)
  const ALWAYS = new Set(['package.json', 'README.md', 'LICENSE'])
  const shipped = (path: string): boolean =>
    ALWAYS.has(path) || (pkg.files ?? []).some(entry => path === entry || path.startsWith(`${entry}/`))

  /** Local relative link targets of one markdown file, repo-relative, anchors stripped. */
  function localLinks(file: string): string[] {
    const text = readFileSync(join(root, file), 'utf8')
    return [...text.matchAll(/\]\(([^)\s]+)\)/g)]
      .map(match => match[1]!.split('#')[0]!)
      .filter(target => target.length > 0 && !/^[a-z][a-z0-9+.-]*:/i.test(target))
      .map(target => relative(root, normalize(join(root, dirname(file), target))).replace(/\\/g, '/'))
  }

  it('every local link reachable from README exists and is in the tarball', () => {
    const seen = new Set<string>()
    const queue = ['README.md']
    while (queue.length > 0) {
      const file = queue.shift()!
      if (seen.has(file)) continue
      seen.add(file)
      for (const target of localLinks(file)) {
        expect(existsSync(join(root, target)), `${file} -> ${target} exists`).toBe(true)
        expect(shipped(target), `${file} -> ${target} is covered by package.json files`).toBe(true)
        if (target.endsWith('.md')) queue.push(target)
      }
    }
    // Detector: the walk really reached the drilled-down docs.
    expect([...seen]).toEqual(expect.arrayContaining([
      'docs/compatibility.md', 'docs/security.md', 'docs/reference.md', 'CHANGELOG.md',
    ]))
  })
})
