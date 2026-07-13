// Observability — the shared query layer used by both agent-facing core
// tools (src/tools/observability.ts) and the human-facing CLI commands
// (src/cli/run.ts). Every CLI command has a parallel core tool wrapping
// the same query function (AGENTS.md vision-check rule, LOG 2026-04-24):
// no privileged human read surface; principal's CLI is just the human's
// tool surface.
//
// All functions are pure-ish: they read the store and return shaped data,
// no event publishing, no side effects. Callers format/render.
//
// Threads are first-class. Anywhere we surface "recent activity" we
// expose threadId so per-conversation cache and run history stays
// queryable as one unit.

import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Store } from "../store/db.ts";
import { tables } from "../store/index.ts";
import type { AgentScope } from "../store/schema.ts";
import { hasPostedPrice, lookupPrice, priceTokens } from "../llm/pricing.ts";
import { ANTHROPIC_DEFAULT_MODEL } from "../llm/index.ts";
import { resolveBootModel, resolveReasoningEffort } from "../memory/index.ts";

// -------- usageStats --------

export interface UsageStatsFilter {
  /** Restrict to one actor (agent id). Omit for everyone the caller can see. */
  actorId?: string;
  /** Restrict to one thread. */
  threadId?: string;
  /** ms-since-epoch lower bound (inclusive). */
  since?: number;
  /** ms-since-epoch upper bound (inclusive). */
  until?: number;
  /** Cap on rows scanned for the by-model breakdown. Default 5000. */
  rowLimit?: number;
}

export interface UsageStatsRow {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  /** Computed via priceTokens at the rate in effect at each row's timestamp. */
  usdMicros: number;
  /** Cache_read / (cache_read + input). 0 when nothing cached. */
  cacheHitRatio: number;
}

export interface UsageStatsByModel extends UsageStatsRow {
  provider: string;
  model: string;
  calls: number;
  /** True if this model has a posted price; false means usdMicros is from FALLBACK. */
  pricePosted: boolean;
}

export interface UsageStats {
  totals: UsageStatsRow;
  byModel: UsageStatsByModel[];
  /** Window the data was scoped to. Echoes filter for callers' formatting. */
  window: { since?: number; until?: number };
  /** Total ledger rows that contributed to the totals. */
  rows: number;
}

