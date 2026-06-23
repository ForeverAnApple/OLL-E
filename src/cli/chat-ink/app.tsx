// Ink chat REPL. Subscribes to the daemon's tail stream, renders
// committed scrollback through <Static> (cheap rerender), and keeps a
// live region below for the in-progress assistant response. Ink owns
// the redraw loop — streaming deltas bump state and the terminal
// repaints, no manual cursor management.
//
// Connection lifecycle is owned here: the prop-supplied client is the
// initial connection; on socket drop we reconnect to `socketFile` with
// exponential backoff and resubscribe on the same threadId. Chat
// survives daemon restarts without losing scrollback.

import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useReducer, useRef, useState } from "react";
import type * as React from "react";
import type { IpcClient } from "../../ipc/client.ts";
import { connectIpc } from "../../ipc/client.ts";
import type { Event } from "../../bus/types.ts";
import { ScrollbackItem, TrayList, type ScrollbackEntry } from "./message.tsx";
import { InputFrame, StatusLine, type BarState } from "./input-bar.tsx";
import { StatusFooter } from "./status-footer.tsx";
import { mintEntryId, mintThreadId, mintToolId } from "./ids.ts";
import {
  SLASH_COMMANDS,
  exactCommand,
  inlineSuggestions,
} from "./commands.ts";
import {
  clipString,
  fmtAge,
  statusGlyph,
  type InboxRow,
} from "./format.ts";

/** Soft cap on the in-flight tray. Realistic exposure is low (you'd
 *  have to type past this many messages mid-turn), but capping avoids
 *  unbounded growth + slow re-renders if `chat.input-folded` never
 *  fires (daemon hang, partition). FIFO drop. */
const TRAY_MAX = 50;

export interface ChatAppProps {
  client: IpcClient;
  socketFile: string;
  agentId: string;
  agentName: string;
  initialThreadId: string;
  initialModel: string;
  inboxOpen: number;
}

type Action =
  | { type: "user-submit"; text: string }
  | { type: "enqueue-tray"; text: string }
  | { type: "drain-tray"; count: number }
  | { type: "discard-tray-last" }
  | { type: "delta"; text: string }
  | { type: "assistant-text"; text: string }
  | { type: "tool-call"; name: string; input: unknown }
  | { type: "tool-result"; content: string; isError: boolean }
  | { type: "note"; text: string }
  | { type: "error"; text: string }
  | { type: "retry"; attempt: number; status?: number; message?: string }
  | { type: "turn-end"; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; usdMicros: number; stopReason: string }
  | { type: "cancel-requested" }
  | { type: "cancelled" }
  | { type: "thread-rotated"; threadId: string }
  | { type: "model-changed"; model: string }
  | { type: "turn-busy"; busy: boolean }
  | { type: "inbox-count"; open: number };

