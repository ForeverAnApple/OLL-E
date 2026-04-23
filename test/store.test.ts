import { describe, expect, it } from "bun:test";
import { openStore, tables } from "../src/store/index.ts";
import { createClock, encodeStamp, ulid } from "../src/id/index.ts";

function fresh() {
  return openStore({ path: ":memory:" });
}

describe("store migrations", () => {
  it("creates every v0 table", () => {
    const db = fresh();
    const rows = db.raw
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    const names = rows.map((r) => r.name);
    for (const expected of [
      "agents",
      "approvals",
      "budgets",
      "claims",
      "decisions",
      "events",
      "extensions",
      "hosts",
      "ledger",
      "memories",
      "memory_reads",
      "principals",
      "tasks",
      "team_members",
      "teams",
      "tool_calls",
      "tools",
      "triggers",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("runs each migration exactly once", () => {
    const db = fresh();
    const count = db.raw.query<{ n: number }, []>("SELECT COUNT(*) as n FROM _migrations").get();
    expect(count?.n).toBe(1);
  });
});

describe("store inserts", () => {
  it("writes a host, an agent, and an event with full provenance", async () => {
    const db = fresh();
    const clock = createClock();
    const now = Date.now();
    const hostId = ulid(now);
    const agentId = ulid(now);

    await db.insert(tables.hosts).values({
      id: hostId,
      hostname: "test-host",
      createdAt: now,
    });
    await db.insert(tables.agents).values({
      id: agentId,
      name: "alice",
      hostId,
      scope: {},
      createdAt: now,
    });

    const eventId = ulid(now);
    await db.insert(tables.events).values({
      id: eventId,
      hlc: encodeStamp(clock.now()),
      hostId,
      actorId: agentId,
      type: "chat.message",
      payload: { text: "hello" },
      createdAt: now,
    });

    const evs = await db.select().from(tables.events);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.type).toBe("chat.message");
    expect((evs[0]!.payload as { text: string }).text).toBe("hello");
    expect(evs[0]!.hlc).toMatch(/^[0-9a-f]{12}-[0-9a-f]{4}$/);
  });

  it("enforces foreign keys", async () => {
    const db = fresh();
    expect(() =>
      db
        .insert(tables.agents)
        .values({
          id: ulid(),
          name: "orphan",
          hostId: "no-such-host",
          scope: {},
          createdAt: Date.now(),
        })
        .run(),
    ).toThrow();
  });
});
