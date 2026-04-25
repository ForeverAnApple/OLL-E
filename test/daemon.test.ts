import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/daemon/daemon.ts";
import { connectIpc, type IpcClient } from "../src/ipc/index.ts";

let daemon: Daemon;
let client: IpcClient;
let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "olle-test-"));
  daemon = await startDaemon({ root: tmp, version: "test", quiet: true });
  client = await connectIpc(daemon.paths.socketFile);
});

afterEach(async () => {
  client.close();
  await daemon.shutdown();
  rmSync(tmp, { recursive: true, force: true });
});

describe("daemon + ipc", () => {
  it("reports version", async () => {
    const v = await client.call<string>("version");
    expect(v).toBe("test");
  });

  it("reports status with host id and pid", async () => {
    const s = await client.call<{ hostId: string; pid: number; uptimeMs: number }>("status");
    expect(s.hostId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(s.pid).toBe(process.pid);
    expect(s.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("publish round-trips into the event store", async () => {
    const res = await client.call<{ id: string; hlc: string }>("publish", {
      type: "cli.hello",
      payload: { msg: "hi" },
      actorId: "cli",
      durable: true,
    });
    expect(res.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    // event lands in the table
    const rows = daemon.store.raw
      .query<{ type: string }, [string]>("SELECT type FROM events WHERE id = ?")
      .all(res.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("cli.hello");
  });

  it("tail stream delivers subsequently published events", async () => {
    const sub = client.stream("tail", { type: "demo" });
    const received: string[] = [];
    const collector = (async () => {
      for await (const ev of sub.events) {
        received.push(ev.type);
        if (received.length === 2) break;
      }
    })();

    // Wait a tick so the subscribe request lands before we publish.
    await new Promise((r) => setTimeout(r, 20));
    await client.call("publish", { type: "demo", payload: { n: 1 }, actorId: "cli" });
    await client.call("publish", { type: "demo", payload: { n: 2 }, actorId: "cli" });

    await collector;
    expect(received).toEqual(["demo", "demo"]);
    await sub.cancel();
  });

  it("refuses to start a second daemon on the same root", async () => {
    await expect(startDaemon({ root: tmp, quiet: true })).rejects.toThrow(/already running/);
  });

  it("observability.usage returns shaped data even with an empty ledger", async () => {
    const stats = await client.call<{ totals: { inputTokens: number }; rows: number }>(
      "observability.usage",
    );
    expect(stats.rows).toBe(0);
    expect(stats.totals.inputTokens).toBe(0);
  });

  it("observability.self surfaces the root agent's identity", async () => {
    const self = await client.call<{
      agentId: string;
      name: string;
      principleCount: number;
    } | null>("observability.self", { agentId: daemon.rootAgentId });
    expect(self).not.toBeNull();
    expect(self!.name).toBe("root");
    expect(self!.agentId).toBe(daemon.rootAgentId);
  });

  it("observability.events round-trips a published event", async () => {
    await client.call("publish", {
      type: "obs.test",
      payload: { n: 1 },
      actorId: "cli",
      durable: true,
    });
    const events = await client.call<Array<{ type: string }>>("observability.events", {
      type: "obs.test",
      limit: 5,
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.type).toBe("obs.test");
  });
});
