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

describe("inbox reply — agent follow-up messages on a decision", () => {
  // The "agent → principal FYI" edge that was missing: after a proposal
  // resolves, the proposing agent reports back into the same decision
  // thread (executed it, blocked, etc) without opening a new vote.

  it("reply appends a row, fires decision.replied, and listMessages returns it", () => {
    const r = rig();
    const { principalId } = seedPrincipalAndAgent(r, { agentId: "proposer" });
    const { id: did } = r.inbox.propose({
      principalId,
      proposingAgentId: "proposer",
      tier: "strategic",
      summary: "do x",
      payload: {},
    });
    r.inbox.respond({ decisionId: did, actorId: "principal-1", vote: "approve" });

    const replied: unknown[] = [];
    r.bus.subscribe("decision.replied", (e) => void replied.push(e.payload));

    const m = r.inbox.reply({
      decisionId: did,
      actorId: "proposer",
      text: "done — see commit abc123",
    });
    expect(m.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(m.text).toBe("done — see commit abc123");
    expect(m.actorId).toBe("proposer");

    const list = r.inbox.listMessages(did);
    expect(list).toHaveLength(1);
    expect(list[0]!.text).toBe("done — see commit abc123");

    expect(replied).toHaveLength(1);
    const p = replied[0] as { decisionId: string; replyId: string; textPreview: string };
    expect(p.decisionId).toBe(did);
    expect(p.replyId).toBe(m.id);
    expect(p.textPreview).toBe("done — see commit abc123");
  });

  it("reply on an unknown decision throws", () => {
    const r = rig();
    seedPrincipalAndAgent(r, { agentId: "proposer" });
    expect(() =>
      r.inbox.reply({ decisionId: "no-such-id", actorId: "proposer", text: "hi" }),
    ).toThrow(/not found/);
  });

  it("listMessages returns rows in chronological order", () => {
    const r = rig();
    const { principalId } = seedPrincipalAndAgent(r, { agentId: "proposer" });
    const { id: did } = r.inbox.propose({
      principalId,
      proposingAgentId: "proposer",
      tier: "operational",
      summary: "x",
      payload: {},
    });
    r.inbox.reply({ decisionId: did, actorId: "proposer", text: "first" });
    // Tiny delay so `at` differs deterministically.
    Bun.sleepSync(2);
    r.inbox.reply({ decisionId: did, actorId: "proposer", text: "second" });
    Bun.sleepSync(2);
    r.inbox.reply({ decisionId: did, actorId: "proposer", text: "third" });

    const list = r.inbox.listMessages(did);
    expect(list.map((m) => m.text)).toEqual(["first", "second", "third"]);
  });

  it("markDecisionRead is idempotent and per-reader", () => {
    const r = rig();
    const { principalId } = seedPrincipalAndAgent(r, { agentId: "proposer" });
    const { id: did } = r.inbox.propose({
      principalId,
      proposingAgentId: "proposer",
      tier: "operational",
      summary: "x",
      payload: {},
    });
    r.inbox.reply({ decisionId: did, actorId: "proposer", text: "a" });
    r.inbox.reply({ decisionId: did, actorId: "proposer", text: "b" });

    // Reader X marks all → 2 newly marked.
    expect(r.inbox.markDecisionRead(did, "reader-x")).toBe(2);
    // Idempotent — re-marking adds nothing.
    expect(r.inbox.markDecisionRead(did, "reader-x")).toBe(0);
    // Reader Y is independent.
    expect(r.inbox.markDecisionRead(did, "reader-y")).toBe(2);
    // X's read set covers both messages.
    expect(r.inbox.readMessageIdsFor(did, "reader-x").size).toBe(2);
    // A new reply lands → reader X has one unread again.
    r.inbox.reply({ decisionId: did, actorId: "proposer", text: "c" });
    const counts = r.inbox.unreadCountsByDecision([did], "reader-x");
    expect(counts.get(did)).toBe(1);
  });

  it("listActionable returns open decisions PLUS resolved-with-unread-replies", () => {
    // The principal's inbox should surface anything needing attention:
    // open decisions awaiting their vote, AND resolved decisions where
    // the agent reported back and they haven't read it yet.
    const r = rig();
    const { principalId } = seedPrincipalAndAgent(r, { agentId: "proposer" });
    const stillOpen = r.inbox.propose({
      principalId,
      proposingAgentId: "proposer",
      tier: "operational",
      summary: "still open",
      payload: {},
    });
    const resolvedWithUnread = r.inbox.propose({
      principalId,
      proposingAgentId: "proposer",
      tier: "operational",
      summary: "resolved + new agent reply",
      payload: {},
    });
    r.inbox.respond({
      decisionId: resolvedWithUnread.id,
      actorId: principalId,
      vote: "approve",
    });
    r.inbox.reply({
      decisionId: resolvedWithUnread.id,
      actorId: "proposer",
      text: "shipped abc",
    });
    const resolvedAndRead = r.inbox.propose({
      principalId,
      proposingAgentId: "proposer",
      tier: "operational",
      summary: "resolved + reply already read",
      payload: {},
    });
    r.inbox.respond({
      decisionId: resolvedAndRead.id,
      actorId: principalId,
      vote: "approve",
    });
    r.inbox.reply({
      decisionId: resolvedAndRead.id,
      actorId: "proposer",
      text: "shipped def",
    });
    r.inbox.markDecisionRead(resolvedAndRead.id, principalId);

    const actionable = r.inbox.listActionable(principalId, principalId);
    const ids = actionable.map((d) => d.id).sort();
    expect(ids).toEqual([stillOpen.id, resolvedWithUnread.id].sort());
    // Resolved-and-read is filtered out — neither open nor has unread.
    expect(ids).not.toContain(resolvedAndRead.id);

    // After viewing resolvedWithUnread, it falls out of actionable.
    r.inbox.markDecisionRead(resolvedWithUnread.id, principalId);
    const after = r.inbox.listActionable(principalId, principalId);
    expect(after.map((d) => d.id)).toEqual([stillOpen.id]);
  });

  it("unreadCountsByDecision returns 0 for decisions with no replies and is bulk-correct", () => {
    const r = rig();
    const { principalId } = seedPrincipalAndAgent(r, { agentId: "proposer" });
    const { id: d1 } = r.inbox.propose({
      principalId,
      proposingAgentId: "proposer",
      tier: "operational",
      summary: "one",
      payload: {},
    });
    const { id: d2 } = r.inbox.propose({
      principalId,
      proposingAgentId: "proposer",
      tier: "operational",
      summary: "two",
      payload: {},
    });
    const { id: d3 } = r.inbox.propose({
      principalId,
      proposingAgentId: "proposer",
      tier: "operational",
      summary: "three",
      payload: {},
    });
    r.inbox.reply({ decisionId: d1, actorId: "proposer", text: "x" });
    r.inbox.reply({ decisionId: d1, actorId: "proposer", text: "y" });
    r.inbox.reply({ decisionId: d3, actorId: "proposer", text: "z" });

    const counts = r.inbox.unreadCountsByDecision([d1, d2, d3], "reader");
    expect(counts.get(d1)).toBe(2);
    expect(counts.get(d2)).toBe(0);
    expect(counts.get(d3)).toBe(1);

    // After marking d1 read, it drops to 0 but d3 stays 1.
    r.inbox.markDecisionRead(d1, "reader");
    const after = r.inbox.unreadCountsByDecision([d1, d2, d3], "reader");
    expect(after.get(d1)).toBe(0);
    expect(after.get(d3)).toBe(1);
  });

  it("textPreview truncates long bodies in the event payload (full text in row)", () => {
    const r = rig();
    const { principalId } = seedPrincipalAndAgent(r, { agentId: "proposer" });
    const { id: did } = r.inbox.propose({
      principalId,
      proposingAgentId: "proposer",
      tier: "operational",
      summary: "x",
      payload: {},
    });
    const long = "x".repeat(500);
    const seen: unknown[] = [];
    r.bus.subscribe("decision.replied", (e) => void seen.push(e.payload));
    const m = r.inbox.reply({ decisionId: did, actorId: "proposer", text: long });
    expect(m.text).toBe(long);
    const p = seen[0] as { textPreview: string; textLength: number };
    expect(p.textLength).toBe(500);
    expect(p.textPreview.length).toBeLessThanOrEqual(200);
    expect(p.textPreview.endsWith("...")).toBe(true);
  });
});
