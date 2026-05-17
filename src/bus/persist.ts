import type { Store } from "../store/db.ts";
import { tables } from "../store/index.ts";
import type { Event } from "./types.ts";

/** Produces a persist callback for createBus: writes durable events into
 *  the events table synchronously so order matches HLC.
 *
 *  Idempotency: `INSERT OR IGNORE` on events.id. Local publish() produces
 *  fresh ULIDs so the ignore branch never fires; `bus.inject` (mesh replay
 *  + catchup) reuses original event ids so duplicates are no-ops here.
 *
 *  Hosts stub: events.host_id is FK → hosts.id. A bridge can hand us an
 *  event whose host_id we've never seen — the peer host doesn't exist in
 *  our `hosts` table yet (the `hello` envelope that names it is Wave 3
 *  work). Insert a placeholder row keyed by host_id so the FK holds; a
 *  later `hello` can refine `hostname`. */
export function persistToStore(db: Store): (event: Event) => void {
  const insertHost = db.raw.prepare(
    `INSERT OR IGNORE INTO hosts (id, hostname, created_at, config_ref)
     VALUES (?, ?, ?, NULL)`,
  );
  const insertEvent = db.raw.prepare(
    `INSERT OR IGNORE INTO events (id, hlc, host_id, actor_id, type, payload, parent_event_id, to_agent_id, thread_id, parent_thread_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const writePair = db.raw.transaction((event: Event) => {
    insertHost.run(event.hostId, `remote:${event.hostId.slice(0, 8)}`, Date.now());
    insertEvent.run(
      event.id,
      event.hlc,
      event.hostId,
      event.actorId,
      event.type,
      JSON.stringify(event.payload ?? null),
      event.parentEventId ?? null,
      event.toAgentId ?? null,
      event.threadId ?? null,
      event.parentThreadId ?? null,
      event.createdAt,
    );
  });
  return (event) => {
    writePair(event);
  };
}

// Re-export to avoid unused-import lint when callers wire the store through.
export { tables };
