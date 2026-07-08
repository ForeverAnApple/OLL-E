import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installStarter, listStarters, getStarter } from "../src/starters/index.ts";
import { validateManifest } from "../src/extensions/manifest.ts";
import { history } from "../src/extensions/git.ts";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { createExtensionHost } from "../src/extensions/index.ts";
import { ulid } from "../src/id/index.ts";
import { openStore, tables } from "../src/store/index.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "olle-starter-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("starter templates", () => {
  it("ships the expected starters with valid manifests", () => {
    const names = listStarters().map((s) => s.name).sort();
    expect(names).toEqual([
      "claude-code",
      "cron-trigger",
      "discord",
      "discord-communication",
      "github",
      "telegram",
      "telegram-communication",
    ]);
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

  it("broad external write tools declare strategic tier", () => {
    const claude = getStarter("claude-code")!.files["index.ts"]!;
    expect(claude).toMatch(/name: "claude_code"[\s\S]*?tier: "strategic"/);

    const discord = getStarter("discord")!.files["index.ts"]!;
    expect(discord).toMatch(/name: "discord_react"[\s\S]*?tier: "strategic"/);

    const github = getStarter("github")!.files["index.ts"]!;
    for (const name of ["github_create_issue", "github_add_comment", "github_close_issue"]) {
      expect(github).toMatch(new RegExp(`name: "${name}"[\\s\\S]*?tier: "strategic"`));
    }
  });

  it("discord template ships hardened reconnect/resume + 429 handling", () => {
    const discord = getStarter("discord")!.files["index.ts"]!;
    // RESUME support: capture the resume gateway url and send op-6 RESUME.
    expect(discord).toContain("resume_gateway_url");
    expect(discord).toContain("UNRESUMABLE_CLOSE_CODES");
    // Heartbeat-ACK zombie detection.
    expect(discord).toContain("awaitingAck");
    // Bounded 429 retry reading retry_after.
    expect(discord).toContain("retry_after");
    // The old TODO markers must be gone — the gaps are closed.
    expect(discord).not.toContain("TODO(agent): exponential backoff");
    expect(discord).not.toContain("TODO(agent): on 429");
  });

  it("discord-communication derives standing-job routes at all three outbound sites", () => {
    // No fake-ExtensionApi harness exists in test/, and hand-rolling one that
    // loads the bridge module + a fake discord_send is disproportionate for a
    // string-template starter. String-level assertion instead: the critical
    // correctness point is that getOrDeriveRoute is applied at all three
    // outbound sites (assistant-text accumulator, tool-call dedup, turn-end
    // send) — deriving only at turn-end silently no-ops because the
    // accumulator never fills.
    const bridge = getStarter("discord-communication")!.files["index.ts"]!;
    expect(bridge).toContain("function getOrDeriveRoute");
    // Once at each of the three handlers plus the definition = 4 references.
    const uses = bridge.match(/getOrDeriveRoute\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(4);
    // Loose prefix contract + derived-route eviction.
    expect(bridge).toContain("DISCORD_THREAD_RE");
    expect(bridge).toContain("derivedRoutes");
    expect(bridge).toContain("evictDerived");
  });

  it("telegram-communication derives standing-job routes at all three outbound sites", () => {
    const bridge = getStarter("telegram-communication")!.files["index.ts"]!;
    expect(bridge).toContain("function getOrDeriveRoute");
    const uses = bridge.match(/getOrDeriveRoute\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(4);
    expect(bridge).toContain("TELEGRAM_THREAD_RE");
    expect(bridge).toContain("derivedRoutes");
    expect(bridge).toContain("evictDerived");
    // Must ignore non-telegram channel-message traffic sharing the bus.
    expect(bridge).toContain('msg.source !== "telegram"');
  });

  it("cron-trigger unload clears its interval", async () => {
    installStarter({ name: "cron-trigger", extensionsDir: tmp, authorName: "a" });
    const manifestPath = join(tmp, "cron-trigger", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.config.intervalMs = 20;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const store = openStore({ path: ":memory:" });
    const hostId = ulid();
    store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
    const bus = createBus({ hostId, persist: persistToStore(store) });
    let ticks = 0;
    bus.subscribe("cron.fire", () => {
      ticks += 1;
    });
    const host = createExtensionHost({ bus, store, hostId, extensionsDir: tmp });
    try {
      await host.load("cron-trigger");
      await new Promise((resolve) => setTimeout(resolve, 55));
      expect(ticks).toBeGreaterThanOrEqual(1);
      await host.unload("cron-trigger");
      const afterUnload = ticks;
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(ticks).toBe(afterUnload);
    } finally {
      await host.unload("cron-trigger");
      bus.close();
      store.close();
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
