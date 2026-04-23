-- OLL-E migration 0001: all tables from ARCHITECTURE.md.
-- Applied in a single transaction by the migrator.

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

CREATE TABLE events (
  id                TEXT PRIMARY KEY,
  hlc               TEXT NOT NULL,
  host_id           TEXT NOT NULL REFERENCES hosts(id),
  actor_id          TEXT NOT NULL,
  type              TEXT NOT NULL,
  payload           TEXT NOT NULL,
  parent_event_id   TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX events_hlc ON events(hlc);
CREATE INDEX events_type ON events(type);
CREATE INDEX events_parent ON events(parent_event_id);

CREATE TABLE claims (
  event_id    TEXT NOT NULL REFERENCES events(id),
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  claimed_at  INTEGER NOT NULL,
  status      TEXT NOT NULL,
  PRIMARY KEY (event_id, task_id)
);
CREATE INDEX claims_event ON claims(event_id);

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

CREATE TABLE decisions (
  id                     TEXT PRIMARY KEY,
  principal_id           TEXT NOT NULL REFERENCES principals(id),
  proposing_agent_id     TEXT NOT NULL REFERENCES agents(id),
  tier                   TEXT NOT NULL,
  summary                TEXT NOT NULL,
  payload                TEXT NOT NULL,
  status                 TEXT NOT NULL,
  staleness              INTEGER,
  quorum_required        INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL,
  resolved_at            INTEGER
);
CREATE INDEX decisions_status ON decisions(status);
CREATE INDEX decisions_principal ON decisions(principal_id);

CREATE TABLE approvals (
  decision_id  TEXT NOT NULL REFERENCES decisions(id),
  actor_id     TEXT NOT NULL,
  vote         TEXT NOT NULL,
  message      TEXT,
  at           INTEGER NOT NULL,
  PRIMARY KEY (decision_id, actor_id, at)
);

CREATE TABLE budgets (
  id             TEXT PRIMARY KEY,
  principal_id   TEXT NOT NULL REFERENCES principals(id),
  agent_id       TEXT REFERENCES agents(id),
  period         TEXT NOT NULL,
  cap_tokens     INTEGER,
  cap_usd        INTEGER,
  spent_tokens   INTEGER NOT NULL DEFAULT 0,
  spent_usd      INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX budgets_agent_period ON budgets(agent_id, period);

CREATE TABLE ledger (
  id            TEXT PRIMARY KEY,
  hlc           TEXT NOT NULL,
  host_id       TEXT NOT NULL REFERENCES hosts(id),
  actor_id      TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  tokens        INTEGER NOT NULL,
  usd           INTEGER NOT NULL,
  tool_call_id  TEXT REFERENCES tool_calls(id),
  at            INTEGER NOT NULL
);
CREATE INDEX ledger_actor ON ledger(actor_id);
CREATE INDEX ledger_model ON ledger(provider, model);

CREATE TABLE memories (
  id          TEXT PRIMARY KEY,
  hlc         TEXT NOT NULL,
  host_id     TEXT NOT NULL REFERENCES hosts(id),
  actor_id    TEXT NOT NULL,
  scope       TEXT NOT NULL,
  scope_ref   TEXT,
  title       TEXT NOT NULL,
  body_md     TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX memories_scope ON memories(scope, scope_ref);
CREATE INDEX memories_actor ON memories(actor_id);

CREATE TABLE memory_reads (
  memory_id         TEXT NOT NULL REFERENCES memories(id),
  reader_actor_id   TEXT NOT NULL,
  at                INTEGER NOT NULL,
  PRIMARY KEY (memory_id, reader_actor_id, at)
);
