// Two-cell team substrate integration test.
//
// Spins up two daemons (Alice + Bob) on separate data roots + ephemeral
// mesh ports, walks Alice through team_create → invite → Bob joins,
// then exercises the success criteria from docs/plan/teams.plan.md:
//
//  1. team_status on both cells reports two members + the connected peer
//  2. (deferred to mesh-claims unit tests) team-scoped claimable events:
//     covered in test/team-claims.test.ts so we don't re-do the timing
//     dance here
//  3. memory.wrote (scope=team) propagates Alice → Bob (forward direction)
//  4. memory.wrote (scope=private) does NOT propagate
//  5. memory.forgotten followed by a stale memory.wrote does not resurrect

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startDaemon, type Daemon } from "../../src/daemon/daemon.ts";
import { connectIpc, type IpcClient } from "../../src/ipc/index.ts";
import { tables } from "../../src/store/index.ts";
import { MEMORY_WROTE, MEMORY_FORGOTTEN } from "../../src/memory/events.ts";
import { ulid, encodeStamp, createClock } from "../../src/id/index.ts";

process.env.OLLE_ADVERTISE_ADDR = "ws://127.0.0.1";

let aliceRoot: string;
let bobRoot: string;
let alice: Daemon;
let bob: Daemon;
let aliceClient: IpcClient;
let bobClient: IpcClient;

beforeAll(async () => {
  aliceRoot = mkdtempSync(join(tmpdir(), "olle-alice-"));
  bobRoot = mkdtempSync(join(tmpdir(), "olle-bob-"));
  alice = await startDaemon({
    root: aliceRoot,
    version: "test",
    quiet: true,
    meshPort: 0,
  });
  bob = await startDaemon({
    root: bobRoot,
    version: "test",
    quiet: true,
    meshPort: 0,
  });
  aliceClient = await connectIpc(alice.paths.socketFile);
  bobClient = await connectIpc(bob.paths.socketFile);
});

afterAll(async () => {
  aliceClient.close();
  bobClient.close();
  await alice.shutdown();
  await bob.shutdown();
  rmSync(aliceRoot, { recursive: true, force: true });
  rmSync(bobRoot, { recursive: true, force: true });
});

