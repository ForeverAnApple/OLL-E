-- OLL-E migration 0003: team mesh substrate.
--
-- Teams stop being single-host bookkeeping (LOG 2026-05-13, 2026-05-14).
-- A team is now a peer mesh: each host runs its own daemon, knows about
-- its peers by host id + dial address, and reconciles the team's event
-- log by union+sort. Three tables back this:
--
--   * team_peers   — local view of "who else is in this team and how do
--                    I reach them right now." One row per (team, peer).
--                    Status reflects the local link state, not consensus.
--
--   * team_invites — outstanding bearer-code invites the local host has
--                    issued. The code itself never lands in SQLite —
--                    only its hash and a `secret_ref` pointing into
--                    `secrets/team/<teamId>` where the raw secret lives.
--
--   * team_claims  — the leaderless claim-window projection. When a
--                    team-tagged event lands, every eligible peer emits
--                    an `intent` row; after the window closes the lowest
--                    (claim_hlc, host_id) wins and the rest move to
--                    `lost`. `split_brain` is reserved for the rare case
--                    where the projection observes inconsistent winners
--                    from different peers and needs human attention.
--
-- Weak refs across hosts: peer_host_id, claiming_host_id, claiming_agent_id,
-- and event_id carry no FK. Hosts and agents from other cells are not
-- present in the local `hosts` / `agents` / `events` tables, and never
-- will be — the mesh is event-log union, not row-level replication. This
-- mirrors the existing pattern for events.actor_id, memories.actor_id,
-- and decision_messages.actor_id (see 0001_init.sql header for events
-- and memories sections).
--
-- Local refs that DO carry FKs: team_peers.team_id and team_invites.team_id.
-- You cannot peer in or invite to a team that doesn't exist locally —
-- the team row is the local handle for the cell, created at
-- `olle team create` or at join time before any peer is recorded.

-- ─── Team peers ───────────────────────────────────────────────────────────

CREATE TABLE team_peers (
  team_id                  TEXT NOT NULL REFERENCES teams(id),
  peer_host_id             TEXT NOT NULL,
  addr                     TEXT NOT NULL,
  status                   TEXT NOT NULL,    -- connected | disconnected | stale | left | rejected
  last_heartbeat_at        INTEGER,
  last_received_event_id   TEXT,
  joined_at                INTEGER NOT NULL,
  PRIMARY KEY (team_id, peer_host_id)
);
CREATE INDEX team_peers_status ON team_peers(status);

-- ─── Team invites ─────────────────────────────────────────────────────────
--
-- The bearer code is the raw secret a friend pastes into `olle team join`.
-- The local store keeps only its hash (for matching at redeem time) and
-- `secret_ref`, a filesystem handle into `secrets/team/<teamId>` where
-- the canonical bytes live. Redemption flips `redeemed_at` /
-- `redeemed_by_host_id`; the row stays as audit.

CREATE TABLE team_invites (
  invite_id            TEXT PRIMARY KEY,
  team_id              TEXT NOT NULL REFERENCES teams(id),
  code_hash            TEXT NOT NULL,
  secret_ref           TEXT NOT NULL,
  addr                 TEXT NOT NULL,
  created_by_actor_id  TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  expires_at           INTEGER,
  redeemed_at          INTEGER,
  redeemed_by_host_id  TEXT
);

-- ─── Team claims ──────────────────────────────────────────────────────────
--
-- Cross-host arbitration record. Distinct from the single-host `claims`
-- table: `claims` is the local scheduler's per-event-per-task winner
-- record, `team_claims` is the projection of the leaderless claim window
-- across the whole mesh. Both exist; they answer different questions.
--
-- event_id and claiming_agent_id are weak refs (the event and the agent
-- may live on a peer host). task_id is local-only when claiming_host_id
-- is the local host; otherwise it's the peer's task id and treated as
-- opaque. task_fingerprint is the stable identity used to dedupe across
-- peers when the same logical task is registered separately on multiple
-- cells (per the teams plan: extensions register handlers locally, the
-- mesh agrees on which instance wins).

CREATE TABLE team_claims (
  claim_id            TEXT PRIMARY KEY,
  team_id             TEXT NOT NULL REFERENCES teams(id),
  event_id            TEXT NOT NULL,
  event_hlc           TEXT NOT NULL,
  claiming_host_id    TEXT NOT NULL,
  claiming_agent_id   TEXT NOT NULL,
  task_id             TEXT NOT NULL,
  task_fingerprint    TEXT NOT NULL,
  claim_hlc           TEXT NOT NULL,
  status              TEXT NOT NULL,    -- intent | won | lost | split_brain
  created_at          INTEGER NOT NULL
);
CREATE INDEX team_claims_event ON team_claims(event_id);
CREATE INDEX team_claims_team  ON team_claims(team_id, created_at);
