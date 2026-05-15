// Ask-up hierarchical approval.
//
// Walks the parent_agent_id chain from the proposing agent up. At each
// level, if the agent has declared delegated_authority covering the tier
// (and the action, by tag), it may auto-approve; otherwise it forwards
// up. When we reach an agent with no parent (the human, by collapse —
// LOG 2026-04-23), we post to that agent's decision inbox: one
// recursion end-to-end, no terminal "now we hit a principal" branch.
//
// v0 simplification:
//  - delegated_authority is read from agents.scope.allowTiers[]. If the
//    tier is listed, the parent auto-approves operationally. Otherwise
//    it escalates. Richer policy (per-tag allowlists, rate caps, etc.)
//    is a v1+ concern.
//  - "Auto-approve" in v0 just skips the inbox and emits the resolved
//    event directly — the v1+ implementation will stamp the approving
//    agent as the resolver.

import { eq } from "drizzle-orm";
import type { EventBus } from "../bus/index.ts";
import type { Store } from "../store/db.ts";
import { tables } from "../store/index.ts";
import type { AgentScope } from "../store/schema.ts";
import type { Tier } from "../scheduler/index.ts";
import type { Inbox, Proposal } from "./inbox.ts";

export interface AskUpInput {
  proposingAgentId: string;
  ownerAgentId: string;
  tier: Tier;
  summary: string;
  payload: Record<string, unknown>;
  stalenessMs?: number;
  rollbackPlan?: string;
}

export interface AskUpResult {
  kind: "auto-approved" | "queued";
  decisionId?: string;
  approverAgentId?: string;
}

export interface AskUpOptions {
  bus: EventBus;
  store: Store;
  hostId: string;
  inbox: Inbox;
}

export function askUp(opts: AskUpOptions, input: AskUpInput): AskUpResult {
  let currentAgentId: string | null = input.proposingAgentId;
  // Walk up; the proposer itself never self-approves, so start from parent.
  const firstAgent = fetchAgent(opts.store, currentAgentId);
  if (!firstAgent) throw new Error(`askUp: agent ${currentAgentId} not found`);
  currentAgentId = firstAgent.parentAgentId ?? null;

  while (currentAgentId) {
    const a = fetchAgent(opts.store, currentAgentId);
    if (!a) break;
    // owns_money agents are inbox endpoints, not delegates. Reaching one
    // means the chain ran out of intermediate authority; queue to their
    // inbox instead of treating their allowTiers as auto-approval scope.
    // Their tiers list says "I am authorized to do this myself," not
    // "I delegate this tier to descendants."
    if (a.ownsMoney) break;
    const allowed: Tier[] = (a.scope as AgentScope).allowTiers ?? [];
    if (allowed.includes(input.tier)) {
      opts.bus.publish({
        type: "decision.auto-approved",
        hostId: opts.hostId,
        actorId: a.id,
        durable: true,
        payload: {
          approverAgentId: a.id,
          proposingAgentId: input.proposingAgentId,
          tier: input.tier,
          summary: input.summary,
          payload: input.payload,
        },
      });
      return { kind: "auto-approved", approverAgentId: a.id };
    }
    currentAgentId = a.parentAgentId ?? null;
  }

  // Reached the top of the chain without a delegation hit. Post to the
  // owning agent's inbox (typically the human — owns_money=1, parent=null).
  const proposal: Proposal = {
    ownerAgentId: input.ownerAgentId,
    proposingAgentId: input.proposingAgentId,
    tier: input.tier,
    summary: input.summary,
    payload: input.payload,
    stalenessMs: input.stalenessMs,
    rollbackPlan: input.rollbackPlan,
  };
  const { id } = opts.inbox.propose(proposal);
  return { kind: "queued", decisionId: id };
}

function fetchAgent(store: Store, id: string) {
  const rows = store.select().from(tables.agents).where(eq(tables.agents.id, id)).all();
  return rows[0];
}
