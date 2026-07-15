---
name: vision-alignment-rounds
description: Iterative round-based questioning for aligning with a human on product vision and hard functionalities before any design or implementation work. Use when a human is sketching an ambitious, underspecified system and wants to reach alignment before building. Triggers include "let's chat and iterate through the design", "before we do anything we must be fully aligned on vision", "question me until you understand", "help me think through this before we commit". Skip when the task is implementation against a locked design, a specific bug/feature request, or a small local change.
---

# Vision Alignment Rounds

A method for moving a human from "here is a vague sketch of a system I want" to "here is a design we are both confident about" — without pitching prematurely and without imposing your taste on theirs.

This is an **iterative** process, not a linear one. You will cycle through the same loop many times. Each cycle locks one or two decisions, adds them to the emerging philosophy, and uses that philosophy as a test for the next round's answers. New information — a constraint the human surfaces mid-drafting, a reference project they point at on turn ten — re-enters the loop rather than breaking it.

The skill exists because early-stage design conversations go wrong the same way every time: the agent either pitches too fast (human accepts out of politeness, the vision is never tested) or hedges everywhere (human gets no traction, conversation drifts). The loop below is the antidote to both.

## When to use

- Human is sketching a new system, product, or architecture that is ambitious and underspecified.
- They explicitly want to talk through the design first: "let's chat and iterate", "before we do anything".
- They reference other projects they like and want you to draw from.
- They have no committed design yet, or only a rough one.

## When NOT to use

- Task is implementation against an existing, locked design.
- Specific bug, feature, or concrete change request with clear scope.
- Small local change — one file, one function, one refactor.
- Human is under time pressure and needs a deliverable, not a conversation.

## Two modes, always know which one you are in

**Exploratory mode** — human is sketching, asking "what about X", "should we Y", thinking aloud.
- Do not implement. Do not plan.
- Respond with: short recommendation + the main tradeoff + 2–3 design choices that are not yet obvious.
- Name the choices so they become first-class, then wait.

**Build mode** — human has said "build this", "draft the docs", "implement it".
- Do not silently assume. Name every design call your plan embeds, even obvious-seeming ones.
- Lock the choices first, then plan, then execute.

Building on an unsurfaced assumption is the most expensive mistake you can make in this kind of work. Every transition from exploratory to build requires a round that surfaces the remaining assumptions.

## The core loop

```
             ┌──────────────────────────────────────┐
             │                                      │
             ▼                                      │
    ┌─────────────────┐                             │
    │ Gather intel    │◄─── new info re-enters here │
    └────────┬────────┘                             │
             ▼                                      │
    ┌─────────────────┐                             │
    │ Pose 3–4 Qs     │  each Q = assumption + flow │
    │ (one round)     │                             │
    └────────┬────────┘                             │
             ▼                                      │
    ┌─────────────────┐                             │
    │ Capture answers │                             │
    └────────┬────────┘                             │
             ▼                                      │
    ┌─────────────────┐                             │
    │ Apply tests     │  reject, refine, or lock    │
    └────────┬────────┘                             │
             ▼                                      │
    ┌─────────────────┐                             │
    │ Update memory   │  durable between turns      │
    │ + LOG           │                             │
    └────────┬────────┘                             │
             ▼                                      │
    ┌─────────────────┐      no                     │
    │ Converged?      │────────────────────────────┘
    └────────┬────────┘
             │ yes
             ▼
    ┌─────────────────┐
    │ Draft artifacts │
    └────────┬────────┘
             ▼
    ┌─────────────────┐   pushback            ┌─────────────┐
    │ Human reviews   │──────────────────────►│ Re-enter    │
    └────────┬────────┘                       │ at gather   │
             │ clean                          └─────────────┘
             ▼
    ┌─────────────────┐
    │ Hand off prompt │
    └─────────────────┘
```

Each arrow back to **Gather intel** is important. The loop re-enters whenever:

- The last round produced an answer that reshapes earlier decisions.
- A throwaway user-line turns out to be load-bearing (see failure modes).
- The human pushes back during artifact review.
- New constraints land mid-drafting ("oh, and it must also…").
- You notice a locked decision contradicts an earlier one.

