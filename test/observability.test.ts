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
    const principalId = ulid();
    const agentId = ulid();
    store.insert(tables.principals).values({
      id: principalId,
      display: "p",
      channels: [],
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
      principalId,
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
  it("groups events by thread; folds chat.usage into cache hit ratio", () => {
    const { store, bus, hostId } = rig();
    const agentId = "agent-x";
    // Publish one chat.usage on each of two threads so the inventory
    // can compute different hit ratios per thread.
    bus.publish({
      type: "chat.usage",
      hostId,
      actorId: agentId,
      threadId: "t1",
      toAgentId: agentId,
      durable: true,
      payload: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 900, cacheCreationInputTokens: 0, totalTokens: 1050 },
    });
    bus.publish({
      type: "chat.turn-end",
      hostId,
      actorId: agentId,
      threadId: "t1",
      toAgentId: agentId,
      durable: true,
      payload: { stopReason: "end_turn" },
    });
    bus.publish({
      type: "chat.usage",
      hostId,
      actorId: agentId,
      threadId: "t2",
      toAgentId: agentId,
      durable: true,
      payload: { inputTokens: 1000, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 1050 },
    });

    const inv = threadInventory(store, { toAgentId: agentId });
    expect(inv.length).toBe(2);
    const t1 = inv.find((r) => r.threadId === "t1")!;
    const t2 = inv.find((r) => r.threadId === "t2")!;
    // 900 / (900 + 100) = 0.9
    expect(t1.cacheHitRatio).toBeCloseTo(0.9, 5);
    expect(t2.cacheHitRatio).toBe(0);

    const recent = recentEvents(store, { threadId: "t1" });
    expect(recent.length).toBe(2);
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
  });

  it("returns null for an unknown agent id", () => {
    const { store } = rig();
    expect(agentSelf(store, "does-not-exist")).toBeNull();
  });
});
