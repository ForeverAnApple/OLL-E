-- OLL-E migration 0004: memory surface fields for identity + cultural pass-on.
--
-- Memory is identity (LOG 2026-04-23). Each row carries a posture `role`,
-- a belief weight `depth` for the inertia model, and attribution fields
-- so cultural pass-on and team authorship stay legible.
--
-- Role is free-form agent-native string: principle, goal, preference,
-- skill, knowledge, ... The one posture blessed as load-bearing is
-- `principle` — auto-injected into every turn's system prompt, and
-- auto-passed to spawned children at spawn time. Other roles are
-- searched/retrieved, not injected.
--
-- Depth is the resistance default (VISION: beliefs have inertia, not
-- locks). Seed principles arrive heavy (10.0 default for role=principle
-- writes; bumped higher at cultural pass-on). Lived writes arrive
-- light (1.0). Hebbian bumps-on-use are v0.1; v0 just writes and
-- respects whatever weight a memory holds.
--
-- authored_by handles the one blessed case of cross-actor writing:
-- cultural pass-on at spawn. The spawn manager emits memory.wrote
-- events with actor_id=childId, authored_by=parentId. The memory_write
-- tool otherwise enforces actor_id == caller.
--
-- seeded_from points back to the source memory id during pass-on so
-- lineage is traceable. Live edits of a seeded principle don't touch
-- the parent row; the child's copy just drifts (nature + nurture).

ALTER TABLE memories ADD COLUMN role TEXT NOT NULL DEFAULT '';
ALTER TABLE memories ADD COLUMN depth INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memories ADD COLUMN authored_by TEXT;
ALTER TABLE memories ADD COLUMN seeded_from TEXT;

CREATE INDEX memories_actor_role ON memories(actor_id, role);

-- Drop the FK from memory_reads → memories. Under the projection model
-- (LOG 2026-04-23) a memory can be forgotten (row deleted) while the
-- read-audit events that referenced it must survive. Weak reference is
-- the pattern already used for events.actor_id / events.to_agent_id.
-- SQLite has no DROP CONSTRAINT, so we recreate the table.

CREATE TABLE memory_reads_new (
  memory_id         TEXT NOT NULL,
  reader_actor_id   TEXT NOT NULL,
  at                INTEGER NOT NULL,
  PRIMARY KEY (memory_id, reader_actor_id, at)
);
INSERT INTO memory_reads_new (memory_id, reader_actor_id, at)
  SELECT memory_id, reader_actor_id, at FROM memory_reads;
DROP TABLE memory_reads;
ALTER TABLE memory_reads_new RENAME TO memory_reads;
CREATE INDEX memory_reads_memory ON memory_reads(memory_id);
