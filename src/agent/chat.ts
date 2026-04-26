// Agent loop — the generic mailbox drainer.
//
// Every agent is a mailbox-holder. This loop subscribes to events addressed
// to its mailbox (toAgentId === agentId), keeps a message history PER
// THREAD (ev.threadId), and drains each thread's pending input in order.
//
// The collapse: there is no special "chat agent" — chat is just one kind
// of event that lands in a mailbox. chat.input from a CLI, chat.input
// from the discord bridge, and later child-agent replies all route through
// the same mechanism: addressed-to-me + tagged-with-a-thread.
//
// Replies (chat.assistant-text, chat.tool-call, chat.tool-result,
// chat.turn-end) carry the same threadId so bridges route them back.
//
// Durability: per-thread message history snapshotted to
// `<threadsDir>/<agentId-sanitized>/<threadId-sanitized>.json` after
// each turn, loaded on first-touch.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventBus } from "../bus/index.ts";
import type { Event } from "../bus/types.ts";
import type { Store } from "../store/db.ts";
import type { Ledger } from "../ledger/index.ts";
import type { ExtensionHost } from "../extensions/index.ts";
import type { Llm, Message, SystemSegment } from "../llm/index.ts";
import type { ToolDef } from "../extensions/types.ts";
import { askUp, type Inbox } from "../inbox/index.ts";
import { checkTool } from "../permissions/index.ts";
import type { AgentScope } from "../store/schema.ts";
import { tables } from "../store/index.ts";
import { eq } from "drizzle-orm";
import { loadPrinciples, renderPrinciples } from "../memory/principles.ts";
import { renderToolCatalog } from "./catalog.ts";
import { buildLoadoutTools } from "../tools/loadout.ts";
import { runAgent, type AgentStep } from "./runtime.ts";

export interface AgentLoopOptions {
  bus: EventBus;
  store: Store;
  hostId: string;
  llm: Llm;
  system?: string;
  /** The agent whose mailbox we're draining. */
  agentId: string;
  /** Extension runtime — loop exposes extension-owned tools alongside
   *  core tools. */
  extensions?: ExtensionHost;
  /** Core/meta tools injected by the host. */
  coreTools?: ToolDef[];
  /** Optional ledger for spend accounting. */
  ledger?: Ledger;
  /** Principal id for budget enforcement + inbox routing on denied calls. */
  principalId?: string;
  /** Inbox used when a tool call is denied by scope — we auto-propose a
   *  grant_scope via askUp. */
  inbox?: Inbox;
  /** Model override. */
  model?: string;
  /** Root directory for per-thread message snapshots. Per agent, per
   *  thread. Omit to disable persistence. */
  threadsDir?: string;
}

interface Thread {
  id: string;
  messages: Message[];
  /** Text queued from chat.input events while the worker is busy. */
  pending: string[];
  /** Origin events paired 1:1 with `pending`; used for parent_event_id
   *  so causal chains stay intact across queued turns. */
  pendingOrigin: Event[];
  /** Set by the single drain loop; undefined means no worker running. */
  worker?: Promise<void>;
  /** Tool names whose schemas the agent has pulled into context for this
   *  thread. Mutated by load_tools / unload_tools meta-tools. Always-
   *  loaded tools are not tracked here — they're sent every turn
   *  regardless. Per-thread runtime state, not persisted. */
  loadedTools: Set<string>;
}

export interface AgentLoop {
  stop(): void;
  threads(): string[];
}

