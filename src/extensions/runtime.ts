// Extension runtime.
//
// Responsibilities:
//  1. Discover extensions under ~/.olle/extensions/<name>/
//  2. Parse and validate each manifest.json
//  3. Run the extension's smoke.ts exported `smokeTest` in isolation before
//     activating. Failure → mark inactive, emit an inbox-worthy event.
//  4. dynamic-import index.ts, call register(api), track unload handler
//  5. Track failure counts; on >=2 failures within 5 minutes mark crashed
//     and emit extension.crashed so the inbox can offer revert.
//
// Hot-reload: unload(old) → reload(same name). We rely on Bun's dynamic
// import and bust the module cache via a query-string cache-buster.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EventBus } from "../bus/index.ts";
import type { Event, Unsubscribe } from "../bus/types.ts";
import type { Store } from "../store/db.ts";
import { tables } from "../store/index.ts";
import { ulid } from "../id/index.ts";
import { eq } from "drizzle-orm";
import { readManifest } from "./manifest.ts";
import type { Scheduler } from "../scheduler/index.ts";
import { checkTool } from "../permissions/index.ts";
import type { AgentScope } from "../store/schema.ts";
import type {
  CallToolOptions,
  ExtensionApi,
  ExtensionModule,
  LoadedExtension,
  Manifest,
  SmokeTest,
  TaskRegistration,
  ToolDef,
  TriggerDef,
} from "./types.ts";

export interface ExtensionHostOptions {
  bus: EventBus;
  store: Store;
  hostId: string;
  extensionsDir: string;
  /** Resolves named secrets to values. Missing secrets return undefined. */
  secrets?: (name: string, ext: string) => string | undefined;
  /** Crash threshold — default 2 failures within the rolling window. */
  failureThreshold?: number;
  /** Rolling window in ms for the failure count. Default 5 min. */
  failureWindowMs?: number;
  /** Scheduler for `registerTask`. If omitted, registerTask throws. */
  scheduler?: Scheduler;
  /** Agent id to attribute extension-registered tasks to. Required if
   *  scheduler is provided. */
  defaultTaskAgentId?: string;
}

export interface ExtensionHost {
  list(): LoadedExtension[];
  get(name: string): LoadedExtension | undefined;
  discover(): Promise<string[]>;
  load(name: string): Promise<LoadedExtension>;
  unload(name: string): Promise<void>;
  reload(name: string): Promise<LoadedExtension>;
  /** Called by task handlers when an extension tool or trigger throws.
   *  Increments failure count and auto-disables past the threshold. */
  reportFailure(name: string, err: unknown): void;
  tools(): Array<{ extensionId: string; tool: ToolDef }>;
  triggers(): Array<{ extensionId: string; trigger: TriggerDef }>;
}

interface RegisteredToolEntry {
  extensionId: string;
  /** Owning extension's user-facing name; used for diagnostics and the
   *  `tool.called` audit event. */
  extensionName: string;
  tool: ToolDef;
  /** Fresh resolution of the target extension's own secrets. Called at
   *  callTool time so rotation eventually propagates; never exposes the
   *  caller's secrets. */
  resolveSecrets: () => Record<string, string>;
}
interface RegisteredTriggerEntry {
  extensionId: string;
  trigger: TriggerDef;
  stop?: () => void | Promise<void>;
}
interface RegisteredTaskEntry {
  taskId: string;
  unregister: () => void;
}

