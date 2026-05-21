// Multi-provider routing. Pins three things in place:
//  1. Provider routing by model-name prefix (gpt-* → openai, claude-* →
//     anthropic), and rejection of unknown prefixes.
//  2. Refusal to boot when the default model's provider isn't loaded.
//  3. Live model swap + hot-add provider after a key arrives.

import { describe, expect, test } from "bun:test";
import { createRouterLlm, providerForModel } from "../src/llm/router.ts";
import type { Completion, CompletionRequest, Llm } from "../src/llm/types.ts";

function fakeAdapter(provider: string, label: string): Llm {
  return {
    provider,
    defaultModel: label,
    async complete(req: CompletionRequest): Promise<Completion> {
      return {
        content: [{ type: "text", text: `${label}:${req.model}` }],
        stopReason: "end_turn",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalTokens: 2,
        },
      };
    },
  };
}

describe("providerForModel", () => {
  test("classifies known prefixes", () => {
    expect(providerForModel("claude-opus-4-7")).toBe("anthropic");
    expect(providerForModel("gpt-5.5")).toBe("openai");
    expect(providerForModel("gpt-4o-mini")).toBe("openai");
    expect(providerForModel("o3")).toBe("openai");
    expect(providerForModel("o3-mini")).toBe("openai");
  });
  test("rejects unknown prefixes", () => {
    expect(() => providerForModel("llama-3")).toThrow(/unknown provider/);
    expect(() => providerForModel("gemini-pro")).toThrow(/unknown provider/);
  });
});

describe("createRouterLlm", () => {
  test("routes to the right adapter based on the request model", async () => {
    const router = createRouterLlm({
      adapters: {
        anthropic: fakeAdapter("anthropic", "A"),
        openai: fakeAdapter("openai", "O"),
      },
      defaultModel: "claude-opus-4-7",
    });
    const a = await router.complete({
      model: "claude-opus-4-7",
      messages: [],
      maxTokens: 1,
    });
    const b = await router.complete({
      model: "gpt-5.5",
      messages: [],
      maxTokens: 1,
    });
    expect((a.content[0] as { text: string }).text).toBe("A:claude-opus-4-7");
    expect((b.content[0] as { text: string }).text).toBe("O:gpt-5.5");
  });

  test("throws at construction when default model's provider is missing", () => {
    expect(() =>
      createRouterLlm({
        adapters: { anthropic: fakeAdapter("anthropic", "A") },
        defaultModel: "gpt-5.5",
      }),
    ).toThrow(/OPENAI_API_KEY/);
  });

  test("setDefaultModel rejects models whose provider isn't loaded", () => {
    const router = createRouterLlm({
      adapters: { openai: fakeAdapter("openai", "O") },
      defaultModel: "gpt-5.5",
    });
    expect(() => router.setDefaultModel("claude-opus-4-7")).toThrow(/ANTHROPIC_API_KEY/);
    expect(router.defaultModel).toBe("gpt-5.5"); // unchanged
  });

  test("setAdapter hot-adds a provider; the rejected model then succeeds", () => {
    const router = createRouterLlm({
      adapters: { openai: fakeAdapter("openai", "O") },
      defaultModel: "gpt-5.5",
    });
    expect(router.hasAdapter("anthropic")).toBe(false);
    router.setAdapter("anthropic", fakeAdapter("anthropic", "A"));
    expect(router.hasAdapter("anthropic")).toBe(true);
    router.setDefaultModel("claude-opus-4-7");
    expect(router.defaultModel).toBe("claude-opus-4-7");
    expect(router.activeProvider).toBe("anthropic");
  });

  test("provider getter reflects the currently active model", () => {
    const router = createRouterLlm({
      adapters: {
        anthropic: fakeAdapter("anthropic", "A"),
        openai: fakeAdapter("openai", "O"),
      },
      defaultModel: "gpt-5.5",
    });
    expect(router.provider).toBe("openai");
    router.setDefaultModel("claude-opus-4-7");
    expect(router.provider).toBe("anthropic");
  });
});
