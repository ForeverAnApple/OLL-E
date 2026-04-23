import { describe, expect, it } from "bun:test";
import { checkTool, narrowsScope } from "../src/permissions/index.ts";
import { runAgent } from "../src/agent/runtime.ts";
import type { Llm, CompletionRequest } from "../src/llm/index.ts";
import type { ToolDef } from "../src/extensions/types.ts";

describe("checkTool", () => {
  it("allows when scope is empty (unrestricted)", () => {
    const r = checkTool({}, { name: "x", tier: "operational" });
    expect(r.ok).toBe(true);
  });

  it("denies a tool in denyTools even if in allowTools", () => {
    const r = checkTool(
      { allowTools: ["x"], denyTools: ["x"] },
      { name: "x", tier: "operational" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("denied-by-deny");
  });

  it("denies a tool not in allowTools when allowTools is set", () => {
    const r = checkTool({ allowTools: ["y"] }, { name: "x", tier: "operational" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not-in-allow");
  });

  it("denies a tier outside allowTiers", () => {
    const r = checkTool(
      { allowTiers: ["operational"] },
      { name: "x", tier: "strategic" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("tier-not-allowed");
  });

  it("allows a tier that is listed", () => {
    const r = checkTool(
      { allowTiers: ["operational", "strategic"] },
      { name: "x", tier: "strategic" },
    );
    expect(r.ok).toBe(true);
  });
});

describe("narrowsScope", () => {
  it("allows child inheriting parent tiers", () => {
    const r = narrowsScope(
      { allowTiers: ["operational", "strategic"] },
      { allowTiers: ["operational"] },
    );
    expect(r.ok).toBe(true);
  });

  it("rejects child widening tiers past parent", () => {
    const r = narrowsScope(
      { allowTiers: ["operational"] },
      { allowTiers: ["operational", "strategic"] },
    );
    expect(r.ok).toBe(false);
  });

  it("rejects child granting a tool its parent denies", () => {
    const r = narrowsScope({ denyTools: ["x"] }, { allowTools: ["x"] });
    expect(r.ok).toBe(false);
  });

  it("rejects child tool outside parent's allowTools", () => {
    const r = narrowsScope({ allowTools: ["a"] }, { allowTools: ["b"] });
    expect(r.ok).toBe(false);
  });

  it("allows child narrowing with an extra deny", () => {
    const r = narrowsScope({}, { denyTools: ["x"] });
    expect(r.ok).toBe(true);
  });
});

describe("runAgent authorize gate", () => {
  function fakeLlm(plan: Array<"tool" | "done">): Llm {
    let turn = 0;
    return {
      provider: "fake",
      defaultModel: "fake",
      async complete(_req: CompletionRequest) {
        const step = plan[turn++] ?? "done";
        if (step === "tool") {
          return {
            content: [
              { type: "tool_use", id: "t1", name: "forbidden", input: {} },
            ],
            stopReason: "tool_use",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            usdMicros: 0,
          };
        }
        return {
          content: [{ type: "text", text: "ok" }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          usdMicros: 0,
        };
      },
    };
  }

  it("returns is_error to the model and fires onDenied when authorize rejects", async () => {
    let executed = false;
    const tool: ToolDef = {
      name: "forbidden",
      tier: "strategic",
      description: "n/a",
      inputSchema: { type: "object" },
      execute: () => {
        executed = true;
        return "ran";
      },
    };
    const denied: string[] = [];
    const result = await runAgent({
      llm: fakeLlm(["tool", "done"]),
      tools: [tool],
      toolCtx: {
        hostId: "h",
        extensionId: "e",
        actorId: "a",
        abort: new AbortController().signal,
        secrets: {},
      },
      messages: [{ role: "user", content: "go" }],
      authorize: (t) =>
        t.name === "forbidden"
          ? { ok: false, reason: "nope" }
          : ({ ok: true } as const),
      onDenied: ({ reason }) => void denied.push(reason),
    });
    expect(executed).toBe(false);
    expect(denied).toEqual(["nope"]);
    expect(result.stopReason).toBe("end_turn");
    // The user-role message after the assistant tool_use should carry an
    // is_error tool_result so the model sees the denial.
    const last = result.messages.at(-2);
    expect(last?.role).toBe("user");
    const blocks = Array.isArray(last?.content) ? last!.content : [];
    const tr = blocks.find((b) => b.type === "tool_result") as
      | { type: "tool_result"; is_error?: boolean; content: string }
      | undefined;
    expect(tr?.is_error).toBe(true);
    expect(tr?.content).toContain("permission denied");
  });
});
