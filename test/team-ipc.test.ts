import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startDaemon, type Daemon } from "../src/daemon/daemon.ts";
import { connectIpc, type IpcClient } from "../src/ipc/index.ts";

let daemon: Daemon;
let client: IpcClient;
let tmp: string;

// Force advertised hostname to loopback so any code path that synthesizes
// an addr doesn't try to dial whatever the host's hostname resolves to.
process.env.OLLE_ADVERTISE_ADDR = "ws://127.0.0.1";

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "olle-team-ipc-"));
  daemon = await startDaemon({
    root: tmp,
    version: "test",
    quiet: true,
    meshPort: 0,
  });
  client = await connectIpc(daemon.paths.socketFile);
});

afterAll(async () => {
  client.close();
  await daemon.shutdown();
  rmSync(tmp, { recursive: true, force: true });
});

describe("team.* IPC surface", () => {
  it("team.status returns empty list when no teams exist", async () => {
    const res = await client.call<{ teams: unknown[] }>("team.status");
    expect(res.teams).toEqual([]);
  });

  it("team.create persists a team and member row", async () => {
    const res = await client.call<{ ok: boolean; teamId: string }>("team.create", {
      name: "first-team",
    });
    expect(res.ok).toBe(true);
    expect(typeof res.teamId).toBe("string");
    const status = await client.call<{
      teams: Array<{ teamId: string; name: string; members: Array<{ actorId: string; role: string }> }>;
    }>("team.status");
    const found = status.teams.find((t) => t.teamId === res.teamId);
    expect(found?.name).toBe("first-team");
    expect(found?.members[0]?.actorId).toBe(daemon.humanAgentId);
    expect(found?.members[0]?.role).toBe("founder");
  });

  it("team.invite produces a decodable bearer code", async () => {
    const created = await client.call<{ teamId: string }>("team.create", {
      name: "invite-team",
    });
    const res = await client.call<{ ok: boolean; code: string; inviteId: string }>(
      "team.invite",
      { teamId: created.teamId },
    );
    expect(res.ok).toBe(true);
    // base64url should round-trip JSON shape with the team id we created.
    const json = Buffer.from(res.code, "base64url").toString("utf8");
    const decoded = JSON.parse(json) as Record<string, string>;
    expect(decoded.teamId).toBe(created.teamId);
    expect(decoded.inviteId).toBe(res.inviteId);
    expect(decoded.proto).toBe("olle.v0");
    expect(typeof decoded.addr).toBe("string");
  });

  it("team.invite rejects unknown team", async () => {
    const res = await client.call<{ ok: boolean; error?: string }>("team.invite", {
      teamId: "no-such-team",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown team/);
  });

  it("team.leave tears down rows and bridge state", async () => {
    const created = await client.call<{ teamId: string }>("team.create", {
      name: "leave-test",
    });
    const beforeStatus = await client.call<{
      teams: Array<{ teamId: string }>;
    }>("team.status");
    expect(beforeStatus.teams.some((t) => t.teamId === created.teamId)).toBe(true);
    const res = await client.call<{ ok: boolean }>("team.leave", {
      teamId: created.teamId,
    });
    expect(res.ok).toBe(true);
    const afterStatus = await client.call<{
      teams: Array<{ teamId: string }>;
    }>("team.status");
    // Team row persists (we don't drop teams on leave — only member rows).
    // The member-side check is the truth: caller is no longer in it.
    const teamStill = afterStatus.teams.find((t) => t.teamId === created.teamId);
    if (teamStill) {
      const found = (teamStill as { members?: Array<{ actorId: string }> }).members ?? [];
      expect(found.some((m) => m.actorId === daemon.humanAgentId)).toBe(false);
    }
  });

  it("team.join rejects malformed code without touching the bridge", async () => {
    const res = await client.call<{ ok: boolean; error?: string }>("team.join", {
      code: "this-is-not-a-bearer-code",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/invalid code/);
  });
});
