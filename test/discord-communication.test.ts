import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import { createExtensionHost } from "../src/extensions/index.ts";
import { getStarter } from "../src/starters/index.ts";

// End-to-end of the discord-communication starter in-process, using the
// mailbox routing model: channel-message -> chat.input addressed to root's
// mailbox with a discord:* threadId -> (simulated) chat.assistant-text
// + chat.turn-end tagged with the same threadId -> bridge calls
// discord_send. No Discord network calls; a stub discord extension
// captures the outbound via a spy tool.

function rig() {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  const rootAgentId = "root-agent";
  store
    .insert(tables.agents)
    .values({ id: rootAgentId, name: "root", hostId, createdAt: Date.now() })
    .run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  return { store, bus, hostId, rootAgentId };
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
  return extDir;
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "olle-dc-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("discord-communication bridge (mailbox-routed)", () => {
  it("DM: publishes chat.input addressed to root's mailbox with a discord:* threadId", async () => {
    const r = rig();
    writeDiscordStub(tmp);
    installStarterInto(tmp, "discord-communication");

    const host = createExtensionHost({
      ...r,
      extensionsDir: tmp,
      defaultTaskAgentId: r.rootAgentId,
    });
    await host.load("discord");
    await host.load("discord-communication");

    const gotInput: Array<{ toAgentId?: string; threadId?: string; text: string }> = [];
    r.bus.subscribe("chat.input", (ev) => {
      gotInput.push({
        toAgentId: ev.toAgentId,
        threadId: ev.threadId,
        text: (ev.payload as { text: string }).text,
      });
    });

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

    await new Promise((r) => setTimeout(r, 20));
    expect(gotInput).toEqual([
      { toAgentId: r.rootAgentId, threadId: "discord:dm-1:user-1", text: "hello olle" },
    ]);
  });

  it("Routes the agent's turn-end back to discord_send, filtered by threadId", async () => {
    const r = rig();
    writeDiscordStub(tmp);
    installStarterInto(tmp, "discord-communication");

    const host = createExtensionHost({
      ...r,
      extensionsDir: tmp,
      defaultTaskAgentId: r.rootAgentId,
    });
    await host.load("discord");
    await host.load("discord-communication");

    // Observe the cross-extension tool-call audit so we can verify the
    // bridge dispatched discord_send with the right args without reaching
    // into the stub's module state.
    const seenCalls: Array<{ caller: string; targetExtension: string; tool: string }> = [];
    r.bus.subscribe("tool.called", (ev) => {
      seenCalls.push(ev.payload as (typeof seenCalls)[number]);
    });

    // 1) Inbound DM — bridge creates a route for the thread.
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
    await new Promise((r) => setTimeout(r, 10));

    const threadId = "discord:dm-2:user-2";
    // 2) Simulate the agent loop's replies tagged with the same threadId.
    r.bus.publish({
      type: "chat.assistant-text",
      hostId: r.hostId,
      actorId: r.rootAgentId,
      durable: true,
      threadId,
      payload: { text: "hi bob" },
    });
    r.bus.publish({
      type: "chat.turn-end",
      hostId: r.hostId,
      actorId: r.rootAgentId,
      durable: true,
      threadId,
      payload: {},
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

    const host = createExtensionHost({
      ...r,
      extensionsDir: tmp,
      defaultTaskAgentId: r.rootAgentId,
    });
    await host.load("discord");
    await host.load("discord-communication");

    const gotInput: string[] = [];
    r.bus.subscribe("chat.input", (ev) => {
      gotInput.push((ev.payload as { text: string }).text);
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
    const manifestPath = join(extDir, "manifest.json");
    const mf = JSON.parse(readFileSync(manifestPath, "utf8"));
    mf.config.watchedChannels = ["watched-1"];
    writeFileSync(manifestPath, JSON.stringify(mf));

    const host = createExtensionHost({
      ...r,
      extensionsDir: tmp,
      defaultTaskAgentId: r.rootAgentId,
    });
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
    // Wake-word stripped from guild-channel text.
    expect(inputs).toEqual(["hey , can you help?"]);
  });
});
