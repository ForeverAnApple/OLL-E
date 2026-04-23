// Meta-tools: let the agent operate on the extension authoring loop.
//
// write-extension    — propose (inbox item) or write files directly if the
//                      proposal was already approved.
// run-smoke-test     — run the named extension's smoke gate without
//                      activating it.
// register-extension — load (or reload) the extension by name. Fails if
//                      manifest is invalid or smoke fails.
// revert-extension   — revert the ext subtree to the given sha.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
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
}

export function buildMetaTools(opts: MetaToolsOptions): ToolDef[] {
  const { extensions, extensionsDir, authorName } = opts;

  const writeExt: ToolDef<
    { name: string; files: Record<string, string>; commitMessage?: string },
    { commit: string | null }
  > = {
    name: "write_extension",
    description:
      "Write files into an extension directory and git-commit the subtree. Files is a map of relative path → content. Creates the extension dir if needed.",
    parameters: z.object({
      name: z.string(),
      files: z.record(z.string(), z.string()),
      commitMessage: z.string().optional(),
    }),
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
    description: "Run an extension's smoke test without activating it.",
    parameters: z.object({ name: z.string() }),
    execute: async ({ name }) => {
      const smokePath = join(extensionsDir, name, "smoke.ts");
      if (!existsSync(smokePath)) return { ok: true } as const;
      try {
        const mod = (await import(pathToFileURL(smokePath).href + `?t=${Date.now()}`)) as {
          smokeTest?: SmokeTest;
        };
        if (typeof mod.smokeTest === "function") {
          // Smoke tests that need the bus should take it; we pass undefined
          // for v0 tools-only smoke tests.
          await mod.smokeTest(undefined as never);
        }
        return { ok: true } as const;
      } catch (err) {
        return { ok: false, error: (err as Error).message } as const;
      }
    },
  };

  const register: ToolDef<
    { name: string },
    { status: string; failures: number }
  > = {
    name: "register_extension",
    description: "Load (or reload) a named extension. Smoke gate runs first.",
    parameters: z.object({ name: z.string() }),
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
    description: "Revert an extension to a prior git sha and reload it.",
    parameters: z.object({ name: z.string(), sha: z.string() }),
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
    description: "List recent commits touching the given extension.",
    parameters: z.object({ name: z.string(), limit: z.number().optional() }),
    execute: async ({ name, limit }) => gitHistory(extensionsDir, name, limit ?? 20),
  };

  const listStartersT: ToolDef<Record<string, never>, Array<{ name: string; description: string }>> = {
    name: "list_starters",
    description: "List the starter extension templates shipped with the binary.",
    parameters: z.object({}),
    execute: async () => listStarters().map(({ name, description }) => ({ name, description })),
  };

  const installStarterT: ToolDef<
    { name: string; overwrite?: boolean },
    { name: string; filesWritten: number; alreadyExisted: boolean; commit: string | null }
  > = {
    name: "install_starter",
    description:
      "Copy a named starter template into the extensions directory and git-commit it. Does not register.",
    parameters: z.object({ name: z.string(), overwrite: z.boolean().optional() }),
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

  return [writeExt, runSmoke, register, revert, history, listStartersT, installStarterT];
}
