// Per-model capability facts for the models OLL-E can actually select (the
// priced set in pricing.ts). The effort dial (`output_config.effort`) and its
// ceiling vary by model: sending an unsupported level 400s *every* turn, and
// because the model and effort are each a self-chosen memory resolved at loop
// start, a bad combination would brick the loop with no way for the agent to
// recover (it can't issue a fixing tool call when every LLM hop 400s). So the
// runtime clamps the resolved (model, effort, maxTokens) against this table
// rather than trusting the pair. Update alongside pricing.ts when providers
// ship models.

import type { ReasoningEffort } from "./types.ts";

// Effort levels in ascending depth. A model's supported set is always a
// prefix of this list, so "highest supported at or below X" is well-defined.
const EFFORT_ORDER: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

interface ModelCaps {
  /** Effort levels this model accepts. Empty = no effort dial (no thinking). */
  efforts: readonly ReasoningEffort[];
  /** Hard ceiling for `max_tokens` (output + thinking share this budget). */
  maxOutputTokens: number;
}

const CAPS: Record<string, ModelCaps> = {
  // Opus tier: full effort range, 64k output.
  "claude-opus-4-8": { efforts: EFFORT_ORDER, maxOutputTokens: 64_000 },
  "claude-opus-4-7": { efforts: EFFORT_ORDER, maxOutputTokens: 64_000 },
  // Sonnet 4.6: effort dial GA, but xhigh/max are Opus-only.
  "claude-sonnet-4-6": { efforts: ["low", "medium", "high"], maxOutputTokens: 64_000 },
  // Haiku 4.5: no effort dial — any effort 400s.
  "claude-haiku-4-5-20251001": { efforts: [], maxOutputTokens: 32_000 },
};

// Unknown/future model: assume the broad GA baseline (low/medium/high) and a
// conservative output cap. The API stays the final backstop.
const DEFAULT_CAPS: ModelCaps = { efforts: ["low", "medium", "high"], maxOutputTokens: 32_000 };

function capsFor(model: string): ModelCaps {
  return CAPS[model] ?? DEFAULT_CAPS;
}

/** Effort levels the model accepts, ascending. Empty = no thinking. The
 *  set-time tools use this to give the agent the valid options. */
export function supportedEfforts(model: string): readonly ReasoningEffort[] {
  return capsFor(model).efforts;
}

/** True iff the model accepts this exact effort level. */
export function supportsEffort(model: string, effort: ReasoningEffort): boolean {
  return capsFor(model).efforts.includes(effort);
}

/** Resolve a requested effort to one the model actually accepts: the level
 *  itself if supported, else the highest supported level below it, else
 *  undefined (the model can't think — run without it). This is the runtime
 *  safety net; an unsupported combination degrades instead of bricking. */
export function clampEffort(
  model: string,
  effort: ReasoningEffort,
): ReasoningEffort | undefined {
  const supported = capsFor(model).efforts;
  if (supported.length === 0) return undefined;
  if (supported.includes(effort)) return effort;
  const reqIdx = EFFORT_ORDER.indexOf(effort);
  for (let i = reqIdx - 1; i >= 0; i--) {
    if (supported.includes(EFFORT_ORDER[i]!)) return EFFORT_ORDER[i];
  }
  return undefined;
}

/** Hard ceiling for `max_tokens` on this model. */
export function maxOutputTokens(model: string): number {
  return capsFor(model).maxOutputTokens;
}
