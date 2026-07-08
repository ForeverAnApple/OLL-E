import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubSecrets } from "../src/agent/redaction.ts";
import { createSecretsProvider } from "../src/agent/secrets-provider.ts";

describe("scrubSecrets", () => {
  it("redacts every occurrence of a known value with its name", () => {
    const secrets = new Map([["API_KEY", "supersecretvalue"]]);
    const out = scrubSecrets("a supersecretvalue b supersecretvalue", secrets);
    expect(out).toBe("a [redacted:API_KEY] b [redacted:API_KEY]");
  });

  it("leaves values under the 8-char floor untouched", () => {
    const secrets = new Map([["PIN", "1234"]]);
    expect(scrubSecrets("pin is 1234", secrets)).toBe("pin is 1234");
  });

  it("is a no-op when no value appears", () => {
    const secrets = new Map([["API_KEY", "supersecretvalue"]]);
    expect(scrubSecrets("nothing here", secrets)).toBe("nothing here");
  });
});

describe("createSecretsProvider", () => {
  it("reads secret files and picks up a mid-session write", () => {
    const dir = mkdtempSync(join(tmpdir(), "olle-secrets-"));
    try {
      writeFileSync(join(dir, "TOKEN_A"), "first-value-long");
      const provider = createSecretsProvider(dir);
      expect(provider().get("TOKEN_A")).toBe("first-value-long");

      // Overwrite in place — the mtime signature must trigger a reload.
      // A tiny sleep guarantees a distinct mtime on coarse filesystems.
      const t = Date.now() + 5;
      while (Date.now() < t) {
        /* spin briefly so mtime advances */
      }
      writeFileSync(join(dir, "TOKEN_A"), "second-value-long");
      expect(provider().get("TOKEN_A")).toBe("second-value-long");

      // Non-secret-shaped names (e.g. a team/ dir or lowercase file) ignored.
      writeFileSync(join(dir, "lowercase"), "ignored");
      expect(provider().has("lowercase")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty map when the dir does not exist", () => {
    const provider = createSecretsProvider(join(tmpdir(), "olle-nope-" + Date.now()));
    expect(provider().size).toBe(0);
  });
});