export function usageStats(store: Store, filter: UsageStatsFilter = {}): UsageStats {
  const conds = buildLedgerConds(filter);
  const limit = filter.rowLimit ?? 5000;
  const rows = store
    .select({
      provider: tables.ledger.provider,
      model: tables.ledger.model,
      inputTokens: tables.ledger.inputTokens,
      outputTokens: tables.ledger.outputTokens,
      cacheReadTokens: tables.ledger.cacheReadTokens,
      cacheCreationTokens: tables.ledger.cacheCreationTokens,
      at: tables.ledger.at,
    })
    .from(tables.ledger)
    .where(conds)
    .orderBy(desc(tables.ledger.at))
    .limit(limit)
    .all();

  // Group by (provider, model) for the breakdown; fold totals as we go.
  const groupKey = (p: string, m: string) => `${p}\u001f${m}`;
  const groups = new Map<
    string,
    {
      provider: string;
      model: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheCreation: number;
      usdMicros: number;
      calls: number;
    }
  >();
  let tIn = 0;
  let tOut = 0;
  let tCacheR = 0;
  let tCacheC = 0;
  for (const r of rows) {
    tIn += r.inputTokens;
    tOut += r.outputTokens;
    tCacheR += r.cacheReadTokens;
    tCacheC += r.cacheCreationTokens;
    // Priced PER ROW at the rate in effect at the row's timestamp (LOG
    // 2026-07-09, effective-dated prices) — pricing the group sum at one
    // rate would re-value history whenever a provider changes a rate.
    const rowUsd = priceTokens(
      r.provider,
      r.model,
      {
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadInputTokens: r.cacheReadTokens,
        cacheCreationInputTokens: r.cacheCreationTokens,
      },
      r.at,
    );
    const k = groupKey(r.provider, r.model);
    const g = groups.get(k);
    if (g) {
      g.input += r.inputTokens;
      g.output += r.outputTokens;
      g.cacheRead += r.cacheReadTokens;
      g.cacheCreation += r.cacheCreationTokens;
      g.usdMicros += rowUsd;
      g.calls += 1;
    } else {
      groups.set(k, {
        provider: r.provider,
        model: r.model,
        input: r.inputTokens,
        output: r.outputTokens,
        cacheRead: r.cacheReadTokens,
        cacheCreation: r.cacheCreationTokens,
        usdMicros: rowUsd,
        calls: 1,
      });
    }
  }

  const totals: UsageStatsRow = {
    inputTokens: tIn,
    outputTokens: tOut,
    cacheReadTokens: tCacheR,
    cacheCreationTokens: tCacheC,
    totalTokens: tIn + tOut + tCacheR + tCacheC,
    usdMicros: 0, // filled below by summing per-model
    cacheHitRatio: cacheHitRatio(tIn, tCacheR),
  };

  const byModel: UsageStatsByModel[] = [];
  for (const g of groups.values()) {
    const usd = g.usdMicros;
    totals.usdMicros += usd;
    byModel.push({
      provider: g.provider,
      model: g.model,
      inputTokens: g.input,
      outputTokens: g.output,
      cacheReadTokens: g.cacheRead,
      cacheCreationTokens: g.cacheCreation,
      totalTokens: g.input + g.output + g.cacheRead + g.cacheCreation,
      usdMicros: usd,
      cacheHitRatio: cacheHitRatio(g.input, g.cacheRead),
      calls: g.calls,
      pricePosted: hasPostedPrice(g.provider, g.model),
    });
  }
  byModel.sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    totals,
    byModel,
    window: { since: filter.since, until: filter.until },
    rows: rows.length,
  };
}

function cacheHitRatio(input: number, cacheRead: number): number {
  const denom = input + cacheRead;
  return denom === 0 ? 0 : cacheRead / denom;
}

function buildLedgerConds(filter: UsageStatsFilter) {
  const parts = [];
  if (filter.actorId) parts.push(eq(tables.ledger.actorId, filter.actorId));
  if (filter.threadId) parts.push(eq(tables.ledger.threadId, filter.threadId));
  if (filter.since != null) parts.push(gte(tables.ledger.at, filter.since));
  if (filter.until != null) parts.push(lte(tables.ledger.at, filter.until));
  return parts.length === 0 ? undefined : and(...parts);
}

// -------- budgetStatus --------

export interface BudgetRow {
  id: string;
  ownerAgentId: string;
  agentId: string | null;
  period: string;
  capUsd: number | null;
  capTokens: number | null;
  spentUsd: number;
  spentTokens: number;
  /** spentUsd / capUsd, capped at 1.0; null when no cap. */
  percentUsd: number | null;
  /** spentTokens / capTokens, capped at 1.0; null when no cap. */
  percentTokens: number | null;
}

export interface BudgetStatus {
  rows: BudgetRow[];
}

export function budgetStatus(
  store: Store,
  filter: { actorId?: string; period?: string } = {},
): BudgetStatus {
  const parts = [];
  if (filter.actorId) parts.push(eq(tables.budgets.agentId, filter.actorId));
  if (filter.period) parts.push(eq(tables.budgets.period, filter.period));
  const where = parts.length ? and(...parts) : undefined;
  const rows = store.select().from(tables.budgets).where(where).all();
  return {
    rows: rows.map((b) => ({
      id: b.id,
      ownerAgentId: b.ownerAgentId,
      agentId: b.agentId,
      period: b.period,
      capUsd: b.capUsd,
      capTokens: b.capTokens,
      spentUsd: b.spentUsd,
      spentTokens: b.spentTokens,
      percentUsd: b.capUsd && b.capUsd > 0 ? Math.min(1, b.spentUsd / b.capUsd) : null,
      percentTokens:
        b.capTokens && b.capTokens > 0 ? Math.min(1, b.spentTokens / b.capTokens) : null,
    })),
  };
}

// -------- runHistory --------

