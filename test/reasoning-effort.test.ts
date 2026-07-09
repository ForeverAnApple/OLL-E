// Reasoning effort — the adapter maps effort to adaptive thinking + the
// AI SDK's Anthropic providerOptions, the mapper round-trips thinking blocks
// across turns (signature preserved), and the preference persists as a memory
// resolved at loop start.

import { describe, expect, it } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { createAnthropicAdapter } from "../src/llm/anthropic.ts";
import { buildMessages, contentPartsToBlocks } from "../src/llm/vercel-mappers.ts";
import type { CompletionRequest } from "../src/llm/types.ts";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import {
  resolveReasoningEffort,
  startMemoryProjector,
  REASONING_EFFORT_ROLE,
} from "../src/memory/index.ts";
import { buildReasoningTools } from "../src/tools/reasoning.ts";
import { streamOf } from "./_helpers/mock-stream.ts";

// A mock model that records the call options the adapter handed the SDK and
// streams a trivial text reply so `complete` resolves.
function captureModel(): {
  model: MockLanguageModelV3;
  calls: LanguageModelV3CallOptions[];
} {
  const calls: LanguageModelV3CallOptions[] = [];
  const model = new MockLanguageModelV3({
    provider: "anthropic",
    modelId: "claude-opus-4-7",
    doStream: async (options) => {
      calls.push(options);
      return {
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "ok" },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            finishReason: { unified: "stop", raw: undefined },
          },
        ]),
      };
    },
  });
  return { model, calls };
}

const base: Omit<CompletionRequest, "effort" | "temperature"> = {
  model: "claude-opus-4-7",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 100,
};

describe("anthropic adapter — reasoning effort", () => {
  it("maps effort to adaptive thinking + effort providerOptions and drops temperature", async () => {
    const { model, calls } = captureModel();
    const llm = createAnthropicAdapter({ languageModel: model });
    await llm.complete({ ...base, effort: "high", temperature: 0.7 });
    const anthropic = calls[0]!.providerOptions?.anthropic as Record<string, unknown>;
    // display: "summarized" is load-bearing — the Opus 4.7+ default
    // ("omitted") returns thinking blocks with empty text, leaving nothing
    // to stream or persist.
    expect(anthropic?.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(anthropic?.effort).toBe("high");
    // 4.7/4.8 reject sampling params alongside effort.
    expect(calls[0]!.temperature).toBeUndefined();
  });

  it("sends no thinking/effort when effort is unset; keeps temperature", async () => {
    const { model, calls } = captureModel();
    const llm = createAnthropicAdapter({ languageModel: model });
    await llm.complete({ ...base, temperature: 0.5 });
    const anthropic = calls[0]!.providerOptions?.anthropic as Record<string, unknown> | undefined;
    expect(anthropic?.thinking).toBeUndefined();
    expect(anthropic?.effort).toBeUndefined();
    expect(calls[0]!.temperature).toBe(0.5);
  });

  it("reads thinking blocks back verbatim (text + signature)", () => {
    // The Anthropic provider surfaces thinking as `reasoning` content parts
    // carrying signature / redactedData in providerMetadata.anthropic.
    const out = contentPartsToBlocks([
      {
        type: "reasoning",
        text: "reasoning…",
        providerMetadata: { anthropic: { signature: "sig-abc" } },
      },
      {
        type: "reasoning",
        text: "",
        providerMetadata: { anthropic: { redactedData: "enc-xyz" } },
      },
      { type: "text", text: "answer" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    expect(out[0]).toEqual({ type: "thinking", thinking: "reasoning…", signature: "sig-abc" });
    expect(out[1]).toEqual({ type: "redacted_thinking", data: "enc-xyz" });
    expect(out[2]).toEqual({ type: "text", text: "answer" });
  });

  it("echoes thinking blocks back on the next turn (signature preserved)", () => {
    const msgs = buildMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "because", signature: "sig-1" },
          { type: "text", text: "ans" },
        ],
      },
    ]);
    const parts = msgs[0]!.content as Array<{
      type: string;
      text?: string;
      providerOptions?: { anthropic?: { signature?: string } };
    }>;
    const reasoning = parts.find((p) => p.type === "reasoning")!;
    expect(reasoning.text).toBe("because");
    expect(reasoning.providerOptions?.anthropic?.signature).toBe("sig-1");
  });
});

function rig() {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  startMemoryProjector({ bus, store, hostId });
  return { store, bus, hostId };
}

function ctx(actorId: string, hostId: string) {
  return { hostId, extensionId: actorId, actorId, abort: new AbortController().signal, secrets: {} };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setTool(tools: ReturnType<typeof buildReasoningTools>): { execute: (a: any, c: any) => any } {
  const t = tools.find((x) => x.name === "set_reasoning_effort");
  if (!t) throw new Error("set_reasoning_effort missing");
  return t as never;
}

describe("set_reasoning_effort", () => {
  it("persists a level, resolvable at loop start", async () => {
    const r = rig();
    const tool = setTool(buildReasoningTools(r));
    expect(resolveReasoningEffort(r.store, "a")).toBeUndefined();

    await tool.execute({ effort: "xhigh", reason: "agentic coding needs depth" }, ctx("a", r.hostId));
    expect(resolveReasoningEffort(r.store, "a")).toBe("xhigh");

    const row = r.store
      .select()
      .from(tables.memories)
      .all()
      .find((m) => m.role === REASONING_EFFORT_ROLE);
    expect(row?.scope).toBe("private");
    expect(row?.bodyMd.split("\n")[0]).toBe("xhigh");
  });

  it("`off` disables thinking → resolves to undefined", async () => {
    const r = rig();
    const tool = setTool(buildReasoningTools(r));
    await tool.execute({ effort: "high", reason: "on" }, ctx("a", r.hostId));
    expect(resolveReasoningEffort(r.store, "a")).toBe("high");
    await tool.execute({ effort: "off", reason: "too slow for now" }, ctx("a", r.hostId));
    expect(resolveReasoningEffort(r.store, "a")).toBeUndefined();
  });

  it("reuses one canonical row across changes", async () => {
    const r = rig();
    const tool = setTool(buildReasoningTools(r));
    await tool.execute({ effort: "low", reason: "1" }, ctx("a", r.hostId));
    await tool.execute({ effort: "max", reason: "2" }, ctx("a", r.hostId));
    const rows = r.store
      .select()
      .from(tables.memories)
      .all()
      .filter((m) => m.role === REASONING_EFFORT_ROLE && m.actorId === "a");
    expect(rows.length).toBe(1);
    expect(resolveReasoningEffort(r.store, "a")).toBe("max");
  });

  it("rejects an invalid level and an empty reason", async () => {
    const r = rig();
    const tool = setTool(buildReasoningTools(r));
    await expect(
      tool.execute({ effort: "turbo", reason: "why" }, ctx("a", r.hostId)),
    ).rejects.toThrow(/invalid effort/);
    await expect(
      tool.execute({ effort: "high", reason: "  " }, ctx("a", r.hostId)),
    ).rejects.toThrow(/reason is required/);
  });
});
