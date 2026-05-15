-- LOG 2026-04-23 finally landing as code: "the human is the oldest agent."
-- `principals` collapses into `agents`. Each existing principal becomes an
-- agent row with the same ULID, `owns_money = 1`, all tiers allowed, and
-- the principal's channels copied across. The decisions/budgets foreign
-- keys retarget to agents.id and rename to `owner_agent_id` so reading the
-- row out loud no longer says "principal" of a row that doesn't exist.
--
-- Ask-up termination becomes one recursion: child → ... → AI root → human
-- agent → no parent. The human agent IS the inbox owner.
--
-- The migration runner toggles `PRAGMA foreign_keys` around each migration
-- (see src/store/migrate.ts) so the table-recreate pattern below is safe.

-- ─── 1. Extend agents ────────────────────────────────────────────────────

ALTER TABLE agents ADD COLUMN channels    TEXT    NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN owns_money  INTEGER NOT NULL DEFAULT 0;

CREATE INDEX agents_owns_money ON agents(owns_money);

-- ─── 2. Lift principals into agents (same ULID) ──────────────────────────
--
-- Humans are the inbox owner + the real-money source, so they hold every
-- tier. host_id stays NOT NULL on agents in v0; the human-agent gets the
-- install's local host. (LOG 2026-04-23 sketched `host_id=null`, but the
-- column-level NOT NULL has wider blast radius than the collapse needs.
-- The human-agent owns no triggers/tasks/tools, so the "executable on this
-- host" queries never hit it. Revisit if multi-host humans land.)

INSERT INTO agents (
  id, name, host_id, parent_agent_id, system_prompt, budget_ref, scope,
  channels, owns_money, created_at
)
SELECT
  p.id,
  p.display,
  (SELECT id FROM hosts ORDER BY created_at LIMIT 1),
  NULL,
  NULL,
  NULL,
  '{"allowTiers":["operational","strategic","vision"]}',
  p.channels,
  1,
  p.created_at
FROM principals p;

-- ─── 3. Parent the existing AI root agents under the human ───────────────
--
-- Pre-collapse, "root agents" (the AI delegates) had parent_agent_id NULL
-- because the chain terminated via decisions.principal_id. Post-collapse,
-- ask-up walks parents all the way; the AI root needs to point at the
-- human so the chain reaches it. v0 is single-principal, so picking the
-- earliest owns_money=1 agent is unambiguous; multi-principal teams will
-- need a richer rule and re-open this.

UPDATE agents
SET parent_agent_id = (
  SELECT id FROM agents
   WHERE owns_money = 1
   ORDER BY created_at
   LIMIT 1
)
WHERE parent_agent_id IS NULL
  AND owns_money = 0
  AND EXISTS (SELECT 1 FROM agents WHERE owns_money = 1);

-- ─── 4. Recreate decisions with owner_agent_id → agents(id) ──────────────

CREATE TABLE decisions_new (
  id                  TEXT PRIMARY KEY,
  owner_agent_id      TEXT NOT NULL REFERENCES agents(id),
  proposing_agent_id  TEXT NOT NULL REFERENCES agents(id),
  tier                TEXT NOT NULL,
  summary             TEXT NOT NULL,
  payload             TEXT NOT NULL,
  status              TEXT NOT NULL,
  staleness           INTEGER,
  quorum_required     INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  resolved_at         INTEGER
);

INSERT INTO decisions_new (
  id, owner_agent_id, proposing_agent_id, tier, summary, payload, status,
  staleness, quorum_required, created_at, resolved_at
)
SELECT
  id, principal_id, proposing_agent_id, tier, summary, payload, status,
  staleness, quorum_required, created_at, resolved_at
FROM decisions;

DROP TABLE decisions;
ALTER TABLE decisions_new RENAME TO decisions;
CREATE INDEX decisions_status ON decisions(status);
CREATE INDEX decisions_owner  ON decisions(owner_agent_id);

-- ─── 5. Recreate budgets with owner_agent_id → agents(id) ────────────────

CREATE TABLE budgets_new (
  id              TEXT PRIMARY KEY,
  owner_agent_id  TEXT NOT NULL REFERENCES agents(id),
  agent_id        TEXT REFERENCES agents(id),
  period          TEXT NOT NULL,
  cap_tokens      INTEGER,
  cap_usd         INTEGER,
  spent_tokens    INTEGER NOT NULL DEFAULT 0,
  spent_usd       INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL
);

INSERT INTO budgets_new (
  id, owner_agent_id, agent_id, period, cap_tokens, cap_usd,
  spent_tokens, spent_usd, updated_at
)
SELECT
  id, principal_id, agent_id, period, cap_tokens, cap_usd,
  spent_tokens, spent_usd, updated_at
FROM budgets;

DROP TABLE budgets;
ALTER TABLE budgets_new RENAME TO budgets;
CREATE INDEX budgets_agent_period ON budgets(agent_id, period);
CREATE INDEX budgets_owner        ON budgets(owner_agent_id, period);

-- ─── 6. Drop principals ──────────────────────────────────────────────────

DROP TABLE principals;
