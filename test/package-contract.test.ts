import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8')

interface PackageJson {
  readonly name: string
  readonly version: string
  readonly type: string
  readonly main: string
  readonly exports: Record<string, unknown>
  readonly files: readonly string[]
  readonly engines: Record<string, string>
  readonly dsh?: { readonly bundle?: { readonly patch?: string }; readonly client?: unknown }
  readonly scripts: Record<string, string>
  readonly peerDependencies: Record<string, string>
  readonly devDependencies: Record<string, string>
}

const pkg = JSON.parse(read('package.json')) as PackageJson

describe('package contract', () => {
  it('is the 0.4.0 outbound package', () => {
    expect(pkg.name).toBe('dsh-goal-autopilot')
    expect(pkg.version).toBe('0.4.0')
    expect(pkg.type).toBe('module')
    expect(pkg.main).toBe('lib/index.js')
  })

  it('exports only the host entry and package.json', () => {
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './package.json'])
    expect(pkg.exports['./client']).toBeUndefined()
  })

  it('declares no client half and no retired bundle keys', () => {
    expect(pkg.dsh?.client).toBeUndefined()
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(JSON.stringify(pkg.dsh)).not.toContain('client')
  })

  it('supports the pinned dsh host range and node floor', () => {
    expect(pkg.engines.node).toBe('>=22')
    expect(pkg.engines.dsh).toBe('>=0.2.2-rc.5 <0.3.0-0')
    expect(pkg.devDependencies['@deepseek-ai/dsh-tools']).toBe('0.2.2-rc.5')
    expect(pkg.devDependencies['@deepseek-ai/dsh-subagent']).toBe('0.2.2-rc.5')
    expect(pkg.devDependencies['@deepseek-ai/schemastery']).toBe('3.18.5')
    expect(pkg.peerDependencies['@deepseek-ai/dsh-tools']).toBe('>=0.2.2-rc.5 <0.3.0-0')
    expect(pkg.peerDependencies['@deepseek-ai/schemastery']).toBe('^3.18.5')
  })

  it('ships the host, the patch, the skill and the docs', () => {
    for (const entry of ['lib', 'cordis.patch.yml', 'skill', 'docs', 'ARCHITECTURE.md', 'CHANGELOG.md', 'README.md', 'README.zh-CN.md']) {
      expect(pkg.files, entry).toContain(entry)
    }
    for (const retired of ['examples', 'DESIGN.md', 'evidence']) expect(pkg.files).not.toContain(retired)
  })

  it('has the documented scripts', () => {
    expect(pkg.scripts.build).toBe('tsc -p tsconfig.json')
    expect(pkg.scripts.check).toBe('tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json')
    expect(pkg.scripts.test).toBe('vitest run')
    expect(pkg.scripts['build:client']).toBeUndefined()
  })
})

describe('removed modules stay removed', () => {
  const gone = [
    'src/client',
    'src/legacy',
    'src/store',
    'src/routing',
    'src/service.ts',
    'src/web.ts',
    'src/policy.ts',
    'src/engine.ts',
    'src/delegate.ts',
    'scripts',
    'tsconfig.client.json',
    'tsconfig.client.local.json',
  ]

  it('has no retired path on disk', () => {
    for (const relative of gone) expect(existsSync(join(root, relative)), relative).toBe(false)
  })

  it('does not ship the retired connector overlay', () => {
    // The example patch is retired with the clerk role; it must not enter the
    // package even if a stale working tree still holds the file.
    expect(pkg.files).not.toContain('examples')
    expect(existsSync(join(root, 'src', 'client'))).toBe(false)
  })

  it('keeps the source tree to the documented modules', () => {
    const files = readdirSync(join(root, 'src'), { recursive: true })
      .map((entry) => String(entry).split(sep).join('/'))
      .filter((entry) => entry.endsWith('.ts'))
      .sort()
    expect(files).toEqual([
      'config.ts',
      'delegator.ts',
      'domain/refusals.ts',
      'domain/types.ts',
      'host-types.ts',
      'host.ts',
      'index.ts',
      'ledger.ts',
      'roles/index.ts',
      'roles/paths.ts',
      'roles/tools.ts',
      'skill.ts',
      'tools.ts',
    ])
  })
})

describe('bundle patch', () => {
  const patch = read('cordis.patch.yml')

  it('is a loader patch fragment for the bundle row', () => {
    expect(patch).toContain('- insert:')
    expect(patch).toContain('id: autopilot')
    expect(patch).toContain('name: dsh-goal-autopilot')
  })

  it('carries no retired key', () => {
    for (const retired of ['storeRoot', 'storeKind', 'routing', 'client', 'auditors', 'governance']) {
      expect(patch, retired).not.toContain(retired)
    }
  })
})

describe('no owner-specific content', () => {
  const forbidden: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
    { label: 'agent-core', pattern: /agent[-_ ]core/i },
    { label: 'Linear', pattern: /\blinear\b/i },
    { label: 'Notion', pattern: /\bnotion\b/i },
    { label: 'Slack', pattern: /\bslack\b/i },
    { label: 'Figma', pattern: /\bfigma\b/i },
    { label: 'MY-* issue keys', pattern: /\bMY-[A-Z0-9]+\b/ },
    { label: 'C:\\Files', pattern: /C:\\Files/i },
    { label: '/home/peter', pattern: /\/home\/peter/i },
    { label: 'Chronicle', pattern: /chronicle/i },
    { label: 'Current Brief', pattern: /current brief/i },
  ]

  const sources = [
    ...readdirSync(join(root, 'src'), { recursive: true })
      .map((entry) => String(entry).split(sep).join('/'))
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => `src/${entry}`),
    ...readdirSync(join(root, 'skill'), { recursive: true })
      .map((entry) => String(entry).split(sep).join('/'))
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => `skill/${entry}`),
    'cordis.patch.yml',
    'package.json',
  ]

  it('keeps every source file and the skill free of private vocabulary', () => {
    for (const relative of sources) {
      const text = read(relative)
      for (const { label, pattern } of forbidden) {
        expect(pattern.test(text), `${relative} mentions ${label}`).toBe(false)
      }
    }
  })

  it('names no concrete model or provider in code or skill', () => {
    for (const relative of sources) {
      const text = read(relative)
      expect(/deepseek-v[0-9]/i.test(text), `${relative} names a model`).toBe(false)
      expect(/command-code|llm-pi-ai|openai-responses/.test(text), `${relative} names a provider route`).toBe(false)
    }
  })
})
