// Scheduler — v0, in-process.
//
// Tasks subscribe to event types (or a match predicate). When a matching
// event arrives, the scheduler runs an eligibility + concurrency check
// and, if the event is "claimable" (the mesh bit), emits a claim row so
// v1+ cross-host arbitration has the same codepath as local dispatch.
//
// For single-host v0 the claim race is trivial (we're the only eligible
// runner) — the seam is what matters.
//
// Durability: register() upserts a tasks row; each dispatch writes a
// task_runs row that transitions queued → running → succeeded|failed.
// On daemon restart, recoverLost() marks orphaned `running` rows as
// `lost` so operators see what was interrupted. After every handler the
// scheduler emits `task.<id>.completed` or `task.<id>.failed` so other
// subscribers can resume on the convention without coupling to internals.

import { and, eq } from "drizzle-orm";
import type { EventBus } from "../bus/index.ts";
import type { Event } from "../bus/types.ts";
import type { Store } from "../store/db.ts";
import { tables } from "../store/index.ts";
import { ulid } from "../id/index.ts";

export type Tier = "operational" | "strategic" | "vision";

export interface TaskContext {
  event: Event;
  bus: EventBus;
  store: Store;
  hostId: string;
  /** Emit a durable follow-on event parented to the triggering one. */
  emit<T>(type: string, payload: T, opts?: { durable?: boolean }): Event<T>;
}

export interface TaskDef {
  id: string;
  agentId: string;
  tier: Tier;
  eventType: string | "*";
  /** Optional finer filter; returning false means "not a match". */
  match?: (event: Event) => boolean;
  tokenEst?: number;
  /** Max parallel executions of this task. Defaults to 1. */
  concurrency?: number;
  handler(ctx: TaskContext): void | Promise<void>;
}

export interface SchedulerOptions {
  bus: EventBus;
  store: Store;
  hostId: string;
  onError?: (err: unknown, task: TaskDef, event: Event) => void;
}

export interface Scheduler {
  register(task: TaskDef): () => void;
  /** Snapshot of in-flight counts per task, for tests/observability. */
  inflight(): Record<string, number>;
  /** Mark any `running` task_runs from a prior process as `lost`.
   *  Returns the count marked. Call once at daemon startup. */
  recoverLost(nowMs?: number): number;
  close(): void;
}

interface Slot {
  task: TaskDef;
  unsubscribe: () => void;
  inflight: number;
  queue: Array<Event>;
}

