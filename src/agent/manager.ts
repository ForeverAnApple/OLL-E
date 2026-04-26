// Agent manager — the registry of running agent loops on this host.
//
// One daemon holds one manager. It owns the map of agentId → running
// loop, handles spawn / kill, and plays a thin retarget-thread role
// (in-memory only for v0; persistence lands later if we need it).
//
// The root agent is registered at daemon startup. Children are registered
// as spawn_agent fires. Killing an agent stops its loop but leaves the
// agents row intact so history (parent chain, past events) stays auditable.

import { and, eq, inArray } from "drizzle-orm";
import type { EventBus } from "../bus/index.ts";
import type { Store } from "../store/db.ts";
import type { Ledger } from "../ledger/index.ts";
import type { ExtensionHost } from "../extensions/index.ts";
import type { Llm } from "../llm/index.ts";
import type { Inbox } from "../inbox/index.ts";
import type { ToolDef } from "../extensions/types.ts";
import type { AgentScope } from "../store/schema.ts";
import { tables } from "../store/index.ts";
import { ulid } from "../id/index.ts";
import { MEMORY_WROTE, type MemoryScope, type MemoryWrotePayload } from "../memory/events.ts";
import { narrowsScope } from "../permissions/index.ts";
import { startAgentLoop, type AgentLoop } from "./chat.ts";

export interface AgentManagerDeps {
  bus: EventBus;
  store: Store;
  hostId: string;
  llm: Llm;
  extensions?: ExtensionHost;
  /** Core meta-tools injected for every agent the manager runs. Often
   *  set post-construction via setCoreTools because building meta-tools
   *  requires a manager reference (spawn_agent etc.). */
  coreTools?: ToolDef[];
  ledger?: Ledger;
  inbox?: Inbox;
  /** Principal id used for budget + askUp routing on denials. */
  principalId?: string;
  /** Where per-thread snapshots live. */
  threadsDir?: string;
  /** Default model the manager starts children with. Omit to use the
   *  llm adapter's defaultModel. */
  model?: string;
  /** Stable host coordinates injected into default child prompts. */
  hostContext?: string;
}

export interface SpawnOptions {
  /** Stable, human-readable name; shown in traces. */
  name: string;
  /** Initial message text delivered into the child's mailbox in the
   *  work thread. This is the child's mission. */
  mission: string;
  /** Agent id of the spawning parent. Required — orphan agents are a
   *  mesh concept we haven't defined yet. */
  parentAgentId: string;
  /** System prompt for the child. Keep it focused — children are hired
   *  for a job, not general conversation. */
  systemPrompt?: string;
  /** Scope the child runs under. Must `narrowsScope` under the parent's
   *  actual scope — we look the parent up to enforce this. */
  scope?: AgentScope;
  /** Thread id to use for the child's work stream. When omitted, a
   *  fresh ULID is minted. Callers (notably spawn_agent) pass the
   *  thread id they want to track this spawn under. */
  threadId?: string;
  /** Parent thread id — when the spawn descends from a parent thread
   *  (e.g. root DMing a human is thread X, spawns a researcher for X),
   *  link back so observers can correlate. */
  parentThreadId?: string;
  /** Optional additional memory ids on the parent to seed into the
   *  child alongside the auto-passed principles. Only memories the
   *  parent actually owns (actor_id == parentAgentId) are passed;
   *  others are silently skipped. Use for specialized spawns where
   *  a particular skill / knowledge / goal memory should travel with
   *  the child at birth. Principles auto-pass regardless. */
  seedMemoryIds?: string[];
}

export interface SpawnResult {
  agentId: string;
  threadId: string;
}

export interface MailSummaryOptions {
  /** Cap the number of threads returned (default 20). */
  limit?: number;
  /** Only look back this many events (default 500 — bounds the scan). */
  scan?: number;
}

export interface MailSummaryEntry {
  threadId: string;
  events: number;
  lastHlc: string;
  lastType: string;
  lastFromActor: string;
}

export interface AgentManager {
  /** Register an already-running loop (used for the root agent whose
   *  loop is wired by the daemon before the manager starts tracking). */
  register(agentId: string, loop: AgentLoop): void;
  /** Swap the coreTools passed to future spawned children. Daemon calls
   *  this after building meta-tools that themselves reference the
   *  manager (resolving the circular dep cleanly). */
  setCoreTools(tools: ToolDef[]): void;
  /** Start a new child loop. Returns the child's id + the thread id the
   *  mission was delivered on. */
  spawn(opts: SpawnOptions): Promise<SpawnResult>;
  /** Stop a running loop. No-op if the agent isn't tracked. */
  kill(agentId: string): void;
  /** List currently-running agent ids. */
  list(): string[];
  /** Retarget a thread to a different agent. Bridges call
   *  `resolveMailbox(threadId)` when deciding where to publish — the
   *  override wins. `undefined` as target removes the override. */
  retargetThread(threadId: string, toAgentId: string | undefined): void;
  /** Look up a thread's current mailbox target. Undefined = no override. */
  resolveMailbox(threadId: string): string | undefined;
  /** Summarize a given agent's mailbox activity — which threads have
   *  recent events, how many, and the last activity age. Cheap durable
   *  view over the events table; safe to call every turn. Does not
   *  mark anything read. */
  mailSummary(agentId: string, opts?: MailSummaryOptions): MailSummaryEntry[];
  /** Stop every tracked loop (daemon shutdown). */
  shutdown(): void;
}

