import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { buildMetaTools } from "../src/tools/meta.ts";
import type { ExtensionHost } from "../src/extensions/index.ts";
import type { OllePaths } from "../src/paths.ts";

interface HostContextResult {
  process: { cwd: string };
  olle: Partial<OllePaths>;
  extensions: Array<{ tools: string[] }>;
  files: Array<{ path: string; kind: string }>;
  commands: Array<{ command: string; ok: boolean; path?: string | null }>;
  note?: string;
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
        defaultModelFile: join(root, "default_model"),
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
      // A missing command surfaces the point-in-time/daemon-PATH caveat so a
      // stale "not found" can't be mistaken for absolute absence.
      expect(result.note).toContain("daemon's PATH at this instant");

      // When every requested command resolves, the note is omitted entirely —
      // no caveat means no per-call bloat.
      const allFound = (await tool.execute(
        { commands: ["bun"] },
        { hostId: "host", extensionId: "agent-1", actorId: "agent-1", abort: new AbortController().signal, secrets: {} },
      )) as HostContextResult;
      expect(allFound.commands.every((c) => c.ok)).toBe(true);
      expect(allFound.note).toBeUndefined();

      // Resolution walks process.env.PATH in-process — not a spawned `which`,
      // whose child inherits a stale exec-time PATH in a compiled binary and
      // would miss dirs added to process.env.PATH at runtime (the Nix bug,
      // LOG 2026-06-17). An executable reachable only via process.env.PATH must
      // resolve, at the exact path under that dir.
      const onDir = mkdtempSync(join(tmpdir(), "olle-pathon-"));
      const savedPath = process.env.PATH;
      try {
        const bin = join(onDir, "olle-probe-bin");
        writeFileSync(bin, "#!/bin/sh\nexit 0\n");
        chmodSync(bin, 0o755);
        process.env.PATH = `${onDir}${delimiter}${savedPath ?? ""}`;
        const probed = (await tool.execute(
          { commands: ["olle-probe-bin"] },
          { hostId: "host", extensionId: "agent-1", actorId: "agent-1", abort: new AbortController().signal, secrets: {} },
        )) as HostContextResult;
        const hit = probed.commands.find((c) => c.command === "olle-probe-bin")!;
        expect(hit.ok).toBe(true);
        expect(hit.path).toBe(bin);
      } finally {
        process.env.PATH = savedPath;
        rmSync(onDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
