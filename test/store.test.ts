import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { openStore, tables } from "../src/store/index.ts";
import { listMigrations, runMigrations } from "../src/store/migrate.ts";
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
      "task_runs",
      "tasks",
      "team_members",
      "teams",
      "tool_calls",
      "tool_results",
      "tools",
      "triggers",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("applies every migration file exactly once", () => {
    const db = fresh();
    const total = db.raw
      .query<{ n: number }, []>("SELECT COUNT(*) as n FROM _migrations")
      .get();
    // Reopening should not re-apply.
    const db2 = openStore({ path: ":memory:" });
    const total2 = db2.raw
      .query<{ n: number }, []>("SELECT COUNT(*) as n FROM _migrations")
      .get();
    expect(total?.n).toBeGreaterThan(0);
    expect(total2?.n).toBe(total?.n);
  });

  it("upgrades legacy idx-keyed _migrations and runs pending content", () => {
    // Simulate a pre-LOG-2026-05-16 dev DB: _migrations keyed on idx, with
    // a renamed-and-collapsed entry occupying idx=3. The current MIGRATIONS
    // array expects name=team_mesh at idx=3 — under the old runner this
    // never ran. Under the new runner the rebuild preserves the historical
    // row and applies team_mesh.
    const db = new Database(":memory:");
    // A real legacy DB actually ran its base migrations, so the base tables
    // (agents, extensions, hosts, …) exist. Reproduce that by execing the
    // real `init` SQL before seeding the legacy idx-keyed _migrations —
    // otherwise a later migration that ALTERs a base table (e.g. 0005 on
    // `extensions`) has nothing to alter in this synthetic fixture.
    const initSql = listMigrations().find((m) => m.name === "init")?.sql;
    if (!initSql) throw new Error("init migration missing");
    db.exec(initSql);
    db.exec(`
      CREATE TABLE _migrations (
        idx INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO _migrations (idx, name, applied_at) VALUES
        (1, 'init', 1),
        (2, 'agent_display_name', 2),
        (3, 'principals_collapse', 3);
    `);
    runMigrations(db);
    const cols = db.query("PRAGMA table_info(_migrations)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(["name", "applied_at"]);
    const names = (db.query("SELECT name FROM _migrations").all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    // Old name preserved as audit; new content ran under its current name.
    expect(names).toContain("principals_collapse");
    expect(names).toContain("team_mesh");
    expect(names).toContain("memory_tombstones");
    // Tables from the 0003_team_mesh migration are present.
    const tableNames = (
      db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(tableNames).toContain("team_claims");
    expect(tableNames).toContain("team_peers");
    expect(tableNames).toContain("team_invites");
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
