-- OLL-E migration 0002: task_runs durability.
-- Records one row per scheduler dispatch so daemon restarts can mark
-- still-running rows as `lost` and operators can audit execution
-- history. The `tasks` row remains the registration; task_runs is the
-- per-execution log.

CREATE TABLE task_runs (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  event_id      TEXT NOT NULL REFERENCES events(id),
  host_id       TEXT NOT NULL REFERENCES hosts(id),
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  status        TEXT NOT NULL, -- queued | running | succeeded | failed | lost
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  error         TEXT
);
CREATE INDEX task_runs_task ON task_runs(task_id);
CREATE INDEX task_runs_status ON task_runs(status);
CREATE INDEX task_runs_event ON task_runs(event_id);
