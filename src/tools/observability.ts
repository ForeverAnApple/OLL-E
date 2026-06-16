// Observability core tools — agent-callable read surface for the world.
//
// Six tools, one per observability query, all wrapping src/observability/.
// The CLI commands wrap the same underlying functions (AGENTS.md vision-
// check rule: every CLI command has a parallel core tool). When an agent
// asks "what did I cost this hour?" or "what threads do I have open?"
// they go through these tools; when the human asks the same in the
// terminal, they go through `olle stats` / `olle threads`.
//
// Defaults are scoped to the calling agent (ctx.actorId) — agents read
// their own world by default. Raw event queries stay scoped too; widening
// belongs to a future authority-aware observability action, not this
// operational tool.

import type { Store } from "../store/index.ts";
import type { ToolDef } from "../extensions/types.ts";
import {
  agentSelf,
  budgetStatus,
  recentEvents,
  runHistory,
  threadInventory,
  usageStats,
  type RecentEventsFilter,
  type RunHistoryFilter,
  type ThreadInventoryFilter,
  type UsageStatsFilter,
} from "../observability/index.ts";

export interface ObservabilityToolsOptions {
  store: Store;
}

const COMMON_TIME_PROPS = {
  since: { type: "number", description: "ms-since-epoch lower bound (inclusive)." },
  until: { type: "number", description: "ms-since-epoch upper bound (inclusive)." },
} as const;

