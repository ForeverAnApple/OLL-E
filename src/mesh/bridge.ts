// RealMeshBridge — WebSocket peer mesh implementation of MeshBridge.
//
// Owns:
//   * Outbound peer set: Map<teamId, Map<peerHostId, PeerLink>>.
//   * Inbound peer set: Map<teamId, Map<peerHostId, InboundLink>>.
//     Same shape; different transport (server-side socket via listener).
//   * teamSecrets: Map<teamId, secret>, shared with the listener.
//   * Outbound scope filter (Feature E).
//   * Catchup driver for both request and serve roles.
//
// Wire seam: asBridge() returns the narrow MeshBridge contract (peerId,
// broadcast, onReceive, close). The daemon holds the RealMeshBridge for
// team ops (addPeer, setTeamSecret, etc.) and threads .asBridge() through
// wireBridgeToBus.

import type { EventBus } from "../bus/index.ts";
import type { Event } from "../bus/types.ts";
import type { Store } from "../store/db.ts";
import { tables } from "../store/index.ts";
import { eq } from "drizzle-orm";
import { ulid } from "../id/index.ts";
import {
  MESH_PROTO,
  signEnvelope,
  type MeshEnvelope,
  type UnsignedEnvelope,
} from "./envelope.ts";
import { createPeerLink, type PeerLink, type PeerLinkStatus } from "./peer.ts";
import { startListener, type Listener, type ListenerHelloParams } from "./listener.ts";
import {
  createCatchup,
  type Catchup,
  type CatchupChunkEnvelope,
  type CatchupRequestEnvelope,
} from "./catchup.ts";
import { isMemoryEvent, routableTeamId, validateTeamScope } from "./scope.ts";
import type { MeshBridge, MeshReceiver } from "./types.ts";

export interface PeerSnapshot {
  peerHostId: string;
  addr: string;
  lastReceivedEventId: string | null;
}

export interface RealMeshBridgeOptions {
  bus: EventBus;
  store: Store;
  hostId: string;
  port: number;
  /** Loaded on demand from the store. Bridge calls this on start() and
   *  after `setTeamSecret` to refresh its world view. */
  loadTeams: () => Array<{ teamId: string; secret: string; peers: PeerSnapshot[] }>;
  /** Bridge calls this when a peer link transitions or a watermark
   *  advances. Daemon persists into team_peers. `left` is the terminal
   *  state after a peer_left envelope or local removePeer; PeerLink
   *  itself never emits it. */
  onPeerStatus: (params: {
    teamId: string;
    peerHostId: string;
    status: PeerLinkStatus | "left";
    addr?: string;
    lastReceivedEventId?: string;
  }) => void;
  /** Optional injection point for the WebSocket client used by PeerLink.
   *  Tests use this to plug a deterministic transport. */
  webSocketFactory?: (addr: string) => WebSocket;
  /** Default chunk size for catchup. */
  catchupChunkSize?: number;
  /** Override for the inbound listener's advertised hostname/port. */
  advertiseAddr?: string;
  /** Validate (and mark redeemed) an invite presented on first-join.
   *  Returns true when the invite is fresh and was just marked redeemed
   *  by `byHostId`; false when missing, expired, or already redeemed.
   *  Called only when `helloPayload.inviteId` is present — normal
   *  reconnect hellos skip this entirely. */
  redeemInvite?: (params: {
    teamId: string;
    inviteId: string;
    byHostId: string;
  }) => boolean;
}

export interface RealMeshBridge {
  start(): Promise<void>;
  addPeer(teamId: string, peerHostId: string, addr: string, sinceEventId?: string | null): void;
  removePeer(teamId: string, peerHostId: string): void;
  setTeamSecret(teamId: string, secret: string): void;
  dropTeam(teamId: string): void;
  ensureListener(): Promise<string>;
  /** Tell every connected peer that this host is leaving the team.
   *  Signed peer_left envelopes go out before the links are torn down;
   *  receivers mark the originating host as `left` in their own peer
   *  table. Best-effort: a peer that already lost its link just won't
   *  hear it and learns from the next reconnect attempt. */
  broadcastPeerLeft(teamId: string): void;
  readonly addr: string | null;
  readonly listenerPort: number;
  asBridge(): MeshBridge;
  close(): Promise<void>;
}

