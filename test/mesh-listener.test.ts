import { describe, expect, it, beforeEach } from "bun:test";
import { startListener, type Listener } from "../src/mesh/listener.ts";
import {
  MESH_PROTO,
  decodeEnvelope,
  encodeEnvelope,
  signEnvelope,
  type MeshEnvelope,
  type UnsignedEnvelope,
} from "../src/mesh/envelope.ts";

const HOST_ID = "host-server";
const TEAM_ID = "team-1";
const SECRET = "listener-test-secret";

// Force advertised hostname to localhost so the WebSocket client can
// actually dial back into the listener regardless of how the machine's
// system hostname resolves.
process.env.OLLE_ADVERTISE_ADDR = "ws://127.0.0.1";

function pickPort(): number {
  // Pick a port high enough to avoid conflicts; collisions cause Bun.serve
  // to throw on bind, which the caller catches and retries.
  return 30_000 + Math.floor(Math.random() * 20_000);
}

async function startWithRetry(opts: {
  teamSecrets: Map<string, string>;
  onPeerHello: Parameters<typeof startListener>[0]["onPeerHello"];
}): Promise<Listener> {
  let lastErr: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      return await startListener({
        hostId: HOST_ID,
        port: pickPort(),
        teamSecrets: opts.teamSecrets,
        onPeerHello: opts.onPeerHello,
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`could not bind listener after 5 tries: ${String(lastErr)}`);
}

function helloEnvelope(secret: string, teamId: string, fromHostId: string): string {
  const unsigned: UnsignedEnvelope = {
    proto: MESH_PROTO,
    envelopeId: "env-hello",
    teamId,
    fromHostId,
    kind: "hello",
    payload: { teamId, fromHostId },
    sentAt: Date.now(),
  } as UnsignedEnvelope;
  const env = { ...unsigned, hmac: signEnvelope(unsigned, secret) } as MeshEnvelope;
  return encodeEnvelope(env);
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.addEventListener("open", () => resolve(), { once: true });
    // We deliberately don't reject on error — Bun's WebSocket fires
    // 'error' on graceful-close-by-server, which is the normal path
    // for tests that expect the listener to reject and close.
    ws.addEventListener(
      "close",
      () => {
        // open never fired; just resolve so the test continues into
        // its assertion (which will be a waitClose immediately after).
        resolve();
      },
      { once: true },
    );
  });
}

function waitClose(ws: WebSocket, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    const t = setTimeout(resolve, timeoutMs);
    ws.addEventListener("close", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

describe("mesh / Listener", () => {
  let listener: Listener | null = null;

  beforeEach(() => {
    listener = null;
  });

  it("advertises addr and accepts a valid hello, then invokes onPeerHello", async () => {
    const teamSecrets = new Map([[TEAM_ID, SECRET]]);
    const helloed: { fromHostId: string | null } = { fromHostId: null };
    listener = await startWithRetry({
      teamSecrets,
      onPeerHello: (params) => {
        helloed.fromHostId = params.fromHostId;
        params.onEnvelope = () => {};
        params.onClose = () => {};
      },
    });
    expect(listener.addr).toMatch(/^ws:\/\/.+:\d+$/);
    const url = listener.addr;

    const ws = new WebSocket(url);
    await waitOpen(ws);
    ws.send(helloEnvelope(SECRET, TEAM_ID, "client-host"));
    // Give the server a turn to process.
    await new Promise((r) => setTimeout(r, 50));
    expect(helloed.fromHostId).toBe("client-host");
    ws.close();
    await waitClose(ws);
    await listener.close();
  });

  it("rejects hello with bad secret and closes the socket", async () => {
    const teamSecrets = new Map([[TEAM_ID, SECRET]]);
    let helloed = false;
    listener = await startWithRetry({
      teamSecrets,
      onPeerHello: () => {
        helloed = true;
      },
    });
    const ws = new WebSocket(listener.addr);
    await waitOpen(ws);
    ws.send(helloEnvelope("WRONG-SECRET", TEAM_ID, "client-host"));
    await waitClose(ws);
    expect(helloed).toBe(false);
    await listener.close();
  });

  it("rejects hello for unknown team and closes the socket", async () => {
    const teamSecrets = new Map([[TEAM_ID, SECRET]]);
    listener = await startWithRetry({
      teamSecrets,
      onPeerHello: () => {},
    });
    const ws = new WebSocket(listener.addr);
    await waitOpen(ws);
    ws.send(helloEnvelope(SECRET, "unknown-team", "client-host"));
    await waitClose(ws);
    await listener.close();
  });

  it("delivers subsequent envelopes through onEnvelope once hello succeeds", async () => {
    const teamSecrets = new Map([[TEAM_ID, SECRET]]);
    const received: MeshEnvelope[] = [];
    listener = await startWithRetry({
      teamSecrets,
      onPeerHello: (params) => {
        params.onEnvelope = (env) => received.push(env);
        params.onClose = () => {};
      },
    });
    const ws = new WebSocket(listener.addr);
    await waitOpen(ws);
    ws.send(helloEnvelope(SECRET, TEAM_ID, "client-host"));
    await new Promise((r) => setTimeout(r, 30));
    // Send a heartbeat post-hello.
    const unsigned: UnsignedEnvelope = {
      proto: MESH_PROTO,
      envelopeId: "env-hb",
      teamId: TEAM_ID,
      fromHostId: "client-host",
      kind: "heartbeat",
      payload: {},
      sentAt: Date.now(),
    } as UnsignedEnvelope;
    const env = { ...unsigned, hmac: signEnvelope(unsigned, SECRET) } as MeshEnvelope;
    ws.send(encodeEnvelope(env));
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);
    expect(received[0]!.kind).toBe("heartbeat");
    ws.close();
    await waitClose(ws);
    await listener.close();
  });

  it("allows responding through the respond callback (welcome envelope round-trip)", async () => {
    const teamSecrets = new Map([[TEAM_ID, SECRET]]);
    listener = await startWithRetry({
      teamSecrets,
      onPeerHello: (params) => {
        const unsigned: UnsignedEnvelope = {
          proto: MESH_PROTO,
          envelopeId: "env-welcome",
          teamId: params.teamId,
          fromHostId: HOST_ID,
          kind: "welcome",
          payload: { peerSet: [] },
          sentAt: Date.now(),
        } as UnsignedEnvelope;
        const env = { ...unsigned, hmac: signEnvelope(unsigned, SECRET) } as MeshEnvelope;
        params.respond(env);
        params.onEnvelope = () => {};
        params.onClose = () => {};
      },
    });
    const ws = new WebSocket(listener.addr);
    await waitOpen(ws);
    const incoming = new Promise<string>((resolve) => {
      ws.addEventListener("message", (ev) => resolve(String((ev as MessageEvent).data)), {
        once: true,
      });
    });
    ws.send(helloEnvelope(SECRET, TEAM_ID, "client-host"));
    const raw = await incoming;
    const parsed = decodeEnvelope(raw);
    expect(parsed.kind).toBe("welcome");
    ws.close();
    await waitClose(ws);
    await listener.close();
  });
});
