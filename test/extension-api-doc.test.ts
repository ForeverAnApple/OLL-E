// The extension API reference is a load-bearing artifact: agents author
// extensions from it alone. This test pins the contracts the doc must carry
// so an edit that drops one fails loudly.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const doc = readFileSync(
  join(import.meta.dir, "../src/extensions/docs/extension-api.md"),
  "utf8",
);
const lines = doc.split("\n");

describe("extension-api.md", () => {
  test("exists with substance: 400 to ~900 lines", () => {
    expect(lines.length).toBeGreaterThanOrEqual(400);
    expect(lines.length).toBeLessThanOrEqual(900);
  });

  test("documents the register(api) entry point", () => {
    expect(doc).toContain("register(api)");
  });

  test("documents every ToolDef field", () => {
    for (const field of [
      "name",
      "description",
      "tier",
      "category",
      "shortClause",
      "alwaysLoaded",
      "inputSchema",
      "validate",
      "sensitiveInputFields",
      "sensitiveOutput",
      "sensitiveOutputFields",
      "maxResultBytes",
      "execute",
    ]) {
      expect(doc).toContain(field);
    }
  });

  test("documents the manifest authority fields", () => {
    expect(doc).toContain("callsTools");
    expect(doc).toContain("eventReads");
    expect(doc).toContain("eventWrites");
  });

  test("documents the manifest catalog field", () => {
    expect(doc).toContain("catalog");
    expect(doc).toContain("tagline");
    expect(doc).toContain("blurb");
  });

  test("lists the five callTool gates in order", () => {
    const allowlist = doc.indexOf("**Allowlist**");
    const existence = doc.indexOf("**Existence**");
    const tier = doc.indexOf("**Tier**");
    const scope = doc.indexOf("**Agent scope**");
    const validation = doc.indexOf("**Input validation**");
    for (const idx of [allowlist, existence, tier, scope, validation]) {
      expect(idx).toBeGreaterThan(-1);
    }
    expect(allowlist).toBeLessThan(existence);
    expect(existence).toBeLessThan(tier);
    expect(tier).toBeLessThan(scope);
    expect(scope).toBeLessThan(validation);
  });

  test("quotes the manifest-gate error strings verbatim from the runtime", () => {
    expect(doc).toContain("add it to manifest.eventReads");
    expect(doc).toContain("add it to manifest.eventWrites");
    expect(doc).toContain("add it to manifest.callsTools");
  });

  test("says a missing smoke is legal for tool-only extensions", () => {
    expect(doc).toContain("tool-only");
    expect(doc).toMatch(/missing `?smoke\.ts`? is legal and passes/i);
  });

  test("documents the delivery-audit bridge convention", () => {
    expect(doc).toContain("delivery.succeeded");
    expect(doc).toContain("delivery.failed");
  });

  test("documents api revocation after unload, verbatim", () => {
    expect(doc).toContain("was unloaded; re-register before acting");
  });

  test("states the no-third-party-deps physics", () => {
    expect(doc).toContain("Bun built-ins + `fetch` + `WebSocket` only");
    expect(doc).toContain("node_modules");
  });

  test("teaches the write -> smoke -> register loop", () => {
    expect(doc).toContain("write_extension");
    expect(doc).toContain("run_smoke_test");
    expect(doc).toContain("register_extension");
    // The loop stated as a sequence at least once.
    expect(doc).toMatch(/write_extension.*run_smoke_test.*register_extension/s);
  });

  test("carries at least 5 fenced ts examples", () => {
    const tsFences = doc.match(/^```ts$/gm) ?? [];
    expect(tsFences.length).toBeGreaterThanOrEqual(5);
  });

  test("documents task namespacing and the smoke signature", () => {
    expect(doc).toContain("ext:<name>:<id>");
    expect(doc).toContain("smokeTest");
  });
});
