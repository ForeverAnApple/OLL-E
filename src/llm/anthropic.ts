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
import { createInstrumentedFetch, type FetchLike } from "./instrumented-fetch.ts";

export interface AnthropicAdapterOptions {
  apiKey?: string;
  /** Override default model. */
  model?: string;
  /** Inject a client for tests. */
  client?: Anthropic;
  /** How many transient-failure retries we'll attempt before giving up.
   *  Default 40. The SDK's backoff is `min(0.5 * 2^n, 8s)` per attempt
   *  with jitter, so the first ~4 retries climb 0.5→8s and the remaining
   *  ~36 sit at the 8s cap → ~5 minutes of ride-out, enough to coast
   *  through Anthropic's typical overload windows. */
  maxRetries?: number;
  /** Override the standard fetch function (primarily for testing retries). */
  fetch?: FetchLike;
}

export const DEFAULT_MODEL = "claude-opus-4-7";
const DEFAULT_MAX_RETRIES = 40;

export function createAnthropicAdapter(opts: AnthropicAdapterOptions = {}): Llm {
  // Caller resolves the key from the secrets store and passes it explicitly.
  // No env fallback — secrets have one source of truth (~/.olle/secrets/).
  const client =
    opts.client ??
    new Anthropic({
      apiKey: opts.apiKey,
    });
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

  return {
    provider: "anthropic",
    defaultModel: opts.model ?? DEFAULT_MODEL,

    async complete(req: CompletionRequest): Promise<Completion> {
      // Wrap fetch only if the caller is listening for retry events.
      // Otherwise pass through opts.fetch (or undefined → SDK default).
      const fetchWrapper = req.onRetry
        ? createInstrumentedFetch(req.onRetry, opts.fetch ?? fetch)
        : opts.fetch;

      const resp = await runStream(client, req, {
        maxRetries,
        signal: req.signal,
        ...(fetchWrapper && { fetch: fetchWrapper }),
      });

      const content: ContentBlock[] = resp.content.map(fromAnthropicBlock);
      const cacheRead = readCacheField(resp.usage, "cache_read_input_tokens");
      const cacheCreation = readCacheField(resp.usage, "cache_creation_input_tokens");
      const usage: Usage = {
        inputTokens: resp.usage.input_tokens,
        outputTokens: resp.usage.output_tokens,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: cacheCreation,
        // Cache reads (cheap) and cache creation (premium) are both
        // billable, so they count toward total. Don't "fix" this formula.
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

/**
 * Stream a completion. The SDK's streaming surface still returns the
 * fully assembled message at the end (`finalMessage()`), so we pipe
 * text deltas to `onTextDelta` for live UI and then return the same
 * non-streaming-shaped response the adapter would otherwise build.
 *
 * Why always stream, even if no one's listening? It keeps the request
 * path single-shaped (one HTTP path, one place where errors surface)
 * and the cost when no delta callback is set is essentially zero — the
 * deltas just get discarded.
 */
async function runStream(
  client: Anthropic,
  req: CompletionRequest,
  options: Anthropic.RequestOptions,
): Promise<Anthropic.Messages.Message> {
  const stream = client.messages.stream(
    {
      model: req.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      system: buildSystem(req.system),
      messages: buildMessages(req.messages),
      tools: req.tools?.length ? buildTools(req.tools) : undefined,
    } as Anthropic.Messages.MessageCreateParamsStreaming,
    options,
  );
  if (req.onTextDelta) {
    stream.on("text", (delta: string) => {
      try {
        req.onTextDelta?.(delta);
      } catch {
        // A misbehaving subscriber must not blow up the LLM call.
      }
    });
  }
  return await stream.finalMessage();
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
 * Caches the conversation prefix through that point so each subsequent
 * turn (which appends a new user message) reads through it. Without
 * this, multi-turn agent loops re-charge the entire conversation every
 * turn.
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
      // Newer stop reasons ("pause_turn" etc) — map to end_turn so v0
      // keeps moving. Refusal is the one case we propagate distinctly.
      return r === "refusal" ? "refusal" : "end_turn";
  }
}

// Cache fields are present on the SDK's usage type but nullable across
// SDK minor versions; some return null when caching is disabled or the
// provider didn't report. Normalize to a number.
function readCacheField(
  usage: Anthropic.Messages.Usage,
  field: "cache_read_input_tokens" | "cache_creation_input_tokens",
): number {
  const raw = (usage as unknown as Record<string, unknown>)[field];
  return typeof raw === "number" ? raw : 0;
}
