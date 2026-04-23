// Anthropic adapter. Maps our generic LLM interface onto the
// @anthropic-ai/sdk messages.create surface and reports usage for the
// ledger. Prompt caching is on-by-default for the system prompt and
// tools block (see docs: https://docs.anthropic.com/en/docs/prompt-caching).

import Anthropic from "@anthropic-ai/sdk";
import type {
  Completion,
  CompletionRequest,
  ContentBlock,
  Llm,
  Message,
  ToolSpec,
  Usage,
} from "./types.ts";

export interface AnthropicAdapterOptions {
  apiKey?: string;
  /** Override default model. */
  model?: string;
  /** micro-USD per million input tokens; adapter doesn't hard-code rates. */
  pricePerMTokIn?: number;
  pricePerMTokOut?: number;
  /** Inject a client for tests. */
  client?: Anthropic;
}

export const DEFAULT_MODEL = "claude-opus-4-7";

export function createAnthropicAdapter(opts: AnthropicAdapterOptions = {}): Llm {
  const client =
    opts.client ??
    new Anthropic({
      apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY,
    });

  return {
    provider: "anthropic",
    defaultModel: opts.model ?? DEFAULT_MODEL,

    async complete(req: CompletionRequest): Promise<Completion> {
      const resp = await client.messages.create({
        model: req.model,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        system: buildSystem(req.system),
        messages: req.messages.map(toAnthropicMessage),
        tools: req.tools?.length ? req.tools.map(toAnthropicTool) : undefined,
      } as Anthropic.Messages.MessageCreateParamsNonStreaming);

      const content: ContentBlock[] = resp.content.map(fromAnthropicBlock);
      const usage: Usage = {
        inputTokens: resp.usage.input_tokens,
        outputTokens: resp.usage.output_tokens,
        totalTokens: resp.usage.input_tokens + resp.usage.output_tokens,
      };
      const usdMicros = computeUsd(usage, opts);

      return {
        content,
        stopReason: mapStopReason(resp.stop_reason),
        usage,
        usdMicros,
      };
    },
  };
}

function buildSystem(
  system: string | undefined,
): Anthropic.Messages.MessageCreateParamsNonStreaming["system"] {
  if (!system) return undefined;
  // Cache-breakpoint the system prompt so long conversations don't
  // re-charge the prefix.
  return [
    {
      type: "text",
      text: system,
      cache_control: { type: "ephemeral" },
    },
  ];
}

function toAnthropicMessage(m: Message): Anthropic.Messages.MessageParam {
  if (m.role === "system") throw new Error("system must be passed via `system`, not messages");
  const role = m.role === "tool" ? "user" : (m.role as "user" | "assistant");
  const content =
    typeof m.content === "string"
      ? m.content
      : (m.content.map((b) => {
          if (b.type === "text") return { type: "text" as const, text: b.text };
          if (b.type === "tool_use") return { type: "tool_use" as const, id: b.id, name: b.name, input: b.input };
          return {
            type: "tool_result" as const,
            tool_use_id: b.tool_use_id,
            content: b.content,
            is_error: b.is_error,
          };
        }) as Anthropic.Messages.MessageParam["content"]);
  return { role, content };
}

function toAnthropicTool(t: ToolSpec): Anthropic.Messages.Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
  };
}

function fromAnthropicBlock(b: Anthropic.Messages.ContentBlock): ContentBlock {
  if (b.type === "text") return { type: "text", text: b.text };
  if (b.type === "tool_use")
    return {
      type: "tool_use",
      id: b.id,
      name: b.name,
      input: b.input as Record<string, unknown>,
    };
  // thinking blocks etc — represent as text for v0
  return { type: "text", text: JSON.stringify(b) };
}

function mapStopReason(
  r: Anthropic.Messages.Message["stop_reason"] | null,
): Completion["stopReason"] {
  switch (r) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "end_turn":
      return "end_turn";
    default:
      // Newer stop reasons ("refusal", "pause_turn", etc) — map to
      // end_turn so v0 keeps moving. Adapters can refine later.
      return r === "refusal" ? "refusal" : "end_turn";
  }
}

// Rough default prices (micro-USD per million tokens) for Opus 4.7; override
// via options when prices change. Kept as a fallback so the ledger always
// writes a non-zero-ish number rather than forcing configuration.
const DEFAULT_PRICE_IN_MICROS = 15_000_000;
const DEFAULT_PRICE_OUT_MICROS = 75_000_000;

function computeUsd(usage: Usage, opts: AnthropicAdapterOptions): number {
  const inMicros = opts.pricePerMTokIn ?? DEFAULT_PRICE_IN_MICROS;
  const outMicros = opts.pricePerMTokOut ?? DEFAULT_PRICE_OUT_MICROS;
  return (
    (usage.inputTokens * inMicros) / 1_000_000 +
    (usage.outputTokens * outMicros) / 1_000_000
  );
}
