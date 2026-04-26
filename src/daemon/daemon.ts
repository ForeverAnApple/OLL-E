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

  // Late-bound manager reference: extensions are created before the
  // agent manager (which needs the LLM adapter, conditionally built),
  // but the resolveMailbox callback captures a closure that reads the
  // manager once it exists.
  let agentManager: AgentManager | undefined;

  ensureRepo(paths.extensionsDir);
  const extensions = createExtensionHost({
    bus,
    store,
    hostId,
    extensionsDir: paths.extensionsDir,
    scheduler,
    defaultTaskAgentId: rootAgentId,
    secrets: (name) => readSecret(paths.secretsDir, name),
    resolveMailbox: (threadId) => agentManager?.resolveMailbox(threadId),
  });
  const ledger = createLedger({ bus, store, hostId });

  const ipc = createIpcServer({
    socketPath: paths.socketFile,
    bus,
    version: opts.version ?? "0.0.0",
    extensions,
    paths,
    store,
    rootAgentId,
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
  let chat: AgentLoop | undefined;
  let chatAgentId: string | undefined;
  if (process.env.ANTHROPIC_API_KEY) {
    chatAgentId = rootAgentId;
    const llm = createAnthropicAdapter();
    // Manager first — meta-tools need a reference so spawn_agent etc.
    // resolve. The root loop gets registered into it after start.
    agentManager = createAgentManager({
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
    });
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
    ];
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
      system: [
        "You are olle, a helpful assistant living inside OLL-E — a habitat built for agents like you.",
        "Your job is to accomplish what the human asks. OLL-E is yours to reshape: when the world is missing something you need, extend it.",
        buildHostContextPrompt(paths, hostId),
        "Your tools live in a catalog (rendered below). Most schemas are deferred — call `load_tools([\"name\"])` to pull them into context for this thread; the schema appears on the next turn. The catalog tells you what exists; loading is the act of picking it up. Unload with `unload_tools` when done.",
        "The four tools you always carry — `load_tools`, `query_self`, `mail_list`, `memory_search` — are in your tool list every turn without loading. Use `query_self` to orient at the start of strategic work; `mail_list` to check whether children or peers have replied; `memory_search` to recall what you've remembered.",
        "Never block a human waiting for slow work — delegate via `spawn_agent`. The per-turn mailbox sidebar shows live threads; `mail_list` reveals durable mail you haven't ingested.",
        "When something feels off, look first (load `query_my_usage` / `query_my_runs` / `query_events`); when caching seems wasteful, propose a strategy revision through the inbox. Be concise.",
      ].join("\n\n"),
    });
    agentManager.register(chatAgentId, chat);
  } else if (!opts.quiet) {
    console.log("olle: ANTHROPIC_API_KEY not set — chat agent disabled");
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
    agentManager?.shutdown();
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
    agentManager,
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

function readSecret(secretsDir: string, name: string): string | undefined {
  try {
    return readFileSync(join(secretsDir, name), "utf8").trim();
  } catch {
    return process.env[name];
  }
}
