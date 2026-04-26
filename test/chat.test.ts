import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import { startAgentLoop } from "../src/agent/chat.ts";
import type { Completion, CompletionRequest, Llm } from "../src/llm/types.ts";
import type { ExtensionHost, ToolDef } from "../src/extensions/index.ts";

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
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 2,
    },
  };
}

function toolUseTurn(name: string, input: Record<string, unknown>): Completion {
  return {
    content: [{ type: "tool_use", id: `${name}-1`, name, input }],
    stopReason: "tool_use",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 2,
    },
  };
}

function fakeLiveExtensionHost(opts: {
  loaded: Set<string>;
  extensionName: string;
  tool: ToolDef;
}): ExtensionHost {
  const record = {
    id: opts.extensionName,
    manifest: { name: opts.extensionName, version: "0.1.0" },
    path: `/tmp/${opts.extensionName}`,
    status: "active" as const,
    failures: 0,
  };
  return {
    list: () => (opts.loaded.has(opts.extensionName) ? [record] : []),
    get: (name) => (name === opts.extensionName && opts.loaded.has(name) ? record : undefined),
    discover: async () => [],
    inventory: async () => [],
    load: async (name) => {
      opts.loaded.add(name);
      return record;
    },
    unload: async (name) => {
      opts.loaded.delete(name);
    },
    reload: async (name) => {
      opts.loaded.add(name);
      return record;
    },
    smokeTest: async () => ({ ok: true }),
    reportFailure: () => {},
    tools: () =>
      opts.loaded.has(opts.extensionName)
        ? [{ extensionId: opts.extensionName, tool: opts.tool }]
        : [],
    triggers: () => [],
  };
}

function rig() {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  // Give us a real agent row too so loadAgentScope finds something.
  const agentId = "root";
  store
    .insert(tables.agents)
    .values({ id: agentId, name: "root", hostId, createdAt: Date.now() })
    .run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  return { store, bus, hostId, agentId };
}

