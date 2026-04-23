import { encodeStamp, createClock, ulid, type HlcClock } from "../id/index.ts";
import { ANY_EVENT, type Event, type EventHandler, type Unsubscribe } from "./types.ts";

export interface PublishInput<T = unknown> {
  type: string;
  payload: T;
  hostId: string;
  actorId: string;
  parentEventId?: string;
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

  function dispatch(event: Event): void {
    const targeted = handlers.get(event.type);
    const any = handlers.get(ANY_EVENT);
    const list: EventHandler[] = [];
    if (targeted) list.push(...targeted);
    if (any) list.push(...any);
    for (const h of list) {
      try {
        const r = h(event);
        if (r && typeof (r as Promise<void>).catch === "function") {
          (r as Promise<void>).catch((err) => onErr(err, event));
        }
      } catch (err) {
        onErr(err, event);
      }
    }
  }

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
      createdAt: stamp.l,
      durable: input.durable ?? false,
    };
    if (event.durable && opts.persist) opts.persist(event);
    dispatch(event);
    return event;
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
    subscribe,
    stream,
    close() {
      closed = true;
      handlers.clear();
    },
  };
}
