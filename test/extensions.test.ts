import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import {
  commitSubtree,
  createExtensionHost,
  ensureRepo,
  history,
  revertSubtree,
} from "../src/extensions/index.ts";

function rig() {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  return { store, bus, hostId };
}

function writeExt(root: string, name: string, opts: {
  manifest?: Record<string, unknown>;
  index?: string;
  smoke?: string;
}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify(
      opts.manifest ?? { name, version: "0.1.0", description: "test ext" },
      null,
      2,
    ),
  );
  if (opts.index)
    writeFileSync(join(dir, "index.ts"), opts.index);
  if (opts.smoke)
    writeFileSync(join(dir, "smoke.ts"), opts.smoke);
  return dir;
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "olle-ext-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("manifest validation", () => {
  it("loads a minimal extension", async () => {
    const r = rig();
    writeExt(tmp, "hello", {
      index: `
        export function register(api) {
          api.registerTool({
            name: "echo",
            description: "echo",
            inputSchema: { type: "object" },
            execute: (args) => args,
          });
        }
      `,
    });
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    const ext = await host.load("hello");
    expect(ext.manifest.name).toBe("hello");
    expect(ext.status).toBe("active");
    expect(host.tools()).toHaveLength(1);
  });

  it("preserves a rich inputSchema from extension to host.tools()", async () => {
    // Guards the host↔extension boundary: whatever JSON Schema the
    // extension authors must flow through unmodified so the LLM sees
    // exactly what the author intended. No library identity required.
    const r = rig();
    writeExt(tmp, "schema-bearer", {
      index: `
        export function register(api) {
          api.registerTool({
            name: "create_issue",
            description: "open an issue",
            inputSchema: {
              type: "object",
              properties: {
                repo: { type: "string", description: "owner/name" },
                title: { type: "string" },
                labels: { type: "array", items: { type: "string" } },
              },
              required: ["repo", "title"],
              additionalProperties: false,
            },
            execute: (args) => args,
          });
        }
      `,
    });
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await host.load("schema-bearer");
    const tools = host.tools();
    expect(tools).toHaveLength(1);
    const schema = tools[0]!.tool.inputSchema as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.type).toBe("object");
    expect(schema.properties.repo).toEqual({ type: "string", description: "owner/name" });
    expect(schema.properties.labels).toEqual({ type: "array", items: { type: "string" } });
    expect(schema.required).toEqual(["repo", "title"]);
  });

  it("runs a validator supplied by the extension", async () => {
    // An extension may ship any validator it likes (zod, hand-rolled,
    // nothing). The host calls it once per tool_use before execute.
    const r = rig();
    writeExt(tmp, "with-validator", {
      index: `
        export function register(api) {
          api.registerTool({
            name: "upper",
            description: "upper",
            inputSchema: {
              type: "object",
              properties: { s: { type: "string" } },
              required: ["s"],
            },
            validate(input) {
              if (typeof input?.s !== "string") throw new Error("s must be a string");
              return { s: input.s.toUpperCase() };
            },
            execute: ({ s }) => s,
          });
        }
      `,
    });
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await host.load("with-validator");
    const { tool } = host.tools()[0]!;
    expect(tool.validate).toBeInstanceOf(Function);
    const validated = tool.validate!({ s: "hello" }) as { s: string };
    expect(validated).toEqual({ s: "HELLO" });
    expect(() => tool.validate!({})).toThrow(/must be a string/);
  });

  it("defaults a missing inputSchema to an empty object schema", async () => {
    // A stale extension authored against an older API shape (e.g.
    // zod-parameters-only) must not brick the chat loop. Runtime fills
    // in a placeholder schema and logs a warning.
    const r = rig();
    writeExt(tmp, "stale", {
      manifest: { name: "stale", version: "0.1.0" },
      // No inputSchema — the bug we guard against.
      index: `
        export function register(api) {
          api.registerTool({
            name: "stale_tool",
            description: "a tool authored before the schema refactor",
            execute: () => "still runs",
          });
        }
      `,
    });
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await host.load("stale");
    const entry = host.tools().find((t) => t.tool.name === "stale_tool");
    expect(entry).toBeDefined();
    expect(entry!.tool.inputSchema).toEqual({ type: "object" });
  });

  it("rejects a name mismatch", async () => {
    const r = rig();
    writeExt(tmp, "correct-dir", {
      manifest: { name: "wrong-name", version: "0.1.0" },
      index: `export function register() {}`,
    });
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await expect(host.load("correct-dir")).rejects.toThrow(/name/);
  });
});

