import type { StarterTemplate } from "./types.ts";

export const discordCommunication: StarterTemplate = {
  name: "discord-communication",
  description: "Bridges Discord to/from the chat agent. DMs always active; guild channels require the channel to be in watchedChannels AND (wake-word match OR @mention). Accumulates assistant text until chat.turn-end, then posts one reply. Standing-job threads deliver channel-only.",
  files: {
    "manifest.json": JSON.stringify(
      {
        name: "discord-communication",
        version: "0.1.0",
        description: "Wake-word + DM bridge between Discord and the chat agent.",
        capabilities: ["bridge:discord-chat"],
        callsTools: ["discord_send"],
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
          watchedChannels: [] as string[],
        },
      },
      null,
      2,
    ) + "\n",
    "index.ts":
`// discord-communication: the inbound/outbound relay that makes chatting
// with olle on Discord feel like chatting with olle on the CLI.
//
// Inbound (channel-message -> chat.input):
//   - DMs: always pumped in.
//   - Guild channels: only if the channel is in watchedChannels AND
//     (the bot is mentioned OR the wake-word matches content).
//   - Thread id: discord:<channel_id>:<author_id> — one correlation per
//     user per channel.
//   - toAgentId: api.rootAgentId so the event lands in root's mailbox.
//
// Outbound (chat.turn-end -> discord_send):
//   - Accumulates chat.assistant-text chunks through the turn, filtered
//     by threadId (not payload.sessionId — threading is a bus-level tag).
//   - On chat.turn-end, posts the accumulated text as one message.
//   - asAgent is threaded so the call passes the same permission gate.
//
// Standing jobs (schedule_task deliver:{kind:"discord",channelId}):
//   - The scheduler drives a turn on threadId discord:<channelId>:job:<jobId>
//     with no prior inbound message. There is no stored route for that
//     thread, so getOrDeriveRoute() lazily derives {channelId, originMessageId:
//     null} straight from the threadId prefix. Deriving must happen at ALL
//     THREE outbound sites — if we only derived at turn-end the accumulator
//     would never have filled and the reply would be empty. Derived routes
//     are per-turn: they're evicted at turn-end/error so they never shadow a
//     real inbound conversation on the same channel later.

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
  watchedChannels: string[];
}

interface Route {
  channelId: string;
  // null when the route was derived from a standing-job threadId (no human
  // message to reply to) — send to the channel with no reply reference.
  originMessageId: string | null;
}

const routes = new Map<string, Route>();
// Threads whose route was lazily derived (standing jobs). Evicted per-turn so
// a derived route never outlives its turn and shadows a real conversation.
const derivedRoutes = new Set<string>();
const accumulators = new Map<string, string[]>();
const turnActors = new Map<string, string>();
// Tracks threads where discord_send was called explicitly to the current
// route during the turn. Other Discord sends must not suppress the reply.
const turnExplicitSend = new Set<string>();

// Loose bridge parse contract (shared shape with the scheduler's job-thread
// ids): any discord:<channelId>:... threadId with no stored route delivers
// channel-only, no reply_to.
const DISCORD_THREAD_RE = /^discord:([^:]+):/;

let cfg: Config | null = null;
let wakeRe: RegExp | null = null;

function loadConfig(): Config {
  const here = dirname(new URL(import.meta.url).pathname);
  const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
  return manifest.config as Config;
}

function threadKey(msg: ChannelMessage): string {
  return \`discord:\${msg.channel_id}:\${msg.author.id}\`;
}

// Return the stored route, or lazily derive one from the threadId prefix for
// standing-job / uncorrelated threads. Derived routes are tracked so they can
// be evicted at end of turn.
function getOrDeriveRoute(threadId: string): Route | null {
  const existing = routes.get(threadId);
  if (existing) return existing;
  const m = DISCORD_THREAD_RE.exec(threadId);
  if (!m) return null;
  const route: Route = { channelId: m[1]!, originMessageId: null };
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
  if (!c.watchedChannels.includes(msg.channel_id)) return false;
  if (msg.is_mention) return true;
  return re.test(msg.content);
}

function cleanContent(raw: string, re: RegExp, isDm: boolean): string {
  // Always strip @mentions of the bot — they're markdown noise to the
  // LLM. Only strip the wake-word in channel messages where it was the
  // trigger; in DMs the wake-word is conversational and stays.
  let stripped = raw.replace(/<@!?[0-9]+>/g, "");
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
    // Ignore other channels' traffic (telegram etc.) sharing the bus.
    if (msg.source && msg.source !== "discord") return;
    if (!shouldAnswer(msg, cfg!, wakeRe!)) return;
    const threadId = threadKey(msg);
    // A real inbound message: store (not derive) a route with a reply target.
    routes.set(threadId, { channelId: msg.channel_id, originMessageId: msg.message_id });
    derivedRoutes.delete(threadId);
    const text = cleanContent(msg.content, wakeRe!, msg.is_dm);
    // Retargeted threads (e.g. a secretary child taking over DMs) win
    // over the default root mailbox.
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

  // When discord_send is called explicitly to this conversation's route, mark
  // the thread so the auto-relay at turn-end doesn't send a duplicate message.
  api.on("chat.tool-call", (ev: any) => {
    const threadId = ev.threadId;
    if (!threadId) return;
    const route = getOrDeriveRoute(threadId);
    if (!route) return;
    const p = ev.payload as { name?: string; input?: unknown };
    if (p.name !== "discord_send") return;
    const input = p.input && typeof p.input === "object" ? p.input as Record<string, unknown> : {};
    const replyTo = (input.reply_to as string | undefined) ?? null;
    if (input.channel_id === route.channelId && replyTo === route.originMessageId) {
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
      // If the agent already called discord_send explicitly this turn, the
      // prose was already delivered (or intentionally omitted). Don't
      // double-send.
      if (text && !explicit) {
        const sendArgs: Record<string, unknown> = { channel_id: route.channelId, content: text };
        if (route.originMessageId) sendArgs.reply_to = route.originMessageId;
        await api.callTool(
          "discord_send",
          sendArgs,
          actor ? { asAgent: actor } : undefined,
        );
      }
    } catch (err) {
      console.error("[discord-communication] discord_send failed:", (err as Error).message);
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
// no event side effects — this bridge only makes sense once the
// discord extension is loaded and actively emitting channel-message.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export async function smokeTest() {
  const here = dirname(new URL(import.meta.url).pathname);
  const m = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8")) as {
    config?: { wakeWord?: unknown; watchedChannels?: unknown };
    callsTools?: unknown;
  };
  if (!m.config || typeof m.config.wakeWord !== "string" || m.config.wakeWord.length === 0) {
    throw new Error("discord-communication: manifest.config.wakeWord must be a non-empty string");
  }
  if (!Array.isArray(m.config.watchedChannels)) {
    throw new Error("discord-communication: manifest.config.watchedChannels must be an array");
  }
  if (!Array.isArray(m.callsTools) || !m.callsTools.includes("discord_send")) {
    throw new Error("discord-communication: manifest.callsTools must include \\"discord_send\\"");
  }
}
`,
    "SETUP.md":
`# discord-communication — setup

## What it does
Bridges Discord and the chat agent so a human on Discord talks to olle the
same way they do on the CLI. Inbound: DMs always route to olle; a guild
channel routes only when the channel is in watchedChannels AND the bot is
@mentioned OR the wake-word appears. Outbound: it accumulates the agent's
reply through the turn and posts one message at turn-end.

It also carries standing-job output: a schedule_task job with
deliver:{kind:"discord",channelId} lands on this bridge and posts to the
channel with no reply reference. No inbound message required.

## Prerequisite
The discord starter must be installed, secret-set, and registered first —
this bridge is useless without discord emitting channel-message events and
providing the discord_send tool. Set up discord (see its SETUP.md) before
this one.

## Secrets
None of its own. It calls the discord starter's discord_send tool; that is
where DISCORD_TOKEN lives.

## Config knobs (manifest.json, config object)
- wakeWord — default "olle". In a watched guild channel, a message
  containing this word (or an @mention of the bot) wakes olle. Case-
  insensitive, whole-word.
- watchedChannels — array of channel ids. Empty means no guild channels are
  watched (DMs still work). Add channel ids to opt them in.

## Install script (narrate this to the human)
    # discord must already be registered and passing smoke
    install_starter("discord-communication")
    # optional: edit manifest.json config.watchedChannels / wakeWord
    register_extension("discord-communication")

## Guardrails
- Add channels to watchedChannels deliberately. A busy channel with a common
  wake-word wakes olle a lot and spends tokens.
- The discord starter's includeBotMessages must stay false, or olle can
  answer its own messages in a loop through this bridge.
- Standing-job delivery posts to the channel id you gave schedule_task.
  Double-check that channel id before scheduling — a wrong id posts into the
  wrong place on a cron.
`,
  },
};
