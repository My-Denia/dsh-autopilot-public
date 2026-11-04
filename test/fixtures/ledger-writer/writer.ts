/**
 * One "process" of the two-process ledger stress test (`test/ledger-store.test.ts`).
 * Appends `count` links tagged `tag` to one session's ledger through the CAS
 * write, retrying a conflict the way the engine does (re-read, re-apply).
 *
 * argv: <storeRoot> <sessionId> <tag> <count>
 */

import { AutopilotError } from '../../../src/domain/types.js'
import { AP_LEDGER_CONFLICT, FileLedgerStore, emptyLedger } from '../../../src/store/ledger.js'

const [root, sessionId, tag, countText] = process.argv.slice(2).filter(arg => arg !== '--')
const count = Number(countText)
const store = FileLedgerStore.open(root!, { lockWaitMs: 10_000 })
let conflicts = 0
for (let i = 0; i < count; i += 1) {
  for (;;) {
    const base = store.load(sessionId!) ?? emptyLedger(sessionId!, new Date().toISOString())
    const next = { ...base, links: [...base.links, { kind: 'issue' as const, ref: `${tag}-${i}`, at: new Date().toISOString() }] }
    try {
      await store.write(next, base.revision)
      break
    } catch (error: unknown) {
      if (!(error instanceof AutopilotError) || error.code !== AP_LEDGER_CONFLICT) throw error
      conflicts += 1
    }
  }
}
process.stdout.write(JSON.stringify({ tag, conflicts }))
