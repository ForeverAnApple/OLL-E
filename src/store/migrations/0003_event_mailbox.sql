-- OLL-E migration 0003: events carry mailbox routing fields.
--
-- The core collapse: "chat session" and "task claim queue" and "decision
-- inbox" are three names for the same thing — a mailbox attached to an
-- addressable identity. Every event grows:
--
--   to_agent_id       -- which agent's mailbox this event is addressed to
--                        (nullable = broadcast/untargeted, back-compat)
--   thread_id         -- correlation id spanning a conversation or a
--                        spawned work stream; transport-agnostic
--   parent_thread_id  -- when a child agent starts a thread to do work
--                        spawned from a parent thread, this links them so
--                        the parent can correlate progress / results
--
-- Indexes are the two read patterns every mailbox query runs: "give me
-- this agent's inbox" and "give me this thread's history".

-- to_agent_id is a weak reference (like actor_id) — we don't enforce FK
-- because mesh events may address agents that don't exist on this host
-- yet, and retired-agent cleanup shouldn't cascade through the event log.
ALTER TABLE events ADD COLUMN to_agent_id TEXT;
ALTER TABLE events ADD COLUMN thread_id TEXT;
ALTER TABLE events ADD COLUMN parent_thread_id TEXT;

CREATE INDEX events_mailbox ON events(to_agent_id, hlc);
CREATE INDEX events_thread  ON events(thread_id, hlc);
