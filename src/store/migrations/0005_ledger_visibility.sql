-- OLL-E migration 0005: tokens-only ledger + caching/threading visibility.
--
-- Two changes that move together:
--
-- 1) Drop ledger.tokens and ledger.usd. Both were misleading.
--    - `tokens` lumped input+output into one number, hiding the asymmetry
--      between cheap input and expensive output and erasing the cache
--      story entirely.
--    - `usd` was a per-row snapshot at insert time. Provider prices change;
--      the snapshot becomes wrong; agents reading their own ledger see
--      false physics. Vision: "constraints feel like physics" — the unit
--      of physics here is tokens, not dollars. Dollars are a derivation
--      computed from tokens × current price (see src/llm/pricing.ts).
--
-- 2) Add visibility columns the new observability layer needs:
--    - input_tokens / output_tokens         — split the lump.
--    - cache_read_tokens                    — cache hits (cheap reads).
--    - cache_creation_tokens                — first-time prefix marks (priced premium).
--    - thread_id                            — per-thread rollups; threads
--      are first-class since the mailbox-drainer collapse and most cache
--      questions are per-thread ("did THIS conversation reuse its prefix?").
--
-- SQLite has supported DROP COLUMN since 3.35 (2021); Bun ships 3.45+, so
-- we do the drops directly. Order matters in SQLite: drop columns first,
-- then add new ones (no semantic dependency, but keeps the ALTER plan
-- minimal). New indexes after.
--
-- Budget enforcement: budgets stay USD-denominated (humans back them with
-- real money, USD is the human-relevant unit). At decrement time the
-- ledger module computes USD = priceTokens(model, usage) and accumulates
-- into budgets.spent_usd. This snapshots USD into the BUDGET (one number
-- per agent×period, easy to update if needed) instead of into every
-- ledger row (millions of rows, immutable). Honest physics in the ledger;
-- pragmatic accounting in the budget.

ALTER TABLE ledger DROP COLUMN tokens;
ALTER TABLE ledger DROP COLUMN usd;

ALTER TABLE ledger ADD COLUMN input_tokens          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ledger ADD COLUMN output_tokens         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ledger ADD COLUMN cache_read_tokens     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ledger ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ledger ADD COLUMN thread_id             TEXT;

CREATE INDEX ledger_actor_at  ON ledger(actor_id, at);
CREATE INDEX ledger_thread_at ON ledger(thread_id, at);

-- Indexes the observability module relies on. Existing indexes cover the
-- "list all of this thing" patterns; these cover "list recent for actor".
CREATE INDEX task_runs_agent_started ON task_runs(agent_id, started_at);
CREATE INDEX events_actor_hlc        ON events(actor_id, hlc);