describe("smoke gate", () => {
  it("fails to load when smokeTest throws", async () => {
    const r = rig();
    writeExt(tmp, "broken", {
      index: `export function register() {}`,
      smoke: `export async function smokeTest() { throw new Error("nope"); }`,
    });
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await expect(host.load("broken")).rejects.toThrow(/nope/);
  });

  it("passes through when smokeTest succeeds", async () => {
    const r = rig();
    writeExt(tmp, "ok", {
      index: `export function register() {}`,
      smoke: `export async function smokeTest() { return; }`,
    });
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    const ext = await host.load("ok");
    expect(ext.status).toBe("active");
  });
});

describe("hot reload + failure tracking", () => {
  it("reload picks up new code", async () => {
    const r = rig();
    const dir = writeExt(tmp, "reload-me", {
      index: `
        export function register(api) {
          api.registerTool({
            name: "v1",
            description: "",
            inputSchema: { type: "object" },
            execute: () => "v1",
          });
        }
      `,
    });
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await host.load("reload-me");
    expect(host.tools().map((t) => t.tool.name)).toEqual(["v1"]);

    writeFileSync(
      join(dir, "index.ts"),
      `
        export function register(api) {
          api.registerTool({
            name: "v2",
            description: "",
            inputSchema: { type: "object" },
            execute: () => "v2",
          });
        }
      `,
    );
    await host.reload("reload-me");
    expect(host.tools().map((t) => t.tool.name)).toEqual(["v2"]);
  });

  it("auto-disables after repeated failures", async () => {
    const r = rig();
    writeExt(tmp, "flaky", {
      index: `export function register() {}`,
    });
    const host = createExtensionHost({
      ...r,
      extensionsDir: tmp,
      failureThreshold: 2,
      failureWindowMs: 10_000,
    });
    await host.load("flaky");
    const events: string[] = [];
    r.bus.subscribe("*", (e) => void events.push(e.type));
    host.reportFailure("flaky", new Error("boom"));
    expect(host.get("flaky")?.status).toBe("active");
    host.reportFailure("flaky", new Error("boom"));
    // unload is async; wait a tick
    await new Promise((res) => setTimeout(res, 20));
    expect(events).toContain("extension.crashed");
    expect(host.get("flaky")).toBeUndefined();
    const row = r.store.raw
      .query<{ status: string }, [string]>("SELECT status FROM extensions WHERE name = ?")
      .get("flaky");
    expect(row?.status).toBe("crashed");
  });
});

describe("git-backed rollback", () => {
  it("commits on write and revert restores prior content", () => {
    ensureRepo(tmp);
    const dir = writeExt(tmp, "gitty", {
      index: `export const v = 1;`,
    });
    const sha1 = commitSubtree({
      cwd: tmp,
      subpath: "gitty",
      message: "init gitty",
      authorName: "agent-1",
    });
    expect(sha1).not.toBeNull();

    writeFileSync(join(dir, "index.ts"), `export const v = 2;`);
    const sha2 = commitSubtree({
      cwd: tmp,
      subpath: "gitty",
      message: "bump",
      authorName: "agent-1",
    });
    expect(sha2).not.toBeNull();

    const hist = history(tmp, "gitty", 10);
    expect(hist.length).toBeGreaterThanOrEqual(2);

    revertSubtree(tmp, "gitty", sha1!, "principal");
    const content = require("node:fs").readFileSync(join(dir, "index.ts"), "utf8");
    expect(content).toBe(`export const v = 1;`);
  });

  it("commit is a no-op when nothing changed", () => {
    ensureRepo(tmp);
    writeExt(tmp, "stable", {
      index: `export const v = 1;`,
    });
    commitSubtree({ cwd: tmp, subpath: "stable", message: "init", authorName: "a" });
    const sha2 = commitSubtree({ cwd: tmp, subpath: "stable", message: "noop", authorName: "a" });
    expect(sha2).toBeNull();
  });
});

