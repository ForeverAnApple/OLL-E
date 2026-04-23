import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitSubtree, ensureRepo } from "../extensions/git.ts";
import { getStarter, listStarters } from "./templates.ts";

export interface InstallStarterResult {
  name: string;
  path: string;
  commit: string | null;
  filesWritten: number;
  alreadyExisted: boolean;
}

/** Install a named starter into the extensions directory.
 *
 * - If the dir already exists, we leave it alone (agent-modified copies
 *   trump the shipped template). Return alreadyExisted=true so the caller
 *   can decide whether to replace.
 * - Otherwise write the template files, ensure the git repo, and commit
 *   under authorName so provenance is preserved. */
export function installStarter(opts: {
  name: string;
  extensionsDir: string;
  authorName?: string;
  overwrite?: boolean;
}): InstallStarterResult {
  const tpl = getStarter(opts.name);
  if (!tpl) throw new Error(`no such starter: ${opts.name}`);
  ensureRepo(opts.extensionsDir);
  const dir = join(opts.extensionsDir, tpl.name);
  const alreadyExisted = existsSync(dir);
  if (alreadyExisted && !opts.overwrite) {
    return { name: tpl.name, path: dir, commit: null, filesWritten: 0, alreadyExisted: true };
  }
  mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const [rel, body] of Object.entries(tpl.files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body, "utf8");
    written++;
  }
  const commit = commitSubtree({
    cwd: opts.extensionsDir,
    subpath: tpl.name,
    message: `install starter: ${tpl.name}`,
    authorName: opts.authorName ?? "olle",
  });
  return { name: tpl.name, path: dir, commit, filesWritten: written, alreadyExisted };
}

export { listStarters, getStarter };
