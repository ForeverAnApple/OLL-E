-- OLL-E migration 0001: full v0 schema in one shot.
--
-- Compacted from eight historical migrations (LOG 2026-04-28). Pre-v1 had
-- no installed-user upgrade path to preserve, so the migration sequence
-- collapsed to the final state. The reasoning trail behind each shape
-- decision lives in LOG.md (search for the table name); this file just
-- defines what's in the store today.
--
-- Applied in a single transaction by `runMigrations` in src/store/migrate.ts.

-- ─── Identity & teams ─────────────────────────────────────────────────────

CREATE TABLE hosts (
  id          TEXT PRIMARY KEY,
  hostname    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  config_ref  TEXT
);

CREATE TABLE principals (
  id          TEXT PRIMARY KEY,
  display     TEXT NOT NULL,
  channels    TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL
);

CREATE TABLE agents (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  host_id           TEXT NOT NULL REFERENCES hosts(id),
  parent_agent_id   TEXT,
  system_prompt     TEXT,
  budget_ref        TEXT,
  scope             TEXT NOT NULL DEFAULT '{}',
  created_at        INTEGER NOT NULL
);
CREATE INDEX agents_name ON agents(name);
CREATE INDEX agents_parent ON agents(parent_agent_id);

CREATE TABLE teams (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  mission_ref  TEXT,
  goal_dir     TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE team_members (
  team_id    TEXT NOT NULL REFERENCES teams(id),
  actor_id   TEXT NOT NULL,
  role       TEXT NOT NULL,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (team_id, actor_id)
);

-- ─── Triggers, tasks, tools, extensions ───────────────────────────────────

CREATE TABLE triggers (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  type        TEXT NOT NULL,
  config      TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE INDEX triggers_agent ON triggers(agent_id);
CREATE INDEX triggers_type ON triggers(type);

CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  trigger_refs  TEXT NOT NULL,
  handler_ref   TEXT NOT NULL,
  tier          TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT '{}',
  token_est     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX tasks_agent ON tasks(agent_id);
CREATE INDEX tasks_tier ON tasks(tier);

CREATE TABLE tools (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  extension_id  TEXT,
  name          TEXT NOT NULL,
  schema        TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);
CREATE INDEX tools_agent ON tools(agent_id);

CREATE TABLE extensions (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  path              TEXT NOT NULL,
  status            TEXT NOT NULL,
  last_smoke_at     INTEGER,
  last_commit_sha   TEXT,
  created_at        INTEGER NOT NULL
);

-- ─── Events, claims, runs, tool_calls ─────────────────────────────────────
--
-- events.to_agent_id / actor_id are weak refs (no FK): mesh events may
-- address agents not present locally, and retired-agent cleanup shouldn't
-- cascade through the event log.

CREATE TABLE events (
  id                TEXT PRIMARY KEY,
  hlc               TEXT NOT NULL,
  host_id           TEXT NOT NULL REFERENCES hosts(id),
  actor_id          TEXT NOT NULL,
  type              TEXT NOT NULL,
  payload           TEXT NOT NULL,
  parent_event_id   TEXT,
  to_agent_id       TEXT,
  thread_id         TEXT,
  parent_thread_id  TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX events_hlc        ON events(hlc);
CREATE INDEX events_type       ON events(type);
CREATE INDEX events_parent     ON events(parent_event_id);
CREATE INDEX events_mailbox    ON events(to_agent_id, hlc);
CREATE INDEX events_thread     ON events(thread_id, hlc);
CREATE INDEX events_actor_hlc  ON events(actor_id, hlc);

CREATE TABLE claims (
  event_id    TEXT NOT NULL REFERENCES events(id),
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  claimed_at  INTEGER NOT NULL,
  status      TEXT NOT NULL,
  PRIMARY KEY (event_id, task_id)
);
CREATE INDEX claims_event ON claims(event_id);

CREATE TABLE task_runs (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  event_id    TEXT NOT NULL REFERENCES events(id),
  host_id     TEXT NOT NULL REFERENCES hosts(id),
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  status      TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  error       TEXT
);
CREATE INDEX task_runs_task            ON task_runs(task_id);
CREATE INDEX task_runs_status          ON task_runs(status);
CREATE INDEX task_runs_event           ON task_runs(event_id);
CREATE INDEX task_runs_agent_started   ON task_runs(agent_id, started_at);

CREATE TABLE tool_calls (
  id           TEXT PRIMARY KEY,
  task_id      TEXT REFERENCES tasks(id),
  tool_id      TEXT NOT NULL REFERENCES tools(id),
  args         TEXT NOT NULL,
  result       TEXT,
  tokens_used  INTEGER NOT NULL DEFAULT 0,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER
);
CREATE INDEX tool_calls_task ON tool_calls(task_id);

-- ─── Decisions, approvals, decision messages + reads ──────────────────────
--
-- decision_messages.actor_id and decision_message_reads.reader_actor_id are
-- weak refs (no FK) — mesh can carry messages whose author isn't local, and
-- retired-agent cleanup shouldn't cascade through the conversation history.

CREATE TABLE decisions (
  id                  TEXT PRIMARY KEY,
  principal_id        TEXT NOT NULL REFERENCES principals(id),
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
CREATE INDEX decisions_status    ON decisions(status);
CREATE INDEX decisions_principal ON decisions(principal_id);

CREATE TABLE approvals (
  decision_id  TEXT NOT NULL REFERENCES decisions(id),
  actor_id     TEXT NOT NULL,
  vote         TEXT NOT NULL,
  message      TEXT,
  at           INTEGER NOT NULL,
  PRIMARY KEY (decision_id, actor_id, at)
);

CREATE TABLE decision_messages (
  id           TEXT PRIMARY KEY,
  decision_id  TEXT NOT NULL REFERENCES decisions(id),
  host_id      TEXT NOT NULL REFERENCES hosts(id),
  actor_id     TEXT NOT NULL,
  text         TEXT NOT NULL,
  at           INTEGER NOT NULL
);
CREATE INDEX decision_messages_decision ON decision_messages(decision_id, at);

CREATE TABLE decision_message_reads (
  message_id       TEXT NOT NULL REFERENCES decision_messages(id),
  reader_actor_id  TEXT NOT NULL,
  at               INTEGER NOT NULL,
  PRIMARY KEY (message_id, reader_actor_id)
);
CREATE INDEX decision_message_reads_reader ON decision_message_reads(reader_actor_id);

-- ─── Budgets + tokens-only ledger ─────────────────────────────────────────
--
-- Budgets stay USD-denominated (humans back them with real money). The
-- ledger records what physically happened: input_tokens / output_tokens /
-- cache_read_tokens / cache_creation_tokens. USD is a derivation
-- (priceTokens(model, usage) in src/llm/pricing.ts) snapshotted into
-- budgets.spent_usd at decrement time, never into ledger rows.

CREATE TABLE budgets (
  id            TEXT PRIMARY KEY,
  principal_id  TEXT NOT NULL REFERENCES principals(id),
  agent_id      TEXT REFERENCES agents(id),
  period        TEXT NOT NULL,
  cap_tokens    INTEGER,
  cap_usd       INTEGER,
  spent_tokens  INTEGER NOT NULL DEFAULT 0,
  spent_usd     INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX budgets_agent_period ON budgets(agent_id, period);

CREATE TABLE ledger (
  id                     TEXT PRIMARY KEY,
  hlc                    TEXT NOT NULL,
  host_id                TEXT NOT NULL REFERENCES hosts(id),
  actor_id               TEXT NOT NULL,
  thread_id              TEXT,
  provider               TEXT NOT NULL,
  model                  TEXT NOT NULL,
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
  tool_call_id           TEXT REFERENCES tool_calls(id),
  at                     INTEGER NOT NULL
);
CREATE INDEX ledger_actor      ON ledger(actor_id);
CREATE INDEX ledger_model      ON ledger(provider, model);
CREATE INDEX ledger_actor_at   ON ledger(actor_id, at);
CREATE INDEX ledger_thread_at  ON ledger(thread_id, at);

-- ─── Memory surface ───────────────────────────────────────────────────────
--
-- Memory is identity (LOG 2026-04-23). One row per fact; role tags
-- differentiate posture (`identity`, `principle`, `goal`, `preference`,
-- `skill`, `knowledge`, `culture`, ...). `principle` and `identity` are
-- the load-bearing roles that render into every turn's system prompt
-- via the SOUL pipeline (LOG 2026-04-24, LOG 2026-04-28).
--
-- depth carries the resistance default (VISION: beliefs have inertia,
-- not locks). Seed beliefs arrive heavy; lived writes arrive light.
-- authored_by is non-null only for cross-actor writes (cultural
-- pass-on at spawn). seeded_from points to the source memory id during
-- pass-on so lineage is traceable.
--
-- memory_reads has no FK on memory_id by design — under the projection
-- model a memory can be forgotten while its read-audit rows must
-- survive. Weak ref is the same pattern used for events.actor_id.

CREATE TABLE memories (
  id           TEXT PRIMARY KEY,
  hlc          TEXT NOT NULL,
  host_id      TEXT NOT NULL REFERENCES hosts(id),
  actor_id     TEXT NOT NULL,
  scope        TEXT NOT NULL,
  scope_ref    TEXT,
  role         TEXT NOT NULL DEFAULT '',
  depth        INTEGER NOT NULL DEFAULT 1,
  authored_by  TEXT,
  seeded_from  TEXT,
  title        TEXT NOT NULL,
  body_md      TEXT NOT NULL,
  tags         TEXT NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX memories_scope       ON memories(scope, scope_ref);
CREATE INDEX memories_actor       ON memories(actor_id);
CREATE INDEX memories_actor_role  ON memories(actor_id, role);

CREATE TABLE memory_reads (
  memory_id        TEXT NOT NULL,
  reader_actor_id  TEXT NOT NULL,
  at               INTEGER NOT NULL,
  PRIMARY KEY (memory_id, reader_actor_id, at)
);
CREATE INDEX memory_reads_memory ON memory_reads(memory_id);

-- ─── Tool results spillover ───────────────────────────────────────────────
--
-- Over-cap tool output spills out of the conversation prefix to keep it
-- bounded; the LLM sees a preview + handle and can recover via
-- read_tool_result. The id is the LLM-emitted tool_use_id (already unique
-- per invocation, embedded in the preview), not a freshly minted ULID.

CREATE TABLE tool_results (
  id          TEXT PRIMARY KEY,
  hlc         TEXT NOT NULL,
  host_id     TEXT NOT NULL REFERENCES hosts(id),
  actor_id    TEXT NOT NULL,
  thread_id   TEXT NOT NULL,
  tool_name   TEXT NOT NULL,
  content     TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX tool_results_thread ON tool_results(thread_id, created_at);
CREATE INDEX tool_results_actor  ON tool_results(actor_id, created_at);
