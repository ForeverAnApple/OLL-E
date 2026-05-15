import { describe, expect, it } from "bun:test";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { createInbox } from "../src/inbox/index.ts";
import { ulid } from "../src/id/index.ts";
import { startChatHealthMonitor } from "../src/daemon/chat-health.ts";

function rig() {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  const ownerAgentId = ulid();
  store
    .insert(tables.agents)
    .values({
      id: ownerAgentId,
      name: "p",
      hostId,
      scope: { allowTiers: ["operational", "strategic", "vision"] },
      channels: [],
      ownsMoney: true,
      createdAt: Date.now(),
    })
    .run();
  const agentId = "root";
  store
    .insert(tables.agents)
    .values({ id: agentId, name: "root", hostId, parentAgentId: ownerAgentId, createdAt: Date.now() })
    .run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  const inbox = createInbox({ bus, store, hostId });
  return { store, bus, hostId, ownerAgentId, agentId, inbox };
}

function chatError(r: ReturnType<typeof rig>, threadId: string, error: string) {
  r.bus.publish({
    type: "chat.error",
    hostId: r.hostId,
    actorId: r.agentId,
    threadId,
    durable: true,
    payload: { error },
  });
}

describe("daemon/chat-health", () => {
  it("posts an inbox proposal after the threshold is crossed", () => {
    const r = rig();
    const monitor = startChatHealthMonitor({
      bus: r.bus,
      inbox: r.inbox,
      hostId: r.hostId,
      ownerAgentId: r.ownerAgentId,
      agentId: r.agentId,
      threshold: 2,
    });

    expect(r.inbox.listOpen(r.ownerAgentId)).toHaveLength(0);
    chatError(r, "t1", "first");
    expect(r.inbox.listOpen(r.ownerAgentId)).toHaveLength(0);
    chatError(r, "t1", "second");
    const open = r.inbox.listOpen(r.ownerAgentId);
    expect(open).toHaveLength(1);
    const payload = open[0]!.payload as { kind: string; lastError: string };
    expect(payload.kind).toBe("chat-failure");
    expect(payload.lastError).toBe("second");
    monitor.stop();
  });

  it("does not double-post for the same outage", () => {
    const r = rig();
    const monitor = startChatHealthMonitor({
      bus: r.bus,
      inbox: r.inbox,
      hostId: r.hostId,
      ownerAgentId: r.ownerAgentId,
      agentId: r.agentId,
      threshold: 2,
    });
    chatError(r, "t1", "a");
    chatError(r, "t1", "b");
    chatError(r, "t1", "c");
    chatError(r, "t1", "d");
    expect(r.inbox.listOpen(r.ownerAgentId)).toHaveLength(1);
    monitor.stop();
  });

  it("re-arms after a successful turn-end", () => {
    const r = rig();
    const monitor = startChatHealthMonitor({
      bus: r.bus,
      inbox: r.inbox,
      hostId: r.hostId,
      ownerAgentId: r.ownerAgentId,
      agentId: r.agentId,
      threshold: 2,
    });
    chatError(r, "t1", "a");
    chatError(r, "t1", "b");
    expect(r.inbox.listOpen(r.ownerAgentId)).toHaveLength(1);

    r.bus.publish({
      type: "chat.turn-end",
      hostId: r.hostId,
      actorId: r.agentId,
      threadId: "t1",
      durable: true,
      payload: {},
    });
    chatError(r, "t1", "c");
    chatError(r, "t1", "d");
    expect(r.inbox.listOpen(r.ownerAgentId)).toHaveLength(2);
    monitor.stop();
  });

  it("ignores chat.error from other agents", () => {
    const r = rig();
    const monitor = startChatHealthMonitor({
      bus: r.bus,
      inbox: r.inbox,
      hostId: r.hostId,
      ownerAgentId: r.ownerAgentId,
      agentId: r.agentId,
      threshold: 2,
    });
    for (let i = 0; i < 5; i++) {
      r.bus.publish({
        type: "chat.error",
        hostId: r.hostId,
        actorId: "some-other-agent",
        threadId: "t1",
        durable: true,
        payload: { error: "n/a" },
      });
    }
    expect(r.inbox.listOpen(r.ownerAgentId)).toHaveLength(0);
    monitor.stop();
  });
});
