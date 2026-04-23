// Meta-tools: let the agent operate on the extension authoring loop.
//
// write-extension    — propose (inbox item) or write files directly if the
//                      proposal was already approved.
// run-smoke-test     — run the named extension's smoke gate without
//                      activating it.
// register-extension — load (or reload) the extension by name. Fails if
//                      manifest is invalid or smoke fails.
// revert-extension   — revert the ext subtree to the given sha.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionHost, ToolDef } from "../extensions/index.ts";
import {
  commitSubtree,
  ensureRepo,
  history as gitHistory,
  revertSubtree,
} from "../extensions/git.ts";
import { validateManifest } from "../extensions/manifest.ts";
import type { SmokeTest } from "../extensions/types.ts";
import { installStarter, listStarters } from "../starters/index.ts";

export interface MetaToolsOptions {
  extensions: ExtensionHost;
  extensionsDir: string;
  /** Author name on git commits — usually the agent id. */
  authorName: string;
  /** Dir where file-backed secrets live. When omitted, secret meta-tools
   *  are not registered. */
  secretsDir?: string;
}

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function buildMetaTools(opts: MetaToolsOptions): ToolDef[] {
  const { extensions, extensionsDir, authorName } = opts;

  const writeExt: ToolDef<
    { name: string; files: Record<string, string>; commitMessage?: string },
    { commit: string | null }
  > = {
    name: "write_extension",
    tier: "strategic",
    description:
      "Write files into an extension directory and git-commit the subtree. Files is a map of relative path → content. Creates the extension dir if needed.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        files: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        commitMessage: { type: "string" },
      },
      required: ["name", "files"],
      additionalProperties: false,
    },
    execute: async ({ name, files, commitMessage }) => {
      if (!/^[a-z0-9][a-z0-9-_]*$/.test(name)) {
        throw new Error(`write_extension: invalid name "${name}"`);
      }
      ensureRepo(extensionsDir);
      const dir = join(extensionsDir, name);
      mkdirSync(dir, { recursive: true });
      for (const [rel, body] of Object.entries(files)) {
        const full = join(dir, rel);
        if (!full.startsWith(dir + "/") && full !== dir) {
          throw new Error(`write_extension: path escapes ext dir: ${rel}`);
        }
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, body, "utf8");
      }
      // Validate manifest if present.
      const manifestPath = join(dir, "manifest.json");
      if (existsSync(manifestPath)) {
        validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")), name);
      }
      const commit = commitSubtree({
        cwd: extensionsDir,
        subpath: name,
        message: commitMessage ?? `agent write: ${name}`,
        authorName,
      });
      return { commit };
    },
  };

  const runSmoke: ToolDef<{ name: string }, { ok: true } | { ok: false; error: string }> = {
    name: "run_smoke_test",
    tier: "operational",
    description:
      "Run an extension's smoke test without activating it. Resolves the extension's declared secrets the same way a register/reload would, so a smoke that passes here will pass on load.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async ({ name }) => {
      const smokePath = join(extensionsDir, name, "smoke.ts");
      if (!existsSync(smokePath)) return { ok: true } as const;
      try {
        // Resolve secrets the same way the runtime does at load: read the
        // manifest's `secrets` list, then pull each from ~/.olle/secrets
        // with process.env as fallback. Without this the agent-callable
        // smoke sees a different world than the actual load-time smoke —
        // which silently masks "you forgot to set a secret" as a generic
        // env-var miss.
        const secrets: Record<string, string> = {};
        const manifestPath = join(extensionsDir, name, "manifest.json");
        if (existsSync(manifestPath) && opts.secretsDir) {
          try {
            const mf = JSON.parse(readFileSync(manifestPath, "utf8")) as {
              secrets?: string[];
            };
            for (const s of mf.secrets ?? []) {
              const p = join(opts.secretsDir, s);
              const v = existsSync(p)
                ? readFileSync(p, "utf8").trim()
                : process.env[s];
              if (v != null) secrets[s] = v;
            }
          } catch {
            /* manifest unreadable — smoke will surface the real error */
          }
        }
        const mod = (await import(pathToFileURL(smokePath).href + `?t=${Date.now()}`)) as {
          smokeTest?: SmokeTest;
        };
        if (typeof mod.smokeTest === "function") {
          await mod.smokeTest(undefined as never, { secrets });
        }
        return { ok: true } as const;
      } catch (err) {
        return { ok: false, error: (err as Error).message } as const;
      }
    },
  };

  const readExtFile: ToolDef<
    { name: string; path: string },
    { path: string; content: string; bytes: number }
  > = {
    name: "read_extension_file",
    tier: "operational",
    description:
      "Read a file from a named extension's directory (e.g. manifest.json, index.ts, smoke.ts). Use this to inspect your own habitat before editing — reading beats guessing at error strings. Paths are relative to the extension dir and must not escape it.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Extension name." },
        path: {
          type: "string",
          description: "Relative path within the extension dir.",
        },
      },
      required: ["name", "path"],
      additionalProperties: false,
    },
    execute: async ({ name, path }) => {
      if (!/^[a-z0-9][a-z0-9-_]*$/.test(name)) {
        throw new Error(`read_extension_file: invalid extension name "${name}"`);
      }
      const base = join(extensionsDir, name);
      const full = join(base, path);
      // Reject traversal: full must be inside base (or be base itself — but
      // we always read files, so exact-base is still a read failure).
      if (full !== base && !full.startsWith(base + "/")) {
        throw new Error(`read_extension_file: path escapes extension dir`);
      }
      if (!existsSync(full)) {
        throw new Error(`read_extension_file: ${path} not found in ${name}`);
      }
      const st = statSync(full);
      if (!st.isFile()) {
        throw new Error(`read_extension_file: ${path} is not a regular file`);
      }
      // 1 MB cap — smoke/manifest/index are all far smaller; this just
      // guards against accidentally slurping a giant blob into the model.
      if (st.size > 1_000_000) {
        throw new Error(
          `read_extension_file: ${path} is ${st.size} bytes (>1MB cap)`,
        );
      }
      const content = readFileSync(full, "utf8");
      return { path, content, bytes: st.size };
    },
  };

  const register: ToolDef<
    { name: string },
    { status: string; failures: number }
  > = {
    name: "register_extension",
    tier: "strategic",
    description: "Load (or reload) a named extension. Smoke gate runs first.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async ({ name }) => {
      const existing = extensions.get(name);
      const ext = existing ? await extensions.reload(name) : await extensions.load(name);
      return { status: ext.status, failures: ext.failures };
    },
  };

  const revert: ToolDef<
    { name: string; sha: string },
    { commit: string | null; status: string }
  > = {
    name: "revert_extension",
    tier: "strategic",
    description: "Revert an extension to a prior git sha and reload it.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        sha: { type: "string" },
      },
      required: ["name", "sha"],
      additionalProperties: false,
    },
    execute: async ({ name, sha }) => {
      const commit = revertSubtree(extensionsDir, name, sha, authorName);
      const ext = await extensions.reload(name);
      return { commit, status: ext.status };
    },
  };

  const history: ToolDef<
    { name: string; limit?: number },
    Array<{ sha: string; author: string; date: number; subject: string }>
  > = {
    name: "extension_history",
    tier: "operational",
    description: "List recent commits touching the given extension.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        limit: { type: "number" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async ({ name, limit }) => gitHistory(extensionsDir, name, limit ?? 20),
  };

  const listStartersT: ToolDef<Record<string, never>, Array<{ name: string; description: string }>> = {
    name: "list_starters",
    tier: "operational",
    description: "List the starter extension templates shipped with the binary.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => listStarters().map(({ name, description }) => ({ name, description })),
  };

  const installStarterT: ToolDef<
    { name: string; overwrite?: boolean },
    { name: string; filesWritten: number; alreadyExisted: boolean; commit: string | null }
  > = {
    name: "install_starter",
    tier: "strategic",
    description:
      "Copy a named starter template into the extensions directory and git-commit it. Does not register.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        overwrite: { type: "boolean" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async ({ name, overwrite }) => {
      const r = installStarter({
        name,
        extensionsDir,
        authorName,
        overwrite,
      });
      return {
        name: r.name,
        filesWritten: r.filesWritten,
        alreadyExisted: r.alreadyExisted,
        commit: r.commit,
      };
    },
  };

  const tools: ToolDef[] = [
    writeExt,
    runSmoke,
    readExtFile,
    register,
    revert,
    history,
    listStartersT,
    installStarterT,
  ];

  if (opts.secretsDir) {
    const secretsDir = opts.secretsDir;

    const setSecret: ToolDef<
      { name: string; value: string },
      { name: string; bytes: number }
    > = {
      name: "set_secret",
      tier: "strategic",
      description:
        "Store a host-scoped secret (e.g. DISCORD_TOKEN). Written to disk mode 0600 and surfaced to extensions that declare it in manifest.secrets. The value is redacted from audit events and persisted session messages. Use before registering an extension that needs the secret.",
      sensitiveInputFields: ["value"],
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Uppercase env-style name, e.g. DISCORD_TOKEN.",
          },
          value: { type: "string", description: "The secret value." },
        },
        required: ["name", "value"],
        additionalProperties: false,
      },
      execute: async ({ name, value }) => {
        if (!SECRET_NAME_RE.test(name)) {
          throw new Error(`set_secret: name must match /^[A-Z][A-Z0-9_]{0,63}$/`);
        }
        if (typeof value !== "string" || value.length === 0) {
          throw new Error("set_secret: value must be a non-empty string");
        }
        mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(secretsDir, name), value, { mode: 0o600 });
        return { name, bytes: value.length };
      },
    };

    const listSecrets: ToolDef<
      Record<string, never>,
      Array<{ name: string; size: number; updatedAt: number }>
    > = {
      name: "list_secrets",
      tier: "operational",
      description: "List names of stored secrets (values are never returned).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        if (!existsSync(secretsDir)) return [];
        return readdirSync(secretsDir)
          .filter((n) => SECRET_NAME_RE.test(n))
          .map((name) => {
            const st = statSync(join(secretsDir, name));
            return { name, size: st.size, updatedAt: st.mtimeMs };
          });
      },
    };

    const removeSecret: ToolDef<{ name: string }, { name: string; removed: boolean }> = {
      name: "remove_secret",
      tier: "strategic",
      description: "Remove a stored secret by name. No-op if absent.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      execute: async ({ name }) => {
        if (!SECRET_NAME_RE.test(name)) {
          throw new Error("remove_secret: invalid name");
        }
        const p = join(secretsDir, name);
        const existed = existsSync(p);
        if (existed) unlinkSync(p);
        return { name, removed: existed };
      },
    };

    tools.push(setSecret, listSecrets, removeSecret);
  }

  return tools;
}
