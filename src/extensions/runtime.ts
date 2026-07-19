// Extension runtime.
//
// This module owns the registries, gates, api-building, and lifecycle. The
// three points where agent-authored code actually executes — staging it,
// running its smoke gate, and importing + registering it — live behind the
// ExtensionExecutor seam (see executor.ts / executor-legacy.ts) so a future
// microVM backend can run that code in a guest without touching this file.
//
// Responsibilities:
//  1. Discover extensions under ~/.olle/extensions/<name>/
//  2. Parse and validate each manifest.json
//  3. Ask the executor to smoke-gate the staged code before activating.
//     Failure → mark inactive, emit an inbox-worthy event.
//  4. Ask the executor to register(api); track the returned unload handler
//  5. Track failure counts; on >=2 failures within 5 minutes mark crashed
//     and emit extension.crashed so the inbox can offer revert.
//
// Hot-reload: unload(old) → reload(same name). Bun's ESM cache is keyed by
// resolved path and ignores query strings, so the legacy executor busts it by
// staging a fresh copy under a uniquely-named dir rather than a query-string.

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
import { checkToolInvariants } from "../boot/invariants.ts";
import type { AgentScope } from "../store/schema.ts";
import type { ExtensionExecutor } from "./executor.ts";
import { createLegacyExecutor, stagingRootFor } from "./executor-legacy.ts";
import type {
  CallToolOptions,
  ExtensionApi,
  ExtensionCatalogProse,
  LoadedExtension,
  Manifest,
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
  /** Backend that runs agent-authored extension code (stage/smoke/register).
   *  Defaults to the in-process legacy executor; a microVM backend implements
   *  the same interface. */
  executor?: ExtensionExecutor;
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
  /** Best-effort: walk the error's stack frames and return the loaded
   *  extension name whose source they came from. Matches both the on-disk
   *  extensions dir (where `register()` runs from in dev) and the staging
   *  dir (where the compiled binary loads from at runtime). Returns
   *  undefined when no frame falls inside an extension — used by the
   *  daemon's uncaughtException guard to route stray throws into the
   *  existing circuit breaker, while still logging anything that can't be
   *  attributed. */
  attribute(err: unknown): string | undefined;
  tools(): Array<{ extensionId: string; tool: ToolDef }>;
  triggers(): Array<{ extensionId: string; trigger: TriggerDef }>;
  /** Catalog prose contributed by loaded extensions. Each loaded extension
   *  with a `manifest.catalog` yields one entry per category its own tools
   *  populate. Deterministically ordered (by extension name, then category)
   *  so the rendered catalog stays stable across calls — it lives in the
   *  cached identity prefix. */
  catalogProse(): ExtensionCatalogProse[];
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
  // One record per load, keyed by extensionId. Captured by closure into that
  // load's api + trigger emits; purgeRegistry flips `revoked` so every stale
  // reference throws. A reload builds a fresh record, so the new api works
  // while the old captured one stays revoked.
  const revocations = new Map<string, { revoked: boolean }>();
  const failureLog = new Map<string, number[]>();
  const threshold = opts.failureThreshold ?? 2;
  const windowMs = opts.failureWindowMs ?? 5 * 60 * 1000;
  const executor = opts.executor ?? createLegacyExecutor({ hostId: opts.hostId });

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

  // The legacy executor stages into stagingRootFor(hostId); attribute() must
  // match that same path, so both sides derive it from the one helper.
  const stagingRoot = stagingRootFor(opts.hostId);

  // Precompiled at construction: both dirs are stable for the lifetime
  // of the host, and `attribute()` runs on every uncaughtException —
  // re-escaping + re-compiling each call would be needless work.
  const attributionRegexes = [opts.extensionsDir, stagingRoot].map(
    (root) => new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^/]+)`, "g"),
  );

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

  function makeApi(
    manifest: Manifest,
    extensionId: string,
    extDir: string,
    revocation: { revoked: boolean },
  ): {
    api: ExtensionApi;
    unsubs: Unsubscribe[];
  } {
    const unsubs: Unsubscribe[] = [];
    const resolved = resolveManifestSecrets(manifest);
    const scratchDir = join(extDir, ".scratch");
    mkdirSync(scratchDir, { recursive: true });

    // After unload, every action method on this api throws. purgeRegistry has
    // already dropped the registrations; a stale reference acting now would
    // register into a dead slot or emit under an unloaded identity.
    const assertLive = () => {
      if (revocation.revoked) {
        throw new Error(
          `extensions: "${manifest.name}" was unloaded; re-register before acting`,
        );
      }
    };

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
        assertLive();
        // First-wins: a tool name is a single slot in the registry.
        // Rejecting a duplicate keeps toolsByName and toolsByExt
        // consistent — drift between the two is what wedged the LLM tool
        // list with two copies of the same name.
        const prior = toolsByName.get(tool.name);
        if (prior) {
          const sameExt = prior.extensionId === extensionId;
          opts.bus.publish({
            type: "tool.collision-rejected",
            payload: {
              tool: tool.name,
              priorExtension: prior.extensionName,
              rejectedExtension: callerName,
              sameExtension: sameExt,
            },
            hostId: opts.hostId,
            actorId: extensionId,
            durable: false,
          });
          console.warn(
            sameExt
              ? `[extensions] tool "${tool.name}" registered twice by "${callerName}" — dropping the second registration`
              : `[extensions] tool "${tool.name}" already registered by "${prior.extensionName}"; dropping registration from "${callerName}"`,
          );
          return;
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
        const invariants = checkToolInvariants(guarded);
        if (!invariants.ok) {
          const details = invariants.failures.map((f) => `[${f.code}] ${f.message}`).join("; ");
          throw new Error(
            `extensions: tool "${tool.name}" from "${callerName}" failed provider invariants: ${details}`,
          );
        }
        const entry: RegisteredToolEntry = {
          extensionId,
          extensionName: callerName,
          tool: guarded,
          resolveSecrets: resolveOwnSecrets,
        };
        let list = toolsByExt.get(extensionId);
        if (!list) toolsByExt.set(extensionId, (list = []));
        list.push(entry);
        toolsByName.set(tool.name, entry);
      },
      registerTrigger(trigger) {
        assertLive();
        let list = triggersByExt.get(extensionId);
        if (!list) triggersByExt.set(extensionId, (list = []));
        list.push({ extensionId, trigger });
      },
      registerTask(task: TaskRegistration) {
        assertLive();
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
                assertLive();
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
        assertLive();
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
        assertLive();
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
        assertLive();
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

  async function startTriggers(
    extensionId: string,
    manifest: Manifest,
    revocation: { revoked: boolean },
  ): Promise<void> {
    // A trigger declared with `type: X` is itself the authority statement
    // that this extension emits X events; cross-checking against
    // manifest.eventWrites would be double bookkeeping that only ever
    // catches manifest drift, never an actual unauthorised emit.
    // eventWrites continues to gate imperative api.publish() and task
    // emit() — see assertEventWrite in makeApi.
    const list = triggersByExt.get(extensionId) ?? [];
    const resolved = resolveManifestSecrets(manifest);
    for (const entry of list) {
      const emit = (payload: unknown) => {
        // A trigger that keeps firing after unload would emit under a dead
        // identity; drop the emit silently rather than resurrect it.
        if (revocation.revoked) return;
        opts.bus.publish({
          type: entry.trigger.type,
          payload,
          hostId: opts.hostId,
          actorId: extensionId,
          durable: true,
        });
      };
      await entry.trigger.start(emit, { hostId: opts.hostId, extensionId, secrets: resolved });
      entry.stop = entry.trigger.stop?.bind(entry.trigger);
    }
  }

  /** Drop all in-memory registrations bound to an extensionId and stop
   *  any partially-started triggers. Used by both unload() and the
   *  failed-load rollback — same job, two callers. Does NOT touch the
   *  `loaded` map or the DB row; the caller decides those. */
  async function purgeRegistry(extensionId: string, name: string): Promise<void> {
    // Revoke first: every api reference and trigger emit captured this
    // object, so flipping it neutralizes stale callers even before their
    // registrations are torn down below. Drop the map entry — the closures
    // hold the object, so a fresh load can mint a new record under the id.
    const revocation = revocations.get(extensionId);
    if (revocation) revocation.revoked = true;
    revocations.delete(extensionId);
    for (const un of subs.get(name) ?? []) {
      try {
        un();
      } catch {
        /* best-effort */
      }
    }
    subs.delete(name);
    await Promise.allSettled(
      (triggersByExt.get(extensionId) ?? []).map((e) => (e.stop ? e.stop() : undefined)),
    );
    for (const entry of tasksByExt.get(extensionId) ?? []) {
      try {
        entry.unregister();
      } catch {
        /* best-effort */
      }
    }
    for (const entry of toolsByExt.get(extensionId) ?? []) {
      // Only evict if we still own the name — a reload races register
      // before unload, so a newer entry may have taken the slot.
      if (toolsByName.get(entry.tool.name) === entry) {
        toolsByName.delete(entry.tool.name);
      }
    }
    tasksByExt.delete(extensionId);
    triggersByExt.delete(extensionId);
    toolsByExt.delete(extensionId);
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
    const staged = await executor.stage(extDir, name);

    // Smoke-gate before any side-effect-ful registration.
    await executor.smoke(staged, manifest, resolveManifestSecrets(manifest), opts.bus);

    const extensionId = upsertRow(opts.store, manifest, extDir);

    // One revocation record per load; purgeRegistry flips it on unload/rollback.
    const revocation = { revoked: false };
    revocations.set(extensionId, revocation);

    const { api, unsubs } = makeApi(manifest, extensionId, extDir, revocation);
    // Track subs *before* register runs so a partial register (e.g. one
    // that subscribes to several events, then throws on the next api.on
    // because of a manifest gate) is fully reachable by purgeRegistry.
    // The unsubs array is captured by reference inside makeApi, so every
    // api.on() pushes onto the same list this map holds.
    subs.set(name, unsubs);
    // Transactional registration: any throw between register() and the
    // final loaded.set must roll back all in-memory side effects, or the
    // next load attempt collides with orphaned tools/subs/triggers.
    let unloadHook: (() => void | Promise<void>) | undefined;
    try {
      ({ unload: unloadHook } = await executor.register(staged, api));
      await startTriggers(extensionId, manifest, revocation);
    } catch (err) {
      await purgeRegistry(extensionId, name);
      markStatus(opts.store, extensionId, "inactive");
      throw err;
    }

    const record: LoadedExtension = {
      id: extensionId,
      manifest,
      path: extDir,
      status: "active",
      failures: 0,
      unload: unloadHook ? async () => unloadHook!() : undefined,
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
    await purgeRegistry(record.id, name);
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
      const staged = await executor.stage(extDir, name);
      await executor.smoke(staged, manifest, resolveManifestSecrets(manifest), opts.bus);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  const errorStack = (err: unknown): string | undefined =>
    err && typeof err === "object" && typeof (err as { stack?: unknown }).stack === "string"
      ? (err as { stack: string }).stack
      : undefined;

  function attribute(err: unknown): string | undefined {
    const stack = errorStack(err);
    if (!stack) return undefined;
    // First loaded extension whose source the stack mentions. Returns on
    // first hit so a tall stack doesn't keep getting walked.
    for (const re of attributionRegexes) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stack)) !== null) {
        const name = m[1];
        if (name && loaded.has(name)) return name;
      }
    }
    return undefined;
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
  function catalogProse(): ExtensionCatalogProse[] {
    const out: ExtensionCatalogProse[] = [];
    // Sort loaded extensions by name so ordering is deterministic across
    // process restarts and load order — the catalog is cached and must not
    // shuffle for a fixed loaded set.
    const sortedLoaded = [...loaded.values()].sort((a, b) =>
      a.manifest.name.localeCompare(b.manifest.name),
    );
    for (const ext of sortedLoaded) {
      const catalog = ext.manifest.catalog;
      if (!catalog) continue;
      const entries = toolsByExt.get(ext.id) ?? [];
      // Distinct categories this extension's own tools declare — the catalog
      // binds only to categories it actually populates. Sorted for stability.
      const categories = [
        ...new Set(
          entries
            .map((e) => e.tool.category)
            .filter((c): c is string => typeof c === "string" && c.length > 0),
        ),
      ].sort();
      for (const category of categories) {
        out.push({
          category,
          tagline: catalog.tagline,
          body: catalog.blurb,
          toolClauses: catalog.tools,
        });
      }
    }
    return out;
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
    attribute,
    tools,
    triggers,
    catalogProse,
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
