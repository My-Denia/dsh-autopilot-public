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

function codesIn(text: string): ReadonlySet<string> {
  return new Set([...text.matchAll(/AP_[A-Z0-9_]+/g)].map(match => match[0]))
}

const files = sourceFiles()
const fromSource = new Set<string>()
for (const file of files) for (const code of codesIn(readFileSync(join(root, 'src', file), 'utf8'))) fromSource.add(code)

describe('refusal contract', () => {
  it('has an enforcing source to census', () => {
    // Cardinality floor: if the walker returned nothing, both comparisons below
    // would pass on two empty sets and report a calm green.
    expect(files.length).toBeGreaterThan(20)
    expect(fromSource.size).toBeGreaterThanOrEqual(60)
  })

  it('states every code the engine can raise, and invents none', () => {
    const documented = codesIn(readFileSync(refusalsPath, 'utf8'))
    expect(documented.size).toBeGreaterThanOrEqual(60)
    const missing = [...fromSource].filter(code => !documented.has(code)).sort()
    const orphaned = [...documented].filter(code => !fromSource.has(code)).sort()
    expect({ missing, orphaned }).toEqual({ missing: [], orphaned: [] })
  })
})
