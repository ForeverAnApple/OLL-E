// Decision enrichment — resolves opaque ids on a Decision row into the
// human-readable display fields both surfaces need:
//
//   inbox.list / inbox.get (CLI/TUI)   — `olle inbox`
//   mail_list (agent core tool)        — model context
//
// Lives here, not in the renderer, so both surfaces see the same
// resolution and the parallel-tool-surface rule (AGENTS.md) holds.

import { inArray } from "drizzle-orm";
import type { Store } from "../store/db.ts";
import { tables } from "../store/index.ts";
import type { Decision, DecisionMessage } from "../store/schema.ts";

export interface EnrichedDecision extends Decision {
  /** `agents.name` for `proposingAgentId`; falls back to the id when the
   *  agent row is gone (rare — referential integrity, but cells can
   *  be GC'd). */
  proposingAgentName: string;
  /** `principals.display` for `principalId`; falls back to id. */
  principalDisplay: string;
}

export interface EnrichedDecisionMessage extends DecisionMessage {
  /** Display name for `actorId`. Looks up `agents.name` first, then
   *  `principals.display`, falls back to the raw id. The CLI/TUI use
   *  this so the inbox view shows "root" instead of a 26-char ULID. */
  actorName: string;
}

export function enrichDecision(store: Store, d: Decision): EnrichedDecision {
  return enrichDecisions(store, [d])[0]!;
}

export function enrichDecisions(store: Store, ds: Decision[]): EnrichedDecision[] {
  if (ds.length === 0) return [];
  const agentIds = Array.from(new Set(ds.map((d) => d.proposingAgentId)));
  const principalIds = Array.from(new Set(ds.map((d) => d.principalId)));
  const agentRows = store
    .select({
      id: tables.agents.id,
      name: tables.agents.name,
      displayName: tables.agents.displayName,
    })
    .from(tables.agents)
    .where(inArray(tables.agents.id, agentIds))
    .all();
  const principalRows = store
    .select({ id: tables.principals.id, display: tables.principals.display })
    .from(tables.principals)
    .where(inArray(tables.principals.id, principalIds))
    .all();
  // Self-chosen handle wins when present — that's the social label the
  // agent actually goes by; falls back to the formal `agents.name`.
  const agentMap = new Map(
    agentRows.map((r) => [r.id, r.displayName?.trim() || r.name] as const),
  );
  const principalMap = new Map(principalRows.map((r) => [r.id, r.display]));
  return ds.map((d) => ({
    ...d,
    proposingAgentName: agentMap.get(d.proposingAgentId) ?? d.proposingAgentId,
    principalDisplay: principalMap.get(d.principalId) ?? d.principalId,
  }));
}

/** Resolve display names for a batch of decision messages. Looks each
 *  actor_id up in `agents.name`, then `principals.display`, then falls
 *  back to the raw id. One pair of queries for the batch (no N+1). */
export function enrichDecisionMessages<T extends DecisionMessage>(
  store: Store,
  msgs: T[],
): Array<T & { actorName: string }> {
  if (msgs.length === 0) return [];
  const ids = Array.from(new Set(msgs.map((m) => m.actorId)));
  const agentRows = store
    .select({
      id: tables.agents.id,
      name: tables.agents.name,
      displayName: tables.agents.displayName,
    })
    .from(tables.agents)
    .where(inArray(tables.agents.id, ids))
    .all();
  const principalRows = store
    .select({ id: tables.principals.id, display: tables.principals.display })
    .from(tables.principals)
    .where(inArray(tables.principals.id, ids))
    .all();
  const nameMap = new Map<string, string>();
  for (const p of principalRows) nameMap.set(p.id, p.display);
  // Agent name wins on conflict — agents are the more common authors and
  // `principals` is collapsing into `agents` long-term anyway (LOG 2026-04-23).
  // Within agents, self-chosen handle wins over formal name.
  for (const a of agentRows) nameMap.set(a.id, a.displayName?.trim() || a.name);
  return msgs.map((m) => ({ ...m, actorName: nameMap.get(m.actorId) ?? m.actorId }));
}
