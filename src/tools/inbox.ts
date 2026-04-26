// Mailbox tools — agent-facing surface for the decision inbox.
//
// `mail_list` is in the always-loaded core (per ARCHITECTURE.md): every
// strategic turn typically wants to know whether replies are waiting before
// committing to the next action. `mail_respond` is deferred — agents only
// reach for it when they intend to vote on a peer/child's proposal.
//
// Both tools resolve the addressee to the host's single principal in v0
// (LOG 2026-04-25). When the principals→agents collapse from 2026-04-23
// lands, the lookup becomes "decisions addressed to me as agent" without
// changing the surface. The CLI (`olle inbox`) reads the same Inbox and
// returns the same rows — parallel-tool-surface rule.

import type { ToolDef } from "../extensions/types.ts";
import { enrichDecisions, type EnrichedDecision, type Inbox, type UserVote } from "../inbox/index.ts";
import type { Decision } from "../store/schema.ts";
import type { Store } from "../store/db.ts";

export interface InboxToolsOptions {
  inbox: Inbox;
  /** The host's principal id. v0 is single-principal so every agent on
   *  this host reads/responds against the same inbox. */
  principalId: string;
  /** Store handle for resolving agent/principal display names on read.
   *  Optional so existing tests that pass `{ inbox, principalId }` still
   *  compile; the agent surface degrades to raw ids when omitted. */
  store?: Store;
}

export function buildInboxTools(opts: InboxToolsOptions): ToolDef[] {
  const { inbox, principalId, store } = opts;

  const list: ToolDef<{ includeResolved?: boolean; limit?: number }, EnrichedDecision[] | Decision[]> = {
    name: "mail_list",
    tier: "operational",
    category: "mailbox",
    alwaysLoaded: true,
    shortClause: "open decisions awaiting your principal's response",
    description:
      "List decisions on the inbox. Default: open items only — proposals waiting for the principal (or you, when you're delegated authority) to vote. Pass includeResolved=true to see recently-resolved entries (audit / debugging). Use this between strategic turns: a delayed reply may have landed since you last looked.",
    inputSchema: {
      type: "object",
      properties: {
        includeResolved: {
          type: "boolean",
          description: "When true, include decisions in any status (default: open only).",
        },
        limit: {
          type: "number",
          description: "Cap on rows returned when includeResolved=true (default 50).",
        },
      },
      additionalProperties: false,
    },
    execute: (args) => {
      const rows = args.includeResolved
        ? inbox.listAll(principalId, args.limit ?? 50)
        : inbox.listOpen(principalId);
      return store ? enrichDecisions(store, rows) : rows;
    },
  };

  const respond: ToolDef<
    {
      id: string;
      vote: UserVote;
      message?: string;
      payloadOverride?: Record<string, unknown>;
    },
    Decision
  > = {
    name: "mail_respond",
    tier: "strategic",
    category: "mailbox",
    shortClause: "vote on a decision (approve/deny/modify)",
    description:
      "Resolve an open decision. Vote=approve lets the proposing task resume with its original payload; deny drops the action; modify swaps in payloadOverride before approval (use to amend tokens, scope, or any field the proposer left mutable). The vote is durable and emits decision.resolved so the originating task can match against it. Strategic tier — voting on someone else's proposal is itself a world-changing act.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Decision id (full ULID)." },
        vote: { type: "string", enum: ["approve", "deny", "modify"] },
        message: {
          type: "string",
          description: "Optional comment recorded on the approval row.",
        },
        payloadOverride: {
          type: "object",
          description: "Required when vote=modify; ignored otherwise.",
          additionalProperties: true,
        },
      },
      required: ["id", "vote"],
      additionalProperties: false,
    },
    execute: (args, ctx) => {
      if (args.vote === "modify" && !args.payloadOverride) {
        throw new Error("mail_respond: vote=modify requires payloadOverride");
      }
      return inbox.respond({
        decisionId: args.id,
        actorId: ctx.actorId,
        vote: args.vote,
        message: args.message,
        payloadOverride: args.payloadOverride,
      });
    },
  };

  return [list, respond];
}
