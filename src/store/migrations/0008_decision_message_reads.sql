-- OLL-E migration 0008: decision_message_reads — per-reader "I saw this" log.
--
-- mail_reply (LOG 2026-04-27) added the agent → principal close-loop
-- channel. To deliver visibility — "you have unread replies on D1" —
-- we need per-reader state tracking what's been seen.
--
-- Mirrors the `memory_reads` shape: weak ref on reader_actor_id (humans
-- federate, retired-agent cleanup shouldn't cascade through history),
-- composite primary key so re-marking is idempotent. Federation-ready
-- for multi-principal / quorum cases without schema change.
--
-- Single-principal v0 reads always carry the root principal as reader.
-- The CLI/TUI auto-marks on view (entering `olle inbox show <id>` or
-- selecting a row in the TUI). Listings carry per-decision unread counts
-- so the user sees the badge before drilling in.

CREATE TABLE decision_message_reads (
  message_id       TEXT NOT NULL REFERENCES decision_messages(id),
  reader_actor_id  TEXT NOT NULL,
  at               INTEGER NOT NULL,
  PRIMARY KEY (message_id, reader_actor_id)
);
CREATE INDEX decision_message_reads_reader ON decision_message_reads(reader_actor_id);