export function buildObservabilityTools(opts: ObservabilityToolsOptions): ToolDef[] {
  const { store } = opts;

  const queryUsage: ToolDef<
    {
      actorId?: string;
      threadId?: string;
      since?: number;
      until?: number;
      rowLimit?: number;
    },
    ReturnType<typeof usageStats>
  > = {
    name: "query_my_usage",
    tier: "operational",
    category: "observability",
    shortClause: "token + USD rollup over a window",
    description:
      "Token + cache spend rollup with per-model breakdown. Defaults to the calling agent over all time. USD is computed from current prices — if a model has no posted price you'll see pricePosted=false on its row, meaning the USD column is a fallback estimate. Use this to notice when your cache hit ratio is low (=> you're regenerating prefix needlessly; consider stabilizing your system prompt or moving volatile content behind the cache breakpoint).",
    inputSchema: {
      type: "object",
      properties: {
        actorId: {
          type: "string",
          description: "Agent id; defaults to caller.",
        },
        threadId: {
          type: "string",
          description: "Restrict to one thread — useful for 'did THIS conversation cache?'",
        },
        ...COMMON_TIME_PROPS,
        rowLimit: {
          type: "number",
          description: "Cap on ledger rows scanned (default 5000).",
        },
      },
      additionalProperties: false,
    },
    execute: (args, ctx) =>
      usageStats(store, {
        actorId: args.actorId ?? ctx.actorId,
        threadId: args.threadId,
        since: args.since,
        until: args.until,
        rowLimit: args.rowLimit,
      } satisfies UsageStatsFilter),
  };

  const queryBudget: ToolDef<
    { actorId?: string; period?: string },
    ReturnType<typeof budgetStatus>
  > = {
    name: "query_my_budget",
    tier: "operational",
    category: "observability",
    shortClause: "current budget cap and spend",
    description:
      "Current budget allocation: cap (USD/tokens), spent, percent consumed. Defaults to the calling agent. When percentUsd is high, propose a raise via the inbox (askUp) instead of self-rationing — budget caps are real-money constraints owned by your principal, not arbitrary throttles.",
    inputSchema: {
      type: "object",
      properties: {
        actorId: { type: "string" },
        period: {
          type: "string",
          description: "Budget period key (e.g. '2026-04' or 'all-time').",
        },
      },
      additionalProperties: false,
    },
    execute: (args, ctx) =>
      budgetStatus(store, {
        actorId: args.actorId ?? ctx.actorId,
        period: args.period,
      }),
  };

  const queryRuns: ToolDef<
    {
      actorId?: string;
      status?: "queued" | "running" | "succeeded" | "failed" | "lost";
      since?: number;
      limit?: number;
    },
    ReturnType<typeof runHistory>
  > = {
    name: "query_my_runs",
    tier: "operational",
    category: "observability",
    shortClause: "task_run history (succeeded/failed/lost)",
    description:
      "Recent task_runs (one row per scheduler dispatch). Defaults to the calling agent, ordered most-recent-first. Filter by status to find failures (status='failed') or stalled work (status='lost' = daemon restarted while running). Use this to audit your own behavior — repeated 'failed' on the same task is a signal to inspect the handler or revert the responsible extension.",
    inputSchema: {
      type: "object",
      properties: {
        actorId: { type: "string" },
        status: {
          type: "string",
          enum: ["queued", "running", "succeeded", "failed", "lost"],
        },
        since: COMMON_TIME_PROPS.since,
        limit: { type: "number", description: "Max rows (default 50)." },
      },
      additionalProperties: false,
    },
    execute: (args, ctx) =>
      runHistory(store, {
        actorId: args.actorId ?? ctx.actorId,
        status: args.status,
        since: args.since,
        limit: args.limit,
      } satisfies RunHistoryFilter),
  };

  const queryThreads: ToolDef<
    { toAgentId?: string; scan?: number; limit?: number },
    ReturnType<typeof threadInventory>
  > = {
    name: "query_my_threads",
    tier: "operational",
    category: "observability",
    shortClause: "threads addressed to your mailbox, with cache stats",
    description:
      "List threads addressed to your mailbox, ordered by most-recent activity. Each row carries that thread's cache hit ratio (computed from chat.turn-end events seen in the scan window). Complements the per-turn mailbox sidebar by surfacing durable thread data that the sidebar elides — useful before delegating, retargeting, or auditing children's work.",
    inputSchema: {
      type: "object",
      properties: {
        toAgentId: {
          type: "string",
          description: "Mailbox to inspect; defaults to caller.",
        },
        scan: {
          type: "number",
          description: "Events to scan back (default 2000, max 10000).",
        },
        limit: { type: "number", description: "Threads returned (default 50)." },
      },
      additionalProperties: false,
    },
    execute: (args, ctx) =>
      threadInventory(store, {
        toAgentId: args.toAgentId ?? ctx.actorId,
        scan: args.scan,
        limit: args.limit,
      } satisfies ThreadInventoryFilter),
  };

  const querySelf: ToolDef<
    { agentId?: string },
    ReturnType<typeof agentSelf>
  > = {
    name: "query_self",
    tier: "operational",
    category: "observability",
    shortClause: "your identity, scope, and tools",
    alwaysLoaded: true,
    description:
      "Read your own identity surface: name, parent, system prompt, scope (allowed tools/tiers), principle count, registered tools, and your thinking config. The authoritative answer to \"what model am I thinking with?\" is `thinkingModel` (and `reasoningEffort`) — the model you're configured to use; `thinkingModelIsDefault` says whether that's the host default or your own choice. Do NOT read `recentlyPricedModels` for that — it's ledger spend history (what you've recently been billed for), which lags a just-made switch. Use this to introspect before self-modifying — knowing your own current state beats guessing.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "Defaults to caller. Pass another agent id to inspect a peer/child.",
        },
      },
      additionalProperties: false,
    },
    execute: (args, ctx) => agentSelf(store, args.agentId ?? ctx.actorId),
  };

  const queryEvents: ToolDef<
    {
      actorId?: string;
      type?: string;
      threadId?: string;
      toAgentId?: string;
      since?: number;
      limit?: number;
      maxPayloadBytes?: number;
    },
    ReturnType<typeof recentEvents>
  > = {
    name: "query_events",
    tier: "operational",
    category: "observability",
    shortClause: "raw event-log query (use sparingly)",
    description:
      "Generic event-log query. All filters optional — combine actorId/type/threadId/toAgentId/since to narrow. Use sparingly: the event log is the source of truth and large reads cost tokens; prefer the specialized query_* tools when they answer your question. Each row's payload is capped to maxPayloadBytes (default 2048) — over-budget rows come back as `{ _truncated, _bytes, _preview }`. Raise the cap deliberately when you need a full body; one chat.tool-call payload can be 100KB+.",
    inputSchema: {
      type: "object",
      properties: {
        actorId: { type: "string" },
        type: { type: "string", description: "Exact event type, e.g. 'chat.turn-end'." },
        threadId: { type: "string" },
        toAgentId: { type: "string" },
        since: COMMON_TIME_PROPS.since,
        limit: { type: "number", description: "Max rows (default 100)." },
        maxPayloadBytes: {
          type: "number",
          description:
            "Per-row payload byte cap (default 2048). Rows whose serialized payload exceeds this come back truncated with a preview. Raising this directly increases context cost.",
        },
      },
      additionalProperties: false,
    },
    execute: (args, ctx) =>
      recentEvents(store, {
        actorId: scopedActor(args.actorId, ctx.actorId, "query_events"),
        type: args.type,
        threadId: args.threadId,
        toAgentId: scopedAgent(args.toAgentId, ctx.actorId, "query_events"),
        since: args.since,
        limit: args.limit,
        maxPayloadBytes: args.maxPayloadBytes ?? 2048,
      } satisfies RecentEventsFilter),
  };

  return [queryUsage, queryBudget, queryRuns, queryThreads, querySelf, queryEvents];
}

function scopedActor(requested: string | undefined, caller: string, tool: string): string {
  if (!requested) return caller;
  if (requested !== caller) {
    throw new Error(`${tool}: actorId is scoped to caller (${caller}); cross-actor reads require an approved widening action`);
  }
  return requested;
}

function scopedAgent(requested: string | undefined, caller: string, tool: string): string | undefined {
  if (!requested) return undefined;
  if (requested !== caller) {
    throw new Error(`${tool}: toAgentId is scoped to caller (${caller}); cross-mailbox reads require an approved widening action`);
  }
  return requested;
}
