import { describe, expect, it } from "bun:test";
import { runAgent } from "../src/agent/runtime.ts";
import type { Completion, CompletionRequest, Llm } from "../src/llm/types.ts";
import type { ToolDef } from "../src/extensions/types.ts";

function mockLlm(scripted: Completion[]): Llm {
  return {
    provider: "mock",
    defaultModel: "mock-1",
    async complete(_req: CompletionRequest): Promise<Completion> {
      const next = scripted.shift();
      if (!next) throw new Error("mockLlm: no scripted completion");
      return next;
    },
  };
}

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  totalTokens: 2,
};

function toolUse(id: string, name: string, input: Record<string, unknown>): Completion {
  return { content: [{ type: "tool_use", id, name, input }], stopReason: "tool_use", usage };
}
function endTurn(text: string): Completion {
  return { content: [{ type: "text", text }], stopReason: "end_turn", usage };
}

// Mirrors read_extension_file: required name+path, would throw inside execute
// if path arrived undefined. The validator must intercept before that.
function readExtFile(executions: string[]): ToolDef<{ name: string; path: string }, string> {
  return {
    name: "read_extension_file",
    description: "read a file from an extension",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, path: { type: "string" } },
      required: ["name", "path"],
      additionalProperties: false,
    },
    execute: ({ name, path }) => {
      // If validation let a bad call through, this is where the opaque crash
      // happened in the field (join(base, undefined)). Make that observable.
      if (typeof path !== "string") throw new Error("paths[1] must be string, got undefined");
      executions.push(`${name}/${path}`);
      return `contents of ${path}`;
    },
  };
}

const ctx = {
  hostId: "h",
  extensionId: "core",
  actorId: "agent-1",
  abort: new AbortController().signal,
  secrets: {},
};

describe("tool input dispatch validation", () => {
  it("returns a schema-shaped error on a blind wrong-param call, then self-corrects", async () => {
    const executions: string[] = [];
    const tool = readExtFile(executions);
    const llm = mockLlm([
      // turn 1: blind call with the wrong param name (the bug from the log)
      toolUse("t1", "read_extension_file", { name: "claude-code", file: "index.ts" }),
      // turn 2: corrected after reading the error
      toolUse("t2", "read_extension_file", { name: "claude-code", path: "index.ts" }),
      endTurn("done"),
    ]);

    const steps: Array<{ id: string; content: string; isError?: boolean }> = [];
    const result = await runAgent({
      llm,
      messages: [{ role: "user", content: "read it" }],
      tools: [tool],
      toolCtx: ctx,
      onStep: (s) => {
        if (s.kind === "tool_result") steps.push({ id: s.id, content: s.content, isError: s.isError });
      },
    });

    // The bad call never reached execute() — no crash, a legible error instead.
    const firstResult = steps.find((s) => s.id === "t1")!;
    expect(firstResult.isError).toBe(true);
    expect(firstResult.content).toContain("missing required property: path");
    expect(firstResult.content).toContain("unexpected property: file");
    expect(firstResult.content).toContain('"path"'); // schema embedded

    // The corrected call executed exactly once and the turn ended cleanly.
    expect(executions).toEqual(["claude-code/index.ts"]);
    expect(result.stopReason).toBe("end_turn");
  });
});
