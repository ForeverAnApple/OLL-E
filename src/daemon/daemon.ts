import { ensurePaths, resolvePaths, type OllePaths } from "../paths.ts";
import { openStore, tables, type Store } from "../store/index.ts";
import { createBus, persistToStore, type EventBus } from "../bus/index.ts";
import { createIpcServer, type IpcServer } from "../ipc/server.ts";
import { createExtensionHost, ensureRepo, type ExtensionHost } from "../extensions/index.ts";
import { ulid } from "../id/index.ts";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

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
  shutdown(): Promise<void>;
}

export async function startDaemon(opts: StartDaemonOptions = {}): Promise<Daemon> {
  const paths = resolvePaths(opts.root);
  ensurePaths(paths);

  checkNotRunning(paths);

  const store = openStore({ path: paths.dbFile });
  const hostId = ensureHostRow(store);
  const bus = createBus({ hostId, persist: persistToStore(store) });

  ensureRepo(paths.extensionsDir);
  const extensions = createExtensionHost({
    bus,
    store,
    hostId,
    extensionsDir: paths.extensionsDir,
  });

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

  return { paths, hostId, store, bus, ipc, extensions, shutdown };
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
