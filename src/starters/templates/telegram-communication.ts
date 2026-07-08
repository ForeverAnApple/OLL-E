import type { StarterTemplate } from "./types.ts";

export const telegramCommunication: StarterTemplate = {
  name: "telegram-communication",
  description:
    "Bridges Telegram to/from the chat agent. DMs always active; group chats require the chat to be in watchedChats AND (wake-word match OR @mention). Shows presence the moment a turn starts, streams the reply live via telegram_stream, and finalizes one formatted message at turn-end. Standing-job threads deliver chat-only.",
  files: {
    "manifest.json": JSON.stringify(
      {
        name: "telegram-communication",
        version: "0.2.0",
        description: "Wake-word + DM bridge between Telegram and the chat agent, with live streamed replies.",
        capabilities: ["bridge:telegram-chat"],
        callsTools: ["telegram_send", "telegram_stream"],
        eventReads: [
          "channel-message",
          "chat.assistant-text",
          "chat.assistant-delta",
          "chat.tool-call",
          "chat.turn-end",
          "chat.error",
        ],
        eventWrites: ["chat.input"],
        config: {
          wakeWord: "olle",
          watchedChats: [] as string[],
        },
      },
      null,
      2,
    ) + "\n",
    "index.ts":
`// telegram-communication: inbound/outbound relay between Telegram and the
// chat agent. Structural twin of discord-communication, plus live
// streaming: the human sees presence the moment the turn starts and
// watches the reply grow instead of staring at a silent chat.
//
// Inbound (channel-message -> chat.input):
//   - Only telegram-sourced messages (payload.source === "telegram"); the
//     discord adapter emits channel-message too, and we must not relay its
//     traffic into Telegram.
//   - DMs (private chats): always pumped in.
//   - Group chats: only if the chat is in watchedChats AND (the bot is
//     @mentioned OR the wake-word matches content).
//   - Thread id: telegram:<chat_id>:<user_id> — one correlation per user
//     per chat.
//   - Right after publishing chat.input we fire telegram_stream(start) so
//     presence ("Thinking…" draft in DMs, typing in groups) appears before
//     the first token exists. The bridge originates the turn, so this is
//     the earliest possible moment — there is no turn-start bus event.
//
// Streaming (chat.assistant-delta -> telegram_stream update):
//   - Deltas accumulate into a per-thread partial; completed hops arrive
//     as chat.assistant-text (the canonical text) and replace the partial.
//   - A 1s timer pushes latest-state-wins updates. We never push per
//     delta: tool calls are logged rows, and token-cadence calls would
//     flood both the log and Telegram's flood control (the adapter
//     throttles again internally — belt and braces).
//
// Outbound (chat.turn-end -> telegram_stream finalize):
//   - finalize renders markdown and upgrades the streamed message in
//     place (or sends fresh if nothing streamed). If the adapter predates
//     telegram_stream or the call fails, telegram_send is the floor — the
//     reply must land even when the streaming UX can't.
//
// Standing jobs (schedule_task deliver:{kind:"telegram",chatId}):
//   - The scheduler drives a turn on threadId telegram:<chatId>:job:<jobId>
//     with no prior inbound message. getOrDeriveRoute() derives {chatId,
//     originMessageId:null} from the threadId prefix — applied at ALL
//     outbound sites, or the accumulator never fills. Derived routes are
//     per-turn and evicted at turn-end/error. Streaming works there too:
//     the first delta derives the route and opens the session.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface ChannelMessage {
  source?: string;
  message_id: string;
  guild_id: string | null;
  channel_id: string;
  thread_id: string | null;
  author: { id: string; name: string; bot: boolean };
  content: string;
  mentions: string[];
  reply_to: string | null;
  is_dm: boolean;
  is_mention: boolean;
}

interface Config {
  wakeWord: string;
  watchedChats: string[];
}

interface Route {
  chatId: string;
  // null when derived from a standing-job threadId (no message to reply to).
  originMessageId: string | null;
}

const routes = new Map<string, Route>();
const derivedRoutes = new Set<string>();
const accumulators = new Map<string, string[]>();
const turnActors = new Map<string, string>();
const turnExplicitSend = new Set<string>();

// Streaming state, all keyed by threadId and torn down at turn boundary.
const partials = new Map<string, string>();
const streamTimers = new Map<string, ReturnType<typeof setInterval>>();
const streamFailures = new Map<string, number>();
const lastPushed = new Map<string, string>();
const STREAM_TICK_MS = 1_000;

// Loose bridge parse contract: any telegram:<chatId>:... threadId with no
// stored route delivers chat-only, no reply_to.
const TELEGRAM_THREAD_RE = /^telegram:([^:]+):/;

let cfg: Config | null = null;
let wakeRe: RegExp | null = null;

function loadConfig(): Config {
  const here = dirname(new URL(import.meta.url).pathname);
  const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
  return manifest.config as Config;
}

function threadKey(msg: ChannelMessage): string {
  return \`telegram:\${msg.channel_id}:\${msg.author.id}\`;
}

function getOrDeriveRoute(threadId: string): Route | null {
  const existing = routes.get(threadId);
  if (existing) return existing;
  const m = TELEGRAM_THREAD_RE.exec(threadId);
  if (!m) return null;
  const route: Route = { chatId: m[1]!, originMessageId: null };
  routes.set(threadId, route);
  derivedRoutes.add(threadId);
  return route;
}

function evictDerived(threadId: string): void {
  if (derivedRoutes.delete(threadId)) routes.delete(threadId);
}

function shouldAnswer(msg: ChannelMessage, c: Config, re: RegExp): boolean {
  if (msg.author.bot) return false;
  if (msg.is_dm) return true;
  if (!c.watchedChats.includes(msg.channel_id)) return false;
  if (msg.is_mention) return true;
  return re.test(msg.content);
}

function cleanContent(raw: string, re: RegExp, isDm: boolean): string {
  // Strip @bot mentions (Telegram sends them as @username text). Strip the
  // wake-word only in group messages where it was the trigger; in DMs it's
  // conversational and stays.
  let stripped = raw.replace(/@[A-Za-z0-9_]+/g, "");
  if (!isDm) stripped = stripped.replace(re, "");
  stripped = stripped.trim();
  return stripped || raw;
}

function finalize(threadId: string): string | null {
  const chunks = accumulators.get(threadId) ?? [];
  accumulators.delete(threadId);
  const text = chunks.join("\\n\\n").trim();
  return text || null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
}

export function register(api: any) {
  cfg = loadConfig();
  wakeRe = new RegExp(\`\\\\b\${escapeRegex(cfg.wakeWord)}\\\\b\`, "i");

  function actorOpts(threadId: string): { asAgent: string } | undefined {
    const actor = turnActors.get(threadId);
    return actor ? { asAgent: actor } : undefined;
  }

  function stopStream(threadId: string): void {
    const t = streamTimers.get(threadId);
    if (t) clearInterval(t);
    streamTimers.delete(threadId);
    partials.delete(threadId);
    lastPushed.delete(threadId);
    streamFailures.delete(threadId);
  }

  // Completed hops (accumulators) + the in-flight hop's deltas (partials).
  function composeStream(threadId: string): string {
    const done = accumulators.get(threadId) ?? [];
    const part = partials.get(threadId) ?? "";
    return [...done, part].filter(Boolean).join("\\n\\n").trim();
  }

  async function pushStream(threadId: string): Promise<void> {
    const route = routes.get(threadId);
    if (!route) return;
    const text = composeStream(threadId);
    if (!text || text === lastPushed.get(threadId)) return;
    lastPushed.set(threadId, text);
    try {
      await api.callTool(
        "telegram_stream",
        { session: threadId, chat_id: route.chatId, phase: "update", text },
        actorOpts(threadId),
      );
      streamFailures.delete(threadId);
    } catch {
      const n = (streamFailures.get(threadId) ?? 0) + 1;
      streamFailures.set(threadId, n);
      // Adapter missing or broken — stop ticking; turn-end still delivers.
      if (n >= 3) stopStream(threadId);
    }
  }

  api.on("channel-message", (ev: any) => {
    const msg = ev.payload as ChannelMessage;
    // Ignore other channels' traffic (discord etc.) sharing the bus.
    if (msg.source && msg.source !== "telegram") return;
    if (!shouldAnswer(msg, cfg!, wakeRe!)) return;
    const threadId = threadKey(msg);
    routes.set(threadId, { chatId: msg.channel_id, originMessageId: msg.message_id });
    derivedRoutes.delete(threadId);
    const text = cleanContent(msg.content, wakeRe!, msg.is_dm);
    const target = api.resolveMailbox?.(threadId) ?? api.rootAgentId;
    api.publish(
      "chat.input",
      { text },
      { durable: true, toAgentId: target, threadId },
    );
    // Presence intent: "Thinking…"/typing appears the moment the turn
    // starts, not at the first token. Best-effort — an adapter without
    // telegram_stream still delivers via turn-end.
    void api
      .callTool("telegram_stream", { session: threadId, chat_id: msg.channel_id, phase: "start" })
      .catch(() => {});
  });

  api.on("chat.assistant-text", (ev: any) => {
    const threadId = ev.threadId;
    if (!threadId) return;
    if (!getOrDeriveRoute(threadId)) return;
    const p = ev.payload as { text: string };
    const acc = accumulators.get(threadId) ?? [];
    acc.push(p.text);
    accumulators.set(threadId, acc);
    // The hop's canonical text replaces its delta accumulation.
    partials.delete(threadId);
    if (ev.actorId) turnActors.set(threadId, ev.actorId as string);
  });

  api.on("chat.assistant-delta", (ev: any) => {
    const threadId = ev.threadId;
    if (!threadId) return;
    if (!getOrDeriveRoute(threadId)) return;
    const p = ev.payload as { text: string };
    partials.set(threadId, (partials.get(threadId) ?? "") + p.text);
    if (ev.actorId) turnActors.set(threadId, ev.actorId as string);
    if (!streamTimers.has(threadId)) {
      streamTimers.set(threadId, setInterval(() => { void pushStream(threadId); }, STREAM_TICK_MS));
    }
  });

  api.on("chat.tool-call", (ev: any) => {
    const threadId = ev.threadId;
    if (!threadId) return;
    const route = getOrDeriveRoute(threadId);
    if (!route) return;
    const p = ev.payload as { name?: string; input?: unknown };
    if (p.name !== "telegram_send") return;
    const input = p.input && typeof p.input === "object" ? p.input as Record<string, unknown> : {};
    const replyTo = (input.reply_to as string | undefined) ?? null;
    if (input.chat_id === route.chatId && replyTo === route.originMessageId) {
      turnExplicitSend.add(threadId);
    }
  });

  api.on("chat.turn-end", async (ev: any) => {
    const threadId = ev.threadId;
    if (!threadId) return;
    const route = getOrDeriveRoute(threadId);
    if (!route) return;
    stopStream(threadId);
    const text = finalize(threadId);
    const opts = actorOpts(threadId);
    turnActors.delete(threadId);
    const explicit = turnExplicitSend.delete(threadId);
    try {
      if (text && !explicit) {
        const args: Record<string, unknown> = { session: threadId, chat_id: route.chatId, phase: "finalize", text };
        if (route.originMessageId) args.reply_to = route.originMessageId;
        try {
          await api.callTool("telegram_stream", args, opts);
        } catch {
          // Adapter predates telegram_stream or the stream died. The reply
          // must land regardless — plain send is the floor.
          const sendArgs: Record<string, unknown> = { chat_id: route.chatId, text };
          if (route.originMessageId) sendArgs.reply_to = route.originMessageId;
          await api.callTool("telegram_send", sendArgs, opts);
        }
      } else {
        // Nothing to say (or the agent already sent explicitly) — tear
        // down presence and any partial quietly.
        void api
          .callTool("telegram_stream", { session: threadId, chat_id: route.chatId, phase: "cancel" }, opts)
          .catch(() => {});
      }
    } catch (err) {
      console.error("[telegram-communication] delivery failed:", (err as Error).message);
    } finally {
      evictDerived(threadId);
    }
  });

  api.on("chat.error", (ev: any) => {
    const threadId = ev.threadId;
    if (!threadId) return;
    const route = routes.get(threadId);
    const opts = actorOpts(threadId);
    stopStream(threadId);
    if (route) {
      void api
        .callTool("telegram_stream", { session: threadId, chat_id: route.chatId, phase: "cancel" }, opts)
        .catch(() => {});
    }
    accumulators.delete(threadId);
    turnActors.delete(threadId);
    turnExplicitSend.delete(threadId);
    evictDerived(threadId);
  });
}

export function unload() {
  for (const t of streamTimers.values()) clearInterval(t);
  streamTimers.clear();
  partials.clear();
  lastPushed.clear();
  streamFailures.clear();
  routes.clear();
  derivedRoutes.clear();
  accumulators.clear();
  turnActors.clear();
  turnExplicitSend.clear();
  cfg = null;
  wakeRe = null;
}
`,
    "smoke.ts":
`// Smoke: validate the manifest has the config we expect. No network,
// no event side effects — this bridge only makes sense once the telegram
// extension is loaded and actively emitting channel-message.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export async function smokeTest() {
  const here = dirname(new URL(import.meta.url).pathname);
  const m = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8")) as {
    config?: { wakeWord?: unknown; watchedChats?: unknown };
    callsTools?: unknown;
    eventReads?: unknown;
  };
  if (!m.config || typeof m.config.wakeWord !== "string" || m.config.wakeWord.length === 0) {
    throw new Error("telegram-communication: manifest.config.wakeWord must be a non-empty string");
  }
  if (!Array.isArray(m.config.watchedChats)) {
    throw new Error("telegram-communication: manifest.config.watchedChats must be an array");
  }
  for (const tool of ["telegram_send", "telegram_stream"]) {
    if (!Array.isArray(m.callsTools) || !m.callsTools.includes(tool)) {
      throw new Error(\`telegram-communication: manifest.callsTools must include "\${tool}"\`);
    }
  }
  if (!Array.isArray(m.eventReads) || !m.eventReads.includes("chat.assistant-delta")) {
    throw new Error('telegram-communication: manifest.eventReads must include "chat.assistant-delta" (streaming feed)');
  }
}
`,
    "SETUP.md":
`# telegram-communication — setup

## What it does
Bridges Telegram and the chat agent so a human on Telegram talks to olle the
same way they do on the CLI. Inbound: DMs (private chats) always route to
olle; a group chat routes only when the chat is in watchedChats AND the bot
is @mentioned OR the wake-word appears.

Outbound is live, not batch. The moment a message routes in, presence
appears — Telegram's native "Thinking…" draft bubble in DMs, a typing
indicator in groups. As the agent produces text the reply streams into the
chat (an animated draft in DMs, a growing ▌-cursor message in groups), and
at turn-end one formatted message is finalized in place. If the telegram
adapter is an older version without telegram_stream, the bridge quietly
falls back to the classic one-message-at-turn-end behavior — the reply
always lands.

It also carries standing-job output: a schedule_task job with
deliver:{kind:"telegram",chatId} lands here and posts to the chat with no
reply reference. No inbound message required; streaming works there too.

## Prerequisite
The telegram starter must be installed, secret-set, and registered first —
this bridge is useless without telegram emitting channel-message events and
providing the telegram_send / telegram_stream tools. Set up telegram (see
its SETUP.md) before this one.

## Secrets
None of its own. It calls the telegram starter's tools; that is where
TELEGRAM_BOT_TOKEN lives.

## Config knobs (manifest.json, config object)
- wakeWord — default "olle". In a watched group chat, a message containing
  this word (or an @mention of the bot) wakes olle. Case-insensitive,
  whole-word.
- watchedChats — array of chat ids (numeric strings). Empty means no group
  chats are watched (DMs still work). Add chat ids to opt them in. The chat
  id shows up in a channel-message event or via telegram_fetch_context.

## Install script (narrate this to the human)
    # telegram must already be registered and passing smoke
    install_starter("telegram-communication")
    # optional: edit manifest.json config.watchedChats / wakeWord
    register_extension("telegram-communication")

## Guardrails
- Add chats to watchedChats deliberately. A busy group with a common
  wake-word wakes olle a lot and spends tokens.
- Standing-job delivery posts to the chat id you gave schedule_task.
  Double-check that chat id before scheduling — a wrong id posts into the
  wrong place on a cron.
- Streaming edits cost API calls (~1/s per active reply). That is well
  inside Telegram's flood limits for a personal bot, but don't watch a
  high-traffic group with streaming if dozens of replies run concurrently.
`,
  },
};
