import { describe, expect, it } from 'vitest'
import { findWriteConflict, pathsIntersect } from '../src/roles/paths.js'
import type { WriteScope } from '../src/roles/paths.js'

const writer = (childId: string, state: string, writePaths: readonly string[]): WriteScope => ({ childId, state, writePaths })

describe('pathsIntersect', () => {
  it('matches identical exact files', () => {
    expect(pathsIntersect('src/a.ts', 'src/a.ts')).toBe(true)
    expect(pathsIntersect('./src/a.ts', 'src\\a.ts')).toBe(true)
    expect(pathsIntersect('src/a.ts', 'src/b.ts')).toBe(false)
  })

  it('matches a file inside a declared prefix', () => {
    expect(pathsIntersect('src/a.ts', 'src/**')).toBe(true)
    expect(pathsIntersect('src/nested/a.ts', 'src/**')).toBe(true)
    expect(pathsIntersect('srcs/a.ts', 'src/**')).toBe(false)
  })

  it('matches two overlapping prefixes', () => {
    expect(pathsIntersect('src/a/**', 'src/**')).toBe(true)
    expect(pathsIntersect('src/a/**', 'lib/**')).toBe(false)
  })

  it('treats any other glob as its directory prefix (over-report, never miss)', () => {
    expect(pathsIntersect('src/*.ts', 'src/a.ts')).toBe(true)
    expect(pathsIntersect('src/[ab].ts', 'src/a.ts')).toBe(true)
    expect(pathsIntersect('**/*.ts', 'src/a.ts')).toBe(true)
  })
})

describe('findWriteConflict', () => {
  it('reports the first live writer with an intersecting path', () => {
    const conflict = findWriteConflict(
      ['src/a.ts'],
      [writer('w1', 'running', ['src/a.ts'])],
      new Set(),
    )
    expect(conflict).toEqual({ childId: 'w1', path: 'src/a.ts', with: 'src/a.ts' })
  })

  it('ignores settled writers and the dispatcher ancestors', () => {
    const records = [
      writer('done', 'idle', ['src/a.ts']),
      writer('cancelled', 'cancelled', ['src/a.ts']),
      writer('lead', 'running', ['src/**']),
    ]
    // The idle and cancelled writers cannot collide; the live lead can.
    expect(findWriteConflict(['src/a.ts'], records, new Set())).toEqual({ childId: 'lead', path: 'src/a.ts', with: 'src/**' })
    // The dispatching chain is exempt: a lead's scope may contain its workers'.
    expect(findWriteConflict(['src/a.ts'], records, new Set(['lead']))).toBeUndefined()
  })

  it('reports a starting writer as live', () => {
    expect(findWriteConflict(['src/**'], [writer('w2', 'starting', ['src/a.ts'])], new Set())).toBeDefined()
  })

  it('has no conflict without declared paths', () => {
    expect(findWriteConflict([], [writer('w1', 'running', ['src/a.ts'])], new Set())).toBeUndefined()
    expect(findWriteConflict(['src/a.ts'], [writer('w1', 'running', [])], new Set())).toBeUndefined()
  })
})
