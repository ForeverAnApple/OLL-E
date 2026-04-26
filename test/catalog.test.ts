import { describe, expect, it } from "bun:test";
import type { ToolDef } from "../src/extensions/types.ts";
import { renderToolCatalog } from "../src/agent/catalog.ts";

function tool(
  name: string,
  category: string,
  shortClause: string,
  description = `${name} description`,
): ToolDef {
  return {
    name,
    description,
    category,
    shortClause,
    inputSchema: { type: "object" },
    execute: () => undefined,
  };
}

describe("renderToolCatalog", () => {
  it("groups tools by category and emits category prose + name+clause lines", () => {
    const tools = [
      tool("memory_search", "memory", "find what you've remembered"),
      tool("memory_write", "memory", "record a new memory"),
      tool("query_self", "observability", "your identity, scope, current loadout"),
    ];
    const out = renderToolCatalog(tools);

    expect(out).toContain("## Available tools");
    expect(out).toContain("### memory — your persistent self");
    expect(out).toContain("### observability — knowing what's happening");
    expect(out).toContain("- memory_search — find what you've remembered");
    expect(out).toContain("- memory_write — record a new memory");
    expect(out).toContain("- query_self — your identity, scope, current loadout");
  });

  it("orders categories deterministically (known categories before extras, misc last)", () => {
    const tools = [
      tool("zfoo", "extension authoring", "edit world"),
      tool("aaa", "memory", "remember"),
      tool("bbb", "ext-contributed", "third party"),
      tool("ccc", "", "no category — falls to misc"),
    ];
    const out = renderToolCatalog(tools);
    const memIdx = out.indexOf("### memory");
    const extIdx = out.indexOf("### extension authoring");
    const thirdIdx = out.indexOf("### ext-contributed");
    const miscIdx = out.indexOf("### misc");
    expect(memIdx).toBeGreaterThan(-1);
    expect(extIdx).toBeGreaterThan(-1);
    expect(thirdIdx).toBeGreaterThan(-1);
    expect(miscIdx).toBeGreaterThan(-1);
    // memory + extension authoring (known) come before ext-contributed (extra).
    expect(memIdx).toBeLessThan(thirdIdx);
    expect(extIdx).toBeLessThan(thirdIdx);
    // misc comes last.
    expect(thirdIdx).toBeLessThan(miscIdx);
  });

  it("uses default prose for extension-contributed categories", () => {
    const tools = [tool("custom_t", "github-bot", "do github things")];
    const out = renderToolCatalog(tools);
    expect(out).toContain("### github-bot — tools contributed by extensions");
    expect(out).toContain("- custom_t — do github things");
  });

  it("falls back to truncated description when shortClause is absent", () => {
    const t: ToolDef = {
      name: "verbose_tool",
      description: "A".repeat(120),
      category: "memory",
      inputSchema: { type: "object" },
      execute: () => undefined,
    };
    const out = renderToolCatalog([t]);
    expect(out).toContain("- verbose_tool — " + "A".repeat(77) + "...");
  });

  it("orders members within a category by name", () => {
    const tools = [
      tool("memory_zeta", "memory", "z"),
      tool("memory_alpha", "memory", "a"),
      tool("memory_mid", "memory", "m"),
    ];
    const out = renderToolCatalog(tools);
    const aIdx = out.indexOf("memory_alpha");
    const mIdx = out.indexOf("memory_mid");
    const zIdx = out.indexOf("memory_zeta");
    expect(aIdx).toBeLessThan(mIdx);
    expect(mIdx).toBeLessThan(zIdx);
  });

  it("returns identical output across calls (stable identity for cache)", () => {
    const tools = [
      tool("a", "memory", "x"),
      tool("b", "observability", "y"),
    ];
    expect(renderToolCatalog(tools)).toBe(renderToolCatalog(tools));
  });
});
