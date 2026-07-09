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
// Replies (chat.assistant-text, chat.tool-call, chat.tool-result-live,
// chat.tool-result, chat.turn-end) carry the same threadId so bridges
// route them back. The two-tier tool-result events mirror the
// assistant-delta / assistant-text split: `*-live` is the UX surface
// that fires the moment a tool finishes (non-durable, may differ from
// canonical when aggregate-budget truncation kicks in); the bare
// `chat.tool-result` is the canonical, durable, post-truncation form.
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
import type { Llm, Message, ReasoningEffort, SystemSegment } from "../llm/index.ts";
import type { ToolDef } from "../extensions/types.ts";
import { askUp, type Inbox } from "../inbox/index.ts";
import { checkTool } from "../permissions/index.ts";
import type { AgentScope } from "../store/schema.ts";
import { tables } from "../store/index.ts";
import { and, eq } from "drizzle-orm";
import { loadIdentity, loadPrinciples, renderSoul } from "../memory/principles.ts";
import { renderToolCatalog } from "./catalog.ts";
import { buildLoadoutTools, markLoaded, type LoadResultEntry } from "../tools/loadout.ts";
import {
  createTruncationState,
  DEFAULT_MAX_MESSAGE_BYTES,
  DEFAULT_MAX_RESULT_BYTES,
  type TruncationState,
} from "./tool-truncate.ts";
import { runAgent, type AgentStep } from "./runtime.ts";
import {
  buildRedactionMap,
  mergeRedactionMap,
  redactInput,
  redactMessages,
  scrubSecrets,
} from "./redaction.ts";
import { getSecretsProvider } from "./secrets-provider.ts";
import { listStarters } from "../starters/index.ts";

export interface AgentLoopOptions {
  bus: EventBus;
  store: Store;
  hostId: string;
  llm: Llm;
  system?: string | (() => string | undefined);
  /** The agent whose mailbox we're draining. */
  agentId: string;
  /** Extension runtime — loop exposes extension-owned tools alongside
   *  core tools. */
  extensions?: ExtensionHost;
  /** Core/meta tools injected by the host. */
  coreTools?: ToolDef[];
  /** Optional ledger for spend accounting. */
  ledger?: Ledger;
  /** Owner-agent id (typically the human) for budget enforcement and
   *  inbox routing on denied calls. Post-LOG 2026-04-23 collapse. */
  ownerAgentId?: string;
  /** Inbox used when a tool call is denied by scope — we auto-propose a
   *  grant_scope via askUp. */
  inbox?: Inbox;
  /** Static model override — used as the fallback when `resolveModel` is
   *  absent (child loops, tests). Prefer `resolveModel` for the live,
   *  per-thread path. */
  model?: string;
  /** Static reasoning-effort fallback — see `resolveEffort`. */
  effort?: ReasoningEffort;
  /** Live model resolver, called once per thread when that thread is first
   *  created, and frozen onto the thread for its life. This is what makes a
   *  `set_thinking_model` switch apply without a daemon restart: active
   *  threads keep the model they started with (cache stays warm, no
   *  mid-conversation swap), and the next NEW thread resolves the freshly
   *  written preference. Falls back to `model` when omitted. */
  resolveModel?: () => string | undefined;
  /** Live reasoning-effort resolver — same per-thread-freeze semantics as
   *  `resolveModel`. Falls back to `effort` when omitted. */
  resolveEffort?: () => ReasoningEffort | undefined;
  /** Root directory for per-thread message snapshots. Per agent, per
   *  thread. Omit to disable persistence. */
  threadsDir?: string;
  /** Host secrets dir. When set, tool results are scrubbed of any exact
   *  secret VALUE before they enter history / snapshots / the
   *  chat.tool-result event (see scrubSecrets). Omit to disable scrubbing
   *  (tests that don't touch secrets). */
  secretsDir?: string;
  /** Debounce window for mail wake (ms). Override in tests; default
   *  MAIL_WAKE_DEBOUNCE_MS. Set to 0 to fire synchronously per event
   *  (useful in tests that don't want to await timers). */
  mailWakeDebounceMs?: number;
  /** Tool-result truncation hooks. When supplied, oversize tool outputs
   *  spill to the durable handle returned by `persist`; the runtime keeps
   *  per-thread state stable so replays produce byte-identical previews
   *  (preserving the prompt cache prefix). Omit in tests that don't care. */
  toolTruncate?: {
    persist(input: { id: string; threadId: string; toolName: string; content: string }): void;
    maxBytesPerCall?: number;
    maxBytesPerMessage?: number;
  };
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
  /** Active turn's abort controller. Set when a turn starts; cleared on
   *  end. `cancel(threadId)` on the loop fires this so the LLM stream
   *  aborts at network level and the turn returns control to the user
   *  without burning the rest of the round-trip budget. */
  activeAbort?: AbortController;
  /** Mid-turn user mailbox. `chat.input` events that land while the
   *  thread already has a turn in flight queue here instead of in
   *  `pending` — runAgent drains this between round-trips so the new
   *  message reaches the model on its next LLM call rather than
   *  waiting for the whole turn to finish. The inverse of "humans are
   *  events": the agent is also expected to keep listening. */
  inFlightInbox: string[];
  /** Tool names whose schemas the agent has pulled into context for this
   *  thread. Mutated by load_tools / unload_tools meta-tools. Always-
   *  loaded tools are not tracked here — they're sent every turn
   *  regardless. Per-thread runtime state, not persisted. */
  loadedTools: Set<string>;
  /** Stable replacement state for the tool-result truncator. Once a
   *  tool_use_id has been spilled, every later rendering of that block
   *  uses the byte-identical preview from this map — without it the
   *  prefix would invalidate every turn the conversation rehydrates. */
  truncationState: TruncationState;
  /** Per-thread high-water mark for "decision resolutions you haven't
   *  seen on this thread" (LOG 2026-04-27). Per-thread (not per-loop) so
   *  the agent's processing turn on `mailbox:<agentId>` advancing its
   *  own HWM does not ack the resolution for the user-facing chat thread.
   *  Initialized to the loop's start time on first touch; restart resets. */
  mailHwm: number;
  /** Model + reasoning-effort frozen at thread creation. A live
   *  `set_thinking_model` / `set_reasoning_effort` switch is picked up by the
   *  next NEW thread; this thread keeps what it started with for its whole
   *  life (no mid-conversation model swap, prompt cache stays warm). Per-
   *  thread runtime state, re-resolved on restart. */
  model?: string;
  effort?: ReasoningEffort;
}

