import { describe, expect, it } from "bun:test";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import { createCatchup } from "../src/mesh/catchup.ts";
import { type MeshEnvelope } from "../src/mesh/envelope.ts";

const TEAM_ID = "team-1";
const SECRET = "overlap-secret";

function cell(hostname: string) {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname, createdAt: Date.now() }).run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  return { store, bus, hostId };
}

describe("mesh / Catchup overlap", () => {
  it("a live event arriving mid-catchup is deduplicated by bus.inject", async () => {
    const A = cell("a");
    const B = cell("b");
    // A: two team events.
    const ev1 = A.bus.publish({
      type: "work.claimable",
      hostId: A.hostId,
      actorId: "a",
      durable: true,
      payload: { teamId: TEAM_ID, jobId: "J1" },
    });
    const ev2 = A.bus.publish({
      type: "work.claimable",
      hostId: A.hostId,
      actorId: "a",
      durable: true,
      payload: { teamId: TEAM_ID, jobId: "J2" },
    });

    const aCatchup = createCatchup({
      bus: A.bus,
      store: A.store,
      hostId: A.hostId,
      chunkSize: 10,
    });
    const bCatchup = createCatchup({
      bus: B.bus,
      store: B.store,
      hostId: B.hostId,
      chunkSize: 10,
    });

    // Subscribe to count how many times B's bus dispatches ev1.
    let ev1DeliverCount = 0;
    B.bus.subscribe("work.claimable", (ev) => {
      if (ev.id === ev1.id) ev1DeliverCount++;
    });

    const serveSend = (env: MeshEnvelope) => {
      if (env.kind === "catchup_chunk") {
        // Before delivering the chunk, sneak ev1 in as a "live" arrival.
        B.bus.inject(ev1, { remote: true });
        bCatchup.handleChunk(env as never);
      }
    };
    const requestSend = (env: MeshEnvelope) => {
      if (env.kind === "catchup_request") {
        aCatchup.serve({
          teamId: TEAM_ID,
          envelope: env as never,
          secret: SECRET,
          fromHostId: A.hostId,
          send: serveSend,
        });
      }
    };

    await bCatchup.request({
      teamId: TEAM_ID,
      peerHostId: A.hostId,
      secret: SECRET,
      sinceEventId: null,
      send: requestSend,
    });

    // Both events landed in B's store exactly once.
    const rows = B.store.raw
      .query<{ id: string }, []>("SELECT id FROM events ORDER BY id")
      .all();
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ev1.id);
    expect(ids).toContain(ev2.id);
    expect(new Set(ids).size).toBe(ids.length);
    // ev1 dispatched once on B (the live inject); the chunked redelivery
    // is a no-op thanks to in-memory dedup in bus.inject.
    expect(ev1DeliverCount).toBe(1);
  });
});
