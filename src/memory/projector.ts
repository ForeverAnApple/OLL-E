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

import { and, desc, eq } from "drizzle-orm";
import type { EventBus } from "../bus/index.ts";
import type { Event, Unsubscribe } from "../bus/types.ts";
import type { Store } from "../store/db.ts";
import { tables } from "../store/index.ts";
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

  function applyWrote(event: Event<MemoryWrotePayload>): void {
    const p = event.payload;
    // Skip malformed payloads instead of throwing — one bad publisher
    // (or a peer's replayed event in v1+ federation) must not poison
    // the bus dispatch loop. The original publisher's tool layer is
    // responsible for rejecting bad input; this is defense-in-depth.
    if (!p || typeof p !== "object") return;
    if (typeof p.id !== "string" || p.id.length === 0) return;
    if (typeof p.actorId !== "string" || p.actorId.length === 0) {
      console.warn(`[memory.projector] skip ${event.id}: missing actorId`);
      return;
    }
    if (typeof p.scope !== "string") {
      console.warn(`[memory.projector] skip ${p.id}: missing scope`);
      return;
    }
    if (typeof p.title !== "string" || typeof p.bodyMd !== "string") {
      console.warn(`[memory.projector] skip ${p.id}: missing title or bodyMd`);
      return;
    }
    const existing = store
      .select({ hlc: tables.memories.hlc })
      .from(tables.memories)
      .where(eq(tables.memories.id, p.id))
      .all()[0];
    const now = event.createdAt;
    const tags = p.tags ?? [];
    const depth = Number.isFinite(p.depth) ? p.depth : 1;
    const role = p.role ?? "";
    if (!existing) {
      store
        .insert(tables.memories)
        .values({
          id: p.id,
          hlc: event.hlc,
          hostId,
          actorId: p.actorId,
          scope: p.scope,
          scopeRef: p.scopeRef ?? null,
          role,
          depth,
          authoredBy: p.authoredBy ?? null,
          seededFrom: p.seededFrom ?? null,
          title: p.title,
          bodyMd: p.bodyMd,
          tags,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      maybeRefreshDisplayName(p.actorId, role);
      return;
    }
    // LWW by HLC (strings are lex-sortable by encodeStamp design).
    if (event.hlc <= existing.hlc) return;
    store
      .update(tables.memories)
      .set({
        hlc: event.hlc,
        actorId: p.actorId,
        scope: p.scope,
        scopeRef: p.scopeRef ?? null,
        role,
        depth,
        authoredBy: p.authoredBy ?? null,
        seededFrom: p.seededFrom ?? null,
        title: p.title,
        bodyMd: p.bodyMd,
        tags,
        updatedAt: now,
      })
      .where(eq(tables.memories.id, p.id))
      .run();
    maybeRefreshDisplayName(p.actorId, role);
  }

  /** Side-effect cache: when an agent writes a `role=display-name` memory
   *  the agent's row gets its `display_name` column updated to the
   *  freshest such body. Memory is the source of truth (federation
   *  syncs events, peers reproject locally); the column is just a fast
   *  read path the CLI / event renderers use without paying a memory
   *  query per render.
   *
   *  We always re-derive from the latest `role=display-name` row owned
   *  by this actor rather than copying the just-projected body — this
   *  way an out-of-order LWW update (older HLC arrives later, gets
   *  rejected above) doesn't poison the cache, and a `memory_forget`
   *  on the active row falls back to whatever's still on disk for
   *  that role. The body is sanitised at read time too (one-line
   *  label, no control bytes, capped length).
   */
  function maybeRefreshDisplayName(actorId: string, role: string): void {
    if (role !== "display-name") return;
    const latest = store
      .select({ bodyMd: tables.memories.bodyMd })
      .from(tables.memories)
      .where(
        and(
          eq(tables.memories.actorId, actorId),
          eq(tables.memories.role, "display-name"),
        ),
      )
      .orderBy(desc(tables.memories.updatedAt))
      .limit(1)
      .all()[0];
    const sanitized = latest ? sanitizeDisplayName(latest.bodyMd) : null;
    store
      .update(tables.agents)
      .set({ displayName: sanitized })
      .where(eq(tables.agents.id, actorId))
      .run();
  }

  function applyForgotten(event: Event<MemoryForgottenPayload>): void {
    const p = event.payload;
    if (!p || typeof p.id !== "string") return;
    const existing = store
      .select({
        hlc: tables.memories.hlc,
        actorId: tables.memories.actorId,
        role: tables.memories.role,
      })
      .from(tables.memories)
      .where(eq(tables.memories.id, p.id))
      .all()[0];
    if (!existing) return;
    if (event.hlc <= existing.hlc) return;
    store.delete(tables.memories).where(eq(tables.memories.id, p.id)).run();
    // If the forgotten memory was the display-name source, recompute
    // the cache against whatever's still on disk for the actor.
    if (existing.role === "display-name") {
      maybeRefreshDisplayName(existing.actorId, "display-name");
    }
  }

  function applyRead(event: Event<MemoryReadPayload>): void {
    const p = event.payload;
    if (!p || typeof p.id !== "string" || typeof p.readerActorId !== "string") return;
    store
      .insert(tables.memoryReads)
      .values({ memoryId: p.id, readerActorId: p.readerActorId, at: event.createdAt })
      .onConflictDoNothing()
      .run();
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

/** Coerce a `role=display-name` memory body into a renderable single-line
 *  handle. Strips control characters, collapses internal whitespace,
 *  trims, and caps at 30 visible characters — long enough for "Aria of
 *  the Greenhouse" but short enough to fit in a CLI header column. An
 *  empty result returns null so the cache reflects "no display name."
 */
const DISPLAY_NAME_MAX = 30;
function sanitizeDisplayName(body: string): string | null {
  if (typeof body !== "string") return null;
  // Strip C0/C1 controls + DEL. Keep regular printable Unicode.
  // eslint-disable-next-line no-control-regex
  const stripped = body.replace(/[\x00-\x1F\x7F-\x9F]/g, " ");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length > DISPLAY_NAME_MAX
    ? collapsed.slice(0, DISPLAY_NAME_MAX)
    : collapsed;
}
