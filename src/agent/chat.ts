// Chat agent — channel-of-first-contact. Subscribes to chat.input events
// for a given session, runs the agent loop, and streams assistant text
// + tool visibility back as chat.* events so the CLI can tail and render.
//
// Concurrency: one worker per session. chat.input always enqueues; the
// worker drains pending messages in order. Never drops — concurrent
// inputs to the same session serialize behind the current turn. Different
// sessions run independently.
//
// Durability: when sessionsDir is configured, session.messages is
// snapshotted to disk after each turn-end and loaded on first-touch so
// a restart doesn't lose conversation state.

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

export interface ChatAgentOptions {
  bus: EventBus;
  store: Store;
  hostId: string;
  llm: Llm;
  system?: string;
  /** The agent's id (for attribution + ledger). */
  agentId: string;
  /** Extension runtime — chat agent uses it to expose extension-owned
   *  tools alongside core tools. */
  extensions?: ExtensionHost;
  /** Core/meta tools injected by the host. */
  coreTools?: ToolDef[];
  /** Optional ledger for spend accounting. */
  ledger?: Ledger;
  /** Principal id for budget enforcement + inbox routing on denied calls. */
  principalId?: string;
  /** Inbox used when a tool call is denied by scope — we auto-propose a
   *  grant_scope via askUp. Omit to just return the denial to the model. */
  inbox?: Inbox;
  /** Model override. */
  model?: string;
  /** Directory to persist session message history as JSON snapshots.
   *  One file per session, written after each turn-end and loaded on
   *  first-touch. Omit to disable persistence (sessions live only in
   *  memory). */
  sessionsDir?: string;
}

interface Session {
  id: string;
  messages: Message[];
  /** Text queued from chat.input events while the worker is busy. */
  pending: string[];
  /** Set by the single drain loop; undefined means no worker running. */
  worker?: Promise<void>;
}

export interface ChatAgent {
  stop(): void;
  sessions(): string[];
}

export function startChatAgent(opts: ChatAgentOptions): ChatAgent {
  const sessions = new Map<string, Session>();
  if (opts.sessionsDir) mkdirSync(opts.sessionsDir, { recursive: true });

  function getOrCreateSession(id: string): Session {
    let s = sessions.get(id);
    if (s) return s;
    const loaded = opts.sessionsDir ? tryLoadSession(opts.sessionsDir, id) : null;
    s = { id, messages: loaded ?? [], pending: [] };
    sessions.set(id, s);
    return s;
  }

  const unsub = opts.bus.subscribe("chat.input", (ev) => {
    const p = ev.payload as { sessionId?: string; text?: string };
    if (!p?.sessionId || typeof p.text !== "string") return;
    const session = getOrCreateSession(p.sessionId);
    session.pending.push(p.text);
    // Preserve the originating event so emitted steps keep the parent
    // chain. First message in a burst wins as parent for the whole
    // drain; v0.1 can emit per-turn parenting if the granularity matters.
    if (!session.worker) {
      session.worker = drain(session, ev, opts)
        .catch((err) => {
          opts.bus.publish({
            type: "chat.error",
            hostId: opts.hostId,
            actorId: opts.agentId,
            parentEventId: ev.id,
            durable: true,
            payload: { sessionId: session.id, error: (err as Error).message },
          });
        })
        .finally(() => {
          session.worker = undefined;
        });
    }
  });

  return {
    stop: () => unsub(),
    sessions: () => [...sessions.keys()],
  };
}

async function drain(session: Session, origin: Event, opts: ChatAgentOptions): Promise<void> {
  while (session.pending.length > 0) {
    const text = session.pending.shift()!;
    await runTurn(session, text, origin, opts);
  }
}

async function runTurn(session: Session, text: string, origin: Event, opts: ChatAgentOptions): Promise<void> {
  session.messages.push({ role: "user", content: text });
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
      messages: session.messages,
      onStep: (step) => emitStep(opts, session.id, origin, step, redactions),
      authorize: (tool) =>
        checkTool(scope, { name: tool.name, tier: tool.tier ?? "operational" }),
      onDenied: ({ tool, reason }) => {
        opts.bus.publish({
          type: "tool.denied",
          hostId: opts.hostId,
          actorId: opts.agentId,
          parentEventId: origin.id,
          durable: true,
          payload: {
            sessionId: session.id,
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
    session.messages = result.messages;
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
    // Commit the snapshot before announcing turn-end so any subscriber
    // reacting to the event can rely on the on-disk state being current.
    // Sensitive tool inputs (e.g. set_secret value) are redacted from the
    // persisted form — the in-memory session still holds the raw values
    // the current turn already passed to the tool, but no subsequent
    // reader (disk snapshot, replay) ever sees them.
    if (opts.sessionsDir) {
      saveSession(opts.sessionsDir, session, redactions);
    }
    opts.bus.publish({
      type: "chat.turn-end",
      hostId: opts.hostId,
      actorId: opts.agentId,
      parentEventId: origin.id,
      durable: true,
      payload: {
        sessionId: session.id,
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
      durable: true,
      payload: { sessionId: session.id, error: (err as Error).message },
    });
  }
}

function collectTools(opts: ChatAgentOptions): ToolDef[] {
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

function sessionFile(dir: string, id: string): string {
  // Only allow url-safe characters in the filename to avoid path traversal.
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(dir, `${safe}.json`);
}

function tryLoadSession(dir: string, id: string): Message[] | null {
  const f = sessionFile(dir, id);
  if (!existsSync(f)) return null;
  try {
    const raw = JSON.parse(readFileSync(f, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { messages?: unknown }).messages)) {
      return null;
    }
    return (raw as { messages: Message[] }).messages;
  } catch {
    // Corrupt snapshot — start fresh. Not worth crashing over; the events
    // log is still the canonical history if we ever need to rebuild.
    return null;
  }
}

function saveSession(
  dir: string,
  session: Session,
  redactions: Map<string, string[]>,
): void {
  try {
    const messages = redactions.size
      ? redactMessages(session.messages, redactions)
      : session.messages;
    writeFileSync(
      sessionFile(dir, session.id),
      JSON.stringify({ id: session.id, messages, savedAt: Date.now() }),
      "utf8",
    );
  } catch {
    // Best-effort persistence; the session remains intact in memory.
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

function redactInput(
  input: unknown,
  fields: string[],
): Record<string, unknown> {
  const src = (input && typeof input === "object") ? (input as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...src };
  for (const f of fields) {
    if (f in out) out[f] = "[redacted]";
  }
  return out;
}

// Deep-clone-and-redact: walks assistant messages for tool_use blocks whose
// tool name has registered sensitive fields. Never mutates the input.
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
  opts: ChatAgentOptions,
  sessionId: string,
  origin: Event,
  step: AgentStep,
  redactions: Map<string, string[]>,
): void {
  if (step.kind === "assistant") {
    // Flatten to text for the CLI; tool-use blocks go out separately.
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
        durable: true,
        payload: { sessionId, text },
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
      durable: true,
      payload: { sessionId, id: step.id, name: step.name, input },
    });
  } else if (step.kind === "tool_result") {
    opts.bus.publish({
      type: "chat.tool-result",
      hostId: opts.hostId,
      actorId: opts.agentId,
      parentEventId: origin.id,
      durable: true,
      payload: {
        sessionId,
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
      durable: false,
      payload: { sessionId, ...step.usage, usdMicros: step.usdMicros },
    });
  }
}
