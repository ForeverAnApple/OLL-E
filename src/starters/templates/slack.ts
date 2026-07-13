import type { StarterTemplate } from "./types.ts";

// The index.ts / smoke.ts / SETUP.md bodies are captured with String.raw so
// escapes survive verbatim into the on-disk file (same convention as web.ts /
// local-llm.ts). That forbids backticks and "${" inside the raw templates —
// the generated source uses plain "+"-concatenation and never a template
// literal. Slack's outbound path leans on markdown_text (Slack renders
// CommonMark server-side), so there is no mrkdwn regex pipeline that would
// have needed literal backticks.

export const slack: StarterTemplate = {
  name: "slack",
  description:
    "Slack Socket Mode adapter. Opens ONE outbound WebSocket (no public endpoint), emits channel-message triggers with the discord/telegram-parity payload shape, and exposes slack_send (chat.postMessage, threaded, markdown_text with plain-text fallback, chunking), slack_stream (native chat.startStream tier or throttled chat.update edit loop), slack_fetch_context (in-memory ring buffer), slack_react. Two tokens: xapp- opens the socket, xoxb- makes Web API calls.",
  files: {
    "manifest.json": JSON.stringify(
      {
        name: "slack",
        version: "0.1.0",
        description:
          "Slack Socket Mode adapter: channel-message trigger + Web API tools over an outbound WebSocket (no public endpoint).",
        secrets: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
        capabilities: ["channel:slack", "trigger:channel-message"],
        eventWrites: ["channel-message"],
        catalog: {
          tagline: "reaching people on Slack",
          blurb:
            "Send messages, stream a reply as it's written, and read\n" +
            "recently-seen chat context over Slack's Socket Mode WebSocket —\n" +
            "no public endpoint required. Reach here to reply in a channel or\n" +
            "thread, keep a long answer live as it forms, or check what was\n" +
            "just said. This is the pipe; a slack-communication bridge drives\n" +
            "live chat on top of it.",
          tools: {
            slack_send: "post a message (threaded, markdown, chunked) to a channel/DM",
            slack_stream: "progressive delivery of one in-flight reply (native stream or edit loop)",
            slack_fetch_context: "recent messages this adapter saw live in a channel (ring buffer)",
            slack_react: "add an emoji reaction to a message",
          },
        },
        config: {
          apiBase: "https://slack.com/api",
          // Backoff ceiling for socket reconnect (ms).
          reconnectMaxMs: 30000,
          // Drop bot/self messages before publishing to the bus. Flip true
          // only if a task truly needs bot chatter (beware self-reply loops).
          includeBotMessages: false,
          // No inbound frame for this long (ms) => socket is a zombie,
          // force-close and reconnect. Slack refreshes each socket every few
          // hours and sends keepalive traffic well inside this window.
          staleTimeoutMs: 40000,
        },
      },
      null,
      2,
    ) + "\n",

    "index.ts": String.raw`// slack: Socket Mode adapter. Opens ONE outbound WebSocket to Slack (no
// public HTTP endpoint needed), turns each inbound message / app_mention
// into a channel-message event (byte-identical payload to the discord and
// telegram adapters so bridges are structurally identical), and exposes Web
// API tools. Two tokens: an app-level xapp- token opens the socket, a bot
// xoxb- token makes every Web API call.
//
// Shape rules (don't break without a logged decision):
//   - ACK FIRST, process after. Every Socket Mode envelope must be
//     acknowledged (echo its envelope_id back over the same socket) within
//     ~3s or Slack retries and eventually drops the connection. Parse ->
//     ack -> fan out; slow processing never delays the ack.
//   - One live connection is enough. The refresh handshake (disconnect
//     reason "warning" / "refresh_requested") dials a REPLACEMENT socket;
//     the old socket's later close is ignored via a generation counter, so
//     there is no gap. Slack allows up to 10 concurrent connections
//     precisely so a refresh has no gap; overlap events dedupe by event_id.
//   - Staleness is the zombie detector. The WHATWG WebSocket exposes no
//     manual ping frames, so we watch the last-inbound-frame timestamp;
//     nothing for staleTimeoutMs -> force-close -> reconnect. (Discord's
//     awaitingAck, adapted to Slack's frame-level keepalive.)
//   - conversations.history is Tier-1 throttled (1 req/min, 15 msgs) for
//     non-Marketplace apps since 2025 -> slack_fetch_context is an in-memory
//     ring buffer of what we saw live, NOT a history poll. Same honesty as
//     telegram_fetch_context.
//   - Outbound text is sent as markdown_text (Slack renders CommonMark
//     server-side); on any send error we retry once as plain text so the
//     reply never drops. No mrkdwn regex pipeline.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface SlackConfig {
  apiBase: string;
  reconnectMaxMs: number;
  includeBotMessages: boolean;
  staleTimeoutMs: number;
}

const DEFAULT_CONFIG: SlackConfig = {
  apiBase: "https://slack.com/api",
  reconnectMaxMs: 30000,
  includeBotMessages: false,
  staleTimeoutMs: 40000,
};

// Same field set the discord/telegram adapters emit — bridges depend on
// parity. The source tag lets a bridge ignore the other channel's messages
// when several adapters share the bus.
interface ChannelMessage {
  source: "slack";
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
  channel: string;
  ts: string;
  author: string;
  text: string;
  at: number;
}

let cfg: SlackConfig = DEFAULT_CONFIG;
let appToken = "";
let botToken = "";
let botUserId: string | null = null;
let teamId: string | null = null;

let stopped = false;
let disabled = false; // Socket Mode turned off at the app (link_disabled).
let ws: WebSocket | null = null;
// Every dialed socket captures the generation it was born in. Only the
// newest generation's close triggers a reconnect; an old socket that Slack
// tears down after a refresh is ignored (its gen < socketGen).
let socketGen = 0;
let reconnectAttempts = 0;
let lastFrameAt = 0;
let staleTimer: ReturnType<typeof setInterval> | null = null;

const channelMessageSubscribers: Array<(p: ChannelMessage) => void> = [];
// Honest history: conversations.history is throttled to near-uselessness for
// this app class, so the only messages we can surface are ones seen live.
const seen: SeenMessage[] = [];
const SEEN_CAP = 200;
// Display-name cache: inbound events carry only user ids.
const userCache = new Map<string, { name: string; at: number }>();
const USER_TTL_MS = 60 * 60 * 1000;
// Small dedup set — Slack re-delivers un-acked events on the next socket.
const seenEventIds = new Set<string>();
const SEEN_EVENT_CAP = 500;

function loadConfig(): SlackConfig {
  try {
    const here = dirname(new URL(import.meta.url).pathname);
    const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
    return { ...DEFAULT_CONFIG, ...(manifest.config ?? {}) } as SlackConfig;
  } catch {
    return DEFAULT_CONFIG;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// One Web API helper. POST JSON, Bearer token, ok:false is a failure even on
// HTTP 200 (Slack's convention). 429 honors Retry-After (seconds) with
// bounded retries; when the budget is spent the error carries retry_after so
// a streaming session can suspend itself.
async function slackFetch(
  method: string,
  body: Record<string, unknown> | undefined,
  token: string,
  attempt = 0,
): Promise<any> {
  const url = (cfg.apiBase || DEFAULT_CONFIG.apiBase) + "/" + method;
  const headers: Record<string, string> = { authorization: "Bearer " + token };
  const init: RequestInit = { method: "POST", headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json; charset=utf-8";
    init.body = JSON.stringify(body);
  }
  const r = await fetch(url, init);
  if (r.status === 429) {
    const ra = Number(r.headers.get("retry-after") ?? "1");
    const retryMs = Math.min((Number.isFinite(ra) ? ra : 1) * 1000, 60000);
    if (attempt < 4) {
      await sleep(retryMs);
      return slackFetch(method, body, token, attempt + 1);
    }
    const err: any = new Error("slack " + method + ": rate limited (429)");
    err.retry_after = retryMs / 1000;
    err.slackError = "ratelimited";
    throw err;
  }
  let data: any;
  try {
    data = await r.json();
  } catch {
    throw new Error("slack " + method + ": HTTP " + r.status + " with non-JSON body");
  }
  if (!r.ok || !data || data.ok !== true) {
    const err: any = new Error("slack " + method + ": " + (data?.error ?? ("HTTP " + r.status)));
    err.slackError = data?.error;
    throw err;
  }
  return data;
}

// ---------- inbound: frames, ack, echo filter, name resolution ----------

// Pull the user ids out of Slack's <@U123> mention syntax.
export function extractMentions(text: string): string[] {
  const out: string[] = [];
  const re = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]!);
  return out;
}

// Echo filter — the bot reads channels it posts into, so it must drop its own
// (and other bots') messages or it answers itself. Returns true = DROP.
// message_changed / message_deleted are dropped by default (edits/deletes are
// a narrow-dispatch concern a task can opt into later).
export function shouldDropEvent(
  event: any,
  ownBotUserId: string | null,
  includeBotMessages: boolean,
): boolean {
  if (!event || typeof event !== "object") return true;
  if (event.type !== "message" && event.type !== "app_mention") return true;
  const sub = event.subtype;
  if (sub === "message_changed" || sub === "message_deleted" || sub === "thread_broadcast") return true;
  if (!includeBotMessages) {
    if (sub === "bot_message") return true;
    if (event.bot_id) return true;
    if (ownBotUserId && event.user === ownBotUserId) return true;
  }
  return false;
}

async function resolveUserName(userId: string | undefined): Promise<string> {
  if (!userId) return "";
  const hit = userCache.get(userId);
  if (hit && Date.now() - hit.at < USER_TTL_MS) return hit.name;
  try {
    const url =
      (cfg.apiBase || DEFAULT_CONFIG.apiBase) + "/users.info?user=" + encodeURIComponent(userId);
    const r = await fetch(url, { headers: { authorization: "Bearer " + botToken } });
    const data = (await r.json()) as any;
    if (data?.ok && data.user) {
      const p = data.user.profile ?? {};
      const name = p.display_name || data.user.real_name || data.user.name || userId;
      userCache.set(userId, { name, at: Date.now() });
      return name;
    }
  } catch {
    /* fall through — use the id */
  }
  userCache.set(userId, { name: userId, at: Date.now() });
  return userId;
}

function toChannelMessage(event: any, name: string): ChannelMessage {
  const text: string = typeof event.text === "string" ? event.text : "";
  const channelType = event.channel_type;
  const mentions = extractMentions(text);
  return {
    source: "slack",
    message_id: String(event.ts ?? ""),
    guild_id: event.team ?? null,
    channel_id: String(event.channel ?? ""),
    thread_id: event.thread_ts != null ? String(event.thread_ts) : null,
    author: { id: String(event.user ?? ""), name, bot: !!event.bot_id },
    content: text,
    mentions,
    // Slack threads ARE the reply model — there is no per-message reply
    // pointer like discord's referenced_message.
    reply_to: event.thread_ts != null ? String(event.thread_ts) : null,
    is_dm: channelType === "im",
    is_mention: event.type === "app_mention" || (botUserId ? mentions.includes(botUserId) : false),
    received_at: Date.now(),
  };
}

async function processEventCallback(callback: any): Promise<void> {
  const eventId = callback?.event_id;
  if (eventId) {
    if (seenEventIds.has(eventId)) return;
    seenEventIds.add(eventId);
    if (seenEventIds.size > SEEN_EVENT_CAP) {
      const first = seenEventIds.values().next().value;
      if (first !== undefined) seenEventIds.delete(first);
    }
  }
  const event = callback?.event;
  if (shouldDropEvent(event, botUserId, cfg.includeBotMessages)) return;
  const name = await resolveUserName(event.user);
  const payload = toChannelMessage(event, name);
  seen.push({ channel: payload.channel_id, ts: payload.message_id, author: name, text: payload.content, at: payload.received_at });
  if (seen.length > SEEN_CAP) seen.splice(0, seen.length - SEEN_CAP);
  for (const fn of channelMessageSubscribers) fn(payload);
}

function ack(socket: WebSocket, envelopeId: string): void {
  try {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ envelope_id: envelopeId }));
  } catch {
    /* socket already gone — the envelope will be re-delivered next connect */
  }
}

function handleFrame(socket: WebSocket, gen: number, raw: string): void {
  lastFrameAt = Date.now();
  let frame: any;
  try {
    frame = JSON.parse(raw);
  } catch {
    return;
  }
  const type = frame?.type;

  if (type === "hello") {
    // Connected — the backoff cycle is over.
    reconnectAttempts = 0;
    return;
  }

  if (type === "disconnect") {
    const reason = frame.reason;
    if (reason === "link_disabled") {
      // The human turned Socket Mode off. Do not reconnect.
      disabled = true;
      console.error("[slack] Socket Mode disabled at the app (link_disabled) — not reconnecting.");
      try { socket.close(); } catch {}
      return;
    }
    // warning (~10s heads-up) or refresh_requested: dial a REPLACEMENT now.
    // This socket keeps running until Slack closes it; because dial() bumps
    // socketGen, this socket's close will be ignored -> zero-gap refresh.
    void dial();
    return;
  }

  // Every envelope with an envelope_id must be acked first, then processed.
  const envelopeId = frame?.envelope_id;
  if (envelopeId) ack(socket, envelopeId);

  if (type === "events_api") {
    void processEventCallback(frame.payload).catch((err) =>
      console.error("[slack] event processing error:", (err as Error).message),
    );
  }
  // slash_commands / interactive / block_suggestion are acked above but not
  // yet dispatched — extend here as tasks need them.
}

async function appsConnectionsOpen(): Promise<string> {
  const data = await slackFetch("apps.connections.open", undefined, appToken);
  if (typeof data.url !== "string") throw new Error("slack apps.connections.open: no url in response");
  return data.url;
}

function scheduleReconnect(): void {
  if (stopped || disabled) return;
  const cap = cfg.reconnectMaxMs || DEFAULT_CONFIG.reconnectMaxMs;
  const delay = Math.min(cap, 1000 * 2 ** reconnectAttempts) + Math.floor(Math.random() * 1000);
  reconnectAttempts += 1;
  setTimeout(() => {
    void dial();
  }, delay);
}

async function dial(): Promise<void> {
  if (stopped || disabled) return;
  const gen = ++socketGen;
  let url: string;
  try {
    url = await appsConnectionsOpen();
  } catch (err) {
    const code = (err as any)?.slackError;
    if (code === "invalid_auth" || code === "not_allowed_token_type" || code === "account_inactive") {
      disabled = true;
      console.error("[slack] apps.connections.open unrecoverable (" + code + ") — check SLACK_APP_TOKEN. Not reconnecting.");
      return;
    }
    console.error("[slack] apps.connections.open failed:", (err as Error).message);
    scheduleReconnect();
    return;
  }
  if (stopped || disabled || gen !== socketGen) return; // superseded mid-fetch

  const socket = new WebSocket(url);
  ws = socket;
  lastFrameAt = Date.now();
  socket.addEventListener("message", (ev) => {
    handleFrame(socket, gen, String((ev as MessageEvent).data));
  });
  socket.addEventListener("close", () => {
    if (stopped || disabled) return;
    // Only the newest socket's close reconnects; an old socket torn down
    // after a refresh (gen < socketGen) is expected — ignore it.
    if (gen !== socketGen) return;
    scheduleReconnect();
  });
  socket.addEventListener("error", (err) => {
    console.error("[slack] ws error:", err);
  });
}

function armStaleTimer(): void {
  if (staleTimer) clearInterval(staleTimer);
  staleTimer = setInterval(() => {
    if (stopped || disabled || !ws) return;
    if (Date.now() - lastFrameAt > (cfg.staleTimeoutMs || DEFAULT_CONFIG.staleTimeoutMs)) {
      // No inbound frame for too long — treat as a zombie and force-close.
      // The close handler (newest gen) fires scheduleReconnect.
      try { ws.close(4000); } catch {}
    }
  }, 15000);
}

// ---------- outbound: chunking + send ----------

// Split on whitespace at or under Slack's recommended per-message size, with
// headroom under the 40k hard limit. Caps the chunk count so a runaway
// payload can't fan out into dozens of sends.
export function chunkText(s: string, max = 3800, cap = 20): string[] {
  const chunks: string[] = [];
  let rest = s;
  while (rest.length > 0 && chunks.length < cap) {
    if (rest.length <= max) {
      chunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  return chunks;
}

// ~1 message/sec/channel: space out consecutive posts to the same channel.
const lastPostAt = new Map<string, number>();
async function paceChannel(channel: string): Promise<void> {
  const prev = lastPostAt.get(channel) ?? 0;
  const wait = prev + 1000 - Date.now();
  if (wait > 0) await sleep(wait);
  lastPostAt.set(channel, Date.now());
}

// One formatted post. markdown_text first (Slack renders CommonMark); if that
// errors, retry once as plain text so the reply always lands. Returns the ts.
async function postOnce(channel: string, text: string, threadTs?: string): Promise<string> {
  await paceChannel(channel);
  const base: Record<string, unknown> = { channel };
  if (threadTs) base.thread_ts = threadTs;
  try {
    const data = await slackFetch("chat.postMessage", { ...base, markdown_text: text }, botToken);
    return String(data.ts);
  } catch (err) {
    // Retry with plain text — never drop the content over a formatting error.
    const data = await slackFetch("chat.postMessage", { ...base, text }, botToken);
    void err;
    return String(data.ts);
  }
}

async function updateOnce(channel: string, ts: string, text: string): Promise<void> {
  try {
    await slackFetch("chat.update", { channel, ts, markdown_text: text }, botToken);
  } catch (err) {
    await slackFetch("chat.update", { channel, ts, text }, botToken);
    void err;
  }
}

// ---------- streaming sessions ----------
// Tier "native": Slack's chat.startStream / appendStream / stopStream (Oct
// 2025). Only works in a thread and needs recipient_team_id + recipient_user_id
// — so it is chosen only when we have a thread_ts and a recipient user id.
// appendStream takes a DELTA, so we track lastText and send only the new tail.
// Tier "edit": the honest floor that works everywhere — one chat.postMessage,
// then throttled chat.update (<=1/1.2s, chat.update is Tier 3 ~50/min) with a
// cursor, finalized by an in-place chat.update. A native start error demotes
// to edit.

interface StreamSession {
  channel: string;
  tier: "native" | "edit";
  threadTs?: string;
  recipientUserId?: string;
  ts: string | null;
  lastText: string;
  lastSentAt: number;
  suspendedUntil: number;
}

const CURSOR = " ▌"; // ▌
const EDIT_INTERVAL_MS = 1200;
const streams = new Map<string, StreamSession>();

function getStream(session: string, channel: string, threadTs?: string, recipientUserId?: string): StreamSession {
  let s = streams.get(session);
  if (!s) {
    const canNative = !!(threadTs && recipientUserId && teamId);
    s = {
      channel,
      tier: canNative ? "native" : "edit",
      threadTs,
      recipientUserId,
      ts: null,
      lastText: "",
      lastSentAt: 0,
      suspendedUntil: 0,
    };
    streams.set(session, s);
  }
  return s;
}

function suspendOn429(s: StreamSession, err: unknown): void {
  const ra = (err as any)?.retry_after;
  if (typeof ra === "number") s.suspendedUntil = Date.now() + Math.min(ra * 1000, 60000);
}

// ---------- registration ----------

export function register(api: any) {
  appToken = api.secrets?.SLACK_APP_TOKEN;
  botToken = api.secrets?.SLACK_BOT_TOKEN;
  if (!appToken) throw new Error("slack: SLACK_APP_TOKEN not injected; approve the extension proposal and set the secret (xapp- app-level token, connections:write).");
  if (!botToken) throw new Error("slack: SLACK_BOT_TOKEN not injected; approve the extension proposal and set the secret (xoxb- bot token).");
  cfg = loadConfig();
  stopped = false;
  disabled = false;
  socketGen = 0;
  reconnectAttempts = 0;

  // auth.test fails fast on a bad bot token and hands us our own user id (for
  // echo filtering) and the team id (recipient_team_id for native streaming).
  void (async () => {
    try {
      const who = await slackFetch("auth.test", {}, botToken);
      botUserId = who.user_id ?? null;
      teamId = who.team_id ?? null;
    } catch (err) {
      console.error("[slack] auth.test failed:", (err as Error).message);
    }
    await dial();
    armStaleTimer();
  })();

  api.registerTrigger({
    name: "slack-channel-message",
    type: "channel-message",
    start(emit: (p: ChannelMessage) => void) {
      channelMessageSubscribers.push(emit);
    },
    stop() {
      channelMessageSubscribers.length = 0;
    },
  });

  api.registerTool({
    name: "slack_send",
    category: "slack",
    tier: "operational",
    shortClause: "post a message to a Slack channel, DM, or thread",
    description:
      "Send a message to a Slack channel, private group, or DM. text is markdown (rendered server-side via markdown_text; falls back to plain text if Slack rejects it). Set thread_ts to the parent message ts to reply in-thread. channel accepts a channel id (C…/G…/D…) or a user id (U…, opens the DM). Long messages split on whitespace and thread under the first message so a long answer reads as one reply.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel id (C…/G…/D…) or user id (U…) to DM" },
        text: { type: "string", description: "Message text (markdown)" },
        thread_ts: { type: "string", description: "Parent message ts to reply in-thread" },
      },
      required: ["channel", "text"],
      additionalProperties: false,
    },
    async execute({ channel, text, thread_ts }: { channel: string; text: string; thread_ts?: string }) {
      const chunks = chunkText(text);
      const tsAll: string[] = [];
      let thread = thread_ts;
      for (const chunk of chunks) {
        const ts = await postOnce(channel, chunk, thread);
        tsAll.push(ts);
        // Continue the rest of a chunked answer under the first message.
        if (!thread) thread = ts;
      }
      return { ok: true, ts: tsAll[0] ?? null, ts_all: tsAll };
    },
  });

  api.registerTool({
    name: "slack_stream",
    category: "slack",
    tier: "operational",
    shortClause: "stream one in-flight reply into a Slack message",
    description:
      "Progressive delivery of one in-flight reply. phase='start' opens the session; phase='update' streams the full accumulated text so far (throttled internally); phase='finalize' delivers the final message; phase='cancel' tears the session down. Uses Slack's native streaming when replying in a thread with a recipient_user_id, otherwise a throttled edit loop. session is any stable id for the reply — a slack-communication bridge passes its thread id.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Stable id for this in-flight reply" },
        channel: { type: "string" },
        phase: { type: "string", enum: ["start", "update", "finalize", "cancel"] },
        text: { type: "string", description: "Full accumulated text (update) or final text (finalize), markdown" },
        thread_ts: { type: "string", description: "Parent ts; required for the native streaming tier" },
        recipient_user_id: { type: "string", description: "Target user id; required for the native streaming tier" },
      },
      required: ["session", "channel", "phase"],
      additionalProperties: false,
    },
    async execute({ session, channel, phase, text = "", thread_ts, recipient_user_id }: {
      session: string;
      channel: string;
      phase: "start" | "update" | "finalize" | "cancel";
      text?: string;
      thread_ts?: string;
      recipient_user_id?: string;
    }) {
      if (phase === "start") {
        const s = getStream(session, channel, thread_ts, recipient_user_id);
        if (s.tier === "native") {
          try {
            const data = await slackFetch(
              "chat.startStream",
              { channel, thread_ts: s.threadTs, recipient_team_id: teamId, recipient_user_id: s.recipientUserId },
              botToken,
            );
            s.ts = String(data.ts);
          } catch (err) {
            void err;
            s.tier = "edit"; // native unavailable — the edit loop works everywhere
          }
        }
        return { ok: true, tier: s.tier };
      }

      if (phase === "update") {
        const s = getStream(session, channel, thread_ts, recipient_user_id);
        const now = Date.now();
        if (!text || text === s.lastText || now < s.suspendedUntil) return { ok: true, skipped: true };

        if (s.tier === "native" && s.ts) {
          const delta = text.startsWith(s.lastText) ? text.slice(s.lastText.length) : text;
          if (!delta) return { ok: true, skipped: true };
          try {
            await slackFetch("chat.appendStream", { channel, ts: s.ts, markdown_text: delta }, botToken);
            s.lastText = text;
            s.lastSentAt = now;
            return { ok: true, tier: "native" };
          } catch (err) {
            suspendOn429(s, err);
            return { ok: true, tier: "native", skipped: true };
          }
        }

        // Edit tier. chat.update is Tier 3 (~50/min) -> <=1 edit / 1.2s.
        if (now - s.lastSentAt < EDIT_INTERVAL_MS) return { ok: true, throttled: true };
        const preview = text.length > 3800 ? text.slice(0, 3800) + "…" : text;
        try {
          if (s.ts == null) {
            const base: Record<string, unknown> = { channel, text: preview + CURSOR };
            if (s.threadTs) base.thread_ts = s.threadTs;
            const data = await slackFetch("chat.postMessage", base, botToken);
            s.ts = String(data.ts);
          } else {
            await slackFetch("chat.update", { channel, ts: s.ts, text: preview + CURSOR }, botToken);
          }
          s.lastText = text;
          s.lastSentAt = now;
        } catch (err) {
          suspendOn429(s, err);
        }
        return { ok: true, tier: "edit" };
      }

      if (phase === "finalize") {
        const s = streams.get(session);
        streams.delete(session);
        if (!s) {
          // No session — deliver as a one-shot send.
          if (!text) return { ok: true, ts_all: [] };
          const tsAll: string[] = [];
          let thread = thread_ts;
          for (const chunk of chunkText(text)) {
            const ts = await postOnce(channel, chunk, thread);
            tsAll.push(ts);
            if (!thread) thread = ts;
          }
          return { ok: true, ts_all: tsAll };
        }

        if (s.tier === "native" && s.ts) {
          const delta = text && text.startsWith(s.lastText) ? text.slice(s.lastText.length) : text;
          try {
            if (delta) await slackFetch("chat.appendStream", { channel, ts: s.ts, markdown_text: delta }, botToken);
          } catch {
            /* best-effort tail */
          }
          try {
            await slackFetch("chat.stopStream", { channel, ts: s.ts }, botToken);
          } catch {
            /* already stopped */
          }
          return { ok: true, tier: "native", ts_all: [s.ts] };
        }

        // Edit tier finalize: upgrade the streamed message in place, then
        // thread any overflow chunks under it.
        const chunks = chunkText(text || s.lastText);
        const tsAll: string[] = [];
        if (s.ts != null) {
          try {
            await updateOnce(channel, s.ts, chunks[0] ?? "");
            tsAll.push(s.ts);
            let thread = s.threadTs ?? s.ts;
            for (const c of chunks.slice(1)) {
              const ts = await postOnce(channel, c, thread);
              tsAll.push(ts);
              thread = thread ?? ts;
            }
            return { ok: true, tier: "edit", ts_all: tsAll };
          } catch {
            /* message gone — fall through to fresh sends */
          }
        }
        let thread = s.threadTs;
        for (const c of chunks) {
          const ts = await postOnce(channel, c, thread);
          tsAll.push(ts);
          if (!thread) thread = ts;
        }
        return { ok: true, tier: "edit", ts_all: tsAll };
      }

      if (phase === "cancel") {
        const s = streams.get(session);
        streams.delete(session);
        if (s?.tier === "native" && s.ts) {
          try {
            await slackFetch("chat.stopStream", { channel, ts: s.ts }, botToken);
          } catch {
            /* best-effort */
          }
        } else if (s?.ts != null && s.lastText) {
          // Strip the cursor so a partial doesn't look mid-sentence forever.
          try {
            await updateOnce(channel, s.ts, s.lastText);
          } catch {
            /* best-effort */
          }
        }
        return { ok: true };
      }

      throw new Error("slack_stream: unknown phase " + phase);
    },
  });

  api.registerTool({
    name: "slack_fetch_context",
    category: "slack",
    tier: "operational",
    shortClause: "recent messages this adapter saw live in a channel",
    description:
      "Return recent messages this adapter has SEEN in a channel since it loaded. HONEST LIMITATION: Slack's conversations.history is Tier-1 throttled (1 request/minute, 15 messages) for non-Marketplace apps since 2025, so this is an in-memory ring buffer of messages that arrived over the socket while the adapter was running — NOT a history search. It is empty after a reload and cannot fetch older messages.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 100, default: 20 },
      },
      required: ["channel"],
      additionalProperties: false,
    },
    async execute({ channel, limit = 20 }: { channel: string; limit?: number }) {
      const rows = seen.filter((m) => m.channel === channel);
      return rows.slice(Math.max(0, rows.length - limit));
    },
  });

  api.registerTool({
    name: "slack_react",
    category: "slack",
    tier: "strategic",
    shortClause: "add an emoji reaction to a Slack message",
    description:
      "Add an emoji reaction to a message (reactions.add). name is the emoji short name WITHOUT colons (e.g. 'thumbsup'). Requires the reactions:write scope.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        timestamp: { type: "string", description: "ts of the message to react to" },
        name: { type: "string", description: "Emoji short name, no colons (e.g. 'eyes')" },
      },
      required: ["channel", "timestamp", "name"],
      additionalProperties: false,
    },
    async execute({ channel, timestamp, name }: { channel: string; timestamp: string; name: string }) {
      await slackFetch("reactions.add", { channel, timestamp, name: name.replace(/:/g, "") }, botToken);
      return { ok: true };
    },
  });
}

export function unload() {
  stopped = true;
  socketGen += 1; // invalidate any in-flight dial
  if (staleTimer) clearInterval(staleTimer);
  staleTimer = null;
  try { ws?.close(); } catch {}
  ws = null;
  channelMessageSubscribers.length = 0;
  seen.length = 0;
  userCache.clear();
  seenEventIds.clear();
  streams.clear();
  lastPostAt.clear();
  botUserId = null;
  teamId = null;
  appToken = "";
  botToken = "";
}
`,

    "smoke.ts": String.raw`// Smoke: read-only auth.test with SLACK_BOT_TOKEN — proves the bot token is
// valid and hands back the bot identity without any side effects. Optionally
// probes SLACK_APP_TOKEN via apps.connections.open (which mints a socket URL
// we immediately discard) so a missing/bad connections:write scope is caught
// at smoke time instead of first connect. Tokens come from the secrets store
// only; env is reserved for behavior config, never secrets.

export async function smokeTest(_bus: unknown, ctx?: { secrets?: Record<string, string> }) {
  const botToken = ctx?.secrets?.SLACK_BOT_TOKEN;
  const appToken = ctx?.secrets?.SLACK_APP_TOKEN;
  if (!botToken) {
    throw new Error('slack smoke: SLACK_BOT_TOKEN not set. Ask olle to store it (set_secret tool) or run: printf %s "$TOKEN" | olle secret set SLACK_BOT_TOKEN');
  }
  if (!appToken) {
    throw new Error('slack smoke: SLACK_APP_TOKEN not set. Ask olle to store it (set_secret tool) or run: printf %s "$TOKEN" | olle secret set SLACK_APP_TOKEN');
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { authorization: "Bearer " + botToken },
      signal: ctrl.signal,
    });
    const data = (await r.json().catch(() => null)) as { ok?: boolean; error?: string; user_id?: string } | null;
    if (!data || data.ok !== true) {
      const e = data?.error ?? ("HTTP " + r.status);
      throw new Error(
        "slack smoke: auth.test failed (" + e + "). " +
          (e === "invalid_auth" || e === "token_revoked"
            ? "The SLACK_BOT_TOKEN (xoxb-…) is wrong or revoked — reinstall the app and set_secret the fresh token."
            : "Check SLACK_BOT_TOKEN and network."),
      );
    }
    if (!data.user_id) {
      throw new Error("slack smoke: auth.test returned no user_id — unexpected response shape.");
    }

    // App-token probe: apps.connections.open mints (and we discard) a socket
    // URL. A bad app token or missing connections:write scope surfaces here.
    const r2 = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: { authorization: "Bearer " + appToken },
      signal: ctrl.signal,
    });
    const d2 = (await r2.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!d2 || d2.ok !== true) {
      const e = d2?.error ?? ("HTTP " + r2.status);
      throw new Error(
        "slack smoke: apps.connections.open failed (" + e + "). " +
          (e === "not_allowed_token_type"
            ? "That looks like the bot token — SLACK_APP_TOKEN must be the xapp- app-level token with connections:write."
            : "Check SLACK_APP_TOKEN (xapp-…, scope connections:write) and that Socket Mode is enabled."),
      );
    }
  } finally {
    clearTimeout(t);
  }
}
`,

    "SETUP.md": String.raw`# slack — setup

## What it does
Opens ONE outbound WebSocket to Slack using Socket Mode, so olle needs no
public HTTPS endpoint (it lives behind NAT just fine). Every message and
@mention the bot can see becomes a channel-message event, same payload shape
as the discord and telegram adapters, so bridges are identical. It also
registers Web API tools: slack_send, slack_stream, slack_fetch_context,
slack_react.

This adapter is only the pipe. To actually chat with olle on Slack you also
install a slack-communication bridge (a deliberate follow-up) that wires
these events to and from the chat agent.

## Tools
- slack_send — markdown in, rendered server-side (markdown_text), chunked and
  threaded for long answers, plain-text fallback so nothing ever drops.
- slack_stream — progressive replies: start/update/finalize/cancel one
  streaming session per reply. Native Slack streaming when in a thread with a
  recipient user id; otherwise a throttled edit loop. A bridge drives it.
- slack_fetch_context — in-memory ring buffer of messages seen since load.
- slack_react — add an emoji reaction (needs the optional reactions:write
  scope).

## Two secrets
Slack splits duties across two tokens:
- SLACK_APP_TOKEN — an app-level xapp-… token with the connections:write
  scope. Opens the Socket Mode WebSocket.
- SLACK_BOT_TOKEN — the bot xoxb-… token. Makes every Web API call
  (posting, editing, reactions, name lookups).

Neither value ever appears in chat or logs — store each via set_secret.

## Getting the tokens (walk the human through this)
1. Go to https://api.slack.com/apps -> Create New App -> From scratch. Name
   it, pick the workspace, Create App.
2. Enable Socket Mode: left sidebar -> Socket Mode -> toggle Enable Socket
   Mode on. (This delivers events over WebSocket instead of HTTP — no public
   URL needed.)
3. App-level token: enabling Socket Mode prompts you to create one; if not,
   Basic Information -> App-Level Tokens -> Generate Token and Scopes -> add
   scope connections:write -> generate. Copy the xapp-… token. This is
   SLACK_APP_TOKEN. (Shown once — copy now.)
4. Bot token scopes: OAuth & Permissions -> Bot Token Scopes -> Add an OAuth
   Scope, add each of: app_mentions:read, chat:write, channels:history,
   groups:history, im:history, mpim:history, im:write, users:read. Optional:
   channels:read, groups:read (list channels), reactions:write (for
   slack_react).
5. Event Subscriptions: left sidebar -> Event Subscriptions -> Enable Events
   on. No Request URL box appears under Socket Mode. Expand Subscribe to bot
   events and add: app_mention, message.channels, message.groups,
   message.im, message.mpim. Save.
6. Install: Install App -> Install to Workspace -> Allow. Copy the Bot User
   OAuth Token xoxb-…. This is SLACK_BOT_TOKEN.
7. Invite the bot: in Slack, /invite @YourBot in each channel it should read
   or post in. DMs work once the app is installed.

## THE GOTCHAS
- Invite the bot or it sees nothing. A bot only receives message.channels for
  channels it is a MEMBER of — /invite it. This is the most common "connects
  but sees nothing" failure.
- Reinstall after adding scopes. New OAuth scopes do not apply until you
  re-run Install to Workspace (step 6). Add a scope -> reinstall -> the token
  stays the same but now carries the scope.
- Context is buffer-only. conversations.history is throttled to 1 request per
  minute / 15 messages for non-Marketplace apps (Slack's 2025 change), so
  slack_fetch_context only returns what the adapter saw live since it loaded.
  It cannot fetch older history and is empty after a reload.
- No typing indicator. Socket Mode has no generic bot "typing…" affordance.
  Presence is expressed by streaming: the native tier shows Slack's own
  streaming shimmer, the edit tier shows a growing message with a cursor.

## Install script (narrate this to the human)
    install_starter("slack")
    set_secret("SLACK_APP_TOKEN", "<the xapp- token>")
    set_secret("SLACK_BOT_TOKEN", "<the xoxb- token>")
    register_extension("slack")

register runs the smoke test first: a read-only auth.test (bot token) plus an
apps.connections.open probe (app token, the minted URL is discarded). If both
pass, the socket comes up and messages flow.

## Config knobs (manifest.json, config object)
- apiBase — default https://slack.com/api. Leave it.
- reconnectMaxMs — backoff ceiling for socket reconnect, default 30000.
- includeBotMessages — default false. Bot/self messages are dropped before
  hitting the bus. Flip true only if you truly want bot chatter; combined
  with a bridge that answers everything it is a self-reply loop.
- staleTimeoutMs — no inbound frame for this long means the socket is a
  zombie: force-close and reconnect. Default 40000.

## Guardrails
- NEVER paste either token into chat. Route both through set_secret so they
  are redacted from logs and persisted sessions.
- A leaked token = full control of the bot. Rotate in the app's Basic
  Information (app token) or OAuth & Permissions (bot token) pages, then
  set_secret the fresh value.
- includeBotMessages=true plus a bridge is a self-reply loop. Keep it false
  unless you have a reason.
`,
  },
};
