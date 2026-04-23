# AGENTS.md

Orienting doc for any agent (or human) working on OLL-E. Read this before proposing anything.

## Always loaded

@docs/design/VISION.md

@docs/design/ARCHITECTURE.md

The two docs above are auto-imported into every session. Vision is the anchor — nothing you propose should contradict it without a logged decision. Architecture names the six primitives and their relationships; new work composes from them rather than inventing alongside them.

## Read on demand

- `docs/design/ROADMAP.md` — what v0 ships and what it deliberately doesn't. Read before proposing any feature to check it isn't explicitly a non-goal.
- `docs/design/LOG.md` — the reasoning trail. Read when a prior decision is relevant; append to it when a real decision lands.
- `docs/design/REFERENCES.md` — prior art and what we took/left from each.

If a question is already answered in those files, defer to them. If you're about to contradict them, that's a decision worth logging, not a silent drift.

## The lens

OLL-E is a **world agents love to live in**, grown by its inhabitants. Every design choice descends from that. The operational restatements:

- **Humans are events.** A Discord DM, a CLI keystroke, an email, a webhook — all produce structurally identical events. No special-cased human UI, no privileged channel.
- **Nothing blocks on humans.** Agent proposes to the decision inbox, keeps working. Replies reconcile async with staleness policies.
- **The environment is modifiable by its inhabitants.** Integrations, tools, triggers, tasks, goals — all authored through the same propose → write → smoke → hot-load loop. No `olle install <thing>` shortcut.
- **Constraints feel like physics.** "My budget is low, let me ask for more" — never "the system refused me." Limits are real (cost, safety); they are not distrust of the agent.
- **Pooled compute = pooled workforce.** In v0, cells share events/memory/decisions; tasks run on whichever cell claims them. No remote code execution.
- **Tiebreaker:** when two designs both work, pick the more-agentic path — the one that gives the inhabitants more agency over their environment without endangering humans.

## Tests to apply before building anything

When a new feature lands on the table, run it through these:

1. **Transport-agnostic?** If the feature has a "human path" and a "machine path," collapse them. `olle chat` in the terminal and "olle, …" in Discord route to the *same* handler. Anything that special-cases humans is a smell.
2. **New primitive or new instance?** Prefer authoring a new **task** / **tool** / **trigger** over introducing a new primitive. The six primitives (Host, Agent, Trigger, Task, Tool, Store) are load-bearing; new ones have to earn their weight.
3. **Does this survive self-modification?** If an agent can't author this through the extension loop, it's either (a) genuinely core-bundle material and should live in the binary, or (b) a sign the loop is missing a capability. Not a reason to ship a bypass.
4. **Does it block on a human?** If yes, redesign until it doesn't. Humans reply through the inbox; agents continue other work; staleness is a first-class policy.
5. **Does it require cross-host code execution?** If yes, it's out of v0 scope. Claim the task locally or don't claim it.
6. **Does the store row carry `host_id`, `actor_id`, and HLC?** Every user-facing record must. Federation is event-log merge, not a reconciliation project.

## How to respond to exploratory asks

When the user is sketching ("what about X", "should we Y"), don't jump to implementation. Short recommendation + tradeoff + the 2–3 design choices that aren't obvious yet. Lock the choices, *then* plan. Building on an unsurfaced assumption is the expensive mistake.

When the user says "build this," plan first, name the design calls the plan embeds, then execute.

## Failure modes this lens exists to prevent

- **Special-cased human UI** ("let's just add a /approve Discord command") — collapse it into the generic inbox-reply path.
- **Synchronous human blocks** (`await askUser()`) — redesign around the async inbox with staleness.
- **Bundled convenience** ("let's ship Discord in the binary so the demo is cleaner") — the demo earns its weight by *growing* Discord through the extension loop. Bundling cheats on the ergonomics we need to prove.
- **Framework-style abstractions** (agent-facing DSLs, schema-first goals, permission languages) — agents reason in markdown and code. Structure that costs agent tokens and clarity is a loss.
- **Bidding, reputation, priority queues** — first-eligible claim wins in v0. Anything fancier requires agents to model peer cost; not worth it yet.
- **Privileged paths for the root principal** — the root is a peer in the world, not an admin console. Their inbox is a channel like any other.

## Working norms in this repo

- Log real decisions in `docs/design/LOG.md`. One short paragraph per decision, with the reasoning — not the conclusion alone.
- Don't create planning/summary docs unless asked. Work from conversation and the design files.
- `docs/design/*.md` are the source of truth for design. Code follows them; when code has to diverge, update the doc in the same change.
- Bun + TypeScript strict. SQLite + Drizzle with numbered migrations from 0001. ULID IDs. HLC timestamps. No ALTER in application code.
