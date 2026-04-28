# OLL-E — Architecture

This document describes the v0 architecture of OLL-E. It is a working artifact — update it as decisions evolve. See `LOG.md` for the reasoning trail and `VISION.md` for the why.

## Runtime

- **Language**: TypeScript, strict mode.
- **Runtime**: Bun. Single compiled binary per platform via `bun build --compile`.
- **Platforms**: macOS (arm64, x86_64), Linux (arm64, x86_64). Windows deferred.
- **Persistence**: SQLite with Drizzle ORM. WAL mode, foreign keys on. Migrations from commit #1.
- **IPC**: Unix socket (localhost HTTP/WS upgrade-able) between daemon and clients.

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
│  │ peer protocol (v1+ mesh; stub in v0)       │  │
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

**Humans are agents too** (per LOG 2026-04-23). The principal is represented as an `agents` row at the top of the tree: `host_id=null` (no executing host), real-money-backed, longest-lived, with its own memory and principles. The ask-up chain is one recursion end-to-end — no terminal "now we hit a principal" special case. `principals` collapses into `agents` via a future migration; v0 retains `principals` as a compatibility row until the collapse lands. "Principal" becomes a property ("this agent owns real-world money"), not a separate primitive.

### Trigger

A source of events. Types in v0:

- `cron` — fires on schedule
- `poll` — fires when a polled endpoint changes (github issues, RSS, etc)
- `webhook` — HTTP endpoint listens for inbound
- `channel-message` — inbound from a chat adapter (Discord, CLI, future Slack)
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
principals    (id, display, channels, created_at)
agents        (id, name, host_id, parent_agent_id, system_prompt, budget_ref, scope, created_at)
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

decisions     (id, principal_id, proposing_agent_id, tier, summary, payload, status, staleness, created_at, resolved_at)
approvals     (decision_id, actor_id, vote, message, at)     -- for quorum/ask-up chains

budgets       (id, principal_id, agent_id, period, cap_tokens, cap_usd, spent, updated_at)
ledger        (id, hlc, host_id, actor_id, thread_id, provider, model,
               input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, tool_call_id)
              -- tokens-only by design (LOG 2026-04-24); USD is computed from current prices

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

## Budget and token ledger

Budget is owned by **principals**. Principals allocate portions to **agents**. Every LLM call (and, eventually, paid tool operation) writes a `ledger` row carrying token counts. Thresholds (80%, 100%) auto-post inbox items. Exceeding cap → agent pauses spending, continues non-paid work.

Budget allocation (raising cap, creating new allocation) is always an inbox decision — never self-authorized by the agent.