export interface RunHistoryFilter {
  actorId?: string;
  status?: "queued" | "running" | "succeeded" | "failed" | "lost";
  since?: number;
  limit?: number;
}

export interface RunHistoryRow {
  id: string;
  taskId: string;
  agentId: string;
  hostId: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  /** ms; null when run is still going. */
  durationMs: number | null;
  error: string | null;
}

export function runHistory(store: Store, filter: RunHistoryFilter = {}): RunHistoryRow[] {
  const parts = [];
  if (filter.actorId) parts.push(eq(tables.taskRuns.agentId, filter.actorId));
  if (filter.status) parts.push(eq(tables.taskRuns.status, filter.status));
  if (filter.since != null) parts.push(gte(tables.taskRuns.startedAt, filter.since));
  const where = parts.length ? and(...parts) : undefined;
  const rows = store
    .select()
    .from(tables.taskRuns)
    .where(where)
    .orderBy(desc(tables.taskRuns.startedAt))
    .limit(filter.limit ?? 50)
    .all();
  return rows.map((r) => ({
    id: r.id,
    taskId: r.taskId,
    agentId: r.agentId,
    hostId: r.hostId,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    durationMs: r.endedAt ? r.endedAt - r.startedAt : null,
    error: r.error,
  }));
}

// -------- threadInventory --------

export interface ThreadInventoryFilter {
  /** Restrict to threads addressed to one agent's mailbox. */
  toAgentId?: string;
  /** Cap on rows scanned. Default 2000 most-recent events. */
  scan?: number;
  /** Cap on threads returned. Default 50. */
  limit?: number;
}

export interface ThreadInventoryRow {
  threadId: string;
  /** The most recent toAgentId we saw on this thread; useful when threads
   *  get retargeted mid-conversation. */
  toAgentId: string | null;
  events: number;
  /** Number of completed turns (chat.turn-end events) on this thread —
   *  the human-meaningful "how long is this conversation" count. */
  turns: number;
  /** Prompt size of the MOST RECENT turn (input + cache read + cache
   *  creation tokens) — the full context the model last had to read, i.e.
   *  "how much information is in this conversation right now". NOT a sum
   *  across turns: each turn re-sends the whole history, so summing would
   *  inflate quadratically and measure re-reading, not size. 0 if no turn
   *  completed in the scan window. */
  contextTokens: number;
  lastHlc: string;
  lastEventAt: number;
  lastType: string;
  /** First (oldest) real user message on the thread, for the status snippet
   *  label. Null when the thread has no user text in the scan window. */
  firstUserText: string | null;
  /** Latest cache-hit ratio computed from any chat.turn-end events seen
   *  on this thread within the scan window. 0 when none observed.
   *  chat.turn-end is the durable per-turn record; chat.usage is the
   *  transient per-call stream and is intentionally not persisted, so it
   *  isn't a source for thread inventory rollups. */
  cacheHitRatio: number;
}

interface MailEventRow {
  hlc: string;
  type: string;
  toAgentId: string | null;
  threadId: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
}

