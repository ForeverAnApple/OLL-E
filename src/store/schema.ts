// Drizzle schema for the per-host store. Every user-facing row carries
// (host_id, actor_id, hlc) so v1+ cross-host event-log merge is union+sort.
//
// Conventions:
//  - All primary keys are ULID text. Generated in application code.
//  - All timestamps are ms-since-epoch integers for Date arithmetic, or HLC
//    strings when causal ordering matters.
//  - JSON columns are typed via drizzle's `text({mode:"json"})` so payloads
//    remain structured without forcing a schema migration per field.
//  - actor_id is a weak reference to an agent id. (LOG 2026-04-23 collapsed
//    principals into agents — every actor is an agent now, including the
//    human, who carries `owns_money = 1`.) We don't FK because mesh events
//    can arrive carrying actor ids that aren't local.

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const hosts = sqliteTable("hosts", {
  id: text("id").primaryKey(),
  hostname: text("hostname").notNull(),
  createdAt: integer("created_at").notNull(),
  configRef: text("config_ref"),
});

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Self-chosen handle the agent uses when introducing itself; nullable
     *  cache of the most recent `role=display-name` memory body, kept
     *  current by the memory projector. CLI/event renders that want a
     *  social label fall back to `name` when this is null. */
    displayName: text("display_name"),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id),
    parentAgentId: text("parent_agent_id"),
    systemPrompt: text("system_prompt"),
    budgetRef: text("budget_ref"),
    scope: text("scope", { mode: "json" }).$type<AgentScope>().notNull().default(sql`'{}'`),
    /** Inbox-delivery channels for this agent. Mostly populated for
     *  `owns_money` (human) agents — the addresses the decision inbox
     *  routes through (CLI, Discord, etc.). Spawned AI agents typically
     *  carry `[]` until/unless they grow their own channels. */
    channels: text("channels", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    /** "This agent is backed by real-world money." Survives the LOG
     *  2026-04-23 collapse as a property, not a separate primitive: a
     *  human is an agent with `owns_money = 1` (and typically
     *  `parent_agent_id = NULL`). Drives ask-up termination and budget
     *  ownership. SQLite booleans are integers (0/1). */
    ownsMoney: integer("owns_money", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    nameIdx: index("agents_name").on(t.name),
    parentIdx: index("agents_parent").on(t.parentAgentId),
    ownsMoneyIdx: index("agents_owns_money").on(t.ownsMoney),
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
  // Owning agent (weak ref — backfilled to root at boot, may name a peer
  // agent absent locally). Placement runs per-agent (LOG 2026-07-18).
  agentId: text("agent_id"),
  // auto | vm | host — resolved isolation posture. `host` is an approved
  // requiresHost extension that cannot run in a VM.
  isolation: text("isolation").notNull().default("auto"),
});

// One row per placed microVM (LOG 2026-07-18). vm_key is the placement key;
// v1 = agent_id (one VM per agent). host_id is a real FK — a VM is always
// local to the host running it.
export const vms = sqliteTable(
  "vms",
  {
    id: text("id").primaryKey(),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id),
    vmKey: text("vm_key").notNull(),
    agentId: text("agent_id").notNull(),
    backend: text("backend").notNull(), // firecracker | subprocess | legacy | vfkit
    status: text("status").notNull(), // booting | running | stopped | crashed
    imageSha: text("image_sha"),
    bootCount: integer("boot_count").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    lastBootAt: integer("last_boot_at"),
  },
  (t) => [uniqueIndex("vms_key").on(t.hostId, t.vmKey)],
);

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
    /** The agent who owns this decision — its inbox sees it, its
     *  channels deliver it, and (when `owns_money = 1`) its real-world
     *  authority is what gets exercised. Pre-2026-04-23 this was
     *  `principal_id`; the collapse made principals into agents. */
    ownerAgentId: text("owner_agent_id")
      .notNull()
      .references(() => agents.id),
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
    byOwner: index("decisions_owner").on(t.ownerAgentId),
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

/** Agent-authored follow-up replies on a decision (LOG 2026-04-27 — mail_reply).
 *  Distinct from `approvals` because there's no vote — these are the
 *  "FYI done" / "blocked because X" messages an agent posts back into
 *  a decision's conversation thread after (typically) executing an
 *  approved payload. Read together with proposal + approvals to render
 *  the full thread in `olle inbox show <id>` and `mail_list`. */
export const decisionMessages = sqliteTable(
  "decision_messages",
  {
    id: text("id").primaryKey(),
    decisionId: text("decision_id")
      .notNull()
      .references(() => decisions.id),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id),
    actorId: text("actor_id").notNull(),
    text: text("text").notNull(),
    at: integer("at").notNull(),
  },
  (t) => ({
    byDecision: index("decision_messages_decision").on(t.decisionId, t.at),
  }),
);

/** Per-reader "I saw this message" log (LOG 2026-04-28 — inbox UI/UX).
 *  Backs unread-counts on `inbox.list` and the `[NEW]` markers on
 *  `inbox.show`. Same shape as `memory_reads`. */
export const decisionMessageReads = sqliteTable(
  "decision_message_reads",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => decisionMessages.id),
    readerActorId: text("reader_actor_id").notNull(),
    at: integer("at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.readerActorId] }),
    byReader: index("decision_message_reads_reader").on(t.readerActorId),
  }),
);

