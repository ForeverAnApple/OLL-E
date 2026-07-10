import { describe, expect, it } from "bun:test";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { createLedger } from "../src/ledger/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import {
  agentSelf,
  budgetStatus,
  recentEvents,
  runHistory,
  threadInventory,
  usageStats,
} from "../src/observability/index.ts";
import { buildObservabilityTools } from "../src/tools/observability.ts";
import { ANTHROPIC_DEFAULT_MODEL as DEFAULT_MODEL } from "../src/llm/index.ts";

function rig() {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  return { store, bus, hostId };
}

describe("observability.usageStats", () => {
  it("aggregates totals + per-model breakdown across ledger rows", () => {
    const { store, bus, hostId } = rig();
    const ledger = createLedger({ store, bus, hostId });
    const agentId = "agent-1";
    // Two calls on opus, one on sonnet, one on the unknown-model fallback.
    ledger.record({
      actorId: agentId,
      threadId: "thr-A",
      provider: "anthropic",
      model: "claude-opus-4-7",
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 300,
      cacheCreationTokens: 0,
    });
    ledger.record({
      actorId: agentId,
      threadId: "thr-A",
      provider: "anthropic",
      model: "claude-opus-4-7",
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 800,
      cacheCreationTokens: 0,
    });
    ledger.record({
      actorId: agentId,
      threadId: "thr-B",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 500,
      outputTokens: 200,
    });
    ledger.record({
      actorId: agentId,
      provider: "anthropic",
      model: "unknown-model",
      inputTokens: 100,
      outputTokens: 50,
    });

    const all = usageStats(store, { actorId: agentId });
    expect(all.rows).toBe(4);
    expect(all.totals.inputTokens).toBe(1_800);
    expect(all.totals.outputTokens).toBe(850);
    expect(all.totals.cacheReadTokens).toBe(1_100);
    // hit ratio = cacheRead / (cacheRead + input) across all rows.
    expect(all.totals.cacheHitRatio).toBeCloseTo(1100 / (1100 + 1800), 5);
    // Three distinct (provider, model) groups.
    expect(all.byModel.length).toBe(3);
    const opus = all.byModel.find((m) => m.model === "claude-opus-4-7")!;
    expect(opus.calls).toBe(2);
    expect(opus.pricePosted).toBe(true);
    const unknown = all.byModel.find((m) => m.model === "unknown-model")!;
    expect(unknown.pricePosted).toBe(false);
    expect(all.totals.usdMicros).toBeGreaterThan(0);

    // Thread filter narrows to a single conversation.
    const onlyA = usageStats(store, { actorId: agentId, threadId: "thr-A" });
    expect(onlyA.rows).toBe(2);
    expect(onlyA.totals.cacheReadTokens).toBe(1_100);
  });
});

describe("observability.budgetStatus", () => {
  it("returns rows + percent computations", () => {
    const { store, hostId } = rig();
    const ownerAgentId = ulid();
    const agentId = ulid();
    store.insert(tables.agents).values({
      id: ownerAgentId,
      name: "p",
      hostId,
      scope: { allowTiers: ["operational", "strategic", "vision"] },
      channels: [],
      ownsMoney: true,
      createdAt: Date.now(),
    }).run();
    store.insert(tables.agents).values({
      id: agentId,
      name: "a",
      hostId,
      scope: {},
      createdAt: Date.now(),
    }).run();
    store.insert(tables.budgets).values({
      id: ulid(),
      ownerAgentId,
      agentId,
      period: "all-time",
      capUsd: 10_000_000, // $10
      capTokens: null,
      spentUsd: 2_500_000, // $2.50
      spentTokens: 1234,
      updatedAt: Date.now(),
    }).run();

    const status = budgetStatus(store, { actorId: agentId });
    expect(status.rows).toHaveLength(1);
    expect(status.rows[0]!.percentUsd).toBeCloseTo(0.25, 5);
    expect(status.rows[0]!.percentTokens).toBeNull();
  });
});

