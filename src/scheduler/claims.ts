// Leaderless claim window — cross-host arbitration for team-scoped
// claimable events.
//
// LOG 2026-05-13/05-14: no origin-host arbiter, no central decider. Every
// eligible peer reaches the same conclusion by applying the same rule
// (lowest (claim_hlc, claiming_host_id, claim_id) tuple) to the same
// observed set of intents. Partitions cause split-brain; that's all.
//
// Single-cell fast path lives in scheduler.ts; this module is only on
// the team path (events carrying payload.teamId).

import { and, eq, ne } from "drizzle-orm";
import type { EventBus } from "../bus/index.ts";
import type { Event } from "../bus/types.ts";
import type { Store } from "../store/db.ts";
import { tables } from "../store/index.ts";
import { ulid } from "../id/index.ts";
import type { TeamClaim } from "../store/schema.ts";

/** Minimal subset of scheduler's TaskDef the claims module needs.
 *  Kept narrow so we don't pull the full TaskDef type cycle through here. */
export interface ClaimTask {
  id: string;
  agentId: string;
}

// Wire shape for `task.claim` events. `claim_hlc` is *not* on the payload
// by design (honest-event-identity, LOG 2026-05-14): every peer derives it
// from the event's own hlc, which `bus.inject` preserves byte-for-byte
// across the mesh. Carrying it on the payload would force a post-publish
// patch — and the wire serializer captures the payload synchronously
// inside `bus.publish`, before any patch can land.
export interface TaskClaimPayload {
  teamId: string;
  eventId: string;
  eventHlc: string;
  claimId: string;
  claimingHostId: string;
  claimingAgentId: string;
  taskId: string;
  taskFingerprint: string;
}

export interface ClaimsOptions {
  bus: EventBus;
  store: Store;
  hostId: string;
  /** Window during which peer intents may still arrive before the timer
   *  fires. Default 100ms per plan ("100ms on LAN"); configurable for tests. */
  claimWindowMs?: number;
  /** Fires when this host wins arbitration — the scheduler runs the task. */
  onWin: (params: { task: ClaimTask; event: Event; claimRow: TeamClaim }) => void | Promise<void>;
  /** Fires when this host loses arbitration — the scheduler releases the
   *  reserved concurrency slot it took at registerIntent time. */
  onLose: (params: { task: ClaimTask; event: Event }) => void;
}

export interface Claims {
  registerIntent(params: { task: ClaimTask; event: Event; taskFingerprint?: string }): void;
  start(): void;
  stop(): void;
}

interface PendingArbitration {
  task: ClaimTask;
  event: Event;
  ourClaimId: string;
  timer: ReturnType<typeof setTimeout>;
}

function compareTuple(
  a: { claimHlc: string; claimingHostId: string; claimId: string },
  b: { claimHlc: string; claimingHostId: string; claimId: string },
): number {
  if (a.claimHlc < b.claimHlc) return -1;
  if (a.claimHlc > b.claimHlc) return 1;
  if (a.claimingHostId < b.claimingHostId) return -1;
  if (a.claimingHostId > b.claimingHostId) return 1;
  if (a.claimId < b.claimId) return -1;
  if (a.claimId > b.claimId) return 1;
  return 0;
}

