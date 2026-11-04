/**
 * The Stated-Contract Invariant, mechanized.
 *
 * A gate that can refuse must state what it requires before it refuses, in the
 * layer its reader is routed to. The enforcing source (\`src/\`) is NOT that
 * layer, so a code that exists only in the source is an unstated contract:
 * every caller pays a collision to learn it.
 *
 * This census runs BOTH ways. Missing-from-doc catches the new gate that
 * shipped without its contract; orphan-in-doc catches the deleted gate whose
 * prose stayed behind and now describes nothing.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REFUSALS } from '../src/domain/refusals.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const refusalsPath = join(root, 'skill', 'dsh-autopilot', 'references', 'refusals.md')

/** Every .ts file under \`src/\`, the enforcing source. */
function sourceFiles(): readonly string[] {
  const out: string[] = []
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = rel.length === 0 ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) { walk(join(dir, entry.name), next); continue }
      if (entry.name.endsWith('.ts')) out.push(next)
    }
  }
  walk(join(root, 'src'), '')
  return out
}

/**
 * Drop comments before counting: a comment that mentions a code (a note about
 * a refusal that no longer exists) raises nothing.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
}

function codesIn(text: string): ReadonlySet<string> {
  return new Set([...text.matchAll(/AP_[A-Z0-9_]+/g)].map(match => match[0]))
}

/**
 * refusals.md has an in-force part (the tables) and, after the \`## Retired codes\`
 * heading, a list of codes that must no longer exist in the source.
 */
function splitRefusals(text: string): { readonly inForce: ReadonlySet<string>, readonly retired: ReadonlySet<string> } {
  const marker = text.indexOf('\n## Retired codes')
  if (marker < 0) throw new Error('refusals.md has no "## Retired codes" section')
  return { inForce: codesIn(text.slice(0, marker)), retired: codesIn(text.slice(marker)) }
}

const files = sourceFiles()
const fromSource = new Set<string>()
for (const file of files) for (const code of codesIn(withoutComments(readFileSync(join(root, 'src', file), 'utf8')))) fromSource.add(code)

describe('refusal contract', () => {
  it('has an enforcing source to census', () => {
    // Cardinality floor: if the walker returned nothing, both comparisons below
    // would pass on two empty sets and report a calm green.
    expect(files.length).toBeGreaterThan(20)
    expect(fromSource.size).toBeGreaterThanOrEqual(10)
  })

  it('documents exactly the codes of the registry in src/domain/refusals.ts', () => {
    const { inForce } = splitRefusals(readFileSync(refusalsPath, 'utf8'))
    const registry = Object.keys(REFUSALS).sort()
    // The registry is the one list a code can be thrown from, so it must not be empty.
    expect(registry.length).toBeGreaterThanOrEqual(19)
    expect([...inForce].sort()).toEqual(registry)
  })

  it('states every code the source can raise, and invents none', () => {
    const { inForce } = splitRefusals(readFileSync(refusalsPath, 'utf8'))
    expect(inForce.size).toBeGreaterThanOrEqual(10)
    const missing = [...fromSource].filter(code => !inForce.has(code)).sort()
    const orphaned = [...inForce].filter(code => !fromSource.has(code)).sort()
    expect({ missing, orphaned }).toEqual({ missing: [], orphaned: [] })
  })

  it('keeps retired codes out of the source', () => {
    const { inForce, retired } = splitRefusals(readFileSync(refusalsPath, 'utf8'))
    // The list is the record of what 0.3.0 removed; an empty one would make the
    // checks below vacuous.
    expect(retired.size).toBeGreaterThanOrEqual(1)
    const stillRaised = [...retired].filter(code => fromSource.has(code)).sort()
    const listedTwice = [...retired].filter(code => inForce.has(code)).sort()
    expect({ stillRaised, listedTwice }).toEqual({ stillRaised: [], listedTwice: [] })
  })
})
