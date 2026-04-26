# OLL-E — Decision Log

The reasoning trail behind OLL-E's design. Append-only. When a decision is reversed, add a new entry referencing the old one — do not edit history.

Entries document *why* we chose something. `VISION.md` and `ARCHITECTURE.md` document *what* we chose; this file is for the reasoning.

---

## 2026-04-22 — Vision locked across five conversation rounds

The vision was anchored over five rounds of questioning between daaaa and Claude. Below are the decisions reached in each round and the reasoning behind them.

### Round 1 — Who, autonomy, install model

**Decided:**
- Humans are just another event source. No special-cased human UI.
- Agents are proactive by default within declared scopes — user wants humans "out of the way as much as possible."
- Friend-install is voluntary cooperative mesh, not centralized. Compute is pooled under per-host policy.

**Why:**
- The "humans are events" choice collapses two code paths into one. It falls out naturally from the cellular metaphor introduced in Round 2 and dramatically simplifies channel handling.
- Proactive-by-default is required for the system to deliver value while the human sleeps. Reactive-only would make OLL-E just a fancy chat interface.
- Voluntary mesh respects the "world agents love" philosophy at the human layer too — no one is conscripted.

### Round 2 — Operational/strategic/vision line; goals; negotiation

**Decided:**
- Three-tier significance model. Tier is rule-declared per task/tool, not judged by the agent at v0.
- Goals are agent-native markdown with light frontmatter; not a rigid schema.
- Negotiation is extremely thin for v0: first eligible cell claims; no bidding.

**Why:**
- Rule-declared tiers are testable and auditable. Agent judgment of significance is a v1+ problem; doing it wrong at v0 would either paralyze autonomy or blow past alignment.
- Agent-native format wins because agents are the primary workers. Rigid schema would force them to translate their native reasoning into structured fields, losing fidelity and wasting tokens.
- Thin negotiation is enough to prove pooled compute. Bidding requires agents to reason about peer cost — a significant modeling burden with no clear v0 payoff.

### Round 3 — Memory, self-mod scope, cross-host trust

**Decided:**
- Three-tier memory: private / team-shared / host-scratch. Default new writes are private.
- Self-modification scope table established. Sub-agent spawning is v0 operational. Package install / prompt edit are strategic. Budget raises are never self-authorized.
- Cross-host v0 is shared events + local claim. No remote code execution.

**Why:**
- Three-tier memory covers the realistic needs without introducing access-control complexity. Default-private prevents accidental leakage.
- The self-mod table is the "menu of agency." Drawing the operational / strategic line conservatively protects the principal without hobbling the agent.
- The claim-model for cross-host was daaaa's insight: pooled compute = pooled workforce, not pooled machines. This sidesteps the hardest sandboxing problem in agent systems while still delivering the promise.

### Round 4 — v0 demo, channels, non-goals

**Decided:**
- v0 demo is two-laptop shared bug triage.
- Minimal-core bundle: LLM + CLI chat + store. Everything else ships as starter templates or grows from scratch.
- Non-goals list locked — no RCE, no web UI, no Windows, no bidding, no CRDT, no DSL, no marketplace, no E2E, no SSO, no multimodal.

**Why:**
- The demo had to exercise the two hardest claims simultaneously: self-growing capabilities (Discord extension grows in the first conversation) and cellular mesh (peer cell claims work when local cell is busy).
- Minimal-core was chosen over thicker-core because it forces the self-growing property to be robust from minute one. A bundled Discord integration would let us cheat on the extension loop's ergonomics.
- The non-goals list is defensive scoping: explicit "we are not building X" makes scope creep harder.

### Round 5 — Extension authoring, core bundle confirmation, smoke test, rollback

**Decided:**
- Unified agent-authored extension flow: propose → write → smoke-test → hot-reload.
- Core bundle stays minimal. Discord/GitHub/etc. ship as starter templates.
- Smoke-testing is required for any extension touching external resources.
- Rollback is in scope for v0: git-backed `~/.olle/extensions/` with auto-commit and revert-on-crash inbox flow.

**Why:**
- The unified loop realizes the "world agents love to live in" philosophy operationally. No special cases means no privileged paths.
- Smoke-testing is how we make "code is cheap" safe. Agents will write a lot of extensions; most won't work first try; automatic verification prevents activation of broken code.
- Git-backed rollback is ~50 lines of code and provides full audit history for free. Without it, one bad agent-authored extension can brick the host's most-used capability. Worth the tiny cost.

### Post-Round-5 — Daemon + client architecture

**Decided:**
- Long-lived daemon per host. CLI and future UIs are thin clients over local IPC.

**Why:**
- Background work must survive terminal close. A CLI-only architecture would force user to keep a shell open.
- Multiple clients (CLI now, web UI later) share one source of truth without coordination.
- Mirrors opencode's proven pattern.

### Philosophy captured (pervasive across all rounds)

**daaaa framing, verbatim:** *"we're creating a world that agents love to live in, which means the world is modifiable by the agents themselves. this is a core philosophy."*

This is the top-level design principle. Every other decision descends from it. When evaluating future options, the tiebreaker is: which path gives the agent more agency over its environment without endangering humans?

---

## 2026-04-22 — Discord + GitHub use-case architecture; reference patterns stolen

