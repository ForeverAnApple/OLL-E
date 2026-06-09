import { ensurePaths, resolvePaths, type OllePaths } from "../paths.ts";
import { openStore, tables, type Store } from "../store/index.ts";
import { createBus, persistToStore, type EventBus, type Unsubscribe } from "../bus/index.ts";
import { createIpcServer, type IpcServer } from "../ipc/server.ts";
import { createExtensionHost, ensureRepo, type ExtensionHost } from "../extensions/index.ts";
import { createLedger, type Ledger } from "../ledger/index.ts";
import { createScheduler, type Scheduler } from "../scheduler/index.ts";
import { createAnthropicAdapter } from "../llm/index.ts";
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

  ensureRepo(paths.extensionsDir);
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
    chatStatus: () => ({
      enabled: chat !== undefined,
      reason: chatDisabledReason,
    }),
    chatCancel: (threadId: string) => (chat ? chat.cancel(threadId) : false),
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
    const anthropicKey = readSecret(paths.secretsDir, "ANTHROPIC_API_KEY");
    if (!anthropicKey) {
      return {
        brought: false,
        reason:
          "No ANTHROPIC_API_KEY secret stored. Set it with: `olle secret set ANTHROPIC_API_KEY` (paste value or pipe on stdin) — chat will come alive automatically.",
      };
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
      const llm = createAnthropicAdapter({ apiKey: anthropicKey });
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
          probe: async (model) => {
            await llm.complete({
              model,
              messages: [{ role: "user", content: "ok" }],
              maxTokens: 1,
            });
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

  // Hot-reload: when the principal stores the API key after install, wake
  // chat without forcing a daemon restart. We deliberately do NOT swap
  // adapters when chat is already up — the running LLM client captured
  // the prior key and rotation requires a fresh adapter graph; that's a
  // restart concern, not a hot-reload one. (Hence `olle daemon restart`.)
  bus.subscribe<{ name?: string }>("secret.set", (ev) => {
    const name = ev.payload?.name;
    if (name !== "ANTHROPIC_API_KEY") return;
    if (chat) return;
    const r = tryBringChatAgentUp();
    if (r.brought) {
      chatDisabledReason = undefined;
      removeBouncer();
      if (!opts.quiet) {
        console.log("olle: ANTHROPIC_API_KEY received — chat agent live");
      }
    } else if (r.reason) {
      // Only update on real failures — the idempotent early-return
      // (chat already up) goes through the `r.brought` branch above.
      chatDisabledReason = r.reason;
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
    scheduler.close();
    for (const ext of extensions.list()) {
      try {
        await extensions.unload(ext.manifest.name);
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
    chat,
    chatAgentId,
    agentManager: managerHolder.ref,
    shutdown,
  };
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
