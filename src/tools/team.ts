// Team tools — cell-to-cell federation surface.
//
// Five tools form the v0 team substrate: team_create, team_invite,
// team_join, team_leave, team_status. All deferred behind load_tools;
// the catalog blurb tells agents when to reach for them.
//
// Authorization model (LOG 2026-04-23 collapse + Wave-4 design call):
// strategic-tier classification gates who can call create / invite /
// join. The existing permission check (src/permissions/check.ts) drops
// callers whose scope.allowTiers omits "strategic". Agents that lack
// it use `mail_propose` to ask the human; the human's allowTiers
// includes strategic so their CLI calls execute directly. No internal
// askUp inside these tools — execution is single-step.

import { randomBytes } from "node:crypto";
import { mkdir, unlink, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";

import type { EventBus } from "../bus/index.ts";
import type { Store } from "../store/db.ts";
import { tables } from "../store/index.ts";
import type { ToolDef } from "../extensions/types.ts";
import { ulid } from "../id/index.ts";
import {
  decodeBearerCode,
  encodeBearerCode,
  hashBearerCode,
  BearerCodeError,
  type BearerCode,
} from "../mesh/code.ts";
import {
  decodeEnvelope,
  signEnvelope,
  verifyEnvelope,
  type MeshEnvelope,
  type UnsignedEnvelope,
} from "../mesh/envelope.ts";
import type { RealMeshBridge } from "../mesh/bridge.ts";

export interface TeamToolsOptions {
  bus: EventBus;
  store: Store;
  hostId: string;
  bridge: RealMeshBridge;
  /** Resolved ~/.olle root; team secrets live under <root>/secrets/team/<teamId>. */
  olleRoot: string;
  /** Override the WebSocket constructor used by team_join (tests inject
   *  a deterministic transport; production uses the global WebSocket). */
  webSocketFactory?: (addr: string) => WebSocket;
  /** Override the join handshake timeout. Default 15s. */
  joinTimeoutMs?: number;
}

interface TeamStatusEntry {
  teamId: string;
  name: string;
  members: Array<{ actorId: string; role: string; joinedAt: number }>;
  peers: Array<{
    peerHostId: string;
    addr: string;
    status: string;
    lastHeartbeatAt: number | null;
    lastReceivedEventId: string | null;
  }>;
}

interface PeerSetEntry {
  peerHostId: string;
  addr: string;
}

export function buildTeamTools(opts: TeamToolsOptions): ToolDef[] {
  const { bus, store, hostId, bridge, olleRoot } = opts;

  function secretPathFor(teamId: string): string {
    return join(olleRoot, "secrets", "team", teamId);
  }

  async function writeTeamSecret(teamId: string, secret: string): Promise<string> {
    const path = secretPathFor(teamId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, secret, { mode: 0o600 });
    return path;
  }

  async function readTeamSecret(teamId: string): Promise<string> {
    const path = secretPathFor(teamId);
    const raw = await readFile(path, "utf8");
    return raw.trim();
  }

  function getMembership(teamId: string, actorId: string) {
    return store
      .select()
      .from(tables.teamMembers)
      .where(
        and(
          eq(tables.teamMembers.teamId, teamId),
          eq(tables.teamMembers.actorId, actorId),
        ),
      )
      .all()[0];
  }

  function getTeam(teamId: string) {
    return store
      .select()
      .from(tables.teams)
      .where(eq(tables.teams.id, teamId))
      .all()[0];
  }

  const create: ToolDef<{ name: string }, { ok: boolean; teamId?: string; error?: string }> = {
    name: "team_create",
    tier: "strategic",
    category: "team",
    shortClause: "mint a new shared identity this host can invite peers into",
    description:
      "Create a new team rooted on this host. Mints a fresh team secret (the HMAC key all peers will use to authenticate envelopes), persists the teams + team_members rows for the caller, and registers the secret with the live mesh bridge so subsequent invites work. Strategic tier — creating a shared identity is an act of world-building. Returns {ok, teamId} on success.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, description: "Human-readable team label." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const name = args.name?.trim();
      if (!name) return { ok: false, error: "name required" };
      const teamId = ulid();
      const secret = randomBytes(32).toString("base64url");
      await writeTeamSecret(teamId, secret);
      const now = Date.now();
      store
        .insert(tables.teams)
        .values({ id: teamId, name, createdAt: now })
        .run();
      store
        .insert(tables.teamMembers)
        .values({
          teamId,
          actorId: ctx.actorId,
          role: "founder",
          joinedAt: now,
        })
        .run();
      bridge.setTeamSecret(teamId, secret);
      bus.publish({
        type: "team.created",
        payload: { teamId, name, createdByActorId: ctx.actorId },
        hostId,
        actorId: ctx.actorId,
        durable: true,
      });
      return { ok: true, teamId };
    },
  };

  const invite: ToolDef<
    { teamId: string; ttlMs?: number },
    { ok: boolean; code?: string; inviteId?: string; error?: string }
  > = {
    name: "team_invite",
    tier: "strategic",
    category: "team",
    sensitiveOutput: true,
    shortClause: "issue a bearer code another host can use to join this team",
    description:
      "Generate a single-use-at-redemption-time bearer code for a team you belong to. The code embeds the team's HMAC secret — anyone holding it can join. Pass `ttlMs` to expire it; omit for no expiry. The code is printed once; if you lose it, mint another. Strategic tier — this credential is the entry point to a shared identity. Output is marked sensitive so the bearer string never leaks into truncated tool-result rows.",
    inputSchema: {
      type: "object",
      properties: {
        teamId: { type: "string" },
        ttlMs: { type: "number", minimum: 0 },
      },
      required: ["teamId"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const team = getTeam(args.teamId);
      if (!team) return { ok: false, error: `unknown team ${args.teamId}` };
      if (!getMembership(args.teamId, ctx.actorId)) {
        return { ok: false, error: "not a member of this team" };
      }
      const addr = await bridge.ensureListener();
      const secret = await readTeamSecret(args.teamId);
      const inviteId = ulid();
      const bearer: BearerCode = {
        proto: "olle.v0",
        teamId: args.teamId,
        inviteId,
        addr,
        secret,
      };
      const code = encodeBearerCode(bearer);
      const now = Date.now();
      const expiresAt = args.ttlMs && args.ttlMs > 0 ? now + args.ttlMs : null;
      store
        .insert(tables.teamInvites)
        .values({
          inviteId,
          teamId: args.teamId,
          codeHash: hashBearerCode(code),
          secretRef: `secrets/team/${args.teamId}`,
          addr,
          createdByActorId: ctx.actorId,
          createdAt: now,
          expiresAt: expiresAt ?? null,
          redeemedAt: null,
          redeemedByHostId: null,
        })
        .run();
      bus.publish({
        type: "team.invite-issued",
        payload: { teamId: args.teamId, inviteId, expiresAt },
        hostId,
        actorId: ctx.actorId,
        durable: true,
      });
      return { ok: true, code, inviteId };
    },
  };

  const joinTeam: ToolDef<
    { code: string },
    { ok: boolean; teamId?: string; peerHostId?: string; error?: string }
  > = {
    name: "team_join",
    tier: "strategic",
    category: "team",
    shortClause: "accept an inbound bearer code and become a peer in that team",
    description:
      "Decode a bearer code, dial the inviter, exchange a signed hello/welcome handshake, and persist the team locally. On success this host joins the team's mesh, registers the secret with the bridge, and dials the other peers the welcome advertised. Strategic tier — entering a new trust relationship. Returns the joined teamId and the inviter's peerHostId. Invalid codes are rejected before any network round-trip.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", minLength: 1 },
      },
      required: ["code"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      let decoded: BearerCode;
      try {
        decoded = decodeBearerCode(args.code);
      } catch (err) {
        const msg = err instanceof BearerCodeError ? err.message : String(err);
        return { ok: false, error: `invalid code: ${msg}` };
      }
      if (getTeam(decoded.teamId)) {
        return { ok: false, error: `already a member of team ${decoded.teamId}` };
      }
      try {
        const welcome = await performJoinHandshake({
          decoded,
          hostId,
          webSocketFactory: opts.webSocketFactory ?? defaultWebSocketFactory,
          timeoutMs: opts.joinTimeoutMs ?? 15_000,
        });
        const peerHostId = welcome.fromHostId;
        const welcomePayload = welcome.kind === "welcome" ? welcome.payload : {};
        const teamName =
          (welcomePayload.teamName as string | undefined) ??
          `team-${decoded.teamId.slice(0, 8)}`;
        // Current welcomes use {peerHostId, addr}; hostId is accepted as
        // a wire-compat alias for older inviters.
        const peerSet = Array.isArray(welcomePayload.peerSet)
          ? normalizePeerSet(welcomePayload.peerSet)
          : [];
        await writeTeamSecret(decoded.teamId, decoded.secret);
        const now = Date.now();
        store
          .insert(tables.teams)
          .values({ id: decoded.teamId, name: teamName, createdAt: now })
          .onConflictDoNothing()
          .run();
        store
          .insert(tables.teamMembers)
          .values({
            teamId: decoded.teamId,
            actorId: ctx.actorId,
            role: "member",
            joinedAt: now,
          })
          .onConflictDoNothing()
          .run();
        store
          .insert(tables.teamPeers)
          .values({
            teamId: decoded.teamId,
            peerHostId,
            addr: decoded.addr,
            status: "connected",
            lastHeartbeatAt: now,
            lastReceivedEventId: null,
            joinedAt: now,
          })
          .onConflictDoNothing()
          .run();
        for (const peer of peerSet) {
          if (!peer || typeof peer.peerHostId !== "string" || peer.peerHostId === hostId) continue;
          if (peer.peerHostId === peerHostId) continue;
          store
            .insert(tables.teamPeers)
            .values({
              teamId: decoded.teamId,
              peerHostId: peer.peerHostId,
              addr: peer.addr,
              status: "connecting",
              lastHeartbeatAt: null,
              lastReceivedEventId: null,
              joinedAt: now,
            })
            .onConflictDoNothing()
            .run();
        }
        bridge.setTeamSecret(decoded.teamId, decoded.secret);
        bridge.addPeer(decoded.teamId, peerHostId, decoded.addr, null);
        for (const peer of peerSet) {
          if (!peer || typeof peer.peerHostId !== "string" || peer.peerHostId === hostId) continue;
          if (peer.peerHostId === peerHostId) continue;
          bridge.addPeer(decoded.teamId, peer.peerHostId, peer.addr, null);
        }
        bus.publish({
          type: "team.joined",
          payload: {
            teamId: decoded.teamId,
            peerHostId,
            joinedByActorId: ctx.actorId,
          },
          hostId,
          actorId: ctx.actorId,
          durable: true,
        });
        return { ok: true, teamId: decoded.teamId, peerHostId };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `join failed: ${msg}` };
      }
    },
  };

  const leave: ToolDef<
    { teamId: string },
    { ok: boolean; teamId?: string; error?: string }
  > = {
    name: "team_leave",
    tier: "operational",
    category: "team",
    shortClause: "drop out of a team and tear down its mesh links",
    description:
      "Leave a team. Broadcasts a signed peer_left to connected peers, tears down the bridge's PeerLinks, deletes the local rows (team_peers, team_members), and best-effort removes the on-disk team secret. Operational tier — the act is locally reversible (you can rejoin with a new invite). Returns {ok, teamId}.",
    inputSchema: {
      type: "object",
      properties: { teamId: { type: "string" } },
      required: ["teamId"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const team = getTeam(args.teamId);
      if (!team) return { ok: false, error: `unknown team ${args.teamId}` };
      if (!getMembership(args.teamId, ctx.actorId)) {
        return { ok: false, error: "not a member of this team" };
      }
      try {
        bridge.broadcastPeerLeft(args.teamId);
      } catch (err) {
        // eslint-disable-next-line no-console -- team tool infra
        console.warn(`[team_leave] broadcast peer_left failed: ${(err as Error).message}`);
      }
      bridge.dropTeam(args.teamId);
      store.delete(tables.teamPeers).where(eq(tables.teamPeers.teamId, args.teamId)).run();
      store
        .delete(tables.teamMembers)
        .where(
          and(
            eq(tables.teamMembers.teamId, args.teamId),
            eq(tables.teamMembers.actorId, ctx.actorId),
          ),
        )
        .run();
      // Best-effort secret cleanup. Other team members on this host (if
      // any in v1+) would also lose the secret here — v0 is single-member-
      // per-host so this is unambiguous.
      try {
        await unlink(secretPathFor(args.teamId));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          // eslint-disable-next-line no-console -- team tool infra
          console.warn(`[team_leave] could not remove secret: ${(err as Error).message}`);
        }
      }
      bus.publish({
        type: "team.left",
        payload: { teamId: args.teamId, leavingActorId: ctx.actorId },
        hostId,
        actorId: ctx.actorId,
        durable: true,
      });
      return { ok: true, teamId: args.teamId };
    },
  };

  const status: ToolDef<Record<string, never>, { teams: TeamStatusEntry[] }> = {
    name: "team_status",
    tier: "operational",
    category: "team",
    shortClause: "list teams this host belongs to, their members, and connected peers",
    description:
      "Return every team this host is a member of, with member roster and peer connectivity (status, last heartbeat, last received event watermark). Read-only — safe to call any time, including between strategic turns to confirm a join landed or to diagnose flapping peers.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: () => {
      const teamRows = store.select().from(tables.teams).all();
      const result: TeamStatusEntry[] = [];
      for (const t of teamRows) {
        const members = store
          .select()
          .from(tables.teamMembers)
          .where(eq(tables.teamMembers.teamId, t.id))
          .all();
        const peers = store
          .select()
          .from(tables.teamPeers)
          .where(eq(tables.teamPeers.teamId, t.id))
          .all();
        result.push({
          teamId: t.id,
          name: t.name,
          members: members.map((m) => ({
            actorId: m.actorId,
            role: m.role,
            joinedAt: m.joinedAt,
          })),
          peers: peers.map((p) => ({
            peerHostId: p.peerHostId,
            addr: p.addr,
            status: p.status,
            lastHeartbeatAt: p.lastHeartbeatAt,
            lastReceivedEventId: p.lastReceivedEventId,
          })),
        });
      }
      return { teams: result };
    },
  };

  return [create, invite, joinTeam, leave, status];
}