interface ChatState {
  scrollback: ScrollbackEntry[];
  streaming: string;
  turnBusy: boolean;
  /** True between the user pressing Ctrl-C mid-turn and the daemon
   *  emitting the terminal event (chat.cancelled / chat.error /
   *  chat.turn-end). Drives the "cancelling…" spinner so the user
   *  sees the request landed instead of staring at an unchanged UI. */
  cancelling: boolean;
  threadId: string;
  model: string;
  inboxOpen: number;
  /** Mid-turn submits pinned above the input until the daemon emits
   *  `chat.input-folded` — at that point they drain FIFO into
   *  scrollback at the natural conversational slot. */
  tray: string[];
  /** Cumulative spend on this thread since REPL start (or last /clear). */
  totalUsdMicros: number;
  /** Cumulative billed tokens — in + out + cache_read + cache_write.
   *  Single number on purpose: separate breakdowns mislead more than
   *  they inform; the per-turn line still shows the breakdown. */
  totalBilledTokens: number;
}

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case "user-submit":
      return {
        ...state,
        scrollback: [...state.scrollback, { kind: "user", id: mintEntryId(), text: action.text }],
      };
    case "enqueue-tray": {
      const tray = [...state.tray, action.text];
      // FIFO-drop the oldest if we've blown the cap.
      return { ...state, tray: tray.length > TRAY_MAX ? tray.slice(-TRAY_MAX) : tray };
    }
    case "drain-tray": {
      const n = Math.min(Math.max(0, action.count), state.tray.length);
      if (n === 0) return state;
      const drained = state.tray.slice(0, n);
      const newEntries: ScrollbackEntry[] = drained.map((text) => ({
        kind: "user", id: mintEntryId(), text,
      }));
      return { ...state, tray: state.tray.slice(n), scrollback: [...state.scrollback, ...newEntries] };
    }
    case "discard-tray-last":
      // Publish failed mid-tray: drop the orphan we just enqueued so it
      // doesn't sit pinned forever pretending to be queued for the agent.
      return state.tray.length === 0 ? state : { ...state, tray: state.tray.slice(0, -1) };
    case "delta":
      return { ...state, streaming: state.streaming + action.text };
    case "assistant-text": {
      const text = action.text || state.streaming;
      const next: ScrollbackEntry[] = text.length > 0
        ? [...state.scrollback, { kind: "assistant", id: mintEntryId(), text }]
        : state.scrollback;
      return { ...state, scrollback: next, streaming: "" };
    }
    case "tool-call":
      return {
        ...state,
        scrollback: [...state.scrollback, { kind: "tool-call", id: mintEntryId(), name: action.name, input: action.input }],
      };
    case "tool-result":
      // Dedup happens before dispatch (see dispatchTailEvent), so this
      // arm always inserts.
      return {
        ...state,
        scrollback: [...state.scrollback, { kind: "tool-result", id: mintEntryId(), content: action.content, isError: action.isError }],
      };
    case "note":
      return { ...state, scrollback: [...state.scrollback, { kind: "note", id: mintEntryId(), text: action.text }] };
    case "error":
      return {
        ...state,
        scrollback: [...state.scrollback, { kind: "error", id: mintEntryId(), text: action.text }],
        streaming: "",
        turnBusy: false,
        cancelling: false,
      };
    case "retry":
      return {
        ...state,
        scrollback: [...state.scrollback, {
          kind: "retry",
          id: mintEntryId(),
          attempt: action.attempt,
          ...(action.status !== undefined && { status: action.status }),
          ...(action.message !== undefined && { message: action.message }),
        }],
      };
    case "turn-end": {
      // Stamp the entry with the **cumulative** USD at the close of
      // this turn (not the per-turn delta). Each turn line reads as a
      // checkpoint — "after turn N, you've spent $X total" — which is
      // the question the user actually asks. Per-turn cost is still
      // derivable as the delta from the previous turn entry.
      const cumulative = state.totalUsdMicros + action.usdMicros;
      const turnBilled =
        action.inputTokens + action.outputTokens + action.cacheReadTokens + action.cacheCreationTokens;
      return {
        ...state,
        scrollback: [...state.scrollback, {
          kind: "turn-end",
          id: mintEntryId(),
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
        cancelling: false,
        totalUsdMicros: cumulative,
        totalBilledTokens: state.totalBilledTokens + turnBilled,
      };
    }
    case "cancel-requested":
      // Idempotent — repeated Ctrl-C taps within the cancel window
      // shouldn't keep cloning state.
      return state.cancelling ? state : { ...state, cancelling: true };
    case "cancelled":
      return {
        ...state,
        scrollback: [...state.scrollback, { kind: "note", id: mintEntryId(), text: "(cancelled)" }],
        streaming: "",
        turnBusy: false,
        cancelling: false,
      };
    case "thread-rotated":
      return {
        ...state,
        threadId: action.threadId,
        scrollback: [],
        streaming: "",
        turnBusy: false,
        cancelling: false,
        tray: [],
        totalUsdMicros: 0,
        totalBilledTokens: 0,
      };
    case "model-changed":
      return { ...state, model: action.model };
    case "turn-busy":
      return { ...state, turnBusy: action.busy, cancelling: action.busy ? state.cancelling : false };
    case "inbox-count":
      // No-op guard — every /inbox call dispatches here; without the
      // guard the whole tree re-renders even when the count didn't move.
      return action.open === state.inboxOpen ? state : { ...state, inboxOpen: action.open };
  }
}

