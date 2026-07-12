// Adapt a CliBrain into the generic `Llm` interface. This exists only so
// incidental `llm.complete` callers keep working in pure-CLI mode: the 1-token
// liveness probe used when switching models, and manager construction that
// requires an Llm. It is deliberately minimal — no MCP tools (tools are
// irrelevant to a plain completion), no session, no streaming.
//
// A CliBrain drives a whole agent turn; that machinery (MCP config, session
// resume) is overkill here, so we lean on the adapters' one-shot seam
// (./one-shot.ts) for a tool-less system+prompt round-trip.

import type {
  Completion,
  CompletionRequest,
  ContentBlock,
  Llm,
  SystemSegment,
} from "../types.ts";
import type { CliBrain } from "./types.ts";
import type { OneShotBrain } from "./one-shot.ts";
import { flattenMessages } from "./render.ts";

function isOneShot(brain: CliBrain): brain is CliBrain & OneShotBrain {
  return typeof (brain as Partial<OneShotBrain>).oneShot === "function";
}

function renderSystem(system: CompletionRequest["system"]): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === "string") return system;
  return (system as SystemSegment[]).map((s) => s.text).join("\n\n");
}

function blockText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "tool_result":
      return block.content;
    default:
      return "";
  }
}

/** Flatten the message list into one prompt string. Tool_use/thinking blocks
 *  and user/assistant role framing collapse to plain text — enough for the
 *  liveness/probe callers this shim serves. */
function renderPrompt(messages: CompletionRequest["messages"]): string {
  return flattenMessages(messages, {
    renderBlock: blockText,
    label: (role, text) =>
      role === "user" || role === "assistant" ? text : `[${role}] ${text}`,
  });
}

export function cliBrainToLlm(brain: CliBrain): Llm {
  return {
    provider: brain.provider,
    defaultModel: brain.defaultModel,
    async complete(req: CompletionRequest): Promise<Completion> {
      const system = renderSystem(req.system);
      const prompt = renderPrompt(req.messages);
      const model = req.model || brain.defaultModel;

      if (!isOneShot(brain)) {
        throw new Error(
          `cliBrainToLlm: brain "${brain.provider}" does not support one-shot completion`,
        );
      }

      const { text, usage } = await brain.oneShot({
        system,
        prompt,
        model,
        signal: req.signal,
      });

      return {
        content: [{ type: "text", text }],
        stopReason: "end_turn",
        usage,
      };
    },
  };
}
