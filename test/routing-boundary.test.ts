/**
 * Mirror-vs-host bearer for the routing catalog port (AC1).
 *
 * WHY THIS FILE EXISTS (the `test/host-types.test.ts` pattern). The routing
 * core talks to `ctx.llm` through a STRUCTURAL mirror (`LlmRuntimeSubset` in
 * `src/routing/catalog.ts`) rather than imported types, so a host member the
 * upstream removes does not fail `tsc` on `src/` — the plugin keeps compiling
 * against its own interface and reads `undefined` at runtime. The assignment
 * below makes the REAL `LlmRuntime` prove it satisfies the mirror at compile
 * time (`pnpm check` / tsconfig.test.json runs this file): if `listProviders`,
 * `listModels`, `resolveModelInfo`, or `resolveCallConfig` disappeared or
 * changed shape, this line goes red instead of the first real dispatch
 * failing silently.
 *
 * `LlmRuntime.prototype` is used because the runtime is a cordis service
 * constructed with a live `Context`; the prototype carries the instance type
 * without a host, and its methods' PRESENCE is asserted at runtime.
 */

import { describe, expect, it } from 'vitest'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { LlmRuntimeSubset } from '../src/routing/catalog.js'

describe('the REAL LlmRuntime satisfies the catalog mirror (dsh-llm 0.2.0-rc.2)', () => {
  it('compile-time bearer: LlmRuntime.prototype is assignable to LlmRuntimeSubset', () => {
    // The assignment IS the assertion. Method syntax on the mirror keeps the
    // parameter comparison bivariant, so the host's branded effort ids stay
    // assignable to the mirror's plain strings — a real signature change
    // beyond that still fails here.
    const mirror: LlmRuntimeSubset = LlmRuntime.prototype
    expect(typeof mirror.listProviders).toBe('function')
    expect(typeof mirror.listModels).toBe('function')
    expect(typeof mirror.resolveModelInfo).toBe('function')
    expect(typeof mirror.resolveCallConfig).toBe('function')
  })
})
