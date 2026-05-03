import { describe, expect, it } from "bun:test";
import { runAgent } from "../src/agent/runtime.ts";
import type {
  Completion,
  CompletionRequest,
  ContentBlock,
  Llm,
  ToolUseBlock,
} from "../src/llm/types.ts";
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

  it("redacts sensitive tool outputs before tracing or feeding back to the model", async () => {
    const llm = mockLlm([
      toolUse("t1", "token_fetch", {}),
      endTurn("done."),
    ]);
    const tool: ToolDef<Record<string, never>, { token: string; label: string }> = {
      name: "token_fetch",
      description: "fetch token",
      inputSchema: { type: "object", properties: {} },
      sensitiveOutputFields: ["token"],
      execute: () => ({ token: "raw-secret", label: "visible" }),
    };
    const seen: string[] = [];
    await runAgent({
      llm,
      toolCtx: ctx,
      tools: [tool],
      messages: [{ role: "user", content: "fetch" }],
      onStep: (s) => {
        if (s.kind === "tool_result") seen.push(s.content);
      },
    });
    expect(seen).toEqual([JSON.stringify({ token: "[redacted]", label: "visible" })]);
    expect(JSON.stringify(llm.calls)).not.toContain("raw-secret");
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

  it("getTools is consulted per round-trip — new tools become callable mid-turn", async () => {
    const llm = mockLlm([
      toolUse("t1", "register", {}),
      toolUse("t2", "newcomer", { x: 1 }),
      endTurn("done."),
    ]);
    const tools: ToolDef[] = [
      {
        name: "register",
        description: "register the newcomer tool",
        inputSchema: { type: "object", properties: {} },
        execute: () => {
          tools.push({
            name: "newcomer",
            description: "added mid-turn",
            inputSchema: { type: "object", properties: { x: { type: "number" } } },
            execute: (args) => `newcomer:${(args as { x: number }).x}`,
          });
          return "registered";
        },
      },
    ];
    const r = await runAgent({
      llm,
      toolCtx: ctx,
      getTools: () => [...tools],
      messages: [{ role: "user", content: "go" }],
    });
    expect(r.stopReason).toBe("end_turn");
    // First LLM call sees only `register`. Second call (after register ran)
    // must see both, AND the tool_use for newcomer must dispatch
    // successfully — not "unknown tool".
    const firstReqTools = (llm.calls[0]!.tools ?? []).map((t) => t.name);
    const secondReqTools = (llm.calls[1]!.tools ?? []).map((t) => t.name);
    expect(firstReqTools).toEqual(["register"]);
    expect(secondReqTools.sort()).toEqual(["newcomer", "register"]);
    const allBlocks = llm.calls[2]!.messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content : [],
    );
    const newcomerResult = allBlocks.find(
      (b) => b.type === "tool_result" && (b as { tool_use_id: string }).tool_use_id === "t2",
    );
    expect(newcomerResult).toBeDefined();
    expect((newcomerResult as { content: string }).content).toBe("newcomer:1");
    expect((newcomerResult as { is_error?: boolean }).is_error).toBeUndefined();
  });

  it("processes tool_use blocks even when stop_reason is not 'tool_use' (pause_turn fold)", async () => {
    // Anthropic returns stop_reason='pause_turn' on long parallel-tool-use
    // batches; our adapter folds that to 'end_turn' (types.ts only enumerates
    // the five canonical reasons). If the runtime gates tool dispatch on
    // stop_reason rather than on actual content, the assistant message lands
    // in history with unanswered tool_use blocks — and the next API call
    // 400s with "tool_use ids were found without tool_result blocks".
    const paused: Completion = {
      content: [
        { type: "tool_use", id: "tA", name: "echo", input: { msg: "a" } },
        { type: "tool_use", id: "tB", name: "echo", input: { msg: "b" } },
      ],
      stopReason: "end_turn",
      usage: {
        inputTokens: 5,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        totalTokens: 10,
      },
    };
    const llm = mockLlm([paused, endTurn("done.")]);
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
      messages: [{ role: "user", content: "go" }],
    });

    // Structural invariant: every tool_use block in an assistant message
    // must have a matching tool_result block in the immediately-following
    // user message. This is exactly what the API checks server-side.
    for (let i = 0; i < r.messages.length; i++) {
      const m = r.messages[i]!;
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      const toolUseIds = m.content
        .filter((b): b is ToolUseBlock => b.type === "tool_use")
        .map((b) => b.id);
      if (toolUseIds.length === 0) continue;
      const next = r.messages[i + 1];
      expect(next, `assistant message #${i} has tool_use but no follow-up`).toBeDefined();
      expect(next!.role).toBe("user");
      expect(Array.isArray(next!.content)).toBe(true);
      const resultIds = (next!.content as ContentBlock[])
        .filter((b): b is { type: "tool_result"; tool_use_id: string; content: string } =>
          b.type === "tool_result",
        )
        .map((b) => b.tool_use_id);
      expect(resultIds.sort()).toEqual([...toolUseIds].sort());
    }
  });

  it("getTools removes a renamed-away tool from dispatch on the next round", async () => {
    const llm = mockLlm([
      toolUse("t1", "rename", {}),
      toolUse("t2", "old_name", {}),
      endTurn("done."),
    ]);
    let live: ToolDef[] = [
      {
        name: "old_name",
        description: "to be replaced",
        inputSchema: { type: "object", properties: {} },
        execute: () => "old",
      },
      {
        name: "rename",
        description: "swap old_name for new_name",
        inputSchema: { type: "object", properties: {} },
        execute: () => {
          live = [
            {
              name: "new_name",
              description: "replacement",
              inputSchema: { type: "object", properties: {} },
              execute: () => "new",
            },
            live.find((t) => t.name === "rename")!,
          ];
          return "renamed";
        },
      },
    ];
    const seen: string[] = [];
    await runAgent({
      llm,
      toolCtx: ctx,
      getTools: () => live,
      messages: [{ role: "user", content: "go" }],
      onStep: (s) => {
        if (s.kind === "tool_result") seen.push(`${s.name}:${s.isError}:${s.content}`);
      },
    });
    expect(seen[0]).toBe("rename:false:renamed");
    expect(seen[1]).toBe("old_name:true:unknown tool: old_name");
  });
});
