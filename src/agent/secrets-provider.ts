// Reads all host-scoped secret name→value pairs off disk so tool results
// can be scrubbed of raw secret bytes (see scrubSecrets). A cheap per-file
// mtime+size signature gates re-reads: a `set_secret` mid-session rewrites
// a file (updating its mtime), so the next scrub picks up the new value
// without paying a directory read on every tool call. One provider is
// memoized per secretsDir; the signature is what actually decides a reload.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Mirror set_secret's name shape (src/tools/meta.ts) so the team/ subdir
// and any stray non-secret files are ignored.
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export type SecretsProvider = () => Map<string, string>;

/** Build a provider that returns the current secret name→value map, reading
 *  from disk only when the file set or any file's mtime/size changed. The
 *  returned map is shared (not copied) — callers must treat it read-only. */
export function createSecretsProvider(secretsDir: string): SecretsProvider {
  let signature: string | null = null;
  let cache = new Map<string, string>();
  return () => {
    if (!existsSync(secretsDir)) {
      if (signature !== "") {
        signature = "";
        cache = new Map();
      }
      return cache;
    }
    const names = readdirSync(secretsDir)
      .filter((n) => SECRET_NAME_RE.test(n))
      .sort();
    const parts: string[] = [];
    for (const name of names) {
      try {
        const st = statSync(join(secretsDir, name));
        parts.push(`${name}:${st.mtimeMs}:${st.size}`);
      } catch {
        // Raced removal between readdir and stat — skip.
      }
    }
    const sig = parts.join("|");
    if (sig === signature) return cache;
    const next = new Map<string, string>();
    for (const name of names) {
      try {
        // Exact file bytes — this is what a `cat` of the secret file would
        // surface in a tool result, so it's what we must match to scrub.
        next.set(name, readFileSync(join(secretsDir, name), "utf8"));
      } catch {
        // Raced removal — skip.
      }
    }
    signature = sig;
    cache = next;
    return next;
  };
}

// One provider per secretsDir, so the mtime cache persists across the many
// runTurn calls of a loop (and is shared by every loop on the same host).
const memo = new Map<string, SecretsProvider>();

export function getSecretsProvider(secretsDir: string): SecretsProvider {
  let p = memo.get(secretsDir);
  if (!p) {
    p = createSecretsProvider(secretsDir);
    memo.set(secretsDir, p);
  }
  return p;
}
