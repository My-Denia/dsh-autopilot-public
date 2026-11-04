/**
 * The autopilot:policy prompt section.
 *
 * ZERO TOKENS NORMALLY. The 0.2.x section taught a gate doctrine on every
 * session that held a run; 0.3.0 has no gates, so a session whose ledger holds
 * nothing to report renders the empty string. The one exception is the
 * aftermath of a host restart: children that were running did not survive, and
 * the main agent has to be told plainly, because nothing else will tell it.
 */

import type { Ledger } from './domain/ledger-types.js'

/**
 * The notice for the main agent after a host restart, or `''` when the ledger
 * records none.
 *
 * It states what was lost, that auto-continue was released (the goal round
 * driver does not re-arm itself), and what resumes the work: the owner's
 * "continue", after which the main agent starts new children from the issue and
 * PR brief. Nothing here asks the agent to refuse anything.
 */
export function renderRootPolicy(ledger: Ledger | undefined): string {
  const marker = ledger?.hostRestart
  if (ledger === undefined || marker === undefined) return ''
  // Once the goal is armed again (or the composition says otherwise) the restart is history, not news.
  if (ledger.autoContinue.code !== undefined && ledger.autoContinue.code !== 'released-after-restart') return ''
  const lost = ledger.delegations.filter(d => d.state === 'lost')
  const named = lost.length === 0
    ? marker.lostChildIds
    : lost.map(d => `${d.role} ${d.childId} (${d.title})`)
  return [
    'Autopilot notice: the host restarted while delegated children were running.',
    named.length === 0
      ? 'The ledger recorded a restart but no child ids.'
      : `Lost children: ${named.join('; ')}. Their work in progress did not survive; anything they had already written to disk or pushed did.`,
    `Auto-continue was released (${ledger.autoContinue.reason}). The goal does not advance on its own until the owner says "continue".`,
    'When the owner says "continue", resume the goal and start new children from the issue and PR brief instead of waiting for the lost ones.',
  ].join('\n')
}
