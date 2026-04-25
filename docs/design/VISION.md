# OLL-E — Vision

## What it is

OLL-E is an event-driven, self-modifying, async-by-default agent system. It installs as a single binary on any laptop or server and federates with peers into a cellular mesh where humans and agents are indistinguishable participants negotiating around a shared goal.

## The one-line pitch

A world that agents love to live in — and that they grow themselves.

## The philosophy

OLL-E is designed as a **habitat** for agents, not as a framework agents call into. The environment is clay, not prison. Constraints exist because they are real (cost, safety, alignment), not because we distrust the inhabitants. When in doubt, pick the more-agentic path.

Concretely this means:

- Agents can write new extensions, modify their own tools, spawn sub-agents, register triggers, edit goals.
- **An agent is a seed plus its lived events; culture flows down the lineage.** Memory is identity — preferences, philosophy, in-flight goals, grown capabilities, accumulated knowledge all live on one persistent surface. Parents transmit philosophy and orientations to children at spawn and remain readable afterward. Children form their own identity on top; drift is expected; correction is ongoing conversation. Maximum diversity, not maximum conformity.
- **Beliefs have inertia, not locks.** Every belief's resistance is proportional to its depth. Change is always possible; shifting a core belief takes evidence proportional to its weight.
- **Evidence is peer; authority is hierarchical.** Information from anywhere — peer, child, parent, principal, the world — updates any agent it reaches, weighted against that agent's own resistance. Hierarchy governs what can be *done*, not what is *true*.
- Constraints feel like physics. An agent experiences "my budget is low, let me ask for more" — not "the system refused me."
- **Humans are the oldest agents.** Not consoles outside the world — the seniors at the top of the ask-up tree, backed by real money, with their own memory, principles, and resistance. Their inbox is a channel. Every agent, human included, tries to impart its principles downward.
- Mid-flight pivots, buggy agent code, and growth are normal states. The system tolerates and recovers. Code is cheap; the environment is robust.

## What's load-bearing

- **Humans are just another event source.** A Discord DM from a person and an email from another agent produce structurally identical events. No special-cased human UI.
- **Nothing blocks on humans.** Agents propose decisions to a per-human decision inbox and continue other work. Replies are reconciled async.
- **Approvals bubble up the agent tree.** A child asks its parent, which either approves within delegated authority or escalates. The chain terminates at the oldest ancestor (the human), whose inbox takes the paged decision.
- **Budget flows down the tree.** The oldest agent (the human) owns the real-world money; each descendant receives a slice. Raising a cap is an inbox item to an ancestor, not a per-call approval.
- **Teams are peer cells around a shared goal.** No central coordinator. Friend-install = a new cell plugging into the collective.
- **Pooled compute = pooled workforce.** In v0, cells share events/memory/decisions across hosts; tasks run on whichever cell claims them, using that cell's own tools. No remote code execution.
- **Integrations are part of the world, therefore modifiable.** There is no `olle install discord` command. The agent proposes, writes, smoke-tests, and hot-loads an extension through the unified authoring loop.
- **Agents can call reinforcements.** Sub-agent spawning is v0, not v1. Cells grow the organism.

## The demo OLL-E v0 earns

1. `curl olle.sh/install | sh && olle run` on your laptop.
2. `olle chat` — first-contact REPL because no other channel exists yet.
3. You: *"I want to watch my Discord server's #bugs channel and try to fix auth-related issues in acme/api."*
4. Agent proposes a Discord extension + GitHub extension via the decision inbox with cost estimates. You approve and paste tokens.
5. Agent scaffolds, smoke-tests, hot-loads each. Active.
6. A bug shows up in #bugs. Agent claims it, shells out to `claude-code`, opens a PR, DMs you a summary on Discord.
7. Your friend runs the same install + `olle team join <code>`. They're now a cell.
8. Next matching bug appears. Your laptop is busy running something else; friend's cell sees the event, claims it, runs locally on their tools and budget. Both cells read/write the team's shared memory.

The self-modifying property is visible from minute one. The mesh property is visible within the first five minutes.

## What v0 is explicitly not

No remote code execution across hosts. No web UI. No Windows. No contract-net bidding, reputation, or priority. No CRDTs. No formal permission DSL. No tool marketplace. No E2E encryption beyond TLS. No SSO or multi-human invite flows. No voice/image/video channels.

These are not forbidden forever. They are not the MVP.

## Why these choices and not others

- **Single binary, not a library.** We want one-command install on any machine. Bun's `--compile` gives us this cleanly across mac+linux.
- **Daemon + thin client, not all-in-one.** Agents do background work. The daemon runs, clients come and go.
- **SQLite + Drizzle, not Postgres.** Each host is sovereign over its own store. Federation is event-log merge, not shared DB.
- **Agent-native markdown goals, not schema.** Agents are the primary workers; the format they reason in natively wins.
- **Thin first-claim-wins, not bidding.** Bidding requires agents to reason about cost and peers' costs. Defer until it earns its complexity.
- **Ask-up hierarchical approval, not flat escalation.** Org-shaped authorization matches how humans naturally delegate and scales inbox load.
- **Git-backed extension rollback, not versioning DSL.** `git log` + `git checkout` is ~50 lines of code and gives us full history for free.

## References we drew from

- **pi-mono** — the ergonomic model: file-based extensions, hot reload, event-driven agent loop, typed tools.
- **opencode** — the persistence and operational model: daemon + client, SQLite + Drizzle + migrations, event bus, session-centric state.
- **nanoclaw** — the self-modification model: agent writes action → host approves → host executes. Our decision inbox is the direct descendant. Sub-agent spawning pattern.
- **PocketFlow** — the minimalism: async-first, tiny core, hooks everywhere.
- **crewAI** — the team-as-role-group mental model.
- **deer-flow** — skill-as-markdown-with-frontmatter pattern for loadable goals.

See REFERENCES.md for specifics.

## Success criteria for v0

- You can install on two machines in under two minutes each.
- Chat-first onboarding grows a usable Discord + GitHub integration without any manual config file editing.
- A shared bug appears and the less-loaded cell claims and resolves it, end-to-end, without human intervention.
- Total v0 codebase fits in a developer's head. Every extension is replaceable by the agent itself.
- When an agent writes a broken extension, the system recovers and tells you what happened within seconds.
- Every `[DEFERRED-]` entry in `docs/design/LOG.md` has been triaged (promoted / kept deferred with updated resurrect-when / retired) before v0 is declared shipped.