describe("cross-extension callTool", () => {
  // Common rig: two extensions, "callee" registers echo_b, "caller"
  // registers run_cross which invokes api.callTool. Both secrets
  // declared so we can verify isolation.
  async function loadPair(
    callerManifest: Record<string, unknown>,
    calleeToolDef?: string,
  ) {
    const r = rig();
    writeExt(tmp, "callee", {
      manifest: { name: "callee", version: "0.1.0", secrets: ["TOK"] },
      index: `
        export function register(api) {
          api.registerTool({
            name: "echo_b",
            description: "",
            inputSchema: { type: "object" },
            ${calleeToolDef ?? ""}
            execute: (args, ctx) => ({
              echoed: args,
              actorId: ctx.actorId,
              extensionId: ctx.extensionId,
              seesTok: ctx.secrets.TOK ?? null,
              seesCallerSecret: ctx.secrets.SECRET_A ?? null,
            }),
          });
        }
      `,
    });
    writeExt(tmp, "caller", {
      manifest: { name: "caller", version: "0.1.0", secrets: ["SECRET_A"], ...callerManifest },
      index: `
        export function register(api) {
          api.registerTool({
            name: "run_cross",
            description: "",
            inputSchema: { type: "object" },
            execute: async (args) => api.callTool("echo_b", args),
          });
        }
      `,
    });
    const host = createExtensionHost({
      ...r,
      extensionsDir: tmp,
      secrets: (name, ext) => {
        if (name === "TOK" && ext === "callee") return "token-b";
        if (name === "SECRET_A" && ext === "caller") return "secret-a-val";
        return undefined;
      },
    });
    await host.load("callee");
    await host.load("caller");
    return { r, host };
  }

  async function invokeCross(host: ReturnType<typeof createExtensionHost>, r: ReturnType<typeof rig>, args: unknown) {
    const runCross = host.tools().find((t) => t.tool.name === "run_cross");
    if (!runCross) throw new Error("run_cross not found");
    return runCross.tool.execute(args as never, {
      hostId: r.hostId,
      extensionId: "outer",
      actorId: "outer",
      abort: new AbortController().signal,
      secrets: {},
    });
  }

  it("honors the allowlist and isolates secrets across extensions", async () => {
    const { r, host } = await loadPair({ callsTools: ["echo_b"] });
    const result = (await invokeCross(host, r, { hello: "world" })) as {
      echoed: unknown;
      actorId: string;
      extensionId: string;
      seesTok: string | null;
      seesCallerSecret: string | null;
    };
    // Input flowed through unchanged.
    expect(result.echoed).toEqual({ hello: "world" });
    // Target's ctx.extensionId is callee's id; ctx.actorId is caller's id.
    const callerId = host.get("caller")!.id;
    const calleeId = host.get("callee")!.id;
    expect(result.extensionId).toBe(calleeId);
    expect(result.actorId).toBe(callerId);
    // Callee sees its OWN secret, and NOT the caller's. Secret isolation
    // is the load-bearing security property of callTool.
    expect(result.seesTok).toBe("token-b");
    expect(result.seesCallerSecret).toBeNull();
  });

  it("rejects the call when the tool is not on the caller's allowlist", async () => {
    const { r, host } = await loadPair({}); // no callsTools declared
    await expect(invokeCross(host, r, {})).rejects.toThrow(/manifest\.callsTools/);
  });

  it("rejects the call when the allowlisted tool doesn't exist", async () => {
    const r = rig();
    writeExt(tmp, "lonely", {
      manifest: { name: "lonely", version: "0.1.0", callsTools: ["nobody_home"] },
      index: `
        export function register(api) {
          api.registerTool({
            name: "run",
            description: "",
            inputSchema: { type: "object" },
            execute: () => api.callTool("nobody_home", {}),
          });
        }
      `,
    });
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await host.load("lonely");
    const tool = host.tools()[0]!.tool;
    await expect(
      tool.execute({} as never, {
        hostId: r.hostId,
        extensionId: "outer",
        actorId: "outer",
        abort: new AbortController().signal,
        secrets: {},
      }),
    ).rejects.toThrow(/not registered/);
  });

  it("rejects strategic-tier tools — they must route through the inbox", async () => {
    const r = rig();
    writeExt(tmp, "strat-target", {
      manifest: { name: "strat-target", version: "0.1.0" },
      index: `
        export function register(api) {
          api.registerTool({
            name: "dangerous",
            description: "",
            tier: "strategic",
            inputSchema: { type: "object" },
            execute: () => "should not run",
          });
        }
      `,
    });
    writeExt(tmp, "would-be-caller", {
      manifest: { name: "would-be-caller", version: "0.1.0", callsTools: ["dangerous"] },
      index: `
        export function register(api) {
          api.registerTool({
            name: "try",
            description: "",
            inputSchema: { type: "object" },
            execute: () => api.callTool("dangerous", {}),
          });
        }
      `,
    });
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await host.load("strat-target");
    await host.load("would-be-caller");
    const tool = host.tools().find((t) => t.tool.name === "try")!.tool;
    await expect(
      tool.execute({} as never, {
        hostId: r.hostId,
        extensionId: "outer",
        actorId: "outer",
        abort: new AbortController().signal,
        secrets: {},
      }),
    ).rejects.toThrow(/strategic/);
  });

  it("aborts the target via ctx.abort when the call times out", async () => {
    const r = rig();
    writeExt(tmp, "slowpoke", {
      manifest: { name: "slowpoke", version: "0.1.0" },
      index: `
        export function register(api) {
          api.registerTool({
            name: "sleep",
            description: "",
            inputSchema: { type: "object" },
            execute: (_args, ctx) => new Promise((_resolve, reject) => {
              const t = setTimeout(() => _resolve("done"), 1000);
              ctx.abort.addEventListener("abort", () => {
                clearTimeout(t);
                reject(new Error("aborted by ctx"));
              });
            }),
          });
        }
      `,
    });
    writeExt(tmp, "hasty", {
      manifest: { name: "hasty", version: "0.1.0", callsTools: ["sleep"] },
      index: `
        export function register(api) {
          api.registerTool({
            name: "run",
            description: "",
            inputSchema: { type: "object" },
            execute: () => api.callTool("sleep", {}, { timeoutMs: 30 }),
          });
        }
      `,
    });
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await host.load("slowpoke");
    await host.load("hasty");
    const tool = host.tools().find((t) => t.tool.name === "run")!.tool;
    await expect(
      tool.execute({} as never, {
        hostId: r.hostId,
        extensionId: "outer",
        actorId: "outer",
        abort: new AbortController().signal,
        secrets: {},
      }),
    ).rejects.toThrow(/aborted by ctx/);
  });

  it("respects acting-agent scope when asAgent is threaded", async () => {
    // An agent row with denyTools=[echo_b] must block callTool even when
    // the caller's manifest allowlist permits it. Agent scope is the
    // sharper tool — the allowlist is about the relationship between
    // extensions; scope is about the authority of the acting agent.
    const r = rig();
    const agentId = "narrow-agent";
    r.store
      .insert(tables.agents)
      .values({
        id: agentId,
        name: "narrow",
        hostId: r.hostId,
        scope: { denyTools: ["echo_b"] },
        createdAt: Date.now(),
      })
      .run();

    writeExt(tmp, "callee", {
      manifest: { name: "callee", version: "0.1.0" },
      index: `
        export function register(api) {
          api.registerTool({
            name: "echo_b",
            description: "",
            inputSchema: { type: "object" },
            execute: (args) => args,
          });
        }
      `,
    });
    writeExt(tmp, "caller", {
      manifest: { name: "caller", version: "0.1.0", callsTools: ["echo_b"] },
      index: `
        export function register(api) {
          api.registerTool({
            name: "run_as_agent",
            description: "",
            inputSchema: { type: "object" },
            execute: async () => api.callTool("echo_b", {}, { asAgent: "narrow-agent" }),
          });
        }
      `,
    });
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await host.load("callee");
    await host.load("caller");
    const tool = host.tools().find((t) => t.tool.name === "run_as_agent")!.tool;
    await expect(
      tool.execute({} as never, {
        hostId: r.hostId,
        extensionId: "outer",
        actorId: "outer",
        abort: new AbortController().signal,
        secrets: {},
      }),
    ).rejects.toThrow(/denied by scope of agent "narrow-agent"/);
  });

  it("emits a durable tool.called event tagging caller + target for audit", async () => {
    const { r, host } = await loadPair({ callsTools: ["echo_b"] });
    const called: Array<{ caller: string; targetExtension: string; tool: string; ok: boolean }> = [];
    r.bus.subscribe("tool.called", (ev) => {
      called.push(ev.payload as typeof called[number]);
    });
    await invokeCross(host, r, { ping: 1 });
    expect(called).toHaveLength(1);
    expect(called[0]).toMatchObject({
      caller: "caller",
      targetExtension: "callee",
      tool: "echo_b",
      ok: true,
    });
  });
});

describe("secrets + scratch dir", () => {
  it("injects declared secrets into the api", async () => {
    const r = rig();
    writeExt(tmp, "secret-ext", {
      manifest: { name: "secret-ext", version: "0.1.0", secrets: ["TOKEN"] },
      index: `
        export function register(api) {
          api.registerTool({
            name: "reveal",
            description: "",
            inputSchema: { type: "object" },
            execute: () => api.secrets.TOKEN,
          });
        }
      `,
    });
    const host = createExtensionHost({
      ...r,
      extensionsDir: tmp,
      secrets: (name, ext) => (name === "TOKEN" && ext === "secret-ext" ? "t0p-s3cr3t" : undefined),
    });
    await host.load("secret-ext");
    expect(host.tools()).toHaveLength(1);
    expect(existsSync(join(tmp, "secret-ext", ".scratch"))).toBe(true);
  });
});
