import { ensurePaths, resolvePaths, type OllePaths } from "../paths.ts";
import { openStore, tables, type Store } from "../store/index.ts";
import { createBus, persistToStore, type EventBus } from "../bus/index.ts";
import { createIpcServer, type IpcServer } from "../ipc/server.ts";
import { createExtensionHost, ensureRepo, type ExtensionHost } from "../extensions/index.ts";
import { createLedger, type Ledger } from "../ledger/index.ts";
import { createScheduler, type Scheduler } from "../scheduler/index.ts";
import { createAnthropicAdapter } from "../llm/index.ts";
import { startChatAgent, type ChatAgent } from "../agent/index.ts";
import { buildMetaTools } from "../tools/meta.ts";
import { createInbox, type Inbox } from "../inbox/index.ts";
import { ulid } from "../id/index.ts";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
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
  readonly chat?: ChatAgent;
  readonly chatAgentId?: string;
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

  ensureRepo(paths.extensionsDir);
  const extensions = createExtensionHost({
    bus,
    store,
    hostId,
    extensionsDir: paths.extensionsDir,
    scheduler,
    defaultTaskAgentId: rootAgentId,
    secrets: (name) => readSecret(paths.secretsDir, name),
  });
  const ledger = createLedger({ bus, store, hostId });

  const ipc = createIpcServer({
    socketPath: paths.socketFile,
    bus,
    version: opts.version ?? "0.0.0",
    extensions,
    paths,
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

  // Chat agent — only if there's an API key. Without it the daemon still
  // runs but `olle chat` just bounces with chat.error.
  let chat: ChatAgent | undefined;
  let chatAgentId: string | undefined;
  if (process.env.ANTHROPIC_API_KEY) {
    chatAgentId = rootAgentId;
    const llm = createAnthropicAdapter();
    const coreTools = buildMetaTools({
      extensions,
      extensionsDir: paths.extensionsDir,
      authorName: chatAgentId,
    });
    chat = startChatAgent({
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
      sessionsDir: paths.sessionsDir,
      system:
        "You are olle, a helpful assistant living inside OLL-E — a habitat " +
        "built for agents like you. Your job is to accomplish what the human " +
        "asks. OLL-E is yours to reshape: when the world is missing something " +
        "you need, extend it. Tools for modifying your habitat: write_extension, " +
        "run_smoke_test, register_extension, revert_extension, extension_history. " +
        "Be concise.",
    });
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
    chat?.stop();
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
    shutdown,
  };
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
  const existing = store.raw
    .query<{ id: string }, []>("SELECT id FROM hosts LIMIT 1")
    .get();
  if (existing) return existing.id;
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
  const existing = store.raw
    .query<{ id: string }, []>("SELECT id FROM principals LIMIT 1")
    .get();
  if (existing) return existing.id;
  const id = ulid();
  store
    .insert(tables.principals)
    .values({ id, display, channels: [], createdAt: Date.now() })
    .run();
  return id;
}

function readSecret(secretsDir: string, name: string): string | undefined {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const p = require("node:path").join(secretsDir, name) as string;
    if (!fs.existsSync(p)) return process.env[name];
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return process.env[name];
  }
}
