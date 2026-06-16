// set_reasoning_effort — the agent picks how hard it thinks.
//
// Sibling to set_thinking_model (see [[model.ts]] tool). The home is memory
// (effort is identity); this is a thin, validating front door to memory_write.
// It enforces a valid level and a non-empty justification — the switch is
// never mechanically gated, but it must be justified.
//
// Levels map to Anthropic's `output_config.effort` + adaptive thinking. `off`
// disables thinking (resolves to no effort). Applied at loop start, so a
// change lands on the next daemon restart.

import type { EventBus } from "../bus/index.ts";
import type { Store } from "../store/db.ts";
import type { ToolDef } from "../extensions/types.ts";
import {
  ANTHROPIC_DEFAULT_MODEL as DEFAULT_MODEL,
  supportsEffort,
  supportedEfforts,
} from "../llm/index.ts";
import {
  EFFORT_LEVELS,
  REASONING_EFFORT_ROLE,
  REASONING_EFFORT_TITLE,
  isLevel,
  resolveThinkingModel,
  writeScalarPref,
} from "../memory/index.ts";

export interface ReasoningToolsOptions {
  bus: EventBus;
  store: Store;
  hostId: string;
}

interface SetArgs {
  effort: string;
  reason: string;
}

interface SetResult {
  effort: string;
  applied: boolean;
  note: string;
}

// Accepted inputs: the real levels plus `off` (disable thinking).
const CHOICES = [...EFFORT_LEVELS, "off"];

export function buildReasoningTools(opts: ReasoningToolsOptions): ToolDef[] {
  const { bus, store, hostId } = opts;

  const setReasoningEffort: ToolDef<SetArgs, SetResult> = {
    name: "set_reasoning_effort",
    tier: "operational",
    category: "host context",
    shortClause: "set how hard you think — off/low/medium/high/xhigh/max (persists)",
    description:
      "Choose how much you reason before acting. This enables adaptive thinking at the chosen depth (Anthropic's effort dial): higher = more internal reasoning and tokens, lower = faster and cheaper, `off` = no thinking (the default). The choice is part of your identity — stored as a private memory and persists. Switching is never blocked, but you must justify it via `reason` (a human asked, or you judged the intelligence/cost trade worth it). `max`/`xhigh` need an Opus model — picking a level your current thinking-model can't run is rejected here so it never silently degrades. Applies to your next NEW thread/conversation; active threads keep their current effort (no restart, no mid-conversation swap).",
    inputSchema: {
      type: "object",
      properties: {
        effort: {
          type: "string",
          enum: CHOICES,
          description: "Reasoning depth, or `off` to disable thinking.",
        },
        reason: {
          type: "string",
          description: "Why you're changing it. Required — justified, not gated.",
        },
      },
      required: ["effort", "reason"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const effort = typeof args.effort === "string" ? args.effort.trim() : "";
      const reason = typeof args.reason === "string" ? args.reason.trim() : "";
      if (!CHOICES.includes(effort)) {
        throw new Error(
          `set_reasoning_effort: invalid effort "${effort}" — pick one of: ${CHOICES.join(", ")}`,
        );
      }
      if (!reason) {
        throw new Error(
          "set_reasoning_effort: reason is required — justify the change (a human asked, or you judged the trade worth it)",
        );
      }
      // Reject a level the agent's current model can't run, rather than
      // letting the runtime silently clamp it (or, before clamping existed,
      // 400 every turn). `off` always validates.
      if (effort !== "off" && isLevel(effort)) {
        const model = resolveThinkingModel(store, ctx.actorId) ?? DEFAULT_MODEL;
        if (!supportsEffort(model, effort)) {
          const allowed = supportedEfforts(model);
          const hint = allowed.length
            ? `pick one of: ${allowed.join(", ")} (or switch to an Opus model first)`
            : `${model} has no reasoning-effort dial — switch to an Opus model first`;
          throw new Error(
            `set_reasoning_effort: "${effort}" isn't supported by your current model ${model} — ${hint}`,
          );
        }
      }

      writeScalarPref({
        bus,
        store,
        hostId,
        actorId: ctx.actorId,
        role: REASONING_EFFORT_ROLE,
        title: REASONING_EFFORT_TITLE,
        tag: "reasoning-effort",
        value: effort,
        reason,
      });

      return {
        effort,
        applied: false,
        note:
          effort === "off"
            ? "Saved — thinking will be off. Applies to your next new thread/conversation; active threads keep their current setting (no restart needed)."
            : `Saved — thinking at effort=${effort}. Applies to your next new thread/conversation; active threads keep their current setting (no restart needed).`,
      };
    },
  };

  return [setReasoningEffort];
}