interface InboundLink {
  peerHostId: string;
  teamId: string;
  respond: (env: MeshEnvelope) => void;
}

/** Outbound link bookkeeping — addr is retained so welcome-peer-set
 *  broadcasts can include reachable peer addresses, and team_status can
 *  report them. */
interface OutboundEntry {
  link: PeerLink;
  addr: string;
}

/** Outbound (we dialed) or inbound (peer dialed us) — both can send
 *  envelopes. Combined for catchup + claim broadcast. */
type Sink = { send: (env: MeshEnvelope) => void };

export function startRealMeshBridge(opts: RealMeshBridgeOptions): RealMeshBridge {
  const teamSecrets = new Map<string, string>();
  const outbound = new Map<string, Map<string, OutboundEntry>>();
  const inbound = new Map<string, Map<string, InboundLink>>();
  const peerWatermarks = new Map<string, string | null>(); // `${teamId}::${peerHostId}` → highest event id seen
  const receivers = new Set<MeshReceiver>();

  let listener: Listener | null = null;
  let closed = false;

  const catchup = createCatchup({
    bus: opts.bus,
    store: opts.store,
    hostId: opts.hostId,
    chunkSize: opts.catchupChunkSize,
  });

  function pkey(teamId: string, peerHostId: string): string {
    return `${teamId}::${peerHostId}`;
  }

  function sign(unsigned: UnsignedEnvelope, secret: string): MeshEnvelope {
    const hmac = signEnvelope(unsigned, secret);
    return { ...unsigned, hmac } as MeshEnvelope;
  }

  function emitScopeViolation(reason: string, detail: Record<string, unknown>): void {
    try {
      opts.bus.publish({
        type: "mesh.scope-violation",
        hostId: opts.hostId,
        actorId: "mesh",
        durable: true,
        payload: { reason, ...detail },
      });
    } catch (err) {
      // eslint-disable-next-line no-console -- mesh is infra
      console.error("[mesh/bridge] failed to emit scope-violation:", err);
    }
  }

  // ─── Inbound dispatch ────────────────────────────────────────────────

  function dispatchEnvelope(env: MeshEnvelope, source: Sink): void {
    // Defense-in-depth: PeerLink/listener already HMAC-verified, but
    // they verified against whatever team the envelope claimed. We
    // double-check that we're actually a member.
    if (!teamSecrets.has(env.teamId)) {
      emitScopeViolation("unknown-team", {
        envelopeTeamId: env.teamId,
        fromHostId: env.fromHostId,
        kind: env.kind,
      });
      return;
    }
    if (env.kind === "event") {
      const ev = env.event;
      const scope = validateTeamScope(ev, env.teamId);
      if (!scope.ok) {
        emitScopeViolation(scope.reason, {
          envelopeTeamId: env.teamId,
          payloadTeamId: scope.payloadTeamId,
          scope: scope.scope,
          eventId: ev.id,
          fromHostId: env.fromHostId,
        });
        return;
      }
      // Watermark advance: any event we accept is a candidate to bump
      // the per-peer watermark. We use event.id directly (ULID monotonic).
      const k = pkey(env.teamId, env.fromHostId);
      const prior = peerWatermarks.get(k) ?? null;
      if (prior === null || ev.id > prior) {
        peerWatermarks.set(k, ev.id);
        opts.onPeerStatus({
          teamId: env.teamId,
          peerHostId: env.fromHostId,
          status: getStatus(env.teamId, env.fromHostId),
          lastReceivedEventId: ev.id,
        });
      }
      for (const fn of receivers) {
        try {
          fn(ev);
        } catch (err) {
          // eslint-disable-next-line no-console -- mesh is infra
          console.error("[mesh/bridge] receiver threw:", err);
        }
      }
      return;
    }
    if (env.kind === "heartbeat") {
      // Bookkeeping only — PeerLink updates lastReceived internally.
      return;
    }
    if (env.kind === "welcome") {
      // Future: peer-set sync. v0 records the welcome but doesn't act on
      // additional peers from it (the bridge's loadTeams handles that).
      return;
    }
    if (env.kind === "catchup_request") {
      const secret = teamSecrets.get(env.teamId);
      if (!secret) return;
      catchup.serve({
        teamId: env.teamId,
        envelope: env as CatchupRequestEnvelope,
        secret,
        fromHostId: env.fromHostId,
        send: source.send,
      });
      return;
    }
    if (env.kind === "catchup_chunk") {
      catchup.handleChunk(env as CatchupChunkEnvelope);
      return;
    }
    if (env.kind === "peer_left") {
      removePeer(env.teamId, env.fromHostId);
      return;
    }
    if (env.kind === "hello") {
      // Hellos arrive on the inbound side and are handled by the listener.
      // An outbound link should never see a hello — drop quietly.
      return;
    }
    if (env.kind === "error") {
      // eslint-disable-next-line no-console -- mesh is infra
      console.warn("[mesh/bridge] peer error envelope:", env.payload);
      return;
    }
  }

  function getStatus(teamId: string, peerHostId: string): PeerLinkStatus {
    const entry = outbound.get(teamId)?.get(peerHostId);
    if (entry) return entry.link.status;
    if (inbound.get(teamId)?.has(peerHostId)) return "connected";
    return "disconnected";
  }

  // ─── Outbound peer management ────────────────────────────────────────

  function dialPeer(
    teamId: string,
    peerHostId: string,
    addr: string,
    secret: string,
    sinceEventId: string | null,
  ): PeerLink {
    const link = createPeerLink({
      hostId: opts.hostId,
      peerHostId,
      teamId,
      secret,
      addr,
      webSocketFactory: opts.webSocketFactory,
      onEnvelope: (env) => {
        dispatchEnvelope(env, { send: (out) => link.send(out) });
      },
      onStatusChange: (status) => {
        opts.onPeerStatus({ teamId, peerHostId, status, addr });
        if (status === "connected") {
          // Trigger catchup. Use the most recent watermark we have.
          const k = pkey(teamId, peerHostId);
          const wm = peerWatermarks.get(k) ?? sinceEventId ?? null;
          void catchup
            .request({
              teamId,
              peerHostId,
              secret,
              sinceEventId: wm,
              send: (env) => link.send(env),
              onWatermark: (w) => {
                peerWatermarks.set(k, w);
                // Read link.status fresh at fire time — capturing the
                // status from when catchup was queued would emit stale
                // values if the link flapped mid-stream.
                opts.onPeerStatus({
                  teamId,
                  peerHostId,
                  status: link.status,
                  lastReceivedEventId: w,
                });
              },
            })
            .catch((err) => {
              // Cancellation on link drop is normal; log other errors.
              if (String(err?.message ?? err).includes("cancelled")) return;
              if (String(err?.message ?? err).includes("superseded")) return;
              // eslint-disable-next-line no-console -- mesh is infra
              console.warn("[mesh/bridge] catchup failed:", err);
            });
        } else if (status === "disconnected" || status === "stale" || status === "rejected") {
          catchup.cancel(teamId, peerHostId);
        }
      },
    });
    return link;
  }

  function addPeer(
    teamId: string,
    peerHostId: string,
    addr: string,
    sinceEventId: string | null = null,
  ): void {
    if (peerHostId === opts.hostId) return; // never dial self
    const secret = teamSecrets.get(teamId);
    if (!secret) {
      // eslint-disable-next-line no-console -- mesh is infra
      console.warn(`[mesh/bridge] addPeer on team ${teamId} with no secret; ignoring`);
      return;
    }
    let teamPeers = outbound.get(teamId);
    if (!teamPeers) {
      teamPeers = new Map();
      outbound.set(teamId, teamPeers);
    }
    const existing = teamPeers.get(peerHostId);
    if (existing) {
      // Replace on addr change; otherwise no-op.
      existing.link.close();
    }
    const k = pkey(teamId, peerHostId);
    if (sinceEventId && !peerWatermarks.has(k)) {
      peerWatermarks.set(k, sinceEventId);
    }
    const link = dialPeer(teamId, peerHostId, addr, secret, sinceEventId);
    teamPeers.set(peerHostId, { link, addr });
  }

  function removePeer(teamId: string, peerHostId: string): void {
    const teamPeers = outbound.get(teamId);
    const entry = teamPeers?.get(peerHostId);
    if (entry) {
      entry.link.close();
      teamPeers!.delete(peerHostId);
      if (teamPeers!.size === 0) outbound.delete(teamId);
    }
    const inboundTeam = inbound.get(teamId);
    if (inboundTeam?.has(peerHostId)) {
      inboundTeam.delete(peerHostId);
      if (inboundTeam.size === 0) inbound.delete(teamId);
    }
    catchup.cancel(teamId, peerHostId);
    peerWatermarks.delete(pkey(teamId, peerHostId));
    opts.onPeerStatus({ teamId, peerHostId, status: "left" });
  }

  function setTeamSecret(teamId: string, secret: string): void {
    teamSecrets.set(teamId, secret);
  }

  function broadcastPeerLeft(teamId: string): void {
    const secret = teamSecrets.get(teamId);
    if (!secret) return;
    const unsigned: UnsignedEnvelope = {
      proto: MESH_PROTO,
      envelopeId: ulid(),
      teamId,
      fromHostId: opts.hostId,
      kind: "peer_left",
      payload: { hostId: opts.hostId },
      sentAt: Date.now(),
    };
    const env = sign(unsigned, secret);
    const outboundTeam = outbound.get(teamId);
    if (outboundTeam) {
      for (const entry of outboundTeam.values()) entry.link.send(env);
    }
    const inboundTeam = inbound.get(teamId);
    if (inboundTeam) {
      for (const link of inboundTeam.values()) link.respond(env);
    }
  }

  function dropTeam(teamId: string): void {
    const team = outbound.get(teamId);
    if (team) {
      for (const entry of team.values()) entry.link.close();
      outbound.delete(teamId);
    }
    inbound.delete(teamId);
    teamSecrets.delete(teamId);
    for (const k of Array.from(peerWatermarks.keys())) {
      if (k.startsWith(`${teamId}::`)) peerWatermarks.delete(k);
    }
  }

  // ─── Listener ────────────────────────────────────────────────────────

  async function ensureListener(): Promise<string> {
    if (listener) return listener.addr;
    listener = await startListener({
      hostId: opts.hostId,
      port: opts.port,
      teamSecrets,
      onPeerHello: (params: ListenerHelloParams) => {
        // Single-use invite enforcement (Feature A — bearer-code rotation
        // is v0.1, but per-inviteId redemption isn't). Reconnect hellos
        // carry no inviteId; only the first-join hello from `team_join`
        // does. Missing/expired/already-redeemed → reject; the joiner sees
        // the socket close and surfaces the failure.
        const inviteId =
          typeof params.helloPayload.inviteId === "string"
            ? (params.helloPayload.inviteId as string)
            : undefined;
        if (inviteId && opts.redeemInvite) {
          const ok = opts.redeemInvite({
            teamId: params.teamId,
            inviteId,
            byHostId: params.fromHostId,
          });
          if (!ok) {
            // eslint-disable-next-line no-console -- mesh is infra
            console.warn(
              `[mesh/bridge] invite ${inviteId} for team ${params.teamId} rejected`,
            );
            params.reject = true;
            return;
          }
        }
        // The bridge already knows the team; register an inbound link
        // entry so outbound broadcasts can opt to use it if no outbound
        // link exists. (Today: outbound is primary; inbound just feeds
        // catchup requests back.)
        const link: InboundLink = {
          peerHostId: params.fromHostId,
          teamId: params.teamId,
          respond: params.respond,
        };
        let team = inbound.get(params.teamId);
        if (!team) {
          team = new Map();
          inbound.set(params.teamId, team);
        }
        team.set(params.fromHostId, link);
        params.onEnvelope = (env) => {
          dispatchEnvelope(env, { send: params.respond });
        };
        params.onClose = () => {
          const t = inbound.get(params.teamId);
          if (t?.get(params.fromHostId) === link) {
            t.delete(params.fromHostId);
            if (t.size === 0) inbound.delete(params.teamId);
          }
        };

        // Send a welcome with the current peer set + the team's local
        // display name for this team.
        const peerSet = collectPeerSet(params.teamId).filter(
          (p) => p.peerHostId !== params.fromHostId,
        );
        const secret = teamSecrets.get(params.teamId);
        if (!secret) return;
        const teamRow = opts.store
          .select()
          .from(tables.teams)
          .where(eq(tables.teams.id, params.teamId))
          .all()[0];
        const welcome: UnsignedEnvelope = {
          proto: MESH_PROTO,
          envelopeId: ulid(),
          teamId: params.teamId,
          fromHostId: opts.hostId,
          kind: "welcome",
          payload: {
            peerSet,
            teamName: teamRow?.name ?? null,
          },
          sentAt: Date.now(),
        };
        params.respond(sign(welcome, secret));
      },
    });
    return listener.addr;
  }

  // Include hostId as a compatibility alias for older joiners; current
  // joiners read peerHostId.
  function collectPeerSet(
    teamId: string,
  ): Array<{ peerHostId: string; hostId: string; addr: string }> {
    const out: Array<{ peerHostId: string; hostId: string; addr: string }> = [];
    const team = outbound.get(teamId);
    if (team) {
      for (const [hostId, entry] of team) {
        out.push({ peerHostId: hostId, hostId, addr: entry.addr });
      }
    }
    return out;
  }

  // ─── Outbound broadcast (called from wire.ts via asBridge) ───────────

  function broadcast(event: Event): void {
    if (closed) return;
    const payloadTeam = routableTeamId(event);
    if (!payloadTeam) return; // not team-scoped, never crosses
    if (isMemoryEvent(event) && !validateTeamScope(event, payloadTeam).ok) return;
    const secret = teamSecrets.get(payloadTeam);
    if (!secret) return; // we're not in this team

    const unsigned: UnsignedEnvelope = {
      proto: MESH_PROTO,
      envelopeId: ulid(),
      teamId: payloadTeam,
      fromHostId: opts.hostId,
      kind: "event",
      event,
      sentAt: Date.now(),
    };
    const env = sign(unsigned, secret);

    const outboundTeam = outbound.get(payloadTeam);
    if (outboundTeam) {
      for (const entry of outboundTeam.values()) {
        entry.link.send(env);
      }
    }
    const inboundTeam = inbound.get(payloadTeam);
    if (inboundTeam) {
      for (const link of inboundTeam.values()) {
        // Don't echo back to the host we just got the event from over
        // this very link. The receiver's bus.inject is idempotent so
        // even if we did, no harm, but it's wasted bytes.
        if (event.hostId === link.peerHostId) continue;
        link.respond(env);
      }
    }
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  async function start(): Promise<void> {
    if (closed) return;
    await ensureListener();
    const teams = opts.loadTeams();
    for (const t of teams) {
      teamSecrets.set(t.teamId, t.secret);
      for (const p of t.peers) {
        if (p.peerHostId === opts.hostId) continue;
        addPeer(t.teamId, p.peerHostId, p.addr, p.lastReceivedEventId ?? null);
      }
    }
  }

  function asBridge(): MeshBridge {
    return {
      peerId: `host:${opts.hostId}`,
      broadcast,
      onReceive(fn: MeshReceiver) {
        receivers.add(fn);
        return () => receivers.delete(fn);
      },
      close() {
        // Bridge.close() doesn't tear down sockets — that's the
        // RealMeshBridge.close() job. wire.ts unwire just removes
        // receivers.
        receivers.clear();
      },
    };
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    for (const team of outbound.values()) {
      for (const entry of team.values()) entry.link.close();
    }
    outbound.clear();
    inbound.clear();
    receivers.clear();
    if (listener) {
      await listener.close();
      listener = null;
    }
  }

  return {
    start,
    addPeer,
    removePeer,
    setTeamSecret,
    dropTeam,
    ensureListener,
    broadcastPeerLeft,
    get addr() {
      return listener?.addr ?? null;
    },
    get listenerPort() {
      return listener?.port ?? opts.port;
    },
    asBridge,
    close,
  };
}
