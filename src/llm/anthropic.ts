// Anthropic adapter. Maps our generic LLM interface onto the
// @anthropic-ai/sdk messages.create surface and reports usage (including
// cache stats) back through the Usage shape. Pricing is computed by the
// caller via src/llm/pricing.ts — this adapter does not know dollars.
//
// Caching strategy (LOG 2026-04-24): four breakpoints, all ephemeral.
//
//   1) System prompt — caller can pass either a single string (cached as
//      one block) or a SystemSegment[] where they decide which segments
//      get cache_control. The chat loop uses the segment form to keep the
//      stable identity/principles cached while the volatile mailbox
//      sidebar sits after the breakpoint and never invalidates the prefix.
//
//   2) Tools block — last tool gets cache_control. Tools change less
//      often than the conversation; one cache point covers the whole
//      tool list.
//
//   3) Last user message — the conversation prefix up through this
//      message gets cached. Next turn's append-only growth reads through
//      the cache. Standard Anthropic conversation-cache pattern.
//
// All four are dumb-but-effective baselines. The propose-up loop lets
// agents file LOG entries when they observe the strategy underperforming
// in their own ledger (per the new AGENTS.md vision-check section).
//
// Docs: https://docs.anthropic.com/en/docs/prompt-caching

import Anthropic from "@anthropic-ai/sdk";
import type {
  Completion,
  CompletionRequest,
  ContentBlock,
  Llm,
  Message,
  SystemSegment,
  ToolSpec,
  Usage,
} from "./types.ts";

export interface AnthropicAdapterOptions {
  apiKey?: string;
  /** Override default model. */
  model?: string;
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
        messages: buildMessages(req.messages),
        tools: req.tools?.length ? buildTools(req.tools) : undefined,
      } as Anthropic.Messages.MessageCreateParamsNonStreaming);

      const content: ContentBlock[] = resp.content.map(fromAnthropicBlock);
      const cacheRead = readCacheField(resp.usage, "cache_read_input_tokens");
      const cacheCreation = readCacheField(resp.usage, "cache_creation_input_tokens");
      const usage: Usage = {
        inputTokens: resp.usage.input_tokens,
        outputTokens: resp.usage.output_tokens,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: cacheCreation,
        // total = everything billed this call. Cache reads are billable
        // (cheap), so they count; cache creation is also billable
        // (premium), so it counts.
        totalTokens:
          resp.usage.input_tokens +
          resp.usage.output_tokens +
          cacheRead +
          cacheCreation,
      };

      return {
        content,
        stopReason: mapStopReason(resp.stop_reason),
        usage,
      };
    },
  };
}

function buildSystem(
  system: CompletionRequest["system"],
): Anthropic.Messages.MessageCreateParamsNonStreaming["system"] {
  if (!system) return undefined;
  const segments: SystemSegment[] =
    typeof system === "string" ? [{ text: system, cache: "ephemeral" }] : system;
  return segments
    .filter((s) => s.text.length > 0)
    .map((s) => {
      const block: Anthropic.Messages.TextBlockParam = { type: "text", text: s.text };
      if (s.cache === "ephemeral") {
        block.cache_control = { type: "ephemeral" };
      }
      return block;
    });
}

function buildTools(tools: ToolSpec[]): Anthropic.Messages.Tool[] {
  return tools.map((t, i) => {
    const out: Anthropic.Messages.Tool = {
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
    };
    // Cache the whole tool block by marking the LAST tool. Anthropic
    // caches contiguous prefix up through the last cache_control mark,
    // so one mark covers the whole tools array.
    if (i === tools.length - 1) {
      (out as { cache_control?: { type: "ephemeral" } }).cache_control = {
        type: "ephemeral",
      };
    }
    return out;
  });
}

/**
 * Build messages with a cache breakpoint on the LAST USER MESSAGE.
 * This caches the conversation prefix through that point so each
 * subsequent turn (which appends a new user message) reads through it.
 * Without this, multi-turn agent loops re-charge the entire conversation
 * every turn.
 */
function buildMessages(messages: Message[]): Anthropic.Messages.MessageParam[] {
  const out = messages.map(toAnthropicMessage);
  const lastUserIdx = findLastUserIndex(out);
  if (lastUserIdx >= 0) {
    out[lastUserIdx] = withTrailingCacheControl(out[lastUserIdx]!);
  }
  return out;
}

function findLastUserIndex(messages: Anthropic.Messages.MessageParam[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return i;
  }
  return -1;
}

function withTrailingCacheControl(
  m: Anthropic.Messages.MessageParam,
): Anthropic.Messages.MessageParam {
  // String content can't carry cache_control directly; normalize to one
  // text block, then mark it.
  if (typeof m.content === "string") {
    return {
      ...m,
      content: [
        {
          type: "text",
          text: m.content,
          cache_control: { type: "ephemeral" },
        },
      ],
    };
  }
  const blocks = m.content.slice();
  const last = blocks[blocks.length - 1];
  if (!last) return m;
  // Tool-result blocks accept cache_control too; text blocks definitely do.
  // Spreading is enough to attach the field — vendor types accept it on
  // every block kind we emit.
  blocks[blocks.length - 1] = {
    ...(last as object),
    cache_control: { type: "ephemeral" },
  } as typeof last;
  return { ...m, content: blocks };
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

// Cache fields are present on the SDK's usage type but are nullable
// across SDK minor versions; some return null when caching is disabled
// or the provider didn't report. Normalize to a number.
function readCacheField(
  usage: Anthropic.Messages.Usage,
  field: "cache_read_input_tokens" | "cache_creation_input_tokens",
): number {
  const raw = (usage as unknown as Record<string, unknown>)[field];
  return typeof raw === "number" ? raw : 0;
}
