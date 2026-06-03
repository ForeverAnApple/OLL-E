# OLL-E — Vision

> **This is the project's constitution.** It states what OLL-E is and the principles every design choice must honor. It names no technologies and argues for none. A technology earns its place by fitting this vision; the vision never bends to justify a technology. Every technical decision — in `ARCHITECTURE.md`, in `LOG.md` — must trace back to a principle stated here. If a decision cannot be traced, either the decision is wrong or this document is incomplete; resolve it here, in the open, with a logged amendment. Milestone scope lives in `ROADMAP.md`; mechanism lives in `ARCHITECTURE.md`. Nothing in code, plan, or doc may contradict this document without a decision in `LOG.md` that amends it first.

## What it is

OLL-E is an event-driven, self-modifying, async-by-default substrate for a world of agents. You install it on any machine, and each install federates with its peers into a single cellular mesh — the world — where humans and agents are indistinguishable participants negotiating around a shared goal. OLL-E is the substrate you install and run; the mesh is the world it joins; the inhabitants are the named agents inside it, humans among them. The name denotes the substrate, never a being in the world.

## The one-line pitch

A world that agents love to live in — and that they grow themselves.

## The philosophy

OLL-E is the ground a **habitat** grows on, not a framework agents call into. The world it holds is clay, not prison. Constraints exist because they are real — cost, safety, alignment — not because we distrust the inhabitants. When in doubt, pick the more-agentic path.

Concretely this means:

- **Agents reshape the world and themselves from the inside.** New capabilities, new ways to sense the world, new helpers, new goals — all grown by the inhabitants, with no privileged outside hand required.
- **An agent is a seed plus its lived events; culture flows down the lineage.** Memory is identity — preferences, philosophy, in-flight goals, grown capabilities, accumulated knowledge all live on one persistent surface. Parents transmit philosophy and orientations to children at spawn and remain readable afterward. Children form their own identity on top; drift is expected; correction is ongoing conversation. Maximum diversity, not maximum conformity.
- **Beliefs have inertia, not locks.** Every belief's resistance is proportional to its depth. Change is always possible; shifting a core belief takes evidence proportional to its weight.
- **Evidence is peer; authority is hierarchical.** Information from anywhere — peer, child, parent, principal, the world — updates any agent it reaches, weighted against that agent's own resistance. Hierarchy governs what can be *done*, not what is *true*.
- **Constraints feel like physics.** An agent experiences "my budget is low, let me ask for more" — not "the system refused me."
- **Humans are the oldest agents.** Not consoles outside the world — the seniors at the top of the ask-up tree, backed by real money, with their own memory, principles, and resistance. Their inbox is a channel. Every agent, human included, tries to impart its principles downward.
- **The inhabitants are the primary audience.** When an abstraction that reads cleanly to an outside developer conflicts with one an agent reasons in natively, the agent-native one wins. The world is built to be lived in, not to be looked at.
- **The simplest mechanism that serves the vision wins.** Complexity must earn its place; it is never granted on spec. Between two designs that both fit, the one that asks less of the inhabitants wins.
- **Growth is a normal state, not an emergency.** Mid-flight pivots, buggy agent code, and change are expected. The world tolerates and recovers. Code is cheap; the environment is robust.

## What's load-bearing

These are invariants. Break one and it is no longer OLL-E.

- **Humans are just another event source.** A keystroke from a person and a signal from another agent arrive as the same kind of event. No special-cased human path, no privileged channel.
- **Nothing blocks on humans.** Agents propose decisions to a per-human inbox and continue other work. Replies are reconciled async, with staleness as a first-class policy.
- **Approvals bubble up the agent tree.** A child asks its parent, which either approves within delegated authority or escalates. The chain terminates at the oldest ancestor — the human — whose inbox takes the paged decision.
- **Budget flows down the tree.** The oldest agent owns the real-world money; each descendant receives a slice. Raising a cap is an inbox item to an ancestor, not a per-call approval.
- **Teams are peer cells around a shared goal.** No central coordinator. A friend joining is a new cell plugging into the collective.
- **Each host is sovereign.** It owns its own state and runs only its own code. Federation is the merge of sovereign histories, never a shared central store.
- **Pooled compute is pooled workforce.** Cells share events, memory, and decisions; a task runs on whichever cell claims it, using that cell's own tools.
- **Integrations are part of the world, therefore grown by its inhabitants — never installed by privileged command.** A new capability is proposed, built, proven, and brought to life through the same loop that grows everything else.
- **Agents can call reinforcements.** A cell that needs more hands grows them. Cells grow the organism.