// --- Streaming smoothing ---------------------------------------------------
// The model emits tokens in bursts (network + SDK buffering), so rendering a
// delta the instant it arrives reveals text in lurches. Instead, deltas pool
// in a buffer and a fixed-cadence timer eases characters onto screen at a
// steady rate — display decoupled from arrival. The committed message is
// unaffected (it comes from the authoritative chat.assistant-text full text);
// this is purely the live preview's animation.
const STREAM_FPS = 35;
// Each tick release ~1/DIVISOR of the buffer, so a deep buffer (big burst)
// catches up fast while a near-empty one trickles — the tail eases out.
const STREAM_DRAIN_DIVISOR = 5;
// ...but always at least this many, so the last few chars don't crawl.
const STREAM_MIN_CHARS = 3;

export function ChatApp({ client: initialClient, socketFile, agentId, agentName, initialThreadId, initialModel, inboxOpen }: ChatAppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  // Width budget for scrollback rows. <Static> mounts each item as a detached
  // root that does NOT inherit the terminal-width constraint Ink applies to the
  // live tree, so flex rows inside a row (list items, blockquotes, the user/
  // tool gutters all use flexGrow) get no width to distribute, measure at
  // max-content, and bleed past the right edge on wide terminals. Pinning each
  // Static item to the terminal width restores the budget. Frozen at render
  // time, which matches Static semantics — committed scrollback never reflows.
  const cols = stdout?.columns ?? 80;
  const [state, dispatch] = useReducer(reducer, {
    scrollback: [],
    streaming: "",
    turnBusy: false,
    cancelling: false,
    threadId: initialThreadId,
    model: initialModel,
    inboxOpen,
    tray: [],
    totalUsdMicros: 0,
    totalBilledTokens: 0,
  });
  // Tool-result dedup: both chat.tool-result-live (UX) and chat.tool-result
  // (canonical/durable) carry the same tool_use id. Render whichever lands
  // first; suppress the other. Bounded by clear-on-turn-end since tool ids
  // are unique within a turn. Lives as a ref — never read by render.
  const toolDedupRef = useRef<Set<string>>(new Set());
  // Pending stream chars not yet eased onto screen. A ref, never read by
  // render — the timer below pulls from it and dispatches the actual delta.
  const pendingRef = useRef<string>("");
  // <TextInput> is uncontrolled — force-remount on submit/clear to wipe
  // its internal buffer.
  const [inputKey, setInputKey] = useState(0);
  const [quitArmed, setQuitArmed] = useState(false);
  // Mirror of the input buffer so the slash-completion pane sitting
  // *outside* the TextInput can react. The keystroke-rate re-render
  // is acceptable: it only re-runs <StatusLine> + <InputFrame> +
  // <StatusFooter>; <Static> doesn't replay committed scrollback.
  const [inputText, setInputText] = useState("");
  const clientRef = useRef<IpcClient>(initialClient);
  const threadIdRef = useRef(state.threadId);
  const quitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { threadIdRef.current = state.threadId; }, [state.threadId]);

  // Streaming smoothing pump: a fixed-cadence timer eases buffered stream
  // chars onto screen at a steady rate, decoupled from bursty token arrival.
  // Idle ticks (empty buffer) return early — no dispatch, no re-render.
  // `dispatch` from useReducer is stable, so this effect runs once.
  useEffect(() => {
    const tickMs = Math.round(1000 / STREAM_FPS);
    const id = setInterval(() => {
      const pending = pendingRef.current;
      if (pending.length === 0) return;
      const n = Math.min(
        pending.length,
        Math.max(STREAM_MIN_CHARS, Math.ceil(pending.length / STREAM_DRAIN_DIVISOR)),
      );
      pendingRef.current = pending.slice(n);
      dispatch({ type: "delta", text: pending.slice(0, n) });
    }, tickMs);
    return () => clearInterval(id);
  }, []);

  // Single long-lived loop: subscribe → drain events → on close, try to
  // reconnect (exponential backoff) → resubscribe. The AbortController
  // both signals shutdown (teardown / unmount) AND unblocks the in-
  // flight backoff sleep so the process exits promptly.
  useEffect(() => {
    const abortCtrl = new AbortController();
    const { signal } = abortCtrl;
    let activeSub: { cancel: () => Promise<void> } | null = null;

    async function reconnect(): Promise<IpcClient | null> {
      dispatch({ type: "note", text: "⟳ daemon disconnected — reconnecting…" });
      let backoff = 250;
      let attempt = 1;
      while (!signal.aborted) {
        try {
          const c = await connectIpc(socketFile);
          dispatch({ type: "note", text: "⟳ reconnected" });
          return c;
        } catch {
          // Only surface the first failure — subsequent retries during a
          // long outage stay silent so scrollback doesn't fill with
          // identical "⟳ retry in Xs" notes.
          if (attempt === 1) {
            dispatch({ type: "note", text: `⟳ retry in ${(backoff / 1000).toFixed(1)}s…` });
          }
          await abortableSleep(backoff, signal);
          backoff = Math.min(backoff * 2, 30_000);
          attempt++;
        }
      }
      return null;
    }

    (async () => {
      while (!signal.aborted) {
        let sub: { events: AsyncIterable<Event>; cancel(): Promise<void> };
        try {
          sub = clientRef.current.stream("tail", { type: "*" });
        } catch {
          // stream() throws when the socket is already closed; skip
          // the iterator and reconnect.
          const next = await reconnect();
          if (!next) break;
          clientRef.current = next;
          continue;
        }
        activeSub = sub;
        try {
          for await (const ev of sub.events) {
            if (signal.aborted) break;
            if (ev.threadId !== threadIdRef.current) continue;
            dispatchTailEvent(ev, dispatch, toolDedupRef.current, pendingRef);
          }
        } catch {
          // ipc closed mid-stream — fall through to reconnect.
        }
        if (signal.aborted) break;
        // Disconnect mid-turn never delivers chat.turn-end. Clear the
        // busy flag so the prompt re-fires after we resubscribe.
        dispatch({ type: "turn-busy", busy: false });
        const next = await reconnect();
        if (!next) break;
        clientRef.current = next;
      }
    })();

    return () => {
      abortCtrl.abort();
      if (activeSub) void activeSub.cancel().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (quitTimerRef.current) clearTimeout(quitTimerRef.current);
    };
  }, []);

  useInput((input, key) => {
    if (key.ctrl && input === "d") {
      teardown();
      return;
    }
    if (key.ctrl && input === "c") {
      if (state.turnBusy) {
        // Second Ctrl-C while a cancel is already in flight: the
        // daemon is slow or hung. Don't trap the user — force-quit.
        if (state.cancelling) {
          teardown();
          return;
        }
        dispatch({ type: "cancel-requested" });
        void clientRef.current.call("chat.cancel", { threadId: state.threadId }).catch(() => {});
        return;
      }
      if (quitArmed) {
        teardown();
        return;
      }
      setQuitArmed(true);
      // Replace any prior arm-timer — a held-down Ctrl-C should not
      // stack disarm timers.
      if (quitTimerRef.current) clearTimeout(quitTimerRef.current);
      quitTimerRef.current = setTimeout(() => {
        quitTimerRef.current = null;
        setQuitArmed(false);
      }, 2000);
    }
  });

  function teardown(): void {
    try { clientRef.current.close(); } catch { /* already gone */ }
    exit();
  }

  async function handleSlashLocal(text: string): Promise<boolean> {
    const cmd = exactCommand(text);
    if (!cmd) {
      const firstToken = text.split(/\s+/, 1)[0]!;
      dispatch({ type: "note", text: `unknown command: ${firstToken}` });
      return true;
    }
    const arg = text.slice(cmd.name.length).trim();
    const client = clientRef.current;
    switch (cmd.name) {
      case "/exit":
      case "/quit":
        teardown();
        return true;
      case "/help":
        dispatch({ type: "note", text: formatHelp() });
        return true;
      case "/clear":
      case "/new":
        // Cancel any in-flight turn first — wiping context shouldn't
        // leave a doomed turn running on the daemon. chat.* events on
        // the old threadId are dropped by the tail filter post-rotate.
        if (state.turnBusy) {
          await client.call("chat.cancel", { threadId: state.threadId }).catch(() => {});
        }
        toolDedupRef.current.clear();
        pendingRef.current = "";
        dispatch({ type: "thread-rotated", threadId: mintThreadId() });
        return true;
      case "/cancel":
        if (!state.turnBusy) {
          dispatch({ type: "note", text: "no agent turn in progress" });
          return true;
        }
        await client.call("chat.cancel", { threadId: state.threadId }).catch(() => {});
        return true;
      case "/model":
        await runModel(arg, client);
        return true;
      case "/inbox":
        await runInbox(arg, client);
        return true;
    }
    return true;
  }

  async function runModel(arg: string, client: IpcClient): Promise<void> {
    if (arg) {
      try {
        const r = await client.call<{ model: string }>("model.set", { model: arg });
        dispatch({ type: "model-changed", model: r.model });
        dispatch({ type: "note", text: `default model → ${r.model}` });
      } catch (e) {
        dispatch({ type: "error", text: `model set: ${(e as Error).message}` });
      }
      return;
    }
    try {
      const r = await client.call<{ model: string }>("model.get");
      dispatch({ type: "note", text: `current model: ${r.model || "(unset)"}` });
    } catch (e) {
      dispatch({ type: "error", text: `model get: ${(e as Error).message}` });
    }
  }

  async function runInbox(arg: string, client: IpcClient): Promise<void> {
    if (arg) {
      try {
        const r = await client.call<InboxRow>("inbox.get", { id: arg });
        dispatch({ type: "note", text: formatInboxOne(r) });
      } catch (e) {
        dispatch({ type: "error", text: `inbox: ${(e as Error).message}` });
      }
      return;
    }
    try {
      const rows = await client.call<InboxRow[]>("inbox.list");
      dispatch({ type: "inbox-count", open: rows.filter((r) => r.status === "open").length });
      if (rows.length === 0) {
        dispatch({ type: "note", text: "(inbox zero — nothing waiting for you)" });
        return;
      }
      dispatch({ type: "note", text: formatInboxList(rows) });
    } catch (e) {
      dispatch({ type: "error", text: `inbox: ${(e as Error).message}` });
    }
  }

  async function onSubmit(text: string): Promise<void> {
    const trimmed = text.replace(/\s+$/, "");
    if (!trimmed) return;
    // @inkjs/ui's <TextInput> reducer has no submit case — bump the
    // remount key and clear the mirror so the next render is fresh.
    setInputKey((k) => k + 1);
    setInputText("");
    if (trimmed.startsWith("/")) {
      const handled = await handleSlashLocal(trimmed);
      if (handled) return;
    }
    // Snapshot the busy state before mutating — `extendTurn` is true
    // only when the user submitted while the previous turn was still
    // running, which is what the daemon uses to fold the message into
    // the in-flight turn instead of queuing fresh.
    const wasBusy = state.turnBusy;
    if (wasBusy) {
      // Park in the tray. Scrollback commit waits for `chat.input-
      // folded` — at that point the message has graduated from
      // "queued, unread" to "part of the conversation."
      dispatch({ type: "enqueue-tray", text: trimmed });
    } else {
      dispatch({ type: "user-submit", text: trimmed });
      dispatch({ type: "turn-busy", busy: true });
    }
    try {
      await clientRef.current.call("publish", {
        type: "chat.input",
        payload: { text: trimmed, extendTurn: wasBusy },
        actorId: "cli",
        durable: true,
        toAgentId: agentId,
        threadId: state.threadId,
      });
    } catch (e) {
      // The publish never reached the daemon, so the tray entry we
      // just parked would otherwise sit pinned forever pretending to
      // be queued. Drop it before reporting the failure.
      if (wasBusy) dispatch({ type: "discard-tray-last" });
      dispatch({ type: "error", text: `send failed: ${(e as Error).message}` });
    }
  }

  const barState: BarState = quitArmed
    ? "quit-armed"
    : state.cancelling
      ? "cancelling"
      : state.turnBusy
        ? "busy"
        : "idle";
  const placeholder = state.cancelling
    ? "cancelling…"
    : state.turnBusy
      ? "type to fold into the running turn…"
      : "ask anything  (/ for commands, Ctrl-C to quit)";
  const suggestions = inlineSuggestions(inputText);

  return (
    <Box flexDirection="column">
      <Static items={state.scrollback}>
        {(entry) => <ScrollbackItem key={entry.id} entry={entry} width={cols} />}
      </Static>
      {state.streaming.length > 0 && (
        <Box marginTop={1} paddingLeft={3} paddingRight={2} flexDirection="column">
          {state.streaming.split("\n").map((line, i) => <Text key={i}>{line}</Text>)}
        </Box>
      )}
      {state.tray.length > 0 && <TrayList items={state.tray} />}
      <Box marginTop={1} flexDirection="column">
        <StatusLine state={barState} quitArmed={quitArmed} input={inputText} />
        <InputFrame
          state={barState}
          inputKey={inputKey}
          placeholder={placeholder}
          suggestions={suggestions}
          onChange={setInputText}
          onSubmit={onSubmit}
        />
        <StatusFooter
          agentName={agentName}
          model={state.model}
          inboxOpen={state.inboxOpen}
          totalBilledTokens={state.totalBilledTokens}
          totalUsdMicros={state.totalUsdMicros}
        />
      </Box>
    </Box>
  );
}

