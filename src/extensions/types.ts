import type { z } from "zod";
import type { EventBus } from "../bus/index.ts";
import type { Event, Unsubscribe } from "../bus/types.ts";
import type { Tier } from "../scheduler/index.ts";

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

export interface TaskRegistration {
  /** Stable id local to this extension. The host namespaces it as
   *  `ext:<extensionName>:<id>` when persisting. */
  id: string;
  eventType: string | "*";
  tier?: Tier;
  match?: (ev: Event) => boolean;
  concurrency?: number;
  tokenEst?: number;
  handler: (ctx: ExtensionTaskContext) => void | Promise<void>;
}

export interface ExtensionTaskContext {
  event: Event;
  hostId: string;
  extensionId: string;
  agentId: string;
  /** Emit a follow-on event parented to the trigger; same shape as the
   *  scheduler's TaskContext.emit but auto-attributed to the extension. */
  emit<T>(type: string, payload: T, opts?: { durable?: boolean }): void;
  secrets: Record<string, string>;
}

export interface ExtensionApi {
  readonly hostId: string;
  readonly extensionId: string;
  registerTool(tool: ToolDef): void;
  registerTrigger(trigger: TriggerDef): void;
  /** Register a scheduler-managed task. Behaviors (per LOG 2026-04-22)
   *  belong here; raw bus subscriptions via `on()` exist for fire-and-
   *  forget side effects, but anything worth remembering across a
   *  restart must go through registerTask so it gets a task_runs row. */
  registerTask(task: TaskRegistration): void;
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
