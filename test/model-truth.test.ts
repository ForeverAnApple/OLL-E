// Model display truth — every read surface (`model.get`, `observability.self`)
// reports the model the next NEW thread will actually run: the agent's chosen
// thinking-model memory clamped to the live backend, else the backend's own
// default. Regression for the statusbar bug where an OpenAI-only or CLI-brain
// host displayed the hardcoded Anthropic default while turns ran elsewhere.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/daemon/daemon.ts";
import { connectIpc } from "../src/ipc/index.ts";
import { ANTHROPIC_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL } from "../src/llm/index.ts";
import { MEMORY_WROTE } from "../src/memory/index.ts";
import type { AgentSelf } from "../src/observability/index.ts";
import { reducer, type ChatState } from "../src/cli/chat-ink/app.tsx";
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

function mockCliBrain(): CliBrain & { calls: CliTurnRequest[] } {
  const calls: CliTurnRequest[] = [];
  return {
    provider: "mock-cli",
    defaultModel: "mock-cli-model",
    calls,
    async probe(): Promise<CliProbeResult> {
      return { status: "ready" };
    },
    async runTurn(req: CliTurnRequest): Promise<CliTurnResult> {
      calls.push(req);
      return { text: "ok", usage: mockUsage(), stopReason: "end_turn" };
    },
  };
}

/** Write the root agent's thinking-model memory the same way
 *  set_thinking_model does (via the memory projector). */
async function writeThinkingModelMemory(daemon: Daemon, model: string): Promise<void> {
  daemon.bus.publish({
    type: MEMORY_WROTE,
    hostId: daemon.hostId,
    actorId: daemon.rootAgentId,
    durable: true,
    payload: {
      id: "01TESTTHINKINGMODEL0000000",
      actorId: daemon.rootAgentId,
      scope: "private",
      scopeRef: daemon.rootAgentId,
      role: "thinking-model",
      title: "thinking-model",
      bodyMd: `${model}\n\ntest fixture`,
      tags: ["thinking-model"],
      depth: 1,
      authoredBy: null,
      seededFrom: null,
    },
  });
  // Let the projector materialize the row.
  await new Promise((r) => setTimeout(r, 30));
}

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
      threadId: "t-model-truth",
      payload: { text },
    });
  });
}

let tmp: string;
let daemon: Daemon | undefined;
let savedAnthropic: string | undefined;
let savedOpenai: string | undefined;
let savedOlleModel: string | undefined;

beforeEach(() => {
  savedAnthropic = process.env.ANTHROPIC_API_KEY;
  savedOpenai = process.env.OPENAI_API_KEY;
  savedOlleModel = process.env.OLLE_MODEL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OLLE_MODEL;
  tmp = mkdtempSync(join(tmpdir(), "olle-model-truth-"));
});

