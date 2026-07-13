import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installStarter } from "../src/starters/index.ts";
import { validateManifestWithWarnings } from "../src/extensions/manifest.ts";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { createExtensionHost } from "../src/extensions/index.ts";
import { ulid } from "../src/id/index.ts";
import { openStore, tables } from "../src/store/index.ts";

// All network is mocked (globalThis.fetch) and so is the outbound socket
// (globalThis.WebSocket). The staged extension reaches both globals at call
// time, so the mocks see exactly the requests/frames the adapter produces.

const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

// Default happy handler for the whole Web API surface the adapter touches.
function defaultHandler(url: string): Response {
  if (url.endsWith("/auth.test")) return json({ ok: true, user_id: "UBOT", team_id: "TEAM1" });
  if (url.endsWith("/apps.connections.open")) return json({ ok: true, url: "wss://fake.slack/link?ticket=x" });
  if (url.includes("/users.info")) return json({ ok: true, user: { profile: { display_name: "Alice" }, name: "alice" } });
  if (url.endsWith("/chat.postMessage")) return json({ ok: true, ts: "1699.0001", channel: "C1" });
  if (url.endsWith("/chat.update")) return json({ ok: true, ts: "1699.0001" });
  if (url.endsWith("/chat.startStream")) return json({ ok: true, ts: "1699.5000" });
  if (url.endsWith("/chat.appendStream")) return json({ ok: true });
  if (url.endsWith("/chat.stopStream")) return json({ ok: true });
  if (url.endsWith("/reactions.add")) return json({ ok: true });
  return json({ ok: false, error: "unknown_method" }, 200);
}

// Minimal WHATWG-ish WebSocket mock. The adapter uses addEventListener,
// send, close, readyState, and the static OPEN — nothing else.
class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  url: string;
  readyState = 1;
  sent: string[] = [];
  private listeners: Record<string, Array<(ev: any) => void>> = {};
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: any) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    for (const fn of this.listeners.close ?? []) fn({});
  }
  // test helper: deliver an inbound frame
  deliver(obj: unknown) {
    const data = JSON.stringify(obj);
    for (const fn of this.listeners.message ?? []) fn({ data });
  }
  acks(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

const SECRETS: Record<string, string> = { SLACK_APP_TOKEN: "xapp-1-test", SLACK_BOT_TOKEN: "xoxb-test" };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "olle-slack-"));
  MockWebSocket.instances = [];
  (globalThis as any).WebSocket = MockWebSocket;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as any).WebSocket = realWebSocket;
  rmSync(tmp, { recursive: true, force: true });
});

// Direct-import the staged index.ts to unit-test the exported pure helpers
// (no host, no network) — same trick web-starter uses.
async function importStaged(): Promise<{
  chunkText: (s: string, max?: number, cap?: number) => string[];
  extractMentions: (text: string) => string[];
  shouldDropEvent: (event: any, ownBotUserId: string | null, includeBotMessages: boolean) => boolean;
}> {
  installStarter({ name: "slack", extensionsDir: tmp, authorName: "t" });
  return import(pathToFileURL(join(tmp, "slack", "index.ts")).href);
}

// Load the staged starter through the extension host (the daemon's real load
// path: smoke -> register). Fetch + WebSocket must already be mocked. Returns
// the tools, the (awaited) socket, and a bus subscription capture.
async function loadHost() {
  installStarter({ name: "slack", extensionsDir: tmp, authorName: "t" });
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  const messages: any[] = [];
  bus.subscribe("channel-message", (ev: any) => {
    messages.push(ev.payload);
  });
  const host = createExtensionHost({
    bus,
    store,
    hostId,
    extensionsDir: tmp,
    secrets: (name) => SECRETS[name],
  });
  await host.load("slack");
  const tool = (n: string) => host.tools().find((t) => t.tool.name === n)?.tool;
  const ctx = { hostId, extensionId: "slack", actorId: "a", abort: new AbortController().signal, secrets: {} };
  // register()'s socket dial is fire-and-forget; wait for it to appear.
  let socket: MockWebSocket | undefined;
  for (let i = 0; i < 60 && !socket; i++) {
    socket = MockWebSocket.instances.at(-1);
    if (!socket) await sleep(5);
  }
  const teardown = async () => {
    await host.unload("slack");
    bus.close();
    store.close();
  };
  return { tool, ctx, socket, messages, teardown };
}

