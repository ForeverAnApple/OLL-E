import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { eq } from "drizzle-orm";
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

  it("requires manifest.eventWrites before publishing events", async () => {
    const r = rig();
    writeExt(tmp, "talker", {
      manifest: { name: "talker", version: "0.1.0" },
      index: `
        export function register(api) {
          api.publish("chat.input", { text: "hi" }, { durable: true });
        }
      `,
    });
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await expect(host.load("talker")).rejects.toThrow(/manifest\.eventWrites/);
  });

  it("requires manifest.eventReads before subscribing to events", async () => {
    const r = rig();
    writeExt(tmp, "listener", {
      manifest: { name: "listener", version: "0.1.0" },
      index: `
        export function register(api) {
          api.on("chat.input", () => {});
        }
      `,
    });
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await expect(host.load("listener")).rejects.toThrow(/manifest\.eventReads/);
  });

  it("allows declared event reads and writes", async () => {
    const r = rig();
    const seen: unknown[] = [];
    r.bus.subscribe("listener.seen", (ev) => {
      seen.push(ev.payload);
    });
    writeExt(tmp, "listener", {
      manifest: {
        name: "listener",
        version: "0.1.0",
        eventReads: ["chat.input"],
        eventWrites: ["listener.seen"],
      },
      index: `
        export function register(api) {
          api.on("chat.input", (ev) => {
            api.publish("listener.seen", { text: ev.payload.text }, { durable: true });
          });
        }
      `,
    });
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await host.load("listener");
    r.bus.publish({
      type: "chat.input",
      payload: { text: "hello" },
      hostId: r.hostId,
      actorId: "test",
      durable: true,
    });
    expect(seen).toEqual([{ text: "hello" }]);
  });

  it("treats a trigger declaration as the authority statement for its type", async () => {
    const r = rig();
    const seen: unknown[] = [];
    r.bus.subscribe("tick", (ev) => {
      seen.push(ev.payload);
    });
    writeExt(tmp, "trigger", {
      manifest: { name: "trigger", version: "0.1.0" },
      index: `
        export function register(api) {
          api.registerTrigger({
            name: "ticker",
            type: "tick",
            start(emit) {
              emit({ ok: true });
            },
          });
        }
      `,
    });
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await host.load("trigger");
    expect(seen).toEqual([{ ok: true }]);
  });

  it("rolls back partial registration when load fails after registerTool", async () => {
    const r = rig();
    writeExt(tmp, "halfway", {
      manifest: { name: "halfway", version: "0.1.0" },
      index: `
        export function register(api) {
          api.registerTool({
            name: "halfway_tool",
            description: "registered just before the throw",
            inputSchema: { type: "object" },
            execute: () => "ok",
          });
          throw new Error("boom mid-register");
        }
      `,
    });
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await expect(host.load("halfway")).rejects.toThrow(/boom mid-register/);
    expect(host.tools().find((t) => t.tool.name === "halfway_tool")).toBeUndefined();
    const row = r.store
      .select()
      .from(tables.extensions)
      .where(eq(tables.extensions.name, "halfway"))
      .all()[0];
    expect(row?.status).toBe("inactive");
  });

  it("unsubscribes listeners attached before a mid-register throw", async () => {
    const r = rig();
    let observed = 0;
    r.bus.subscribe("chat.input", () => {
      // sentinel — this listener stays for the whole test, separate from
      // the one the extension installs. Used only to confirm publish
      // actually reaches the bus.
    });
    writeExt(tmp, "leaky", {
      manifest: {
        name: "leaky",
        version: "0.1.0",
        eventReads: ["chat.input"],
      },
      index: `
        export function register(api) {
          api.on("chat.input", () => { globalThis.__leakyHits = (globalThis.__leakyHits ?? 0) + 1; });
          throw new Error("boom after subscribe");
        }
      `,
    });
    (globalThis as unknown as { __leakyHits?: number }).__leakyHits = 0;
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await expect(host.load("leaky")).rejects.toThrow(/boom after subscribe/);

    r.bus.publish({
      type: "chat.input",
      payload: { text: "after-failed-load" },
      hostId: r.hostId,
      actorId: "test",
      durable: true,
    });
    observed = (globalThis as unknown as { __leakyHits: number }).__leakyHits;
    expect(observed).toBe(0);
  });

  it("does not stack listeners across repeated failed loads", async () => {
    const r = rig();
    writeExt(tmp, "stacker", {
      manifest: {
        name: "stacker",
        version: "0.1.0",
        eventReads: ["chat.input"],
      },
      index: `
        export function register(api) {
          api.on("chat.input", () => { globalThis.__stackerHits = (globalThis.__stackerHits ?? 0) + 1; });
          throw new Error("always boom");
        }
      `,
    });
    (globalThis as unknown as { __stackerHits?: number }).__stackerHits = 0;
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    for (let i = 0; i < 4; i++) {
      await expect(host.load("stacker")).rejects.toThrow(/always boom/);
    }
    r.bus.publish({
      type: "chat.input",
      payload: { text: "hi" },
      hostId: r.hostId,
      actorId: "test",
      durable: true,
    });
    expect((globalThis as unknown as { __stackerHits: number }).__stackerHits).toBe(0);
  });

  it("registerTool is first-wins on name collision", async () => {
    const r = rig();
    writeExt(tmp, "first", {
      index: `
        export function register(api) {
          api.registerTool({
            name: "shared",
            description: "first registrant",
            inputSchema: { type: "object" },
            execute: () => "first",
          });
        }
      `,
    });
    writeExt(tmp, "second", {
      index: `
        export function register(api) {
          api.registerTool({
            name: "shared",
            description: "second registrant",
            inputSchema: { type: "object" },
            execute: () => "second",
          });
        }
      `,
    });
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await host.load("first");
    await host.load("second");
    const all = host.tools().filter((t) => t.tool.name === "shared");
    expect(all).toHaveLength(1);
    expect(all[0]!.tool.description).toBe("first registrant");
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

  it("smokeTest re-reads source after edits — no ESM cache stickiness", async () => {
    const r = rig();
    writeExt(tmp, "iterate", {
      index: `export function register() {}`,
      smoke: `export async function smokeTest() { throw new Error("v1"); }`,
    });
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    const first = await host.smokeTest("iterate");
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error).toMatch(/v1/);

    writeFileSync(
      join(tmp, "iterate", "smoke.ts"),
      `export async function smokeTest() { throw new Error("v2"); }`,
    );
    const second = await host.smokeTest("iterate");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/v2/);

    writeFileSync(
      join(tmp, "iterate", "smoke.ts"),
      `export async function smokeTest() { return; }`,
    );
    const third = await host.smokeTest("iterate");
    expect(third.ok).toBe(true);
  });

  it("smokeTest reports missing extension dir without throwing", async () => {
    const r = rig();
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    const result = await host.smokeTest("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found on disk/);
  });
});

