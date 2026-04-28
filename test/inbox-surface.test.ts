// Tests for the human-facing inbox surface (IPC + agent core tools).
//
// Two halves:
//   1. IPC roundtrip — `inbox.list` / `inbox.get` / `inbox.respond` /
//      `inbox.count` against a live daemon. Mirrors how `olle inbox` and
//      future channel adapters reach the inbox.
//   2. Tool surface — buildInboxTools() returning execute() that resolves
//      the same Inbox the IPC handlers use, so `mail_list`/`mail_respond`
//      see identical rows.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/daemon/daemon.ts";
import { connectIpc, type IpcClient } from "../src/ipc/index.ts";
import { buildInboxTools } from "../src/tools/inbox.ts";
import type { Decision } from "../src/store/schema.ts";
import { tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import type { AskUpResult } from "../src/inbox/index.ts";
import { eq } from "drizzle-orm";

let daemon: Daemon;
let client: IpcClient;
let tmp: string;
let tools: ReturnType<typeof buildInboxTools>;

// Daemon lifecycle is shared across the file; only inbox state resets per test.
// Per-test daemon spinup was ~200ms × 13 tests = ~2.5s of pure setup.
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "olle-inbox-surface-"));
  daemon = await startDaemon({ root: tmp, version: "test", quiet: true });
  client = await connectIpc(daemon.paths.socketFile);
  tools = buildInboxTools({
    inbox: daemon.inbox,
    principalId: daemon.rootPrincipalId,
    bus: daemon.bus,
    hostId: daemon.hostId,
    store: daemon.store,
  });
});

beforeEach(() => {
  // Order matters: walk leaf-to-root through the FK graph.
  daemon.store.raw.exec(
    "DELETE FROM decision_message_reads;" +
      " DELETE FROM decision_messages;" +
      " DELETE FROM approvals;" +
      " DELETE FROM decisions;",
  );
});

afterAll(async () => {
  client.close();
  await daemon.shutdown();
  rmSync(tmp, { recursive: true, force: true });
});

function seedDecision(d: Daemon, summary = "install discord"): { id: string } {
  return d.inbox.propose({
    principalId: d.rootPrincipalId,
    proposingAgentId: d.rootAgentId,
    tier: "strategic",
    summary,
    payload: { ext: "discord" },
  });
}

