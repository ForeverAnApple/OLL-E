// OpenAI adapter: provider-neutral mapping, streaming text deltas,
// cache-read accounting, and stop-reason translation. Retry surface
// is exercised by the shared createInstrumentedFetch tests — OpenAI
// inherits that wrapper unchanged.

import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { createOpenAIAdapter } from "../src/llm/openai.ts";
import type { CompletionRequest } from "../src/llm/types.ts";
import { streamOf } from "./_helpers/mock-stream.ts";

const baseReq: CompletionRequest = {
  model: "gpt-5",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 16,
};

function mockModel(parts: unknown[]) {
  return new MockLanguageModelV3({
    provider: "openai",
    modelId: "gpt-5",
    doStream: async () => ({
      stream: streamOf(parts as never[]),
    }),
  });
}

function textRun(deltas: string[], usage: {
  total?: number; cacheRead?: number; output?: number;
}, finish: "stop" | "length" | "tool-calls" | "content-filter" = "stop") {
  const id = "t1";
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id },
    ...deltas.map((d) => ({ type: "text-delta", id, delta: d })),
    { type: "text-end", id },
    {
      type: "finish",
      usage: {
        inputTokens: {
          total: usage.total ?? 0,
          noCache: undefined,
          cacheRead: usage.cacheRead ?? 0,
          cacheWrite: 0,
        },
        outputTokens: { total: usage.output ?? 0, text: usage.output ?? 0, reasoning: 0 },
      },
      finishReason: { unified: finish, raw: undefined },
    },
  ];
}

describe("openai adapter streaming", () => {
  test("forwards content deltas and returns the assembled message", async () => {
    const deltas: string[] = [];
    const model = mockModel(textRun(["hello ", "world"], { total: 10, output: 5 }));
    const llm = createOpenAIAdapter({ languageModel: model });
    const out = await llm.complete({ ...baseReq, onTextDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual(["hello ", "world"]);
    expect(out.content).toEqual([{ type: "text", text: "hello world" }]);
    expect(out.stopReason).toBe("end_turn");
  });
});

describe("openai adapter usage mapping", () => {
  test("subtracts cached_tokens from inputTokens and reports cache reads", async () => {
    const model = mockModel(
      textRun(["ok"], { total: 100, cacheRead: 60, output: 20 }),
    );
    const llm = createOpenAIAdapter({ languageModel: model });
    const out = await llm.complete(baseReq);
    expect(out.usage).toEqual({
      inputTokens: 40, // 100 total - 60 cached
      outputTokens: 20,
      cacheReadInputTokens: 60,
      cacheCreationInputTokens: 0,
      totalTokens: 120, // 40 + 20 + 60
    });
  });

  test("handles missing cache info (no cache)", async () => {
    const model = mockModel(textRun(["ok"], { total: 10, output: 5 }));
    const llm = createOpenAIAdapter({ languageModel: model });
    const out = await llm.complete(baseReq);
    expect(out.usage.cacheReadInputTokens).toBe(0);
    expect(out.usage.inputTokens).toBe(10);
  });
});

describe("openai adapter stop reasons", () => {
  test("tool-calls finish reason → tool_use, with tool_use blocks in content", async () => {
    const model = mockModel([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "do_thing",
        input: '{"x":1}',
      },
      {
        type: "finish",
        usage: {
          inputTokens: { total: 5, noCache: undefined, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 0, reasoning: 0 },
        },
        finishReason: { unified: "tool-calls", raw: undefined },
      },
    ]);
    const llm = createOpenAIAdapter({ languageModel: model });
    const out = await llm.complete(baseReq);
    expect(out.stopReason).toBe("tool_use");
    expect(out.content).toEqual([
      { type: "tool_use", id: "call_1", name: "do_thing", input: { x: 1 } },
    ]);
  });

  test("length finish reason → max_tokens", async () => {
    const model = mockModel(textRun(["..."], { total: 5, output: 5 }, "length"));
    const llm = createOpenAIAdapter({ languageModel: model });
    const out = await llm.complete(baseReq);
    expect(out.stopReason).toBe("max_tokens");
  });

  test("content-filter finish reason → refusal", async () => {
    const model = mockModel(textRun([], { total: 5, output: 0 }, "content-filter"));
    const llm = createOpenAIAdapter({ languageModel: model });
    const out = await llm.complete(baseReq);
    expect(out.stopReason).toBe("refusal");
  });
});
