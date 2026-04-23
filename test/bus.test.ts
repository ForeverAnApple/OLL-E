import { describe, expect, it } from "bun:test";
import { ANY_EVENT, createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";

function seedHost(db: ReturnType<typeof openStore>, hostId: string) {
  db.insert(tables.hosts)
    .values({ id: hostId, hostname: "test", createdAt: Date.now() })
    .run();
}

describe("event bus", () => {
  it("dispatches synchronously to type subscribers", () => {
    const bus = createBus({ hostId: "h" });
    const seen: string[] = [];
    bus.subscribe("chat.msg", (e) => void seen.push(e.type));
    bus.publish({ type: "chat.msg", payload: {}, hostId: "h", actorId: "a" });
    bus.publish({ type: "other", payload: {}, hostId: "h", actorId: "a" });
    expect(seen).toEqual(["chat.msg"]);
  });

  it("wildcard subscribers see every event exactly once", () => {
    const bus = createBus({ hostId: "h" });
    let n = 0;
    bus.subscribe(ANY_EVENT, () => {
      n++;
    });
    bus.publish({ type: "a", payload: {}, hostId: "h", actorId: "x" });
    bus.publish({ type: "b", payload: {}, hostId: "h", actorId: "x" });
    expect(n).toBe(2);
  });

  it("unsubscribe stops delivery", () => {
    const bus = createBus({ hostId: "h" });
    let n = 0;
    const un = bus.subscribe("x", () => {
      n++;
    });
    bus.publish({ type: "x", payload: {}, hostId: "h", actorId: "a" });
    un();
    bus.publish({ type: "x", payload: {}, hostId: "h", actorId: "a" });
    expect(n).toBe(1);
  });

  it("isolates handler errors", () => {
    const errs: unknown[] = [];
    const bus = createBus({
      hostId: "h",
      onHandlerError: (e) => errs.push(e),
    });
    bus.subscribe("x", () => {
      throw new Error("boom");
    });
    let ok = false;
    bus.subscribe("x", () => {
      ok = true;
    });
    bus.publish({ type: "x", payload: {}, hostId: "h", actorId: "a" });
    expect(errs).toHaveLength(1);
    expect(ok).toBe(true);
  });

  it("stream yields events and terminates on abort", async () => {
    const bus = createBus({ hostId: "h" });
    const ctrl = new AbortController();
    const collected: string[] = [];
    const task = (async () => {
      for await (const ev of bus.stream("x", { signal: ctrl.signal })) {
        collected.push(ev.type);
        if (collected.length === 2) ctrl.abort();
      }
    })();
    bus.publish({ type: "x", payload: {}, hostId: "h", actorId: "a" });
    bus.publish({ type: "x", payload: {}, hostId: "h", actorId: "a" });
    await task;
    expect(collected).toEqual(["x", "x"]);
  });

  it("durable events land in the events table", () => {
    const db = openStore({ path: ":memory:" });
    const hostId = ulid();
    seedHost(db, hostId);
    const bus = createBus({ hostId, persist: persistToStore(db) });

    bus.publish({ type: "x", payload: { v: 1 }, hostId, actorId: "actor", durable: true });
    bus.publish({ type: "x", payload: { v: 2 }, hostId, actorId: "actor" }); // not durable

    const rows = db.raw
      .query<{ type: string; payload: string }, []>(
        "SELECT type, payload FROM events ORDER BY hlc",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload)).toEqual({ v: 1 });
  });

  it("publish after close throws", () => {
    const bus = createBus({ hostId: "h" });
    bus.close();
    expect(() =>
      bus.publish({ type: "x", payload: {}, hostId: "h", actorId: "a" }),
    ).toThrow();
  });
});