describe("inventory", () => {
  it("surfaces registered, unregistered, and broken extensions", async () => {
    const r = rig();
    writeExt(tmp, "loaded-ext", {
      index: `export function register() {}`,
    });
    writeExt(tmp, "unloaded-ext", {
      index: `export function register() {}`,
    });
    // Broken: manifest exists but is invalid JSON.
    const brokenDir = join(tmp, "broken-ext");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "manifest.json"), "{ not-valid json");

    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await host.load("loaded-ext");

    const inv = await host.inventory();
    const byName = Object.fromEntries(inv.map((e) => [e.name, e]));
    expect(byName["loaded-ext"]?.status).toBe("registered");
    expect(byName["unloaded-ext"]?.status).toBe("unregistered");
    // Broken-manifest entries are surfaced under the directory name (the
    // manifest can't be trusted to give a name) with an error attached.
    expect(byName["broken-ext"]?.status).toBe("broken");
    expect(byName["broken-ext"]?.error).toBeDefined();
  });

  it("ignores hidden dirs and bare directories without a manifest", async () => {
    const r = rig();
    // Hidden dir — the .git dir would otherwise leak through.
    mkdirSync(join(tmp, ".git"), { recursive: true });
    // Random scratch dir without a manifest — not yet an extension.
    mkdirSync(join(tmp, "scratchpad"), { recursive: true });
    writeExt(tmp, "real", { index: `export function register() {}` });

    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    const inv = await host.inventory();
    expect(inv.map((e) => e.name)).toEqual(["real"]);
  });

  it("marks manifest-name mismatches as broken under the directory name", async () => {
    const r = rig();
    writeExt(tmp, "actual-dir", {
      manifest: { name: "advertised-name", version: "0.1.0" },
      index: `export function register() {}`,
    });
    writeExt(tmp, "advertised-name", {
      index: `export function register() {}`,
    });

    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await host.load("advertised-name");

    const inv = await host.inventory();
    const byPath = Object.fromEntries(inv.map((e) => [e.path, e]));
    const mismatch = byPath[join(tmp, "actual-dir")]!;
    expect(mismatch.name).toBe("actual-dir");
    expect(mismatch.status).toBe("broken");
    expect(mismatch.error).toMatch(/manifest name "advertised-name" != dir "actual-dir"/);
    expect(inv.filter((e) => e.name === "advertised-name")).toHaveLength(1);
    expect(inv.find((e) => e.name === "advertised-name")?.status).toBe("registered");
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

  describe("attribute()", () => {
    it("returns the extension name for a frame inside the extensions dir", async () => {
      const r = rig();
      writeExt(tmp, "alpha", { index: `export function register() {}` });
      const host = createExtensionHost({ ...r, extensionsDir: tmp });
      await host.load("alpha");
      const err = new Error("synthetic");
      err.stack = `Error: synthetic\n    at fn (${join(tmp, "alpha", "index.ts")}:5:3)`;
      expect(host.attribute(err)).toBe("alpha");
    });

    it("returns the extension name for a frame inside the staging dir", async () => {
      const r = rig();
      writeExt(tmp, "beta", { index: `export function register() {}` });
      const host = createExtensionHost({ ...r, extensionsDir: tmp });
      await host.load("beta");
      // Synthesize a stack frame matching the staging path the runtime
      // copies extensions into. Shape: <tmpdir>/olle-stage-<host>/<name>/<ulid>/index.ts.
      const stagingPath = join(tmpdir(), `olle-stage-${r.hostId}`, "beta", "01ABC", "index.ts");
      const err = new Error("synthetic");
      err.stack = `Error: synthetic\n    at fn (${stagingPath}:7:1)`;
      expect(host.attribute(err)).toBe("beta");
    });

    it("returns undefined when no frame falls inside an extension", async () => {
      const r = rig();
      const host = createExtensionHost({ ...r, extensionsDir: tmp });
      const err = new Error("synthetic");
      err.stack = `Error: synthetic\n    at fn (/usr/local/lib/node_modules/something/index.js:1:1)`;
      expect(host.attribute(err)).toBeUndefined();
    });

    it("does not attribute to extensions that are not currently loaded", async () => {
      const r = rig();
      // On-disk dir exists, but never loaded — a stale stack frame must
      // not fire reportFailure on a name the host doesn't know.
      writeExt(tmp, "gamma", { index: `export function register() {}` });
      const host = createExtensionHost({ ...r, extensionsDir: tmp });
      const err = new Error("synthetic");
      err.stack = `Error: synthetic\n    at fn (${join(tmp, "gamma", "index.ts")}:1:1)`;
      expect(host.attribute(err)).toBeUndefined();
    });

    it("handles non-Error throws gracefully", async () => {
      const r = rig();
      const host = createExtensionHost({ ...r, extensionsDir: tmp });
      expect(host.attribute("a string")).toBeUndefined();
      expect(host.attribute(undefined)).toBeUndefined();
      expect(host.attribute({ stack: 42 })).toBeUndefined();
    });
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
