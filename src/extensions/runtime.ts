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
import { latestCommitsBySubtree } from "./git.ts";
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
  /** Thread-routing resolver. Bridges call api.resolveMailbox(threadId)
   *  to find out if a thread has been retargeted away from the default
   *  mailbox. Omit when routing isn't available (tests). */
  resolveMailbox?: (threadId: string) => string | undefined;
}

export type SmokeResult = { ok: true } | { ok: false; error: string };

export interface ExtensionInventoryEntry {
  name: string;
  /** "registered" — currently loaded into the runtime.
   *  "unregistered" — present on disk with a valid manifest but never
   *    loaded (e.g. authored in a prior session, never call to register).
   *  "broken" — present on disk but the manifest is invalid or does not
   *    match the directory name; `error` carries the message. */
  status: "registered" | "unregistered" | "broken";
  path: string;
  error?: string;
  lastCommit?: { sha: string; author: string; date: number; subject: string };
}

export interface ExtensionHost {
  list(): LoadedExtension[];
  get(name: string): LoadedExtension | undefined;
  discover(): Promise<string[]>;
  load(name: string): Promise<LoadedExtension>;
  unload(name: string): Promise<void>;
  reload(name: string): Promise<LoadedExtension>;
  /** Full picture of what's on disk: registered, on-disk-but-unregistered,
   *  and broken/unloadable manifest cases. Lets agents (and the `olle extension list`
   *  CLI) discover extensions they authored in a prior session — without
   *  this they have to remember on their own that they exist. */
  inventory(): Promise<ExtensionInventoryEntry[]>;
  /** Run an extension's smoke gate without activating. Always stages a
   *  fresh copy (Bun's ESM cache is keyed by resolved path, so reusing
   *  the on-disk path would import a stale module after edits). Same
   *  staging + secret resolution path that `load()` uses, so a smoke
   *  that passes here will pass on register. */
  smokeTest(name: string): Promise<SmokeResult>;
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
  // Name→entry index so collision checks and cross-extension callTool
  // resolution are O(1). Kept in sync with toolsByExt.
  const toolsByName = new Map<string, RegisteredToolEntry>();
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

  function resolveManifestSecrets(manifest: Manifest): Record<string, string> {
    const out: Record<string, string> = {};
    if (manifest.secrets && opts.secrets) {
      for (const s of manifest.secrets) {
        const v = opts.secrets(s, manifest.name);
        if (v != null) out[s] = v;
      }
    }
    return out;
  }

  async function runSmoke(stagedDir: string, manifest: Manifest): Promise<void> {
    const smokePath = join(stagedDir, "smoke.ts");
    if (!existsSync(smokePath)) return; // no smoke.ts is allowed; tool-only extensions
    const url = pathToFileURL(smokePath).href;
    const mod = (await import(url)) as { smokeTest?: SmokeTest };
    if (typeof mod.smokeTest !== "function") return;
    await mod.smokeTest(opts.bus, { secrets: resolveManifestSecrets(manifest) });
  }

