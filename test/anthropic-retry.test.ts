// Retry observability behavior. The Anthropic SDK owns the retry loop
// (we pass `maxRetries` and let it back off internally); our code's
// contribution is `createInstrumentedFetch`, which observes the SDK
// re-invoking fetch and surfaces those as onRetry callbacks. These
// tests pin that wrapper in isolation plus the adapter's streaming
// text-delta forwarding.
//
// Regression guard: a prior refactor silently dropped retry handling
// entirely, leaving users staring at raw "API overloaded" errors. The
// retries now live in the SDK, but we still need to know the wrapper
// fires onRetry on every retry attempt and not on the first call.

import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicAdapter } from "../src/llm/anthropic.ts";
import { createInstrumentedFetch, type FetchLike } from "../src/llm/instrumented-fetch.ts";
import type { CompletionRequest, RetryInfo } from "../src/llm/types.ts";

const successResp = {
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

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
  test("forwards text deltas to req.onTextDelta and assembles the final message", async () => {
    const deltas: string[] = [];
    const client = {
      messages: {
        stream: () => {
          const handlers = new Map<string, (s: string) => void>();
          const finalPromise = (async () => {
            // Let the adapter attach its listener first.
            await Promise.resolve();
            handlers.get("text")?.("hello ");
            handlers.get("text")?.("world");
            return successResp;
          })();
          return {
            on: (ev: string, fn: (s: string) => void) => {
              handlers.set(ev, fn);
            },
            finalMessage: () => finalPromise,
          };
        },
      },
    } as unknown as Anthropic;
    const llm = createAnthropicAdapter({ client });
    const out = await llm.complete({ ...baseReq, onTextDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual(["hello ", "world"]);
    expect(out.content[0]).toMatchObject({ type: "text", text: "ok" });
  });
});
