// Reasoning effort — the adapter maps effort to adaptive thinking +
// output_config, preserves thinking blocks across turns, and the preference
// persists as a memory resolved at loop start.

import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { createAnthropicAdapter } from "../src/llm/anthropic.ts";
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

// Fake client that records every params object passed to messages.stream and
// returns a fixed final message. Mirrors what the adapter consumes (on/finalMessage).
function captureClient(finalResp: unknown): {
  client: Anthropic;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    messages: {
      stream: (params: Record<string, unknown>) => {
        calls.push(params);
        return { on: () => {}, finalMessage: async () => finalResp };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const okResp = {
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

const base: Omit<CompletionRequest, "effort" | "temperature"> = {
  model: "claude-opus-4-7",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 100,
};

describe("anthropic adapter — reasoning effort", () => {
  it("maps effort to adaptive thinking + output_config and drops temperature", async () => {
    const { client, calls } = captureClient(okResp);
    const llm = createAnthropicAdapter({ client });
    await llm.complete({ ...base, effort: "high", temperature: 0.7 });
    expect(calls[0]!.thinking).toEqual({ type: "adaptive" });
    expect(calls[0]!.output_config).toEqual({ effort: "high" });
    // 4.7/4.8 reject sampling params alongside effort.
    expect(calls[0]!.temperature).toBeUndefined();
  });

  it("sends no thinking/output_config when effort is unset; keeps temperature", async () => {
    const { client, calls } = captureClient(okResp);
    const llm = createAnthropicAdapter({ client });
    await llm.complete({ ...base, temperature: 0.5 });
    expect(calls[0]!.thinking).toBeUndefined();
    expect(calls[0]!.output_config).toBeUndefined();
    expect(calls[0]!.temperature).toBe(0.5);
  });

  it("reads thinking blocks back verbatim (text + signature)", async () => {
    const resp = {
      content: [
        { type: "thinking", thinking: "reasoning…", signature: "sig-abc" },
        { type: "redacted_thinking", data: "enc-xyz" },
        { type: "text", text: "answer" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 2 },
    };
    const { client } = captureClient(resp);
    const llm = createAnthropicAdapter({ client });
    const out = await llm.complete({ ...base, effort: "high" });
    expect(out.content[0]).toEqual({
      type: "thinking",
      thinking: "reasoning…",
      signature: "sig-abc",
    });
    expect(out.content[1]).toEqual({ type: "redacted_thinking", data: "enc-xyz" });
  });

  it("echoes thinking blocks back on the next turn (signature preserved)", async () => {
    const { client, calls } = captureClient(okResp);
    const llm = createAnthropicAdapter({ client });
    await llm.complete({
      ...base,
      effort: "high",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "because", signature: "sig-1" },
            { type: "text", text: "ans" },
          ],
        },
        { role: "user", content: "more" },
      ],
    });
    const sent = calls[0]!.messages as Array<{ role: string; content: unknown }>;
    const asst = sent.find((m) => m.role === "assistant")!;
    const blocks = asst.content as Array<{ type: string; signature?: string; thinking?: string }>;
    const tb = blocks.find((b) => b.type === "thinking");
    expect(tb).toEqual({ type: "thinking", thinking: "because", signature: "sig-1" });
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
