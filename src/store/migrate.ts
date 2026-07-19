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
import migration0003 from "./migrations/0003_team_mesh.sql" with { type: "text" };
import migration0004 from "./migrations/0004_memory_tombstones.sql" with { type: "text" };
import migration0005 from "./migrations/0005_vm_isolation.sql" with { type: "text" };

export interface MigrationFile {
  readonly index: number;
  readonly name: string;
  readonly sql: string;
}

const MIGRATIONS: readonly MigrationFile[] = [
  { index: 1, name: "init", sql: migration0001 },
  { index: 2, name: "agent_display_name", sql: migration0002 },
  { index: 3, name: "team_mesh", sql: migration0003 },
  { index: 4, name: "memory_tombstones", sql: migration0004 },
  { index: 5, name: "vm_isolation", sql: migration0005 },
];

export function listMigrations(): readonly MigrationFile[] {
  return MIGRATIONS;
}

export function runMigrations(db: Database): number {
  // Identity is the migration's `name`; the array index above is ordering
  // only. Earlier versions persisted `idx` as PK, which turned a code-list
  // choice into durable state — renames or collapses (LOG 2026-05-16) then
  // blocked new content at the same index from ever running on existing
  // DBs. Now we track by name and let the code list reshape freely.
  const cols = db.query("PRAGMA table_info(_migrations)").all() as Array<{ name: string }>;
  if (cols.length === 0) {
    db.exec(
      `CREATE TABLE _migrations (
         name TEXT PRIMARY KEY,
         applied_at INTEGER NOT NULL
       );`,
    );
  } else if (cols.some((c) => c.name === "idx")) {
    // Legacy layout (idx PK, name TEXT, applied_at). Rebuild with name as
    // PK; preserve (name, applied_at). Atomic so a crash mid-rebuild
    // leaves the old table intact.
    db.transaction(() => {
      db.exec(
        `CREATE TABLE _migrations_v2 (
           name TEXT PRIMARY KEY,
           applied_at INTEGER NOT NULL
         );
         INSERT OR IGNORE INTO _migrations_v2 (name, applied_at)
           SELECT name, applied_at FROM _migrations;
         DROP TABLE _migrations;
         ALTER TABLE _migrations_v2 RENAME TO _migrations;`,
      );
    })();
  }
  const applied = new Set<string>(
    (db.query("SELECT name FROM _migrations").all() as Array<{ name: string }>).map((r) => r.name),
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
      if (applied.has(m.name)) continue;
      const tx = db.transaction(() => {
        db.exec(m.sql);
        db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(
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
