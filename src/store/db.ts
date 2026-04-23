import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { runMigrations } from "./migrate.ts";
import * as schema from "./schema.ts";

export type Store = ReturnType<typeof drizzle<typeof schema>> & {
  raw: Database;
  close(): void;
};

export interface OpenOptions {
  /** ":memory:" for tests, otherwise a filesystem path. */
  path: string;
  /** Skip migrations — only useful for tests creating a schema manually. */
  skipMigrations?: boolean;
}

export function openStore(opts: OpenOptions): Store {
  const raw = new Database(opts.path, { create: true });
  raw.exec("PRAGMA journal_mode = WAL;");
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec("PRAGMA synchronous = NORMAL;");
  if (!opts.skipMigrations) runMigrations(raw);
  const db = drizzle(raw, { schema }) as Store;
  (db as unknown as { raw: Database }).raw = raw;
  (db as unknown as { close(): void }).close = () => raw.close();
  return db;
}

export { schema };
