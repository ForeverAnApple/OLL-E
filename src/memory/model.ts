// Thinking-model preference — the model an agent chooses to think with.
//
// "Switch itself to opus 4.8 and persist it" lands here. The choice is a
// memory, not host config: the model an agent reasons in is part of its
// identity, so it lives on the same persistent surface as principles and
// identity (LOG 2026-06-08). The agent writes it through `set_thinking_model`
// (a validating front door to memory_write); the daemon reads it back here at
// loop start and passes it as the loop's `model`.
//
// This is a thin instance of the scalar-preference pattern ([[scalar-pref.ts]]):
// one canonical private row, body line 1 = the model id, the rest = the
// switch's justification (which survives in the memory.wrote event log).

import type { Store } from "../store/db.ts";
import { hasPostedPrice } from "../llm/pricing.ts";
import { resolveScalarPref, findScalarPrefId } from "./scalar-pref.ts";

/** Role tag the thinking-model preference memory carries. Dedicated so the
 *  resolver query is unambiguous and the row never collides with a casual
 *  `preference` the agent writes about something else. */
export const THINKING_MODEL_ROLE = "thinking-model";

/** Title every thinking-model memory carries — stable so an update reuses
 *  one canonical row rather than accreting a new row per switch. */
export const THINKING_MODEL_TITLE = "thinking-model";

/** The agent's chosen model, or undefined to fall back to the adapter
 *  default. Validates the stored value has a posted price; a malformed,
 *  unpriced, or explicit "default" choice resolves to undefined — meaning
 *  "use the default model," never a crash. (Provider is anthropic-only in
 *  v0; posted-price membership is the gate.) */
export function resolveThinkingModel(store: Store, agentId: string): string | undefined {
  const model = resolveScalarPref(store, agentId, THINKING_MODEL_ROLE);
  if (!model) return undefined;
  return hasPostedPrice("anthropic", model) ? model : undefined;
}

/** Find the agent's existing thinking-model memory id, if any. The switch
 *  tool reuses it (update) so identity stays one canonical row. */
export function findThinkingModelMemoryId(store: Store, agentId: string): string | undefined {
  return findScalarPrefId(store, agentId, THINKING_MODEL_ROLE);
}

/** Boot-time model resolution with a human rescue hatch.
 *
 *  Precedence: `OLLE_MODEL` env override (if priced) → thinking-model memory
 *  → undefined (adapter default). The override is the escape hatch for a
 *  self-bricked agent: if a switch somehow lands a model the API rejects,
 *  the agent can't run a turn to fix itself, but a human can force a
 *  known-good model at boot without touching the store. `OLLE_MODEL=default`
 *  forces the host default, ignoring the memory. An unpriced override is
 *  ignored (falls through), so a typo can't brick the rescue. */
export function resolveBootModel(
  store: Store,
  agentId: string,
  override: string | undefined = process.env.OLLE_MODEL,
): string | undefined {
  const ov = override?.trim();
  if (ov) {
    if (ov === "default") return undefined; // force host default, ignore memory
    if (hasPostedPrice("anthropic", ov)) return ov;
    // Unpriced override — ignore and fall through; the daemon logs a warning.
  }
  return resolveThinkingModel(store, agentId);
}
