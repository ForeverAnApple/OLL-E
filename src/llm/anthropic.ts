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
  RetryInfo,
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
  /** How many transient-failure retries we'll attempt before giving up.
   *  Default 12, which with the capped backoff below buys ~5–6 minutes
   *  of ride-out — enough to coast through Anthropic's typical overload
   *  windows without surfacing a crash to the user. */
  maxRetries?: number;
  /** Initial backoff in ms (doubled with jitter on each retry). */
  retryInitialMs?: number;
  /** Cap on per-retry sleep. Backoff plateaus here so we don't sit idle
   *  for minutes on a single attempt. */
  retryMaxMs?: number;
  /** Override the sleeper (tests inject a synchronous one). */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_MODEL = "claude-opus-4-7";
const DEFAULT_MAX_RETRIES = 12;
const DEFAULT_RETRY_INITIAL_MS = 1000;
const DEFAULT_RETRY_MAX_MS = 30_000;

export function createAnthropicAdapter(opts: AnthropicAdapterOptions = {}): Llm {
  // We own the retry loop; disable the SDK's so the two layers don't compound.
  const client =
    opts.client ??
    new Anthropic({
      // Caller (the daemon) resolves the key from the secrets store and
      // passes it explicitly. No env fallback — secrets have one source of
      // truth (~/.olle/secrets/), env is reserved for behavior toggles.
      apiKey: opts.apiKey,
      maxRetries: 0,
    });
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const initialMs = opts.retryInitialMs ?? DEFAULT_RETRY_INITIAL_MS;
  const maxMs = opts.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  const sleep = opts.sleep ?? defaultSleep;

  return {
    provider: "anthropic",
    defaultModel: opts.model ?? DEFAULT_MODEL,

    async complete(req: CompletionRequest): Promise<Completion> {
      const resp = await callWithRetry(
        () => runStream(client, req),
        { maxRetries, initialMs, maxMs, sleep, onRetry: req.onRetry },
      );

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

/**
 * Stream a completion. The SDK's streaming surface still returns the
 * fully assembled message at the end (`finalMessage()`), so we pipe
 * text deltas to `onTextDelta` for live UI and then return the same
 * non-streaming-shaped response the adapter would otherwise build.
 *
 * Why always stream, even if no one's listening? It keeps the request
 * path single-shaped (one HTTP path, one place where transient errors
 * surface), and the cost of streaming when no delta callback is set is
 * essentially zero — we just discard the deltas.
 */
async function runStream(
  client: Anthropic,
  req: CompletionRequest,
): Promise<Anthropic.Messages.Message> {
  // Built as a loose object so the conditional `thinking`/`output_config`
  // fields are easy to attach; cast once to the SDK param type at the call.
  // Both are GA on the request surface (no beta header).
  const params: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: buildSystem(req.system),
    messages: buildMessages(req.messages),
  };
  if (req.tools?.length) params.tools = buildTools(req.tools);
  if (req.effort) {
    // Reasoning effort ⇒ adaptive thinking + effort dial. Opus 4.7/4.8
    // reject temperature/top_p/top_k, so we never send sampling params
    // alongside effort.
    params.thinking = { type: "adaptive" };
    params.output_config = { effort: req.effort };
  } else if (req.temperature !== undefined) {
    params.temperature = req.temperature;
  }
  const stream = client.messages.stream(
    params as unknown as Anthropic.Messages.MessageCreateParamsStreaming,
    req.signal ? { signal: req.signal } : undefined,
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
          // Echo thinking blocks back verbatim — the API matches the
          // signature against the assistant turn it accompanies.
          if (b.type === "thinking")
            return { type: "thinking" as const, thinking: b.thinking, signature: b.signature };
          if (b.type === "redacted_thinking")
            return { type: "redacted_thinking" as const, data: b.data };
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
  // Preserve thinking blocks verbatim (text + signature). The signature is
  // load-bearing: the API requires it echoed back on the next turn, so we
  // must keep the block intact rather than flatten it to text.
  if (b.type === "thinking")
    return { type: "thinking", thinking: b.thinking, signature: b.signature };
  if (b.type === "redacted_thinking") return { type: "redacted_thinking", data: b.data };
  // Unknown future block types — represent as text so the loop keeps moving.
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

interface RetryOpts {
  maxRetries: number;
  initialMs: number;
  maxMs: number;
  sleep: (ms: number) => Promise<void>;
  onRetry?: (info: RetryInfo) => void;
}

/**
 * Retries `fn` on transient Anthropic failures (overload, rate limit, 5xx)
 * with exponential backoff capped at `maxMs`. Surfaces every retry through
 * the optional `onRetry` so the surrounding loop can show "API busy" status
 * instead of letting the user stare at a frozen prompt.
 *
 * Non-transient errors (4xx other than 408/409/429) bypass retry entirely.
 * On exhaustion we rewrap the last error into a clean message — the raw
 * APIError's stack-shaped string is hostile in chat output.
 */
async function callWithRetry<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt > opts.maxRetries) break;
      // Decorrelated jitter: pick uniformly in [initial, prev*3], cap at maxMs.
      // Smooths the herd if many requests hit overload at once.
      const base = Math.min(opts.maxMs, opts.initialMs * 2 ** (attempt - 1));
      const waitMs = Math.min(opts.maxMs, opts.initialMs + Math.random() * base);
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      const message =
        err instanceof Error ? err.message : typeof err === "string" ? err : undefined;
      opts.onRetry?.({ attempt, status, waitMs, message });
      await opts.sleep(waitMs);
    }
  }
  throw rewrapTransient(lastErr, opts.maxRetries);
}

function isTransient(err: unknown): boolean {
  if (!(err instanceof Anthropic.APIError)) return false;
  const s = err.status;
  if (!s) return true; // network-level failure with no HTTP status — worth retrying
  return s === 408 || s === 409 || s === 429 || s >= 500;
}

function rewrapTransient(err: unknown, maxRetries: number): Error {
  if (err instanceof Anthropic.APIError) {
    const s = err.status;
    if (s === 529 || s === 503) {
      return new Error(
        `Anthropic API overloaded (HTTP ${s}) after ${maxRetries} retries — try again shortly`,
      );
    }
    if (s === 429) {
      return new Error(
        `Anthropic rate limit hit (HTTP 429) after ${maxRetries} retries — back off and retry`,
      );
    }
    if (s && s >= 500) {
      return new Error(
        `Anthropic server error (HTTP ${s}) after ${maxRetries} retries: ${err.message}`,
      );
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
