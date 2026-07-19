# OLL-E — Architecture

This document describes the v0 architecture of OLL-E. It is a working artifact — update it as decisions evolve. See `LOG.md` for the reasoning trail and `VISION.md` for the why.

## Runtime

- **Language**: TypeScript, strict mode.
- **Runtime**: Bun. Single compiled binary per platform via `bun build --compile`.
- **Platforms**: macOS (arm64, x86_64), Linux (arm64, x86_64). Windows deferred.
- **Persistence**: SQLite with Drizzle ORM. WAL mode, foreign keys on. Migrations from commit #1.
- **IPC**: Unix socket (localhost HTTP/WS upgrade-able) between daemon and clients.

## Why these choices

Each foundational choice is downstream of a `VISION.md` principle — the technology serves the principle, never the reverse. If a better technology fits the same principle, it wins; the principle does not move.

- **Single binary, daemon + thin client.** Serves *install anywhere* and *growth/background work is a normal state* — one-command install on any machine; the daemon runs while clients come and go. Bun's `--compile` delivers the binary across macOS and Linux.
- **SQLite per host, not a shared database.** Serves *each host is sovereign* and *federation is the merge of sovereign histories, never a shared central store*.
- **Agent-native markdown, not schema.** Serves *the inhabitants are the primary audience* — the format agents reason in natively wins over the one that reads cleanly to an outside developer.
- **First-claim-wins, not bidding.** Serves *the simplest mechanism that serves the vision wins* — bidding asks inhabitants to model their own and peers' cost; it has not earned that complexity.
- **Ask-up hierarchical approval, not flat escalation.** Serves the *approvals bubble up the tree* invariant and matches how delegation actually works.
- **Git-backed extension rollback, not a versioning DSL.** Serves *the world tolerates and recovers; code is cheap* — full history for almost no code.

## Process topology

Each host runs one long-lived **daemon** process. Any number of **thin clients** attach to it over local IPC.

```
┌──────────────────────────────────────────────────┐
│ daemon (long-lived, per host)                    │
│  ┌────────────────────────────────────────────┐  │
│  │ event bus (in-process pub/sub)             │  │
│  │ store (SQLite)                             │  │
│  │ scheduler (resource caps, token ledger)    │  │
│  │ extension runtime (hot-reloaded from fs)   │  │
│  │ decision inbox router                      │  │
│  │ peer protocol (LAN mesh; see Cross-host)   │  │
│  └────────────────────────────────────────────┘  │
│  IPC socket: ~/.olle/run/olle.sock               │
└──────────────────────────────────────────────────┘
        ▲                 ▲                    ▲
        │                 │                    │
     olle CLI        olle chat REPL        future web UI
```

## Data directory layout

```
~/.olle/
  olle.db                # SQLite: all structured state
  config.toml            # host config (principals, budgets, paths, secrets ref)
  extensions/            # git repo; agents write here; hot-reloaded
    .git/
    .docs/
      extension-api.md   # API reference, synced from the binary at boot (host-actor commit)
    discord/             # starter or agent-authored
      manifest.json
      index.ts
      smoke.ts
    github/
    claude-code/
    ...
  memory/                # markdown notes with role tags; agent-readable/writable
                         # (LOG 2026-04-23) absorbs former goals/ — goals are memories
                         # with role=goal; preferences, skills, knowledge share the surface
    private/<agent>/     # per-agent private
    team/<team>/         # team-shared with attribution
    scratch/<task>/      # ephemeral task working state
  logs/
    olle.log
  run/
    olle.sock            # IPC socket
    olle.pid
  secrets/               # encrypted-at-rest; referenced by name from extensions
```

## Primitives

Six primitives. Everything else is built from them.

### Host

