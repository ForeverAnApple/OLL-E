// Client-side WebSocket peer link — one connection from this host to a
// peer host, scoped to a single team.
//
// One PeerLink per (peerHostId, teamId): we considered multiplexing
// multiple teams over one socket, but the HMAC binds to a team secret
// and the per-peer watermark is per-team. Multiplexing would force a
// "pick a team for outer auth" hack; per-team links keep the contract
// straight and the bookkeeping local.
//
// Reconnect: backoff schedule per teams.plan.md "Wire" (1s, 2s, 5s, 15s,
// 60s, cap). After the schedule is exhausted we plateau at the last
// value. Heartbeats every 15s by default; no heartbeat for `staleAfterMs`
// → status `stale`, close, reconnect.

import {
  decodeEnvelope,
  encodeEnvelope,
  MESH_PROTO,
  MeshEnvelopeError,
  signEnvelope,
  verifyEnvelope,
  type MeshEnvelope,
  type UnsignedEnvelope,
} from "./envelope.ts";
import { ulid } from "../id/index.ts";

export type PeerLinkStatus = "connecting" | "connected" | "disconnected" | "stale" | "rejected";

export interface PeerLinkOptions {
  hostId: string;
  peerHostId: string;
  teamId: string;
  secret: string;
  addr: string;
  onEnvelope: (env: MeshEnvelope) => void;
  onStatusChange: (status: PeerLinkStatus) => void;
  heartbeatMs?: number;
  staleAfterMs?: number;
  reconnectBackoffMs?: number[];
  /** Maximum queued sends while not connected; oldest dropped on overflow. */
  maxQueue?: number;
  /** Optional injection for tests; defaults to the global WebSocket. */
  webSocketFactory?: (addr: string) => WebSocket;
}

export interface PeerLink {
  readonly peerHostId: string;
  readonly teamId: string;
  readonly status: PeerLinkStatus;
  send(env: MeshEnvelope): void;
  close(): void;
}

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_STALE_AFTER_MS = 60_000;
const DEFAULT_BACKOFF: readonly number[] = [1_000, 2_000, 5_000, 15_000, 60_000];
const DEFAULT_MAX_QUEUE = 1_000;

