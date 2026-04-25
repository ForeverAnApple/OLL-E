// Drizzle schema for the per-host store. Every user-facing row carries
// (host_id, actor_id, hlc) so v1+ cross-host event-log merge is union+sort.
//
// Conventions:
//  - All primary keys are ULID text. Generated in application code.
//  - All timestamps are ms-since-epoch integers for Date arithmetic, or HLC
//    strings when causal ordering matters.
//  - JSON columns are typed via drizzle's `text({mode:"json"})` so payloads
//    remain structured without forcing a schema migration per field.
//  - actor_id is a weak reference: it may point at an agent OR a principal.
//    We check on read, not via FK.

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const hosts = sqliteTable("hosts", {
  id: text("id").primaryKey(),
  hostname: text("hostname").notNull(),
  createdAt: integer("created_at").notNull(),
  configRef: text("config_ref"),
});

export const principals = sqliteTable("principals", {
  id: text("id").primaryKey(),
  display: text("display").notNull(),
  channels: text("channels", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  createdAt: integer("created_at").notNull(),
});

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id),
    parentAgentId: text("parent_agent_id"),
    systemPrompt: text("system_prompt"),
    budgetRef: text("budget_ref"),
    scope: text("scope", { mode: "json" }).$type<AgentScope>().notNull().default(sql`'{}'`),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    nameIdx: index("agents_name").on(t.name),
    parentIdx: index("agents_parent").on(t.parentAgentId),
  }),
);

export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  missionRef: text("mission_ref"),
  goalDir: text("goal_dir"),
  createdAt: integer("created_at").notNull(),
});

export const teamMembers = sqliteTable(
  "team_members",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id),
    actorId: text("actor_id").notNull(),
    role: text("role").notNull(),
    joinedAt: integer("joined_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.teamId, t.actorId] }),
  }),
);

export const triggers = sqliteTable(
  "triggers",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    type: text("type").notNull(), // cron | poll | webhook | channel-message | internal-emit
    config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    scope: text("scope", { mode: "json" }).$type<AgentScope>().notNull().default(sql`'{}'`),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    byAgent: index("triggers_agent").on(t.agentId),
    byType: index("triggers_type").on(t.type),
  }),
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    triggerRefs: text("trigger_refs", { mode: "json" }).$type<string[]>().notNull(),
    handlerRef: text("handler_ref").notNull(),
    tier: text("tier").notNull(), // operational | strategic | vision
    scope: text("scope", { mode: "json" }).$type<AgentScope>().notNull().default(sql`'{}'`),
    tokenEst: integer("token_est").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    byAgent: index("tasks_agent").on(t.agentId),
    byTier: index("tasks_tier").on(t.tier),
  }),
);

export const tools = sqliteTable(
  "tools",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    extensionId: text("extension_id"),
    name: text("name").notNull(),
    schema: text("schema", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    scope: text("scope", { mode: "json" }).$type<AgentScope>().notNull().default(sql`'{}'`),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    byAgent: index("tools_agent").on(t.agentId),
  }),
);

export const extensions = sqliteTable("extensions", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  path: text("path").notNull(),
  status: text("status").notNull(), // active | inactive | crashed
  lastSmokeAt: integer("last_smoke_at"),
  lastCommitSha: text("last_commit_sha"),
  createdAt: integer("created_at").notNull(),
});

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    hlc: text("hlc").notNull(),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id),
    actorId: text("actor_id").notNull(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    parentEventId: text("parent_event_id"),
    // Mailbox routing: which agent is this addressed to, and which
    // correlation thread does it belong to. Both nullable for
    // untargeted/untagged events. Weak reference on to_agent_id
    // (no FK) — mesh events may address agents not present locally.
    // See migration 0003 for the story.
    toAgentId: text("to_agent_id"),
    threadId: text("thread_id"),
    parentThreadId: text("parent_thread_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    byHlc: index("events_hlc").on(t.hlc),
    byType: index("events_type").on(t.type),
    byParent: index("events_parent").on(t.parentEventId),
    byMailbox: index("events_mailbox").on(t.toAgentId, t.hlc),
    byThread: index("events_thread").on(t.threadId, t.hlc),
    byActorHlc: index("events_actor_hlc").on(t.actorId, t.hlc),
  }),
);

export const claims = sqliteTable(
  "claims",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    claimedAt: integer("claimed_at").notNull(),
    status: text("status").notNull(), // winner | lost | lapsed | failed
  },
  (t) => ({
    pk: primaryKey({ columns: [t.eventId, t.taskId] }),
    byEvent: index("claims_event").on(t.eventId),
  }),
);

export const taskRuns = sqliteTable(
  "task_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    status: text("status").notNull(), // queued | running | succeeded | failed | lost
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    error: text("error"),
  },
  (t) => ({
    byTask: index("task_runs_task").on(t.taskId),
    byStatus: index("task_runs_status").on(t.status),
    byEvent: index("task_runs_event").on(t.eventId),
    byAgentStarted: index("task_runs_agent_started").on(t.agentId, t.startedAt),
  }),
);

