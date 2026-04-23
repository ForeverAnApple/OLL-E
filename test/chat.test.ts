import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("enqueues concurrent chat.input for the same session and drains in order", async () => {
    // Two inputs land while the first turn is still running — they
    // must serialize, not drop. No chat.busy event is expected.
    const r = rig();
    const llm = mockLlm([endTurn("r1"), endTurn("r2"), endTurn("r3")]);
    startChatAgent({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm,
      agentId: "root",
    });

    const texts: string[] = [];
    r.bus.subscribe("chat.assistant-text", (e) => {
      texts.push((e.payload as { text: string }).text);
    });
    let turnEnds = 0;
    const allThree = new Promise<void>((resolve) => {
      r.bus.subscribe("chat.turn-end", () => {
        turnEnds += 1;
        if (turnEnds === 3) resolve();
      });
    });
    const busy: string[] = [];
    r.bus.subscribe("chat.busy", (e) => {
      busy.push((e.payload as { sessionId: string }).sessionId);
    });

    // Fire three inputs back-to-back for the same session.
    for (const text of ["a", "b", "c"]) {
      r.bus.publish({
        type: "chat.input",
        hostId: r.hostId,
        actorId: "cli",
        durable: true,
        payload: { sessionId: "q1", text },
      });
    }
    await allThree;

    expect(texts).toEqual(["r1", "r2", "r3"]);
    // No busy-drops — the drain loop serialized for us.
    expect(busy).toEqual([]);
  });

  it("persists session messages to disk and reloads on restart", async () => {
    const r = rig();
    const dir = mkdtempSync(join(tmpdir(), "olle-sessions-"));
    try {
      const llm1 = mockLlm([endTurn("first")]);
      const chat1 = startChatAgent({
        bus: r.bus,
        store: r.store,
        hostId: r.hostId,
        llm: llm1,
        agentId: "root",
        sessionsDir: dir,
      });
      const firstDone = new Promise<void>((resolve) => {
        r.bus.subscribe("chat.turn-end", () => resolve());
      });
      r.bus.publish({
        type: "chat.input",
        hostId: r.hostId,
        actorId: "cli",
        durable: true,
        payload: { sessionId: "persist-1", text: "hello" },
      });
      await firstDone;
      chat1.stop();

      // Snapshot must be on disk with user + assistant turn recorded.
      const snapshot = JSON.parse(readFileSync(join(dir, "persist-1.json"), "utf8")) as {
        messages: Array<{ role: string }>;
      };
      expect(snapshot.messages.length).toBeGreaterThanOrEqual(2);
      expect(snapshot.messages[0]!.role).toBe("user");

      // Fresh chat agent picks up the history. The second turn must
      // include the first turn's messages so the model sees continuity.
      const r2 = { store: r.store, bus: r.bus, hostId: r.hostId };
      // Snapshot the messages array at call time — runAgent pushes the
      // assistant response back into the same array after the call, so
      // a reference would mutate out from under us.
      let sawMessages: Array<{ role: string; content: unknown }> | null = null;
      const llm2: Llm = {
        provider: "mock",
        defaultModel: "mock-1",
        async complete(req) {
          sawMessages = JSON.parse(JSON.stringify(req.messages));
          return endTurn("second");
        },
      };
      startChatAgent({
        ...r2,
        llm: llm2,
        agentId: "root",
        sessionsDir: dir,
      });
      const secondDone = new Promise<void>((resolve) => {
        const sub = r.bus.subscribe("chat.turn-end", () => {
          sub();
          resolve();
        });
      });
      r.bus.publish({
        type: "chat.input",
        hostId: r.hostId,
        actorId: "cli",
        durable: true,
        payload: { sessionId: "persist-1", text: "follow up" },
      });
      await secondDone;
      expect(sawMessages).not.toBeNull();
      // The LLM saw the prior turn's messages PLUS the new user text —
      // "hello" (user), "first" (assistant), "follow up" (user).
      expect(sawMessages!.length).toBeGreaterThanOrEqual(3);
      expect(sawMessages!.at(-1)).toMatchObject({ role: "user", content: "follow up" });
      expect(sawMessages![0]).toMatchObject({ role: "user", content: "hello" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects path-traversal in sessionId when saving", async () => {
    // Guard against a malicious or typo'd sessionId writing outside the
    // sessions dir. We sanitize to url-safe chars; verify the file lands
    // with the sanitized name.
    const r = rig();
    const dir = mkdtempSync(join(tmpdir(), "olle-sessions-"));
    try {
      const llm = mockLlm([endTurn("ok")]);
      startChatAgent({
        bus: r.bus,
        store: r.store,
        hostId: r.hostId,
        llm,
        agentId: "root",
        sessionsDir: dir,
      });
      const done = new Promise<void>((resolve) => {
        r.bus.subscribe("chat.turn-end", () => resolve());
      });
      r.bus.publish({
        type: "chat.input",
        hostId: r.hostId,
        actorId: "cli",
        durable: true,
        payload: { sessionId: "../etc/passwd", text: "x" },
      });
      await done;
      // File lands inside dir under the sanitized name, not outside it.
      const sanitized = readFileSync(join(dir, ".._etc_passwd.json"), "utf8");
      expect(sanitized).toContain("messages");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