export function startAgentLoop(opts: AgentLoopOptions): AgentLoop {
  const threads = new Map<string, Thread>();
  const agentDir = opts.threadsDir
    ? join(opts.threadsDir, sanitizeId(opts.agentId))
    : undefined;
  if (agentDir) mkdirSync(agentDir, { recursive: true });

  function getOrCreate(id: string): Thread {
    let t = threads.get(id);
    if (t) return t;
    const loaded = agentDir ? tryLoadThread(agentDir, id) : null;
    t = {
      id,
      messages: loaded ?? [],
      pending: [],
      pendingOrigin: [],
      loadedTools: new Set<string>(),
    };
    threads.set(id, t);
    return t;
  }

  const unsub = opts.bus.subscribe("chat.input", (ev) => {
    // Mailbox gate: only events addressed to this agent.
    if (ev.toAgentId !== opts.agentId) return;
    // Threaded: every mailbox event must declare its thread.
    if (!ev.threadId) return;
    const p = ev.payload as { text?: string };
    if (typeof p?.text !== "string") return;

    const thread = getOrCreate(ev.threadId);
    thread.pending.push(p.text);
    thread.pendingOrigin.push(ev);
    if (!thread.worker) {
      thread.worker = drain(thread, opts, agentDir, threads)
        .catch((err) => {
          // Fallback error event anchored to the most recent origin so
          // observers still get a causal chain.
          const last = thread.pendingOrigin.at(-1) ?? ev;
          opts.bus.publish({
            type: "chat.error",
            hostId: opts.hostId,
            actorId: opts.agentId,
            parentEventId: last.id,
            threadId: thread.id,
            durable: true,
            payload: { error: (err as Error).message },
          });
        })
        .finally(() => {
          thread.worker = undefined;
        });
    }
  });

  return {
    stop: () => unsub(),
    threads: () => [...threads.keys()],
  };
}

async function drain(
  thread: Thread,
  opts: AgentLoopOptions,
  agentDir: string | undefined,
  allThreads: Map<string, Thread>,
): Promise<void> {
  while (thread.pending.length > 0) {
    const text = thread.pending.shift()!;
    const origin = thread.pendingOrigin.shift()!;
    await runTurn(thread, text, origin, opts, agentDir, allThreads);
  }
}

