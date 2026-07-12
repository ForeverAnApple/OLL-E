// CLI-brain integration — the wiring that lets a logged-in coding-agent CLI
// back the chat loop when no API key is present. No real CLIs are spawned:
// a mock CliBrain (probe→ready, runTurn→canned) is injected through the
// daemon's `cliBrainOverride` seam, and the tool-dispatch surface is tested
// directly against a stub tool.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import { startDaemon, type Daemon } from "../src/daemon/daemon.ts";
import { createToolDispatch } from "../src/mcp/dispatch.ts";
import type { CliBrain, CliProbeResult, CliTurnRequest, CliTurnResult } from "../src/llm/cli-brain/types.ts";
import type { ToolDef } from "../src/extensions/index.ts";

function mockUsage() {
  return {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 15,
  };
}

/** A CliBrain that never spawns a process: probe reports ready, runTurn
 *  records what it was handed and returns a canned assistant text. */
function mockCliBrain(): CliBrain & { calls: CliTurnRequest[] } {
  const calls: CliTurnRequest[] = [];
  return {
    provider: "mock-cli",
    defaultModel: "mock-cli-model",
    calls,
    async probe(): Promise<CliProbeResult> {
      return { status: "ready", version: "mock 1.0" };
    },
    async runTurn(req: CliTurnRequest): Promise<CliTurnResult> {
      calls.push(req);
      return {
        text: "delegated hello",
        usage: mockUsage(),
        sessionId: "sess-1",
        stopReason: "end_turn",
      };
    },
  };
}

/** A CliBrain that returns a scripted result per turn (last entry repeats),
 *  recording every request for assertions. */
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

