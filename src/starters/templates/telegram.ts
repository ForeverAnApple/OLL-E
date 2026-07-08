import type { StarterTemplate } from "./types.ts";

export const telegram: StarterTemplate = {
  name: "telegram",
  description: "Telegram Bot adapter. Long-polls getUpdates, emits channel-message triggers with the discord-parity payload shape, exposes telegram_send (HTML, chunked) and telegram_fetch_context tools.",
  files: {
    "manifest.json": JSON.stringify(
      {
        name: "telegram",
        version: "0.1.0",
        description: "Telegram Bot adapter: channel-message trigger + REST tools via long polling.",
        secrets: ["TELEGRAM_BOT_TOKEN"],
        capabilities: ["channel:telegram", "trigger:channel-message"],
        eventWrites: ["channel-message"],
        config: {
          apiBase: "https://api.telegram.org",
          // Long-poll hold time in seconds. Telegram holds the getUpdates
          // request open this long before returning empty.
          pollTimeoutSec: 30,
          // Backoff after a failed poll before retrying.
          pollErrorBackoffMs: 3000,
          // Telegram parse mode. HTML is chosen over MarkdownV2 because
          // MarkdownV2 requires escaping ~18 characters that appear all over
          // normal LLM prose; HTML needs only & < > escaped, which we do
          // unconditionally in telegram_send.
          parseMode: "HTML",
        },
      },
      null,
      2,
    ) + "\n",
    "index.ts":
`// telegram: Bot API adapter. Long-polls getUpdates in a loop, turns each
// text message into a channel-message event (same payload shape as the
// discord adapter so bridges are structurally identical), and exposes two
// REST tools. One bot connection per extension load.
//
// Shape rules (don't break without a logged decision):
//   - getMe runs first so we fail fast on a bad token and learn our own
//     bot id/username (for @mention detection).
//   - The poll offset is persisted to scratchDir/offset.json so a reload
//     doesn't re-deliver the backlog Telegram still holds.
//   - unload() flips stopped AND aborts the in-flight poll. A 30s blocking
//     getUpdates that survives unload would double-poll after reload —
//     aborting is not optional.
//   - telegram_send HTML-escapes & < > ALWAYS and sends parse_mode HTML.
//     We never let the LLM emit raw markup; escaping is the safety floor.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface TelegramConfig {
  apiBase: string;
  pollTimeoutSec: number;
  pollErrorBackoffMs: number;
  parseMode: string;
}

// Same shape the discord adapter emits — bridges depend on parity. The
// source tag lets a bridge ignore the other channel's messages when both
// adapters are loaded (both emit channel-message on one bus).
interface ChannelMessage {
  source: "telegram";
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

interface SeenMessage {
  chat_id: string;
  message_id: string;
  author: string;
  content: string;
  at: number;
}

let cfg: TelegramConfig | null = null;
let apiUrl = ""; // \`\${apiBase}/bot\${token}\`
let stopped = false;
let pollController: AbortController | null = null;
let offset = 0;
let scratchDir = "";
let botId: string | null = null;
let botUsername: string | null = null;

const channelMessageSubscribers: Array<(p: ChannelMessage) => void> = [];
// Honest history: Telegram's Bot API exposes no history endpoint, so the
// only messages we can ever surface are the ones we saw live. Ring buffer.
const seen: SeenMessage[] = [];
const SEEN_CAP = 200;

function loadConfig(): TelegramConfig {
  const here = dirname(new URL(import.meta.url).pathname);
  const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
  return manifest.config as TelegramConfig;
}

function offsetPath(): string {
  return join(scratchDir, "offset.json");
}

function loadOffset(): void {
  try {
    const raw = readFileSync(offsetPath(), "utf8");
    const j = JSON.parse(raw);
    if (typeof j.offset === "number") offset = j.offset;
  } catch {
    /* first run — no persisted offset */
  }
}

function persistOffset(): void {
  try {
    writeFileSync(offsetPath(), JSON.stringify({ offset }));
  } catch (err) {
    console.error("[telegram] failed to persist offset:", (err as Error).message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function tg(
  method: string,
  opts: { query?: Record<string, string>; body?: unknown; signal?: AbortSignal } = {},
): Promise<any> {
  const url = new URL(\`\${apiUrl}/\${method}\`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
  }
  const init: RequestInit = { signal: opts.signal };
  if (opts.body !== undefined) {
    init.method = "POST";
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  const r = await fetch(url, init);
  const data = (await r.json()) as { ok?: boolean; result?: any; description?: string };
  if (!r.ok || !data.ok) {
    throw new Error(\`telegram \${method}: \${r.status} \${data.description ?? JSON.stringify(data)}\`);
  }
  return data.result;
}

function extractMentions(msg: any): string[] {
  const ents = msg.entities ?? [];
  const text: string = typeof msg.text === "string" ? msg.text : "";
  const out: string[] = [];
  for (const e of ents) {
    if (e.type === "mention") {
      out.push(text.substring(e.offset, e.offset + e.length).replace(/^@/, ""));
    } else if (e.type === "text_mention" && e.user?.id) {
      out.push(String(e.user.id));
    }
  }
  return out;
}

function handleUpdate(u: any): void {
  const msg = u.message ?? u.edited_message ?? u.channel_post;
  if (!msg || typeof msg.text !== "string") return;
  const chat = msg.chat ?? {};
  const from = msg.from ?? {};
  const payload: ChannelMessage = {
    source: "telegram",
    message_id: String(msg.message_id),
    guild_id: null,
    channel_id: String(chat.id),
    thread_id: msg.message_thread_id != null ? String(msg.message_thread_id) : null,
    author: {
      id: String(from.id ?? ""),
      name: from.username ?? from.first_name ?? "",
      bot: !!from.is_bot,
    },
    content: msg.text,
    mentions: extractMentions(msg),
    reply_to: msg.reply_to_message?.message_id != null ? String(msg.reply_to_message.message_id) : null,
    is_dm: chat.type === "private",
    is_mention: botUsername ? msg.text.includes("@" + botUsername) : false,
    received_at: Date.now(),
  };
  seen.push({
    chat_id: payload.channel_id,
    message_id: payload.message_id,
    author: payload.author.name,
    content: payload.content,
    at: payload.received_at,
  });
  if (seen.length > SEEN_CAP) seen.splice(0, seen.length - SEEN_CAP);
  for (const fn of channelMessageSubscribers) fn(payload);
}

async function startPolling(): Promise<void> {
  try {
    const me = await tg("getMe");
    botId = String(me.id);
    botUsername = me.username ?? null;
  } catch (err) {
    console.error("[telegram] getMe failed, not polling:", (err as Error).message);
    return;
  }
  while (!stopped) {
    pollController = new AbortController();
    try {
      const updates = (await tg("getUpdates", {
        query: { offset: String(offset), timeout: String(cfg?.pollTimeoutSec ?? 30) },
        signal: pollController.signal,
      })) as any[];
      for (const u of updates ?? []) {
        offset = Math.max(offset, u.update_id + 1);
        handleUpdate(u);
      }
      if (updates && updates.length) persistOffset();
    } catch (err) {
      if (stopped || (err as Error).name === "AbortError") break;
      console.error("[telegram] getUpdates error:", (err as Error).message);
      await sleep(cfg?.pollErrorBackoffMs ?? 3000);
    }
  }
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Split on whitespace at or under Telegram's 4096-char message cap. Caps the
// number of chunks so a runaway payload can't fan out into dozens of sends.
function chunkText(s: string, max = 4096, cap = 20): string[] {
  const chunks: string[] = [];
  let rest = s;
  while (rest.length > 0 && chunks.length < cap) {
    if (rest.length <= max) {
      chunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf("\\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\\s+/, "");
  }
  return chunks;
}

export function register(api: any) {
  const token = api.secrets?.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("telegram: TELEGRAM_BOT_TOKEN not injected; approve the extension proposal and set the secret.");
  cfg = loadConfig();
  apiUrl = \`\${cfg.apiBase}/bot\${token}\`;
  scratchDir = api.scratchDir;
  stopped = false;
  loadOffset();
  void startPolling();

  api.registerTrigger({
    name: "telegram-channel-message",
    type: "channel-message",
    start(emit: (p: ChannelMessage) => void) {
      channelMessageSubscribers.push(emit);
    },
    stop() {
      channelMessageSubscribers.length = 0;
    },
  });

  api.registerTool({
    name: "telegram_send",
    description:
      "Send a message to a Telegram chat. Content is HTML-escaped and sent with parse_mode HTML; messages over 4096 chars are split on whitespace. Set reply_to to a message id to attach a reply.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Telegram chat id (numeric string) or @channelusername" },
        text: { type: "string", description: "Message text (plain — it will be HTML-escaped)" },
        reply_to: { type: "string", description: "Message id to reply to" },
      },
      required: ["chat_id", "text"],
      additionalProperties: false,
    },
    async execute({ chat_id, text, reply_to }: { chat_id: string; text: string; reply_to?: string }) {
      const chunks = chunkText(htmlEscape(text));
      const messageIds: number[] = [];
      for (const [i, chunk] of chunks.entries()) {
        const body: Record<string, unknown> = {
          chat_id,
          text: chunk,
          parse_mode: cfg?.parseMode ?? "HTML",
        };
        // Attach the reply only to the first chunk; the rest continue the thread.
        if (reply_to && i === 0) body.reply_to_message_id = Number(reply_to);
        const res = await tg("sendMessage", { body });
        messageIds.push(res.message_id);
      }
      return { ok: true, message_ids: messageIds };
    },
  });

  api.registerTool({
    name: "telegram_fetch_context",
    description:
      "Return recent messages this adapter has SEEN in a chat since it loaded. HONEST LIMITATION: the Telegram Bot API has no message-history endpoint, so this is only an in-memory ring buffer of messages that arrived while the adapter was running. It cannot fetch older history and is empty after a reload.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 100, default: 20 },
      },
      required: ["chat_id"],
      additionalProperties: false,
    },
    async execute({ chat_id, limit = 20 }: { chat_id: string; limit?: number }) {
      const rows = seen.filter((m) => m.chat_id === chat_id);
      return rows.slice(Math.max(0, rows.length - limit));
    },
  });
}

export function unload() {
  stopped = true;
  // Abort the in-flight long poll so we don't keep an orphaned 30s request
  // alive across the reload (which would double-poll and re-deliver).
  try { pollController?.abort(); } catch {}
  pollController = null;
  persistOffset();
  channelMessageSubscribers.length = 0;
  seen.length = 0;
  botId = null;
  botUsername = null;
}
`,
    "smoke.ts":
`// Smoke: validate TELEGRAM_BOT_TOKEN by calling getMe. No polling, no
// side effects. Token comes from the secrets store only.

export async function smokeTest(_bus, ctx) {
  const token = ctx?.secrets?.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("telegram smoke: TELEGRAM_BOT_TOKEN not set. Ask olle to store it (set_secret tool) or run: printf %s \\"\\$TOKEN\\" | olle secret set TELEGRAM_BOT_TOKEN");
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(\`https://api.telegram.org/bot\${token}/getMe\`, {
      signal: ctrl.signal,
    });
    const data = await r.json() as { ok?: boolean; result?: { id?: number; username?: string }; description?: string };
    if (!r.ok || !data.ok) {
      throw new Error(\`telegram smoke: getMe returned \${r.status} \${data.description ?? ""}\`);
    }
    if (!data.result?.id) {
      throw new Error("telegram smoke: unexpected response shape from getMe");
    }
  } finally {
    clearTimeout(t);
  }
}
`,
    "SETUP.md":
`# telegram — setup

## What it does
Turns a Telegram bot into an event source for olle. It long-polls Telegram's
getUpdates endpoint and emits a channel-message event for each text message,
using the same payload shape as the discord adapter (so bridges are
identical). It registers two tools: telegram_send (HTML, auto-chunked) and
telegram_fetch_context.

Like discord, this is only the pipe. To chat with olle on Telegram you also
install telegram-communication.

## Secret
- TELEGRAM_BOT_TOKEN — the token BotFather hands you.

## Getting the token (walk the human through this)
1. In Telegram, open a chat with @BotFather.
2. Send /newbot. Follow the prompts: give the bot a display name, then a
   username ending in "bot".
3. BotFather replies with a token like 123456789:ABCdef... — that is
   TELEGRAM_BOT_TOKEN.
4. THE GOTCHA — privacy mode. By default a bot in a GROUP only receives
   messages that @mention it or reply to it (DMs are always delivered in
   full). If you want the bot to see all group messages, send BotFather
   /setprivacy, pick the bot, and Disable privacy. For DM-only use you can
   leave it on.
5. To DM the bot, open its username link and press Start. To use it in a
   group, add it as a member.

## Install script (narrate this to the human)
    install_starter("telegram")
    set_secret("TELEGRAM_BOT_TOKEN", "<the token>")
    register_extension("telegram")

register runs the smoke test first (a getMe call). If it passes, polling
starts and messages flow.

## Config knobs (manifest.json, config object)
- pollTimeoutSec — long-poll hold time, default 30. Higher = fewer requests.
- pollErrorBackoffMs — wait after a failed poll before retrying, default 3000.
- parseMode — default HTML. Leave it. MarkdownV2 needs escaping that mangles
  normal prose; HTML needs only & < > escaped, which the send tool always does.
- apiBase — default https://api.telegram.org. Leave unless self-hosting.

## Guardrails
- NEVER paste the token into chat. Route it through set_secret so it is
  redacted from logs and persisted sessions.
- A leaked token = full control of the bot. Ask BotFather to /revoke and
  reissue if it ever lands in plaintext.
- telegram_fetch_context only knows messages seen since load — it is not a
  history search. Don't rely on it for anything before the adapter started.
`,
  },
};
