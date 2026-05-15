import type { Database } from "bun:sqlite";

// Static imports so `bun build --compile` embeds the SQL into the binary.
// readdirSync against `/$bunfs/root/migrations` returns ENOENT — the bundler
// only carries files reachable through the import graph. Add new migrations
// here in numeric order; the array is the manifest.
//
// 2026-04-28: 0001-0008 collapsed into a single `0001_init.sql` (LOG entry
// for that date). 2026-05-14: the principals-collapse migration was folded
// back into 0001 too. Pre-v1 had no installed-user upgrade path to preserve.
import migration0001 from "./migrations/0001_init.sql" with { type: "text" };
import migration0002 from "./migrations/0002_agent_display_name.sql" with { type: "text" };

export interface MigrationFile {
  readonly index: number;
  readonly name: string;
  readonly sql: string;
}

const MIGRATIONS: readonly MigrationFile[] = [
  { index: 1, name: "init", sql: migration0001 },
  { index: 2, name: "agent_display_name", sql: migration0002 },
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
  // FK enforcement is toggled around the migration set, not inside it.
  // SQLite silently ignores `PRAGMA foreign_keys` inside a transaction
  // (https://sqlite.org/foreignkeys.html#fk_enable). Future table-recreate
  // migrations may need FKs off while dependent tables are rewritten. We
  // restore FKs to ON so the daemon runs with constraints enforced.
  db.exec("PRAGMA foreign_keys = OFF");
  let count = 0;
  try {
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
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  return count;
}
