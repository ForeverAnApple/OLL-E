import { describe, expect, it } from "bun:test";
import { runAgent } from "../src/agent/runtime.ts";
import type { Completion, CompletionRequest, ContentBlock, Llm } from "../src/llm/types.ts";
import type { ToolDef } from "../src/extensions/types.ts";

/** Scriptable mock LLM. Each entry is the completion to return for the
 *  next .complete() call, regardless of request. */
function mockLlm(scripted: Completion[]): Llm & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  return {
    provider: "mock",
    defaultModel: "mock-1",
    calls,
    async complete(req: CompletionRequest): Promise<Completion> {
      calls.push(req);
      const next = scripted.shift();
      if (!next) throw new Error("mockLlm: no scripted completion");
      return next;
    },
  };
}

function endTurn(text: string): Completion {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: {
      inputTokens: 10,
      outputTokens: text.length,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 10 + text.length,
    },
  };
}

function toolUse(id: string, name: string, input: Record<string, unknown>): Completion {
  const content: ContentBlock[] = [{ type: "tool_use", id, name, input }];
  return {
    content,
    stopReason: "tool_use",
    usage: {
      inputTokens: 5,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 10,
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

describe("runAgent", () => {
  it("returns assistant text on end_turn", async () => {
    const llm = mockLlm([endTurn("hello world")]);
    const r = await runAgent({
      llm,
      toolCtx: ctx,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.stopReason).toBe("end_turn");
    const last = r.messages[r.messages.length - 1];
    expect(last!.role).toBe("assistant");
    expect(Array.isArray(last!.content)).toBe(true);
    expect((last!.content as ContentBlock[])[0]).toEqual({ type: "text", text: "hello world" });
  });

  it("executes tool calls and feeds results back", async () => {
    const llm = mockLlm([
      toolUse("t1", "echo", { msg: "ping" }),
      endTurn("done."),
    ]);
    const echo: ToolDef<{ msg: string }, string> = {
      name: "echo",
      description: "echo",
      inputSchema: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
      execute: (args) => `echoed:${args.msg}`,
    };
    const r = await runAgent({
      llm,
      toolCtx: ctx,
      tools: [echo],
      messages: [{ role: "user", content: "please echo" }],
    });
    expect(r.stopReason).toBe("end_turn");
    expect(llm.calls).toHaveLength(2);
    // second call must contain a tool_result user message
    // All messages fed to the 2nd LLM call, flattened to blocks, must
    // contain a tool_result with the echoed content.
    const allBlocks = llm.calls[1]!.messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content : [],
    );
    const toolResult = allBlocks.find((b) => b.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect((toolResult as { content: string }).content).toBe("echoed:ping");
  });

  it("surfaces tool errors as is_error tool_result blocks", async () => {
    const llm = mockLlm([
      toolUse("t1", "boom", {}),
      endTurn("noted."),
    ]);
    const boom: ToolDef<Record<string, never>, string> = {
      name: "boom",
      description: "throws",
      inputSchema: { type: "object", properties: {} },
      execute: () => {
        throw new Error("kaboom");
      },
    };
    const seen: string[] = [];
    await runAgent({
      llm,
      toolCtx: ctx,
      tools: [boom],
      messages: [{ role: "user", content: "go" }],
      onStep: (s) => {
        if (s.kind === "tool_result") seen.push(`${s.name}:${s.isError}:${s.content}`);
      },
    });
    expect(seen).toEqual(["boom:true:kaboom"]);
  });

  it("stops at maxTurns if the model never ends the turn", async () => {
    const llm = mockLlm(Array.from({ length: 10 }, () => toolUse("x", "noop", {})));
    const noop: ToolDef<Record<string, never>, string> = {
      name: "noop",
      description: "noop",
      inputSchema: { type: "object", properties: {} },
      execute: () => "ok",
    };
    const r = await runAgent({
      llm,
      toolCtx: ctx,
      tools: [noop],
      maxTurns: 3,
      messages: [{ role: "user", content: "loop" }],
    });
    expect(r.stopReason).toBe("max_turns");
    expect(llm.calls).toHaveLength(3);
  });

  it("passes the tool's inputSchema verbatim into the LLM request", async () => {
    const llm = mockLlm([endTurn("ok")]);
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
      additionalProperties: false,
    };
    const tool: ToolDef<{ a: string; b?: number }, string> = {
      name: "t",
      description: "t",
      inputSchema: schema,
      execute: () => "ok",
    };
    await runAgent({
      llm,
      toolCtx: ctx,
      tools: [tool],
      messages: [{ role: "user", content: "noop" }],
    });
    const spec = llm.calls[0]!.tools?.[0];
    expect(spec?.name).toBe("t");
    expect(spec?.inputSchema).toBe(schema);
  });

  it("runs the tool's validate() on LLM-emitted input before execute", async () => {
    const llm = mockLlm([
      toolUse("t1", "norm", { n: "  hi  " }),
      endTurn("done"),
    ]);
    const seen: unknown[] = [];
    const tool: ToolDef<{ n: string }, string> = {
      name: "norm",
      description: "normalize",
      inputSchema: {
        type: "object",
        properties: { n: { type: "string" } },
        required: ["n"],
      },
      validate(input) {
        const { n } = input as { n: string };
        return { n: n.trim() };
      },
      execute(args) {
        seen.push(args);
        return args.n;
      },
    };
    await runAgent({
      llm,
      toolCtx: ctx,
      tools: [tool],
      messages: [{ role: "user", content: "go" }],
    });
    expect(seen).toEqual([{ n: "hi" }]);
  });

  it("passes input through unchanged when validate is absent", async () => {
    const llm = mockLlm([
      toolUse("t1", "raw", { anything: 42, nested: { x: 1 } }),
      endTurn("done"),
    ]);
    const seen: unknown[] = [];
    const tool: ToolDef<Record<string, unknown>, string> = {
      name: "raw",
      description: "passthrough",
      inputSchema: { type: "object" },
      execute(args) {
        seen.push(args);
        return "ok";
      },
    };
    await runAgent({
      llm,
      toolCtx: ctx,
      tools: [tool],
      messages: [{ role: "user", content: "go" }],
    });
    expect(seen).toEqual([{ anything: 42, nested: { x: 1 } }]);
  });

  it("surfaces validate() errors as is_error tool_result blocks", async () => {
    const llm = mockLlm([
      toolUse("t1", "strict", { n: "nope" }),
      endTurn("noted"),
    ]);
    const tool: ToolDef<{ n: number }, string> = {
      name: "strict",
      description: "validates",
      inputSchema: {
        type: "object",
        properties: { n: { type: "number" } },
        required: ["n"],
      },
      validate(input) {
        const { n } = input as { n: unknown };
        if (typeof n !== "number") throw new Error("n must be a number");
        return { n };
      },
      execute: (args) => String(args.n),
    };
    const seen: string[] = [];
    await runAgent({
      llm,
      toolCtx: ctx,
      tools: [tool],
      messages: [{ role: "user", content: "go" }],
      onStep: (s) => {
        if (s.kind === "tool_result") seen.push(`${s.isError}:${s.content}`);
      },
    });
    expect(seen).toEqual(["true:n must be a number"]);
  });
});
