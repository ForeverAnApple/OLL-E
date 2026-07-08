import type { StarterTemplate } from "./types.ts";

export const telegram: StarterTemplate = {
  name: "telegram",
  description:
    "Telegram Bot adapter. Long-polls getUpdates, emits channel-message triggers with the discord-parity payload shape, renders markdown to Telegram-HTML, and exposes telegram_send, telegram_stream (draft-streaming/edit-loop progressive replies), telegram_typing, telegram_fetch_context.",
  files: {
    "manifest.json": JSON.stringify(
      {
        name: "telegram",
        version: "0.2.0",
        description: "Telegram Bot adapter: channel-message trigger + REST tools via long polling, with streaming replies and presence.",
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
        },
      },
      null,
      2,
    ) + "\n",
    "index.ts":
`// telegram: Bot API adapter. Long-polls getUpdates in a loop, turns each
// text message into a channel-message event (same payload shape as the
// discord adapter so bridges are structurally identical), and exposes REST
// tools. One bot connection per extension load.
//
// Shape rules (don't break without a logged decision):
//   - getMe runs first so we fail fast on a bad token and learn our own
//     bot id/username (for @mention detection).
//   - The poll offset is persisted to scratchDir/offset.json so a reload
//     doesn't re-deliver the backlog Telegram still holds.
//   - unload() flips stopped AND aborts the in-flight poll. A 30s blocking
//     getUpdates that survives unload would double-poll after reload —
//     aborting is not optional.
//   - Outbound text is agent markdown rendered to Telegram's HTML tag set
//     by mdToHtml(). Anything outside the supported tags is escaped, so
//     LLM output can never smuggle raw markup; if Telegram still rejects
//     the entities the send retries as plain text — content never drops.
//   - telegram_stream is stateful on purpose: streaming is a session
//     (presence -> throttled partials -> one formatted finalize), and the
//     flood-control state (lastSentAt, retry_after suspensions) must live
//     next to the token that pays for violating it. Mid-stream text is
//     ALWAYS plain — partial markdown renders as broken entities and 400s.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface TelegramConfig {
  apiBase: string;
  pollTimeoutSec: number;
  pollErrorBackoffMs: number;
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
  const data = (await r.json()) as {
    ok?: boolean;
    result?: any;
    description?: string;
    parameters?: { retry_after?: number };
  };
  if (!r.ok || !data.ok) {
    const err = new Error(\`telegram \${method}: \${r.status} \${data.description ?? JSON.stringify(data)}\`);
    // Flood control: Telegram says exactly how long to shut up. Carry it.
    (err as any).retry_after = data.parameters?.retry_after;
    throw err;
  }
  return data.result;
}

function isParseError(err: unknown): boolean {
  return /can't parse entities/i.test(String((err as Error)?.message ?? ""));
}

// Editing a message to its current content is a 400, not a no-op. Treat as
// success everywhere — the state we wanted is the state that exists.
function isNotModified(err: unknown): boolean {
  return /message is not modified/i.test(String((err as Error)?.message ?? ""));
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
        query: {
          offset: String(offset),
          timeout: String(cfg?.pollTimeoutSec ?? 30),
          // allowed_updates is sticky server-side; pin it so a stale setting
          // from an older build can't silently filter what we receive.
          allowed_updates: JSON.stringify(["message", "edited_message", "channel_post"]),
        },
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

// ---------- formatting: agent markdown -> Telegram HTML ----------
// Telegram renders no markdown; it accepts a fixed HTML tag set (b/i/s/
// code/pre/a/blockquote). We render the markdown LLMs actually emit and
// escape everything else. HTML over MarkdownV2 because MarkdownV2 demands
// escaping ~18 characters that appear all over normal prose; HTML needs
// only & < > — and half-finished HTML is machine-detectable, which the
// plain-text fallback relies on.

function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Inline transforms over already-escaped text. Code spans are pulled out
// first so bold/italic/link patterns can't fire inside them.
function inlineMd(s: string): string {
  const spans: string[] = [];
  s = s.replace(/\`([^\`\\n]+)\`/g, (_m, c) => {
    spans.push(\`<code>\${c}</code>\`);
    return \`\\x00\${spans.length - 1}\\x00\`;
  });
  s = s.replace(/\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, (_m, label, url) => {
    return \`<a href="\${url.replace(/"/g, "&quot;")}">\${label}</a>\`;
  });
  s = s.replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<b>$1</b>");
  // Italic requires word-ish boundaries so snake_case and a*b survive.
  s = s.replace(/(^|\\s)\\*([^*\\n]+)\\*(?=[\\s.,;:!?)]|$)/g, "$1<i>$2</i>");
  s = s.replace(/(^|\\s)_([^_\\n]+)_(?=[\\s.,;:!?)]|$)/g, "$1<i>$2</i>");
  s = s.replace(/~~([^~\\n]+)~~/g, "<s>$1</s>");
  return s.replace(/\\x00(\\d+)\\x00/g, (_m, i) => spans[Number(i)]!);
}

function mdToHtml(md: string): string {
  // Fenced code blocks come out first, escaped verbatim.
  const blocks: string[] = [];
  let text = md.replace(/\`\`\`([A-Za-z0-9_+#.-]*)[^\\S\\n]*\\n?([\\s\\S]*?)\`\`\`/g, (_m, lang, code) => {
    const cls = lang ? \` class="language-\${lang}"\` : "";
    blocks.push(\`<pre><code\${cls}>\${htmlEscape(code.replace(/\\n$/, ""))}</code></pre>\`);
    return \`\\x00B\${blocks.length - 1}\\x00\`;
  });
  text = htmlEscape(text);
  const lines = text.split("\\n").map((line) => {
    const h = /^#{1,6}\\s+(.*)$/.exec(line);
    if (h) return \`<b>\${inlineMd(h[1]!)}</b>\`;
    const q = /^&gt;\\s?(.*)$/.exec(line);
    if (q) return \`<blockquote>\${inlineMd(q[1]!)}</blockquote>\`;
    const li = /^(\\s*)[-*]\\s+(.*)$/.exec(line);
    if (li) return \`\${li[1]}• \${inlineMd(li[2]!)}\`;
    return inlineMd(line);
  });
  // Contiguous quote lines merge into one bubble.
  text = lines.join("\\n").replace(/<\\/blockquote>\\n<blockquote>/g, "\\n");
  return text.replace(/\\x00B(\\d+)\\x00/g, (_m, i) => blocks[Number(i)]!);
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

// Chunk markdown with headroom for entity expansion, and never leave a code
// fence dangling across a boundary: a chunk holding an odd number of \`\`\`
// gets a closer appended, and the fence reopens at the top of the next.
function chunkMarkdown(s: string, max = 3500, cap = 20): string[] {
  const chunks = chunkText(s, max, cap);
  let open = false;
  for (let i = 0; i < chunks.length; i++) {
    let c = chunks[i]!;
    if (open) c = "\`\`\`\\n" + c;
    open = ((c.match(/\`\`\`/g) ?? []).length % 2) === 1;
    if (open && i < chunks.length - 1) c += "\\n\`\`\`";
    chunks[i] = c;
  }
  return chunks;
}

// One formatted send. HTML first; if Telegram rejects the entities, plain
// text — the reply always lands.
async function sendChunk(chatId: string, md: string, replyTo?: string, threadId?: number): Promise<number> {
  const base: Record<string, unknown> = { chat_id: chatId, link_preview_options: { is_disabled: true } };
  if (threadId != null) base.message_thread_id = threadId;
  if (replyTo) base.reply_parameters = { message_id: Number(replyTo), allow_sending_without_reply: true };
  try {
    const res = await tg("sendMessage", { body: { ...base, text: mdToHtml(md), parse_mode: "HTML" } });
    return res.message_id as number;
  } catch (err) {
    if (!isParseError(err)) throw err;
    const res = await tg("sendMessage", { body: { ...base, text: md } });
    return res.message_id as number;
  }
}

async function editFormatted(chatId: string, messageId: number, md: string): Promise<void> {
  const base: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    link_preview_options: { is_disabled: true },
  };
  try {
    await tg("editMessageText", { body: { ...base, text: mdToHtml(md), parse_mode: "HTML" } });
  } catch (err) {
    if (isNotModified(err)) return;
    if (!isParseError(err)) throw err;
    try {
      await tg("editMessageText", { body: { ...base, text: md } });
    } catch (err2) {
      if (!isNotModified(err2)) throw err2;
    }
  }
}

// ---------- streaming sessions ----------
// One session per in-flight reply. Tier "draft" is native draft streaming
// (sendMessageDraft, Bot API 9.5+; private chats only — positive chat ids):
// an empty first draft renders the client's own "Thinking…" placeholder,
// updates animate, nothing persists until the finalize sendMessage, and an
// abandoned draft self-expires in ~30s. Tier "edit" is the classic loop for
// groups and servers without drafts: sendMessage once, then throttled
// editMessageText with a cursor, finalized by an in-place formatted edit.
// A draft failure before the first successful draft demotes to "edit".

interface StreamSession {
  chatId: string;
  threadId?: number;
  tier: "draft" | "edit";
  draftId: number;
  draftOk: boolean;
  messageId: number | null;
  lastText: string;
  lastSentAt: number;
  suspendedUntil: number;
  presenceTimer: ReturnType<typeof setInterval> | null;
}

const CURSOR = " ▌";
const streams = new Map<string, StreamSession>();
let nextDraftId = 1;

function getStream(session: string, chatId: string, threadId?: number): StreamSession {
  let s = streams.get(session);
  if (!s) {
    s = {
      chatId,
      threadId,
      tier: Number(chatId) > 0 ? "draft" : "edit",
      draftId: nextDraftId++,
      draftOk: false,
      messageId: null,
      lastText: "",
      lastSentAt: 0,
      suspendedUntil: 0,
      presenceTimer: null,
    };
    streams.set(session, s);
  }
  return s;
}

function suspendOn429(s: StreamSession, err: unknown): void {
  const ra = (err as any)?.retry_after;
  if (typeof ra === "number") s.suspendedUntil = Date.now() + Math.min(ra * 1000, 60_000);
}

// Presence. Typing lasts ~5s and no API call stops it, so the edit tier
// re-pulses every 4s for the whole session — that keeps the indicator alive
// through silent tool-running stretches, and each real send just clears it
// until the next pulse. Drafts self-expire in ~30s, so the draft tier
// re-sends the current draft when nothing has gone out for 20s.
function armPresence(s: StreamSession): void {
  if (s.presenceTimer) return;
  s.presenceTimer = setInterval(() => {
    void (async () => {
      try {
        if (s.tier === "edit") {
          const body: Record<string, unknown> = { chat_id: s.chatId, action: "typing" };
          if (s.threadId != null) body.message_thread_id = s.threadId;
          await tg("sendChatAction", { body });
        } else if (Date.now() - s.lastSentAt > 20_000) {
          await tg("sendMessageDraft", {
            body: { chat_id: Number(s.chatId), draft_id: s.draftId, text: s.lastText.slice(0, 4096) },
          });
          s.lastSentAt = Date.now();
        }
      } catch {
        /* presence is best-effort */
      }
    })();
  }, 4_000);
}

function endStream(session: string): StreamSession | undefined {
  const s = streams.get(session);
  if (s?.presenceTimer) clearInterval(s.presenceTimer);
  if (s) s.presenceTimer = null;
  streams.delete(session);
  return s;
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
      "Send a message to a Telegram chat. Text is markdown — **bold**, *italic*, \`code\`, fenced code blocks, [links](url), > quotes, # headings, bullets render natively; anything else is escaped. Falls back to plain text if Telegram rejects the markup. Long messages split on whitespace. Set reply_to to a message id to attach a reply.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Telegram chat id (numeric string) or @channelusername" },
        text: { type: "string", description: "Message text (markdown)" },
        reply_to: { type: "string", description: "Message id to reply to" },
        thread_id: { type: "string", description: "Forum topic id, if the chat uses topics" },
      },
      required: ["chat_id", "text"],
      additionalProperties: false,
    },
    async execute({ chat_id, text, reply_to, thread_id }: { chat_id: string; text: string; reply_to?: string; thread_id?: string }) {
      const tid = thread_id != null ? Number(thread_id) : undefined;
      const chunks = chunkMarkdown(text);
      const messageIds: number[] = [];
      for (const [i, chunk] of chunks.entries()) {
        // Attach the reply only to the first chunk; the rest continue it.
        messageIds.push(await sendChunk(chat_id, chunk, i === 0 ? reply_to : undefined, tid));
      }
      return { ok: true, message_ids: messageIds };
    },
  });

  api.registerTool({
    name: "telegram_typing",
    description:
      "Show a chat action ('typing' by default; also upload_photo, upload_document, record_voice, …) in a Telegram chat. Displays for ~5 seconds or until the bot's next message; re-call to keep it alive. telegram_stream manages presence automatically — call this only for one-off work outside a stream session.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        action: { type: "string", default: "typing" },
        thread_id: { type: "string", description: "Forum topic id, if the chat uses topics" },
      },
      required: ["chat_id"],
      additionalProperties: false,
    },
    async execute({ chat_id, action = "typing", thread_id }: { chat_id: string; action?: string; thread_id?: string }) {
      const body: Record<string, unknown> = { chat_id, action };
      if (thread_id != null) body.message_thread_id = Number(thread_id);
      await tg("sendChatAction", { body });
      return { ok: true };
    },
  });

  api.registerTool({
    name: "telegram_stream",
    description:
      "Progressive delivery of one in-flight reply. phase='start' shows presence the moment work begins (native 'Thinking…' draft bubble in private chats, typing indicator in groups). phase='update' streams the full accumulated text so far (throttled internally; plain text until finalize). phase='finalize' renders markdown and delivers the final message(s). phase='cancel' tears the session down. session is any stable id for the reply — the telegram-communication bridge uses its thread id.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Stable id for this in-flight reply" },
        chat_id: { type: "string" },
        phase: { type: "string", enum: ["start", "update", "finalize", "cancel"] },
        text: { type: "string", description: "Full accumulated text (update) or final text (finalize), markdown" },
        reply_to: { type: "string", description: "Message id the finalized reply should attach to" },
        thread_id: { type: "string", description: "Forum topic id, if the chat uses topics" },
      },
      required: ["session", "chat_id", "phase"],
      additionalProperties: false,
    },
    async execute({ session, chat_id, phase, text = "", reply_to, thread_id }: {
      session: string;
      chat_id: string;
      phase: "start" | "update" | "finalize" | "cancel";
      text?: string;
      reply_to?: string;
      thread_id?: string;
    }) {
      const tid = thread_id != null ? Number(thread_id) : undefined;

      if (phase === "start") {
        const s = getStream(session, chat_id, tid);
        if (s.tier === "draft") {
          try {
            // Empty draft = the client's native "Thinking…" placeholder.
            await tg("sendMessageDraft", { body: { chat_id: Number(chat_id), draft_id: s.draftId, text: "" } });
            s.draftOk = true;
            s.lastSentAt = Date.now();
          } catch {
            s.tier = "edit"; // server without drafts — typing it is
          }
        }
        if (s.tier === "edit") {
          try {
            const body: Record<string, unknown> = { chat_id, action: "typing" };
            if (tid != null) body.message_thread_id = tid;
            await tg("sendChatAction", { body });
          } catch {
            /* presence is best-effort */
          }
        }
        armPresence(s);
        return { ok: true, tier: s.tier };
      }

      if (phase === "update") {
        const s = getStream(session, chat_id, tid);
        armPresence(s);
        const now = Date.now();
        if (!text || text === s.lastText || now < s.suspendedUntil) return { ok: true, skipped: true };

        if (s.tier === "draft") {
          try {
            await tg("sendMessageDraft", {
              body: { chat_id: Number(chat_id), draft_id: s.draftId, text: text.slice(0, 4096) },
            });
            s.draftOk = true;
            s.lastText = text;
            s.lastSentAt = now;
            return { ok: true, tier: "draft" };
          } catch (err) {
            suspendOn429(s, err);
            if (s.draftOk || now < s.suspendedUntil) return { ok: true, tier: "draft", skipped: true };
            s.tier = "edit"; // drafts unsupported here — demote and fall through
          }
        }

        // Edit tier. Flood envelope per the Bots FAQ: ~1 msg/s in a private
        // chat, 20/min in a group — so 1s cadence in DMs, 3s in groups.
        const interval = Number(chat_id) > 0 ? 1_000 : 3_000;
        if (now - s.lastSentAt < interval) return { ok: true, throttled: true };
        // Mid-stream we truncate rather than split: splitting a moving
        // target duplicates content; finalize does the real split.
        const preview = text.length > 3_900 ? text.slice(0, 3_900) + "…" : text;
        try {
          if (s.messageId == null) {
            // Debounce the first bubble so a 2-word preview doesn't ping.
            if (preview.length < 24) return { ok: true, skipped: true };
            const body: Record<string, unknown> = {
              chat_id,
              text: preview + CURSOR,
              link_preview_options: { is_disabled: true },
            };
            if (tid != null) body.message_thread_id = tid;
            const res = await tg("sendMessage", { body });
            s.messageId = res.message_id as number;
          } else {
            await tg("editMessageText", {
              body: {
                chat_id,
                message_id: s.messageId,
                text: preview + CURSOR,
                link_preview_options: { is_disabled: true },
              },
            });
          }
          s.lastText = text;
          s.lastSentAt = now;
        } catch (err) {
          if (!isNotModified(err)) suspendOn429(s, err);
        }
        return { ok: true, tier: "edit" };
      }

      if (phase === "finalize") {
        const s = endStream(session);
        if (!text) {
          // Nothing to deliver — just strip the cursor off any partial.
          if (s?.messageId != null && s.lastText) {
            try {
              await tg("editMessageText", {
                body: {
                  chat_id,
                  message_id: s.messageId,
                  text: s.lastText.slice(0, 3_900),
                  link_preview_options: { is_disabled: true },
                },
              });
            } catch {
              /* leave the partial as-is */
            }
          }
          return { ok: true, message_ids: s?.messageId != null ? [s.messageId] : [] };
        }
        const chunks = chunkMarkdown(text);
        const ids: number[] = [];
        if (s?.messageId != null) {
          // Upgrade the streamed message in place — delete+repost would
          // scroll-jump the client and drop the notification anchor.
          let edited = false;
          try {
            await editFormatted(chat_id, s.messageId, chunks[0]!);
            edited = true;
          } catch {
            /* message gone (deleted?) — fall through to fresh sends */
          }
          if (edited) {
            ids.push(s.messageId);
            for (const c of chunks.slice(1)) ids.push(await sendChunk(chat_id, c, undefined, tid));
            return { ok: true, message_ids: ids };
          }
        }
        for (const [i, c] of chunks.entries()) {
          ids.push(await sendChunk(chat_id, c, i === 0 ? reply_to : undefined, tid));
        }
        return { ok: true, message_ids: ids };
      }

      if (phase === "cancel") {
        const s = endStream(session);
        // Drafts evaporate on their own; a streamed message keeps its text
        // but loses the cursor so it doesn't look mid-sentence forever.
        if (s?.messageId != null && s.lastText) {
          try {
            await tg("editMessageText", {
              body: {
                chat_id,
                message_id: s.messageId,
                text: s.lastText.slice(0, 3_900),
                link_preview_options: { is_disabled: true },
              },
            });
          } catch {
            /* best-effort */
          }
        }
        return { ok: true };
      }

      throw new Error(\`telegram_stream: unknown phase \${phase}\`);
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
  for (const s of streams.values()) {
    if (s.presenceTimer) clearInterval(s.presenceTimer);
  }
  streams.clear();
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
identical).

## Tools
- telegram_send — markdown in, native Telegram formatting out (see below).
- telegram_stream — progressive replies: start/update/finalize/cancel one
  streaming session per reply. The telegram-communication bridge drives it;
  call it directly only for long manual work.
- telegram_typing — one-off chat action ("typing", "upload_document", …).
- telegram_fetch_context — in-memory ring buffer of messages seen since load.

Like discord, this is only the pipe. To chat with olle on Telegram you also
install telegram-communication.

## Formatting
Telegram renders no markdown natively — it accepts a small HTML tag set. The
adapter converts agent markdown (**bold**, *italic*, \`code\`, fenced code
blocks with language highlighting, [links](url), > quotes, # headings,
bullets) to that tag set and escapes everything else, so raw LLM output can
never break a message. If Telegram still rejects the markup, the message is
re-sent as plain text — content never drops. Link previews are suppressed.

## Streaming & presence
Private chats use Telegram's native draft streaming (Bot API 9.5+): the
human sees the client's own "Thinking…" placeholder the moment a turn
starts, the reply streams as an animated draft bubble, and one formatted
message is sent at the end (drafts are ephemeral — nothing persists if the
turn dies). Groups — and servers without draft support — fall back to a
throttled send-then-edit loop with a ▌ cursor and a typing indicator
refreshed every 4s. Flood control is respected: ~1 edit/s in DMs, ~3s in
groups, and Telegram's retry_after is honored (up to 60s) on 429.

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
- apiBase — default https://api.telegram.org. Leave unless self-hosting.

## Guardrails
- NEVER paste the token into chat. Route it through set_secret so it is
  redacted from logs and persisted sessions.
- A leaked token = full control of the bot. Ask BotFather to /revoke and
  reissue if it ever lands in plaintext.
- telegram_fetch_context only knows messages seen since load — it is not a
  history search. Don't rely on it for anything before the adapter started.
- Draft streaming needs a Bot API 9.5+ server. The stock api.telegram.org
  qualifies; a self-hosted apiBase that predates it just demotes streams to
  the edit loop automatically.
`,
  },
};
