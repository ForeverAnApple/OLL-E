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
import type { Decision, DecisionMessage } from "../store/schema.ts";
import { ulid } from "../id/index.ts";
import type { Tier } from "../scheduler/index.ts";
import { and, asc, desc, eq, inArray, like, lt } from "drizzle-orm";

export type DecisionStatus = "open" | "approved" | "denied" | "modified" | "stale";
// `stale` is a system-emitted vote — `sweepStale` writes it on auto-expiry.
// Subscribers handle it explicitly rather than learning a new event type.
// User-driven `respond()` is restricted to UserVote; the wider Vote shows up
// only on the resolved-event payload.
export type UserVote = "approve" | "deny" | "modify";
export type Vote = UserVote | "stale";

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
  vote: UserVote;
  message?: string;
  /** For modify votes: the replacement payload. */
  payloadOverride?: Record<string, unknown>;
}

export interface ReplyInput {
  decisionId: string;
  actorId: string;
  text: string;
}

export interface Inbox {
  propose(p: Proposal): { id: string; deadlineAt?: number };
  listOpen(principalId: string): Decision[];
  /** All decisions for a principal, regardless of status, newest first.
   *  Backs `olle inbox --all` and audit reads. */
  listAll(principalId: string, limit?: number): Decision[];
  /** Decisions proposed by this actor, newest first. Backs `mail_list`'s
   *  outgoing direction so a proposer can see "did my asks get answered?"
   *  Default skips resolved rows (status='open' only) so the agent's
   *  attention lands on what's still pending; pass includeResolved=true
   *  to include resolved/stale entries (for audit / catching missed
   *  replies on restart). */
  listProposedBy(actorId: string, opts?: { includeResolved?: boolean; limit?: number }): Decision[];
  get(id: string): Decision | undefined;
  /** Resolve a full id or unique prefix to a Decision. Returns undefined
   *  when nothing matches; throws when the prefix is ambiguous. The CLI
   *  shows truncated ids, so callers commonly pass a prefix. */
  resolve(idOrPrefix: string): Decision | undefined;
  respond(input: RespondInput): Decision;
  /** Append a non-vote message into a decision's conversation thread.
   *  Used by `mail_reply` for "FYI done" / "blocked because X" follow-
   *  ups after a decision resolves (or, occasionally, while still open
   *  to add context). Emits `decision.replied` for bridges + observers. */
  reply(input: ReplyInput): DecisionMessage;
  /** All follow-up messages on a decision, oldest first. Renders inline
   *  with the proposal + approvals in `olle inbox show <id>` and the
   *  agent's `mail_list` enrichment. */
  listMessages(decisionId: string): DecisionMessage[];
  /** Mark every reply on a decision as read by `readerActorId`. Idempotent.
   *  Returns the count of messages newly marked (rows that already had a
   *  read entry are not re-counted). Backs the auto-mark-on-view UX. */
  markDecisionRead(decisionId: string, readerActorId: string): number;
  /** Per-decision unread reply counts for a single reader. Used to render
   *  the "(N new)" badge on `olle inbox` listings without N+1 queries. */
  unreadCountsByDecision(
    decisionIds: string[],
    readerActorId: string,
  ): Map<string, number>;
  /** For a single decision, return the set of message ids the reader has
   *  already seen. Lets `inbox.show` render `[NEW]` on previously-unread
   *  messages while still auto-marking-read on the same call. */
  readMessageIdsFor(decisionId: string, readerActorId: string): Set<string>;
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