A deployment unit: one daemon process, one data directory, one SQLite store. Owns local resources (CPU, token budget allocations it accepts, tools it exposes) and local sovereignty (runs only its own cells' code).

### Agent

A named logical identity. Has its own memory, tasks, tool access, budget allocation, and permission scope. One host can run N agents; an agent does **not** span hosts in v0. Parent-child relationships (from sub-agent spawning) form an authority delegation tree.

**Humans are agents too** (LOG 2026-04-23 design; landed as code in LOG 2026-05-14). The human is an `agents` row with `owns_money = 1` at the top of the tree: longest-lived, with its own memory and principles, all tiers allowed in `scope.allowTiers`. Its `host_id` records the install host (a v0 compromise — the LOG sketched `host_id = null`, but the human-agent owns no triggers/tasks/tools so it never shows up in "executable on this host" queries and the wider nullable change wasn't worth its blast radius). The ask-up chain is one recursion end-to-end — `askUp` walks parents until either an intermediate agent's `allowTiers` covers the tier (auto-approve) or it reaches an `owns_money` agent (queue to its inbox). "Principal" survives as the `owns_money` property, not a separate primitive.

### Trigger

A source of events. Types in v0:

- `cron` — fires on schedule. **Live** (LOG 2026-07-08): the standing-jobs subsystem persists `type='cron'` rows in the `triggers` table — the first real reader/writer of that schema, which had held zero rows ever — and arms them with `croner` timers. See "Standing jobs" below.
- `poll` — fires when a polled endpoint changes (github issues, RSS, etc)
- `webhook` — HTTP endpoint listens for inbound
- `channel-message` — inbound from a chat adapter (Discord, Telegram, Slack, CLI)
- `internal-emit` — another task emitted an event

### Task

A handler bound to triggers by subscription. When a matching event appears, eligible tasks emit `claim` messages; first claim wins; task executes on the claimer's host. A task is a TypeScript function with a declared scope, required tools, token estimate, and significance tier.

**Lifecycle and durability.** `tasks` is the registration; `task_runs` is the per-execution log. The scheduler writes a `task_runs` row on dispatch (`status=running`), updates it on completion (`succeeded` or `failed`), and on daemon startup `recoverLost()` marks any rows still `running` from a prior process as `lost`. After every handler the scheduler emits one of two events:

- `task.<taskId>.completed` — payload `{ taskId, runId, eventId }`
- `task.<taskId>.failed` — payload `{ taskId, runId, eventId, error }`

Subscribers waiting on a task's outcome listen for these instead of polling `task_runs` or coupling to scheduler internals. The same convention fires for `lost` runs (delivered as `failed` with `error: "lost"`) so resume logic doesn't need to special-case restarts.

Tasks register through one of two surfaces:
- **Extensions** call `api.registerTask(...)` (per LOG 2026-04-22, "Extension = capability; Task = behavior" — extensions hold capabilities, tasks hold behaviors that compose them).
- **Core** wires its built-in tasks at daemon startup against the same scheduler.

Direct agent-authored task files (proposed via the inbox `register_task` action) are deferred per LOG 2026-04-22 line 150 — for now task-only authoring goes through extension packaging.

### Tool

A typed callable capability: `{name, description, inputSchema (JSON Schema), validate?(input), execute(args, ctx)}`. The host↔extension boundary deliberately crosses plain data (JSON Schema) rather than a shared schema-library instance — extensions may author their `inputSchema` by hand or generate it from whichever library they prefer (Zod, Valibot, ArkType, etc.), keeping cross-module library identity out of the boundary. Tools may request permission gates (ctx.ask) and always carry attribution. Every tool call is logged. Tools may also declare `maxResultBytes` to set a tighter cap than the system default for inline output (see "Tool-result truncation"); over-cap output is spilled to durable storage and replaced with a recovery handle.

### Store

Per-host SQLite database. See schema below. Designed for federation — every row carries identity and provenance columns so event-log merge (v1+) is a union+sort, not a reconciliation project.

## Store schema sketch

All IDs are ULID (time-sortable, globally unique without coordination). All user-facing records carry `host_id`, `actor_id`, and HLC timestamp.

```
hosts         (id, hostname, created_at, config_ref)
agents        (id, name, host_id, parent_agent_id, system_prompt, budget_ref, scope, channels, owns_money, created_at)
teams         (id, name, mission_ref, goal_dir, created_at)
team_members  (team_id, actor_id, role, joined_at)

triggers      (id, agent_id, type, config, scope, created_at)
tasks         (id, agent_id, trigger_refs, handler_ref, tier, scope, token_est, created_at)
task_runs     (id, task_id, event_id, host_id, agent_id, status, started_at, ended_at, error)
tools         (id, agent_id, extension_id, schema, scope, created_at)
extensions    (id, name, path, status, last_smoke_at, last_commit_sha)

events        (id, hlc, host_id, actor_id, type, payload_json, parent_event_id)
claims        (event_id, task_id, agent_id, claimed_at, status)
tool_calls    (id, task_id, tool_id, args_json, result_json, tokens_used, started_at, ended_at)
tool_results  (id, hlc, host_id, actor_id, thread_id, tool_name, content, bytes, created_at)
              -- spilled over-cap tool output, recovered via read_tool_result

decisions          (id, owner_agent_id, proposing_agent_id, tier, summary, payload, status, staleness, created_at, resolved_at)
approvals          (decision_id, actor_id, vote, message, at)             -- vote rows on a decision
decision_messages  (id, decision_id, host_id, actor_id, text, at)         -- agent follow-up replies (mail_reply)

budgets       (id, owner_agent_id, agent_id, period, cap_tokens, cap_usd, spent, updated_at)
ledger        (id, hlc, host_id, actor_id, thread_id, provider, model,
               input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, tool_call_id)
              -- tokens-only by design (LOG 2026-04-24); USD derived at the rate in effect at the row's timestamp (LOG 2026-07-09)

memories      (id, hlc, host_id, actor_id, scope, title, body_md, tags)  -- scope ∈ {private,team,scratch}
memory_reads  (memory_id, reader_actor_id, at)
```

Migrations live in `src/store/migrations/`. Every schema change is a numbered migration. No ALTER in application code.

## Event flow

All action originates from events. The lifecycle:

1. A **Trigger** fires → emits an `event` row.
2. Event hits the in-process **bus**. Subscribing **tasks** evaluate eligibility (tag match, scope, capacity, budget, tool availability).
3. Eligible tasks emit a `claim` event. First claim to land wins; losing claims are dropped.
4. Winning task executes: calls tools, each call goes through the permission gate, writes to ledger + log.
5. Task emits result events (completion, failure, produced artifacts).
6. Downstream tasks subscribing to those events may fire. Cascade continues.

The bus is in-process within a host. Cross-host event propagation (v0 mesh) is handled by a **bridge** that mirrors events to peer hosts over a stable wire protocol. See "Mesh" below.

## Standing jobs

A standing job is a cron'd natural-language instruction — how the agent makes itself useful without being prompted (LOG 2026-07-08, the push-first program). It is the first live use of the `cron` trigger type and the `triggers` table.

**Determinism in the substrate, cognition only inside the turn.** The cron fires in code; the *only* stochastic part is the agent turn the fire wakes. `src/schedule/` (`createCronScheduler`) arms `croner` timers — at boot via `loadAndArm()` (reads every `type='cron'` row) and live via the `schedule.armed` / `schedule.cancelled` bus events the `schedule_*` tools publish, so a job scheduled mid-run starts firing without a restart. The tool and the scheduler couple through the bus, not a shared handle. This shape is a deliberate rejection of LLM-turn "heartbeats," which hallucinate actions and make the schedule itself nondeterministic; the schedule is a fact in the substrate, and the agent reasons only about *what to do* when woken.

**Fire path and delivery contract.** `fireJob` publishes a durable `chat.input` `{ text: instruction, standingJob: true, jobId }` addressed to the job's agent on a deterministic thread id (reusing the mail-wake seam in `src/agent/chat.ts`), plus a durable `schedule.fired` audit event. The thread id encodes the destination so a channel bridge can route the resulting turn's output with no prior inbound message on the thread (`src/schedule/thread.ts`).

**Fresh thread per fire is the default.** A standing job's value is fresh-at-fire-time (same reasoning as the misfire policy below), so each fire opens a new thread carrying no transcript from prior fires — `fireJob` mints a per-fire ULID and folds it into the thread id. Rows with no `threadMode` field (every pre-change row) are fresh with no migration: `parseCronConfig` normalizes a missing/malformed `threadMode` to `"fresh"` at parse time. A job that opts into `threadMode: "shared"` lands every fire on its one continuing thread instead — for jobs whose value *is* the running context, at the cost of a prompt that grows with every fire. Fresh-fire inputs explicitly mark their thread disposable. After each turn the agent loop retains only the newest 100 completed disposable threads per agent, evicting older runtime state and snapshots; daemon startup applies the same cap to snapshots left by a crash. Active, shared, and ordinary threads are never evicted by this policy. Durable events remain the audit surface.

- `cli` → fresh `cron:<jobId>:fire:<fireId>`, shared `cron:<jobId>` (local terminal thread)
- `discord` → fresh `discord:<channelId>:fire:<fireId>:job:<jobId>`, shared `discord:<channelId>:job:<jobId>`
- `telegram` → fresh `telegram:<chatId>:fire:<fireId>:job:<jobId>`, shared `telegram:<chatId>:job:<jobId>`

The fire segment sits *before* `:job:<jobId>` on channel ids so the segment stays terminal: cloned bridge extensions in real users' `~/.olle` parse the jobId with an end-anchored `/:job:([^:]+)$/`, and that regex must keep capturing the jobId (never the fireId). Cli ids carry no such parse contract, so the fire segment simply appends — the asymmetry is deliberate.

Bridges parse any `^(discord|telegram):<id>:` thread they hold no stored inbound route for and deliver channel-only (no `reply_to`) — one parse contract (`CHANNEL_THREAD_PREFIX_RE`) shared by tool, scheduler, and bridges; the fire segment leaves capture group 2 (the channel/chat id) untouched.

**Delivery is audited.** After attempting to deliver a turn's output, each bridge publishes a durable `delivery.succeeded` or `delivery.failed` event — payload `{ channel, threadId, destination, jobId?, error? }`, `jobId` parsed from the `:job:` thread suffix. A standing job whose digest lands nowhere is no longer invisible: the failure sits in `query_events` / `olle events` next to the `schedule.fired` that caused it. The convention is part of the bridge contract; future channel bridges emit the same pair.

**Misfire policy: skip missed-while-down.** Arming computes the next *future* fire; a daemon asleep across a scheduled time does not replay it on boot. A standing job's value is fresh-at-fire-time, so a missed fire is dropped rather than replayed stale — no catch-up burst.

New durable events: `schedule.armed`, `schedule.cancelled`, `schedule.fired`.

## Hierarchical authorization (ask-up)

Every strategic/vision action goes through approval. The protocol:

1. An agent wants to do something in tier `strategic` or `vision`.
2. It emits a `request-approval` event addressed to its **parent agent** (or, if it has no parent, to its **root principal's decision inbox**).
3. Parent receives. Evaluates against its declared `delegated_authority`:
   - If within delegated authority → replies `approve` or `deny` down the chain.
   - If beyond → forwards `request-approval` to its own parent. Preserves the full provenance chain.
4. Chain terminates at a root agent, which posts to its principal's decision inbox.
5. Replies flow back down the path, reconciled with the originating task (which has been doing other work in the meantime).
6. Staleness deadline on each request; expired requests are logged and dropped per the originating task's `on_stale` policy.

In a solo setup (one root agent, one human), the chain collapses to one hop — inbox.

## Decision inbox

Per-principal queue of items requiring a decision. Delivered through the principal's declared channel(s) — `olle inbox` CLI subcommand, Discord DM, email, etc.

Each item:

```
{
  id, proposing_agent, tier, summary,
  cost_estimate: { tokens, usd, wall_time },
  payload,                   -- concrete action
  rollback_plan,
  staleness_deadline,
  options: ["approve", "deny", "modify"],
  channel_refs                -- where it was delivered
}
```

Reply modes:
- `approve` → task resumes with the intended action, if still relevant
- `deny` → task drops action gracefully, may propose an alternative
- `modify` → principal edits the payload; approved-with-changes
- `ignore` → staleness fires; `on_stale` policy runs

Agents never block waiting. Every inbox-originated task continues other work while waiting.

Two surfaces close the loop after resolution. The **from-idle wake** (LOG 2026-04-26) fires a synthetic `chat.input` on the proposing agent's `mailbox:<agentId>` thread when `decision.resolved` lands — a small, bounded thread the agent processes cheaply. The **on-next-turn sidebar** (LOG 2026-04-27) renders unread resolutions in the per-turn system prompt for whichever thread the proposer next runs in, so the close-loop reply lands where the user is watching without forcing a turn on the originating thread when the resolution itself arrives — important when that thread is large. The high-water mark for "unread" is in-memory and initialized to loop start on restart, so pre-restart resolutions are not automatically re-rendered. Pull-side `mail_list({direction:"out", includeResolved:true})` is the durable audit.

**Resolution executes, it isn't just a doorbell.** `respond()` flips the decision status and emits `decision.resolved`; that alone wakes the proposer but mutates no state. For `grant_scope` — the auto-proposal a denied tool call files (LOG 2026-04-22 permissions) — a dedicated executor (`src/permissions/grant.ts`, LOG 2026-07-08) subscribes to `decision.resolved` and, on `approved` / `modified`, merges the `{tool, tier}` into the target agent's `agents.scope`, gated by `narrowsScope` against the approver (you can't grant authority you don't hold). It publishes `scope.granted` or `scope.grant-rejected`. Before this executor, approving a `grant_scope` did nothing and the retried call was denied identically — the "approve-hang" bug. `denied` / `stale` / freeform resolutions stay wake-only; only `grant_scope` has a concrete action to execute (the 2026-04-27 rejection of generic decision-resumption still holds for everything else).

## Budget and token ledger

Budget is owned by **principals**. Principals allocate portions to **agents**. Every LLM call (and, eventually, paid tool operation) writes a `ledger` row carrying token counts. Thresholds (80%, 100%) auto-post inbox items. Exceeding cap → agent pauses spending, continues non-paid work.

Budget allocation (raising cap, creating new allocation) is always an inbox decision — never self-authorized by the agent.

**Tokens-only ledger; USD as derivation** (LOG 2026-04-24). Ledger rows store `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, and `thread_id`. They do **not** store USD. Per-row USD would be a snapshot at insert time — provider prices change, snapshots rot, and an agent reading its own ledger would see false physics. The physical unit is tokens; USD is computed via `src/llm/pricing.ts`, the single source of truth. Prices are **effective-dated** (LOG 2026-07-09): a provider rate change appends a new era with its `effectiveFrom` rather than editing the old one, and every derivation prices a row at the rate in effect at that row's timestamp — so history never re-values when rates move. Editing an era in place is reserved for fixing a rate that was recorded wrong (a bug is not a price change).

Budgets stay USD-denominated because principals back them with real money. The asymmetry resolves at decrement time: the ledger module computes USD via `priceTokens(model, usage)` and accumulates into `budgets.spent_usd`, snapshotting USD into the *budget* (one number per agent×period) instead of every ledger row. The cap-comparison stays meaningful even when prices later shift; agents see cost as physics; nobody is lying to anybody.

Ledger is keyed `(owner_agent_id, agent_id, provider, model, period)` so team-level or mesh-level rollups in v1+ are schema-free; the new `(actor_id, at)` and `(thread_id, at)` indexes serve the observability layer.

## Provider detection ladder and CLI-brain mode

At chat bringup the daemon picks the LLM backend by walking a ladder (`tryBringChatAgentUp`, `src/daemon/daemon.ts`):

1. **Secret-file API key** — `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` on disk → **API mode** (the router + adapters described above).
2. **Env-var API key** — no file key but the key is in `process.env` → import it to the secrets file (mode 0600) and proceed as API mode. Silent by design: it's the user's own key on their own box, and one source of truth stays the file. `readSecret` never consults env.
3. **`claude` CLI probe** (`createClaudeCliBrain().probe()`) → **CLI mode** with claude.
4. **`codex` CLI probe** → CLI mode with codex.
5. **Disabled** — a reason naming what was tried (needs-login vs not-installed) and the fix.

**CLI-brain mode.** When no API key is present but a logged-in coding-agent CLI is, an agent turn is **whole-turn-delegated** to that official harness instead of driving `runAgent`. The CLI owns its inner LLM↔tool loop; OLL-E's own tools reach it over **MCP** via the bridge: the harness spawns `olle mcp-bridge --agent <id> --thread <id> [--socket <path>]` (an MCP stdio server, `src/cli/mcp-bridge.ts`), which proxies `tools/list` and `tools/call` back into the daemon's `tools.list` / `tools.call` IPC RPCs. Those RPCs call a `ToolDispatch` (`src/mcp/dispatch.ts`) — the headless twin of the chat loop's per-tool dispatch: same scope/tier gate (`checkTool`), same input validation, redaction, secret-scrub, and truncation, and the same durable `chat.tool-call` / `chat.tool-result` / `tool.denied` audit events on the same thread. The dispatch is deliberately NOT per-thread-loadout-aware — the loaded set is a prompt-context economy for the API path; a CLI harness carries its own context budget, and execution never consulted it.

Delegated turns **record tokens but bill $0**: the CLI reports usage, the ledger writes it under a `*-cli` provider, and `priceTokens` prices any `*-cli` provider at $0 — a subscription turn spends the plan, not metered dollars (subscription physics; see LOG 2026-07-11). The tradeoff: OLL-E's SOUL/cache economy and exact API accounting don't apply on the CLI path — usage is whatever the harness self-reports.

**Session resume is in-memory, per thread.** The CLI's own session id is held on the `Thread` and resumed on the next turn (no re-sent system prompt). A daemon restart drops it; the next turn opens a fresh CLI session and re-sends a rendered transcript of prior messages. When a real API key later lands (`secret.set`), the daemon tears the CLI loop down and re-brings-up in API mode — the CLI was always the fallback, not the choice.

**One effective-model resolution for display and execution.** `model.get`, `observability.self`, and `query_self` all report the daemon's effective-model resolution (`modelControl.effective` — the chosen model clamped to the live backend, else that backend's own default), the same function the chat loop freezes at thread birth (LOG 2026-07-11). In CLI mode they therefore report the brain's model, never the persisted API default.

**Auth-loss keep-alive.** A delegated turn whose CLI reports lost auth publishes durable `chat.cli-auth-lost { provider, loginHint? }` alongside the usual `chat.error`. The daemon flips `status.chat` to a needs-login reason without tearing the loop down; the next successful `chat.turn-end` clears it. Bounded — no auto-retry timer; a re-login makes the next turn work.

## Caching

Prompt caching is on by default through the Anthropic adapter (`src/llm/anthropic.ts`). Four ephemeral cache breakpoints, all dumb-but-effective:

- **Stable system segments** — caller passes a `SystemSegment[]` and marks which segments get `cache_control`. The chat loop uses this form to keep the stable identity + principles cached while the volatile mailbox sidebar sits *after* the breakpoint and never invalidates the prefix.
- **Last tool** — caches the entire tools block as one unit. Tools change less often than the conversation.
- **Last user message** — caches the conversation prefix through that point. Subsequent turns' append-only growth reads through the cache.

Strategy lives in core for v0; revisions flow through the standard propose-up loop (agent observes inefficiency in its own ledger via `query_my_usage`, files an inbox proposal, ask-up chain reaches the principal who edits the strategy and ships a new binary). A hot-loadable cache-strategy extension is `[DEFERRED-to-v0.1]` until enough proposals to justify the abstraction land.

Self-modification thrashes the cache by design — when an agent rewrites its identity or principles, the prefix invalidates. Intra-thread hit rates will be high; cross-self-modification rates lower. That's the cost of being a habitat where inhabitants reshape themselves.

## Observability

`src/observability/` exports six pure query functions: `usageStats`, `budgetStatus`, `runHistory`, `threadInventory`, `agentSelf`, `recentEvents`. Both surfaces below call into this layer, so they see the same numbers.

- **Agent-callable core tools** (`src/tools/observability.ts`): `query_my_usage`, `query_my_budget`, `query_my_runs`, `query_my_threads`, `query_self`, `query_events`. Defaults are scoped to the calling agent (`ctx.actorId`) so vague queries never leak unrelated data.
- **CLI subcommands** (`src/cli/run.ts`): `olle stats`, `olle cache`, `olle runs`, `olle threads`, `olle events`, `olle inspect agent <id>`. Thin wrappers over the same `observability.*` IPC methods.

**Rule (AGENTS.md vision-check):** every CLI command has a parallel core tool. The CLI is the human's tool surface, parallel to an agent's tool surface — never a privileged read path. "Humans are events" governs the write side; the analogous read-side rule is "no privileged human dashboard."

Cache fields ride on `chat.usage` and `chat.turn-end` event payloads turn-by-turn so subscribers (CLI tail, future bridges, downstream observability dashboards) see cache stats live without polling the ledger.

## Tool catalog and lazy loading

Tool schemas (name + description + JSON Schema) cost LLM context every turn. With a growing extension surface, always-carrying every schema bloats the prefix and amplifies cache-write cost whenever self-modification invalidates it. So tool schemas ship deferred by default; agents pull what they need on demand.

**Always-loaded core (`alwaysLoaded: true` on `ToolDef`):** five tools, in the LLM's tool list every turn — `load_tools`, `query_self`, `mail_list`, `memory_search`, `memory_write`. The orientation + mailbox + memory primitives most strategic turns need; `memory_write` joins the read-half so any turn worth remembering can record without a `load_tools` round-trip first (LOG 2026-04-28 — the soul-seeding bootstrap interview makes this load-bearing). `unload_tools` is also always-loaded but isn't conceptually "core" — it's the partner to `load_tools`. Everything else (extension authoring, observability beyond `query_self`, delegation, secrets, scratch, memory lineage, host context, extension-registered tools) is deferred.

**The catalog** lives in the stable system segment alongside principles. It's a pure function of the registered tool set: rich category prose ("when to reach for these") + minimal `name — short clause` per tool, grouped by category. Categories: `loadout`, `observability`, `memory`, `delegation`, `mailbox`, `scheduling`, `extension authoring`, `secrets`, `host context`, `scratch`. Extension-contributed categories render prose the extension ships itself: the manifest's optional `catalog` field (`{tagline, blurb, tools?}`, agent-native markdown; malformed → warn-and-drop) binds to the categories the extension's own tools declare. Precedence per category: core `CATEGORY_PROSE` wins → extension catalog prose (first-loaded on conflict) → default blurb. Per-tool clause order: `shortClause` → manifest `tools` one-liner → description. The catalog does NOT include "loaded right now" markers — that state lives in the tools block (cached separately) and would otherwise invalidate the catalog inside the cached identity prefix.

**Loading and unloading:**

- `load_tools(names)` — adds names to the per-thread loaded set, returns each tool's schema in the result so the agent can read it the same turn. Schemas appear in the LLM's tool list on the next inner round-trip; calls to those tools succeed from then on.
- `unload_tools(names)` — drops names from the loaded set. Always-loaded core tools cannot be unloaded.

Both report unknown / no-op cases per-name without aborting the call. Cost: a `load_tools` round-trip is one extra LLM call; the schema then rides every subsequent turn until unloaded.

**Live tool surface within a turn.** The chat loop's `getTools()` re-reads `opts.extensions.tools()` at the start of every inner round-trip, so tools registered/unloaded mid-turn appear in (or disappear from) both the LLM's tool list and the dispatch table on the very next call. The catalog stays turn-stable on purpose — it lives in the cached system prefix; an agent that just registered a tool already knows it exists. (See LOG 2026-04-26 for the full reasoning.)

**Auto-load on register.** `register_extension` adds the just-registered extension's contributed tools to the calling thread's loaded set and surfaces their schemas in the result (mirroring `load_tools`). The agent already paid the write+smoke+register cost with intent to use; forcing a separate `load_tools` hop is the kind of papercut habitat philosophy is supposed to delete. Always-loaded tools and already-loaded names are reported but not re-added. `unload_tools` remains the cheap path back if the agent regrets the inflation.

**Seeded from active extensions at thread birth** (LOG 2026-06-17). Auto-load-on-register only fires at the register *moment*; a restart drops the in-memory loaded set, so without this a fresh thread would see an already-installed extension's tools as name-only catalog lines and re-guess (or re-`load_tools`) their schema every session. So `getOrCreate` seeds each new thread's loaded set with every currently-active extension's contributed tools (`seedExtensionTools`, `src/agent/chat.ts`). Same reasoning as auto-load-on-register, extended across the restart: a registered extension is a capability the agent chose with intent to use, and that intent outlives the process. The schemas land in the separately-cached **tools block** (not the identity/catalog prefix), so a larger active set costs a marginally bigger cache-read per turn and never invalidates the expensive prefix; the set is bounded by active-extension count, which specialist-delegation keeps small at scale. Core deferred tools (delegation, secrets, observability beyond `query_self`) are *not* seeded — they're occasional reaches, not installed capabilities, and stay name-only until `load_tools`.

**Per-thread, not per-agent.** The loaded set lives on the in-memory `Thread` (`src/agent/chat.ts`) and is runtime state, not durable identity. Restart drops it; a fresh thread starts with the always-loaded core plus the active-extension seed above. This intentionally treats the *explicit* loadout (whatever the agent itself `load_tools`ed beyond the seed) as conversational working state — if an agent decides "I always want core tool X loaded," it writes a principle, and per-agent durable loadout is `[DEFERRED-to-v0.1]` pending real ledger evidence of recurring loads.

**Hot-reload pruning.** When an extension is unloaded between turns, any of its tools still in a thread's loaded set drop silently and a `tool.loaded-dropped` event fires. The next turn's tools block reflects the removal; the agent sees the warning event in `query_events` if it asks.

**Why no progressive catalog folding.** As tool counts grow, the simple-tier catalog grows too. Earlier draft proposed B/C/D fold tiers (collapse taglines → categories → degenerate to flat keyword search). Rejected for v0: the parallel specialist-delegation plan offers a cleaner answer to scale — agents specialize by domain, each agent's catalog stays small, out-of-domain work is `delegate_to(specialist)` rather than catalog inflation. If that doesn't pan out, fold tiers and `ToolSearch`-style discovery resurrect for v0.1+.

## Tool-result truncation

Tool calls return arbitrary-sized payloads, and a single fat result inflates W (cache_creation) for the whole rest of the conversation — every subsequent inner round-trip re-caches the prefix it landed in. Per LOG 2026-04-27 a single ~60k-token `github_list_issues` result accounted for ~25% of one session's bill.

The runtime caps every tool result at a system byte limit before it enters the message history. Outputs above the cap are spilled to the `tool_results` table and replaced inline with a stable preview block:

```
<persisted-output>
Output too large (243.0KB). Full output saved to: tool-result/<tool_use_id>

Preview (first 8.0KB):
<head of the content>
...
Use read_tool_result(handle="<id>", offset=N, limit=N) to fetch more.
</persisted-output>
```

The agent recovers the rest via `read_tool_result(handle, offset?, limit?)` — always-loaded so the recovery path costs no extra round-trip. Slices are clamped at a per-call max; the response carries `hasMore` and `nextOffset` for pagination.

**Two caps, both runtime-enforced:**

- **Per-call cap** — `DEFAULT_MAX_RESULT_BYTES = 50_000`. Tools may declare a tighter `maxResultBytes` on their `ToolDef`; the system cap is the upper bound. Sensitive-output tools (`sensitiveOutput: true`) are never spilled — the redaction substitute already collapses to a constant.
- **Per-message aggregate cap** — `DEFAULT_MAX_MESSAGE_BYTES = 200_000`. Catches the "N parallel tools each at 49KB" failure mode the per-call cap leaves open. Largest blocks spill first until the message fits.

**Stable replacement state.** `Thread.truncationState` carries a `Map<tool_use_id, preview>` — once a result has been spilled, every later rendering of the block uses the byte-identical preview from the map. Without this, replaying the same conversation would produce different preview text each turn (different size string, different timestamp) and the prompt-cache prefix would invalidate. We pay 1.25× per cache write — a single replacement-instability bug erases the entire reason to truncate.

**Schema.** `tool_results (id, hlc, host_id, actor_id, thread_id, tool_name, content, bytes, created_at)`, indexed by `(thread_id, created_at)` and `(actor_id, created_at)`. The `id` is the LLM-emitted `tool_use_id` — already globally unique per invocation and embedded in the preview, so no separate ULID. `INSERT OR IGNORE` makes the persist idempotent under retries.

**Why a row, not a file.** Federation merge is a union+sort over rows; a blob on disk is a separate sync target. The full content sits next to events and ledger rows in one store, with the same `host_id`/`actor_id`/`hlc` provenance every other user-facing record carries.

## Memory tiers

Three scopes, enforced at write/read:

- **private** — owned by one agent; only readable by that agent.
- **team** — readable by any cell in the team; writes carry authorship and timestamp; corrections are visible, attribution preserved.
- **scratch** — per-task ephemeral working state; purged on task completion or timeout.

Default for new writes: **private**. Promoting private → team is operational. Deleting/overwriting team memory authored by another actor is strategic (inbox item).

Memory reads are logged (`memory_reads`) so the agent can ask "who knew what when."

**Memory is identity** (per LOG 2026-04-23). Each row is part of the persistent self of its `actor_id` — preferences, philosophy, in-flight goals, grown capabilities (tools/extensions) and lived knowledge all live on this one surface. Role tags on each row differentiate posture (`identity`, `principle`, `goal`, `preference`, `skill`, `knowledge`, `culture`, `thinking-model`, `reasoning-effort`, etc.) — goals no longer live in a separate directory or primitive. The `identity` and `principle` roles are load-bearing: `identity`'s presence/absence on the root agent flips the daemon's boot prompt between bootstrap-interviewer and normal-orientation (LOG 2026-04-28 — soul-seeding), and both roles render into the cached system segment via the SOUL pipeline (LOG 2026-04-24). The `thinking-model` role is load-bearing the same way: the agent picks the model it reasons in via `set_thinking_model` (a validating front door to `memory_write`), and the daemon resolves that memory into each thread's `model` — model selection is identity, not host config (LOG 2026-06-08). The `reasoning-effort` role is its sibling: `set_reasoning_effort` records how hard the agent thinks (off/low/medium/high/xhigh/max), resolved into the thread's `effort`, which the Anthropic adapter maps to adaptive thinking + `output_config.effort`. Both are opt-in (absent memory = adapter default / no thinking) and both resolve **per-thread, frozen at thread creation** (LOG 2026-06-08) — a switch lands on the next new thread without a daemon restart, while active threads keep what they started with (no mid-conversation swap, prompt cache stays warm). Every memory write is a `memory.*` event; the `memories` table is a materialized projection of the event log, reconstructible by replay (federation = event-log merge, peers sync events). Beliefs carry a depth per the resistance model — seed beliefs from parents arrive pre-stamped heavy; lived beliefs accrue weight through use. Change is always possible; shifting a deep belief takes evidence proportional to its weight. No locks, just inertia.

Open calls tracked for implementation (see LOG 2026-04-23):

- Parent-read of child private memory (private = strictly-solo vs ancestor-readable) — `[DEFERRED-to-v0.1]`.
- Scratch binding to `task_runs.id` so `recoverLost()` sweeps orphaned scratch — `[DEFERRED-to-v0.1]`.

## Extension authoring loop

The unified flow for adding capabilities — channels, tools, trigger types, anything:

1. **Propose**: agent posts a decision-inbox item describing the purpose, dependencies, secrets required, cost estimate.
2. **Approve**: principal replies `approve`; secrets (API tokens) come in via a reply or a separate `olle secret set` call.
3. **Author**: agent writes files into `~/.olle/extensions/<name>/`. Uses a starter template (if one matches) or generates from scratch. Auto-committed to the local git repo with actor attribution.
4. **Smoke test**: extension exports `smokeTest()` — a read-only or idempotent probe. Runs automatically. Must pass **if present**; a missing `smoke.ts` is legal and passes — deliberate, for tool-only extensions with nothing external to probe. Write one whenever the extension touches secrets, config, or a wire format.
5. **Hot-load**: on explicit `register_extension` (or boot discovery) the daemon validates the manifest and loads into runtime — there is no fs watcher. If load throws or smoke fails → extension is left on disk, marked inactive, inbox item emitted with error detail.
6. **Live**: extension now participates in event routing; its tools/triggers available.

Manifests are the visible authority boundary for extensions. `callsTools` lists cross-extension tool calls; `eventReads` lists bus event types the extension may subscribe to; `eventWrites` lists event types the extension may emit imperatively (via `api.publish` or task-handler `emit`). The optional `catalog` field carries the extension's own catalog prose (see "Tool catalog and lazy loading"); `config` is a known, unparsed passthrough extensions re-read from disk. Validation warns on unknown manifest keys — a typo'd `eventRead` (singular) surfaces in the `write_extension` result instead of as a permission denial two steps later — but never fails on them. A broader event surface is authored as a normal manifest edit and passes through the same smoke + hot-load path.

Trigger declarations are themselves authority statements for their `type` field — a `registerTrigger({ type: "channel-message", ... })` is the manifest-visible promise that this extension emits `channel-message` events from that trigger. Re-listing the trigger type in `eventWrites` is harmless but not required; a trigger can never emit anything other than its declared type, so the cross-check would only ever catch manifest drift, not an actual unauthorised emit (LOG 2026-04-27).

### Core bundle (shipped in binary, not an extension)

- LLM provider adapters (Anthropic, OpenAI) via API key config
- CLI-brain backends + MCP bridge (`src/llm/cli-brain/`, `src/mcp/`, `src/cli/mcp-bridge.ts`) — when no API key is present, a logged-in `claude`/`codex` CLI backs the chat loop via whole-turn delegation; see "Provider detection ladder and CLI-brain mode"
- Pricing config (`src/llm/pricing.ts`) — single source of truth for token prices; effective-dated eras, USD computed on read at the rate in effect at spend time (`*-cli` providers price at $0 — subscription physics)
- Store / event bus / scheduler
- Decision-inbox router
- CLI chat handler (channel-of-first-contact)
- Scratch filesystem tool
- Meta-tools: `write_extension`, `run_smoke_test`, `register_extension`, `revert_extension`, `read_extension_file`, `extension_history`, `query_host_context`. `read_extension_file` also reaches `.docs/` (the boot-synced API reference); `write_extension` cannot — the reference is read-only to agents
- Loadout meta-tools: `load_tools`, `unload_tools` — bring deferred tool schemas into / out of a thread's context (see "Tool catalog and lazy loading")
- Observability tools: `query_my_usage`, `query_my_budget`, `query_my_runs`, `query_my_threads`, `query_self`, `query_events` — agents read their own world; CLI uses the same query layer
- Tool-result recovery: `read_tool_result` — fetch a slice of a spilled tool output by handle (see "Tool-result truncation")
- Scheduling: `schedule_task` / `schedule_list` / `schedule_cancel` — the agent's front door to the cron subsystem; register/list/cancel standing jobs (category `scheduling`, tier `operational`, self-only target, ~50/agent cap). See "Standing jobs"
- Self-config: `set_thinking_model` / `set_reasoning_effort` — the agent picks the model it reasons in and how hard it thinks; persist as `thinking-model` / `reasoning-effort` memories, resolved per-thread and frozen at thread creation (a switch applies to the next new thread, no restart). The resolution is clamped to the live backend (LOG 2026-07-11, model display truth): a choice whose provider has no loaded adapter degrades to the backend's default instead of bricking new threads, and reapplies unchanged once its provider's key lands — the memory persists; only the effective model bends. The two are chosen independently, so `src/llm/models.ts` holds per-model capability facts (supported effort levels, output ceiling) and `runAgent` clamps the resolved `(model, effort, max_tokens)` together — an unsupported pair degrades instead of bricking the loop. A model switch smoke-tests the candidate (1-token probe via the adapter) before committing, so a priced-but-unserved model can never be stored; the `OLLE_MODEL` env override (`resolveBootModel`) is the human rescue hatch that outranks the memory at boot for a muted agent (LOG 2026-06-08). Thinking is visible (LOG 2026-07-08): effort requests `display: "summarized"` (the Opus 4.7+ default `"omitted"` returns thinking blocks with empty text), and streamed reasoning surfaces as a non-durable `chat.thinking-delta` event — visualization only, like `chat.assistant-delta`; the durable record is the thinking block inside the assistant message, persisted anyway for the signature echo. Thinking cost needs no separate ledger column: the API folds thinking into `output_tokens` (already recorded exactly), and prior-turn thinking blocks are stripped server-side, never billing as input

### Starter templates (shipped read-only; agents clone and modify)

Eleven ship today. Each carries a `SETUP.md` (a fourth `files` key) documenting what it does, the exact secrets and how to acquire them, and an install→set-secret→register→smoke walkthrough written for the agent to narrate conversationally. `install_starter` / `list_starters` return `hasSetupGuide` and nudge reading it before asking for secrets — so onboarding a channel is a conversation, not a guess.

- `discord` — bot gateway + message send/receive; hardened with RESUME + backoff, heartbeat-ACK zombie detection, 429 retry
- `discord-communication` — wake-word chat behavior over the discord gateway; standing-job channel routing (lazy `getOrDeriveRoute`)
- `telegram` — long-poll `getUpdates` adapter; markdown→Telegram-HTML rendering with plain-text fallback; `telegram_send` (fence-aware chunking, reply_parameters), `telegram_stream` (native draft streaming in DMs, throttled edit loop in groups, presence timers, retry_after obedience), `telegram_typing`, `telegram_fetch_context`
- `telegram-communication` — structural port of `discord-communication` for Telegram, plus live replies: presence fires on `chat.input` publish, `chat.assistant-delta` streams through `telegram_stream` on a 1s latest-state-wins tick, turn-end finalizes in place with `telegram_send` as the never-drop fallback
- `github` — webhook receiver + API calls (issues, PRs, comments); `github_activity` since-based delta tool
- `freshrss` — Google Reader API (ClientLogin); `freshrss_unread` / `freshrss_feeds` (operational), `freshrss_mark_read` (strategic)
- `web` — one `web_fetch(url)` tool (operational): SSRF-guarded fetch (private/link-local/CGNAT/loopback ranges blocked, DNS pre-resolution, manual redirect re-validation), hand-rolled HTML→markdown, 2MB download cap + `maxResultBytes` spill. No `web_search` — search needs a provider key and ranking opinions; separate proposal
- `local-llm` — adapter for a local OpenAI-compatible server (llama.cpp, vLLM, LM Studio): `local_llm_generate` chat completion (auto-picks the model when the server serves exactly one, surfaces `reasoning_content` from thinking models) and `local_llm_models` (both operational); `baseUrl` in config, optional Bearer key via the `LOCAL_LLM_API_KEY` secret. Deliberately no SSRF guard — `baseUrl` is operator config aimed at localhost, never tool input. A tool, not a brain swap: the chat loop's provider adapters stay core
- `slack` — Socket Mode adapter: one outbound WebSocket, no public endpoint (NAT-friendly). Two tokens — app-level `xapp-` opens the socket, bot `xoxb-` makes Web API calls. Ack-first-then-process per envelope (~3s deadline); zero-gap socket refresh via a generation counter; last-inbound-frame staleness as the zombie detector. `slack_send` (`markdown_text` with plain-text fallback, chunked, threaded, ~1 msg/s/channel), `slack_stream` (native `chat.startStream`/`appendStream`/`stopStream` tier in-thread with recipient ids, else a throttled `chat.update` edit loop ≤1/1.2s), `slack_fetch_context` (in-memory ring buffer — `conversations.history` is Tier-1 throttled to 1 req/min for non-Marketplace apps since 2025), `slack_react`. Echo-filtered on `bot_id`/`bot_message`/self; `source: "slack"` on payloads
- `cron-trigger`
- `claude-code` — subprocess invocation
- `http-webhook-trigger` (v0.1), `codex` (v0.1)

`channel-message` payloads carry `source: "discord"|"telegram"|"slack"` and each bridge filters on it, so a two-bridge host never relays its own cross-channel echoes. The generic RSS starter was cut — FreshRSS subsumes it.

### Rollback

`~/.olle/extensions/` is a git repo. Every agent write is auto-committed. On crash (threshold: 2 failures within 5 minutes, configurable), the extension auto-disables and the principal gets an inbox item:

> "Extension `github` crashed on last 2 invocations. Last working commit was `<sha>` (3 edits ago). Options: revert / keep-disabled / inspect."

CLI: `olle extension history <name>`, `olle extension revert <name> [--to <sha>]`.

Unload also revokes the extension's `api`: references captured in timers or promise chains throw `extensions: "<name>" was unloaded; re-register before acting` (revoked trigger emits drop silently) instead of publishing as a dead registration. Corollary: `unload()` runs after revocation and must not call api methods.

## MicroVM isolation (post-v0)

Agent-authored extension code is **untrusted by construction** (LOG 2026-07-18). It runs inside a per-agent Firecracker microVM, not the daemon process. The invariant it enforces: **secrets never enter the guest, and the guest has no way to reach the network except through a host-mediated broker.** This is the deterministic environmental boundary that holds when model judgment doesn't — Anthropic's containment lesson ("if credentials never enter the sandbox, they can't be exfiltrated, regardless of the cause"). Per-agent VMs are the tier Anthropic reserves for untrusted code (Claude Cowork's full-VM-with-vsock), not over-engineering.

### Topology

```
daemon (unprivileged host)                    per-agent microVM (no net device)
┌───────────────────────────┐                 ┌──────────────────────────────┐
│ extension host / registries│ vsock 5000 ↔   │ socat → /run/olle/ctl.sock   │
│ scheduler (task_runs)     │ UDS (control)   │  guest shim (bun):           │
│ ToolDispatch + gates      │◄───────────────►│   ExtensionApi RPC stubs     │
│ VM supervisor             │                 │   in-guest smoke runner      │
│ credential broker ────────┼ vsock 5001 ◄────┤   trigger sockets/timers     │
│   SSRF floor + allowlist  │ UDS (egress)    │   fetch/WebSocket → broker    │
│   placeholder substitute  │                 │   /data (scratch, own blkdev)│
└───────────────────────────┘                 └──────────────────────────────┘
```

Transport is virtio-vsock exposed host-side as Unix domain sockets under `~/.olle/run/vm/<vmKey>/` (Bun can't open AF_VSOCK, so socat bridges vsock↔guest-UDS). The existing line-JSON IPC protocol (`src/ipc/protocol.ts`) rides the channel, made bidirectional: a frame with `method` is a request to the receiver, a frame with `ok`/`stream` is a response. The guest gets **no virtio-net device and no network driver** — deny-all egress by construction.

### Identity binding

Each VM's control UDS lives in a per-VM directory the supervisor mints, so every connection on it *is* that VM. Guest-originated `ext.call-tool` carries no self-asserted `agentId` — the host stamps the placement's owning agent before the existing `checkTool` gates. This structurally closes the trust gap the CLI mcp-bridge path still carries (a caller asserting its own agentId, `src/mcp/dispatch.ts`); the mcp-bridge half stays a follow-up.

### Credential broker

The one instance per VM is the only egress path. Contract, in order: parse URL → **SSRF floor** (private/loopback/link-local ranges refused regardless of allowlist; classifier lifted from the web starter into `src/net/ssrf.ts`) → **allowlist** match against a loaded manifest's `egress.hosts` (else durable `egress.denied`) → **DNS resolve + connect to the pinned IP** (closes the TOCTOU rebinding gap) → **substitute** `olle-secret://<NAME>` placeholders in URL/headers/text-body/WS-text-frames, only where `<NAME>` is declared for the pinned host → perform the request host-side (TLS terminates in the daemon). An unroutable placeholder is left intact and fails closed (upstream 401). Because the guest has no network device, the broker always makes the upstream TLS call itself — so masking needs no TLS-terminate flag and domain fronting is structurally impossible, both improvements over a bolt-on sandbox proxy.

WebSockets are broker-owned: the guest `WebSocket` is an RPC stub; the broker holds the real socket, substitutes placeholders in outbound text frames (Discord's identify frame is plain JSON), streams inbound frames back, and closes every socket on VM teardown — relocating the trigger sockets/timers that used to live in daemon module scope.

### Manifest authority — `egress`

The visible authority boundary for network access, peer to `callsTools`/`eventReads`/`eventWrites`:

```
egress?: Array<{ hosts: string[]; secrets?: string[]; mode?: "placeholder" | "guest" }>
```

`hosts` are exact or single-level-wildcard patterns; `secrets` bound to those hosts are the extension's `injectHosts` (Anthropic's term for the same idea). `mode` defaults to `placeholder` (broker substitutes at egress); `guest` delivers the real value in-VM (still egress-pinned) for HMAC/binary-frame protocols where substitution can't work. A secret declared in `secrets` but no `egress` entry is a placeholder that can never be substituted — a lint warning, not a failure. `requiresHost: true` marks an extension that cannot isolate (spawns host binaries — e.g. the claude-code starter); flipping it to host mode is a strategic-tier inbox decision persisted as `extensions.isolation='host'`.

### Placement and events

`placementFor(agentId, manifest)` returns a `vmKey`; v1 returns the agentId (one VM per agent), and the pooling future changes only that function plus a `vms.vm_key` lookup. Guest-emitted events cross via `ext.publish` → host-enforced `assertEventWrite` → `bus.publish` with fresh identity and `actorId = extensionId` — **published, not injected**: a guest is a subordinate execution context the host fully owns, not a federation peer (contrast the mesh's `bus.inject`). Subscriptions stream to the guest scrubbed of secret values.

### Backend ladder

`VmBackend` abstracts the hypervisor: **Firecracker** (Linux + KVM, the built tier) → CI-only bare subprocess (no isolation, flagged) → **in-process legacy** (no backend available; emits durable `extension.unisolated`, surfaced in `olle status`). macOS (vfkit over Virtualization.framework) and a real bubblewrap fallback tier are designed behind this interface and deferred until Linux microVM is proven. The guest is a Linux image (custom vmlinux with no network drivers + ext4 rootfs carrying bun, socat, and the shim) built via nix or docker-export, versioned under `~/.olle/vm/images/`, not embedded in the daemon binary.

## Cross-host mesh (v0)

**Claim model only. No remote code execution.** The substrate is the most-agentic shape we can ship (LOG 2026-05-13): peer-mesh, leaderless arbitration, every cell sovereign. Centralization is a behavior an extension grows on top, not a shape the binary forces.

### Wire

JSON over WebSocket. LAN `ws://` only in v0; `wss://` and relays are deferred. Authentication is per-team HMAC-SHA256 keyed on a shared secret minted at `team_create`. The wire envelope (`src/mesh/envelope.ts`):

```
{ proto: "olle.v0", envelopeId, teamId, fromHostId,
  kind: "event"|"hello"|"welcome"|"heartbeat"|"catchup_request"|"catchup_chunk"|"peer_left"|"error",
  event? | payload?, sentAt, hmac }
```

HMAC over canonical JSON of the envelope minus the `hmac` field. Bad HMAC / proto / teamId mismatch → drop, close link, emit `mesh.envelope-rejected`.

### Topology

Any team member can mint an invite (`team_invite` → bearer code = `base64url(JSON{proto,teamId,inviteId,addr,secret})`). The joiner (`team_join`) dials the inviter, sends a signed `hello`, receives `welcome { peerHostId, peerSet }`, and then dials every other peer in the set. O(N²) fully-connected mesh is fine for v0 team sizes.

Every `hello` carries the sender's own `listenerAddr`. The receiver `addPeer`s the dialer using that addr, opening a reverse outbound link. Both sides end up with one inbound and one outbound link to every peer, and catchup-on-reconnect fires on whichever side restarts (catchup is triggered on outbound `connected` transitions only — without the reverse link, an inviter restart leaves no path for the inviter to pull the joiner's gap).

Heartbeat every 15s; peer goes stale after 60s of silence; reconnect backoff at 1s, 2s, 5s, 15s, 60s, cap. TCP close → reconnect with the same schedule.

### What crosses, what stays

Outbound (local → bridge) forwards a durable event only if its `payload.teamId` matches an active local team and (for memory events) `payload.scope === "team"`. Inbound mismatch → drop + `mesh.scope-violation`. Concretely:

- **Crosses:** `memory.wrote` (scope=team), `memory.forgotten` (scope=team), claimable work events with `payload.teamId`, `task.claim`, `team.peer.*`.
- **Stays:** private/scratch memory, chat turns, secrets, tool results, decisions, ledger rows, runs — anything without `payload.teamId`.

### Honest event identity

Cross-host events keep their original `id, hlc, hostId, actorId, payload, parentEventId, toAgentId, threadId, parentThreadId, createdAt`. The bus exposes `inject(event, { remote: true })` for this (LOG 2026-05-14 — the "honest event identity" slice replaced the old payload-tagged `bus.publish` re-mint path). Persist is `INSERT OR IGNORE` and stubs a `hosts` row for unknown peer host ids. Dispatch carries a delivery context `{ remote: boolean }` to handlers; the flag is never written into payload.

Federation is event-log merge: every peer keeps its own copy, the memory projector reads `event.hostId` not `bus.hostId`, and rows round-trip without lying about provenance.

### Leaderless claim window

Per LOG 2026-05-13: no origin-host arbiter. When a team-scoped claimable event arrives on any peer, the scheduler (`src/scheduler/claims.ts`):

1. Persists a `team_claims` row with `status = "intent"` and emits a `task.claim` event.
2. Arms a 100ms timer keyed on `event.id`. Default is `claimWindowMs` in `SchedulerOptions`; configurable for tests.
3. On timer expiry: reads all intent rows for the event, picks the lowest `(claim_hlc, claiming_host_id, claim_id)` tuple lex-wise.
4. If lowest is ours → `status = "won"`, run the task. Else → `status = "lost"`, don't run.

Partition handling: if a lower-tuple claim arrives *after* our timer fired and we're already running, mark the row `split_brain`, emit a durable `mesh.claim-split-brain` event, but **do not abort the running task**. Mid-run abort is messier than the duplicate; v0 acknowledges partition risk honestly.

The single-host fast path (events without `payload.teamId`) bypasses the window — non-team claimable events execute immediately via the legacy `claims` table.

### Catchup on reconnect

Per-peer-link watermark `team_peers.last_received_event_id`. On (re)connect:

1. Send `catchup_request { teamId, sinceEventId }` (the local watermark).
2. Peer scans its store for team-scoped events with `id > sinceEventId`, paginated at 200 per chunk (default; `catchupChunkSize` configurable).
3. Peer sends `catchup_chunk { events, hasMore }`; recipient calls `bus.inject` on each, updates watermark to the highest id seen, requests the next chunk if `hasMore`.

Live events arriving during catchup deduplicate through `bus.inject`'s in-memory seen set + `INSERT OR IGNORE` at the SQL layer. Whichever peer Alice reconnects to first feeds her the missing tail — no global sequencer.

### Memory tombstones

`memory_tombstones (memory_id PRIMARY KEY, hlc, host_id, actor_id, forgotten_at)`. On `memory.wrote`, the projector first checks tombstones: if one exists with `hlc >= event.hlc`, the write is rejected (the memory was forgotten after this write). On `memory.forgotten`, the projector upserts the tombstone (later HLC wins on conflict) and deletes the live row if `event.hlc > existing.hlc`.

LWW + tombstone-wins. No version vectors, no CRDTs. Three rules, one table.

### Trust model

v0 trust is "the friend you handed the code to." Bearer code = credential, not single-use ticket: single-use is enforced at the inviter on the same `inviteId`, but anyone with the code holds the team secret. Leak = rotate the team secret (rotation is `[DEFERRED-to-v0.1]`). No per-actor wire signatures; multi-trust within a team is also `[DEFERRED-to-v0.1]`.

### What does **not** cross

- Task handler code / function invocation
- Local tools
- Per-host scratch or filesystem paths
- Per-agent private memory
- Decision-inbox rows (schema-unblocked by the LOG 2026-05-14 principals collapse; cross-host sync deferred to a follow-up slice)

### Deferred for v0.1+

- TLS / `wss://`; relays; mDNS; hole-punch — LAN-only assumption is the v0 bar.
- Per-team secret rotation.
- Per-agent / per-actor wire signatures.
- Cross-host decision-row sync (schema unblocked, transport deferred).
- Group E2E encryption (pairs with relays).
- Per-extension task-fingerprint registry (the `task_fingerprint` field is opaque string in v0).
- Conflict-visibility UI (LWW + attribution covers v0).
- Sandboxed remote code execution.

### Claim protocol — quick reference

1. Task emitted on host A with `payload.teamId` + `claimable: true`.
2. Event bridged to peers (scope filter passes).
3. Each peer's scheduler registers intent (`task.claim` event, `team_claims` row).
4. Window closes; lowest `(claim_hlc, claiming_host_id, claim_id)` wins.
5. Winner runs the task locally on its own tools and budget. Result events flow back.
6. Winner failure → next claim window if the event is re-emitted; no automatic retry in v0.

## CLI surface

```
olle run                    # foreground daemon (dev)
olle daemon install         # register with launchd/systemd (mac/linux)
olle daemon uninstall
olle daemon status

olle chat [agent]           # REPL connected to an agent
olle tail                   # stream events
olle inbox                  # list/respond to decisions

olle agent list|new|pause|resume
olle team create|join|leave|status
olle extension list|history|revert|disable|enable
olle secret set|list|remove
olle budget show|set

# Observability — same query layer agents use via query_my_*
olle stats   [--agent X] [--thread X] [--since 1h]   # token + USD rollup
olle cache   [--agent X] [--thread X] [--since 1h]   # cache hit ratio rollup
olle runs    [--agent X] [--status X] [--since 1h]   # task_run history
olle threads [--agent X] [--limit N]                 # threads per mailbox
olle events  [--agent X] [--type T] [--thread X]     # one-shot event query
olle inspect agent <id>                              # agent identity surface

olle upgrade                # pull new binary, run migrations
```

All commands are thin RPC wrappers over the daemon's IPC endpoint. Every observability subcommand has a parallel agent-callable core tool — the CLI is the human's tool surface, never a privileged read path.

## Safety and observability

- Every tool call and memory read is logged with actor and timestamp.
- Every extension write is a git commit.
- Every decision-inbox item is auditable via `olle inbox history`.
- Budget overruns pause spending but never crash.
- Crashed extensions auto-disable and notify; they do not take down the daemon.
- Circuit breakers (rate limits, repeated-failure halts) are independent of significance tiers.

## Seams intentionally unbuilt in v0

- Quorum-of-principals flow (pathway exists in schema; v0 treats all decisions as single-principal)
- Web UI (IPC socket is ready for it)
- Sandbox beyond process boundary
- Natural-language-only config (files still exist; agent edits them)

These are not regrets; they are where we deliberately stopped.
