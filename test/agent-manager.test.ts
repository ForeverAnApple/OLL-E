import { describe, expect, it } from "bun:test";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import { createAgentManager } from "../src/agent/index.ts";
import type { Completion, CompletionRequest, Llm } from "../src/llm/types.ts";
import type { Event } from "../src/bus/types.ts";
import { eq } from "drizzle-orm";

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

function rig(parentScope?: Record<string, unknown>) {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  const parentId = "parent";
  store
    .insert(tables.agents)
    .values({
      id: parentId,
      name: "parent",
      hostId,
      scope: (parentScope ?? {}) as never,
      createdAt: Date.now(),
    })
    .run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  return { store, bus, hostId, parentId };
}

describe("agent manager — spawn", () => {
  it("spawns a child that responds to the mission in its own thread", async () => {
    const r = rig();
    const mgr = createAgentManager({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm: mockLlm([endTurn("acknowledged")]),
    });
    const firstReply = new Promise<Event>((resolve) => {
      const unsub = r.bus.subscribe("chat.turn-end", (ev) => {
        unsub();
        resolve(ev);
      });
    });
    const result = await mgr.spawn({
      name: "worker",
      mission: "go do the thing",
      parentAgentId: r.parentId,
    });
    expect(result.agentId).toBeDefined();
    expect(result.threadId).toBeDefined();

    const ev = await firstReply;
    // Child's reply is tagged with the spawn thread so the parent can
    // correlate progress without coupling to mailbox semantics.
    expect(ev.threadId).toBe(result.threadId);
    expect(ev.actorId).toBe(result.agentId);

    // agents row exists with the parent link.
    const row = r.store
      .select()
      .from(tables.agents)
      .where(eq(tables.agents.id, result.agentId))
      .all()[0];
    expect(row?.parentAgentId).toBe(r.parentId);
    mgr.shutdown();
  });

  it("rejects a child scope that exceeds the parent's authority", async () => {
    const r = rig({ allowTiers: ["operational"] });
    const mgr = createAgentManager({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm: mockLlm([]),
    });
    await expect(
      mgr.spawn({
        name: "worker",
        mission: "x",
        parentAgentId: r.parentId,
        scope: { allowTiers: ["operational", "strategic"] },
      }),
    ).rejects.toThrow(/exceeds parent authority/);
    mgr.shutdown();
  });

  it("emits agent.spawned on successful spawn", async () => {
    const r = rig();
    const mgr = createAgentManager({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm: mockLlm([endTurn("ack")]),
    });
    const spawnSeen = new Promise<Event>((resolve) => {
      r.bus.subscribe("agent.spawned", resolve);
    });
    const result = await mgr.spawn({
      name: "worker",
      mission: "m",
      parentAgentId: r.parentId,
    });
    const ev = await spawnSeen;
    expect((ev.payload as { childId: string }).childId).toBe(result.agentId);
    mgr.shutdown();
  });
});

describe("agent manager — kill", () => {
  it("stops a running child's loop and emits agent.killed", async () => {
    const r = rig();
    const mgr = createAgentManager({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm: mockLlm([endTurn("ack"), endTurn("ignored")]),
    });
    const firstDone = new Promise<void>((resolve) => {
      const unsub = r.bus.subscribe("chat.turn-end", () => {
        unsub();
        resolve();
      });
    });
    const result = await mgr.spawn({
      name: "worker",
      mission: "first",
      parentAgentId: r.parentId,
    });
    await firstDone;
    expect(mgr.list()).toContain(result.agentId);

    const killed = new Promise<Event>((resolve) => {
      r.bus.subscribe("agent.killed", resolve);
    });
    mgr.kill(result.agentId);
    const ev = await killed;
    expect((ev.payload as { agentId: string }).agentId).toBe(result.agentId);
    expect(mgr.list()).not.toContain(result.agentId);

    // Second mission into dead mailbox is silently ignored — no crash,
    // no turn-end. Spy on chat.turn-end to confirm.
    let postKillTurns = 0;
    r.bus.subscribe("chat.turn-end", () => {
      postKillTurns += 1;
    });
    r.bus.publish({
      type: "chat.input",
      hostId: r.hostId,
      actorId: r.parentId,
      durable: true,
      toAgentId: result.agentId,
      threadId: result.threadId,
      payload: { text: "still there?" },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(postKillTurns).toBe(0);
    mgr.shutdown();
  });

  it("kill of unknown agent is a no-op", () => {
    const r = rig();
    const mgr = createAgentManager({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm: mockLlm([]),
    });
    mgr.kill("does-not-exist");
    expect(mgr.list()).toEqual([]);
    mgr.shutdown();
  });
});

describe("agent manager — mailSummary", () => {
  it("groups events by thread, most-recent first, only for the given agent", () => {
    const r = rig();
    const mgr = createAgentManager({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm: mockLlm([]),
    });
    // Drop a mix of events into the store via the bus (durable).
    // Two threads addressed to "parent"; one thread addressed to
    // "someone-else" that must not appear in parent's summary.
    for (let i = 0; i < 3; i++) {
      r.bus.publish({
        type: "chat.input",
        hostId: r.hostId,
        actorId: "cli",
        durable: true,
        toAgentId: r.parentId,
        threadId: "thread-A",
        payload: { text: `A${i}` },
      });
    }
    r.bus.publish({
      type: "chat.input",
      hostId: r.hostId,
      actorId: "cli",
      durable: true,
      toAgentId: r.parentId,
      threadId: "thread-B",
      payload: { text: "B0" },
    });
    r.bus.publish({
      type: "chat.input",
      hostId: r.hostId,
      actorId: "cli",
      durable: true,
      toAgentId: "someone-else",
      threadId: "thread-Z",
      payload: { text: "Z0" },
    });

    const summary = mgr.mailSummary(r.parentId);
    const ids = summary.map((s) => s.threadId);
    expect(ids).toContain("thread-A");
    expect(ids).toContain("thread-B");
    expect(ids).not.toContain("thread-Z");
    const a = summary.find((s) => s.threadId === "thread-A")!;
    expect(a.events).toBe(3);
    mgr.shutdown();
  });
});

describe("agent manager — retarget_thread", () => {
  it("stores an override and emits thread.retargeted", () => {
    const r = rig();
    const mgr = createAgentManager({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm: mockLlm([]),
    });
    const events: Event[] = [];
    r.bus.subscribe("thread.retargeted", (ev) => {
      events.push(ev);
    });

    expect(mgr.resolveMailbox("t1")).toBeUndefined();
    mgr.retargetThread("t1", "secretary");
    expect(mgr.resolveMailbox("t1")).toBe("secretary");
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      threadId: "t1",
      current: "secretary",
      previous: undefined,
    });

    // Clearing with undefined removes the override.
    mgr.retargetThread("t1", undefined);
    expect(mgr.resolveMailbox("t1")).toBeUndefined();
    expect(events).toHaveLength(2);
    expect(events[1]!.payload).toMatchObject({
      threadId: "t1",
      current: null,
      previous: "secretary",
    });
    mgr.shutdown();
  });
});
