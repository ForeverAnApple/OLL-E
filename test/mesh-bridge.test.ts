import { describe, expect, it } from "bun:test";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import { startRealMeshBridge } from "../src/mesh/bridge.ts";
import {
  MESH_PROTO,
  signEnvelope,
  type MeshEnvelope,
  type UnsignedEnvelope,
} from "../src/mesh/envelope.ts";

// Fake socket harness: identical to the one in mesh-peer.test.ts but
// scoped per test. Each created WebSocket is captured on a registry so
// the test drives open/message/close manually.
class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  private listeners = new Map<string, Set<(ev: unknown) => void>>();
  public sent: string[] = [];
  constructor(public addr: string) {}
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }
  send(raw: string): void {
    this.sent.push(raw);
  }
  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.fire("close", {});
  }
  fire(type: string, ev: unknown): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of set) fn(ev);
  }
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.fire("open", {});
  }
  message(raw: string): void {
    this.fire("message", { data: raw });
  }
}

function createRegistry() {
  const sockets: FakeWebSocket[] = [];
  const factory = (addr: string): WebSocket => {
    const s = new FakeWebSocket(addr);
    sockets.push(s);
    return s as unknown as WebSocket;
  };
  return { sockets, factory };
}

function cell(hostname: string, port: number) {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname, createdAt: Date.now() }).run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  return { store, bus, hostId, port };
}

async function pickFreePort(): Promise<number> {
  // We don't actually open a listener for the bridge tests below — most
  // of them exercise outbound only. The bridge requires a port; we still
  // pass one and start() will try to bind. To keep tests hermetic we
  // skip start() where possible.
  return 30_000 + Math.floor(Math.random() * 20_000);
}

const SECRET = "bridge-secret";
const TEAM_ID = "team-1";

function makeEventEnvelope(
  teamId: string,
  fromHostId: string,
  event: import("../src/bus/types.ts").Event,
  secret: string,
): MeshEnvelope {
  const unsigned: UnsignedEnvelope = {
    proto: MESH_PROTO,
    envelopeId: "env-" + Math.random().toString(36).slice(2),
    teamId,
    fromHostId,
    kind: "event",
    event,
    sentAt: Date.now(),
  } as UnsignedEnvelope;
  return { ...unsigned, hmac: signEnvelope(unsigned, secret) } as MeshEnvelope;
}

