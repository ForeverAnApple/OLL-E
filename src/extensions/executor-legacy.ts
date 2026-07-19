// Legacy (in-process) extension executor.
//
// The three points where agent-authored extension code actually runs —
// staging it, running its smoke gate, and importing + registering it. Extracted
// from runtime.ts behind ExtensionExecutor so a future microVM backend can
// implement the same seam. This backend runs the code in-process, exactly as
// runtime.ts did before the extraction. Nothing observable changes.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ulid } from "../id/index.ts";
import type { EventBus } from "../bus/index.ts";
import type { ExtensionExecutor, StagedExtension } from "./executor.ts";
import type { ExtensionApi, ExtensionModule, Manifest, SmokeTest } from "./types.ts";

/** Staging root for a host. Shared with runtime.ts's attribution regexes so a
 *  stack frame from staged code attributes to its extension — both sides must
 *  compute the same path or fault-isolation breaks. */
export function stagingRootFor(hostId: string): string {
  // Staging dir sits outside the extension tree so cpSync is happy, and
  // outside the git-tracked extensions root so we don't commit copies.
  return join(tmpdir(), `olle-stage-${hostId}`);
}

/** Legacy staged handle: carries the staged dir as `ref` plus the extension
 *  `name` for the register()-missing error text. The interface only promises
 *  `ref`, so the extra field is a structural widening. */
interface LegacyStaged extends StagedExtension {
  readonly name: string;
}

export function createLegacyExecutor(opts: { hostId: string }): ExtensionExecutor {
  const stagingRoot = stagingRootFor(opts.hostId);
  mkdirSync(stagingRoot, { recursive: true });

  return {
    /** Stage a fresh copy of the extension into a uniquely-named sibling
     *  directory so dynamic import resolves a new module URL — Bun's ESM
     *  cache is keyed by resolved path and ignores query strings. */
    async stage(extDir: string, name: string): Promise<LegacyStaged> {
      const version = ulid();
      const perExt = join(stagingRoot, name);
      mkdirSync(perExt, { recursive: true });
      const stageDir = join(perExt, version);
      cpSync(extDir, stageDir, { recursive: true });
      // Best-effort cleanup of older staged versions.
      try {
        for (const prior of readdirSync(perExt)) {
          if (prior === version) continue;
          rmSync(join(perExt, prior), { recursive: true, force: true });
        }
      } catch {
        /* ignore */
      }
      return { ref: stageDir, name };
    },

    async smoke(
      staged: StagedExtension,
      _manifest: Manifest,
      secrets: Record<string, string>,
      bus: EventBus,
    ): Promise<void> {
      const smokePath = join(staged.ref, "smoke.ts");
      if (!existsSync(smokePath)) return; // no smoke.ts is allowed; tool-only extensions
      const url = pathToFileURL(smokePath).href;
      const mod = (await import(url)) as { smokeTest?: SmokeTest };
      if (typeof mod.smokeTest !== "function") return;
      await mod.smokeTest(bus, { secrets });
    },

    async register(
      staged: StagedExtension,
      api: ExtensionApi,
    ): Promise<{ unload?: () => void | Promise<void> }> {
      const name = (staged as LegacyStaged).name;
      const indexUrl = pathToFileURL(join(staged.ref, "index.ts")).href;
      const mod = (await import(indexUrl)) as ExtensionModule | { default: ExtensionModule };
      const impl: ExtensionModule = "default" in mod ? mod.default : mod;
      if (typeof impl.register !== "function") {
        throw new Error(`extensions: ${name} has no register()`);
      }
      await impl.register(api);
      return { unload: impl.unload ? () => impl.unload!() : undefined };
    },
  };
}
