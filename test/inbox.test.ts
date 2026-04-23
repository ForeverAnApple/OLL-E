import { describe, expect, it } from "bun:test";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { askUp, createInbox } from "../src/inbox/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";

function rig() {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  const inbox = createInbox({ bus, store, hostId });
  return { store, bus, inbox, hostId };
}

function seedPrincipalAndAgent(
  rig: ReturnType<typeof createRigHelpers>["rig"],
  opts: {
    agentId: string;
    parentAgentId?: string;
    allowTiers?: Array<"operational" | "strategic" | "vision">;
  },
): { principalId: string } {
  const principalId = ulid();
  rig.store
    .insert(tables.principals)
    .values({ id: principalId, display: "me", channels: [], createdAt: Date.now() })
    .run();
  rig.store
    .insert(tables.agents)
    .values({
      id: opts.agentId,
      name: opts.agentId,
      hostId: rig.hostId,
      parentAgentId: opts.parentAgentId,
      scope: { allowTiers: opts.allowTiers ?? [] },
      createdAt: Date.now(),
    })
    .run();
  return { principalId };
}

function createRigHelpers() {
  return { rig: rig() };
}

describe("inbox propose/respond", () => {
  it("propose writes a decision and emits a durable event", () => {
    const r = rig();
    const { principalId } = seedPrincipalAndAgent(r, { agentId: "proposer" });
    const events: string[] = [];
    r.bus.subscribe("*", (e) => void events.push(e.type));
    const { id } = r.inbox.propose({
      principalId,
      proposingAgentId: "proposer",
      tier: "strategic",
      summary: "install discord",
      payload: { ext: "discord" },
    });
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const list = r.inbox.listOpen(principalId);
    expect(list).toHaveLength(1);
    expect(events).toContain("decision.proposed");
  });

  it("respond(approve) resolves and emits decision.resolved", () => {
    const r = rig();
    const { principalId } = seedPrincipalAndAgent(r, { agentId: "proposer" });
    const { id } = r.inbox.propose({
      principalId,
      proposingAgentId: "proposer",
      tier: "strategic",
      summary: "do a thing",
      payload: { foo: 1 },
    });
    const seen: unknown[] = [];
    r.bus.subscribe("decision.resolved", (e) => void seen.push(e.payload));

    const after = r.inbox.respond({ decisionId: id, actorId: "principal-1", vote: "approve" });
    expect(after.status).toBe("approved");
    expect(seen).toHaveLength(1);
    const p = seen[0] as { status: string; vote: string };
    expect(p.status).toBe("approved");
    expect(p.vote).toBe("approve");
  });

  it("respond(modify) swaps the payload", () => {
    const r = rig();
    const { principalId } = seedPrincipalAndAgent(r, { agentId: "proposer" });
    const { id } = r.inbox.propose({
      principalId,
      proposingAgentId: "proposer",
      tier: "operational",
      summary: "x",
      payload: { v: 1 },
    });
    const after = r.inbox.respond({
      decisionId: id,
      actorId: "principal-1",
      vote: "modify",
      payloadOverride: { v: 42 },
    });
    expect(after.status).toBe("modified");
    expect(after.payload).toEqual({ v: 42 });
  });

  it("double-respond is rejected", () => {
    const r = rig();
    const { principalId } = seedPrincipalAndAgent(r, { agentId: "proposer" });
    const { id } = r.inbox.propose({
      principalId,
      proposingAgentId: "proposer",
      tier: "operational",
      summary: "x",
      payload: {},
    });
    r.inbox.respond({ decisionId: id, actorId: "p", vote: "approve" });
    expect(() => r.inbox.respond({ decisionId: id, actorId: "p", vote: "deny" })).toThrow();
  });

  it("sweepStale closes past-deadline decisions", () => {
    const r = rig();
    const { principalId } = seedPrincipalAndAgent(r, { agentId: "proposer" });
    r.inbox.propose({
      principalId,
      proposingAgentId: "proposer",
      tier: "strategic",
      summary: "fresh",
      payload: {},
      stalenessMs: 1_000_000,
    });
    r.inbox.propose({
      principalId,
      proposingAgentId: "proposer",
      tier: "strategic",
      summary: "gone",
      payload: {},
      stalenessMs: 10,
    });
    // advance virtual "now"
    const n = r.inbox.sweepStale(Date.now() + 1_000);
    expect(n).toBe(1);
    expect(r.inbox.listOpen(principalId)).toHaveLength(1);
  });
});

describe("askUp chain", () => {
  it("auto-approves when a parent has the tier in delegated authority", () => {
    const r = rig();
    const { principalId } = seedPrincipalAndAgent(r, {
      agentId: "root",
      allowTiers: ["strategic", "operational"],
    });
    r.store
      .insert(tables.agents)
      .values({
        id: "child",
        name: "child",
        hostId: r.hostId,
        parentAgentId: "root",
        scope: {},
        createdAt: Date.now(),
      })
      .run();

    const result = askUp(
      { bus: r.bus, store: r.store, hostId: r.hostId, inbox: r.inbox },
      {
        proposingAgentId: "child",
        principalId,
        tier: "strategic",
        summary: "rename thing",
        payload: { foo: "bar" },
      },
    );
    expect(result.kind).toBe("auto-approved");
    expect(result.approverAgentId).toBe("root");
    expect(r.inbox.listOpen(principalId)).toHaveLength(0);
  });

  it("queues to principal inbox when no ancestor has authority", () => {
    const r = rig();
    const { principalId } = seedPrincipalAndAgent(r, { agentId: "root", allowTiers: [] });
    r.store
      .insert(tables.agents)
      .values({
        id: "child",
        name: "child",
        hostId: r.hostId,
        parentAgentId: "root",
        scope: {},
        createdAt: Date.now(),
      })
      .run();

    const result = askUp(
      { bus: r.bus, store: r.store, hostId: r.hostId, inbox: r.inbox },
      {
        proposingAgentId: "child",
        principalId,
        tier: "vision",
        summary: "rewrite mission",
        payload: {},
      },
    );
    expect(result.kind).toBe("queued");
    expect(r.inbox.listOpen(principalId)).toHaveLength(1);
  });
});
