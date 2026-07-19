import type { Manifest, ExtensionApi } from "./types.ts";
import type { EventBus } from "../bus/index.ts";

/** Opaque handle to a staged copy of an extension's code. Legacy carries the
 *  staged directory path; a future VM backend carries a guest-side ref. */
export interface StagedExtension {
  readonly ref: string;
}

/** Runs agent-authored extension code. The host owns registries, gates, and
 *  api-building (src/extensions/runtime.ts); the executor owns only the three
 *  points where that code actually executes — staging it, running its smoke
 *  gate, and importing + registering it. Legacy runs it in-process; a microVM
 *  backend (later) runs it in a guest over an RPC channel, implementing this
 *  same interface. */
export interface ExtensionExecutor {
  /** Prepare a fresh copy of the extension's code so a reload after edits
   *  loads the new code (Bun's ESM cache is keyed by resolved path). */
  stage(extDir: string, name: string): Promise<StagedExtension>;
  /** Run smoke.ts against the staged code if present; throw on failure. A
   *  missing smoke.ts or a module without a smokeTest export is a no-op pass
   *  (today's contract). */
  smoke(
    staged: StagedExtension,
    manifest: Manifest,
    secrets: Record<string, string>,
    bus: EventBus,
  ): Promise<void>;
  /** Import the staged index.ts and invoke register(api). Return the module's
   *  optional unload hook. Throws if the module has no register(). */
  register(
    staged: StagedExtension,
    api: ExtensionApi,
  ): Promise<{ unload?: () => void | Promise<void> }>;
}
