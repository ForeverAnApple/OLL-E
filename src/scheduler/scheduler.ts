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

  function persistTask(task: TaskDef): void {
    // Idempotent: skip if a row with this id already exists. Tests share
    // task ids across rigs; production wires unique ulids.
    try {
      const existing = opts.store
        .select()
        .from(tables.tasks)
        .where(eq(tables.tasks.id, task.id))
        .all();
      if (existing.length > 0) return;
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
        .run();
    } catch {
      /* FK miss in test scaffolding — ignore */
    }
  }

  function recordClaim(task: TaskDef, event: Event, status: "winner" | "failed"): void {
    // Claims require both the event and the task to exist in the store.
    // In v0 many event/task rows are stub-only; guard rather than crash.
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
    } catch {
      /* FK miss in test scaffolding — ignore */
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
    } catch {
      // FK miss in tests where agent/task/event rows aren't seeded.
      return null;
    }
  }

  function endRun(runId: string | null, status: "succeeded" | "failed", error?: string): void {
    if (!runId) return;
    try {
      opts.store
        .update(tables.taskRuns)
        .set({ status, endedAt: Date.now(), error: error ?? null })
        .where(eq(tables.taskRuns.id, runId))
        .run();
    } catch {
      /* row vanished — ignore */
    }
  }

  async function execute(slot: Slot, event: Event): Promise<void> {
    const { task } = slot;
    const claimable = Boolean(
      (event.payload as Record<string, unknown>)?.claimable,
    );
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
      endRun(runId, err ? "failed" : "succeeded", errMsg);
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
      for (const r of stale) {
        opts.store
          .update(tables.taskRuns)
          .set({ status: "lost", endedAt: nowMs, error: "daemon restart" })
          .where(eq(tables.taskRuns.id, r.id))
          .run();
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