interface JoinHandshakeOptions {
  decoded: BearerCode;
  hostId: string;
  webSocketFactory: (addr: string) => WebSocket;
  timeoutMs: number;
}

/** Open a raw WebSocket to the inviter, send a signed hello carrying the
 *  invite id, wait for a verified welcome, close. The bridge's PeerLink
 *  redials normally afterwards — this handshake exists only to claim the
 *  invite and learn the inviter's hostId + peerSet. */
async function performJoinHandshake(opts: JoinHandshakeOptions): Promise<MeshEnvelope> {
  return new Promise<MeshEnvelope>((resolve, reject) => {
    let settled = false;
    const ws = opts.webSocketFactory(opts.decoded.addr);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error(`handshake timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    const finish = (err: Error | null, env?: MeshEnvelope): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      if (err) reject(err);
      else if (env) resolve(env);
    };

    ws.addEventListener("open", () => {
      const unsigned: UnsignedEnvelope = {
        proto: "olle.v0",
        envelopeId: ulid(),
        teamId: opts.decoded.teamId,
        fromHostId: opts.hostId,
        kind: "hello",
        payload: { inviteId: opts.decoded.inviteId, joinerHostId: opts.hostId },
        sentAt: Date.now(),
      };
      const hmac = signEnvelope(unsigned, opts.decoded.secret);
      const env: MeshEnvelope = { ...unsigned, hmac } as MeshEnvelope;
      try {
        ws.send(JSON.stringify(env));
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      const raw = typeof ev.data === "string" ? ev.data : ev.data?.toString?.() ?? "";
      let env: MeshEnvelope;
      try {
        env = decodeEnvelope(raw);
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (env.teamId !== opts.decoded.teamId) {
        finish(new Error(`welcome teamId mismatch: ${env.teamId}`));
        return;
      }
      if (!verifyEnvelope(env, opts.decoded.secret)) {
        finish(new Error("welcome HMAC verify failed"));
        return;
      }
      if (env.kind === "error") {
        const p = env.payload as { reason?: string };
        finish(new Error(p?.reason ?? "inviter rejected hello"));
        return;
      }
      if (env.kind !== "welcome") {
        // Tolerate stray heartbeats etc; only welcome resolves the promise.
        return;
      }
      finish(null, env);
    });
    ws.addEventListener("error", (ev: Event | { message?: string }) => {
      const message = (ev as { message?: string }).message ?? "websocket error";
      finish(new Error(message));
    });
    ws.addEventListener("close", () => {
      finish(new Error("connection closed before welcome"));
    });
  });
}

function normalizePeerSet(raw: unknown[]): PeerSetEntry[] {
  const out: PeerSetEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const p = entry as { peerHostId?: unknown; hostId?: unknown; addr?: unknown };
    const peerHostId =
      typeof p.peerHostId === "string"
        ? p.peerHostId
        : typeof p.hostId === "string"
          ? p.hostId
          : null;
    if (!peerHostId || typeof p.addr !== "string") continue;
    out.push({ peerHostId, addr: p.addr });
  }
  return out;
}

const defaultWebSocketFactory = (addr: string): WebSocket => new WebSocket(addr);
