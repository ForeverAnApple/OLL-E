// OpenAI adapter. Maps our generic LLM interface onto the openai SDK's
// chat.completions surface and reports usage (including cache hits) back
// through the Usage shape. Pricing is computed by the caller via
// src/llm/pricing.ts — this adapter does not know dollars.
//
// Caching: OpenAI does automatic prompt caching server-side for
// supported models (no manual cache_control breakpoints). The provider-
// neutral `SystemSegment.cache` markers are accepted but ignored —
// OpenAI decides what to cache. We DO map `prompt_tokens_details.
// cached_tokens` into `Usage.cacheReadInputTokens` so the ledger and
// observability layer see cache hits as physics, same as Anthropic.
// OpenAI has no "cache creation" concept; that field stays 0.
//
// Tool calls: OpenAI splits tool_use and tool_result across separate
// messages (assistant.tool_calls[] + role:"tool" messages). Our
// provider-neutral ContentBlock[] keeps them inside one message; the
// mapping below explodes the neutral shape into the OpenAI shape on
// the way in and recombines on the way out.
//
// Docs: https://platform.openai.com/docs/guides/prompt-caching

import OpenAI from "openai";
import type {
  Completion,
  CompletionRequest,
  ContentBlock,
  Llm,
  Message,
  SystemSegment,
  ToolSpec,
  ToolUseBlock,
  Usage,
} from "./types.ts";
import { createInstrumentedFetch, type FetchLike } from "./instrumented-fetch.ts";

export interface OpenAIAdapterOptions {
  apiKey?: string;
  /** Override default model. */
  model?: string;
  /** Inject a client for tests. */
  client?: OpenAI;
  /** How many transient-failure retries we'll attempt before giving up.
   *  Default 40 to match the Anthropic adapter's ride-out envelope —
   *  OpenAI's overload windows are comparable and we want consistent
   *  resilience regardless of provider. */
  maxRetries?: number;
  /** Override the standard fetch function (primarily for testing retries). */
  fetch?: FetchLike;
}

export const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_MAX_RETRIES = 40;

export function createOpenAIAdapter(opts: OpenAIAdapterOptions = {}): Llm {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

  return {
    provider: "openai",
    defaultModel: opts.model ?? DEFAULT_MODEL,

    async complete(req: CompletionRequest): Promise<Completion> {
      // OpenAI takes the fetch override at client construction, not per-
      // request — so we instantiate a new client per call when onRetry
      // is set (otherwise the instrumented-fetch counter would carry
      // state across logical requests). Client construction is just
      // field assignment; the cost is irrelevant next to the round-trip.
      const fetchOverride = req.onRetry
        ? createInstrumentedFetch(req.onRetry, opts.fetch ?? (fetch as FetchLike))
        : opts.fetch;
      const client =
        opts.client ??
        new OpenAI({
          apiKey: opts.apiKey,
          fetch: fetchOverride,
        });

      const resp = await runStream(client, req, {
        maxRetries,
        signal: req.signal,
      });

      const choice = resp.choices[0];
      if (!choice) {
        throw new Error("OpenAI returned no choices");
      }
      const content = fromOpenAIMessage(choice.message);
      const u = resp.usage;
      const cacheRead = u?.prompt_tokens_details?.cached_tokens ?? 0;
      // OpenAI reports prompt_tokens as TOTAL prompt tokens including
      // cached. Subtract to keep `inputTokens` semantically aligned with
      // Anthropic (uncached input only).
      const inputTokens = Math.max(0, (u?.prompt_tokens ?? 0) - cacheRead);
      const outputTokens = u?.completion_tokens ?? 0;
      const usage: Usage = {
        inputTokens,
        outputTokens,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: 0,
        // Cache reads are billable (cheap) so they count toward total.
        // OpenAI has no cache_creation concept; stays 0.
        totalTokens: inputTokens + outputTokens + cacheRead,
      };

      return {
        content,
        stopReason: mapFinishReason(choice.finish_reason, choice.message.refusal),
        usage,
      };
    },
  };
}

/**
 * Stream a completion. Same single-shape rationale as the Anthropic
 * adapter: the SDK's `.stream()` returns the assembled completion at
 * the end (`finalChatCompletion()`), so we pipe content deltas to
 * `onTextDelta` for live UI and otherwise behave like a non-streaming
 * call. Cost of streaming with no delta listener is essentially zero.
 */
