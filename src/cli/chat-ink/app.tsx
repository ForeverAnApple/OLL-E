// Ink chat REPL. Subscribes to the daemon's tail stream, renders
// committed scrollback through <Static> (cheap rerender), and keeps a
// live region below for the in-progress assistant response. Ink owns
// the redraw loop — streaming deltas just bump state and the terminal
// repaints, no manual cursor management.

import { Box, Static, Text, useApp, useInput } from "ink";
import { useEffect, useReducer, useState } from "react";
import type * as React from "react";
import type { IpcClient } from "../../ipc/client.ts";
import type { Event } from "../../bus/types.ts";
import { MessageRow, type ScrollbackEntry } from "./message.tsx";
import { InputFrame, StatusLine, type BarState } from "./input-bar.tsx";
import { StatusFooter } from "./status-footer.tsx";
import { mintId } from "./ids.ts";

export interface ChatAppProps {
  client: IpcClient;
  agentId: string;
  agentName: string;
  initialThreadId: string;
  initialModel: string;
  inboxOpen: number;
}

type Action =
  | { type: "user-submit"; text: string }
  | { type: "delta"; text: string }
  | { type: "assistant-text"; text: string }
  | { type: "tool-call"; name: string; input: unknown }
  | { type: "tool-result"; toolId: string; content: string; isError: boolean }
  | { type: "note"; text: string }
  | { type: "error"; text: string }
  | { type: "retry"; attempt: number; status?: number; message?: string }
  | { type: "turn-end"; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; usdMicros: number; stopReason: string }
  | { type: "cancelled" }
  | { type: "thread-rotated"; threadId: string }
  | { type: "model-changed"; model: string }
  | { type: "turn-busy"; busy: boolean };

interface ChatState {
  scrollback: ScrollbackEntry[];
  streaming: string;
  renderedToolResults: Set<string>;
  turnBusy: boolean;
  threadId: string;
  model: string;
  /** Cumulative spend on this thread since the REPL started (or last /clear). */
  totalUsdMicros: number;
  /** Cumulative billed tokens — in + out + cache_read + cache_write.
   *  Single number on purpose: separate in/out + cache breakdowns were
   *  the source of the earlier "weird counter" feedback. One number,
   *  total throughput. */
  totalBilledTokens: number;
}

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case "user-submit":
      return {
        ...state,
        scrollback: [...state.scrollback, { kind: "user", id: mintId("e:"), text: action.text }],
      };
    case "delta":
      return { ...state, streaming: state.streaming + action.text };
    case "assistant-text": {
      const text = action.text || state.streaming;
      const next: ScrollbackEntry[] = text.length > 0
        ? [...state.scrollback, { kind: "assistant", id: mintId("e:"), text }]
        : state.scrollback;
      return { ...state, scrollback: next, streaming: "" };
    }
    case "tool-call":
      return {
        ...state,
        scrollback: [...state.scrollback, { kind: "tool-call", id: mintId("e:"), name: action.name, input: action.input }],
      };
    case "tool-result": {
      if (state.renderedToolResults.has(action.toolId)) return state;
      const ids = new Set(state.renderedToolResults);
      ids.add(action.toolId);
      return {
        ...state,
        renderedToolResults: ids,
        scrollback: [...state.scrollback, { kind: "tool-result", id: mintId("e:"), content: action.content, isError: action.isError }],
      };
    }
    case "note":
      return { ...state, scrollback: [...state.scrollback, { kind: "note", id: mintId("e:"), text: action.text }] };
    case "error":
      return {
        ...state,
        scrollback: [...state.scrollback, { kind: "error", id: mintId("e:"), text: action.text }],
        streaming: "",
        turnBusy: false,
      };
    case "retry":
      return {
        ...state,
        scrollback: [...state.scrollback, {
          kind: "retry",
          id: mintId("e:"),
          attempt: action.attempt,
          ...(action.status !== undefined && { status: action.status }),
          ...(action.message !== undefined && { message: action.message }),
        }],
      };
    case "turn-end": {
      // We stamp the entry with the **cumulative** USD at the close of
      // this turn (not the per-turn delta). This makes each turn line
      // read as a checkpoint — "after turn N, you've spent $X total" —
      // which is the question the user actually asks. Per-turn cost is
      // still derivable as the delta from the previous turn entry, but
      // we don't render it: KISS, one cost per line.
      const cumulative = state.totalUsdMicros + action.usdMicros;
      const turnBilled =
        action.inputTokens + action.outputTokens + action.cacheReadTokens + action.cacheCreationTokens;
      return {
        ...state,
        scrollback: [...state.scrollback, {
          kind: "turn-end",
          id: mintId("e:"),
          model: action.model,
          inputTokens: action.inputTokens,
          outputTokens: action.outputTokens,
          cacheReadTokens: action.cacheReadTokens,
          cacheCreationTokens: action.cacheCreationTokens,
          cumulativeUsdMicros: cumulative,
          stopReason: action.stopReason,
        }],
        streaming: "",
        turnBusy: false,
        renderedToolResults: new Set(),
        totalUsdMicros: cumulative,
        totalBilledTokens: state.totalBilledTokens + turnBilled,
      };
    }
    case "cancelled":
      return {
        ...state,
        scrollback: [...state.scrollback, { kind: "note", id: mintId("e:"), text: "(cancelled)" }],
        streaming: "",
        turnBusy: false,
        renderedToolResults: new Set(),
      };
    case "thread-rotated":
      return {
        ...state,
        threadId: action.threadId,
        scrollback: [],
        streaming: "",
        turnBusy: false,
        renderedToolResults: new Set(),
        totalUsdMicros: 0,
        totalBilledTokens: 0,
      };
    case "model-changed":
      return { ...state, model: action.model };
    case "turn-busy":
      return { ...state, turnBusy: action.busy };
  }
}

