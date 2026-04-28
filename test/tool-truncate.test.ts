import { describe, expect, it } from "bun:test";
import { runAgent } from "../src/agent/runtime.ts";
import {
  createTruncationState,
  DEFAULT_MAX_RESULT_BYTES,
} from "../src/agent/tool-truncate.ts";
import type { Completion, CompletionRequest, ContentBlock, Llm } from "../src/llm/types.ts";
import type { ToolDef } from "../src/extensions/types.ts";

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
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 2,
    },
  };
}

function toolUse(id: string, name: string, input: Record<string, unknown>): Completion {
  return {
    content: [{ type: "tool_use", id, name, input }],
    stopReason: "tool_use",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 2,
    },
  };
}

function parallelToolUse(
  blocks: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): Completion {
  const content: ContentBlock[] = blocks.map((b) => ({
    type: "tool_use",
    id: b.id,
    name: b.name,
    input: b.input,
  }));
  return {
    content,
    stopReason: "tool_use",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 2,
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

function bigTool(name: string, size: number): ToolDef<unknown, string> {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    execute: () => "X".repeat(size),
  };
}

describe("tool-result truncation", () => {
  it("passes through small outputs unchanged", async () => {
    const persisted: Array<{ id: string; content: string }> = [];
    const llm = mockLlm([toolUse("t1", "small", {}), endTurn("ok")]);
    const r = await runAgent({
      llm,
      toolCtx: ctx,
      messages: [{ role: "user", content: "go" }],
      tools: [bigTool("small", 100)],
      truncate: {
        state: createTruncationState(),
        maxBytesPerCall: DEFAULT_MAX_RESULT_BYTES,
        maxBytesPerMessage: 200_000,
        persist: (input) => persisted.push({ id: input.id, content: input.content }),
      },
    });
    expect(r.stopReason).toBe("end_turn");
    expect(persisted.length).toBe(0);
    const userMsg = r.messages[2];
    const block = (userMsg!.content as ContentBlock[])[0]!;
    expect(block.type).toBe("tool_result");
    expect((block as { content: string }).content.length).toBe(100);
  });

  it("spills oversize outputs and replaces inline with a preview + handle", async () => {
    const persisted: Array<{ id: string; content: string }> = [];
    const llm = mockLlm([toolUse("t1", "fat", {}), endTurn("ok")]);
    const r = await runAgent({
      llm,
      toolCtx: ctx,
      messages: [{ role: "user", content: "go" }],
      tools: [bigTool("fat", 100_000)],
      truncate: {
        state: createTruncationState(),
        maxBytesPerCall: 50_000,
        maxBytesPerMessage: 200_000,
        persist: (input) => persisted.push({ id: input.id, content: input.content }),
      },
    });
    expect(r.stopReason).toBe("end_turn");
    expect(persisted.length).toBe(1);
    expect(persisted[0]!.id).toBe("t1");
    expect(persisted[0]!.content.length).toBe(100_000);

    const block = (r.messages[2]!.content as ContentBlock[])[0]!;
    const content = (block as { content: string }).content;
    expect(content).toContain("<persisted-output>");
    expect(content).toContain("tool-result/t1");
    expect(content).toContain("read_tool_result");
    expect(content.length).toBeLessThan(50_000);
  });

  it("uses a byte-identical preview on subsequent renders (cache stability)", async () => {
    const state = createTruncationState();
    const llm1 = mockLlm([toolUse("t1", "fat", {}), endTurn("ok")]);
    const r1 = await runAgent({
      llm: llm1,
      toolCtx: ctx,
      messages: [{ role: "user", content: "go" }],
      tools: [bigTool("fat", 100_000)],
      truncate: {
        state,
        maxBytesPerCall: 50_000,
        maxBytesPerMessage: 200_000,
        persist: () => {},
      },
    });
    const first = (r1.messages[2]!.content as ContentBlock[])[0]! as { content: string };
    // Second turn re-runs the same tool_use_id through the truncator —
    // simulates a transcript replay or a subsequent inner round-trip
    // re-emitting the prior block. The state's seen-cache must produce
    // the same string byte-for-byte.
    const llm2 = mockLlm([toolUse("t1", "fat", {}), endTurn("ok")]);
    const r2 = await runAgent({
      llm: llm2,
      toolCtx: ctx,
      messages: [{ role: "user", content: "go" }],
      tools: [bigTool("fat", 100_000)],
      truncate: {
        state,
        maxBytesPerCall: 50_000,
        maxBytesPerMessage: 200_000,
        persist: () => {},
      },
    });
    const second = (r2.messages[2]!.content as ContentBlock[])[0]! as { content: string };
    expect(second.content).toBe(first.content);
  });

  it("respects per-tool maxResultBytes override", async () => {
    const persisted: Array<{ id: string }> = [];
    const tool: ToolDef<unknown, string> = {
      name: "tight",
      description: "small cap",
      inputSchema: { type: "object" },
      maxResultBytes: 1_000,
      execute: () => "Y".repeat(5_000),
    };
    const llm = mockLlm([toolUse("t1", "tight", {}), endTurn("ok")]);
    const r = await runAgent({
      llm,
      toolCtx: ctx,
      messages: [{ role: "user", content: "go" }],
      tools: [tool],
      truncate: {
        state: createTruncationState(),
        maxBytesPerCall: 50_000,
        maxBytesPerMessage: 200_000,
        persist: (input) => persisted.push({ id: input.id }),
      },
    });
    expect(r.stopReason).toBe("end_turn");
    expect(persisted.length).toBe(1);
  });

  it("enforces per-message aggregate cap by spilling largest first", async () => {
    const persisted: Array<{ id: string; content: string }> = [];
    const llm = mockLlm([
      parallelToolUse([
        { id: "a", name: "med", input: {} },
        { id: "b", name: "med", input: {} },
        { id: "c", name: "huge", input: {} },
      ]),
      endTurn("ok"),
    ]);
    // 30k per "med" call passes per-call (cap 50k) but three of them in
    // one message blow past per-message. The largest should spill first.
    const tools: ToolDef[] = [
      bigTool("med", 30_000),
      bigTool("huge", 45_000),
    ];
    const r = await runAgent({
      llm,
      toolCtx: ctx,
      messages: [{ role: "user", content: "go" }],
      tools,
      truncate: {
        state: createTruncationState(),
        maxBytesPerCall: 50_000,
        maxBytesPerMessage: 80_000,
        persist: (input) => persisted.push({ id: input.id, content: input.content }),
      },
    });
    expect(r.stopReason).toBe("end_turn");
    // huge gets spilled first; med blocks may also spill until the
    // aggregate sits under 80k.
    expect(persisted.some((p) => p.id === "c")).toBe(true);
    const userMsg = r.messages[2]!;
    let total = 0;
    for (const b of userMsg.content as ContentBlock[]) {
      total += Buffer.byteLength((b as { content: string }).content, "utf8");
    }
    expect(total).toBeLessThanOrEqual(80_000);
  });

  it("never spills sensitive-output tools", async () => {
    const persisted: Array<{ id: string }> = [];
    const tool: ToolDef<unknown, string> = {
      name: "secret",
      description: "redacted",
      inputSchema: { type: "object" },
      sensitiveOutput: true,
      execute: () => "S".repeat(100_000),
    };
    const llm = mockLlm([toolUse("t1", "secret", {}), endTurn("ok")]);
    const r = await runAgent({
      llm,
      toolCtx: ctx,
      messages: [{ role: "user", content: "go" }],
      tools: [tool],
      truncate: {
        state: createTruncationState(),
        maxBytesPerCall: 50_000,
        maxBytesPerMessage: 200_000,
        persist: (input) => persisted.push({ id: input.id }),
      },
    });
    expect(r.stopReason).toBe("end_turn");
    expect(persisted.length).toBe(0);
    const block = (r.messages[2]!.content as ContentBlock[])[0]! as { content: string };
    expect(block.content).toBe("[redacted]");
  });
});
