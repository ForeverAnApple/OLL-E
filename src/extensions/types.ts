import type { z } from "zod";
import type { EventBus } from "../bus/index.ts";
import type { Event, Unsubscribe } from "../bus/types.ts";

export type ExtensionStatus = "active" | "inactive" | "crashed";

export interface Manifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** Secret names the extension reads. The agent prompts for them before
   *  activation; at runtime they are injected into ctx.secrets. */
  secrets?: string[];
  /** Capabilities declared by the extension — informational in v0, the
   *  permission gate uses it in v1+. */
  capabilities?: string[];
}

export interface ToolDef<I = unknown, O = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<I>;
  execute(args: I, ctx: ToolExecuteContext): Promise<O> | O;
}

export interface ToolExecuteContext {
  hostId: string;
  extensionId: string;
  actorId: string;
  abort: AbortSignal;
  secrets: Record<string, string>;
}

export interface TriggerDef<T = unknown> {
  name: string;
  type: string;
  start(emit: (payload: T) => void, ctx: TriggerContext): Promise<void> | void;
  stop?(): Promise<void> | void;
}

export interface TriggerContext {
  hostId: string;
  extensionId: string;
  secrets: Record<string, string>;
}

export interface ExtensionApi {
  readonly hostId: string;
  readonly extensionId: string;
  registerTool(tool: ToolDef): void;
  registerTrigger(trigger: TriggerDef): void;
  on(event: string, handler: (ev: Event) => void | Promise<void>): Unsubscribe;
  publish<T>(type: string, payload: T, opts?: { durable?: boolean }): void;
  /** Secrets declared in manifest.secrets — keys available post-approval. */
  secrets: Record<string, string>;
  /** Scratch dir the extension may read/write. */
  scratchDir: string;
}

/** The shape an extension's index.ts default-exports. */
export interface ExtensionModule {
  manifest?: Manifest; // may alternatively come from manifest.json
  register(api: ExtensionApi): void | Promise<void>;
  unload?(): void | Promise<void>;
}

/** Smoke test contract — exported as `smokeTest` in smoke.ts. */
export type SmokeTest = (bus: EventBus) => Promise<void> | void;

/** Internal: the loaded, live extension record. */
export interface LoadedExtension {
  id: string;
  manifest: Manifest;
  path: string;
  status: ExtensionStatus;
  failures: number;
  unload?: () => Promise<void>;
}