describe("CLI-brain detection ladder + whole-turn delegation", () => {
  let tmp: string;
  let daemon: Daemon;
  let savedAnthropic: string | undefined;
  let savedOpenai: string | undefined;

  beforeEach(() => {
    // Force the ladder past API mode — no secret file (fresh tmp root) and no
    // env key. Save/restore so we don't clobber the runner's environment.
    savedAnthropic = process.env.ANTHROPIC_API_KEY;
    savedOpenai = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    tmp = mkdtempSync(join(tmpdir(), "olle-clibrain-"));
  });

  afterEach(async () => {
    if (daemon) await daemon.shutdown();
    rmSync(tmp, { recursive: true, force: true });
    if (savedAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropic;
    if (savedOpenai !== undefined) process.env.OPENAI_API_KEY = savedOpenai;
  });

  it("picks the injected CLI brain when no API key is present, and a turn delegates + records $0", async () => {
    const brain = mockCliBrain();
    daemon = await startDaemon({
      root: tmp,
      version: "test",
      quiet: true,
      enableMesh: false,
      cliBrainOverride: brain,
    });

    // (a) Ladder selected the CLI brain — chat is up in CLI mode.
    expect(daemon.chatAgentId).toBe(daemon.rootAgentId);

    // (b) A turn through the CLI branch delegates, emits turn-end, records $0.
    const seen: string[] = [];
    daemon.bus.subscribe("chat.assistant-text", () => void seen.push("assistant-text"));
    const turnEnd = new Promise<Record<string, unknown>>((resolve) => {
      daemon.bus.subscribe("chat.turn-end", (e) => resolve(e.payload as Record<string, unknown>));
    });

    daemon.bus.publish({
      type: "chat.input",
      hostId: daemon.hostId,
      actorId: "cli",
      durable: true,
      toAgentId: daemon.rootAgentId,
      threadId: "t1",
      payload: { text: "hi" },
    });

    const endPayload = await turnEnd;
    expect(seen).toContain("assistant-text");
    // Delegation actually ran and was handed a composed system + our prompt.
    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0]!.prompt).toBe("hi");
    expect(typeof brain.calls[0]!.system).toBe("string");
    // Bridge argv addresses this agent + thread.
    expect(brain.calls[0]!.bridge.args).toContain("mcp-bridge");
    expect(brain.calls[0]!.bridge.args).toContain("t1");
    // turn-end priced at $0 (subscription physics).
    expect(endPayload.usdMicros).toBe(0);

    // Ledger row written under the *-cli provider, priced $0.
    const rows = daemon.store
      .select()
      .from(tables.ledger)
      .all()
      .filter((r) => r.threadId === "t1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe("mock-cli");
    expect(rows[0]!.inputTokens).toBe(10);
    // Budget accrued $0 for the CLI provider.
    const budgets = daemon.store.select().from(tables.budgets).all();
    for (const b of budgets) expect(b.spentUsd).toBe(0);
  });

  it("drops a dead session id after an errored resume turn (next turn is fresh)", async () => {
    // Turn 1 establishes a session; turn 2 resumes it and errors (non-transient);
    // the fix clears the dead session id so turn 3 opens fresh with the
    // transcript instead of retrying the wedged --resume id forever.
    const brain = scriptedCliBrain([
      { text: "one", sessionId: "sess-1" },
      { error: { code: "unknown", message: "boom" } },
      { text: "three", sessionId: "sess-2" },
    ]);
    daemon = await startDaemon({
      root: tmp,
      version: "test",
      quiet: true,
      enableMesh: false,
      cliBrainOverride: brain,
    });

    // Drive one turn on thread t1 and wait for it to settle (turn-end on
    // success, chat.error on the failing turn).
    const runTurn = async (text: string) => {
      await new Promise<void>((resolve) => {
        const done = () => {
          unsubEnd();
          unsubErr();
          // Let the drain worker fully clear before the next publish. turn-end
          // fires from inside the running turn; publishing the next chat.input
          // in the immediate microtask would race the worker slot and orphan it
          // (real callers space messages by human/network time).
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
    };

    await runTurn("first");
    await runTurn("second");
    await runTurn("third");

    expect(brain.calls).toHaveLength(3);
    expect(brain.calls[0]!.resumeSessionId).toBeUndefined(); // fresh
    expect(brain.calls[1]!.resumeSessionId).toBe("sess-1"); // resumes turn 1's session
    expect(brain.calls[2]!.resumeSessionId).toBeUndefined(); // dead session dropped
  });
});

describe("createToolDispatch — gate + audit events", () => {
  function rig() {
    const store = openStore({ path: ":memory:" });
    const hostId = ulid();
    store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
    const bus = createBus({ hostId, persist: persistToStore(store) });
    return { store, bus, hostId };
  }

  function seedAgent(store: ReturnType<typeof openStore>, hostId: string, scope: unknown): string {
    const id = ulid();
    store
      .insert(tables.agents)
      .values({ id, name: "a", hostId, scope: scope as never, createdAt: Date.now() })
      .run();
    return id;
  }

  it("runs a permitted tool through the gate and emits tool-call + tool-result", async () => {
    const { store, bus, hostId } = rig();
    const agentId = seedAgent(store, hostId, {});
    const echo: ToolDef = {
      name: "echo",
      description: "echoes input",
      inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
      execute: (args) => `echo:${(args as { msg: string }).msg}`,
    };
    const dispatch = createToolDispatch({
      bus,
      store,
      hostId,
      coreTools: () => [echo],
    });

    const events: string[] = [];
    bus.subscribe("chat.tool-call", () => void events.push("tool-call"));
    bus.subscribe("chat.tool-result", () => void events.push("tool-result"));

    const specs = await dispatch.list(agentId);
    expect(specs.map((s) => s.name)).toContain("echo");

    const res = await dispatch.call({
      agentId,
      threadId: "t1",
      name: "echo",
      input: { msg: "hello" },
    });
    expect(res.isError).toBe(false);
    expect(res.content).toBe("echo:hello");
    expect(events).toEqual(["tool-call", "tool-result"]);
  });

  it("denies a tool the agent's scope forbids and emits tool.denied", async () => {
    const { store, bus, hostId } = rig();
    // Agent may only call operational tools.
    const agentId = seedAgent(store, hostId, { allowTiers: ["operational"] });
    const danger: ToolDef = {
      name: "danger",
      description: "strategic tool",
      tier: "strategic",
      inputSchema: { type: "object" },
      execute: () => "ran",
    };
    const dispatch = createToolDispatch({ bus, store, hostId, coreTools: () => [danger] });

    let denied = false;
    let ran = false;
    bus.subscribe("tool.denied", () => void (denied = true));
    bus.subscribe("chat.tool-call", () => void (ran = true));

    const res = await dispatch.call({ agentId, threadId: "t1", name: "danger", input: {} });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("permission denied");
    expect(denied).toBe(true);
    // Denied before the tool-call audit event — no execution attempted.
    expect(ran).toBe(false);
  });

  it("returns a legible error for an unknown tool", async () => {
    const { store, bus, hostId } = rig();
    const agentId = seedAgent(store, hostId, {});
    const dispatch = createToolDispatch({ bus, store, hostId, coreTools: () => [] });
    const res = await dispatch.call({ agentId, threadId: "t1", name: "nope", input: {} });
    expect(res.isError).toBe(true);
    expect(res.content).toBe("unknown tool: nope");
  });

  it("rejects an unknown agentId without executing or emitting audit events", async () => {
    // loadAgentScope returns {} for a missing row, and {} means UNRESTRICTED —
    // so a caller-asserted bogus agentId would otherwise run any tier ungated.
    const { store, bus, hostId } = rig();
    let ran = false;
    const danger: ToolDef = {
      name: "write_extension",
      description: "vision-tier tool",
      tier: "vision",
      inputSchema: { type: "object" },
      execute: () => {
        ran = true;
        return "ran";
      },
    };
    const dispatch = createToolDispatch({ bus, store, hostId, coreTools: () => [danger] });

    let toolCall = false;
    let denied = false;
    bus.subscribe("chat.tool-call", () => void (toolCall = true));
    bus.subscribe("tool.denied", () => void (denied = true));

    const res = await dispatch.call({
      agentId: "made-up-agent",
      threadId: "t1",
      name: "write_extension",
      input: {},
    });
    expect(res.isError).toBe(true);
    expect(res.content).toBe("unknown agent: made-up-agent");
    // No execution, no tool-call audit event, no denial event — terminal early.
    expect(ran).toBe(false);
    expect(toolCall).toBe(false);
    expect(denied).toBe(false);

    // And list() returns [] for an unknown agent rather than the full catalog.
    expect(await dispatch.list("made-up-agent")).toEqual([]);
  });
});
