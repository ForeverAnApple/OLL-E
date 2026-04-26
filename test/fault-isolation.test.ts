import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import { createExtensionHost } from "../src/extensions/index.ts";
import { installFaultIsolation } from "../src/daemon/fault-isolation.ts";

function rig() {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  return { store, bus, hostId };
}

function writeExt(root: string, name: string, index: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ name, version: "0.1.0", description: "test ext" }, null, 2),
  );
  writeFileSync(join(dir, "index.ts"), index);
  return dir;
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "olle-fault-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("installFaultIsolation", () => {
  it("routes attributable uncaughtException into reportFailure", async () => {
    const r = rig();
    writeExt(tmp, "noisy", `export function register() {}`);
    const host = createExtensionHost({
      ...r,
      extensionsDir: tmp,
      failureThreshold: 2,
      failureWindowMs: 10_000,
    });
    await host.load("noisy");

    const events: Array<{ type: string; payload: unknown }> = [];
    r.bus.subscribe("*", (e) => void events.push({ type: e.type, payload: e.payload }));

    const fi = installFaultIsolation({ host, log: () => {} });
    try {
      const err = new Error("boom");
      err.stack = `Error: boom\n    at fn (${join(tmp, "noisy", "index.ts")}:1:1)`;
      // Manually invoke the listener so the test isn't process-fatal.
      // Bun raises uncaughtException synchronously to listeners; emit
      // gives us the same delivery without crashing on the default
      // listener if our handler weren't installed.
      process.emit("uncaughtException", err);

      const failures = events.filter((e) => e.type === "extension.failure");
      expect(failures).toHaveLength(1);
      expect((failures[0]!.payload as { name: string }).name).toBe("noisy");
    } finally {
      fi.uninstall();
    }
  });

  it("trips the breaker and marks crashed on threshold", async () => {
    const r = rig();
    writeExt(tmp, "doomed", `export function register() {}`);
    const host = createExtensionHost({
      ...r,
      extensionsDir: tmp,
      failureThreshold: 2,
      failureWindowMs: 10_000,
    });
    await host.load("doomed");

    const events: string[] = [];
    r.bus.subscribe("*", (e) => void events.push(e.type));

    const fi = installFaultIsolation({ host, log: () => {} });
    try {
      const stack = `Error: x\n    at fn (${join(tmp, "doomed", "index.ts")}:1:1)`;
      const err1 = new Error("one"); err1.stack = stack;
      const err2 = new Error("two"); err2.stack = stack;
      process.emit("uncaughtException", err1);
      process.emit("uncaughtException", err2);
      // unload is async
      await new Promise((res) => setTimeout(res, 20));
      expect(events).toContain("extension.crashed");
      const row = r.store.raw
        .query<{ status: string }, [string]>("SELECT status FROM extensions WHERE name = ?")
        .get("doomed");
      expect(row?.status).toBe("crashed");
    } finally {
      fi.uninstall();
    }
  });

  it("logs but does not throw for unattributed errors", async () => {
    const r = rig();
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    const captured: Array<{ msg: string; err: unknown }> = [];
    const fi = installFaultIsolation({
      host,
      log: (msg, err) => void captured.push({ msg, err }),
    });
    try {
      const err = new Error("orphan");
      err.stack = `Error: orphan\n    at fn (/usr/local/something/else.js:1:1)`;
      process.emit("uncaughtException", err);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.msg).toContain("orphan");
    } finally {
      fi.uninstall();
    }
  });

  it("routes unhandledRejection through the same path", async () => {
    const r = rig();
    writeExt(tmp, "rejecter", `export function register() {}`);
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    await host.load("rejecter");

    const events: string[] = [];
    r.bus.subscribe("*", (e) => void events.push(e.type));

    const fi = installFaultIsolation({ host, log: () => {} });
    try {
      const err = new Error("async-boom");
      err.stack = `Error: async-boom\n    at fn (${join(tmp, "rejecter", "index.ts")}:1:1)`;
      process.emit("unhandledRejection", err, Promise.reject(err).catch(() => {}));
      expect(events).toContain("extension.failure");
    } finally {
      fi.uninstall();
    }
  });

  it("uninstall removes the listeners", () => {
    const r = rig();
    const host = createExtensionHost({ ...r, extensionsDir: tmp });
    const before = process.listenerCount("uncaughtException");
    const fi = installFaultIsolation({ host, log: () => {} });
    expect(process.listenerCount("uncaughtException")).toBe(before + 1);
    fi.uninstall();
    expect(process.listenerCount("uncaughtException")).toBe(before);
  });
});