export function ChatApp({ client, agentId, agentName, initialThreadId, initialModel, inboxOpen }: ChatAppProps): React.ReactElement {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(reducer, {
    scrollback: [],
    streaming: "",
    renderedToolResults: new Set<string>(),
    turnBusy: false,
    threadId: initialThreadId,
    model: initialModel,
    totalUsdMicros: 0,
    totalBilledTokens: 0,
  });
  // Force-remount the uncontrolled <TextInput> when /clear rotates the
  // thread so its buffer wipes alongside the scrollback.
  const [inputKey, setInputKey] = useState(0);
  const [quitArmed, setQuitArmed] = useState(false);

  useEffect(() => {
    const sub = client.stream("tail", { type: "*" });
    let aborted = false;
    (async () => {
      try {
        for await (const ev of sub.events) {
          if (aborted) break;
          if (ev.threadId !== state.threadId) continue;
          dispatchTailEvent(ev, dispatch);
        }
      } catch {
        /* ipc closed — caller handles */
      }
    })();
    return () => {
      aborted = true;
      void sub.cancel().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.threadId]);

  useInput((input, key) => {
    // Ctrl-D = EOF / exit immediately. No confirm — that's the
    // shell convention every terminal user knows.
    if (key.ctrl && input === "d") {
      client.close();
      exit();
      return;
    }
    if (key.ctrl && input === "c") {
      if (state.turnBusy) {
        void client.call("chat.cancel", { threadId: state.threadId }).catch(() => {});
        return;
      }
      if (quitArmed) {
        client.close();
        exit();
        return;
      }
      // Guard: a held-down Ctrl-C would otherwise stack a fresh
      // 2s-disarm timeout on every keypress.
      if (quitArmed) return;
      setQuitArmed(true);
      setTimeout(() => setQuitArmed(false), 2000);
    }
  });

  async function onSubmit(text: string): Promise<void> {
    const trimmed = text.replace(/\s+$/, "");
    if (!trimmed) return;
    // @inkjs/ui's <TextInput> reducer has no submit case — the buffer
    // doesn't clear on its own. Force-remount on every submit so the
    // user can keep typing without staring at the previous message.
    setInputKey((k) => k + 1);
    if (trimmed.startsWith("/")) {
      const handled = await handleSlash(trimmed, {
        client,
        threadId: state.threadId,
        agentId,
        dispatch,
        exit,
        resetInput: () => setInputKey((k) => k + 1),
      });
      if (handled) return;
    }
    dispatch({ type: "user-submit", text: trimmed });
    dispatch({ type: "turn-busy", busy: true });
    try {
      await client.call("publish", {
        type: "chat.input",
        payload: { text: trimmed, extendTurn: state.turnBusy },
        actorId: "cli",
        durable: true,
        toAgentId: agentId,
        threadId: state.threadId,
      });
    } catch (e) {
      dispatch({ type: "error", text: `send failed: ${(e as Error).message}` });
    }
  }

  const barState: BarState = quitArmed ? "quit-armed" : state.turnBusy ? "busy" : "idle";
  const placeholder = state.turnBusy
    ? "type to fold into the running turn…"
    : "ask anything  (/ for commands, Ctrl-C to quit)";

  return (
    <Box flexDirection="column">
      <Static items={state.scrollback}>
        {(entry) => <MessageRow key={entry.id} entry={entry} />}
      </Static>
      {state.streaming.length > 0 && (
        <Box paddingLeft={3} paddingRight={1} flexDirection="column">
          {state.streaming.split("\n").map((line, i) => <Text key={i}>{line}</Text>)}
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        <StatusLine state={barState} quitArmed={quitArmed} />
        <InputFrame state={barState} inputKey={inputKey} placeholder={placeholder} onSubmit={onSubmit} />
        <StatusFooter
          agentName={agentName}
          model={state.model}
          inboxOpen={inboxOpen}
          threadId={state.threadId}
          totalBilledTokens={state.totalBilledTokens}
        />
      </Box>
    </Box>
  );
}

interface SlashContext {
  client: IpcClient;
  threadId: string;
  agentId: string;
  dispatch: React.Dispatch<Action>;
  exit: () => void;
  resetInput: () => void;
}

async function handleSlash(text: string, ctx: SlashContext): Promise<boolean> {
  const firstToken = text.split(/\s+/, 1)[0]!;
  const arg = text.slice(firstToken.length).trim();
  const cmd = firstToken.toLowerCase();
  if (cmd === "/exit" || cmd === "/quit") {
    ctx.client.close();
    ctx.exit();
    return true;
  }
  if (cmd === "/help") {
    ctx.dispatch({ type: "note", text: "/help · /clear · /new · /cancel · /model [name] · /exit" });
    return true;
  }
  if (cmd === "/clear" || cmd === "/new") {
    const newId = mintId("cli:");
    ctx.dispatch({ type: "thread-rotated", threadId: newId });
    ctx.resetInput();
    return true;
  }
  if (cmd === "/cancel") {
    await ctx.client.call("chat.cancel", { threadId: ctx.threadId }).catch(() => {});
    return true;
  }
  if (cmd === "/model") {
    if (arg) {
      try {
        const r = await ctx.client.call<{ model: string }>("model.set", { model: arg });
        ctx.dispatch({ type: "model-changed", model: r.model });
        ctx.dispatch({ type: "note", text: `default model → ${r.model}` });
      } catch (e) {
        ctx.dispatch({ type: "error", text: `model set: ${(e as Error).message}` });
      }
    } else {
      try {
        const r = await ctx.client.call<{ model: string }>("model.get");
        ctx.dispatch({ type: "note", text: `current model: ${r.model || "(unset)"}` });
      } catch (e) {
        ctx.dispatch({ type: "error", text: `model get: ${(e as Error).message}` });
      }
    }
    return true;
  }
  ctx.dispatch({ type: "note", text: `unknown command: ${firstToken}` });
  return true;
}

function dispatchTailEvent(ev: Event, dispatch: React.Dispatch<Action>): void {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const numFrom = (v: unknown): number => (typeof v === "number" ? v : 0);
  switch (ev.type) {
    case "chat.assistant-delta":
      dispatch({ type: "delta", text: String(p.text ?? "") });
      return;
    case "chat.assistant-text":
      dispatch({ type: "assistant-text", text: String(p.text ?? "") });
      return;
    case "chat.tool-call":
      dispatch({ type: "tool-call", name: String(p.name ?? "?"), input: p.input });
      return;
    case "chat.tool-result-live":
    case "chat.tool-result":
      dispatch({
        type: "tool-result",
        toolId: String(p.id ?? mintId("tool:")),
        content: String(p.content ?? ""),
        isError: Boolean(p.isError),
      });
      return;
    case "chat.api-retry":
      dispatch({
        type: "retry",
        attempt: numFrom(p.attempt),
        ...(typeof p.status === "number" && { status: p.status }),
        ...(typeof p.message === "string" && { message: p.message }),
      });
      return;
    case "chat.turn-end":
      dispatch({
        type: "turn-end",
        model: typeof p.model === "string" ? p.model : "",
        inputTokens: numFrom(p.inputTokens),
        outputTokens: numFrom(p.outputTokens),
        cacheReadTokens: numFrom(p.cacheReadTokens),
        cacheCreationTokens: numFrom(p.cacheCreationTokens),
        usdMicros: numFrom(p.usdMicros),
        stopReason: String(p.stopReason ?? ""),
      });
      return;
    case "chat.error":
      dispatch({ type: "error", text: String(p.error ?? "") });
      return;
    case "chat.cancelled":
      dispatch({ type: "cancelled" });
      return;
  }
}

