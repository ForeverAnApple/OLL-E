export interface Event<T = unknown> {
  /** ULID */
  readonly id: string;
  /** Encoded HLC stamp. */
  readonly hlc: string;
  readonly hostId: string;
  readonly actorId: string;
  readonly type: string;
  readonly payload: T;
  readonly parentEventId?: string;
  /** Mailbox routing. When set, identifies the agent whose mailbox this
   *  event belongs in. Unset = broadcast / untargeted (back-compat). */
  readonly toAgentId?: string;
  /** Correlation id. Threads span a conversation, a spawned work stream,
   *  an approval chain — transport-agnostic. Unset = standalone ping. */
  readonly threadId?: string;
  /** If this event opens a thread that descends from another thread
   *  (e.g. child agent working on parent's task), names that parent
   *  thread. Only meaningful on thread-opening events. */
  readonly parentThreadId?: string;
  /** Wall-clock ms, for display — HLC is the authority for ordering. */
  readonly createdAt: number;
  /** Persisted to store.events iff true. */
  readonly durable: boolean;
}

/** Per-dispatch context. `remote = true` means this event arrived from a
 *  peer over the mesh and was replayed locally via `bus.inject` — the
 *  in-memory flag never lands on `event.payload`, so the persisted row
 *  matches what the original publisher emitted. Bridges and re-broadcast
 *  guards use this to avoid looping the mesh; pure projectors ignore it. */
export interface DeliveryContext {
  readonly remote: boolean;
}

export type EventHandler<T = unknown> = (
  event: Event<T>,
  ctx: DeliveryContext,
) => void | Promise<void>;
export type Unsubscribe = () => void;

/** Wildcard matches every event. Type strings may use dots; we match on prefix via ":" paths deliberately not — v0 stays literal. */
export const ANY_EVENT = "*" as const;