async function runStream(
  client: OpenAI,
  req: CompletionRequest,
  options: { maxRetries: number; signal?: AbortSignal },
): Promise<OpenAI.ChatCompletion> {
  const stream = client.chat.completions.stream(
    {
      model: req.model,
      max_completion_tokens: req.maxTokens,
      temperature: req.temperature,
      messages: buildMessages(req.system, req.messages),
      tools: req.tools?.length ? buildTools(req.tools) : undefined,
    },
    options,
  );
  if (req.onTextDelta) {
    stream.on("content", (delta: string) => {
      try {
        req.onTextDelta?.(delta);
      } catch {
        // A misbehaving subscriber must not blow up the LLM call.
      }
    });
  }
  return await stream.finalChatCompletion();
}

function buildMessages(
  system: CompletionRequest["system"],
  messages: Message[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  if (system) {
    const text = typeof system === "string" ? system : flattenSystemSegments(system);
    if (text.length > 0) {
      out.push({ role: "system", content: text });
    }
  }

  for (const m of messages) {
    if (m.role === "system") {
      // Legacy callers may put system in the messages array; merge it
      // into the leading system message rather than fighting them.
      const text = typeof m.content === "string" ? m.content : extractText(m.content);
      if (text.length > 0) out.push({ role: "system", content: text });
      continue;
    }

    if (m.role === "assistant") {
      out.push(toAssistantMessage(m));
      continue;
    }

    // role === "user" or "tool" — both can carry tool_result blocks
    // (per the Anthropic adapter precedent, "tool" maps to "user" with
    // tool_result content). OpenAI requires tool_result blocks to ride
    // on their own `role: "tool"` messages, so explode them here.
    if (typeof m.content === "string") {
      out.push({ role: "user", content: m.content });
      continue;
    }

    const textParts: string[] = [];
    for (const block of m.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_result") {
        out.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: block.content,
        });
      }
      // tool_use on a user/tool role would be a caller bug; skip.
    }
    if (textParts.length > 0) {
      out.push({ role: "user", content: textParts.join("") });
    }
  }

  return out;
}

function toAssistantMessage(
  m: Message,
): OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam {
  if (typeof m.content === "string") {
    return { role: "assistant", content: m.content };
  }
  const textParts: string[] = [];
  const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
  for (const block of m.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
    // tool_result on assistant would be a caller bug; skip.
  }
  const out: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
    role: "assistant",
    content: textParts.length > 0 ? textParts.join("") : null,
  };
  if (toolCalls.length > 0) out.tool_calls = toolCalls;
  return out;
}

function flattenSystemSegments(segments: SystemSegment[]): string {
  // OpenAI's system role takes a string — cache markers from the
  // provider-neutral SystemSegment are ignored (OpenAI auto-caches).
  // Concatenate with double newlines so segment boundaries survive as
  // paragraph breaks in the rendered prompt.
  return segments
    .filter((s) => s.text.length > 0)
    .map((s) => s.text)
    .join("\n\n");
}

function extractText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function buildTools(tools: ToolSpec[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

function fromOpenAIMessage(
  msg: OpenAI.Chat.Completions.ChatCompletionMessage,
): ContentBlock[] {
  const out: ContentBlock[] = [];
  if (msg.content) {
    out.push({ type: "text", text: msg.content });
  } else if (msg.refusal) {
    // Surface refusal text so the agent can react instead of seeing an
    // empty assistant turn.
    out.push({ type: "text", text: msg.refusal });
  }
  if (msg.tool_calls?.length) {
    for (const call of msg.tool_calls) {
      if (call.type === "function") {
        out.push(toolUseFromFunctionCall(call));
      }
      // custom tool calls — ignore in v0; we only emit function tools.
    }
  }
  return out;
}

function toolUseFromFunctionCall(
  call: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall,
): ToolUseBlock {
  let input: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(call.function.arguments || "{}");
    if (parsed && typeof parsed === "object") {
      input = parsed as Record<string, unknown>;
    }
  } catch {
    // Model produced invalid JSON in arguments. Pass the raw string
    // through under a known key so the tool executor sees something
    // rather than silently dropping the call — invalid arguments are
    // the tool's problem to surface as a typed error.
    input = { _raw: call.function.arguments };
  }
  return {
    type: "tool_use",
    id: call.id,
    name: call.function.name,
    input,
  };
}

function mapFinishReason(
  reason: OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"],
  refusal: string | null,
): Completion["stopReason"] {
  // Refusal beats finish_reason — OpenAI may set finish_reason="stop"
  // even when content was suppressed and refusal carries the message.
  if (refusal) return "refusal";
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    case "stop":
    default:
      return "end_turn";
  }
}
