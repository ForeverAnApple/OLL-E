import { describe, expect, it } from "bun:test";
import { createChannel, type RequestHandler, type Transport } from "../src/vm/channel.ts";

// In-memory duplex pair: each side's write feeds the other's onData. Delivery
// is deferred to a microtask so a handler that replies inside onData doesn't
// re-enter the writer synchronously; awaiting any call/stream flushes it.
// Closing either side closes both, mimicking a real socket pair disconnect.
function makePipe(): { a: Transport; b: Transport } {
  const mkEnd = () => ({
    dataCbs: [] as Array<(c: string | Buffer) => void>,
    closeCbs: [] as Array<() => void>,
    closed: false,
  });
  const A = mkEnd();
  const B = mkEnd();

  const deliver = (dst: typeof A, data: string) => {
    queueMicrotask(() => {
      if (dst.closed) return;
      for (const cb of dst.dataCbs) cb(data);
    });
  };
  const closeBoth = () => {
    for (const end of [A, B]) {
      if (end.closed) continue;
      end.closed = true;
      for (const cb of end.closeCbs) cb();
    }
  };
  const mk = (self: typeof A, peer: typeof A): Transport => ({
    write: (data) => {
      if (!self.closed) deliver(peer, String(data));
    },
    onData: (cb) => void self.dataCbs.push(cb),
    onClose: (cb) => void self.closeCbs.push(cb),
    close: closeBoth,
  });
  return { a: mk(A, B), b: mk(B, A) };
}

// A handler that answers by method. `label` proves which end replied.
function handler(label: string): RequestHandler {
  return async (method, params, ctx) => {
    if (method === "echo") return { from: label, echo: params?.text };
    if (method === "boom") throw new Error("handler exploded");
    if (method === "count") {
      const s = ctx.stream();
      const n = (params?.n as number) ?? 0;
      for (let i = 0; i < n; i++) s.push({ i });
      s.end();
      return;
    }
    if (method === "hang") return new Promise<never>(() => {}); // never resolves
    if (method === "drip") {
      const s = ctx.stream();
      s.push({ first: true });
      await new Promise<never>(() => {}); // stream stays open
      return;
    }
    throw new Error(`unknown method: ${method}`);
  };
}

describe("vm channel", () => {
  it("routes one-shot requests in both directions with independent id spaces", async () => {
    const { a, b } = makePipe();
    const chA = createChannel(a, { onRequest: handler("A") });
    const chB = createChannel(b, { onRequest: handler("B") });

    // Both fire concurrently — each uses its own id=1, no collision.
    const [fromB, fromA] = await Promise.all([
      chA.call<{ from: string; echo: string }>("echo", { text: "x" }),
      chB.call<{ from: string; echo: string }>("echo", { text: "y" }),
    ]);
    expect(fromB).toEqual({ from: "B", echo: "x" });
    expect(fromA).toEqual({ from: "A", echo: "y" });
  });

  it("rejects the caller when the handler throws", async () => {
    const { a, b } = makePipe();
    const chA = createChannel(a, { onRequest: handler("A") });
    createChannel(b, { onRequest: handler("B") });
    await expect(chA.call("boom")).rejects.toThrow(/handler exploded/);
  });

  it("streams N data frames then completes", async () => {
    const { a, b } = makePipe();
    const chA = createChannel(a, { onRequest: handler("A") });
    createChannel(b, { onRequest: handler("B") });

    const { events } = chA.stream("count", { n: 3 });
    const got: unknown[] = [];
    for await (const ev of events) got.push(ev);
    expect(got).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
  });

  it("rejects when the peer has no request handler", async () => {
    const { a, b } = makePipe();
    const chA = createChannel(a, { onRequest: handler("A") });
    createChannel(b); // no onRequest
    await expect(chA.call("echo", { text: "x" })).rejects.toThrow(/no handler/);
  });

  it("rejects an unknown method the handler doesn't know", async () => {
    const { a, b } = makePipe();
    createChannel(a, { onRequest: handler("A") });
    const chB = createChannel(b, { onRequest: handler("B") });
    await expect(chB.call("nope")).rejects.toThrow(/unknown method/);
  });

  it("rejects a pending call and ends an active stream on transport close", async () => {
    const { a, b } = makePipe();
    const chA = createChannel(a, { onRequest: handler("A") });
    const chB = createChannel(b, { onRequest: handler("B") });

    const pendingCall = chA.call("hang"); // B never answers
    const { events } = chA.stream("drip");
    const it = events[Symbol.asyncIterator]();
    const first = await it.next(); // one frame arrives before close
    expect(first.value).toEqual({ first: true });

    chB.close(); // peer drops → both transports close

    await expect(pendingCall).rejects.toThrow(/channel closed/);
    await expect(it.next()).rejects.toThrow(/channel closed/);
    await chA.closed; // resolves, no hang
  });
});
