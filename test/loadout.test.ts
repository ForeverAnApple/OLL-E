import { describe, expect, it } from "bun:test";
import type { ToolDef, ToolExecuteContext } from "../src/extensions/types.ts";
import { buildLoadoutTools } from "../src/tools/loadout.ts";

const ctx: ToolExecuteContext = {
  hostId: "h",
  extensionId: "test",
  actorId: "test",
  abort: new AbortController().signal,
  secrets: {},
};

function makeTool(name: string, alwaysLoaded = false): ToolDef {
  return {
    name,
    description: `${name} desc`,
    inputSchema: { type: "object", properties: { x: { type: "string" } } },
    alwaysLoaded,
    execute: () => undefined,
  };
}

describe("load_tools", () => {
  it("adds names to the loaded set and returns their schemas", async () => {
    const loadedTools = new Set<string>();
    const allTools = [makeTool("write_extension"), makeTool("memory_write")];
    const load = buildLoadoutTools({ loadedTools, allTools: () => allTools })[0]!;

    const out = (await load.execute(
      { names: ["write_extension", "memory_write"] },
      ctx,
    )) as { results: Array<{ name: string; status: string; inputSchema?: unknown }> };

    expect(loadedTools.has("write_extension")).toBe(true);
    expect(loadedTools.has("memory_write")).toBe(true);
    expect(out.results).toHaveLength(2);
    expect(out.results[0]!.status).toBe("loaded");
    expect(out.results[0]!.inputSchema).toEqual(allTools[0]!.inputSchema);
  });

  it("reports unknown names without aborting other loads", async () => {
    const loadedTools = new Set<string>();
    const allTools = [makeTool("real_tool")];
    const load = buildLoadoutTools({ loadedTools, allTools: () => allTools })[0]!;

    const out = (await load.execute(
      { names: ["real_tool", "ghost_tool"] },
      ctx,
    )) as { results: Array<{ name: string; status: string }> };

    expect(loadedTools.has("real_tool")).toBe(true);
    expect(out.results.find((r) => r.name === "ghost_tool")!.status).toBe("unknown");
    expect(out.results.find((r) => r.name === "real_tool")!.status).toBe("loaded");
  });

  it("returns already-loaded for repeat calls", async () => {
    const loadedTools = new Set<string>(["preloaded"]);
    const allTools = [makeTool("preloaded")];
    const load = buildLoadoutTools({ loadedTools, allTools: () => allTools })[0]!;

    const out = (await load.execute({ names: ["preloaded"] }, ctx)) as {
      results: Array<{ name: string; status: string }>;
    };
    expect(out.results[0]!.status).toBe("already-loaded");
  });

  it("returns always-loaded for tools that don't need loading", async () => {
    const loadedTools = new Set<string>();
    const allTools = [makeTool("query_self", true)];
    const load = buildLoadoutTools({ loadedTools, allTools: () => allTools })[0]!;

    const out = (await load.execute({ names: ["query_self"] }, ctx)) as {
      results: Array<{ name: string; status: string }>;
    };
    expect(out.results[0]!.status).toBe("always-loaded");
    expect(loadedTools.has("query_self")).toBe(false);
  });
});

describe("unload_tools", () => {
  it("drops loaded names from the set", async () => {
    const loadedTools = new Set<string>(["a", "b"]);
    const allTools = [makeTool("a"), makeTool("b")];
    const unload = buildLoadoutTools({ loadedTools, allTools: () => allTools })[1]!;

    const out = (await unload.execute({ names: ["a"] }, ctx)) as {
      results: Array<{ name: string; status: string }>;
    };
    expect(loadedTools.has("a")).toBe(false);
    expect(loadedTools.has("b")).toBe(true);
    expect(out.results[0]!.status).toBe("unloaded");
  });

  it("refuses to unload always-loaded tools", async () => {
    const loadedTools = new Set<string>();
    const allTools = [makeTool("query_self", true)];
    const unload = buildLoadoutTools({ loadedTools, allTools: () => allTools })[1]!;

    const out = (await unload.execute({ names: ["query_self"] }, ctx)) as {
      results: Array<{ name: string; status: string }>;
    };
    expect(out.results[0]!.status).toBe("always-loaded");
  });

  it("reports not-loaded for names not in the set", async () => {
    const loadedTools = new Set<string>();
    const allTools = [makeTool("a")];
    const unload = buildLoadoutTools({ loadedTools, allTools: () => allTools })[1]!;

    const out = (await unload.execute({ names: ["a", "ghost"] }, ctx)) as {
      results: Array<{ name: string; status: string }>;
    };
    expect(out.results.find((r) => r.name === "a")!.status).toBe("not-loaded");
    expect(out.results.find((r) => r.name === "ghost")!.status).toBe("not-loaded");
  });
});