describe("observability.runHistory", () => {
  it("returns recent task_runs with computed durations", () => {
    const { store, hostId } = rig();
    const taskId = ulid();
    const eventId = ulid();
    const agentId = "a1";
    // Need agent + task + event rows for the FK constraints.
    store.insert(tables.agents).values({
      id: agentId,
      name: "a",
      hostId,
      scope: {},
      createdAt: Date.now(),
    }).run();
    store.insert(tables.events).values({
      id: eventId,
      hlc: "0",
      hostId,
      actorId: agentId,
      type: "x",
      payload: {},
      createdAt: Date.now(),
    }).run();
    store.insert(tables.tasks).values({
      id: taskId,
      agentId,
      triggerRefs: [],
      handlerRef: "h",
      tier: "operational",
      scope: {},
      tokenEst: 0,
      createdAt: Date.now(),
    }).run();
    const t0 = Date.now() - 1000;
    store.insert(tables.taskRuns).values({
      id: ulid(),
      taskId,
      eventId,
      hostId,
      agentId,
      status: "succeeded",
      startedAt: t0,
      endedAt: t0 + 250,
    }).run();
    store.insert(tables.taskRuns).values({
      id: ulid(),
      taskId,
      eventId,
      hostId,
      agentId,
      status: "running",
      startedAt: Date.now(),
    }).run();

    const all = runHistory(store, { actorId: agentId });
    expect(all).toHaveLength(2);
    const succeeded = all.find((r) => r.status === "succeeded")!;
    expect(succeeded.durationMs).toBe(250);
    const running = all.find((r) => r.status === "running")!;
    expect(running.durationMs).toBeNull();

    const onlyRunning = runHistory(store, { actorId: agentId, status: "running" });
    expect(onlyRunning).toHaveLength(1);
  });
});

describe("observability.threadInventory + recentEvents", () => {
  it("groups events by thread; folds chat.turn-end into cache hit ratio", () => {
    const { store, bus, hostId } = rig();
    const agentId = "agent-x";
    // Publish one chat.turn-end on each of two threads so the inventory
    // can compute different hit ratios per thread.
    bus.publish({
      type: "chat.turn-end",
      hostId,
      actorId: agentId,
      threadId: "t1",
      toAgentId: agentId,
      durable: true,
      payload: {
        stopReason: "end_turn",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 900,
        cacheCreationTokens: 0,
        totalTokens: 1050,
      },
    });
    bus.publish({
      type: "chat.turn-end",
      hostId,
      actorId: agentId,
      threadId: "t2",
      toAgentId: agentId,
      durable: true,
      payload: {
        stopReason: "end_turn",
        inputTokens: 1000,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 1050,
      },
    });

    const inv = threadInventory(store, { toAgentId: agentId });
    expect(inv.length).toBe(2);
    const t1 = inv.find((r) => r.threadId === "t1")!;
    const t2 = inv.find((r) => r.threadId === "t2")!;
    // 900 / (900 + 100) = 0.9
    expect(t1.cacheHitRatio).toBeCloseTo(0.9, 5);
    expect(t2.cacheHitRatio).toBe(0);
    // One completed turn each; no user text yet.
    expect(t1.turns).toBe(1);
    expect(t1.firstUserText).toBeNull();

    const recent = recentEvents(store, { threadId: "t1" });
    expect(recent.length).toBe(1);
  });

  it("snippet = oldest real user message; counts turns; skips mail-wake inputs", () => {
    const { store, bus, hostId } = rig();
    const agentId = "agent-snip";
    const turn = () =>
      bus.publish({
        type: "chat.turn-end",
        hostId,
        actorId: agentId,
        threadId: "t1",
        toAgentId: agentId,
        durable: true,
        payload: { stopReason: "end_turn", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 2 },
      });
    const userMsg = (text: string, extra: Record<string, unknown> = {}) =>
      bus.publish({
        type: "chat.input",
        hostId,
        actorId: "cli",
        threadId: "t1",
        toAgentId: agentId,
        durable: true,
        payload: { text, ...extra },
      });

    userMsg("hi");
    turn();
    userMsg("help me debug the auth flow");
    turn();
    userMsg("keep going", { mailWake: true }); // synthetic wake — must be ignored

    const t1 = threadInventory(store, { toAgentId: agentId }).find((r) => r.threadId === "t1")!;
    expect(t1.firstUserText).toBe("hi"); // oldest real user message
    expect(t1.turns).toBe(2); // two chat.turn-end
  });

  it("contextTokens = most recent turn's prompt size, not a sum across turns", () => {
    const { store, bus, hostId } = rig();
    const agentId = "agent-ctx";
    const turn = (input: number, cacheRead: number) =>
      bus.publish({
        type: "chat.turn-end",
        hostId,
        actorId: agentId,
        threadId: "t1",
        toAgentId: agentId,
        durable: true,
        payload: {
          stopReason: "end_turn",
          inputTokens: input,
          outputTokens: 5,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: 0,
          totalTokens: input + cacheRead + 5,
        },
      });

    turn(1000, 0); // older, smaller turn
    turn(4000, 8000); // most recent: 4000 input + 8000 cache read = 12000 context

    const t1 = threadInventory(store, { toAgentId: agentId }).find((r) => r.threadId === "t1")!;
    expect(t1.turns).toBe(2);
    // Latest turn's prompt size — NOT 1000+4000+8000 (that would be summing).
    expect(t1.contextTokens).toBe(12000);
  });

  // Regression: chat.ts emits chat.usage with durable:false (it's a live
  // per-call stream for subscribers, not a persisted record). Earlier
  // threadInventory keyed on chat.usage and so always reported a ratio
  // of 0 in production — chat.turn-end is the durable per-turn record
  // and is the right source.
  it("ignores transient chat.usage; uses durable chat.turn-end for cache stats", () => {
    const { store, bus, hostId } = rig();
    const agentId = "agent-x";
    bus.publish({
      type: "chat.usage",
      hostId,
      actorId: agentId,
      threadId: "t1",
      toAgentId: agentId,
      durable: false,
      payload: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 900,
        cacheCreationInputTokens: 0,
        totalTokens: 1050,
      },
    });
    bus.publish({
      type: "chat.turn-end",
      hostId,
      actorId: agentId,
      threadId: "t1",
      toAgentId: agentId,
      durable: true,
      payload: {
        stopReason: "end_turn",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 900,
        cacheCreationTokens: 0,
        totalTokens: 1050,
      },
    });

    const inv = threadInventory(store, { toAgentId: agentId });
    const t1 = inv.find((r) => r.threadId === "t1")!;
    expect(t1).toBeDefined();
    // 900 / (900 + 100) = 0.9 — sourced from the durable chat.turn-end.
    expect(t1.cacheHitRatio).toBeCloseTo(0.9, 5);
  });
});

