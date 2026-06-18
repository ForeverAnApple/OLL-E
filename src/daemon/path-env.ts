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

/** Resolve the login shell's PATH via `<shell> -lc 'printf %s "$PATH"'`.
 *  Returns null on any failure (missing shell, timeout, non-zero exit) so the
 *  caller falls back to the inherited PATH rather than breaking boot. */
function probeLoginPath(
  shell: string,
): string | null {
  try {
    const r = spawnSync(shell, ["-lc", 'printf %s "$PATH"'], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (r.status !== 0 || !r.stdout) return null;
    const p = r.stdout.trim();
    return p.length > 0 ? p : null;
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
 *  the dirs that were newly added, for logging/observability. */
export function enrichPathFromLoginShell(
  opts: EnrichPathOptions = {},
): { changed: boolean; added: string[] } {
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
  if (!loginPath) return { changed: false, added: [] };

  const { path, added } = mergeLoginPath(env.PATH ?? "", loginPath);
  if (added.length === 0) return { changed: false, added: [] };
  env.PATH = path;
  return { changed: true, added };
}