export function threadInventory(
  store: Store,
  filter: ThreadInventoryFilter = {},
): ThreadInventoryRow[] {
  const scan = Math.min(filter.scan ?? 2000, 10_000);
  const parts = [sql`${tables.events.threadId} IS NOT NULL`];
  if (filter.toAgentId) parts.push(eq(tables.events.toAgentId, filter.toAgentId));
  const rows = store
    .select({
      hlc: tables.events.hlc,
      type: tables.events.type,
      toAgentId: tables.events.toAgentId,
      threadId: tables.events.threadId,
      payload: tables.events.payload,
      createdAt: tables.events.createdAt,
    })
    .from(tables.events)
    .where(and(...parts))
    .orderBy(desc(tables.events.hlc))
    .limit(scan)
    .all() as MailEventRow[];

  // Fold by threadId, in HLC-descending order so the first row we see
  // for a thread is its most recent activity.
  const byThread = new Map<
    string,
    {
      threadId: string;
      toAgentId: string | null;
      events: number;
      turns: number;
      contextTokens: number;
      lastHlc: string;
      lastEventAt: number;
      lastType: string;
      firstUserText: string | null;
      cacheRead: number;
      input: number;
    }
  >();
  for (const r of rows) {
    const tid = r.threadId;
    if (!tid) continue;
    let g = byThread.get(tid);
    if (!g) {
      g = {
        threadId: tid,
        toAgentId: r.toAgentId,
        events: 0,
        turns: 0,
        contextTokens: 0,
        lastHlc: r.hlc,
        lastEventAt: r.createdAt,
        lastType: r.type,
        firstUserText: null,
        cacheRead: 0,
        input: 0,
      };
      byThread.set(tid, g);
    }
    g.events += 1;
    if (r.type === "chat.turn-end") {
      const p = r.payload;
      // Rows are HLC-descending, so the first turn-end we see (turns still 0)
      // is the MOST RECENT — snapshot its prompt size as the live context.
      if (g.turns === 0) {
        g.contextTokens =
          numField(p, "inputTokens") +
          numField(p, "cacheReadTokens") +
          numField(p, "cacheCreationTokens");
      }
      g.turns += 1;
      g.cacheRead += numField(p, "cacheReadTokens");
      g.input += numField(p, "inputTokens");
    }
    // Rows arrive HLC-descending, so overwriting on every real user message
    // leaves firstUserText holding the OLDEST one — the conversation opener,
    // which is what the status snippet shows. Skip synthetic mail-wake inputs.
    if (r.type === "chat.input") {
      const p = r.payload;
      if (!boolField(p, "mailWake")) {
        const txt = strField(p, "text");
        if (txt) g.firstUserText = txt;
      }
    }
  }

  const out: ThreadInventoryRow[] = [];
  for (const g of byThread.values()) {
    out.push({
      threadId: g.threadId,
      toAgentId: g.toAgentId,
      events: g.events,
      turns: g.turns,
      contextTokens: g.contextTokens,
      lastHlc: g.lastHlc,
      lastEventAt: g.lastEventAt,
      lastType: g.lastType,
      firstUserText: g.firstUserText,
      cacheHitRatio: cacheHitRatio(g.input, g.cacheRead),
    });
  }
  out.sort((a, b) => (a.lastHlc < b.lastHlc ? 1 : -1));
  const limit = filter.limit ?? 50;
  return out.slice(0, limit);
}

function numField(p: Record<string, unknown>, k: string): number {
  const v = p[k];
  return typeof v === "number" ? v : 0;
}

function strField(p: Record<string, unknown>, k: string): string | null {
  const v = p[k];
  return typeof v === "string" ? v : null;
}

function boolField(p: Record<string, unknown>, k: string): boolean {
  return p[k] === true;
}

// -------- agentSelf --------

export interface AgentSelfTool {
  name: string;
  extensionId: string | null;
}

export interface AgentSelf {
  agentId: string;
  name: string;
  /** Self-chosen handle the agent uses when introducing itself. Cache
   *  of the most recent `role=display-name` private memory body
   *  (maintained by the memory projector). Null when the agent
   *  hasn't named themselves yet — callers fall back to `name`. */
  displayName: string | null;
  hostId: string;
  parentAgentId: string | null;
  systemPrompt: string | null;
  scope: AgentScope;
  /** Number of role=principle private memories. The bodies live in
   *  memory queries; we just say "you have N principles" here. */
  principleCount: number;
  /** Tool rows registered to this agent in the store. Extension-loaded
   *  tools register here at extension load time. */
  tools: AgentSelfTool[];
  /** Pricing: shows whether this agent has any model with a posted
   *  price recently; helps the agent know if its USD numbers are real
   *  or fallback. */
  recentlyPricedModels: Array<{ provider: string; model: string; pricePosted: boolean }>;
  /** The model this agent thinks in — its self-chosen `role=thinking-model`
   *  memory, or the host default when it hasn't chosen. Reports the
   *  configured choice, not whatever the ledger last billed. */
  thinkingModel: string;
  /** True when no explicit choice is set and `thinkingModel` is the host
   *  default rather than a deliberate selection. */
  thinkingModelIsDefault: boolean;
  /** How hard this agent thinks — its `role=reasoning-effort` memory, or
   *  "off" when unset. */
  reasoningEffort: string;
}

