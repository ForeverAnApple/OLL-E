// setBudget (the budget.set write surface) + its integration with the
// ledger decrement path: an armed cap accumulates spend on record() and
// flips overBudget when crossed; re-setting a cap preserves spend.

import { describe, expect, it } from "bun:test";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import { createLedger, setBudget } from "../src/ledger/index.ts";

function rig() {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  const humanId = ulid();
  const rootId = ulid();
  store
    .insert(tables.agents)
    .values({ id: humanId, name: "human", hostId, ownsMoney: true, createdAt: Date.now() })
    .run();
  store
    .insert(tables.agents)
    .values({ id: rootId, name: "root", hostId, parentAgentId: humanId, createdAt: Date.now() })
    .run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  return { store, bus, hostId, humanId, rootId };
}

describe("setBudget", () => {
  it("creates a row, and a later set preserves accumulated spend", () => {
    const r = rig();
    const created = setBudget(r.store, {
      ownerAgentId: r.humanId,
      agentId: r.rootId,
      capUsdMicros: 100_000_000, // $100
    });
    expect(created.created).toBe(true);
    expect(created.capUsdMicros).toBe(100_000_000);
    expect(created.spentUsdMicros).toBe(0);

    // Spend against it through the real decrement path.
    const ledger = createLedger({ bus: r.bus, store: r.store, hostId: r.hostId });
    const { usdMicros, overBudget } = ledger.record({
      actorId: r.rootId,
      ownerAgentId: r.humanId,
      threadId: "t1",
      provider: "anthropic",
      model: "claude-opus-4-8",
      inputTokens: 1_000_000, // $5 at posted rates
      outputTokens: 0,
    });
    expect(usdMicros).toBe(5_000_000);
    expect(overBudget).toBe(false);

    // Cap change is a policy change, not an amnesty — spend survives.
    const updated = setBudget(r.store, {
      ownerAgentId: r.humanId,
      agentId: r.rootId,
      capUsdMicros: 4_000_000, // $4 — below what's already spent
    });
    expect(updated.created).toBe(false);
    expect(updated.spentUsdMicros).toBe(5_000_000);

    // Next spend sees the wall.
    const second = ledger.record({
      actorId: r.rootId,
      ownerAgentId: r.humanId,
      threadId: "t1",
      provider: "anthropic",
      model: "claude-opus-4-8",
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(second.overBudget).toBe(true);
  });

  it("caps are keyed per (owner, agent, period) — another agent stays uncapped", () => {
    const r = rig();
    setBudget(r.store, { ownerAgentId: r.humanId, agentId: r.rootId, capUsdMicros: 1 });
    const ledger = createLedger({ bus: r.bus, store: r.store, hostId: r.hostId });
    const other = ledger.record({
      actorId: r.humanId, // different agent id than the capped row
      ownerAgentId: r.humanId,
      threadId: "t2",
      provider: "anthropic",
      model: "claude-opus-4-8",
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(other.overBudget).toBe(false);
  });
});
