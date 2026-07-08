import type { StarterTemplate } from "./types.ts";

export const telegramCommunication: StarterTemplate = {
  name: "telegram-communication",
  description: "Bridges Telegram to/from the chat agent. DMs always active; group chats require the chat to be in watchedChats AND (wake-word match OR @mention). Accumulates assistant text until chat.turn-end, then posts one reply. Standing-job threads deliver chat-only.",
  files: {
    "manifest.json": JSON.stringify(
      {
        name: "telegram-communication",
        version: "0.1.0",
        description: "Wake-word + DM bridge between Telegram and the chat agent.",
        capabilities: ["bridge:telegram-chat"],
        callsTools: ["telegram_send"],
        eventReads: [
          "channel-message",
          "chat.assistant-text",
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
// chat agent. Structural twin of discord-communication — same accumulate-
// then-send-one-reply shape, keyed on telegram threadIds.
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
//
// Outbound (chat.turn-end -> telegram_send):
//   - Accumulates chat.assistant-text chunks through the turn.
//   - On chat.turn-end, posts the accumulated text as one message.
//
// Standing jobs (schedule_task deliver:{kind:"telegram",chatId}):
//   - The scheduler drives a turn on threadId telegram:<chatId>:job:<jobId>
//     with no prior inbound message. getOrDeriveRoute() derives {chatId,
//     originMessageId:null} from the threadId prefix — applied at ALL THREE
//     outbound sites, or the accumulator never fills. Derived routes are
//     per-turn and evicted at turn-end/error.

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
  });

  api.on("chat.assistant-text", (ev: any) => {
    const threadId = ev.threadId;
    if (!threadId) return;
    if (!getOrDeriveRoute(threadId)) return;
    const p = ev.payload as { text: string };
    const acc = accumulators.get(threadId) ?? [];
    acc.push(p.text);
    accumulators.set(threadId, acc);
    if (ev.actorId) turnActors.set(threadId, ev.actorId as string);
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
    const text = finalize(threadId);
    const actor = turnActors.get(threadId);
    turnActors.delete(threadId);
    const explicit = turnExplicitSend.delete(threadId);
    try {
      if (text && !explicit) {
        const sendArgs: Record<string, unknown> = { chat_id: route.chatId, text };
        if (route.originMessageId) sendArgs.reply_to = route.originMessageId;
        await api.callTool(
          "telegram_send",
          sendArgs,
          actor ? { asAgent: actor } : undefined,
        );
      }
    } catch (err) {
      console.error("[telegram-communication] telegram_send failed:", (err as Error).message);
    } finally {
      evictDerived(threadId);
    }
  });

  api.on("chat.error", (ev: any) => {
    const threadId = ev.threadId;
    if (!threadId) return;
    accumulators.delete(threadId);
    turnActors.delete(threadId);
    turnExplicitSend.delete(threadId);
    evictDerived(threadId);
  });
}

export function unload() {
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
  };
  if (!m.config || typeof m.config.wakeWord !== "string" || m.config.wakeWord.length === 0) {
    throw new Error("telegram-communication: manifest.config.wakeWord must be a non-empty string");
  }
  if (!Array.isArray(m.config.watchedChats)) {
    throw new Error("telegram-communication: manifest.config.watchedChats must be an array");
  }
  if (!Array.isArray(m.callsTools) || !m.callsTools.includes("telegram_send")) {
    throw new Error("telegram-communication: manifest.callsTools must include \\"telegram_send\\"");
  }
}
`,
    "SETUP.md":
`# telegram-communication — setup

## What it does
Bridges Telegram and the chat agent so a human on Telegram talks to olle the
same way they do on the CLI. Inbound: DMs (private chats) always route to
olle; a group chat routes only when the chat is in watchedChats AND the bot
is @mentioned OR the wake-word appears. Outbound: it accumulates the agent's
reply through the turn and posts one message at turn-end.

It also carries standing-job output: a schedule_task job with
deliver:{kind:"telegram",chatId} lands here and posts to the chat with no
reply reference. No inbound message required.

## Prerequisite
The telegram starter must be installed, secret-set, and registered first —
this bridge is useless without telegram emitting channel-message events and
providing the telegram_send tool. Set up telegram (see its SETUP.md) before
this one.

## Secrets
None of its own. It calls the telegram starter's telegram_send tool; that is
where TELEGRAM_BOT_TOKEN lives.

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
`,
  },
};
