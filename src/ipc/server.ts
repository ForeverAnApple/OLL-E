import { createServer, type Server, type Socket } from "node:net";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { EventBus } from "../bus/index.ts";
import type { ExtensionHost } from "../extensions/index.ts";
import { history, revertSubtree } from "../extensions/git.ts";
import { installStarter, listStarters } from "../starters/index.ts";
import type { OllePaths } from "../paths.ts";
import { isRequest, type Response, type Request } from "./protocol.ts";

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface IpcServerOptions {
  socketPath: string;
  bus: EventBus;
  /** Version string returned by the `version` method. */
  version: string;
  extensions?: ExtensionHost;
  paths?: OllePaths;
}

export interface IpcServer {
  listen(): Promise<void>;
  close(): Promise<void>;
}

export function createIpcServer(opts: IpcServerOptions): IpcServer {
  const live = new Set<Socket>();
  const server: Server = createServer((sock) => {
    live.add(sock);
    sock.on("close", () => live.delete(sock));
    handleConnection(sock, opts);
  });

  return {
    listen() {
      // Remove a stale socket before binding. The daemon startup path checks
      // for a running PID separately; if we get here, the old socket is ours.
      if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);
      return new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(opts.socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        // Force-close any lingering client sockets so server.close's callback
        // fires promptly during shutdown.
        for (const sock of live) sock.destroy();
        server.close(() => {
          if (existsSync(opts.socketPath)) {
            try {
              unlinkSync(opts.socketPath);
            } catch {
              /* ignore */
            }
          }
          resolve();
        });
      });
    },
  };
}

function handleConnection(sock: Socket, opts: IpcServerOptions): void {
  let buffer = "";
  // Map of pending subscription ids → unsub callback. Cleared on close.
  const subscriptions = new Map<number, () => void>();

  const send = (msg: Response): void => {
    if (sock.destroyed) return;
    sock.write(JSON.stringify(msg) + "\n");
  };

  sock.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let req: unknown;
      try {
        req = JSON.parse(line);
      } catch (e) {
        send({
          id: 0,
          ok: false,
          error: { message: `bad json: ${(e as Error).message}` },
        });
        continue;
      }
      if (!isRequest(req)) {
        send({ id: 0, ok: false, error: { message: "malformed request" } });
        continue;
      }
      void dispatch(req, opts, send, subscriptions);
    }
  });

  const cleanup = (): void => {
    for (const unsub of subscriptions.values()) unsub();
    subscriptions.clear();
  };
  sock.on("close", cleanup);
  sock.on("error", cleanup);
}

