// set_thinking_model — the agent picks the model it thinks with.
//
// The home is memory (the choice is identity, per LOG 2026-06-08); this is a
// thin, validating front door to memory_write, not a new home. It earns its
// weight over a raw memory_write by enforcing the two things that make the
// switch trustworthy:
//   1. The model must have a posted price — otherwise the ledger would
//      silently fall back and lie to the agent about its own physics.
//   2. A non-empty `reason` — the switch is never mechanically gated (no
//      ask-up, per the cost-gate decision), but it must be justified: a
//      human asked, or the agent judged the cost/intelligence trade worth it.
//      The justification rides in the memory body and the memory.wrote log.
//
// Apply timing: read at loop start (resolveThinkingModel), so a switch lands
// on the next daemon restart / loop start, not mid-conversation.

import type { EventBus } from "../bus/index.ts";
import type { Store } from "../store/db.ts";
import type { ToolDef } from "../extensions/types.ts";
import {
  hasPostedPrice,
  postedModels,
  DEFAULT_MODEL,
  supportsEffort,
  clampEffort,
  supportedEfforts,
} from "../llm/index.ts";
import {
  THINKING_MODEL_ROLE,
  THINKING_MODEL_TITLE,
  resolveReasoningEffort,
  writeScalarPref,
} from "../memory/index.ts";

export interface ModelToolsOptions {
  bus: EventBus;
  store: Store;
  hostId: string;
  /** Live verification of a candidate model: a cheap probe call to the
   *  provider that throws if the model isn't actually served. Wired in
   *  production from the LLM adapter; omit to skip the smoke test (tests
   *  that don't exercise it). "Posted price" proves the host can bill the
   *  model, not that the API serves it — this closes that gap so a switch
   *  can never brick the loop with a priced-but-unserved model. */
  probe?: (model: string) => Promise<void>;
}

interface SetArgs {
  model: string;
  reason: string;
}

interface SetResult {
  model: string;
  applied: boolean;
  note: string;
}

// Sentinel meaning "stop overriding — fall back to the host default model."
// Resolves to undefined (no posted price), which the daemon reads as default.
const DEFAULT_SENTINEL = "default";

export function buildModelTools(opts: ModelToolsOptions): ToolDef[] {
  const { bus, store, hostId, probe } = opts;

  const setThinkingModel: ToolDef<SetArgs, SetResult> = {
    name: "set_thinking_model",
    tier: "operational",
    category: "host context",
    shortClause: "switch which model you think with (persists)",
    description:
      'Choose the model you reason in. The choice is part of your identity — it\'s stored as a private memory and persists. Switching is never blocked, but you must justify it: pass `reason` saying why (a human asked, or you judged the cost/intelligence trade worth it). The reason is recorded with the switch. Only models the provider actually serves are accepted — the switch is smoke-tested with a real call before it commits, so a bad name changes nothing. Pass model "default" to stop overriding and fall back to the host default. Applies to your next NEW thread/conversation; the current and any active thread keep their model until they end (no restart, no mid-conversation swap).',
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description: 'Model id to switch to, e.g. claude-opus-4-8. Or "default" to revert to the host default.',
        },
        reason: {
          type: "string",
          description:
            "Why you're switching. Required — the switch is justified, not gated.",
        },
      },
      required: ["model", "reason"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const model = typeof args.model === "string" ? args.model.trim() : "";
      const reason = typeof args.reason === "string" ? args.reason.trim() : "";
      if (!model) {
        throw new Error("set_thinking_model: model is required");
      }
      if (!reason) {
        throw new Error(
          "set_thinking_model: reason is required — justify the switch (a human asked, or you judged the trade worth it)",
        );
      }
      const isDefault = model === DEFAULT_SENTINEL;
      if (!isDefault && !hasPostedPrice("anthropic", model)) {
        const known = postedModels("anthropic").join(", ");
        throw new Error(
          `set_thinking_model: no such priced model "${model}" on this host — pick one of: ${known} (or "default")`,
        );
      }

      // Smoke test before committing. The agent (and pricing.ts) can't know
      // the provider actually serves a model — only a real call can. Probe
      // with a cheap call; if it throws, the switch is rejected and nothing
      // is written, so a bad model can never reach loop start and brick the
      // turn. ("default" needs no probe — it can't be wrong.)
      if (!isDefault && probe) {
        try {
          await probe(model);
        } catch (err) {
          const msg = (err as Error)?.message ?? String(err);
          throw new Error(
            `set_thinking_model: could not verify "${model}" with the provider — ${msg}. Not switched; nothing changed.`,
          );
        }
      }

      writeScalarPref({
        bus,
        store,
        hostId,
        actorId: ctx.actorId,
        role: THINKING_MODEL_ROLE,
        title: THINKING_MODEL_TITLE,
        tag: "thinking-model",
        value: model,
        reason,
      });

      // If the agent already has a reasoning-effort set that the new model
      // can't run, the runtime will clamp it. Say so now — silent clamping
      // would be a lie about what the agent will actually get.
      const effort = resolveReasoningEffort(store, ctx.actorId);
      const effectiveModel = isDefault ? DEFAULT_MODEL : model;
      let effortNote = "";
      if (effort && !supportsEffort(effectiveModel, effort)) {
        const clamped = clampEffort(effectiveModel, effort);
        const allowed = supportedEfforts(effectiveModel);
        effortNote =
          clamped
            ? ` Heads up: ${effectiveModel} doesn't support your reasoning-effort "${effort}" — it'll run at "${clamped}". Supported: ${allowed.join(", ")}.`
            : ` Heads up: ${effectiveModel} has no reasoning-effort dial — your "${effort}" will run without thinking.`;
      }

      const base = isDefault
        ? "Reverted to the host default model."
        : "Saved.";
      return {
        model,
        applied: false,
        note: `${base} Applies to your next new thread/conversation — this one and any active thread keep their current model until they end (start a fresh chat to think with it; no restart needed).${effortNote}`,
      };
    },
  };

  return [setThinkingModel];
}