  function makeApi(manifest: Manifest, extensionId: string, extDir: string): {
    api: ExtensionApi;
    unsubs: Unsubscribe[];
  } {
    const unsubs: Unsubscribe[] = [];
    const resolved = resolveManifestSecrets(manifest);
    const scratchDir = join(extDir, ".scratch");
    mkdirSync(scratchDir, { recursive: true });

    // Fresh resolver captured into each tool entry so cross-extension
    // callTool sees target's own secrets, never the caller's. Re-reads
    // from opts.secrets on each call so rotation eventually propagates
    // without a full extension reload.
    const resolveOwnSecrets = () => resolveManifestSecrets(manifest);

    const callerAllowlist = new Set(manifest.callsTools ?? []);
    const eventReadAllowlist = new Set(manifest.eventReads ?? []);
    const eventWriteAllowlist = new Set(manifest.eventWrites ?? []);
    const callerName = manifest.name;
    const assertEventRead = (type: string, action: string) => {
      if (eventReadAllowlist.has(type) || eventReadAllowlist.has("*")) return;
      throw new Error(
        `extensions: "${callerName}" cannot ${action} "${type}" — add it to manifest.eventReads`,
      );
    };
    const assertEventWrite = (type: string, action: string) => {
      if (eventWriteAllowlist.has(type) || eventWriteAllowlist.has("*")) return;
      throw new Error(
        `extensions: "${callerName}" cannot ${action} "${type}" — add it to manifest.eventWrites`,
      );
    };

    const api: ExtensionApi = {
      hostId: opts.hostId,
      extensionId,
      rootAgentId: opts.defaultTaskAgentId,
      resolveMailbox: opts.resolveMailbox,
      secrets: resolved,
      scratchDir,
      registerTool(tool) {
        let list = toolsByExt.get(extensionId);
        if (!list) toolsByExt.set(extensionId, (list = []));
        const prior = toolsByName.get(tool.name);
        if (prior && prior.extensionId !== extensionId) {
          console.warn(
            `[extensions] tool name "${tool.name}" registered by both "${prior.extensionName}" and "${callerName}" — callTool resolution is ambiguous`,
          );
        }
        // LLM vendors reject tool specs without a JSON Schema; fall back
        // to an empty-object schema rather than 400 every chat turn.
        let guarded = tool;
        if (!tool.inputSchema || typeof tool.inputSchema !== "object") {
          console.warn(
            `[extensions] tool "${tool.name}" from "${callerName}" has no inputSchema — defaulting to { type: "object" }; please update the extension to declare a JSON Schema`,
          );
          guarded = { ...tool, inputSchema: { type: "object" } };
        }
        const entry: RegisteredToolEntry = {
          extensionId,
          extensionName: callerName,
          tool: guarded,
          resolveSecrets: resolveOwnSecrets,
        };
        list.push(entry);
        toolsByName.set(tool.name, entry);
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
        assertEventRead(task.eventType, "registerTask");
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
                assertEventWrite(type, "emit");
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
        assertEventRead(event, "subscribe to");
        const un = opts.bus.subscribe(event, handler);
        unsubs.push(un);
        return un;
      },
      publish<T>(
        type: string,
        payload: T,
        publishOpts?: {
          durable?: boolean;
          toAgentId?: string;
          threadId?: string;
          parentThreadId?: string;
          parentEventId?: string;
        },
      ) {
        assertEventWrite(type, "publish");
        opts.bus.publish({
          type,
          payload,
          hostId: opts.hostId,
          actorId: extensionId,
          durable: publishOpts?.durable ?? false,
          toAgentId: publishOpts?.toAgentId,
          threadId: publishOpts?.threadId,
          parentThreadId: publishOpts?.parentThreadId,
          parentEventId: publishOpts?.parentEventId,
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
        // Gate 2: tool exists. Collisions already warned at registerTool.
        const target = toolsByName.get(name);
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
    const eventWriteAllowlist = new Set(manifest.eventWrites ?? []);
    const assertTriggerWrite = (type: string) => {
      if (eventWriteAllowlist.has(type) || eventWriteAllowlist.has("*")) return;
      throw new Error(
        `extensions: "${manifest.name}" cannot emit trigger "${type}" — add it to manifest.eventWrites`,
      );
    };
    for (const entry of list) {
      assertTriggerWrite(entry.trigger.type);
      const emit = (payload: unknown) => {
        assertTriggerWrite(entry.trigger.type);
        opts.bus.publish({
          type: entry.trigger.type,
          payload,
          hostId: opts.hostId,
          actorId: extensionId,
          durable: true,
        });
      };
      const resolved = resolveManifestSecrets(manifest);
      await entry.trigger.start(emit, { hostId: opts.hostId, extensionId, secrets: resolved });
      entry.stop = entry.trigger.stop?.bind(entry.trigger);
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
    await runSmoke(stagedDir, manifest);

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
    // Stop triggers in parallel — a hung stop on one trigger shouldn't
    // block the rest (e.g. Discord gateway + poll on the same extension).
    await Promise.allSettled(
      (triggersByExt.get(record.id) ?? []).map((e) => (e.stop ? e.stop() : undefined)),
    );
    for (const entry of tasksByExt.get(record.id) ?? []) {
      try {
        entry.unregister();
      } catch {
        /* best-effort */
      }
    }
    for (const entry of toolsByExt.get(record.id) ?? []) {
      // Only evict if we still own the name — a reload races register
      // before unload, so a newer entry may have taken the slot.
      if (toolsByName.get(entry.tool.name) === entry) {
        toolsByName.delete(entry.tool.name);
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

  async function inventory(): Promise<ExtensionInventoryEntry[]> {
    const entries = existsSync(opts.extensionsDir) ? readdirSync(opts.extensionsDir) : [];
    // One git call total, then look up by entry name. Inventory is read-
    // only — git failure is tolerated (empty map = no lastCommit fields).
    const lastCommits = existsSync(join(opts.extensionsDir, ".git"))
      ? safeLatestCommits(opts.extensionsDir)
      : new Map();
    const out: ExtensionInventoryEntry[] = [];
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const dir = join(opts.extensionsDir, entry);
      let stat;
      try {
        stat = statSync(dir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      // A scratch/in-progress dir without a manifest is invisible until the
      // author drops one in.
      if (!existsSync(join(dir, "manifest.json"))) continue;

      let inv: ExtensionInventoryEntry;
      try {
        const manifest = readManifest(dir);
        if (manifest.name !== entry) {
          throw new Error(`extensions: manifest name "${manifest.name}" != dir "${entry}"`);
        }
        inv = {
          name: manifest.name,
          status: loaded.has(manifest.name) ? "registered" : "unregistered",
          path: dir,
        };
      } catch (err) {
        inv = { name: entry, status: "broken", path: dir, error: (err as Error).message };
      }

      const recent = lastCommits.get(entry);
      if (recent) inv.lastCommit = recent;

      out.push(inv);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async function smokeTest(name: string): Promise<SmokeResult> {
    const extDir = resolve(opts.extensionsDir, name);
    if (!existsSync(extDir)) {
      return { ok: false, error: `extensions: ${name} not found on disk` };
    }
    let manifest: Manifest;
    try {
      manifest = readManifest(extDir);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    if (manifest.name !== name) {
      return {
        ok: false,
        error: `extensions: manifest name "${manifest.name}" != dir "${name}"`,
      };
    }
    try {
      const stagedDir = stage(extDir, name);
      await runSmoke(stagedDir, manifest);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
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

  return {
    list,
    get,
    discover,
    inventory,
    load,
    unload,
    reload,
    smokeTest,
    reportFailure,
    tools,
    triggers,
  };
}

function safeLatestCommits(dir: string): Map<string, { sha: string; author: string; date: number; subject: string }> {
  try {
    return latestCommitsBySubtree(dir);
  } catch {
    return new Map();
  }
}

function loadScopeForAgent(store: Store, agentId: string): AgentScope {
  const row = store.select().from(tables.agents).where(eq(tables.agents.id, agentId)).all()[0];
  if (!row) {
    throw new Error(`extensions: unknown acting agent "${agentId}" — refusing to run unscoped`);
  }
  return (row.scope as AgentScope) ?? {};
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
