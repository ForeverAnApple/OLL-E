// Memory event types + payload shapes.
//
// Memory is a projection of the event log (LOG 2026-04-23). The three event
// kinds below are load-bearing: `memory.wrote` is upsert, `memory.forgotten`
// is tombstone, `memory.read` is audit. Federation syncs these events and
// each peer reprojects; v1+ mesh gets LWW-with-attribution for free.
//
// Payload shape guideline: self-sufficient. The projector must be able to
// apply a `memory.wrote` from a peer host without looking anything else up.

/** Memory scopes — enforced at write/read via tool dispatch (LOG 2026-04-23
 *  strictly-solo-private: private memories are readable only by their
 *  actor; team by team members; scratch by the task run's actor). */
export type MemoryScope = "private" | "team" | "scratch";

/** `memory.wrote` event — upsert by id. LWW on HLC decides who wins when
 *  two writes target the same id. The projector drops writes whose HLC is
 *  <= the existing row's HLC (stale-event protection on replay). */
export interface MemoryWrotePayload {
  /** Stable memory id. Generated on first write; subsequent writes with
   *  the same id update the row. */
  id: string;
  /** Owning actor. For cultural pass-on this is the child's id while
   *  `authoredBy` carries the parent; otherwise actor_id equals the
   *  writing actor. */
  actorId: string;
  scope: MemoryScope;
  /** For scope=private: the owning agent id. For scope=team: the team id.
   *  For scope=scratch: the task_run id. Optional so we don't force a
   *  denormalized value when scope+actor already disambiguate. */
  scopeRef?: string;
  /** Posture — free-form agent-native string. `principle` is the one
   *  blessed load-bearing role (auto-injected at turn start, auto-passed
   *  at spawn). Empty string = unset. */
  role: string;
  title: string;
  bodyMd: string;
  tags: string[];
  /** Belief weight under the resistance model (VISION: beliefs have
   *  inertia, not locks). Default 1 for lived writes; principles default
   *  to 10; pass-on bumps further. */
  depth: number;
  /** Set only when another actor wrote this on `actorId`'s behalf —
   *  cultural pass-on is the blessed case. Tool writes leave it null. */
  authoredBy?: string;
  /** For seeded memories: the source memory id on the parent. Lineage
   *  trace; live edits of the child's copy do not affect the parent row. */
  seededFrom?: string;
}

/** `memory.forgotten` event — tombstone by id. Projector deletes the row
 *  iff event HLC > existing row HLC. (Under v0 single-host bus ordering
 *  we do not need a separate tombstone table; v1+ federation with
 *  out-of-order delivery will need one — seam noted in LOG.) */
export interface MemoryForgottenPayload {
  id: string;
}

/** `memory.read` event — audit trail. Written by the `memory_read` tool
 *  and any other read path; appends to `memory_reads`. */
export interface MemoryReadPayload {
  id: string;
  readerActorId: string;
}

export const MEMORY_WROTE = "memory.wrote" as const;
export const MEMORY_FORGOTTEN = "memory.forgotten" as const;
export const MEMORY_READ = "memory.read" as const;

export type MemoryEventType =
  | typeof MEMORY_WROTE
  | typeof MEMORY_FORGOTTEN
  | typeof MEMORY_READ;

/** Weight defaults for memory writes. Role-conditioned — principles are
 *  strict by default (depth 10 vs 1 for lived writes). Cultural pass-on
 *  may override further. Callers can pass explicit depth to bypass. */
export const DEPTH_DEFAULTS: Readonly<Record<string, number>> = {
  principle: 10,
};
export const DEPTH_LIVED_DEFAULT = 1;

export function defaultDepthForRole(role: string): number {
  return DEPTH_DEFAULTS[role] ?? DEPTH_LIVED_DEFAULT;
}
