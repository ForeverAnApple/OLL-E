import type { Store } from "../store/db.ts";
import { tables } from "../store/index.ts";
import type { Event } from "./types.ts";

/** Produces a persist callback for createBus: writes durable events into
 *  the events table synchronously so order matches HLC. */
export function persistToStore(db: Store): (event: Event) => void {
  const insert = db.raw.prepare(
    `INSERT INTO events (id, hlc, host_id, actor_id, type, payload, parent_event_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return (event) => {
    insert.run(
      event.id,
      event.hlc,
      event.hostId,
      event.actorId,
      event.type,
      JSON.stringify(event.payload ?? null),
      event.parentEventId ?? null,
      event.createdAt,
    );
  };
}

// Re-export to avoid unused-import lint when callers wire the store through.
export { tables };
