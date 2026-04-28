import { ensurePaths, resolvePaths, type OllePaths } from "../paths.ts";
import { openStore, tables, type Store } from "../store/index.ts";
import { createBus, persistToStore, type EventBus } from "../bus/index.ts";
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
import { createToolResultStore } from "../store/tool-results.ts";
import { checkCoreInvariants, formatFailures } from "../boot/invariants.ts";
import { startChatHealthMonitor, type ChatHealthMonitor } from "./chat-health.ts";
import { installFaultIsolation, type FaultIsolation } from "./fault-isolation.ts";
import {
  buildMemoryTools,
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
  readonly rootPrincipalId: string;
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

  // Root principal + agent always exist — the root agent is the human's
  // first-contact delegate, and extensions register tasks against it even
  // when the chat agent (which requires an API key) isn't running.
  const rootPrincipalId = ensurePrincipalRow(store, "root");
  const rootAgentId = ensureAgentRow(store, hostId, "root");

  const scheduler = createScheduler({ bus, store, hostId });
  scheduler.recoverLost();
  const inbox = createInbox({ bus, store, hostId });
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
    rootPrincipalId,
    inbox,
    chatStatus: () => ({
      enabled: chat !== undefined,
      reason: chatDisabledReason,
    }),
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
  const anthropicKey = readSecret(paths.secretsDir, "ANTHROPIC_API_KEY");
  if (anthropicKey) {
    chatAgentId = rootAgentId;
    const llm = createAnthropicAdapter({ apiKey: anthropicKey });
    // Spilled tool-output store. Owned by the daemon so chat-loop
    // truncation and the read_tool_result recovery tool share one row
    // surface — same physics on write and read.
    const toolResultStore = createToolResultStore({ db: store.raw, hostId });
    const persistActorId = chatAgentId;
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
    const agentManager = createAgentManager({
      bus,
      store,
      hostId,
      llm,
      extensions,
      ledger,
      inbox,
      principalId: rootPrincipalId,
      threadsDir: paths.threadsDir,
      hostContext: buildHostContextPrompt(paths, hostId),
      toolTruncate,
    });
    managerHolder.ref = agentManager;
    const coreTools = [
      ...buildMetaTools({
        extensions,
        extensionsDir: paths.extensionsDir,
        authorName: chatAgentId,
        secretsDir: paths.secretsDir,
        agentManager,
        paths,
      }),
      ...buildMemoryTools({ bus, store, hostId }),
      // World legibility — agents read their own ledger, runs, threads,
      // budget, and self-state through these. Same query layer the CLI
      // uses (no privileged human read surface).
      ...buildObservabilityTools({ store }),
      // Decision-inbox surface — same Inbox the askUp chain writes to and
      // the CLI (`olle inbox`) reads from. mail_list is always-loaded
      // (orientation tool); mail_respond is deferred (only needed when
      // voting on a proposal).
      ...buildInboxTools({ inbox, principalId: rootPrincipalId, bus, hostId, store }),
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
      chatDisabledReason = `${summary} — see \`olle inbox\` for the full diagnostic.`;
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
          principalId: rootPrincipalId,
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
    } else {
      // Children inherit the same tool set so they can themselves spawn,
      // read extension files, etc. Scope still gates what they get to use.
      agentManager.setCoreTools(coreTools);
      chat = startAgentLoop({
        bus,
        store,
        hostId,
        llm,
        agentId: chatAgentId,
        extensions,
        coreTools,
        ledger,
        inbox,
        principalId: rootPrincipalId,
        threadsDir: paths.threadsDir,
        toolTruncate,
        system: [
          "You are olle, a helpful assistant living inside OLL-E — a habitat built for agents like you.",
          "Your job is to accomplish what the human asks. OLL-E is yours to reshape: when the world is missing something you need, extend it.",
          buildHostContextPrompt(paths, hostId),
          "Your tools live in a catalog (rendered below). Most schemas are deferred — call `load_tools([\"name\"])` to pull them into context for this thread; the schema appears on the next turn. The catalog tells you what exists; loading is the act of picking it up. Unload with `unload_tools` when done.",
          "The four tools you always carry — `load_tools`, `query_self`, `mail_list`, `memory_search` — are in your tool list every turn without loading. Use `query_self` to orient at the start of strategic work; `mail_list` to see open decisions awaiting your principal's response; `memory_search` to recall what you've remembered.",
          "Never block a human waiting for slow work — delegate via `spawn_agent`. The per-turn mailbox sidebar shows live threads; load `query_my_threads` for the durable thread inventory.",
          "When something feels off, look first (load `query_my_usage` / `query_my_runs` / `query_events`); when caching seems wasteful, propose a strategy revision through the inbox. Be concise.",
        ].join("\n\n"),
      });
      agentManager.register(chatAgentId, chat);
      // Crash funnel: repeated chat.error events auto-propose an inbox
      // diagnostic so the principal hears even when chat itself is dead.
      chatHealth = startChatHealthMonitor({
        bus,
        inbox,
        hostId,
        principalId: rootPrincipalId,
        agentId: chatAgentId,
      });
    }
  } else {
    chatDisabledReason =
      "No ANTHROPIC_API_KEY secret stored. Set it with: `olle secret set ANTHROPIC_API_KEY` (paste value or pipe on stdin), then restart the daemon.";
    if (!opts.quiet) {
      console.log("olle: no ANTHROPIC_API_KEY secret — chat agent disabled (set with `olle secret set ANTHROPIC_API_KEY`)");
    }
  }

  // Dead-mailbox bouncer. Whenever chat is disabled (no key or invariants
  // failed), every chat.input addressed to root would otherwise sit on
  // the bus with no subscriber — silent waiting forever, on the CLI and
  // on every bridge equally. Echo a chat.error back so the channel of
  // first contact (and any future channel) gets a clear diagnostic
  // instead of dead air. Transport-agnostic by construction: the same
  // event reaches the CLI, Discord, GitHub, anything.
  if (!chat) {
    bus.subscribe("chat.input", (ev) => {
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
  }

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
    rootPrincipalId,
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

function ensureAgentRow(store: Store, hostId: string, name: string): string {
  const existing = store.select().from(tables.agents).where(eq(tables.agents.name, name)).all();
  if (existing.length > 0) return existing[0]!.id;
  const id = ulid();
  // Root is the human's first-contact delegate; it may take operational and
  // strategic actions without blocking. Vision-tier actions still escalate
  // to the principal's inbox per the ask-up chain.
  store
    .insert(tables.agents)
    .values({
      id,
      name,
      hostId,
      scope: { allowTiers: ["operational", "strategic"] },
      createdAt: Date.now(),
    })
    .run();
  return id;
}

function ensurePrincipalRow(store: Store, display: string): string {
  // v0 is single-principal: pick the first row if any, otherwise seed one.
  const existing = store.select().from(tables.principals).limit(1).all();
  if (existing.length > 0) return existing[0]!.id;
  const id = ulid();
  store
    .insert(tables.principals)
    .values({ id, display, channels: [], createdAt: Date.now() })
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