  function listProposedBy(
    actorId: string,
    opts: { includeResolved?: boolean; limit?: number } = {},
  ): Decision[] {
    const { includeResolved = false, limit = 100 } = opts;
    const where = includeResolved
      ? eq(tables.decisions.proposingAgentId, actorId)
      : and(
          eq(tables.decisions.proposingAgentId, actorId),
          eq(tables.decisions.status, "open"),
        );
    return store
      .select()
      .from(tables.decisions)
      .where(where)
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

  function reply(input: ReplyInput): DecisionMessage {
    if (!input.text || typeof input.text !== "string") {
      throw new Error("inbox: reply text is required");
    }
    const d = get(input.decisionId);
    if (!d) throw new Error(`inbox: decision ${input.decisionId} not found`);
    const id = ulid();
    const now = Date.now();
    const row: DecisionMessage = {
      id,
      decisionId: d.id,
      hostId,
      actorId: input.actorId,
      text: input.text,
      at: now,
    };
    store.insert(tables.decisionMessages).values(row).run();
    bus.publish({
      type: "decision.replied",
      hostId,
      actorId: input.actorId,
      durable: true,
      payload: {
        decisionId: d.id,
        replyId: id,
        principalId: d.principalId,
        proposingAgentId: d.proposingAgentId,
        // Truncate in the event payload — full text lives in the row.
        // Bridges that want display content should query the row.
        textPreview: input.text.length > 200 ? `${input.text.slice(0, 197)}...` : input.text,
        textLength: input.text.length,
      },
    });
    return row;
  }

  function listMessages(decisionId: string): DecisionMessage[] {
    return store
      .select()
      .from(tables.decisionMessages)
      .where(eq(tables.decisionMessages.decisionId, decisionId))
      .orderBy(asc(tables.decisionMessages.at))
      .all();
  }

  function markDecisionRead(decisionId: string, readerActorId: string): number {
    const messages = store
      .select({ id: tables.decisionMessages.id })
      .from(tables.decisionMessages)
      .where(eq(tables.decisionMessages.decisionId, decisionId))
      .all();
    if (messages.length === 0) return 0;
    const already = readMessageIdsFor(decisionId, readerActorId);
    const now = Date.now();
    let added = 0;
    for (const m of messages) {
      if (already.has(m.id)) continue;
      store
        .insert(tables.decisionMessageReads)
        .values({ messageId: m.id, readerActorId, at: now })
        .onConflictDoNothing()
        .run();
      added += 1;
    }
    return added;
  }

  function readMessageIdsFor(decisionId: string, readerActorId: string): Set<string> {
    // Inner join: messages on this decision that have a read row for this reader.
    const rows = store
      .select({ id: tables.decisionMessages.id })
      .from(tables.decisionMessages)
      .innerJoin(
        tables.decisionMessageReads,
        eq(tables.decisionMessageReads.messageId, tables.decisionMessages.id),
      )
      .where(
        and(
          eq(tables.decisionMessages.decisionId, decisionId),
          eq(tables.decisionMessageReads.readerActorId, readerActorId),
        ),
      )
      .all();
    return new Set(rows.map((r) => r.id));
  }

  function unreadCountsByDecision(
    decisionIds: string[],
    readerActorId: string,
  ): Map<string, number> {
    const out = new Map<string, number>();
    if (decisionIds.length === 0) return out;
    // Fetch all messages for the given decisions, plus this reader's reads,
    // then bucket. Two queries beats N+1 and the rows are bounded.
    const messages = store
      .select({
        id: tables.decisionMessages.id,
        decisionId: tables.decisionMessages.decisionId,
      })
      .from(tables.decisionMessages)
      .where(inArray(tables.decisionMessages.decisionId, decisionIds))
      .all();
    if (messages.length === 0) {
      for (const d of decisionIds) out.set(d, 0);
      return out;
    }
    const messageIds = messages.map((m) => m.id);
    const reads = store
      .select({ messageId: tables.decisionMessageReads.messageId })
      .from(tables.decisionMessageReads)
      .where(
        and(
          inArray(tables.decisionMessageReads.messageId, messageIds),
          eq(tables.decisionMessageReads.readerActorId, readerActorId),
        ),
      )
      .all();
    const readSet = new Set(reads.map((r) => r.messageId));
    for (const d of decisionIds) out.set(d, 0);
    for (const m of messages) {
      if (readSet.has(m.id)) continue;
      out.set(m.decisionId, (out.get(m.decisionId) ?? 0) + 1);
    }
    return out;
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
          vote: "stale",
        },
      });
    }
    return ids.length;
  }

  return {
    propose,
    listOpen,
    listAll,
    listProposedBy,
    get,
    resolve,
    respond,
    reply,
    listMessages,
    markDecisionRead,
    readMessageIdsFor,
    unreadCountsByDecision,
    sweepStale,
  };
}
