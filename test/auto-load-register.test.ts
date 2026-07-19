import { describe, expect, it } from "bun:test";
import { seedExtensionTools, wrapRegisterForAutoLoad } from "../src/agent/chat.ts";
import type { ExtensionHost, ToolDef } from "../src/extensions/index.ts";

// Two seams over chat.ts's per-thread loaded set: wrapRegisterForAutoLoad
// (auto-load an extension's tools at register time) and seedExtensionTools
// (seed a fresh thread with every active extension's tools). Both read the
// same host.tools() surface, so they share one fake.
//
// Minimal fake. Real ExtensionHost has many methods; we only exercise
// the seam these functions read from.
function fakeExtensionHost(opts: {
  toolsByExt: Record<string, ToolDef[]>;
  loaded: string[];
}): ExtensionHost {
  return {
    list: () => [],
    get: (name) =>
      opts.loaded.includes(name)
        ? {
            id: name, // identity per test — extensionId == name
            manifest: { name, version: "0.1.0" },
            path: "/tmp/" + name,
            status: "active",
            failures: 0,
          }
        : undefined,
    discover: async () => [],
    inventory: async () => [],
    load: async () => {
      throw new Error("unused");
    },
    unload: async () => {},
    reload: async () => {
      throw new Error("unused");
    },
    smokeTest: async () => ({ ok: true }),
    reportFailure: () => {},
    attribute: () => undefined,
    tools: () =>
      Object.entries(opts.toolsByExt).flatMap(([extensionId, tools]) =>
        tools.map((tool) => ({ extensionId, tool })),
      ),
    triggers: () => [],
    catalogProse: () => [],
  };
}

const baseTool: ToolDef<{ name: string }, { status: string }> = {
  name: "register_extension",
  description: "register",
  inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  execute: async () => ({ status: "active" }),
};

const ctx = {
  hostId: "h",
  extensionId: "core",
  actorId: "a",
  abort: new AbortController().signal,
  secrets: {},
};

