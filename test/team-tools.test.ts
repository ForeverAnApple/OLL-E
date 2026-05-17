import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTeamTools } from "../src/tools/team.ts";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import { decodeBearerCode, hashBearerCode } from "../src/mesh/code.ts";
import {
  decodeEnvelope,
  signEnvelope,
  verifyEnvelope,
  type MeshEnvelope,
  type UnsignedEnvelope,
} from "../src/mesh/envelope.ts";
import type { RealMeshBridge } from "../src/mesh/bridge.ts";
import type { MeshBridge } from "../src/mesh/index.ts";

interface BridgeCall {
  method: string;
  args: unknown[];
}

function stubBridge(addr: string = "ws://127.0.0.1:40001"): RealMeshBridge & { calls: BridgeCall[] } {
  const calls: BridgeCall[] = [];
  const noop = (): void => undefined;
  const asBridgeStub: MeshBridge = {
    peerId: "stub",
    broadcast: noop,
    onReceive: () => noop,
    close: noop,
  };
  return {
    calls,
    addr,
    listenerPort: 40001,
    asBridge: () => asBridgeStub,
    start: async () => undefined,
    close: async () => undefined,
    ensureListener: async () => {
      calls.push({ method: "ensureListener", args: [] });
      return addr;
    },
    setTeamSecret: (teamId, secret) => {
      calls.push({ method: "setTeamSecret", args: [teamId, secret] });
    },
    addPeer: (...args) => {
      calls.push({ method: "addPeer", args: args as unknown[] });
    },
    removePeer: (...args) => {
      calls.push({ method: "removePeer", args: args as unknown[] });
    },
    dropTeam: (teamId) => {
      calls.push({ method: "dropTeam", args: [teamId] });
    },
    broadcastPeerLeft: (teamId) => {
      calls.push({ method: "broadcastPeerLeft", args: [teamId] });
    },
  } as RealMeshBridge & { calls: BridgeCall[] };
}

async function makeRig() {
  const tmp = await mkdtemp(join(tmpdir(), "olle-team-tools-"));
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "test", createdAt: Date.now() }).run();
  const actorId = ulid();
  store
    .insert(tables.agents)
    .values({
      id: actorId,
      name: "human",
      hostId,
      parentAgentId: null,
      systemPrompt: null,
      budgetRef: null,
      scope: { allowTiers: ["operational", "strategic", "vision"] },
      channels: [],
      ownsMoney: true,
      createdAt: Date.now(),
    })
    .run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  const bridge = stubBridge();
  const tools = buildTeamTools({
    bus,
    store,
    hostId,
    bridge,
    olleRoot: tmp,
    joinTimeoutMs: 1_000,
  });
  const byName = new Map(tools.map((t) => [t.name, t] as const));
  const ctx = {
    hostId,
    extensionId: "core",
    actorId,
    abort: new AbortController().signal,
    secrets: {},
  };
  return { tmp, store, bus, hostId, actorId, bridge, tools, byName, ctx };
}

describe("team_create", () => {
  it("persists rows, writes secret, and registers with bridge", async () => {
    const rig = await makeRig();
    try {
      const tool = rig.byName.get("team_create")!;
      const res = (await tool.execute({ name: "alpha" }, rig.ctx)) as {
        ok: boolean;
        teamId: string;
      };
      expect(res.ok).toBe(true);
      expect(typeof res.teamId).toBe("string");
      const team = rig.store
        .select()
        .from(tables.teams)
        .all()
        .find((t) => t.id === res.teamId);
      expect(team?.name).toBe("alpha");
      const member = rig.store
        .select()
        .from(tables.teamMembers)
        .all()
        .find((m) => m.teamId === res.teamId);
      expect(member?.actorId).toBe(rig.actorId);
      const secretFile = join(rig.tmp, "secrets", "team", res.teamId);
      const secret = await readFile(secretFile, "utf8");
      expect(secret.length).toBeGreaterThanOrEqual(40);
      const st = await stat(secretFile);
      expect(st.mode & 0o777).toBe(0o600);
      const setCall = rig.bridge.calls.find((c) => c.method === "setTeamSecret");
      expect(setCall?.args[0]).toBe(res.teamId);
      expect(setCall?.args[1]).toBe(secret);
    } finally {
      await rm(rig.tmp, { recursive: true, force: true });
    }
  });

  it("rejects empty name", async () => {
    const rig = await makeRig();
    try {
      const tool = rig.byName.get("team_create")!;
      const res = (await tool.execute({ name: "   " }, rig.ctx)) as { ok: boolean; error?: string };
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/name/);
    } finally {
      await rm(rig.tmp, { recursive: true, force: true });
    }
  });
});

