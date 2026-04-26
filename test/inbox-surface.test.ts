// Tests for the human-facing inbox surface (IPC + agent core tools).
//
// Two halves:
//   1. IPC roundtrip — `inbox.list` / `inbox.get` / `inbox.respond` /
//      `inbox.count` against a live daemon. Mirrors how `olle inbox` and
//      future channel adapters reach the inbox.
//   2. Tool surface — buildInboxTools() returning execute() that resolves
//      the same Inbox the IPC handlers use, so `mail_list`/`mail_respond`
//      see identical rows.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/daemon/daemon.ts";
import { connectIpc, type IpcClient } from "../src/ipc/index.ts";
import { buildInboxTools } from "../src/tools/inbox.ts";
import type { Decision } from "../src/store/schema.ts";

let daemon: Daemon;
let client: IpcClient;
let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "olle-inbox-surface-"));
  daemon = await startDaemon({ root: tmp, version: "test", quiet: true });
  client = await connectIpc(daemon.paths.socketFile);
});

afterEach(async () => {
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
    const open = await client.call<Decision[]>("inbox.list");
    const all = await client.call<Decision[]>("inbox.list", { status: "all" });
    expect(open).toHaveLength(1);
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === id)?.status).toBe("approved");
  });

  it("inbox.get returns full row; missing id errors", async () => {
    const { id } = seedDecision(daemon);
    const r = await client.call<Decision>("inbox.get", { id });
    expect(r.id).toBe(id);
    expect(r.payload).toEqual({ ext: "discord" });
    await expect(client.call("inbox.get", { id: "nope" })).rejects.toThrow(/not found/);
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
    const tools = buildInboxTools({ inbox: daemon.inbox, principalId: daemon.rootPrincipalId });
    const list = tools.find((t) => t.name === "mail_list")!;
    const ipcRows = await client.call<Decision[]>("inbox.list");
    const toolRows = (await list.execute({}, makeCtx(daemon))) as Decision[];
    expect(toolRows.map((r) => r.id).sort()).toEqual(ipcRows.map((r) => r.id).sort());
  });

  it("mail_list includeResolved=true matches inbox.list?status=all", async () => {
    const { id } = seedDecision(daemon);
    seedDecision(daemon, "still-open");
    await client.call("inbox.respond", { id, vote: "deny" });
    const tools = buildInboxTools({ inbox: daemon.inbox, principalId: daemon.rootPrincipalId });
    const list = tools.find((t) => t.name === "mail_list")!;
    const all = (await list.execute({ includeResolved: true }, makeCtx(daemon))) as Decision[];
    expect(all).toHaveLength(2);
    const open = (await list.execute({}, makeCtx(daemon))) as Decision[];
    expect(open).toHaveLength(1);
    expect(open[0]!.summary).toBe("still-open");
  });

  it("mail_respond resolves a decision and stamps actorId from ctx", async () => {
    const { id } = seedDecision(daemon);
    const tools = buildInboxTools({ inbox: daemon.inbox, principalId: daemon.rootPrincipalId });
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
    const tools = buildInboxTools({ inbox: daemon.inbox, principalId: daemon.rootPrincipalId });
    const respond = tools.find((t) => t.name === "mail_respond")!;
    // execute() throws synchronously — wrap in a thunk so expect can catch it.
    expect(() => respond.execute({ id, vote: "modify" }, makeCtx(daemon))).toThrow(
      /payloadOverride/,
    );
  });

  it("mail_list is alwaysLoaded; mail_respond is deferred", () => {
    const tools = buildInboxTools({ inbox: daemon.inbox, principalId: daemon.rootPrincipalId });
    const list = tools.find((t) => t.name === "mail_list")!;
    const respond = tools.find((t) => t.name === "mail_respond")!;
    expect(list.alwaysLoaded).toBe(true);
    expect(respond.alwaysLoaded).toBeFalsy();
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
