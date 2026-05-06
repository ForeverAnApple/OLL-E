-- Per-agent self-chosen handle. Cache of "the most recent
-- role=display-name memory body" maintained by the memory projector
-- (LOG 2026-04-23: memory is identity). Nullable; CLI/event renders
-- fall back to agents.name when unset.

ALTER TABLE agents ADD COLUMN display_name TEXT;
