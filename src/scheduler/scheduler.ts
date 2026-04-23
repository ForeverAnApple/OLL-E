// Scheduler — v0, in-process.
//
// Tasks subscribe to event types (or a match predicate). When a matching
// event arrives, the scheduler runs an eligibility + concurrency check
// and, if the event is "claimable" (the mesh bit), emits a claim row so
// v1+ cross-host arbitration has the same codepath as local dispatch.
//
// For single-host v0 the claim race is trivial (we're the only eligible
// runner) — the seam is what matters.

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

  async function execute(slot: Slot, event: Event): Promise<void> {
    const { task } = slot;
    const claimable = Boolean(
      (event.payload as Record<string, unknown>)?.claimable,
    );
    if (claimable) recordClaim(task, event, "winner");
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
    try {
      await task.handler(ctx);
    } catch (err) {
      if (claimable) recordClaim(task, event, "failed");
      onErr(err, task, event);
    } finally {
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

  function close(): void {
    for (const slot of slots.values()) slot.unsubscribe();
    slots.clear();
  }

  return { register, inflight, close };
}

// Helper: common claim envelope used by trigger emitters that want mesh
// semantics today. Non-claimable events flow direct dispatch.
export function claimableEvent<T>(payload: T): T & { claimable: true } {
  return { ...(payload as object), claimable: true } as T & { claimable: true };
}

// Re-export ulid so task factories don't pull it from a sibling module.
export { ulid };