describe("inbox.* IPC", () => {
  it("inbox.list defaults to root principal and returns open rows", async () => {
    seedDecision(daemon, "first");
    seedDecision(daemon, "second");
    const rows = await client.call<Decision[]>("inbox.list");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.summary).sort()).toEqual(["first", "second"]);
    for (const r of rows) {
      expect(r.status).toBe("open");
      expect(r.principalId).toBe(daemon.rootPrincipalId);
    }
  });

  it("inbox.list status=all includes resolved", async () => {
    const { id } = seedDecision(daemon, "resolve me");
    seedDecision(daemon, "stay open");
    await client.call("inbox.respond", { id, vote: "approve" });
    const active = await client.call<Decision[]>("inbox.list");
    const all = await client.call<Decision[]>("inbox.list", { status: "all" });
    // Default filter is "active" — open OR has-unread. The resolved row
    // has no replies, so it falls out of the default view.
    expect(active).toHaveLength(1);
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === id)?.status).toBe("approved");
  });

  it("inbox.list default surfaces resolved decisions with unread agent replies", async () => {
    const { id } = seedDecision(daemon, "resolve + reply");
    seedDecision(daemon, "stay open");
    await client.call("inbox.respond", { id, vote: "approve" });
    daemon.inbox.reply({ decisionId: id, actorId: daemon.rootAgentId, text: "shipped" });
    // Default filter (no status param) should now show BOTH the open row
    // and the resolved-with-unread row — the load-bearing fix for "I
    // can't see the agent's reply unless I switch to all".
    const active = await client.call<Decision[]>("inbox.list");
    expect(active).toHaveLength(2);
    expect(active.map((r) => r.id).sort()).toContain(id);

    // After viewing the resolved one, it auto-marks read and falls out.
    await client.call("inbox.get", { id });
    const afterRead = await client.call<Decision[]>("inbox.list");
    expect(afterRead.map((r) => r.id)).not.toContain(id);
  });

  it("inbox.list status=open is the strict lifecycle filter (no unread-replies expansion)", async () => {
    const { id } = seedDecision(daemon, "resolve + reply");
    seedDecision(daemon, "stay open");
    await client.call("inbox.respond", { id, vote: "approve" });
    daemon.inbox.reply({ decisionId: id, actorId: daemon.rootAgentId, text: "shipped" });
    // status=open — strictly open status, regardless of unread state.
    const strictlyOpen = await client.call<Decision[]>("inbox.list", { status: "open" });
    expect(strictlyOpen).toHaveLength(1);
    expect(strictlyOpen[0]!.id).not.toBe(id);
  });

  it("inbox.get returns full row plus reply messages; missing id errors", async () => {
    const { id } = seedDecision(daemon);
    daemon.inbox.reply({ decisionId: id, actorId: daemon.rootAgentId, text: "shipped abc" });
    const r = await client.call<
      Decision & {
        messages: Array<{ text: string; actorId: string; actorName: string; read: boolean }>;
      }
    >("inbox.get", { id });
    expect(r.id).toBe(id);
    expect(r.payload).toEqual({ ext: "discord" });
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]!.text).toBe("shipped abc");
    expect(r.messages[0]!.actorId).toBe(daemon.rootAgentId);
    // actorName resolves the display name so the CLI doesn't show raw ULIDs.
    expect(r.messages[0]!.actorName).toBe("root");
    // First read returns read:false (the principal hadn't seen it before).
    expect(r.messages[0]!.read).toBe(false);
    await expect(client.call("inbox.get", { id: "nope" })).rejects.toThrow(/not found/);
  });

  it("inbox.get auto-marks replies read; subsequent gets return read:true", async () => {
    const { id } = seedDecision(daemon);
    daemon.inbox.reply({ decisionId: id, actorId: daemon.rootAgentId, text: "first" });
    daemon.inbox.reply({ decisionId: id, actorId: daemon.rootAgentId, text: "second" });
    const first = await client.call<{ messages: Array<{ read: boolean }> }>("inbox.get", { id });
    expect(first.messages.every((m) => !m.read)).toBe(true);
    const second = await client.call<{ messages: Array<{ read: boolean }> }>("inbox.get", { id });
    expect(second.messages.every((m) => m.read)).toBe(true);
    // A new reply lands → only that one is unread on the next get.
    daemon.inbox.reply({ decisionId: id, actorId: daemon.rootAgentId, text: "third" });
    const third = await client.call<{ messages: Array<{ read: boolean; text: string }> }>(
      "inbox.get",
      { id },
    );
    const unreadTexts = third.messages.filter((m) => !m.read).map((m) => m.text);
    expect(unreadTexts).toEqual(["third"]);
  });

  it("inbox.get with markRead:false does NOT advance the read state", async () => {
    const { id } = seedDecision(daemon);
    daemon.inbox.reply({ decisionId: id, actorId: daemon.rootAgentId, text: "x" });
    await client.call("inbox.get", { id, markRead: false });
    // Second call with default markRead still sees the message as unread,
    // because the first call didn't mark it.
    const r = await client.call<{ messages: Array<{ read: boolean }> }>("inbox.get", { id });
    expect(r.messages[0]!.read).toBe(false);
  });

  it("inbox.list enriches each row with unreadReplyCount", async () => {
    const { id: d1 } = seedDecision(daemon, "first");
    seedDecision(daemon, "second");
    daemon.inbox.reply({ decisionId: d1, actorId: daemon.rootAgentId, text: "a" });
    daemon.inbox.reply({ decisionId: d1, actorId: daemon.rootAgentId, text: "b" });
    const rows = await client.call<Array<Decision & { unreadReplyCount: number }>>("inbox.list");
    const row1 = rows.find((r) => r.id === d1)!;
    const row2 = rows.find((r) => r.summary === "second")!;
    expect(row1.unreadReplyCount).toBe(2);
    expect(row2.unreadReplyCount).toBe(0);
    // After viewing d1 (which auto-marks read), the list count drops.
    await client.call("inbox.get", { id: d1 });
    const after = await client.call<Array<Decision & { unreadReplyCount: number }>>("inbox.list");
    expect(after.find((r) => r.id === d1)!.unreadReplyCount).toBe(0);
  });

  it("inbox.get/respond accept a unique id prefix (CLI paste-friendly)", async () => {
    const { id } = seedDecision(daemon);
    const prefix = id.slice(0, 10);
    const r = await client.call<Decision>("inbox.get", { id: prefix });
    expect(r.id).toBe(id);
    const updated = await client.call<Decision>("inbox.respond", { id: prefix, vote: "approve" });
    expect(updated.status).toBe("approved");
  });

  it("inbox.respond approves and emits decision.resolved", async () => {
    const { id } = seedDecision(daemon);
    const seen: unknown[] = [];
    const unsub = daemon.bus.subscribe("decision.resolved", (e) => void seen.push(e.payload));
    const updated = await client.call<Decision>("inbox.respond", { id, vote: "approve" });
    unsub();
    expect(updated.status).toBe("approved");
    expect(seen).toHaveLength(1);
  });

  it("inbox.respond rejects bad votes", async () => {
    const { id } = seedDecision(daemon);
    await expect(client.call("inbox.respond", { id, vote: "yes" })).rejects.toThrow(
      /vote must be approve/,
    );
  });

  it("inbox.respond modify swaps payload", async () => {
    const { id } = seedDecision(daemon);
    const updated = await client.call<Decision>("inbox.respond", {
      id,
      vote: "modify",
      payloadOverride: { ext: "discord", costCapUsd: 5 },
    });
    expect(updated.status).toBe("modified");
    expect(updated.payload).toEqual({ ext: "discord", costCapUsd: 5 });
  });

  it("inbox.count surfaces open count for the chat banner", async () => {
    let r = await client.call<{ open: number }>("inbox.count");
    expect(r.open).toBe(0);
    seedDecision(daemon);
    seedDecision(daemon);
    r = await client.call<{ open: number }>("inbox.count");
    expect(r.open).toBe(2);
  });
});

