-- OLL-E migration 0006: tool_results — durable storage for over-cap tool
-- output, replaced inline by a preview + handle so the conversation prefix
-- stays bounded.
--
-- Why a table and not a file: federation is event-log + row merge (every
-- user-facing record carries host_id, actor_id, hlc). A blob on disk is
-- another sync target; a row drops into the same merge path as everything
-- else. Lookup by tool_use_id (PRIMARY KEY) is the hot path — read_tool_result
-- comes through with the id from the inline preview marker.
--
-- The id is the LLM-emitted tool_use_id, not a freshly minted ULID. It's
-- already globally unique per invocation and the agent already knows it
-- (the preview includes it), so we skip a layer of indirection.

CREATE TABLE tool_results (
  id           TEXT PRIMARY KEY,
  hlc          TEXT NOT NULL,
  host_id      TEXT NOT NULL REFERENCES hosts(id),
  actor_id     TEXT NOT NULL,
  thread_id    TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  content      TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX tool_results_thread ON tool_results(thread_id, created_at);
CREATE INDEX tool_results_actor  ON tool_results(actor_id, created_at);
