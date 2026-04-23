import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "bun:sqlite";

export interface MigrationFile {
  readonly index: number;
  readonly name: string;
  readonly sql: string;
}

const MIGRATIONS_DIR = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "migrations");
})();

// Match `NNNN_name.sql`. Order by the numeric prefix.
const MIGRATION_PATTERN = /^(\d{4})_([^.]+)\.sql$/;

export function listMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const out: MigrationFile[] = [];
  for (const entry of readdirSync(dir)) {
    const m = MIGRATION_PATTERN.exec(entry);
    if (!m) continue;
    out.push({
      index: Number.parseInt(m[1]!, 10),
      name: m[2]!,
      sql: readFileSync(join(dir, entry), "utf8"),
    });
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

export function runMigrations(db: Database, dir: string = MIGRATIONS_DIR): number {
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
  for (const m of listMigrations(dir)) {
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