describe("slack starter — manifest", () => {
  it("validates clean with catalog prose, two secrets, and config", () => {
    installStarter({ name: "slack", extensionsDir: tmp, authorName: "t" });
    const raw = readFileSync(join(tmp, "slack", "manifest.json"), "utf8");
    const { manifest, warnings } = validateManifestWithWarnings(JSON.parse(raw), "slack");
    expect(warnings).toEqual([]);
    expect(manifest.name).toBe("slack");
    expect(manifest.secrets).toEqual(["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]);
    expect(manifest.eventWrites).toEqual(["channel-message"]);
    expect(manifest.catalog!.tagline).toBe("reaching people on Slack");
    expect(manifest.catalog!.tools).toMatchObject({
      slack_send: expect.any(String),
      slack_stream: expect.any(String),
      slack_fetch_context: expect.any(String),
    });
    const config = JSON.parse(raw).config;
    expect(config.apiBase).toBe("https://slack.com/api");
    expect(config.includeBotMessages).toBe(false);
  });
});

describe("slack starter — pure helpers", () => {
  it("chunkText splits on whitespace under the cap and caps the count", async () => {
    const { chunkText } = await importStaged();
    expect(chunkText("hello world")).toEqual(["hello world"]);
    const long = ("word ".repeat(2000)).trim(); // ~10k chars
    const chunks = chunkText(long, 3800);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(3800);
    // Cap honored.
    const huge = "x".repeat(200000);
    expect(chunkText(huge, 3800, 20).length).toBe(20);
  });

  it("extractMentions pulls user ids, including the <@U|label> form", async () => {
    const { extractMentions } = await importStaged();
    expect(extractMentions("hey <@U123> and <@U456|bob>")).toEqual(["U123", "U456"]);
    expect(extractMentions("no mentions here")).toEqual([]);
  });

  it("shouldDropEvent drops self/bot/edits, keeps real user messages", async () => {
    const { shouldDropEvent } = await importStaged();
    // real human message
    expect(shouldDropEvent({ type: "message", user: "U1", text: "hi" }, "UBOT", false)).toBe(false);
    // app_mention kept
    expect(shouldDropEvent({ type: "app_mention", user: "U1", text: "<@UBOT> hi" }, "UBOT", false)).toBe(false);
    // self
    expect(shouldDropEvent({ type: "message", user: "UBOT", text: "x" }, "UBOT", false)).toBe(true);
    // bot_message subtype
    expect(shouldDropEvent({ type: "message", subtype: "bot_message", text: "x" }, "UBOT", false)).toBe(true);
    // bot_id present
    expect(shouldDropEvent({ type: "message", bot_id: "B1", text: "x" }, "UBOT", false)).toBe(true);
    // edits/deletes dropped
    expect(shouldDropEvent({ type: "message", subtype: "message_changed" }, "UBOT", false)).toBe(true);
    // non-message event type dropped
    expect(shouldDropEvent({ type: "reaction_added" }, "UBOT", false)).toBe(true);
    // includeBotMessages=true keeps a bot message
    expect(shouldDropEvent({ type: "message", bot_id: "B1", text: "x" }, "UBOT", true)).toBe(false);
  });
});

describe("slack starter — tools via extension host", () => {
  it("registers all tools with the expected tiers", async () => {
    mockFetch(defaultHandler);
    const { tool, teardown } = await loadHost();
    try {
      expect(tool("slack_send")!.tier).toBe("operational");
      expect(tool("slack_stream")!.tier).toBe("operational");
      expect(tool("slack_fetch_context")!.tier).toBe("operational");
      expect(tool("slack_react")!.tier).toBe("strategic");
    } finally {
      await teardown();
    }
  });

  it("slack_send: markdown_text happy path, one channel, returns ts", async () => {
    const calls = mockFetch(defaultHandler);
    const { tool, ctx, teardown } = await loadHost();
    try {
      const before = calls.length;
      const r = (await tool("slack_send")!.execute(
        { channel: "C1", text: "**hello**" },
        ctx as never,
      )) as { ok: boolean; ts: string; ts_all: string[] };
      const posts = calls.slice(before).filter((c) => c.url.endsWith("/chat.postMessage"));
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body).toMatchObject({ channel: "C1", markdown_text: "**hello**" });
      expect(posts[0]!.headers.authorization).toBe("Bearer xoxb-test");
      expect(r.ts).toBe("1699.0001");
      expect(r.ts_all).toEqual(["1699.0001"]);
    } finally {
      await teardown();
    }
  });

  it("slack_send: threads a reply and chunks long text under the first ts", async () => {
    let seq = 0;
    const calls = mockFetch((url) => {
      if (url.endsWith("/chat.postMessage")) return json({ ok: true, ts: "ts-" + seq++ });
      return defaultHandler(url);
    });
    const { tool, ctx, teardown } = await loadHost();
    try {
      // thread_ts given → the reply attaches to it.
      const before = calls.length;
      await tool("slack_send")!.execute({ channel: "C1", text: "reply", thread_ts: "parent" }, ctx as never);
      const post = calls.slice(before).find((c) => c.url.endsWith("/chat.postMessage"))!;
      expect(post.body).toMatchObject({ channel: "C1", thread_ts: "parent" });

      // Long text → multiple chunks, all threaded under the first message's ts.
      seq = 0;
      const before2 = calls.length;
      const long = ("word ".repeat(2000)).trim();
      const r = (await tool("slack_send")!.execute({ channel: "C2", text: long }, ctx as never)) as {
        ts_all: string[];
      };
      const posts = calls.slice(before2).filter((c) => c.url.endsWith("/chat.postMessage"));
      expect(posts.length).toBeGreaterThan(1);
      expect(posts[0]!.body).not.toHaveProperty("thread_ts"); // first has no parent
      // Every later chunk threads under the first ts (ts-0).
      for (const p of posts.slice(1)) expect((p.body as any).thread_ts).toBe("ts-0");
      expect(r.ts_all[0]).toBe("ts-0");
    } finally {
      await teardown();
    }
  }, 15000);

  it("slack_send: falls back to plain text when markdown_text is rejected", async () => {
    const calls = mockFetch((url, init) => {
      if (url.endsWith("/chat.postMessage")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.markdown_text !== undefined) return json({ ok: false, error: "invalid_blocks" });
        return json({ ok: true, ts: "plain-ts" });
      }
      return defaultHandler(url);
    });
    const { tool, ctx, teardown } = await loadHost();
    try {
      const before = calls.length;
      const r = (await tool("slack_send")!.execute({ channel: "C1", text: "hi" }, ctx as never)) as {
        ts: string;
      };
      const posts = calls.slice(before).filter((c) => c.url.endsWith("/chat.postMessage"));
      expect(posts).toHaveLength(2); // markdown_text attempt, then text fallback
      expect(posts[1]!.body).toMatchObject({ channel: "C1", text: "hi" });
      expect(r.ts).toBe("plain-ts");
    } finally {
      await teardown();
    }
  });

  it("slack_stream: no thread/recipient → edit tier (post then throttled update)", async () => {
    const calls = mockFetch(defaultHandler);
    const { tool, ctx, teardown } = await loadHost();
    try {
      const start = (await tool("slack_stream")!.execute(
        { session: "s1", channel: "C1", phase: "start" },
        ctx as never,
      )) as { tier: string };
      expect(start.tier).toBe("edit"); // no thread_ts / recipient → cannot go native

      const before = calls.length;
      await tool("slack_stream")!.execute(
        { session: "s1", channel: "C1", phase: "update", text: "partial answer" },
        ctx as never,
      );
      const posts = calls.slice(before).filter((c) => c.url.endsWith("/chat.postMessage"));
      expect(posts).toHaveLength(1); // first update posts the message
      expect(String((posts[0]!.body as any).text)).toContain("partial answer");

      // startStream is never called on the edit tier.
      expect(calls.some((c) => c.url.endsWith("/chat.startStream"))).toBe(false);

      const fin = (await tool("slack_stream")!.execute(
        { session: "s1", channel: "C1", phase: "finalize", text: "final answer" },
        ctx as never,
      )) as { tier: string; ts_all: string[] };
      expect(fin.tier).toBe("edit");
      expect(calls.some((c) => c.url.endsWith("/chat.update"))).toBe(true); // in-place finalize
    } finally {
      await teardown();
    }
  });

  it("slack_stream: thread + recipient → native tier (start/append/stop)", async () => {
    const calls = mockFetch(defaultHandler);
    const { tool, ctx, teardown } = await loadHost();
    try {
      const start = (await tool("slack_stream")!.execute(
        { session: "s2", channel: "C1", phase: "start", thread_ts: "T", recipient_user_id: "U9" },
        ctx as never,
      )) as { tier: string };
      expect(start.tier).toBe("native");
      const startCall = calls.find((c) => c.url.endsWith("/chat.startStream"))!;
      expect(startCall.body).toMatchObject({
        channel: "C1",
        thread_ts: "T",
        recipient_team_id: "TEAM1", // from auth.test
        recipient_user_id: "U9",
      });

      await tool("slack_stream")!.execute(
        { session: "s2", channel: "C1", phase: "update", text: "Hello" },
        ctx as never,
      );
      await tool("slack_stream")!.execute(
        { session: "s2", channel: "C1", phase: "update", text: "Hello world" },
        ctx as never,
      );
      const appends = calls.filter((c) => c.url.endsWith("/chat.appendStream"));
      // Deltas only: "Hello" then " world".
      expect((appends[0]!.body as any).markdown_text).toBe("Hello");
      expect((appends[1]!.body as any).markdown_text).toBe(" world");

      await tool("slack_stream")!.execute({ session: "s2", channel: "C1", phase: "finalize", text: "Hello world" }, ctx as never);
      expect(calls.some((c) => c.url.endsWith("/chat.stopStream"))).toBe(true);
    } finally {
      await teardown();
    }
  });

  it("acks every envelope first, then fans a real message onto the bus", async () => {
    mockFetch(defaultHandler);
    const { socket, messages, teardown } = await loadHost();
    try {
      expect(socket).toBeDefined();
      socket!.deliver({ type: "hello", num_connections: 1 });
      socket!.deliver({
        type: "events_api",
        envelope_id: "env-1",
        payload: {
          type: "event_callback",
          event_id: "Ev1",
          team_id: "TEAM1",
          event: { type: "message", channel: "C1", channel_type: "channel", user: "U1", text: "hi there", ts: "111.1" },
        },
      });
      // Ack is synchronous (before async processing).
      expect(socket!.acks()).toContainEqual({ envelope_id: "env-1" });
      // Processing awaits users.info; let it settle.
      await sleep(20);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        source: "slack",
        channel_id: "C1",
        content: "hi there",
        is_dm: false,
        author: { id: "U1", name: "Alice", bot: false },
      });
    } finally {
      await teardown();
    }
  });

  it("echo-filters the bot's own messages (acked but not published)", async () => {
    mockFetch(defaultHandler);
    const { socket, messages, teardown } = await loadHost();
    try {
      socket!.deliver({ type: "hello" });
      socket!.deliver({
        type: "events_api",
        envelope_id: "env-2",
        payload: {
          type: "event_callback",
          event_id: "Ev2",
          event: { type: "message", channel: "C1", user: "UBOT", text: "my own echo", ts: "222.2" },
        },
      });
      expect(socket!.acks()).toContainEqual({ envelope_id: "env-2" }); // still acked
      await sleep(20);
      expect(messages).toHaveLength(0); // self message dropped
    } finally {
      await teardown();
    }
  });

  it("slack_fetch_context returns the in-memory ring buffer for a channel", async () => {
    mockFetch(defaultHandler);
    const { socket, tool, ctx, teardown } = await loadHost();
    try {
      socket!.deliver({ type: "hello" });
      for (const [i, text] of ["one", "two", "three"].entries()) {
        socket!.deliver({
          type: "events_api",
          envelope_id: "e" + i,
          payload: {
            type: "event_callback",
            event_id: "Evc" + i,
            event: { type: "message", channel: "C1", channel_type: "channel", user: "U1", text, ts: "1." + i },
          },
        });
      }
      // A message on another channel must not leak into C1's context.
      socket!.deliver({
        type: "events_api",
        envelope_id: "eX",
        payload: {
          type: "event_callback",
          event_id: "EvcX",
          event: { type: "message", channel: "C2", channel_type: "channel", user: "U1", text: "elsewhere", ts: "2.0" },
        },
      });
      await sleep(30);
      const rows = (await tool("slack_fetch_context")!.execute({ channel: "C1" }, ctx as never)) as Array<{
        text: string;
      }>;
      expect(rows.map((r) => r.text)).toEqual(["one", "two", "three"]);
    } finally {
      await teardown();
    }
  });

  it("slackFetch honors 429 Retry-After and retries", async () => {
    let hits = 0;
    const calls = mockFetch((url) => {
      if (url.endsWith("/reactions.add")) {
        hits++;
        if (hits === 1) return json({ ok: false, error: "ratelimited" }, 429, { "retry-after": "0" });
        return json({ ok: true });
      }
      return defaultHandler(url);
    });
    const { tool, ctx, teardown } = await loadHost();
    try {
      const before = calls.length;
      const r = (await tool("slack_react")!.execute(
        { channel: "C1", timestamp: "1.1", name: ":eyes:" },
        ctx as never,
      )) as { ok: boolean };
      expect(r.ok).toBe(true);
      const reacts = calls.slice(before).filter((c) => c.url.endsWith("/reactions.add"));
      expect(reacts).toHaveLength(2); // 429 then success
      // Colons stripped from the emoji name.
      expect((reacts[1]!.body as any).name).toBe("eyes");
    } finally {
      await teardown();
    }
  });
});

