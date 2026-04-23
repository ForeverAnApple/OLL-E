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
  /** Wall-clock ms, for display — HLC is the authority for ordering. */
  readonly createdAt: number;
  /** Persisted to store.events iff true. */
  readonly durable: boolean;
}

export type EventHandler<T = unknown> = (event: Event<T>) => void | Promise<void>;
export type Unsubscribe = () => void;

/** Wildcard matches every event. Type strings may use dots; we match on prefix via ":" paths deliberately not — v0 stays literal. */
export const ANY_EVENT = "*" as const;
