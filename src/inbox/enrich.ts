// Decision enrichment — resolves opaque ids on a Decision row into the
// human-readable display fields both surfaces need:
//
//   inbox.list / inbox.get (CLI/TUI)   — `olle inbox`
//   mail_list (agent core tool)        — model context
//
// Lives here, not in the renderer, so both surfaces see the same
// resolution and the parallel-tool-surface rule (AGENTS.md) holds.
//
// Post-LOG 2026-04-23 collapse: every actor is an agent (the human carries
// `owns_money = 1`). One lookup against `agents`, no dual scan.

import { inArray } from "drizzle-orm";
import type { Store } from "../store/db.ts";
import { tables } from "../store/index.ts";
import type { Decision, DecisionMessage } from "../store/schema.ts";

export interface EnrichedDecision extends Decision {
  /** `agents.name` for `proposingAgentId`; falls back to the id when the
   *  agent row is gone (rare — referential integrity, but cells can
   *  be GC'd). */
  proposingAgentName: string;
  /** Display name for the owning agent (typically the human). Falls back
   *  to the raw id. Named `ownerDisplay` rather than `ownerAgentName` so
   *  CLI renderers reading the field don't need to know it's an agent. */
  ownerDisplay: string;
}

export interface EnrichedDecisionMessage extends DecisionMessage {
  /** Display name for `actorId`. Self-chosen handle wins when present;
   *  falls back to formal `agents.name`, then the raw id. */
  actorName: string;
}

export function enrichDecision(store: Store, d: Decision): EnrichedDecision {
  return enrichDecisions(store, [d])[0]!;
}

export function enrichDecisions(store: Store, ds: Decision[]): EnrichedDecision[] {
  if (ds.length === 0) return [];
  const ids = Array.from(
    new Set(ds.flatMap((d) => [d.proposingAgentId, d.ownerAgentId])),
  );
  const agentRows = store
    .select({
      id: tables.agents.id,
      name: tables.agents.name,
      displayName: tables.agents.displayName,
    })
    .from(tables.agents)
    .where(inArray(tables.agents.id, ids))
    .all();
  // Self-chosen handle wins when present — that's the social label the
  // agent actually goes by; falls back to the formal `agents.name`.
  const nameMap = new Map(
    agentRows.map((r) => [r.id, r.displayName?.trim() || r.name] as const),
  );
  return ds.map((d) => ({
    ...d,
    proposingAgentName: nameMap.get(d.proposingAgentId) ?? d.proposingAgentId,
    ownerDisplay: nameMap.get(d.ownerAgentId) ?? d.ownerAgentId,
  }));
}

/** Resolve display names for a batch of decision messages. Looks each
 *  actor_id up in `agents.name` (or `display_name` when set), falls
 *  back to the raw id. One query for the batch (no N+1). */
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
  const nameMap = new Map<string, string>();
  for (const a of agentRows) nameMap.set(a.id, a.displayName?.trim() || a.name);
  return msgs.map((m) => ({ ...m, actorName: nameMap.get(m.actorId) ?? m.actorId }));
}
