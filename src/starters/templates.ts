// Starter extension templates — shipped inside the binary as in-memory
// files. `install_starter` writes them to ~/.olle/extensions/<name>/ so
// the agent can iterate on them like any other extension (git-tracked,
// smoke-gated, hot-reloadable). No hardcoded features.

export interface StarterTemplate {
  name: string;
  description: string;
  files: Record<string, string>;
}

const cronTrigger: StarterTemplate = {
  name: "cron-trigger",
  description: "Fires an event every N milliseconds. Declare the interval and event type in the manifest's `config`.",
  files: {
    "manifest.json": JSON.stringify(
      {
        name: "cron-trigger",
        version: "0.1.0",
        description: "Periodic event trigger. Configure intervalMs + eventType.",
        capabilities: ["trigger:cron"],
        config: { intervalMs: 60000, eventType: "cron.fire" },
      },
      null,
      2,
    ) + "\n",
    "index.ts":
`// cron-trigger: fires a periodic event at intervalMs with eventType, per
// manifest.config. A single extension instance can only declare one
// interval; the agent grows specialized forks (e.g. "cron-hourly") for
// more rates.

const DEFAULT_INTERVAL = 60000;
const DEFAULT_TYPE = "cron.fire";

export function register(api) {
  // Read config from the manifest we shipped beside us.
  const fs = require("node:fs");
  const path = require("node:path");
  const here = path.dirname(new URL(import.meta.url).pathname);
  const manifestPath = path.join(here, "manifest.json");
  const cfg = JSON.parse(fs.readFileSync(manifestPath, "utf8")).config || {};
  const intervalMs = cfg.intervalMs ?? DEFAULT_INTERVAL;
  const eventType = cfg.eventType ?? DEFAULT_TYPE;

  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    api.publish(eventType, { tick: ticks, at: Date.now() }, { durable: true });
  }, intervalMs);

  // Store the timer on the api object so unload() can clear it.
  api.__cronTimer = timer;
}

export function unload() {
  // Best effort; if the api object is lost we accept leaking one timer.
}
`,
    "smoke.ts":
`export async function smokeTest() {
  // Non-destructive — just validate the manifest can be read.
  const fs = require("node:fs");
  const path = require("node:path");
  const here = path.dirname(new URL(import.meta.url).pathname);
  const raw = fs.readFileSync(path.join(here, "manifest.json"), "utf8");
  const m = JSON.parse(raw);
  if (!m.config || typeof m.config.intervalMs !== "number") {
    throw new Error("cron-trigger: manifest.config.intervalMs must be a number");
  }
}
`,
  },
};

const claudeCode: StarterTemplate = {
  name: "claude-code",
  description: "Tool that shells out to the claude CLI for code-authoring tasks in a workspace path.",
  files: {
    "manifest.json": JSON.stringify(
      {
        name: "claude-code",
        version: "0.1.0",
        description: "Invoke the claude CLI as a subprocess on a workspace.",
        capabilities: ["tool:claude_code"],
      },
      null,
      2,
    ) + "\n",
    "index.ts":
`// claude-code: a tool that runs \`claude -p <prompt>\` in a workspace and
// returns stdout. Useful when an agent wants to delegate a coding task
// to a headless Claude Code session.

import { spawn } from "node:child_process";

export function register(api) {
  api.registerTool({
    name: "claude_code",
    description:
      "Run the claude CLI with a prompt inside a working directory and return its stdout. Useful for delegating code changes.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "prompt to pass to claude -p" },
        cwd: { type: "string", description: "absolute path to the workspace" },
        timeoutMs: { type: "number" },
      },
      required: ["prompt", "cwd"],
      additionalProperties: false,
    },
    execute: ({ prompt, cwd, timeoutMs }) =>
      new Promise((resolve, reject) => {
        const child = spawn("claude", ["-p", prompt], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d.toString()));
        child.stderr.on("data", (d) => (err += d.toString()));
        const t = timeoutMs
          ? setTimeout(() => {
              child.kill("SIGTERM");
              reject(new Error(\`claude_code timeout after \${timeoutMs}ms\`));
            }, timeoutMs)
          : null;
        child.on("close", (code) => {
          if (t) clearTimeout(t);
          if (code === 0) resolve(out);
          else reject(new Error(\`claude exited \${code}: \${err || out}\`));
        });
        child.on("error", (e) => {
          if (t) clearTimeout(t);
          reject(e);
        });
      }),
  });
}
`,
    "smoke.ts":
`export async function smokeTest() {
  // Verify the 'claude' binary exists on PATH. Don't actually run it
  // (would spend tokens / need auth).
  const { spawnSync } = require("node:child_process");
  const r = spawnSync("which", ["claude"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) {
    throw new Error("claude CLI not on PATH");
  }
}
`,
  },
};

