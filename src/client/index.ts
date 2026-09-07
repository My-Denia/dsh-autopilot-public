/**
 * dsh-autopilot browser half — the autopilot run card.
 *
 * Registers one `ConversationNodeDefinition` (`./definition.ts`, a pure fold
 * over the root session's `autopilot_*` tool traffic) and seats its renderer
 * behind the keyed chat-node slot. Both registrations are additive: every
 * registered definition sees every event, only the FALLBACK definition is
 * suppressed when another claims a target, so the ordinary `tool-call` rows for
 * `autopilot_*` keep rendering and the card is an extra row beside them.
 *
 * THIS FILE IS THE CONTRACT SEAM. It is the only module in the client half that
 * imports the host runtime, and the `satisfies` below is where a drift between
 * `./definition.ts`'s structural mirrors and the real
 * `ConversationNodeDefinition` becomes a compile error rather than a runtime
 * surprise.
 *
 * @module dsh-autopilot/client
 */

// dsh 0.1.2 dismantled `@deepseek-ai/dsh-client-runtime`; its client symbols
// moved by domain. Both of these are TYPE-ONLY imports, so the compiled bundle
// requires nothing but the two react seed words (asserted by
// scripts/run-bundle.mjs A10).
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'

import { AUTOPILOT_RUN_KIND, createAutopilotRunDefinition, isAppendSurfaceEventMirror } from './definition.js'
import type { AutopilotRunState } from './definition.js'
import { AutopilotRunCard } from './AutopilotRunCard.js'

export type {
  AutopilotAuditRow, AutopilotCallRow, AutopilotRunChatData, AutopilotRunState,
  AutopilotTriageView, Observed,
} from './definition.js'
export { AUTOPILOT_RUN_KIND, createAutopilotRunDefinition } from './definition.js'
export { AutopilotRunCard } from './AutopilotRunCard.js'

/**
 * Required client services.
 *
 * These are CORDIS SERVICE NAMES, not package names — a distinction the host
 * graph does not make for you. The package-name list lives in
 * `package.json` `dsh.client.inject`, and per
 * `packages/client/modules/src/client/manifest.ts` that list is INFORMATIONAL:
 * only `dsh.client.external` constrains code arrival. This bundle needs neither
 * a graph edge nor an external, because the only specifiers it requires
 * (`react`, `react/jsx-runtime`) are seed words the web platform preloads
 * (`packages/client/web/src/seed.ts` at dsh 0.1.2-rc.1).
 */
// dsh 0.1.2: the `conversationEvents` service died with dsh-client-runtime;
// the definition registry now hangs off `ctx.uiConversation.events`
// (`@deepseek-ai/dsh-client-ui-conversation`, `UiConversation`), which is the
// idiom the in-tree ui-goal client uses. Measured on the real rc.1 host: the
// old name left this entry `pending (waiting for service: conversationEvents)`.
export const inject = ['slots', 'uiConversation']

/** Cordis plugin name. */
export const name = 'dsh-autopilot-client'

/**
 * The definition, wired to the LOCAL `isAppendSurfaceEventMirror`.
 *
 * Until dsh 0.1.1 this file injected the host's own `isAppendSurfaceEvent`
 * from `@deepseek-ai/dsh-client-runtime/client`. dsh 0.1.2 removed that
 * package; the predicate now lives in `@deepseek-ai/dsh-session`, which has no
 * browser entry and is not a module the web loader serves (measured against
 * the 0.1.2-rc.1 tree: ui-conversation's client bundle requires only
 * client-store, ui-slots, cordis, react, jsx-runtime, ui-primitives and
 * react-dom). So the mirror is the ONLY implementation. The cost is stated in
 * ./definition.ts beside it: a third `SurfaceOp` variant upstream would have
 * to be mirrored by hand, and the `surfaceOp === 'append'` read is the whole
 * dependency.
 */
const definition = createAutopilotRunDefinition({
  isAppendSurfaceEvent: isAppendSurfaceEventMirror,
}) satisfies ConversationNodeDefinition<AutopilotRunState>

/**
 * Structural subset of the client context this plugin touches.
 *
 * `ClientContext` is cordis's `Context` after declaration merging, and the two
 * services below are merged onto it by packages this bundle deliberately does
 * not import. Narrowing through a local interface is the same idiom the host
 * half uses for `PluginContext` (`src/index.ts`) and keeps the client
 * typecheck free of a second sibling-checkout `paths` entry.
 */
interface CardHost {
  uiConversation: { events: { register(definition: ConversationNodeDefinition<AutopilotRunState>): () => void } }
  slots: {
    inject(key: string, callback: () => (() => void)): () => void
    register(spec: { name: string; key: string }, component: unknown): () => void
  }
}

/**
 * Client plugin body.
 *
 * Both registrations run through the caller's fiber, so plugin unload removes
 * the definition and vacates the seat. `ChatNodeSeat` dispatches on `node.kind`
 * with a `JsonBlock` fallback, so a build that registered the definition but
 * not the renderer degrades to a JSON card rather than crashing the view.
 *
 * @param ctx - the client cordis context.
 */
export function apply(ctx: ClientContext): void {
  const host = ctx as unknown as CardHost
  host.uiConversation.events.register(definition)
  host.slots.inject('conversation.chat.node', () => host.slots.register(
    { name: 'conversation.chat.node', key: AUTOPILOT_RUN_KIND },
    AutopilotRunCard,
  ))
}
