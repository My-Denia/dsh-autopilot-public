/**
 * Cost seed for the model-routing layer: ONE column, and only the one the host
 * does not publish.
 *
 * WHY THIS EXISTS AT ALL. `ctx.llm.resolveModelInfo()` publishes the permitted
 * reasoning efforts, the input modalities and the context window for an exact
 * route. It does NOT publish token price. The routing layer's `economy`
 * preference needs price, and it used to approximate it with "smallest context
 * window >= floor", which is not a price: `zai/glm-5.3` and
 * `zai/glm-5.3-flash` both declare a 1,000,000-token window while their
 * sticker prices differ by roughly 9x.
 *
 * WHAT IT IS NOT. It is not a capability ranking and not an owner decision.
 * Price is not ability: a newer, stronger model can be cheaper. Every
 * capability fact is read from the host at dispatch. Nothing here may be used
 * to claim a model is better, only to say what it costs.
 *
 * KEYED BY MODEL IDENTITY, NOT BY ROUTE. This is the correction that matters,
 * and the harness's own catalogs prove it: the same model is packaged under
 * different provider keys with different-looking ids — `moonshotai/kimi-k3`
 * and `kimi-coding/k3` are one model at one price. A provider is a route and
 * billing surface an operator chooses, not a property of the model, so a
 * `provider/model` primary key silently misses exactly the deployments that
 * configured a model under their own provider entry. Kimi is Moonshot's model;
 * which catalog file names it is bookkeeping.
 *
 * So resolution runs from the specific to the general, and REPORTS which step
 * answered:
 *
 * 1. `route`            — `provider/model` matched exactly in the catalogs.
 * 2. `model`            — the model id matched under some other provider. The
 *                          price is the catalog's own for that model id, and
 *                          {@link CAPABILITY_SEED_BY_MODEL} asserts that every
 *                          provider carrying an id agrees on it; an id with two
 *                          prices is refused at generation time rather than
 *                          resolved by picking one.
 * 3. `model-case-folded` — matched after folding case and separators. It is
 *                          reported separately on purpose: this recovers a
 *                          misspelled route id, and a typo must be VISIBLE, not
 *                          silently absorbed.
 * 4. absent              — `cost: unknown`. Never approximated by a proxy.
 *
 * INCLUSION RULE, stated once. A provider is seeded only when its catalog is
 * the model PRODUCER's own first-party API. Excluded: resellers of open-weight
 * models (groq, cerebras, nvidia, together, baseten, fireworks), where the same
 * model is reachable at several prices; gateways (openrouter,
 * vercel-ai-gateway, amazon-bedrock, azure-openai-responses, google-vertex,
 * github-copilot, huggingface, cloudflare-*, opencode*, radius); and
 * open-weight mirrors (meta). `test/capability-seed.test.ts` asserts this rule
 * rather than trusting this paragraph.
 *
 * PROVENANCE AND REGENERATION. Generated 2026-10-09 from the harness's own provider
 * catalogs, `@earendil-works/pi-ai/dist/providers/data/<provider>.json`. The
 * same files carry the permitted-effort maps this repository deliberately does
 * NOT copy: those are host-authoritative at runtime ({@link ./select.ts} reads
 * them through the catalog port), and a second copy here would be a second
 * owner of a fact that can move.
 *
 * Values are US dollars per million tokens as the catalog states them. Free and
 * subscription routes (both prices 0) are omitted: "0" there is a billing
 * arrangement, not a price, and ranking on it would send every economy dispatch
 * to a route whose cost is not actually known.
 */

/** One model's seeded prices, in US dollars per million tokens. */
export interface SeededCost {
  readonly inputPerM: number
  readonly outputPerM: number
  readonly cacheReadPerM?: number
}

/** Provenance of the seed, as data so a run record can cite it. */
export const CAPABILITY_SEED_PROVENANCE = {
  /** Identity of this seed; every route record that used it must carry it. */
  id: 'seed-cost@2026-10-09',
  /** The catalog snapshot this was read from. */
  source: '@earendil-works/pi-ai/dist/providers/data/<provider>.json (shipped with the DeepSeek Harness)',
  /** What this seed may be used for, and what it may never be used for. */
  scope: 'token price only — never a capability ranking, never a dispatch authority',
} as const

/**
 * Provider/model -> seeded price, as the catalogs state it per route.
 *
 * Kept alongside {@link CAPABILITY_SEED_BY_MODEL} because a route hit is the
 * strongest evidence available; the model index is the fallback that keeps an
 * operator's own provider naming from losing the fact.
 */