describe("mesh / RealMeshBridge outbound scope filter", () => {
  it("drops events without payload.teamId", async () => {
    const reg = createRegistry();
    const A = cell("a", await pickFreePort());
    const bridge = startRealMeshBridge({
      bus: A.bus,
      store: A.store,
      hostId: A.hostId,
      port: A.port,
      loadTeams: () => [],
      onPeerStatus: () => {},
      webSocketFactory: reg.factory,
    });
    bridge.setTeamSecret(TEAM_ID, SECRET);
    bridge.addPeer(TEAM_ID, "peer-host", "ws://fake");
    // Let the PeerLink construct.
    await new Promise((r) => setTimeout(r, 0));
    expect(reg.sockets).toHaveLength(1);
    reg.sockets[0]!.open();
    // Drain initial hello.
    const baseline = reg.sockets[0]!.sent.length;
    // Broadcast an event with NO teamId.
    bridge.asBridge().broadcast({
      id: ulid(),
      hlc: "0000000000000000-0000",
      hostId: A.hostId,
      actorId: "a",
      type: "noise",
      payload: { thing: 1 },
      createdAt: Date.now(),
      durable: true,
    });
    // Nothing should have been appended.
    expect(reg.sockets[0]!.sent.length).toBe(baseline);
    await bridge.close();
  });

  it("drops events whose payload.teamId we're not a member of", async () => {
    const reg = createRegistry();
    const A = cell("a", await pickFreePort());
    const bridge = startRealMeshBridge({
      bus: A.bus,
      store: A.store,
      hostId: A.hostId,
      port: A.port,
      loadTeams: () => [],
      onPeerStatus: () => {},
      webSocketFactory: reg.factory,
    });
    bridge.setTeamSecret(TEAM_ID, SECRET);
    bridge.addPeer(TEAM_ID, "peer-host", "ws://fake");
    await new Promise((r) => setTimeout(r, 0));
    reg.sockets[0]!.open();
    const baseline = reg.sockets[0]!.sent.length;
    bridge.asBridge().broadcast({
      id: ulid(),
      hlc: "0000000000000000-0000",
      hostId: A.hostId,
      actorId: "a",
      type: "work.claimable",
      payload: { teamId: "team-other" },
      createdAt: Date.now(),
      durable: true,
    });
    expect(reg.sockets[0]!.sent.length).toBe(baseline);
    await bridge.close();
  });

  it("forwards events for a known team to all outbound links for that team", async () => {
    const reg = createRegistry();
    const A = cell("a", await pickFreePort());
    const bridge = startRealMeshBridge({
      bus: A.bus,
      store: A.store,
      hostId: A.hostId,
      port: A.port,
      loadTeams: () => [],
      onPeerStatus: () => {},
      webSocketFactory: reg.factory,
    });
    bridge.setTeamSecret(TEAM_ID, SECRET);
    bridge.addPeer(TEAM_ID, "peer-host-1", "ws://fake-1");
    bridge.addPeer(TEAM_ID, "peer-host-2", "ws://fake-2");
    await new Promise((r) => setTimeout(r, 0));
    expect(reg.sockets).toHaveLength(2);
    reg.sockets[0]!.open();
    reg.sockets[1]!.open();
    const baseline = reg.sockets.map((s) => s.sent.length);
    bridge.asBridge().broadcast({
      id: ulid(),
      hlc: "0000000000000000-0000",
      hostId: A.hostId,
      actorId: "a",
      type: "work.claimable",
      payload: { teamId: TEAM_ID, jobId: "JOB1" },
      createdAt: Date.now(),
      durable: true,
    });
    expect(reg.sockets[0]!.sent.length).toBe(baseline[0]! + 1);
    expect(reg.sockets[1]!.sent.length).toBe(baseline[1]! + 1);
    // The new send should be an `event` envelope.
    const last0 = JSON.parse(reg.sockets[0]!.sent[reg.sockets[0]!.sent.length - 1]!) as MeshEnvelope;
    expect(last0.kind).toBe("event");
    await bridge.close();
  });

  it("drops memory events that are not scope=team", async () => {
    const reg = createRegistry();
    const A = cell("a", await pickFreePort());
    const bridge = startRealMeshBridge({
      bus: A.bus,
      store: A.store,
      hostId: A.hostId,
      port: A.port,
      loadTeams: () => [],
      onPeerStatus: () => {},
      webSocketFactory: reg.factory,
    });
    bridge.setTeamSecret(TEAM_ID, SECRET);
    bridge.addPeer(TEAM_ID, "peer-host", "ws://fake");
    await new Promise((r) => setTimeout(r, 0));
    reg.sockets[0]!.open();
    const baseline = reg.sockets[0]!.sent.length;
    bridge.asBridge().broadcast({
      id: ulid(),
      hlc: "0000000000000000-0000",
      hostId: A.hostId,
      actorId: "a",
      type: "memory.wrote",
      payload: { teamId: TEAM_ID, scope: "private" },
      createdAt: Date.now(),
      durable: true,
    });
    expect(reg.sockets[0]!.sent.length).toBe(baseline);
    await bridge.close();
  });

  it("forwards tool-produced team memory events using scopeRef", async () => {
    const reg = createRegistry();
    const A = cell("a", await pickFreePort());
    const bridge = startRealMeshBridge({
      bus: A.bus,
      store: A.store,
      hostId: A.hostId,
      port: A.port,
      loadTeams: () => [],
      onPeerStatus: () => {},
      webSocketFactory: reg.factory,
    });
    bridge.setTeamSecret(TEAM_ID, SECRET);
    bridge.addPeer(TEAM_ID, "peer-host", "ws://fake");
    await new Promise((r) => setTimeout(r, 0));
    reg.sockets[0]!.open();
    const baseline = reg.sockets[0]!.sent.length;
    const memoryId = ulid();

    bridge.asBridge().broadcast({
      id: ulid(),
      hlc: "0000000000000000-0000",
      hostId: A.hostId,
      actorId: "a",
      type: "memory.wrote",
      payload: {
        id: memoryId,
        actorId: "a",
        scope: "team",
        scopeRef: TEAM_ID,
        role: "knowledge",
        title: "shared",
        bodyMd: "x",
        tags: [],
        depth: 1,
      },
      createdAt: Date.now(),
      durable: true,
    });
    bridge.asBridge().broadcast({
      id: ulid(),
      hlc: "0000000000000000-0001",
      hostId: A.hostId,
      actorId: "a",
      type: "memory.forgotten",
      payload: { id: memoryId, scope: "team", scopeRef: TEAM_ID },
      createdAt: Date.now(),
      durable: true,
    });

    expect(reg.sockets[0]!.sent.length).toBe(baseline + 2);
    const sent = JSON.parse(reg.sockets[0]!.sent.at(-2)!) as MeshEnvelope;
    expect(sent.kind).toBe("event");
    expect(sent.teamId).toBe(TEAM_ID);
    await bridge.close();
  });
});

