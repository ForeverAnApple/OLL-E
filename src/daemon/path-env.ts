// Make the daemon see the user's *real* PATH.
//
// When launchd (macOS) or systemd (Linux) starts the daemon, it hands it a
// stripped environment — typically PATH=/usr/bin:/bin:/usr/sbin:/sbin. That
// omits wherever the user actually installed their tools: Nix profiles
// (/etc/profiles/per-user/<u>/bin, /run/current-system/sw/bin), Homebrew
// (/opt/homebrew/bin), asdf, ~/.local/bin. The agent then reports "claude not
// on PATH" and subprocess extensions can't spawn it — even though `which
// claude` works fine in the user's shell. A false constraint born of a
// stripped environment; VISION says limits should be real, not artifacts.
//
// Fix: once at process start, ask the user's *login* shell for its PATH and
// merge the new entries into process.env.PATH. Login shells source the profile
// files where every ecosystem (Nix/Homebrew/asdf/...) registers its bin dir,
// so this is robust without hardcoding any one of them. Everything downstream
// inherits process.env.PATH unchanged — `query_host_context`'s `which`, the
// starter templates' resolveCommand, and the spawned subprocess — so a single
// enrichment at the entry point fixes the whole class.

import { spawnSync } from "node:child_process";

/** Pure merge: login-shell dirs take precedence (honoring the user's own
 *  resolution order), followed by any dirs the daemon already had that the
 *  login shell didn't list. Deduped, order-preserving. */
export function mergeLoginPath(
  currentPath: string,
  loginPath: string,
): { path: string; added: string[] } {
  const current = currentPath.split(":").filter(Boolean);
  const login = loginPath.split(":").filter(Boolean);
  const loginSet = new Set(login);
  const added = login.filter((d) => !current.includes(d));
  if (added.length === 0) return { path: currentPath, added: [] };
  const merged = [...login, ...current.filter((d) => !loginSet.has(d))];
  return { path: merged.join(":"), added };
}

// Login shells routinely print to stdout from their profiles (nvm banners,
// oh-my-zsh, a bare `echo` in .zshrc, MOTD). We can't suppress that, so we
// fence the PATH behind a sentinel and read only what follows the *last* one.
// `$PATH` can't contain this string, so the fence is unambiguous; if it's
// absent the output is untrustworthy and we fail closed rather than splice
// profile noise into PATH.
const PATH_SENTINEL = "@@OLLE_PATH@@";

/** Extract the PATH from a probe's raw stdout, discarding any profile noise
 *  printed before the sentinel. Returns null if the sentinel is missing (the
 *  printf never ran, or output is unusable) or the PATH is empty. */
export function parseProbeOutput(stdout: string): string | null {
  const idx = stdout.lastIndexOf(PATH_SENTINEL);
  if (idx === -1) return null;
  const p = stdout.slice(idx + PATH_SENTINEL.length).trim();
  return p.length > 0 ? p : null;
}

/** Resolve the login shell's PATH via `<shell> -lc 'printf %s "<sentinel>$PATH"'`.
 *  Returns null on any failure (missing shell, timeout, non-zero exit, sentinel
 *  absent) so the caller falls back to the inherited PATH rather than breaking
 *  boot or corrupting PATH with profile output. */
function probeLoginPath(
  shell: string,
): string | null {
  try {
    const r = spawnSync(shell, ["-lc", `printf %s "${PATH_SENTINEL}$PATH"`], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (r.status !== 0 || !r.stdout) return null;
    return parseProbeOutput(r.stdout);
  } catch {
    return null;
  }
}

export interface EnrichPathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Injectable for tests — given the shell path, return its PATH (or null). */
  probe?: (shell: string) => string | null;
}

/** Enrich `env.PATH` in place from the login shell. Idempotent: a second call
 *  (or a daemon already started from a full-PATH shell) adds nothing. Returns
 *  the dirs newly added plus `probed` — false when the shell probe itself
 *  failed (missing shell, timeout, sentinel absent), so a caller can tell a
 *  genuine no-op (`probed:true, changed:false`) from a defeated probe and log
 *  the latter instead of silently leaving PATH stripped. */
export function enrichPathFromLoginShell(
  opts: EnrichPathOptions = {},
): { changed: boolean; added: string[]; probed: boolean } {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const probe = opts.probe ?? probeLoginPath;

  // launchd may not pass SHELL; fall back to the system default.
  const shell =
    env.SHELL && env.SHELL.length > 0
      ? env.SHELL
      : platform === "darwin"
        ? "/bin/zsh"
        : "/bin/sh";

  const loginPath = probe(shell);
  if (!loginPath) return { changed: false, added: [], probed: false };

  const { path, added } = mergeLoginPath(env.PATH ?? "", loginPath);
  if (added.length === 0) return { changed: false, added: [], probed: true };
  env.PATH = path;
  return { changed: true, added, probed: true };
}
