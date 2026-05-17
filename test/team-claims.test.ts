// Leaderless claim window — two schedulers, single team-scoped claimable
// event. After the window expires exactly one cell wins and runs.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { createScheduler, type Scheduler } from "../src/scheduler/index.ts";
import { openStore, tables, type Store } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";

function rig() {
  // Shared store + shared bus across two schedulers. Each scheduler
  // registers its own task instance under a distinct task id but the
  // task_fingerprint we pass routes them into the same arbitration set.
  const store = openStore({ path: ":memory:" });
  const hostA = ulid();
  const hostB = ulid();
  store.insert(tables.hosts).values({ id: hostA, hostname: "a", createdAt: Date.now() }).run();
  store.insert(tables.hosts).values({ id: hostB, hostname: "b", createdAt: Date.now() }).run();

  const teamId = ulid();
  store.insert(tables.teams).values({ id: teamId, name: "team", createdAt: Date.now() }).run();

  const agentA = "agent-a";
  const agentB = "agent-b";
  for (const [id, hostId] of [
    [agentA, hostA],
    [agentB, hostB],
  ] as const) {
    store
      .insert(tables.agents)
      .values({ id, name: id, hostId, scope: {}, createdAt: Date.now() })
      .run();
  }

  // One bus shared between both schedulers — simulates an idealized mesh
  // where every claim is visible to every peer within the window.
  const bus = createBus({ hostId: hostA, persist: persistToStore(store) });

  return { store, bus, hostA, hostB, agentA, agentB, teamId };
}

describe("leaderless claim window", () => {
  let scheduler: Scheduler | null = null;
  let scheduler2: Scheduler | null = null;
  let store: Store | null = null;

  afterEach(() => {
    scheduler?.close();
    scheduler2?.close();
    store?.close();
    scheduler = null;
    scheduler2 = null;
    store = null;
  });

  it("exactly one host wins; the other persists status=lost; only winner runs", async () => {
    const r = rig();
    store = r.store;

    const ranOn: string[] = [];
    const taskFingerprint = "team-work-fp";

    scheduler = createScheduler({
      bus: r.bus,
      store: r.store,
      hostId: r.hostA,
      claimWindowMs: 30,
    });
    scheduler2 = createScheduler({
      bus: r.bus,
      store: r.store,
      hostId: r.hostB,
      claimWindowMs: 30,
    });

    // Same task id on both cells — the fingerprint default is
    // `${task.id}:${event.id}` so identical ids dedupe across hosts.
    scheduler.register({
      id: "team-work",
      agentId: r.agentA,
      tier: "operational",
      eventType: "team.work",
      handler: () => {
        ranOn.push(r.hostA);
      },
    });
    scheduler2.register({
      id: "team-work",
      agentId: r.agentB,
      tier: "operational",
      eventType: "team.work",
      handler: () => {
        ranOn.push(r.hostB);
      },
    });

    // Inject the trigger with claimable + teamId; both schedulers route
    // it through the leaderless window.
    r.bus.publish({
      type: "team.work",
      payload: { claimable: true, teamId: r.teamId, taskFingerprint },
      hostId: r.hostA,
      actorId: "trigger",
      durable: true,
    });

    // Wait long enough for the window to expire on both schedulers.
    await new Promise((res) => setTimeout(res, 100));

    const rows = r.store.raw
      .query<{ status: string; claim_id: string; claiming_host_id: string }, []>(
        "SELECT status, claim_id, claiming_host_id FROM team_claims ORDER BY claim_hlc",
      )
      .all();
    expect(rows.length).toBe(2);
    const won = rows.filter((x) => x.status === "won");
    const lost = rows.filter((x) => x.status === "lost");
    expect(won.length).toBe(1);
    expect(lost.length).toBe(1);
    // Only one cell ran the handler.
    expect(ranOn.length).toBe(1);
    // And the winner row's claiming_host_id matches the cell that ran.
    expect(ranOn[0]).toBe(won[0]!.claiming_host_id);
  });
});
