// Mailbox tools — agent-facing surface for the decision inbox.
//
// `mail_list` is in the always-loaded core (per ARCHITECTURE.md): every
// strategic turn typically wants to know whether replies are waiting before
// committing to the next action. `mail_respond` is deferred — agents only
// reach for it when they intend to vote on a peer/child's proposal.
// `mail_propose` is also deferred — agents reach for it only when they
// intend to open an ask up the chain (LOG 2026-04-26).
//
// All three resolve the addressee to the host's single principal in v0
// (LOG 2026-04-25). When the principals→agents collapse from 2026-04-23
// lands, the lookup becomes "decisions addressed to me as agent" without
// changing the surface. The CLI (`olle inbox`) reads the same Inbox and
// returns the same rows — parallel-tool-surface rule.

import type { ToolDef } from "../extensions/types.ts";
import {
  askUp,
  enrichDecisions,
  type AskUpResult,
  type EnrichedDecision,
  type Inbox,
  type UserVote,
} from "../inbox/index.ts";
import type { EventBus } from "../bus/index.ts";
import type { Decision, DecisionMessage } from "../store/schema.ts";
import type { Store } from "../store/db.ts";
import type { Tier } from "../scheduler/index.ts";

export interface InboxToolsOptions {
  inbox: Inbox;
  /** The host's principal id. v0 is single-principal so every agent on
   *  this host reads/responds against the same inbox. */
  principalId: string;
  /** Event bus — required for `mail_propose` to run askUp (emits
   *  decision.proposed / decision.auto-approved). Omit to skip
   *  registering `mail_propose`. */
  bus?: EventBus;
  /** Host id, stamped on inbox events emitted by `mail_propose`. Same
   *  registration rule as `bus`. */
  hostId?: string;
  /** Store handle for resolving agent/principal display names on read,
   *  walking the ancestor chain for askUp, and writing decision rows.
   *  Optional so existing tests that pass `{ inbox, principalId }` still
   *  compile; the agent surface degrades to raw ids when omitted, and
   *  `mail_propose` is omitted entirely (it requires the trio). */
  store?: Store;
}

export type MailDirection = "in" | "out" | "both";

