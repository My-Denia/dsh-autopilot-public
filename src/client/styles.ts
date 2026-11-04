/**
 * Inline style objects shared by the card and the ledger view.
 *
 * Inline on purpose: `lib/client.js` is built by `tsc` plus
 * `scripts/wrap-client.mjs`, which does not resolve CSS imports, so styling is
 * CSSProperties over the host's `--dsw-alias-*` variables.
 *
 * @module dsh-autopilot/client/styles
 */

import type { CSSProperties } from 'react'
import type { Tone } from './ledger.js'

export const shell: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2)',
  padding: '10px 12px',
  fontSize: 12,
  lineHeight: 1.6,
  color: 'var(--dsw-alias-label-primary)',
}

export const muted: CSSProperties = { color: 'var(--dsw-alias-label-tertiary)' }

export const badge = (color: string): CSSProperties => ({
  border: `1px solid ${color}`,
  color,
  borderRadius: 4,
  padding: '0 5px',
  fontSize: 11,
})

/** Map a view-model tone onto the host's colour variables. */
export function toneColor(tone: Tone): string {
  switch (tone) {
    case 'success': return 'var(--dsw-alias-state-success-primary)'
    case 'warn': return 'var(--dsw-alias-state-warn-primary)'
    case 'error': return 'var(--dsw-alias-state-error-primary)'
    default: return 'var(--dsw-alias-label-tertiary)'
  }
}
