// Principle rendering — the SOUL pattern adapted from openclaw.
//
// Per LOG 2026-04-23 "memory is identity" + "every agent tries to impart
// its principles downward", `role=principle` memories are load-bearing:
// they are the agent's strict commitments. We render them into the
// system prompt at every turn instead of leaving them to be retrieved —
// this is what makes them *strict* rather than just weighty.
//
// Rendering contract:
//  - Load the agent's own `role=principle` memories (scope=private).
//  - Sort by depth DESC then id ASC so prompt-cache keys stay stable.
//  - Render as a titled block; skip when the agent holds no principles
//    (fresh root with no lived principles yet — see LOG: no synthetic
//    core-bundle seeds, principles accrue through living).
//
// Not read from here:
//  - team memories (even with role=principle). Team memory is peer
//    evidence, not self-identity. Agents can memory_search for it.
//  - ancestor principles. Those are available via memory_lineage —
//    deliberate retrieval, not always-on injection. Preserves strictly-
//    solo private: we never peek up the tree without the agent asking.

import { and, asc, desc, eq } from "drizzle-orm";
import type { Store } from "../store/db.ts";
import { tables } from "../store/index.ts";

export interface PrincipleRow {
  id: string;
  title: string;
  bodyMd: string;
  depth: number;
  seededFrom: string | null;
  authoredBy: string | null;
}

export function loadPrinciples(store: Store, agentId: string): PrincipleRow[] {
  const rows = store
    .select({
      id: tables.memories.id,
      title: tables.memories.title,
      bodyMd: tables.memories.bodyMd,
      depth: tables.memories.depth,
      seededFrom: tables.memories.seededFrom,
      authoredBy: tables.memories.authoredBy,
    })
    .from(tables.memories)
    .where(
      and(
        eq(tables.memories.actorId, agentId),
        eq(tables.memories.scope, "private"),
        eq(tables.memories.role, "principle"),
      ),
    )
    .orderBy(desc(tables.memories.depth), asc(tables.memories.id))
    .all();
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    bodyMd: r.bodyMd,
    depth: r.depth,
    seededFrom: r.seededFrom ?? null,
    authoredBy: r.authoredBy ?? null,
  }));
}

/** Render principles as a prompt block. Returns null when the agent
 *  holds no principles — caller appends nothing in that case. Format is
 *  stable so prompt caches stay warm across turns when nothing changed. */
export function renderPrinciples(rows: PrincipleRow[]): string | null {
  if (rows.length === 0) return null;
  const lines: string[] = ["Your principles — strict, non-negotiable:"];
  for (const r of rows) {
    // Title as the handle; body as the substance. Seed/depth cues kept
    // terse — agent can memory_read for the full record.
    const seed = r.seededFrom ? " (inherited)" : "";
    lines.push(`- ${r.title}${seed}: ${r.bodyMd}`);
  }
  return lines.join("\n");
}
