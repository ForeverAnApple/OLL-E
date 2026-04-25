// Memory projector — folds `memory.*` events into the `memories` table.
//
// Memory is a projection of the event log (LOG 2026-04-23). Writes go to
// events; the `memories` table is a materialized view, reconstructible by
// replay. This keeps federation = event-log merge: peers sync events,
// each side reprojects locally.
//
// Semantics:
//  - `memory.wrote(id, ...)` — upsert. If no row: insert with event.hlc.
//    If row exists with hlc < event.hlc: update. Else ignore (stale).
//  - `memory.forgotten(id)` — delete iff existing row's hlc < event.hlc.
//  - `memory.read(id, reader)` — append to memory_reads.
//
// The projector is synchronous (via bus dispatch). Persisting the event
// row happens *before* dispatch in createBus (persist: persistToStore),
// so a row in `events` always precedes the projection side-effect.
//
// v1+ federation note: out-of-order delivery (forgotten arrives before
// wrote) is not handled — v0 bus is in-process, events flow in HLC order
// per host. When cross-host mesh lands we need a tombstone records table
// or equivalent. See LOG entry on memory surface for the full trade.

import type { EventBus } from "../bus/index.ts";
import type { Event, Unsubscribe } from "../bus/types.ts";
import type { Store } from "../store/db.ts";
import {
  MEMORY_FORGOTTEN,
  MEMORY_READ,
  MEMORY_WROTE,
  type MemoryForgottenPayload,
  type MemoryReadPayload,
  type MemoryWrotePayload,
} from "./events.ts";

export interface ProjectorOptions {
  bus: EventBus;
  store: Store;
  hostId: string;
}

export interface MemoryProjector {
  /** Stop subscribing. In-memory state is ephemeral (the table is truth). */
  stop(): void;
}

export function startMemoryProjector(opts: ProjectorOptions): MemoryProjector {
  const { bus, store, hostId } = opts;
  const raw = store.raw;

  // Prepared statements — projector runs on every durable memory event,
  // preparing once up front is meaningfully cheaper.
  const selectMemoryHlc = raw.prepare(
    "SELECT hlc FROM memories WHERE id = ?",
  );
  const insertMemory = raw.prepare(
    `INSERT INTO memories (
       id, hlc, host_id, actor_id, scope, scope_ref, role, depth,
       authored_by, seeded_from, title, body_md, tags,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateMemory = raw.prepare(
    `UPDATE memories SET
       hlc = ?, actor_id = ?, scope = ?, scope_ref = ?,
       role = ?, depth = ?, authored_by = ?, seeded_from = ?,
       title = ?, body_md = ?, tags = ?, updated_at = ?
     WHERE id = ?`,
  );
  const deleteMemory = raw.prepare("DELETE FROM memories WHERE id = ?");
  const insertRead = raw.prepare(
    "INSERT OR IGNORE INTO memory_reads (memory_id, reader_actor_id, at) VALUES (?, ?, ?)",
  );

  function applyWrote(event: Event<MemoryWrotePayload>): void {
    const p = event.payload;
    if (!p || typeof p !== "object" || typeof p.id !== "string") return;
    const existing = selectMemoryHlc.get(p.id) as { hlc: string } | null;
    const now = event.createdAt;
    const tags = JSON.stringify(p.tags ?? []);
    if (!existing) {
      insertMemory.run(
        p.id,
        event.hlc,
        hostId,
        p.actorId,
        p.scope,
        p.scopeRef ?? null,
        p.role ?? "",
        Number.isFinite(p.depth) ? p.depth : 1,
        p.authoredBy ?? null,
        p.seededFrom ?? null,
        p.title,
        p.bodyMd,
        tags,
        now,
        now,
      );
      return;
    }
    // LWW by HLC (strings are lex-sortable by encodeStamp design).
    if (event.hlc <= existing.hlc) return;
    updateMemory.run(
      event.hlc,
      p.actorId,
      p.scope,
      p.scopeRef ?? null,
      p.role ?? "",
      Number.isFinite(p.depth) ? p.depth : 1,
      p.authoredBy ?? null,
      p.seededFrom ?? null,
      p.title,
      p.bodyMd,
      tags,
      now,
      p.id,
    );
  }

  function applyForgotten(event: Event<MemoryForgottenPayload>): void {
    const p = event.payload;
    if (!p || typeof p.id !== "string") return;
    const existing = selectMemoryHlc.get(p.id) as { hlc: string } | null;
    if (!existing) return;
    if (event.hlc <= existing.hlc) return;
    deleteMemory.run(p.id);
  }

  function applyRead(event: Event<MemoryReadPayload>): void {
    const p = event.payload;
    if (!p || typeof p.id !== "string" || typeof p.readerActorId !== "string") return;
    insertRead.run(p.id, p.readerActorId, event.createdAt);
  }

  const subs: Unsubscribe[] = [
    bus.subscribe<MemoryWrotePayload>(MEMORY_WROTE, applyWrote),
    bus.subscribe<MemoryForgottenPayload>(MEMORY_FORGOTTEN, applyForgotten),
    bus.subscribe<MemoryReadPayload>(MEMORY_READ, applyRead),
  ];

  return {
    stop: () => {
      for (const u of subs) u();
    },
  };
}
