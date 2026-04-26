import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMetaTools } from "../src/tools/meta.ts";
import type { ExtensionHost } from "../src/extensions/index.ts";
import type { OllePaths } from "../src/paths.ts";

interface HostContextResult {
  process: { cwd: string };
  olle: Partial<OllePaths>;
  extensions: Array<{ tools: string[] }>;
  files: Array<{ path: string; kind: string }>;
  commands: Array<{ command: string; ok: boolean }>;
}

function mockExtensions(): ExtensionHost {
  return {
    list: () => [
      {
        id: "ext-1",
        manifest: { name: "demo", version: "0.1.0" },
        path: "/tmp/demo",
        status: "active",
        failures: 0,
      },
    ],
    get: () => undefined,
    discover: async () => [],
    load: async () => {
      throw new Error("unused");
    },
    unload: async () => {},
    reload: async () => {
      throw new Error("unused");
    },
    smokeTest: async () => ({ ok: true }),
    inventory: async () => [],
    reportFailure: () => {},
    attribute: () => undefined,
    tools: () => [
      {
        extensionId: "ext-1",
        tool: {
          name: "demo_tool",
          description: "demo",
          inputSchema: {},
          execute: () => "ok",
        },
      },
    ],
    triggers: () => [],
  };
}

describe("meta tools", () => {
  it("query_host_context surfaces paths, extension tools, and command availability", async () => {
    const root = mkdtempSync(join(tmpdir(), "olle-meta-"));
    try {
      const paths = {
        root,
        dbFile: join(root, "olle.db"),
        configFile: join(root, "config.toml"),
        extensionsDir: join(root, "extensions"),
        goalsDir: join(root, "goals"),
        memoryDir: join(root, "memory"),
        logsDir: join(root, "logs"),
        logFile: join(root, "logs", "olle.log"),
        runDir: join(root, "run"),
        socketFile: join(root, "run", "olle.sock"),
        pidFile: join(root, "run", "olle.pid"),
        secretsDir: join(root, "secrets"),
        threadsDir: join(root, "threads"),
      };
      const tools = buildMetaTools({
        extensions: mockExtensions(),
        extensionsDir: paths.extensionsDir,
        authorName: "agent-1",
        paths,
      });
      const tool = tools.find((t) => t.name === "query_host_context")!;
      const result = (await tool.execute(
        { commands: ["bun", "definitely-not-olle-command"] },
        {
          hostId: "host",
          extensionId: "agent-1",
          actorId: "agent-1",
          abort: new AbortController().signal,
          secrets: {},
        },
      )) as HostContextResult;

      expect(result.olle.root).toBe(root);
      expect(result.process.cwd).toBe(process.cwd());
      expect(result.extensions[0]!.tools).toEqual(["demo_tool"]);
      expect(result.commands.find((c) => c.command === "bun")!.ok).toBe(true);
      expect(result.commands.find((c) => c.command === "definitely-not-olle-command")!.ok).toBe(false);
      expect(result.files.find((f) => f.path === root)!.kind).toBe("dir");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
