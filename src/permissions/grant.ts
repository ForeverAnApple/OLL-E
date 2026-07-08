// grant_scope executor — closes the "approve appears to hang" gap.
//
// When a tool call is denied, the chat loop opens an ask-up proposal with
// payload.action === "grant_scope" (src/agent/chat.ts). The inbox's respond()
// flips the decision status and emits `decision.resolved` — but nothing ever
// mutated `agents.scope`, so an approved grant did nothing and the next call
// was denied again. This subscriber is the missing executor: on an approved/
// modified grant_scope resolution it merges the {tool, tier} into the target
// agent's scope, gated by the approver's own authority (you can't grant what
// you don't hold). It's the event-driven cousin of the inbox staleness sweep.
//
// denied / stale / freeform resolutions are no-ops here — they wake the
// proposer through the existing mail-wake path; there's nothing to execute.

import { eq } from "drizzle-orm";
import type { EventBus } from "../bus/index.ts";
import type { Store } from "../store/db.ts";
import { tables } from "../store/index.ts";
import type { AgentScope } from "../store/schema.ts";
import type { Tier } from "../scheduler/index.ts";
import { narrowsScope } from "./check.ts";

export interface GrantScopeExecutorOptions {
  bus: EventBus;
  store: Store;
  hostId: string;
}

export interface GrantScopeExecutor {
  stop(): void;
}

interface DecisionResolvedPayload {
  status?: string;
  ownerAgentId?: string;
  decisionId?: string;
  /** The (possibly modified) decision payload. */
  payload?: {
    action?: string;
    agentId?: string;
    tool?: string;
    tier?: Tier;
  };
}

/** Merge a granted {tool, tier} into a scope, idempotently:
 *   - lift the tool out of denyTools if it was blocked,
 *   - add it to allowTools when an allowlist is present (absent = unrestricted),
 *   - add the tier to allowTiers when a tier list is present.
 *  Applying the same grant twice yields the same scope. */
function mergeGrant(scope: AgentScope, tool: string, tier: Tier): AgentScope {
  const next: AgentScope = { ...scope };
  if (next.denyTools?.includes(tool)) {
    next.denyTools = next.denyTools.filter((t) => t !== tool);
  }
  if (next.allowTools && !next.allowTools.includes(tool)) {
    next.allowTools = [...next.allowTools, tool];
  }
  if (next.allowTiers && !next.allowTiers.includes(tier)) {
    next.allowTiers = [...next.allowTiers, tier];
  }
  return next;
}

export function installGrantScopeExecutor(opts: GrantScopeExecutorOptions): GrantScopeExecutor {
  const { bus, store, hostId } = opts;

  const unsub = bus.subscribe<DecisionResolvedPayload>("decision.resolved", (ev) => {
    const p = ev.payload;
    if (!p) return;
    if (p.status !== "approved" && p.status !== "modified") return;
    const inner = p.payload;
    if (!inner || inner.action !== "grant_scope") return;

    const targetAgentId = inner.agentId;
    const tool = inner.tool;
    const tier: Tier = inner.tier ?? "operational";
    if (typeof targetAgentId !== "string" || typeof tool !== "string" || tool.length === 0) {
      return;
    }

    const approverAgentId = p.ownerAgentId;
    const approverRow = approverAgentId
      ? store
          .select({ scope: tables.agents.scope })
          .from(tables.agents)
          .where(eq(tables.agents.id, approverAgentId))
          .all()[0]
      : undefined;
    const approverScope: AgentScope = approverRow?.scope ?? {};

    // Authority check: the approver can only grant scope it holds itself.
    const candidate: AgentScope = { allowTools: [tool], allowTiers: [tier] };
    const authority = narrowsScope(approverScope, candidate);
    if (!authority.ok) {
      bus.publish({
        type: "scope.grant-rejected",
        hostId,
        actorId: approverAgentId ?? hostId,
        durable: true,
        payload: {
          decisionId: p.decisionId,
          agentId: targetAgentId,
          tool,
          tier,
          approverAgentId,
          reason: authority.reason,
        },
      });
      return;
    }

    const targetRow = store
      .select({ scope: tables.agents.scope })
      .from(tables.agents)
      .where(eq(tables.agents.id, targetAgentId))
      .all()[0];
    if (!targetRow) {
      bus.publish({
        type: "scope.grant-rejected",
        hostId,
        actorId: approverAgentId ?? hostId,
        durable: true,
        payload: {
          decisionId: p.decisionId,
          agentId: targetAgentId,
          tool,
          tier,
          reason: `target agent ${targetAgentId} not found`,
        },
      });
      return;
    }

    const nextScope = mergeGrant(targetRow.scope ?? {}, tool, tier);
    store
      .update(tables.agents)
      .set({ scope: nextScope })
      .where(eq(tables.agents.id, targetAgentId))
      .run();

    bus.publish({
      type: "scope.granted",
      hostId,
      actorId: approverAgentId ?? hostId,
      durable: true,
      payload: {
        decisionId: p.decisionId,
        agentId: targetAgentId,
        tool,
        tier,
        approverAgentId,
        scope: nextScope,
      },
    });
  });

  return { stop: unsub };
}