async function runTurn(
  thread: Thread,
  text: string,
  origin: Event,
  opts: AgentLoopOptions,
  agentDir: string | undefined,
  allThreads: Map<string, Thread>,
): Promise<void> {
  thread.messages.push({ role: "user", content: text });
  try {
    // Loadout meta-tools capture this thread's loadedTools set in closure
    // so load_tools / unload_tools mutate the right thread. Built per-turn
    // because the closure is per-thread; the cost is two object literals.
    const coreTools = collectTools(opts);
    const loadoutTools = buildLoadoutTools({
      loadedTools: thread.loadedTools,
      allTools: () => tools,
    });
    const tools = [...coreTools, ...loadoutTools];
    // Hot-reload pruning: if an extension was unloaded since last turn and
    // its tool was in this thread's loaded set, drop the entry silently
    // and emit a warning event. Otherwise the agent's loaded list lies.
    pruneOrphanLoaded(thread, tools, opts, origin);
    const redactions = buildRedactionMap(tools);
    const scope = loadAgentScope(opts.store, opts.agentId);
    const grantProposed = new Set<string>();
    // Principles — the agent's strict commitments, injected at turn
    // start instead of retrieved (openclaw SOUL pattern adapted to
    // one-surface memory — LOG 2026-04-23). Stable sort (depth desc,
    // id asc) keeps prompt caches warm across turns with no changes.
    const principleBlock = renderPrinciples(loadPrinciples(opts.store, opts.agentId));
    // Tool catalog — pure function of the registered tool set, rendered
    // into the stable identity segment so the agent reads "what exists"
    // alongside its principles. Per-thread loaded state is encoded in
    // the tools block (which the LLM provider caches separately), NOT
    // in this catalog text — the catalog must stay stable across
    // load_tools calls within a thread or it'll invalidate the prefix.
    const catalogBlock = renderToolCatalog(tools);
    // Mailbox sidebar — a one-line situational awareness block appended
    // to the system prompt each turn. Makes delegation decidable: the
    // agent can see "I have 3 threads with pending work" and choose to
    // spawn a secretary, retarget, or stay focused.
    const sidebar = buildMailboxSidebar(allThreads, thread.id);
    // Structured system prompt with the cache breakpoint between stable
    // (base + principles + catalog) and volatile (sidebar) segments.
    const systemSegments = composeSystemSegments(
      opts.system,
      principleBlock,
      catalogBlock,
      sidebar,
    );
    const result = await runAgent({
      llm: opts.llm,
      model: opts.model,
      system: systemSegments,
      tools,
      isLoaded: (name) => thread.loadedTools.has(name),
      toolCtx: {
        hostId: opts.hostId,
        extensionId: opts.agentId,
        actorId: opts.agentId,
        abort: new AbortController().signal,
        secrets: {},
      },
      messages: thread.messages,
      onStep: (step) => emitStep(opts, thread.id, origin, step, redactions),
      authorize: (tool) =>
        checkTool(scope, { name: tool.name, tier: tool.tier ?? "operational" }),
      onDenied: ({ tool, reason }) => {
        opts.bus.publish({
          type: "tool.denied",
          hostId: opts.hostId,
          actorId: opts.agentId,
          parentEventId: origin.id,
          threadId: thread.id,
          durable: true,
          payload: {
            tool: tool.name,
            tier: tool.tier ?? "operational",
            reason,
          },
        });
        if (!opts.inbox || !opts.principalId) return;
        if (grantProposed.has(tool.name)) return;
        grantProposed.add(tool.name);
        askUp(
          { bus: opts.bus, store: opts.store, hostId: opts.hostId, inbox: opts.inbox },
          {
            proposingAgentId: opts.agentId,
            principalId: opts.principalId,
            tier: "strategic",
            summary: `grant ${opts.agentId} permission to call ${tool.name}`,
            payload: {
              action: "grant_scope",
              agentId: opts.agentId,
              tool: tool.name,
              tier: tool.tier ?? "operational",
              reason,
            },
          },
        );
      },
    });
    thread.messages = result.messages;
    let recorded: { usdMicros: number } | undefined;
    if (opts.ledger && result.totalUsage.totalTokens > 0) {
      recorded = opts.ledger.record({
        actorId: opts.agentId,
        threadId: thread.id,
        principalId: opts.principalId,
        provider: opts.llm.provider,
        model: opts.model ?? opts.llm.defaultModel,
        inputTokens: result.totalUsage.inputTokens,
        outputTokens: result.totalUsage.outputTokens,
        cacheReadTokens: result.totalUsage.cacheReadInputTokens,
        cacheCreationTokens: result.totalUsage.cacheCreationInputTokens,
      });
    }
    // Commit snapshot before announcing turn-end so subscribers reacting
    // to the event can rely on disk state being current. Sensitive tool
    // inputs (e.g. set_secret value) are redacted from the persisted form.
    if (agentDir) saveThread(agentDir, thread, redactions);
    opts.bus.publish({
      type: "chat.turn-end",
      hostId: opts.hostId,
      actorId: opts.agentId,
      parentEventId: origin.id,
      threadId: thread.id,
      durable: true,
      payload: {
        stopReason: result.stopReason,
        model: opts.model ?? opts.llm.defaultModel,
        inputTokens: result.totalUsage.inputTokens,
        outputTokens: result.totalUsage.outputTokens,
        cacheReadTokens: result.totalUsage.cacheReadInputTokens,
        cacheCreationTokens: result.totalUsage.cacheCreationInputTokens,
        totalTokens: result.totalUsage.totalTokens,
        // USD at current prices for the convenience of dashboards/CLI.
        // Always re-derivable from tokens; included only because every
        // surface that wants "what did this turn cost?" else has to
        // re-import pricing.
        usdMicros: recorded?.usdMicros ?? 0,
      },
    });
  } catch (err) {
    opts.bus.publish({
      type: "chat.error",
      hostId: opts.hostId,
      actorId: opts.agentId,
      parentEventId: origin.id,
      threadId: thread.id,
      durable: true,
      payload: { error: (err as Error).message },
    });
  }
}

/**
 * Compose the system prompt as ordered segments with the cache breakpoint
 * placed between stable and volatile content (LOG 2026-04-24).
 *
 * Stable (cached): base system prompt + principles + tool catalog. These
 * change rarely; an agent self-modifying its identity rewrites the
 * principles row, which does invalidate the cache — by design, that's
 * the cost of self-modification. The tool catalog is a pure function of
 * the registered tool set, so per-thread load_tools calls do NOT
 * invalidate it (intentional — see catalog.ts).
 *
 * Volatile (uncached): mailbox sidebar. Updates every turn as threads come
 * and go. Keeping it in its own segment after the breakpoint means turn-by-turn
 * sidebar churn doesn't invalidate the principle/identity prefix.
 */
