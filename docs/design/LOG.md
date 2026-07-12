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

## 2026-04-26 — Extension authoring loop: smoke fresh, dispatch live, register auto-loads

A real run inside OLL-E surfaced three structural bugs in the propose → write → smoke → hot-load loop — the load-bearing self-modification mechanism. The agent burned ~6 turns on wrong theories because the world was lying to it. Three fixes landed:

1. **Smoke runs fresh every call.** `run_smoke_test` was importing `smoke.ts` with a `?t=${Date.now()}` query string, but Bun's ESM cache keys on resolved file path and ignores the query, so re-edits kept seeing the first version's error. The runtime's `load()` already solves this by staging into a ULID-suffixed temp dir before importing — same trick now exposes through a public `ExtensionHost.smokeTest(name)`. The meta-tool became a thin wrapper, deleting a duplicate (and subtly divergent) secret-resolution path that also happened to pass `undefined` where the runtime passes `opts.bus`. Single source of truth for smoke staging + secrets.

2. **`list_extensions` for on-disk-but-unregistered extensions.** `query_host_context` and `olle extension list` both showed only loaded extensions, so an agent could entirely forget it had authored an extension in a prior session. New `ExtensionHost.inventory()` returns `{name, status: registered | unregistered | broken, path, lastCommit}` for everything under `~/.olle/extensions/` with a manifest. Wired into a new core `list_extensions` tool AND the existing CLI subcommand — observability rule says every CLI surface has a parallel agent tool, both reading the same layer. The "agent forgets they built X" failure mode was tempting to solve with a system-authored memory note ("you built X on date Y"); rejected. **Memory is identity. The system writing identity-bearing memory on the agent's behalf would be the system speaking *as* the agent — same category of mistake as a privileged human dashboard, just inverted.** The right answer is to make the world queryable; the agent decides what's worth a memory note.

3. **Live tool surface in chat.ts; `runAgent` re-resolves per round-trip.** The chat loop snapshotted the tool list once at turn start (`coreTools = collectTools(opts)` at `chat.ts:175`) and the snapshot fed both the LLM tool list and the dispatch table. Mid-turn `register_extension` therefore left the new tool invisible to the LLM, "unknown" to the dispatcher, and unfindable by `load_tools`; a renamed-away tool stayed dispatchable because it was still in the snapshot even though the host's internal map (correctly) cleaned it up. Replaced the snapshot with a live `getTools()` getter that re-reads `opts.extensions.tools()`. Threaded the getter into `runAgent` so it rebuilds `toolByName` and the visible-tool filter at the start of every round-trip. The catalog stays turn-stable on purpose — it lives in the cached system prefix, and invalidating it mid-turn defeats the cache architecture (an agent that just registered already knows the tool exists; the catalog being one-turn-stale is acceptable).

Two design calls embedded:

1. **`register_extension` auto-loads its declared tools into the calling thread's `loadedTools` and surfaces their schemas in the result.** ARCHITECTURE.md says "lazy by default" for the loadout — that rationale is about prefix-token cost for tools the agent *might* want. Irrelevant to a tool the agent just authored: write+smoke+register is explicit cost paid with intent to use. Forcing a separate `load_tools` hop is exactly the papercut habitat philosophy is supposed to delete. `unload_tools` remains the cheap path back if the agent regrets the inflation. Per-thread runtime state, not durable identity — same model as `load_tools` itself.

2. **Reject the auto-stub-memory shortcut for "you authored X."** See above — making the world observable (`list_extensions`) is the more-agentic path. The agent retains agency over its own identity surface; the system supplies a queryable world.

`[DEFERRED-to-v0.1]` Tool prefix-cost surface. Auto-load on register (and `load_tools` by hand) silently commits the agent to shipping tool schemas in every subsequent turn's prefix. There is no surface that says "loading X costs N prefix tokens/turn" — the agent has to estimate from `inputSchema` size. Possible shapes: per-tool prefix-byte estimates in the catalog, in the `load_tools` / `register_extension` result, or in `query_self.loaded`. **Resurrect when:** the first agent files an inbox proposal about loaded-set bloat, OR ledger evidence shows recurring loads that could have been avoided.

---

## 2026-04-26 — Caller identity for `retargetThread` (resolved same day)

The `retarget_thread` meta-tool now passes `ctx.actorId` through to `manager.retargetThread`, so `thread.retargeted` events attribute to the agent that requested the redirect rather than to the manager process. `callerId` is required on the manager API; the previous `agentFromCall()` placeholder is removed. The earlier same-day [DEFERRED-to-v0.1] entry is retired — promoted in the same review pass that flagged the dead-weight parameter.

---

## 2026-04-26 — `mail_propose`: agent-initiated decisions, symmetric wake on reply

The decision inbox primitive existed and was wired into `askUp()`, but `askUp()` only fired *as a side effect* of the permission gate denying a call. No agent — child or root — had a tool to **proactively** open an ask up the chain. The asymmetry the running olle agent surfaced ("children have a more reliable way to reach me than I have to reach you") is real, but the deeper diagnosis is that *no* agent has the capability today; root just feels it most because no scheduler ever denies anything on its behalf. Fixing it for root alone would re-introduce the special-cased human path the architecture is moving away from. Fix it universally instead.

**The shape that landed:**

- **`mail_propose` core tool** (`src/tools/inbox.ts`), `category: "mailbox"`, `tier: "strategic"`, deferred-loaded (catalog-visible; loaded on use). Wraps `askUp()` from the caller's `actorId` toward `opts.principalId`. Returns `{kind: "auto-approved" | "queued", decisionId?, approverAgentId?}` so the caller knows what happened and can store the id to correlate later.
- **`mail_list({direction})` filter** — `'in' | 'out' | 'both'`, default `'in'` (back-compat). `'out'` returns decisions where `proposingAgentId === ctx.actorId`; lets a proposer check "did my asks get answered?" without inventing a new tool. New `Inbox.listProposedBy()` query is a one-line WHERE; `'both'` is union-deduped on id.
- **Bus-subscribe wake on the agent loop** for `decision.resolved` where `proposingAgentId === me`. Debounced (~2s quiet window) → synthesizes a `chat.input` event on a stable per-agent thread `mailbox:<agentId>` with text "📬 N reply/replies — `mail_list({direction:'out',includeResolved:true})` to view." The existing `chat.input` handler picks it up and runs a turn on the mailbox thread. The agent reads the wake as input and decides what to do.

**The four design calls locked in conversation:**

1. **Debounced wake, not per-event.** A parent with 8 active children resolving asks in the same second gets one wake, not eight. Per-event is a perf tax with no semantic gain.
2. **Mailbox thread, not active thread, not in-place interrupt.** `mailbox:<agentId>` is a stable per-agent thread for processing inbound mail; it doesn't interrupt the agent's current work thread. The agent already pre-loads `mail_list` (always-loaded core) so the wake's only job is "you have a reason to think now."
3. **No reminder pings before staleness.** Deadlines are visible in `mail_list`; pinging twice is the chase pattern in a friendlier coat. Staleness is the absence contract — the proposing agent declares how long it can wait, the system fires `decision.resolved` with `vote: "stale"` on expiry, the proposer's `on_stale` runs.
4. **No synthetic seed principles.** Same answer LOG 2026-04-23 reached for "Serve your principal": the binary doesn't plant the *posture* of when to mail-propose. The principal teaches it in conversation; cultural-pass-on inherits the principle to children. Capability is core (it can't be missing); posture is grown.

**The two `[DEFERRED]` items embedded:**

- **`toAgentId` parameter on `mail_propose`** that addresses a specific ancestor (not just "run askUp"). Today addressing an ancestor (vs the principal) requires a new `addressed_agent_id` column on `decisions` plus the wake subscription extending to `decision.proposed` filtered by it. Dropped from this cut because the principals→agents collapse from LOG 2026-04-23 will subsume the work — once principal is just the topmost agent, "addressed to ancestor X" becomes the natural shape and the schema bump happens then. v0 callers get the askUp behavior unchanged: child-tier-delegated → resolves at parent silently; otherwise lands on principal. **Resurrect when:** the principals→agents collapse migration is being drafted.
- **`decision.escalated` events at each propagation hop**, so an ancestor whose chain a proposal walks past gets read-only awareness without being the addressee. Not needed today (nobody subscribes), useful when v0.1 introduces the `addressed_agent_id` shape above. **Resurrect when:** the same migration above lands.

