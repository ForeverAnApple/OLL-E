# OLL-E — LOG archive

Entries moved out of `docs/design/LOG.md` to keep the running log focused on actionable or load-bearing architectural decisions. Entries here are decisions that have shipped, stabilized, or were tactical fixes — preserved verbatim for audit, no longer expected to shape new design work.

When archiving an entry, copy the date-stamped section verbatim from `LOG.md` and add a one-line note in this file's index. Do not edit moved entries; reversal still happens via a new entry in the live log.

---

## Index

- [2026-04-22 — Scheduler wired into the daemon; `task_runs` durability lands](#2026-04-22--scheduler-wired-into-the-daemon-task_runs-durability-lands) — shipped infrastructure; the load-bearing lens (done-event convention `task.<id>.completed/failed`, `task_runs.status` lifecycle, `recoverLost()` on startup) is captured in `ARCHITECTURE.md` under "Task lifecycle and durability."
- [2026-04-22 — Open seams left after vision lock (drafting-phase decisions)](#2026-04-22--open-seams-left-after-vision-lock-drafting-phase-decisions) — orphaned bullets from the vision-lock session; the listed concerns (service-manager lifecycle, CLI chat REPL UX, starter template source, IPC protocol shape, peer bridge skeleton) have all been resolved by shipped code or live `[DEFERRED-]` markers elsewhere.
- [2026-04-26 — Caller identity for `retargetThread` (resolved same day)](#2026-04-26--caller-identity-for-retargetthread-resolved-same-day) — same-day promote of a `[DEFERRED-to-v0.1]` entry; cleanup, no live implication.
- [2026-04-28 — `threadInventory` cache stats sourced from `chat.turn-end`, not `chat.usage`](#2026-04-28--threadinventory-cache-stats-sourced-from-chatturn-end-not-chatusage) — bug-fix; established that `chat.usage` is intentionally non-durable (the live stream) and `chat.turn-end` is the durable record.
- [2026-04-28 — Inbox UI/UX: read tracking, unread badges, visibility-first show view](#2026-04-28--inbox-uiux-read-tracking-unread-badges-visibility-first-show-view) — shipped UI/UX iteration; auto-mark-on-view + per-reader unread state landed.
- [2026-04-28 — Migrations 0001-0008 collapsed into a single `0001_init.sql`](#2026-04-28--migrations-0001-0008-collapsed-into-a-single-0001_initsql) — pre-v1 schema collapse; one-time housekeeping. Schema changes are append-only migrations from this point forward.

---

## 2026-04-22 — Scheduler wired into the daemon; `task_runs` durability lands

Pre-existing drift diagnosed and closed. `src/scheduler/scheduler.ts` has shipped since `9cf0c1b` (scheduler + ledger + claim seam) but was never instantiated in `daemon.ts` — only two tests called `createScheduler`. The chat-first MVP ran everything through bus subscriptions + the chat handler, so the scheduler sat as test-only code. No prior entry parked it; this was drift, not a decision.

### Decided

- **Scheduler runs in the daemon.** Constructed alongside bus/store/ledger; `scheduler.recoverLost()` fires once at startup. Extension host takes a `scheduler` + `defaultTaskAgentId` so `api.registerTask(...)` goes through the same codepath as core-registered tasks.
- **`task_runs` table for execution durability.** New table (migration 0002). One row per dispatch: `status ∈ {queued, running, succeeded, failed, lost}`. The scheduler transitions the row inline. `recoverLost()` marks orphaned `running` rows as `lost` on restart so operators can audit what was interrupted.
- **Root agent always exists.** Previously `ensureAgentRow(store, "root")` only ran when `ANTHROPIC_API_KEY` was set (chat agent path). Moved unconditional so extensions can register tasks even on a chat-less host. Chat agent now borrows the same row.
- **Done-event convention.** Every handler run ends with `task.<taskId>.completed` or `task.<taskId>.failed` (including `lost` runs, delivered as `failed` with `error: "lost"`). Subscribers waiting on a task don't poll `task_runs` or couple to scheduler internals.
- **Task registration surface.** `api.registerTask(...)` added to `ExtensionApi`. Extension-registered tasks get namespaced ids (`ext:<extensionName>:<localId>`) so collisions across extensions are impossible.

### Deliberately deferred

- **Agent-direct `register_task` meta-tool / inbox action.** LOG 2026-04-22 line 150 already parked task-only authoring behind extension packaging for v0. The `register_task` action type in the self-mod vocabulary (LOG line 109) stays blessed-but-unbuilt. Revisit when an agent actually wants to author a task file without wrapping it in an extension.
- **Cancellation, pause, resume of in-flight runs.** Nanoclaw and openclaw both have this; v0 doesn't need it. `task_runs.status` has room for `cancelled` when we get there.
- **Time-domain scheduling (run at timestamp T).** The `cron-trigger` starter owns the timer inside the extension, emits `cron.fire`, and a task subscribes. Consistent with "extension = capability" — the scheduler stays reactive.

### Why

The async-by-default framing in VISION ("an event-driven, self-modifying, async-by-default agent system") means the scheduler isn't optional infrastructure; it's load-bearing. `task_runs` durability is the minimum the "system tolerates and recovers" clause demands — before this, a daemon crash mid-handler left no record at all. The done-event convention keeps resume logic on the bus rather than forcing subscribers to walk SQL. Every other alternative we considered (shared in-memory Promise registry, separate TaskFlowRecord primitive à la openclaw, callback tables) either broke "humans-are-events" symmetry or invented a new primitive where composition of existing ones sufficed.

### Survey: what this does *not* touch

- No change to the extension authoring loop (`write_extension`, `register_extension`, smoke gate, git rollback).
- No change to the inbox / ask-up / decision primitives.
- No change to the chat agent's meta-tools.
- No new concepts in VISION or AGENTS.md — every change above descends from existing framing.

---

## 2026-04-22 — Open seams left after vision lock (drafting-phase decisions)

Orphaned bullets that lived at the tail of `LOG.md` without a section header — they appear to have been a continuation of the vision-locking session that never got sliced into a proper dated entry. Preserved verbatim here because git history shows they have always been present in this shape; relocated during the 2026-05-06 archive pass when the live LOG was tightened. The listed concerns are all resolved or have live `[DEFERRED-]` markers elsewhere.

Original wording:

> These are deliberately un-landed as of the vision-lock date. Drafting-phase decisions only.
>
> - **Exact service-manager lifecycle.** `olle daemon install` shape on mac (launchd) vs linux (systemd). Whether auto-start-on-login is opt-in during install or always prompted.
> - **CLI chat REPL UX.** Since minimal-core means CLI chat is the only channel until other extensions grow, its quality matters more than it would otherwise. What does first-contact look like? What's the prompt? What commands are slash-invokable? Deferred until first drafting of the chat client.
> - **Starter template source.** Bundled in the binary or fetched from a well-known URL at first-run? Bundled is simpler and works offline; fetched is smaller binary. Lean: bundled for v0, consider fetch-on-demand in v1.
> - **Exact IPC protocol.** JSON-over-unix-socket is fine; might want subscribe-streams for event tailing. WebSocket upgrade path for future web UI.
> - **Peer bridge skeleton.** The interface is clear; the first implementation needs to decide whether v0 ships any real cross-host code at all, or whether the "two-laptop demo" uses a local-mock bridge for the first pass.

Where they landed (as of 2026-05-06):
- *Service-manager lifecycle* — `olle daemon` subcommands shipped; install ergonomics still open but no longer drafting-phase.
- *CLI chat REPL UX* — shipped iteratively; see LOG `2026-04-28 — olle chat polish`, `2026-05-05 — Mid-turn user input folds`, and the `2026-05-05 — Self-chosen agent display name` entries.
- *Starter template source* — bundled in binary for v0 per `src/starters/templates.ts`; fetch-on-demand stays a v0.1+ consideration.
- *IPC protocol* — JSON-over-unix-socket shipped; WebSocket upgrade is a v1+ web-UI seam in `ARCHITECTURE.md`.
- *Peer bridge skeleton* — stubbed for v0; mesh seams listed under `ARCHITECTURE.md` "v1+ mesh seams."

---

## 2026-04-26 — Caller identity for `retargetThread` (resolved same day)

The `retarget_thread` meta-tool now passes `ctx.actorId` through to `manager.retargetThread`, so `thread.retargeted` events attribute to the agent that requested the redirect rather than to the manager process. `callerId` is required on the manager API; the previous `agentFromCall()` placeholder is removed. The earlier same-day [DEFERRED-to-v0.1] entry is retired — promoted in the same review pass that flagged the dead-weight parameter.

---

## 2026-04-28 — `threadInventory` cache stats sourced from `chat.turn-end`, not `chat.usage`

`query_my_threads` was reporting `cacheHitRatio: 0` on every live thread in production. Root cause: `threadInventory` folded cache fields from `chat.usage` events queried from the durable events table, but `chat.usage` is published with `durable: false` (it's the per-call live stream for CLI tail / future bridges, intentionally not persisted — see `chat.ts` `kind === "usage"` branch). The events table never has `chat.usage` rows, so the rollup was always empty. The pre-existing observability test passed because its fixture published `chat.usage` with `durable: true`, which doesn't match production.

**Decision: read cache fields from `chat.turn-end` instead.** That event is already durable, fires once per turn (one row per turn instead of one per inner round-trip), and carries `inputTokens` + `cacheReadTokens` + `cacheCreationTokens` + `totalTokens` directly. Considered the alternative (flip `chat.usage` to `durable: true`): rejected because it would write 5–10× more event rows for the same information and `chat.usage` is by-design transient — its job is the *live* stream, the durable record is `chat.turn-end`. The fix was a four-line change in `threadInventory` plus the field-name update (`cacheReadInputTokens` → `cacheReadTokens` to match the turn-end payload shape).

The all-time cache-ratio rollup in `usageStats` was unaffected — it reads the ledger, which is correctly populated. The artifact users were seeing in `query_my_threads` (0 ratio on a thread that was clearly hitting cache) is gone.

---

## 2026-04-28 — Inbox UI/UX: read tracking, unread badges, visibility-first show view

Manual-test of `mail_reply` (LOG 2026-04-27) revealed the next visibility gap: the principal had no way to know an agent had replied. `olle inbox list` showed the same row as before; nothing distinguished "agent posted a follow-up" from "no change since I last looked." Read tracking was the obvious fix; the rest of the cut leaned into "visibility-first" — colored glyphs, unread badges, generous whitespace, `[NEW]` markers on previously-unread replies in the show view, and a sectioned layout that gives the proposal, payload, and reply thread their own breathing room.

**The shape that landed:**

- **Migration `0008_decision_message_reads.sql`** — `(message_id, reader_actor_id, at)` composite PK plus `reader_actor_id` index. Same shape as `memory_reads`. Federation-ready: per-reader rows mean future quorum-of-principals or team-shared inboxes work without schema change. Single-principal v0 always carries the root principal as reader.
- **Inbox APIs** — `markDecisionRead(decisionId, readerActorId)` (idempotent, returns count newly marked), `readMessageIdsFor(decisionId, readerActorId)` (Set, used to render `[NEW]` flags), and `unreadCountsByDecision(decisionIds, readerActorId)` (bulk Map for listing badges, two queries instead of N+1).
- **IPC enrichment** — `inbox.list` adds `unreadReplyCount` per row. `inbox.get` adds `messages: [...]` with each carrying `read: boolean` (state captured *before* this call's side-effects) AND auto-marks all replies read for the requester. `markRead: false` opt-out for observability peeks. Default reader is the root principal. Same handler also resolves `actorName` for each message via the existing enrichment pattern, so the CLI doesn't print 26-char ULIDs where a name fits.
- **`olle inbox list`** — colored status glyphs (cyan-bold when unread replies are waiting, otherwise yellow=open / green=approved / red=denied / cyan=modified / gray=stale), bold-cyan `(N new)` badge appended to summaries with unread, and a header line showing total + total-unread when non-zero. Generous summary width.
- **`olle inbox show <id>`** — restructured: title block (id + double-rule), key-value pairs (status / tier / from / to / age / stale / resolved) on indented lines, wrapped summary with breathing room, `── payload ──` rule before the JSON, `── replies (N) · M new ──` rule before the threaded replies. Each reply gets a timestamp, author name, optional `[NEW]` cyan tag, and indented body with soft-wrap. Auto-marked-read by the IPC handler.
- **TUI** — list rows now show the cyan-bold glyph + `(N new)` badge when unread. Preview pane gained a replies block at the bottom rendered in the same shape as the CLI show. Selection-changes fire an async `inbox.get` (auto-marks read, refreshes the listing); listing's unread badge drops on next refresh. Detail-fetch dedupes against the cached selection so navigation doesn't thrash IPC.

**The four design calls:**

1. **Auto-mark on view.** Considered explicit `mail_ack` (more agentic-feeling, principal in control). Rejected for the principal-facing surface: the principal's role here is *consumer*, not author. Forcing them to ack each reply would be the same nagging-discipline anti-pattern we rejected for the agent-facing sidebar (LOG 2026-04-27). Opening the decision IS reading it. The `markRead: false` flag exists for the rare programmatic peek. Symmetric to how the agent-side sidebar auto-acks on render.
2. **Unread state per-reader, not per-message.** The state needing per-reader split is "did *I* see this," not "has anyone seen this." `decision_message_reads` is the right shape; a `read_at` column on `decision_messages` would either lock us to single-reader or muddle the semantics. Cost: one more table; gain: the federation seam is honest.
3. **Cyan-bold for "needs attention."** ANSI color choices land on convention: yellow=open (waiting), green=approved (done well), red=denied, cyan=modified, gray=stale. Cyan-bold reserved for "you have unread replies" because it's the signal we want eye-catching without being alarming (red would imply error). Single-color signaling beats glyph-substitution for accessibility — even on color-blind terminals the badge text still reads clearly.
4. **One-call list view.** `inbox.list` could have stayed plain and `unreadReplyCount` could ride a separate `inbox.unreadCount` call. Rejected: the listing shows N rows and would do N round-trips, defeating the rendering UX work. Bulk enrichment server-side keeps the listing snappy and the CLI/TUI dumb.

**One `[DEFERRED]` item:**

- **Mark-unread / per-message granular state.** Today the principal gets one knob: viewing the decision marks ALL replies on it read. No way to revisit a single reply as "I want to come back to this." Considered: `mail_unread(decisionId, messageId?)` tool, or a TUI hotkey. Skipped because no concrete need yet — the search/scan affordances cover "find that reply again." **Resurrect when:** a real workflow needs revisit-tracking on individual messages (likely paired with bridges that push notifications, where re-surfacing matters).

---

## 2026-04-28 — Migrations 0001-0008 collapsed into a single `0001_init.sql`

Pre-v1; no installed-user upgrade path to preserve. The eight historical migrations were a development artifact (each one a real schema decision logged separately) rather than a contract with users. Carrying them forward means every fresh install walks through CREATE → ALTER → CREATE → ALTER replays of the same end state, plus the reasoning-trail noise of the historical names is now in `_migrations` instead of `LOG.md` where it belongs.

The compacted `0001_init.sql` defines the final-state CREATE TABLE / CREATE INDEX statements (matching `schema.ts`). `migrate.ts` now imports only the single migration. Verified by the full test suite (280 tests pass against the new schema). The reasoning behind each table's shape stays in `LOG.md` (search for the table name); the SQL file just records what's in the store today.

**Cost we paid:** historical commits' migration-numbered filenames no longer resolve at HEAD. The git history is the audit trail; `git log -- src/store/migrations/` reconstructs the per-decision sequence if anyone needs it.

**Resurrect when:** v1 ships and we have installed users. From that point forward, schema changes are append-only migrations again, never collapsed.
