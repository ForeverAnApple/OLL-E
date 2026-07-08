import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMetaTools, normalizeFiles } from "../src/tools/meta.ts";
import { ensureRepo, git } from "../src/extensions/git.ts";
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Mirrors the real freshrss smoke gate: reads the working-tree manifest and
// fails if config.url is empty — the exact error the live incident produced.
function workingTreeSmokeHost(extensionsDir: string): ExtensionHost {
  const host = mockExtensions();
  host.smokeTest = async (name: string) => {
    const manifestPath = join(extensionsDir, name, "manifest.json");
    if (!existsSync(manifestPath)) return { ok: false, error: "manifest missing" };
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      config?: { url?: string };
    };
    const url = manifest.config?.url ?? "";
    if (!url) return { ok: false, error: "manifest.config.url is empty" };
    return { ok: true };
  };
  return host;
}

const CTX = {
  hostId: "host",
  extensionId: "agent-1",
  actorId: "agent-1",
  abort: new AbortController().signal,
  secrets: {},
};

const NEW_MANIFEST = JSON.stringify(
  { name: "freshrss", version: "0.1.0", config: { url: "https://rss.davec.xyz" } },
  null,
  2,
);

// Regression for the live incident: an agent's write landed in git history with
// the new content while the WORKING TREE kept the old — because `files` arrived
// as a JSON string and Object.entries iterated it character-by-character,
// spraying files named 0,1,2,… and never touching manifest.json. The tool
// reported a commit; reads/smoke/register saw the stale file.
describe("write_extension — working tree matches the reported commit", () => {
  function seed() {
    const root = mkdtempSync(join(tmpdir(), "olle-writeext-"));
    const extDir = join(root, "extensions");
    mkdirSync(extDir, { recursive: true });
    ensureRepo(extDir);
    // Starter install left a manifest with an empty url on disk + in git.
    mkdirSync(join(extDir, "freshrss"), { recursive: true });
    writeFileSync(
      join(extDir, "freshrss", "manifest.json"),
      JSON.stringify({ name: "freshrss", version: "0.1.0", config: { url: "" } }, null, 2),
    );
    git(extDir, ["add", "-A"]);
    git(extDir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"]);
    return { root, extDir };
  }

  function tools(extDir: string) {
    return buildMetaTools({
      extensions: workingTreeSmokeHost(extDir),
      extensionsDir: extDir,
      authorName: "agent-1",
    });
  }

  function assertClean(extDir: string) {
    // The bug's fingerprint: files named 0,1,2,… one byte each.
    const entries = readdirSync(join(extDir, "freshrss"));
    const junk = entries.filter((e) => /^\d+$/.test(e));
    expect(junk).toEqual([]);
    // Working tree == committed content.
    const wt = readFileSync(join(extDir, "freshrss", "manifest.json"), "utf8");
    const head = git(extDir, ["show", "HEAD:freshrss/manifest.json"]).stdout;
    expect(wt).toBe(head);
    expect(JSON.parse(wt).config.url).toBe("https://rss.davec.xyz");
  }

  it("array-of-{path,content} form updates the file on disk", async () => {
    const { root, extDir } = seed();
    try {
      const write = tools(extDir).find((t) => t.name === "write_extension")!;
      const res = (await write.execute(
        { name: "freshrss", files: [{ path: "manifest.json", content: NEW_MANIFEST }] },
        CTX,
      )) as { commit: string | null };
      expect(res.commit).toBeTruthy();
      assertClean(extDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("double-encoded JSON-string files (the live bug) is recovered, not char-sprayed", async () => {
    const { root, extDir } = seed();
    try {
      const t = tools(extDir);
      const write = t.find((tt) => tt.name === "write_extension")!;
      const readFile = t.find((tt) => tt.name === "read_extension_file")!;
      const smoke = t.find((tt) => tt.name === "run_smoke_test")!;

      // Exactly what the LLM emitted on the wire: the whole `files` argument as
      // a JSON string.
      const res = (await write.execute(
        {
          name: "freshrss",
          files: JSON.stringify([{ path: "manifest.json", content: NEW_MANIFEST }]),
        },
        CTX,
      )) as { commit: string | null };

      expect(res.commit).toBeTruthy();
      assertClean(extDir);

      // read_extension_file agrees with disk.
      const read = (await readFile.execute(
        { name: "freshrss", path: "manifest.json" },
        CTX,
      )) as { content: string };
      expect(JSON.parse(read.content).config.url).toBe("https://rss.davec.xyz");

      // A reload smoke (reads the working tree) now passes.
      const smokeRes = (await smoke.execute({ name: "freshrss" }, CTX)) as {
        ok: boolean;
        error?: string;
      };
      expect(smokeRes.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unrecoverable garbage without writing or committing", async () => {
    const { root, extDir } = seed();
    try {
      const write = tools(extDir).find((t) => t.name === "write_extension")!;
      const before = git(extDir, ["rev-parse", "HEAD"]).stdout.trim();
      await expect(
        write.execute({ name: "freshrss", files: "not json at all" }, CTX),
      ).rejects.toThrow(/files must be/);
      // Nothing written, nothing committed.
      expect(readdirSync(join(extDir, "freshrss"))).toEqual(["manifest.json"]);
      expect(git(extDir, ["rev-parse", "HEAD"]).stdout.trim()).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("normalizeFiles", () => {
  it("accepts the documented path→content map", () => {
    expect(normalizeFiles({ "manifest.json": "{}" })).toEqual({ "manifest.json": "{}" });
  });
  it("accepts the array-of-{path,content} form", () => {
    expect(normalizeFiles([{ path: "a.ts", content: "x" }])).toEqual({ "a.ts": "x" });
  });
  it("recovers a JSON string of either form", () => {
    expect(normalizeFiles('{"a":"1"}')).toEqual({ a: "1" });
    expect(normalizeFiles('[{"path":"a","content":"1"}]')).toEqual({ a: "1" });
  });
  it("rejects a bare non-JSON string instead of iterating its characters", () => {
    expect(() => normalizeFiles("hello")).toThrow(/files must be/);
  });
  it("rejects non-string content values", () => {
    expect(() => normalizeFiles({ a: 1 as unknown as string })).toThrow(/must be a string/);
    expect(() => normalizeFiles([{ path: "a", content: 1 as unknown as string }])).toThrow(
      /content must be a string/,
    );
  });
});
