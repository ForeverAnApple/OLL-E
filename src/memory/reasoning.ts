// Reasoning-effort preference — how hard an agent thinks.
//
// Sibling to the thinking-model preference (see [[model.ts]] / LOG 2026-06-08):
// the effort an agent reasons at is part of its identity, so it lives on the
// same persistent memory surface and resolves at loop start. The agent sets it
// via `set_reasoning_effort` (a validating front door to memory_write); the
// daemon reads it back here and passes it as the loop's `effort`, which the
// Anthropic adapter maps to adaptive thinking + `output_config.effort`.
//
// A thin instance of the scalar-preference pattern ([[scalar-pref.ts]]). Absence
// of the memory = no thinking (the historical default), so this is strictly
// opt-in and a clean restart reverts to prior behavior.

import type { Store } from "../store/db.ts";
import {
  ANTHROPIC_DEFAULT_MODEL as DEFAULT_MODEL,
  clampEffort,
  type ReasoningEffort,
} from "../llm/index.ts";
import { resolveScalarPref, findScalarPrefId } from "./scalar-pref.ts";

/** Role tag the reasoning-effort preference memory carries. */
export const REASONING_EFFORT_ROLE = "reasoning-effort";

/** Title every reasoning-effort memory carries — stable so an update reuses
 *  one canonical row rather than accreting a row per change. */
export const REASONING_EFFORT_TITLE = "reasoning-effort";

/** Valid effort levels. `off` is accepted by the set tool to mean "disable
 *  thinking" — it is intentionally NOT in this list, so it resolves to
 *  undefined (no effort) below. */
export const EFFORT_LEVELS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function isLevel(s: string): s is ReasoningEffort {
  return (EFFORT_LEVELS as readonly string[]).includes(s);
}

/** The agent's chosen reasoning effort, or undefined for no thinking.
 *  Unrecognised levels (including `off`) resolve to undefined. Recognised
 *  levels are clamped against the model that will run the thread, so stale
 *  memories from older builds cannot brick every future LLM call. */
export function resolveReasoningEffort(
  store: Store,
  agentId: string,
  model: string = DEFAULT_MODEL,
): ReasoningEffort | undefined {
  const level = resolveScalarPref(store, agentId, REASONING_EFFORT_ROLE);
  return level && isLevel(level) ? clampEffort(model, level) : undefined;
}

/** Find the agent's existing reasoning-effort memory id, if any. The set
 *  tool reuses it (update) so identity stays one canonical row. */
export function findReasoningEffortMemoryId(
  store: Store,
  agentId: string,
): string | undefined {
  return findScalarPrefId(store, agentId, REASONING_EFFORT_ROLE);
}
