// Thin wrapper over `git` for the extensions directory. Every agent write
// turns into a commit, so `olle extension history <name>` is just git log
// scoped to that subtree and revert is `git checkout <sha> -- <subtree>`.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[]): GitResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

export function ensureRepo(dir: string): void {
  if (existsSync(join(dir, ".git"))) return;
  const init = git(dir, ["init", "-q", "-b", "main"]);
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  // Minimal identity so commits don't fail on hosts without ~/.gitconfig.
  git(dir, ["config", "user.email", "olle@localhost"]);
  git(dir, ["config", "user.name", "olle"]);
  // Seed commit so `git log -- <path>` on first write has a history.
  git(dir, ["commit", "--allow-empty", "-q", "-m", "init extensions"]);
}

export interface CommitOptions {
  cwd: string;
  subpath: string; // relative — the extension dir
  message: string;
  authorName: string; // agent id or principal id
  authorEmail?: string;
}

export function commitSubtree(opts: CommitOptions): string | null {
  const { cwd, subpath, message, authorName, authorEmail } = opts;
  const email = authorEmail ?? `${authorName}@olle`;
  const add = git(cwd, ["add", "--", subpath]);
  if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}`);
  // Check if there are staged changes.
  const diff = git(cwd, ["diff", "--cached", "--quiet"]);
  if (diff.status === 0) return null; // nothing staged
  const commit = git(cwd, [
    "-c",
    `user.name=${authorName}`,
    "-c",
    `user.email=${email}`,
    "commit",
    "-q",
    "-m",
    message,
  ]);
  if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
  const sha = git(cwd, ["rev-parse", "HEAD"]);
  return sha.stdout.trim();
}

export interface HistoryEntry {
  sha: string;
  author: string;
  date: number;
  subject: string;
}

export function history(cwd: string, subpath: string, limit = 50): HistoryEntry[] {
  const r = git(cwd, [
    "log",
    `-n${limit}`,
    "--format=%H%x1f%an%x1f%at%x1f%s",
    "--",
    subpath,
  ]);
  if (r.status !== 0) return [];
  const out: HistoryEntry[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const [sha, author, date, subject] = line.split("\x1f");
    if (!sha) continue;
    out.push({
      sha,
      author: author ?? "",
      date: Number.parseInt(date ?? "0", 10) * 1000,
      subject: subject ?? "",
    });
  }
  return out;
}

export function revertSubtree(
  cwd: string,
  subpath: string,
  sha: string,
  authorName: string,
): string | null {
  const co = git(cwd, ["checkout", sha, "--", subpath]);
  if (co.status !== 0) throw new Error(`git checkout failed: ${co.stderr}`);
  return commitSubtree({
    cwd,
    subpath,
    message: `revert ${subpath} to ${sha.slice(0, 8)}`,
    authorName,
  });
}