export function agentSelf(
  store: Store,
  agentId: string,
  opts?: {
    /** The model the live backend will actually run for this agent (daemon's
     *  effective-model resolution: chosen clamped to the backend, else the
     *  backend default). When absent — pure-store callers, tests — the
     *  Anthropic default remains the fall-through, but any daemon-wired
     *  surface should pass this so thinkingModel never names a model the
     *  backend can't serve. */
    effectiveModel?: string;
  },
): AgentSelf | null {
  const arows = store
    .select()
    .from(tables.agents)
    .where(eq(tables.agents.id, agentId))
    .all();
  if (arows.length === 0) return null;
  const a = arows[0]!;

  const principleRows = store
    .select({ c: sql<number>`COUNT(*)` })
    .from(tables.memories)
    .where(
      and(
        eq(tables.memories.actorId, agentId),
        eq(tables.memories.scope, "private"),
        eq(tables.memories.role, "principle"),
      ),
    )
    .all();
  const principleCount = Number(principleRows[0]?.c ?? 0);

  const toolRows = store
    .select({ name: tables.tools.name, extensionId: tables.tools.extensionId })
    .from(tables.tools)
    .where(eq(tables.tools.agentId, agentId))
    .all();

  const recentModels = store
    .select({ provider: tables.ledger.provider, model: tables.ledger.model })
    .from(tables.ledger)
    .where(eq(tables.ledger.actorId, agentId))
    .orderBy(desc(tables.ledger.at))
    .limit(50)
    .all();
  const seen = new Set<string>();
  const recentlyPricedModels: AgentSelf["recentlyPricedModels"] = [];
  for (const r of recentModels) {
    const key = `${r.provider}\u001f${r.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Touch lookupPrice to force pricing import to be exercised; the
    // hasPostedPrice call is the actual data we surface.
    void lookupPrice(r.provider, r.model);
    recentlyPricedModels.push({
      provider: r.provider,
      model: r.model,
      pricePosted: hasPostedPrice(r.provider, r.model),
    });
  }

  // The agent's self-chosen model + effort (private memories), reported as
  // the configured choice rather than ledger history. The caller-supplied
  // effective model wins: it is the daemon's resolution of what the live
  // backend actually runs (chosen model clamped to loaded adapters, else
  // the backend's default) — without it an OpenAI-only or CLI-brain host
  // would report the hardcoded Anthropic default here, the statusbar lie.
  const chosenModel = resolveBootModel(store, agentId);
  const thinkingModel = opts?.effectiveModel ?? chosenModel ?? ANTHROPIC_DEFAULT_MODEL;
  // "Default" = the agent's own choice is not what runs — either it never
  // chose, or its choice was clamped away by the backend.
  const thinkingModelIsDefault = chosenModel === undefined || thinkingModel !== chosenModel;
  const reasoningEffort = resolveReasoningEffort(store, agentId, thinkingModel) ?? "off";

  return {
    agentId: a.id,
    name: a.name,
    displayName: a.displayName ?? null,
    hostId: a.hostId,
    parentAgentId: a.parentAgentId,
    systemPrompt: a.systemPrompt,
    scope: (a.scope as AgentScope) ?? {},
    principleCount,
    tools: toolRows.map((t) => ({ name: t.name, extensionId: t.extensionId })),
    recentlyPricedModels,
    thinkingModel,
    thinkingModelIsDefault,
    reasoningEffort,
  };
}

// -------- teamRoster --------

export interface TeamRosterMember {
  actorId: string;
  role: string;
  joinedAt: number;
}

export interface TeamRosterPeer {
  peerHostId: string;
  addr: string;
  status: string;
  lastHeartbeatAt: number | null;
  lastReceivedEventId: string | null;
}

export interface TeamRosterRow {
  teamId: string;
  name: string;
  members: TeamRosterMember[];
  peers: TeamRosterPeer[];
}

export interface TeamRoster {
  teams: TeamRosterRow[];
}

/** Every team this host is a member of, with member roster + peer
 *  connectivity. Shared between the agent's team_status tool and the
 *  human's `olle status` dashboard — single source of truth so both
 *  surfaces see the same numbers (AGENTS.md vision-check). */
export function teamRoster(store: Store): TeamRoster {
  const teamRows = store.select().from(tables.teams).all();
  const teams: TeamRosterRow[] = [];
  for (const t of teamRows) {
    const members = store
      .select()
      .from(tables.teamMembers)
      .where(eq(tables.teamMembers.teamId, t.id))
      .all();
    const peers = store
      .select()
      .from(tables.teamPeers)
      .where(eq(tables.teamPeers.teamId, t.id))
      .all();
    teams.push({
      teamId: t.id,
      name: t.name,
      members: members.map((m) => ({
        actorId: m.actorId,
        role: m.role,
        joinedAt: m.joinedAt,
      })),
      peers: peers.map((p) => ({
        peerHostId: p.peerHostId,
        addr: p.addr,
        status: p.status,
        lastHeartbeatAt: p.lastHeartbeatAt,
        lastReceivedEventId: p.lastReceivedEventId,
      })),
    });
  }
  return { teams };
}

// -------- recentEvents --------

export interface RecentEventsFilter {
  actorId?: string;
  type?: string;
  threadId?: string;
  toAgentId?: string;
  /** ms-since-epoch lower bound. */
  since?: number;
  limit?: number;
  /** Per-row payload byte cap. Rows whose serialized payload exceeds this are
   *  replaced with `{ _truncated, _bytes, _preview }`. Omit for full payloads.
   *  The store is unaffected — truncation is read-shaping for callers paying
   *  per-token (agents). */
  maxPayloadBytes?: number;
}

/** Either the original payload or a truncated marker. The marker preserves
 *  the byte count and a leading slice so callers can triage without paying
 *  the full cost. */
export type RecentEventPayload =
  | Record<string, unknown>
  | { _truncated: true; _bytes: number; _preview: string };

export interface RecentEventRow {
  id: string;
  hlc: string;
  type: string;
  actorId: string;
  toAgentId: string | null;
  threadId: string | null;
  parentEventId: string | null;
  createdAt: number;
  payload: RecentEventPayload;
}

function shapePayload(
  raw: Record<string, unknown>,
  maxBytes: number | undefined,
): RecentEventPayload {
  if (maxBytes == null) return raw;
  const json = JSON.stringify(raw);
  if (json.length <= maxBytes) return raw;
  // Preview = ~80% of budget so the wrapper fields fit under the cap too.
  const previewLen = Math.max(0, Math.floor(maxBytes * 0.8));
  return {
    _truncated: true,
    _bytes: json.length,
    _preview: json.slice(0, previewLen),
  };
}

export function recentEvents(
  store: Store,
  filter: RecentEventsFilter = {},
): RecentEventRow[] {
  const parts = [];
  if (filter.actorId) parts.push(eq(tables.events.actorId, filter.actorId));
  if (filter.type) parts.push(eq(tables.events.type, filter.type));
  if (filter.threadId) parts.push(eq(tables.events.threadId, filter.threadId));
  if (filter.toAgentId) parts.push(eq(tables.events.toAgentId, filter.toAgentId));
  if (filter.since != null) parts.push(gte(tables.events.createdAt, filter.since));
  const where = parts.length ? and(...parts) : undefined;
  const rows = store
    .select()
    .from(tables.events)
    .where(where)
    .orderBy(desc(tables.events.hlc))
    .limit(filter.limit ?? 100)
    .all();
  return rows.map((r) => ({
    id: r.id,
    hlc: r.hlc,
    type: r.type,
    actorId: r.actorId,
    toAgentId: r.toAgentId,
    threadId: r.threadId,
    parentEventId: r.parentEventId,
    createdAt: r.createdAt,
    payload: shapePayload(r.payload as Record<string, unknown>, filter.maxPayloadBytes),
  }));
}
