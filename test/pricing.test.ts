// Effective-dated pricing (LOG 2026-07-09). The rate for a spend is the
// rate in effect at the spend's timestamp; appending a new era must never
// re-value history. Era selection is tested through the pure eraPriceAt;
// priceTokens/lookupPrice are pinned on the single-era models that exist
// in the real table today.

import { describe, expect, test } from "bun:test";
import {
  eraPriceAt,
  lookupPrice,
  priceTokens,
  type ModelPrice,
  type PriceEra,
} from "../src/llm/pricing.ts";

const OLD: ModelPrice = {
  inMicros: 15_000_000,
  outMicros: 75_000_000,
  cacheReadMicros: 1_500_000,
  cacheCreationMicros: 18_750_000,
};
const NEW: ModelPrice = {
  inMicros: 5_000_000,
  outMicros: 25_000_000,
  cacheReadMicros: 500_000,
  cacheCreationMicros: 6_250_000,
};
const CUT_AT = Date.UTC(2026, 4, 5); // 2026-05-05
const ERAS: PriceEra[] = [{ price: OLD }, { effectiveFrom: CUT_AT, price: NEW }];

describe("eraPriceAt", () => {
  test("timestamp before the cut gets the old rate", () => {
    expect(eraPriceAt(ERAS, CUT_AT - 1)).toEqual(OLD);
  });
  test("timestamp at/after the cut gets the new rate", () => {
    expect(eraPriceAt(ERAS, CUT_AT)).toEqual(NEW);
    expect(eraPriceAt(ERAS, CUT_AT + 86_400_000)).toEqual(NEW);
  });
  test("timestamp before the first dated era falls back to the earliest known rate", () => {
    const datedOnly: PriceEra[] = [{ effectiveFrom: CUT_AT, price: NEW }];
    expect(eraPriceAt(datedOnly, CUT_AT - 1)).toEqual(NEW);
  });
});

describe("priceTokens with at", () => {
  test("single-era model prices identically at any timestamp", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
    };
    const past = priceTokens("anthropic", "claude-opus-4-8", usage, Date.UTC(2026, 0, 1));
    const now = priceTokens("anthropic", "claude-opus-4-8", usage);
    expect(past).toBe(now);
    // 5 + 25 + 0.5 + 6.25 = $36.75 per million of each bucket.
    expect(now).toBe(36_750_000);
  });
  test("unknown model still prices via FALLBACK regardless of timestamp", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0 };
    expect(priceTokens("anthropic", "claude-nonexistent", usage, 0)).toBe(
      lookupPrice("anthropic", "claude-nonexistent").inMicros,
    );
  });
});