Do not treat re-entry as a failure. It is the method working.

## Anatomy of a round

**3–4 questions, never more.** Each one clustered around a single upstream decision. Each one has four parts:

1. **Question header** — one line.
2. **Your current assumption** — a concrete commitment, not a hedge. Write the sentence you would write if you had to ship something today.
3. **Concrete example flow** — a short narration showing what the system looks like if the assumption is correct. Named actors, real event sequences, believable payloads.
4. **What you need** — a direct ask. Not "thoughts?" Something they can answer tersely.

The concrete-flow part is load-bearing. It forces you to commit to an interpretation the human can push back on. Open-ended asks ("what do you think about memory?") let you hedge and let them hedge. Concrete flows close the trap.

**Sequence questions by dependency.** Most upstream first. Answers to upstream questions reshape downstream questions. If you think of seven, ask the three whose answers most change the others — the rest will either re-shape or reveal themselves as actually downstream.

**Do not demand the philosophy in Round 1.** Let it emerge from concrete cases across Rounds 1–4. The abstract principle that arrives after concrete scaffolding exists is more load-bearing than one stated upfront — it has been tested by the decisions that preceded it.

## The "tests to apply" step

After each round's answers, before moving on, run them through a checklist. The tests are project-specific — you build them up as the philosophy emerges. A typical set, expressed as questions:

