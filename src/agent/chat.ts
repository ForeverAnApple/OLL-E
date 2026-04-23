// Chat agent — channel-of-first-contact. Subscribes to chat.input events
// for a given session, runs the agent loop, and streams assistant text
// + tool visibility back as chat.* events so the CLI can tail and render.
//
// Session ids keep parallel conversations isolated; the CLI generates one
// per repl and sticks it in the event payload.

import type { EventBus } from "../bus/index.ts";
import type { Event } from "../bus/types.ts";
import type { Store } from "../store/db.ts";
import type { Ledger } from "../ledger/index.ts";
import type { ExtensionHost } from "../extensions/index.ts";
import type { Llm, Message } from "../llm/index.ts";
import type { ToolDef } from "../extensions/types.ts";
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
  /** Principal id for budget enforcement. */
  principalId?: string;
  /** Model override. */
  model?: string;
}

/** History is kept in-memory per session for v0. Durable reconstruction
 *  from the events table is a v0.1 concern. */
interface Session {
  id: string;
  messages: Message[];
  running: boolean;
}

export interface ChatAgent {
  stop(): void;
  sessions(): string[];
}

export function startChatAgent(opts: ChatAgentOptions): ChatAgent {
  const sessions = new Map<string, Session>();

  const unsub = opts.bus.subscribe("chat.input", async (ev) => {
    const p = ev.payload as { sessionId?: string; text?: string };
    if (!p?.sessionId || typeof p.text !== "string") return;
    let session = sessions.get(p.sessionId);
    if (!session) {
      session = { id: p.sessionId, messages: [], running: false };
      sessions.set(p.sessionId, session);
    }
    if (session.running) {
      // Drop or queue? v0: drop with a warning event. Reasonable because
      // chat input is interactive — the user shouldn't be multiplexing.
      opts.bus.publish({
        type: "chat.busy",
        hostId: opts.hostId,
        actorId: opts.agentId,
        payload: { sessionId: session.id },
        durable: false,
      });
      return;
    }
    session.running = true;
    session.messages.push({ role: "user", content: p.text });

    try {
      const tools = collectTools(opts);
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
        onStep: (step) => emitStep(opts, session!.id, ev, step),
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
      opts.bus.publish({
        type: "chat.turn-end",
        hostId: opts.hostId,
        actorId: opts.agentId,
        parentEventId: ev.id,
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
        parentEventId: ev.id,
        durable: true,
        payload: { sessionId: session.id, error: (err as Error).message },
      });
    } finally {
      session.running = false;
    }
  });

  return {
    stop: () => unsub(),
    sessions: () => [...sessions.keys()],
  };
}

function collectTools(opts: ChatAgentOptions): ToolDef[] {
  const tools: ToolDef[] = [...(opts.coreTools ?? [])];
  if (opts.extensions) {
    for (const { tool } of opts.extensions.tools()) tools.push(tool);
  }
  return tools;
}

function emitStep(
  opts: ChatAgentOptions,
  sessionId: string,
  origin: Event,
  step: AgentStep,
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
    opts.bus.publish({
      type: "chat.tool-call",
      hostId: opts.hostId,
      actorId: opts.agentId,
      parentEventId: origin.id,
      durable: true,
      payload: { sessionId, id: step.id, name: step.name, input: step.input },
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
