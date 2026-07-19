// A bidirectional line-JSON RPC peer over an arbitrary duplex byte stream.
//
// This is the seam a host↔guest microVM connection (vsock / UDS) will use.
// Unlike the IPC client/server pair — where the client owns the id space and
// only ever sends requests — BOTH ends of a Channel can originate calls and
// handle inbound ones. The two directions use independent id spaces: a frame
// carrying a `method` is an inbound REQUEST to dispatch; a frame carrying
// `ok`/`stream` is a RESPONSE to one of our own pending calls. `isRequest()`
// disambiguates, so both peers can have an in-flight id=1 at once without
// collision — a response always echoes the requester's id back on the wire.
//
// Framing is the shared line-JSON codec; the request/response shapes reuse
// protocol.ts, widening only the stream-data payload from Event to unknown.

import { encodeLine, LineDecoder } from "../ipc/codec.ts";
import { isRequest, type Request } from "../ipc/protocol.ts";
import type { Socket } from "node:net";

/** Minimal duplex byte transport. Kept abstract so a Channel is testable over
 *  an in-memory pipe and reusable over a real socket. */
export interface Transport {
  write(data: string): void;
  onData(cb: (chunk: string | Buffer) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

type WireError = { message: string; code?: string };

/** Response frames — protocol.ts's Response with the stream payload widened
 *  to `unknown` (IPC pins it to Event; a generic channel streams anything). */
type ResponseFrame =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: WireError }
  | { id: number; stream: "data"; item: unknown }
  | { id: number; stream: "end" }
  | { id: number; stream: "error"; error: WireError };

/** Emitter handed to a streaming request handler. */
export interface StreamController {
  push(item: unknown): void;
  end(): void;
  error(err: Error): void;
}

export interface RequestCtx {
  /** Aborts when the caller cancels the stream or the transport closes. */
  signal: AbortSignal;
  /** Switch this response into streaming mode and get the emitter. Once
   *  called, the handler's resolved value is ignored — the stream ends when
   *  the handler calls `end()`/`error()`, or (as a convenience) when the
   *  handler's promise resolves without having ended it. */
  stream(): StreamController;
}

export type RequestHandler = (
  method: string,
  params: Record<string, unknown> | undefined,
  ctx: RequestCtx,
) => Promise<unknown>;

export interface Channel {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  stream(
    method: string,
    params?: Record<string, unknown>,
  ): { events: AsyncIterable<unknown>; cancel(): Promise<void> };
  close(): void;
  /** Resolves when the transport closes — peer disconnect or local close. */
  closed: Promise<void>;
}

/** Reserved control method: cancel a stream the peer is producing for us. */
const CANCEL_METHOD = "$cancel";

export function createChannel(
  transport: Transport,
  opts: { onRequest?: RequestHandler } = {},
): Channel {
  let nextId = 1;
  const pending = new Map<number, (f: ResponseFrame) => void>();
  const streams = new Map<
    number,
    { push: (item: unknown) => void; end: (err?: Error) => void }
  >();
  // Inbound streaming requests we're producing, keyed by the requester's id
  // (their id space) so a $cancel can abort the right one.
  const producing = new Map<number, AbortController>();
  const decoder = new LineDecoder();

  let isClosed = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));

  const send = (frame: unknown): void => {
    if (isClosed) return;
    transport.write(encodeLine(frame));
  };

  transport.onData((chunk) => {
    for (const frame of decoder.push(chunk)) handleFrame(frame);
  });

  function handleFrame(frame: unknown): void {
    if (isRequest(frame)) {
      handleInbound(frame);
      return;
    }
    const f = frame as ResponseFrame;
    if (!f || typeof f.id !== "number") return;
    if ("stream" in f) {
      const s = streams.get(f.id);
      if (!s) return;
      if (f.stream === "data") s.push(f.item);
      else if (f.stream === "end") {
        streams.delete(f.id);
        s.end();
      } else if (f.stream === "error") {
        streams.delete(f.id);
        s.end(new Error(f.error.message));
      }
    } else {
      const resolver = pending.get(f.id);
      if (resolver) {
        pending.delete(f.id);
        resolver(f);
      }
    }
  }

  function handleInbound(req: Request): void {
    if (req.method === CANCEL_METHOD) {
      const target = (req.params?.targetId as number | undefined) ?? -1;
      producing.get(target)?.abort();
      producing.delete(target);
      send({ id: req.id, ok: true, value: null });
      return;
    }
    const handler = opts.onRequest;
    if (!handler) {
      send({ id: req.id, ok: false, error: { message: `no handler for method: ${req.method}` } });
      return;
    }
    const abort = new AbortController();
    let streaming = false;
    let streamEnded = false;
    const controller: StreamController = {
      push: (item) => {
        if (!streamEnded) send({ id: req.id, stream: "data", item });
      },
      end: () => {
        if (streamEnded) return;
        streamEnded = true;
        producing.delete(req.id);
        send({ id: req.id, stream: "end" });
      },
      error: (err) => {
        if (streamEnded) return;
        streamEnded = true;
        producing.delete(req.id);
        send({ id: req.id, stream: "error", error: { message: err.message } });
      },
    };
    const ctx: RequestCtx = {
      signal: abort.signal,
      stream: () => {
        streaming = true;
        producing.set(req.id, abort);
        return controller;
      },
    };
    Promise.resolve()
      .then(() => handler(req.method, req.params, ctx))
      .then((value) => {
        if (streaming) {
          if (!streamEnded) controller.end();
        } else {
          send({ id: req.id, ok: true, value });
        }
      })
      .catch((err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        if (streaming) controller.error(e);
        else send({ id: req.id, ok: false, error: { message: e.message } });
      });
  }

  function call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      if (isClosed) {
        reject(new Error("channel closed"));
        return;
      }
      pending.set(id, (f) => {
        if ("stream" in f) return; // a call never expects stream frames
        if (f.ok) resolve(f.value as T);
        else reject(new Error(f.error.message));
      });
      send({ id, method, params });
    });
  }

  function stream(method: string, params?: Record<string, unknown>) {
    const id = nextId++;
    const buf: unknown[] = [];
    type Waiter = {
      resolve: (r: IteratorResult<unknown>) => void;
      reject: (e: Error) => void;
    };
    let waiter: Waiter | null = null;
    let ended = false;
    let endErr: Error | undefined;

    streams.set(id, {
      push: (item) => {
        if (waiter) {
          const w = waiter;
          waiter = null;
          w.resolve({ value: item, done: false });
        } else {
          buf.push(item);
        }
      },
      end: (err) => {
        ended = true;
        endErr = err;
        if (waiter) {
          const w = waiter;
          waiter = null;
          if (err) w.reject(err);
          else w.resolve({ value: undefined, done: true });
        }
      },
    });

    if (isClosed) streams.get(id)!.end(new Error("channel closed"));
    else send({ id, method, params });

    const iterable: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<unknown>> {
            if (buf.length) return Promise.resolve({ value: buf.shift(), done: false });
            if (ended) {
              if (endErr) return Promise.reject(endErr);
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise<IteratorResult<unknown>>((resolve, reject) => {
              waiter = { resolve, reject };
            });
          },
          return(): Promise<IteratorResult<unknown>> {
            void cancel();
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };

    const cancel = async (): Promise<void> => {
      if (ended) return;
      ended = true;
      streams.delete(id);
      try {
        await call<null>(CANCEL_METHOD, { targetId: id });
      } catch {
        /* peer already gone */
      }
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.resolve({ value: undefined, done: true });
      }
    };

    return { events: iterable, cancel };
  }

  const onClose = (): void => {
    if (isClosed) return;
    isClosed = true;
    for (const resolve of pending.values())
      resolve({ id: 0, ok: false, error: { message: "channel closed" } });
    for (const s of streams.values()) s.end(new Error("channel closed"));
    for (const ctrl of producing.values()) ctrl.abort();
    pending.clear();
    streams.clear();
    producing.clear();
    resolveClosed();
  };
  transport.onClose(onClose);

  function close(): void {
    transport.close();
    onClose();
  }

  return { call, stream, close, closed };
}

/** Adapt a node:net Socket to a Transport. Not exercised by the channel tests
 *  (they drive an in-memory pipe) but ready for the real host↔guest link. */
export function socketTransport(sock: Socket): Transport {
  return {
    write: (data) => {
      if (!sock.destroyed) sock.write(data);
    },
    onData: (cb) => {
      sock.on("data", cb);
    },
    onClose: (cb) => {
      sock.on("close", cb);
      sock.on("error", cb);
    },
    close: () => {
      sock.end();
      sock.destroy();
    },
  };
}
