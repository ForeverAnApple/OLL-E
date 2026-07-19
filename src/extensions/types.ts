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
  /** Allowlist of tool names this extension is permitted to invoke via
   *  `api.callTool`. Cross-extension tool use is opt-in and declared up
   *  front so the coupling is visible in git. Tools not listed here are
   *  rejected at call time; self-registered tools are not exempt. */
  callsTools?: string[];
  /** Event types this extension may observe via api.on() or scheduler
   *  tasks. Use "*" only for deliberately broad observability extensions. */
  eventReads?: string[];
  /** Event types this extension may emit via api.publish(), triggers, or
   *  task ctx.emit(). Use "*" only for deliberately broad bridge layers. */
  eventWrites?: string[];
  /** Catalog prose for this extension's tools. `tagline` + `blurb` render
   *  under the category heading in the agent's tool catalog; `tools` maps a
   *  tool name to a one-line clause used when the ToolDef lacks a
   *  `shortClause`. Malformed catalog (missing tagline/blurb) is warned and
   *  dropped, never a load failure. Binds to the categories the extension's
   *  own tools declare (use `category: "<extension-name>"` on each ToolDef). */
  catalog?: {
    tagline: string;
    blurb: string;
    tools?: Record<string, string>;
  };
  /** Egress declarations — the visible authority boundary for network access
   *  from isolated (microVM) execution, peer to callsTools/eventReads/
   *  eventWrites (LOG 2026-07-18). Each entry allowlists a set of hosts and
   *  the secrets permitted to reach them (the extension's `injectHosts`).
   *  `mode: "placeholder"` (default) means api.secrets carries
   *  `olle-secret://<NAME>` tokens the broker substitutes at egress, so the
   *  real value never enters the guest; `mode: "guest"` delivers the real
   *  value in-VM (still egress-pinned to `hosts`) for HMAC/binary-frame
   *  protocols where substitution can't work. A secret in `secrets` but no
   *  egress entry is an unroutable placeholder — a lint warning, not a
   *  failure. Malformed entries are dropped with a warning. */
  egress?: Array<{
    hosts: string[];
    secrets?: string[];
    mode?: "placeholder" | "guest";
  }>;
  /** The extension cannot run isolated — it spawns host binaries or reads the
   *  host filesystem (e.g. the claude-code starter). Loading it in a VM is
   *  impossible; running it in-process is a strategic-tier decision persisted
   *  as extensions.isolation = "host". */
  requiresHost?: boolean;
}

/** One rendered catalog-prose entry, derived from a loaded extension's
 *  `manifest.catalog` bound to a category its tools populate. Consumed by
 *  `renderToolCatalog` as its `extensionProse` argument. */
export interface ExtensionCatalogProse {
  category: string;
  tagline: string;
  body: string;
  toolClauses?: Record<string, string>;
}