async function waitFor<T>(
  predicate: () => Promise<T | null | undefined> | T | null | undefined,
  timeoutMs = 3_000,
  intervalMs = 50,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("two-cell team substrate", () => {
  let teamId: string;
  let inviteCode: string;

  it("Alice creates a team and Bob joins via bearer code", async () => {
    const created = await aliceClient.call<{ ok: boolean; teamId: string }>(
      "team.create",
      { name: "demo-team" },
    );
    expect(created.ok).toBe(true);
    teamId = created.teamId;

    const issued = await aliceClient.call<{ ok: boolean; code: string }>(
      "team.invite",
      { teamId },
    );
    expect(issued.ok).toBe(true);
    inviteCode = issued.code;

    const joined = await bobClient.call<{
      ok: boolean;
      teamId: string;
      peerHostId: string;
      error?: string;
    }>("team.join", { code: inviteCode });
    expect(joined.ok).toBe(true);
    expect(joined.teamId).toBe(teamId);
    expect(joined.peerHostId).toBe(alice.hostId);
  });

  it("both cells report a member each plus a connected peer", async () => {
    // Bob's view should land immediately after join; Alice's side learns
    // of the new peer through her listener's onPeerHello callback. We
    // poll for a few ticks since the listener fires asynchronously.
    const aliceStatus = await waitFor(async () => {
      const r = await aliceClient.call<{
        teams: Array<{ teamId: string; peers: Array<{ peerHostId: string; status: string }> }>;
      }>("team.status");
      const t = r.teams.find((t) => t.teamId === teamId);
      if (!t) return null;
      const peer = t.peers.find((p) => p.peerHostId === bob.hostId);
      return peer ? t : null;
    });
    expect(aliceStatus.peers.length).toBeGreaterThanOrEqual(1);
    expect(aliceStatus.peers[0]!.peerHostId).toBe(bob.hostId);

    const bobStatus = await waitFor(async () => {
      const r = await bobClient.call<{
        teams: Array<{ teamId: string; peers: Array<{ peerHostId: string; status: string }> }>;
      }>("team.status");
      const t = r.teams.find((t) => t.teamId === teamId);
      if (!t || t.peers.length === 0) return null;
      return t;
    });
    expect(bobStatus.peers[0]!.peerHostId).toBe(alice.hostId);
  });

  it("team-scoped memory.wrote propagates from Alice to Bob", async () => {
    const memoryId = ulid();
    const clock = createClock();
    alice.bus.publish({
      type: MEMORY_WROTE,
      payload: {
        id: memoryId,
        actorId: alice.humanAgentId,
        scope: "team",
        scopeRef: teamId,
        role: "knowledge",
        title: "shared note",
        bodyMd: "the test wrote this",
        tags: [],
        depth: 1,
      },
      hostId: alice.hostId,
      actorId: alice.humanAgentId,
      durable: true,
    });

    const row = await waitFor(() => {
      return bob.store
        .select()
        .from(tables.memories)
        .all()
        .find((m) => m.id === memoryId);
    });
    expect(row.scope).toBe("team");
    // Identity preservation (Wave 2 honest-event-identity): Bob's row
    // carries Alice's hostId, not Bob's.
    expect(row.hostId).toBe(alice.hostId);
    expect(row.actorId).toBe(alice.humanAgentId);
  });

  it("private memory.wrote does NOT cross to Bob", async () => {
    const memoryId = ulid();
    alice.bus.publish({
      type: MEMORY_WROTE,
      payload: {
        id: memoryId,
        actorId: alice.humanAgentId,
        scope: "private",
        scopeRef: alice.humanAgentId,
        role: "knowledge",
        title: "alice's private note",
        bodyMd: "no leak",
        tags: [],
        depth: 1,
      },
      hostId: alice.hostId,
      actorId: alice.humanAgentId,
      durable: true,
    });
    // Give the bridge an honest shot to (incorrectly) mirror it.
    await new Promise((r) => setTimeout(r, 250));
    const bobRow = bob.store
      .select()
      .from(tables.memories)
      .all()
      .find((m) => m.id === memoryId);
    expect(bobRow).toBeUndefined();
    const aliceRow = alice.store
      .select()
      .from(tables.memories)
      .all()
      .find((m) => m.id === memoryId);
    expect(aliceRow).toBeDefined();
  });

  it("out-of-order tombstone keeps memory forgotten", async () => {
    // Write team memory on Alice → propagates → forget on Alice →
    // propagates → then attempt an older-HLC write on Bob. The tombstone
    // (Wave 1B + Wave 2) must reject the stale write.
    const memoryId = ulid();
    const clock = createClock();
    const wroteStamp = clock.now();
    alice.bus.publish({
      type: MEMORY_WROTE,
      payload: {
        id: memoryId,
        actorId: alice.humanAgentId,
        scope: "team",
        scopeRef: teamId,
        role: "knowledge",
        title: "ephemeral",
        bodyMd: "will be forgotten",
        tags: [],
        depth: 1,
      },
      hostId: alice.hostId,
      actorId: alice.humanAgentId,
      durable: true,
    });
    await waitFor(() => {
      return bob.store
        .select()
        .from(tables.memories)
        .all()
        .find((m) => m.id === memoryId);
    });

    alice.bus.publish({
      type: MEMORY_FORGOTTEN,
      payload: { id: memoryId, scope: "team", scopeRef: teamId },
      hostId: alice.hostId,
      actorId: alice.humanAgentId,
      durable: true,
    });
    await waitFor(() => {
      const row = bob.store
        .select()
        .from(tables.memories)
        .all()
        .find((m) => m.id === memoryId);
      return row ? null : true;
    });

    // Inject a stale-hlc wrote directly via bus.inject on Bob (simulating
    // a late event arriving out of order). The HLC is older than the
    // forgotten event's, so the tombstone rejects it.
    const staleHlc = encodeStamp({ l: wroteStamp.l - 1_000_000, c: 0 });
    bob.bus.inject(
      {
        id: ulid(),
        hlc: staleHlc,
        hostId: alice.hostId,
        actorId: alice.humanAgentId,
        type: MEMORY_WROTE,
        payload: {
          id: memoryId,
          actorId: alice.humanAgentId,
          scope: "team",
          scopeRef: teamId,
          role: "knowledge",
          title: "resurrected?",
          bodyMd: "no",
          tags: [],
          depth: 1,
        },
        createdAt: Date.now() - 60_000,
        durable: true,
      },
      { remote: true },
    );
    // Tombstone wins: row stays absent.
    await new Promise((r) => setTimeout(r, 100));
    const row = bob.store
      .select()
      .from(tables.memories)
      .all()
      .find((m) => m.id === memoryId);
    expect(row).toBeUndefined();
  });
});
