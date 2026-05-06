// Per-model token prices. Single source of truth for the USD-as-derivation
// rule (LOG 2026-04-24): the ledger stores tokens; anyone who wants USD
// computes it from current prices via priceTokens(). Update this map when
// providers change rates — historical ledger rows naturally re-price to
// the new rate, which is honest ("at today's prices, that conversation
// would have cost X").
//
// All values are micro-USD per million tokens. 1_000_000 micros = $1.
// Cache pricing follows Anthropic's posted multipliers:
//   - cache_read       ~ 0.1 × input  (cache hit, very cheap)
//   - cache_creation   ~ 1.25 × input (one-time premium for first write)
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
