// Adapter-level retry behavior. We don't ping the real API here — we
// inject a fake client that throws Anthropic.APIError instances and
// confirm the loop classifies, sleeps, and surfaces retries correctly.
//
// Regression guard: the retry handling was silently dropped during a
// ledger refactor; users got raw "API overloaded" errors back-to-back
// because the SDK's default 2-retry budget didn't ride out short
// overload windows. This file pins the new behavior in place.

import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicAdapter } from "../src/llm/anthropic.ts";
import type { CompletionRequest, RetryInfo } from "../src/llm/types.ts";

function makeApiError(status: number, message = "boom"): InstanceType<typeof Anthropic.APIError> {
  return new Anthropic.APIError(status, undefined, message, new Headers());
}

/**
 * Build a fake Anthropic client whose `messages.stream(...)` produces a
 * stream-like object matching what the adapter consumes (`on("text", ...)`
 * + `finalMessage()`). Each handler in `handlers` is consumed once per
 * stream call; the last is reused if more attempts than handlers occur.
 */
function fakeClient(handlers: Array<() => Promise<unknown>>): Anthropic {
  let i = 0;
  return {
    messages: {
      stream: () => {
        const h = handlers[Math.min(i, handlers.length - 1)]!;
        i++;
        const promise = h();
        return {
          on: () => {},
          finalMessage: () => promise,
        };
      },
    },
  } as unknown as Anthropic;
}

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

describe("anthropic adapter streaming", () => {
  test("forwards text deltas to req.onTextDelta and assembles the final message", async () => {
    const deltas: string[] = [];
    // Custom fake stream that emits two text deltas before resolving.
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
    const llm = createAnthropicAdapter({
      client,
      maxRetries: 0,
      retryInitialMs: 1,
      retryMaxMs: 5,
      sleep: async () => {},
    });
    const out = await llm.complete({ ...baseReq, onTextDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual(["hello ", "world"]);
    expect(out.content[0]).toMatchObject({ type: "text", text: "ok" });
  });
});

describe("anthropic adapter retry", () => {
  test("rides out a transient 529 and succeeds, calling onRetry once", async () => {
    const sleeps: number[] = [];
    const retries: RetryInfo[] = [];
    const llm = createAnthropicAdapter({
      client: fakeClient([
        () => Promise.reject(makeApiError(529, "overloaded")),
        () => Promise.resolve(successResp),
      ]),
      maxRetries: 4,
      retryInitialMs: 10,
      retryMaxMs: 100,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const out = await llm.complete({ ...baseReq, onRetry: (i) => retries.push(i) });
    expect(out.stopReason).toBe("end_turn");
    expect(retries.length).toBe(1);
    expect(retries[0]?.attempt).toBe(1);
    expect(retries[0]?.status).toBe(529);
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThan(0);
  });

  test("retries on 503/429 too and counts attempts", async () => {
    const retries: RetryInfo[] = [];
    const llm = createAnthropicAdapter({
      client: fakeClient([
        () => Promise.reject(makeApiError(503)),
        () => Promise.reject(makeApiError(429)),
        () => Promise.resolve(successResp),
      ]),
      maxRetries: 4,
      retryInitialMs: 1,
      retryMaxMs: 5,
      sleep: async () => {},
    });
    await llm.complete({ ...baseReq, onRetry: (i) => retries.push(i) });
    expect(retries.map((r) => r.status)).toEqual([503, 429]);
  });

  test("does NOT retry on a non-transient 400", async () => {
    let calls = 0;
    const llm = createAnthropicAdapter({
      client: fakeClient([
        () => {
          calls++;
          return Promise.reject(makeApiError(400, "bad request"));
        },
      ]),
      maxRetries: 4,
      retryInitialMs: 1,
      retryMaxMs: 5,
      sleep: async () => {},
    });
    await expect(llm.complete(baseReq)).rejects.toThrow(/bad request/);
    expect(calls).toBe(1);
  });

  test("after exhausting retries, throws a clean rewrapped error", async () => {
    const llm = createAnthropicAdapter({
      client: fakeClient([() => Promise.reject(makeApiError(529))]),
      maxRetries: 2,
      retryInitialMs: 1,
      retryMaxMs: 5,
      sleep: async () => {},
    });
    await expect(llm.complete(baseReq)).rejects.toThrow(/overloaded.*after 2 retries/);
  });
});
