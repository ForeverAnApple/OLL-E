import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncExtensionDocs, DOCS_SUBPATH } from "../src/extensions/docs.ts";
import { ensureRepo, git, history } from "../src/extensions/git.ts";

const DOC_REL = join(DOCS_SUBPATH, "extension-api.md");

describe("syncExtensionDocs", () => {
  it("writes and commits the embedded contract on first boot", () => {
    const dir = mkdtempSync(join(tmpdir(), "olle-docs-"));
    try {
      ensureRepo(dir);
      const res = syncExtensionDocs(dir);
      const docPath = join(dir, DOC_REL);
      expect(existsSync(docPath)).toBe(true);
      expect(res.updated).toBe(true);
      expect(res.commit).toBeTruthy();
      // The .docs commit is authored under the olle host identity.
      const log = history(dir, DOCS_SUBPATH);
      expect(log[0]!.author).toBe("olle");
      expect(log[0]!.sha).toBe(res.commit!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op on the second boot (idempotent)", () => {
    const dir = mkdtempSync(join(tmpdir(), "olle-docs-"));
    try {
      ensureRepo(dir);
      syncExtensionDocs(dir);
      const second = syncExtensionDocs(dir);
      expect(second.updated).toBe(false);
      expect(second.commit).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rewrites and recommits when the on-disk file diverged (binary wins)", () => {
    const dir = mkdtempSync(join(tmpdir(), "olle-docs-"));
    try {
      ensureRepo(dir);
      const first = syncExtensionDocs(dir);
      const docPath = join(dir, DOC_REL);
      const embedded = readFileSync(docPath, "utf8");

      // Simulate a divergence that landed in git history (an agent's bad edit
      // auto-committed). A merely-uncommitted edit, once restored, matches HEAD
      // and correctly produces no new commit; a committed divergence is the
      // case that must be re-flattened at boot.
      writeFileSync(docPath, "hand-edited garbage");
      git(dir, ["add", "-A"]);
      git(dir, ["-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "-m", "bad edit"]);

      const res = syncExtensionDocs(dir);
      expect(res.updated).toBe(true);
      expect(res.commit).toBeTruthy();
      expect(res.commit).not.toBe(first.commit);
      // The embedded content overwrote the local edit.
      expect(readFileSync(docPath, "utf8")).toBe(embedded);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