export const CAPABILITY_SEED_BY_ROUTE: Readonly<Record<string, SeededCost>> = {
  "anthropic/claude-fable-5": { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1 },
  "anthropic/claude-fable-5-1": { inputPerM: 10, outputPerM: 50, cacheReadPerM: 0.25 },
  "anthropic/claude-haiku-4-5": { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1 },
  "anthropic/claude-haiku-4-5-20251001": { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1 },
  "anthropic/claude-opus-4-5": { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5 },
  "anthropic/claude-opus-4-5-20251101": { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5 },
  "anthropic/claude-opus-4-6": { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5 },
  "anthropic/claude-opus-4-7": { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5 },
  "anthropic/claude-opus-4-8": { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5 },
  "anthropic/claude-opus-5": { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5 },
  "anthropic/claude-opus-5-5": { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2 },
  "anthropic/claude-sonnet-4-5": { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
  "anthropic/claude-sonnet-4-5-20250929": { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
  "anthropic/claude-sonnet-4-6": { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
  "anthropic/claude-sonnet-5": { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2 },
  "deepseek/deepseek-flash": { inputPerM: 0.3, outputPerM: 1.2, cacheReadPerM: 0.006 },
  "deepseek/deepseek-v4-pro": { inputPerM: 1.32, outputPerM: 3.96, cacheReadPerM: 0.044 },
  "google/deep-research-max-preview-04-2026": { inputPerM: 2, outputPerM: 12, cacheReadPerM: 0.2 },
  "google/deep-research-preview-04-2026": { inputPerM: 2, outputPerM: 12, cacheReadPerM: 0.2 },
  "google/gemini-2.5-computer-use-preview-10-2025": { inputPerM: 1.25, outputPerM: 10 },
  "google/gemini-2.5-flash": { inputPerM: 0.3, outputPerM: 2.5, cacheReadPerM: 0.03 },
  "google/gemini-2.5-flash-lite": { inputPerM: 0.1, outputPerM: 0.4, cacheReadPerM: 0.01 },
  "google/gemini-2.5-pro": { inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
  "google/gemini-3-flash-preview": { inputPerM: 0.5, outputPerM: 3, cacheReadPerM: 0.05 },
  "google/gemini-3.1-flash-lite": { inputPerM: 0.25, outputPerM: 1.5, cacheReadPerM: 0.025 },
  "google/gemini-3.1-flash-lite-image": { inputPerM: 0.25, outputPerM: 30 },
  "google/gemini-3.1-flash-lite-preview": { inputPerM: 0.25, outputPerM: 1.5, cacheReadPerM: 0.025 },
  "google/gemini-3.1-flash-live-preview": { inputPerM: 0.75, outputPerM: 4.5 },
  "google/gemini-3.1-pro-preview": { inputPerM: 2, outputPerM: 12, cacheReadPerM: 0.2 },
  "google/gemini-3.1-pro-preview-customtools": { inputPerM: 2, outputPerM: 12, cacheReadPerM: 0.2 },
  "google/gemini-3.5-flash": { inputPerM: 1.5, outputPerM: 9, cacheReadPerM: 0.15 },
  "google/gemini-3.5-flash-lite": { inputPerM: 0.3, outputPerM: 2.5, cacheReadPerM: 0.03 },
  "google/gemini-3.6-flash": { inputPerM: 0.75, outputPerM: 3.75, cacheReadPerM: 0.075 },
  "google/gemini-3.7-flash": { inputPerM: 0.75, outputPerM: 3.75, cacheReadPerM: 0.075 },
  "google/gemini-3.8-flash": { inputPerM: 0.75, outputPerM: 3.75, cacheReadPerM: 0.075 },
  "google/gemini-flash-latest": { inputPerM: 1.5, outputPerM: 9, cacheReadPerM: 0.15 },
  "google/gemini-flash-lite-latest": { inputPerM: 0.25, outputPerM: 1.5, cacheReadPerM: 0.025 },
  "kimi-coding/k3": { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
  "kimi-coding/kimi-for-coding": { inputPerM: 0.95, outputPerM: 4, cacheReadPerM: 0.19 },
  "kimi-coding/kimi-for-coding-highspeed": { inputPerM: 1.9, outputPerM: 8, cacheReadPerM: 0.38 },
  "minimax-cn/MiniMax-M2.7": { inputPerM: 0.3, outputPerM: 1.2, cacheReadPerM: 0.06 },
  "minimax-cn/MiniMax-M2.7-highspeed": { inputPerM: 0.6, outputPerM: 2.4, cacheReadPerM: 0.06 },
  "minimax-cn/MiniMax-M3": { inputPerM: 0.3, outputPerM: 1.2, cacheReadPerM: 0.06 },
  "minimax/MiniMax-M2.7": { inputPerM: 0.3, outputPerM: 1.2, cacheReadPerM: 0.06 },
  "minimax/MiniMax-M2.7-highspeed": { inputPerM: 0.6, outputPerM: 2.4, cacheReadPerM: 0.06 },
  "minimax/MiniMax-M3": { inputPerM: 0.3, outputPerM: 1.2, cacheReadPerM: 0.06 },
  "mistral/codestral-latest": { inputPerM: 0.3, outputPerM: 0.9, cacheReadPerM: 0.03 },
  "mistral/devstral-2512": { inputPerM: 0.4, outputPerM: 2, cacheReadPerM: 0.04 },
  "mistral/devstral-latest": { inputPerM: 0.4, outputPerM: 2, cacheReadPerM: 0.04 },
  "mistral/devstral-medium-2507": { inputPerM: 0.4, outputPerM: 2, cacheReadPerM: 0.04 },
  "mistral/devstral-medium-latest": { inputPerM: 0.4, outputPerM: 2, cacheReadPerM: 0.04 },
  "mistral/devstral-small-2505": { inputPerM: 0.1, outputPerM: 0.3, cacheReadPerM: 0.01 },
  "mistral/devstral-small-2507": { inputPerM: 0.1, outputPerM: 0.3, cacheReadPerM: 0.01 },
  "mistral/magistral-medium-latest": { inputPerM: 2, outputPerM: 5, cacheReadPerM: 0.2 },
  "mistral/magistral-small": { inputPerM: 0.5, outputPerM: 1.5, cacheReadPerM: 0.05 },
  "mistral/ministral-3b-latest": { inputPerM: 0.04, outputPerM: 0.04, cacheReadPerM: 0.004 },
  "mistral/ministral-8b-latest": { inputPerM: 0.1, outputPerM: 0.1, cacheReadPerM: 0.01 },
  "mistral/mistral-large-2411": { inputPerM: 2, outputPerM: 6, cacheReadPerM: 0.2 },
  "mistral/mistral-large-2512": { inputPerM: 0.5, outputPerM: 1.5, cacheReadPerM: 0.05 },
  "mistral/mistral-large-latest": { inputPerM: 0.5, outputPerM: 1.5, cacheReadPerM: 0.05 },
  "mistral/mistral-medium-2505": { inputPerM: 0.4, outputPerM: 2, cacheReadPerM: 0.04 },
  "mistral/mistral-medium-2508": { inputPerM: 0.4, outputPerM: 2, cacheReadPerM: 0.04 },
  "mistral/mistral-medium-2604": { inputPerM: 1.5, outputPerM: 7.5, cacheReadPerM: 0.15 },
  "mistral/mistral-medium-3.5": { inputPerM: 1.5, outputPerM: 7.5 },
  "mistral/mistral-medium-latest": { inputPerM: 1.5, outputPerM: 7.5, cacheReadPerM: 0.15 },
  "mistral/mistral-nemo": { inputPerM: 0.15, outputPerM: 0.15, cacheReadPerM: 0.015 },
  "mistral/mistral-small-2506": { inputPerM: 0.1, outputPerM: 0.3, cacheReadPerM: 0.01 },
  "mistral/mistral-small-2603": { inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: 0.015 },
  "mistral/mistral-small-latest": { inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: 0.015 },
  "mistral/open-mistral-7b": { inputPerM: 0.25, outputPerM: 0.25, cacheReadPerM: 0.025 },
  "mistral/open-mistral-nemo": { inputPerM: 0.15, outputPerM: 0.15, cacheReadPerM: 0.015 },
  "mistral/open-mixtral-8x22b": { inputPerM: 2, outputPerM: 6, cacheReadPerM: 0.2 },
  "mistral/open-mixtral-8x7b": { inputPerM: 0.7, outputPerM: 0.7, cacheReadPerM: 0.07 },
  "mistral/pixtral-12b": { inputPerM: 0.15, outputPerM: 0.15, cacheReadPerM: 0.015 },
  "mistral/pixtral-large-latest": { inputPerM: 2, outputPerM: 6, cacheReadPerM: 0.2 },
  "mistral/voxtral-small-latest": { inputPerM: 0.1, outputPerM: 0.3, cacheReadPerM: 0.01 },
  "mistral/zai-glm-5-2": { inputPerM: 1.4, outputPerM: 4.4, cacheReadPerM: 0.14 },
  "mistral/zai-glm-5-3": { inputPerM: 1.4, outputPerM: 4.4, cacheReadPerM: 0.14 },
  "moonshotai-cn/kimi-k2.6": { inputPerM: 0.95, outputPerM: 4, cacheReadPerM: 0.16 },
  "moonshotai-cn/kimi-k2.7-code": { inputPerM: 0.95, outputPerM: 4, cacheReadPerM: 0.19 },
  "moonshotai-cn/kimi-k2.7-code-highspeed": { inputPerM: 1.9, outputPerM: 8, cacheReadPerM: 0.38 },
  "moonshotai-cn/kimi-k3": { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
  "moonshotai/kimi-k2.6": { inputPerM: 0.95, outputPerM: 4, cacheReadPerM: 0.16 },
  "moonshotai/kimi-k2.7-code": { inputPerM: 0.95, outputPerM: 4, cacheReadPerM: 0.19 },
  "moonshotai/kimi-k2.7-code-highspeed": { inputPerM: 1.9, outputPerM: 8, cacheReadPerM: 0.38 },
  "moonshotai/kimi-k3": { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
  "openai-codex/gpt-5.3-codex-spark": { inputPerM: 1.75, outputPerM: 14, cacheReadPerM: 0.175 },
  "openai-codex/gpt-5.5": { inputPerM: 5, outputPerM: 30, cacheReadPerM: 0.5 },
  "openai-codex/gpt-5.6-luna": { inputPerM: 0.2, outputPerM: 1.2, cacheReadPerM: 0.02 },
  "openai-codex/gpt-5.6-sol": { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.4 },
  "openai-codex/gpt-5.6-terra": { inputPerM: 2, outputPerM: 12, cacheReadPerM: 0.2 },
  "openai-codex/gpt-6-astra": { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1 },
  "openai-codex/gpt-6-luna": { inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01 },
  "openai-codex/gpt-6-sol": { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2 },
  "openai/gpt-4": { inputPerM: 30, outputPerM: 60 },
  "openai/gpt-4-turbo": { inputPerM: 10, outputPerM: 30 },
  "openai/gpt-4.1": { inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.5 },
  "openai/gpt-4.1-mini": { inputPerM: 0.4, outputPerM: 1.6, cacheReadPerM: 0.1 },
  "openai/gpt-4.1-nano": { inputPerM: 0.1, outputPerM: 0.4, cacheReadPerM: 0.025 },
  "openai/gpt-4o": { inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 1.25 },
  "openai/gpt-4o-2024-05-13": { inputPerM: 5, outputPerM: 15 },
  "openai/gpt-4o-2024-08-06": { inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 1.25 },
  "openai/gpt-4o-2024-11-20": { inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 1.25 },
  "openai/gpt-4o-mini": { inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: 0.075 },
  "openai/gpt-5": { inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
  "openai/gpt-5-chat-latest": { inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
  "openai/gpt-5-mini": { inputPerM: 0.25, outputPerM: 2, cacheReadPerM: 0.025 },
  "openai/gpt-5-nano": { inputPerM: 0.05, outputPerM: 0.4, cacheReadPerM: 0.005 },
  "openai/gpt-5-pro": { inputPerM: 15, outputPerM: 120 },
  "openai/gpt-5.1": { inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
  "openai/gpt-5.2": { inputPerM: 1.75, outputPerM: 14, cacheReadPerM: 0.175 },
  "openai/gpt-5.2-chat-latest": { inputPerM: 1.75, outputPerM: 14, cacheReadPerM: 0.175 },
  "openai/gpt-5.2-pro": { inputPerM: 21, outputPerM: 168 },
  "openai/gpt-5.3-chat-latest": { inputPerM: 1.75, outputPerM: 14, cacheReadPerM: 0.175 },
  "openai/gpt-5.3-codex": { inputPerM: 1.75, outputPerM: 14, cacheReadPerM: 0.175 },
  "openai/gpt-5.3-codex-spark": { inputPerM: 1.75, outputPerM: 14, cacheReadPerM: 0.175 },
  "openai/gpt-5.4": { inputPerM: 2.5, outputPerM: 15, cacheReadPerM: 0.25 },
  "openai/gpt-5.4-mini": { inputPerM: 0.75, outputPerM: 4.5, cacheReadPerM: 0.075 },
  "openai/gpt-5.4-nano": { inputPerM: 0.2, outputPerM: 1.25, cacheReadPerM: 0.02 },
  "openai/gpt-5.4-pro": { inputPerM: 30, outputPerM: 180 },
  "openai/gpt-5.5": { inputPerM: 5, outputPerM: 30, cacheReadPerM: 0.5 },
  "openai/gpt-5.5-pro": { inputPerM: 30, outputPerM: 180 },
  "openai/gpt-5.6-luna": { inputPerM: 0.2, outputPerM: 1.2, cacheReadPerM: 0.02 },
  "openai/gpt-5.6-sol": { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.4 },
  "openai/gpt-5.6-terra": { inputPerM: 2, outputPerM: 12, cacheReadPerM: 0.2 },
  "openai/gpt-6-astra": { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1 },
  "openai/gpt-6-luna": { inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01 },
  "openai/gpt-6-sol": { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2 },
  "openai/gpt-realtime-2.1": { inputPerM: 4, outputPerM: 24, cacheReadPerM: 0.4 },
  "openai/o1": { inputPerM: 15, outputPerM: 60, cacheReadPerM: 7.5 },
  "openai/o1-pro": { inputPerM: 150, outputPerM: 600 },
  "openai/o3": { inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.5 },
  "openai/o3-mini": { inputPerM: 1.1, outputPerM: 4.4, cacheReadPerM: 0.55 },
  "openai/o3-pro": { inputPerM: 20, outputPerM: 80 },
  "openai/o4-mini": { inputPerM: 1.1, outputPerM: 4.4, cacheReadPerM: 0.275 },
  "xai/grok-4.3": { inputPerM: 1.25, outputPerM: 2.5, cacheReadPerM: 0.2 },
  "xai/grok-4.5": { inputPerM: 2, outputPerM: 6, cacheReadPerM: 0.3 },
  "xai/grok-4.6": { inputPerM: 2, outputPerM: 6, cacheReadPerM: 0.5 },
  "xai/grok-4.7": { inputPerM: 2, outputPerM: 6, cacheReadPerM: 0.5 },
  "xiaomi/mimo-v2.5": { inputPerM: 0.14, outputPerM: 0.28, cacheReadPerM: 0.0028 },
  "xiaomi/mimo-v2.5-pro": { inputPerM: 0.435, outputPerM: 0.87, cacheReadPerM: 0.0036 },
  "xiaomi/mimo-v2.5-pro-ultraspeed": { inputPerM: 1.305, outputPerM: 2.61, cacheReadPerM: 0.0108 },
  "xiaomi/mimo-v2.6-flash": { inputPerM: 0.14, outputPerM: 0.28, cacheReadPerM: 0.0028 },
  "xiaomi/mimo-v2.6-pro": { inputPerM: 0.435, outputPerM: 0.87, cacheReadPerM: 0.0036 },
  "xiaomi/mimo-v2.6-pro-ultraspeed": { inputPerM: 4.35, outputPerM: 8.7, cacheReadPerM: 0.036 },
  "zai-coding-cn/glm-4.6v": { inputPerM: 0.3, outputPerM: 0.9 },
  "zai-coding-cn/glm-5.3": { inputPerM: 1.4, outputPerM: 4.4, cacheReadPerM: 0.26 },
  "zai-coding-cn/glm-5.3-flash": { inputPerM: 0.15, outputPerM: 0.5, cacheReadPerM: 0.03 },
  "zai/glm-4.7": { inputPerM: 0.6, outputPerM: 2.2, cacheReadPerM: 0.11 },
  "zai/glm-5-turbo": { inputPerM: 1.2, outputPerM: 4, cacheReadPerM: 0.24 },
  "zai/glm-5.2": { inputPerM: 1.4, outputPerM: 4.4, cacheReadPerM: 0.26 },
  "zai/glm-5.3": { inputPerM: 1.4, outputPerM: 4.4, cacheReadPerM: 0.26 },
  "zai/glm-5.3-flash": { inputPerM: 0.15, outputPerM: 0.5, cacheReadPerM: 0.03 },
}

/**
 * Model id -> seeded price, provider-blind.
 *
 * Every provider that carries an id in this table states the SAME price for it;
 * the generator refuses to emit an id with two prices rather than choose one.
 * That makes a model hit as trustworthy as a route hit for these catalogs.
 */
export const CAPABILITY_SEED_BY_MODEL: Readonly<Record<string, SeededCost>> = {
  "MiniMax-M2.7": { inputPerM: 0.3, outputPerM: 1.2, cacheReadPerM: 0.06 },
  "MiniMax-M2.7-highspeed": { inputPerM: 0.6, outputPerM: 2.4, cacheReadPerM: 0.06 },
  "MiniMax-M3": { inputPerM: 0.3, outputPerM: 1.2, cacheReadPerM: 0.06 },
  "claude-fable-5": { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1 },
  "claude-fable-5-1": { inputPerM: 10, outputPerM: 50, cacheReadPerM: 0.25 },
  "claude-haiku-4-5": { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1 },
  "claude-haiku-4-5-20251001": { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1 },
  "claude-opus-4-5": { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5 },
  "claude-opus-4-5-20251101": { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5 },
  "claude-opus-4-6": { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5 },
  "claude-opus-4-7": { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5 },
  "claude-opus-4-8": { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5 },
  "claude-opus-5": { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5 },
  "claude-opus-5-5": { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2 },
  "claude-sonnet-4-5": { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
  "claude-sonnet-4-5-20250929": { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
  "claude-sonnet-4-6": { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
  "claude-sonnet-5": { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2 },
  "codestral-latest": { inputPerM: 0.3, outputPerM: 0.9, cacheReadPerM: 0.03 },
  "deep-research-max-preview-04-2026": { inputPerM: 2, outputPerM: 12, cacheReadPerM: 0.2 },
  "deep-research-preview-04-2026": { inputPerM: 2, outputPerM: 12, cacheReadPerM: 0.2 },
  "deepseek-flash": { inputPerM: 0.3, outputPerM: 1.2, cacheReadPerM: 0.006 },
  "deepseek-v4-pro": { inputPerM: 1.32, outputPerM: 3.96, cacheReadPerM: 0.044 },
  "devstral-2512": { inputPerM: 0.4, outputPerM: 2, cacheReadPerM: 0.04 },
  "devstral-latest": { inputPerM: 0.4, outputPerM: 2, cacheReadPerM: 0.04 },
  "devstral-medium-2507": { inputPerM: 0.4, outputPerM: 2, cacheReadPerM: 0.04 },
  "devstral-medium-latest": { inputPerM: 0.4, outputPerM: 2, cacheReadPerM: 0.04 },
  "devstral-small-2505": { inputPerM: 0.1, outputPerM: 0.3, cacheReadPerM: 0.01 },
  "devstral-small-2507": { inputPerM: 0.1, outputPerM: 0.3, cacheReadPerM: 0.01 },
  "gemini-2.5-computer-use-preview-10-2025": { inputPerM: 1.25, outputPerM: 10 },
  "gemini-2.5-flash": { inputPerM: 0.3, outputPerM: 2.5, cacheReadPerM: 0.03 },
  "gemini-2.5-flash-lite": { inputPerM: 0.1, outputPerM: 0.4, cacheReadPerM: 0.01 },
  "gemini-2.5-pro": { inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
  "gemini-3-flash-preview": { inputPerM: 0.5, outputPerM: 3, cacheReadPerM: 0.05 },
  "gemini-3.1-flash-lite": { inputPerM: 0.25, outputPerM: 1.5, cacheReadPerM: 0.025 },
  "gemini-3.1-flash-lite-image": { inputPerM: 0.25, outputPerM: 30 },
  "gemini-3.1-flash-lite-preview": { inputPerM: 0.25, outputPerM: 1.5, cacheReadPerM: 0.025 },
  "gemini-3.1-flash-live-preview": { inputPerM: 0.75, outputPerM: 4.5 },
  "gemini-3.1-pro-preview": { inputPerM: 2, outputPerM: 12, cacheReadPerM: 0.2 },
  "gemini-3.1-pro-preview-customtools": { inputPerM: 2, outputPerM: 12, cacheReadPerM: 0.2 },
  "gemini-3.5-flash": { inputPerM: 1.5, outputPerM: 9, cacheReadPerM: 0.15 },
  "gemini-3.5-flash-lite": { inputPerM: 0.3, outputPerM: 2.5, cacheReadPerM: 0.03 },
  "gemini-3.6-flash": { inputPerM: 0.75, outputPerM: 3.75, cacheReadPerM: 0.075 },
  "gemini-3.7-flash": { inputPerM: 0.75, outputPerM: 3.75, cacheReadPerM: 0.075 },
  "gemini-3.8-flash": { inputPerM: 0.75, outputPerM: 3.75, cacheReadPerM: 0.075 },
  "gemini-flash-latest": { inputPerM: 1.5, outputPerM: 9, cacheReadPerM: 0.15 },
  "gemini-flash-lite-latest": { inputPerM: 0.25, outputPerM: 1.5, cacheReadPerM: 0.025 },
  "glm-4.6v": { inputPerM: 0.3, outputPerM: 0.9 },
  "glm-4.7": { inputPerM: 0.6, outputPerM: 2.2, cacheReadPerM: 0.11 },
  "glm-5-turbo": { inputPerM: 1.2, outputPerM: 4, cacheReadPerM: 0.24 },
  "glm-5.2": { inputPerM: 1.4, outputPerM: 4.4, cacheReadPerM: 0.26 },
  "glm-5.3": { inputPerM: 1.4, outputPerM: 4.4, cacheReadPerM: 0.26 },
  "glm-5.3-flash": { inputPerM: 0.15, outputPerM: 0.5, cacheReadPerM: 0.03 },
  "gpt-4": { inputPerM: 30, outputPerM: 60 },
  "gpt-4-turbo": { inputPerM: 10, outputPerM: 30 },
  "gpt-4.1": { inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.5 },
  "gpt-4.1-mini": { inputPerM: 0.4, outputPerM: 1.6, cacheReadPerM: 0.1 },
  "gpt-4.1-nano": { inputPerM: 0.1, outputPerM: 0.4, cacheReadPerM: 0.025 },
  "gpt-4o": { inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 1.25 },
  "gpt-4o-2024-05-13": { inputPerM: 5, outputPerM: 15 },
  "gpt-4o-2024-08-06": { inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 1.25 },
  "gpt-4o-2024-11-20": { inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 1.25 },
  "gpt-4o-mini": { inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: 0.075 },
  "gpt-5": { inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
  "gpt-5-chat-latest": { inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
  "gpt-5-mini": { inputPerM: 0.25, outputPerM: 2, cacheReadPerM: 0.025 },
  "gpt-5-nano": { inputPerM: 0.05, outputPerM: 0.4, cacheReadPerM: 0.005 },
  "gpt-5-pro": { inputPerM: 15, outputPerM: 120 },
  "gpt-5.1": { inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
  "gpt-5.2": { inputPerM: 1.75, outputPerM: 14, cacheReadPerM: 0.175 },
  "gpt-5.2-chat-latest": { inputPerM: 1.75, outputPerM: 14, cacheReadPerM: 0.175 },
  "gpt-5.2-pro": { inputPerM: 21, outputPerM: 168 },
  "gpt-5.3-chat-latest": { inputPerM: 1.75, outputPerM: 14, cacheReadPerM: 0.175 },
  "gpt-5.3-codex": { inputPerM: 1.75, outputPerM: 14, cacheReadPerM: 0.175 },
  "gpt-5.3-codex-spark": { inputPerM: 1.75, outputPerM: 14, cacheReadPerM: 0.175 },
  "gpt-5.4": { inputPerM: 2.5, outputPerM: 15, cacheReadPerM: 0.25 },
  "gpt-5.4-mini": { inputPerM: 0.75, outputPerM: 4.5, cacheReadPerM: 0.075 },
  "gpt-5.4-nano": { inputPerM: 0.2, outputPerM: 1.25, cacheReadPerM: 0.02 },
  "gpt-5.4-pro": { inputPerM: 30, outputPerM: 180 },
  "gpt-5.5": { inputPerM: 5, outputPerM: 30, cacheReadPerM: 0.5 },
  "gpt-5.5-pro": { inputPerM: 30, outputPerM: 180 },
  "gpt-5.6-luna": { inputPerM: 0.2, outputPerM: 1.2, cacheReadPerM: 0.02 },
  "gpt-5.6-sol": { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.4 },
  "gpt-5.6-terra": { inputPerM: 2, outputPerM: 12, cacheReadPerM: 0.2 },
  "gpt-6-astra": { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1 },
  "gpt-6-luna": { inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01 },
  "gpt-6-sol": { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2 },
  "gpt-realtime-2.1": { inputPerM: 4, outputPerM: 24, cacheReadPerM: 0.4 },
  "grok-4.3": { inputPerM: 1.25, outputPerM: 2.5, cacheReadPerM: 0.2 },
  "grok-4.5": { inputPerM: 2, outputPerM: 6, cacheReadPerM: 0.3 },
  "grok-4.6": { inputPerM: 2, outputPerM: 6, cacheReadPerM: 0.5 },
  "grok-4.7": { inputPerM: 2, outputPerM: 6, cacheReadPerM: 0.5 },
  "k3": { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
  "kimi-for-coding": { inputPerM: 0.95, outputPerM: 4, cacheReadPerM: 0.19 },
  "kimi-for-coding-highspeed": { inputPerM: 1.9, outputPerM: 8, cacheReadPerM: 0.38 },
  "kimi-k2.6": { inputPerM: 0.95, outputPerM: 4, cacheReadPerM: 0.16 },
  "kimi-k2.7-code": { inputPerM: 0.95, outputPerM: 4, cacheReadPerM: 0.19 },
  "kimi-k2.7-code-highspeed": { inputPerM: 1.9, outputPerM: 8, cacheReadPerM: 0.38 },
  "kimi-k3": { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
  "magistral-medium-latest": { inputPerM: 2, outputPerM: 5, cacheReadPerM: 0.2 },
  "magistral-small": { inputPerM: 0.5, outputPerM: 1.5, cacheReadPerM: 0.05 },
  "mimo-v2.5": { inputPerM: 0.14, outputPerM: 0.28, cacheReadPerM: 0.0028 },
  "mimo-v2.5-pro": { inputPerM: 0.435, outputPerM: 0.87, cacheReadPerM: 0.0036 },
  "mimo-v2.5-pro-ultraspeed": { inputPerM: 1.305, outputPerM: 2.61, cacheReadPerM: 0.0108 },
  "mimo-v2.6-flash": { inputPerM: 0.14, outputPerM: 0.28, cacheReadPerM: 0.0028 },
  "mimo-v2.6-pro": { inputPerM: 0.435, outputPerM: 0.87, cacheReadPerM: 0.0036 },
  "mimo-v2.6-pro-ultraspeed": { inputPerM: 4.35, outputPerM: 8.7, cacheReadPerM: 0.036 },
  "ministral-3b-latest": { inputPerM: 0.04, outputPerM: 0.04, cacheReadPerM: 0.004 },
  "ministral-8b-latest": { inputPerM: 0.1, outputPerM: 0.1, cacheReadPerM: 0.01 },
  "mistral-large-2411": { inputPerM: 2, outputPerM: 6, cacheReadPerM: 0.2 },
  "mistral-large-2512": { inputPerM: 0.5, outputPerM: 1.5, cacheReadPerM: 0.05 },
  "mistral-large-latest": { inputPerM: 0.5, outputPerM: 1.5, cacheReadPerM: 0.05 },
  "mistral-medium-2505": { inputPerM: 0.4, outputPerM: 2, cacheReadPerM: 0.04 },
  "mistral-medium-2508": { inputPerM: 0.4, outputPerM: 2, cacheReadPerM: 0.04 },
  "mistral-medium-2604": { inputPerM: 1.5, outputPerM: 7.5, cacheReadPerM: 0.15 },
  "mistral-medium-3.5": { inputPerM: 1.5, outputPerM: 7.5 },
  "mistral-medium-latest": { inputPerM: 1.5, outputPerM: 7.5, cacheReadPerM: 0.15 },
  "mistral-nemo": { inputPerM: 0.15, outputPerM: 0.15, cacheReadPerM: 0.015 },
  "mistral-small-2506": { inputPerM: 0.1, outputPerM: 0.3, cacheReadPerM: 0.01 },
  "mistral-small-2603": { inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: 0.015 },
  "mistral-small-latest": { inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: 0.015 },
  "o1": { inputPerM: 15, outputPerM: 60, cacheReadPerM: 7.5 },
  "o1-pro": { inputPerM: 150, outputPerM: 600 },
  "o3": { inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.5 },
  "o3-mini": { inputPerM: 1.1, outputPerM: 4.4, cacheReadPerM: 0.55 },
  "o3-pro": { inputPerM: 20, outputPerM: 80 },
  "o4-mini": { inputPerM: 1.1, outputPerM: 4.4, cacheReadPerM: 0.275 },
  "open-mistral-7b": { inputPerM: 0.25, outputPerM: 0.25, cacheReadPerM: 0.025 },
  "open-mistral-nemo": { inputPerM: 0.15, outputPerM: 0.15, cacheReadPerM: 0.015 },
  "open-mixtral-8x22b": { inputPerM: 2, outputPerM: 6, cacheReadPerM: 0.2 },
  "open-mixtral-8x7b": { inputPerM: 0.7, outputPerM: 0.7, cacheReadPerM: 0.07 },
  "pixtral-12b": { inputPerM: 0.15, outputPerM: 0.15, cacheReadPerM: 0.015 },
  "pixtral-large-latest": { inputPerM: 2, outputPerM: 6, cacheReadPerM: 0.2 },
  "voxtral-small-latest": { inputPerM: 0.1, outputPerM: 0.3, cacheReadPerM: 0.01 },
  "zai-glm-5-2": { inputPerM: 1.4, outputPerM: 4.4, cacheReadPerM: 0.14 },
  "zai-glm-5-3": { inputPerM: 1.4, outputPerM: 4.4, cacheReadPerM: 0.14 },
}

/** Fold case and separators. Used only to RECOVER a near-miss, never to assert identity. */
function foldModelId(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s._-]+/g, '')
}

const FOLDED_INDEX: ReadonlyMap<string, string> = new Map(
  Object.keys(CAPABILITY_SEED_BY_MODEL).map(model => [foldModelId(model), model]),
)

/** How a price was resolved. Reported so a caller cannot mistake a recovery for a fact. */
export type SeedMatchKind = 'route' | 'model' | 'model-case-folded'

/** One resolved price plus the evidence step that produced it. */
export interface SeedHit {
  readonly cost: SeededCost
  readonly match: SeedMatchKind
  /** The seeded key the price came from, so a reader can audit the resolution. */
  readonly source: string
}

/**
 * Resolve a route's seeded price, or `undefined` when this seed does not know it.
 *
 * Specific to general: exact route, then model identity, then a case/separator
 * recovery that is LABELLED as such. Absence is a first-class answer — the
 * caller must record cost as unknown rather than substitute a proxy.
 */
export function seededCost(provider: string, model: string): SeedHit | undefined {
  const p = provider.trim()
  const m = model.trim()
  if (m.length === 0) return undefined
  if (p.length > 0) {
    const route = CAPABILITY_SEED_BY_ROUTE[`${p}/${m}`]
    if (route !== undefined) return { cost: route, match: 'route', source: `${p}/${m}` }
  }
  const direct = CAPABILITY_SEED_BY_MODEL[m]
  if (direct !== undefined) return { cost: direct, match: 'model', source: m }
  const canonical = FOLDED_INDEX.get(foldModelId(m))
  if (canonical !== undefined) {
    const cost = CAPABILITY_SEED_BY_MODEL[canonical]
    if (cost !== undefined) return { cost, match: 'model-case-folded', source: canonical }
  }
  return undefined
}
