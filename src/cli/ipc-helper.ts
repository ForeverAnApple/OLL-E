import { connectIpc, type IpcClient } from "../ipc/client.ts";

/** Open an IPC client, run `fn`, and always close — even on throw.
 *  Spares the per-command `try { ... } finally { client.close() }` boilerplate. */
export async function withIpc<T>(
  socketPath: string,
  fn: (client: IpcClient) => Promise<T>,
): Promise<T> {
  const client = await connectIpc(socketPath);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}