export const toolCalls = sqliteTable(
  "tool_calls",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").references(() => tasks.id),
    toolId: text("tool_id")
      .notNull()
      .references(() => tools.id),
    args: text("args", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
    tokensUsed: integer("tokens_used").notNull().default(0),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
  },
  (t) => ({
    byTask: index("tool_calls_task").on(t.taskId),
  }),
);

export const decisions = sqliteTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id),
    proposingAgentId: text("proposing_agent_id")
      .notNull()
      .references(() => agents.id),
    tier: text("tier").notNull(),
    summary: text("summary").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull(), // open | approved | denied | modified | stale
    staleness: integer("staleness"), // ms deadline
    quorumRequired: integer("quorum_required", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    resolvedAt: integer("resolved_at"),
  },
  (t) => ({
    byStatus: index("decisions_status").on(t.status),
    byPrincipal: index("decisions_principal").on(t.principalId),
  }),
);

export const approvals = sqliteTable(
  "approvals",
  {
    decisionId: text("decision_id")
      .notNull()
      .references(() => decisions.id),
    actorId: text("actor_id").notNull(),
    vote: text("vote").notNull(), // approve | deny | modify
    message: text("message"),
    at: integer("at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.decisionId, t.actorId, t.at] }),
  }),
);

export const budgets = sqliteTable(
  "budgets",
  {
    id: text("id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id),
    agentId: text("agent_id").references(() => agents.id),
    period: text("period").notNull(), // e.g. 2026-04 or all-time
    capTokens: integer("cap_tokens"),
    capUsd: integer("cap_usd"), // micro-USD to stay integer
    spentTokens: integer("spent_tokens").notNull().default(0),
    spentUsd: integer("spent_usd").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    byAgentPeriod: index("budgets_agent_period").on(t.agentId, t.period),
  }),
);

// Tokens-only ledger (LOG 2026-04-24). USD is a derivation: it's what
// these tokens would cost at current prices (see src/llm/pricing.ts).
// Storing per-row USD created false physics — prices change, snapshots
// rot. Budgets snapshot USD at decrement time into budgets.spent_usd
// because real-money caps need a number to compare against; the ledger
// just records what physically happened.
export const ledger = sqliteTable(
  "ledger",
  {
    id: text("id").primaryKey(),
    hlc: text("hlc").notNull(),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id),
    actorId: text("actor_id").notNull(),
    threadId: text("thread_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    toolCallId: text("tool_call_id").references(() => toolCalls.id),
    at: integer("at").notNull(),
  },
  (t) => ({
    byActor: index("ledger_actor").on(t.actorId),
    byModel: index("ledger_model").on(t.provider, t.model),
    byActorAt: index("ledger_actor_at").on(t.actorId, t.at),
    byThreadAt: index("ledger_thread_at").on(t.threadId, t.at),
  }),
);

export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    hlc: text("hlc").notNull(),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id),
    actorId: text("actor_id").notNull(),
    scope: text("scope").notNull(), // private | team | scratch
    scopeRef: text("scope_ref"), // agent id for private, team id for team, task_run id for scratch
    // Posture differentiator (LOG 2026-04-23). Free-form string; the
    // blessed load-bearing role is `principle` (always-injected at
    // turn start, auto-passed at spawn). Other common roles: goal,
    // preference, skill, knowledge.
    role: text("role").notNull().default(""),
    // Belief weight under the resistance model. Seed principles arrive
    // heavy; lived writes arrive light. No ceiling enforced.
    depth: integer("depth").notNull().default(1),
    // Non-null only when another actor wrote this on the owner's behalf —
    // cultural pass-on is the one blessed case. Otherwise authored_by is
    // implicit (= actor_id) and stays null.
    authoredBy: text("authored_by"),
    // Source memory id during cultural pass-on; null for lived writes.
    seededFrom: text("seeded_from"),
    title: text("title").notNull(),
    bodyMd: text("body_md").notNull(),
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    byScope: index("memories_scope").on(t.scope, t.scopeRef),
    byActor: index("memories_actor").on(t.actorId),
    byActorRole: index("memories_actor_role").on(t.actorId, t.role),
  }),
);

export const memoryReads = sqliteTable(
  "memory_reads",
  {
    // Weak reference — a forgotten memory's audit records must survive
    // its deletion. See migration 0004 for the full rationale.
    memoryId: text("memory_id").notNull(),
    readerActorId: text("reader_actor_id").notNull(),
    at: integer("at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.memoryId, t.readerActorId, t.at] }),
    byMemory: index("memory_reads_memory").on(t.memoryId),
  }),
);

export interface AgentScope {
  allowTools?: string[];
  denyTools?: string[];
  allowTiers?: Array<"operational" | "strategic" | "vision">;
  tags?: string[];
}

export type Host = typeof hosts.$inferSelect;
export type NewHost = typeof hosts.$inferInsert;
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type Principal = typeof principals.$inferSelect;
export type NewPrincipal = typeof principals.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type Decision = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;
export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
export type Extension = typeof extensions.$inferSelect;
export type NewExtension = typeof extensions.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
export type TaskRun = typeof taskRuns.$inferSelect;
export type NewTaskRun = typeof taskRuns.$inferInsert;