export function createAgentManager(deps: AgentManagerDeps): AgentManager {
  const loops = new Map<string, AgentLoop>();
  const threadRoutes = new Map<string, string>();
  let coreTools = deps.coreTools;

  function register(agentId: string, loop: AgentLoop): void {
    loops.set(agentId, loop);
  }

  function setCoreTools(tools: ToolDef[]): void {
    coreTools = tools;
  }

  async function spawn(opts: SpawnOptions): Promise<SpawnResult> {
    if (!opts.name || !/^[a-zA-Z0-9][\w-]{0,63}$/.test(opts.name)) {
      throw new Error(`spawn: invalid name "${opts.name}"`);
    }
    if (!opts.mission || typeof opts.mission !== "string") {
      throw new Error("spawn: mission (string) is required");
    }
    // Scope narrowing: load parent's real scope and validate the child's
    // requested scope stays within it.
    const parent = deps.store
      .select()
      .from(tables.agents)
      .where(eq(tables.agents.id, opts.parentAgentId))
      .all()[0];
    if (!parent) {
      throw new Error(`spawn: parent agent ${opts.parentAgentId} not found`);
    }
    const parentScope = (parent.scope as AgentScope) ?? {};
    const childScope: AgentScope = opts.scope ?? {};
    const check = narrowsScope(parentScope, childScope);
    if (!check.ok) {
      throw new Error(`spawn: child scope rejected — ${check.reason}`);
    }

    const childId = ulid();
    deps.store
      .insert(tables.agents)
      .values({
        id: childId,
        name: opts.name,
        hostId: deps.hostId,
        parentAgentId: opts.parentAgentId,
        systemPrompt: opts.systemPrompt ?? null,
        scope: childScope,
        createdAt: Date.now(),
      })
      .run();

    // Cultural pass-on (LOG 2026-04-24): every role=principle memory the
    // parent owns lands in the child's private memory at birth with
    // attribution preserved. `seedMemoryIds` augments with specialized
    // non-principle seeds (skill/knowledge/goal). These arrive *before*
    // the child's loop starts draining its mailbox so its first turn
    // sees the inherited principles injected via the SOUL path.
    passOnCulture({
      store: deps.store,
      bus: deps.bus,
      hostId: deps.hostId,
      parentAgentId: opts.parentAgentId,
      childId,
      extraMemoryIds: opts.seedMemoryIds ?? [],
    });

    const threadId = opts.threadId ?? ulid();

    const loop = startAgentLoop({
      bus: deps.bus,
      store: deps.store,
      hostId: deps.hostId,
      llm: deps.llm,
      agentId: childId,
      extensions: deps.extensions,
      coreTools,
      ledger: deps.ledger,
      inbox: deps.inbox,
      principalId: deps.principalId,
      threadsDir: deps.threadsDir,
      model: deps.model,
      system:
        opts.systemPrompt ??
        // Default prompt makes clear to the child that it's a worker
        // reporting back to its parent via its own reply stream. The
        // parent sees those replies by observing events in the thread.
        [
          `You are ${opts.name}, a child agent spawned to complete a specific mission.`,
          `Your parent is agent ${opts.parentAgentId}.`,
          deps.hostContext,
          `Your replies flow back in thread ${threadId}; keep them focused and terminate when the mission is complete.`,
        ].filter(Boolean).join(" "),
    });
    loops.set(childId, loop);

    // Deliver the mission into the child's mailbox. The child's loop is
    // subscribed by toAgentId === childId; this is what wakes it up.
    deps.bus.publish({
      type: "chat.input",
      hostId: deps.hostId,
      actorId: opts.parentAgentId,
      durable: true,
      toAgentId: childId,
      threadId,
      parentThreadId: opts.parentThreadId,
      payload: { text: opts.mission },
    });

    // Auditable spawn record — distinct event type so observers (tail,
    // other agents) can filter for it without squinting at chat.input.
    deps.bus.publish({
      type: "agent.spawned",
      hostId: deps.hostId,
      actorId: opts.parentAgentId,
      durable: true,
      threadId: opts.parentThreadId,
      payload: {
        childId,
        childName: opts.name,
        threadId,
        mission: opts.mission,
      },
    });

    return { agentId: childId, threadId };
  }

  function kill(agentId: string): void {
    const loop = loops.get(agentId);
    if (!loop) return;
    loop.stop();
    loops.delete(agentId);
    deps.bus.publish({
      type: "agent.killed",
      hostId: deps.hostId,
      actorId: agentId,
      durable: true,
      payload: { agentId },
    });
  }

  function retargetThread(threadId: string, toAgentId: string | undefined): void {
    if (!threadId) throw new Error("retargetThread: threadId required");
    const previous = threadRoutes.get(threadId);
    if (toAgentId) threadRoutes.set(threadId, toAgentId);
    else threadRoutes.delete(threadId);
    deps.bus.publish({
      type: "thread.retargeted",
      hostId: deps.hostId,
      actorId: agentFromCall() ?? "manager",
      durable: true,
      threadId,
      payload: { threadId, previous, current: toAgentId ?? null },
    });
  }

  function resolveMailbox(threadId: string): string | undefined {
    return threadRoutes.get(threadId);
  }

  function mailSummary(agentId: string, opts?: MailSummaryOptions): MailSummaryEntry[] {
    const limit = Math.max(1, Math.min(opts?.limit ?? 20, 100));
    const scan = Math.max(50, Math.min(opts?.scan ?? 500, 5000));
    // Raw SQL because drizzle doesn't know about the mailbox columns
    // we added in migration 0003 by their TypeScript names in every
    // query path — easier to be explicit than fight the builder here.
    const rows = deps.store.raw
      .prepare(
        `SELECT thread_id, type, actor_id, hlc
         FROM events
         WHERE to_agent_id = ?
           AND thread_id IS NOT NULL
         ORDER BY hlc DESC
         LIMIT ?`,
      )
      .all(agentId, scan) as Array<{
        thread_id: string;
        type: string;
        actor_id: string;
        hlc: string;
      }>;
    const byThread = new Map<string, MailSummaryEntry>();
    for (const r of rows) {
      const existing = byThread.get(r.thread_id);
      if (existing) {
        existing.events += 1;
        continue;
      }
      byThread.set(r.thread_id, {
        threadId: r.thread_id,
        events: 1,
        lastHlc: r.hlc,
        lastType: r.type,
        lastFromActor: r.actor_id,
      });
    }
    return [...byThread.values()]
      .sort((a, b) => (a.lastHlc < b.lastHlc ? 1 : -1))
      .slice(0, limit);
  }

  function shutdown(): void {
    for (const loop of loops.values()) loop.stop();
    loops.clear();
    threadRoutes.clear();
  }

  return {
    register,
    setCoreTools,
    spawn,
    kill,
    list: () => [...loops.keys()],
    retargetThread,
    resolveMailbox,
    mailSummary,
    shutdown,
  };
}

