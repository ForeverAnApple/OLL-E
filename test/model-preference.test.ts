// Persistence round-trip for the default-model file. Tiny module, tiny
// test — the value is in pinning the "absent file → fallback" behavior
// so a fresh install doesn't surface NaN/empty-string defaults.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOT_DEFAULT_MODEL,
  fallbackForProvider,
  readDefaultModel,
  writeDefaultModel,
} from "../src/daemon/model-preference.ts";

describe("default-model persistence", () => {
  test("read returns the boot fallback when the file is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "olle-model-"));
    try {
      const file = join(dir, "default_model");
      expect(readDefaultModel(file)).toBe(BOOT_DEFAULT_MODEL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("write then read round-trips, trimming trailing whitespace", () => {
    const dir = mkdtempSync(join(tmpdir(), "olle-model-"));
    try {
      const file = join(dir, "default_model");
      writeDefaultModel(file, "claude-opus-4-7");
      expect(readDefaultModel(file)).toBe("claude-opus-4-7");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("read falls back when the file exists but is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "olle-model-"));
    try {
      const file = join(dir, "default_model");
      writeDefaultModel(file, "");
      expect(readDefaultModel(file, "fallback-model")).toBe("fallback-model");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("boot default is the Anthropic Opus tier", () => {
    expect(BOOT_DEFAULT_MODEL).toBe("claude-opus-4-7");
  });

  test("fallbackForProvider returns the canonical default per provider", () => {
    expect(fallbackForProvider("anthropic")).toBe("claude-opus-4-7");
    expect(fallbackForProvider("openai")).toBe("gpt-5.5");
  });
});
