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
  goals/                 # markdown goal files (agent-native format)
    team-acme.md
    obj-triage.md
  memory/                # markdown notes; agent-readable/writable
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

### Trigger

A source of events. Types in v0:

- `cron` — fires on schedule
- `poll` — fires when a polled endpoint changes (github issues, RSS, etc)
- `webhook` — HTTP endpoint listens for inbound
- `channel-message` — inbound from a chat adapter (Discord, CLI, future Slack)
- `internal-emit` — another task emitted an event

### Task

A handler bound to triggers by subscription. When a matching event appears, eligible tasks emit `claim` messages; first claim wins; task executes on the claimer's host. A task is a TypeScript function with a declared scope, required tools, token estimate, and significance tier.

### Tool

A typed callable capability: `{id, description, parameters (Zod), execute(args, ctx)}`. Tools may request permission gates (ctx.ask) and always carry attribution. Every tool call is logged.

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
tools         (id, agent_id, extension_id, schema, scope, created_at)
extensions    (id, name, path, status, last_smoke_at, last_commit_sha)

events        (id, hlc, host_id, actor_id, type, payload_json, parent_event_id)
claims        (event_id, task_id, agent_id, claimed_at, status)
tool_calls    (id, task_id, tool_id, args_json, result_json, tokens_used, started_at, ended_at)

decisions     (id, principal_id, proposing_agent_id, tier, summary, payload, status, staleness, created_at, resolved_at)
approvals     (decision_id, actor_id, vote, message, at)     -- for quorum/ask-up chains

budgets       (id, principal_id, agent_id, period, cap_tokens, cap_usd, spent, updated_at)
ledger        (id, hlc, host_id, actor_id, provider, model, tokens, usd, tool_call_id)

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

Budget is owned by **principals**. Principals allocate portions to **agents**. Every LLM call and paid tool operation writes a `ledger` row and decrements `budgets.spent`. Thresholds (80%, 100%) auto-post inbox items. Exceeding cap → agent pauses spending, continues non-paid work.

Budget allocation (raising cap, creating new allocation) is always an inbox decision — never self-authorized by the agent.

Ledger is keyed `(principal_id, agent_id, provider, model, period)` so team-level or mesh-level rollups in v1+ are schema-free.

## Memory tiers

Three scopes, enforced at write/read:

- **private** — owned by one agent; only readable by that agent.
- **team** — readable by any cell in the team; writes carry authorship and timestamp; corrections are visible, attribution preserved.
- **scratch** — per-task ephemeral working state; purged on task completion or timeout.

Default for new writes: **private**. Promoting private → team is operational. Deleting/overwriting team memory authored by another actor is strategic (inbox item).

Memory reads are logged (`memory_reads`) so the agent can ask "who knew what when."

## Extension authoring loop

The unified flow for adding capabilities — channels, tools, trigger types, anything:

1. **Propose**: agent posts a decision-inbox item describing the purpose, dependencies, secrets required, cost estimate.
2. **Approve**: principal replies `approve`; secrets (API tokens) come in via a reply or a separate `olle secret set` call.
3. **Author**: agent writes files into `~/.olle/extensions/<name>/`. Uses a starter template (if one matches) or generates from scratch. Auto-committed to the local git repo with actor attribution.
4. **Smoke test**: extension exports `smokeTest()` — a read-only or idempotent probe. Runs automatically. Must pass before activation.
5. **Hot-load**: daemon detects new/changed extension, validates manifest, loads into runtime. If load throws or smoke fails → extension is left on disk, marked inactive, inbox item emitted with error detail.
6. **Live**: extension now participates in event routing; its tools/triggers available.

### Core bundle (shipped in binary, not an extension)

- LLM provider adapters (Anthropic, OpenAI) via API key config
- Store / event bus / scheduler
- Decision-inbox router
- CLI chat handler (channel-of-first-contact)
- Scratch filesystem tool
- Meta-tools: `write-extension`, `run-smoke-test`, `register-extension`, `revert-extension`

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

olle upgrade                # pull new binary, run migrations
```

All commands are thin RPC wrappers over the daemon's IPC endpoint.

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
