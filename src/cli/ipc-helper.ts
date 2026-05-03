import { connectIpc, type IpcClient } from "../ipc/client.ts";

/** Print the friendly daemon-down message and exit with code 1.
 *  Centralized so every CLI subcommand surfaces the same line: a stack
 *  trace was the original failure mode, which made first-run UX read
 *  like a crash whenever the daemon hadn't been started yet. */
function exitDaemonDown(socketPath: string, err: unknown): never {
  const reason = (err as Error).message ?? String(err);
  // eslint-disable-next-line no-console -- CLI surface
  console.error(
    `olle: daemon not reachable at ${socketPath} (${reason})\n` +
      `      start it with \`olle run\` (foreground) or \`scripts/install.sh\` (autostart)`,
  );
  process.exit(1);
}

/** Connect, or print the friendly diagnostic + exit(1). Use this for
 *  long-lived / streaming subcommands where `withIpc`'s scoped close
 *  doesn't fit (`olle tail`, `olle chat`'s initial connect). */
export async function connectOrExit(socketPath: string): Promise<IpcClient> {
  try {
    return await connectIpc(socketPath);
  } catch (err) {
    exitDaemonDown(socketPath, err);
  }
}

/** Open an IPC client, run `fn`, and always close — even on throw.
 *  Spares the per-command `try { ... } finally { client.close() }` boilerplate
 *  AND surfaces a friendly message instead of a stack trace when the
 *  daemon is down. */
export async function withIpc<T>(
  socketPath: string,
  fn: (client: IpcClient) => Promise<T>,
): Promise<T> {
  let client: IpcClient;
  try {
    client = await connectIpc(socketPath);
  } catch (err) {
    exitDaemonDown(socketPath, err);
  }
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}