describe("observability tools scope", () => {
  it("query_events defaults to the caller and rejects cross-actor widening", async () => {
    const { store, bus, hostId } = rig();
    bus.publish({
      type: "memory.wrote",
      hostId,
      actorId: "alice",
      durable: true,
      payload: { bodyMd: "alice private" },
    });
    bus.publish({
      type: "memory.wrote",
      hostId,
      actorId: "bob",
      durable: true,
      payload: { bodyMd: "bob private" },
    });
    const tool = buildObservabilityTools({ store }).find((t) => t.name === "query_events")!;
    const ctx = {
      hostId,
      extensionId: "",
      actorId: "alice",
      abort: new AbortController().signal,
      secrets: {},
    };
    const own = await tool.execute({}, ctx);
    expect(JSON.stringify(own)).toContain("alice private");
    expect(JSON.stringify(own)).not.toContain("bob private");
    expect(() => tool.execute({ actorId: "bob" }, ctx)).toThrow(/cross-actor/);
  });
});

describe("observability.agentSelf", () => {
  it("returns identity, scope, principle count, and recent models", () => {
    const { store, bus, hostId } = rig();
    const agentId = ulid();
    store.insert(tables.agents).values({
      id: agentId,
      name: "self-test",
      hostId,
      systemPrompt: "you are a worker",
      scope: { allowTiers: ["operational"] },
      createdAt: Date.now(),
    }).run();
    // One principle memory.
    store.insert(tables.memories).values({
      id: ulid(),
      hlc: "0",
      hostId,
      actorId: agentId,
      scope: "private",
      role: "principle",
      depth: 10,
      title: "honesty",
      bodyMd: "tell the truth",
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).run();
    // One ledger row so recentlyPricedModels has data.
    const ledger = createLedger({ store, bus, hostId });
    ledger.record({
      actorId: agentId,
      provider: "anthropic",
      model: "claude-opus-4-7",
      inputTokens: 10,
      outputTokens: 5,
    });

    const self = agentSelf(store, agentId)!;
    expect(self.name).toBe("self-test");
    expect(self.principleCount).toBe(1);
    expect(self.scope.allowTiers).toEqual(["operational"]);
    expect(self.recentlyPricedModels).toEqual([
      { provider: "anthropic", model: "claude-opus-4-7", pricePosted: true },
    ]);
    // No thinking-model memory → reports the host default, flagged as such.
    expect(self.thinkingModel).toBe(DEFAULT_MODEL);
    expect(self.thinkingModelIsDefault).toBe(true);
    expect(self.reasoningEffort).toBe("off");
  });

  it("reports the passed host default model when the agent has no thinking-model memory", () => {
    // Regression: an OpenAI-only host boots on gpt-5.5, but agentSelf hardcoded
    // the Anthropic default as its fallback — so `olle status` claimed Opus
    // while the agent actually ran gpt-5.5. The live host default must win.
    const { store, hostId } = rig();
    const agentId = ulid();
    store
      .insert(tables.agents)
      .values({ id: agentId, name: "gpt-host", hostId, createdAt: Date.now() })
      .run();

    const self = agentSelf(store, agentId, "gpt-5.5")!;
    expect(self.thinkingModel).toBe("gpt-5.5");
    // Still "default" — the agent made no explicit choice; the value just
    // tracks the host default rather than a hardcoded provider constant.
    expect(self.thinkingModelIsDefault).toBe(true);
  });

  it("reports the configured thinkingModel, not the ledger's recent model (the query_self bug)", () => {
    const { store, bus, hostId } = rig();
    const agentId = ulid();
    store
      .insert(tables.agents)
      .values({ id: agentId, name: "bocchi", hostId, createdAt: Date.now() })
      .run();
    // Switched to 4-8 (the configured/identity choice)...
    store
      .insert(tables.memories)
      .values({
        id: ulid(),
        hlc: "1",
        hostId,
        actorId: agentId,
        scope: "private",
        scopeRef: agentId,
        role: "thinking-model",
        depth: 1,
        title: "thinking-model",
        bodyMd: "claude-opus-4-8\n\nfaa asked me to switch",
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    // ...but the ledger is still dominated by pre-switch 4-7 spend.
    const ledger = createLedger({ store, bus, hostId });
    ledger.record({ actorId: agentId, provider: "anthropic", model: "claude-opus-4-7", inputTokens: 10, outputTokens: 5 });

    const self = agentSelf(store, agentId)!;
    expect(self.thinkingModel).toBe("claude-opus-4-8"); // authoritative
    expect(self.thinkingModelIsDefault).toBe(false);
    // recentlyPricedModels still shows history — which is exactly why it must
    // NOT be used to answer "what model am I?".
    expect(self.recentlyPricedModels[0]!.model).toBe("claude-opus-4-7");
  });

  it("reports reasoningEffort clamped against the agent's own model, not the default", () => {
    const { store, hostId } = rig();
    const agentId = ulid();
    store
      .insert(tables.agents)
      .values({ id: agentId, name: "ryo", hostId, createdAt: Date.now() })
      .run();
    // Configured for Sonnet (no xhigh/max dial) at effort `max`.
    const mem = (role: string, body: string) => ({
      id: ulid(),
      hlc: "1",
      hostId,
      actorId: agentId,
      scope: "private" as const,
      scopeRef: agentId,
      role,
      depth: 1,
      title: role,
      bodyMd: body,
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    store.insert(tables.memories).values(mem("thinking-model", "claude-sonnet-4-6\n\ncheaper")).run();
    store.insert(tables.memories).values(mem("reasoning-effort", "max\n\nwant depth")).run();

    const self = agentSelf(store, agentId)!;
    expect(self.thinkingModel).toBe("claude-sonnet-4-6");
    // The daemon clamps Sonnet's `max` down to `high` at loop start; query_self
    // must report the same effective level, not the stored `max`.
    expect(self.reasoningEffort).toBe("high");
  });

  it("returns null for an unknown agent id", () => {
    const { store } = rig();
    expect(agentSelf(store, "does-not-exist")).toBeNull();
  });
});