describe("mail_* core tools", () => {
  // Tool surface mirrors IPC: same Inbox instance, so rows are identical.
  it("mail_list returns the same rows as inbox.list", async () => {
    seedDecision(daemon, "via tools");
    const list = tools.find((t) => t.name === "mail_list")!;
    const ipcRows = await client.call<Decision[]>("inbox.list");
    const toolRows = (await list.execute({}, makeCtx(daemon))) as Decision[];
    expect(toolRows.map((r) => r.id).sort()).toEqual(ipcRows.map((r) => r.id).sort());
  });

  it("mail_list includeResolved=true matches inbox.list?status=all", async () => {
    const { id } = seedDecision(daemon);
    seedDecision(daemon, "still-open");
    await client.call("inbox.respond", { id, vote: "deny" });
    const list = tools.find((t) => t.name === "mail_list")!;
    const all = (await list.execute({ includeResolved: true }, makeCtx(daemon))) as Decision[];
    expect(all).toHaveLength(2);
    const open = (await list.execute({}, makeCtx(daemon))) as Decision[];
    expect(open).toHaveLength(1);
    expect(open[0]!.summary).toBe("still-open");
  });

  it("mail_respond resolves a decision and stamps actorId from ctx", async () => {
    const { id } = seedDecision(daemon);
    const respond = tools.find((t) => t.name === "mail_respond")!;
    const updated = (await respond.execute(
      { id, vote: "approve", message: "lgtm" },
      makeCtx(daemon),
    )) as Decision;
    expect(updated.status).toBe("approved");
    const approvalRow = daemon.store.raw
      .query<{ actor_id: string; message: string }, [string]>(
        "SELECT actor_id, message FROM approvals WHERE decision_id = ?",
      )
      .get(id);
    expect(approvalRow?.actor_id).toBe(daemon.rootAgentId);
    expect(approvalRow?.message).toBe("lgtm");
  });

  it("mail_respond modify requires payloadOverride", () => {
    const { id } = seedDecision(daemon);
    const respond = tools.find((t) => t.name === "mail_respond")!;
    // execute() throws synchronously — wrap in a thunk so expect can catch it.
    expect(() => respond.execute({ id, vote: "modify" }, makeCtx(daemon))).toThrow(
      /payloadOverride/,
    );
  });

  it("mail_list is alwaysLoaded; mail_respond, mail_propose, mail_reply are deferred", () => {
    const list = tools.find((t) => t.name === "mail_list")!;
    const respond = tools.find((t) => t.name === "mail_respond")!;
    const propose = tools.find((t) => t.name === "mail_propose")!;
    const reply = tools.find((t) => t.name === "mail_reply")!;
    expect(list.alwaysLoaded).toBe(true);
    expect(respond.alwaysLoaded).toBeFalsy();
    expect(propose.alwaysLoaded).toBeFalsy();
    expect(reply.alwaysLoaded).toBeFalsy();
  });

  it("mail_reply appends a message and stamps actorId from ctx", async () => {
    const { id } = seedDecision(daemon);
    // Approve first so the agent has something to reply to (semantically
    // typical, though reply works on any decision regardless of status).
    daemon.inbox.respond({ decisionId: id, actorId: daemon.rootPrincipalId, vote: "approve" });
    const reply = tools.find((t) => t.name === "mail_reply")!;
    const result = (await reply.execute(
      { decisionId: id, text: "done — see commit abc" },
      makeCtx(daemon),
    )) as { id: string; text: string; actorId: string; decisionId: string };
    expect(result.text).toBe("done — see commit abc");
    expect(result.actorId).toBe(daemon.rootAgentId);
    expect(result.decisionId).toBe(id);
    const messages = daemon.inbox.listMessages(id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe("done — see commit abc");
  });

  it("mail_reply accepts an id prefix", async () => {
    const { id } = seedDecision(daemon);
    const reply = tools.find((t) => t.name === "mail_reply")!;
    const result = (await reply.execute(
      { decisionId: id.slice(0, 10), text: "hi" },
      makeCtx(daemon),
    )) as { decisionId: string };
    expect(result.decisionId).toBe(id);
  });

  it("mail_reply rejects callers who did not propose the decision", () => {
    const childId = ulid();
    daemon.store
      .insert(tables.agents)
      .values({
        id: childId,
        name: "child",
        hostId: daemon.hostId,
        parentAgentId: daemon.rootAgentId,
        scope: {},
        createdAt: Date.now(),
      })
      .run();
    const { id } = daemon.inbox.propose({
      principalId: daemon.rootPrincipalId,
      proposingAgentId: childId,
      tier: "strategic",
      summary: "child ask",
      payload: {},
    });
    const reply = tools.find((t) => t.name === "mail_reply")!;
    expect(() => reply.execute({ decisionId: id, text: "done" }, makeCtx(daemon))).toThrow(
      /only the proposing agent/,
    );
    expect(daemon.inbox.listMessages(id)).toHaveLength(0);
  });

  it("mail_reply errors when the decision id resolves to nothing", () => {
    const reply = tools.find((t) => t.name === "mail_reply")!;
    expect(() => reply.execute({ decisionId: "no-such", text: "x" }, makeCtx(daemon))).toThrow(
      /not found/,
    );
  });

  it("mail_propose is omitted when bus / hostId / store aren't all present", () => {
    const partial = buildInboxTools({ inbox: daemon.inbox, principalId: daemon.rootPrincipalId });
    expect(partial.find((t) => t.name === "mail_propose")).toBeUndefined();
  });
});

describe("mail_list direction filter", () => {
  // 'in' (default) returns proposals addressed to the principal — what the
  // tool's owner would vote on. 'out' returns proposals the caller (per
  // ctx.actorId) authored — so a proposer can check whether their own
  // asks have been resolved without inventing a new tool. 'both' merges
  // and dedupes by id.

  function rootSeedDecision(d: Daemon, summary = "in-row"): { id: string } {
    return d.inbox.propose({
      principalId: d.rootPrincipalId,
      proposingAgentId: d.rootAgentId,
      tier: "strategic",
      summary,
      payload: {},
    });
  }

  it("'in' (default) matches existing behavior", async () => {
    rootSeedDecision(daemon, "alpha");
    const list = tools.find((t) => t.name === "mail_list")!;
    const rows = (await list.execute({}, makeCtx(daemon))) as Decision[];
    expect(rows.map((r) => r.summary)).toEqual(["alpha"]);
  });

  it("'out' returns decisions where ctx.actorId is the proposer, scoped to open by default", async () => {
    // Seed a child agent and have it propose; verify mail_list({direction:'out'})
    // returns only the child's open proposals when called with the child's actorId.
    const childId = ulid();
    daemon.store
      .insert(tables.agents)
      .values({
        id: childId,
        name: "child",
        hostId: daemon.hostId,
        parentAgentId: daemon.rootAgentId,
        scope: {},
        createdAt: Date.now(),
      })
      .run();
    const open = daemon.inbox.propose({
      principalId: daemon.rootPrincipalId,
      proposingAgentId: childId,
      tier: "strategic",
      summary: "child-open",
      payload: {},
    });
    const resolved = daemon.inbox.propose({
      principalId: daemon.rootPrincipalId,
      proposingAgentId: childId,
      tier: "strategic",
      summary: "child-resolved",
      payload: {},
    });
    daemon.inbox.respond({ decisionId: resolved.id, actorId: daemon.rootAgentId, vote: "approve" });
    // Also seed a proposal by root that should NOT show up in child's 'out'.
    rootSeedDecision(daemon, "root-only");

    const list = tools.find((t) => t.name === "mail_list")!;
    const childCtx = { ...makeCtx(daemon), actorId: childId };
    const openRows = (await list.execute({ direction: "out" }, childCtx)) as Decision[];
    expect(openRows.map((r) => r.summary)).toEqual(["child-open"]);
    expect(openRows.every((r) => r.id !== open.id ? false : true)).toBe(true);

    const allRows = (await list.execute(
      { direction: "out", includeResolved: true },
      childCtx,
    )) as Decision[];
    expect(allRows.map((r) => r.summary).sort()).toEqual(["child-open", "child-resolved"].sort());
  });

  it("'both' unions in+out and dedupes by id", async () => {
    // Root proposes; the row is BOTH addressed to root's principal AND
    // proposed by root. 'both' must surface it once.
    rootSeedDecision(daemon, "shared");
    const list = tools.find((t) => t.name === "mail_list")!;
    const rows = (await list.execute({ direction: "both" }, makeCtx(daemon))) as Decision[];
    expect(rows.map((r) => r.summary)).toEqual(["shared"]);
  });
});

describe("mail_propose tool", () => {
  // Wraps askUp from ctx.actorId. Behavior matches the existing askUp tests
  // (LOG 2026-04-26): auto-resolve at the first ancestor with delegated
  // tier; queue at principal otherwise.

  function makeChild(d: Daemon, allowTiers: Array<"operational" | "strategic" | "vision"> = []): string {
    const id = ulid();
    d.store
      .insert(tables.agents)
      .values({
        id,
        name: "child",
        hostId: d.hostId,
        parentAgentId: d.rootAgentId,
        scope: { allowTiers },
        createdAt: Date.now(),
      })
      .run();
    return id;
  }

  it("auto-approves when an ancestor has the tier in delegated authority", async () => {
    // Give root delegated 'strategic'; child proposes strategic; askUp
    // resolves at root without touching the principal's inbox.
    daemon.store
      .update(tables.agents)
      .set({ scope: { allowTiers: ["strategic"] } })
      .where(eq(tables.agents.id, daemon.rootAgentId))
      .run();
    const child = makeChild(daemon);
    const propose = tools.find((t) => t.name === "mail_propose")!;

    const before = daemon.inbox.listOpen(daemon.rootPrincipalId).length;
    const result = (await propose.execute(
      { summary: "ranged refactor", payload: { action: "test" } },
      { ...makeCtx(daemon), actorId: child },
    )) as AskUpResult;
    expect(result.kind).toBe("auto-approved");
    expect(result.approverAgentId).toBe(daemon.rootAgentId);
    expect(daemon.inbox.listOpen(daemon.rootPrincipalId).length).toBe(before);
  });

  it("queues to the principal when no ancestor has authority", async () => {
    const child = makeChild(daemon, []);
    const propose = tools.find((t) => t.name === "mail_propose")!;

    const before = daemon.inbox.listOpen(daemon.rootPrincipalId).length;
    const result = (await propose.execute(
      {
        summary: "rewire mission",
        payload: { action: "raise_budget", amount: 50 },
        tier: "vision",
        stalenessMs: 60_000,
      },
      { ...makeCtx(daemon), actorId: child },
    )) as AskUpResult;
    expect(result.kind).toBe("queued");
    expect(result.decisionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const after = daemon.inbox.listOpen(daemon.rootPrincipalId);
    expect(after.length).toBe(before + 1);
    const row = after.find((r) => r.id === result.decisionId)!;
    expect(row.summary).toBe("rewire mission");
    expect(row.proposingAgentId).toBe(child);
    expect(row.tier).toBe("vision");
    expect(row.payload).toEqual({ action: "raise_budget", amount: 50 });
  });

  it("default tier is 'strategic' and default payload is empty object", async () => {
    // Root's default scope is ["operational","strategic"], so a strategic
    // proposal would auto-approve at root and never queue. Read the tier
    // back off the auto-approved event payload — same code path that would
    // fire if the proposal queued, just at a different ancestor.
    const child = makeChild(daemon, []);
    const propose = tools.find((t) => t.name === "mail_propose")!;

    const seen: Array<{ tier: string; payload: unknown }> = [];
    const unsub = daemon.bus.subscribe("decision.auto-approved", (ev) => {
      const p = ev.payload as { tier: string; payload: unknown };
      seen.push({ tier: p.tier, payload: p.payload });
    });
    const result = (await propose.execute(
      { summary: "plain ask" },
      { ...makeCtx(daemon), actorId: child },
    )) as AskUpResult;
    unsub();
    expect(result.kind).toBe("auto-approved");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.tier).toBe("strategic");
    expect(seen[0]!.payload).toEqual({});
  });
});


function makeCtx(d: Daemon) {
  return {
    hostId: d.hostId,
    extensionId: "core",
    actorId: d.rootAgentId,
    abort: new AbortController().signal,
    secrets: {},
  };
}
