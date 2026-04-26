// Decision inbox — per-principal queue of items requiring a human decision.
//
// Agents never block on the inbox; they propose() and continue. When a
// principal responds via respond(), we emit decision.resolved events that
// the original task can match against to resume.
//
// Staleness: each proposal carries a wall-clock deadline. sweepStale()
// marks expired items as stale and fires decision.resolved with status
// "stale" so the originating task's on_stale policy can run.

import type { EventBus } from "../bus/index.ts";
import type { Store } from "../store/db.ts";
import { tables } from "../store/index.ts";
import type { Decision } from "../store/schema.ts";
import { ulid } from "../id/index.ts";
import type { Tier } from "../scheduler/index.ts";
import { and, desc, eq, inArray, like, lt } from "drizzle-orm";

export type DecisionStatus = "open" | "approved" | "denied" | "modified" | "stale";
export type Vote = "approve" | "deny" | "modify";

export interface Proposal {
  principalId: string;
  proposingAgentId: string;
  tier: Tier;
  summary: string;
  payload: Record<string, unknown>;
  /** How long (ms from now) before the decision is auto-marked stale. */
  stalenessMs?: number;
  rollbackPlan?: string;
  quorumRequired?: boolean;
}

export interface RespondInput {
  decisionId: string;
  actorId: string;
  vote: Vote;
  message?: string;
  /** For modify votes: the replacement payload. */
  payloadOverride?: Record<string, unknown>;
}

export interface Inbox {
  propose(p: Proposal): { id: string; deadlineAt?: number };
  listOpen(principalId: string): Decision[];
  /** All decisions for a principal, regardless of status, newest first.
   *  Backs `olle inbox --all` and audit reads. */
  listAll(principalId: string, limit?: number): Decision[];
  get(id: string): Decision | undefined;
  /** Resolve a full id or unique prefix to a Decision. Returns undefined
   *  when nothing matches; throws when the prefix is ambiguous. The CLI
   *  shows truncated ids, so callers commonly pass a prefix. */
  resolve(idOrPrefix: string): Decision | undefined;
  respond(input: RespondInput): Decision;
  sweepStale(nowMs?: number): number;
}

export interface InboxOptions {
  bus: EventBus;
  store: Store;
  hostId: string;
}

export function createInbox(opts: InboxOptions): Inbox {
  const { bus, store, hostId } = opts;

  function propose(p: Proposal): { id: string; deadlineAt?: number } {
    const id = ulid();
    const now = Date.now();
    const deadlineAt = p.stalenessMs != null ? now + p.stalenessMs : undefined;
    store
      .insert(tables.decisions)
      .values({
        id,
        principalId: p.principalId,
        proposingAgentId: p.proposingAgentId,
        tier: p.tier,
        summary: p.summary,
        payload: p.payload,
        status: "open",
        staleness: deadlineAt,
        quorumRequired: p.quorumRequired ?? false,
        createdAt: now,
      })
      .run();

    bus.publish({
      type: "decision.proposed",
      hostId,
      actorId: p.proposingAgentId,
      durable: true,
      payload: {
        decisionId: id,
        principalId: p.principalId,
        proposingAgentId: p.proposingAgentId,
        tier: p.tier,
        summary: p.summary,
        deadlineAt,
      },
    });

    return { id, deadlineAt };
  }

  function listOpen(principalId: string): Decision[] {
    return store
      .select()
      .from(tables.decisions)
      .where(
        and(eq(tables.decisions.principalId, principalId), eq(tables.decisions.status, "open")),
      )
      .all();
  }

  function listAll(principalId: string, limit = 100): Decision[] {
    return store
      .select()
      .from(tables.decisions)
      .where(eq(tables.decisions.principalId, principalId))
      .orderBy(desc(tables.decisions.createdAt))
      .limit(limit)
      .all();
  }

  function get(id: string): Decision | undefined {
    const rows = store.select().from(tables.decisions).where(eq(tables.decisions.id, id)).all();
    return rows[0];
  }

  function resolve(idOrPrefix: string): Decision | undefined {
    // Cheap path: exact match. Avoids a LIKE scan when callers already
    // hand over the full ULID (agents typically do; CLI users rarely).
    const exact = get(idOrPrefix);
    if (exact) return exact;
    // ULIDs are 26 chars Crockford base32; anything longer can't match.
    if (idOrPrefix.length === 0 || idOrPrefix.length >= 26) return undefined;
    const matches = store
      .select()
      .from(tables.decisions)
      .where(like(tables.decisions.id, `${idOrPrefix}%`))
      .limit(2)
      .all();
    if (matches.length === 0) return undefined;
    if (matches.length > 1) {
      throw new Error(`inbox: prefix ${idOrPrefix} is ambiguous (matches multiple decisions)`);
    }
    return matches[0];
  }

  function respond(input: RespondInput): Decision {
    const d = get(input.decisionId);
    if (!d) throw new Error(`inbox: decision ${input.decisionId} not found`);
    if (d.status !== "open") throw new Error(`inbox: decision ${d.id} already ${d.status}`);

    const now = Date.now();
    const nextStatus: DecisionStatus =
      input.vote === "approve" ? "approved" : input.vote === "deny" ? "denied" : "modified";

    store
      .insert(tables.approvals)
      .values({
        decisionId: d.id,
        actorId: input.actorId,
        vote: input.vote,
        message: input.message,
        at: now,
      })
      .run();

    const nextPayload = input.vote === "modify" && input.payloadOverride ? input.payloadOverride : d.payload;

    store
      .update(tables.decisions)
      .set({
        status: nextStatus,
        payload: nextPayload,
        resolvedAt: now,
      })
      .where(eq(tables.decisions.id, d.id))
      .run();

    bus.publish({
      type: "decision.resolved",
      hostId,
      actorId: input.actorId,
      durable: true,
      payload: {
        decisionId: d.id,
        principalId: d.principalId,
        proposingAgentId: d.proposingAgentId,
        status: nextStatus,
        vote: input.vote,
        message: input.message,
        payload: nextPayload,
      },
    });

    return { ...d, status: nextStatus, payload: nextPayload, resolvedAt: now };
  }

  function sweepStale(nowMs: number = Date.now()): number {
    const open = store
      .select()
      .from(tables.decisions)
      .where(
        and(
          eq(tables.decisions.status, "open"),
          lt(tables.decisions.staleness, nowMs),
        ),
      )
      .all();
    if (open.length === 0) return 0;
    const ids = open.map((d) => d.id);
    store
      .update(tables.decisions)
      .set({ status: "stale", resolvedAt: nowMs })
      .where(inArray(tables.decisions.id, ids))
      .run();
    for (const d of open) {
      bus.publish({
        type: "decision.resolved",
        hostId,
        actorId: "system",
        durable: true,
        payload: {
          decisionId: d.id,
          principalId: d.principalId,
          proposingAgentId: d.proposingAgentId,
          status: "stale",
          vote: null,
        },
      });
    }
    return ids.length;
  }

  return { propose, listOpen, listAll, get, resolve, respond, sweepStale };
}