export function createExtensionHost(opts: ExtensionHostOptions): ExtensionHost {
  const loaded = new Map<string, LoadedExtension>();
  const subs = new Map<string, Unsubscribe[]>();
  const toolsByExt = new Map<string, RegisteredToolEntry[]>();
  const triggersByExt = new Map<string, RegisteredTriggerEntry[]>();
  const tasksByExt = new Map<string, RegisteredTaskEntry[]>();
  const failureLog = new Map<string, number[]>();
  const threshold = opts.failureThreshold ?? 2;
  const windowMs = opts.failureWindowMs ?? 5 * 60 * 1000;

  mkdirSync(opts.extensionsDir, { recursive: true });

  async function discover(): Promise<string[]> {
    const entries = existsSync(opts.extensionsDir) ? readdirSync(opts.extensionsDir) : [];
    const found: string[] = [];
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const dir = join(opts.extensionsDir, entry);
      if (!statSync(dir).isDirectory()) continue;
      if (!existsSync(join(dir, "manifest.json"))) continue;
      found.push(entry);
    }
    return found;
  }

  // Staging dir sits outside the extension tree so cpSync is happy, and
  // outside the git-tracked extensions root so we don't commit copies.
  const stagingRoot = join(tmpdir(), `olle-stage-${opts.hostId}`);
  mkdirSync(stagingRoot, { recursive: true });

  /** Stage a fresh copy of the extension into a uniquely-named sibling
   *  directory so dynamic import resolves a new module URL — Bun's ESM
   *  cache is keyed by resolved path and ignores query strings. */
  function stage(extDir: string, name: string): string {
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
    return stageDir;
  }

  async function runSmoke(stagedDir: string): Promise<void> {
    const smokePath = join(stagedDir, "smoke.ts");
    if (!existsSync(smokePath)) return; // no smoke.ts is allowed; tool-only extensions
    const url = pathToFileURL(smokePath).href;
    const mod = (await import(url)) as { smokeTest?: SmokeTest };
    if (typeof mod.smokeTest !== "function") return;
    await mod.smokeTest(opts.bus);
  }

  function makeApi(manifest: Manifest, extensionId: string, extDir: string): {
    api: ExtensionApi;
    unsubs: Unsubscribe[];
  } {
    const unsubs: Unsubscribe[] = [];
    const resolved: Record<string, string> = {};
    if (manifest.secrets && opts.secrets) {
      for (const s of manifest.secrets) {
        const v = opts.secrets(s, manifest.name);
        if (v != null) resolved[s] = v;
      }
    }
    const scratchDir = join(extDir, ".scratch");
    mkdirSync(scratchDir, { recursive: true });

    // Fresh resolver for this extension's own secrets; captured into each
    // tool entry so cross-extension callTool sees target's secrets, never
    // caller's. Re-reads from opts.secrets on each call so rotation
    // eventually propagates without a full extension reload.
    const resolveOwnSecrets = (): Record<string, string> => {
      const out: Record<string, string> = {};
      if (manifest.secrets && opts.secrets) {
        for (const s of manifest.secrets) {
          const v = opts.secrets(s, manifest.name);
          if (v != null) out[s] = v;
        }
      }
      return out;
    };

    const callerAllowlist = new Set(manifest.callsTools ?? []);
    const callerName = manifest.name;

    const api: ExtensionApi = {
      hostId: opts.hostId,
      extensionId,
      secrets: resolved,
      scratchDir,
      registerTool(tool) {
        let list = toolsByExt.get(extensionId);
        if (!list) toolsByExt.set(extensionId, (list = []));
        // Warn on name collision across extensions — callTool walks
        // toolsByExt by name and returns first match, so duplicates
        // create a routing ambiguity the caller can't see.
        for (const [otherId, entries] of toolsByExt) {
          if (otherId === extensionId) continue;
          for (const e of entries) {
            if (e.tool.name === tool.name) {
              console.warn(
                `[extensions] tool name "${tool.name}" registered by both "${e.extensionName}" and "${callerName}" — callTool resolution is ambiguous`,
              );
            }
          }
        }
        // Defense against stale / malformed extensions: LLM vendors
        // reject tool specs without a JSON Schema. If an extension
        // forgets inputSchema (or ships an old zod-based shape), fall
        // back to an empty-object schema and warn loudly. Better to
        // expose a broken tool than to 400 every chat turn.
        const guarded: typeof tool =
          tool.inputSchema && typeof tool.inputSchema === "object"
            ? tool
            : (() => {
                console.warn(
                  `[extensions] tool "${tool.name}" from "${callerName}" has no inputSchema — defaulting to { type: "object" }; please update the extension to declare a JSON Schema`,
                );
                return { ...tool, inputSchema: { type: "object" } };
              })();
        list.push({ extensionId, extensionName: callerName, tool: guarded, resolveSecrets: resolveOwnSecrets });
      },
      registerTrigger(trigger) {
        let list = triggersByExt.get(extensionId);
        if (!list) triggersByExt.set(extensionId, (list = []));
        list.push({ extensionId, trigger });
      },
      registerTask(task: TaskRegistration) {
        if (!opts.scheduler || !opts.defaultTaskAgentId) {
          throw new Error(
            `extensions: registerTask called by "${manifest.name}" but host has no scheduler wired`,
          );
        }
        const taskId = `ext:${manifest.name}:${task.id}`;
        const agentId = opts.defaultTaskAgentId;
        const unregister = opts.scheduler.register({
          id: taskId,
          agentId,
          tier: task.tier ?? "operational",
          eventType: task.eventType,
          match: task.match,
          concurrency: task.concurrency,
          tokenEst: task.tokenEst,
          handler: async (ctx) => {
            await task.handler({
              event: ctx.event,
              hostId: ctx.hostId,
              extensionId,
              agentId,
              secrets: resolved,
              emit: (type, payload, emitOpts) => {
                ctx.emit(type, payload, emitOpts);
              },
              // Task-context callTool threads the acting agentId so
              // scope narrowing applies. Handlers that need a different
              // acting agent can still reach api.callTool directly.
              callTool: <I, O>(name: string, args: I, toolOpts?: Omit<CallToolOptions, "asAgent">) =>
                (api.callTool as <I2, O2>(n: string, a: I2, o?: CallToolOptions) => Promise<O2>)<I, O>(
                  name,
                  args,
                  { ...toolOpts, asAgent: agentId },
                ),
            });
          },
        });
        let list = tasksByExt.get(extensionId);
        if (!list) tasksByExt.set(extensionId, (list = []));
        list.push({ taskId, unregister });
      },
      on(event: string, handler: (ev: Event) => void | Promise<void>) {
        const un = opts.bus.subscribe(event, handler);
        unsubs.push(un);
        return un;
      },
      publish<T>(type: string, payload: T, publishOpts?: { durable?: boolean }) {
        opts.bus.publish({
          type,
          payload,
          hostId: opts.hostId,
          actorId: extensionId,
          durable: publishOpts?.durable ?? false,
        });
      },
      async callTool<I, O>(name: string, args: I, callOpts?: CallToolOptions): Promise<O> {
        // Gate 1: allowlist. No exceptions — even self-calls have to
        // declare the intent in the manifest. Makes cross-ext coupling
        // visible in git and reviewable at install time.
        if (!callerAllowlist.has(name)) {
          throw new Error(
            `extensions: "${callerName}" cannot callTool("${name}") — add it to manifest.callsTools`,
          );
        }
        // Gate 2: tool exists. Walk all registered tools; first name
        // match wins. Collisions already warned at registerTool time.
        let target: RegisteredToolEntry | undefined;
        for (const list of toolsByExt.values()) {
          const hit = list.find((e) => e.tool.name === name);
          if (hit) {
            target = hit;
            break;
          }
        }
        if (!target) {
          throw new Error(`extensions: callTool("${name}") — tool not registered`);
        }
        // Gate 3: tier. Only operational tools are callable directly.
        // Strategic/vision tools must go through the inbox — a task that
        // wants to create an issue or install an extension proposes a
        // decision first; on approval, the resolved-decision handler is
        // what ultimately invokes the tool. Enforcing this here keeps
        // callTool a peer-to-peer composition seam, not a self-mod
        // escape hatch.
        const toolTier = target.tool.tier ?? "operational";
        if (toolTier !== "operational") {
          throw new Error(
            `extensions: callTool("${name}") — tool is tier "${toolTier}"; route through the decision inbox`,
          );
        }
        // Gate 4: agent scope. When the caller declares an acting agent,
        // run the same permission gate the chat agent uses so scope
        // narrowing applies uniformly to task-authored tool invocations.
        // Pure extension-to-extension calls without an agent context skip
        // this gate — the allowlist + tier gates above still apply.
        if (callOpts?.asAgent) {
          const scope = loadScopeForAgent(opts.store, callOpts.asAgent);
          const authz = checkTool(scope, { name, tier: toolTier });
          if (!authz.ok) {
            throw new Error(
              `extensions: callTool("${name}") denied by scope of agent "${callOpts.asAgent}": ${authz.reason}`,
            );
          }
        }
        // Gate 5: input validation. Defers to the target's own validator;
        // if absent, args flow through unchanged (same contract as the
        // chat agent's tool dispatch).
        const validated = target.tool.validate ? target.tool.validate(args) : args;
        // Abort plumbing: timeout bounds runaway recursion and hanging
        // REST calls; caller's signal propagates so cooperative cancel
        // works end-to-end.
        const controller = new AbortController();
        const timeoutMs = callOpts?.timeoutMs ?? 30_000;
        const timeoutHandle = setTimeout(() => {
          controller.abort(new Error(`callTool("${name}") timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const callerSignal = callOpts?.signal;
        const onCallerAbort = callerSignal ? () => controller.abort(callerSignal.reason) : undefined;
        if (callerSignal?.aborted) {
          controller.abort(callerSignal.reason);
        } else if (callerSignal && onCallerAbort) {
          callerSignal.addEventListener("abort", onCallerAbort, { once: true });
        }
        const startedAt = Date.now();
        const targetExtensionName = target.extensionName;
        const targetExtensionId = target.extensionId;
        try {
          // Secret isolation: target's OWN secrets via its resolver
          // closure. The caller has no way to inject or observe these.
          const result = await target.tool.execute(validated as never, {
            hostId: opts.hostId,
            extensionId: targetExtensionId,
            actorId: extensionId,
            abort: controller.signal,
            secrets: target.resolveSecrets(),
          });
          opts.bus.publish({
            type: "tool.called",
            hostId: opts.hostId,
            actorId: extensionId,
            payload: {
              caller: callerName,
              targetExtension: targetExtensionName,
              tool: name,
              durationMs: Date.now() - startedAt,
              ok: true,
            },
            durable: true,
          });
          return result as O;
        } catch (err) {
          opts.bus.publish({
            type: "tool.called",
            hostId: opts.hostId,
            actorId: extensionId,
            payload: {
              caller: callerName,
              targetExtension: targetExtensionName,
              tool: name,
              durationMs: Date.now() - startedAt,
              ok: false,
              error: (err as Error).message,
            },
            durable: true,
          });
          throw err;
        } finally {
          clearTimeout(timeoutHandle);
          if (callerSignal && onCallerAbort) {
            callerSignal.removeEventListener("abort", onCallerAbort);
          }
        }
      },
    };

    return { api, unsubs };
  }

  async function startTriggers(extensionId: string, manifest: Manifest, extDir: string): Promise<void> {
    const list = triggersByExt.get(extensionId) ?? [];
    for (const entry of list) {
      const emit = (payload: unknown) =>
        opts.bus.publish({
          type: entry.trigger.type,
          payload,
          hostId: opts.hostId,
          actorId: extensionId,
          durable: true,
        });
      const resolved: Record<string, string> = {};
      if (manifest.secrets && opts.secrets) {
        for (const s of manifest.secrets) {
          const v = opts.secrets(s, manifest.name);
          if (v != null) resolved[s] = v;
        }
      }
      await entry.trigger.start(emit, { hostId: opts.hostId, extensionId, secrets: resolved });
      entry.stop = entry.trigger.stop?.bind(entry.trigger);
      // store reference for stop
      // (already mutated entry in place)
      void extDir; // keep for future scratch paths
    }
  }

  async function load(name: string): Promise<LoadedExtension> {
    if (loaded.has(name)) throw new Error(`extensions: ${name} already loaded`);
    const extDir = resolve(opts.extensionsDir, name);
    const manifest = readManifest(extDir);
    if (manifest.name !== name) {
      throw new Error(`extensions: manifest name "${manifest.name}" != dir "${name}"`);
    }

    // Stage a fresh copy so dynamic import resolves a new module URL and
    // bypasses any prior cached version — Bun's ESM cache is keyed by
    // resolved path and ignores query strings.
    const stagedDir = stage(extDir, name);

    // Smoke-gate before any side-effect-ful registration.
    await runSmoke(stagedDir);

    const extensionId = upsertRow(opts.store, manifest, extDir);
    const indexUrl = pathToFileURL(join(stagedDir, "index.ts")).href;
    const mod = (await import(indexUrl)) as ExtensionModule | { default: ExtensionModule };
    const impl: ExtensionModule = "default" in mod ? mod.default : mod;
    if (typeof impl.register !== "function") {
      throw new Error(`extensions: ${name} has no register()`);
    }

    const { api, unsubs } = makeApi(manifest, extensionId, extDir);
    await impl.register(api);
    subs.set(name, unsubs);
    await startTriggers(extensionId, manifest, extDir);

    const record: LoadedExtension = {
      id: extensionId,
      manifest,
      path: extDir,
      status: "active",
      failures: 0,
      unload: impl.unload ? async () => impl.unload!() : undefined,
    };
    loaded.set(name, record);
    markStatus(opts.store, extensionId, "active");
    opts.bus.publish({
      type: "extension.loaded",
      payload: { name, version: manifest.version },
      hostId: opts.hostId,
      actorId: extensionId,
      durable: true,
    });
    return record;
  }

  async function unload(name: string): Promise<void> {
    const record = loaded.get(name);
    if (!record) return;
    for (const un of subs.get(name) ?? []) un();
    subs.delete(name);
    for (const entry of triggersByExt.get(record.id) ?? []) {
      if (entry.stop) await entry.stop();
    }
    for (const entry of tasksByExt.get(record.id) ?? []) {
      try {
        entry.unregister();
      } catch {
        /* best-effort */
      }
    }
    tasksByExt.delete(record.id);
    triggersByExt.delete(record.id);
    toolsByExt.delete(record.id);
    try {
      if (record.unload) await record.unload();
    } catch (err) {
      opts.bus.publish({
        type: "extension.unload-failed",
        payload: { name, error: (err as Error).message },
        hostId: opts.hostId,
        actorId: record.id,
        durable: true,
      });
    }
    loaded.delete(name);
    // Preserve "crashed" status — an explicit revert/enable will clear it.
    if (record.status !== "crashed") {
      markStatus(opts.store, record.id, "inactive");
    }
    opts.bus.publish({
      type: "extension.unloaded",
      payload: { name, status: record.status },
      hostId: opts.hostId,
      actorId: record.id,
      durable: true,
    });
  }

  async function reload(name: string): Promise<LoadedExtension> {
    if (loaded.has(name)) await unload(name);
    return load(name);
  }

  function reportFailure(name: string, err: unknown): void {
    const record = loaded.get(name);
    if (!record) return;
    const now = Date.now();
    let log = failureLog.get(name);
    if (!log) failureLog.set(name, (log = []));
    log.push(now);
    while (log.length && now - log[0]! > windowMs) log.shift();
    record.failures = log.length;
    opts.bus.publish({
      type: "extension.failure",
      payload: { name, error: (err as Error).message, failures: log.length },
      hostId: opts.hostId,
      actorId: record.id,
      durable: true,
    });
    if (log.length >= threshold) {
      record.status = "crashed";
      markStatus(opts.store, record.id, "crashed");
      opts.bus.publish({
        type: "extension.crashed",
        payload: { name, failures: log.length },
        hostId: opts.hostId,
        actorId: record.id,
        durable: true,
      });
      void unload(name);
    }
  }

  function list(): LoadedExtension[] {
    return [...loaded.values()];
  }
  function get(name: string): LoadedExtension | undefined {
    return loaded.get(name);
  }
  function tools(): RegisteredToolEntry[] {
    return [...toolsByExt.values()].flat();
  }
  function triggers(): RegisteredTriggerEntry[] {
    return [...triggersByExt.values()].flat();
  }

  return { list, get, discover, load, unload, reload, reportFailure, tools, triggers };
}

function loadScopeForAgent(store: Store, agentId: string): AgentScope {
  const row = store.select().from(tables.agents).where(eq(tables.agents.id, agentId)).all()[0];
  return (row?.scope as AgentScope) ?? {};
}

function upsertRow(store: Store, manifest: Manifest, path: string): string {
  const existing = store.select().from(tables.extensions).where(eq(tables.extensions.name, manifest.name)).all();
  if (existing.length > 0) return existing[0]!.id;
  const id = ulid();
  store
    .insert(tables.extensions)
    .values({
      id,
      name: manifest.name,
      path,
      status: "active",
      createdAt: Date.now(),
    })
    .run();
  return id;
}

function markStatus(store: Store, id: string, status: "active" | "inactive" | "crashed"): void {
  store.update(tables.extensions).set({ status }).where(eq(tables.extensions.id, id)).run();
}

/** Write a file into the extension's dir. Creates parent dirs. */
export function writeExtensionFile(extDir: string, relPath: string, content: string): void {
  const full = join(extDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}