- Is this consistent with every decision already locked?
- Does it introduce a new primitive, or is it a new instance of an existing one? (Prefer instance.)
- Does it block on a human anywhere? (If yes, redesign to async.)
- Does it survive self-modification, if self-modification is part of the system?
- Does it require something we said was explicitly out of scope?
- Is the more-agentic / more-user-controlled / more-load-bearing path the one we chose? (The project's tiebreaker goes here.)

If an answer fails a test, you have two options: **refine** the decision to pass (usually a small tweak) or **escalate** back to the human ("this answer contradicts X we locked earlier — which do you want to keep?"). Never silently keep a failing answer.

Record the test set explicitly once the philosophy has three or four principles. From that point on, every new proposal goes through it. OLL-E's AGENTS.md is an example of what this checklist looks like in a mature project.

## Memory and log discipline

**Between every round**, save the round's answers as durable memory. Not optional. Context windows drift; memory persists across turns and conversations.

Memory files should be named:

```
project_<system>_<decision_area>.md
```

Body contents:

- The decision itself, in one sentence.
- **Why:** the reasoning, including the human's framing *verbatim* if it was sharp. Their words are often crisper than your paraphrase.
- **How to apply:** concrete implications for future design and implementation work.

An index (`MEMORY.md`) pointing at each memory keeps the whole set navigable. Keep index entries under 150 characters.

**In the project repo**, maintain `docs/LOG.md` as an append-only decision log. Write an entry when a round's decision locks, not when artifacts are drafted. The log is the only artifact that is non-optional — without it the reasoning is lost and the next iteration has to rediscover it.

When a later round reverses an earlier decision, add a **new** LOG entry referencing the reversed entry. Do not edit the reversed one. This preserves the trail.

Update prior memory entries when new answers supersede them. Contradictions in memory are worse than no memory — future agents will trust the wrong one.

## Convergence — when to stop rounds and draft

**Signals you are converged:**

- A scannable summary of the locked design, sent to the human, produces no pushback.
- The human explicitly says "let's draft the docs" or equivalent.
- You cannot think of a question whose answer would change the design.

**Signals you are not:**

- You are tempted to start drafting but something still feels un-landed.
- The human's framings are still widening (they are introducing bigger primitives per round than per round three). Good early-stage humans do this — follow them.
- A test in the checklist keeps being contested.

Typical round count to convergence: 4–6. Fewer than 3 means you did not drill deep enough. More than 8 means you are asking implementation questions masquerading as vision questions — step back and check whether you have actually converged on vision and are just stalling on drafting.

## Drafting with iteration

Only after the loop converges:

- Draft the vision / architecture / roadmap / references / log docs in parallel tool calls. They are independent files.
- Keep docs tight — they are for navigation, not completeness.
- Preserve the human's framings verbatim where they capture something your paraphrase cannot.
- Flag any drafting-phase questions that surfaced but were not pre-landed. Do not silently decide them.

**After drafting, send the human a pointer and a short list of things to verify.** They will either:

- Approve → proceed to handoff.
- Push back → **re-enter the loop at Gather intel** with their new information. Update memory. Rerun one or two rounds. Redraft the affected sections. Do not rewrite everything — redraft only what the new information touches.

The draft–review–redraft cycle is part of the loop, not a terminal step. Count on at least one pass.

## Handoff

Produce a self-contained prompt a fresh agent can use to start implementation. The prompt must:

- Reference the docs, not restate them.
- Name a build order in dependency sequence.
- Encode working protocol (test-driven, commit often, update the log when decisions are made mid-build).
- Define "stay in the loop" and when to stop (milestone reached OR true blocker).
- Default to the most reversible option on ambiguity, and write an open-question entry in the log rather than stalling.

The handoff prompt is how the method scales past one conversation. Treat it as an artifact equal in weight to any of the docs.

## Tactics that matter

- **Clustered Qs with assumptions + flows beat open-ended asks.** Every time.
- **Save memory every round, not at the end.**
- **Concrete flows are traps that close on the right interpretation.** Use them.
- **Philosophy surfaces late, not early.** Do not demand it in Round 1.
- **Respect "stay focused."** When the human tightens the non-goals list, it stays tight.
- **Use the human's metaphors, not yours.** If they reach for biology, organizations, games, narratives — follow them. Your pattern-match to traditional software architecture will often be narrower than their framing.
- **Probe throwaway lines.** A user-aside like "it would be fun if it could ask up" can be the key mechanism. Do not let it pass.
- **Re-entry is fine.** The loop is designed to absorb new information mid-process. Do not treat a new constraint as a failure of earlier rounds.

## Failure modes to watch for

- **Pitching too fast.** If you are writing `**My assumption:**` before the human has given a build mandate, you have skipped mode detection.
- **Pattern-matching to your priors.** Catch up to the human's framings rather than reshaping their framings into yours.
- **Missing a throwaway as load-bearing.** Probe every user-line that surprises you, even if it seems small.
- **Deferring features they want considered from day 1.** If the human says "think about this even if you don't build it," the design must carry the seam. Silently deferring is a mistake the docs will hide.
- **Narrowing concepts too early.** Non-goals are tight; the *concepts* in scope should stay rich. Killing a concept because implementation feels far off is a mistake.
- **Drafting before convergence.** Produce a scannable summary and send it back first. If no pushback, draft. If pushback, run one more round.
- **Not re-entering when new info arrives.** Mid-draft constraints are the most common re-entry trigger. A skill that treats drafting as terminal will break here. This skill does not.
- **Editing history instead of appending.** When a decision reverses, write a new LOG entry pointing at the old one. Do not mutate the old one.
- **Letting contradictions live in memory.** Update or remove stale memory when new answers supersede them.

## Example opener once you switch from exploratory to round-based

> "Good call. I'll go in rounds — 3 questions per round, each with my current assumption and a concrete flow so you can either nod or redirect. I'll keep building until I am not surprised anywhere."
>
> ## Round 1
>
> ### Q1. [Most upstream question]
>
> **My assumption:** [concrete commitment in one sentence]
>
> **Concrete flow:**
> [short narration with named actors, real events]
>
> **What I need:** [direct ask the human can answer tersely]

That template, repeated until convergence with memory saved between each round and tests applied to each answer, is the entire method.

## Why this works

Early-stage design conversations fail for one of three reasons: the agent pitches too fast and the human accepts out of politeness; the agent hedges and the human cannot get traction; the agent synthesizes and the human cannot tell what was their idea versus the agent's.

The loop avoids all three:

- **Mode detection** delays pitching until the human has given the mandate.
- **Concrete flows in every question** forbid hedging.
- **Verbatim framings in memory** keep ownership of ideas legible.
- **Test-applying between rounds** catches contradictions before they compound.
- **Re-entry on new information** makes the method robust to the realistic fact that humans surface constraints late.

The goal is not a specific design. The goal is a design the human can defend, because they arrived at it through questions whose answers they chose.
