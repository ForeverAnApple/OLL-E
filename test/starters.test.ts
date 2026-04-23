import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installStarter, listStarters, getStarter } from "../src/starters/index.ts";
import { validateManifest } from "../src/extensions/manifest.ts";
import { history } from "../src/extensions/git.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "olle-starter-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("starter templates", () => {
  it("ships four starters with valid manifests", () => {
    const names = listStarters().map((s) => s.name).sort();
    expect(names).toEqual(["claude-code", "cron-trigger", "discord", "github"]);
    for (const s of listStarters()) {
      const mfRaw = s.files["manifest.json"];
      expect(mfRaw).toBeDefined();
      const mf = JSON.parse(mfRaw!);
      expect(() => validateManifest(mf, s.name)).not.toThrow();
      expect(mf.name).toBe(s.name);
    }
  });

  it("each starter has an index.ts and smoke.ts", () => {
    for (const s of listStarters()) {
      expect(s.files["index.ts"]).toBeDefined();
      expect(s.files["smoke.ts"]).toBeDefined();
    }
  });
});

describe("installStarter", () => {
  it("writes files and git-commits under the given author", () => {
    const r = installStarter({ name: "cron-trigger", extensionsDir: tmp, authorName: "agent-1" });
    expect(r.alreadyExisted).toBe(false);
    expect(r.commit).not.toBeNull();
    expect(existsSync(join(tmp, "cron-trigger", "manifest.json"))).toBe(true);
    const log = history(tmp, "cron-trigger", 5);
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0]!.author).toBe("agent-1");
  });

  it("leaves an existing extension alone by default", () => {
    installStarter({ name: "cron-trigger", extensionsDir: tmp, authorName: "a" });
    const custom = getStarter("cron-trigger")!;
    const r2 = installStarter({ name: "cron-trigger", extensionsDir: tmp, authorName: "a" });
    expect(r2.alreadyExisted).toBe(true);
    expect(r2.filesWritten).toBe(0);
    void custom;
  });

  it("overwrites when overwrite=true", () => {
    installStarter({ name: "cron-trigger", extensionsDir: tmp, authorName: "a" });
    // Corrupt a file
    const p = join(tmp, "cron-trigger", "index.ts");
    require("node:fs").writeFileSync(p, "corrupted");
    installStarter({ name: "cron-trigger", extensionsDir: tmp, authorName: "a", overwrite: true });
    const content = readFileSync(p, "utf8");
    expect(content).not.toBe("corrupted");
  });

  it("rejects unknown starter names", () => {
    expect(() => installStarter({ name: "nope", extensionsDir: tmp })).toThrow(/no such starter/);
  });
});