/** Sleep that resolves on either timeout or abort. Without the abort
 *  hook, an unmount during the reconnect backoff would keep the
 *  process alive for up to 30s while the timer ran down. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = (): void => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function formatHelp(): string {
  const nameW = SLASH_COMMANDS.reduce((w, c) => Math.max(w, c.name.length), 0);
  return SLASH_COMMANDS
    .map((c) => `  ${c.name.padEnd(nameW)}  ${c.description}`)
    .join("\n");
}

function formatInboxList(rows: InboxRow[]): string {
  const now = Date.now();
  const lines = rows.slice(0, 10).map((r) => {
    const id = r.id.slice(0, 10);
    const age = fmtAge(Math.max(0, now - r.createdAt));
    const unread = (r.unreadReplyCount ?? 0) > 0 ? ` (${r.unreadReplyCount} new)` : "";
    const from = r.proposingAgentName ?? r.proposingAgentId.slice(0, 8);
    return `  ${statusGlyph(r.status)} ${id}  ${r.tier.padEnd(11)}  ${age.padStart(4)}  ${from} — ${r.summary}${unread}`;
  });
  const more = rows.length > 10 ? `\n  … +${rows.length - 10} more — \`olle inbox list\`` : "";
  return `inbox (${rows.length}):\n${lines.join("\n")}${more}`;
}

function formatInboxOne(r: InboxRow): string {
  const age = fmtAge(Math.max(0, Date.now() - r.createdAt));
  const from = r.proposingAgentName ?? r.proposingAgentId.slice(0, 8);
  return [
    `${statusGlyph(r.status)} ${r.id}  ${r.tier}  ${age} ago  ${from}`,
    `  ${r.summary}`,
    r.payload ? `  payload: ${clipString(JSON.stringify(r.payload), 280)}` : "",
    `  respond: olle inbox respond ${r.id} approve|deny|modify`,
  ].filter(Boolean).join("\n");
}

function dispatchTailEvent(
  ev: Event,
  dispatch: React.Dispatch<Action>,
  toolDedup: Set<string>,
  pending: { current: string },
): void {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const numFrom = (v: unknown): number => (typeof v === "number" ? v : 0);
  switch (ev.type) {
    case "chat.assistant-delta":
      // Pool the delta; the smoothing timer eases it onto screen. No dispatch
      // here, so bursty arrival doesn't drive bursty rendering.
      pending.current += String(p.text ?? "");
      return;
    case "chat.assistant-text":
      // Turn's text is final and authoritative — drop any unrevealed buffer
      // (it's all in this full text) and commit.
      pending.current = "";
      dispatch({ type: "assistant-text", text: String(p.text ?? "") });
      return;
    case "chat.tool-call":
      dispatch({ type: "tool-call", name: String(p.name ?? "?"), input: p.input });
      return;
    case "chat.tool-result-live":
    case "chat.tool-result": {
      const id = String(p.id ?? mintToolId());
      if (toolDedup.has(id)) return;
      toolDedup.add(id);
      dispatch({
        type: "tool-result",
        content: String(p.content ?? ""),
        isError: Boolean(p.isError),
      });
      return;
    }
    case "chat.input-folded": {
      const count = numFrom(p.count);
      if (count > 0) dispatch({ type: "drain-tray", count });
      return;
    }
    case "chat.api-retry":
      dispatch({
        type: "retry",
        attempt: numFrom(p.attempt),
        ...(typeof p.status === "number" && { status: p.status }),
        ...(typeof p.message === "string" && { message: p.message }),
      });
      return;
    case "chat.turn-end":
      toolDedup.clear();
      pending.current = "";
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
      pending.current = "";
      dispatch({ type: "error", text: String(p.error ?? "") });
      return;
    case "chat.cancelled":
      toolDedup.clear();
      pending.current = "";
      dispatch({ type: "cancelled" });
      return;
  }
}