async function dispatch(
  req: Request,
  opts: IpcServerOptions,
  send: (r: Response) => void,
  subs: Map<number, () => void>,
): Promise<void> {
  try {
    switch (req.method) {
      case "version":
        send({ id: req.id, ok: true, value: opts.version });
        return;
      case "status":
        send({
          id: req.id,
          ok: true,
          value: {
            hostId: opts.bus.hostId,
            pid: process.pid,
            uptimeMs: Math.round(process.uptime() * 1000),
          },
        });
        return;
      case "publish": {
        const p = (req.params ?? {}) as {
          type?: string;
          payload?: unknown;
          actorId?: string;
          durable?: boolean;
        };
        if (typeof p.type !== "string" || typeof p.actorId !== "string") {
          send({
            id: req.id,
            ok: false,
            error: { message: "publish: type and actorId required" },
          });
          return;
        }
        const ev = opts.bus.publish({
          type: p.type,
          payload: p.payload ?? {},
          hostId: opts.bus.hostId,
          actorId: p.actorId,
          durable: p.durable ?? false,
        });
        send({ id: req.id, ok: true, value: { id: ev.id, hlc: ev.hlc } });
        return;
      }
      case "tail": {
        const type = ((req.params?.type as string | undefined) ?? "*") || "*";
        const unsub = opts.bus.subscribe(type, (ev) => {
          send({ id: req.id, stream: "data", event: ev });
        });
        subs.set(req.id, unsub);
        return;
      }
      case "tail.cancel": {
        const target = (req.params?.targetId as number | undefined) ?? -1;
        const unsub = subs.get(target);
        if (unsub) {
          unsub();
          subs.delete(target);
          send({ id: target, stream: "end" });
        }
        send({ id: req.id, ok: true, value: null });
        return;
      }
      case "extensions.list": {
        if (!opts.extensions) {
          send({ id: req.id, ok: true, value: [] });
          return;
        }
        send({
          id: req.id,
          ok: true,
          value: opts.extensions.list().map((e) => ({
            name: e.manifest.name,
            version: e.manifest.version,
            status: e.status,
            failures: e.failures,
          })),
        });
        return;
      }
      case "extensions.reload": {
        if (!opts.extensions) {
          send({ id: req.id, ok: false, error: { message: "extensions unavailable" } });
          return;
        }
        const name = req.params?.name as string | undefined;
        if (!name) {
          send({ id: req.id, ok: false, error: { message: "name required" } });
          return;
        }
        const ext = await opts.extensions.reload(name);
        send({ id: req.id, ok: true, value: { name, status: ext.status } });
        return;
      }
      case "extensions.history": {
        if (!opts.paths) {
          send({ id: req.id, ok: false, error: { message: "extensions unavailable" } });
          return;
        }
        const name = req.params?.name as string | undefined;
        if (!name) {
          send({ id: req.id, ok: false, error: { message: "name required" } });
          return;
        }
        const limit = (req.params?.limit as number | undefined) ?? 20;
        const hist = history(opts.paths.extensionsDir, name, limit);
        send({ id: req.id, ok: true, value: hist });
        return;
      }
      case "starters.list": {
        send({
          id: req.id,
          ok: true,
          value: listStarters().map((s) => ({ name: s.name, description: s.description })),
        });
        return;
      }
      case "starters.install": {
        if (!opts.paths || !opts.extensions) {
          send({ id: req.id, ok: false, error: { message: "extensions unavailable" } });
          return;
        }
        const name = req.params?.name as string | undefined;
        const overwrite = Boolean(req.params?.overwrite);
        const load = (req.params?.load as boolean | undefined) ?? true;
        const authorName = (req.params?.authorName as string | undefined) ?? "cli";
        if (!name) {
          send({ id: req.id, ok: false, error: { message: "name required" } });
          return;
        }
        const result = installStarter({
          name,
          extensionsDir: opts.paths.extensionsDir,
          authorName,
          overwrite,
        });
        let status: string | undefined;
        if (load && !result.alreadyExisted) {
          const ext = await opts.extensions.reload(name).catch((e) => {
            throw new Error(`install ok but load failed: ${(e as Error).message}`);
          });
          status = ext.status;
        }
        send({ id: req.id, ok: true, value: { ...result, status } });
        return;
      }
      case "secrets.list": {
        if (!opts.paths) {
          send({ id: req.id, ok: false, error: { message: "paths unavailable" } });
          return;
        }
        const dir = opts.paths.secretsDir;
        if (!existsSync(dir)) {
          send({ id: req.id, ok: true, value: [] });
          return;
        }
        const entries = readdirSync(dir)
          .filter((n) => SECRET_NAME_RE.test(n))
          .map((name) => {
            const st = statSync(join(dir, name));
            return { name, size: st.size, updatedAt: st.mtimeMs };
          });
        send({ id: req.id, ok: true, value: entries });
        return;
      }
      case "secrets.set": {
        if (!opts.paths) {
          send({ id: req.id, ok: false, error: { message: "paths unavailable" } });
          return;
        }
        const name = req.params?.name as string | undefined;
        const value = req.params?.value as string | undefined;
        if (!name || !SECRET_NAME_RE.test(name)) {
          send({
            id: req.id,
            ok: false,
            error: { message: "name must match /^[A-Z][A-Z0-9_]{0,63}$/" },
          });
          return;
        }
        if (typeof value !== "string" || value.length === 0) {
          send({ id: req.id, ok: false, error: { message: "value required" } });
          return;
        }
        mkdirSync(opts.paths.secretsDir, { recursive: true, mode: 0o700 });
        const p = join(opts.paths.secretsDir, name);
        writeFileSync(p, value, { mode: 0o600 });
        send({ id: req.id, ok: true, value: { name, bytes: value.length } });
        return;
      }
      case "secrets.remove": {
        if (!opts.paths) {
          send({ id: req.id, ok: false, error: { message: "paths unavailable" } });
          return;
        }
        const name = req.params?.name as string | undefined;
        if (!name || !SECRET_NAME_RE.test(name)) {
          send({ id: req.id, ok: false, error: { message: "invalid name" } });
          return;
        }
        const p = join(opts.paths.secretsDir, name);
        if (existsSync(p)) unlinkSync(p);
        send({ id: req.id, ok: true, value: { name, removed: true } });
        return;
      }
      case "extensions.revert": {
        if (!opts.paths || !opts.extensions) {
          send({ id: req.id, ok: false, error: { message: "extensions unavailable" } });
          return;
        }
        const name = req.params?.name as string | undefined;
        const sha = req.params?.sha as string | undefined;
        const actorId = (req.params?.actorId as string | undefined) ?? "principal";
        if (!name || !sha) {
          send({
            id: req.id,
            ok: false,
            error: { message: "name and sha required" },
          });
          return;
        }
        const newSha = revertSubtree(opts.paths.extensionsDir, name, sha, actorId);
        const ext = await opts.extensions.reload(name);
        send({
          id: req.id,
          ok: true,
          value: { name, revertedTo: sha, newCommit: newSha, status: ext.status },
        });
        return;
      }
      default:
        send({
          id: req.id,
          ok: false,
          error: { message: `unknown method: ${req.method}` },
        });
    }
  } catch (err) {
    send({
      id: req.id,
      ok: false,
      error: { message: (err as Error).message },
    });
  }
}
