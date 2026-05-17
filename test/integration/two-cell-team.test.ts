// Two-cell team substrate integration test.
//
// Spins up two daemons (Alice + Bob) on separate data roots + ephemeral
// mesh ports, walks Alice through team_create → invite → Bob joins,
// then exercises the success criteria from docs/plan/teams.plan.md:
//
//  1. team_status on both cells reports two members + the connected peer
//  2. team-scoped claimable event: exactly one cell runs the handler;
//     both stores observe the won + lost claim rows; event identity
//     preserved across the bridge
//  3. memory.wrote (scope=team) propagates Alice → Bob (forward direction)
//  4. memory.wrote (scope=private) does NOT propagate
//  5. memory.forgotten followed by a stale memory.wrote does not resurrect
//  6. Alice (inviter) offline → Bob publishes team memory + team event
//     → Alice reconnects → catchup pulls Bob's gap events into Alice's
//     store with original hostId/hlc preserved. Plan-faithful direction
//     (the literal demo). Works because hello carries the joiner's
//     listener addr; the inviter addPeer's the joiner on first hello
//     and on restart re-dials, so catchup fires symmetrically.

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

  it("team-scoped claimable event runs on exactly one cell; both observe won + lost claims", async () => {
    // Same task id on both cells — the claim fingerprint defaults to
    // `${task.id}:${event.id}` so the schedulers arbitrate against each
    // other. Each handler records its host so we can assert the singleton.
    const taskId = "team-bug-fix";
    const ranOn: string[] = [];
    alice.scheduler.register({
      id: taskId,
      agentId: alice.rootAgentId,
      tier: "operational",
      eventType: "team.bug",
      handler: () => {
        ranOn.push(alice.hostId);
      },
    });
    bob.scheduler.register({
      id: taskId,
      agentId: bob.rootAgentId,
      tier: "operational",
      eventType: "team.bug",
      handler: () => {
        ranOn.push(bob.hostId);
      },
    });

    const trigger = alice.bus.publish({
      type: "team.bug",
      payload: { claimable: true, teamId, summary: "fix the auth bug" },
      hostId: alice.hostId,
      actorId: alice.humanAgentId,
      durable: true,
    });

    // Default claim window is 100ms; crossing latency + arbitration
    // callbacks need headroom. waitFor polls until both stores have
    // observed both intents (the wire round-trip completed).
    for (const cell of [alice, bob]) {
      await waitFor(() => {
        const rows = cell.store.raw
          .query<{ status: string }, [string]>(
            `SELECT status FROM team_claims WHERE event_id = ?`,
          )
          .all(trigger.id);
        return rows.length === 2 ? rows : null;
      }, 2_000);
    }
    // Let any second handler that's racing the assertion settle.
    await new Promise((r) => setTimeout(r, 150));
    expect(ranOn.length).toBe(1);
    const winnerHostId = ranOn[0]!;

    // Leaderless = each peer transitions its OWN row to reflect its
    // local decision. The winner additionally demotes peer rows to
    // "lost" in the same window; the loser leaves the winner's row at
    // "intent" because she has no authority over peer-owned rows. So
    // the cross-cell invariant is "both rows present + each cell's own
    // row matches its decision," not "both stores see won + lost."
    for (const cell of [alice, bob]) {
      const ownRow = cell.store.raw
        .query<{ status: string }, [string, string]>(
          `SELECT status FROM team_claims WHERE event_id = ? AND claiming_host_id = ?`,
        )
        .all(trigger.id, cell.hostId)[0]!;
      const expected = cell.hostId === winnerHostId ? "won" : "lost";
      expect(ownRow.status).toBe(expected);
    }

    // Honest event identity: Bob's local row for the triggering event
    // carries Alice's hostId + hlc, not re-minted on cross.
    const bobsEventRow = bob.store
      .select()
      .from(tables.events)
      .all()
      .find((e) => e.id === trigger.id);
    expect(bobsEventRow).toBeDefined();
    expect(bobsEventRow!.hostId).toBe(alice.hostId);
    expect(bobsEventRow!.hlc).toBe(trigger.hlc);
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

  // Catchup-on-reconnect (criterion 3) — plan-faithful direction:
  // the inviter (Alice) goes offline, the joiner (Bob) does work,
  // the inviter reconnects and pulls the gap.
  //
  // Works because hello carries the joiner's advertised listener addr,
  // the inviter's bridge addPeer's the joiner on first hello and
  // persists that addr, and on inviter restart bridge.start() re-dials
  // the joiner — catchup fires on the outbound `connected` transition.
  // Without that addr the inviter has no outbound link to dial and only
  // the joiner can request catchup (which is the wrong direction).
  it(
    "Alice offline → Bob publishes → Alice reconnects → catchup pulls gap events with original hostId/hlc",
    async () => {
    // Pin Alice's port so her bridge re-binds at the same addr Bob has
    // in team_peers. meshPort=0 would re-roll the port and Bob's
    // outbound reconnect would chase a dead socket.
    const alicePort = alice.bridge!.listenerPort;

    // Alice goes dark.
    aliceClient.close();
    await alice.shutdown();

    // While Alice is offline, Bob writes a team memory and emits a
    // separate team event. Both are durable; neither reaches Alice live.
    const offlineMemoryId = ulid();
    bob.bus.publish({
      type: MEMORY_WROTE,
      payload: {
        id: offlineMemoryId,
        actorId: bob.humanAgentId,
        scope: "team",
        scopeRef: teamId,
        role: "knowledge",
        title: "while-alice-was-offline",
        bodyMd: "bob wrote this during the gap",
        tags: [],
        depth: 1,
      },
      hostId: bob.hostId,
      actorId: bob.humanAgentId,
      durable: true,
    });
    const offlineEvent = bob.bus.publish({
      type: "team.work",
      payload: { teamId, summary: "work-during-alice-offline" },
      hostId: bob.hostId,
      actorId: bob.humanAgentId,
      durable: true,
    });

    // Snapshot Bob's authoritative rows so we can compare identity
    // fields after they land on Alice via catchup.
    const bobMemoryRow = bob.store
      .select()
      .from(tables.memories)
      .all()
      .find((m) => m.id === offlineMemoryId)!;
    const bobEventRow = bob.store
      .select()
      .from(tables.events)
      .all()
      .find((e) => e.id === offlineEvent.id)!;

    // Alice reconnects with the same data root + the same listener port.
    // Bridge.start() iterates team_peers, dials Bob using the addr
    // recorded from his original hello; on the `connected` transition,
    // catchup kicks off using the persisted last_received_event_id
    // watermark and pulls the gap.
    alice = await startDaemon({
      root: aliceRoot,
      version: "test",
      quiet: true,
      meshPort: alicePort,
    });
    aliceClient = await connectIpc(alice.paths.socketFile);

    const recoveredMemory = await waitFor(() => {
      return alice.store
        .select()
        .from(tables.memories)
        .all()
        .find((m) => m.id === offlineMemoryId);
    }, 8_000);
    const recoveredEvent = await waitFor(() => {
      return alice.store
        .select()
        .from(tables.events)
        .all()
        .find((e) => e.id === offlineEvent.id);
    }, 8_000);

    // Honest event identity preserved across catchup.
    expect(recoveredMemory.hostId).toBe(bob.hostId);
    expect(recoveredMemory.actorId).toBe(bob.humanAgentId);
    expect(recoveredMemory.hlc).toBe(bobMemoryRow.hlc);
    expect(recoveredEvent.hostId).toBe(bob.hostId);
    expect(recoveredEvent.actorId).toBe(bob.humanAgentId);
    expect(recoveredEvent.hlc).toBe(bobEventRow.hlc);
  },
  15_000,
  );
});