describe("agent loop over the mailbox", () => {
  it("responds to mailbox-addressed chat.input with assistant-text + turn-end", async () => {
    const r = rig();
    const llm = mockLlm([endTurn("hi from mock")]);
    startAgentLoop({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm,
      agentId: r.agentId,
      system: "test",
    });

    const seen: Array<{ type: string; threadId?: string; payload: unknown }> = [];
    r.bus.subscribe("chat.assistant-text", (e) =>
      void seen.push({ type: e.type, threadId: e.threadId, payload: e.payload }),
    );
    r.bus.subscribe("chat.turn-end", (e) =>
      void seen.push({ type: e.type, threadId: e.threadId, payload: e.payload }),
    );

    const done = new Promise<void>((resolve) => {
      r.bus.subscribe("chat.turn-end", () => resolve());
    });

    r.bus.publish({
      type: "chat.input",
      hostId: r.hostId,
      actorId: "cli",
      durable: true,
      toAgentId: r.agentId,
      threadId: "t1",
      payload: { text: "hello" },
    });
    await done;

    expect(seen.map((s) => s.type)).toEqual(["chat.assistant-text", "chat.turn-end"]);
    // Replies carry the same threadId so bridges can route them back.
    expect(seen[0]!.threadId).toBe("t1");
    expect(seen[1]!.threadId).toBe("t1");
    expect((seen[0]!.payload as { text: string }).text).toBe("hi from mock");
  });

  it("ignores chat.input that isn't addressed to this agent's mailbox", async () => {
    const r = rig();
    const llm = mockLlm([endTurn("should not fire")]);
    startAgentLoop({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm,
      agentId: r.agentId,
    });
    let fired = false;
    r.bus.subscribe("chat.turn-end", () => {
      fired = true;
    });
    // toAgentId targets a different agent.
    r.bus.publish({
      type: "chat.input",
      hostId: r.hostId,
      actorId: "cli",
      durable: true,
      toAgentId: "someone-else",
      threadId: "t1",
      payload: { text: "hi" },
    });
    // No toAgentId at all — untargeted broadcast, also not our mailbox.
    r.bus.publish({
      type: "chat.input",
      hostId: r.hostId,
      actorId: "cli",
      durable: true,
      threadId: "t2",
      payload: { text: "hi" },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fired).toBe(false);
  });

  it("enqueues concurrent chat.input for the same thread and drains in order", async () => {
    const r = rig();
    const llm = mockLlm([endTurn("r1"), endTurn("r2"), endTurn("r3")]);
    startAgentLoop({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm,
      agentId: r.agentId,
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

    for (const text of ["a", "b", "c"]) {
      r.bus.publish({
        type: "chat.input",
        hostId: r.hostId,
        actorId: "cli",
        durable: true,
        toAgentId: r.agentId,
        threadId: "q1",
        payload: { text },
      });
    }
    await allThree;

    expect(texts).toEqual(["r1", "r2", "r3"]);
  });

  it("runs different threads independently — different histories, interleaved drains", async () => {
    // The loop keeps per-thread history; inputs to thread A must not
    // appear in thread B's LLM context.
    const r = rig();
    const seenContexts: Array<{ thread: string; last: string | undefined }> = [];
    const llm: Llm = {
      provider: "mock",
      defaultModel: "mock-1",
      async complete(req) {
        const last = req.messages.at(-1);
        seenContexts.push({
          thread: (last?.content as string) ?? "",
          last: typeof last?.content === "string" ? last.content : undefined,
        });
        return endTurn("ack");
      },
    };
    startAgentLoop({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm,
      agentId: r.agentId,
    });
    let turnEnds = 0;
    const done = new Promise<void>((resolve) => {
      r.bus.subscribe("chat.turn-end", () => {
        turnEnds += 1;
        if (turnEnds === 2) resolve();
      });
    });
    r.bus.publish({
      type: "chat.input",
      hostId: r.hostId,
      actorId: "cli",
      durable: true,
      toAgentId: r.agentId,
      threadId: "A",
      payload: { text: "from-A" },
    });
    r.bus.publish({
      type: "chat.input",
      hostId: r.hostId,
      actorId: "cli",
      durable: true,
      toAgentId: r.agentId,
      threadId: "B",
      payload: { text: "from-B" },
    });
    await done;
    // Each thread's request saw its own last message only.
    const lasts = seenContexts.map((s) => s.last).sort();
    expect(lasts).toEqual(["from-A", "from-B"]);
  });

  it("persists thread message history and reloads on restart", async () => {
    const r = rig();
    const dir = mkdtempSync(join(tmpdir(), "olle-threads-"));
    try {
      const llm1 = mockLlm([endTurn("first")]);
      const loop1 = startAgentLoop({
        bus: r.bus,
        store: r.store,
        hostId: r.hostId,
        llm: llm1,
        agentId: r.agentId,
        threadsDir: dir,
      });
      const firstDone = new Promise<void>((resolve) => {
        r.bus.subscribe("chat.turn-end", () => resolve());
      });
      r.bus.publish({
        type: "chat.input",
        hostId: r.hostId,
        actorId: "cli",
        durable: true,
        toAgentId: r.agentId,
        threadId: "persist-1",
        payload: { text: "hello" },
      });
      await firstDone;
      loop1.stop();

      // Snapshot lives under <threadsDir>/<agentId>/<threadId>.json.
      const snapPath = join(dir, "root", "persist-1.json");
      const snapshot = JSON.parse(readFileSync(snapPath, "utf8")) as {
        messages: Array<{ role: string }>;
      };
      expect(snapshot.messages.length).toBeGreaterThanOrEqual(2);
      expect(snapshot.messages[0]!.role).toBe("user");

      // Fresh loop picks up the history.
      let sawMessages: Array<{ role: string; content: unknown }> | null = null;
      const llm2: Llm = {
        provider: "mock",
        defaultModel: "mock-1",
        async complete(req) {
          // Snapshot by value — runAgent mutates the array after call.
          sawMessages = JSON.parse(JSON.stringify(req.messages));
          return endTurn("second");
        },
      };
      startAgentLoop({
        bus: r.bus,
        store: r.store,
        hostId: r.hostId,
        llm: llm2,
        agentId: r.agentId,
        threadsDir: dir,
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
        toAgentId: r.agentId,
        threadId: "persist-1",
        payload: { text: "follow up" },
      });
      await secondDone;
      expect(sawMessages).not.toBeNull();
      expect(sawMessages!.length).toBeGreaterThanOrEqual(3);
      expect(sawMessages!.at(-1)).toMatchObject({ role: "user", content: "follow up" });
      expect(sawMessages![0]).toMatchObject({ role: "user", content: "hello" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects path-traversal in threadId when saving", async () => {
    const r = rig();
    const dir = mkdtempSync(join(tmpdir(), "olle-threads-"));
    try {
      const llm = mockLlm([endTurn("ok")]);
      startAgentLoop({
        bus: r.bus,
        store: r.store,
        hostId: r.hostId,
        llm,
        agentId: r.agentId,
        threadsDir: dir,
      });
      const done = new Promise<void>((resolve) => {
        r.bus.subscribe("chat.turn-end", () => resolve());
      });
      r.bus.publish({
        type: "chat.input",
        hostId: r.hostId,
        actorId: "cli",
        durable: true,
        toAgentId: r.agentId,
        threadId: "../etc/passwd",
        payload: { text: "x" },
      });
      await done;
      // Sanitized name lands inside <dir>/<agentId>, not outside it.
      const sanitized = readFileSync(
        join(dir, "root", ".._etc_passwd.json"),
        "utf8",
      );
      expect(sanitized).toContain("messages");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts sensitive inputs for tools registered and called in the same turn", async () => {
    const r = rig();
    const dir = mkdtempSync(join(tmpdir(), "olle-threads-"));
    try {
      const loaded = new Set<string>();
      const secretTool: ToolDef<Record<string, unknown>, string> = {
        name: "secret_tool",
        description: "uses a secret",
        inputSchema: {
          type: "object",
          properties: {
            token: { type: "string" },
            label: { type: "string" },
          },
        },
        sensitiveInputFields: ["token"],
        execute: () => "ok",
      };
      const extensions = fakeLiveExtensionHost({
        loaded,
        extensionName: "secret-ext",
        tool: secretTool,
      });
      const registerExtension: ToolDef<{ name: string }, { status: string }> = {
        name: "register_extension",
        description: "register",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        execute: async ({ name }) => {
          loaded.add(name);
          return { status: "active" };
        },
      };
      const llm = mockLlm([
        toolUseTurn("register_extension", { name: "secret-ext" }),
        toolUseTurn("secret_tool", { token: "raw-secret", label: "kept" }),
        endTurn("done"),
      ]);
      const seenToolCalls: unknown[] = [];
      r.bus.subscribe("chat.tool-call", (e) => {
        seenToolCalls.push(e.payload);
      });
      startAgentLoop({
        bus: r.bus,
        store: r.store,
        hostId: r.hostId,
        llm,
        agentId: r.agentId,
        coreTools: [registerExtension],
        extensions,
        threadsDir: dir,
      });

      const done = new Promise<void>((resolve) => {
        r.bus.subscribe("chat.turn-end", () => resolve());
      });
      r.bus.publish({
        type: "chat.input",
        hostId: r.hostId,
        actorId: "cli",
        durable: true,
        toAgentId: r.agentId,
        threadId: "redact-live",
        payload: { text: "register then call" },
      });
      await done;

      const secretCall = seenToolCalls.find(
        (p) => (p as { name?: string }).name === "secret_tool",
      ) as { input: Record<string, unknown> } | undefined;
      expect(secretCall?.input).toEqual({ token: "[redacted]", label: "kept" });

      const snapPath = join(dir, "root", "redact-live.json");
      const snapshot = readFileSync(snapPath, "utf8");
      expect(snapshot).not.toContain("raw-secret");
      expect(snapshot).toContain("[redacted]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