export const budgets = sqliteTable(
  "budgets",
  {
    id: text("id").primaryKey(),
    /** The agent who owns this budget envelope — the real-money source.
     *  Typically an `owns_money = 1` agent (a human). Pre-2026-04-23
     *  this was `principal_id`. */
    ownerAgentId: text("owner_agent_id")
      .notNull()
      .references(() => agents.id),
    /** Sub-allocation: when set, this row caps spending for a specific
     *  descendant agent rather than the owner directly. */
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
    byOwner: index("budgets_owner").on(t.ownerAgentId, t.period),
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

// Over-cap tool output spilled out of the conversation prefix and replaced
// inline with a preview + handle. The id is the LLM-emitted tool_use_id —
// already unique per invocation and embedded in the preview so the agent
// can recover it via `read_tool_result`.
export const toolResults = sqliteTable(
  "tool_results",
  {
    id: text("id").primaryKey(),
    hlc: text("hlc").notNull(),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id),
    actorId: text("actor_id").notNull(),
    threadId: text("thread_id").notNull(),
    toolName: text("tool_name").notNull(),
    content: text("content").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    byThread: index("tool_results_thread").on(t.threadId, t.createdAt),
    byActor: index("tool_results_actor").on(t.actorId, t.createdAt),
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

// Federation tombstones (migration 0004). A peer's `memory.forgotten`
// can arrive before its corresponding `memory.wrote` under network
// reorder / catch-up replay. The projector consults this table on
// every `memory.wrote` and refuses to resurrect a row whose tombstone
// hlc dominates the write. host_id and actor_id are weak refs — a
// tombstone authored by a peer carries that peer's identity.
export const memoryTombstones = sqliteTable("memory_tombstones", {
  memoryId: text("memory_id").primaryKey(),
  hlc: text("hlc").notNull(),
  hostId: text("host_id").notNull(),
  actorId: text("actor_id").notNull(),
  forgottenAt: integer("forgotten_at").notNull(),
});

// ─── Team mesh substrate (migration 0003) ─────────────────────────────────
//
// Local view of "who else is in this team and how do I reach them right
// now." One row per (team, peer). Status reflects the local link state,
// not a consensus view. peer_host_id is a weak ref — peers from other
// cells aren't present in the local `hosts` table.
export const teamPeers = sqliteTable(
  "team_peers",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id),
    peerHostId: text("peer_host_id").notNull(),
    addr: text("addr").notNull(),
    status: text("status").notNull(), // connected | disconnected | stale | left | rejected
    lastHeartbeatAt: integer("last_heartbeat_at"),
    lastReceivedEventId: text("last_received_event_id"),
    joinedAt: integer("joined_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.teamId, t.peerHostId] }),
    byStatus: index("team_peers_status").on(t.status),
  }),
);

// Outstanding bearer-code invites the local host has issued. The raw
// secret never lands in SQLite — only its hash plus a `secret_ref`
// pointing into `secrets/team/<teamId>` where the canonical bytes live.
export const teamInvites = sqliteTable("team_invites", {
  inviteId: text("invite_id").primaryKey(),
  teamId: text("team_id")
    .notNull()
    .references(() => teams.id),
  codeHash: text("code_hash").notNull(),
  secretRef: text("secret_ref").notNull(),
  addr: text("addr").notNull(),
  createdByActorId: text("created_by_actor_id").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at"),
  redeemedAt: integer("redeemed_at"),
  redeemedByHostId: text("redeemed_by_host_id"),
});

// Leaderless claim-window projection across the mesh. Distinct from the
// single-host `claims` table — `claims` is the local scheduler's per-
// event-per-task winner record, `team_claims` is the cross-host
// arbitration projection. event_id, claiming_host_id, and
// claiming_agent_id are weak refs (the event/agent may live on a peer
// host). task_fingerprint is the stable identity used to dedupe when
// the same logical task is registered on multiple cells.
export const teamClaims = sqliteTable(
  "team_claims",
  {
    claimId: text("claim_id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id),
    eventId: text("event_id").notNull(),
    eventHlc: text("event_hlc").notNull(),
    claimingHostId: text("claiming_host_id").notNull(),
    claimingAgentId: text("claiming_agent_id").notNull(),
    taskId: text("task_id").notNull(),
    taskFingerprint: text("task_fingerprint").notNull(),
    claimHlc: text("claim_hlc").notNull(),
    status: text("status").notNull(), // intent | won | lost | split_brain
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    byEvent: index("team_claims_event").on(t.eventId),
    byTeam: index("team_claims_team").on(t.teamId, t.createdAt),
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
export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type Decision = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;
export type DecisionMessage = typeof decisionMessages.$inferSelect;
export type NewDecisionMessage = typeof decisionMessages.$inferInsert;
export type DecisionMessageRead = typeof decisionMessageReads.$inferSelect;
export type NewDecisionMessageRead = typeof decisionMessageReads.$inferInsert;
export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
export type Extension = typeof extensions.$inferSelect;
export type NewExtension = typeof extensions.$inferInsert;
export type Vm = typeof vms.$inferSelect;
export type NewVm = typeof vms.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
export type TriggerRow = typeof triggers.$inferSelect;
export type NewTriggerRow = typeof triggers.$inferInsert;
export type TaskRun = typeof taskRuns.$inferSelect;
export type NewTaskRun = typeof taskRuns.$inferInsert;
export type TeamPeer = typeof teamPeers.$inferSelect;
export type NewTeamPeer = typeof teamPeers.$inferInsert;
export type TeamInvite = typeof teamInvites.$inferSelect;
export type NewTeamInvite = typeof teamInvites.$inferInsert;
export type TeamClaim = typeof teamClaims.$inferSelect;
export type NewTeamClaim = typeof teamClaims.$inferInsert;
export type MemoryTombstone = typeof memoryTombstones.$inferSelect;
export type NewMemoryTombstone = typeof memoryTombstones.$inferInsert;
