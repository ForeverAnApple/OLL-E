import { describe, expect, it } from "bun:test";
import { z } from "zod";
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
    usage: { inputTokens: 10, outputTokens: text.length, totalTokens: 10 + text.length },
    usdMicros: 0,
  };
}

function toolUse(id: string, name: string, input: Record<string, unknown>): Completion {
  const content: ContentBlock[] = [{ type: "tool_use", id, name, input }];
  return {
    content,
    stopReason: "tool_use",
    usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
    usdMicros: 0,
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
      parameters: z.object({ msg: z.string() }),
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
      parameters: z.object({}),
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
      parameters: z.object({}),
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
});
