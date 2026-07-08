import type { StarterTemplate } from "./types.ts";

export const discord: StarterTemplate = {
  name: "discord",
  description: "Discord gateway adapter. Opens the v10 gateway WS, emits channel-message + member-join triggers, exposes send/react/fetch-context/list-channels tools. Near-working skeleton — agent fills in reconnect/resume/rate-limit handling.",
  files: {
    "manifest.json": JSON.stringify(
      {
        name: "discord",
        version: "0.1.0",
        description: "Discord gateway adapter: channel-message + member-join triggers, REST tools.",
        secrets: ["DISCORD_TOKEN"],
        capabilities: ["channel:discord", "trigger:channel-message", "trigger:member-join"],
        eventWrites: ["channel-message", "member-join"],
        config: {
          // 1 (GUILDS) | 2 (GUILD_MEMBERS) | 512 (GUILD_MESSAGES) |
          // 4096 (DIRECT_MESSAGES) | 32768 (MESSAGE_CONTENT) = 37379.
          // MESSAGE_CONTENT + GUILD_MEMBERS are privileged — enable in
          // the Developer Portal before activating.
          intents: 37379,
          apiBase: "https://discord.com/api/v10",
          gatewayUrl: "wss://gateway.discord.gg/?v=10&encoding=json",
          // Default: drop messages from bots (including self) before
          // publishing to the bus. Flip to true if you need raw visibility.
          includeBotMessages: false,
        },
      },
      null,
      2,
    ) + "\n",
    "index.ts":
`// discord: gateway adapter. Opens a single Discord Gateway v10 connection
// per host, fans dispatch events into two triggers (channel-message,
// member-join), and exposes four REST tools. Designed as a skeleton —
// reconnect/resume, rate-limit handling, and richer dispatch coverage are
// left as the agent's job to flesh out on first activation.
//
// Shape rules (don't break these without a logged decision):
//   - One gateway connection per extension load. Triggers share it via
//     module-scoped subscriber arrays.
//   - register() opens the gateway (fire-and-forget) and registers the
//     triggers + tools. unload() closes cleanly.
//   - All REST calls use the Bot auth scheme: \`Authorization: Bot <token>\`.
//   - MESSAGE_CONTENT is a privileged intent. Enable it in the Developer
//     Portal, else message.content arrives empty for non-DM, non-mention
//     messages.

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
  received_at: number;
}

interface MemberJoin {
  guild_id: string;
  user_id: string;
  username: string;
  joined_at: number;
}

interface DiscordConfig {
  intents: number;
  apiBase: string;
  gatewayUrl: string;
  includeBotMessages: boolean;
}

// Module-scoped gateway state. One connection per extension load.
let ws: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastSeq: number | null = null;
let sessionId: string | null = null;
let botUserId: string | null = null;
let closing = false;
let cfg: DiscordConfig | null = null;
let authHeader = "";

const channelMessageSubscribers: Array<(p: ChannelMessage) => void> = [];
const memberJoinSubscribers: Array<(p: MemberJoin) => void> = [];

function loadConfig(): DiscordConfig {
  const here = dirname(new URL(import.meta.url).pathname);
  const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
  return manifest.config as DiscordConfig;
}

function sendOp(op: number, d: unknown): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ op, d }));
  }
}

function openGateway(token: string, config: DiscordConfig): void {
  if (ws) return; // already open
  authHeader = \`Bot \${token}\`;
  ws = new WebSocket(config.gatewayUrl);
  ws.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(String((ev as MessageEvent).data));
      handleGatewayMessage(msg, token, config);
    } catch (err) {
      console.error("[discord] dispatch parse error:", err);
    }
  });
  ws.addEventListener("close", () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    ws = null;
    if (!closing) {
      // TODO(agent): exponential backoff + resume via session_id/resume_gateway_url.
      setTimeout(() => openGateway(token, config), 5000);
    }
  });
  ws.addEventListener("error", (err) => {
    console.error("[discord] ws error:", err);
  });
}

function handleGatewayMessage(
  msg: { op: number; d: any; s: number | null; t: string | null },
  token: string,
  config: DiscordConfig,
): void {
  switch (msg.op) {
    case 10: {
      // HELLO — start heartbeat, send IDENTIFY.
      const interval = msg.d.heartbeat_interval as number;
      heartbeatTimer = setInterval(() => sendOp(1, lastSeq), interval);
      sendOp(2, {
        token,
        intents: config.intents,
        properties: { os: process.platform, browser: "olle", device: "olle" },
      });
      break;
    }
    case 11:
      // HEARTBEAT_ACK — TODO(agent): track to detect zombie connection.
      break;
    case 0: {
      if (typeof msg.s === "number") lastSeq = msg.s;
      handleDispatch(msg.t ?? "", msg.d, config);
      break;
    }
    case 7: // RECONNECT
    case 9: // INVALID_SESSION
      try { ws?.close(); } catch {}
      break;
    default:
      break;
  }
}

function handleDispatch(type: string, data: any, config: DiscordConfig): void {
  if (type === "READY") {
    sessionId = data.session_id;
    botUserId = data.user?.id ?? null;
    return;
  }
  if (type === "MESSAGE_CREATE") {
    if (!config.includeBotMessages && data.author?.bot) return;
    const mentions: string[] = (data.mentions ?? []).map((m: any) => m.id);
    const payload: ChannelMessage = {
      message_id: data.id,
      guild_id: data.guild_id ?? null,
      channel_id: data.channel_id,
      thread_id: data.thread_id ?? null,
      author: {
        id: data.author.id,
        name: data.author.username,
        bot: !!data.author.bot,
      },
      content: data.content ?? "",
      mentions,
      reply_to: data.referenced_message?.id ?? null,
      is_dm: !data.guild_id,
      is_mention: botUserId ? mentions.includes(botUserId) : false,
      received_at: Date.now(),
    };
    for (const fn of channelMessageSubscribers) fn(payload);
    return;
  }
  if (type === "GUILD_MEMBER_ADD") {
    const payload: MemberJoin = {
      guild_id: data.guild_id,
      user_id: data.user?.id,
      username: data.user?.username ?? "",
      joined_at: Date.now(),
    };
    for (const fn of memberJoinSubscribers) fn(payload);
    return;
  }
  // TODO(agent): extend for MESSAGE_UPDATE, MESSAGE_DELETE, THREAD_CREATE,
  // INTERACTION_CREATE, etc., as tasks need them.
}

async function discordFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = cfg?.apiBase ?? "https://discord.com/api/v10";
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", authHeader);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const r = await fetch(\`\${base}\${path}\`, { ...init, headers });
  // TODO(agent): on 429, read retry_after and back off instead of throwing.
  if (!r.ok) throw new Error(\`discord \${path}: \${r.status} \${await r.text()}\`);
  return r;
}

export function register(api: any) {
  const token = api.secrets?.DISCORD_TOKEN;
  if (!token) throw new Error("discord: DISCORD_TOKEN not injected; approve the extension proposal and set the secret.");
  cfg = loadConfig();
  closing = false;
  openGateway(token, cfg);

  api.registerTrigger({
    name: "discord-channel-message",
    type: "channel-message",
    start(emit: (p: ChannelMessage) => void) {
      channelMessageSubscribers.push(emit);
    },
    stop() {
      channelMessageSubscribers.length = 0;
    },
  });

  api.registerTrigger({
    name: "discord-member-join",
    type: "member-join",
    start(emit: (p: MemberJoin) => void) {
      memberJoinSubscribers.push(emit);
    },
    stop() {
      memberJoinSubscribers.length = 0;
    },
  });

  api.registerTool({
    name: "discord_send",
    description: "Send a message to a Discord channel or thread. Set reply_to to attach a reply reference.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Discord channel or thread id" },
        content: { type: "string", description: "Message content (plain text or markdown)" },
        reply_to: { type: "string", description: "Message id to reply to" },
      },
      required: ["channel_id", "content"],
      additionalProperties: false,
    },
    async execute({ channel_id, content, reply_to }: { channel_id: string; content: string; reply_to?: string }) {
      const body: Record<string, unknown> = { content };
      if (reply_to) body.message_reference = { message_id: reply_to };
      const r = await discordFetch(\`/channels/\${channel_id}/messages\`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return await r.json();
    },
  });

  api.registerTool({
    name: "discord_react",
    description: "Add a reaction to a message. emoji is unicode (e.g. \\\"👍\\\") or custom \\\"name:id\\\".",
    tier: "strategic",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        message_id: { type: "string" },
        emoji: { type: "string" },
      },
      required: ["channel_id", "message_id", "emoji"],
      additionalProperties: false,
    },
    async execute({ channel_id, message_id, emoji }: { channel_id: string; message_id: string; emoji: string }) {
      const enc = encodeURIComponent(emoji);
      await discordFetch(\`/channels/\${channel_id}/messages/\${message_id}/reactions/\${enc}/@me\`, {
        method: "PUT",
      });
      return { ok: true };
    },
  });

  api.registerTool({
    name: "discord_fetch_context",
    description: "Fetch recent messages in a channel or thread — useful for building chat preamble before calling the chat agent.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        before: { type: "string", description: "Message id; fetch messages before this" },
        limit: { type: "number", minimum: 1, maximum: 100, default: 20 },
      },
      required: ["channel_id"],
      additionalProperties: false,
    },
    async execute({ channel_id, before, limit = 20 }: { channel_id: string; before?: string; limit?: number }) {
      const q = new URLSearchParams({ limit: String(limit) });
      if (before) q.set("before", before);
      const r = await discordFetch(\`/channels/\${channel_id}/messages?\${q}\`);
      return await r.json();
    },
  });

  api.registerTool({
    name: "discord_list_channels",
    description: "List channels the bot can see in a guild.",
    inputSchema: {
      type: "object",
      properties: { guild_id: { type: "string" } },
      required: ["guild_id"],
      additionalProperties: false,
    },
    async execute({ guild_id }: { guild_id: string }) {
      const r = await discordFetch(\`/guilds/\${guild_id}/channels\`);
      return await r.json();
    },
  });
}

export function unload() {
  closing = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  try { ws?.close(); } catch {}
  ws = null;
  sessionId = null;
  botUserId = null;
  channelMessageSubscribers.length = 0;
  memberJoinSubscribers.length = 0;
}
`,
    "smoke.ts":
`// Smoke: validate DISCORD_TOKEN by calling /users/@me. Doesn't open the
// gateway (heavier, side-effecting) — just confirms the token is accepted.
// Token comes from the secrets store only; env is reserved for behavior
// config, never secrets (one source of truth).

export async function smokeTest(_bus, ctx) {
  const token = ctx?.secrets?.DISCORD_TOKEN;
  if (!token) {
    throw new Error("discord smoke: DISCORD_TOKEN not set. Ask olle to store it (set_secret tool) or run: printf %s \\"\\$TOKEN\\" | olle secret set DISCORD_TOKEN");
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: \`Bot \${token}\` },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      throw new Error(\`discord smoke: /users/@me returned \${r.status} \${await r.text()}\`);
    }
    const user = await r.json() as { id?: string; username?: string };
    if (!user?.id) {
      throw new Error("discord smoke: unexpected response shape from /users/@me");
    }
  } finally {
    clearTimeout(t);
  }
}
`,
  },
};
