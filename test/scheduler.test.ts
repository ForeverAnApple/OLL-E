import { describe, expect, it } from "bun:test";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { createScheduler } from "../src/scheduler/index.ts";
import { openStore } from "../src/store/index.ts";
import { createLedger } from "../src/ledger/index.ts";
import { tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";

function rig() {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  const scheduler = createScheduler({ bus, store, hostId });
  return { store, bus, scheduler, hostId };
}

describe("scheduler", () => {
  it("dispatches a registered task on matching event", async () => {
    const { bus, scheduler, hostId } = rig();
    const seen: number[] = [];
    scheduler.register({
      id: "t1",
      agentId: "a1",
      tier: "operational",
      eventType: "ping",
      handler(ctx) {
        seen.push((ctx.event.payload as { n: number }).n);
      },
    });
    bus.publish({ type: "ping", payload: { n: 1 }, hostId, actorId: "x" });
    bus.publish({ type: "ping", payload: { n: 2 }, hostId, actorId: "x" });
    // Allow microtasks to drain.
    await Promise.resolve();
    expect(seen).toEqual([1, 2]);
  });

  it("respects concurrency cap and queues overflow", async () => {
    const { bus, scheduler, hostId } = rig();
    let active = 0;
    let peak = 0;
    const done: Array<() => void> = [];
    scheduler.register({
      id: "t2",
      agentId: "a",
      tier: "operational",
      eventType: "slow",
      concurrency: 2,
      handler: () =>
        new Promise<void>((resolve) => {
          active += 1;
          peak = Math.max(peak, active);
          done.push(() => {
            active -= 1;
            resolve();
          });
        }),
    });
    for (let i = 0; i < 5; i++) {
      bus.publish({ type: "slow", payload: {}, hostId, actorId: "x" });
    }
    // two should be active; three queued
    await Promise.resolve();
    expect(scheduler.inflight().t2).toBe(2);
    // drain
    while (done.length) done.shift()!();
    // loop through until inflight=0
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 5));
      while (done.length) done.shift()!();
    }
    expect(peak).toBe(2);
  });

  it("writes a claims row for claimable events", () => {
    const { bus, scheduler, store, hostId } = rig();
    // Seed agent + task in the DB so the FK check passes.
    store.insert(tables.agents).values({
      id: "agent-1",
      name: "a",
      hostId,
      scope: {},
      createdAt: Date.now(),
    }).run();
    store.insert(tables.tasks).values({
      id: "task-1",
      agentId: "agent-1",
      triggerRefs: [],
      handlerRef: "",
      tier: "operational",
      scope: {},
      tokenEst: 0,
      createdAt: Date.now(),
    }).run();

    scheduler.register({
      id: "task-1",
      agentId: "agent-1",
      tier: "operational",
      eventType: "claimable.work",
      handler: () => undefined,
    });

    bus.publish({
      type: "claimable.work",
      payload: { claimable: true, job: "demo" },
      hostId,
      actorId: "trigger",
      durable: true,
    });

    const claims = store.raw
      .query<{ event_id: string; status: string }, []>("SELECT event_id, status FROM claims")
      .all();
    expect(claims.length).toBeGreaterThanOrEqual(1);
    expect(claims[0]!.status).toBe("winner");
  });
});

describe("ledger", () => {
  it("writes a row per record() and returns the id", () => {
    const { store, bus, hostId } = rig();
    const ledger = createLedger({ store, bus, hostId });
    const { ledgerId } = ledger.record({
      actorId: "a",
      provider: "anthropic",
      model: "claude-opus-4-7",
      tokens: 1000,
      usd: 5000, // micro-USD
    });
    const rows = store.raw.query<{ id: string }, []>("SELECT id FROM ledger").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(ledgerId);
  });

  it("emits budget.threshold and budget.exceeded at 80% and 100%", () => {
    const { store, bus, hostId } = rig();
    const principalId = ulid();
    const agentId = "a";
    store.insert(tables.principals).values({
      id: principalId,
      display: "me",
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
      capUsd: 1_000_000, // $1.00
      capTokens: null,
      spentTokens: 0,
      spentUsd: 0,
      updatedAt: Date.now(),
    }).run();

    const ledger = createLedger({ store, bus, hostId });
    const events: string[] = [];
    bus.subscribe("*", (e) => void events.push(e.type));

    // 50% — no event
    ledger.record({
      actorId: agentId,
      principalId,
      provider: "anthropic",
      model: "x",
      tokens: 100,
      usd: 500_000,
    });
    expect(events).not.toContain("budget.threshold");
    // 85% — cross 80%
    ledger.record({
      actorId: agentId,
      principalId,
      provider: "anthropic",
      model: "x",
      tokens: 100,
      usd: 350_000,
    });
    expect(events).toContain("budget.threshold");
    expect(events).not.toContain("budget.exceeded");
    // 110% — cross 100%
    const { overBudget } = ledger.record({
      actorId: agentId,
      principalId,
      provider: "anthropic",
      model: "x",
      tokens: 100,
      usd: 250_000,
    });
    expect(events).toContain("budget.exceeded");
    expect(overBudget).toBe(true);
  });
});
