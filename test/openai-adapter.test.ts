// OpenAI adapter: provider-neutral mapping, streaming text deltas,
// cache-read accounting, and stop-reason translation. Retry surface
// is exercised by the shared createInstrumentedFetch tests — OpenAI
// inherits that wrapper unchanged.

import { describe, expect, test } from "bun:test";
import OpenAI from "openai";
import { createOpenAIAdapter } from "../src/llm/openai.ts";
import type { CompletionRequest } from "../src/llm/types.ts";

interface FakeStreamResult {
  /** Optional content deltas to emit before resolving. */
  contentDeltas?: string[];
  /** The completion the stream resolves to. */
  completion: OpenAI.ChatCompletion;
}

function fakeClient(results: FakeStreamResult[]): OpenAI {
  let i = 0;
  return {
    chat: {
      completions: {
        stream: () => {
          const res = results[Math.min(i, results.length - 1)]!;
          i++;
          const handlers = new Map<string, (s: string) => void>();
          const finalPromise = (async () => {
            // Let the adapter attach listeners first.
            await Promise.resolve();
            for (const d of res.contentDeltas ?? []) {
              handlers.get("content")?.(d);
            }
            return res.completion;
          })();
          return {
            on: (ev: string, fn: (s: string) => void) => {
              handlers.set(ev, fn);
            },
            finalChatCompletion: () => finalPromise,
          };
        },
      },
    },
  } as unknown as OpenAI;
}

function chatCompletion(overrides: {
  content?: string | null;
  refusal?: string | null;
  tool_calls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
  finish_reason?: OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"];
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
}): OpenAI.ChatCompletion {
  return {
    id: "fake",
    object: "chat.completion",
    created: 0,
    model: "gpt-5",
    choices: [
      {
        index: 0,
        finish_reason: overrides.finish_reason ?? "stop",
        logprobs: null,
        message: {
          role: "assistant",
          content: overrides.content ?? null,
          refusal: overrides.refusal ?? null,
          ...(overrides.tool_calls ? { tool_calls: overrides.tool_calls } : {}),
        } as OpenAI.Chat.Completions.ChatCompletionMessage,
      },
    ],
    usage: {
      prompt_tokens: overrides.prompt_tokens ?? 10,
      completion_tokens: overrides.completion_tokens ?? 5,
      total_tokens: (overrides.prompt_tokens ?? 10) + (overrides.completion_tokens ?? 5),
      ...(overrides.cached_tokens !== undefined
        ? { prompt_tokens_details: { cached_tokens: overrides.cached_tokens } }
        : {}),
    },
  };
}

const baseReq: CompletionRequest = {
  model: "gpt-5",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 16,
};

describe("openai adapter streaming", () => {
  test("forwards content deltas and returns the assembled message", async () => {
    const deltas: string[] = [];
    const client = fakeClient([
      {
        contentDeltas: ["hello ", "world"],
        completion: chatCompletion({ content: "hello world" }),
      },
    ]);
    const llm = createOpenAIAdapter({ client });
    const out = await llm.complete({ ...baseReq, onTextDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual(["hello ", "world"]);
    expect(out.content).toEqual([{ type: "text", text: "hello world" }]);
    expect(out.stopReason).toBe("end_turn");
  });
});

describe("openai adapter usage mapping", () => {
  test("subtracts cached_tokens from inputTokens and reports cache reads", async () => {
    const client = fakeClient([
      {
        completion: chatCompletion({
          content: "ok",
          prompt_tokens: 100,
          completion_tokens: 20,
          cached_tokens: 60,
        }),
      },
    ]);
    const llm = createOpenAIAdapter({ client });
    const out = await llm.complete(baseReq);
    expect(out.usage).toEqual({
      inputTokens: 40, // 100 - 60 cached
      outputTokens: 20,
      cacheReadInputTokens: 60,
      cacheCreationInputTokens: 0,
      totalTokens: 120, // 40 + 20 + 60
    });
  });

  test("handles missing prompt_tokens_details (no cache)", async () => {
    const client = fakeClient([
      {
        completion: chatCompletion({
          content: "ok",
          prompt_tokens: 10,
          completion_tokens: 5,
        }),
      },
    ]);
    const llm = createOpenAIAdapter({ client });
    const out = await llm.complete(baseReq);
    expect(out.usage.cacheReadInputTokens).toBe(0);
    expect(out.usage.inputTokens).toBe(10);
  });
});

describe("openai adapter stop reasons", () => {
  test("tool_calls finish_reason → tool_use", async () => {
    const client = fakeClient([
      {
        completion: chatCompletion({
          finish_reason: "tool_calls",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "do_thing", arguments: '{"x": 1}' },
            },
          ],
        }),
      },
    ]);
    const llm = createOpenAIAdapter({ client });
    const out = await llm.complete(baseReq);
    expect(out.stopReason).toBe("tool_use");
    expect(out.content).toEqual([
      { type: "tool_use", id: "call_1", name: "do_thing", input: { x: 1 } },
    ]);
  });

  test("length finish_reason → max_tokens", async () => {
    const client = fakeClient([
      { completion: chatCompletion({ content: "...", finish_reason: "length" }) },
    ]);
    const llm = createOpenAIAdapter({ client });
    const out = await llm.complete(baseReq);
    expect(out.stopReason).toBe("max_tokens");
  });

  test("refusal field beats finish_reason", async () => {
    const client = fakeClient([
      {
        completion: chatCompletion({
          content: null,
          refusal: "I cannot help with that.",
          finish_reason: "stop",
        }),
      },
    ]);
    const llm = createOpenAIAdapter({ client });
    const out = await llm.complete(baseReq);
    expect(out.stopReason).toBe("refusal");
    expect(out.content).toEqual([{ type: "text", text: "I cannot help with that." }]);
  });
});

describe("openai adapter tool_call argument parsing", () => {
  test("invalid JSON arguments fall through as _raw rather than throwing", async () => {
    const client = fakeClient([
      {
        completion: chatCompletion({
          finish_reason: "tool_calls",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "do_thing", arguments: "{not json" },
            },
          ],
        }),
      },
    ]);
    const llm = createOpenAIAdapter({ client });
    const out = await llm.complete(baseReq);
    expect(out.content).toEqual([
      { type: "tool_use", id: "call_1", name: "do_thing", input: { _raw: "{not json" } },
    ]);
  });
});