export interface ToolDef<I = unknown, O = unknown> {
  name: string;
  description: string;
  /** Significance tier for the permission check. Defaults to "operational".
   *  Read-only / idempotent tools stay operational; tools that write to
   *  the world (extensions, external services) are strategic; tools that
   *  rewrite mission/budget/goals are vision. */
  tier?: Tier;
  /** Catalog category this tool belongs in. The catalog renderer groups
   *  tools by category and emits a category-level blurb before listing
   *  members. Falls back to `"misc"` (rendered last) when absent. */
  category?: string;
  /** One short clause used in the catalog under the tool's name —
   *  purposive ("when to reach for this"), not structural. The catalog
   *  uses this instead of `description` to keep per-tool entries tight;
   *  the full description still ships when the tool's schema is loaded. */
  shortClause?: string;
  /** When true, the tool's schema is sent to the LLM on every turn. When
   *  false (the default), the schema is deferred — agents pull it into
   *  context with the `load_tools` meta-tool. Default false because tool
   *  schemas cost LLM context every turn; flip true only for tools used
   *  on most turns of most threads. */
  alwaysLoaded?: boolean;
  /** JSON Schema describing the tool's input. Handed straight to the LLM
   *  vendor's tool-use spec. The host introspects it only for *minimal*
   *  structural validation before execute() — required properties,
   *  `additionalProperties: false`, and primitive `type` checks — so a
   *  wrong-shaped call (notably a blind call to a deferred tool) returns a
   *  legible, schema-carrying error instead of crashing inside execute().
   *  Deep/semantic constraints are not enforced here; use `validate()` for
   *  those. Extensions author this as a plain object (or convert from their
   *  preferred schema library themselves); this keeps any shared-library
   *  identity out of the host↔extension boundary. */
  inputSchema: Record<string, unknown>;
  /** Optional runtime validator. Called with the raw LLM-emitted input;
   *  its return value is passed to `execute`. If omitted, input flows
   *  through unchanged. */
  validate?(input: unknown): I;
  /** Input property names whose values must be redacted from any audit
   *  event or persisted message (e.g. secret bodies). The tool still
   *  receives the raw value; only the trace is sanitized. */
  sensitiveInputFields?: string[];
  /** When true, the tool result is replaced with "[redacted]" before it
   *  reaches the LLM transcript, event log, or persisted thread snapshot. */
  sensitiveOutput?: boolean;
  /** Output object fields whose values must be redacted before tracing or
   *  feeding the result back to the model. Ignored when sensitiveOutput is
   *  true. */
  sensitiveOutputFields?: string[];
  /** Per-tool override for the rendered tool_result byte cap. Outputs above
   *  this are spilled to the tool_results store and replaced inline with a
   *  preview + handle the agent can fetch via `read_tool_result`. Capped
   *  by the runtime's system-wide limit; leave unset to use the default. */
  maxResultBytes?: number;
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
  /** Invoke a cross-extension tool with the task's own agentId threaded
   *  in as `asAgent`. Same semantics as `api.callTool` but with scope
   *  enforcement automatic — the acting agent's allowTools/denyTools/
   *  allowTiers policy applies per `checkTool`. Use this inside task
   *  handlers; reach for `api.callTool` only when no agent context
   *  applies. */
  callTool<I = unknown, O = unknown>(
    name: string,
    args: I,
    opts?: Omit<CallToolOptions, "asAgent">,
  ): Promise<O>;
}

export interface CallToolOptions {
  /** Hard wall-clock cap for the call. Default 30s. Aborts via ctx.abort
   *  so the target tool can short-circuit. */
  timeoutMs?: number;
  /** Caller's signal; aborts propagate to the target's ctx.abort. */
  signal?: AbortSignal;
  /** Agent on whose behalf the call is being made. When set, the runtime
   *  looks up the agent's scope and runs checkTool(scope, target) before
   *  dispatch — the same permission gate the chat agent uses. Task
   *  handlers thread their own agentId via ctx.callTool automatically;
   *  other callers pass it explicitly when there's a meaningful acting
   *  agent. Omit for pure extension-to-extension plumbing without an
   *  agent context. */
  asAgent?: string;
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
  publish<T>(
    type: string,
    payload: T,
    opts?: {
      durable?: boolean;
      /** Address the event to an agent's mailbox. */
      toAgentId?: string;
      /** Correlation id for a conversation / work stream. */
      threadId?: string;
      /** If opening a thread that descends from another, record the parent. */
      parentThreadId?: string;
      parentEventId?: string;
    },
  ): void;
  /** The root agent id on this host. Bridges use this to address events
   *  into the root's mailbox by default. */
  rootAgentId?: string;
  /** Look up a thread's current mailbox target (from retarget_thread).
   *  Returns the override or undefined — bridges should fall back to
   *  rootAgentId when nothing matches. */
  resolveMailbox?(threadId: string): string | undefined;
  /** Invoke a tool registered by any extension (including this one).
   *  Gated by manifest.callsTools — the tool's name must be on the
   *  allowlist or the call is rejected. The target tool runs with its
   *  own extension's secrets; the caller's secrets never leak across.
   *  Attribution: ctx.actorId = caller, ctx.extensionId = target. */
  callTool<I = unknown, O = unknown>(
    name: string,
    args: I,
    opts?: CallToolOptions,
  ): Promise<O>;
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

/** Context passed to smoke.ts smokeTest — so smoke can read its extension's
 *  declared secrets without resorting to process.env scraping. */
export interface SmokeContext {
  /** Resolved values for the manifest's `secrets` list (file-backed in
   *  ~/.olle/secrets/). Missing secrets are absent from the record. Env
   *  is intentionally not consulted — secrets have one source of truth. */
  secrets: Record<string, string>;
}

/** Smoke test contract — exported as `smokeTest` in smoke.ts. */
export type SmokeTest = (
  bus: EventBus,
  ctx?: SmokeContext,
) => Promise<void> | void;

/** Internal: the loaded, live extension record. */
export interface LoadedExtension {
  id: string;
  manifest: Manifest;
  path: string;
  status: ExtensionStatus;
  failures: number;
  unload?: () => Promise<void>;
}