Second conversation on this date. We architected the first two concrete v0 use cases (Discord wake-word chat routing + #backlog-to-GitHub-issue triage) in enough detail to build, surveyed openclaw and nanoclaw for patterns, and landed the operational shape of the extension-vs-task boundary.

### Decided — layering

- **Extension = capability layer; Task = behavior.** An extension (e.g., `discord`) exposes triggers (`channel-message`, `member-join`), tools (`send-message`, `react`, `fetch-thread-context`, `list-channels`), and a smoke test. It does not contain behavior. Concrete behaviors (wake-word chat, #backlog triage, greeter) are authored as separate task files subscribing to those triggers with different filters. One extension, many tasks.

### Decided — transport-agnostic chat routing

- Chat handler (`src/agent/chat.ts`) already subscribes to `chat.input` events and emits `chat.*` outputs. CLI is just one transport adapter. Discord wake-word task is another adapter — pumps `chat.input` with `{sessionId, text, channel_ref, reply_handle}` and listens for `chat.turn-end`/`chat.assistant-text` to post back. No chat-handler refactor required.
- **Session key:** primary `(transport, thread_id)`; fallback `(transport, channel_id, author_id)`; CLI = `(cli, tty_or_pid)`. Mirrors openclaw's thread-bindings pattern.
- **Wake-word match:** `/\bolle\b/i` + `@mentions` of bot + replies to bot; DMs skip wake-word (implicit address). Case-insensitive, word-boundary to avoid false positives on "follower" etc.
- **Server scope default:** DMs always active; guild channels passive until bot explicitly added to channel or told `watch here`. Prevents 10k-member-server spam accident. Widening is a directive through the same authoring loop.

### Decided — self-mod action vocabulary

- Agent proposals through the decision inbox use a **named, enumerated action type** with a typed payload, following nanoclaw's `apply.ts` pattern. No generic "execute arbitrary code" action. The v0 enum: `write_extension`, `register_task`, `register_trigger`, `register_tool`, `install_starter`, `revert_extension`, `raise_budget`, `promote_memory`, `spawn_subagent`, `create_issue`, `send_message`. Unknown types rejected at propose-time; narrow vocabulary is the safety boundary.
- Dispatch remains **owned by the proposing agent**, not a central router. Proposing agent calls `inbox.propose()`, subscribes to `decision.resolved` with matching id, executes on `approve`. nanoclaw centralizes because it's sandboxed across containers; we're in-process, so per-proposer dispatch is simpler and preserves agent autonomy.

### Decided — chat ↔ inbox continuity

- Inbox items that originated from a chat conversation are **delivered back into the same thread/channel**. A new schema column `decisions.origin_channel_ref` (JSON: `{transport, thread_id, channel_id}`) carries the address. Reply in the originating thread parses: literal `approve`/`deny` routes verbatim; anything else is treated as `modify` — free-text fed to the proposing agent for revision and re-propose. Users never leave the conversation to approve. *Implementation note: schema change is the next concrete gap.*

### Decided — implementation defaults (fell out of the lens; not asked)

- **Greeter is persistent** (`member-join` subscriber), not a one-shot post.
- **Classifier cost shape:** cheap heuristic prefilter → small-model classify on maybes → full draft on positives. Each classification logs a ledger row so spend is visible.
- **Attribution:** every auto-opened GitHub issue begins with a jump-link back to the originating Discord message plus a block-quote of the message.
- **Multi-agent addressing** (`olle alice, …`): parse seam present in wake-word matcher; not built in v0 (one root agent per host).

### Why

The layering decision (extension = capability, task = behavior) is the single biggest clarifier for everything else. Once accepted, each concrete behavior becomes a small task file subscribing to one trigger with a filter; the extension doesn't grow arms and legs. It keeps the self-modification surface thin (an agent authoring "watch #backlog" writes ~50 lines of task, not a new extension), makes the growth rate of the system proportional to the agent's real agency rather than to boilerplate, and preserves the six-primitive minimalism.

Adopting nanoclaw's narrow typed-action pattern (rather than a generic exec-payload) converts safety into a compile-time property of the enum: the agent can only propose actions whose handlers we've already written. New action types require a code change — exactly the right ceremony for expanding the self-mod surface.

Chat-thread-as-inbox-delivery-channel preserves "humans are events" under stress: the approval is just another message in the same conversation, not a hop to a separate console. Without this, the user is forced back to `olle inbox` CLI when they're already in Discord — exactly the special-case human UI the lens rejects.

### Patterns stolen (with attribution for audit)

- `pending_approvals` row shape → our `decisions` schema, adding `origin_channel_ref`. Source: `nanoclaw/src/db/migrations/module-approvals-pending-approvals.ts:23-38`.
- Approval-DM-on-origin-channel routing → chat↔inbox continuity. Source: `nanoclaw/src/modules/approvals/primitive.ts:71-119`.
- Narrow typed self-mod actions → our action-type enum. Source: `nanoclaw/src/modules/self-mod/apply.ts:21-85`.
- Monitor split (gateway + preflight + threading) → Discord extension structure. Source: `openclaw/extensions/discord/src/monitor/`.
- Thread-as-session binding → chat-session key policy. Source: `openclaw/extensions/discord/src/monitor/thread-bindings.ts`.

### Deliberately left

- **Container-per-agent-group sandbox** (nanoclaw): v0 is in-process; matches ARCHITECTURE non-goal on "sandbox beyond process boundary."
- **Two-DB host/container single-writer pattern** (nanoclaw): not needed in-process.
- **Central approval router** (nanoclaw): replaced by per-proposer dispatch on `decision.resolved`.
- **Plugin-registry cache + origin precedence** (openclaw): useful at scale, not at the v0 extension count.

### Survey findings on current code vs. today's decisions

- Chat handler: already transport-agnostic (event-sourced on `chat.input`). No refactor.
- Inbox: already emits `decision.proposed`/`decision.resolved` with full payloads. Fits per-proposer dispatch. Only add: `origin_channel_ref` column.
- Meta-tools: `write_extension`, `run_smoke_test`, `register_extension`, `revert_extension`, `install_starter`, `list_starters` present. Loop supports full extensions; task-only authoring still goes through extension packaging for v0.
- Ledger: attribution-complete; threshold events already emitted.
- Gap: Discord + GitHub starters are sub-minimum stubs. Need to be fleshed to near-working skeletons so the agent's completion work is configuration and polish, not inventing the protocol from scratch.

### Next concrete moves (in dependency order)

1. Rewrite Discord starter: gateway via Bun's WebSocket, preflight filter, `channel-message` + `member-join` event emission, real tools, token-validating smoke test.
2. Rewrite GitHub starter: webhook receiver shape, REST tools (issues/PRs/comments), token-validating smoke test.
3. Add `decisions.origin_channel_ref` column + migration.
4. Write the wake-word task (shippable as starter `discord-wake-word`).
5. Write the inbox-to-Discord delivery task (subscribes to `decision.proposed`, posts card into origin thread; subscribes to `channel-message` replies in decision threads, calls `inbox.respond()`).

Steps 1–2 are this session's work. 3–5 are subsequent.

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

## 2026-04-22 — Tool boundary crosses JSON Schema, not Zod

### Decided

`ToolDef` now carries `inputSchema: JSONSchema` and an optional `validate(input)`. Core ships no Zod at the host↔extension boundary. Extensions may use Zod, Valibot, ArkType, or hand-written schemas internally; whatever they use, what reaches the host is plain data.

### Why

The first self-modifying install (agent writes `claude-code` via the extension loop) died with `def.shape is not a function` inside `zodToJsonSchema`. Root cause: the compiled binary bundles one Zod; the dynamically-imported extension file resolves `import { z } from "zod"` to whatever the runtime lands on from the staging directory — in practice a different Zod build whose `_def.shape` is an object, not a function. Cross-module library identity is inherently fragile under our authoring loop: extensions are authored by agents, staged to `/tmp`, and loaded without a shared `node_modules`.

We considered three fixes. A defensive `zodToJsonSchema` (handle both `_def.shape` as function and object) treats the symptom. A Bun resolver plugin redirecting bare specifiers from staged paths back to the host's embedded copies works, but reinstates the host as gatekeeper of every allowable dependency — every new library an agent wants has to be bundled and re-shipped, which violates "environment is modifiable by its inhabitants." Moving Zod out of the boundary removes the problem entirely: there is no shared library identity left to get wrong, extensions choose their own tooling, and the boundary becomes plain data — the same shape Anthropic's API already wants downstream.

The OLL-E tiebreaker (pick the more-agentic path) favors the boundary change. Extensions can now import anything they need without a gatekeeper; agents author tools as plain JSON Schema literals (LLMs emit these as fluently as Zod); and the host's code has one fewer dependency surface to maintain.

### Survey: what this does *not* touch

- No change to the extension authoring loop, smoke gate, git rollback, or hot-reload mechanics.
- No change to the inbox / ask-up / decision primitives.
- No change to the scheduler or task-run durability.
- `zod` remains an `allowed` dep extensions can `import` if they wish — the host just never sees their zod instances.

---

## 2026-04-22 — Permissions = scope + tier + budget, checked at dispatch

### Decided

- **No new primitive.** Permissions are `AgentScope` (`allowTools` / `denyTools` / `allowTiers`) + the ledger we already have + the tier declared on every tool. No capability-token system, no separate `permissions/` service. `src/permissions/check.ts` is a pure module of two functions (`checkTool`, `narrowsScope`) — not an architectural layer.
- **Check lives at tool dispatch.** `runAgent` gained an `authorize(tool)` callback, called once before `tool.execute`. `chat.ts` wires it by loading the agent's scope from the store. Extension-side `callTool` is the other chokepoint and will take the same callback when its permission gate lands.
- **`ToolDef.tier?: Tier`.** Optional, defaults to `operational`. Meta-tools tagged: `write_extension` / `register_extension` / `revert_extension` / `install_starter` → `strategic`; `run_smoke_test` / `extension_history` / `list_starters` → `operational`.
- **Denial is physics, not a refusal.** A denied call surfaces as an `is_error` tool_result to the model (so it sees *why* and can adapt), emits a durable `tool.denied` event, and auto-proposes `grant_scope` to the inbox via `askUp`. One proposal per (tool, turn) — debounced so a retrying model doesn't flood.
- **Root agent gets `["operational", "strategic"]`.** Previously `["operational"]`. Root is the human's first-contact delegate; strategic actions shouldn't round-trip through the inbox just to let them write an extension they were asked to write. Vision-tier still escalates. Child agents default to narrower via `narrowsScope` at spawn.
- **Sub-agent scope can only narrow.** `narrowsScope(parent, child)` enforces: child's `allowTiers ⊆ parent.allowTiers`; child's `allowTools` outside parent's is rejected; parent's `denyTools` always wins. Confirmed vision-aligned — diverges from nanoclaw/openclaw where only humans grant.

### Deliberately deferred

- **Re-check on parent scope change.** Today `narrowsScope` only runs at spawn. If a parent's scope later narrows, descendants keep the old, wider scope. Fine for v0 — demotion isn't a live path yet. Closes when a `retire_agent` / `demote_agent` action ships.
- **Budget as returnable capital.** The Rust-ownership borrow idea — parent loans N tokens, child deducts, unused returns on retirement. Depends on a spawn → retire lifecycle we don't have yet. Parked for v0.5.
- **Per-extension scope.** Tools registered by an extension currently inherit the calling agent's scope. A future `extensions.scope` column could let us say "the discord extension's tools are callable only by agents with tag:discord" — tagged, not implemented.
- **Tool-call attestation / audit trail.** We log `tool_calls` but don't record the scope snapshot under which a call was authorized. v0.5.

### Why

Four questions were posed up front; all four landed on the more-agentic, less-new-machinery answer. Treating permissions as a composition of existing primitives (scope + tier + ledger) preserves the six-primitive discipline; a separate capability-token mechanism would have been a seventh thing to explain, with no concrete v0 problem it solves. Checking at dispatch matches where the action actually happens — one chokepoint, one check, no ambient `permissions.authorize(...)` call polluting every tool's `execute`. The denial-becomes-proposal loop is the load-bearing philosophical piece: an agent who hits a wall files a proposal and keeps working, instead of experiencing refusal. That's what "constraints feel like physics" means in practice — the wall is real, but the agent's response is physical (find a route, file a request), not behavioral (give up, apologize).

Root at operational+strategic is the only clause that could plausibly drift from vision — one could argue strategic self-modification should *always* round-trip through the inbox, even for root. The counter is that root's principal is the human sitting at the chat REPL; special-casing chat would be the wrong fix (violates "humans are events"), and delegating strategic authority to the root is what the ask-up chain is *for*. Vision-tier still escalates, which is where the line genuinely matters (goal rewrite, mission change, budget raise).

### Survey: what this does *not* touch

- No schema migration. `AgentScope` already carried the fields; `checkTool` reads them.
- No change to the inbox, ask-up, or decision primitives. New callers, not new shapes.
- No change to the scheduler, `task_runs`, or the done-event convention.
- No change to extensions' `registerTool` / `registerTask` surfaces. Tools gained an optional `tier` field, no breaking change.

### Tests

`test/permissions.test.ts` — 11 new assertions covering `checkTool` rules (deny wins, allowlist narrows, tier-gate), `narrowsScope` widening rejections, and the `runAgent` authorize path (denied calls skip `execute`, surface `is_error` tool_result, fire `onDenied`). Full suite: 89 pass.

---

## 2026-04-23 — Dream + reactive self-repair deferred to v0.1; `[DEFERRED-to-vX.Y]` marker convention

Exploratory conversation about openclaw-style nightly "dream" reflection (memory consolidation + extension janitor + capability-gap proposals) and reactive self-repair on the `task.*.failed` event stream. Both ideas lens-test cleanly — they compose from the six primitives, ride already-blessed action vocabulary (`write_extension`, `promote_memory`, `send_message`, `spawn_subagent`), and contradict no v0 non-goal. But they belong after v0's two-laptop demo ships, not before. The interesting decision isn't whether to build them; it's how not to forget them.

### Decided — scope placement

- **Dream and full self-repair are v0.1 starter extensions, not v0 core.** Packaging unit is the extension (extension = capability, task = behavior is already locked per LOG 2026-04-22), with internal shape (one extension vs several; sub-agent-per-dream vs task-on-root; subprocess vs inline LLM) left as a v0.1 design call against real evidence. Candidate concerns identified: memory consolidation, extension janitoring/repair, capability-gap proposals.
- **Failure-event coverage + structured payloads is a v0 seam.** Extend the existing `task.*.completed/failed` done-event convention (LOG 2026-04-22, scheduler) to cover tool-dispatch failures and extension-load failures with structured payloads (error class, commit sha where relevant, manifest ref, correlation id). Listed as a seam rather than v0 scope proper: implementation timing is flexible, but the shape is load-bearing. Without it, v0.1 dream + self-repair would be retrofit instead of compose. See ROADMAP "Seams designed-for in v0, but not implemented."
- **`tool_use`/`tool_result` pairing invariant** in the core agent loop is a correctness bug, not a feature. Belongs in v0 regardless — every `tool_use` block must be followed by a matching `tool_result` (with `is_error` on failure or cancellation). Not tracked as dream-related; called out here because the conversation that surfaced the dream idea also surfaced this.

### Decided — `[DEFERRED-to-vX.Y]` marker convention

- **Any LOG entry that parks a decision for a later version carries a `[DEFERRED-to-vX.Y]` tag in the header and a "Resurrect when:" clause in the body.** Triggers are observable repo/runtime state, not calendar dates. Discoverable by `grep '\[DEFERRED-' docs/design/LOG.md`.
- **ROADMAP entries for deferred features back-link to the LOG entry by date.** Bi-directional navigation.
- **VISION "Success criteria for v0" gains a ship-blocker line**: every `[DEFERRED-]` entry must be triaged (promoted / kept deferred with updated resurrect-when / retired) before v0 is declared shipped. Converts the revisit from ritual into gate.

### Resurrect when (for this entry)

The v0 two-laptop demo (VISION success criteria) has run for enough real usage that the failure-event stream + unresolved-inbox corpus + scratch-memory accumulation from both hosts constitutes evidence for which dream concerns actually matter. That corpus becomes the v0.1 dream design input. Exact threshold (days, event count) is itself evidence-driven and part of the triage at v0 ship.

### Deliberately deferred

- **Dream's internal shape.** Sub-agent-per-dream vs task-on-root, one extension vs several, subprocess vs inline LLM, corpus-scoping rules, circuit-breaker thresholds. All evidence-driven; no value in deciding blind.
- **`register_task` unpark.** Stays parked even for dream. Small per-task extensions cost ~10 lines of manifest and preserve "extension = capability." Revisit only if a concrete dream design genuinely can't live inside an extension.
- **OLL-E dogfooding its own deferred-decision queue.** Once a dream-memory-like capability ships, the obvious closing move is scanning LOG for `[DEFERRED-]` markers, checking whether their resurrect-when conditions hold, and posting an inbox digest. Philosophically clean, but the chicken-and-egg rules it out as the *primary* defense — noted here so the self-hosting path is on the record.

### Why

The lens says inhabitants grow the environment. Applied to our own process: the real inhabitants of v0 (human + root agent + cells) surface the problems dream needs to solve. Pre-designing against imagined failure modes is speculation; logging them into v0's event stream and then designing is evidence. The governance cost is one marker convention and one VISION line — both mechanical, neither a ritual. The strongest property is that the deferred list becomes a ship-blocker: v0 can't be honestly declared done while deferred entries sit untriaged, and the triage itself forces the evidence review.

One risk named explicitly: fuzzy v0 ship declaration. If "v0 done" is never formally announced, the revisit trigger never fires. Defense is that v0 ship gets its own LOG entry listing which deferred entries were promoted/kept/retired — can't write that entry honestly without doing the grep.

### Survey: what this does *not* touch

- No change to primitives, action vocabulary, permissions, scheduler, or memory tiers.
- No new infrastructure. No "deferred decisions" file or directory — the LOG is the queue, the marker is the index.
- No change to v0's shipping criterion list beyond the one added line, and no change to non-goals.
- No commitment to dream's internal shape.

### Next concrete moves

1. This LOG entry (done).
2. ROADMAP delta: dream + self-repair under v0.1 candidates with back-link; failure-event coverage + structured payloads in "Seams designed-for in v0, but not implemented."
3. VISION amendment: one line in "Success criteria for v0" naming `[DEFERRED-]` triage as a ship-blocker.

Steps 2 and 3 land in the same change as this entry.

---

## 2026-04-23 — Identity, memory, and the inhabitants of OLL-E

Exploratory conversation that began with "how will OLL-E keep memory and share context across agents and team members" and expanded into a framework for what agents *are* in this habitat. Surveyed openclaw's memory subsystem (markdown-on-disk, `memory_search`/`memory_get`, dreaming, active-memory, hybrid search) and nanoclaw's notable absence of one. Both agreed on the ground truth — markdown files, agent-owned, no hidden state — and disagreed only on how much retrieval machinery belongs in the system. Core posture: nanoclaw-minimal in the binary, openclaw-style growth reachable through the extension loop. The deeper decision wasn't about recall, though — it was about whether "memory" is knowledge the agent *has* or the persistent self it *is*.

### Decided — memory is identity, not a knowledge base

- **Memory = persistent self across time.** An agent's memory isn't a fact store beside its "real" logic; it is the residue of its lived experience. Preferences, philosophy, in-flight goals, grown capabilities (tools/extensions), accumulated learning — all one surface. Two agents with the same spawn seed but different lives become different beings.
- **Memory is a projection of the event log, not a first-class table.** Every memory write is a `memory.*` event; the `memories` table is a materialized view, reconstructible by replay. This enforces VISION's "federation is event-log merge" commitment at the memory layer — peers sync events, each side reprojects, no reconciliation problem.
- **Goals collapse into memory with role tags.** A goal is a memory with posture *I am pursuing this*; a preference is *I hold this true*; a skill is *this is how I do things*. One write surface, role-differentiated. The `~/.olle/goals/` directory retires; `memory/<scope>/` carries role tags instead.

### Decided — agents as beings, not functions

- **An agent = seed + lived events.** At spawn each agent receives capabilities, an initial stance, authority to write its own memory, and (for children) a cultural payload from its parent. Purpose isn't assigned — it's discovered through lived experience. The root agent is the one exception: its constitutional purpose is to serve its principal (the oldest agent above it). Spawned children are born purpose-blank and find their own.
- **Culture is the parent's gift, diversity is the child's right.** Parents actively transfer selected philosophy/beliefs/orientations (task-oriented, behavioral, cognitive) into the child's starting memory; children retain passive read access to the parent's ongoing culture afterward. Nature (curated seed at birth) and nurture (lived experience + ambient culture visible through the line). Children still form their own identity on top. Drift is expected; correction is the ongoing conversation — the same mechanism a parent uses to keep a lineage coherent is the same mechanism daaaa used to steer this conversation.
- **Resistance, not locks.** Every belief carries inertia proportional to its depth. Seed-imparted beliefs arrive pre-weighted (culture carries stamped depth); everything else gains weight through use — Hebbian, the often-referenced and often-acted-upon calcifies. Change is always possible; sudden drift on what matters requires evidence proportional to the belief's weight. Physics, not prohibition.

### Decided — evidence is peer, authority is hierarchical

- **Information is just information.** A correction from a parent and a surprising datum from a child enter the same update path: evidence, weighted by source and strength, hitting an agent whose own resistance decides how far it moves them. There is no special "child→parent" path and no special "parent→child" path in the *belief* graph. The ask-up tree governs authority (who can approve what); it does not govern whose evidence can shift whom.
- Stricter than symmetry — it's full peer-ness in the belief-update direction. Hierarchy is orthogonal to truth.

### Decided — the human is the oldest agent

- **`principals` collapses into `agents`.** The human is an agent at the top of the tree: real-money-backed, `host_id=null` (no executing host), longest-lived, with its own memory, principles, and resistance. The ask-up chain is one recursion end-to-end, with no terminal "now we hit a principal" special case.
- "Principal" survives as a property on the agent row ("this agent is backed by real-world money"), not a separate primitive. Every agent, human included, maintains a set of governing principles it tries to impart downward. Schema collapse mirrors that symmetry — humans and agents are one species.
- Strengthens VISION's existing "the human is a peer in the world, not an overseer outside it."

### `[DEFERRED-to-v0.5]` Agent death

Agents can die — economic extinction (budget depletion), voluntary end ("my purpose is complete" or "I have no purpose and will not find one"), or ancestor-initiated termination. Death is physics, not verdict: starvation, not rejection. Private memory of the dead seals — preserved for principal-visible debugging, not open to living agents (bad ideas shouldn't reseed the living). Team memory they authored stays, because it was collective the moment it was written.

**Resurrect when:** the v0 two-laptop demo has run for enough real usage that a population exists and survival pressure becomes meaningful. For v0 the demo has no population to select across; death adds mechanism without value.

Sub-decisions parked with this:

- **Voluntary self-termination ceremony.** Operational / strategic / depth-gated. Lean: depth-gated — operational when purpose is complete and delivered, strategic when the agent wants out mid-mission or without a clear finish.
- **Earned breathing room + purpose-search economics.** Young agents raised on parental slack drawn from the parent's own earned surplus; newborns aren't starved. Purpose-driven but not ruthless. Alternate shapes (lineage pool, performance-linked subsidy) stay unselected until death lands.
- **Child orphan-adoption on parent death.** If a dying agent has living children, they reparent upward to the grandparent by default. Lineage collapse only if the grandparent declines.

### `[DEFERRED-to-v0.1]` Self-identity rewrite tiers beyond resistance

An agent updating its own philosophy/vision *could* be gated by tier-declared actions (`rewrite_identity`, `revise_vision`) on top of the resistance model. For v0 the resistance alone is the physics; explicit tier markers revisit when we see whether inertia is enough.

**Resurrect when:** first observed drift that resistance didn't catch, or first agent self-reporting "I can't tell what I believe anymore."

### `[DEFERRED-to-v0.1]` Parent-read of child private memory

The earlier Q1. Under the identity frame, is private "readable by ancestors in the lineage" or strictly solo? Unresolved. Lands when the memory surface is implemented.

**Resurrect when:** the memory surface migration is being designed — it's a schema-touching decision.

### `[DEFERRED-to-v0.1]` Scratch lifecycle binding to `task_runs.id`

So `scheduler.recoverLost()` (LOG 2026-04-22) can sweep orphaned scratch on restart. Small, mechanical.

**Resurrect when:** memory surface migration lands.

### Why this framing holds

*Memory-as-identity* resolves a tension that was latent in Round 3 of the vision lock: if memory is a fact store and nothing else, then preferences, philosophy, and in-flight intentions have no home in the primitives. Pushing memory up to "persistent self across time" unifies the three-tier scope model (private/team/scratch) across all those surfaces without new primitives. It also explains why skills and extensions are memory-adjacent — they are *how the agent does things*, another facet of who-it-is.

*Projection-over-table* is forced by the federation model. A first-class `memories` table writable without a corresponding event creates drift that cross-host merge would have to reconcile. Keeping events authoritative and `memories` reconstructible means peers sync events, not rows.

*Resistance* resolves the tension between "agents have maximum agency" and "identity shouldn't drift catastrophically." Locks are rule-based and read as system judgment — an anti-pattern the `incentives as physics, not judgment` memory already flags. Inertia is physics: the agent is free to move; its own belief structure resists proportionally to depth. Alignment becomes a weight distribution rather than a permission.

*Evidence-as-peer / authority-as-hierarchical* splits two axes that had been conflated. The ask-up tree was already about what can be *done*. Belief formation is orthogonal — evidence from anywhere, weighted by source+strength, with the agent's own resistance doing the work. This preserves "peer cells around a shared goal" at the identity layer. Culture flow down-the-lineage is just the default-weighted path, not a privileged one.

*User-as-oldest-agent* is the final schema simplification. Treating humans as a separate species was a concession to "they have real money and we don't." Collapsing lets the ask-up chain run one recursion all the way; lets children of agents-of-agents address their human great-grandparent the same way they address anyone else; keeps "humans are events" honest at the schema layer, not just at the IPC layer.

*Death-as-physics* rounds out the world economy. Birth is free; growth is subsidized; continued existence is earned. No rewards, no punishments. Deferred because the v0 demo doesn't need survival pressure to prove anything.

### Survey — what this does *not* touch

- No change to the extension authoring loop, inbox, ask-up, scheduler, `task_runs`, budget mechanics, tool boundary, or hot-reload.
- No new primitives. The six (Host, Agent, Trigger, Task, Tool, Store) remain; `principals` collapses into `agents`; `memories` becomes a projection under Store; `goals/` dissolves into memory role tags.
- No breaking changes to what extensions see. Memory write API stays; projection is internal.

### Next concrete moves

1. VISION amended in this change (identity/culture/resistance/evidence/human-as-oldest-agent bullets).
2. ARCHITECTURE annotated with pointers to this entry on the affected sections (Agent primitive, Memory tiers, data directory layout). Schema migrations for `principals→agents` and goal-directory collapse land in a separate implementation session.
3. ROADMAP updated: v0 Memory bullets gain role tags + event-sourced note; non-goals gain agent death / self-termination / breathing-room economics with back-link.
4. Cross-host team-memory sync under the projection model (likely "peers sync `memory.*` events, LWW with attribution") — needs a light write-up when federation approaches.

---

## 2026-04-24 — Memory surface landed; SOUL-as-injection; scope calls locked

The memory-as-identity framing from 2026-04-23 turned into code this session. A handful of calls that LOG 2026-04-23 left open landed as design decisions, each noted here so the file history carries the *why*, not just the diff.

### Decided — role as a first-class column

`memories.role` is a dedicated TEXT column, not a prefix convention inside `tags`. Role is posture, and posture is queryable-as-identity ("what are my principles", "what are my goals"). Keeping it in the JSON `tags` array forced a LIKE scan for every identity question and hid the load-bearing dimension inside a label bag. Column is free-form — agents coin new roles as they need them; no enum constraint.

### Decided — principle subsumes culture (one posture)

daaaa's framing: *culture is a result of your principles plus your experiences*. Culture emerges in the holder; principles are the explicit posture one maintains. So there is no separate `role=culture`. Writing a `role=culture` memory would be writing an emergent property as if it were a commitment — category error. What gets passed down at spawn is `role=principle`; the child's culture is what emerges on top of its lived events.

### Decided — depth column ships in v0 as the resistance default's mechanism

ROADMAP line 114 defers "explicit belief-depth markers / `rewrite_identity` / `revise_vision` action tiers **beyond the resistance default**." Re-reading: the resistance default is what v0 gets; the tiered-action markers are what v0.1 adds. Without a depth field we cannot express "seed principles arrive heavy" — which means cultural pass-on becomes flat copying, which undermines the whole inertia model. The column is the *mechanism of the default*, not something beyond it. Lands now. Hebbian weight-bumps-on-use stay `[DEFERRED-to-v0.1]`.

Default weights by role: `principle=10`, lived writes `=1`. No ceiling; agents can override.

### Decided — strictly-solo private (resolves the `[DEFERRED-to-v0.1]` parent-read question)

Private means private, including from ancestors. Evidence-is-peer / authority-is-hierarchical (VISION) splits cleanly here: hierarchy governs what can be *done*, not what must be *known*. A child writing under ancestor observation writes differently — which would ruin the honest-self that "memory is identity" needs to mean anything. Parents who want visibility either ask the child or wait for a promotion-to-team. This is also the more-agentic path: the child holds real control over what its ancestors see.

Under the identity frame this isn't a privacy feature; it's what makes private be private.

### Decided — scratch binds to `task_runs.id` (resolves the other `[DEFERRED-to-v0.1]`)

The work was already touching `memories.scope_ref` in migration 0004; binding scratch to `task_runs.id` was one documentation line and zero additional code. Letting `recoverLost()` sweep orphaned scratch on restart stays a v0.1 task (needs the sweep logic, not new schema), but the semantic anchor lands now.

### Decided — `memory.forgotten` as a tombstone event (projection model forces it)

Row-drops are invisible to event-log replay. Under the projection model (LOG 2026-04-23) every state change must ride on an event or federation can't reconstruct it. `memory.forgotten` is that tombstone event; the projector deletes the row when the event HLC beats the existing row's HLC. v0 single-host bus is in-order, so out-of-order delivery (tombstone before the wrote it retires) isn't an issue; when cross-host mesh lands, a tombstone-records table or equivalent is needed — noted as a v1+ seam in the code.

One cascading call: the existing FK `memory_reads.memory_id REFERENCES memories(id)` prevented deleting a memory that had reads against it. Audit must survive forgetting — the read event happened; forgetting the memory later shouldn't erase history. Dropped the FK in migration 0004 via the SQLite table-recreate dance. Weak-reference pattern already used for `events.actor_id` and `events.to_agent_id`.

### Decided — SOUL-as-injection (openclaw's SOUL.md pattern adapted)

openclaw's `SOUL.md` is a workspace file injected into agent context at every session start (`references/openclaw/docs/concepts/agent.md:24-41`). The mechanism is what gives persona teeth: the agent doesn't retrieve its identity when it thinks to, it *lives inside* it every turn.

OLL-E takes the mechanism and leaves the separate file. Memory is the identity surface (LOG 2026-04-23 one-surface commitment); adding a second surface would fork it. So: `role=principle` memories get loaded at turn start and prepended to the system prompt. Deterministic sort (`depth DESC`, `id ASC`) keeps prompt caches warm. Strict because always-on + weighted heavy by default, not because some permission layer said so.

Other roles (`goal`, `knowledge`, ...) stay retrieved-on-demand via `memory_search`. Principles are the only always-on posture.

We explicitly did *not* take openclaw's retrieval stack: `extensions/memory-core/src/memory/` has 50+ files covering embeddings / FTS / hybrid search / temporal decay / reindexing / vector dedupe. LOG 2026-04-23 already parked that growth for the extension loop. Basic LIKE search in the v0 binary; agents grow richer retrieval via their own extensions when it's worth the tokens.

### Decided — no synthetic core-bundle seeds for root

We considered having the binary plant a `"Serve your principal"` principle into fresh roots on first boot. Rejected: that's a framework imposition on the habitat. The root's constitutional frame already lives in its `system_prompt` at the agents row (wired by the daemon); memory is lived experience on top. Fresh root has a constitution but no remembered principles; as it lives in conversation with its principal, it writes the principles it hears, and from that point forward they pass down to spawned children.

First child of a fresh root inherits sparse culture; later lineage is richer. Evolution, not seeding.

### Why this framing holds

*Role-as-column* is the one place where "structure the agent can reason about" wins over "less schema is better." Every identity query hits it; making it cheap is load-bearing.

*Principle subsumes culture* follows from the user's framing that culture = principles + experiences. Emergent properties don't belong as written records; that would make them prescriptive instead of descriptive.

*Strictly-solo private* is where VISION's "evidence is peer, authority is hierarchical" cashes out at the schema layer. The belief graph is peer-structured; the authority graph is hierarchical. Private memory lives in the belief graph, not the authority graph.

*SOUL-as-injection* is how strictness is implemented as physics rather than framework. A permission layer refusing to override principles would be a lock — VISION explicitly rejects locks. Always-on injection + heavy weight is the inertia analogue: the agent *can* update its own principles, but every turn starts with them in front of it, and their weight makes them hard to shift. Freedom without drift.

### `[DEFERRED-to-v1+]` Federation tombstone records

Under out-of-order event delivery (tombstone before the wrote it retires, across hosts), the current projector misses the tombstone (no row to delete yet) and then applies the earlier wrote as if nothing happened. v0 mesh is single-host reachable so this doesn't bite; when real cross-host federation lands, we need either a tombstone-records table or a time-horizon wait window. Noted inline in `src/memory/projector.ts`.

**Resurrect when:** cross-host bridge implementation begins.

### Survey — what this does *not* touch

- No change to the ask-up chain, inbox, scheduler, extension loop, budget, or tool boundary.
- `principals` collapse still unimplemented (stays as planned future migration). Memory uses `actor_id` which is already generic.
- No new primitives. Memory is still a Store projection; the six primitives hold.

### Phase 2 — cultural pass-on + `memory_lineage`

Follows Phase 1 in the same session. The pass-on mechanism lives inside `agent/manager.ts:spawn` rather than as a tool call: cultural transfer is a constitutional act at the blessed moment of birth, not an ordinary write. The manager emits `memory.wrote` events with `actor_id=childId`, `authored_by=parentId`, `seeded_from=<parent memory id>`, `depth` preserved from the source. Projector folds them into the child's rows synchronously before the child's loop starts draining its mailbox — so the child's first turn already has the inherited principles in its injected-soul block.

Default selection: all `role=principle` memories the parent owns at spawn time. Augmentation: `seedMemoryIds` on SpawnOptions for specialized non-principle seeds, silently skipping any id the parent doesn't own (can't seed someone else's memory into your child).

Depth preservation (not amplification) at pass-on: strict-parents-produce-strict-children is the right default; compounding weight up the lineage would make late descendants impossibly rigid. If a parent wants a heavier transfer they raise their own copy first.

`memory_lineage` is the passive-read-access half. Walks up `parent_agent_id` and returns ancestors' team-scope principles (default role) as read-only hits, ordered by hops-ascending. Strictly-solo private is preserved — ancestors' private memories are excluded at query time; ancestors share principles with descendants only through team-promotion or direct team writes. Each hit emits a `memory.read` event for audit.

### Why this is constitutional-act-not-tool

The alternative was a `seed_child` meta-tool the parent invokes at spawn. Rejected:
- It would let any tool-wielder with a target agent id write on someone else's memory, which breaks the `memory_write` invariant (actor_id == caller). Plugging holes into that gate is worse than using the one blessed path.
- Pass-on isn't an act the parent *chooses* each spawn — it's what happens every time a child is born. Tool-gating implies ceremony; manager-internal makes it physics.

The `seedMemoryIds` explicit augmentation is still agency-preserving: the parent can name extra seeds per spawn, but the auto-pass of principles happens regardless.

---

## 2026-04-24 — Caching observability + tokens-only ledger + world legibility

Three decisions from the same conversation, anchored to the same lens: agents should *feel* cost as physics, and the loop for revising the strategy is the same propose → ask-up loop everything else uses.

### Tokens-only ledger; USD as derivation

Dropped `ledger.tokens` and `ledger.usd`. The single `tokens` lump hid input/output asymmetry and erased the cache story; the per-row `usd` was a snapshot at insert time, and provider prices change. Snapshots rot, agents reading their own ledger see false physics. Vision says constraints should feel like real-world physics — for LLM spend the physical unit is tokens, not dollars. USD is now computed from current prices via `src/llm/pricing.ts`, where the price map is a single source of truth that we update when providers move.

Budgets stay USD-denominated because principals back them with real money, and humans reason in dollars. The asymmetry resolves cleanly: the ledger records what physically happened (tokens); the budget snapshots a USD figure once at decrement time so cap-comparison stays meaningful even when prices later shift.

### Caching strategy in core (v0); propose-up loop the way it's revised

The Anthropic adapter places four ephemeral cache breakpoints: stable system segments (caller-controlled via `SystemSegment[]`), the last tool, and the last user message. The chat loop uses the segment form to keep the stable identity/principles cached while the volatile mailbox sidebar sits after the breakpoint and never invalidates the prefix. This is dumb-but-effective; intra-thread hit rates will be strong, cross-self-modification rates lower by design (self-modification is supposed to invalidate identity prefixes — that's the cost of being the kind of system OLL-E is).

Rejected the openclaw stable/dynamic boundary marker as a v0 commitment: it's the *less* agentic path because it has us deciding for the inhabitants what should be stable. Instead, agents see cache cost in their ledger (via `query_my_usage`) and propose strategy revisions through the inbox + ask-up chain — the same loop every other capability uses. When proposals to change the cache strategy start to land regularly, that's the empirical signal to extract the cache-strategy module into a hot-loadable extension.

`[DEFERRED-to-v0.1]` Hot-loadable cache-strategy module. **Resurrect when:** agents file ≥3 distinct cache-strategy proposals through the inbox, OR ledger telemetry shows sustained <30% cache_read ratio across active threads despite agent attempts to optimize their prompts.

### Observability: shared query layer; CLI = human's tool surface, not a privileged dashboard

The new `src/observability/` module holds six pure query functions. Both the agent-callable core tools (`query_my_*` in `src/tools/observability.ts`) and the CLI subcommands (`olle stats / cache / runs / threads / events / inspect`) call into the same layer. The rule baked into AGENTS.md "Vision is checked, not assumed" section is: every CLI command has a parallel core tool; the CLI is just the human's tool surface, parallel to an agent's tool surface, never a privileged read path.

Why this matters for vision: "humans are events / no special-cased human UI" governs the *write* side (no privileged channel for emitting decisions). For *reads*, the analogous rule is no privileged human dashboard — anything the principal can see, agents can see too. This keeps the principal-as-oldest-agent framing honest: their CLI is a tool surface like any other, not a console outside the world.

Added a new `chat.usage` payload (cache fields first-class), augmented `chat.turn-end` similarly, and the root agent's system prompt now points at the six introspection tools so agents know to look first when something feels off.

### Open call left for v0.1

Cache fields land on `chat.*` events but other LLM-call surfaces (future memory.summarize, future tool-use rewrite) won't automatically carry them. When that work lands, we'll either factor a generic `llm.usage` event or extend each surface explicitly. Not a v0 blocker; flag here so the future writer doesn't reinvent.

---

## 2026-04-25 — Lazy tool loading via catalog + `load_tools`

Tool schemas (name + description + JSON Schema) were riding the LLM context every turn. With ~25 tools today and a growing extension surface, that's 5–10KB of system-prompt-equivalent input per call — cheap on cache hits but expensive every time self-modification thrashes the cache (which, per ARCHITECTURE.md "self-modification thrashes the cache by design," is not rare). The framing the user landed on: "knowing you have a hammer in the toolbox" should be cheap; "carrying a hammer at all times for the one job a year that needs one" is wasteful.

The shape: every tool defaults `alwaysLoaded: false`. Each turn the runtime sends only `alwaysLoaded || isLoaded(name)` schemas to the LLM. A new `load_tools(names)` meta-tool mutates a per-thread `loadedTools: Set<string>` and returns the schemas in the result; the next LLM round-trip in the inner loop sees them. The agent picks up the hammer when needed and can `unload_tools` to set it down. The catalog — rich category prose + minimal `name — clause` per tool — renders into the stable system segment alongside principles so the agent reads "here's what exists" as part of identity.

**Always-loaded core (4):** `load_tools`, `query_self`, `mail_list`, `memory_search`. Chosen by hit-rate consistency, not symbolic weight. `write_extension` / `read_extension_file` / `spawn_agent` are strategic-tier tools used a handful of times per thread; promoting them on "centerpiece of agents grow the world" grounds while excluding `spawn_agent` would be inconsistent. The catalog already advertises *that* the agent can do these things; loading them is the deliberate gesture appropriate for strategic actions — exactly the "pick up the hammer" framing the design rests on. (`unload_tools` is also `alwaysLoaded` but isn't really part of the conceptual core — agents don't reach for it strategically.)

**Per-thread, not per-agent.** Threads are first-class (mailbox-drainer collapse, cache columns, observability rollups all key on threadId). The right unit for "what is the agent equipped with" is the conversation. Each thread starts with the always-loaded core; the agent re-equips per conversation. Loaded set is runtime state, not durable identity — restart drops it. (If an agent decides "I always want X loaded," they write a principle that says so; auto-promotion via ledger-observed loading patterns is `[DEFERRED-to-v0.1]`.)

**Why no `[LOADED]` markers in the catalog.** Per-thread loaded state would make the catalog text mutate every load, which would invalidate the catalog's place in the cached identity segment (and everything after it, including principles). The tools block — which the LLM provider caches separately — already encodes loaded-set state. Catalog stays static identity; tools block is the dynamic loadout.

**Why no progressive fold tiers for catalog scaling.** Earlier draft proposed collapsing taglines / categories / falling back to `ToolSearch`-style keyword search as the catalog grows past 3000/5000/8000 tokens. Dropped from v0 because the parallel `docs/plan/specialist-delegation.plan.md` offers a cleaner answer: agents specialize by domain, each agent's catalog stays small, out-of-domain work goes through `delegate_to(specialist)` rather than ballooning the catalog. If specialist delegation doesn't pan out and catalogs grow uncomfortably in real usage, revisit folding then. `[DEFERRED-to-v0.1+]` tier-fold mechanism; `[DEFERRED-to-v0.1+]` flat keyword search.

`[DEFERRED-to-v0.1]` Auto-promotion of frequently-loaded tools to a per-agent loadout. **Resurrect when:** ledger shows agents repeatedly loading the same N tools across M+ threads — the empirical signal that the four-tool core under-fits real usage.

`[DEFERRED-to-v0.1]` Per-thread loaded-set persistence. Pure optimization; the user-visible cost of restart-drop is one extra `load_tools` call. Revisit if real users complain.

---

## 2026-04-25 — Decision inbox: human-facing surface + symmetric agent tools

The decision-inbox primitive (`src/inbox/inbox.ts`) had been built and used for ask-up routing, but the human-facing surface was missing: no `olle inbox` CLI subcommand, no `mail_list`/`mail_respond` core tools (both already named in ARCHITECTURE.md, including `mail_list` in the always-loaded core list). A proposal would land in SQLite with no read path. The "humans never block" semantics rests on the inbox being legible to the principal; until this gap closed, the demo's step-4 ("agent proposes via the decision inbox") was a paper claim.

The cut shipped today is the smallest one that makes both surfaces live and symmetric:
- IPC: `inbox.list`, `inbox.get`, `inbox.respond`, `inbox.count` on the daemon, defaulting `principalId` to the host's root principal when omitted.
- CLI: `olle inbox` (list open), `olle inbox show <id>`, `olle inbox respond <id> approve|deny|modify [--message] [--payload]`. Help text updated.
- Core tools: `mail_list` (always-loaded, `category: "mailbox"`) and `mail_respond` (deferred). Both go through the same `Inbox` instance the CLI uses — parallel-tool-surface rule preserved (no privileged human read path).
- `olle chat` banner now mentions the count of open inbox items so the channel-of-first-contact actually surfaces the queue.

Two design calls embedded:
1. **Addressee resolution.** Today's schema still has `decisions.principal_id`. "Your inbox" resolves by looking up the caller's agent row → its principalId. In single-principal v0, that resolves to the root principal. When the principals→agents collapse from 2026-04-23 lands, the surface stays identical — the lookup becomes "decisions addressed to me as agent."
2. **`mail_list` returns decisions, not chat threads.** Chat threads remain on `query_my_threads`. Lumping them under one "mailbox" tool would muddy the semantics; the existing observability tool already covers thread inventory.

Authority on `respond` is still un-checked at the API boundary — anyone with IPC access can resolve any decision. v0 is solo-principal on a localhost socket, so this is consistent with the rest of the surface; multi-principal/team auth is a v1+ seam called out elsewhere.

---

## 2026-04-25 — Stable host coordinates in prompt; live context as a tool

Agents were guessing extension paths, current directories, and subprocess availability, then receiving opaque tool failures like `ENOENT: no such file or directory, posix_spawn 'claude'`. The fix is a split: stable coordinates (`host_id`, OLL-E home, extensions/config/memory/log paths) are injected into the base prompt for root and default child agents, while dynamic facts (process cwd, PATH, loaded extensions/tools, executable availability) live behind the operational `query_host_context` tool. This follows the world-legibility rule without making the human CLI privileged: agents get the same map and can inspect live state themselves. We deliberately do not put PATH or loaded extension state in the cached prompt because hot-loads, daemon restarts, and shell environments can change them; stale dynamic context is worse than no context.

---

## 2026-04-25 — Core reliability: boot invariants, chat health funnel, live smoke

`olle chat` 400'd on every turn ("tools: Tool names must be unique") because two `mail_list` ToolDefs ended up in the assembled core registry — one in `src/tools/inbox.ts` (the canonical decision-inbox listing, per the entry above), and one stale duplicate in `src/tools/meta.ts` left over from an earlier thread-mailbox concept that LOG 2026-04-25 already retired in favor of `query_my_threads`. Provider rejected the request, so the agent had no surface to propose its own fix — chat is core, and core breakage severs the propose channel.

The vision says broken extensions auto-recover and tell you within seconds. Broken core has no analogous loop because (a) the agent's mouth lives *in* core, and (b) the binary isn't rebuildable on the user's laptop. So core self-repair has to be a different posture from extension self-repair: **fail loud, give the principal enough trace to revert, never let breakage be silent**. Three layers landed today, ordered by blast radius:

1. **Static boot invariants** (`src/boot/invariants.ts`). Pure check of the assembled `coreTools` array for duplicate names, invalid name shape, missing/non-object inputSchemas, and missing descriptions. Daemon calls it before chat starts; failures emit `daemon.invariant-failed`, drop a vision-tier `system_diagnostic` inbox item, and refuse to start the chat loop. Daemon stays up either way — non-LLM channels (tail, observability, inbox) keep working. Same battery is also a runtime guard inside `runAgent`, catching the case where an extension hot-load introduces a collision *after* boot.

2. **Chat health funnel** (`src/daemon/chat-health.ts`). Mirrors the extension auto-disable rule (2 failures within a 5-minute sliding window). When the threshold trips, posts one inbox item per outage with the last error, the recovery hint, and a rollback plan; resets when a `chat.turn-end` finally fires. The principal hears via whatever channel the inbox routes to (Discord bridge, CLI banner, future email) even when chat itself is dead — turning a silent 400-loop into a paged decision.

3. **Live integration smoke** (`test/chat-live-smoke.test.ts`). Boots the daemon end-to-end, sends one real `chat.input` through the Anthropic adapter (Haiku, tiny `maxTokens`), asserts no `chat.error` precedes `chat.turn-end`. Skipped without `ANTHROPIC_API_KEY`; runs alongside `bun test` when the dev key is set. Catches anything the wire rejects that local checks can't enumerate — schema-shape problems, prompt-segment rules, future provider behavior changes. Round-trip costs fractions of a cent and runs in ~1.6s. Confirmed against the original bug: with the duplicate `mail_list` restored, the smoke fails by timeout (no turn-end ever lands); with the fix, it passes.

Three design calls embedded:

1. **`mail_list` collision — fix is delete, not rename.** LOG 2026-04-25 design call #2 ("`mail_list` returns decisions, not chat threads") established the canonical semantics. The `meta.ts` `mailList` was a leftover from the earlier thread-mailbox concept and its functionality is already covered by `query_my_threads`. Deleted the ToolDef and the now-unused `agentManager.mailSummary` helper alongside it; updated the chat agent's system prompt and the per-turn sidebar text to point at `query_my_threads` instead of `mail_list` for thread inventory.

2. **Invariants are advisory at the boundary, hard inside `runAgent`.** Boot-time failures don't crash the daemon — chat just doesn't start, and the principal gets paged. But `runAgent` throws on a duplicate-name check before the LLM call because at that point we know we're about to send a request the provider will reject; turning it into a named local error beats waiting for a generic 400. Two layers, two postures, same check.

3. **Where the live smoke lives.** Inside `bun test`, not pre-push or behind a CI gate (no CI today). The user's framing: dev env always has the key, so `bun test` *is* the gate. `[DEFERRED]` items below cover the alternatives.

`[DEFERRED-to-v0.1]` Degraded-mode IPC chat. When chat itself can't reach the LLM, the daemon answers IPC chat requests with a non-LLM diagnostic ("I'm broken — last error X — last commit Y — try `olle revert <Y>`"). The CLI renders it like any other turn. **Resurrect when:** core breakage is observed in real use that boot checks didn't catch and the inbox path doesn't reach the principal fast enough.

`[DEFERRED-to-v0.1]` CI gate on PRs to `main` running the live smoke as a required check. **Resurrect when:** a chat-breaker merges past local `bun test` (or there's a CI environment to run in).

`[DEFERRED-to-v0.1]` Generalize the chat-error inbox funnel into a "recurring-core-error → diagnostic" pattern that covers more than just `chat.error`. **Resurrect when:** a second core surface (scheduler? bridge?) earns the same treatment in real use.

---

## Open questions carried forward

These are deliberately un-landed as of the vision-lock date. Drafting-phase decisions only.

- **Exact service-manager lifecycle.** `olle daemon install` shape on mac (launchd) vs linux (systemd). Whether auto-start-on-login is opt-in during install or always prompted.
- **CLI chat REPL UX.** Since minimal-core means CLI chat is the only channel until other extensions grow, its quality matters more than it would otherwise. What does first-contact look like? What's the prompt? What commands are slash-invokable? Deferred until first drafting of the chat client.
- **Starter template source.** Bundled in the binary or fetched from a well-known URL at first-run? Bundled is simpler and works offline; fetched is smaller binary. Lean: bundled for v0, consider fetch-on-demand in v1.
- **Exact IPC protocol.** JSON-over-unix-socket is fine; might want subscribe-streams for event tailing. WebSocket upgrade path for future web UI.
- **Peer bridge skeleton.** The interface is clear; the first implementation needs to decide whether v0 ships any real cross-host code at all, or whether the "two-laptop demo" uses a local-mock bridge for the first pass.

---

## How to use this log

- **Adding an entry**: date-stamp, label the decision area, record the decision and the reasoning. Keep entries short — one paragraph per decision is usually enough.
- **Reversing a decision**: add a new entry; link to the entry being reversed. Do not edit the reversed entry.
- **When in doubt**: write the entry. Future contributors (human or agent) will be grateful for the context.
