import { describe, expect, it } from "bun:test";
import { createPeerLink, type PeerLinkStatus } from "../src/mesh/peer.ts";
import {
  MESH_PROTO,
  decodeEnvelope,
  signEnvelope,
  type MeshEnvelope,
  type UnsignedEnvelope,
} from "../src/mesh/envelope.ts";

// Fake WebSocket — supports the subset of the browser API the PeerLink
// consumes (readyState, addEventListener, send, close) and exposes test
// hooks (deliver, simulateClose) on the constructed instance.
type Listener = (ev: unknown) => void;
interface Sent {
  raw: string;
}

interface FakeSocketHandle {
  ws: FakeWebSocket;
  sent: Sent[];
  deliver(raw: string): void;
  simulateClose(): void;
  isOpen(): boolean;
}

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState: number = 0;
  private listeners = new Map<string, Set<Listener>>();
  public sent: string[] = [];
  constructor(public addr: string) {
    // open kicked manually so tests control timing
  }
  addEventListener(type: string, fn: Listener): void {
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

// We don't patch the global WebSocket — the FakeWebSocket's
// `readyState = 1` for OPEN matches the standard `WebSocket.OPEN`,
// which is what PeerLink reads. The factory injection routes
// construction through us; the readyState compare uses the real
// global constants.

function createSocketRegistry(): {
  factory: (addr: string) => WebSocket;
  current: FakeSocketHandle[];
  latest(): FakeSocketHandle;
} {
  const current: FakeSocketHandle[] = [];
  return {
    factory(addr: string) {
      const ws = new FakeWebSocket(addr);
      const handle: FakeSocketHandle = {
        ws,
        sent: [],
        deliver: (raw: string) => ws.message(raw),
        simulateClose: () => ws.close(),
        isOpen: () => ws.readyState === FakeWebSocket.OPEN,
      };
      // Mirror sends into handle.sent (since PeerLink calls ws.send).
      const origSend = ws.send.bind(ws);
      ws.send = (raw: string) => {
        handle.sent.push({ raw });
        origSend(raw);
      };
      current.push(handle);
      return ws as unknown as WebSocket;
    },
    current,
    latest() {
      const h = current[current.length - 1];
      if (!h) throw new Error("no socket constructed yet");
      return h;
    },
  };
}

const SECRET = "test-team-secret";
const TEAM_ID = "team-1";
const PEER_HOST_ID = "peer-host";
const HOST_ID = "local-host";

function makeEnvelope(kind: MeshEnvelope["kind"], payload: Record<string, unknown> = {}): string {
  const unsigned: UnsignedEnvelope = {
    proto: MESH_PROTO,
    envelopeId: "env-" + Math.random().toString(36).slice(2),
    teamId: TEAM_ID,
    fromHostId: PEER_HOST_ID,
    kind,
    payload,
    sentAt: Date.now(),
  } as UnsignedEnvelope;
  const env = { ...unsigned, hmac: signEnvelope(unsigned, SECRET) } as MeshEnvelope;
  return JSON.stringify(env);
}

async function nextTick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("mesh / PeerLink", () => {
  it("hello-then-flush: queues sends before connect, sends hello on open, then drains queue", async () => {
    const reg = createSocketRegistry();
    const statuses: PeerLinkStatus[] = [];
    const link = createPeerLink({
      hostId: HOST_ID,
      peerHostId: PEER_HOST_ID,
      teamId: TEAM_ID,
      secret: SECRET,
      addr: "ws://fake",
      webSocketFactory: reg.factory,
      onEnvelope: () => {},
      onStatusChange: (s) => statuses.push(s),
      heartbeatMs: 60_000,
      staleAfterMs: 60_000,
      reconnectBackoffMs: [5_000],
    });
    // Queue a send while still connecting.
    const queued = JSON.parse(makeEnvelope("heartbeat")) as MeshEnvelope;
    link.send(queued);
    await nextTick();
    const sock = reg.latest();
    expect(sock.isOpen()).toBe(false);
    sock.ws.open();
    // First send should be the hello, then the queued envelope.
    expect(sock.sent.length).toBeGreaterThanOrEqual(2);
    const first = JSON.parse(sock.sent[0]!.raw) as MeshEnvelope;
    expect(first.kind).toBe("hello");
    const second = JSON.parse(sock.sent[1]!.raw) as MeshEnvelope;
    expect(second.kind).toBe("heartbeat");
    expect(statuses).toContain("connected");
    link.close();
  });

  it("verifies HMAC on inbound; drops bad-HMAC envelopes and rejects link", async () => {
    const reg = createSocketRegistry();
    const received: MeshEnvelope[] = [];
    const statuses: PeerLinkStatus[] = [];
    const link = createPeerLink({
      hostId: HOST_ID,
      peerHostId: PEER_HOST_ID,
      teamId: TEAM_ID,
      secret: SECRET,
      addr: "ws://fake",
      webSocketFactory: reg.factory,
      onEnvelope: (env) => received.push(env),
      onStatusChange: (s) => statuses.push(s),
      heartbeatMs: 60_000,
      staleAfterMs: 60_000,
      reconnectBackoffMs: [60_000],
    });
    await nextTick();
    const sock = reg.latest();
    sock.ws.open();

    // Good envelope.
    sock.deliver(makeEnvelope("heartbeat"));
    expect(received).toHaveLength(1);

    // Tampered HMAC.
    const goodJson = makeEnvelope("heartbeat");
    const goodEnv = JSON.parse(goodJson) as MeshEnvelope;
    const badEnv = { ...goodEnv, hmac: "deadbeef".padEnd(64, "0") };
    sock.deliver(JSON.stringify(badEnv));
    // Receiver shouldn't have observed the bad envelope.
    expect(received).toHaveLength(1);
    expect(statuses).toContain("rejected");

    link.close();
  });

  it("reconnects with backoff after a remote close; new socket carries fresh hello", async () => {
    const reg = createSocketRegistry();
    const statuses: PeerLinkStatus[] = [];
    const link = createPeerLink({
      hostId: HOST_ID,
      peerHostId: PEER_HOST_ID,
      teamId: TEAM_ID,
      secret: SECRET,
      addr: "ws://fake",
      webSocketFactory: reg.factory,
      onEnvelope: () => {},
      onStatusChange: (s) => statuses.push(s),
      heartbeatMs: 60_000,
      staleAfterMs: 60_000,
      reconnectBackoffMs: [10], // tiny so the test stays fast
    });
    await nextTick();
    const sock1 = reg.latest();
    sock1.ws.open();
    expect(reg.current).toHaveLength(1);
    // Force close — the link should schedule a reconnect.
    sock1.simulateClose();
    expect(statuses).toContain("disconnected");
    // Backoff window elapses.
    await new Promise((r) => setTimeout(r, 40));
    expect(reg.current.length).toBeGreaterThanOrEqual(2);
    const sock2 = reg.latest();
    sock2.ws.open();
    const first2 = JSON.parse(sock2.sent[0]!.raw) as MeshEnvelope;
    expect(first2.kind).toBe("hello");
    link.close();
  });

  it("close() is permanent — no further reconnects", async () => {
    const reg = createSocketRegistry();
    const link = createPeerLink({
      hostId: HOST_ID,
      peerHostId: PEER_HOST_ID,
      teamId: TEAM_ID,
      secret: SECRET,
      addr: "ws://fake",
      webSocketFactory: reg.factory,
      onEnvelope: () => {},
      onStatusChange: () => {},
      heartbeatMs: 60_000,
      staleAfterMs: 60_000,
      reconnectBackoffMs: [10],
    });
    await nextTick();
    const sock = reg.latest();
    sock.ws.open();
    link.close();
    sock.simulateClose();
    await new Promise((r) => setTimeout(r, 30));
    // Still only one socket constructed.
    expect(reg.current).toHaveLength(1);
  });

  it("drops the envelope when teamId mismatches the link's team", async () => {
    const reg = createSocketRegistry();
    const received: MeshEnvelope[] = [];
    const link = createPeerLink({
      hostId: HOST_ID,
      peerHostId: PEER_HOST_ID,
      teamId: TEAM_ID,
      secret: SECRET,
      addr: "ws://fake",
      webSocketFactory: reg.factory,
      onEnvelope: (env) => received.push(env),
      onStatusChange: () => {},
      reconnectBackoffMs: [60_000],
    });
    await nextTick();
    const sock = reg.latest();
    sock.ws.open();
    // Build an envelope with a different teamId, signed correctly.
    const unsigned: UnsignedEnvelope = {
      proto: MESH_PROTO,
      envelopeId: "x",
      teamId: "other-team",
      fromHostId: PEER_HOST_ID,
      kind: "heartbeat",
      payload: {},
      sentAt: Date.now(),
    } as UnsignedEnvelope;
    const env = { ...unsigned, hmac: signEnvelope(unsigned, SECRET) } as MeshEnvelope;
    sock.deliver(JSON.stringify(env));
    expect(received).toHaveLength(0);
    link.close();
  });

  it("ensures decode is non-throwing — malformed JSON is logged-not-thrown", async () => {
    const reg = createSocketRegistry();
    const link = createPeerLink({
      hostId: HOST_ID,
      peerHostId: PEER_HOST_ID,
      teamId: TEAM_ID,
      secret: SECRET,
      addr: "ws://fake",
      webSocketFactory: reg.factory,
      onEnvelope: () => {},
      onStatusChange: () => {},
      reconnectBackoffMs: [60_000],
    });
    await nextTick();
    const sock = reg.latest();
    sock.ws.open();
    expect(() => sock.deliver("{not json")).not.toThrow();
    // also covers decodeEnvelope round-trip used internally
    void decodeEnvelope; // touch import
    link.close();
  });
});