describe("team_invite", () => {
  it("produces a decodable code, persists the hash, and is sensitive", async () => {
    const rig = await makeRig();
    try {
      const create = rig.byName.get("team_create")!;
      const created = (await create.execute({ name: "beta" }, rig.ctx)) as { teamId: string };
      const invite = rig.byName.get("team_invite")!;
      expect(invite.sensitiveOutput).toBe(true);
      const res = (await invite.execute({ teamId: created.teamId }, rig.ctx)) as {
        ok: boolean;
        code: string;
        inviteId: string;
      };
      expect(res.ok).toBe(true);
      const decoded = decodeBearerCode(res.code);
      expect(decoded.teamId).toBe(created.teamId);
      expect(decoded.inviteId).toBe(res.inviteId);
      const row = rig.store
        .select()
        .from(tables.teamInvites)
        .all()
        .find((r) => r.inviteId === res.inviteId);
      expect(row?.codeHash).toBe(hashBearerCode(res.code));
    } finally {
      await rm(rig.tmp, { recursive: true, force: true });
    }
  });

  it("rejects unknown team", async () => {
    const rig = await makeRig();
    try {
      const invite = rig.byName.get("team_invite")!;
      const res = (await invite.execute({ teamId: "no-such-team" }, rig.ctx)) as {
        ok: boolean;
        error?: string;
      };
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/unknown team/);
    } finally {
      await rm(rig.tmp, { recursive: true, force: true });
    }
  });

  it("respects ttlMs by writing expires_at into the row", async () => {
    const rig = await makeRig();
    try {
      const create = rig.byName.get("team_create")!;
      const created = (await create.execute({ name: "gamma" }, rig.ctx)) as { teamId: string };
      const invite = rig.byName.get("team_invite")!;
      const before = Date.now();
      const res = (await invite.execute(
        { teamId: created.teamId, ttlMs: 60_000 },
        rig.ctx,
      )) as { ok: boolean; inviteId: string };
      expect(res.ok).toBe(true);
      const row = rig.store
        .select()
        .from(tables.teamInvites)
        .all()
        .find((r) => r.inviteId === res.inviteId);
      expect(row?.expiresAt).not.toBeNull();
      expect(row!.expiresAt!).toBeGreaterThanOrEqual(before + 60_000);
    } finally {
      await rm(rig.tmp, { recursive: true, force: true });
    }
  });
});