describe("mesh / RealMeshBridge inbound scope enforcement", () => {
  it("emits mesh.scope-violation when envelope.teamId mismatches event.payload.teamId", async () => {
    const reg = createRegistry();
    const A = cell("a", await pickFreePort());
    const violations: Array<{ type: string; payload: unknown }> = [];
    A.bus.subscribe("mesh.scope-violation", (ev) => {
      violations.push({ type: ev.type, payload: ev.payload });
    });
    const bridge = startRealMeshBridge({
      bus: A.bus,
      store: A.store,
      hostId: A.hostId,
      port: A.port,
      loadTeams: () => [],
      onPeerStatus: () => {},
      webSocketFactory: reg.factory,
    });
    bridge.setTeamSecret(TEAM_ID, SECRET);
    bridge.addPeer(TEAM_ID, "peer-host", "ws://fake");
    await new Promise((r) => setTimeout(r, 0));
    reg.sockets[0]!.open();

    const event = {
      id: ulid(),
      hlc: "0000000000000000-0000",
      hostId: "peer-host",
      actorId: "peer-agent",
      type: "work.claimable",
      payload: { teamId: "team-other" }, // mismatch!
      createdAt: Date.now(),
      durable: true,
    };
    const env = makeEventEnvelope(TEAM_ID, "peer-host", event, SECRET);
    reg.sockets[0]!.message(JSON.stringify(env));
    // dispatchEnvelope is synchronous on the PeerLink callback, but the
    // bus.publish for mesh.scope-violation is synchronous too.
    expect(violations).toHaveLength(1);
    expect((violations[0]!.payload as { reason: string }).reason).toBe(
      "payload-team-mismatch",
    );
    await bridge.close();
  });

  it("delivers a properly scoped event into the local bus via receivers", async () => {
    const reg = createRegistry();
    const A = cell("a", await pickFreePort());
    const bridge = startRealMeshBridge({
      bus: A.bus,
      store: A.store,
      hostId: A.hostId,
      port: A.port,
      loadTeams: () => [],
      onPeerStatus: () => {},
      webSocketFactory: reg.factory,
    });
    bridge.setTeamSecret(TEAM_ID, SECRET);
    bridge.addPeer(TEAM_ID, "peer-host", "ws://fake");
    await new Promise((r) => setTimeout(r, 0));
    reg.sockets[0]!.open();
    const received: import("../src/bus/types.ts").Event[] = [];
    bridge.asBridge().onReceive((ev) => received.push(ev));
    const event = {
      id: ulid(),
      hlc: "0000000000000000-0000",
      hostId: "peer-host",
      actorId: "peer-agent",
      type: "work.claimable",
      payload: { teamId: TEAM_ID, jobId: "JOB1" },
      createdAt: Date.now(),
      durable: true,
    };
    const env = makeEventEnvelope(TEAM_ID, "peer-host", event, SECRET);
    reg.sockets[0]!.message(JSON.stringify(env));
    expect(received).toHaveLength(1);
    expect(received[0]!.id).toBe(event.id);
    expect(received[0]!.hostId).toBe("peer-host");
    await bridge.close();
  });
});
