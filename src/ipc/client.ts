import { connect, type Socket } from "node:net";
import type { Response } from "./protocol.ts";
import type { Event } from "../bus/types.ts";

export interface IpcClient {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  stream(
    method: string,
    params?: Record<string, unknown>,
  ): { events: AsyncIterable<Event>; cancel(): Promise<void> };
  close(): void;
  /** Resolves when the underlying socket closes — peer disconnect or local close.
   *  Consumers can await this to drive reconnect logic. */
  closed: Promise<void>;
}

export async function connectIpc(socketPath: string): Promise<IpcClient> {
  const sock: Socket = await new Promise((resolve, reject) => {
    const s = connect(socketPath);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });

  let nextId = 1;
  const pending = new Map<number, (r: Response) => void>();
  const streams = new Map<
    number,
    { push: (ev: Event) => void; end: (err?: Error) => void }
  >();
  let buffer = "";

  sock.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: Response;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if ("stream" in msg) {
        const s = streams.get(msg.id);
        if (!s) continue;
        if (msg.stream === "data") s.push(msg.event);
        else if (msg.stream === "end") s.end();
        else if (msg.stream === "error") s.end(new Error(msg.error.message));
      } else {
        const resolver = pending.get(msg.id);
        if (resolver) {
          pending.delete(msg.id);
          resolver(msg);
        }
      }
    }
  });

  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  let didClose = false;
  const onClose = () => {
    if (didClose) return;
    didClose = true;
    for (const r of pending.values()) r({ id: 0, ok: false, error: { message: "ipc closed" } });
    for (const s of streams.values()) s.end(new Error("ipc closed"));
    pending.clear();
    streams.clear();
    resolveClosed();
  };
  sock.on("close", onClose);
  sock.on("error", onClose);

  function call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, (msg) => {
        if ("stream" in msg) return;
        if (msg.ok) resolve(msg.value as T);
        else reject(new Error(msg.error.message));
      });
      sock.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  function stream(method: string, params?: Record<string, unknown>) {
    const id = nextId++;
    const buf: Event[] = [];
    type Waiter = {
      resolve: (r: IteratorResult<Event>) => void;
      reject: (e: Error) => void;
    };
    let waiter: Waiter | null = null;
    let ended = false;
    let endErr: Error | undefined;

    streams.set(id, {
      push: (ev) => {
        if (waiter) {
          const w = waiter;
          waiter = null;
          w.resolve({ value: ev, done: false });
        } else {
          buf.push(ev);
        }
      },
      end: (err) => {
        ended = true;
        endErr = err;
        if (waiter) {
          const w = waiter;
          waiter = null;
          if (err) w.reject(err);
          else w.resolve({ value: undefined as unknown as Event, done: true });
        }
      },
    });

    sock.write(JSON.stringify({ id, method, params }) + "\n");

    const iterable: AsyncIterable<Event> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<Event>> {
            if (buf.length) return Promise.resolve({ value: buf.shift()!, done: false });
            if (ended) {
              if (endErr) return Promise.reject(endErr);
              return Promise.resolve({ value: undefined as unknown as Event, done: true });
            }
            return new Promise<IteratorResult<Event>>((resolve, reject) => {
              waiter = { resolve, reject };
            });
          },
          return(): Promise<IteratorResult<Event>> {
            void cancel();
            return Promise.resolve({ value: undefined as unknown as Event, done: true });
          },
        };
      },
    };

    const cancel = async (): Promise<void> => {
      if (ended) return;
      ended = true;
      streams.delete(id);
      try {
        await call<null>("tail.cancel", { targetId: id });
      } catch {
        /* already gone */
      }
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.resolve({ value: undefined as unknown as Event, done: true });
      }
    };

    return { events: iterable, cancel };
  }

  function close(): void {
    sock.end();
    sock.destroy();
  }

  return { call, stream, close, closed };
}
