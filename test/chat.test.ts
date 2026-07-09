import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import { startAgentLoop } from "../src/agent/chat.ts";
import { createInbox } from "../src/inbox/index.ts";
import type { Completion, CompletionRequest, Llm } from "../src/llm/types.ts";
import type { ExtensionHost, ToolDef } from "../src/extensions/index.ts";
import { eq } from "drizzle-orm";

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

function flattenSystem(system: CompletionRequest["system"]): string {
  return Array.isArray(system) ? system.map((s) => s.text).join("\n") : (system ?? "");
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
    attribute: () => undefined,
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

  it("publishes chat.thinking-delta for streamed reasoning, non-durable", async () => {
    const r = rig();
    const llm: Llm = {
      provider: "mock",
      defaultModel: "mock-1",
      async complete(req) {
        req.onReasoningDelta?.("mulling ");
        req.onReasoningDelta?.("it over");
        return endTurn("answer");
      },
    };
    startAgentLoop({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm,
      agentId: r.agentId,
      system: "test",
    });

    const thinkingDeltas: string[] = [];
    r.bus.subscribe("chat.thinking-delta", (e) =>
      void thinkingDeltas.push((e.payload as { text: string }).text),
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

    expect(thinkingDeltas).toEqual(["mulling ", "it over"]);
    // Deltas are visualization, not history: nothing lands in the durable
    // event log. (The thinking block itself persists in thread messages.)
    const persisted = r.store
      .select()
      .from(tables.events)
      .where(eq(tables.events.type, "chat.thinking-delta"))
      .all();
    expect(persisted).toEqual([]);
  });

  it("resolves function system prompts at turn time", async () => {
    const r = rig();
    const requests: CompletionRequest[] = [];
    const llm: Llm = {
      provider: "mock",
      defaultModel: "mock-1",
      async complete(req) {
        requests.push(req);
        return endTurn(`turn ${requests.length}`);
      },
    };
    startAgentLoop({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm,
      agentId: r.agentId,
      system: () => {
        const seeded = r.store.raw
          .query<{ id: string }, [string]>(
            "SELECT id FROM memories WHERE actor_id = ? AND scope = 'private' AND role = 'identity' LIMIT 1",
          )
          .all(r.agentId);
        return seeded.length > 0 ? "NORMAL PROMPT" : "BOOTSTRAP PROMPT";
      },
    });

    async function send(text: string): Promise<void> {
      const done = new Promise<void>((resolve) => {
        const unsub = r.bus.subscribe("chat.turn-end", () => {
          unsub();
          resolve();
        });
      });
      r.bus.publish({
        type: "chat.input",
        hostId: r.hostId,
        actorId: "cli",
        durable: true,
        toAgentId: r.agentId,
        threadId: "t1",
        payload: { text },
      });
      await done;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    await send("first");
    r.store
      .insert(tables.memories)
      .values({
        id: ulid(),
        hlc: "1",
        hostId: r.hostId,
        actorId: r.agentId,
        scope: "private",
        scopeRef: r.agentId,
        role: "identity",
        depth: 10,
        title: "name",
        bodyMd: "I am OLL-E.",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    await send("second");

    const firstSystem = flattenSystem(requests[0]!.system);
    const secondSystem = flattenSystem(requests[1]!.system);
    expect(firstSystem).toContain("BOOTSTRAP PROMPT");
    expect(firstSystem).not.toContain("NORMAL PROMPT");
    expect(secondSystem).toContain("NORMAL PROMPT");
    expect(secondSystem).not.toContain("BOOTSTRAP PROMPT");
    expect(secondSystem).toContain("Who you are:");
    expect(secondSystem).toContain("I am OLL-E.");
  });

  it("freezes the model per thread — active threads keep it, new threads pick up a switch", async () => {
    const r = rig();
    const requests: CompletionRequest[] = [];
    const llm: Llm = {
      provider: "mock",
      defaultModel: "mock-1",
      async complete(req) {
        requests.push(req);
        return endTurn("ok");
      },
    };
    let current: string | undefined = "model-A";
    startAgentLoop({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm,
      agentId: r.agentId,
      // Live resolver — what set_thinking_model drives in production.
      resolveModel: () => current,
    });

    async function send(threadId: string, text: string): Promise<void> {
      const done = new Promise<void>((resolve) => {
        const unsub = r.bus.subscribe("chat.turn-end", () => {
          unsub();
          resolve();
        });
      });
      r.bus.publish({
        type: "chat.input",
        hostId: r.hostId,
        actorId: "cli",
        durable: true,
        toAgentId: r.agentId,
        threadId,
        payload: { text },
      });
      await done;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    await send("tA", "1"); // thread A born while resolver says model-A
    current = "model-B"; // self-switch lands (no restart)
    await send("tA", "2"); // same thread → frozen on model-A
    await send("tB", "1"); // brand-new thread → picks up model-B

    expect(requests[0]!.model).toBe("model-A");
    expect(requests[1]!.model).toBe("model-A"); // active thread unchanged
    expect(requests[2]!.model).toBe("model-B"); // new thread takes the switch
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

  it("folds extendTurn=true mid-turn input into the running turn and emits chat.input-folded", async () => {
    const r = rig();
    // Two LLM responses are scripted; the first call is gated on a
    // promise so we can publish the mid-turn input *while runAgent is
    // still inside the LLM call* (which is when activeAbort is set
    // and the inflight-inbox routing applies). Without the gate, the
    // mock returns synchronously and the turn ends before the second
    // publish ever sees activeAbort.
    const seen: Array<Array<string>> = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const llm: Llm = {
      provider: "mock",
      defaultModel: "mock-1",
      async complete(req) {
        seen.push(
          req.messages.map((m) =>
            typeof m.content === "string" ? m.content : "<blocks>",
          ),
        );
        if (seen.length === 1) await firstHeld;
        return endTurn(`r${seen.length}`);
      },
    };
    startAgentLoop({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm,
      agentId: r.agentId,
    });

    const folded: Array<{ count: number; stranded?: boolean }> = [];
    r.bus.subscribe("chat.input-folded", (e) => {
      folded.push(e.payload as { count: number; stranded?: boolean });
    });
    let turnEnds = 0;
    const done = new Promise<void>((resolve) => {
      r.bus.subscribe("chat.turn-end", () => {
        turnEnds += 1;
        if (turnEnds === 1) resolve();
      });
    });

    // Initial request — starts the turn. The worker spawns, runTurn
    // assigns activeAbort, and runAgent's first llm.complete blocks
    // on `firstHeld`.
    r.bus.publish({
      type: "chat.input",
      hostId: r.hostId,
      actorId: "cli",
      durable: true,
      toAgentId: r.agentId,
      threadId: "tx",
      payload: { text: "hello" },
    });
    // One microtask flush is enough to let the worker enter the held
    // LLM call. Now activeAbort is set and the in-flight inbox path
    // applies for the next publish.
    await new Promise((resolve) => setTimeout(resolve, 5));
    r.bus.publish({
      type: "chat.input",
      hostId: r.hostId,
      actorId: "cli",
      durable: true,
      toAgentId: r.agentId,
      threadId: "tx",
      payload: { text: "and also do X", extendTurn: true },
    });
    // Release the first LLM call so runAgent can proceed: end_turn
    // → late drain → fold "and also do X" → second LLM call.
    releaseFirst();
    await done;

    // Exactly one turn ran (the second message was folded in, not its
    // own turn) and the second LLM call's messages array carried the
    // extension-message as a fresh user turn after the first
    // assistant reply.
    expect(turnEnds).toBe(1);
    expect(seen.length).toBe(2);
    expect(seen[1]?.at(-1)).toBe("and also do X");
    // chat.input-folded fired once with count=1 (not stranded, since
    // it landed on the late-drain path inside runAgent).
    expect(folded.length).toBe(1);
    expect(folded[0]).toEqual({ count: 1 });
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

  it("scrubs known secret values from tool results (history, snapshot, event)", async () => {
    const r = rig();
    const dir = mkdtempSync(join(tmpdir(), "olle-threads-"));
    const secretsDir = mkdtempSync(join(tmpdir(), "olle-secrets-"));
    try {
      // Planted secrets: one long enough to scrub, one under the 8-char floor.
      writeFileSync(join(secretsDir, "LONGSECRET"), "s3cr3t-token-value");
      writeFileSync(join(secretsDir, "SHORTONE"), "pass1");

      const loaded = new Set<string>(["leak-ext"]);
      const leakTool: ToolDef<Record<string, unknown>, string> = {
        name: "leak_tool",
        description: "returns raw secret bytes",
        inputSchema: { type: "object", properties: {} },
        execute: () => "dump: s3cr3t-token-value and pass1",
      };
      const extensions = fakeLiveExtensionHost({
        loaded,
        extensionName: "leak-ext",
        tool: leakTool,
      });
      const llm = mockLlm([toolUseTurn("leak_tool", {}), endTurn("done")]);

      const results: string[] = [];
      r.bus.subscribe("chat.tool-result", (e) => {
        results.push((e.payload as { content: string }).content);
      });

      startAgentLoop({
        bus: r.bus,
        store: r.store,
        hostId: r.hostId,
        llm,
        agentId: r.agentId,
        extensions,
        threadsDir: dir,
        secretsDir,
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
        threadId: "leak",
        payload: { text: "leak it" },
      });
      await done;

      // Event payload: long value redacted, short value left intact.
      const event = results.find((c) => c.startsWith("dump:"));
      expect(event).toBeDefined();
      expect(event).not.toContain("s3cr3t-token-value");
      expect(event).toContain("[redacted:LONGSECRET]");
      expect(event).toContain("pass1");

      // Persisted snapshot (history) mirrors the event.
      const snapshot = readFileSync(join(dir, "root", "leak.json"), "utf8");
      expect(snapshot).not.toContain("s3cr3t-token-value");
      expect(snapshot).toContain("[redacted:LONGSECRET]");
      expect(snapshot).toContain("pass1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(secretsDir, { recursive: true, force: true });
    }
  });

  it("blocks paid LLM work when the caller's budget is already exhausted", async () => {
    const r = rig();
    const ownerAgentId = ulid();
    r.store.insert(tables.agents).values({
      id: ownerAgentId,
      name: "p",
      hostId: r.hostId,
      scope: { allowTiers: ["operational", "strategic", "vision"] },
      channels: [],
      ownsMoney: true,
      createdAt: Date.now(),
    }).run();
    r.store.insert(tables.budgets).values({
      id: ulid(),
      ownerAgentId,
      agentId: r.agentId,
      period: "all-time",
      capUsd: 1,
      capTokens: null,
      spentUsd: 1,
      spentTokens: 0,
      updatedAt: Date.now(),
    }).run();
    const inbox = createInbox({ bus: r.bus, store: r.store, hostId: r.hostId });
    const llm = mockLlm([]);
    startAgentLoop({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm,
      agentId: r.agentId,
      ownerAgentId,
      inbox,
    });
    const done = new Promise<string>((resolve) => {
      r.bus.subscribe("chat.error", (e) => resolve((e.payload as { error: string }).error));
    });
    r.bus.publish({
      type: "chat.input",
      hostId: r.hostId,
      actorId: "cli",
      durable: true,
      toAgentId: r.agentId,
      threadId: "budget-block",
      payload: { text: "spend" },
    });
    const error = await done;
    expect(error).toContain("budget exhausted");
    expect(inbox.listOpen(ownerAgentId)).toHaveLength(1);
  });
});

describe("mail wake — decision.resolved synthesizes chat.input on mailbox thread", () => {
  // The push-side of mail_propose / mail_list (LOG 2026-04-26): when a
  // proposal addressed up the chain comes back with a vote (or expires
  // stale), the proposing agent's loop wakes by injecting a synthetic
  // chat.input on a stable per-agent mailbox thread. The wake fires for
  // events where proposingAgentId === my agentId; debounced to coalesce
  // bursts.

  function publishResolved(
    bus: ReturnType<typeof createBus>,
    hostId: string,
    proposingAgentId: string,
    decisionId = ulid(),
  ) {
    bus.publish({
      type: "decision.resolved",
      hostId,
      actorId: "principal",
      durable: true,
      payload: {
        decisionId,
        ownerAgentId: "p1",
        proposingAgentId,
        status: "approved",
        vote: "approve",
      },
    });
  }

  it("wakes the proposer's loop by injecting chat.input on the mailbox thread", async () => {
    const r = rig();
    // Loop never runs the LLM in this test — we're observing only the
    // injected chat.input event. Use empty script; if the wake erroneously
    // routed straight to a turn, the script would throw "exhausted".
    const llm = mockLlm([endTurn("never called in this test")]);
    const loop = startAgentLoop({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm,
      agentId: r.agentId,
      mailWakeDebounceMs: 0, // fire synchronously, no setTimeout race
    });
    try {
      const seen: Array<{ threadId?: string; payload: unknown }> = [];
      r.bus.subscribe("chat.input", (e) => {
        if ((e.payload as { mailWake?: boolean })?.mailWake) {
          seen.push({ threadId: e.threadId, payload: e.payload });
        }
      });
      publishResolved(r.bus, r.hostId, r.agentId);
      // Synchronous flush at debounce=0; one wake.
      expect(seen).toHaveLength(1);
      expect(seen[0]!.threadId).toBe(`mailbox:${r.agentId}`);
      const payload = seen[0]!.payload as {
        text: string;
        mailWake: boolean;
        decisionIds: string[];
      };
      expect(payload.mailWake).toBe(true);
      expect(payload.text).toContain("1 reply");
      expect(payload.text).toContain("mail_list");
      expect(payload.decisionIds).toHaveLength(1);
    } finally {
      loop.stop();
    }
  });

  it("ignores decision.resolved for other agents' proposals", async () => {
    const r = rig();
    const llm = mockLlm([endTurn("unused")]);
    const loop = startAgentLoop({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm,
      agentId: r.agentId,
      mailWakeDebounceMs: 0,
    });
    try {
      const seen: unknown[] = [];
      r.bus.subscribe("chat.input", (e) => {
        if ((e.payload as { mailWake?: boolean })?.mailWake) seen.push(e);
      });
      publishResolved(r.bus, r.hostId, "some-other-agent");
      expect(seen).toHaveLength(0);
    } finally {
      loop.stop();
    }
  });

  it("debounces a burst of resolutions into a single wake", async () => {
    const r = rig();
    const llm = mockLlm([endTurn("unused")]);
    const debounceMs = 25;
    const loop = startAgentLoop({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm,
      agentId: r.agentId,
      mailWakeDebounceMs: debounceMs,
    });
    try {
      const seen: Array<{ payload: unknown }> = [];
      r.bus.subscribe("chat.input", (e) => {
        if ((e.payload as { mailWake?: boolean })?.mailWake) {
          seen.push({ payload: e.payload });
        }
      });
      // Burst of 5 resolutions for our agent within the debounce window.
      for (let i = 0; i < 5; i++) publishResolved(r.bus, r.hostId, r.agentId);
      // Before the timer fires, no wake yet.
      expect(seen).toHaveLength(0);
      await new Promise((resolve) => setTimeout(resolve, debounceMs + 20));
      expect(seen).toHaveLength(1);
      const payload = seen[0]!.payload as { text: string; decisionIds: string[] };
      expect(payload.text).toContain("5 replies");
      expect(payload.decisionIds).toHaveLength(5);
    } finally {
      loop.stop();
    }
  });

  it("stop() cancels a pending wake (no leaked timer firing post-shutdown)", async () => {
    const r = rig();
    const llm = mockLlm([endTurn("unused")]);
    const debounceMs = 30;
    const loop = startAgentLoop({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm,
      agentId: r.agentId,
      mailWakeDebounceMs: debounceMs,
    });
    const seen: unknown[] = [];
    r.bus.subscribe("chat.input", (e) => {
      if ((e.payload as { mailWake?: boolean })?.mailWake) seen.push(e);
    });
    publishResolved(r.bus, r.hostId, r.agentId);
    loop.stop();
    await new Promise((resolve) => setTimeout(resolve, debounceMs + 20));
    expect(seen).toHaveLength(0);
  });
});

describe("mailbox sidebar — unread decision resolutions surface on next turn", () => {
  // Pull-side close-loop for the proposing agent on whatever thread it
  // next runs in (LOG 2026-04-27). Complements the from-idle wake on
  // mailbox:<agentId>: when the principal returns to the original chat
  // thread, the sidebar surfaces "your proposal X was approved" without
  // forcing a turn on the original (potentially huge) thread when the
  // resolution itself landed.

  function rigWithInbox() {
    const base = rig();
    const ownerAgentId = ulid();
    base.store
      .insert(tables.agents)
      .values({
        id: ownerAgentId,
        name: "p",
        hostId: base.hostId,
        scope: { allowTiers: ["operational", "strategic", "vision"] },
        channels: [],
        ownsMoney: true,
        createdAt: Date.now(),
      })
      .run();
    const inbox = createInbox({ bus: base.bus, store: base.store, hostId: base.hostId });
    return { ...base, inbox, ownerAgentId };
  }

  // Capture every system segment the LLM sees, turn-by-turn.
  function capturingLlm(scripted: Completion[]): {
    llm: Llm;
    systemsPerTurn: Array<Array<{ text: string; cache?: string }>>;
  } {
    const systemsPerTurn: Array<Array<{ text: string; cache?: string }>> = [];
    const llm: Llm = {
      provider: "mock",
      defaultModel: "mock-1",
      async complete(req: CompletionRequest): Promise<Completion> {
        const sys = req.system;
        const segs = Array.isArray(sys)
          ? sys.map((s) => ({ text: s.text, cache: s.cache }))
          : sys
            ? [{ text: sys as unknown as string }]
            : [];
        systemsPerTurn.push(segs);
        const c = scripted.shift();
        if (!c) throw new Error("capturingLlm exhausted");
        return c;
      },
    };
    return { llm, systemsPerTurn };
  }

  function sidebarTextFor(turnIndex: number, capture: ReturnType<typeof capturingLlm>): string {
    const segs = capture.systemsPerTurn[turnIndex] ?? [];
    // Sidebar segment is the one without cache hint (composeSystemSegments
    // marks the stable identity segment as cache:"ephemeral").
    const sidebarSeg = segs.find((s) => !s.cache);
    return sidebarSeg?.text ?? "";
  }

  async function sendAndAwait(
    r: ReturnType<typeof rigWithInbox>,
    text: string,
    threadId: string,
  ): Promise<void> {
    let resolved = false;
    const done = new Promise<void>((resolve) => {
      const unsub = r.bus.subscribe("chat.turn-end", (e) => {
        if (resolved) return;
        if (e.threadId === threadId) {
          resolved = true;
          unsub();
          resolve();
        }
      });
    });
    r.bus.publish({
      type: "chat.input",
      hostId: r.hostId,
      actorId: "cli",
      durable: true,
      toAgentId: r.agentId,
      threadId,
      payload: { text },
    });
    await done;
    // The chat loop's drain.finally clears thread.worker as a microtask
    // after this turn returns. Without yielding, an immediately-following
    // sendAndAwait would publish chat.input while worker still appears
    // set, and the message would sit in pending with nobody to drain it.
    // setImmediate yields past the microtask queue.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  it("renders unread resolution on next turn, not on turn after (HWM advances)", async () => {
    const r = rigWithInbox();
    const capture = capturingLlm([endTurn("ok1"), endTurn("ok2"), endTurn("ok3")]);
    const loop = startAgentLoop({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm: capture.llm,
      agentId: r.agentId,
      inbox: r.inbox,
      // Disable wake firing during this test — we're isolating the sidebar path.
      mailWakeDebounceMs: 60_000,
    });
    try {
      // Resolve a proposal AFTER the loop starts (so it lands above the HWM).
      const { id: d1 } = r.inbox.propose({
        ownerAgentId: r.ownerAgentId,
        proposingAgentId: r.agentId,
        tier: "strategic",
        summary: "Self-test findings: slim github_list_issues + auto-pick discord guild",
        payload: { fixes: 2 },
      });
      r.inbox.respond({ decisionId: d1, actorId: "principal", vote: "approve" });

      // Turn 1 — sidebar should mention the resolution.
      await sendAndAwait(r, "what's up?", "T1");
      const turn1Sidebar = sidebarTextFor(0, capture);
      expect(turn1Sidebar).toContain("Decision resolutions you haven't seen");
      expect(turn1Sidebar).toContain(d1);
      expect(turn1Sidebar).toContain("approved");

      // Turn 2 — same thread, no new resolutions: sidebar should NOT
      // re-render the same row (HWM advanced past it).
      await sendAndAwait(r, "anything else?", "T1");
      const turn2Sidebar = sidebarTextFor(1, capture);
      expect(turn2Sidebar).not.toContain(d1);
      expect(turn2Sidebar).not.toContain("Decision resolutions you haven't seen");

      // A second proposal lands and is resolved.
      const { id: d2 } = r.inbox.propose({
        ownerAgentId: r.ownerAgentId,
        proposingAgentId: r.agentId,
        tier: "strategic",
        summary: "Add Slack adapter",
        payload: {},
      });
      r.inbox.respond({ decisionId: d2, actorId: "principal", vote: "deny", message: "wait until v0.1" });

      // Turn 3 — d2 only (d1 already shown).
      await sendAndAwait(r, "ok cool", "T1");
      const turn3Sidebar = sidebarTextFor(2, capture);
      expect(turn3Sidebar).toContain("Decision resolutions you haven't seen");
      expect(turn3Sidebar).toContain(d2);
      expect(turn3Sidebar).toContain("denied");
      expect(turn3Sidebar).not.toContain(d1);
    } finally {
      loop.stop();
    }
  });

  it("does not ack unread resolutions when budget blocks the paid turn", async () => {
    const r = rigWithInbox();
    r.store
      .insert(tables.budgets)
      .values({
        id: ulid(),
        ownerAgentId: r.ownerAgentId,
        agentId: r.agentId,
        period: "all-time",
        capUsd: 1,
        capTokens: null,
        spentUsd: 1,
        spentTokens: 0,
        updatedAt: Date.now(),
      })
      .run();
    const capture = capturingLlm([endTurn("ok after cap raise")]);
    const loop = startAgentLoop({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm: capture.llm,
      agentId: r.agentId,
      ownerAgentId: r.ownerAgentId,
      inbox: r.inbox,
      mailWakeDebounceMs: 60_000,
    });
    try {
      const { id: d1 } = r.inbox.propose({
        ownerAgentId: r.ownerAgentId,
        proposingAgentId: r.agentId,
        tier: "strategic",
        summary: "approved while capped",
        payload: {},
      });
      r.inbox.respond({ decisionId: d1, actorId: "principal", vote: "approve" });

      const blocked = new Promise<string>((resolve) => {
        const unsub = r.bus.subscribe("chat.error", (e) => {
          if (e.threadId !== "T1") return;
          unsub();
          resolve((e.payload as { error: string }).error);
        });
      });
      r.bus.publish({
        type: "chat.input",
        hostId: r.hostId,
        actorId: "cli",
        durable: true,
        toAgentId: r.agentId,
        threadId: "T1",
        payload: { text: "while capped" },
      });
      await expect(blocked).resolves.toContain("budget exhausted");
      expect(capture.systemsPerTurn).toHaveLength(0);
      await new Promise<void>((resolve) => setImmediate(resolve));

      r.store
        .update(tables.budgets)
        .set({ capUsd: 2, updatedAt: Date.now() })
        .where(eq(tables.budgets.ownerAgentId, r.ownerAgentId))
        .run();

      await sendAndAwait(r, "after cap raise", "T1");
      const sidebar = sidebarTextFor(0, capture);
      expect(sidebar).toContain("Decision resolutions you haven't seen");
      expect(sidebar).toContain(d1);
      expect(sidebar).toContain("approved");
    } finally {
      loop.stop();
    }
  });

  it("does not surface resolutions that landed before the loop started", async () => {
    // HWM is initialized to loop-start; pre-existing history shouldn't
    // dump on the first turn (would be noise after a daemon restart).
    const r = rigWithInbox();
    // Resolve a proposal BEFORE the loop starts.
    const { id: dOld } = r.inbox.propose({
      ownerAgentId: r.ownerAgentId,
      proposingAgentId: r.agentId,
      tier: "strategic",
      summary: "old proposal pre-boot",
      payload: {},
    });
    r.inbox.respond({ decisionId: dOld, actorId: "principal", vote: "approve" });
    // Sleep ~5ms to ensure loop-start HWM > resolvedAt of dOld.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const capture = capturingLlm([endTurn("ok")]);
    const loop = startAgentLoop({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm: capture.llm,
      agentId: r.agentId,
      inbox: r.inbox,
      mailWakeDebounceMs: 60_000,
    });
    try {
      await sendAndAwait(r, "hello", "T1");
      const turn1Sidebar = sidebarTextFor(0, capture);
      expect(turn1Sidebar).not.toContain(dOld);
      expect(turn1Sidebar).not.toContain("Decision resolutions you haven't seen");
    } finally {
      loop.stop();
    }
  });

  it("HWM is per-thread — rendering on the mailbox wake thread does NOT ack the resolution for a separate chat thread", async () => {
    // The whole reason we keep mailHwm per-thread (not per-loop). Otherwise
    // the wake's mailbox:<agentId> turn would advance a shared HWM and
    // pre-empt the user-facing thread's sidebar.
    const r = rigWithInbox();
    const capture = capturingLlm([endTurn("on mailbox"), endTurn("on T1")]);
    const loop = startAgentLoop({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm: capture.llm,
      agentId: r.agentId,
      inbox: r.inbox,
      mailWakeDebounceMs: 60_000,
    });
    try {
      const { id: d1 } = r.inbox.propose({
        ownerAgentId: r.ownerAgentId,
        proposingAgentId: r.agentId,
        tier: "strategic",
        summary: "the thing",
        payload: {},
      });
      r.inbox.respond({ decisionId: d1, actorId: "principal", vote: "approve" });

      // Simulate the wake landing first by sending a turn on the mailbox thread.
      await sendAndAwait(r, "(synthetic mail wake)", `mailbox:${r.agentId}`);
      const mailboxSidebar = sidebarTextFor(0, capture);
      expect(mailboxSidebar).toContain(d1);
      expect(mailboxSidebar).toContain("approved");

      // Now the user re-engages on a fresh chat thread — its sidebar
      // should STILL show d1 even though the mailbox thread already
      // rendered (and acked, for itself) the same resolution.
      await sendAndAwait(r, "hi from user", "T1");
      const t1Sidebar = sidebarTextFor(1, capture);
      expect(t1Sidebar).toContain(d1);
      expect(t1Sidebar).toContain("approved");
    } finally {
      loop.stop();
    }
  });

  it("does not surface resolutions of proposals filed by other agents", async () => {
    const r = rigWithInbox();
    // Seed a second agent and have it propose+resolve.
    const otherAgent = "other";
    r.store
      .insert(tables.agents)
      .values({ id: otherAgent, name: otherAgent, hostId: r.hostId, createdAt: Date.now() })
      .run();
    const capture = capturingLlm([endTurn("ok")]);
    const loop = startAgentLoop({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm: capture.llm,
      agentId: r.agentId,
      inbox: r.inbox,
      mailWakeDebounceMs: 60_000,
    });
    try {
      const { id: dOther } = r.inbox.propose({
        ownerAgentId: r.ownerAgentId,
        proposingAgentId: otherAgent,
        tier: "strategic",
        summary: "not my proposal",
        payload: {},
      });
      r.inbox.respond({ decisionId: dOther, actorId: "principal", vote: "approve" });

      await sendAndAwait(r, "hi", "T1");
      const sb = sidebarTextFor(0, capture);
      expect(sb).not.toContain(dOther);
      expect(sb).not.toContain("Decision resolutions you haven't seen");
    } finally {
      loop.stop();
    }
  });
});
