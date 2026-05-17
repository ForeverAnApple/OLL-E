import { describe, expect, it } from "bun:test";
import { ANY_EVENT, createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { createClock, encodeStamp, ulid } from "../src/id/index.ts";

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

  it("inject persists with original identity + dispatches with remote ctx", () => {
    const db = openStore({ path: ":memory:" });
    const hostId = ulid();
    seedHost(db, hostId);
    const bus = createBus({ hostId, persist: persistToStore(db) });

    const seen: Array<{ id: string; hostId: string; remote: boolean }> = [];
    bus.subscribe("memory.wrote", (e, ctx) => {
      seen.push({ id: e.id, hostId: e.hostId, remote: ctx.remote });
    });

    const remoteId = ulid();
    const remoteHost = ulid();
    const remoteEvent = {
      id: remoteId,
      hlc: "01HABCDEF0000000-0000",
      hostId: remoteHost,
      actorId: "peer-actor",
      type: "memory.wrote",
      payload: { x: 1 },
      createdAt: Date.now(),
      durable: true,
    } as const;

    const r1 = bus.inject(remoteEvent, { remote: true });
    expect(r1.dispatched).toBe(true);
    expect(seen).toEqual([{ id: remoteId, hostId: remoteHost, remote: true }]);

    // Row persisted with the original hostId, not the local bus's.
    const row = db.raw
      .query<{ id: string; host_id: string; actor_id: string }, []>(
        "SELECT id, host_id, actor_id FROM events",
      )
      .all();
    expect(row).toHaveLength(1);
    expect(row[0]).toEqual({ id: remoteId, host_id: remoteHost, actor_id: "peer-actor" });
    // Hosts stub created for the unknown remote host_id.
    const hosts = db.raw
      .query<{ id: string; hostname: string }, []>("SELECT id, hostname FROM hosts ORDER BY id")
      .all();
    expect(hosts.some((h) => h.id === remoteHost)).toBe(true);

    // Second inject of the same event is a no-op (in-memory dedup).
    const r2 = bus.inject(remoteEvent, { remote: true });
    expect(r2.dispatched).toBe(false);
    expect(seen.length).toBe(1);
  });

  it("inject merges remote HLC before local follow-up publishes", () => {
    let now = 1_000;
    const clock = createClock(() => now);
    const bus = createBus({ hostId: "local", clock });
    const remoteHlc = encodeStamp({ l: 5_000, c: 3 });

    bus.inject(
      {
        id: ulid(),
        hlc: remoteHlc,
        hostId: "remote",
        actorId: "peer",
        type: "peer.observed",
        payload: {},
        createdAt: 5_000,
        durable: true,
      },
      { remote: true },
    );

    now = 1_001;
    const local = bus.publish({
      type: "local.follow-up",
      payload: {},
      hostId: "local",
      actorId: "agent",
    });
    expect(local.hlc > remoteHlc).toBe(true);
  });

  it("inject after close throws", () => {
    const bus = createBus({ hostId: "h" });
    bus.close();
    const ev = {
      id: ulid(),
      hlc: "01HABCDEF0000000-0000",
      hostId: "remote",
      actorId: "a",
      type: "x",
      payload: {},
      createdAt: Date.now(),
      durable: true,
    } as const;
    expect(() => bus.inject(ev, { remote: true })).toThrow();
  });
});
