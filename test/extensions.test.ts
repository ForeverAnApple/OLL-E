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
            parameters: { parse: (x) => x },
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
            parameters: { parse: (x) => x },
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
            parameters: { parse: (x) => x },
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
            parameters: { parse: (x) => x },
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
