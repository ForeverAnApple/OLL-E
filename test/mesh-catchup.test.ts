import { describe, expect, it } from "bun:test";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import { createCatchup } from "../src/mesh/catchup.ts";
import {
  MESH_PROTO,
  signEnvelope,
  type MeshEnvelope,
  type UnsignedEnvelope,
} from "../src/mesh/envelope.ts";

const SECRET = "catchup-secret";
const TEAM_ID = "team-1";

function cell(hostname: string) {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname, createdAt: Date.now() }).run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  return { store, bus, hostId };
}

function teamEvent(
  hostId: string,
  type: string,
  payload: Record<string, unknown>,
): import("../src/bus/types.ts").Event {
  return {
    id: ulid(),
    hlc: "0000000000000000-0000",
    hostId,
    actorId: "agent",
    type,
    payload,
    createdAt: Date.now(),
    durable: true,
  };
}

describe("mesh / Catchup", () => {
  it("request → serve → chunks → final hasMore=false flows events through bus.inject", async () => {
    // Two cells: A is the serving peer, B is the requesting peer.
    // A's store has 3 team-scoped events; B starts empty.
    const A = cell("a");
    const B = cell("b");
    // Persist 3 team events into A.
    const ev1 = A.bus.publish({
      type: "work.claimable",
      hostId: A.hostId,
      actorId: "a",
      durable: true,
      payload: { teamId: TEAM_ID, jobId: "J1" },
    });
    const ev2 = A.bus.publish({
      type: "memory.wrote",
      hostId: A.hostId,
      actorId: "a",
      durable: true,
      payload: { scope: "team", scopeRef: TEAM_ID, memoryId: "m1" },
    });
    const ev3 = A.bus.publish({
      type: "work.claimable",
      hostId: A.hostId,
      actorId: "a",
      durable: true,
      payload: { teamId: TEAM_ID, jobId: "J2" },
    });
    // And a non-team event that must NOT be served.
    const evPrivate = A.bus.publish({
      type: "memory.wrote",
      hostId: A.hostId,
      actorId: "a",
      durable: true,
      payload: { scope: "private", scopeRef: "a", memoryId: "p1" },
    });

    const aCatchup = createCatchup({
      bus: A.bus,
      store: A.store,
      hostId: A.hostId,
      chunkSize: 2,
    });
    const bCatchup = createCatchup({
      bus: B.bus,
      store: B.store,
      hostId: B.hostId,
      chunkSize: 2,
    });

    // Bridge: feed serve outputs back into the requester via handleChunk.
    const serveSend = (env: MeshEnvelope) => {
      // Round-trip the envelope (encode/decode roundtrip would normally
      // happen via wire; here we feed directly).
      if (env.kind === "catchup_chunk") {
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

    const watermarks: string[] = [];
    await bCatchup.request({
      teamId: TEAM_ID,
      peerHostId: A.hostId,
      secret: SECRET,
      sinceEventId: null,
      send: requestSend,
      onWatermark: (w) => watermarks.push(w),
    });

    // B should now have the three team events but not the private one.
    const rows = B.store.raw
      .query<{ id: string; type: string }, []>("SELECT id, type FROM events ORDER BY id")
      .all();
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ev1.id);
    expect(ids).toContain(ev2.id);
    expect(ids).toContain(ev3.id);
    expect(ids).not.toContain(evPrivate.id);
    expect(watermarks.length).toBeGreaterThan(0);
    expect(watermarks[watermarks.length - 1]).toBe(ev3.id);
  });

  it("drops wrong-team and private-memory events inside catchup chunks", async () => {
    const B = cell("b");
    const bCatchup = createCatchup({ bus: B.bus, store: B.store, hostId: B.hostId });
    const violations: Array<{ reason: string }> = [];
    B.bus.subscribe("mesh.scope-violation", (event) => {
      violations.push(event.payload as { reason: string });
    });

    const request = bCatchup.request({
      teamId: TEAM_ID,
      peerHostId: "peer-a",
      secret: SECRET,
      sinceEventId: null,
      send: () => {},
    });
    const good = teamEvent("peer-a", "work.claimable", { teamId: TEAM_ID, jobId: "J1" });
    const wrongTeam = teamEvent("peer-a", "work.claimable", {
      teamId: "team-other",
      jobId: "J2",
    });
    const privateMemory = teamEvent("peer-a", "memory.wrote", {
      id: "private-memory",
      actorId: "agent",
      scope: "private",
      scopeRef: "agent",
      role: "knowledge",
      title: "private",
      bodyMd: "no leak",
      tags: [],
      depth: 1,
    });
    const teamMemory = teamEvent("peer-a", "memory.wrote", {
      id: "team-memory",
      actorId: "agent",
      scope: "team",
      scopeRef: TEAM_ID,
      role: "knowledge",
      title: "shared",
      bodyMd: "ok",
      tags: [],
      depth: 1,
    });
    const unsigned: UnsignedEnvelope = {
      proto: MESH_PROTO,
      envelopeId: "chunk-1",
      teamId: TEAM_ID,
      fromHostId: "peer-a",
      kind: "catchup_chunk",
      payload: {
        events: [good, wrongTeam, privateMemory, teamMemory],
        hasMore: false,
      },
      sentAt: Date.now(),
    } as UnsignedEnvelope;
    const env = { ...unsigned, hmac: signEnvelope(unsigned, SECRET) } as MeshEnvelope;

    expect(bCatchup.handleChunk(env as never)).toBe(true);
    await request;

    const rows = B.store.raw.query<{ id: string }, []>("SELECT id FROM events").all();
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(good.id);
    expect(ids).toContain(teamMemory.id);
    expect(ids).not.toContain(wrongTeam.id);
    expect(ids).not.toContain(privateMemory.id);
    expect(violations.map((v) => v.reason).sort()).toEqual([
      "memory-non-team-scope",
      "payload-team-mismatch",
    ]);
  });

  it("handleChunk reports false when no in-flight request matches", () => {
    const B = cell("b");
    const bCatchup = createCatchup({ bus: B.bus, store: B.store, hostId: B.hostId });
    const unsigned: UnsignedEnvelope = {
      proto: MESH_PROTO,
      envelopeId: "x",
      teamId: TEAM_ID,
      fromHostId: "unknown-host",
      kind: "catchup_chunk",
      payload: { events: [], hasMore: false },
      sentAt: Date.now(),
    } as UnsignedEnvelope;
    const env = { ...unsigned, hmac: signEnvelope(unsigned, SECRET) } as MeshEnvelope;
    expect(bCatchup.handleChunk(env as never)).toBe(false);
  });
});
