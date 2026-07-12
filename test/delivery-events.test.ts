import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBus, persistToStore, type Event } from "../src/bus/index.ts";
import { createExtensionHost, type ExtensionHost } from "../src/extensions/index.ts";
import { installStarter, getStarter } from "../src/starters/index.ts";
import { ulid } from "../src/id/index.ts";
import { openStore, tables } from "../src/store/index.ts";

// Bridge delivery-audit events (workstream B): both communication bridges
// publish durable delivery.succeeded / delivery.failed after attempting to
// deliver a turn's output, so a dropped reply is visible to query_events
// instead of a silent console.error.

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "olle-delivery-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function rig() {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  return { store, bus, hostId };
}

// A stub channel adapter that registers the tools a bridge calls at turn-end
// and always returns ok — lets us drive the success path without a network.
function writeSendStub(root: string, name: string, tools: string[]) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ name, version: "0.1.0", description: "send stub" }, null, 2),
  );
  const regs = tools
    .map(
      (t) => `
        api.registerTool({
          name: "${t}",
          description: "stub ${t}",
          inputSchema: { type: "object" },
          execute: () => ({ ok: true }),
        });`,
    )
    .join("\n");
  writeFileSync(
    join(dir, "index.ts"),
    `export function register(api) {${regs}\n      }\n`,
  );
  return dir;
}

// Publish the two events a bridge listens for to drive a turn's outbound
// delivery: one assistant-text chunk, then turn-end on the same thread.
async function driveTurn(
  bus: ReturnType<typeof createBus>,
  hostId: string,
  threadId: string,
  actorId: string,
  text: string,
) {
  bus.publish({ type: "chat.assistant-text", payload: { text }, hostId, actorId, threadId });
  bus.publish({ type: "chat.turn-end", payload: {}, hostId, actorId, threadId });
  // turn-end handlers are async (they await callTool); let them settle.
  await new Promise((r) => setTimeout(r, 60));
}

function capture(bus: ReturnType<typeof createBus>) {
  const events: Event[] = [];
  bus.subscribe("delivery.succeeded", (ev) => void events.push(ev));
  bus.subscribe("delivery.failed", (ev) => void events.push(ev));
  return events;
}

describe("telegram-communication delivery-audit events", () => {
  let store: ReturnType<typeof rig>["store"];
  let bus: ReturnType<typeof rig>["bus"];
  let hostId: string;
  let host: ExtensionHost;

  afterEach(async () => {
    if (host) await host.unload("telegram-communication").catch(() => {});
    bus?.close();
    store?.close();
  });

  it("emits a durable delivery.failed when the send tool is missing", async () => {
    ({ store, bus, hostId } = rig());
    installStarter({ name: "telegram-communication", extensionsDir: tmp, authorName: "a" });
    host = createExtensionHost({ bus, store, hostId, extensionsDir: tmp });
    await host.load("telegram-communication");

    const events = capture(bus);
    // No telegram_send / telegram_stream registered → the callTool gate
    // throws → the bridge's catch fires.
    await driveTurn(bus, hostId, "telegram:123:u1", "", "hello world");

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe("delivery.failed");
    expect(ev.durable).toBe(true);
    expect(ev.threadId).toBe("telegram:123:u1");
    expect(ev.payload).toMatchObject({
      channel: "telegram",
      threadId: "telegram:123:u1",
      destination: "123",
    });
    expect(typeof (ev.payload as { error: string }).error).toBe("string");
    expect((ev.payload as { error: string }).error.length).toBeGreaterThan(0);
    expect((ev.payload as Record<string, unknown>).jobId).toBeUndefined();
  });

  it("emits a durable delivery.succeeded when the send tool returns ok", async () => {
    ({ store, bus, hostId } = rig());
    // An agent row so the asAgent scope gate (threaded from the turn's
    // actorId) passes instead of throwing on an unknown agent.
    const agentId = "agent-x";
    store
      .insert(tables.agents)
      .values({ id: agentId, name: "x", hostId, scope: {}, createdAt: Date.now() })
      .run();

    installStarter({ name: "telegram-communication", extensionsDir: tmp, authorName: "a" });
    writeSendStub(tmp, "telegram", ["telegram_send", "telegram_stream"]);
    host = createExtensionHost({ bus, store, hostId, extensionsDir: tmp });
    await host.load("telegram");
    await host.load("telegram-communication");

    const events = capture(bus);
    await driveTurn(bus, hostId, "telegram:123:u1", agentId, "delivered body");

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe("delivery.succeeded");
    expect(ev.durable).toBe(true);
    expect(ev.payload).toMatchObject({
      channel: "telegram",
      threadId: "telegram:123:u1",
      destination: "123",
    });
    expect((ev.payload as Record<string, unknown>).jobId).toBeUndefined();

    await host.unload("telegram").catch(() => {});
  });

  it("parses jobId out of a standing-job thread id", async () => {
    ({ store, bus, hostId } = rig());
    installStarter({ name: "telegram-communication", extensionsDir: tmp, authorName: "a" });
    host = createExtensionHost({ bus, store, hostId, extensionsDir: tmp });
    await host.load("telegram-communication");

    const events = capture(bus);
    await driveTurn(bus, hostId, "telegram:123:job:abc", "", "cron output");

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe("delivery.failed");
    expect(ev.payload).toMatchObject({
      channel: "telegram",
      threadId: "telegram:123:job:abc",
      destination: "123",
      jobId: "abc",
    });
  });
});

