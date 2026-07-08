import { describe, expect, it } from "bun:test";
import { seedExtensionTools } from "../src/agent/chat.ts";
import type { ExtensionHost, ToolDef } from "../src/extensions/index.ts";

// A new thread's loaded set is pre-populated with every active extension's
// contributed tools, so the agent sees their schemas from turn one instead
// of re-guessing or re-load_tools-ing an already-installed capability every
// session. Mirrors the auto-load-register harness — only the tools() seam
// matters here.
function fakeExtensionHost(toolsByExt: Record<string, ToolDef[]>): ExtensionHost {
  return {
    list: () => [],
    get: () => undefined,
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
      Object.entries(toolsByExt).flatMap(([extensionId, tools]) =>
        tools.map((tool) => ({ extensionId, tool })),
      ),
    triggers: () => [],
  };
}

const tool = (name: string, alwaysLoaded = false): ToolDef => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
  alwaysLoaded,
  execute: () => name,
});

describe("seedExtensionTools", () => {
  it("seeds the names of every active extension's tools", () => {
    const host = fakeExtensionHost({
      "claude-code": [tool("claude_code")],
      github: [tool("github_list_issues"), tool("github_comment")],
    });
    const loaded = seedExtensionTools(host);
    expect(loaded.has("claude_code")).toBe(true);
    expect(loaded.has("github_list_issues")).toBe(true);
    expect(loaded.has("github_comment")).toBe(true);
    expect(loaded.size).toBe(3);
  });

  it("skips always-loaded tools — they're sent every turn regardless", () => {
    const host = fakeExtensionHost({
      "my-ext": [tool("ext_tool"), tool("always_on", true)],
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
    expect(seedExtensionTools(fakeExtensionHost({})).size).toBe(0);
  });
});
