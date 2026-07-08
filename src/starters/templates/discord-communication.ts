import type { StarterTemplate } from "./types.ts";

export const discordCommunication: StarterTemplate = {
  name: "discord-communication",
  description: "Bridges Discord to/from the chat agent. DMs always active; guild channels require the channel to be in watchedChannels AND (wake-word match OR @mention). Accumulates assistant text until chat.turn-end, then posts one reply.",
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
//     user per channel. Channel-keyed sends land in the right place for
//     MESSAGE_CREATE from threads too, so separate thread handling isn't
//     needed.
//   - toAgentId: api.rootAgentId so the event lands in root's mailbox.
//     Retargeting (a secretary taking over a thread, say) will be the
//     agent's own job via retarget_thread.
//
// Outbound (chat.turn-end -> discord_send):
//   - Accumulates chat.assistant-text chunks through the turn, filtered
//     by threadId (not payload.sessionId — threading is a bus-level tag).
//   - On chat.turn-end, posts the accumulated text as one message.
//   - asAgent is threaded so the call passes the same permission gate
//     the agent applies to its own tool dispatch.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface ChannelMessage {
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
  originMessageId: string;
}

const routes = new Map<string, Route>();
const accumulators = new Map<string, string[]>();
const turnActors = new Map<string, string>();
// Tracks threads where discord_send was called explicitly to the current
// route during the turn. Other Discord sends must not suppress the reply.
const turnExplicitSend = new Set<string>();

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
    if (!shouldAnswer(msg, cfg!, wakeRe!)) return;
    const threadId = threadKey(msg);
    routes.set(threadId, { channelId: msg.channel_id, originMessageId: msg.message_id });
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
    if (!threadId || !routes.has(threadId)) return;
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
    if (!threadId || !routes.has(threadId)) return;
    const route = routes.get(threadId)!;
    const p = ev.payload as { name?: string; input?: unknown };
    if (p.name !== "discord_send") return;
    const input = p.input && typeof p.input === "object" ? p.input as Record<string, unknown> : {};
    if (input.channel_id === route.channelId && input.reply_to === route.originMessageId) {
      turnExplicitSend.add(threadId);
    }
  });

  api.on("chat.turn-end", async (ev: any) => {
    const threadId = ev.threadId;
    if (!threadId) return;
    const route = routes.get(threadId);
    if (!route) return;
    const text = finalize(threadId);
    const actor = turnActors.get(threadId);
    turnActors.delete(threadId);
    const explicit = turnExplicitSend.delete(threadId);
    // If the agent already called discord_send explicitly this turn, the prose
    // was already delivered (or intentionally omitted). Don't double-send.
    if (!text || explicit) return;
    try {
      await api.callTool(
        "discord_send",
        { channel_id: route.channelId, content: text, reply_to: route.originMessageId },
        actor ? { asAgent: actor } : undefined,
      );
    } catch (err) {
      console.error("[discord-communication] discord_send failed:", (err as Error).message);
    }
  });

  api.on("chat.error", (ev: any) => {
    const threadId = ev.threadId;
    if (!threadId) return;
    accumulators.delete(threadId);
    turnActors.delete(threadId);
    turnExplicitSend.delete(threadId);
  });
}

export function unload() {
  routes.clear();
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
  },
};
