-- OLL-E migration 0005: microVM isolation (LOG 2026-07-18).
--
-- Agent-authored extension code becomes untrusted by construction: it runs
-- in a per-agent microVM, not the daemon process. This migration adds the
-- durable state that placement and lifecycle need.
--
-- extensions.agent_id — the owning agent. Extensions were host-global (tasks
--   attributed to the root agent); per-agent VM placement needs an owner.
--   Weak ref (no FK): backfilled to the root agent at boot, and a peer-authored
--   row could carry an agent id absent from the local `agents` table.
--
-- extensions.isolation — auto | vm | host. `auto` resolves to the best backend
--   the host offers, else legacy in-process (flagged unisolated). `host` is the
--   persisted form of an approved `requiresHost` manifest — an extension that
--   spawns host binaries and cannot isolate; flipping to it is a strategic-tier
--   inbox decision.
--
-- vms — one row per placed VM. vm_key is the placement key; v1 sets it to the
--   agent id (one VM per agent). The pooling future (>8 concurrent VMs) changes
--   only placementFor() and this key, never the schema. host_id is a real FK —
--   a VM is always local to the host that runs it (unlike memories/events,
--   which federate and carry peer ids).

ALTER TABLE extensions ADD COLUMN agent_id TEXT;
ALTER TABLE extensions ADD COLUMN isolation TEXT NOT NULL DEFAULT 'auto';

CREATE TABLE vms (
  id            TEXT PRIMARY KEY,
  host_id       TEXT NOT NULL REFERENCES hosts(id),
  vm_key        TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  backend       TEXT NOT NULL,     -- firecracker | subprocess | legacy | vfkit
  status        TEXT NOT NULL,     -- booting | running | stopped | crashed
  image_sha     TEXT,
  boot_count    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_boot_at  INTEGER
);

CREATE UNIQUE INDEX vms_key ON vms (host_id, vm_key);