export interface AgentLoop {
  stop(): void;
  threads(): string[];
  /** Abort the in-flight turn for `threadId`, if any. Returns true if a
   *  turn was running and was signalled to abort; false if no active turn
   *  was found. The turn's chat.error event lands on the bus once the
   *  cancellation propagates through the LLM stream. */
  cancel(threadId: string): boolean;
}

/** Per-agent stable thread id where mail-wake notes are delivered. The
 *  agent's loop subscribes to `decision.resolved` (LOG 2026-04-26) where it
 *  was the proposer; on fire (debounced), a synthetic `chat.input` is
 *  injected on this thread so the agent reads "you have replies" as input
 *  and can decide what to do. The thread is stable so context accumulates
 *  across mail interactions without spawning a new thread per ping; mail
 *  exchanges are short so bloat is bounded. */
export function mailboxThreadId(agentId: string): string {
  return `mailbox:${agentId}`;
}

/** Quiet window for collapsing a burst of `decision.resolved` events into a
 *  single wake. Tuned to amortize the case where a parent's many children
 *  finish near-simultaneously without making the agent feel sluggish for
 *  one-off replies. */
const MAIL_WAKE_DEBOUNCE_MS = 2_000;

export function startAgentLoop(opts: AgentLoopOptions): AgentLoop {
  const threads = new Map<string, Thread>();
  const agentDir = opts.threadsDir
    ? join(opts.threadsDir, sanitizeId(opts.agentId))
    : undefined;
  if (agentDir) mkdirSync(agentDir, { recursive: true });

  // Loop-start timestamp seeds each new thread's per-thread mailHwm so
  // we don't dump pre-existing history on a thread's first turn after
  // boot. Per-thread (not per-loop) so the agent's mailbox-thread
  // processing of a wake doesn't ack the resolution for the user-facing
  // chat thread (LOG 2026-04-27). Restart resets — pull surface
  // mail_list({direction:"out", includeResolved:true}) is the durable audit.
  const loopStartMs = Date.now();

  function getOrCreate(id: string): Thread {
    let t = threads.get(id);
    if (t) return t;
    const loaded = agentDir ? tryLoadThread(agentDir, id) : null;
    t = {
      id,
      messages: loaded ?? [],
      pending: [],
      pendingOrigin: [],
      inFlightInbox: [],
      // Seed with every active extension's contributed tools. An installed,
      // registered extension is a capability the agent already chose with
      // intent to use; making a fresh thread re-guess or re-load_tools its
      // schema every session is the same papercut register-auto-load deletes.
      // These land in the separately-cached tools block, so they don't
      // invalidate the identity prefix. Core deferred tools stay name-only —
      // they're occasional reaches, not installed capabilities.
      loadedTools: seedExtensionTools(opts.extensions),
      truncationState: createTruncationState(),
      mailHwm: loopStartMs,
      // Freeze model + effort at thread birth. New threads created after a
      // self-switch resolve the new values; existing threads are untouched.
      model: opts.resolveModel ? opts.resolveModel() : opts.model,
      effort: opts.resolveEffort ? opts.resolveEffort() : opts.effort,
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
    // The publisher signals "I typed this while the agent was mid-turn
    // and I want it folded in" via `extendTurn: true`. When a turn is
    // actually in flight on this thread, route to the in-flight inbox
    // so runAgent picks it up at its next round-trip boundary. Without
    // the flag (or when the turn has already ended) we fall through to
    // the normal `pending` queue — three sequential publishes from a
    // batch script become three turns, not one mega-turn.
    const extendTurn = (ev.payload as { extendTurn?: boolean })?.extendTurn === true;
    if (extendTurn && thread.activeAbort) {
      thread.inFlightInbox.push(p.text);
      return;
    }
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

  // Mail wake — subscribe to decision.resolved where this agent was the
  // proposer, debounce a burst into one synthetic chat.input on the
  // agent's stable mailbox thread. Pull-side (mail_list) still works any
  // time; this is the push-side that wakes idle agents whose proposals
  // got an answer (LOG 2026-04-26).
  const debounceMs = opts.mailWakeDebounceMs ?? MAIL_WAKE_DEBOUNCE_MS;
  let mailPending: { count: number; ids: string[] } = { count: 0, ids: [] };
  let mailTimer: ReturnType<typeof setTimeout> | undefined;
  const flushMailWake = () => {
    mailTimer = undefined;
    const { count, ids } = mailPending;
    mailPending = { count: 0, ids: [] };
    if (count === 0) return;
    const noun = count === 1 ? "reply" : "replies";
    const text = `📬 ${count} ${noun} to your proposal${count === 1 ? "" : "s"} — call mail_list({direction:"out", includeResolved:true}) to read.`;
    opts.bus.publish({
      type: "chat.input",
      hostId: opts.hostId,
      actorId: opts.hostId,
      durable: true,
      toAgentId: opts.agentId,
      threadId: mailboxThreadId(opts.agentId),
      payload: { text, mailWake: true, decisionIds: ids },
    });
  };
  const unsubMail = opts.bus.subscribe("decision.resolved", (ev) => {
    const p = ev.payload as { proposingAgentId?: string; decisionId?: string } | undefined;
    if (!p || p.proposingAgentId !== opts.agentId) return;
    mailPending.count += 1;
    if (p.decisionId) mailPending.ids.push(p.decisionId);
    if (debounceMs <= 0) {
      flushMailWake();
      return;
    }
    if (mailTimer) clearTimeout(mailTimer);
    mailTimer = setTimeout(flushMailWake, debounceMs);
  });

  return {
    stop: () => {
      unsub();
      unsubMail();
      if (mailTimer) {
        clearTimeout(mailTimer);
        mailTimer = undefined;
      }
    },
    threads: () => [...threads.keys()],
    cancel: (threadId: string) => {
      const t = threads.get(threadId);
      if (!t || !t.activeAbort) return false;
      t.activeAbort.abort(new Error("cancelled by user"));
      return true;
    },
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
  const turnAbort = new AbortController();
  thread.activeAbort = turnAbort;
  try {
    // Core tools wrapped per-turn so register_extension's auto-load
    // closure binds this thread's loadedTools.
    const wrappedCore = (opts.coreTools ?? []).map((t) =>
      t.name === "register_extension" && opts.extensions
        ? wrapRegisterForAutoLoad(t, {
            loadedTools: thread.loadedTools,
            extensions: opts.extensions,
          })
        : t,
    );
    const loadoutTools = buildLoadoutTools({
      loadedTools: thread.loadedTools,
      allTools: () => getTools(),
    });
    // Live tool surface — re-read on every round-trip so a mid-turn
    // register/unload becomes visible on the very next call (both in the
    // LLM's tool list and in dispatch). The catalog rendered into the
    // system prefix uses the turn-start snapshot below; that is on
    // purpose — invalidating the cached prefix mid-turn would defeat the
    // cache architecture.
    const getTools = (): ToolDef[] => {
      const out: ToolDef[] = [...wrappedCore];
      if (opts.extensions) {
        for (const { extensionId, tool } of opts.extensions.tools()) {
          out.push(wrapExtensionTool(tool, extensionId));
        }
      }
      out.push(...loadoutTools);
      return out;
    };
    const turnStartTools = getTools();
    // Hot-reload pruning: if an extension was unloaded since last turn and
    // its tool was in this thread's loaded set, drop the entry silently
    // and emit a warning event. Otherwise the agent's loaded list lies.
    pruneOrphanLoaded(thread, turnStartTools, opts, origin);
    const redactions = buildRedactionMap(turnStartTools);
    const refreshRedactions = () => mergeRedactionMap(redactions, getTools());
    const redactToolInput = (name: string, input: unknown) => {
      refreshRedactions();
      const fields = redactions.get(name);
      return fields ? redactInput(input, fields) : input;
    };
    const scope = loadAgentScope(opts.store, opts.agentId);
    const grantProposed = new Set<string>();
    // SOUL block — identity (who you are) + principles (your strict
    // commitments), injected at turn start instead of retrieved
    // (openclaw SOUL pattern adapted to one-surface memory — LOG
    // 2026-04-23, extended for identity by LOG 2026-04-28 soul-seeding).
    // Identity renders first so the agent reads its own name before its
    // commitments. Stable sort keeps prompt caches warm across turns
    // with no changes.
    const principleBlock = renderSoul(
      loadIdentity(opts.store, opts.agentId),
      loadPrinciples(opts.store, opts.agentId),
    );
    // Tool catalog — pure function of the registered tool set, rendered
    // into the stable identity segment so the agent reads "what exists"
    // alongside its principles. Per-thread loaded state is encoded in
    // the tools block (which the LLM provider caches separately), NOT
    // in this catalog text — the catalog must stay stable across
    // load_tools calls within a thread or it'll invalidate the prefix.
    const catalogBlock = renderToolCatalog(turnStartTools, listStarters());
    // Mailbox sidebar — situational awareness block appended to the
    // system prompt each turn. Two sections:
    //   1. Other threads with activity (delegation cue).
    //   2. Resolved proposals this agent hasn't seen yet (LOG 2026-04-27).
    // The wake on `mailbox:<agentId>` covers idle resolutions; this
    // section closes the loop on whichever thread the agent next runs a
    // turn on. Ack is delayed until after the paid turn returns, so a
    // budget wall or LLM failure does not mark unread mail as seen.
    const sidebar = buildMailboxSidebar(allThreads, thread, opts.inbox, opts.agentId);
    // Structured system prompt with the cache breakpoint between stable
    // (base + principles + catalog) and volatile (sidebar) segments.
    const systemSegments = composeSystemSegments(
      typeof opts.system === "function" ? opts.system() : opts.system,
      principleBlock,
      catalogBlock,
      sidebar.text,
    );
    const budgetBlock = paidBudgetBlock(opts, thread.id, origin);
    if (budgetBlock) {
      if (agentDir) saveThread(agentDir, thread, redactions);
      return;
    }
    const result = await runAgent({
      llm: opts.llm,
      model: thread.model,
      effort: thread.effort,
      system: systemSegments,
      getTools,
      isLoaded: (name) => thread.loadedTools.has(name),
      toolCtx: {
        hostId: opts.hostId,
        // Empty-string sentinel = "this call is from a core tool, not
        // an extension." Extension-contributed tools are wrapped by
        // wrapExtensionTool() to inject their real extensionId at execute
        // time; this default only ever reaches a core tool.
        extensionId: "",
        actorId: opts.agentId,
        // Same signal as runAgent's `signal`: a single user-cancel fires
        // both the LLM stream abort and any in-flight tool that respects it.
        abort: turnAbort.signal,
        secrets: {},
      },
      signal: turnAbort.signal,
      messages: thread.messages,
      mailbox: () => {
        // runAgent calls this between round-trips. Drain the in-flight
        // inbox into Message[] so the next LLM hop sees any user input
        // that landed since the last drain. Splice (not slice) so a
        // second call in the same turn doesn't replay messages.
        if (thread.inFlightInbox.length === 0) return [];
        const drained = thread.inFlightInbox.splice(0);
        // Tell observers (CLI tray, future bridges) which messages
        // just got folded into the running turn so a "queued"
        // visual indicator can transition into scrollback at the
        // correct conversational position. Non-durable: this is UX
        // signalling, not a record-of-what-happened — the original
        // chat.input events are durable and carry the canonical text.
        opts.bus.publish({
          type: "chat.input-folded",
          hostId: opts.hostId,
          actorId: opts.agentId,
          parentEventId: origin.id,
          threadId: thread.id,
          durable: false,
          payload: { count: drained.length },
        });
        // The thread.messages array is mutated by runAgent through the
        // shared reference, so injecting here also keeps the durable
        // snapshot consistent — the post-turn `thread.messages =
        // result.messages` assignment captures whichever messages the
        // model actually saw.
        return drained.map((text) => ({ role: "user" as const, content: text }));
      },
      truncate: opts.toolTruncate
        ? {
            state: thread.truncationState,
            maxBytesPerCall: opts.toolTruncate.maxBytesPerCall ?? DEFAULT_MAX_RESULT_BYTES,
            maxBytesPerMessage:
              opts.toolTruncate.maxBytesPerMessage ?? DEFAULT_MAX_MESSAGE_BYTES,
            persist: ({ id, toolName, content }) =>
              opts.toolTruncate!.persist({
                id,
                threadId: thread.id,
                toolName,
                content,
              }),
          }
        : undefined,
      // Value-level secret scrubbing. Reads the live secret set (mtime-
      // cached) each result so a mid-session set_secret is honored; runs
      // before truncation in the runtime so spilled rows are scrubbed too.
      scrubResult: opts.secretsDir
        ? (content) => scrubSecrets(content, getSecretsProvider(opts.secretsDir!)())
        : undefined,
      onStep: (step) => emitStep(opts, thread.id, origin, step, redactToolInput),
      authorize: (tool) =>
        checkTool(scope, { name: tool.name, tier: tool.tier ?? "operational" }),
      onDenied: ({ tool, reason, input }) => {
        const safeInput = redactToolInput(tool.name, input);
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
            input: safeInput,
          },
        });
        if (!opts.inbox || !opts.ownerAgentId) {
          // Misconfig: scope check denied a call but there's no inbox /
          // owner-agent wired, so the agent can't ask-up for a grant.
          // Distinct event type so chat-health doesn't count it as a
          // chat outage and the CLI doesn't treat it as turn-terminal.
          opts.bus.publish({
            type: "tool.misconfig",
            hostId: opts.hostId,
            actorId: opts.agentId,
            parentEventId: origin.id,
            threadId: thread.id,
            durable: true,
            payload: {
              error:
                "tool denied and ask-up unavailable — no inbox/owner-agent configured for this agent",
              tool: tool.name,
              tier: tool.tier ?? "operational",
              reason,
              hasInbox: Boolean(opts.inbox),
              hasOwnerAgent: Boolean(opts.ownerAgentId),
            },
          });
          return;
        }
        if (grantProposed.has(tool.name)) return;
        grantProposed.add(tool.name);
        // Resolve agent name for the summary so the principal sees a
        // human label, not a ULID. The store is authoritative; if the
        // row is gone we fall back to the id. Self-chosen handle wins
        // over the formal `name` so the principal reads the social
        // label the agent itself uses.
        const agentRow = opts.store
          .select({
            name: tables.agents.name,
            displayName: tables.agents.displayName,
          })
          .from(tables.agents)
          .where(eq(tables.agents.id, opts.agentId))
          .all()[0];
        const agentLabel =
          agentRow?.displayName?.trim() || agentRow?.name || opts.agentId;
        askUp(
          { bus: opts.bus, store: opts.store, hostId: opts.hostId, inbox: opts.inbox },
          {
            proposingAgentId: opts.agentId,
            ownerAgentId: opts.ownerAgentId,
            tier: "strategic",
            summary: `grant ${agentLabel} permission to call ${tool.name}(${summarizeInputArgs(safeInput)})`,
            payload: {
              action: "grant_scope",
              agentId: opts.agentId,
              agentName: agentLabel,
              tool: tool.name,
              toolDescription: tool.description,
              tier: tool.tier ?? "operational",
              input: safeInput,
              threadId: thread.id,
              reason,
            },
          },
        );
      },
    });
    if (sidebar.mailHwmAfterRead != null) {
      thread.mailHwm = Math.max(thread.mailHwm, sidebar.mailHwmAfterRead);
    }
    thread.messages = result.messages;
    let recorded: { usdMicros: number } | undefined;
    if (opts.ledger && result.totalUsage.totalTokens > 0) {
      recorded = opts.ledger.record({
        actorId: opts.agentId,
        threadId: thread.id,
        ownerAgentId: opts.ownerAgentId,
        provider: opts.llm.provider,
        model: thread.model ?? opts.llm.defaultModel,
        inputTokens: result.totalUsage.inputTokens,
        outputTokens: result.totalUsage.outputTokens,
        cacheReadTokens: result.totalUsage.cacheReadInputTokens,
        cacheCreationTokens: result.totalUsage.cacheCreationInputTokens,
      });
    }
    // Commit snapshot before announcing turn-end so subscribers reacting
    // to the event can rely on disk state being current. Sensitive tool
    // inputs (e.g. set_secret value) are redacted from the persisted form.
    refreshRedactions();
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
        model: thread.model ?? opts.llm.defaultModel,
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
    const cancelled =
      turnAbort.signal.aborted ||
      (err as { name?: string })?.name === "AbortError" ||
      /cancelled by user|aborted/i.test((err as Error)?.message ?? "");
    opts.bus.publish({
      type: cancelled ? "chat.cancelled" : "chat.error",
      hostId: opts.hostId,
      actorId: opts.agentId,
      parentEventId: origin.id,
      threadId: thread.id,
      durable: true,
      payload: {
        error: cancelled ? "cancelled by user" : (err as Error).message,
      },
    });
  } finally {
    if (thread.activeAbort === turnAbort) thread.activeAbort = undefined;
    // Race window: a `chat.input` could have landed between runAgent's
    // last mailbox drain and us clearing activeAbort. Anything still
    // sitting in the in-flight inbox at this point would be lost
    // unless we promote it back to `pending`, where the drain loop
    // will pick it up as the start of a fresh turn. Origin is reused
    // from the closing turn — there's no per-message origin event for
    // the in-flight queue and reusing keeps causal chains pointing at
    // a real, durable parent. Emit `chat.input-folded` too so the
    // CLI tray (which has been pinning these messages as "queued")
    // knows to commit them into scrollback now — they're about to
    // run as their own turn rather than getting folded into this
    // one, but from the user's standpoint they've graduated from
    // "agent hasn't seen this" either way.
    if (thread.inFlightInbox.length > 0) {
      const stranded = thread.inFlightInbox.splice(0);
      thread.pending.push(...stranded);
      for (let i = 0; i < stranded.length; i++) thread.pendingOrigin.push(origin);
      opts.bus.publish({
        type: "chat.input-folded",
        hostId: opts.hostId,
        actorId: opts.agentId,
        parentEventId: origin.id,
        threadId: thread.id,
        durable: false,
        payload: { count: stranded.length, stranded: true },
      });
    }
  }
}