afterEach(async () => {
  if (daemon) await daemon.shutdown();
  daemon = undefined;
  rmSync(tmp, { recursive: true, force: true });
  if (savedAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropic;
  if (savedOpenai !== undefined) process.env.OPENAI_API_KEY = savedOpenai;
  if (savedOlleModel !== undefined) process.env.OLLE_MODEL = savedOlleModel;
});

/** Seed an API key into the temp root's secrets store (the ladder's first
 *  rung) rather than process.env — env writes leak across test files in a
 *  parallel run and would poison the live smoke test with a fake key. */
function seedSecret(name: string, value: string): void {
  const dir = join(tmp, "secrets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, name), value, { mode: 0o600 });
}

async function bootOpenAiOnly(): Promise<Daemon> {
  seedSecret("OPENAI_API_KEY", "sk-fake-openai");
  return startDaemon({ root: tmp, version: "test", quiet: true, enableMesh: false });
}

describe("model truth — OpenAI-only API mode", () => {
  it("model.get and observability.self report the OpenAI boot model, never the Anthropic default", async () => {
    daemon = await bootOpenAiOnly();
    const client = await connectIpc(daemon.paths.socketFile);
    try {
      const got = await client.call<{ model: string }>("model.get");
      expect(got.model).toBe(OPENAI_DEFAULT_MODEL);

      const self = await client.call<AgentSelf>("observability.self", {
        agentId: daemon.rootAgentId,
      });
      expect(self.thinkingModel).toBe(OPENAI_DEFAULT_MODEL);
      expect(self.thinkingModelIsDefault).toBe(true);
    } finally {
      client.close();
    }
  });

  it("clamps a thinking-model memory naming a model no loaded adapter serves", async () => {
    daemon = await bootOpenAiOnly();
    // Anthropic model chosen while only the OpenAI adapter is loaded — the
    // chat loop can't run it (router.complete throws), so no surface may
    // display it as if it ran.
    await writeThinkingModelMemory(daemon, "claude-opus-4-8");
    const client = await connectIpc(daemon.paths.socketFile);
    try {
      const got = await client.call<{ model: string }>("model.get");
      expect(got.model).toBe(OPENAI_DEFAULT_MODEL);

      const self = await client.call<AgentSelf>("observability.self", {
        agentId: daemon.rootAgentId,
      });
      expect(self.thinkingModel).toBe(OPENAI_DEFAULT_MODEL);
      expect(self.thinkingModelIsDefault).toBe(true);
    } finally {
      client.close();
    }
  });
});

describe("model truth — Anthropic API mode", () => {
  it("honors a thinking-model memory whose provider IS served", async () => {
    seedSecret("ANTHROPIC_API_KEY", "sk-fake-anthropic");
    daemon = await startDaemon({ root: tmp, version: "test", quiet: true, enableMesh: false });
    await writeThinkingModelMemory(daemon, "claude-opus-4-8");
    const client = await connectIpc(daemon.paths.socketFile);
    try {
      const got = await client.call<{ model: string }>("model.get");
      expect(got.model).toBe("claude-opus-4-8");

      const self = await client.call<AgentSelf>("observability.self", {
        agentId: daemon.rootAgentId,
      });
      expect(self.thinkingModel).toBe("claude-opus-4-8");
      expect(self.thinkingModelIsDefault).toBe(false);
    } finally {
      client.close();
    }
  });

  it("without a memory, reports the router default (the Anthropic boot model)", async () => {
    seedSecret("ANTHROPIC_API_KEY", "sk-fake-anthropic");
    daemon = await startDaemon({ root: tmp, version: "test", quiet: true, enableMesh: false });
    const client = await connectIpc(daemon.paths.socketFile);
    try {
      const got = await client.call<{ model: string }>("model.get");
      expect(got.model).toBe(ANTHROPIC_DEFAULT_MODEL);
    } finally {
      client.close();
    }
  });
});

describe("model truth — CLI-brain mode", () => {
  it("model.get and observability.self report the CLI brain's model, not the Anthropic default", async () => {
    const brain = mockCliBrain();
    daemon = await startDaemon({
      root: tmp,
      version: "test",
      quiet: true,
      enableMesh: false,
      cliBrainOverride: brain,
    });
    const client = await connectIpc(daemon.paths.socketFile);
    try {
      const got = await client.call<{ model: string }>("model.get");
      expect(got.model).toBe("mock-cli-model");

      const self = await client.call<AgentSelf>("observability.self", {
        agentId: daemon.rootAgentId,
      });
      expect(self.thinkingModel).toBe("mock-cli-model");
      expect(self.thinkingModelIsDefault).toBe(true);
    } finally {
      client.close();
    }
  });

  it("a thinking-model memory passes through to the harness and turn-end reports it", async () => {
    const brain = mockCliBrain();
    daemon = await startDaemon({
      root: tmp,
      version: "test",
      quiet: true,
      enableMesh: false,
      cliBrainOverride: brain,
    });
    // In CLI mode the chosen model is handed to the harness (`--model`), so
    // it IS what runs — display and delegation agree.
    await writeThinkingModelMemory(daemon, "claude-opus-4-8");
    const client = await connectIpc(daemon.paths.socketFile);
    try {
      const got = await client.call<{ model: string }>("model.get");
      expect(got.model).toBe("claude-opus-4-8");

      let turnEndModel: string | undefined;
      const unsub = daemon.bus.subscribe<{ model?: string }>("chat.turn-end", (ev) => {
        turnEndModel = ev.payload?.model;
      });
      await driveTurn(daemon, "hello");
      unsub();
      expect(brain.calls[0]?.model).toBe("claude-opus-4-8");
      expect(turnEndModel).toBe("claude-opus-4-8");
    } finally {
      client.close();
    }
  });
});

describe("statusbar reducer — model tracks turn-end", () => {
  const base: ChatState = {
    scrollback: [],
    streaming: "",
    thinking: "",
    thinkingStartedAt: null,
    turnBusy: true,
    cancelling: false,
    threadId: "t",
    model: "stale-model",
    inboxOpen: 0,
    tray: [],
    totalUsdMicros: 0,
    contextTokens: 0,
  };

  it("adopts the model the turn was actually billed on", () => {
    const next = reducer(base, {
      type: "turn-end",
      model: "gpt-5.5",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      usdMicros: 0,
      stopReason: "end_turn",
    });
    expect(next.model).toBe("gpt-5.5");
  });

  it("keeps the current display when turn-end carries no model", () => {
    const next = reducer(base, {
      type: "turn-end",
      model: "",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      usdMicros: 0,
      stopReason: "end_turn",
    });
    expect(next.model).toBe("stale-model");
  });
});
