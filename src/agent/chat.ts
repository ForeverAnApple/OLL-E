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
import type { Llm, Message } from "../llm/index.ts";
import type { ToolDef } from "../extensions/types.ts";
import { askUp, type Inbox } from "../inbox/index.ts";
import { checkTool } from "../permissions/index.ts";
import type { AgentScope } from "../store/schema.ts";
import { tables } from "../store/index.ts";
import { eq } from "drizzle-orm";
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
    t = { id, messages: loaded ?? [], pending: [], pendingOrigin: [] };
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
      thread.worker = drain(thread, opts, agentDir)
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
): Promise<void> {
  while (thread.pending.length > 0) {
    const text = thread.pending.shift()!;
    const origin = thread.pendingOrigin.shift()!;
    await runTurn(thread, text, origin, opts, agentDir);
  }
}

async function runTurn(
  thread: Thread,
  text: string,
  origin: Event,
  opts: AgentLoopOptions,
  agentDir: string | undefined,
): Promise<void> {
  thread.messages.push({ role: "user", content: text });
  try {
    const tools = collectTools(opts);
    const redactions = buildRedactionMap(tools);
    const scope = loadAgentScope(opts.store, opts.agentId);
    const grantProposed = new Set<string>();
    const result = await runAgent({
      llm: opts.llm,
      model: opts.model,
      system: opts.system,
      tools,
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
    if (opts.ledger && result.totalUsage.totalTokens > 0) {
      opts.ledger.record({
        actorId: opts.agentId,
        principalId: opts.principalId,
        provider: opts.llm.provider,
        model: opts.model ?? opts.llm.defaultModel,
        tokens: result.totalUsage.totalTokens,
        usd: result.totalUsdMicros,
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
        tokens: result.totalUsage.totalTokens,
        usdMicros: result.totalUsdMicros,
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
    opts.bus.publish({
      type: "chat.usage",
      hostId: opts.hostId,
      actorId: opts.agentId,
      parentEventId: origin.id,
      threadId,
      durable: false,
      payload: { ...step.usage, usdMicros: step.usdMicros },
    });
  }
}
