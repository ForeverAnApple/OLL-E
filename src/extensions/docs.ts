// Ships the embedded extension API reference to the data dir at boot.
//
// The contract agents read before authoring an extension lives in the binary
// (Bun text import, embedded for `bun build --compile`). At boot we materialize
// it to `<extensionsDir>/.docs/extension-api.md` so `read_extension_file` can
// serve it like any other habitat file, and commit the change into the same
// git repo that tracks every extension write. Idempotent: only the boot that
// actually changes the file writes and commits.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitSubtree } from "./git.ts";
// The `with { type: "text" }` import attribute (declared in ./docs/md.d.ts)
// embeds the .md as a string so the compiled binary carries the contract.
import apiDoc from "./docs/extension-api.md" with { type: "text" };

/** The subtree the docs live under, relative to the extensions dir. Leading
 *  dot keeps it out of extension-name space — no extension can be named
 *  `.docs` (write_extension's name regex rejects a leading dot). */
export const DOCS_SUBPATH = ".docs";
const DOC_FILENAME = "extension-api.md";

/** Write the embedded extension API reference to `<extensionsDir>/.docs/` if it
 *  differs from what's on disk, then commit under the olle host identity.
 *  Returns whether the file changed and the resulting commit sha (null when
 *  nothing changed — the common warm-boot case). */
export function syncExtensionDocs(
  extensionsDir: string,
): { updated: boolean; commit: string | null } {
  const docsDir = join(extensionsDir, DOCS_SUBPATH);
  const docPath = join(docsDir, DOC_FILENAME);

  const current = existsSync(docPath) ? readFileSync(docPath, "utf8") : null;
  if (current === apiDoc) return { updated: false, commit: null };

  mkdirSync(docsDir, { recursive: true });
  writeFileSync(docPath, apiDoc);

  const commit = commitSubtree({
    cwd: extensionsDir,
    subpath: DOCS_SUBPATH,
    message: "docs: sync extension API reference",
    authorName: "olle",
  });
  return { updated: true, commit };
}