export function createScheduler(opts: SchedulerOptions): Scheduler {
  const slots = new Map<string, Slot>();
  const onErr =
    opts.onError ??
    ((e, t, ev) => {
      // eslint-disable-next-line no-console -- scheduler is infra
      console.error(`[scheduler] ${t.id} on ${ev.type} threw:`, e);
    });

  // Persistence errors during dispatch (claims / task_runs) are logged
  // loudly but kept off the dispatch hot path — the bus.publish for the
  // done-event MUST still fire so subscribers waiting on resume don't
  // hang. register() is the strict surface: it throws on failed insert
  // so misconfigured callers (missing agent row, etc.) fail fast at
  // setup time instead of dropping audit rows in production.
  function logPersistError(where: string, task: TaskDef, err: unknown, event?: Event): void {
    const evPart = event ? ` event=${event.id} type=${event.type}` : "";
    // eslint-disable-next-line no-console -- scheduler is infra
    console.error(
      `[scheduler] ${where} failed for task=${task.id}${evPart}: ${(err as Error).message ?? err}`,
    );
  }

  // claims.event_id and task_runs.event_id reference events(id). Most
  // events that trigger a tracked task are durable and were already
  // persisted by the bus; non-durable triggers (chat deltas, ext
  // api.publish defaults, scheduler done-events) aren't. The scheduler
  // is the system that knows audit is now warranted, so it upserts the
  // triggering event row idempotently before recording. Cheaper than
  // forcing every publisher to think about audit.
  const ensureEventStmt = opts.store.raw.prepare(
    `INSERT OR IGNORE INTO events
       (id, hlc, host_id, actor_id, type, payload, parent_event_id, to_agent_id, thread_id, parent_thread_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  function ensureEventPersisted(event: Event): void {
    ensureEventStmt.run(
      event.id,
      event.hlc,
      event.hostId,
      event.actorId,
      event.type,
      JSON.stringify(event.payload ?? null),
      event.parentEventId ?? null,
      event.toAgentId ?? null,
      event.threadId ?? null,
      event.parentThreadId ?? null,
      event.createdAt,
    );
  }

  function persistTask(task: TaskDef): void {
    // Idempotent on (id) via onConflictDoNothing — both re-registration
    // and tests that share task ids land safely. Any other failure
    // (FK violation, schema drift) propagates so the caller knows the
    // registration is bad before any dispatch is attempted.
    opts.store
      .insert(tables.tasks)
      .values({
        id: task.id,
        agentId: task.agentId,
        triggerRefs: task.eventType === "*" ? [] : [task.eventType],
        handlerRef: `code:${task.id}`,
        tier: task.tier,
        scope: {},
        tokenEst: task.tokenEst ?? 0,
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
  }

  function recordClaim(task: TaskDef, event: Event, status: "winner" | "failed"): void {
    try {
      opts.store
        .insert(tables.claims)
        .values({
          eventId: event.id,
          taskId: task.id,
          agentId: task.agentId,
          claimedAt: Date.now(),
          status,
        })
        .run();
    } catch (err) {
      logPersistError("recordClaim", task, err, event);
    }
  }

  function startRun(task: TaskDef, event: Event): string | null {
    const id = ulid();
    try {
      opts.store
        .insert(tables.taskRuns)
        .values({
          id,
          taskId: task.id,
          eventId: event.id,
          hostId: opts.hostId,
          agentId: task.agentId,
          status: "running",
          startedAt: Date.now(),
        })
        .run();
      return id;
    } catch (err) {
      logPersistError("startRun", task, err, event);
      return null;
    }
  }

  function endRun(
    runId: string | null,
    task: TaskDef,
    event: Event,
    status: "succeeded" | "failed",
    error?: string,
  ): void {
    if (!runId) return;
    try {
      opts.store
        .update(tables.taskRuns)
        .set({ status, endedAt: Date.now(), error: error ?? null })
        .where(eq(tables.taskRuns.id, runId))
        .run();
    } catch (err) {
      logPersistError("endRun", task, err, event);
    }
  }

  async function execute(slot: Slot, event: Event): Promise<void> {
    const { task } = slot;
    const claimable = Boolean(
      (event.payload as Record<string, unknown>)?.claimable,
    );
    try {
      ensureEventPersisted(event);
    } catch (err) {
      logPersistError("ensureEventPersisted", task, err, event);
    }
    if (claimable) recordClaim(task, event, "winner");
    const runId = startRun(task, event);
    const ctx: TaskContext = {
      event,
      bus: opts.bus,
      store: opts.store,
      hostId: opts.hostId,
      emit(type, payload, emitOpts) {
        return opts.bus.publish({
          type,
          payload,
          hostId: opts.hostId,
          actorId: task.agentId,
          parentEventId: event.id,
          durable: emitOpts?.durable ?? false,
        });
      },
    };
    let err: unknown;
    try {
      await task.handler(ctx);
    } catch (caught) {
      err = caught;
      if (claimable) recordClaim(task, event, "failed");
      onErr(err, task, event);
    } finally {
      const errMsg = err instanceof Error ? err.message : err != null ? String(err) : undefined;
      endRun(runId, task, event, err ? "failed" : "succeeded", errMsg);
      // Done-event convention: subscribers can wait on these without
      // coupling to scheduler internals or the runs table.
      opts.bus.publish({
        type: err ? `task.${task.id}.failed` : `task.${task.id}.completed`,
        payload: {
          taskId: task.id,
          runId,
          eventId: event.id,
          error: errMsg,
        },
        hostId: opts.hostId,
        actorId: task.agentId,
        parentEventId: event.id,
        durable: false,
      });
      slot.inflight -= 1;
      drainQueue(slot);
    }
  }

  function drainQueue(slot: Slot): void {
    const limit = slot.task.concurrency ?? 1;
    while (slot.inflight < limit && slot.queue.length > 0) {
      const ev = slot.queue.shift()!;
      slot.inflight += 1;
      void execute(slot, ev);
    }
  }

  function dispatch(slot: Slot, event: Event): void {
    if (slot.task.match && !slot.task.match(event)) return;
    const limit = slot.task.concurrency ?? 1;
    if (slot.inflight >= limit) {
      slot.queue.push(event);
      return;
    }
    slot.inflight += 1;
    void execute(slot, event);
  }

  function register(task: TaskDef): () => void {
    if (slots.has(task.id)) throw new Error(`scheduler: task ${task.id} already registered`);
    persistTask(task);
    const slot: Slot = { task, unsubscribe: () => undefined, inflight: 0, queue: [] };
    slot.unsubscribe = opts.bus.subscribe(task.eventType, (ev) => dispatch(slot, ev));
    slots.set(task.id, slot);
    return () => {
      slot.unsubscribe();
      slots.delete(task.id);
    };
  }

  function inflight(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, slot] of slots) out[id] = slot.inflight;
    return out;
  }

  function recoverLost(nowMs: number = Date.now()): number {
    try {
      const stale = opts.store
        .select()
        .from(tables.taskRuns)
        .where(
          and(eq(tables.taskRuns.hostId, opts.hostId), eq(tables.taskRuns.status, "running")),
        )
        .all();
      if (stale.length === 0) return 0;
      opts.store
        .update(tables.taskRuns)
        .set({ status: "lost", endedAt: nowMs, error: "daemon restart" })
        .where(and(eq(tables.taskRuns.hostId, opts.hostId), eq(tables.taskRuns.status, "running")))
        .run();
      for (const r of stale) {
        opts.bus.publish({
          type: `task.${r.taskId}.failed`,
          payload: { taskId: r.taskId, runId: r.id, eventId: r.eventId, error: "lost" },
          hostId: opts.hostId,
          actorId: r.agentId,
          durable: true,
        });
      }
      return stale.length;
    } catch {
      return 0;
    }
  }

  function close(): void {
    for (const slot of slots.values()) slot.unsubscribe();
    slots.clear();
  }

  return { register, inflight, recoverLost, close };
}

// Helper: common claim envelope used by trigger emitters that want mesh
// semantics today. Non-claimable events flow direct dispatch.
export function claimableEvent<T>(payload: T): T & { claimable: true } {
  return { ...(payload as object), claimable: true } as T & { claimable: true };
}

// Re-export ulid so task factories don't pull it from a sibling module.
export { ulid };