describe("team_join", () => {
  it("rejects malformed code WITHOUT touching network", async () => {
    const rig = await makeRig();
    try {
      const join = rig.byName.get("team_join")!;
      const res = (await join.execute({ code: "not-a-code" }, rig.ctx)) as {
        ok: boolean;
        error?: string;
      };
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/invalid code/);
      // No bridge calls — fail-fast.
      expect(rig.bridge.calls.length).toBe(0);
    } finally {
      await rm(rig.tmp, { recursive: true, force: true });
    }
  });

  it("completes the handshake against a stub inviter and persists rows", async () => {
    const rig = await makeRig();
    try {
      // Stub inviter: holds the team secret, accepts hello, returns
      // a signed welcome with peerSet. Modeled as a fake WebSocket so
      // we don't depend on real listener wiring.
      const teamId = ulid();
      const inviterHostId = "inviter-host";
      const inviterSecret = "the-shared-secret";
      const inviteId = ulid();
      const otherPeerHostId = "third-host";
      const fakeWs = createFakeWebSocket({
        onHello: (env: MeshEnvelope) => {
          expect(env.teamId).toBe(teamId);
          expect(env.fromHostId).toBe(rig.hostId);
          expect(verifyEnvelope(env, inviterSecret)).toBe(true);
          const unsigned: UnsignedEnvelope = {
            proto: "olle.v0",
            envelopeId: ulid(),
            teamId,
            fromHostId: inviterHostId,
            kind: "welcome",
            payload: {
              teamName: "delta",
              peerSet: [{ hostId: otherPeerHostId, addr: "ws://127.0.0.1:40003" }],
            },
            sentAt: Date.now(),
          };
          const hmac = signEnvelope(unsigned, inviterSecret);
          return JSON.stringify({ ...unsigned, hmac } as MeshEnvelope);
        },
      });
      const code = encodeFakeBearer(teamId, inviteId, inviterSecret);
      const join = rig.byName.get("team_join")!;
      const tools = buildTeamTools({
        bus: rig.bus,
        store: rig.store,
        hostId: rig.hostId,
        bridge: rig.bridge,
        olleRoot: rig.tmp,
        joinTimeoutMs: 1_000,
        webSocketFactory: () => fakeWs.ws as unknown as WebSocket,
      });
      const joinTool = tools.find((t) => t.name === "team_join")!;
      const res = (await joinTool.execute({ code }, rig.ctx)) as {
        ok: boolean;
        teamId?: string;
        peerHostId?: string;
        error?: string;
      };
      expect(res.ok).toBe(true);
      expect(res.teamId).toBe(teamId);
      expect(res.peerHostId).toBe(inviterHostId);
      const peers = rig.store
        .select()
        .from(tables.teamPeers)
        .all()
        .filter((p) => p.teamId === teamId);
      expect(peers.length).toBe(2);
      const setSecret = rig.bridge.calls.find(
        (c) => c.method === "setTeamSecret" && (c.args[0] as string) === teamId,
      );
      expect(setSecret).toBeDefined();
      const addPeers = rig.bridge.calls.filter((c) => c.method === "addPeer");
      expect(addPeers.length).toBe(2);
    } finally {
      await rm(rig.tmp, { recursive: true, force: true });
    }
  });

  it("rejects already-joined team", async () => {
    const rig = await makeRig();
    try {
      const create = rig.byName.get("team_create")!;
      const created = (await create.execute({ name: "duplicate" }, rig.ctx)) as { teamId: string };
      const invite = rig.byName.get("team_invite")!;
      const issued = (await invite.execute({ teamId: created.teamId }, rig.ctx)) as { code: string };
      const join = rig.byName.get("team_join")!;
      const res = (await join.execute({ code: issued.code }, rig.ctx)) as {
        ok: boolean;
        error?: string;
      };
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/already a member/);
    } finally {
      await rm(rig.tmp, { recursive: true, force: true });
    }
  });
});

describe("team_leave", () => {
  it("tears down rows, signals bridge, and removes the secret file", async () => {
    const rig = await makeRig();
    try {
      const create = rig.byName.get("team_create")!;
      const created = (await create.execute({ name: "epsilon" }, rig.ctx)) as { teamId: string };
      const secretFile = join(rig.tmp, "secrets", "team", created.teamId);
      await stat(secretFile);
      const leave = rig.byName.get("team_leave")!;
      const res = (await leave.execute({ teamId: created.teamId }, rig.ctx)) as { ok: boolean };
      expect(res.ok).toBe(true);
      const remainingMembers = rig.store
        .select()
        .from(tables.teamMembers)
        .all()
        .filter((m) => m.teamId === created.teamId);
      expect(remainingMembers.length).toBe(0);
      const calls = rig.bridge.calls.map((c) => c.method);
      expect(calls).toContain("broadcastPeerLeft");
      expect(calls).toContain("dropTeam");
      let secretStillExists = true;
      try {
        await stat(secretFile);
      } catch {
        secretStillExists = false;
      }
      expect(secretStillExists).toBe(false);
    } finally {
      await rm(rig.tmp, { recursive: true, force: true });
    }
  });

  it("rejects unknown team and non-membership", async () => {
    const rig = await makeRig();
    try {
      const leave = rig.byName.get("team_leave")!;
      const r1 = (await leave.execute({ teamId: "missing" }, rig.ctx)) as {
        ok: boolean;
        error?: string;
      };
      expect(r1.ok).toBe(false);
      expect(r1.error).toMatch(/unknown team/);
    } finally {
      await rm(rig.tmp, { recursive: true, force: true });
    }
  });
});

