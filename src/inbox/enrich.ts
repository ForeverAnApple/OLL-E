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
import type { Decision } from "../store/schema.ts";

export interface EnrichedDecision extends Decision {
  /** `agents.name` for `proposingAgentId`; falls back to the id when the
   *  agent row is gone (rare — referential integrity, but cells can
   *  be GC'd). */
  proposingAgentName: string;
  /** `principals.display` for `principalId`; falls back to id. */
  principalDisplay: string;
}

export function enrichDecision(store: Store, d: Decision): EnrichedDecision {
  return enrichDecisions(store, [d])[0]!;
}

export function enrichDecisions(store: Store, ds: Decision[]): EnrichedDecision[] {
  if (ds.length === 0) return [];
  const agentIds = Array.from(new Set(ds.map((d) => d.proposingAgentId)));
  const principalIds = Array.from(new Set(ds.map((d) => d.principalId)));
  const agentRows = store
    .select({ id: tables.agents.id, name: tables.agents.name })
    .from(tables.agents)
    .where(inArray(tables.agents.id, agentIds))
    .all();
  const principalRows = store
    .select({ id: tables.principals.id, display: tables.principals.display })
    .from(tables.principals)
    .where(inArray(tables.principals.id, principalIds))
    .all();
  const agentMap = new Map(agentRows.map((r) => [r.id, r.name]));
  const principalMap = new Map(principalRows.map((r) => [r.id, r.display]));
  return ds.map((d) => ({
    ...d,
    proposingAgentName: agentMap.get(d.proposingAgentId) ?? d.proposingAgentId,
    principalDisplay: principalMap.get(d.principalId) ?? d.principalId,
  }));
}