function paidBudgetBlock(opts: AgentLoopOptions, threadId: string, origin: Event): boolean {
  if (!opts.ownerAgentId) return false;
  const rows = opts.store
    .select()
    .from(tables.budgets)
    .where(
      and(
        eq(tables.budgets.ownerAgentId, opts.ownerAgentId),
        eq(tables.budgets.agentId, opts.agentId),
      ),
    )
    .all();
  const blocked = rows.find((b) => {
    const usdBlocked = b.capUsd != null && b.spentUsd >= b.capUsd;
    const tokenBlocked = b.capTokens != null && b.spentTokens >= b.capTokens;
    return usdBlocked || tokenBlocked;
  });
  if (!blocked) return false;

  const reason =
    blocked.capUsd != null && blocked.spentUsd >= blocked.capUsd
      ? `USD budget exhausted for period ${blocked.period}`
      : `token budget exhausted for period ${blocked.period}`;
  opts.bus.publish({
    type: "chat.error",
    hostId: opts.hostId,
    actorId: opts.agentId,
    parentEventId: origin.id,
    threadId,
    durable: true,
    payload: { error: `${reason}; paid LLM work paused until the cap is raised` },
  });
  opts.bus.publish({
    type: "budget.exceeded",
    hostId: opts.hostId,
    actorId: opts.agentId,
    parentEventId: origin.id,
    threadId,
    durable: true,
    payload: {
      ownerAgentId: opts.ownerAgentId,
      agentId: opts.agentId,
      period: blocked.period,
      capUsd: blocked.capUsd,
      spentUsd: blocked.spentUsd,
      capTokens: blocked.capTokens,
      spentTokens: blocked.spentTokens,
    },
  });
  if (opts.inbox) {
    try {
      askUp(
        { bus: opts.bus, store: opts.store, hostId: opts.hostId, inbox: opts.inbox },
        {
          proposingAgentId: opts.agentId,
          ownerAgentId: opts.ownerAgentId,
          tier: "strategic",
          summary: `raise budget for agent ${opts.agentId}`,
          payload: {
            action: "raise_budget",
            agentId: opts.agentId,
            period: blocked.period,
            currentCapUsd: blocked.capUsd,
            currentSpentUsd: blocked.spentUsd,
            currentCapTokens: blocked.capTokens,
            currentSpentTokens: blocked.spentTokens,
            reason,
          },
        },
      );
    } catch {
      /* best-effort: the budget wall still holds */
    }
  }
  return true;
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
  current: Thread,
  inbox: Inbox | undefined,
  agentId: string,
): { text: string; mailHwmAfterRead?: number } {
  const sections: string[] = [];
  let mailHwmAfterRead: number | undefined;
  const threadSection = renderThreadActivity(threads, current.id);
  if (threadSection) sections.push(threadSection);
  if (inbox) {
    const resolutionSection = renderUnreadResolutions(inbox, agentId, current);
    if (resolutionSection.text) sections.push(resolutionSection.text);
    mailHwmAfterRead = resolutionSection.mailHwmAfterRead;
  }
  return { text: sections.join("\n\n"), mailHwmAfterRead };
}

