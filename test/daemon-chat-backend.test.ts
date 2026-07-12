// Daemon chat-backend state machine — the CLI-brain auth-loss keep-alive and
// the CLI→API upgrade guard. No real CLIs are spawned: a mock CliBrain is
// injected through the daemon's `cliBrainOverride` seam (same pattern as
// cli-brain-integration.test.ts) so the in-process daemon exercises the state
// transitions without external processes.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/daemon/daemon.ts";
import { connectIpc } from "../src/ipc/index.ts";
import type {
  CliBrain,
  CliProbeResult,
  CliTurnRequest,
  CliTurnResult,
} from "../src/llm/cli-brain/types.ts";

function mockUsage() {
  return {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 15,
  };
}

/** A CliBrain that returns a scripted result per turn (last entry repeats). */
function scriptedCliBrain(
  results: Array<{ text?: string; sessionId?: string; error?: CliTurnResult["error"] }>,
): CliBrain & { calls: CliTurnRequest[] } {
  const calls: CliTurnRequest[] = [];
  let i = 0;
  return {
    provider: "mock-cli",
    defaultModel: "mock-cli-model",
    calls,
    async probe(): Promise<CliProbeResult> {
      return { status: "ready" };
    },
    async runTurn(req: CliTurnRequest): Promise<CliTurnResult> {
      calls.push(req);
      const r = results[Math.min(i, results.length - 1)]!;
      i++;
      return {
        text: r.text ?? "",
        usage: mockUsage(),
        stopReason: r.error ? "error" : "end_turn",
        ...(r.sessionId !== undefined && { sessionId: r.sessionId }),
        ...(r.error && { error: r.error }),
      };
    },
  };
}

/** Publish a chat.input and resolve once the turn settles (turn-end on
 *  success, chat.error on failure). Spaces the next publish by a tick so the
 *  drain worker clears — real callers space messages by human/network time. */
function driveTurn(daemon: Daemon, text: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      unsubEnd();
      unsubErr();
      setTimeout(resolve, 30);
    };
    const unsubEnd = daemon.bus.subscribe("chat.turn-end", done);
    const unsubErr = daemon.bus.subscribe("chat.error", done);
    daemon.bus.publish({
      type: "chat.input",
      hostId: daemon.hostId,
      actorId: "cli",
      durable: true,
      toAgentId: daemon.rootAgentId,
      threadId: "t1",
      payload: { text },
    });
  });
}

type ChatStatus = { enabled: boolean; reason: string | null };

describe("daemon chat-backend state machine (CLI-brain)", () => {
  let tmp: string;
  let daemon: Daemon;
  let savedAnthropic: string | undefined;
  let savedOpenai: string | undefined;

  beforeEach(() => {
    // Force the ladder past API mode — no secret file, no env key — so the
    // injected CLI brain backs the loop.
    savedAnthropic = process.env.ANTHROPIC_API_KEY;
    savedOpenai = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    tmp = mkdtempSync(join(tmpdir(), "olle-daemon-chat-"));
  });

  afterEach(async () => {
    if (daemon) await daemon.shutdown();
    rmSync(tmp, { recursive: true, force: true });
    if (savedAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropic;
    if (savedOpenai !== undefined) process.env.OPENAI_API_KEY = savedOpenai;
  });

  it("keeps chat enabled after a CLI auth-loss turn, then clears the flag on the next good turn", async () => {
    // Turn 1 reports auth loss; turn 2 (post re-login) succeeds.
    const brain = scriptedCliBrain([
      { error: { code: "auth_required", message: "logged out", loginHint: "run: claude login" } },
      { text: "back online", sessionId: "sess-1" },
    ]);
    daemon = await startDaemon({
      root: tmp,
      version: "test",
      quiet: true,
      enableMesh: false,
      cliBrainOverride: brain,
    });
    const client = await connectIpc(daemon.paths.socketFile);
    try {
      // CLI mode is up and enabled.
      let status = await client.call<ChatStatus>("status.chat");
      expect(status.enabled).toBe(true);

      // Turn 1 — the CLI backend went dark.
      await driveTurn(daemon, "hello");

      // Recovery-critical: chat STAYS enabled (the loop is up; a re-login makes
      // the next turn work). Disabling here would hard-exit `olle chat` — the
      // only surface that can send the recovering turn — deadlocking recovery.
      status = await client.call<ChatStatus>("status.chat");
      expect(status.enabled).toBe(true);
      expect(status.reason).toContain("needs login");

      // Turn 2 — a successful root turn clears the auth-lost flag.
      await driveTurn(daemon, "still there?");
      status = await client.call<ChatStatus>("status.chat");
      expect(status.enabled).toBe(true);
      expect(status.reason).toBeNull();
    } finally {
      client.close();
    }
  });

  it("does not tear down a working CLI loop when a CLI→API upgrade can't build (bad persisted model)", async () => {
    const brain = scriptedCliBrain([
      { text: "cli one", sessionId: "s1" },
      { text: "cli two", sessionId: "s2" },
    ]);
    daemon = await startDaemon({
      root: tmp,
      version: "test",
      quiet: true,
      enableMesh: false,
      cliBrainOverride: brain,
    });
    const client = await connectIpc(daemon.paths.socketFile);
    try {
      // Confirm we're serving via the CLI brain.
      await driveTurn(daemon, "first");
      expect(brain.calls.length).toBe(1);

      // Persist a garbage model (createRouterLlm will throw) and drop an API
      // key on disk, then fire the secret.set the upgrade path listens for.
      writeFileSync(daemon.paths.defaultModelFile, "not-a-real-model-x9", "utf8");
      writeFileSync(join(daemon.paths.secretsDir, "ANTHROPIC_API_KEY"), "sk-fake", "utf8");
      daemon.bus.publish({
        type: "secret.set",
        hostId: daemon.hostId,
        actorId: "cli",
        durable: true,
        payload: { name: "ANTHROPIC_API_KEY" },
      });
      // Let the async secret.set handler run its pre-flight.
      await new Promise((r) => setTimeout(r, 50));

      // The upgrade pre-flight failed, so the working CLI loop must NOT have
      // been torn down: chat stays enabled and another turn still routes
      // through the CLI brain.
      const status = await client.call<ChatStatus>("status.chat");
      expect(status.enabled).toBe(true);
      await driveTurn(daemon, "second");
      expect(brain.calls.length).toBe(2);
    } finally {
      client.close();
    }
  });
});