export function createClaims(opts: ClaimsOptions): Claims {
  const windowMs = opts.claimWindowMs ?? 100;
  // Keyed by `${eventId}:${taskFingerprint}` — multiple tasks may compete
  // independently against the same event, each in their own window.
  const pending = new Map<string, PendingArbitration>();
  // event_id:task_fingerprint pairs where this host has already transitioned
  // its row to `won` and (we presume) handed control to the scheduler. Used
  // for late-arrival split-brain detection.
  const wonLocally = new Set<string>();
  let unsub: (() => void) | null = null;

  const arbKey = (eventId: string, fingerprint: string): string => `${eventId}:${fingerprint}`;

  function readIntents(eventId: string, fingerprint: string): TeamClaim[] {
    return opts.store
      .select()
      .from(tables.teamClaims)
      .where(
        and(
          eq(tables.teamClaims.eventId, eventId),
          eq(tables.teamClaims.taskFingerprint, fingerprint),
        ),
      )
      .all();
  }

  // INSERT OR IGNORE on (claim_id) PK — peer claims arriving on both buses
  // (e.g. shared bus in tests) are deduplicated by the bus, but the SQL
  // ignore is the durable guarantee.
  const insertClaimStmt = opts.store.raw.prepare(
    `INSERT OR IGNORE INTO team_claims
       (claim_id, team_id, event_id, event_hlc, claiming_host_id,
        claiming_agent_id, task_id, task_fingerprint, claim_hlc, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  function persistIntent(row: {
    claimId: string;
    teamId: string;
    eventId: string;
    eventHlc: string;
    claimingHostId: string;
    claimingAgentId: string;
    taskId: string;
    taskFingerprint: string;
    claimHlc: string;
  }): void {
    try {
      insertClaimStmt.run(
        row.claimId,
        row.teamId,
        row.eventId,
        row.eventHlc,
        row.claimingHostId,
        row.claimingAgentId,
        row.taskId,
        row.taskFingerprint,
        row.claimHlc,
        "intent",
        Date.now(),
      );
    } catch (err) {
      // eslint-disable-next-line no-console -- infra
      console.error(
        `[claims] persistIntent failed for claim=${row.claimId} event=${row.eventId}: ${
          (err as Error).message ?? err
        }`,
      );
    }
  }

  function decideWindow(eventId: string, fingerprint: string): void {
    const key = arbKey(eventId, fingerprint);
    const arb = pending.get(key);
    if (!arb) return;
    pending.delete(key);

    const rows = readIntents(eventId, fingerprint);
    if (rows.length === 0) return; // shouldn't happen — our own row is in there

    const winner = rows.reduce((lo, r) => (compareTuple(r, lo) < 0 ? r : lo));
    const ourRow = rows.find((r) => r.claimId === arb.ourClaimId);
    if (!ourRow) return;

    if (winner.claimId === arb.ourClaimId) {
      // Win: flip own row to `won`, peers to `lost`, hand off to scheduler.
      opts.store
        .update(tables.teamClaims)
        .set({ status: "won" })
        .where(eq(tables.teamClaims.claimId, arb.ourClaimId))
        .run();
      opts.store
        .update(tables.teamClaims)
        .set({ status: "lost" })
        .where(
          and(
            eq(tables.teamClaims.eventId, eventId),
            eq(tables.teamClaims.taskFingerprint, fingerprint),
            ne(tables.teamClaims.claimId, arb.ourClaimId),
          ),
        )
        .run();
      wonLocally.add(key);
      const wonRow: TeamClaim = { ...ourRow, status: "won" };
      try {
        const r = opts.onWin({ task: arb.task, event: arb.event, claimRow: wonRow });
        if (r && typeof (r as Promise<void>).catch === "function") {
          (r as Promise<void>).catch((err) => {
            // eslint-disable-next-line no-console -- infra
            console.error("[claims] onWin threw:", err);
          });
        }
      } catch (err) {
        // eslint-disable-next-line no-console -- infra
        console.error("[claims] onWin threw:", err);
      }
    } else {
      opts.store
        .update(tables.teamClaims)
        .set({ status: "lost" })
        .where(eq(tables.teamClaims.claimId, arb.ourClaimId))
        .run();
      opts.onLose({ task: arb.task, event: arb.event });
    }
  }

  function registerIntent(params: {
    task: ClaimTask;
    event: Event;
    taskFingerprint?: string;
  }): void {
    const { task, event } = params;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const teamId = typeof payload.teamId === "string" ? payload.teamId : null;
    if (!teamId) {
      // Defensive: caller should have routed elsewhere. Release slot.
      opts.onLose({ task, event });
      return;
    }
    const fingerprint = params.taskFingerprint ?? `${task.id}:${event.id}`;
    const claimId = ulid();

    // Publish the claim. Our own targeted "task.claim" subscription fires
    // synchronously inside dispatch, so `handleClaimEvent` persists the
    // intent row using `event.hlc` as claim_hlc before publish returns.
    // The wire bridge's "*" subscription fires after, broadcasting the
    // unmodified event to peers; their `handleClaimEvent` derives the
    // same claim_hlc on the other side. No payload patching needed.
    const claimEvent = opts.bus.publish<TaskClaimPayload>({
      type: "task.claim",
      payload: {
        teamId,
        eventId: event.id,
        eventHlc: event.hlc,
        claimId,
        claimingHostId: opts.hostId,
        claimingAgentId: task.agentId,
        taskId: task.id,
        taskFingerprint: fingerprint,
      },
      hostId: opts.hostId,
      actorId: task.agentId,
      parentEventId: event.id,
      durable: true,
    });

    // Idempotent: handleClaimEvent already persisted this row above.
    // Re-inserting is INSERT OR IGNORE; defensive in case the subscription
    // is ever decoupled from publish dispatch.
    persistIntent({
      claimId,
      teamId,
      eventId: event.id,
      eventHlc: event.hlc,
      claimingHostId: opts.hostId,
      claimingAgentId: task.agentId,
      taskId: task.id,
      taskFingerprint: fingerprint,
      claimHlc: claimEvent.hlc,
    });

    const key = arbKey(event.id, fingerprint);
    const timer = setTimeout(() => decideWindow(event.id, fingerprint), windowMs);
    pending.set(key, { task, event, ourClaimId: claimId, timer });
  }

  function handleClaimEvent(event: Event<TaskClaimPayload>): void {
    const p = event.payload;
    if (!p || typeof p !== "object") return;
    // claim_hlc is the task.claim event's own hlc — preserved across the
    // mesh by bus.inject's honest-event-identity contract. Local publish
    // round-trips through here too; INSERT OR IGNORE makes it a no-op.
    const claimHlc = event.hlc;
    persistIntent({
      claimId: p.claimId,
      teamId: p.teamId,
      eventId: p.eventId,
      eventHlc: p.eventHlc,
      claimingHostId: p.claimingHostId,
      claimingAgentId: p.claimingAgentId,
      taskId: p.taskId,
      taskFingerprint: p.taskFingerprint,
      claimHlc,
    });

    // Split-brain check: if our row for this (event, fingerprint) is
    // already `won` and this incoming tuple is strictly lower, the peer's
    // intent arrived too late. The task may already be running; we don't
    // abort (the plan: aborting mid-run is messier than the duplicate).
    const key = arbKey(p.eventId, p.taskFingerprint);
    if (!wonLocally.has(key)) return;

    const ourRow = opts.store
      .select()
      .from(tables.teamClaims)
      .where(
        and(
          eq(tables.teamClaims.eventId, p.eventId),
          eq(tables.teamClaims.taskFingerprint, p.taskFingerprint),
          eq(tables.teamClaims.claimingHostId, opts.hostId),
        ),
      )
      .all()[0];
    if (!ourRow) return;
    if (ourRow.claimId === p.claimId) return; // our own row replayed
    if (ourRow.status === "split_brain") return; // already flagged

    const incoming = {
      claimHlc,
      claimingHostId: p.claimingHostId,
      claimId: p.claimId,
    };
    if (compareTuple(incoming, ourRow) >= 0) return; // not lower

    opts.store
      .update(tables.teamClaims)
      .set({ status: "split_brain" })
      .where(eq(tables.teamClaims.claimId, ourRow.claimId))
      .run();
    opts.bus.publish({
      type: "mesh.claim-split-brain",
      payload: {
        teamId: p.teamId,
        eventId: p.eventId,
        taskFingerprint: p.taskFingerprint,
        localClaim: {
          claimId: ourRow.claimId,
          claimHlc: ourRow.claimHlc,
          claimingHostId: ourRow.claimingHostId,
        },
        lateClaim: {
          claimId: p.claimId,
          claimHlc,
          claimingHostId: p.claimingHostId,
        },
      },
      hostId: opts.hostId,
      actorId: ourRow.claimingAgentId,
      parentEventId: event.id,
      durable: true,
    });
  }

  function start(): void {
    if (unsub) return;
    unsub = opts.bus.subscribe<TaskClaimPayload>("task.claim", (ev) => handleClaimEvent(ev));
  }

  function stop(): void {
    if (unsub) {
      unsub();
      unsub = null;
    }
    for (const arb of pending.values()) clearTimeout(arb.timer);
    pending.clear();
  }

  return { registerIntent, start, stop };
}
