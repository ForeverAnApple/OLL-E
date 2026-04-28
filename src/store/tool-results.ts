// Persistence for over-cap tool output. The runtime hands us full content
// + identity; we write a row and the agent recovers it later through the
// `read_tool_result` tool. INSERT OR IGNORE on the LLM-emitted tool_use_id
// makes the store idempotent under retries / replay.

import type { Database } from "bun:sqlite";
import { createClock, encodeStamp, type HlcClock } from "../id/hlc.ts";

export interface ToolResultRow {
  id: string;
  threadId: string;
  actorId: string;
  hostId: string;
  toolName: string;
  bytes: number;
  createdAt: number;
}

export interface PersistInput {
  id: string;
  threadId: string;
  actorId: string;
  hostId: string;
  toolName: string;
  content: string;
}

export interface ToolResultStore {
  persist(input: PersistInput): void;
  read(id: string, opts?: { offset?: number; limit?: number }): ReadResult | null;
}

export interface ReadResult {
  meta: ToolResultRow;
  content: string;
  totalBytes: number;
  offset: number;
  hasMore: boolean;
}

export function createToolResultStore(opts: {
  db: Database;
  clock?: HlcClock;
  hostId: string;
}): ToolResultStore {
  const clock = opts.clock ?? createClock();
  const insert = opts.db.prepare(
    `INSERT OR IGNORE INTO tool_results
       (id, hlc, host_id, actor_id, thread_id, tool_name, content, bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const select = opts.db.prepare(
    `SELECT id, thread_id as threadId, actor_id as actorId, host_id as hostId,
            tool_name as toolName, content, bytes, created_at as createdAt
       FROM tool_results
      WHERE id = ?`,
  );

  return {
    persist(input) {
      const bytes = Buffer.byteLength(input.content, "utf8");
      insert.run(
        input.id,
        encodeStamp(clock.now()),
        input.hostId,
        input.actorId,
        input.threadId,
        input.toolName,
        input.content,
        bytes,
        Date.now(),
      );
    },
    read(id, readOpts) {
      const row = select.get(id) as
        | (ToolResultRow & { content: string })
        | undefined;
      if (!row) return null;
      const total = row.bytes;
      const offset = Math.max(0, readOpts?.offset ?? 0);
      const limit = readOpts?.limit;
      let slice = row.content.slice(offset);
      if (limit !== undefined && limit >= 0 && limit < slice.length) {
        slice = slice.slice(0, limit);
      }
      const end = offset + slice.length;
      return {
        meta: {
          id: row.id,
          threadId: row.threadId,
          actorId: row.actorId,
          hostId: row.hostId,
          toolName: row.toolName,
          bytes: row.bytes,
          createdAt: row.createdAt,
        },
        content: slice,
        totalBytes: total,
        offset,
        hasMore: end < total,
      };
    },
  };
}