function renderThreadActivity(
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
  // not the right surface anyway; load query_my_threads for detail.
  const shown = others.slice(0, 8);
  const truncated = others.length - shown.length;
  const lines = shown.map(
    (o) =>
      `  - ${o.id}: ${o.pending} unread${o.msgs ? `, ${o.msgs} msgs in context` : ""}`,
  );
  const header = `Your mailbox — ${others.length} other thread(s) with activity:`;
  const footer = truncated > 0 ? `\n  (+${truncated} more — load query_my_threads for full inventory)` : "";
  return `${header}\n${lines.join("\n")}${footer}`;
}

/** Resolved proposals where this agent was the proposer that landed since
 *  the HWM. Closes the loop on whichever thread the agent next runs in,
 *  complementing the from-idle wake on `mailbox:<agentId>`. The caller
 *  commits the returned HWM only after a paid turn is delivered, so
 *  budget gates and LLM failures do not acknowledge mail the agent never
 *  read. Crash-mid-turn recovery is the always-available pull surface
 *  mail_list({direction:"out", includeResolved:true}). */
function renderUnreadResolutions(
  inbox: Inbox,
  agentId: string,
  thread: Thread,
): { text: string; mailHwmAfterRead?: number } {
  const sinceHwm = thread.mailHwm;
  const nowAtRead = Date.now();
  const all = inbox.listProposedBy(agentId, { includeResolved: true, limit: 100 });
  const fresh = all.filter(
    (d) =>
      d.status !== "open" &&
      d.resolvedAt != null &&
      // `>=` because thread creation and a same-tick respond() can land
      // on the same millisecond. We compensate on advance below.
      d.resolvedAt >= sinceHwm &&
      d.resolvedAt <= nowAtRead,
  );
  if (fresh.length === 0) return { text: "" };
  // Advance to nowAtRead+1 after the turn returns so the rows we showed
  // don't re-appear next turn on this thread, while a resolution landing
  // exactly at nowAtRead+1 in the future is still captured by the next
  // render's `>=` window. Per-thread, so the agent's mailbox-thread
  // processing doesn't ack the resolution for the user-facing chat thread.
  const mailHwmAfterRead = nowAtRead + 1;
  fresh.sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0));
  const cap = 8;
  const shown = fresh.slice(-cap);
  const truncated = fresh.length - shown.length;
  const lines = shown.map((d) => {
    const summary = d.summary.length > 80 ? `${d.summary.slice(0, 77)}...` : d.summary;
    const ago = relativeAgo(nowAtRead - (d.resolvedAt ?? nowAtRead));
    return `  - ${d.id}: ${d.status} ${ago} — "${summary}"`;
  });
  const header = `Decision resolutions you haven't seen (${fresh.length}):`;
  const footer =
    truncated > 0
      ? `\n  (+${truncated} older — call mail_list({direction:"out", includeResolved:true}) for full audit)`
      : "";
  return { text: `${header}\n${lines.join("\n")}${footer}`, mailHwmAfterRead };
}

