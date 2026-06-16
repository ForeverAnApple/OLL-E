// Shared Vercel AI SDK ↔ OLL-E mapping. Both adapters end with
// `streamText` and share most of the message-shape translation; only
// provider-specific concerns (Anthropic cache control) stay in the
// adapter file.

import type {
  AssistantContent,
  FinishReason,
  LanguageModelUsage,
  ModelMessage,
  ToolCallPart,
} from "ai";
import type { streamText } from "ai";
import type { Completion, ContentBlock, Message, Usage } from "./types.ts";

export function mapFinishReason(reason: FinishReason): Completion["stopReason"] {
  switch (reason) {
    case "tool-calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
      return "end_turn";
    case "content-filter":
      return "refusal";
    case "error":
    case "other":
    default:
      return "end_turn";
  }
}

/** Map AI SDK's normalized usage to OLL-E's Usage. AI SDK reports
 *  `inputTokens` as the TOTAL prompt tokens (including cache reads); to
 *  preserve our existing semantics (uncached input only), we subtract
 *  cache read/write or take `noCacheTokens` directly when the provider
 *  reports it. OpenAI sets `hasCacheWrites: false` because it has no
 *  cache_creation concept; Anthropic sets it true. */
export function mapUsage(
  u: LanguageModelUsage,
  opts: { hasCacheWrites: boolean },
): Usage {
  const cacheRead = u.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheCreation = opts.hasCacheWrites
    ? (u.inputTokenDetails?.cacheWriteTokens ?? 0)
    : 0;
  const totalInput = u.inputTokens ?? 0;
  const inputTokens =
    u.inputTokenDetails?.noCacheTokens ??
    Math.max(0, totalInput - cacheRead - cacheCreation);
  const outputTokens = u.outputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    totalTokens: inputTokens + outputTokens + cacheRead + cacheCreation,
  };
}

/** Translate OLL-E's neutral Message[] to AI SDK ModelMessage[]. Splits
 *  tool-result blocks onto their own `role: "tool"` messages (the AI
 *  SDK shape), drops malformed combinations (tool_use on user, tool_result
 *  on assistant). System messages are rejected — system must come through
 *  the dedicated `system` parameter of `streamText`. */
export function buildMessages(messages: Message[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      throw new Error("system must be passed via `system`, not messages");
    }
    if (m.role === "assistant") {
      out.push(toAssistantMessage(m));
      continue;
    }
    if (typeof m.content === "string") {
      out.push({ role: "user", content: m.content });
      continue;
    }
    const toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }> = [];
    const textParts: string[] = [];
    for (const block of m.content) {
      if (block.type === "tool_result") {
        toolResults.push({
          tool_use_id: block.tool_use_id,
          content: block.content,
          ...(block.is_error !== undefined && { is_error: block.is_error }),
        });
      } else if (block.type === "text") {
        textParts.push(block.text);
      }
    }
    if (toolResults.length > 0) {
      out.push({
        role: "tool",
        content: toolResults.map((r) => ({
          type: "tool-result",
          toolCallId: r.tool_use_id,
          // Name is structurally required by the AI SDK but neither
          // provider sends it back to its wire format from a tool message
          // — leaving empty avoids round-tripping a name we don't have.
          // If a future AI SDK version validates this, plumb the original
          // tool name through OLL-E's ToolResultBlock.
          toolName: "",
          output:
            r.is_error
              ? { type: "error-text", value: r.content }
              : { type: "text", value: r.content },
        })),
      });
    }
    if (textParts.length > 0) {
      out.push({ role: "user", content: textParts.join("") });
    }
  }
  return out;
}

function toAssistantMessage(m: Message): ModelMessage {
  if (typeof m.content === "string") {
    return { role: "assistant", content: m.content };
  }
  const parts: AssistantContent = [];
  for (const b of m.content) {
    if (b.type === "text") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "tool_use") {
      const call: ToolCallPart = {
        type: "tool-call",
        toolCallId: b.id,
        toolName: b.name,
        input: b.input,
      };
      parts.push(call);
    } else if (b.type === "thinking") {
      // Echo the thinking block back with its signature so Anthropic
      // accepts the next (tool-use) turn. The provider reads the signature
      // from providerOptions.anthropic and re-emits the wire `thinking` block.
      parts.push({
        type: "reasoning",
        text: b.thinking,
        providerOptions: { anthropic: { signature: b.signature } },
      });
    } else if (b.type === "redacted_thinking") {
      parts.push({
        type: "reasoning",
        text: "",
        providerOptions: { anthropic: { redactedData: b.data } },
      });
    }
  }
  return { role: "assistant", content: parts };
}

/** Reverse direction: AI SDK's final content array → OLL-E ContentBlock[]. */
export function contentPartsToBlocks(
  parts: Awaited<ReturnType<typeof streamText>["content"]>,
): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const p of parts) {
    if (p.type === "text") {
      out.push({ type: "text", text: p.text });
    } else if (p.type === "tool-call") {
      out.push({
        type: "tool_use",
        id: p.toolCallId,
        name: p.toolName,
        input: parseToolInput(p.input),
      });
    } else if (p.type === "reasoning") {
      // Extended-thinking output. The Anthropic provider carries the
      // signature (or redacted blob) in providerMetadata.anthropic; we
      // preserve it on OLL-E's block so the next turn can echo it back
      // verbatim — a tool-use turn 400s otherwise (every OLL-E turn is one).
      const meta = (p.providerMetadata?.anthropic ?? {}) as {
        signature?: string;
        redactedData?: string;
      };
      if (meta.redactedData != null) {
        out.push({ type: "redacted_thinking", data: meta.redactedData });
      } else {
        out.push({ type: "thinking", thinking: p.text, signature: meta.signature ?? "" });
      }
    }
  }
  return out;
}

/** Tool-call inputs are parsed objects in the happy path. Unparsable
 *  ones surface as strings; surface them under `_raw` so the tool
 *  executor sees something rather than silently dropping the call. */
function parseToolInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object") return input as Record<string, unknown>;
  if (typeof input === "string") return { _raw: input };
  return {};
}
