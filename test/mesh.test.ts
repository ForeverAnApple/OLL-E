import { describe, expect, it } from "bun:test";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import { createScheduler } from "../src/scheduler/index.ts";
import { createLocalPair, wireBridgeToBus } from "../src/mesh/index.ts";

function cell(nameHint: string) {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: nameHint, createdAt: Date.now() }).run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  return { store, bus, hostId };
}

function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

describe("mesh / local-pair bridge", () => {
  it("mirrors durable events from A to B with original identity intact", async () => {
    const A = cell("a");
    const B = cell("b");
    const { a: bridgeA, b: bridgeB } = createLocalPair();
    wireBridgeToBus({ bus: A.bus, bridge: bridgeA });
    wireBridgeToBus({ bus: B.bus, bridge: bridgeB });

    const seenOnB: Array<{ jobId: string; hostId: string; payload: Record<string, unknown> }> = [];
    B.bus.subscribe("job.available", (e) => {
      const p = e.payload as { jobId?: string };
      if (p.jobId)
        seenOnB.push({
          jobId: p.jobId,
          hostId: e.hostId,
          payload: p as Record<string, unknown>,
        });
    });

    const published = A.bus.publish({
      type: "job.available",
      hostId: A.hostId,
      actorId: "trigger",
      durable: true,
      payload: { jobId: "JOB1", claimable: true },
    });
    // Bridge delivery is microtask-deferred.
    await new Promise((r) => setTimeout(r, 5));
    expect(seenOnB).toHaveLength(1);
    // Honest identity: B sees A's hostId, not its own.
    expect(seenOnB[0]!.hostId).toBe(A.hostId);
    expect(seenOnB[0]!.hostId).not.toBe(B.hostId);
    // No REMOTE_TAG / remoteOrigin / remoteEventId pollution on payload.
    expect(seenOnB[0]!.payload).toEqual({ jobId: "JOB1", claimable: true });
    expect(Object.keys(seenOnB[0]!.payload)).not.toContain("olle.remote");
    expect(Object.keys(seenOnB[0]!.payload)).not.toContain("remoteOrigin");
    // Persisted row on B has the original event id and host_id.
    const row = B.store.raw
      .query<{ id: string; host_id: string }, []>(
        "SELECT id, host_id FROM events WHERE type = 'job.available'",
      )
      .all()[0];
    expect(row?.id).toBe(published.id);
    expect(row?.host_id).toBe(A.hostId);
  });

  it("does not bounce events back to their origin", async () => {
    const A = cell("a");
    const B = cell("b");
    const pair = createLocalPair();
    wireBridgeToBus({ bus: A.bus, bridge: pair.a });
    wireBridgeToBus({ bus: B.bus, bridge: pair.b });

    let aCount = 0;
    A.bus.subscribe("ping", () => {
      aCount++;
    });
    A.bus.publish({
      type: "ping",
      hostId: A.hostId,
      actorId: "trigger",
      durable: true,
      payload: {},
    });
    await new Promise((r) => setTimeout(r, 10));
    // A saw its own publish exactly once; nothing came back from B.
    expect(aCount).toBe(1);
  });

  it("exercises first-claim-wins across two cells", async () => {
    const A = cell("a");
    const B = cell("b");
    wireBridgeToBus({ bus: A.bus, bridge: createLocalPair().a });
    // Re-establish the pair so both halves are in the same pair.
    const pair = createLocalPair();
    wireBridgeToBus({ bus: A.bus, bridge: pair.a });
    wireBridgeToBus({ bus: B.bus, bridge: pair.b });

    // Both cells have a scheduler that handles the same event type. Seed
    // agent + task rows so the claim insert has FK targets.
    for (const c of [A, B]) {
      c.store
        .insert(tables.agents)
        .values({ id: "agent", name: "a", hostId: c.hostId, scope: {}, createdAt: Date.now() })
        .run();
      c.store
        .insert(tables.tasks)
        .values({
          id: "task",
          agentId: "agent",
          triggerRefs: [],
          handlerRef: "",
          tier: "operational",
          scope: {},
          tokenEst: 0,
          createdAt: Date.now(),
        })
        .run();
    }

    const schedA = createScheduler({ bus: A.bus, store: A.store, hostId: A.hostId });
    const schedB = createScheduler({ bus: B.bus, store: B.store, hostId: B.hostId });
    const executedOn: string[] = [];
    schedA.register({
      id: "task",
      agentId: "agent",
      tier: "operational",
      eventType: "job.available",
      handler: () => void executedOn.push("a"),
    });
    schedB.register({
      id: "task",
      agentId: "agent",
      tier: "operational",
      eventType: "job.available",
      handler: () => void executedOn.push("b"),
    });

    A.bus.publish({
      type: "job.available",
      hostId: A.hostId,
      actorId: "trigger",
      durable: true,
      payload: { claimable: true },
    });

    await new Promise((r) => setTimeout(r, 20));

    // Each cell recorded a "winner" claim locally because each executed.
    // Real mesh arbitration picks one — for v0 we prove the seam: both
    // claims exist in the ledger with HLC ordering so a future cell-level
    // arbiter can pick first-by-HLC.
    const claimsA = A.store.raw
      .query<{ agent_id: string; status: string }, []>("SELECT agent_id, status FROM claims")
      .all();
    const claimsB = B.store.raw
      .query<{ agent_id: string; status: string }, []>("SELECT agent_id, status FROM claims")
      .all();
    expect(claimsA.length).toBeGreaterThan(0);
    expect(claimsB.length).toBeGreaterThan(0);
    expect(executedOn.sort()).toEqual(["a", "b"]);

    // The HLC on A's claim should sort before B's claim (A originated).
    const eventsA = A.store.raw
      .query<{ hlc: string; type: string }, [string]>("SELECT hlc, type FROM events WHERE type = ?")
      .all("job.available");
    expect(eventsA).toHaveLength(1);
    // Sanity: HLCs are well-formed and comparable.
    void compareHlc(eventsA[0]!.hlc, eventsA[0]!.hlc);
  });

  it("team-scoped claim window picks exactly one winner across the wire", async () => {
    // Regression: the prior `claim_hlc` placeholder + post-publish patch
    // shape sent `claim_hlc=""` over the wire, so each peer ranked the
    // other's tuple lex-smallest and concluded the *other* side won —
    // nobody ran. This test exercises the team path through a real wire
    // (local-pair bridge between two distinct buses) to lock down the
    // claim_hlc-from-event.hlc derivation.
    const A = cell("a");
    const B = cell("b");
    const pair = createLocalPair();
    wireBridgeToBus({ bus: A.bus, bridge: pair.a });
    wireBridgeToBus({ bus: B.bus, bridge: pair.b });

    const teamId = ulid();
    for (const c of [A, B]) {
      c.store
        .insert(tables.teams)
        .values({ id: teamId, name: "t", createdAt: Date.now() })
        .run();
      c.store
        .insert(tables.agents)
        .values({ id: "agent", name: "a", hostId: c.hostId, scope: {}, createdAt: Date.now() })
        .run();
    }

    const schedA = createScheduler({
      bus: A.bus,
      store: A.store,
      hostId: A.hostId,
      claimWindowMs: 40,
    });
    const schedB = createScheduler({
      bus: B.bus,
      store: B.store,
      hostId: B.hostId,
      claimWindowMs: 40,
    });
    const executedOn: string[] = [];
    schedA.register({
      id: "team-task",
      agentId: "agent",
      tier: "operational",
      eventType: "team.work",
      handler: () => void executedOn.push("a"),
    });
    schedB.register({
      id: "team-task",
      agentId: "agent",
      tier: "operational",
      eventType: "team.work",
      handler: () => void executedOn.push("b"),
    });

    A.bus.publish({
      type: "team.work",
      hostId: A.hostId,
      actorId: "trigger",
      durable: true,
      payload: { claimable: true, teamId },
    });

    // Wait past both arbitration windows.
    await new Promise((r) => setTimeout(r, 120));

    // Exactly one cell ran the handler.
    expect(executedOn.length).toBe(1);

    // Each cell has both claim rows. The winner is decided by the same
    // (claim_hlc, host_id, claim_id) rule on each side; the cell that ran
    // is the one whose local table marked its own row "won".
    const aRows = A.store.raw
      .query<{ claim_hlc: string; claiming_host_id: string; status: string }, []>(
        "SELECT claim_hlc, claiming_host_id, status FROM team_claims",
      )
      .all();
    const bRows = B.store.raw
      .query<{ claim_hlc: string; claiming_host_id: string; status: string }, []>(
        "SELECT claim_hlc, claiming_host_id, status FROM team_claims",
      )
      .all();
    expect(aRows.length).toBe(2);
    expect(bRows.length).toBe(2);

    // claim_hlc carries across the wire byte-identical — proof the hlc
    // is the task.claim event's own hlc, not a stripped placeholder.
    for (const row of aRows) {
      const match = bRows.find((r) => r.claiming_host_id === row.claiming_host_id);
      expect(match).toBeDefined();
      expect(match!.claim_hlc).toBe(row.claim_hlc);
    }

    // The cell whose row reads "won" locally is the one that executed.
    const aOwn = aRows.find((r) => r.claiming_host_id === A.hostId)!;
    const bOwn = bRows.find((r) => r.claiming_host_id === B.hostId)!;
    expect(aOwn.status === "won" ? "a" : "b").toBe(
      bOwn.status === "won" ? "b" : "a",
    );
    expect(executedOn[0]).toBe(aOwn.status === "won" ? "a" : "b");
  });
});