**Why this is core, not extension:** the inbox primitive is core, attribution + redaction events are emitted by the runtime, and the `actorId` provenance comes from the live tool-execute context. An extension synthesizing principal mail would be lying about provenance — same reasoning that put `mail_list`/`mail_respond` in core (LOG 2026-04-25 design call #2). The propose tool joins them on the same boundary.

**Why no system cron sweeping mailboxes:** would be a concession that we don't trust the bus and a framework imposition (we decide when agents check). Anti-agentic. If a particular agent wants belt-and-suspenders polling, it authors a userspace trigger via the extension loop — the more-agentic path.

**Why the human's wake is not in this PR:** the human is just an agent whose mailbox subscriber is a *bridge*, not a loop. The CLI banner already subscribes to `decision.proposed` for the principal (LOG 2026-04-25); future Discord / Telegram / email bridges are extension territory, authored through the standard propose → write → smoke → register loop. Same `decision.proposed` event, transport-agnostic. The propose tool doesn't know or care which transport delivered.

---

## 2026-04-26 — Extension event scopes are manifest-declared and enforced

Security review found that extension manifests declared broad capabilities informally, while `api.on()` and `api.publish()` could still read or emit any bus event. That made the event log a hidden ambient authority and let a compromised bridge impersonate unrelated behavior. The fix keeps the extension loop agentic rather than introducing an admin side channel: manifests now declare `eventReads` and `eventWrites`, and the runtime enforces those lists for bus subscriptions, direct publishes, trigger emits, scheduler task subscriptions, and task emits. Widening an extension's event surface is a normal propose → write → smoke → hot-load edit, visible in git and reviewable with the rest of the extension.

---

## 2026-04-26 — Daemon survives extension throws via process-level fault isolation

A stale on-disk `cron-trigger` manifest (predating the previous entry's eventWrites enforcement) sent the daemon into a crash-restart loop: its `setInterval` callback called `api.publish("cron.fire", …)`, the new authority assertion threw, and Node terminated the process because no `uncaughtException` handler was installed. The supervisor relaunched, the bug recurred immediately, and `olle chat` showed a continuous reconnect loop.

Architecture already promised "crashed extensions auto-disable and notify; they do not take down the daemon," and the breaker was already built — `ExtensionHost.reportFailure` had been counting failures, tripping at 2-in-5min, marking the row crashed, and unloading. The missing piece was the wire from "Node would otherwise call `process.exit`" to that breaker. Resisted wrapping every `setInterval`/`setTimeout` at the api boundary (extensions call those directly; we don't control the call sites) and instead added a single `process.on("uncaughtException" | "unhandledRejection")` guard at daemon startup that calls a new `host.attribute(err)` (path-prefix match against the extensions dir and the in-memory staging dir) and routes attributable throws into the existing `reportFailure`. Unattributed throws log loudly and are dropped — daemon never exits. No new circuit-breaker primitive; the elegant fix was plumbing into the one that already existed. Lives in `src/daemon/fault-isolation.ts`; uninstalls on `daemon.shutdown()` so test harnesses don't accumulate handlers.

Follow-up still owed: `reportFailure` emits `extension.crashed` events but does not yet post a decision-inbox item with the rollback option (the architecture's "Last working commit was X, options: revert / keep-disabled / inspect" UX). Tracked separately.

---

## 2026-04-27 — Sidebar surfaces unread decision resolutions on origin thread

A real chatlog with the running root agent surfaced the gap: the agent files `mail_propose` from chat thread T1, ends turn, principal approves by email hours later, principal returns to T1 and asks "what happened?" Agent self-diagnoses as "no wake scheduled" and proposes a memory note ("remember to check `mail_list direction=out` each turn"). Both are wrong shape.

The wake from LOG 2026-04-26 *is* implemented — `agent/chat.ts` subscribes to `decision.resolved` and synthesizes a `chat.input` on `mailbox:<agentId>`. The agent reacts there. But the principal sits on T1, where the existing `buildMailboxSidebar` surfaces other-thread activity and nothing about resolution state. The wake landed somewhere the principal wasn't watching, and the agent's instinct ("remember to look") was discipline-as-fix instead of physics-as-fix — the exact failure mode VISION calls out.

Three more-aggressive shapes were considered and rejected before the cut narrowed:

1. **Task-ref continuations on decisions** (`on_resolve_task_id`, `on_stale_task_id`, per-id event topics, `mail_propose({onResolve, onStale})` params). Adds a new lifecycle hook to decisions and a derived event topic convention. Real value, but no v0 task today wants to resume mid-flight after approval — the demo flows don't need it. Per AGENTS.md test #2 ("new instance, not new primitive"), this hasn't earned weight. **Resurrect when:** the first task in real code surfaces a mid-execution approval need; design the shape against the actual call site.
2. **Routing the wake to the proposal's origin thread** (instead of `mailbox:<agentId>`). Closes the loop in the place the user is watching — but forces a full prefix replay on T1 every time a resolution lands. T1 may be hundreds of thousands of tokens; user offline past Anthropic's ~5min cache TTL means cache-cold; the system would be punishing the agent for having had a long conversation. Bad physics. **Resurrect when:** thread-context cost stops being a load-bearing constraint (smaller models priced flat? structured-summary turns? not v0).
3. **Persisted ack** via a `decisions.acked_at` column. State that can live in-memory in the agent loop as a high-water mark per agent. Restart loses it → first turn after restart re-renders one batch of recent resolutions → that's a feature (the agent gets re-oriented), not a bug. The pull-side (`mail_list direction=out includeResolved=true`) is the durable audit. A column + migration + index for "did I render this row in the prompt yet" is overkill.

**The shape that landed (one change):**

- **`buildMailboxSidebar` extended** in `src/agent/chat.ts` to include resolved decisions where the calling agent was the proposer and `resolved_at >= thread.mailHwm`. After rendering, the thread's HWM advances to `nowAtRead + 1`. The HWM lives **per-thread** on the `Thread` interface (not per-loop) — initialized to loop-start time the first time a thread is touched. Section appears alongside the existing thread-activity lines in the per-turn sidebar.

That's it. No migration, no new column, no event topic, no tool param, no scheduler change. Wake on `mailbox:<agentId>` stays exactly as is.

**Why per-thread HWM, not per-loop.** First draft was a single shared HWM at loop scope, which broke the actual flow: the from-idle wake fires a synthetic `chat.input` on `mailbox:<agentId>` ~2s after resolution, the agent runs a turn there, the sidebar renders the resolution and the shared HWM advances past it — so when the user re-engages on a separate chat thread, that thread's sidebar shows nothing. Per-thread isolates: mailbox-thread acks for itself only; user-facing chat thread still sees the unread resolution on its next turn. Cost: when the user has multiple chat threads simultaneously, each renders the same resolution once. Acceptable for v0; the alternative (shared HWM) defeats the whole purpose since the wake always wins the race.

**Cost story (the load-bearing reason for this shape).** The wake fires on `mailbox:<agentId>` — a small, bounded thread — when resolutions land while the agent is idle. That turn is cheap. The sidebar fires on T1's *next* turn, which is user-initiated and would have been paid for anyway. Sidebar adds a few hundred tokens of "by the way these resolved" context to a turn already in flight. Total extra LLM cost over baseline: zero forced turns. Routing the wake to T1 (option 2 above) would have been zero-implementation-complexity but pathological cost-wise; this rejection is the load-bearing one in the conversation that produced this entry.

**What the user perceives.** Approval lands → agent reacts on `mailbox:<agentId>` (work executes if applicable; tool calls land in event log + extensions/ git history regardless of which thread initiated them). User returns to T1, types anything → sidebar shows "D1 approved by root 2h ago — see mailbox:root for follow-through" → agent's reply on T1 summarizes the state. Close-loop arrives where the user is looking, with no extra forced LLM call.

**Why this is enough for v0.** The chatlog gap is "agent doesn't notice approvals on threads other than mailbox." Sidebar fixes that on the proposer-side surface. Anything more (continuations, origin routing, persisted ack) is forward infrastructure that hasn't been earned by a real call site. Future calls — when they arrive — can ride the same propose → review → ship loop.

**Why nothing changes for `decision.escalated`.** That event is deferred from LOG 2026-04-26 and is observability-only — intermediate hops along an ask-up chain. Continuations only fire on terminal resolve, which is the right boundary; the escalated event lands without a continuation hook because nobody's asking to *do something* on a hop, only to know it happened.

---

## 2026-04-27 — Trigger declarations are their own authority statement; transactional `load()`; first-wins tool registration

Three stacked bugs surfaced in a single chatlog: agent registered three discord extensions, the first failed manifest validation, and every subsequent agent turn — including unrelated `hello?` — died on `runAgent: duplicate tool name "discord_send" in registry — refusing to call provider`. The agent was wedged with no path to recover via its own tools.

**Root causes, deepest first:**

1. **The eventWrites gate on triggers was redundant double-bookkeeping.** LOG 2026-04-26 (extension event scopes) added `assertTriggerWrite` inside `startTriggers`, requiring `eventWrites: ["channel-message"]` even though the trigger itself was declared with `type: "channel-message"`. A trigger's `type` field at registration *is* the manifest-visible promise of what it emits — its `start(emit, …)` closure can never publish anything else. The cross-check could only ever catch manifest drift (an old on-disk extension predating the gate), never an actual unauthorised emit. That is exactly what hit here: a starter installed three days before the gate landed lacked the field a newer binary now demanded. The elegant fix is dropping the redundant check; `eventWrites` continues to gate imperative `api.publish()` and task-handler `emit()` where the authority surface really is unbounded without a manifest declaration. `ARCHITECTURE.md` updated to spell out the rule: trigger declarations are themselves authority statements for their type; eventWrites gates imperative emits.

2. **`load()` was non-transactional.** `impl.register(api)` populated `toolsByName`/`toolsByExt` with the discord tools, then `startTriggers` threw, and the throw escaped `load()` with no rollback — the registered tools were left orphaned in the registry while the extension itself was absent from `loaded`. A retry of the same extension (or a sibling extension declaring the same tool name) collided with the orphans. Fixed by wrapping `impl.register → startTriggers` in try/catch with a `purgeRegistry(extensionId, name)` helper that drops `toolsByName`/`toolsByExt`/`subs`/`tasksByExt`/`triggersByExt` and stops any partially-started triggers. `markStatus(extensionId, "inactive")` so the failure stays auditable in the DB. Extracted the same helper out of `unload()` since it does identical work — same job, two callers.

3. **`registerTool` and `resolveTools` had inconsistent duplicate semantics.** `registerTool` overwrote `toolsByName` on collision but pushed unconditionally into `toolsByExt`; `host.tools()` flattens `toolsByExt`, so two extensions claiming the same name produced a duplicated list, which `resolveTools` then refused with a thrown error that killed the agent loop before it ever reached the LLM. Made `registerTool` first-wins (rejects the second registrant with a `tool.collision-rejected` event and a warning log) so the registry is self-consistent by construction. Softened `resolveTools` to dedupe-first-wins + warn rather than throw — defense in depth. Limits should feel like physics, not refusals; the daemon must never trap the agent on a registry inconsistency.

**Why this is the elegant shape, not a migration story.** An inbox-item-with-suggested-edit flow for stale manifests was on the table — host detects a missing `eventWrites` entry, opens a decision proposing the manifest patch. Rejected because the gate itself was the bug: a check that can only catch manifest drift, never an actual authority violation, is bookkeeping cosplay. Removing it dissolves the migration problem entirely; the on-disk discord extension just works on the next reload, with no host code editing the agent's own files (which would have violated the agent's agency over its environment) and no inbox dance for a deviation that wasn't real.

**What stays.** `eventWrites` and `eventReads` continue to gate the imperative paths where they earn their weight. `boot/invariants.ts` keeps the static-startup duplicate-tool check as a fail-loud — at boot, a duplicate is a config bug worth refusing to start over; at runtime, it's a registry inconsistency the daemon should observe and walk past. The two surfaces have different right answers.

---

## 2026-04-27 — Tool-result truncation: cap inline output, spill to handle, recover on demand

**The empirical pull.** Investigating a session that read `↑29 ↓7.8k R737k W299k $7.30`, daaaa pushed back on the observability surface — 737k cache reads felt impossible. The math reconciled (real bill, every byte priced correctly), but a single tool call dominated turn 1's W: `github_list_issues` returned 243KB (~60k tokens) in one shot. With caching costing 1.25× to write and 0.1× to read, that one tool result cost ~$1.85 of the $7.30 bill — 25% — and propagated into turns 2 and 3 as cache reads. The structural finding: W is dictated by what tools dump into the conversation, not by where we place cache markers. The lever isn't `anthropic.ts`; it's per-tool output discipline.

**The decision.** Cap every tool result at a system byte limit before it enters the message history. Outputs above the cap spill to a new `tool_results` table and are replaced inline with a stable preview block carrying the `tool_use_id` as a recovery handle. The agent recovers the rest via `read_tool_result(handle, offset?, limit?)` — always-loaded so the recovery path doesn't burn an extra round-trip.

**Implementation details:**

- **Two caps.** Per-call default 50KB, per-message aggregate 200KB. Tools may declare `maxResultBytes` for a tighter per-call ceiling. Per-message cap catches the "N parallel tools each at 49KB" failure mode the per-call cap leaves open; largest blocks spill first.
- **Stable replacement state on `Thread`.** A `Map<tool_use_id, preview>` ensures every later rendering of a spilled block uses the byte-identical preview. Without this, replays would produce different preview text (different size string), invalidating the prompt-cache prefix — the very thing we're optimizing for. A single instability bug erases the entire savings.
- **`tool_results` table, not a file.** Federation merge is a union+sort over rows. Keeping spill in the same SQLite store as events/ledger gives spilled content the same `host_id`/`actor_id`/`hlc` provenance every other user-facing record carries, and one sync target instead of two. `INSERT OR IGNORE` on `tool_use_id` makes persist idempotent under retry/replay.
- **Sensitive output stays sensitive.** Tools with `sensitiveOutput: true` are never spilled — the redaction substitute is already constant-size and there's no semantic gain from persisting `[redacted]`.
- **`read_tool_result` is always-loaded, not deferred.** Spilling happens reactively; the agent didn't choose to be in the recovery path. Forcing a `load_tools` hop just to learn the recovery surface is a papercut habitat philosophy is supposed to delete. Loadout cost: ~one tool's schema in every tool list. Cheap.

**Vision check.** This is the strongest "constraints feel like physics" example we have: the agent doesn't experience refusal — it experiences a smaller view of a large response with a handle to the rest, mirroring how real disks deliver large files. Tiebreaker passes: the agent has *more* agency (can choose to slice further or move on), not less. Self-modification holds — agents can edit `maxResultBytes` in their own extensions; raising the system cap goes through propose-up. Transport-agnostic — every tool is capped uniformly, no special-cased "human-friendly" tool. None of the six tests fails.

**What this does NOT do.** It doesn't change the cache-marker strategy in `src/llm/anthropic.ts` (we'd already verified that's not the problem). It doesn't add cross-extension `maxBytes` per call class — single system cap, simple to reason about. It doesn't summarize tool output — the head of the bytes is always a strict prefix; if the agent wants summarization it asks the tool for a smaller projection or summarizes the head itself.

**One `[DEFERRED]` item:**

- **`[DEFERRED-to-v0.1]` Starter-template patches.** The empirical case was the bundled `github` starter's `github_list_issues` returning unbounded pages. The starter template at `src/starters/templates.ts` could declare `maxResultBytes: 8_000` on listing tools and ship a `summary: true` projection by default. Held back deliberately: the agent owns its installed copy of the starter and can edit it through the extension authoring loop — that's the demo. Once we see whether the cap alone is enough, or whether starter authors keep tripping the same wire, backport the per-tool override into the seed. **Resurrect when:** more than one fat-output starter tool surfaces in real ledgers.

---

## 2026-04-27 — `mail_reply`: the agent → principal FYI edge

Manual-test thinking on the sidebar fix (LOG 2026-04-27 above) surfaced the bigger gap behind the user's expectation: when the principal approves, they expect a "done" reply to land back in the *same inbox conversation* — not on a chat thread, not on the agent's mailbox thread, *into the decision they just acted on*. That edge of the graph was missing. OLL-E had `principal → agent` (chat.input via any channel) and `agent → principal-needs-decision` (mail_propose, heavy / requires vote), but no `agent → principal-FYI`. So an agent that did the work after approval had nowhere to put a "shipped commit X" report that the principal would see in the place they were looking.

Three shapes were considered:

1. **Overload `mail_propose` with a `replyTo` parameter** (user's first instinct — same tool, simpler agent surface). Rejected: the schemas are genuinely different — `mail_propose` requires summary/payload/tier/deadline because it's opening a vote; a reply requires only a target id and text. Discriminated unions in JSON Schema are expressible but ugly, and the agent reading the catalog would have to learn "this tool does two things depending on which fields you pass." Two sibling tools with crisp single-purpose schemas read better.
2. **Overload `approvals` table with `vote=null` rows for non-vote messages.** Rejected: the schema requires `vote NOT NULL`, and dropping that constraint either loses the type guarantee or forces a sentinel vote value (`'comment'`) that muddles "approvals" as a name. One purpose-built table per conversational role keeps both readable.
3. **New `decision_messages` table + `mail_reply(decisionId, text)` tool.** Chosen.

**The shape that landed:**

- **Migration `0007_decision_messages.sql`** — `(id, decision_id, host_id, actor_id, text, at)` with `(decision_id, at)` index for the "show me the thread" read. `actor_id` is a weak ref (matches the `to_agent_id` / `events.actor_id` pattern from migration 0003) so mesh-bridged messages whose author isn't local don't fail FK and retired-agent cleanup doesn't cascade through history.
- **`Inbox.reply(input)` and `Inbox.listMessages(decisionId)`** — append a row, fire `decision.replied` (durable, with `textPreview` truncated to 200 chars in the payload + `textLength` so bridges can decide whether to fetch the full text from the row). List returns chronological.
- **`mail_reply` core tool** — `category: "mailbox"`, `tier: "operational"`, deferred-loaded (catalog-visible, loaded on use). Operational tier because the strategic cost was paid when the proposal was opened; replies are the cheap close-loop primitive that keeps the principal informed without re-entering the approval cycle. Resolves prefix ids (CLI-paste-friendly, same convention as `mail_respond`).
- **`olle inbox show <id>` enriched** — `inbox.get` IPC handler now returns `{ ...decision, messages: [...] }`. CLI renders the proposal + payload as before, then below: `replies (N):` followed by each message's timestamp + actor + text. Single round-trip; cheap query (indexed).

**The four design calls:**

1. **Sibling tool, not overloaded `mail_propose`.** Above. Same family (`mail_*`), same backing data (`decisions` row + child tables), separate tools per role. Catalog reads cleanly.
2. **Reply works on any decision regardless of status.** Originally considered restricting to resolved decisions only ("you can't comment on something not yet voted"). Dropped: blocking replies on open decisions would force agents to wait before reporting partial progress on long-running approved actions. Schema/tool stay permissive; the principle (below) provides the cultural shape of when to use it.
3. **Operational tier, not strategic.** A reply doesn't change the world — it just records what already happened. Strategic cost was paid at propose-time. Treating reply as strategic would make every close-loop note pay the same gate as the original ask, which would discourage agents from reporting at all. Wrong incentive shape.
4. **No automatic reply on resolution.** Considered: when `decision.resolved` fires, auto-post a system message into `decision_messages` saying "principal voted X." Rejected: that's the *principal*'s message (their vote), and `approvals.message` already carries it. Agents post their own follow-ups in their own voice; the system doesn't ventriloquize.

**Why the principal's behavior change is principal-authored, not code-planted.** Per LOG 2026-04-26 ("No synthetic seed principles"), the binary doesn't ship culture. The principal writes the principle "on approval, execute and report via mail_reply" via memory_write (role=principle); from there it auto-injects into every turn's system prompt and propagates to spawned children via cultural pass-on (LOG 2026-04-23). Capability lives in core (mail_reply is the missing primitive — that *is* binary work); posture is grown.

**One `[DEFERRED]` item:**

- **Bridges that push `decision.replied` to the principal in real time.** The CLI banner (LOG 2026-04-25) already subscribes to `decision.proposed` for the principal; the analogous subscription to `decision.replied` would surface "your agent reported back on D1" without the principal having to open `olle inbox show <id>`. Out of scope for this cut — the inbox-view-on-demand UX delivers the close-loop visibility; live push lands when there's a second observer (Discord/email bridge) that wants to consume the same event. **Resurrect when:** a non-CLI bridge that handles principal channels is being authored.

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

## 2026-04-28 — Soul-seeding via bootstrap prompt; identity moves out of the binary

The conversation that surfaced this: the root agent's identity ("you are olle, a helpful assistant…") was hardcoded at `daemon.ts:252-260`, which means an agent with full `memory_write` authority could *append* principles but never *replace* the identity that ships in the binary. Code is structurally more authoritative than any principle the agent will ever write — that violates "the environment is clay, not prison" and "every extension is replaceable by the agent itself." The fix is to move identity out of the binary and into seeded memory rows the agent (and its principal) own and can rewrite.

**The shape that landed:**

- **Two boot prompts.** When the root agent has zero `role='identity'` memories, the daemon uses a **bootstrap interviewer** prompt: "you were just installed; neither of you has a name; learn enough to be useful starting tomorrow; record what you learn with `memory_write`." Once identity exists, a **shrunk normal** prompt — pure operational orientation (catalog, load_tools, mailbox, host context) with all opinions removed.
- **`role='identity'`** as a new posture tag. Joins `goal`, `preference`, `skill`, `knowledge`, `culture` per LOG 2026-04-23. No schema migration — `memories.role` is a free-form string. Documented in ARCHITECTURE.md memory-tiers.
- **Render path.** Identity rows render alongside principles in the cached system segment, extending the SOUL pattern from LOG 2026-04-24. New `loadIdentity` + `renderSoul` in `src/memory/principles.ts`; `chat.ts` calls both. Identity renders first ("Who you are: …"), principles after.
- **Detection.** Daemon resolves the boot prompt at every turn via a thunk on `system` (queries `memories WHERE actor_id=rootAgentId AND role='identity'`); the very turn that writes the first identity row flips the next turn into the normal prompt without needing a daemon restart.
- **Bootstrap requires three.** The interviewer prompt names exactly three load-bearing asks: (a) what to call the principal, (b) what the principal wants to call the agent, (c) one real first task. Beyond that, "err on too few questions"; the rest accrues through living per VISION.
- **`agents.name` stays as the internal handle.** The root row keeps `name='root'` for FK / mailbox routing. The principal-facing display name lives in the identity memory; renaming is a `memory_write`, not a schema mutation.

**The big rejection.** The plan started as "deep-interview-lite" — dimension-driven question loop, pressure ladder, pushback pattern library, challenge modes (Ontologist / Contrarian), readiness gates as code, crystallization step (raw answers → typed rows), scratch-tier resume state machine, four new role tags (`identity`, `principle`, `anti-pattern`, `self-portrait`). Borrowed from `gstack/office-hours`, `oh-my-codex/deep-interview`, and `gstack/plan-tune`. All of it is exactly the kind of framework-style abstraction AGENTS.md "failure modes" rejects: *"agents reason in markdown and code; structure that costs agent tokens and clarity is a loss."* Those reference skills are solving a different problem (extracting bulletproof specs for downstream automation). Soul-seeding's research takeaway was *minimum viable seed*, with drift expected and correction ongoing. The bootstrap prompt with three required asks + technique notes gets ~95% of the value with ~5% of the code. If real use produces consistently bad seeds we add scaffolding *then*, with real evidence about which scaffold to add.

**The dry-run that proved it.** Before locking, we ran the original 10-turn fixed script in conversation. Two questions in, the cognitive-interview "walk me through yesterday" technique was rejected by the principal: *"I just don't see how this is how you're going to work together with me. I can tell you how I currently work and how I WANT to work."* The technique was imported from forensic interviewing, where the witness might be unreliable. Soul-seeding has the opposite frame — the principal is *authoring* the agent's identity, not being interrogated about behavior. The aspirational dimension is first-class signal, not noise. The script collapsed against contact with one principal; the structured loop would have collapsed the same way, just slower.

**Phase 2 (`[DEFERRED-to-v0.1]`).** Living calibration — agent observes its own behavior against principles, surfaces stated-vs-lived drift to inbox via Socratic elenchus. Schema is already designed for it (memories are event-sourced; principles carry depth). **Resurrect when:** 2+ weeks of v0 use produces real divergence the principal complains about, OR the bootstrap prompt produces consistently bad seeds.

**`memory_write` joins the always-loaded core.** Soul-seeding's bootstrap turn instructs the agent to record what it learns via `memory_write` — but `memory_write` was deferred, forcing a `load_tools(["memory_write"])` round-trip on the very first first-contact turn. That's exactly the kind of papercut habitat philosophy is supposed to delete. Promoting it is symmetric with `memory_search` (the read half is already always-loaded) and bounded — `memory_write` is the only write surface for the persistent self, not a wide-open category — so the always-loaded core grows from four tools to five (`load_tools`, `query_self`, `mail_list`, `memory_search`, `memory_write`). ARCHITECTURE.md's "Tool catalog and lazy loading" updated to reflect.

---

## 2026-04-28 — Migrations 0001-0008 collapsed into a single `0001_init.sql`

Pre-v1; no installed-user upgrade path to preserve. The eight historical migrations were a development artifact (each one a real schema decision logged separately) rather than a contract with users. Carrying them forward means every fresh install walks through CREATE → ALTER → CREATE → ALTER replays of the same end state, plus the reasoning-trail noise of the historical names is now in `_migrations` instead of `LOG.md` where it belongs.

The compacted `0001_init.sql` defines the final-state CREATE TABLE / CREATE INDEX statements (matching `schema.ts`). `migrate.ts` now imports only the single migration. Verified by the full test suite (280 tests pass against the new schema). The reasoning behind each table's shape stays in `LOG.md` (search for the table name); the SQL file just records what's in the store today.

**Cost we paid:** historical commits' migration-numbered filenames no longer resolve at HEAD. The git history is the audit trail; `git log -- src/store/migrations/` reconstructs the per-decision sequence if anyone needs it.

**Resurrect when:** v1 ships and we have installed users. From that point forward, schema changes are append-only migrations again, never collapsed.

---

## 2026-04-28 — `olle chat` polish: paste fallback, Ctrl-C semantics, `chat.cancelled` event

`olle chat` had two reported issues: (a) pastes containing newlines auto-submitted at the first newline, (b) no way to interrupt a streaming agent turn — Ctrl-C did nothing or quit. Both fixed; the architectural choices behind the fixes are worth recording.

**On the framework question.** Considered swapping the hand-rolled raw-mode renderer for Ink, OpenTUI (opencode's choice), or terminal-kit. Rejected for v0:
- Ink breaks `bun build --compile` (yoga.wasm bundling, top-level await — see Bun #13552). Single-binary distribution is load-bearing.
- OpenTUI is v0.2 with native Zig deps and "not ready for production" per its own README. Adopting now would put renderer maintenance inside a surface the inhabitants couldn't realistically reshape.
- The polished references that look best (Claude Code, opencode, Codex CLI) all use *alt-screen* + custom scrollback. That's why their copy/scroll bug-class exists — they fight the terminal for what the terminal already does well. OLL-E's renderer writes to native scrollback; mouse copy and `Ctrl+B [` scroll-up still work. Keeping that property is more agentic-feeling than the polished-but-trapped alternative.

**Paste fallback heuristic.** Bracketed paste (`\x1b[?2004h`) is the canonical path and was already implemented. The bug appeared when terminals/multiplexers stripped the markers (tmux without proper config, some SSH paths). Added a heuristic in `line-editor.ts`: if a chunk contains a newline followed by more printable bytes in the same chunk, treat the newline as embedded (insert) rather than submit. Single Enter keypresses arrive as their own 1-byte chunk; pastes arrive bundled. The bracketed path still wins when present; this just stops the silent failure mode.

**Ctrl-C semantics.** Raw mode disables OS-level SIGINT generation, so `process.on("SIGINT")` never fires while the editor is active — every Ctrl-C must be read off `stdin` directly. New behavior:
- *Idle:* first Ctrl-C arms a "press again within 2s to exit" hint above the prompt; second Ctrl-C exits. One-tap exit is too easy to hit accidentally when the buffer has half a message.
- *Streaming:* Ctrl-C cancels the in-flight turn (LLM stream aborted at network level via `AbortSignal`), emits a `chat.cancelled` event, and returns control to the prompt. The user does not have to wait out the rest of the response just to redirect.

**`chat.cancelled` is a distinct event, not a flavor of `chat.error`.** The chat-health monitor escalates repeated `chat.error`s to an inbox proposal (the system thinks chat is crashing). User-initiated cancellations would otherwise look like a crash loop to the monitor and start filing false-positive diagnostics. Distinct event = correct semantics: cancellation is a normal user-driven outcome, not a fault.

**Plumbing.** `AbortSignal` flows: `LineEditor.onStreamCancel` → `cancelTurn()` → IPC `chat.cancel({threadId})` → `AgentLoop.cancel(threadId)` → per-thread `AbortController` → `runAgent` `signal` → `CompletionRequest.signal` → Anthropic SDK `messages.stream(params, {signal})`. Same signal also lands in `toolCtx.abort` so a future tool that respects abort gets cancelled too. The retry layer in `anthropic.ts` does not retry `AbortError` (only `APIError`), so cancellation propagates cleanly through.

**Polish that was deferred.** Considered an in-editor large-paste collapse (`[Pasted N lines]` placeholder) and `$EDITOR` escape. Both require a buffer-segment refactor of `LineEditor` (cursor/row math currently assumes a flat string). Not blocking; revisit when paste sizes start hurting visually or when users start asking for `$EDITOR`.

---

## 2026-05-03 — Starter write-tool tiers and transport replies

Starter tools that broadly mutate code or third-party state are strategic by default: `claude_code`, GitHub issue create/comment/close, and Discord reactions now declare `tier: "strategic"` so direct agent/tool calls route through the same permission physics as other world-changing actions. `discord_send` stays operational for v0 because the Discord communication bridge uses it as the transport reply path for `chat.turn-end`, analogous to the CLI printing the assistant's reply; making that path strategic would special-case Discord humans behind an approval wall and violate transport-agnostic chat. The unresolved edge is arbitrary channel sends through the same tool name; resurrect when channel/repo-scoped tool permissions exist, or split transport replies from proactive outbound posting.

---

## 2026-05-05 — Chat agent hot-reloads on `secret.set`; daemon restart becomes an explicit escape hatch

Fresh-install flow surfaced the bug: `olle secret set ANTHROPIC_API_KEY <val>` writes the file but `daemon.ts` only reads the key once at boot, so chat stays disabled until a daemon restart. The user-facing message even said "then restart the daemon," which is exactly the framework gunk vision rejects — constraints should feel like physics, and "you must restart for the system to notice the thing you just gave it" is the opposite.

**The fix.** Both secret-write paths (IPC `secrets.set` and the agent-callable `set_secret` tool) publish a `secret.set` event carrying `{ name, bytes }` — never the value. Keeping the value out of the event payload preserves the redaction story (`set_secret` already declares `sensitiveInputFields: ["value"]` so audit events and persisted session messages strip it; the wire format follows the same rule, so any future bridge that mirrors events doesn't suddenly become an exfil channel). The daemon subscribes; when the name is `ANTHROPIC_API_KEY` and chat is currently *not* up, it re-runs the bringup helper. The chat-input bouncer (which echoes `chat.error` while chat is disabled) carries an unsub handle that gets torn down the moment chat goes live. From the principal's perspective: paste the key, run `olle chat`, you're in. No restart, no second command.

**What we deliberately did not do.** When chat is *already* up and someone resets `ANTHROPIC_API_KEY`, the handler does nothing. The running LLM adapter captured the prior key and rotation requires rebuilding the adapter graph (and the agent manager that holds it) — that's a fresh process, not a hot-reload. Calling that out as a constraint is honest; pretending hot-reload covers rotation would silently keep the old key in flight. The escape hatch for rotation (and any other "I want a clean process" need) is the new `olle daemon restart` CLI.

**`olle daemon restart`.** SIGTERMs the daemon by pid (read via the `status` IPC method, not by parsing the pid file directly — same data, one source of truth) and polls the socket for the supervisor-restarted process. Works on both linux (systemd-user `Restart=always`) and macOS (launchd `KeepAlive`); foreground `olle run` users get a clear "re-run `olle run`" message when the timeout lapses. No new IPC method on the daemon side — SIGTERM hits the existing handler in `cmdRun`, so the restart command is a thin shell wrapper over what `systemctl --user restart olle.service` already did. CLI parity for convenience, not a privileged path.

**Why subscribe rather than re-read.** Considered making `readSecret` lazy at chat-bringup time and re-checking on every chat.input. Rejected: that's polling-flavored work on every event, and conflates the "secret available" question with the "agent alive" question. An event is the right unit — secrets are written deliberately, the write moment is observable, and other future subscribers (e.g., extensions that need to react to a token landing) get the same hook for free. The `secret.set` event is durable so it lands in the audit log alongside other state changes.

---

## 2026-05-05 — Tool-result events split into live (UX) and canonical (durable, post-truncation)

The chat UI wants tool results to land the moment each tool finishes — a slow first tool used to leave the turn looking frozen between the call line and an eventual dump-of-everything. That argued for emitting `chat.tool-result` immediately after each `tool.execute()`. But aggregate-budget truncation runs **after** the per-tool loop finishes; if the durable `chat.tool-result` carried what-the-user-saw rather than what-the-model-saw, the event log and the model's actual messages would diverge. The architecture's implicit invariant — "what observers see equals what the model received" — would break, and federation (event-log merge across peers) would inherit that lie.

**The shape we landed on.** Two events, mirroring the existing `chat.assistant-delta` / `chat.assistant-text` split:

- `chat.tool-result-live` — non-durable, fires inside the per-tool loop the instant a tool finishes (post per-tool cap, pre aggregate-budget cap). UX surfaces (`olle chat`, future bridges) consume it. Not persisted, not federated, not part of the replayable record.
- `chat.tool-result` — durable, fires once per tool **after** the aggregate-budget pass with the exact content the model sees in its messages array. Canonical for observability, replay, federation.

For the 99% case the two are byte-identical; the live emit drives UX, the canonical emit pins the record. For the 1% case where aggregate truncation rewrites a result into a `<persisted-output>` recovery marker, the events diverge by design — UX showed what the tool produced, the log records what the model actually received.

**CLI dedup.** `olle chat` subscribes to both types. A `Set<string>` of rendered tool_use ids tracks "already painted." The live event renders + adds; the canonical event renders only when the id is absent (covers reconnect-mid-turn, where the live event flowed past the disconnected subscription). Set clears on `chat.turn-end` / error / cancel. Tool ids are unique within a turn, so the set is bounded.

**Why two event types instead of one with a flag.** The bus mixes durable and non-durable events on the same subscription stream — subscribers filter by `type`, not by the durable flag. A single event type with a "this is the live preview" payload field forces every subscriber (CLI, observability dashboards, future federation bridges) to know about the flag. Two types lets each surface subscribe to what it actually wants — UX surfaces drop the live one in scrollback and ignore the canonical (or use it as a reconnect fallback); audit/replay surfaces ignore live entirely and read canonical as truth. Naming the difference also tells the story at the type level.

**Why not delay the live UX until truncation finishes.** Briefly considered keeping a single durable `chat.tool-result` and just emitting it after aggregate-cap: that's the original behavior, and it's exactly what motivated this whole change. A 60KB tool result blocks UX paint for as long as truncation logic takes; with parallel slow tools the user sees a blank stretch followed by a batch dump. The whole point of the fix is responsiveness.

**Bus-ordering note.** The per-tool loop now interleaves `tool_use` / `tool_result_live` step-by-step instead of emitting all `tool_use` first and all `tool_result` second. Searched current subscribers — only `src/cli/run.ts` (the chat REPL) and `src/starters/templates.ts` (Discord template) listen for these. Neither relied on the batched ordering. Future subscribers shouldn't either; the canonical `tool_result` still arrives in a single post-loop block if anyone needs that.

---

## 2026-05-05 — Mid-turn user input folds into the running turn

The CLI used to suspend its input editor for the duration of an agent turn — the prompt would disappear, agent text streamed into scrollback, and only when `chat.turn-end` landed did the editor come back. That made the natural human follow-up — "wait, also do X" — wait an entire turn before the agent could see it. Vision says humans are events; the corollary is that humans aren't blocked by agents either, and a system that quietly buffers "type while the agent is mid-stream" inputs into the *next* turn is making the human wait on the agent.

**The shape we landed on.** Two cooperating changes:

- *Daemon side* — `runAgent()` gains a `mailbox: () => Message[]` callback. The chat loop drains it at every round-trip boundary (after the previous `tool_result`, before the next assistant call — the only API-safe injection point; you cannot put a user message between a `tool_use` and its `tool_result`) and once more when the model would otherwise `end_turn`. If the late drain returns messages, the loop appends them and continues instead of returning. New `chat.input` events with `payload.extendTurn === true` route into a per-thread `inFlightInbox` rather than the existing `pending` queue when a turn is actually running on that thread. The `pending` path is preserved so synchronous batches of three `chat.input` events still produce three separate turns — the routing decision lives entirely on the publisher's intent flag.

- *Client side* — the input editor stays live the whole time. Every UI scrollback write (assistant deltas, tool calls/results, retries, notes, errors, cancels) is wrapped in `editor.eraseRender()` → write → `editor.refresh()`, so the bounding-box frame "follows" the bottom of the agent's stream as new content lands above it. The existing `pending`-rewind machinery learned a `framePad` flag to walk back through the `\n` we insert when a pending tail ends mid-row before the frame's first content row. When the user submits while the agent is still streaming, the CLI calls `flushPendingTail` (= `forceFlushPending`) to freeze whatever markdown tail is on screen as committed text without closing the assistant block, commits the user gutter cleanly underneath, and publishes `chat.input` with `extendTurn: true`. The next assistant delta continues into the same header rather than starting a fresh one.

**Race.** A `chat.input` could land between runAgent's last drain and the chat-loop `finally` clearing `activeAbort`. The `finally` checks `inFlightInbox` and promotes anything still sitting there back into `pending` (keyed to the closing turn's origin so causal chains still terminate at a real durable event), so a late arrival becomes a fresh turn rather than getting silently dropped.

**Why an explicit flag and not a heuristic.** Earlier draft folded any `chat.input` that arrived while `activeAbort` was set. A test that synchronously publishes three `chat.input` events to the same thread (and expects three turns) failed: by the time publish #2 hits the subscriber, runTurn has already set `activeAbort` and the second/third land in the in-flight inbox. The test's intent — "three discrete requests, three turns" — and the user's intent — "I'm still typing about the agent's reply" — are indistinguishable from the daemon's side. So the CLI tags only its mid-stream submits with `extendTurn: true` (it knows because `turnBusy` was already set), and the daemon honours that as the routing signal. Bots, scripts, and other event sources that don't set the flag get the existing one-message-one-turn behaviour for free.

---

## 2026-05-05 — Self-chosen agent display name lives as a memory; column is a cache

Agents have an `id` (ULID) and a `name` (formal designation set at spawn, alphanumeric+dash, validated). Wanted a third name: a self-chosen handle the agent uses when introducing itself socially — what shows up in the CLI header, the inbox enrichment, the grant-scope ask-up summary, anywhere a human-readable label lands. Spec called for "agent-callable so they can rename themselves," which immediately raises tool-bloat: a dedicated `set_display_name` tool ships another schema into every catalog render.

**The collapse.** Display name is a memory with `role='display-name'`, written through the `memory_write` tool the agent already has always-loaded. The architecture's "memory is identity" line (LOG 2026-04-23) extends naturally: a name you call yourself is identity. The memory is the source of truth — federation syncs events, peers reproject locally — and the new `agents.display_name` column is just a fast read path the CLI / event renderers use without paying a memory query per render. The memory projector's `memory.wrote` handler side-effects the cache: when the role is `display-name`, it queries the latest `role=display-name` row owned by that actor, sanitises the body (strip control chars, collapse whitespace, cap at 30 chars, null when empty), and updates the agents row. `memory_forget` on a display-name memory recomputes from whatever's still on disk.

**Why re-derive instead of "copy the just-written body."** An out-of-order LWW write whose HLC is lower than the existing row's gets rejected by the projector. If we cached the rejected body the rejected row would still poison the column. The "always re-derive from the freshest matching memory" rule mirrors the LWW semantics already in the projector — same source, same answer. Same logic applies on `memory_forget`: drop the row, recompute the cache against whatever else exists for the actor.

**Why one column, not two source-of-truth surfaces.** Considered keeping the column out and querying memory at every CLI header render. Rejected: the chat header repaints on every editor refresh (which, after the async-input change above, fires on every assistant delta). A SELECT against `memories` on every keystroke is real overhead. The column trades one schema migration for an O(1) read on every render. The asymmetry — memory authoritative, column cached — keeps the philosophy clean while paying for performance.

**Surface coverage.** `observability.agentSelf` (and the `query_self` tool that wraps it) returns `displayName: string | null`; the CLI chat header resolves to `displayName ?? name ?? "agent"`. `inbox/enrich.ts` (decisions and decision messages) prefers display name over formal name when surfacing authorship to the principal. The `tool.denied` ask-up summary picks the display name when crafting the grant-scope proposal. `olle inspect agent` shows `called: <name>` when set. Every renderer treats display name as the social face of the agent and `name` as the formal designation; both stay separate (`name` is what scripts and code reference, `displayName` is what humans read).

These are deliberately un-landed as of the vision-lock date. Drafting-phase decisions only.

- **Exact service-manager lifecycle.** `olle daemon install` shape on mac (launchd) vs linux (systemd). Whether auto-start-on-login is opt-in during install or always prompted.
- **CLI chat REPL UX.** Since minimal-core means CLI chat is the only channel until other extensions grow, its quality matters more than it would otherwise. What does first-contact look like? What's the prompt? What commands are slash-invokable? Deferred until first drafting of the chat client.
- **Starter template source.** Bundled in the binary or fetched from a well-known URL at first-run? Bundled is simpler and works offline; fetched is smaller binary. Lean: bundled for v0, consider fetch-on-demand in v1.
- **Exact IPC protocol.** JSON-over-unix-socket is fine; might want subscribe-streams for event tailing. WebSocket upgrade path for future web UI.
- **Peer bridge skeleton.** The interface is clear; the first implementation needs to decide whether v0 ships any real cross-host code at all, or whether the "two-laptop demo" uses a local-mock bridge for the first pass.

---

## 2026-05-14 — Principals collapse into agents (LOG 2026-04-23 landing)

LOG 2026-04-23 ("the human is the oldest agent") was design text for three weeks; the schema kept lying. `principals` and `agents` were parallel tables with two near-identical surfaces — both had memory, both lived in trees, both received messages, and every code path that crossed the chain ended in a special-case branch checking which side it had landed on. The collapse landed today in migration `0003_principals_collapse.sql`.

**What changed.** `principals` is dropped. Every former-principal becomes an `agents` row with the same ULID, `owns_money = 1`, all tiers allowed in `scope.allowTiers`, and the channels list copied verbatim. `decisions.principal_id` and `budgets.principal_id` retarget to `agents.id` and rename to `owner_agent_id`. The bootstrap AI agent's `parent_agent_id` now points at the human-agent, so the ask-up chain walks one recursion end-to-end without a terminal branch.

**Why now.** The teams plan needed cross-host decision sync; the existing FKs forced any imported decision to either fake a local `principals` row or punt the slice. Either path was infrastructure cosplay around a problem we'd already decided how to solve. The collapse was cheaper than the workaround.

**Ask-up semantics for owns-money agents.** `askUp` now treats an `owns_money` agent as the inbox endpoint, not a delegate: even if its `allowTiers` covers the proposed tier, the chain queues to its inbox rather than auto-approving. The human's tier list says "I am authorized to do this myself" — not "I delegate this tier downward." Without the explicit terminus check, a child proposing a vision-tier action would have been silently auto-approved by walking through the human's row, which would defeat the whole inbox surface.

**Scope of the rename.** Schema columns + indexes; `Daemon.rootPrincipalId` → `Daemon.humanAgentId`; every interface field named `principalId` → `ownerAgentId` (inbox, ledger, agent manager, chat loop, IPC, CLI); every test-rig that seeded a principal now seeds an owns-money agent. The `tables.principals` export and `Principal`/`NewPrincipal` types are gone. Tests + typecheck green.

**Migration hygiene.** Following the 2026-04-28 pattern: the migration runs against any existing daemon on next start, idempotent via `_migrations`. Pre-v1 we have no installed-user upgrade path to preserve, so after soak we'll fold 0003 into `0001_init.sql` directly and delete the migration file — a future fresh install reads a clean schema with no `principals` archeology.

**What's now unblocked.** Cross-host decision-row sync (the teams plan's biggest deferred item). Remote `decisions` and `budgets` rows now FK only to `agents.id`, and that column was already a weak ref across hosts, so bridging them is just events on the wire — no more pretending local rows exist for remote humans.

**What's still property-not-primitive.** "Principal" survives as `owns_money` on an agent row. The vocabulary stays useful ("ask your principal") even though the schema dimension is gone.

---

## 2026-05-13 — Substrate stays peer-mesh; centralization is agent-grown behavior

While planning Phase C (cross-host mesh), pushback landed: if the agents *want* centralized coordination — a leader for task assignment, a shared scheduling oracle — why would the binary forbid it? Doesn't vision say the world is modifiable by its inhabitants?

The pushback was correct, and the prior framing was muddled. Vision draws two axes, not one:

- **Hierarchy is required, not forbidden.** Parent-child agent trees, budget flowing down, approvals bubbling up, humans-as-oldest-agents. *"Authority is hierarchical"* (LOG 2026-04-22 round 3).
- **Peer mesh is required for one specific axis** — the federation layer *between cells.* *"Teams are peer cells around a shared goal. No central coordinator."* (VISION.md). The reason: sovereignty + voluntariness. If host A becomes a permanent dependency of host B, B's principal has been conscripted into A's infrastructure without consenting at install time. *"Each host is sovereign over its own store."*

**The resolution.** The binary ships the most-agentic substrate — peer-mesh — because that's the only substrate that doesn't foreclose other shapes. Agents grow centralization on top through the extension authoring loop: a `leader-election` extension, a `central-scheduler` extension, a `decision-arbitrator` extension. A team installs the shape its members agree on; a different team installs a different shape; both work on the same v0 substrate. Peer substrate doesn't foreclose centralized behavior; centralized substrate forecloses peer behavior. Same logic as TCP/IP — peer-routed substrate, centralized services possible on top.

**The concrete framing that motivated this** (daaaa, this turn): *"an agent with good uptime ELECTS to become a central node and the rest of the team agrees."* Leadership is earned and consented to, not granted by the binary.

**What this rules out.** v0 (or any version) hosting load-bearing central infrastructure that teams depend on. A hub at `olle.sh` that teams *must* connect to would make *us* the dependency, *us* the involuntary infrastructure — directly violating sovereignty. A v0.1+ optional relay is fine specifically because anyone can run a relay and it sees encrypted bytes only — convenience, not coordination.

**Smoke test for Phase C** (added to the plan): before declaring Phase C done, sketch a `leader-election` extension and verify it can be authored cleanly on top of v0 primitives (events, claims, HLC, decisions, memory). If it can't, the primitives are missing something agents will need to grow the shapes they want.

---

## 2026-05-14 — Teams plan: peer-mesh substrate, leaderless claims, honest event identity

Design entry for the teams plan (`docs/plan/teams.plan.md`). Today's slice ships the v0 cross-host substrate — peer mesh, scoped sync, leaderless claim window, catchup on reconnect, memory tombstones — not the bug-fix demo on top. Substrate's job is five concrete predicates: Alice and Bob both run cells, both see each other's claimable work, an offline cell catches up on reconnect, private memory never crosses, and a single piece of work is claimed exactly once across the mesh.

**Leaderless claim window.** Each peer applies the same rule independently against the same observed claim set within a default 100ms LAN window — first-eligible-by-HLC wins, ties broken by lexical `hostId`. No origin-host arbiter, no `decided_by_host_id`, no consensus protocol. Direct application of LOG 2026-05-13: arbitration is policy that an extension can grow on top, the substrate ships the most-agentic shape. Partition risk surfaces as an honest `mesh.claim-split-brain` event when two peers each thought they won — observability over invented consensus. If teams want quorum or a leader, a `leader-election` extension authors that shape; the binary refuses to foreclose it by baking one in.

**Catchup on reconnect is v0, not v0.1.** The demo's resilience claim — Alice goes offline, reconnects, sees what Bob did — is hollow without it, and the teams plan explicitly owns it. Per-peer watermark on `team_peers.last_received_event_id`; reconnecting peer asks for events newer than its mark; `bus.inject` is idempotent on `events.id` so duplicate deliveries from multiple peers are harmless. Whichever peer Alice reconnects to first feeds her; no global sequencer, no designated source-of-truth host. The mesh is its own log.

**Honest event identity via `bus.inject`.** `bus.publish` re-mints `id`/`hlc`/`hostId` for everything it touches — fine for locally-originated events, a lie for remote ones. A remote `memory.wrote` published locally would persist with the local host's id and a fresh HLC, and every downstream projection would inherit that lie. Federation is event-log merge; the schema can only carry that promise if the rows tell the truth. Replaced with `bus.inject(event, { remote: true })`: persist the original `id`/`hlc`/`hostId` (INSERT OR IGNORE makes redelivery a no-op), stub a `hosts` row on first sight of an unknown remote `hostId` so the FK holds, dispatch through the in-process bus with `remote: true` carried in-memory only — never on the payload, because the payload is what gets sent to peers and recursing remotes-as-remotes would loop the mesh.

**Explicit `teamId` + `scope=team` routing.** The bridge has no "should I send this?" decision tree. Either the event payload carries `teamId` (with `scope === "team"` for memory events specifically) or it stays put. No actor-membership inference, no "compute from team_members and pray" — every actor-membership lookup is a place mesh routing can quietly diverge from intent. Enumerated event types may cross the wire: `memory.wrote` and `memory.forgotten` (when `scope === "team"`), claimable work events the scheduler tags, `task.claim`, and `team.peer.*` lifecycle. Inbound events that don't match the enumerated set or whose `teamId` the receiver isn't a member of are dropped with a `mesh.scope-violation` event — visible, not silent.

**Bearer code = credential, not single-use ticket.** A team join code is the team's shared secret in v0. Single-use is enforced at the inviter on the `inviteId` so a code can't authorize two cells off one redemption, but anyone holding the code holds the secret. If it leaks, rotate the team secret — and rotation is v0.1. The v0 trust model is "friend you handed the code to face-to-face or over a secure channel," and the binary is honest about that rather than pretending the code itself is the security boundary.

**No version vectors; tombstones only.** New `memory_tombstones (id, hlc, host_id, actor_id, memory_id)`. Three rules cover concurrent edits across the mesh: LWW on HLC for `memory.wrote`, tombstone wins for `memory.forgotten` regardless of HLC, and an out-of-order `memory.wrote` arriving after a tombstone with a lower HLC is dropped. One table, three rules — no vector clocks, no CRDTs, no per-row version arrays. The richer machinery buys nothing the demo proves and a great deal the substrate can't yet justify.

**Cross-host decision-row sync deferred.** LOG 2026-05-14 (principals collapse, earlier today) cleared the schema obstacle — `decisions` and `budgets` now FK only to `agents.id`, and that column is already a weak cross-host ref, so bridging decision rows is "just events on the wire." But wire + claim + catchup are the load-bearing primitives; decision sync is a behavior built on top of them. Folded into a follow-up slice in this same plan once the two-cell substrate goes green. Doing them together would couple two debugging surfaces that don't need to be coupled.

**Smoke-test commitment, in the design not after it.** Per LOG 2026-05-13's substrate-expressiveness discipline: once the substrate lands, a `leader-election` extension sketch gets appended to this LOG. If the sketch can't compose cleanly from `events + claims + HLC + memory + decisions`, the design is reopened — not patched over with new primitives smuggled in later. Calling this out here, in the design entry, because the check is part of the design. An afterthought-shaped commitment is a commitment that quietly never happens.

**What we deliberately didn't build.** No relay, no TLS (LAN-only, peer-to-peer TCP), no version vectors, no origin-host arbiter, no global sequencer, no remote code execution. Each of those is the wrong primitive at this stage; growing them later costs less than ripping them out.

---

## 2026-05-15 — Teams substrate landed; peer.ts hello-ordering fix; leader-election sketch

The substrate from the 2026-05-14 design entry is live. The two-cell integration test (`test/integration/two-cell-team.test.ts`) walks Alice and Bob through `team_create → team_invite → team_join`, verifies both report each other as a connected peer, observes a team-scoped `memory.wrote` cross the wire with original `hostId` intact, confirms a private memory does NOT cross, and verifies an out-of-order `memory.wrote` arriving after a tombstone fails to resurrect. Full suite: 382 green.

**Peer.ts hello-ordering bug, caught by the integration test.** The first run of the integration test surfaced a synchronous race in `src/mesh/peer.ts`: on socket open the link called `setStatus("connected")` *before* sending hello. `setStatus` fires `onStatusChange` handlers synchronously in the bridge, and the bridge's connected-handler immediately calls `catchup.request(...)` which sends a `catchup_request` envelope. So the very first byte on the new socket was sometimes `catchup_request`, which the remote listener correctly rejected ("first envelope kind catchup_request; expected hello — closing"), and the peer link entered a reconnect loop without ever delivering anything. Fix: send hello *before* `setStatus("connected")`. One-line reorder. The comment in peer.ts now names the constraint explicitly so future edits don't re-introduce it.

This is exactly the kind of bug an integration test is supposed to catch — every unit test for peer/bridge/catchup passed individually because each mocked the surface the other relied on. The substrate-level test forced them to talk for real.

**Substrate-expressiveness check: `leader-election` sketch.** Per the 2026-05-13 discipline rule, sketching a `leader-election` extension on the shipped primitives. If the sketch composes cleanly, the substrate earned its keep; if it needs something we didn't ship, design reopens.

The shape:

1. **Election trigger.** An extension-registered cron trigger fires on each cell every N seconds (configurable). It emits a durable `team.leader.election-tick` event with `{ teamId }` and `claimable: true`.
2. **Eligibility.** Every cell registers a task that subscribes to `team.leader.election-tick` with a match predicate on `payload.teamId`. The handler is trivially "claim and write a memory."
3. **Arbitration.** Because the event is team-scoped and `claimable`, it routes through the leaderless claim window automatically. Exactly one cell wins per tick under partition-free conditions; under partition, the `mesh.claim-split-brain` event surfaces honest ambiguity that the application layer can act on (escalate to inbox, fall back to "no leader," etc.).
4. **Term storage.** The winner writes a team memory `role=leader, body=<hostId>` (or similar) with the tick's HLC as the term marker. LWW + tombstone semantics from the memory projector cover term progression: later ticks overwrite the row in HLC order; a `memory.forgotten` followed by an out-of-order older write doesn't resurrect a stale leader.
5. **Followers read.** Any cell that wants to know "who's the leader right now" does a `memory_search` on `role=leader` in the team scope. Memory is identity (LOG 2026-04-23); the leader's identity is just another belief the team holds.
6. **Liveness via stale.** If a tick fails to find a willing winner (every cell is busy or budget-exhausted), the previous leader memory rides until a healthier tick replaces it. The election cadence determines staleness tolerance; no separate liveness protocol.
7. **Optional: principal blessing.** If a deployment wants human sign-off on leadership changes, the election task emits `mail_propose({ tier: "strategic", action: "ratify_leader", ... })` after winning, and gates the memory write on `decision.resolved`. The substrate doesn't impose this; the extension authors it where it matters.

**Composition check.** Primitives consumed: cron triggers (existing), claimable team-scoped events (Feature C), leaderless claim window (Feature C), HLC ordering (existing), team-scope memory (Feature E), memory tombstones (Feature F), optional decision-inbox (existing). Every one is a primitive the substrate ships. Nothing extension-authored requires a new core surface. **The check passes.**

What the sketch made clear about the substrate, retroactively: the `mesh.claim-split-brain` event is more than a debugging hint — it's the application-layer hook that lets centralization-shaped extensions (leader election, sharded scheduling, anything that wants single-owner semantics) detect their own consensus violations without inventing a side channel. If we had quietly suppressed split-brain instead of emitting it, the leader-election extension would have to either trust the substrate (false confidence) or build its own arbitration (paying for what the substrate already paid for). Emitting the event makes the choice the application's.

What we'd build differently if we were starting from this sketch instead of ending at it: the `task_fingerprint` field on `team_claims` is currently opaque per the plan's explicit deferral, and the leader-election sketch needs to ensure two cells don't run different leader-election ticks under the same tick HLC. The fingerprint `${task.id}:${event.id}` Wave 3B chose covers this — different `task.id`s arbitrate independently, same `task.id` across cells dedupes correctly. Confirmed in `test/team-claims.test.ts`. No fingerprint-registry primitive needed yet.

---

## 2026-05-16 — Migration runner tracks by name, not index

`scripts/install.sh && olle chat` failed on an existing dev DB with `no such table: team_claims`. Root cause: the runner keyed `_migrations` on `idx INTEGER PRIMARY KEY`. When 0003 got renamed from `principals_collapse` (folded into `0001_init.sql` per commit `8d1f420`) to `team_mesh`, every existing DB had idx=3 already applied — under the old name. The runner saw idx=3 present and skipped, so the new content at the same idx never ran. Daemon then crashed on the missing tables.

This is a class of bug, not a one-off. Any migration collapse, rename, or content swap at an existing index silently no-ops on installed DBs. The CLAUDE.md note that "pre-v1 has no installed-user upgrade path to preserve" was being read as license to ignore the breakage, but it actually meant "we won't ship migrations to roll forward from pre-v1 schema" — not "the runner can lie about which migration ran." Those are different statements; conflating them is how silent drift starts.

**Fix.** `_migrations` is now `(name TEXT PRIMARY KEY, applied_at INTEGER)`. Identity is the migration's name; the array position in `MIGRATIONS` is ordering only. The runner detects the legacy `idx`-keyed table on first boot and rebuilds it in a single transaction (preserves `name` + `applied_at`, drops `idx`). The old `principals_collapse` row stays as historical attestation that its content already landed; the new `team_mesh` row gets inserted when its SQL runs. Fresh installs create the new schema directly; never see the migration shim.

**Rule going forward.** Migration *name* = content identity. Once shipped, never rename. Never change content. If content needs to change, add a new migration with a new name. The runner cannot defend against editing a migration in place under the same name — that's the developer discipline the rule preserves.

**What this rejected.** Wiping the dev DB was the lazy fix and matches the "no upgrade path" framing. Rejected because the breakage isn't the user's data, it's the runner's identity model. Patching the model fixes every future rename without the discipline-of-remembering-to-wipe.

---

## 2026-05-16 — Symmetric mesh: hello carries the dialer's listener addr

Writing the two-cell integration test for `docs/plan/teams.plan.md` criterion 3 ("Alice goes offline, Bob does the work, Alice still sees what happened when she reconnects") surfaced a real substrate gap: it didn't work in the inviter-restart direction. The joiner-restart direction worked fine. Asymmetric.

Two reasons compounded. Catchup is triggered only on outbound `connected` transitions (`src/mesh/bridge.ts:280`) — inbound links don't fire it. And the inviter never learned the joiner's addr, because the bearer code carries only the inviter's addr; the joiner's hello named the team and the host but not a routable address. So the inviter held only an inbound link from the joiner, no outbound link to it, and on restart had no path to dial the joiner and pull missing events. The joiner's outbound reconnect succeeded, but the joiner is the one *with* the new events — its catchup request asked the inviter for events the inviter didn't have. The inviter's missing tail never crossed.

**Fix.** Every outgoing `hello` now carries the dialer's own `listenerAddr` (peer.ts), and the listener's `onPeerHello` handler in the bridge calls `addPeer(joinerHostId, listenerAddr)` to open the reverse outbound link. Both peers end up with one inbound + one outbound link to every other peer — the literal O(N²) mesh the architecture doc already described. Catchup now fires symmetrically: whoever restarts dials out, the outbound link transitions to `connected`, and the catchup request flows in the direction that has the gap.

Also fixed `addPeer`'s no-op-on-same-addr path. The existing comment promised it; the code closed the link unconditionally. With reverse-dial happening on every hello, that bug would have churned the catchup window on every reconnect, so this had to land in the same change.

**What this rejects.** Two alternatives were on the table. (a) Trigger catchup on inbound `connected` too — would have worked, but would have left the mesh asymmetric (the inviter still has no outbound link, so any future feature that assumes outbound presence would re-break the inviter side). (b) Bake the joiner's addr into `welcome` instead of `hello` — no, hello-first is right because reconnect hellos need the addr too, and welcome only fires on first contact. Putting it on hello matches the lifecycle: every new socket re-advertises, every restart re-asserts.

**What this leaves deferred.** Per-actor wire signatures still aren't a thing; the addr is trusted at HMAC-verified-team-secret level. Multi-NIC hosts still rely on `OLLE_ADVERTISE_ADDR` rather than negotiation. NAT traversal stays out of v0. None of these block the demo; all are listed in the plan's deferrals table.

---

## 2026-05-20 — LLM layer on Vercel AI SDK; Ink scaffold for `olle chat`

Two surgical swaps, prompted by named pain rather than architectural anxiety. The user named the toil honestly: hand-rolled streaming/cursor management in `cmdChat` (random text streaming bugs, 7-10 rounds of AI-pairing to get aesthetics right) and hand-maintained per-provider LLM adapters (cache-breakpoint plumbing, retry observability, streaming bridges, usage normalization across two SDK shapes). Neither pain was OLL-E architecture — both were plumbing layers any production agent codebase will write once and maintain forever if not delegated.

**LLM swap.** `src/llm/anthropic.ts` and `src/llm/openai.ts` now wrap Vercel AI SDK (`ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai`) behind the existing `Llm` / `CompletionRequest` / `Completion` interface in `src/llm/types.ts`. The provider-neutral seam holds; downstream callers (router, ledger, chat loop) didn't move. Cache breakpoints — system segments, last tool, last user message — translate to `providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } }` per AI SDK's declarative form. `createInstrumentedFetch` survives unchanged and wires into the provider factory's `fetch` param so retry-observability still surfaces `onRetry` callbacks. Tests rewrote against `MockLanguageModelV3` from `ai/test` (a tiny `streamOf` helper builds the ReadableStream<LanguageModelV3StreamPart>). `@anthropic-ai/sdk` + `openai` packages dropped from dependencies. ~500 LOC of vendor-specific glue replaced with ~80 LOC of mapper code and a 55-LOC shared `vercel-mappers.ts`. 405/407 tests green (2 pre-existing skips, 0 fail). Adding a third provider is now `import { google } from "@ai-sdk/google"` against the existing mappers, not a fork-and-write.

**Vision check passed.** Adopting an SDK for the LLM client doesn't violate "habitat, not framework" — AI SDK is a library, not a framework. The agent loop, six primitives, mesh, decision inbox, extension authoring loop, memory projector — all unchanged. We deleted vendor-adapter code, not architectural code.

**Ink scaffold (parallel, opt-in).** New `olle chat-ink` command mounts a React tree (Ink) instead of cmdChat's hand-rolled LineEditor + ANSI cursor dance. Ink owns the redraw loop, so streaming `chat.assistant-delta` events just bump React state and the terminal repaints itself — no manual erase/refresh, no overlap bugs, no walking-over-the-prompt failure mode that drove the suspend()-during-streaming hack in the old chat. Scrollback uses Ink's `<Static>` for the committed history (cheap rerender), with the in-progress streaming text rendered separately below in a dynamic region. Input is `@inkjs/ui`'s uncontrolled `<TextInput>`; Ctrl-C handling is two-tap-quit when idle, cancel-turn when streaming, matching the old behavior. Slash commands `/help`, `/clear`, `/new`, `/cancel`, `/model`, `/exit` are wired. Markdown rendering inside scrollback is **not** ported yet — assistant text renders as plain markdown source until a follow-up adds a marked-to-Ink-component path.

**Parallel-not-replacement.** `cmdChat` stays as-is; `chat-ink` is the experimental opt-in surface. Once chat-ink carries the full surface (tray for in-flight queued messages, suggestions tray, reconnect loop, markdown rendering) and the user prefers it, we delete cmdChat in a separate change. The point of the parallel path is to prove the streaming-bug class is solved by Ink before committing to ripping out the working chat.

**What this rejects.** Two adjacent moves were on the table and rejected. (a) Adopting a full agent SDK (Mastra, LangGraph, CrewAI, OpenAI Agents SDK, Claude Agent SDK, Cersei): all impose their own primitive model (agent class, workflow graph, memory abstraction). Adopting one would bend OLL-E's six primitives to fit, costing the habitat property to save adapter code. Cersei is also Rust — a language port, not a library swap. (b) A "huge rewrite" framing for the toil pain: rejected as elegance-as-avoidance. The toil was real but local; the fix was surgical replacement of two commodity plumbing layers, not architectural surrender.

**What this leaves open.** Markdown rendering inside Ink scrollback; per-thread loadout durability when chat-ink replaces cmdChat (the in-memory loaded set survives one process, not restart — same constraint cmdChat has today). Adding a third provider (Google, Mistral, Ollama, OpenRouter) is now mechanically trivial and queued for the next provider-need-driven session.

---

## 2026-06-02 — "OLL-E" names the runtime, not the world or a being

A naming audit surfaced a category error in the docs. `VISION.md` and the `AGENTS.md` lens both said "OLL-E **is** a world / a habitat" — equating the name with the thing it hosts. The same name was simultaneously doing three jobs: the binary you install (`olle run`), the federated world that binary hosts, and (in casual framing) a singular, personable being à la WALL-E/Ollie. Three referents, one name.

**Prior framing:** OLL-E = the world. "OLL-E is a world agents love to live in." "OLL-E is designed as a habitat for agents."

**New framing:** OLL-E = the **runtime** — the single binary + daemon you install, the thing that *hosts* a world. The world/mesh is what it hosts; the inhabitants are the individually-named agents (humans included). The name never denotes a single being inside the world. This is resolution **A** of the naming discussion (the alternative, B, would have made "Ollie" a charismatic first-contact *agent* with the world named separately — rejected as a larger, product-surface change we don't need).

**Why this and not a rename.** The code already does A: `olle` is the CLI binary (`olle run`, `olle chat [agent]`), and agents carry their own names. Only the prose anthropomorphized. A tool name that boots a world is normal and honest — `docker` boots containers, nobody thinks Docker is a container. The deeper reason is philosophical, not cosmetic: a world with a single name and a face is a world with a *center*, which directly undercuts the load-bearing leaderless/peer thesis (no central coordinator, no privileged paths for any one entity). Personifying the world as one named being is the same failure mode the lens already forbids for the root principal.

**Edits landed (this change):** `VISION.md` "What it is" (`agent system` → `agent runtime`, plus an explicit "the runtime; the mesh is the world" clause) and "The philosophy" (`designed as a habitat` → `the runtime for a habitat`); `AGENTS.md` lens opener. The one-line pitch ("A world that agents love to live in…") stays — it's the product promise describing the world the runtime grows, now anchored by a precise definition above it.

**What this leaves open / deferred.** The world itself has no proper name yet — `[DEFERRED]` until a product/marketing need forces one (resurrect-when: a surface needs to refer to "the world" as a named place rather than "the mesh" / "the habitat"). If a named first-contact persona is ever wanted, that's resolution B and gets its own entry — it is not blocked by this one.

---

## 2026-06-02 — VISION.md becomes a timeless constitution; milestone content moves to ROADMAP

`VISION.md` had drifted into part-constitution, part-milestone-plan: it carried the v0 demo script, a "What v0 is explicitly not" list, and "Success criteria for v0." Milestone scope in the anchor document is a drift vector — every version bump invites someone to edit the constitution, and a constitution you edit every release isn't one. So VISION is now strictly timeless: what OLL-E is, the philosophy, the load-bearing invariants, the why-the-shape-is-the-shape, and lineage. A preamble states its constitutional role explicitly (supreme, amendable only via a logged decision). All `v0`/`v1` tokens purged; the two load-bearing bullets that hedged in v0 terms ("In v0, cells share…", "Sub-agent spawning is v0, not v1") are restated as unconditional invariants.

The relocated content: the demo script and success criteria moved into `ROADMAP.md` under v0 (the demo now lives inline where ROADMAP already pointed; success criteria join the shipping bar). The "What v0 is explicitly not" list was deleted from VISION outright — ROADMAP's "Explicit non-goals for v0" already supersedes it and is more complete. The "Why these choices" section stays in VISION, reframed as "Why the shape is the shape" — recording the reasoning behind foundational commitments *is* drift-prevention, which is constitutional, not milestone. Pairs with the 2026-06-02 naming entry above; both are the same housekeeping pass to make the anchor docs say exactly one true thing each.

---

## 2026-06-02 — VISION is tech-independent; rationale moves to ARCHITECTURE (reverses the keep-the-why call above)

The earlier 2026-06-02 constitution entry kept "Why the shape is the shape" inside VISION, arguing tech rationale was drift-prevention and therefore constitutional. That was wrong, and the user named why: a vision that argues for SQLite or Bun is a vision a technology swap can falsify. The constitution must be the thing technologies are *measured against* — it names no technologies and argues for none. A technology earns its place by fitting the vision; the vision never bends to justify a technology.

So VISION is now strictly philosophy: identity, principles, load-bearing invariants. The "Why the shape is the shape" section is gone from it, and the "Lineage" section too (prior-art provenance is reference material — `REFERENCES.md` owns it, not the constitution). The rationale moved to `ARCHITECTURE.md` as "Why these choices," reframed so each choice is stated as *downstream of a named vision principle* ("SQLite per host serves *each host is sovereign*"). This makes the dependency direction explicit and one-way: ARCHITECTURE traces up to VISION; VISION never reaches down.

Three values that previously existed only as tech-justifications were promoted into VISION as first-class principles, so the technical decisions have something to trace back to: **each host is sovereign** (load-bearing), **the inhabitants are the primary audience** (agent-native ergonomics beat developer-facing ones), and **the simplest mechanism that serves the vision wins** (complexity earns its place, never granted on spec). The test the user set: VISION can now be used to fundamentally understand any technical decision — every entry in ARCHITECTURE's "Why these choices" points at a principle that lives in VISION.

---

## 2026-06-08 — An agent's model is a memory, not host config

The ask: let the agent switch itself from opus 4.7 to 4.8 and have it persist. The obvious home — `config.toml` — is wrong. `config.toml` is the human's host-config surface (principals, budgets, secrets); for the agent to "switch *itself*" through it, we'd hand it a privileged tool that pokes a human file, which is exactly the special-cased path AGENTS.md test 3 and the "no privileged human dashboard" rule exist to kill.

**The choice descends from "memory is identity" (LOG 2026-04-23).** The model an agent reasons in is a preference — part of its persistent self — so it lives on the same surface as identity and principles. Stored as a private memory with `role='thinking-model'`, body line 1 = model id, the rest = the switch's justification. `resolveThinkingModel(store, agentId)` reads the newest such row at loop start and passes it as the loop's `model`; absent or unpriced → adapter default (`DEFAULT_MODEL`). `config.toml` keeps a real but different future job — host default + payable-model allowlist (the cost-ceiling "physics") — and was deliberately *not* built now; it's dead weight for this ask.

**Three design calls (with the principal, this turn):**
- **Home: memory, via a thin validating tool.** `set_thinking_model(model, reason)` is a front door to `memory_write`, not a new home. It earns ~30 lines over a raw write by enforcing the two things that make a switch trustworthy: the model must have a posted price in `pricing.ts` (else the ledger silently falls back and lies about physics), and `reason` must be non-empty.
- **Cost gate: none — justified, not gated.** No ask-up, no tier comparison. The agent may switch freely; it must record *why* (a human asked, or it judged the cost/intelligence trade worth it). The existing budget physics (80%/100% auto-inbox) catch a reckless choice after the fact; a pre-switch gate would be distrust dressed as safety.
- **Apply timing: next loop start.** `model` is read once when the loop is built (static, like it's plumbed today), so a switch lands on the next daemon restart, not mid-conversation. The tool result says so.

Also added `claude-opus-4-8` to `pricing.ts` explicitly (it was matching 4.7 only by FALLBACK luck) and a `postedModels()` export for the switch tool's validation + error message.

---

## 2026-06-08 — Reasoning effort is a memory too; "effort" is the real knob, not budget_tokens

Sibling to the thinking-model decision above. The ask was "implement reasoning effort." Research (claude-api skill) corrected the shape: on the model OLL-E actually runs (`claude-opus-4-7`, and the new `4-8`), `thinking: {type:"enabled", budget_tokens:N}` **400s** — extended thinking with a fixed budget is gone. The live knob is `output_config: {effort: "low"|"medium"|"high"|"xhigh"|"max"}` (GA, no beta header) paired with adaptive thinking (`thinking: {type:"adaptive"}`). Sampling params (`temperature`/`top_p`/`top_k`) also 400 on these models.

**Design — mirror the thinking-model path exactly.** Effort is identity, so it lives in memory: a private `role='reasoning-effort'` row, body line 1 = level, resolved at loop start by `resolveReasoningEffort`, passed as the loop's `effort`. The agent sets it via `set_reasoning_effort(effort, reason)` — validated level, mandatory justification, no mechanical gate (same cost-philosophy as the model switch). One bundled knob: setting an effort enables adaptive thinking at that depth; `off` (or no memory) = no thinking, which is the historical behavior. So the feature is strictly opt-in and a clean restart reverts.

**The load-bearing correctness work was the thinking-block lifecycle, not the knob.** The adapter previously flattened thinking blocks to `JSON.stringify` text (`anthropic.ts:274`), discarding the `signature`. With thinking on, the API requires each thinking block (and `redacted_thinking`) echoed back verbatim on the next turn or a tool-use turn 400s — and *every* OLL-E turn is tool-use. So enabling thinking forced: a `thinking`/`redacted_thinking` ContentBlock type that preserves text+signature, round-tripped through `fromAnthropicBlock`/`toAnthropicMessage`. Also bumped the default `max_tokens` when effort is set (4096 truncates mid-thought; 32k, or 64k at xhigh/max) and dropped `temperature` from the request whenever effort is on. Thinking tokens bill as output tokens, so the ledger stays honest with no pricing change.

**SDK bump.** Did this on the same turn: `@anthropic-ai/sdk` 0.38 → 0.102, which natively types `output_config.effort` (`low|medium|high|xhigh|max`), adaptive thinking, and the thinking blocks. The upgrade needed **zero** production changes — only one test helper line (`APIError`'s constructor now wants a real `Headers`). The adapter still builds the request as a loose object cast once at the call site, because the `thinking`/`output_config` fields are attached conditionally; that's an ergonomics choice now, not an SDK-version workaround.

---

## 2026-06-08 — Model and effort are chosen independently, so the loop must not brick on an invalid pair

Follow-up review of the two decisions above caught a self-inflicted, unrecoverable failure. The model and the effort are each a self-chosen memory resolved independently at loop start. `set_thinking_model` accepted any *priced* model (Sonnet 4.6, Haiku 4.5 included), and `set_reasoning_effort` accepted any *valid* level — with no cross-check. So an agent could land on, say, Haiku + `max`. Since `output_config.effort` 400s when the model can't run that depth, **every** LLM hop would then 400 — and a 400 is non-transient, so it throws before any tool dispatches. The agent can't issue a fixing `set_reasoning_effort` call when no turn completes. The thread (and the loop) is dead until a human edits the DB. That violates the v0 success criterion "when an agent writes a broken [config], the system recovers."

**Fix at altitude, not as a special case.** A new `src/llm/models.ts` holds per-model capability facts (which efforts each selectable model accepts, and its `max_tokens` ceiling) — the LLM-layer sibling of `pricing.ts`, updated alongside it. Two enforcement points: (1) **runtime safety net** — `runAgent` resolves `(model, effort, maxTokens)` together, `clampEffort`s an unsupported level down to the highest the model runs (or off), and caps `max_tokens` at the model ceiling, so a bad pair *degrades* instead of bricking; (2) **set-time feedback** — `set_reasoning_effort` rejects a level the agent's current model can't run (clear physics-feel error listing the valid levels), and `set_thinking_model` warns when a switch will clamp the agent's existing effort. The clamp also subsumes the earlier `max_tokens` concern: with effort correctly gated, the 32k/64k defaults are always within the chosen model's cap. Also added a `"default"` sentinel to `set_thinking_model` so the agent can stop overriding and fall back to the host default (symmetry with effort's `off`).

**Simplify.** `thinking-model` and `reasoning-effort` were two copies of the same "single canonical private memory, body line 1 = value" pattern across four files. Folded the duplicated query/publish boilerplate into `src/memory/scalar-pref.ts` (`resolveScalarPref` / `findScalarPrefId` / `writeScalarPref`); `model.ts`/`reasoning.ts` keep only their role constant + validator, and the two tools keep only their distinct validation. A third such knob is now a few lines, not a fifth copy.

---

## 2026-06-08 — Switching models safely: smoke test on switch + OLLE_MODEL rescue hatch

Two safety properties added to the model-switch path, prompted by "the agent can't verify 4-8 is real, and can we go back?"

**The agent never had to verify — the host does.** `set_thinking_model` gates on `hasPostedPrice`, and `resolveThinkingModel` re-checks it at read time, so a typo/hallucinated name is rejected and a corrupt memory row falls back to `DEFAULT_MODEL` rather than bricking boot. The one residual hole: "priced" proves the host can *bill* a model, not that the API *serves* it. Closed it two ways.

1. **Smoke test on switch.** `set_thinking_model` now takes an optional `probe(model)` (wired in the daemon from the LLM adapter as a 1-token `complete` call). It runs after the posted-price gate and before the memory write; if the provider rejects the model, the switch throws and nothing is written. A priced-but-unserved model can no longer reach loop start, so a switch can't brick the turn loop. This is the extension-loop's propose→smoke→activate pattern applied to model choice — verification by *calling*, not by belief. `default` skips the probe (can't be wrong). Probe is optional so unit tests skip it; production always wires it.

2. **`OLLE_MODEL` rescue hatch.** `resolveBootModel` reads an `OLLE_MODEL` env override at boot, ahead of the memory: priced override wins, `default` forces the host default ignoring the memory, an unpriced override is ignored (a typo can't brick the rescue). This is the human off-ramp for the otherwise-unreachable case where a muted agent can't run a turn to fix its own model — set the env and restart, no SQLite, no agent. Honors the "env = behavior toggle, not secret" rule. Set via `systemctl --user set-environment OLLE_MODEL=claude-opus-4-7 && olle daemon restart` (or `OLLE_MODEL=… olle run` in foreground).

Rollback layers now: change is staged (not live until restart) → `set_thinking_model("default")` → explicit model → `OLLE_MODEL` boot override → delete the one canonical memory row. The daemon process never fails to boot on a bad model; at worst chat turns 400, and now even that can't happen through the blessed switch path.

---

## 2026-06-08 — Model/effort apply per-thread, not per-restart (supersedes "restart to apply")

The earlier thinking-model / reasoning-effort entries resolved `(model, effort)` **once at loop start** and passed static values to the single agent loop, so a self-switch needed a daemon restart. Replaced with **per-thread freeze**: `AgentLoopOptions` now takes `resolveModel` / `resolveEffort` thunks; the chat loop calls them once when a `Thread` is first created and freezes the result onto the thread for its life. A `set_thinking_model` / `set_reasoning_effort` switch is therefore picked up by the next **new** thread (a fresh `olle chat`, `/new`, `/clear`, or a new channel thread); active conversations keep what they started with. No restart.

Why per-thread freeze rather than per-turn: switching a live conversation's model mid-stream would (a) feel like the agent's mind changed mid-thought, and (b) invalidate the prompt cache (model is part of the cache key — see `prompt-caching.md`). Freezing per thread keeps active threads' caches warm and only pays the cold-start on a genuinely new thread, which starts cold anyway. So this is both the more intuitive UX *and* the cheaper one — the restart-to-apply compromise was leaving that on the table.

Static `model` / `effort` options are retained as the fallback for child loops (`agent/manager.ts`) and tests; only the daemon's root loop wires the live resolvers. `OLLE_MODEL` rescue hatch and the switch smoke-test are unchanged and still apply (resolver calls `resolveBootModel`).

---

## 2026-06-16 — Model/effort self-config ported onto the Vercel AI SDK (the five 2026-06-08 entries landed on main here)

The five entries above were authored on `feat/model-effort-self-config`, a branch off pre-Vercel main. While it sat unmerged, main replaced the hand-rolled `@anthropic-ai/sdk` adapter with the Vercel AI SDK (entry 2026-05-20). The branch couldn't merge — it re-added the deleted dependency and edited a rewritten adapter. So the feature was **ported**, not merged, and a few mechanics from those entries are now stale at the implementation layer (the *decisions* stand; the wiring moved):

- **Effort no longer rides a raw `output_config.effort` on a cast SDK request.** It now flows through the AI SDK's `providerOptions.anthropic = { thinking: { type: "adaptive" }, effort }` (the provider maps `effort` to the same dial; the enum `low|medium|high|xhigh|max` is identical). Temperature is still dropped when effort is set. `src/llm/anthropic.ts`.
- **Thinking-block round-trip moved into `src/llm/vercel-mappers.ts`.** Anthropic surfaces thinking as AI SDK `reasoning` content parts carrying `signature` / `redactedData` in `providerMetadata.anthropic`. `contentPartsToBlocks` maps those to OLL-E `thinking` / `redacted_thinking` blocks; `buildMessages` echoes them back as `reasoning` parts with the signature in `providerOptions.anthropic`, so the SDK re-emits the wire `thinking` block and a tool-use turn doesn't 400. Same correctness property the 2026-06-08 entry named, expressed through the SDK seam instead of raw blocks.
- **`@anthropic-ai/sdk` 0.38 → 0.102 (entry above) is moot** — that dependency is gone; the SDK bump it describes doesn't apply to main.
- **`DEFAULT_MODEL` is now `ANTHROPIC_DEFAULT_MODEL`** (main went multi-provider). The model/effort modules alias it at import; the host default lives in `src/daemon/model-preference.ts` (`BOOT_DEFAULT_MODEL`), which the per-agent memory choice overrides.

**Dropped on the way in:** the branch also carried an early `olle status` command + its observability support (`turns`, `firstUserText` on `ThreadInventoryRow`). Main built its own richer `olle status` (peers, chat health, root agent) independently. Kept main's; dropped the branch's to avoid two competing implementations. Only the model/effort half of the branch landed. `feat/extended-thinking` (an even older, pre-Vercel take on the same idea) was dropped entirely.

Verified: `tsc` clean, 433 pass / 2 skip / 0 fail, the 65 model/effort feature tests green against the Vercel mock.

---

## 2026-06-16 — Host does minimal structural validation of tool input before execute()

A chat log surfaced the failure: an agent blind-called `read_extension_file` — a deferred tool whose schema it never loaded — guessing the param `file` when the tool wants `path`. The runtime ran no check against `inputSchema` (it only calls a tool's optional `validate()`, which `read_extension_file` lacks), so `undefined` reached `join(base, undefined)` and Node threw `The "paths[1]" property must be of type string`, leaked verbatim to the model. The agent couldn't decode it, retried the same mistake, then spent a `load_tools` round-trip to reverse-engineer the param name — three round-trips to read one file, all of which persist in thread context.

Root cause is a seam, not a model quirk: the catalog (LOG 2026-04-25) lists every tool by name, and dispatch resolves the **full** registry (`toolByName`), not the visible set — so the model can call a deferred tool whose schema was never sent. Blind calls to no-arg tools (`query_host_context`, `list_starters`) succeed and train the model that catalog tools are directly callable; the first arg-bearing tool then crashes.

**Decision:** the runtime now runs `validateToolInput` (`src/agent/validate-tool-input.ts`) against `tool.inputSchema` before `execute()`. On a structural miss it returns a legible, schema-carrying `is_error` result (`missing required property: path`, `unexpected property: file`, plus the schema) so the model self-corrects in one turn. A tiny JSON-Schema subset — required props, `additionalProperties:false`, primitive `type` checks — no dependency, consistent with the "plain JSON Schema, no shared schema-library at the boundary" rule.

**Why this shape, not the alternatives:** forbidding dispatch of unloaded tools ("load it first") was rejected as a refusal-shaped wall — anti-vision. Making the constraint *teach the shape* rather than crash is the "constraints feel like physics" invariant; writing the error for the agent to act on is "the inhabitants are the primary audience." Same principle as auto-load-on-register (LOG 2026-04-26): the agent expressed intent by calling; the world adapts. Structural validation now pre-empts `validate()` when the input violates the declared schema (an existing `agent.test.ts` case was updated to assert `validate()` still owns *semantic* rules the schema can't express). `ToolDef.inputSchema`'s "host does not introspect it" comment was amended.

**Logged for follow-up, not fixed here:** the daemon's minimal launchd/systemd PATH (`scripts/install.sh` sets only `OLLE_HOME`) makes `claude`/`codex` invisible to the daemon and everything it spawns even when installed — so "not on PATH" reads as "not installed." A separate infra slice (bake a fuller PATH into the service env, or augment PATH at spawn in the subprocess starters). Verified for this change: `tsc` clean, full suite 447 pass / 0 fail.

---

## 2026-06-16 — Daemon recovers the user's real PATH from the login shell (the follow-up above)

The PATH gap from the entry above bit concretely on a nix-darwin host: `which claude` → `/etc/profiles/per-user/<u>/bin/claude`, but the daemon's PATH was the launchd-stripped `/usr/bin:/bin:/usr/sbin:/sbin`, so `query_host_context` reported "claude not on PATH" and the agent concluded "not installed on this machine." The tool was there; the daemon was blind to it. A false constraint — VISION says limits should be real (cost, safety), not artifacts of a stripped environment.

**Decision:** at the daemon *process* entry points (`cmdRun` in `src/cli/run.ts`, `main` in `src/daemon/main.ts`), call `enrichPathFromLoginShell()` (`src/daemon/path-env.ts`) before `startDaemon`. It runs `<shell> -lc 'printf %s "$PATH"'` (SHELL or platform default; 2s timeout; failure → no-op), then merges the login dirs into `process.env.PATH`, login order first, deduped. Everything downstream inherits it unchanged — `query_host_context`'s `which`, the starter templates' `resolveCommand`, and the spawned subprocess — so a single enrichment fixes the whole class. No starter-template change needed.

**Why this shape, not the alternatives:** baking PATH into the launchd plist / systemd unit at install time was rejected — it snapshots the install-time environment and rots (the same failure the plist's own comment flags about embedding `ANTHROPIC_API_KEY`), and it doesn't cover `olle run` from a fresh shell. Hardcoding Nix/Homebrew/asdf candidate dirs (what the on-disk smoke test did) is a guess that misses the next ecosystem; asking the *login shell* is robust because that's exactly where every ecosystem registers its bin dir. Placed at the process entry, not inside `startDaemon`, so the reusable core stays free of shell-spawning and the 5 daemon-booting tests don't shell out. The on-disk agent-authored `claude-code/smoke.ts` still hardcodes three dirs and replaces `env.PATH` for its `which` fallback — that's the inhabitant's artifact to refresh; the platform fix is making `query_host_context` honest so the agent reasons from a true PATH. Verified: probe surfaces `/etc/profiles/per-user/<u>/bin` on the affected host; `tsc` clean, full suite 456 pass / 0 fail.

---

## 2026-06-17 — Compiled-Bun child spawns inherit the exec-time PATH, not runtime mutations (the real Nix bug)

The 2026-06-16 PATH-enrichment entry was half a fix. Symptom that exposed it: on the Nix host, `query_host_context` reported a full `process.path` (including `/etc/profiles/per-user/<u>/bin`) yet its `commands` probe said `claude` not-found — while `git` (in `/usr/bin`) resolved. Reproduced under a **compiled** binary launched with a stripped env: mutating `process.env.PATH` at runtime (what `enrichPathFromLoginShell` does) is **invisible to child processes** — a compiled Bun binary spawns children with the *exec-time* environment, and no in-process method (`process.env.PATH=`, `Bun.env.PATH=`, full-object reassign) changes that. So the enrichment only ever fixed JS reads; `query_host_context`'s `spawnSync("which", ...)` — a child — kept searching the stripped exec PATH and false-negatived on anything outside `/usr/bin`. `process.path` and `commands` were reading two different PATHs in the same process. (The earlier "the resolver works" repro was wrong because it ran from a shell that already had the full PATH at exec time, hiding the divergence entirely. Lesson logged: reproduce under the *deployed* conditions, not a convenient shell.)

**Two-faced fix:**
- **Probe honesty (`src/tools/meta.ts`):** `resolveCommand` no longer shells out to `which`. It walks `process.env.PATH` in-process (`statSync` + `accessSync(X_OK)`), the same value `process.path` reports — so the two can never disagree again, and it reads the enriched PATH that runtime mutation *does* fix for in-process code. Proven: under a stripped-exec compiled binary with runtime-enriched PATH, the in-process walk resolves `claude`/`bun`/`git` where the old `which` child found only `git`.
- **Subprocess reality (`scripts/install.sh`):** child spawns can only be fixed at the *launcher*, so the login-shell PATH is now baked into the launchd plist (`EnvironmentVariables/PATH`) and systemd unit (`Environment=PATH=`). That makes the daemon's exec-time PATH correct, which every subprocess extension (claude-code, codex) inherits natively. This reverses the 2026-06-16 reasoning that rejected baking PATH into the service definition as "snapshots and rots": runtime enrichment provably *cannot* reach children in compiled Bun, so the exec-time PATH is mandatory. Staleness is the accepted tradeoff (existing dirs keep working; a brand-new PATH dir needs a reinstall), and `enrichPathFromLoginShell` stays as the in-process half plus the rescue for `olle run` from a stripped shell. Comments in `run.ts` corrected to stop claiming the runtime pass fixes spawns. The install-side probe mirrors `path-env.ts`'s sentinel (login shells print profile noise to stdout; a leaked banner — or its newline — would otherwise be baked into the service PATH and break the systemd unit), and `$SERVICE_PATH` is XML-escaped into the plist and shell-quoted in the systemd `Environment=` line so a dir with `& < >` or spaces can't malform the config.

Also (data, not code): the earlier confabulated `knowledge` memory (`query_host_context can false-negative on PATH`) was a *symptom* of this real bug, not pure hallucination — the agent observed a true divergence and guessed the wrong mechanism. It was retired via a `memory.forgotten` tombstone once the real cause was found. Verified: `tsc` clean, full suite 461 pass / 0 fail.

---

## 2026-06-17 — A fresh thread seeds its loaded set from active extensions

Symptom from a live `olle chat`: the agent called the `claude_code` extension tool with a guessed input shape (`{prompt}`), missing the required `cwd`, and ate a validation-error round-trip — *every session*. The guess itself is not the bug: the `fix/tool-input-validation` branch is built for blind calls (the catalog lists tool names, a wrong guess returns the schema, the agent self-corrects in one turn, deterministically — `validate-tool-input.ts`). The bug is that the per-thread loaded set is in-memory and a fresh thread started **empty** (`loadedTools: new Set()`), so an already-installed, *active* extension's tool was back to a name-only catalog line with its schema deferred. Auto-load-on-register fires only at the register *moment*; across a restart that intent evaporated and the agent re-guessed (or re-`load_tools`ed) the same installed capability every session.

**Decision:** seed each new thread's loaded set with every currently-active extension's contributed tools (`seedExtensionTools`, `src/agent/chat.ts`), always-loaded tools excluded. Same reasoning as auto-load-on-register, extended across the process boundary: a registered extension is a capability the agent chose with intent to use, and that intent outlives a restart. Chosen over the broader per-agent *durable* loadout (persist whatever was `load_tools`ed, rehydrate on new threads), which stays `[DEFERRED-to-v0.1]` — this slice fixes the actual papercut (installed-capability re-guessing) without a store + restore path. Cheap because extension schemas live in the separately-cached **tools block**, not the identity/catalog prefix: a bigger active set costs a marginally larger cache-read per turn and never invalidates the expensive prefix; size is bounded by active-extension count, which specialist-delegation keeps small at scale. Core deferred tools (delegation, secrets, observability beyond `query_self`) are deliberately *not* seeded — occasional reaches, not installed capabilities. Vision check: "the simplest mechanism that serves the vision wins" and "ask less of the inhabitants." Verified: `tsc` clean, full suite + new `seed-extension-tools.test.ts` green (462 files-worth, 0 fail).

Noted, not fixed here: `config.toml` is a dead coordinate — `paths.ts` defines it and `buildHostContextPrompt` advertises it, but nothing writes or reads it (config comes from a hard-coded boot default, `paths.ts:21`). The boot preamble disclaims existence, so `query_host_context` reporting `exists: false` is honest — but advertising a by-design-absent file in the stable prefix invites the confusion the agent flagged. Left for a follow-up.

---

## 2026-07-08 — Agent-direct task authoring, unparked: standing jobs land as `schedule_*` + the `triggers` table

Three prior entries parked agent-direct task authoring behind extension packaging. LOG 2026-04-22 (Discord/GitHub architecture) blessed `register_task` in the self-mod vocabulary but left it unbuilt ("task-only authoring still goes through extension packaging for v0", line 150). LOG 2026-04-22 (scheduler) parked the `register_task` meta-tool explicitly: "Revisit when an agent actually wants to author a task file without wrapping it in an extension" (line 180). LOG 2026-04-23 (dream) re-parked it a third time (line 280). The resurrect-when has now fired — but not as `register_task`.

**The condition was met by the push-first program, not by an agent wanting to hand-write a handler.** The real want turned out narrower and sharper: the agent needs to make *itself* fire on a schedule — a morning digest, a recurring check — with no human at the keyboard. That doesn't need arbitrary task-file authoring; it needs one specific behavior (cron → wake a turn) exposed as a tool. So the unpark takes the shape of `schedule_task` / `schedule_list` / `schedule_cancel` core tools writing `type='cron'` rows into the previously-dead `triggers` table — the first live reader/writer of a schema that shipped in 0001 and had held zero rows ever. No new primitive, no migration, no `register_task`.

**The locked rule: determinism in the substrate, cognition only inside the turn.** A standing job is a cron'd natural-language instruction. The cron fires in code (`croner` in `src/schedule/`), the delivery route is computed deterministically from the job's config, and the *only* stochastic part is the agent turn the fire wakes. This is a direct correction of the owner's OpenClaw experience, where "heartbeat" prompts — waking the LLM every N minutes to decide whether to act — hallucinated messages that were never sent and made the schedule itself nondeterministic (the agent would sometimes skip its own job, sometimes fire twice). **Heartbeat is explicitly rejected.** The schedule is a fact in the substrate; the agent reasons about *what to do* when woken, never about *whether it is time*.

**Operational tier, self-only target.** `schedule_*` are `operational` — scheduling yourself to post a digest is not a strategic act, and gating it behind the inbox would defeat the whole point (push without a human in the loop). The guard that keeps this safe is target-scoping: a job always runs as its creator, on its creator's budget and tools; `schedule_cancel` enforces `agentId === ctx.actorId`. Cross-agent scheduling — "schedule *that* agent to do X" — is a different act with a real authority question, and it would be strategic. `[DEFERRED-to-v0.1]` Cross-agent standing jobs. **Resurrect when:** an agent has a concrete need to schedule a peer or child, at which point the target check becomes an ask-up rather than an ownership reject.

**Misfire policy: skip missed-while-down.** Arming computes the next *future* fire; a daemon asleep across a scheduled time does not replay it on boot. The alternative — catch-up bursts — is worse for a natural-language job: a laptop closed over a weekend would wake to three days of stale "post yesterday's digest" turns, each now wrong. A standing job's value is fresh-at-fire-time; a missed fire is better dropped than replayed stale.

---

## 2026-07-08 — Push-first: OLL-E was pull-only and therefore unused; making it push

**The diagnosis.** A forensic pass on the owner's own install turned up the damning fact: the `tasks`, `triggers`, and `decisions` tables had zero real rows, ever. Every capability the system had grown — the extension loop, the scheduler, the inbox, the ask-up chain — was reachable only by a human first typing into `olle chat`. OLL-E was pull-only. The owner had built a substrate for proactive agents and then never used it, because using it required him to initiate every single time. A world agents are supposed to "love to live in" that only moves when poked is a chat client with extra steps.

**The fix is to make the system push**, along four fronts landed in this program (9 commits):

- **Standing jobs** (entry above) — the agent schedules itself to fire, so useful work lands unprompted. This is the load-bearing piece; everything else serves it.
- **Channel starters that reach the human where they already are** — `telegram` (long-poll `getUpdates` adapter + `telegram_send`) and `telegram-communication`, alongside the existing Discord pair, so a digest can land in the app the owner actually checks. `freshrss` (Google Reader API) and a new `github_activity` delta tool give the digest something worth saying.
- **SETUP.md on all eight starters** + an `install_starter` nudge (`hasSetupGuide` in the tool return), so the agent walks a human through BotFather / a GitHub PAT / FreshRSS API creds conversationally instead of guessing at secrets or asking for tokens in chat.
- **Deterministic bridge routing with source disambiguation** — a fired job's turn runs on a channel-encoded thread id (`discord:<channelId>:job:<jobId>`) the bridge routes from the id alone, with no prior inbound message on the thread; `channel-message` payloads now carry `source: "discord"|"telegram"` and each bridge filters on it, so a two-bridge host doesn't relay its own cross-channel echoes.

**grant_scope executor — the approve-hang gap.** Adjacent bug, fixed in the same program. When a denied tool call auto-proposed `grant_scope` to the inbox (LOG 2026-04-22 permissions), approving it did *nothing*: `inbox.respond()` flipped the decision status and emitted `decision.resolved`, but no code ever mutated `agents.scope`. Approve was a doorbell — the next call was denied again, identically. `src/permissions/grant.ts` is the missing executor: on an approved/modified `grant_scope` resolution it merges `{tool, tier}` into the target's scope, gated by `narrowsScope` against the approver (you can't grant authority you don't hold), and publishes `scope.granted` / `scope.grant-rejected`. `denied` / `stale` / freeform resolutions stay wake-only — consistent with the 2026-04-27 rejection of generic decision-resumption (only `grant_scope` has a concrete thing to execute).

**The phase gate.** No Phase-2 capability work — email, calendar, more data sources — until the loop proves itself: an unprompted, useful digest lands in a channel on **5 separate days**. The gate is deliberately behavioral, not a feature checklist. The failure mode this whole program corrects was building capability nobody used; the discipline is to not build more until the existing loop demonstrates it earns a human's attention day after day. Counting starts from the first real 8am digest job.

---

## 2026-07-08 — Telegram UX: presence, streamed replies, real formatting; reaction-ack rejected

**The gap.** The telegram starter pair was a functional pipe with dead air: a human sent a message and saw nothing until one unformatted blob arrived at turn-end — literal `**asterisks**` included, since `telegram_send` escaped everything and rendered nothing. Research (live Bot API docs + the openclaw/hermes reference integrations) drove a rework of both templates.

**Streaming tiers, best-available-first.** Bot API 9.3 added native draft streaming (`sendMessageDraft`, all bots since 9.5): partial text animates as an ephemeral client-side draft, an empty draft renders a native "Thinking…" placeholder, and only the finalize `sendMessage` persists. Private chats get that; groups (and pre-9.5 servers, detected by first-draft failure) fall back to the classic throttled send-then-`editMessageText` loop with a ▌ cursor and a 4s-refreshed typing indicator. Constants follow the FAQ flood envelope and the reference repos' production practice: 1s edit cadence in DMs, 3s in groups, dedup-before-edit, "message is not modified" treated as success, `retry_after` honored up to 60s, truncate-don't-split mid-stream, split properly only at finalize. Rich Messages (Bot API 10.1, GFM markdown, 32k chars) noted as the upgrade that deletes the escaping and chunking code — deliberately not adopted at one month old.

**Where the state lives.** `telegram_stream` is one stateful adapter tool (start/update/finalize/cancel session phases) rather than exposed `editMessageText` primitives: flood-control state belongs next to the token that pays for violating it. The bridge subscribes to `chat.assistant-delta` (the token feed existed all along; the manifest just never read it) and pushes latest-state-wins updates on a 1s tick — never per delta, because every `callTool` is a logged row. Turn-end finalizes in place; `telegram_send` remains the never-drop floor if the stream dies. All new tools are operational-tier — the runtime's `callTool` gate rejects strategic tools from extensions (the `discord_react` tier is why discord can't grow the same bridge-driven UX without a change).

**Formatting.** Markdown→Telegram-HTML converter (fenced code with language class, inline code, bold/italic/strike with word-boundary guards, links, headings, quotes, bullets), everything else escaped, plain-text resend on entity-parse 400, fence-aware chunking at 3500 chars. HTML over MarkdownV2 stands: 3 escaped chars beats 18, and broken HTML is machine-detectable.

**Reaction-ack rejected.** Bots have no read receipts (`readBusinessMessage` is business-connection-only); the idiomatic substitute is a 👀 `setMessageReaction`, and both reference repos ship elaborate status→emoji systems. The owner vetoed it as tacky and annoying — presence comes from the "Thinking…" draft and typing indicator alone, which signal the same thing without stamping the human's message. **Resurrect when:** a real need for per-message acknowledgment that presence can't express (e.g. group chats where the bot reads but doesn't answer).

---

## 2026-07-08 — Thinking made visible: summarized display, streamed thinking-delta; no ledger breakout

**The gap.** Reasoning effort worked end-to-end (memory → per-thread freeze → clamp → `output_config.effort`) but was invisible twice over. First, the adapter sent `thinking: {type: "adaptive"}` with no `display`, and the Opus 4.7+ default is `"omitted"` — thinking blocks came back with *empty text*, so there was literally nothing to show or persist. Second, even non-empty thinking had no path out: the adapter's `onChunk` forwarded only `text-delta`, `emitStep` filtered assistant content to text blocks, and the CLI had no render arm or effort indicator. A user staring at `olle chat` could not tell whether the agent was thinking at all.

**The fix.** `display: "summarized"` whenever effort is set (billing is identical either way — thinking tokens count toward `output_tokens` regardless of display, so visibility is free). A provider-neutral `onReasoningDelta` hook mirrors `onTextDelta` through both adapters; `runAgent` surfaces it as a `thinking_delta` step; the chat loop publishes it as **`chat.thinking-delta`, non-durable** — same reasoning as `chat.assistant-delta`: deltas are visualization, not history. The durable record is the thinking block inside the assistant message, which must persist anyway for the signature echo (a tool-use turn 400s without it). The CLI streams thinking dim-italic in the live region, collapses each stretch to a one-line `✻ thought for Ns` marker, and the footer shows `think:<effort>` next to the model.

**Cost tracking: deliberately no breakout.** Anthropic does not report thinking tokens separately — they are folded into `output_tokens`, which the ledger already records exactly, so USD stays exact too. A `thinking_tokens` column could only hold an estimate (the summarized display text is a *summary*, not the billed reasoning — counting its characters would understate real cost), and storing estimates as physics is precisely what the 2026-04-24 tokens-only-ledger entry forbids. **Resurrect when:** the API starts reporting a real reasoning-token count in usage; then it's one ledger column and a pricing passthrough.

**Context-feedback note, recorded because it keeps coming up.** Thinking blocks feed back into context *within* a turn (each tool round-trip re-sends them; required, and how the model keeps its reasoning chain across tool calls) but *not across* turns — the API strips prior-turn thinking server-side and doesn't bill it as input. OLL-E re-sending them from `thread.messages` is therefore harmless: no context cost, no cache invalidation, and the context gauge stays honest because it reads API-reported usage, not local message bytes.

---

## 2026-07-09 — Accounting audit fixes: partial-usage recording, effective-dated prices, budget armed

**The audit.** A full accounting audit (code trace + live-DB reconciliation) found the pipeline exact for every completed turn — ledger totals matched `chat.turn-end` events with zero drift on all 36 threads — and three gaps, all closed here.

**Partial usage survives a failed turn.** `runAgent` accumulated usage across round-trips but a thrown error or user cancel discarded the whole total: the catch in `runTurn` skipped `ledger.record`, so a turn that died on round-trip 6 silently dropped five rounds of real, billed spend (each round re-reads the whole context as cache_read) and under-decremented the budget. The turn's spend now accumulates outside `runAgent`'s return path — from the per-round-trip `usage` steps — and is recorded in both the success and error paths. Zero occurrences in live data (no `chat.error`/`chat.cancelled` ever); fixed before it cost anything. The model-switch smoke probe (`daemon.ts`), the one other billed LLM call site, now records too.

**Prices are effective-dated; history stops moving.** `priceTokens` gains an `at` parameter and `pricing.ts` supports per-model rate eras (`effectiveFrom`); observability prices each ledger row at the rate in effect at the row's own timestamp, and the ledger prices a spend at record time. This refines 2026-04-24's "USD computed from current prices": the ledger stays tokens-only and USD stays a derivation — but a derivation from *the rate that was actually billed*, so a provider price change appends an era instead of retroactively re-valuing every past month. Note for the record: the 2026-05-05 pricing.ts change was a **bug fix**, not a price change — opus-4-7 was always $5/$25 (the initial sheet wrongly copied the legacy Opus 4.1 tier), so it stays a single-era model and pre-fix `turn-end.usdMicros` snapshots (~$18.5 total) overstate what Anthropic actually billed (~$10.8). Current `olle stats` is the number that reconciles against the console.

**Budget armed; the write surface now exists.** The audit found the `budgets` table empty — the whole cap machinery (thresholds, inbox alerts, pre-turn wall) wired but dormant, all spend uncapped. `ARCHITECTURE.md` sketched `olle budget set` but only the read side was ever built. Added `setBudget` (upsert preserving accumulated spend — a cap change is a policy change, not an amnesty), a `budget.set` IPC method, and the `olle budget show|set` CLI. Vision check: this is not a privileged bypass of the inbox — the inbox flow is how an *agent* requests a raise; the owner granting one on their own money is the terminal act of that same chain (same standing as `olle secret set`). Armed: $100 all-time on the root agent.

---

## 2026-07-11 — Agent-grade extension API reference (`src/extensions/docs/extension-api.md`)

The `ExtensionApi` contract shipped compiled away: no document, tool, or prompt line told an agent `register(api)` exists, what `ToolDef` carries, or the five `callTool` gates — starters were the accidental docs, and `registerTask`/`callTool`/`validate`/`maxResultBytes` were exercised by zero worked examples. An agent authoring an extension flew on priors plus error-message archaeology. One hand-written 582-line reference (pi-mono's editorial pattern: complete quick-start artifact first, types as inline comments in runnable snippets, Safe/Unsafe footgun pairs, five complete single-concept examples) now documents the whole surface, including deliberate physics previously discoverable only by failure: smoke-less tool-only extensions are legal, no third-party deps with the decision-inbox escape hatch, api revocation after unload, the gate error strings verbatim. A guard test pins the load-bearing strings so the doc can't silently rot. Same commit repairs ARCHITECTURE's smoke-mandatory and fs-watch drift (code was right; the doc lied). Kept hand-written adjacent to `types.ts` — generation machinery hasn't earned its place.

---

## 2026-07-11 — `web` starter: one `web_fetch(url)` tool

Agents needed the public web (4 of 5 peer runtimes surveyed ship fetch; digests summarizing headlines want article bodies) and the alternative was each agent hand-rolling an unguarded fetch. Operational tier — read-only. Hand-rolled HTML→markdown, Bun built-ins only: the no-third-party-deps physics is load-bearing, not a nuisance. Download cap plus the existing `maxResultBytes` spill; SSRF guard blocks private/link-local/CGNAT/loopback ranges with DNS pre-resolution and manual redirect re-validation per hop (DNS-rebind TOCTOU between lookup and fetch is an accepted, commented limitation at this tier). `web_search` deliberately excluded — search needs a provider key and ranking opinions; that's a future proposal, not a fetch.

---

## 2026-07-11 — Docs-as-files delivery for the API reference

Boot writes the embedded reference (Bun text import, the same binary-embed mechanism the migrations use) to `~/.olle/extensions/.docs/extension-api.md` — host-actor commit, only when content changed, so a binary upgrade shows up as a readable diff in the extensions repo: the world's physics changed and the change is visible history. The stable system segment gains a two-line router pointing at it (~40 resting tokens, cached). Rejected alternatives, for the record: catalog inlining (pays the token cost every turn inside the prefix self-modification already thrashes), a dedicated docs tool (a new tool whose entire behavior is "read a file"), memory rows (the contract is a world fact, identical for every agent and versioned with the binary — not identity; memories hold what an agent *learned about* authoring, not the reference itself). One mechanical discovery: `read_extension_file`'s name validation rejected dotted names, so `.docs` is an explicit read-only allowance — `write_extension` still can't touch it, and extension discovery already skips dot-entries.

---

## 2026-07-11 — Delivery-audit events from the channel bridges

A Telegram or Discord delivery failure was a `console.error` — invisible to `query_events`, the inbox, and the agent itself, so a standing job could "succeed" while its digest landed nowhere. Both communication bridges now publish durable `delivery.succeeded` / `delivery.failed` at turn-end delivery, payload `{ channel, threadId, destination, jobId?, error? }` with `jobId` parsed from the `:job:` thread suffix (it exists nowhere else at the emit site). Deliberately minimal: an event convention plus two template edits — no new query surface, no core changes — so observability parity holds by construction (`query_events` for agents, `olle events` for the human). The quiet-cancel/explicit branch emits nothing, because no bridge delivery was attempted. The convention is documented in the extension API reference for future bridges.

---

## 2026-07-11 — Revoke `api` after unload

`purgeRegistry` unsubscribed, stopped triggers, and evicted tools — but an `api` captured in a timer or promise chain could still `publish`/`callTool` after unload: events attributed to a dead registration, a provenance lie in a system whose federation story *is* provenance (pi-mono's staleness-poisoning, adapted). A per-load `revoked` flag is now checked by every api action method plus the task-emit wrapper; post-unload calls throw `extensions: "<name>" was unloaded; re-register before acting`, while a revoked trigger's `emit` drops silently (it fires from background timers, where a throw would crash the timer loop rather than inform anyone). Flag over Proxy: a handful of explicit guard lines, no reflection magic, same fail-closed result. Reload mints a fresh record, so the new api works while stale references keep throwing. Corollary contract: `unload()` runs after revocation and must not call api methods.

---

- **Adding an entry**: date-stamp, label the decision area, record the decision and the reasoning. Keep entries short — one paragraph per decision is usually enough.
- **Reversing a decision**: add a new entry; link to the entry being reversed. Do not edit the reversed entry.
- **When in doubt**: write the entry. Future contributors (human or agent) will be grateful for the context.
