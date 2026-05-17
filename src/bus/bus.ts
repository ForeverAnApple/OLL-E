import {
  decodeStamp,
  encodeStamp,
  createClock,
  ulid,
  type HlcClock,
} from "../id/index.ts";
import {
  ANY_EVENT,
  type DeliveryContext,
  type Event,
  type EventHandler,
  type Unsubscribe,
} from "./types.ts";

export interface PublishInput<T = unknown> {
  type: string;
  payload: T;
  hostId: string;
  actorId: string;
  parentEventId?: string;
  /** Address this event to a specific agent's mailbox. */
  toAgentId?: string;
  /** Correlation id for the conversation/work-stream this belongs to. */
  threadId?: string;
  /** If this event opens a new thread descending from another, reference
   *  the parent thread so observers can correlate. */
  parentThreadId?: string;
  durable?: boolean;
}

export interface BusOptions {
  hostId: string;
  clock?: HlcClock;
  /** Invoked for every durable event before handlers run. Synchronous so the
   *  persisted row is committed before any subscriber can see it. */
  persist?: (event: Event) => void;
  /** Surfaces handler errors; default logs to stderr. */
  onHandlerError?: (err: unknown, event: Event) => void;
}

export interface EventBus {
  readonly hostId: string;
  publish<T>(input: PublishInput<T>): Event<T>;
  /** Replay a remote-originated event locally with its original identity
   *  (id, hlc, hostId, actorId, payload — everything) intact. Persists
   *  through `opts.persist` (idempotent on event id) and dispatches with
   *  `{ remote: true }` so bridges suppress re-broadcast. In-memory dedup
   *  on event.id means redelivery is a no-op. */
  inject(event: Event, opts: { remote: true }): { dispatched: boolean };
  subscribe<T = unknown>(type: string, handler: EventHandler<T>): Unsubscribe;
  stream<T = unknown>(type?: string, opts?: { signal?: AbortSignal }): AsyncIterable<Event<T>>;
  close(): void;
}

export function createBus(opts: BusOptions): EventBus {
  const clock = opts.clock ?? createClock();
  const handlers = new Map<string, Set<EventHandler>>();
  let closed = false;

  const onErr =
    opts.onHandlerError ??
    ((err, ev) => {
      // eslint-disable-next-line no-console -- bus is infra, no log router yet
      console.error(`[bus] handler for ${ev.type} threw:`, err);
    });

  function subscribe<T>(type: string, handler: EventHandler<T>): Unsubscribe {
    if (closed) throw new Error("bus: subscribe after close");
    let set = handlers.get(type);
    if (!set) {
      set = new Set();
      handlers.set(type, set);
    }
    set.add(handler as EventHandler);
    return () => {
      const s = handlers.get(type);
      if (!s) return;
      s.delete(handler as EventHandler);
      if (s.size === 0) handlers.delete(type);
    };
  }

  // Dispatched-id memo: prevents inject() redelivery from re-firing
  // handlers. Local publish() also writes here so a peer-side mirror that
  // bridges our own event back doesn't double-fire either.
  //
  // Bounded FIFO: a long-running daemon emits events forever; an unbounded
  // set leaks proportional to total event volume. The cap covers realistic
  // in-flight catchup overlap (default chunk = 200) plus live churn. Beyond
  // the cap we fall back to the persist callback's INSERT OR IGNORE for
  // durability dedup — a rare double-dispatch of a long-stale event is
  // cheaper than the leak. Map keeps insertion order so eviction is O(1).
  const MAX_DISPATCHED_MEMO = 10_000;
  const dispatched = new Map<string, true>();
  function markDispatched(id: string): void {
    dispatched.set(id, true);
    if (dispatched.size > MAX_DISPATCHED_MEMO) {
      const oldest = dispatched.keys().next().value as string | undefined;
      if (oldest !== undefined) dispatched.delete(oldest);
    }
  }

  function dispatch(event: Event, ctx: DeliveryContext): void {
    const targeted = handlers.get(event.type);
    const any = handlers.get(ANY_EVENT);
    const list: EventHandler[] = [];
    if (targeted) list.push(...targeted);
    if (any) list.push(...any);
    for (const h of list) {
      try {
        const r = h(event, ctx);
        if (r && typeof (r as Promise<void>).catch === "function") {
          (r as Promise<void>).catch((err) => onErr(err, event));
        }
      } catch (err) {
        onErr(err, event);
      }
    }
  }

  const LOCAL_CTX: DeliveryContext = { remote: false };
  const REMOTE_CTX: DeliveryContext = { remote: true };

  function publish<T>(input: PublishInput<T>): Event<T> {
    if (closed) throw new Error("bus: publish after close");
    const stamp = clock.now();
    const event: Event<T> = {
      id: ulid(stamp.l),
      hlc: encodeStamp(stamp),
      hostId: input.hostId,
      actorId: input.actorId,
      type: input.type,
      payload: input.payload,
      parentEventId: input.parentEventId,
      toAgentId: input.toAgentId,
      threadId: input.threadId,
      parentThreadId: input.parentThreadId,
      createdAt: stamp.l,
      durable: input.durable ?? false,
    };
    if (event.durable && opts.persist) opts.persist(event);
    markDispatched(event.id);
    dispatch(event, LOCAL_CTX);
    return event;
  }

  function inject(event: Event, _opts: { remote: true }): { dispatched: boolean } {
    if (closed) throw new Error("bus: inject after close");
    // Persist before in-memory dedup check — the persist call is idempotent
    // (INSERT OR IGNORE) so re-injection is a no-op at the SQL layer, and
    // catchup replay across a daemon restart still lands the row even when
    // the in-memory set was reset.
    if (opts.persist) opts.persist(event);
    if (dispatched.has(event.id)) return { dispatched: false };
    try {
      clock.recv(decodeStamp(event.hlc));
    } catch {
      // Keep accepting legacy/test fixtures with non-HLC stamps. Real mesh
      // events carry encodeStamp() output, which advances the local clock
      // before any subscriber can publish a causal follow-up.
    }
    markDispatched(event.id);
    dispatch(event, REMOTE_CTX);
    return { dispatched: true };
  }

  function stream<T>(type: string = ANY_EVENT, opts?: { signal?: AbortSignal }): AsyncIterable<Event<T>> {
    const buffer: Event<T>[] = [];
    let resolveNext: ((v: IteratorResult<Event<T>>) => void) | null = null;
    let done = false;

    const push = (ev: Event<T>) => {
      if (done) return;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: ev, done: false });
      } else {
        buffer.push(ev);
      }
    };
    const unsub = subscribe<T>(type, push);
    const abort = () => {
      if (done) return;
      done = true;
      unsub();
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined, done: true });
      }
    };
    opts?.signal?.addEventListener("abort", abort, { once: true });

    return {
      [Symbol.asyncIterator](): AsyncIterator<Event<T>> {
        return {
          next(): Promise<IteratorResult<Event<T>>> {
            if (done) return Promise.resolve({ value: undefined, done: true });
            const queued = buffer.shift();
            if (queued) return Promise.resolve({ value: queued, done: false });
            return new Promise<IteratorResult<Event<T>>>((resolve) => {
              resolveNext = resolve;
            });
          },
          return(): Promise<IteratorResult<Event<T>>> {
            abort();
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }

  return {
    hostId: opts.hostId,
    publish,
    inject,
    subscribe,
    stream,
    close() {
      closed = true;
      handlers.clear();
    },
  };
}