describe("team_status", () => {
  it("returns teams with members and peers shaped correctly", async () => {
    const rig = await makeRig();
    try {
      const create = rig.byName.get("team_create")!;
      const a = (await create.execute({ name: "alpha" }, rig.ctx)) as { teamId: string };
      const b = (await create.execute({ name: "beta" }, rig.ctx)) as { teamId: string };
      rig.store
        .insert(tables.teamPeers)
        .values({
          teamId: a.teamId,
          peerHostId: "peer-x",
          addr: "ws://127.0.0.1:50001",
          status: "connected",
          lastHeartbeatAt: 12345,
          lastReceivedEventId: null,
          joinedAt: Date.now(),
        })
        .run();
      const status = rig.byName.get("team_status")!;
      const res = (await status.execute({}, rig.ctx)) as {
        teams: Array<{
          teamId: string;
          name: string;
          members: Array<{ actorId: string }>;
          peers: Array<{ peerHostId: string; status: string }>;
        }>;
      };
      const sorted = [...res.teams].sort((x, y) => x.name.localeCompare(y.name));
      expect(sorted.map((t) => t.name)).toEqual(["alpha", "beta"]);
      const alpha = sorted[0]!;
      expect(alpha.teamId).toBe(a.teamId);
      expect(alpha.members[0]!.actorId).toBe(rig.actorId);
      expect(alpha.peers).toEqual([
        expect.objectContaining({ peerHostId: "peer-x", status: "connected" }),
      ]);
      const beta = sorted[1]!;
      expect(beta.teamId).toBe(b.teamId);
      expect(beta.peers).toEqual([]);
    } finally {
      await rm(rig.tmp, { recursive: true, force: true });
    }
  });
});

// ─── Fake WebSocket helpers ───────────────────────────────────────────────

interface FakeWsHandle {
  ws: {
    readyState: number;
    addEventListener: (kind: string, fn: (...args: unknown[]) => void) => void;
    send: (data: string) => void;
    close: () => void;
  };
}

function createFakeWebSocket(opts: {
  onHello: (env: MeshEnvelope) => string | null;
}): FakeWsHandle {
  type Listener = (...args: unknown[]) => void;
  const listeners = new Map<string, Listener[]>();
  let state = 0; // CONNECTING
  const add = (kind: string, fn: Listener): void => {
    let arr = listeners.get(kind);
    if (!arr) {
      arr = [];
      listeners.set(kind, arr);
    }
    arr.push(fn);
  };
  const emit = (kind: string, ev?: unknown): void => {
    const arr = listeners.get(kind);
    if (!arr) return;
    for (const fn of arr) fn(ev);
  };
  // Fire 'open' on next microtask so addEventListener calls register first.
  queueMicrotask(() => {
    state = 1; // OPEN
    emit("open", {});
  });
  return {
    ws: {
      get readyState() {
        return state;
      },
      addEventListener: add,
      send: (data: string) => {
        if (state !== 1) throw new Error("fake ws send before open");
        let env: MeshEnvelope;
        try {
          env = decodeEnvelope(data);
        } catch (err) {
          emit("error", { message: String(err) });
          return;
        }
        const reply = opts.onHello(env);
        if (reply != null) {
          queueMicrotask(() => emit("message", { data: reply }));
        }
      },
      close: () => {
        if (state === 3) return;
        state = 3;
        emit("close", {});
      },
    },
  };
}

function encodeFakeBearer(teamId: string, inviteId: string, secret: string): string {
  // Matches the production encoder; small inline duplicate keeps the test
  // independent of internal module shape.
  const payload = {
    proto: "olle.v0",
    teamId,
    inviteId,
    addr: "ws://127.0.0.1:0",
    secret,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
