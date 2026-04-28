import type { Database } from "bun:sqlite";

// Static imports so `bun build --compile` embeds the SQL into the binary.
// readdirSync against `/$bunfs/root/migrations` returns ENOENT — the bundler
// only carries files reachable through the import graph. Add new migrations
// here in numeric order; the array is the manifest.
import migration0001 from "./migrations/0001_init.sql" with { type: "text" };
import migration0002 from "./migrations/0002_task_runs.sql" with { type: "text" };
import migration0003 from "./migrations/0003_event_mailbox.sql" with { type: "text" };
import migration0004 from "./migrations/0004_memory_surface.sql" with { type: "text" };
import migration0005 from "./migrations/0005_ledger_visibility.sql" with { type: "text" };
import migration0006 from "./migrations/0006_tool_results.sql" with { type: "text" };
import migration0007 from "./migrations/0007_decision_messages.sql" with { type: "text" };

export interface MigrationFile {
  readonly index: number;
  readonly name: string;
  readonly sql: string;
}

const MIGRATIONS: readonly MigrationFile[] = [
  { index: 1, name: "init", sql: migration0001 },
  { index: 2, name: "task_runs", sql: migration0002 },
  { index: 3, name: "event_mailbox", sql: migration0003 },
  { index: 4, name: "memory_surface", sql: migration0004 },
  { index: 5, name: "ledger_visibility", sql: migration0005 },
  { index: 6, name: "tool_results", sql: migration0006 },
  { index: 7, name: "decision_messages", sql: migration0007 },
];

export function listMigrations(): readonly MigrationFile[] {
  return MIGRATIONS;
}

export function runMigrations(db: Database): number {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       idx INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at INTEGER NOT NULL
     );`,
  );
  const applied = new Set<number>(
    (db.query("SELECT idx FROM _migrations").all() as Array<{ idx: number }>).map((r) => r.idx),
  );
  let count = 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.index)) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO _migrations (idx, name, applied_at) VALUES (?, ?, ?)").run(
        m.index,
        m.name,
        Date.now(),
      );
    });
    tx();
    count++;
  }
  return count;
}
