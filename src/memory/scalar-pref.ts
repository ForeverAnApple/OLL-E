// Scalar-preference memory — a single canonical private memory row per
// (agent, role) whose first body line is the value and the rest is the
// justification. thinking-model and reasoning-effort are both instances:
// each is one knob the agent sets about itself, persisted as identity,
// resolved at loop start (see [[model.ts]] / [[reasoning.ts]] / LOG 2026-06-08).
//
// The shape is deliberately tiny so a third such knob is a few lines, not a
// fourth copy of the same query/publish boilerplate.

import { and, desc, eq } from "drizzle-orm";
import type { EventBus } from "../bus/index.ts";
import type { Store } from "../store/db.ts";
import { tables } from "../store/index.ts";
import { MEMORY_WROTE } from "./events.ts";
import { ulid } from "../id/index.ts";

/** The raw value (first body line) of the agent's newest memory for this
 *  role, or undefined if none. Callers validate the value themselves; a
 *  malformed value means "use the default," never a crash. */
export function resolveScalarPref(
  store: Store,
  agentId: string,
  role: string,
): string | undefined {
  const row = store
    .select({ bodyMd: tables.memories.bodyMd })
    .from(tables.memories)
    .where(
      and(
        eq(tables.memories.actorId, agentId),
        eq(tables.memories.scope, "private"),
        eq(tables.memories.role, role),
      ),
    )
    .orderBy(desc(tables.memories.updatedAt))
    .limit(1)
    .all()[0];
  return row?.bodyMd.split("\n", 1)[0]?.trim() || undefined;
}

/** The id of the agent's existing memory for this role, if any. The set
 *  tools reuse it (update) so the knob stays one canonical row. */
export function findScalarPrefId(
  store: Store,
  agentId: string,
  role: string,
): string | undefined {
  return store
    .select({ id: tables.memories.id })
    .from(tables.memories)
    .where(
      and(
        eq(tables.memories.actorId, agentId),
        eq(tables.memories.scope, "private"),
        eq(tables.memories.role, role),
      ),
    )
    .orderBy(desc(tables.memories.updatedAt))
    .limit(1)
    .all()[0]?.id;
}

/** Publish a scalar-preference write: body line 1 = value, the rest = reason.
 *  Reuses the agent's canonical row for the role so identity stays one memory;
 *  every change's justification survives in the memory.wrote event log. */
export function writeScalarPref(args: {
  bus: EventBus;
  store: Store;
  hostId: string;
  actorId: string;
  role: string;
  title: string;
  tag: string;
  value: string;
  reason: string;
}): void {
  const id = findScalarPrefId(args.store, args.actorId, args.role) ?? ulid();
  args.bus.publish({
    type: MEMORY_WROTE,
    hostId: args.hostId,
    actorId: args.actorId,
    durable: true,
    payload: {
      id,
      actorId: args.actorId,
      scope: "private",
      scopeRef: args.actorId,
      role: args.role,
      title: args.title,
      bodyMd: `${args.value}\n\n${args.reason}`,
      tags: [args.tag],
      depth: 1,
      authoredBy: null,
      seededFrom: null,
    },
  });
}
