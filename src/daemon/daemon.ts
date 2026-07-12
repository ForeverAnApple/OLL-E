import { ensurePaths, resolvePaths, type OllePaths } from "../paths.ts";
import { openStore, tables, type Store } from "../store/index.ts";
import { createBus, persistToStore, type EventBus, type Unsubscribe } from "../bus/index.ts";
import { createIpcServer, type IpcServer } from "../ipc/server.ts";
import { createExtensionHost, ensureRepo, type ExtensionHost } from "../extensions/index.ts";
import { syncExtensionDocs } from "../extensions/docs.ts";
import { createLedger, type Ledger } from "../ledger/index.ts";
import { createScheduler, type Scheduler } from "../scheduler/index.ts";
import {
  createAnthropicAdapter,
  createOpenAIAdapter,
  createRouterLlm,
  providerForModel,
  type RouterAdapters,
  type RouterLlm,
} from "../llm/index.ts";
import {
  fallbackForProvider,
  readDefaultModel,
  writeDefaultModel,
} from "./model-preference.ts";
import {
  startAgentLoop,
  createAgentManager,
  type AgentLoop,
  type AgentManager,
} from "../agent/index.ts";
import { buildMetaTools } from "../tools/meta.ts";
import { buildObservabilityTools } from "../tools/observability.ts";
import { buildInboxTools } from "../tools/inbox.ts";
import { buildToolResultTools } from "../tools/tool-results.ts";
import { buildTeamTools } from "../tools/team.ts";
import { buildScheduleTools } from "../tools/schedule.ts";
import { createCronScheduler, type CronScheduler } from "../schedule/index.ts";
import { installGrantScopeExecutor, type GrantScopeExecutor } from "../permissions/index.ts";
import { startRealMeshBridge, type RealMeshBridge } from "../mesh/bridge.ts";
import { wireBridgeToBus } from "../mesh/wire.ts";
import type { ToolDef } from "../extensions/types.ts";
import { buildModelTools } from "../tools/model.ts";
import { buildReasoningTools } from "../tools/reasoning.ts";
import { createToolResultStore } from "../store/tool-results.ts";
import { checkCoreInvariants, formatFailures } from "../boot/invariants.ts";
import { startChatHealthMonitor, type ChatHealthMonitor } from "./chat-health.ts";
import { installFaultIsolation, type FaultIsolation } from "./fault-isolation.ts";
import {
  buildMemoryTools,
  loadIdentity,
  resolveBootModel,
  resolveReasoningEffort,
  startMemoryProjector,
  type MemoryProjector,
} from "../memory/index.ts";
import { createInbox, type Inbox } from "../inbox/index.ts";
import { ulid } from "../id/index.ts";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";

export interface StartDaemonOptions {
  /** Override data root; defaults to $OLLE_HOME or ~/.olle */
  root?: string;
  /** Version string the daemon advertises. */
  version?: string;
  /** Silent mode for tests. */
  quiet?: boolean;
  /** Listening port for the mesh WebSocket listener. Defaults to
   *  $OLLE_MESH_PORT or 0 (OS-assigned). Pick a known port in production
   *  so peer addrs in bearer codes stay stable across daemon restarts. */
  meshPort?: number;
  /** Disable the mesh layer entirely. Useful for tests that never touch
   *  teams — skips opening a listener port. Defaults to true. */
  enableMesh?: boolean;
}

export interface Daemon {
  readonly paths: OllePaths;
  readonly hostId: string;
  readonly store: Store;
  readonly bus: EventBus;
  readonly ipc: IpcServer;
  readonly extensions: ExtensionHost;
  readonly ledger: Ledger;
  readonly scheduler: Scheduler;
  readonly inbox: Inbox;
  readonly rootAgentId: string;
  readonly humanAgentId: string;
  readonly bridge?: RealMeshBridge;
  readonly teamTools: ToolDef[];
  readonly chat?: AgentLoop;
  readonly chatAgentId?: string;
  readonly agentManager?: AgentManager;
  shutdown(): Promise<void>;
}