// There's no agent-call-stack yet; this is a placeholder for when we
// thread caller identity through. For now retargeting is attributed to
// the manager itself in the emitted event.
function agentFromCall(): string | undefined {
  return undefined;
}

interface PassOnArgs {
  store: Store;
  bus: EventBus;
  hostId: string;
  parentAgentId: string;
  childId: string;
  extraMemoryIds: string[];
}

/** Cultural pass-on: emit memory.wrote events so the parent's
 *  principles (plus any explicit extras) land as seeds in the child's
 *  private memory. Attribution: actor_id=childId (it's the child's
 *  identity now), authored_by=parentId, seeded_from=<parent memory id>.
 *  Depth preserved — a strict parent produces strict-by-default children
 *  without compounding weight up the lineage. */
function passOnCulture(args: PassOnArgs): void {
  const { store, bus, hostId, parentAgentId, childId, extraMemoryIds } = args;
  // Auto-pass: every role=principle memory the parent owns in private
  // scope. We don't propagate team/scratch — team is peer evidence, not
  // inheritance; scratch is task-ephemeral.
  const autoSeeds = store
    .select()
    .from(tables.memories)
    .where(
      and(
        eq(tables.memories.actorId, parentAgentId),
        eq(tables.memories.scope, "private"),
        eq(tables.memories.role, "principle"),
      ),
    )
    .all();

  const extras =
    extraMemoryIds.length > 0
      ? store
          .select()
          .from(tables.memories)
          .where(
            and(
              eq(tables.memories.actorId, parentAgentId),
              inArray(tables.memories.id, extraMemoryIds),
            ),
          )
          .all()
      : [];

  const seen = new Set<string>();
  const seeds = [...autoSeeds, ...extras].filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  for (const seed of seeds) {
    const newId = ulid();
    const payload: MemoryWrotePayload = {
      id: newId,
      actorId: childId,
      scope: "private" as MemoryScope,
      scopeRef: childId,
      role: seed.role,
      title: seed.title,
      bodyMd: seed.bodyMd,
      tags: (seed.tags as string[]) ?? [],
      depth: seed.depth,
      authoredBy: parentAgentId,
      seededFrom: seed.id,
    };
    bus.publish({
      type: MEMORY_WROTE,
      hostId,
      actorId: parentAgentId,
      durable: true,
      payload,
    });
  }
}
