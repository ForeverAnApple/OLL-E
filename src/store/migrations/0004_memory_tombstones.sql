-- OLL-E migration 0004: memory tombstones.
--
-- Memory is a projection of the event log (LOG 2026-04-23). The projector
-- consumes `memory.wrote` and `memory.forgotten` events and materializes
-- `memories` rows. Single-host that's fine — events are inserted in
-- arrival order and the projector sees them in that order too.
--
-- Federation breaks the assumption. A peer's `memory.forgotten` can be
-- delivered to us before its corresponding `memory.wrote` (network split,
-- catch-up replay, late reconnect). If we let the projector run on
-- arrival order, the late write would resurrect a forgotten memory and
-- the user would see a row they thought they'd deleted.
--
-- LWW on HLC plus a tombstone table fixes it. Three rules, one table:
--
--   1. `memory.forgotten(id, hlc=F)` records a tombstone row keyed by
--      memory_id, regardless of whether the memory exists locally.
--   2. `memory.wrote(id, hlc=W)` only materializes a row when no
--      tombstone exists for that id with hlc >= W.
--   3. Tombstones are never garbage-collected within v0. They are the
--      durable "this id is dead" record.
--
-- The table is intentionally tiny (memory_id + provenance + hlc). The
-- bodies of forgotten memories are not preserved — the agent emitted
-- `memory.forgotten` because it wanted them gone. We keep only enough
-- to prevent resurrection.
--
-- host_id and actor_id are weak refs (no FK) — same pattern as
-- memories.actor_id and events.actor_id: a tombstone authored on a peer
-- host carries that peer's host/actor ids, which aren't present in the
-- local `hosts` / `agents` tables.

CREATE TABLE memory_tombstones (
  memory_id      TEXT PRIMARY KEY,
  hlc            TEXT NOT NULL,
  host_id        TEXT NOT NULL,
  actor_id       TEXT NOT NULL,
  forgotten_at   INTEGER NOT NULL
);