describe("discord-communication delivery-audit events", () => {
  let store: ReturnType<typeof rig>["store"];
  let bus: ReturnType<typeof rig>["bus"];
  let hostId: string;
  let host: ExtensionHost;

  afterEach(async () => {
    if (host) await host.unload("discord-communication").catch(() => {});
    bus?.close();
    store?.close();
  });

  it("emits a durable delivery.failed when discord_send is missing", async () => {
    ({ store, bus, hostId } = rig());
    installStarter({ name: "discord-communication", extensionsDir: tmp, authorName: "a" });
    host = createExtensionHost({ bus, store, hostId, extensionsDir: tmp });
    await host.load("discord-communication");

    const events = capture(bus);
    await driveTurn(bus, hostId, "discord:456:u1", "", "hello discord");

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe("delivery.failed");
    expect(ev.durable).toBe(true);
    expect(ev.threadId).toBe("discord:456:u1");
    expect(ev.payload).toMatchObject({
      channel: "discord",
      threadId: "discord:456:u1",
      destination: "456",
    });
    expect(typeof (ev.payload as { error: string }).error).toBe("string");
    expect((ev.payload as Record<string, unknown>).jobId).toBeUndefined();
  });

  it("parses jobId out of a discord standing-job thread id", async () => {
    ({ store, bus, hostId } = rig());
    installStarter({ name: "discord-communication", extensionsDir: tmp, authorName: "a" });
    host = createExtensionHost({ bus, store, hostId, extensionsDir: tmp });
    await host.load("discord-communication");

    const events = capture(bus);
    await driveTurn(bus, hostId, "discord:456:job:xyz", "", "cron output");

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe("delivery.failed");
    expect(ev.payload).toMatchObject({
      channel: "discord",
      threadId: "discord:456:job:xyz",
      destination: "456",
      jobId: "xyz",
    });
  });
});

describe("bridge manifests declare the delivery events", () => {
  it("both bridges list delivery.succeeded and delivery.failed in eventWrites", () => {
    for (const name of ["telegram-communication", "discord-communication"]) {
      const raw = getStarter(name)!.files["manifest.json"]!;
      const mf = JSON.parse(raw) as { eventWrites: string[] };
      expect(mf.eventWrites).toContain("delivery.succeeded");
      expect(mf.eventWrites).toContain("delivery.failed");
    }
  });
});
