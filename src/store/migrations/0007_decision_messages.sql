-- OLL-E migration 0006: decision_messages — agent follow-up replies on a decision.
--
-- The principal -> agent direction has chat.input + the wake mechanism.
-- The agent -> principal direction has mail_propose for "I need a vote."
-- This table fills the missing edge: agent posts a non-voting message
-- back into a decision's conversation thread (typically a "done"
-- report after executing an approved payload, or a blocker note if
-- something prevented execution).
--
-- Separate from `approvals` because the schema there requires a vote
-- (NOT NULL); muddling it with non-vote rows would mean either making
-- vote nullable (loses the type guarantee) or inventing a sentinel
-- vote value (loses semantic clarity). One purpose-built table per
-- conversational role keeps both readable.
--
-- Rendered together: `olle inbox show <id>` reads the proposal +
-- approvals + decision_messages and shows them in chronological order.
-- The agent reads the same view through `mail_list` enrichment so the
-- parallel-tool-surface rule holds.

CREATE TABLE decision_messages (
  id           TEXT PRIMARY KEY,
  decision_id  TEXT NOT NULL REFERENCES decisions(id),
  host_id      TEXT NOT NULL REFERENCES hosts(id),
  -- actor_id is a weak ref (like events.actor_id, like to_agent_id) — mesh
  -- can carry messages whose author isn't local; retired-agent cleanup
  -- shouldn't cascade through the conversation history.
  actor_id     TEXT NOT NULL,
  text         TEXT NOT NULL,
  at           INTEGER NOT NULL
);
CREATE INDEX decision_messages_decision ON decision_messages(decision_id, at);