function composeSystemSegments(
  base: string | undefined,
  principles: string | null,
  catalog: string,
  sidebar: string,
): SystemSegment[] | undefined {
  const stable: string[] = [];
  if (base) stable.push(base);
  if (principles) stable.push(principles);
  if (catalog) stable.push(catalog);
  const segments: SystemSegment[] = [];
  if (stable.length > 0) {
    segments.push({ text: stable.join("\n\n"), cache: "ephemeral" });
  }
  if (sidebar) {
    segments.push({ text: sidebar });
  }
  return segments.length > 0 ? segments : undefined;
}

/**
 * Drop names from a thread's loadedTools set when their tool no longer
 * exists in the current registry (extension hot-reloaded away). Emits a
 * one-line warning event per dropped tool so the agent can see *why* its
 * loadout shrunk between turns.
 */
function pruneOrphanLoaded(
  thread: Thread,
  tools: ToolDef[],
  opts: AgentLoopOptions,
  origin: Event,
): void {
  if (thread.loadedTools.size === 0) return;
  const present = new Set(tools.map((t) => t.name));
  for (const name of [...thread.loadedTools]) {
    if (present.has(name)) continue;
    thread.loadedTools.delete(name);
    opts.bus.publish({
      type: "tool.loaded-dropped",
      hostId: opts.hostId,
      actorId: opts.agentId,
      parentEventId: origin.id,
      threadId: thread.id,
      durable: true,
      payload: {
        name,
        reason: "tool no longer registered (extension unloaded?)",
      },
    });
  }
}

function buildMailboxSidebar(
  threads: Map<string, Thread>,
  currentThreadId: string,
): string {
  const others: Array<{ id: string; pending: number; msgs: number }> = [];
  for (const [id, t] of threads) {
    if (id === currentThreadId) continue;
    // Only surface threads with either unprocessed pending input or
    // prior history worth noting. Empty placeholder threads are noise.
    if (t.pending.length === 0 && t.messages.length === 0) continue;
    others.push({ id, pending: t.pending.length, msgs: t.messages.length });
  }
  if (others.length === 0) return "";
  // Cap the visual — if an agent has 40 open threads the sidebar is
  // not the right surface anyway; they should use mail_list for detail.
  const shown = others.slice(0, 8);
  const truncated = others.length - shown.length;
  const lines = shown.map(
    (o) =>
      `  - ${o.id}: ${o.pending} unread${o.msgs ? `, ${o.msgs} msgs in context` : ""}`,
  );
  const header = `Your mailbox — ${others.length} other thread(s) with activity:`;
  const footer = truncated > 0 ? `\n  (+${truncated} more — call mail_list for full list)` : "";
  return `${header}\n${lines.join("\n")}${footer}`;
}

function collectTools(opts: AgentLoopOptions): ToolDef[] {
  const tools: ToolDef[] = [...(opts.coreTools ?? [])];
  if (opts.extensions) {
    for (const { tool } of opts.extensions.tools()) tools.push(tool);
  }
  return tools;
}

function loadAgentScope(store: Store, agentId: string): AgentScope {
  const row = store.select().from(tables.agents).where(eq(tables.agents.id, agentId)).all()[0];
  return (row?.scope as AgentScope) ?? {};
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function threadFile(agentDir: string, threadId: string): string {
  return join(agentDir, `${sanitizeId(threadId)}.json`);
}

function tryLoadThread(agentDir: string, threadId: string): Message[] | null {
  const f = threadFile(agentDir, threadId);
  if (!existsSync(f)) return null;
  try {
    const raw = JSON.parse(readFileSync(f, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { messages?: unknown }).messages)) {
      return null;
    }
    return (raw as { messages: Message[] }).messages;
  } catch {
    // Corrupt snapshot — start fresh. The events log is still canonical.
    return null;
  }
}