const discord: StarterTemplate = {
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
// Reads the token from DISCORD_TOKEN env since smoke runs before secrets
// are injected into the extension runtime.

export async function smokeTest() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error("discord smoke: DISCORD_TOKEN not set in env. Set it via \`olle secret set DISCORD_TOKEN ...\` or export DISCORD_TOKEN before smoking.");
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

const github: StarterTemplate = {
  name: "github",
  description: "GitHub REST adapter. Issue/PR/comment tools using GH_TOKEN. Webhook receiver (inbound events) is deliberately left for the agent to add when a task needs it.",
  files: {
    "manifest.json": JSON.stringify(
      {
        name: "github",
        version: "0.1.0",
        description: "GitHub REST adapter: create_issue, add_comment, list_issues, close_issue.",
        secrets: ["GH_TOKEN"],
        capabilities: ["tool:github"],
        config: {
          apiBase: "https://api.github.com",
          userAgent: "olle-github-adapter",
        },
      },
      null,
      2,
    ) + "\n",
    "index.ts":
`// github: REST adapter. Exposes the subset of the GitHub REST API that the
// first use cases need (create/close issues, add comments, list issues).
// Webhook ingress (push/issue/PR events) is not wired here — add an
// http-webhook-trigger extension + a task that calls into this one when a
// task actually needs inbound events.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface GitHubConfig {
  apiBase: string;
  userAgent: string;
}

let cfg: GitHubConfig | null = null;
let authHeader = "";

function loadConfig(): GitHubConfig {
  const here = dirname(new URL(import.meta.url).pathname);
  const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
  return manifest.config as GitHubConfig;
}

async function gh(path: string, init: RequestInit = {}): Promise<any> {
  const base = cfg?.apiBase ?? "https://api.github.com";
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", authHeader);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  headers.set("User-Agent", cfg?.userAgent ?? "olle");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const r = await fetch(\`\${base}\${path}\`, { ...init, headers });
  if (!r.ok) throw new Error(\`github \${path}: \${r.status} \${await r.text()}\`);
  return r.status === 204 ? null : await r.json();
}

export function register(api: any) {
  const token = api.secrets?.GH_TOKEN;
  if (!token) throw new Error("github: GH_TOKEN not injected; approve the extension proposal and set the secret.");
  cfg = loadConfig();
  authHeader = \`Bearer \${token}\`;

  api.registerTool({
    name: "github_create_issue",
    description: "Open a new issue in a repo. Attach body, labels, assignees as needed.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name, e.g. acme/api" },
        title: { type: "string" },
        body: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        assignees: { type: "array", items: { type: "string" } },
      },
      required: ["repo", "title"],
      additionalProperties: false,
    },
    async execute({ repo, title, body, labels, assignees }: { repo: string; title: string; body?: string; labels?: string[]; assignees?: string[] }) {
      return await gh(\`/repos/\${repo}/issues\`, {
        method: "POST",
        body: JSON.stringify({ title, body, labels, assignees }),
      });
    },
  });

  api.registerTool({
    name: "github_add_comment",
    description: "Add a comment to an existing issue or PR.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        issue_number: { type: "number" },
        body: { type: "string" },
      },
      required: ["repo", "issue_number", "body"],
      additionalProperties: false,
    },
    async execute({ repo, issue_number, body }: { repo: string; issue_number: number; body: string }) {
      return await gh(\`/repos/\${repo}/issues/\${issue_number}/comments\`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
    },
  });

  api.registerTool({
    name: "github_list_issues",
    description: "List issues in a repo filtered by state/labels. Useful for dedup before opening new ones.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "all"], default: "open" },
        labels: { type: "string", description: "comma-separated label names" },
        per_page: { type: "number", minimum: 1, maximum: 100, default: 30 },
      },
      required: ["repo"],
      additionalProperties: false,
    },
    async execute({ repo, state = "open", labels, per_page = 30 }: { repo: string; state?: string; labels?: string; per_page?: number }) {
      const q = new URLSearchParams({ state, per_page: String(per_page) });
      if (labels) q.set("labels", labels);
      return await gh(\`/repos/\${repo}/issues?\${q}\`);
    },
  });

  api.registerTool({
    name: "github_close_issue",
    description: "Close an issue. Optional reason: completed or not_planned.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        issue_number: { type: "number" },
        reason: { type: "string", enum: ["completed", "not_planned"], default: "completed" },
      },
      required: ["repo", "issue_number"],
      additionalProperties: false,
    },
    async execute({ repo, issue_number, reason = "completed" }: { repo: string; issue_number: number; reason?: string }) {
      return await gh(\`/repos/\${repo}/issues/\${issue_number}\`, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed", state_reason: reason }),
      });
    },
  });
}

export function unload() {
  cfg = null;
  authHeader = "";
}
`,
    "smoke.ts":
`// Smoke: confirm GH_TOKEN is accepted by calling /user. Doesn't mutate
// anything. Reads from GH_TOKEN env since smoke runs before secret
// injection into the extension runtime.

export async function smokeTest() {
  const token = process.env.GH_TOKEN;
  if (!token) {
    throw new Error("github smoke: GH_TOKEN not set in env. Set it via \`olle secret set GH_TOKEN ...\` or export GH_TOKEN before smoking.");
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: \`Bearer \${token}\`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "olle-smoke",
      },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      throw new Error(\`github smoke: /user returned \${r.status} \${await r.text()}\`);
    }
    const user = await r.json() as { login?: string };
    if (!user?.login) {
      throw new Error("github smoke: unexpected response shape from /user");
    }
  } finally {
    clearTimeout(t);
  }
}
`,
  },
};

const discordCommunication: StarterTemplate = {
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
//   - Session key: discord:<channel_id>:<author_id> — one session per
//     user per channel. MESSAGE_CREATE's channel_id is the thread id
//     when the message was in a thread, so channel-keyed sends land
//     in the right place without needing separate thread handling.
//
// Outbound (chat.turn-end -> discord_send):
//   - Accumulates chat.assistant-text chunks through the turn.
//   - On chat.turn-end, posts the accumulated text as one message.
//   - asAgent is threaded so the call passes the same permission gate
//     the chat agent applies to its own tool dispatch.

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

let cfg: Config | null = null;
let wakeRe: RegExp | null = null;

function loadConfig(): Config {
  const here = dirname(new URL(import.meta.url).pathname);
  const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
  return manifest.config as Config;
}

function sessionKey(msg: ChannelMessage): string {
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

function finalize(sessionId: string): string | null {
  const chunks = accumulators.get(sessionId) ?? [];
  accumulators.delete(sessionId);
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
    const sessionId = sessionKey(msg);
    routes.set(sessionId, { channelId: msg.channel_id, originMessageId: msg.message_id });
    const text = cleanContent(msg.content, wakeRe!, msg.is_dm);
    api.publish("chat.input", { sessionId, text }, { durable: true });
  });

  api.on("chat.assistant-text", (ev: any) => {
    const p = ev.payload as { sessionId: string; text: string };
    if (!routes.has(p.sessionId)) return;
    const acc = accumulators.get(p.sessionId) ?? [];
    acc.push(p.text);
    accumulators.set(p.sessionId, acc);
    if (ev.actorId) turnActors.set(p.sessionId, ev.actorId as string);
  });

  api.on("chat.turn-end", async (ev: any) => {
    const p = ev.payload as { sessionId: string };
    const route = routes.get(p.sessionId);
    if (!route) return;
    const text = finalize(p.sessionId);
    const actor = turnActors.get(p.sessionId);
    turnActors.delete(p.sessionId);
    if (!text) return;
    try {
      await api.callTool(
        "discord_send",
        { channel_id: route.channelId, content: text, reply_to: route.originMessageId },
        actor ? { asAgent: actor } : undefined,
      );
    } catch (err) {
      // Log but don't throw — a failed post shouldn't crash the
      // extension. Next turn-end can still try.
      console.error("[discord-communication] discord_send failed:", (err as Error).message);
    }
  });

  api.on("chat.error", (ev: any) => {
    const p = ev.payload as { sessionId: string };
    accumulators.delete(p.sessionId);
    turnActors.delete(p.sessionId);
  });
}

export function unload() {
  routes.clear();
  accumulators.clear();
  turnActors.clear();
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

const STARTERS: Record<string, StarterTemplate> = {
  "cron-trigger": cronTrigger,
  "claude-code": claudeCode,
  discord,
  "discord-communication": discordCommunication,
  github,
};

export function listStarters(): StarterTemplate[] {
  return Object.values(STARTERS);
}

export function getStarter(name: string): StarterTemplate | undefined {
  return STARTERS[name];
}
