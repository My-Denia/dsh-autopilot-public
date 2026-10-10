/**
 * The reference layer's contract.
 *
 * The adapter routes to its reference layer, so three things have to stay true
 * or the routing is a lie: the file must ship, it must state every invariant it
 * claims, and each invariant must have exactly ONE owner in the routed tree.
 *
 * That last property is the Statement-Artifact Sync Rule applied to this
 * repository rather than to someone else's: a rule restated in two documents is
 * a rule that will disagree with itself, and DESIGN.md §1 already records this
 * package paying that bill once.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BUNDLED_SKILL_REFERENCES, SKILL_REFERENCES_DIR } from '../src/skill-install.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const skillDir = join(root, 'skill', 'dsh-autopilot')
const referenceFile = join(skillDir, SKILL_REFERENCES_DIR, 'governance-invariants.md')

/**
 * The invariants the reference layer owns.
 *
 * Declared HERE rather than discovered by scanning, on purpose: a scan would
 * pass after someone deleted a rule, which is the failure this list exists to
 * catch. Adding a rule to the reference means adding it here in the same change.
 */
const INVARIANT_HEADINGS = [
  'Risk levels',
  'Audit modes',
  'Checker-Resolution Invariant',
  'Moving-Anchor Invariant',
  'Evidence Sufficiency',
  'Audit-Packet Rule',
  'Concurrent-Audit Rule',
  'Statement-Artifact Sync Rule',
  'Stated-Contract Invariant',
  'Sizing and replanning',
  'Delegation',
  'State and evidence',
  'Closeout',
  'Audit Findings Grading',
  'Minimum-Sufficient Admission',
  'Plan Amendment and Delta Re-audit',
  'Partial Delivery and Carryover',
  'Owner-Decision Boundaries',
  'Red flags',
] as const

/** Every .md/.ts file in the repository, minus build output and run archives. */
function repositoryTextFiles(): readonly string[] {
  const skip = new Set(['node_modules', '.git', 'lib', 'build', 'coverage', 'goal-runs', '.scratch', '.test-tmp', 'evidence', '.github'])
  const out: string[] = []
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const next = rel.length === 0 ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) { walk(join(dir, entry.name), next); continue }
      if (/\.(md|ts|tsx)$/.test(entry.name)) out.push(next)
    }
  }
  walk(root, '')
  return out
}

const reference = readFileSync(referenceFile, 'utf8')

describe('governance reference layer', () => {
  it('states every invariant it owns, as its own heading', () => {
    // Cardinality floor first (Checker-Resolution Invariant): an empty list
    // would make the loop below vacuous and the test would report a calm pass.
    expect(INVARIANT_HEADINGS.length).toBeGreaterThanOrEqual(10)
    const missing = INVARIANT_HEADINGS.filter(
      heading => !new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(reference),
    )
    expect(missing).toEqual([])
  })

  it('gives each invariant exactly one owner across the repository', () => {
    const files = repositoryTextFiles()
    // The floor again: a walker that returned nothing would silence the check.
    expect(files.length).toBeGreaterThan(50)
    const owners = new Map<string, string[]>()
    for (const heading of INVARIANT_HEADINGS) {
      owners.set(heading, files.filter(file => new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(readFileSync(join(root, file), 'utf8'))))
    }
    const split = [...owners].filter(([, files]) => files.length !== 1).map(([heading, files]) => `${heading}: ${files.join(', ') || '(no owner)'}`)
    expect(split).toEqual([])
    for (const heading of INVARIANT_HEADINGS) {
      expect(owners.get(heading)).toEqual([`skill/dsh-autopilot/${SKILL_REFERENCES_DIR}/governance-invariants.md`])
    }
  })

  it('ships the reference layer with the skill', () => {
    // The static install list must equal the real directory, or an upgrade
    // publishes a SKILL.md whose links point at files that are not there.
    const onDisk = readdirSync(join(skillDir, SKILL_REFERENCES_DIR)).filter(name => name.endsWith('.md')).sort()
    expect([...BUNDLED_SKILL_REFERENCES].sort()).toEqual(onDisk)
    expect(BUNDLED_SKILL_REFERENCES).toContain('governance-invariants.md')
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files?: readonly string[] }
    expect(pkg.files).toContain('skill')
  })

  it('keeps a defining block owned once, not just a heading', () => {
    // The heading census above only sees '## <name>' lines, so a RENAMED
    // restatement is invisible to it — which is exactly how the usage-class
    // table and the boundary-state menu came to exist in two documents while
    // the prose claimed "no overlap". These anchors are the defining blocks
    // themselves.
    const routed = [
      'skill/dsh-autopilot/SKILL.md',
      ...BUNDLED_SKILL_REFERENCES.map(name => 'skill/dsh-autopilot/' + SKILL_REFERENCES_DIR + '/' + name),
      'docs/reference.md',
    ]
    const anchors = ['| class | what it must carry |', 'Boundary-state menu:']
    for (const anchor of anchors) {
      const owners = routed.filter(file => readFileSync(join(root, file), 'utf8').includes(anchor))
      expect({ anchor, owners }).toEqual({ anchor, owners: ['skill/dsh-autopilot/SKILL.md'] })
    }
  })

  it('routes to the reference layer from the adapter instead of restating the rules', () => {
    const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
    expect(skill).toContain(`${SKILL_REFERENCES_DIR}/governance-invariants.md`)
    expect(skill).toContain(`${SKILL_REFERENCES_DIR}/refusals.md`)
    expect(skill).toContain('docs/reference.md')
    // The risk and audit-mode TABLES are the reference's; the adapter names the
    // fields but must not carry a second copy of the rules that fill them.
    expect(skill).not.toContain('| level | shape |')
    expect(skill).not.toContain('| mode | who reviews | legal when |')
  })
})
