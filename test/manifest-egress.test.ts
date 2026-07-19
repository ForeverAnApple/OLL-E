import { describe, expect, it } from "bun:test";
import { validateManifestWithWarnings } from "../src/extensions/manifest.ts";

const base = { name: "demo", version: "1.0.0" };

describe("manifest egress + requiresHost parsing", () => {
  it("parses a well-formed egress array", () => {
    const { manifest, warnings } = validateManifestWithWarnings({
      ...base,
      egress: [
        { hosts: ["api.telegram.org"], secrets: ["TELEGRAM_BOT_TOKEN"] },
        { hosts: ["*.discord.gg"], secrets: ["DISCORD_TOKEN"], mode: "guest" },
        { hosts: ["example.org"] },
      ],
    });
    expect(warnings).toEqual([]);
    expect(manifest.egress).toHaveLength(3);
    expect(manifest.egress?.[0]).toEqual({ hosts: ["api.telegram.org"], secrets: ["TELEGRAM_BOT_TOKEN"] });
    expect(manifest.egress?.[1]?.mode).toBe("guest");
    expect(manifest.egress?.[2]).toEqual({ hosts: ["example.org"] });
  });

  it("defaults mode to undefined (placeholder) and drops a bad mode", () => {
    const { manifest } = validateManifestWithWarnings({
      ...base,
      egress: [{ hosts: ["h"], mode: "weird" }],
    });
    expect(manifest.egress?.[0]?.mode).toBeUndefined();
  });

  it("drops a malformed entry with a warning but keeps valid ones", () => {
    const { manifest, warnings } = validateManifestWithWarnings({
      ...base,
      egress: [{ hosts: ["good.com"] }, { hosts: [] }, { secrets: ["X"] }, "nope"],
    });
    expect(manifest.egress).toHaveLength(1);
    expect(manifest.egress?.[0]?.hosts).toEqual(["good.com"]);
    expect(warnings.filter((w) => w.includes("egress"))).toHaveLength(3);
  });

  it("warns and drops when egress is not an array", () => {
    const { manifest, warnings } = validateManifestWithWarnings({ ...base, egress: { hosts: ["x"] } });
    expect(manifest.egress).toBeUndefined();
    expect(warnings.some((w) => w.includes("egress must be an array"))).toBe(true);
  });

  it("parses requiresHost boolean and warns on a non-boolean", () => {
    expect(validateManifestWithWarnings({ ...base, requiresHost: true }).manifest.requiresHost).toBe(true);
    const bad = validateManifestWithWarnings({ ...base, requiresHost: "yes" });
    expect(bad.manifest.requiresHost).toBeUndefined();
    expect(bad.warnings.some((w) => w.includes("requiresHost"))).toBe(true);
  });

  it("does not warn on egress/requiresHost as known keys", () => {
    const { warnings } = validateManifestWithWarnings({
      ...base,
      egress: [{ hosts: ["a"] }],
      requiresHost: false,
    });
    expect(warnings.some((w) => w.includes("unknown key"))).toBe(false);
  });
});