function relativeAgo(ms: number): string {
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** Wrap an extension-contributed tool so its `execute` always receives a
 *  ctx whose `extensionId` is the contributing extension's id, regardless
 *  of what the chat agent's shared toolCtx carries. Without this every
 *  extension tool would see whatever sentinel chat.ts plugged in. */
function wrapExtensionTool(tool: ToolDef, extensionId: string): ToolDef {
  return {
    ...tool,
    execute: (args, ctx) => tool.execute(args, { ...ctx, extensionId }),
  } as ToolDef;
}

/** Build a new thread's loaded set pre-populated with the names of every
 *  active extension's contributed tools. Always-loaded tools are skipped —
 *  they're handled out-of-band and never need to sit in the set. */
export function seedExtensionTools(extensions: ExtensionHost | undefined): Set<string> {
  const loaded = new Set<string>();
  if (!extensions) return loaded;
  for (const { tool } of extensions.tools()) {
    if (!tool.alwaysLoaded) loaded.add(tool.name);
  }
  return loaded;
}

export interface RegisterAutoLoadDeps {
  loadedTools: Set<string>;
  extensions: ExtensionHost;
}

/** Wrap register_extension so a successful register auto-loads the
 *  extension's contributed tools into the calling thread's loadedTools
 *  set and surfaces their schemas in the result — write+smoke+register
 *  is explicit cost paid with intent to use, so a separate load_tools
 *  hop is dead weight. unload_tools is the way back if regretted. */
export function wrapRegisterForAutoLoad(tool: ToolDef, deps: RegisterAutoLoadDeps): ToolDef {
  return {
    ...tool,
    execute: async (args, ctx) => {
      const result = (await tool.execute(args, ctx)) as Record<string, unknown>;
      const name = (args as { name?: string }).name;
      if (!name) return result;
      const ext = deps.extensions.get(name);
      if (!ext) return result;
      const autoLoaded: LoadResultEntry[] = [];
      for (const entry of deps.extensions.tools()) {
        if (entry.extensionId !== ext.id) continue;
        autoLoaded.push(markLoaded(deps.loadedTools, entry.tool));
      }
      return { ...result, autoLoaded };
    },
  } as ToolDef;
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

function emitStep(
  opts: AgentLoopOptions,
  threadId: string,
  origin: Event,
  step: AgentStep,
  redactToolInput: (name: string, input: unknown) => unknown,
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
  } else if (step.kind === "thinking_delta") {
    if (!step.text) return;
    // Streaming thinking text. Non-durable like assistant-delta: pure
    // visualization. The thinking cost is already inside output_tokens
    // (ledger-exact); the thinking block itself persists in the thread
    // messages for the signature echo — no separate durable record needed.
    opts.bus.publish({
      type: "chat.thinking-delta",
      hostId: opts.hostId,
      actorId: opts.agentId,
      parentEventId: origin.id,
      threadId,
      durable: false,
      payload: { text: step.text },
    });
  } else if (step.kind === "tool_use") {
    const input = redactToolInput(step.name, step.input);
    opts.bus.publish({
      type: "chat.tool-call",
      hostId: opts.hostId,
      actorId: opts.agentId,
      parentEventId: origin.id,
      threadId,
      durable: true,
      payload: { id: step.id, name: step.name, input },
    });
  } else if (step.kind === "tool_result_live") {
    // Live UX-only event. Non-durable: not persisted, not federated,
    // not part of the replayable record. Subscribers that drive a
    // visible surface (CLI, bridges) consume this; observability /
    // history reconstruction don't see it at all.
    opts.bus.publish({
      type: "chat.tool-result-live",
      hostId: opts.hostId,
      actorId: opts.agentId,
      parentEventId: origin.id,
      threadId,
      durable: false,
      payload: {
        id: step.id,
        name: step.name,
        isError: step.isError,
        content: step.content,
      },
    });
  } else if (step.kind === "tool_result") {
    // Canonical, durable. Carries exactly what the model received in
    // its tool_result message — diverges from chat.tool-result-live
    // only when aggregate-budget truncation rewrote the content into
    // a `<persisted-output>` recovery marker.
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

/** One-line summary of a denied tool call's input args, for the
 *  grant_scope proposal summary. Mirrors what humans want to read first
 *  on the inbox: "install_starter(discord)" beats raw ULIDs.
 *
 *  Strategy: pick a small set of well-known short keys, render
 *  `key=value` pairs joined by spaces, capped to ~80 chars. Falls back
 *  to a compact JSON when no recognizable shape. */
function summarizeInputArgs(input: unknown): string {
  if (input == null) return "";
  if (typeof input !== "object") return String(input).slice(0, 80);
  const obj = input as Record<string, unknown>;
  const preferred = ["name", "id", "tool", "type", "channel", "to", "path", "scope", "starter"];
  const parts: string[] = [];
  for (const k of preferred) {
    if (obj[k] != null && (typeof obj[k] === "string" || typeof obj[k] === "number")) {
      parts.push(`${k}=${String(obj[k])}`);
    }
  }
  if (parts.length === 0) {
    // Fall back to a compact stringify; trim if long.
    let s: string;
    try {
      s = JSON.stringify(obj);
    } catch {
      s = String(obj);
    }
    return s.length > 80 ? `${s.slice(0, 79)}…` : s;
  }
  const joined = parts.join(" ");
  return joined.length > 80 ? `${joined.slice(0, 79)}…` : joined;
}