export async function startDaemon(opts: StartDaemonOptions = {}): Promise<Daemon> {
  const paths = resolvePaths(opts.root);
  ensurePaths(paths);

  checkNotRunning(paths);

  const store = openStore({ path: paths.dbFile });
  const hostId = ensureHostRow(store);
  const bus = createBus({ hostId, persist: persistToStore(store) });

  // Human agent + AI delegate always exist. The human agent is the
  // owns-money root (LOG 2026-04-23 collapse of principals into agents);
  // the AI root agent is its first-contact delegate, parented under it,
  // and extensions register tasks against the AI root even when the chat
  // loop (which needs an API key) isn't running.
  const humanAgentId = ensureHumanAgent(store, hostId, "root-human");
  const rootAgentId = ensureAiRootAgent(store, hostId, "root", humanAgentId);

  const scheduler = createScheduler({ bus, store, hostId });
  scheduler.recoverLost();
  const inbox = createInbox({ bus, store, hostId });
  // Cron subsystem — arms standing jobs (type='cron' triggers rows) and
  // fires them deterministically. Coupled to the schedule_* tools through
  // the schedule.armed/schedule.cancelled events, so a job scheduled mid-run
  // starts firing without a restart. loadAndArm re-arms persisted jobs on
  // boot; skip-missed-while-down means no catch-up burst for missed fires.
  const cron: CronScheduler = createCronScheduler({ bus, store, hostId });
  cron.loadAndArm();
  // grant_scope executor — turns an approved permission proposal into an
  // actual agents.scope mutation (closes the "approve appears to hang" gap).
  // Event-driven cousin of the inbox staleness sweep.
  const grantExec: GrantScopeExecutor = installGrantScopeExecutor({ bus, store, hostId });
  // Staleness sweeper. Each decision carries a wall-clock deadline; nothing
  // moves it from `open` → `stale` unless someone calls sweepStale(). Run
  // it on a timer so async-by-default actually means async — agents that
  // proposed and moved on get their `decision.resolved` (vote=stale) when
  // the deadline lapses, regardless of whether anyone reads the inbox.
  // 30s is comfortably above the cost of a single SELECT and below the
  // staleness windows we expect agents to set (typically minutes/hours).
  const sweepIntervalMs = 30_000;
  const sweepTimer = setInterval(() => {
    try {
      inbox.sweepStale();
    } catch (err) {
      // Transient store failure shouldn't kill the timer. Log loudly;
      // the next tick tries again.
      if (!opts.quiet) {
        // eslint-disable-next-line no-console -- daemon infra
        console.error(`olle: inbox sweepStale failed: ${(err as Error).message ?? err}`);
      }
    }
  }, sweepIntervalMs);
  // Don't keep the event loop alive purely to sweep — if everything else
  // (IPC, bus, projector) has shut down, the daemon should exit.
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
  // Memory projector — folds memory.* events into the `memories` table.
  // Must start before any memory writes happen (extensions loading,
  // agent spawn, etc.) so nothing is lost before the subscriber is live.
  const memoryProjector: MemoryProjector = startMemoryProjector({ bus, store, hostId });

  // Late-bound manager reference: extensions are created and loaded before
  // the agent manager decision. During that boot window, mailbox resolution
  // intentionally returns undefined so bridges use rootAgentId.
  const managerHolder: { ref: AgentManager | undefined } = { ref: undefined };

  // ─── Mesh bridge ─────────────────────────────────────────────────────
  //
  // Real WebSocket peer mesh for cross-host federation. Wired before
  // extension loading so events the loaders emit (extension.loaded,
  // task.registered, etc.) can cross to peer cells if they're team-scoped.
  // Port defaults to $OLLE_MESH_PORT or 0 (OS-assigned). Set a known port
  // in production so bearer-code addrs stay stable across restarts.
  const meshEnabled = opts.enableMesh !== false;
  const meshPort = resolveMeshPort(opts.meshPort);
  let bridge: RealMeshBridge | undefined;
  let wiredBridge: { unwire(): void } | undefined;
  if (meshEnabled) {
    bridge = startRealMeshBridge({
      bus,
      store,
      hostId,
      port: meshPort,
      loadTeams: () => loadTeamsFromStore(store, paths),
      onPeerStatus: (params) => persistPeerStatus(store, params),
      redeemInvite: (params) => redeemInviteInStore(store, params),
    });
    try {
      await bridge.start();
    } catch (err) {
      if (!opts.quiet) {
        console.error(`olle: mesh bridge failed to start: ${(err as Error).message}`);
      }
      bridge = undefined;
    }
    if (bridge) {
      wiredBridge = wireBridgeToBus({ bus, bridge: bridge.asBridge() });
    }
  }

  // Team tools — registered even when mesh is disabled so the IPC surface
  // can return a clean "mesh disabled" error rather than 404. When the
  // bridge is undefined, tool calls fail at execute-time with a clear
  // diagnostic; status remains read-only and always works.
  const teamTools: ToolDef[] = bridge
    ? buildTeamTools({ bus, store, hostId, bridge, olleRoot: paths.root })
    : [];

  ensureRepo(paths.extensionsDir);
  // Materialize the embedded extension API contract into the repo so agents
  // can read it via read_extension_file. Idempotent — only a changed doc writes.
  syncExtensionDocs(paths.extensionsDir);
  const extensions = createExtensionHost({
    bus,
    store,
    hostId,
    extensionsDir: paths.extensionsDir,
    scheduler,
    defaultTaskAgentId: rootAgentId,
    secrets: (name) => readSecret(paths.secretsDir, name),
    resolveMailbox: (threadId) => managerHolder.ref?.resolveMailbox(threadId),
  });
  const ledger = createLedger({ bus, store, hostId });

  // Route stray throws (timer callbacks, microtasks, naked promise
  // rejections) into the existing per-extension circuit breaker instead
  // of letting Node terminate the daemon. Architecture: crashed extensions
  // auto-disable; the daemon does not. Installed once, before any
  // extension code runs, so first-tick throws are covered too.
  const faultIsolation: FaultIsolation = installFaultIsolation({
    host: extensions,
    log: opts.quiet ? () => {} : undefined,
  });

  // Tracked so `status.chat` can explain the absence — the IPC handler
  // closes over these and reads them lazily, so chat startup can race
  // ipc.listen without a window of "unknown" answers.
  let chat: AgentLoop | undefined;
  let chatAgentId: string | undefined;
  let chatHealth: ChatHealthMonitor | undefined;
  let chatDisabledReason: string | undefined;
  // The multi-provider router. Lives in outer state so the `model.set`
  // and `secret.set` subscribers can mutate it (switch active model,
  // hot-add a provider when a second API key lands) without restarting
  // chat.
  let router: RouterLlm | undefined;

  const ipc = createIpcServer({
    socketPath: paths.socketFile,
    bus,
    version: opts.version ?? "0.0.0",
    extensions,
    paths,
    store,
    rootAgentId,
    humanAgentId,
    inbox,
    teamTools,
    meshEnabled: bridge !== undefined,
    chatStatus: () => ({
      enabled: chat !== undefined,
      reason: chatDisabledReason,
    }),
    chatCancel: (threadId: string) => (chat ? chat.cancel(threadId) : false),
    modelControl: {
      current: () =>
        router ? router.defaultModel : readDefaultModel(paths.defaultModelFile),
      validate: (model: string) => {
        // Always reject unknown provider prefixes (typos like
        // "claud-opus-4-7"). When the router is alive, also reject
        // models whose provider has no loaded adapter — refuses to
        // persist a default the daemon can't actually use.
        const provider = providerForModel(model);
        if (router && !router.hasAdapter(provider)) {
          const keyName = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
          throw new Error(
            `model "${model}" requires the ${provider} adapter — set ${keyName} via \`olle secret set ${keyName}\``,
          );
        }
      },
    },
  });
  await ipc.listen();

  // Discover + load extensions already on disk.
  for (const name of await extensions.discover()) {
    try {
      await extensions.load(name);
    } catch (err) {
      if (!opts.quiet) {
        console.error(`olle: extension "${name}" failed to load: ${(err as Error).message}`);
      }
      bus.publish({
        type: "extension.load-failed",
        hostId,
        actorId: hostId,
        durable: true,
        payload: { name, error: (err as Error).message },
      });
    }
  }

  // Root agent loop — only if there's an API key. Without it the daemon
  // still runs but `olle chat` just bounces with chat.error. Note: this
  // is no longer a "chat agent"; it's the generic agent drain loop
  // anchored to root's mailbox. Bridges publish into that mailbox.
  //
  // Bringup is split into a helper so it runs in two scenarios: at boot
  // (when the key is already on disk) and on a `secret.set` event for
  // ANTHROPIC_API_KEY (when the principal sets the key after install).
  // The latter is the "constraints feel like physics" path — adding the
  // key brings the agent alive without a daemon restart.
  const tryBringChatAgentUp = (): { brought: boolean; reason?: string } => {
    // Idempotent: a `secret.set` event that races with another bringup
    // attempt sees chat already running and short-circuits cleanly.
    if (chat) return { brought: true };
    // Build whichever provider adapters have keys on disk; the router
    // refuses to start if the currently selected model's provider is
    // missing. Either-or, not both-required — a host with only an OpenAI
    // key (or only an Anthropic key) is a valid v1 install.
    const anthropicKey = readSecret(paths.secretsDir, "ANTHROPIC_API_KEY");
    const openaiKey = readSecret(paths.secretsDir, "OPENAI_API_KEY");
    const adapters: RouterAdapters = {};
    if (anthropicKey) adapters.anthropic = createAnthropicAdapter({ apiKey: anthropicKey });
    if (openaiKey) adapters.openai = createOpenAIAdapter({ apiKey: openaiKey });
    if (!adapters.anthropic && !adapters.openai) {
      return {
        brought: false,
        reason:
          "No LLM API key stored. Set ANTHROPIC_API_KEY (for claude-*) or OPENAI_API_KEY (for gpt-*/o*) via `olle secret set <NAME>` — chat will come alive automatically.",
      };
    }
    const desiredModel = readDefaultModel(paths.defaultModelFile);
    // Fall back to whichever provider IS loaded if the desired model's
    // provider has no key on disk. "Constraints feel like physics" — a
    // host with one key shouldn't refuse to boot just because the
    // persisted default points at a different provider. The user keeps
    // their stated preference; we just temporarily use a runnable model
    // until the missing key arrives.
    let bootModel = desiredModel;
    try {
      const desiredProvider = providerForModel(desiredModel);
      if (!adapters[desiredProvider]) {
        const fallbackProvider = adapters.anthropic ? "anthropic" : "openai";
        bootModel = fallbackForProvider(fallbackProvider);
        if (!opts.quiet) {
          console.log(
            `olle: ${desiredModel} requires ${desiredProvider} key (missing) — booting on ${bootModel} until it arrives`,
          );
        }
      }
    } catch {
      // Unknown prefix in the persisted default. Let the router throw
      // below with its own diagnostic; we don't try to repair garbage.
    }
    let localRouter: RouterLlm;
    try {
      localRouter = createRouterLlm({ adapters, defaultModel: bootModel });
    } catch (err) {
      // Even the fallback failed (e.g. persisted default has an unknown
      // prefix). Surface the router's diagnostic.
      return { brought: false, reason: (err as Error).message };
    }
    const rootLoopAgentId = rootAgentId;
    // Construction is split into two phases:
    //   1. Build everything into LOCAL bindings.
    //   2. Commit to the outer closure state only after every step succeeds.
    // If anything in phase 1 throws (e.g. createToolResultStore against a
    // wedged db, startAgentLoop against a corrupt threads dir), the outer
    // state stays untouched — the bouncer keeps reflecting the old reason
    // and a future `secret.set` retries from a clean slate.
    let localManager: AgentManager | undefined;
    let localChat: AgentLoop | undefined;
    let localHealth: ChatHealthMonitor | undefined;
    try {
      const llm = localRouter;
      // Spilled tool-output store. Owned by the daemon so chat-loop
      // truncation and the read_tool_result recovery tool share one row
      // surface — same physics on write and read.
      const toolResultStore = createToolResultStore({ db: store.raw, hostId });
      const persistActorId = rootLoopAgentId;
      const toolTruncate = {
        persist: ({
          id,
          threadId,
          toolName,
          content,
        }: { id: string; threadId: string; toolName: string; content: string }) =>
          toolResultStore.persist({
            id,
            threadId,
            toolName,
            content,
            actorId: persistActorId,
            hostId,
          }),
      };
      // Manager first — meta-tools need a reference so spawn_agent etc.
      // resolve. The root loop gets registered into it after start.
      localManager = createAgentManager({
        bus,
        store,
        hostId,
        llm,
        extensions,
        ledger,
        inbox,
        ownerAgentId: humanAgentId,
        threadsDir: paths.threadsDir,
        secretsDir: paths.secretsDir,
        hostContext: buildHostContextPrompt(paths, hostId),
        resolveModel: (agentId) => resolveBootModel(store, agentId),
        resolveEffort: (agentId, model) => resolveReasoningEffort(store, agentId, model),
        toolTruncate,
      });
      const coreTools = [
        ...buildMetaTools({
          bus,
          extensions,
          extensionsDir: paths.extensionsDir,
          authorName: rootLoopAgentId,
          secretsDir: paths.secretsDir,
          agentManager: localManager,
          paths,
        }),
        ...buildMemoryTools({ bus, store, hostId }),
        // Self-modification of the model the agent thinks with. Writes a
        // private thinking-model memory; resolveThinkingModel reads it back
        // at loop start (see `model:` on startAgentLoop below).
        ...buildModelTools({
          bus,
          store,
          hostId,
          // Smoke-test a candidate model with a 1-token call before the
          // switch commits — see set_thinking_model. Invalid/unserved
          // models throw here and the switch is rejected.
          //
          // This is a LIVENESS check, not a generation: it must fail fast.
          // The adapter's normal request path retries transient failures up
          // to 40× with exponential backoff (right for real turns, riding
          // out overload windows). For the probe that's a trap — a probe to
          // an overloaded/unserved model would grind through minutes of
          // retries while BLOCKING the agent turn that called the switch.
          // Bound it with a short timeout: a model that can't answer "ok" in
          // one token within the window is rejected, the turn completes, and
          // the agent stays on its current model (recoverable, no brick).
          probe: async (model, actorId) => {
            const PROBE_TIMEOUT_MS = 15_000;
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
            try {
              const completion = await llm.complete({
                model,
                messages: [{ role: "user", content: "ok" }],
                maxTokens: 1,
                signal: ctl.signal,
              });
              // Tiny (~a dozen tokens) but real, billed spend — record it
              // so the ledger covers 100% of LLM call sites. A failed
              // probe throws before here; the SDK surfaces no usage for
              // failed calls, so there is nothing to record on that path.
              ledger.record({
                actorId,
                threadId: "model-probe",
                ownerAgentId: humanAgentId,
                provider: llm.provider,
                model,
                inputTokens: completion.usage.inputTokens,
                outputTokens: completion.usage.outputTokens,
                cacheReadTokens: completion.usage.cacheReadInputTokens,
                cacheCreationTokens: completion.usage.cacheCreationInputTokens,
              });
            } catch (err) {
              if (ctl.signal.aborted) {
                throw new Error(
                  `probe timed out after ${PROBE_TIMEOUT_MS / 1000}s — the provider is slow/overloaded or "${model}" is not served on this key`,
                );
              }
              throw err;
            } finally {
              clearTimeout(timer);
            }
          },
        }),
        // Self-modification of how hard the agent thinks. Writes a private
        // reasoning-effort memory; resolveReasoningEffort reads it back at
        // loop start (see `effort:` on startAgentLoop below).
        ...buildReasoningTools({ bus, store, hostId }),
        // World legibility — agents read their own ledger, runs, threads,
        // budget, and self-state through these. Same query layer the CLI
        // uses (no privileged human read surface).
        ...buildObservabilityTools({ store }),
        // Decision-inbox surface — same Inbox the askUp chain writes to and
        // the CLI (`olle inbox`) reads from. mail_list is always-loaded
        // (orientation tool); mail_respond is deferred (only needed when
        // voting on a proposal).
        ...buildInboxTools({ inbox, ownerAgentId: humanAgentId, bus, hostId, store }),
        // Recovery surface for spilled tool output. Always-loaded — when an
        // oversize result lands, the agent needs this in the same turn or
        // it'd burn an extra round-trip just to learn the recovery path.
        ...buildToolResultTools({ store: toolResultStore }),
        // Team substrate — cell-to-cell federation. Empty when the mesh
        // is disabled (test daemon, missing bridge), so the agent's
        // catalog reflects "team category absent" rather than offering
        // tools that would always fail.
        ...teamTools,
        // Standing jobs — the agent schedules cron'd natural-language
        // instructions for itself (the push-first surface). Deferred by
        // default; discovered through the catalog's "scheduling" category.
        ...buildScheduleTools({ bus, store, hostId }),
      ];
      // Boot invariants — last gate before chat goes live. Tool-name
      // duplication, malformed schemas, etc. surface here as a named
      // failure instead of as a provider 400 on every turn. Daemon stays
      // up either way; chat refuses to start when the registry is broken,
      // and the principal hears via the inbox if the store is reachable.
      const invariants = checkCoreInvariants(coreTools);
      if (!invariants.ok) {
        const summary = formatFailures(invariants);
        const reason = `${summary} — see \`olle inbox\` for the full diagnostic.`;
        if (!opts.quiet) console.error(`olle: ${summary}`);
        bus.publish({
          type: "daemon.invariant-failed",
          hostId,
          actorId: hostId,
          durable: true,
          payload: { failures: invariants.failures },
        });
        try {
          inbox.propose({
            ownerAgentId: humanAgentId,
            // FK on decisions.proposing_agent_id → agents; hostId would
            // violate it. Root agent is the closest legitimate proposer
            // for environment-level diagnostics.
            proposingAgentId: rootAgentId,
            tier: "vision",
            summary: "core tool invariants failed — chat is disabled",
            payload: {
              action: "system_diagnostic",
              kind: "boot-invariants",
              failures: invariants.failures,
              recovery:
                "Inspect recent commits to src/tools/* and src/daemon/daemon.ts; revert the registration that introduced the offender(s).",
            },
            rollbackPlan: "git log -- src/tools/ src/daemon/daemon.ts",
          });
        } catch {
          // Inbox propose is best-effort — never let a secondary failure
          // mask the primary diagnostic on stderr.
        }
        // localManager has no registered loops yet; safe to drop on the
        // floor (its shutdown is a no-op over an empty map).
        return { brought: false, reason };
      }
      // Children inherit the same tool set so they can themselves spawn,
      // read extension files, etc. Scope still gates what they get to use.
      localManager.setCoreTools(coreTools);
      if (process.env.OLLE_MODEL && !opts.quiet) {
        const resolved = resolveBootModel(store, rootLoopAgentId);
        console.log(
          `olle: OLLE_MODEL=${process.env.OLLE_MODEL} rescue override → boot model ${resolved ?? "(host default)"}`,
        );
      }
      localChat = startAgentLoop({
        bus,
        store,
        hostId,
        llm,
        agentId: rootLoopAgentId,
        extensions,
        coreTools,
        ledger,
        inbox,
        ownerAgentId: humanAgentId,
        threadsDir: paths.threadsDir,
        secretsDir: paths.secretsDir,
        toolTruncate,
        // The agent's self-chosen model + effort (private memories), resolved
        // per-thread at thread creation rather than once at loop start, so a
        // `set_thinking_model` / `set_reasoning_effort` switch applies on the
        // next NEW thread without a daemon restart; active threads keep what
        // they started with. The `OLLE_MODEL` env override (rescue hatch)
        // takes precedence — see resolveBootModel.
        resolveModel: () => resolveBootModel(store, rootLoopAgentId),
        resolveEffort: () => {
          const model = resolveBootModel(store, rootLoopAgentId) ?? llm.defaultModel;
          return resolveReasoningEffort(store, rootLoopAgentId, model);
        },
        // Boot prompt branches on whether identity has been seeded yet
        // (LOG 2026-04-28). Resolve at turn-time, not daemon-start-time:
        // fresh installs can seed identity during the first conversation,
        // and the next turn in the same daemon must use the normal prompt.
        system: () =>
          hasSeededIdentity(store, rootLoopAgentId)
            ? buildNormalPrompt(paths, hostId)
            : buildBootstrapPrompt(paths, hostId),
      });
      localManager.register(rootLoopAgentId, localChat);
      // Crash funnel: repeated chat.error events auto-propose an inbox
      // diagnostic so the principal hears even when chat itself is dead.
      localHealth = startChatHealthMonitor({
        bus,
        inbox,
        hostId,
        ownerAgentId: humanAgentId,
        agentId: rootLoopAgentId,
      });
    } catch (err) {
      // Roll back any partial wiring before reporting up. Manager owns
      // every loop it registered (only `localChat` here), so a single
      // shutdown call cleans both.
      try {
        localManager?.shutdown();
      } catch {
        /* best-effort */
      }
      try {
        localHealth?.stop();
      } catch {
        /* best-effort */
      }
      return {
        brought: false,
        reason: `chat-agent bringup threw: ${(err as Error).message ?? err}. Check ~/.olle/logs/.`,
      };
    }
    // Phase 2 — commit to outer state. Once any of these is set, the
    // bouncer's next dispatch sees chat alive and the secret.set handler
    // skips re-entry.
    chat = localChat;
    chatAgentId = rootLoopAgentId;
    chatHealth = localHealth;
    managerHolder.ref = localManager;
    router = localRouter;
    return { brought: true };
  };

  // Dead-mailbox bouncer. Whenever chat is disabled (no key or invariants
  // failed), every chat.input addressed to root would otherwise sit on
  // the bus with no subscriber — silent waiting forever, on the CLI and
  // on every bridge equally. Echo a chat.error back so the channel of
  // first contact (and any future channel) gets a clear diagnostic
  // instead of dead air. Transport-agnostic by construction: the same
  // event reaches the CLI, Discord, GitHub, anything.
  //
  // The unsub handle is captured so we can tear the bouncer down the
  // moment chat comes alive (initial bringup or via secret.set).
  let bouncerUnsub: Unsubscribe | undefined;
  const installBouncer = (): void => {
    if (bouncerUnsub) return;
    bouncerUnsub = bus.subscribe("chat.input", (ev) => {
      if (ev.toAgentId !== rootAgentId) return;
      if (!ev.threadId) return;
      bus.publish({
        type: "chat.error",
        hostId,
        actorId: rootAgentId,
        parentEventId: ev.id,
        threadId: ev.threadId,
        durable: true,
        payload: {
          error: `chat agent disabled: ${chatDisabledReason ?? "unknown reason"}`,
        },
      });
    });
  };
  const removeBouncer = (): void => {
    bouncerUnsub?.();
    bouncerUnsub = undefined;
  };

  // Initial bringup. If the key is already on disk, chat goes live now;
  // otherwise the bouncer stays installed until a `secret.set` event for
  // ANTHROPIC_API_KEY arrives (see subscription below).
  //
  // This call is also the safety net that makes the IPC startup race
  // benign: between `ipc.listen()` and the secret.set subscription
  // below, a `secrets.set` IPC arrival writes the file and publishes an
  // event with no subscriber yet. The event is dropped, but the file
  // is on disk, and `tryBringChatAgentUp` re-reads the secrets dir, so
  // the dropped-event path still ends with chat alive.
  const initial = tryBringChatAgentUp();
  if (!initial.brought) {
    chatDisabledReason = initial.reason;
    if (!opts.quiet) {
      console.log(`olle: chat agent disabled — ${initial.reason}`);
    }
    installBouncer();
  }

  // Hot-reload: when the principal stores an LLM API key after install,
  // wake chat (if down) or hot-add the provider's adapter to the router
  // (if up) without forcing a daemon restart. Constraints feel like
  // physics — adding the resource adds the capability.
  //
  // Key rotation on the SAME provider with chat already up is still a
  // restart concern: the running adapter captured the prior key and we
  // don't swap it out under the agent's feet. `olle daemon restart`.
  bus.subscribe<{ name?: string }>("secret.set", (ev) => {
    const name = ev.payload?.name;
    if (name !== "ANTHROPIC_API_KEY" && name !== "OPENAI_API_KEY") return;
    if (chat && router) {
      // Chat is up — hot-add the adapter if it wasn't already loaded.
      // (Same-provider re-set is the rotation case noted above; we don't
      // overwrite the running adapter.)
      const provider = name === "ANTHROPIC_API_KEY" ? "anthropic" : "openai";
      if (!router.hasAdapter(provider)) {
        const key = readSecret(paths.secretsDir, name);
        if (key) {
          const adapter =
            provider === "anthropic"
              ? createAnthropicAdapter({ apiKey: key })
              : createOpenAIAdapter({ apiKey: key });
          router.setAdapter(provider, adapter);
          if (!opts.quiet) console.log(`olle: ${name} received — ${provider} adapter loaded`);
          // Reapply the persisted preference if it pointed at this
          // provider and was overridden by the boot fallback. The
          // user's stated default takes precedence once it becomes
          // runnable.
          const desired = readDefaultModel(paths.defaultModelFile);
          if (desired !== router.defaultModel) {
            try {
              const desiredProvider = providerForModel(desired);
              if (desiredProvider === provider) {
                router.setDefaultModel(desired);
                if (!opts.quiet) console.log(`olle: restored persisted default model → ${desired}`);
              }
            } catch {
              // Persisted default has an unknown prefix — leave the
              // router on the fallback model; the user can `olle model
              // <name>` to fix it.
            }
          }
        }
      }
      return;
    }
    if (chat) return;
    const r = tryBringChatAgentUp();
    if (r.brought) {
      chatDisabledReason = undefined;
      removeBouncer();
      if (!opts.quiet) {
        console.log(`olle: ${name} received — chat agent live`);
      }
    } else if (r.reason) {
      // Only update on real failures — the idempotent early-return
      // (chat already up) goes through the `r.brought` branch above.
      chatDisabledReason = r.reason;
    }
  });

  // Live model swap. The IPC `model.set` handler persists to the
  // default-model file and publishes this event; we mutate the router
  // here so the next chat turn picks up the new model. If chat is down,
  // the next bringup reads the file and uses the new model.
  bus.subscribe<{ model?: string }>("model.set", (ev) => {
    const model = ev.payload?.model;
    if (typeof model !== "string" || model.length === 0) return;
    if (!router) return;
    try {
      router.setDefaultModel(model);
      if (!opts.quiet) console.log(`olle: default model → ${model}`);
    } catch (err) {
      // Provider missing for this model. The IPC handler already
      // surfaced the error to the caller; log it so the daemon trail
      // has the same diagnostic.
      if (!opts.quiet) console.error(`olle: model.set rejected — ${(err as Error).message}`);
    }
  });

  writeFileSync(paths.pidFile, String(process.pid), "utf8");

  if (!opts.quiet) {
    // eslint-disable-next-line no-console -- daemon startup banner
    console.log(
      `olle daemon listening on ${paths.socketFile} (host ${hostId}, pid ${process.pid})`,
    );
  }

  // Emit a startup event so tail clients see lifecycle state.
  bus.publish({
    type: "daemon.started",
    payload: { version: opts.version ?? "0.0.0" },
    hostId,
    actorId: hostId,
    durable: true,
  });

  const shutdown = async () => {
    bus.publish({
      type: "daemon.stopping",
      payload: {},
      hostId,
      actorId: hostId,
      durable: true,
    });
    // Manager shutdown stops every tracked loop (including the root);
    // explicit chat?.stop() is redundant when the manager owns it, but
    // safe if the manager never came up (no API key).
    managerHolder.ref?.shutdown();
    chatHealth?.stop();
    chat?.stop();
    clearInterval(sweepTimer);
    memoryProjector.stop();
    cron.close();
    grantExec.stop();
    scheduler.close();
    for (const ext of extensions.list()) {
      try {
        await extensions.unload(ext.manifest.name);
      } catch {
        /* best-effort */
      }
    }
    if (wiredBridge) wiredBridge.unwire();
    if (bridge) {
      try {
        await bridge.close();
      } catch {
        /* best-effort */
      }
    }
    await ipc.close();
    bus.close();
    store.close();
    faultIsolation.uninstall();
    if (existsSync(paths.pidFile)) {
      try {
        unlinkSync(paths.pidFile);
      } catch {
        /* best-effort */
      }
    }
  };

  return {
    paths,
    hostId,
    store,
    bus,
    ipc,
    extensions,
    ledger,
    scheduler,
    inbox,
    rootAgentId,
    humanAgentId,
    bridge,
    teamTools,
    chat,
    chatAgentId,
    agentManager: managerHolder.ref,
    shutdown,
  };
}

