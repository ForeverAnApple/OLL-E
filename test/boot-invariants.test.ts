import { describe, expect, it } from "bun:test";
import { checkCoreInvariants, formatFailures } from "../src/boot/invariants.ts";
import type { ToolDef } from "../src/extensions/types.ts";

function tool(name: string, overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name,
    description: `description for ${name}`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({}),
    ...overrides,
  };
}

describe("boot/invariants", () => {
  it("passes a clean core registry", () => {
    const r = checkCoreInvariants([tool("a"), tool("b"), tool("c")]);
    expect(r.ok).toBe(true);
    expect(r.failures).toHaveLength(0);
  });

  it("flags duplicate tool names — the wedge that started this", () => {
    const r = checkCoreInvariants([tool("mail_list"), tool("other"), tool("mail_list")]);
    expect(r.ok).toBe(false);
    const dup = r.failures.find((f) => f.code === "duplicate-tool-name");
    expect(dup).toBeDefined();
    expect(dup!.offenders).toEqual(["mail_list"]);
    expect(formatFailures(r)).toContain("mail_list");
  });

  it("flags invalid tool names", () => {
    const r = checkCoreInvariants([tool("bad name!")]);
    expect(r.failures.some((f) => f.code === "invalid-tool-name")).toBe(true);
  });

  it("flags missing inputSchema", () => {
    const r = checkCoreInvariants([
      tool("missing", { inputSchema: undefined as unknown as Record<string, unknown> }),
    ]);
    expect(r.failures.some((f) => f.code === "missing-input-schema")).toBe(true);
  });

  it("flags non-object inputSchema.type", () => {
    const r = checkCoreInvariants([
      tool("wrong", { inputSchema: { type: "string" } as unknown as Record<string, unknown> }),
    ]);
    expect(r.failures.some((f) => f.code === "non-object-input-schema")).toBe(true);
  });

  it("flags missing description", () => {
    const r = checkCoreInvariants([tool("nodesc", { description: "" })]);
    expect(r.failures.some((f) => f.code === "missing-description")).toBe(true);
  });

  it("collects every failure rather than throwing on the first", () => {
    const r = checkCoreInvariants([
      tool("dupe"),
      tool("dupe"),
      tool("bad name!"),
      tool("nodesc", { description: "" }),
    ]);
    const codes = r.failures.map((f) => f.code).sort();
    expect(codes).toEqual(
      ["duplicate-tool-name", "invalid-tool-name", "missing-description"].sort(),
    );
  });
});