describe("wrapRegisterForAutoLoad", () => {
  it("mutates loadedTools and returns schemas for newly-loaded tools", async () => {
    // The agent paid the cost of write+smoke+register, so the contributed
    // tools land in the calling thread's loadedTools without a separate
    // load_tools hop. Schemas come back in the result so the agent can
    // reason about call shape this turn.
    const loadedTools = new Set<string>();
    const host = fakeExtensionHost({
      loaded: ["my-ext"],
      toolsByExt: {
        "my-ext": [
          {
            name: "ext_tool_a",
            description: "a",
            inputSchema: { type: "object", properties: { x: { type: "number" } } },
            execute: () => "a",
          },
          {
            name: "ext_tool_b",
            description: "b",
            inputSchema: { type: "object", properties: {} },
            execute: () => "b",
          },
        ],
      },
    });
    const wrapped = wrapRegisterForAutoLoad(baseTool, { loadedTools, extensions: host });
    const result = (await wrapped.execute({ name: "my-ext" } as never, ctx)) as {
      status: string;
      autoLoaded: Array<{ name: string; status: string; inputSchema?: Record<string, unknown> }>;
    };

    expect(result.status).toBe("active");
    expect(loadedTools.has("ext_tool_a")).toBe(true);
    expect(loadedTools.has("ext_tool_b")).toBe(true);
    const byName = Object.fromEntries(result.autoLoaded.map((e) => [e.name, e]));
    expect(byName.ext_tool_a?.status).toBe("loaded");
    expect(byName.ext_tool_b?.status).toBe("loaded");
    expect(byName.ext_tool_a?.inputSchema).toEqual({
      type: "object",
      properties: { x: { type: "number" } },
    });
  });

  it("reports already-loaded tools without double-counting", async () => {
    const loadedTools = new Set<string>(["ext_tool_a"]);
    const host = fakeExtensionHost({
      loaded: ["my-ext"],
      toolsByExt: {
        "my-ext": [
          {
            name: "ext_tool_a",
            description: "a",
            inputSchema: { type: "object", properties: {} },
            execute: () => "a",
          },
        ],
      },
    });
    const wrapped = wrapRegisterForAutoLoad(baseTool, { loadedTools, extensions: host });
    const result = (await wrapped.execute({ name: "my-ext" } as never, ctx)) as {
      autoLoaded: Array<{ name: string; status: string }>;
    };
    expect(result.autoLoaded[0]?.status).toBe("already-loaded");
    // Set still has it, but no second insertion (size unchanged).
    expect(loadedTools.size).toBe(1);
  });

  it("reports always-loaded tools as such — never adds them to loadedTools", async () => {
    // Always-loaded tools are sent every turn by the runtime; tracking them
    // in loadedTools would burn a "slot" the agent can't free with unload.
    const loadedTools = new Set<string>();
    const host = fakeExtensionHost({
      loaded: ["my-ext"],
      toolsByExt: {
        "my-ext": [
          {
            name: "always_on",
            description: "always",
            inputSchema: { type: "object", properties: {} },
            alwaysLoaded: true,
            execute: () => "x",
          },
        ],
      },
    });
    const wrapped = wrapRegisterForAutoLoad(baseTool, { loadedTools, extensions: host });
    const result = (await wrapped.execute({ name: "my-ext" } as never, ctx)) as {
      autoLoaded: Array<{ name: string; status: string }>;
    };
    expect(result.autoLoaded[0]?.status).toBe("always-loaded");
    expect(loadedTools.size).toBe(0);
  });

  it("passes through the result unchanged when the extension isn't found", async () => {
    // The underlying register_extension may have failed in a way that
    // returns a result rather than throwing. Don't add an autoLoaded
    // field in that case — the agent should see the underlying shape.
    const loadedTools = new Set<string>();
    const host = fakeExtensionHost({ loaded: [], toolsByExt: {} });
    const wrapped = wrapRegisterForAutoLoad(baseTool, { loadedTools, extensions: host });
    const result = await wrapped.execute({ name: "missing-ext" } as never, ctx);
    expect(result).toEqual({ status: "active" });
    expect(loadedTools.size).toBe(0);
  });
});

const seedTool = (name: string, alwaysLoaded = false): ToolDef => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
  alwaysLoaded,
  execute: () => name,
});

describe("seedExtensionTools", () => {
  // A new thread's loaded set is pre-populated with every active extension's
  // contributed tools, so the agent sees their schemas from turn one instead
  // of re-guessing or re-load_tools-ing an already-installed capability.
  it("seeds the names of every active extension's tools", () => {
    const host = fakeExtensionHost({
      loaded: [],
      toolsByExt: {
        "claude-code": [seedTool("claude_code")],
        github: [seedTool("github_list_issues"), seedTool("github_comment")],
      },
    });
    const loaded = seedExtensionTools(host);
    expect(loaded.has("claude_code")).toBe(true);
    expect(loaded.has("github_list_issues")).toBe(true);
    expect(loaded.has("github_comment")).toBe(true);
    expect(loaded.size).toBe(3);
  });

  it("skips always-loaded tools — they're sent every turn regardless", () => {
    const host = fakeExtensionHost({
      loaded: [],
      toolsByExt: { "my-ext": [seedTool("ext_tool"), seedTool("always_on", true)] },
    });
    const loaded = seedExtensionTools(host);
    expect(loaded.has("ext_tool")).toBe(true);
    expect(loaded.has("always_on")).toBe(false);
    expect(loaded.size).toBe(1);
  });

  it("returns an empty set when there's no extension host", () => {
    expect(seedExtensionTools(undefined).size).toBe(0);
  });

  it("returns an empty set when no extensions are active", () => {
    expect(seedExtensionTools(fakeExtensionHost({ loaded: [], toolsByExt: {} })).size).toBe(0);
  });
});