export function buildInboxTools(opts: InboxToolsOptions): ToolDef[] {
  const { inbox, principalId, bus, hostId, store } = opts;

  const list: ToolDef<
    { direction?: MailDirection; includeResolved?: boolean; limit?: number },
    EnrichedDecision[] | Decision[]
  > = {
    name: "mail_list",
    tier: "operational",
    category: "mailbox",
    alwaysLoaded: true,
    shortClause: "open decisions awaiting your principal's response",
    description:
      "List decisions on the inbox. direction='in' (default) returns proposals addressed to your principal — what you would vote on. direction='out' returns proposals YOU made that haven't been resolved yet — use this between turns to check whether your asks got an answer. direction='both' returns the union, deduped by id. Default scope is open-only; pass includeResolved=true for audit / catching missed replies. Use this between strategic turns: a delayed reply may have landed since you last looked.",
    inputSchema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["in", "out", "both"],
          description:
            "'in' = decisions addressed to my principal (default); 'out' = decisions I proposed; 'both' = union deduped.",
        },
        includeResolved: {
          type: "boolean",
          description: "When true, include decisions in any status (default: open only).",
        },
        limit: {
          type: "number",
          description: "Cap on rows returned (default 50 for resolved-included, 100 for 'out').",
        },
      },
      additionalProperties: false,
    },
    execute: (args, ctx) => {
      const direction: MailDirection = args.direction ?? "in";
      const includeResolved = args.includeResolved ?? false;
      // 'in' resolves against the host's single principal in v0; the
      // tool's view of "my inbox" is whoever's inbox the daemon hooked
      // this build to. Post-collapse this resolves to ctx.actorId.
      const incoming =
        direction === "in" || direction === "both"
          ? includeResolved
            ? inbox.listAll(principalId, args.limit ?? 50)
            : inbox.listOpen(principalId)
          : [];
      const outgoing =
        direction === "out" || direction === "both"
          ? inbox.listProposedBy(ctx.actorId, {
              includeResolved,
              limit: args.limit ?? 100,
            })
          : [];
      const merged = direction === "both" ? dedupeById([...incoming, ...outgoing]) : direction === "in" ? incoming : outgoing;
      return store ? enrichDecisions(store, merged) : merged;
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

  const reply: ToolDef<{ decisionId: string; text: string }, DecisionMessage> = {
    name: "mail_reply",
    tier: "operational",
    category: "mailbox",
    shortClause: "post a follow-up message into a decision's thread",
    description:
      "Append a non-vote message into the conversation thread on an existing decision. Use this AFTER a proposal you filed gets resolved (approved/denied/modified) to close the loop with the principal: report what you did with the approved payload, post the commit/PR/result, or explain a blocker if execution couldn't complete. The principal sees these inline with `olle inbox show <id>` and via bridges. Operational tier — the strategic cost was paid when the proposal was opened; replies are the cheap close-loop primitive that keeps the principal informed without a new approval. Convention: be concise (2–6 lines); link to artifacts (commits, files, events) rather than pasting them. If you blocked, say what's blocking and what you'd need.",
    inputSchema: {
      type: "object",
      properties: {
        decisionId: {
          type: "string",
          description: "Full decision ULID (the same id you got from mail_propose).",
        },
        text: {
          type: "string",
          description:
            "Message body. Plain text or markdown. Keep it tight — the principal scans these.",
        },
      },
      required: ["decisionId", "text"],
      additionalProperties: false,
    },
    execute: (args, ctx) => {
      const target = inbox.resolve(args.decisionId);
      if (!target) throw new Error(`mail_reply: decision ${args.decisionId} not found`);
      if (target.proposingAgentId !== ctx.actorId) {
        throw new Error(
          `mail_reply: actor ${ctx.actorId} cannot reply to decision ${target.id}; only the proposing agent can reply`,
        );
      }
      return inbox.reply({
        decisionId: target.id,
        actorId: ctx.actorId,
        text: args.text,
      });
    },
  };

  const tools: ToolDef[] = [list, respond, reply];

  // mail_propose needs bus + store + hostId (askUp emits events, walks the
  // ancestor chain, and stamps origin). Skip the tool when any of the trio
  // is missing rather than ship a half-working surface; the daemon always
  // wires all three, and unit tests that build the tool surface without
  // them are testing list/respond and don't need propose.
  if (store && bus && hostId) {
    const propose: ToolDef<
      {
        summary: string;
        payload?: Record<string, unknown>;
        tier?: Tier;
        stalenessMs?: number;
        rollbackPlan?: string;
      },
      AskUpResult
    > = {
      name: "mail_propose",
      tier: "strategic",
      category: "mailbox",
      shortClause: "open an ask up the ancestor chain (askUp protocol)",
      description:
        "Open an ask up the ancestor chain. Runs the same askUp protocol that fires when a tool call is denied: walks parent → ... → root → principal; the first ancestor whose delegated authority covers `tier` auto-approves; otherwise the proposal lands on the principal's decision inbox. Returns {kind: 'auto-approved' | 'queued', decisionId?, approverAgentId?} — a 'queued' result means the principal will see this in `olle inbox` (or whatever channel they wired); a 'auto-approved' result means an ancestor resolved it without human involvement. You do not block on the reply: when it arrives, decision.resolved fires and your loop wakes; check `mail_list({direction:'out', includeResolved:true})` to read the answer. Strategic tier — initiating a proposal is itself a world-changing act, and the principal pays attention cost.",
      inputSchema: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description:
              "One short line for the inbox row — what's being asked, in the principal's reading voice.",
          },
          payload: {
            type: "object",
            description:
              "Arbitrary JSON payload describing the ask. Convention: include an `action` field naming what you want (e.g. 'grant_scope', 'install_extension', 'raise_budget'). Approved payloads are returned verbatim on decision.resolved so your follow-up turn can match on it.",
            additionalProperties: true,
          },
          tier: {
            type: "string",
            enum: ["operational", "strategic", "vision"],
            description:
              "Significance tier — drives the askUp walk. Default 'strategic' (most common case). 'vision' rewrites mission/budget; 'operational' is rarely worth proposing (just do it within scope).",
          },
          stalenessMs: {
            type: "number",
            description:
              "Wall-clock ms before the proposal is auto-resolved with vote='stale' (your on_stale logic runs). Omit for no deadline. Recommended for time-sensitive asks so the system doesn't hold a permanent open item.",
          },
          rollbackPlan: {
            type: "string",
            description:
              "Optional human-readable note describing how to undo the action if approved-and-regretted. Surfaces on the principal's view of the row.",
          },
        },
        required: ["summary"],
        additionalProperties: false,
      },
      execute: (args, ctx) => {
        return askUp(
          { bus, store, hostId, inbox },
          {
            proposingAgentId: ctx.actorId,
            principalId,
            tier: args.tier ?? "strategic",
            summary: args.summary,
            payload: args.payload ?? {},
            stalenessMs: args.stalenessMs,
            rollbackPlan: args.rollbackPlan,
          },
        );
      },
    };
    tools.push(propose);
  }

  return tools;
}

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}
