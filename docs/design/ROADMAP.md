# OLL-E — Roadmap

Milestone scope. `VISION.md` says what OLL-E is and never bends; `ARCHITECTURE.md` says how v0 is built; this file says what a version ships, what it deliberately doesn't, and the gate between phases. When a feature lands on the table, check here first — a non-goal below is a decision, not an oversight.

## The killer use: the daily digest loop

v0 earns its keep with one loop, not a feature list: **an unprompted, useful digest lands in a channel every morning.** One standing job (`schedule_task`, created conversationally — "post me yesterday's unread items and repo activity at 8am"), pulling from FreshRSS + GitHub, delivered to Discord or Telegram. The whole substrate exists to make that loop trustworthy: the schedule is deterministic (cron in code, not an LLM heartbeat — LOG 2026-07-08), the delivery route is derived from the thread id with no prior inbound message, and the only stochastic part is the agent's turn writing the digest.

This is the answer to the diagnosis that OLL-E was built and never used (LOG 2026-07-08, push-first): the system was pull-only, so it moved only when a human typed. The digest loop is the smallest thing that makes it push.

Everything shipped for v0 serves this loop:

- **Standing jobs** — `schedule_task` / `schedule_list` / `schedule_cancel`, the cron subsystem (`src/schedule/`). See ARCHITECTURE "Standing jobs".
- **Channel starters** — `discord` + `discord-communication`, `telegram` + `telegram-communication`, so the digest reaches the human where they already are.
- **Data starters** — `freshrss` (unread + feeds), `github` (`github_activity` delta), so the digest has something worth saying.
- **SETUP.md on every starter** + `install_starter` nudge, so onboarding a channel is a conversation, not a guess at secrets.
- **grant_scope executor** — approving a scope grant actually mutates scope (LOG 2026-07-08 approve-hang fix), so the first tool denial the loop hits isn't a dead end.

## The phase gate

**No Phase-2 capability work until the loop proves itself: an unprompted, useful digest lands in a channel on 5 separate days.**

The gate is behavioral, not a checklist. The failure this whole program corrects was building capability nobody used; the discipline is to not build more until the existing loop demonstrably earns a human's attention day after day. Counting starts from the first real 8am digest job. (LOG 2026-07-08.)

## Phase 2 (gated) — more of the world worth pushing

Sketch only; scope firms up against what the 5-day run teaches. Candidates, roughly in want-order:

- **Email starter** — read/triage/draft; the digest gains an inbox summary and can send.
- **Calendar starter** — today's agenda folds into the morning digest; scheduling nudges.
- **More data sources** — whatever the digest keeps wishing it had.
- **Dream / reactive self-repair** — v0.1 starter extensions (LOG 2026-04-23); resurrect when the failure-event corpus is real evidence.

## v0.1+ deferred (tracked in LOG with resurrect-when)

Back-linked to their LOG entries; `grep '\[DEFERRED-' docs/design/LOG.md` is the live index.

- **Cross-agent standing jobs** — v0 jobs always run as their creator (self-only target). Scheduling a peer or child is a real authority question and would be strategic. (LOG 2026-07-08.)
- **Mesh hardening** — TLS / `wss://`, relays, mDNS, per-team secret rotation, per-actor wire signatures, cross-host decision-row sync. v0 is LAN-only, "the friend you handed the code to." (ARCHITECTURE "Cross-host mesh".)
- **Parent-read of child private memory; scratch-to-`task_runs` binding** — schema-touching, land with the memory-surface work. (LOG 2026-04-23.)
- **Agent death / survival economics** — no population to select across in v0. (LOG 2026-04-23.)

## Post-v0 — Isolation program

The MVP-v0 phase is over. v0 proved the digest loop; the substrate now hosts agent-authored
code, and that code runs *inside the daemon* — imported into its address space, handed every
secret in plaintext, able to crash the process or exfiltrate anywhere. The isolation program
closes that hole: agent-authored extensions become **untrusted by construction**.

- **Per-agent microVMs.** Each agent's grown extensions run in that agent's own Firecracker
  microVM (Linux/KVM first). The VM has **no network device** — all egress is forced through a
  host-side credential broker. Secrets never enter the guest (REST or WebSocket); the broker
  injects them at the edge, so a compromised extension has nothing to steal and nowhere to send
  it. Smoke tests move into the guest, off the daemon's pre-gate path.
- **Why this is capability worth building, not feature surface.** Isolation is agency
  infrastructure: code that cannot hurt the host can be trusted with less approval friction,
  which serves the more-agentic path. It is the deterministic environmental boundary that holds
  when model-layer judgment doesn't — the same lesson Anthropic published from containing Claude
  (LOG 2026-07-18).
- **Pooling seam.** v1 is one VM per agent; a `placementFor(agentId, manifest)` seam lets 50-100
  agents later share pooled guest VMs by group without schema redesign. Revisit at >8 concurrent
  VMs.
- **Fallback is observable, never silent.** A host without a working backend runs extensions
  in-process (legacy) and emits a durable `extension.unisolated` event surfaced in `olle status`.
  macOS (vfkit) and a bubblewrap fallback tier are designed behind the backend interface,
  deferred until Linux microVM is proven.

## Explicit non-goals

Carried from ARCHITECTURE "Seams intentionally unbuilt", plus what the push-first program ruled out:

- **No LLM heartbeat.** Waking the agent every N minutes to decide whether to act hallucinates actions and makes the schedule nondeterministic. Determinism lives in the substrate; cognition only inside the turn. Rejected, not deferred. (LOG 2026-07-08.)
- **No generic RSS starter.** FreshRSS subsumes it — one adapter over the Google Reader API covers every feed the user already curates.
- **No cross-agent scheduling in v1.** (See deferred above.)
- **No remote code execution.** Cross-host is claim-model only; a task runs on whichever cell claims it, using that cell's own tools. (VISION load-bearing.)
- **No web UI, no Windows, no bidding/reputation/priority queues, no natural-language-only config** (files still exist; the agent edits them). (Sandboxing beyond the process boundary *was* a non-goal; lifted 2026-07-18 — see "Post-v0 — Isolation program" below and LOG 2026-07-18.)
- **No privileged human dashboard.** Every CLI read command has a parallel agent-callable tool; the CLI is the human's tool surface, never a privileged path.
