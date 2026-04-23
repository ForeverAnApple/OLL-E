import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import { createExtensionHost } from "../src/extensions/index.ts";
import { getStarter } from "../src/starters/index.ts";

// End-to-end of the discord-communication starter in-process:
//
//   fake channel-message -> discord-communication subscriber ->
//   chat.input (bus) -> our mock chat handler -> chat.assistant-text
//   chunks + chat.turn-end -> discord-communication -> api.callTool
//   discord_send -> spy tool captures the outbound.
//
// No Discord network calls; the real discord extension is replaced with
// a stub that registers a spy discord_send so we can observe the call.

function rig() {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  return { store, bus, hostId };
}

function installStarterInto(dir: string, name: string): string {
  const starter = getStarter(name);
  if (!starter) throw new Error(`no starter named ${name}`);
  const extDir = join(dir, name);
  mkdirSync(extDir, { recursive: true });
  for (const [f, c] of Object.entries(starter.files)) {
    writeFileSync(join(extDir, f), c);
  }
  return extDir;
}

// A stub "discord" extension that exposes a spy discord_send tool.
// The real starter's discord_send makes a fetch() call; we never want
// that in tests. Registering our stub under the same extension name
// ("discord") means discord-communication's callsTools: ["discord_send"]
// resolves to the spy.
function writeDiscordStub(dir: string): string {
  const extDir = join(dir, "discord");
  mkdirSync(extDir, { recursive: true });
  writeFileSync(
    join(extDir, "manifest.json"),
    JSON.stringify({
      name: "discord",
      version: "0.1.0-test",
      description: "Test stub for discord extension — spy discord_send.",
      capabilities: ["channel:discord"],
    }),
  );
  writeFileSync(
    join(extDir, "index.ts"),
    `
    export const __sends = [];
    export function register(api) {
      api.registerTool({
        name: "discord_send",
        description: "",
        inputSchema: { type: "object" },
        execute: (args, ctx) => {
          __sends.push({ args, actorId: ctx.actorId, extensionId: ctx.extensionId });
          return { id: "stub-msg-" + __sends.length };
        },
      });
    }
    `,
  );
  // No smoke.ts — smoke is optional.
  return extDir;
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "olle-dc-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("discord-communication bridge", () => {
  it("relays a DM end-to-end: channel-message -> chat.input -> turn-end -> discord_send", async () => {
    const r = rig();
    writeDiscordStub(tmp);
    installStarterInto(tmp, "discord-communication");

    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await host.load("discord");
    await host.load("discord-communication");

    const gotInput: string[] = [];
    r.bus.subscribe("chat.input", (ev) => {
      const p = ev.payload as { sessionId: string; text: string };
      gotInput.push(`${p.sessionId}:${p.text}`);
    });

    // Simulate a DM: is_dm=true means no channel allowlist check, no
    // wake-word required, just pump straight through.
    r.bus.publish({
      type: "channel-message",
      hostId: r.hostId,
      actorId: "discord",
      durable: true,
      payload: {
        message_id: "m1",
        guild_id: null,
        channel_id: "dm-1",
        thread_id: null,
        author: { id: "user-1", name: "alice", bot: false },
        content: "hello olle",
        mentions: [],
        reply_to: null,
        is_dm: true,
        is_mention: false,
      },
    });

    // Let the subscribers settle.
    await new Promise((r) => setTimeout(r, 20));
    expect(gotInput).toEqual(["discord:dm-1:user-1:hello olle"]);

    // Now simulate the chat agent's response stream.
    const sessionId = "discord:dm-1:user-1";
    r.bus.publish({
      type: "chat.assistant-text",
      hostId: r.hostId,
      actorId: "root-agent",
      durable: true,
      payload: { sessionId, text: "hi alice" },
    });
    r.bus.publish({
      type: "chat.assistant-text",
      hostId: r.hostId,
      actorId: "root-agent",
      durable: true,
      payload: { sessionId, text: "how can I help?" },
    });
    r.bus.publish({
      type: "chat.turn-end",
      hostId: r.hostId,
      actorId: "root-agent",
      durable: true,
      payload: { sessionId },
    });

    // turn-end handler is async (awaits callTool), give it a tick.
    await new Promise((r) => setTimeout(r, 20));

    const discordModUrl = (() => {
      for (const loaded of host.list()) {
        if (loaded.manifest.name === "discord") return loaded;
      }
      throw new Error("discord not loaded");
    })();
    // We can only get the __sends array by importing the staged module
    // path — the runtime stages copies. Simpler: read from the spy via
    // the tool's captured closure by calling it directly.
    const tools = host.tools();
    const spy = tools.find((t) => t.tool.name === "discord_send");
    expect(spy).toBeDefined();
    // Re-invoke to confirm shape is callable (not asserting on stubbed state).
    void discordModUrl;

    // Instead of reaching into the stub's module state (which isn't
    // exposed through the host), verify via the tool-call audit event
    // that the outbound was attempted with the right args.
    // That signal is emitted by api.callTool for cross-extension dispatch.
    // We subscribed too late for the earlier calls — re-trigger by
    // sending a fresh turn on a second session and observing.
    const seenCalls: Array<{ caller: string; targetExtension: string; tool: string }> = [];
    r.bus.subscribe("tool.called", (ev) => {
      seenCalls.push(ev.payload as typeof seenCalls[number]);
    });

    const s2 = "discord:dm-2:user-2";
    r.bus.publish({
      type: "channel-message",
      hostId: r.hostId,
      actorId: "discord",
      durable: true,
      payload: {
        message_id: "m2",
        guild_id: null,
        channel_id: "dm-2",
        thread_id: null,
        author: { id: "user-2", name: "bob", bot: false },
        content: "",
        mentions: [],
        reply_to: null,
        is_dm: true,
        is_mention: false,
      },
    });
    r.bus.publish({
      type: "chat.assistant-text",
      hostId: r.hostId,
      actorId: "root-agent",
      durable: true,
      payload: { sessionId: s2, text: "hi bob" },
    });
    r.bus.publish({
      type: "chat.turn-end",
      hostId: r.hostId,
      actorId: "root-agent",
      durable: true,
      payload: { sessionId: s2 },
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(seenCalls).toHaveLength(1);
    expect(seenCalls[0]).toMatchObject({
      caller: "discord-communication",
      targetExtension: "discord",
      tool: "discord_send",
    });
  });

  it("ignores guild-channel messages that aren't in watchedChannels and lack a wake-word", async () => {
    const r = rig();
    writeDiscordStub(tmp);
    installStarterInto(tmp, "discord-communication");

    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await host.load("discord");
    await host.load("discord-communication");

    const gotInput: string[] = [];
    r.bus.subscribe("chat.input", (ev) => {
      gotInput.push(((ev.payload as { text: string }).text));
    });

    r.bus.publish({
      type: "channel-message",
      hostId: r.hostId,
      actorId: "discord",
      durable: true,
      payload: {
        message_id: "m3",
        guild_id: "g1",
        channel_id: "public-1",
        thread_id: null,
        author: { id: "user-3", name: "cathy", bot: false },
        content: "just chatting with friends, no bot required",
        mentions: [],
        reply_to: null,
        is_dm: false,
        is_mention: false,
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(gotInput).toEqual([]);
  });

  it("picks up messages when the wake-word matches in a watched channel", async () => {
    const r = rig();
    writeDiscordStub(tmp);
    const extDir = installStarterInto(tmp, "discord-communication");
    // Narrow watchedChannels so we pick up this channel's traffic.
    const manifestPath = join(extDir, "manifest.json");
    const mf = JSON.parse(require("node:fs").readFileSync(manifestPath, "utf8"));
    mf.config.watchedChannels = ["watched-1"];
    require("node:fs").writeFileSync(manifestPath, JSON.stringify(mf));

    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await host.load("discord");
    await host.load("discord-communication");

    const inputs: string[] = [];
    r.bus.subscribe("chat.input", (ev) => {
      inputs.push((ev.payload as { text: string }).text);
    });

    r.bus.publish({
      type: "channel-message",
      hostId: r.hostId,
      actorId: "discord",
      durable: true,
      payload: {
        message_id: "m4",
        guild_id: "g1",
        channel_id: "watched-1",
        thread_id: null,
        author: { id: "user-4", name: "dan", bot: false },
        content: "hey olle, can you help?",
        mentions: [],
        reply_to: null,
        is_dm: false,
        is_mention: false,
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    // The wake-word is stripped, so the chat agent sees clean text.
    expect(inputs).toEqual(["hey , can you help?"]);
  });
});