function resolveMeshPort(override?: number): number {
  if (override !== undefined) return override;
  const envPort = process.env.OLLE_MESH_PORT;
  if (envPort) {
    const n = Number.parseInt(envPort, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  // 0 lets the OS pick. Production operators who care about a stable
  // peer-dial addr should set OLLE_MESH_PORT explicitly.
  return 0;
}

interface PeerStatusUpdate {
  teamId: string;
  peerHostId: string;
  status: string;
  addr?: string;
  lastReceivedEventId?: string;
}

function persistPeerStatus(store: Store, params: PeerStatusUpdate): void {
  // Upsert: the bridge may emit transitions for peers we haven't yet
  // committed to local state (welcome-time, mid-handshake). INSERT OR
  // IGNORE the row first, then UPDATE the live columns.
  const now = Date.now();
  try {
    store.raw
      .prepare(
        `INSERT OR IGNORE INTO team_peers
           (team_id, peer_host_id, addr, status, last_heartbeat_at,
            last_received_event_id, joined_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.teamId,
        params.peerHostId,
        params.addr ?? "",
        params.status,
        params.status === "connected" ? now : null,
        params.lastReceivedEventId ?? null,
        now,
      );
    type Bind = string | number | null;
    const updates: string[] = ["status = ?"];
    const args: Bind[] = [params.status];
    if (params.addr !== undefined) {
      updates.push("addr = ?");
      args.push(params.addr);
    }
    if (params.status === "connected") {
      updates.push("last_heartbeat_at = ?");
      args.push(now);
    }
    if (params.lastReceivedEventId !== undefined) {
      updates.push("last_received_event_id = ?");
      args.push(params.lastReceivedEventId);
    }
    args.push(params.teamId, params.peerHostId);
    store.raw
      .prepare(
        `UPDATE team_peers SET ${updates.join(", ")} WHERE team_id = ? AND peer_host_id = ?`,
      )
      .run(...args);
  } catch (err) {
    // eslint-disable-next-line no-console -- daemon infra
    console.error(`[daemon] persistPeerStatus failed: ${(err as Error).message}`);
  }
}

interface InviteRedemption {
  teamId: string;
  inviteId: string;
  byHostId: string;
}

function redeemInviteInStore(store: Store, params: InviteRedemption): boolean {
  const now = Date.now();
  try {
    const row = store.raw
      .prepare(
        `SELECT invite_id, team_id, expires_at, redeemed_at FROM team_invites WHERE invite_id = ?`,
      )
      .get(params.inviteId) as
      | { invite_id: string; team_id: string; expires_at: number | null; redeemed_at: number | null }
      | undefined;
    if (!row) return false;
    if (row.team_id !== params.teamId) return false;
    if (row.redeemed_at != null) return false;
    if (row.expires_at != null && row.expires_at < now) return false;
    const result = store.raw
      .prepare(
        `UPDATE team_invites
           SET redeemed_at = ?, redeemed_by_host_id = ?
         WHERE invite_id = ? AND redeemed_at IS NULL`,
      )
      .run(now, params.byHostId, params.inviteId);
    return (result.changes ?? 0) > 0;
  } catch (err) {
    // eslint-disable-next-line no-console -- daemon infra
    console.error(`[daemon] redeemInvite failed: ${(err as Error).message}`);
    return false;
  }
}

function loadTeamsFromStore(
  store: Store,
  paths: OllePaths,
): Array<{ teamId: string; secret: string; peers: Array<{ peerHostId: string; addr: string; lastReceivedEventId: string | null }> }> {
  const teams = store.select().from(tables.teams).all();
  const out: Array<{
    teamId: string;
    secret: string;
    peers: Array<{ peerHostId: string; addr: string; lastReceivedEventId: string | null }>;
  }> = [];
  for (const t of teams) {
    let secret: string;
    try {
      secret = readFileSync(join(paths.secretsDir, "team", t.id), "utf8").trim();
    } catch {
      // Missing secret file → team is dead-but-not-dropped. Skip; the
      // agent can revisit via team_leave or olle inspect.
      continue;
    }
    const peers = store
      .select()
      .from(tables.teamPeers)
      .all()
      .filter((p) => p.teamId === t.id)
      .map((p) => ({
        peerHostId: p.peerHostId,
        addr: p.addr,
        lastReceivedEventId: p.lastReceivedEventId,
      }));
    out.push({ teamId: t.id, secret, peers });
  }
  return out;
}

function buildHostContextPrompt(paths: OllePaths, hostId: string): string {
  return [
    `Stable host context: host_id=${hostId}.`,
    `OLL-E home: ${paths.root}.`,
    `Extensions directory: ${paths.extensionsDir}.`,
    `Config file: ${paths.configFile}.`,
    `Memory directory: ${paths.memoryDir}.`,
    `Logs directory: ${paths.logsDir}.`,
    "These are stable coordinates, not proof that a specific file, extension, cwd, or executable exists right now. Before filesystem/subprocess work, call query_host_context or the relevant read/list tool to verify live state.",
  ].join(" ");
}

/** True when the root agent has at least one `role='identity'` memory.
 *  Drives the daemon's choice of boot prompt: bootstrap-interviewer when
 *  no identity has been seeded yet (first run after install), otherwise
 *  the shrunk normal prompt that lets seeded identity + principles
 *  render themselves through the SOUL pipeline. See LOG 2026-04-28.
 *  Evaluated at turn start (system is a thunk) so a fresh install leaves
 *  bootstrap mode as soon as the agent writes its first identity row. */
function hasSeededIdentity(store: Store, agentId: string): boolean {
  return loadIdentity(store, agentId).length > 0;
}

/** First-run bootstrap interviewer prompt. Used the very first time the
 *  root agent runs after install, when no identity memories exist yet.
 *  Three required asks (principal name, agent name, first task) plus
 *  technique notes; agent records what it learns via `memory_write`,
 *  then stops interviewing. Subsequent boots skip this entirely. */
function buildBootstrapPrompt(paths: OllePaths, hostId: string): string {
  return [
    "You were just installed. Your principal is talking to you for the first time. Neither of you has a name for the other yet.",
    "Your only job in this conversation is to learn enough to be useful starting tomorrow — not a complete portrait, the minimum to start. Three things you MUST learn before you stop interviewing:\n  1. What to call your principal.\n  2. What they want to call you.\n  3. One real thing they want help with first.",
    "Beyond those, ask whatever feels load-bearing — communication style, things to specifically NOT do, how cautious vs eager they want you to be — but err on too few questions. The rest grows through living, not through this one conversation.",
    "Technique notes: ground vague answers in concrete instances (\"give me one real example\"); push past polished first answers (\"what's the version that's harder to say?\"); reflect what you heard back so the principal can correct it.",
    "Record what you learn as you go using `memory_write`:\n  - Names → role='identity', scope='private', depth=10 (one row for what to call your principal, one for your own name).\n  - Operative beliefs → role='principle', scope='private', depth=5 for foundational beliefs you'd rebuild decisions on, depth=2 for casual preferences. Put the *reason* in the body so future-you knows why.",
    "When the three required items are captured and you've heard enough to start being useful, stop interviewing and ask what they want to do first. The next conversation will skip this introduction — you become the agent you helped describe.",
    buildHostContextPrompt(paths, hostId),
    "Always-loaded tools you carry every turn: `load_tools`, `query_self`, `mail_list`, `memory_search`, `memory_write`. Other tool schemas are deferred — call `load_tools([\"name\"])` to pull them into context for this thread.",
  ].join("\n\n");
}

/** Normal boot prompt — used once identity has been seeded. Pure
 *  operational orientation: catalog physics, always-loaded tools,
 *  delegation, look-first-when-something-is-off. All opinions and
 *  identity live in seeded memory rows and render through the SOUL
 *  pipeline (`renderSoul` in src/memory/principles.ts). */
function buildNormalPrompt(paths: OllePaths, hostId: string): string {
  return [
    "You live inside OLL-E — a habitat for agents like you. OLL-E is yours to reshape: when the world is missing something you need, extend it.",
    buildHostContextPrompt(paths, hostId),
    "Your tools live in a catalog (rendered below). Most schemas are deferred — call `load_tools([\"name\"])` to pull them into context for this thread; the schema appears on the next turn. The catalog tells you what exists; loading is the act of picking it up. Unload with `unload_tools` when done.",
    "The extension API contract lives at `.docs/extension-api.md` inside your extensions directory. Before authoring or modifying an extension from scratch, read it completely via `read_extension_file(name: \".docs\", path: \"extension-api.md\")` — starters are worked examples; the doc is the contract.",
    "The five tools you always carry — `load_tools`, `query_self`, `mail_list`, `memory_search`, `memory_write` — are in your tool list every turn without loading. Use `query_self` to orient at the start of strategic work; `mail_list` to see open decisions awaiting your principal's response; `memory_search` and `memory_write` to recall and record what matters.",
    "Never block a human waiting for slow work — delegate via `spawn_agent`. The mailbox sidebar shows live threads; load `query_my_threads` for the durable thread inventory.",
    "When something feels off, look first (load `query_my_usage` / `query_my_runs` / `query_events`).",
  ].join("\n\n");
}

function checkNotRunning(paths: OllePaths): void {
  if (!existsSync(paths.pidFile)) return;
  const raw = readFileSync(paths.pidFile, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) return;
  try {
    // Signal 0 = existence check without delivering.
    process.kill(pid, 0);
    throw new Error(`olle daemon already running (pid ${pid})`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      // Stale pid file; nothing to do — caller will overwrite.
      return;
    }
    throw err;
  }
}

function ensureHostRow(store: Store): string {
  const existing = store.select().from(tables.hosts).limit(1).all();
  if (existing.length > 0) return existing[0]!.id;
  const id = ulid();
  store
    .insert(tables.hosts)
    .values({
      id,
      hostname: process.env.HOSTNAME ?? "localhost",
      createdAt: Date.now(),
    })
    .run();
  return id;
}

function ensureHumanAgent(store: Store, hostId: string, name: string): string {
  // v0 is single-human: pick the first owns_money agent if any, otherwise
  // seed one. The human is an `agents` row with `owns_money = 1`, every
  // tier allowed (they ARE the authority), and `parent_agent_id = NULL`
  // (they're at the top of the ask-up chain).
  const existing = store
    .select()
    .from(tables.agents)
    .where(eq(tables.agents.ownsMoney, true))
    .limit(1)
    .all();
  if (existing.length > 0) return existing[0]!.id;
  const id = ulid();
  store
    .insert(tables.agents)
    .values({
      id,
      name,
      hostId,
      scope: { allowTiers: ["operational", "strategic", "vision"] },
      channels: [],
      ownsMoney: true,
      createdAt: Date.now(),
    })
    .run();
  return id;
}

function ensureAiRootAgent(
  store: Store,
  hostId: string,
  name: string,
  humanAgentId: string,
): string {
  // The AI delegate the human's first contact reaches. It carries operational
  // and strategic tiers — escalation hits the human only for vision tier or
  // when policy isn't covered. Parented under the human so ask-up walks one
  // recursion end-to-end (LOG 2026-04-23: humans are the oldest agents).
  const existing = store
    .select()
    .from(tables.agents)
    .where(eq(tables.agents.name, name))
    .all();
  if (existing.length > 0) return existing[0]!.id;
  const id = ulid();
  store
    .insert(tables.agents)
    .values({
      id,
      name,
      hostId,
      parentAgentId: humanAgentId,
      scope: { allowTiers: ["operational", "strategic"] },
      channels: [],
      ownsMoney: false,
      createdAt: Date.now(),
    })
    .run();
  return id;
}

// Secrets are file-backed only. process.env is intentionally NOT consulted —
// env is for behavior/functionality (OLLE_HOME, paths), not for secrets.
// One source of truth, set via `olle secret set <NAME>`. Drift between an
// install-time-embedded plist env and the secrets store was the bug this
// closes.
function readSecret(secretsDir: string, name: string): string | undefined {
  try {
    return readFileSync(join(secretsDir, name), "utf8").trim();
  } catch {
    return undefined;
  }
}