export function createPeerLink(opts: PeerLinkOptions): PeerLink {
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const backoff = opts.reconnectBackoffMs ?? [...DEFAULT_BACKOFF];
  const maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
  const wsFactory =
    opts.webSocketFactory ?? ((addr: string) => new WebSocket(addr));

  let ws: WebSocket | null = null;
  let status: PeerLinkStatus = "connecting";
  let closed = false;
  let rejected = false;
  let backoffIdx = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let stalenessTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastReceivedAt = 0;
  const queue: MeshEnvelope[] = [];

  function setStatus(next: PeerLinkStatus): void {
    if (status === next) return;
    status = next;
    try {
      opts.onStatusChange(next);
    } catch (err) {
      // eslint-disable-next-line no-console -- mesh is infra
      console.error("[mesh/peer] status callback threw:", err);
    }
  }

  function clearTimers(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (stalenessTimer) {
      clearInterval(stalenessTimer);
      stalenessTimer = null;
    }
  }

  function nextBackoffMs(): number {
    const idx = Math.min(backoffIdx, backoff.length - 1);
    backoffIdx++;
    return backoff[idx] ?? backoff[backoff.length - 1] ?? 60_000;
  }

  function scheduleReconnect(): void {
    if (closed || rejected) return;
    if (reconnectTimer) return;
    setStatus("connecting");
    const delay = nextBackoffMs();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function rawSend(env: MeshEnvelope): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(encodeEnvelope(env));
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console -- mesh is infra
      console.error("[mesh/peer] send threw:", err);
      return false;
    }
  }

  function flushQueue(): void {
    while (queue.length > 0) {
      const env = queue[0]!;
      if (!rawSend(env)) return;
      queue.shift();
    }
  }

  function makeHelloEnvelope(): MeshEnvelope {
    const unsigned: UnsignedEnvelope = {
      proto: MESH_PROTO,
      envelopeId: ulid(),
      teamId: opts.teamId,
      fromHostId: opts.hostId,
      kind: "hello",
      payload: { teamId: opts.teamId, fromHostId: opts.hostId },
      sentAt: Date.now(),
    };
    const hmac = signEnvelope(unsigned, opts.secret);
    return { ...unsigned, hmac } as MeshEnvelope;
  }

  function makeHeartbeatEnvelope(): MeshEnvelope {
    const unsigned: UnsignedEnvelope = {
      proto: MESH_PROTO,
      envelopeId: ulid(),
      teamId: opts.teamId,
      fromHostId: opts.hostId,
      kind: "heartbeat",
      payload: {},
      sentAt: Date.now(),
    };
    const hmac = signEnvelope(unsigned, opts.secret);
    return { ...unsigned, hmac } as MeshEnvelope;
  }

  function startHeartbeat(): void {
    clearTimers();
    heartbeatTimer = setInterval(() => {
      rawSend(makeHeartbeatEnvelope());
    }, heartbeatMs);
    // Check staleness on its own cadence — we don't want missed heartbeats
    // to silently waste the whole staleAfterMs window.
    const checkEvery = Math.max(1_000, Math.floor(staleAfterMs / 4));
    stalenessTimer = setInterval(() => {
      if (Date.now() - lastReceivedAt > staleAfterMs) {
        setStatus("stale");
        try {
          ws?.close();
        } catch {
          // ignore — onclose will fire
        }
      }
    }, checkEvery);
  }

  function connect(): void {
    if (closed || rejected) return;
    setStatus("connecting");
    let socket: WebSocket;
    try {
      socket = wsFactory(opts.addr);
    } catch (err) {
      // eslint-disable-next-line no-console -- mesh is infra
      console.error("[mesh/peer] WebSocket construct failed:", err);
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.addEventListener("open", () => {
      if (closed || rejected) {
        try {
          socket.close();
        } catch {
          // ignore
        }
        return;
      }
      lastReceivedAt = Date.now();
      backoffIdx = 0;
      // Hello FIRST, status change SECOND. setStatus("connected") fires
      // synchronous onStatusChange handlers in the bridge that may try to
      // send catchup_request (or anything else) — the remote listener
      // rejects any envelope that arrives before a verified hello, so
      // hello must precede every other byte going out on this socket.
      rawSend(makeHelloEnvelope());
      setStatus("connected");
      flushQueue();
      startHeartbeat();
    });

    socket.addEventListener("message", (ev) => {
      if (closed || rejected) return;
      let raw: string;
      const data = (ev as MessageEvent).data;
      if (typeof data === "string") {
        raw = data;
      } else if (data instanceof ArrayBuffer) {
        raw = new TextDecoder().decode(data);
      } else {
        // eslint-disable-next-line no-console -- mesh is infra
        console.warn("[mesh/peer] unexpected message data type; dropping");
        return;
      }
      let env: MeshEnvelope;
      try {
        env = decodeEnvelope(raw);
      } catch (err) {
        if (!(err instanceof MeshEnvelopeError)) throw err;
        // eslint-disable-next-line no-console -- mesh is infra
        console.warn("[mesh/peer] decode failed:", err.message);
        return;
      }
      if (env.teamId !== opts.teamId) {
        // eslint-disable-next-line no-console -- mesh is infra
        console.warn(
          `[mesh/peer] envelope team ${env.teamId} mismatch on link team ${opts.teamId}; dropping`,
        );
        return;
      }
      if (!verifyEnvelope(env, opts.secret)) {
        // eslint-disable-next-line no-console -- mesh is infra
        console.warn("[mesh/peer] HMAC verify failed; rejecting link");
        rejected = true;
        setStatus("rejected");
        clearTimers();
        try {
          socket.close();
        } catch {
          // ignore
        }
        return;
      }
      lastReceivedAt = Date.now();
      try {
        opts.onEnvelope(env);
      } catch (err) {
        // eslint-disable-next-line no-console -- mesh is infra
        console.error("[mesh/peer] onEnvelope threw:", err);
      }
    });

    socket.addEventListener("close", () => {
      clearTimers();
      ws = null;
      if (closed || rejected) return;
      if (status !== "stale") setStatus("disconnected");
      scheduleReconnect();
    });

    socket.addEventListener("error", (err) => {
      // eslint-disable-next-line no-console -- mesh is infra
      console.warn("[mesh/peer] ws error:", (err as Event & { message?: string }).message ?? err);
    });
  }

  function send(env: MeshEnvelope): void {
    if (closed || rejected) return;
    if (rawSend(env)) return;
    queue.push(env);
    if (queue.length > maxQueue) {
      queue.shift();
      // eslint-disable-next-line no-console -- mesh is infra
      console.warn(
        `[mesh/peer] queue overflow for ${opts.peerHostId}/${opts.teamId}; dropping oldest`,
      );
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    clearTimers();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    setStatus("disconnected");
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
      ws = null;
    }
  }

  // Kick the first connect on the next microtask so the caller can
  // attach status listeners synchronously.
  queueMicrotask(() => {
    if (!closed && !rejected) connect();
  });

  return {
    get peerHostId() {
      return opts.peerHostId;
    },
    get teamId() {
      return opts.teamId;
    },
    get status() {
      return status;
    },
    send,
    close,
  };
}
