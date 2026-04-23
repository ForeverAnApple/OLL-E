import { describe, expect, it } from "bun:test";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import { startChatAgent } from "../src/agent/chat.ts";
import type { Completion, CompletionRequest, Llm } from "../src/llm/types.ts";

function mockLlm(script: Completion[]): Llm {
  return {
    provider: "mock",
    defaultModel: "mock-1",
    async complete(_req: CompletionRequest): Promise<Completion> {
      const c = script.shift();
      if (!c) throw new Error("mockLlm exhausted");
      return c;
    },
  };
}

function endTurn(text: string): Completion {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    usdMicros: 0,
  };
}

function rig() {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  return { store, bus, hostId };
}

describe("chat agent over the bus", () => {
  it("responds to chat.input with chat.assistant-text + chat.turn-end", async () => {
    const r = rig();
    const llm = mockLlm([endTurn("hi from mock")]);
    startChatAgent({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm,
      agentId: "root",
      system: "test",
    });

    const seen: Array<{ type: string; payload: unknown }> = [];
    r.bus.subscribe("chat.assistant-text", (e) => void seen.push({ type: e.type, payload: e.payload }));
    r.bus.subscribe("chat.turn-end", (e) => void seen.push({ type: e.type, payload: e.payload }));

    const done = new Promise<void>((resolve) => {
      r.bus.subscribe("chat.turn-end", () => resolve());
    });

    r.bus.publish({
      type: "chat.input",
      hostId: r.hostId,
      actorId: "cli",
      durable: true,
      payload: { sessionId: "s1", text: "hello" },
    });
    await done;

    expect(seen.map((s) => s.type)).toEqual(["chat.assistant-text", "chat.turn-end"]);
    expect((seen[0]!.payload as { text: string }).text).toBe("hi from mock");
  });

  it("ignores chat.input for other sessions", async () => {
    const r = rig();
    const llm = mockLlm([endTurn("only s2")]);
    startChatAgent({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm,
      agentId: "root",
    });
    const responses: string[] = [];
    r.bus.subscribe("chat.assistant-text", (e) => {
      const p = e.payload as { sessionId: string; text: string };
      responses.push(`${p.sessionId}:${p.text}`);
    });
    const done = new Promise<void>((resolve) => {
      r.bus.subscribe("chat.turn-end", (e) => {
        if ((e.payload as { sessionId: string }).sessionId === "s2") resolve();
      });
    });
    r.bus.publish({
      type: "chat.input",
      hostId: r.hostId,
      actorId: "cli",
      durable: true,
      payload: { sessionId: "s2", text: "hi" },
    });
    await done;
    expect(responses).toEqual(["s2:only s2"]);
  });
});
