/**
 * Write-path declarations and their intersection. Pure.
 *
 * A path is either an exact file (`src/a.ts`) or a prefix (`src/**`, meaning
 * everything below `src`). Any other glob is read conservatively as the
 * directory prefix before its first wildcard, so it can only over-report an
 * intersection, never miss one. The check is a conflict guard between
 * concurrent writers under one root, not a permission system.
 */

import type { DelegationRecord } from '../domain/ledger-types.js'

interface Normalized {
  readonly kind: 'exact' | 'prefix'
  /** Without a trailing slash; `''` is the whole tree. */
  readonly path: string
}

function normalize(raw: string): Normalized {
  let path = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/')
  const wild = path.search(/[*?[{]/)
  if (wild === -1) return { kind: 'exact', path: path.replace(/\/$/, '') }
  path = path.slice(0, wild)
  const cut = path.lastIndexOf('/')
  return { kind: 'prefix', path: cut === -1 ? '' : path.slice(0, cut) }
}

const inside = (child: string, prefix: string): boolean => prefix === '' || child === prefix || child.startsWith(`${prefix}/`)

/** Whether two declared paths can touch the same file. */
export function pathsIntersect(a: string, b: string): boolean {
  const x = normalize(a)
  const y = normalize(b)
  if (x.kind === 'exact' && y.kind === 'exact') return x.path === y.path
  if (x.kind === 'exact') return inside(x.path, y.path)
  if (y.kind === 'exact') return inside(y.path, x.path)
  return inside(x.path, y.path) || inside(y.path, x.path)
}

export interface WriteConflict {
  readonly childId: string
  readonly path: string
  readonly with: string
}

const ACTIVE = new Set<string>(['starting', 'running'])

/**
 * The first conflict between `paths` and the active writers of `delegations`,
 * skipping the new delegation's own ancestors: a lead's paths may contain its
 * workers', and a worker is checked against its siblings, not its lead.
 *
 * @param ancestors child ids of the dispatching chain (the lead, when a lead dispatches).
 */
export function findWriteConflict(
  paths: readonly string[],
  delegations: readonly DelegationRecord[],
  ancestors: ReadonlySet<string>,
): WriteConflict | undefined {
  for (const other of delegations) {
    if (!ACTIVE.has(other.state) || ancestors.has(other.childId)) continue
    for (const mine of paths) {
      for (const theirs of other.writePaths ?? []) {
        if (pathsIntersect(mine, theirs)) return { childId: other.childId, path: mine, with: theirs }
      }
    }
  }
  return undefined
}
