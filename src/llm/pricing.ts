// Per-model token prices. Single source of truth for the USD-as-derivation
// rule (LOG 2026-04-24): the ledger stores tokens; anyone who wants USD
// computes it from current prices via priceTokens(). Update this map when
// providers change rates — historical ledger rows naturally re-price to
// the new rate, which is honest ("at today's prices, that conversation
// would have cost X").
//
// All values are micro-USD per million tokens. 1_000_000 micros = $1.
// Cache pricing per provider posted multipliers:
//   Anthropic:
//     - cache_read       ~ 0.1 × input  (cache hit, very cheap)
//     - cache_creation   ~ 1.25 × input (one-time premium for first write)
//   OpenAI (automatic prompt caching, no explicit creation):
//     - cache_read       ~ 0.5 × input  (cache hit, half price)
//     - cache_creation   = input        (no surcharge; field stays 0 in usage)
// Output is unaffected by caching.

export interface ModelPrice {
  /** Micro-USD per million input tokens (uncached). */
  inMicros: number;
  /** Micro-USD per million output tokens. */
  outMicros: number;
  /** Micro-USD per million cache-read tokens. ~10% of input by convention. */
  cacheReadMicros: number;
  /** Micro-USD per million cache-creation tokens. ~125% of input by convention. */
  cacheCreationMicros: number;
}

export interface PricedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

// Posted prices as of 2026-05. Edit this map when Anthropic updates rates.
// Source: https://platform.claude.com/docs/en/docs/about-claude/pricing
// Conservative fallback below for unknown models so pricing never throws —
// agents see a number, possibly wrong, never crash.
const PRICES: Record<string, Record<string, ModelPrice>> = {
  anthropic: {
    // Opus 4.5+ priced 3x cheaper than the original Opus 4 / 4.1 tier.
    // (Opus 4.0/4.1 were $15/$75; Opus 4.5/4.6/4.7 are $5/$25.)
    "claude-opus-4-7": {
      inMicros: 5_000_000,
      outMicros: 25_000_000,
      cacheReadMicros: 500_000,
      cacheCreationMicros: 6_250_000,
    },
    "claude-sonnet-4-6": {
      inMicros: 3_000_000,
      outMicros: 15_000_000,
      cacheReadMicros: 300_000,
      cacheCreationMicros: 3_750_000,
    },
    "claude-haiku-4-5-20251001": {
      inMicros: 1_000_000,
      outMicros: 5_000_000,
      cacheReadMicros: 100_000,
      cacheCreationMicros: 1_250_000,
    },
  },
  openai: {
    // Source: https://openai.com/api/pricing/. Cache reads at 0.5x input
    // per OpenAI's automatic-cache discount. cache_creation tokens are
    // never reported by OpenAI; the field exists for parity but stays 0.
    // gpt-5.5 prices are a placeholder mirroring gpt-5 — update when
    // OpenAI publishes the real rate sheet for the model.
    "gpt-5.5": {
      inMicros: 5_000_000,
      outMicros: 25_000_000,
      cacheReadMicros: 2_500_000,
      cacheCreationMicros: 5_000_000,
    },
    "gpt-5": {
      inMicros: 5_000_000,
      outMicros: 25_000_000,
      cacheReadMicros: 2_500_000,
      cacheCreationMicros: 5_000_000,
    },
    "gpt-5-mini": {
      inMicros: 1_000_000,
      outMicros: 4_000_000,
      cacheReadMicros: 500_000,
      cacheCreationMicros: 1_000_000,
    },
    "gpt-4o": {
      inMicros: 2_500_000,
      outMicros: 10_000_000,
      cacheReadMicros: 1_250_000,
      cacheCreationMicros: 2_500_000,
    },
    "gpt-4o-mini": {
      inMicros: 150_000,
      outMicros: 600_000,
      cacheReadMicros: 75_000,
      cacheCreationMicros: 150_000,
    },
    "o3": {
      inMicros: 20_000_000,
      outMicros: 80_000_000,
      cacheReadMicros: 10_000_000,
      cacheCreationMicros: 20_000_000,
    },
    "o3-mini": {
      inMicros: 1_100_000,
      outMicros: 4_400_000,
      cacheReadMicros: 550_000,
      cacheCreationMicros: 1_100_000,
    },
  },
};

const FALLBACK: ModelPrice = {
  // Mid-Opus-ish numbers. Wrong for cheaper models, but never zero —
  // the agent feels SOMETHING when it spends. Update PRICES to fix.
  inMicros: 5_000_000,
  outMicros: 25_000_000,
  cacheReadMicros: 500_000,
  cacheCreationMicros: 6_250_000,
};

export function lookupPrice(provider: string, model: string): ModelPrice {
  return PRICES[provider]?.[model] ?? FALLBACK;
}

/** Compute micro-USD for a given usage at current prices. Pure function. */
export function priceTokens(provider: string, model: string, usage: PricedUsage): number {
  const p = lookupPrice(provider, model);
  return (
    (usage.inputTokens * p.inMicros) / 1_000_000 +
    (usage.outputTokens * p.outMicros) / 1_000_000 +
    ((usage.cacheReadInputTokens ?? 0) * p.cacheReadMicros) / 1_000_000 +
    ((usage.cacheCreationInputTokens ?? 0) * p.cacheCreationMicros) / 1_000_000
  );
}

/** True iff the model has a posted price. Useful for "is this fallback?" UI. */
export function hasPostedPrice(provider: string, model: string): boolean {
  return PRICES[provider]?.[model] !== undefined;
}

/** Every model name across every provider with a posted price. Order
 *  is provider-grouped, then declaration order within the provider. */
export function listKnownModels(): string[] {
  return Object.values(PRICES).flatMap((byModel) => Object.keys(byModel));
}