function saveThread(
  agentDir: string,
  thread: Thread,
  redactions: Map<string, string[]>,
): void {
  try {
    const messages = redactions.size
      ? redactMessages(thread.messages, redactions)
      : thread.messages;
    writeFileSync(
      threadFile(agentDir, thread.id),
      JSON.stringify({ id: thread.id, messages, savedAt: Date.now() }),
      "utf8",
    );
  } catch {
    // Best-effort; in-memory thread remains intact.
  }
}

function buildRedactionMap(tools: ToolDef[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const t of tools) {
    if (t.sensitiveInputFields && t.sensitiveInputFields.length) {
      m.set(t.name, t.sensitiveInputFields);
    }
  }
  return m;
}

function redactInput(input: unknown, fields: string[]): Record<string, unknown> {
  const src = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...src };
  for (const f of fields) {
    if (f in out) out[f] = "[redacted]";
  }
  return out;
}

function redactMessages(
  messages: Message[],
  redactions: Map<string, string[]>,
): Message[] {
  return messages.map((m) => {
    if (m.role !== "assistant" || typeof m.content === "string") return m;
    const content = (m.content as unknown[]).map((block) => {
      const b = block as { type?: string; name?: string; input?: unknown };
      if (b.type !== "tool_use" || !b.name) return block;
      const fields = redactions.get(b.name);
      if (!fields) return block;
      return { ...b, input: redactInput(b.input, fields) };
    });
    return { ...m, content } as Message;
  });
}

function emitStep(
  opts: AgentLoopOptions,
  threadId: string,
  origin: Event,
  step: AgentStep,
  redactions: Map<string, string[]>,
): void {
  if (step.kind === "assistant") {
    const text = step.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text) {
      // Authoritative full-text event — durable, persisted, and what
      // memory/observability subscribers reconstruct conversations from.
      // Streaming consumers (CLI) prefer chat.assistant-delta and ignore
      // this; non-streaming consumers (history snapshots) get the whole
      // block here in one shot.
      opts.bus.publish({
        type: "chat.assistant-text",
        hostId: opts.hostId,
        actorId: opts.agentId,
        parentEventId: origin.id,
        threadId,
        durable: true,
        payload: { text },
      });
    }
  } else if (step.kind === "assistant_delta") {
    if (!step.text) return;
    // Live token-by-token feed for surfaces that want to render
    // progressively. Marked non-durable: deltas are visualization, not
    // history. The full chat.assistant-text below is the canonical record.
    opts.bus.publish({
      type: "chat.assistant-delta",
      hostId: opts.hostId,
      actorId: opts.agentId,
      parentEventId: origin.id,
      threadId,
      durable: false,
      payload: { text: step.text },
    });
  } else if (step.kind === "tool_use") {
    const fields = redactions.get(step.name);
    const input = fields ? redactInput(step.input, fields) : step.input;
    opts.bus.publish({
      type: "chat.tool-call",
      hostId: opts.hostId,
      actorId: opts.agentId,
      parentEventId: origin.id,
      threadId,
      durable: true,
      payload: { id: step.id, name: step.name, input },
    });
  } else if (step.kind === "tool_result") {
    opts.bus.publish({
      type: "chat.tool-result",
      hostId: opts.hostId,
      actorId: opts.agentId,
      parentEventId: origin.id,
      threadId,
      durable: true,
      payload: {
        id: step.id,
        name: step.name,
        isError: step.isError,
        content: step.content,
      },
    });
  } else if (step.kind === "usage") {
    // Per-call usage event. Cache fields are first-class so subscribers
    // (CLI tail, future bridges, observability dashboards) see cache
    // stats turn-by-turn without having to wait for chat.turn-end.
    opts.bus.publish({
      type: "chat.usage",
      hostId: opts.hostId,
      actorId: opts.agentId,
      parentEventId: origin.id,
      threadId,
      durable: false,
      payload: { ...step.usage },
    });
  } else if (step.kind === "retry") {
    // Surface adapter-level transient retries (overload, rate limit, 5xx)
    // so the UI can render "API busy, waiting…" instead of leaving the
    // user staring at an unmoving prompt while the SDK rides it out.
    opts.bus.publish({
      type: "chat.api-retry",
      hostId: opts.hostId,
      actorId: opts.agentId,
      parentEventId: origin.id,
      threadId,
      durable: false,
      payload: { ...step.info },
    });
  }
}
