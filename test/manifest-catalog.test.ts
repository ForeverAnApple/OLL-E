import { describe, expect, it } from "bun:test";
import {
  validateManifest,
  validateManifestWithWarnings,
} from "../src/extensions/manifest.ts";

describe("validateManifestWithWarnings", () => {
  it("warns on an unknown key and drops it", () => {
    // The classic typo: `eventRead` (singular) silently gates nothing.
    const { manifest, warnings } = validateManifestWithWarnings(
      { name: "x", version: "0.1.0", eventRead: ["chat.turn-end"] },
      "x",
    );
    expect(warnings).toContain('manifest[x]: unknown key "eventRead" (ignored)');
    expect(manifest).not.toHaveProperty("eventRead");
  });

  it("does not warn on `config` or `catalog`", () => {
    const { warnings } = validateManifestWithWarnings(
      {
        name: "x",
        version: "0.1.0",
        config: { url: "https://example.com" },
        catalog: { tagline: "t", blurb: "b" },
      },
      "x",
    );
    expect(warnings).toEqual([]);
  });

  it("parses a well-formed catalog into the manifest", () => {
    const { manifest } = validateManifestWithWarnings(
      {
        name: "x",
        version: "0.1.0",
        catalog: { tagline: "t", blurb: "b", tools: { x_tool: "clause" } },
      },
      "x",
    );
    expect(manifest.catalog).toEqual({ tagline: "t", blurb: "b", tools: { x_tool: "clause" } });
  });

  it("does not parse `config` into the manifest even though it is a known key", () => {
    const { manifest } = validateManifestWithWarnings(
      { name: "x", version: "0.1.0", config: { url: "u" } },
      "x",
    );
    expect(manifest).not.toHaveProperty("config");
  });

  it("warns and drops a malformed catalog (missing tagline)", () => {
    const { manifest, warnings } = validateManifestWithWarnings(
      { name: "x", version: "0.1.0", catalog: { blurb: "b" } },
      "x",
    );
    expect(warnings.some((w) => w.includes("catalog is malformed"))).toBe(true);
    expect(manifest.catalog).toBeUndefined();
  });

  it("still throws on a genuinely invalid manifest", () => {
    expect(() => validateManifest({ version: "0.1.0" }, "x")).toThrow(/invalid name/);
    expect(() => validateManifest({ name: "x" }, "x")).toThrow(/version required/);
    expect(() => validateManifest("not-an-object", "x")).toThrow(/not an object/);
  });

  it("validateManifest is a throwing wrapper that discards warnings", () => {
    // An unknown key is a warning, not a throw — the wrapper still returns.
    const mf = validateManifest({ name: "x", version: "0.1.0", bogus: 1 }, "x");
    expect(mf.name).toBe("x");
  });
});
