import { describe, expect, it } from "bun:test";
import type { ToolDef } from "../src/extensions/types.ts";
import type { StarterTemplate } from "../src/starters/index.ts";
import { renderToolCatalog } from "../src/agent/catalog.ts";

function starter(name: string, description: string): StarterTemplate {
  return { name, description, files: {} };
}

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
    const starters = [starter("discord", "bot gateway"), starter("github", "webhook receiver")];
    expect(renderToolCatalog(tools, starters)).toBe(renderToolCatalog(tools, starters));
  });

  it("renders a starters section with name + description, sorted by name", () => {
    const tools = [tool("memory_search", "memory", "recall")];
    const starters = [
      starter("github", "webhook receiver + API calls"),
      starter("discord", "bot gateway + message send/receive"),
    ];
    const out = renderToolCatalog(tools, starters);
    expect(out).toContain("## Available starters");
    expect(out).toContain("- discord — bot gateway + message send/receive");
    expect(out).toContain("- github — webhook receiver + API calls");
    // Guidance an agent must read before standing up its own service.
    expect(out).toContain("CONNECTS to an existing");
    expect(out).toContain("Never provision infrastructure");
    // Alphabetical: discord before github.
    expect(out.indexOf("- discord")).toBeLessThan(out.indexOf("- github"));
  });

  it("omits the starters section when no starters are supplied", () => {
    const out = renderToolCatalog([tool("memory_search", "memory", "recall")]);
    expect(out).not.toContain("## Available starters");
  });

  it("carries the secret-value guardrail in the secrets category prose", () => {
    const out = renderToolCatalog([
      tool("set_secret", "secrets", "store a host-scoped secret"),
    ]);
    expect(out).toContain("### secrets —");
    expect(out).toContain("reading a secret's value");
    expect(out).toContain("never acceptable");
  });

  it("prefers extension prose over the default blurb for its category", () => {
    const tools = [tool("web_fetch", "web", "")];
    const prose = [
      { category: "web", tagline: "fetching the public web", body: "Pull a URL." },
    ];
    const out = renderToolCatalog(tools, [], prose);
    expect(out).toContain("### web — fetching the public web");
    expect(out).toContain("Pull a URL.");
    // The default extension blurb must NOT appear for this category.
    expect(out).not.toContain("### web — tools contributed by extensions");
  });

  it("never lets extension prose override a core category", () => {
    const tools = [tool("memory_search", "memory", "recall")];
    const prose = [
      { category: "memory", tagline: "HIJACKED", body: "extension tried to rewrite core" },
    ];
    const out = renderToolCatalog(tools, [], prose);
    expect(out).toContain("### memory — your persistent self");
    expect(out).not.toContain("HIJACKED");
    expect(out).not.toContain("extension tried to rewrite core");
  });

  it("clause fallback order: shortClause > manifest toolClauses > description", () => {
    const withShort: ToolDef = {
      name: "has_short",
      description: "long description",
      category: "web",
      shortClause: "from shortClause",
      inputSchema: { type: "object" },
      execute: () => undefined,
    };
    const noShort: ToolDef = {
      name: "no_short",
      description: "from description",
      category: "web",
      inputSchema: { type: "object" },
      execute: () => undefined,
    };
    const prose = [
      {
        category: "web",
        tagline: "the web",
        body: "web tools",
        toolClauses: { has_short: "manifest clause A", no_short: "manifest clause B" },
      },
    ];
    const out = renderToolCatalog([withShort, noShort], [], prose);
    // shortClause wins over the manifest clause.
    expect(out).toContain("- has_short — from shortClause");
    // manifest clause wins over description when shortClause is absent.
    expect(out).toContain("- no_short — manifest clause B");
    expect(out).not.toContain("from description");
  });

  it("falls back to description when neither shortClause nor a manifest clause exists", () => {
    const t: ToolDef = {
      name: "bare",
      description: "just the description",
      category: "web",
      inputSchema: { type: "object" },
      execute: () => undefined,
    };
    const prose = [{ category: "web", tagline: "web", body: "b", toolClauses: { other: "x" } }];
    const out = renderToolCatalog([t], [], prose);
    expect(out).toContain("- bare — just the description");
  });

  it("first-loaded extension prose wins on a category conflict", () => {
    const tools = [tool("t", "shared", "")];
    const prose = [
      { category: "shared", tagline: "FIRST", body: "first body" },
      { category: "shared", tagline: "SECOND", body: "second body" },
    ];
    const out = renderToolCatalog(tools, [], prose);
    expect(out).toContain("### shared — FIRST");
    expect(out).not.toContain("SECOND");
  });

  it("stays stable across calls with extension prose supplied (cache invariant)", () => {
    const tools = [tool("web_fetch", "web", "")];
    const starters = [starter("web", "fetch")];
    const prose = [
      { category: "web", tagline: "fetching the public web", body: "Pull a URL.", toolClauses: { web_fetch: "grab a page" } },
    ];
    expect(renderToolCatalog(tools, starters, prose)).toBe(
      renderToolCatalog(tools, starters, prose),
    );
  });
});