**Tokens-only ledger; USD as derivation** (LOG 2026-04-24). Ledger rows store `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, and `thread_id`. They do **not** store USD. Per-row USD would be a snapshot at insert time — provider prices change, snapshots rot, and an agent reading its own ledger would see false physics. The physical unit is tokens; USD is computed from current prices via `src/llm/pricing.ts`, which is the single source of truth and gets updated when providers change rates.

Budgets stay USD-denominated because principals back them with real money. The asymmetry resolves at decrement time: the ledger module computes USD via `priceTokens(model, usage)` and accumulates into `budgets.spent_usd`, snapshotting USD into the *budget* (one number per agent×period) instead of every ledger row. The cap-comparison stays meaningful even when prices later shift; agents see cost as physics; nobody is lying to anybody.

Ledger is keyed `(principal_id, agent_id, provider, model, period)` so team-level or mesh-level rollups in v1+ are schema-free; the new `(actor_id, at)` and `(thread_id, at)` indexes serve the observability layer.

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

**Always-loaded core (`alwaysLoaded: true` on `ToolDef`):** four tools, in the LLM's tool list every turn — `load_tools`, `query_self`, `mail_list`, `memory_search`. These are the orientation + mailbox + memory-read primitives most strategic turns need. `unload_tools` is also always-loaded but isn't conceptually "core" — it's the partner to `load_tools`. Everything else (extension authoring, observability beyond `query_self`, delegation, secrets, scratch, full memory write/lineage, host context, extension-registered tools) is deferred.

**The catalog** lives in the stable system segment alongside principles. It's a pure function of the registered tool set: rich category prose ("when to reach for these") + minimal `name — short clause` per tool, grouped by category. Categories: `loadout`, `observability`, `memory`, `delegation`, `mailbox`, `extension authoring`, `secrets`, `host context`, `scratch`. Extension-contributed categories render with a default blurb until the core registry learns them. The catalog does NOT include "loaded right now" markers — that state lives in the tools block (cached separately) and would otherwise invalidate the catalog inside the cached identity prefix.

**Loading and unloading:**

- `load_tools(names)` — adds names to the per-thread loaded set, returns each tool's schema in the result so the agent can read it the same turn. Schemas appear in the LLM's tool list on the next inner round-trip; calls to those tools succeed from then on.
- `unload_tools(names)` — drops names from the loaded set. Always-loaded core tools cannot be unloaded.

Both report unknown / no-op cases per-name without aborting the call. Cost: a `load_tools` round-trip is one extra LLM call; the schema then rides every subsequent turn until unloaded.

**Live tool surface within a turn.** The chat loop's `getTools()` re-reads `opts.extensions.tools()` at the start of every inner round-trip, so tools registered/unloaded mid-turn appear in (or disappear from) both the LLM's tool list and the dispatch table on the very next call. The catalog stays turn-stable on purpose — it lives in the cached system prefix; an agent that just registered a tool already knows it exists. (See LOG 2026-04-26 for the full reasoning.)

**Auto-load on register.** `register_extension` adds the just-registered extension's contributed tools to the calling thread's loaded set and surfaces their schemas in the result (mirroring `load_tools`). The agent already paid the write+smoke+register cost with intent to use; forcing a separate `load_tools` hop is the kind of papercut habitat philosophy is supposed to delete. Always-loaded tools and already-loaded names are reported but not re-added. `unload_tools` remains the cheap path back if the agent regrets the inflation.

**Per-thread, not per-agent.** The loaded set lives on the in-memory `Thread` (`src/agent/chat.ts`) and is runtime state, not durable identity. Restart drops it; a fresh thread starts with the always-loaded core. This intentionally treats the loadout as conversational working state — if an agent decides "I always want X loaded," it writes a principle, and per-agent loadout durability is `[DEFERRED-to-v0.1]` pending real ledger evidence of recurring loads.

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

**Memory is identity** (per LOG 2026-04-23). Each row is part of the persistent self of its `actor_id` — preferences, philosophy, in-flight goals, grown capabilities (tools/extensions) and lived knowledge all live on this one surface. Role tags on each row differentiate posture (`goal`, `preference`, `skill`, `knowledge`, `culture`, etc.) — goals no longer live in a separate directory or primitive. Every memory write is a `memory.*` event; the `memories` table is a materialized projection of the event log, reconstructible by replay (federation = event-log merge, peers sync events). Beliefs carry a depth per the resistance model — seed beliefs from parents arrive pre-stamped heavy; lived beliefs accrue weight through use. Change is always possible; shifting a deep belief takes evidence proportional to its weight. No locks, just inertia.

Open calls tracked for implementation (see LOG 2026-04-23):

- Parent-read of child private memory (private = strictly-solo vs ancestor-readable) — `[DEFERRED-to-v0.1]`.
- Scratch binding to `task_runs.id` so `recoverLost()` sweeps orphaned scratch — `[DEFERRED-to-v0.1]`.

## Extension authoring loop

The unified flow for adding capabilities — channels, tools, trigger types, anything:

1. **Propose**: agent posts a decision-inbox item describing the purpose, dependencies, secrets required, cost estimate.
2. **Approve**: principal replies `approve`; secrets (API tokens) come in via a reply or a separate `olle secret set` call.
3. **Author**: agent writes files into `~/.olle/extensions/<name>/`. Uses a starter template (if one matches) or generates from scratch. Auto-committed to the local git repo with actor attribution.
4. **Smoke test**: extension exports `smokeTest()` — a read-only or idempotent probe. Runs automatically. Must pass before activation.
5. **Hot-load**: daemon detects new/changed extension, validates manifest, loads into runtime. If load throws or smoke fails → extension is left on disk, marked inactive, inbox item emitted with error detail.
6. **Live**: extension now participates in event routing; its tools/triggers available.

Manifests are the visible authority boundary for extensions. `callsTools` lists cross-extension tool calls; `eventReads` lists bus event types the extension may subscribe to; `eventWrites` lists event types the extension may emit imperatively (via `api.publish` or task-handler `emit`). A broader event surface is authored as a normal manifest edit and passes through the same smoke + hot-load path.

Trigger declarations are themselves authority statements for their `type` field — a `registerTrigger({ type: "channel-message", ... })` is the manifest-visible promise that this extension emits `channel-message` events from that trigger. Re-listing the trigger type in `eventWrites` is harmless but not required; a trigger can never emit anything other than its declared type, so the cross-check would only ever catch manifest drift, not an actual unauthorised emit (LOG 2026-04-27).

### Core bundle (shipped in binary, not an extension)

- LLM provider adapters (Anthropic, OpenAI) via API key config
- Pricing config (`src/llm/pricing.ts`) — single source of truth for token prices, USD computed on read
- Store / event bus / scheduler
- Decision-inbox router
- CLI chat handler (channel-of-first-contact)
- Scratch filesystem tool
- Meta-tools: `write_extension`, `run_smoke_test`, `register_extension`, `revert_extension`, `read_extension_file`, `extension_history`, `query_host_context`
- Loadout meta-tools: `load_tools`, `unload_tools` — bring deferred tool schemas into / out of a thread's context (see "Tool catalog and lazy loading")
- Observability tools: `query_my_usage`, `query_my_budget`, `query_my_runs`, `query_my_threads`, `query_self`, `query_events` — agents read their own world; CLI uses the same query layer
- Tool-result recovery: `read_tool_result` — fetch a slice of a spilled tool output by handle (see "Tool-result truncation")

### Starter templates (shipped read-only; agents clone and modify)

- `discord` — bot gateway + message send/receive
- `github` — webhook receiver + API calls (issues, PRs, comments)
- `slack` (v0.1)
- `cron-trigger`
- `http-webhook-trigger`
- `claude-code` — subprocess invocation
- `codex` (v0.1)

### Rollback

`~/.olle/extensions/` is a git repo. Every agent write is auto-committed. On crash (threshold: 2 failures within 5 minutes, configurable), the extension auto-disables and the principal gets an inbox item:

> "Extension `github` crashed on last 2 invocations. Last working commit was `<sha>` (3 edits ago). Options: revert / keep-disabled / inspect."

CLI: `olle extension history <name>`, `olle extension revert <name> [--to <sha>]`.

## Cross-host mesh (v0)

**Claim model only. No remote code execution.**

What crosses host boundaries:
- Events (published to peers in the same team)
- Memory (team-tier is synced; private and scratch are not)
- Decision-inbox items (addressed to a principal via whichever host owns that principal's channel)
- Approval messages (ask-up chains may traverse hosts)
- Task offers (`task-available`) and claims

What does **not** cross:
- Task handler code / function invocation
- Local tools
- Per-host scratch or filesystem paths
- Per-agent private memory

### Claim protocol

1. Task emitted on host A is tagged `claimable: true` with eligibility criteria.
2. Event bridged to all peer hosts in the team.
3. Each peer's scheduler checks local eligibility (tag match, capacity, tool availability, budget). If eligible, emits a `claim` event.
4. First claim wins — all hosts observe the ordering (HLC). Losers drop.
5. Winner runs the task locally, using its own tools and its own budget. Result is bridged back.
6. If winner fails or times out (deadline on claim), claim lapses and task becomes available again.

### v1+ mesh seams

These protocols are **designed for** in v0 but unimplemented:

- Peer discovery (LAN mDNS, team-supplied bootstrap peer list, hole-punch relay)
- Formal wire protocol with auth (per-team shared secret → per-principal key in v1+)
- Conflict resolution for concurrent memory writes (last-write-wins with attribution in v0; CRDT in v1+)
- Remote code execution under sandbox (not in v0, possibly v1+ with opt-in host policy)

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

- Peer wire protocol (bridge code is stubbed; team mesh in v0 is single-host reachable)
- Quorum-of-principals flow (pathway exists in schema; v0 treats all decisions as single-principal)
- Web UI (IPC socket is ready for it)
- Sandbox beyond process boundary
- Natural-language-only config (files still exist; agent edits them)

These are not regrets; they are where we deliberately stopped.
