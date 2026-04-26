// Live smoke test — boots the daemon end-to-end and sends one real
// chat round-trip through the Anthropic adapter. Catches anything the
// wire rejects: tool-name collisions, schema-shape problems, prompt
// segments the provider doesn't accept, etc.
//
// Skipped automatically without ANTHROPIC_API_KEY so CI without secrets
// stays green; required to pass in any environment that has the key.
// Pinned to Haiku + a tiny maxTokens so a run costs fractions of a cent.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/daemon/daemon.ts";
import { connectIpc, type IpcClient } from "../src/ipc/index.ts";
import { ulid } from "../src/id/index.ts";

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;
const describeLive = HAS_KEY ? describe : describe.skip;

let daemon: Daemon;
let client: IpcClient;
let tmp: string;

beforeAll(async () => {
  if (!HAS_KEY) return;
  tmp = mkdtempSync(join(tmpdir(), "olle-smoke-"));
  // Smaller max tokens via env so the haiku call is fast & cheap.
  process.env.OLLE_SMOKE = "1";
  daemon = await startDaemon({ root: tmp, version: "smoke", quiet: true });
  client = await connectIpc(daemon.paths.socketFile);
});

afterAll(async () => {
  if (!HAS_KEY) return;
  client.close();
  await daemon.shutdown();
  rmSync(tmp, { recursive: true, force: true });
});

describeLive("live smoke — daemon + chat round-trip via Anthropic", () => {
  it("starts the chat agent (boot invariants pass)", () => {
    expect(daemon.chat).toBeDefined();
    expect(daemon.chatAgentId).toBe(daemon.rootAgentId);
  });

  it("completes one chat turn without chat.error", async () => {
    const threadId = ulid();
    const errors: Array<{ error?: string }> = [];
    const errSub = client.stream("tail", { type: "chat.error" });
    const errCollector = (async () => {
      for await (const ev of errSub.events) {
        errors.push(ev.payload as { error?: string });
      }
    })();

    const turnEnd = client.stream("tail", { type: "chat.turn-end" });
    const turnEnded = (async () => {
      for await (const ev of turnEnd.events) {
        if (ev.threadId === threadId) return ev;
      }
      return undefined;
    })();

    // Let the subscribes register before publishing.
    await new Promise((r) => setTimeout(r, 30));

    await client.call("publish", {
      type: "chat.input",
      payload: { text: "ping" },
      actorId: "smoke",
      durable: true,
      toAgentId: daemon.rootAgentId,
      threadId,
    });

    const completed = await Promise.race([
      turnEnded,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("chat turn timed out (60s)")), 60_000),
      ),
    ]);

    expect(completed).toBeDefined();
    expect(errors).toEqual([]);

    await errSub.cancel();
    await turnEnd.cancel();
    await errCollector.catch(() => {});
  }, 70_000);
});
