// Late-arrival partition: cell A's window fires before cell B's claim is
// observed. A wins locally and starts the run. B's claim then arrives with
// a strictly lower tuple. Expected: A's row flips to `split_brain`, a
// durable `mesh.claim-split-brain` event is published, and A's running task
// is NOT aborted (the plan: duplicate work is less harmful than tearing
// down a half-finished run).

import { afterEach, describe, expect, it } from "bun:test";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { createScheduler, type Scheduler } from "../src/scheduler/index.ts";
import { openStore, tables, type Store } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import type { Event } from "../src/bus/types.ts";

function rig() {
  const store = openStore({ path: ":memory:" });
  const hostA = ulid();
  const hostB = ulid();
  store.insert(tables.hosts).values({ id: hostA, hostname: "a", createdAt: Date.now() }).run();
  store.insert(tables.hosts).values({ id: hostB, hostname: "b", createdAt: Date.now() }).run();
  const teamId = ulid();
  store.insert(tables.teams).values({ id: teamId, name: "team", createdAt: Date.now() }).run();
  const agentA = "agent-a";
  store
    .insert(tables.agents)
    .values({ id: agentA, name: agentA, hostId: hostA, scope: {}, createdAt: Date.now() })
    .run();
  const bus = createBus({ hostId: hostA, persist: persistToStore(store) });
  return { store, bus, hostA, hostB, agentA, teamId };
}

describe("split-brain on late-arrival peer claim", () => {
  let scheduler: Scheduler | null = null;
  let store: Store | null = null;

  afterEach(() => {
    scheduler?.close();
    store?.close();
    scheduler = null;
    store = null;
  });

  it("marks our won row split_brain, emits mesh.claim-split-brain, run is not aborted", async () => {
    const r = rig();
    store = r.store;

    let handlerDone = false;
    // Resolve the handler-running promise externally so we can keep the
    // task in-flight while we inject the late peer claim.
    let releaseHandler!: () => void;
    const handlerPromise = new Promise<void>((res) => {
      releaseHandler = res;
    });

    scheduler = createScheduler({
      bus: r.bus,
      store: r.store,
      hostId: r.hostA,
      claimWindowMs: 20,
    });
    scheduler.register({
      id: "team-work",
      agentId: r.agentA,
      tier: "operational",
      eventType: "team.work",
      handler: async () => {
        await handlerPromise;
        handlerDone = true;
      },
    });

    const splitBrainEvents: Event[] = [];
    r.bus.subscribe("mesh.claim-split-brain", (e) => {
      splitBrainEvents.push(e);
    });

    // Trigger: A registers intent, no peers respond, A's timer fires,
    // A's row goes to `won`, handler starts and awaits releaseHandler.
    const trigger = r.bus.publish({
      type: "team.work",
      payload: { claimable: true, teamId: r.teamId },
      hostId: r.hostA,
      actorId: "trigger",
      durable: true,
    });

    // Wait past the claim window so A wins and the handler is in-flight.
    await new Promise((res) => setTimeout(res, 40));

    // Confirm A's row is won and handler is still running.
    const wonBefore = r.store.raw
      .query<{ claim_id: string; status: string }, [string]>(
        "SELECT claim_id, status FROM team_claims WHERE claiming_host_id = ?",
      )
      .all(r.hostA);
    expect(wonBefore.length).toBe(1);
    expect(wonBefore[0]!.status).toBe("won");
    expect(handlerDone).toBe(false);

    // Hand-craft B's late-arrival claim. Make its tuple strictly lower
    // than A's: claim_hlc is derived from event.hlc, and "0000..."
    // lexicographically precedes any real HLC.
    const ourClaim = wonBefore[0]!;
    const lateClaimId = ulid();
    const lateEvent: Event = {
      id: ulid(),
      hlc: "0000000000000-0000-AAAAAAAAAA",
      hostId: r.hostB,
      actorId: "agent-b",
      type: "task.claim",
      payload: {
        teamId: r.teamId,
        eventId: trigger.id,
        eventHlc: trigger.hlc,
        claimId: lateClaimId,
        claimingHostId: r.hostB,
        claimingAgentId: "agent-b",
        taskId: "team-work",
        taskFingerprint: `team-work:${trigger.id}`,
      },
      parentEventId: trigger.id,
      createdAt: Date.now(),
      durable: true,
    };

    r.bus.inject(lateEvent, { remote: true });

    // Let the synchronous handler chain settle.
    await new Promise((res) => setTimeout(res, 5));

    // Our row should be flagged split_brain; the split-brain event should
    // have fired; the running handler is still pending.
    const allRows = r.store.raw
      .query<{ claim_id: string; status: string; claiming_host_id: string }, []>(
        "SELECT claim_id, status, claiming_host_id FROM team_claims",
      )
      .all();
    // Sanity: both A's and B's intents should be in the table.
    expect(allRows.length).toBe(2);
    const afterRows = r.store.raw
      .query<{ claim_id: string; status: string }, [string]>(
        "SELECT claim_id, status FROM team_claims WHERE claim_id = ?",
      )
      .all(ourClaim.claim_id);
    expect(afterRows[0]!.status).toBe("split_brain");
    expect(splitBrainEvents.length).toBe(1);
    expect(handlerDone).toBe(false);

    // Release: the in-flight task completes normally.
    releaseHandler();
    await new Promise((res) => setTimeout(res, 5));
    expect(handlerDone).toBe(true);
  });
});