describe("slack starter — smoke", () => {
  async function importSmoke(): Promise<{
    smokeTest: (bus: unknown, ctx?: { secrets?: Record<string, string> }) => Promise<void>;
  }> {
    installStarter({ name: "slack", extensionsDir: tmp, authorName: "t" });
    return import(pathToFileURL(join(tmp, "slack", "smoke.ts")).href);
  }

  it("passes when both tokens auth", async () => {
    const { smokeTest } = await importSmoke();
    const calls = mockFetch(defaultHandler);
    await smokeTest(undefined, { secrets: SECRETS });
    expect(calls.some((c) => c.url.endsWith("/auth.test"))).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/apps.connections.open"))).toBe(true);
  });

  it("names the missing secret", async () => {
    const { smokeTest } = await importSmoke();
    mockFetch(defaultHandler);
    await expect(smokeTest(undefined, { secrets: {} })).rejects.toThrow(/SLACK_BOT_TOKEN not set/);
    await expect(smokeTest(undefined, { secrets: { SLACK_BOT_TOKEN: "x" } })).rejects.toThrow(
      /SLACK_APP_TOKEN not set/,
    );
  });

  it("distinguishes a bad bot token from a bad app token", async () => {
    const { smokeTest } = await importSmoke();
    // bad bot token
    mockFetch((url) => {
      if (url.endsWith("/auth.test")) return json({ ok: false, error: "invalid_auth" });
      return defaultHandler(url);
    });
    await expect(smokeTest(undefined, { secrets: SECRETS })).rejects.toThrow(/auth\.test failed.*invalid_auth/);

    // good bot token, wrong app token type (bot token passed as app token)
    mockFetch((url) => {
      if (url.endsWith("/apps.connections.open")) return json({ ok: false, error: "not_allowed_token_type" });
      return defaultHandler(url);
    });
    await expect(smokeTest(undefined, { secrets: SECRETS })).rejects.toThrow(
      /apps\.connections\.open failed.*not_allowed_token_type/,
    );
  });
});
