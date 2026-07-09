// Retry observability behavior. The Vercel AI SDK owns the retry loop;
// our code's contribution is `createInstrumentedFetch`, which observes
// the SDK re-invoking fetch and surfaces those as onRetry callbacks.
// These tests pin that wrapper in isolation plus the adapter's
// streaming text-delta forwarding.
//
// Regression guard: a prior refactor silently dropped retry handling
// entirely, leaving users staring at raw "API overloaded" errors. The
// retries now live in the SDK, but we still need to know the wrapper
// fires onRetry on every retry attempt and not on the first call.

import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { createAnthropicAdapter } from "../src/llm/anthropic.ts";
import { createInstrumentedFetch, type FetchLike } from "../src/llm/instrumented-fetch.ts";
import type { CompletionRequest, RetryInfo } from "../src/llm/types.ts";
import { streamOf } from "./_helpers/mock-stream.ts";

const baseReq: CompletionRequest = {
  model: "claude-opus-4-7",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 16,
};

describe("createInstrumentedFetch", () => {
  test("does not fire onRetry on the first call", async () => {
    const retries: RetryInfo[] = [];
    const fakeFetch = (async () => new Response("ok", { status: 200 })) as FetchLike;
    const instrumented = createInstrumentedFetch((info) => retries.push(info), fakeFetch);
    await instrumented("https://example.com");
    expect(retries).toEqual([]);
  });

  test("fires onRetry on every call past the first, carrying prior status", async () => {
    const retries: RetryInfo[] = [];
    let n = 0;
    const fakeFetch = (async () => {
      n++;
      if (n === 1) return new Response("overloaded", { status: 529, statusText: "Overloaded" });
      if (n === 2) return new Response("rate limited", { status: 429, statusText: "Too Many" });
      return new Response("ok", { status: 200, statusText: "OK" });
    }) as FetchLike;
    const instrumented = createInstrumentedFetch((info) => retries.push(info), fakeFetch);
    await instrumented("https://example.com");
    await instrumented("https://example.com");
    await instrumented("https://example.com");
    expect(retries.map((r) => ({ attempt: r.attempt, status: r.status }))).toEqual([
      { attempt: 1, status: 529 },
      { attempt: 2, status: 429 },
    ]);
  });

  test("surfaces network-level errors with the thrown message", async () => {
    const retries: RetryInfo[] = [];
    let n = 0;
    const fakeFetch = (async () => {
      n++;
      if (n === 1) throw new Error("ECONNRESET");
      return new Response("ok", { status: 200 });
    }) as FetchLike;
    const instrumented = createInstrumentedFetch((info) => retries.push(info), fakeFetch);
    await expect(instrumented("https://example.com")).rejects.toThrow("ECONNRESET");
    await instrumented("https://example.com");
    expect(retries).toEqual([
      { attempt: 1, status: undefined, message: "ECONNRESET" },
    ]);
  });
});

describe("anthropic adapter streaming", () => {
  test("forwards text deltas to req.onTextDelta and assembles the final content", async () => {
    const deltas: string[] = [];
    const model = new MockLanguageModelV3({
      provider: "anthropic",
      modelId: "claude-opus-4-7",
      doStream: async () => ({
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "hello " },
          { type: "text-delta", id: "t1", delta: "world" },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 2, text: 2, reasoning: 0 },
            },
            finishReason: { unified: "stop", raw: undefined },
          },
        ]),
      }),
    });
    const llm = createAnthropicAdapter({ languageModel: model });
    const out = await llm.complete({ ...baseReq, onTextDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual(["hello ", "world"]);
    expect(out.content).toEqual([{ type: "text", text: "hello world" }]);
    expect(out.stopReason).toBe("end_turn");
  });

  test("forwards reasoning deltas to req.onReasoningDelta and keeps the thinking block", async () => {
    const thinkingDeltas: string[] = [];
    const textDeltas: string[] = [];
    let capturedOptions: { providerOptions?: Record<string, unknown> } | undefined;
    const model = new MockLanguageModelV3({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      doStream: async (options) => {
        capturedOptions = options as typeof capturedOptions;
        return {
          stream: streamOf([
            { type: "stream-start", warnings: [] },
            { type: "reasoning-start", id: "r1" },
            { type: "reasoning-delta", id: "r1", delta: "let me " },
            { type: "reasoning-delta", id: "r1", delta: "mull" },
            { type: "reasoning-end", id: "r1" },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "answer" },
            { type: "text-end", id: "t1" },
            {
              type: "finish",
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 5, text: 2, reasoning: 3 },
              },
              finishReason: { unified: "stop", raw: undefined },
            },
          ]),
        };
      },
    });
    const llm = createAnthropicAdapter({ languageModel: model });
    const out = await llm.complete({
      ...baseReq,
      effort: "medium",
      onTextDelta: (d) => textDeltas.push(d),
      onReasoningDelta: (d) => thinkingDeltas.push(d),
    });
    expect(thinkingDeltas).toEqual(["let me ", "mull"]);
    expect(textDeltas).toEqual(["answer"]);
    // The assembled thinking block still lands in content (needed for the
    // signature echo on the next turn), alongside the text.
    expect(out.content).toEqual([
      { type: "thinking", thinking: "let me mull", signature: "" },
      { type: "text", text: "answer" },
    ]);
    // Effort must reach the wire as adaptive thinking with summarized
    // display — the Opus 4.7+ default ("omitted") returns empty thinking
    // text, which would make the whole streaming path render nothing.
    const anthropicOpts = capturedOptions?.providerOptions?.anthropic as {
      thinking?: { type: string; display?: string };
      effort?: string;
    };
    expect(anthropicOpts?.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(anthropicOpts?.effort).toBe("medium");
  });
});
