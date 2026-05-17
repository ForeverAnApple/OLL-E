import { createServer, type Server, type Socket } from "node:net";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { EventBus } from "../bus/index.ts";
import type { ExtensionHost } from "../extensions/index.ts";
import type { ToolDef } from "../extensions/types.ts";
import { history, revertSubtree } from "../extensions/git.ts";
import { installStarter, listStarters } from "../starters/index.ts";
import type { OllePaths } from "../paths.ts";
import type { Store } from "../store/index.ts";
import {
  enrichDecision,
  enrichDecisionMessages,
  enrichDecisions,
  type Inbox,
  type UserVote,
} from "../inbox/index.ts";
import {
  agentSelf,
  budgetStatus,
  recentEvents,
  runHistory,
  threadInventory,
  usageStats,
} from "../observability/index.ts";
import { isRequest, type Response, type Request } from "./protocol.ts";

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface IpcServerOptions {
  socketPath: string;
  bus: EventBus;
  /** Version string returned by the `version` method. */
  version: string;
  extensions?: ExtensionHost;
  paths?: OllePaths;
  /** Store used by the observability.* methods. The CLI surface and the
   *  agent-callable tools both read through src/observability/, so they
   *  see the same numbers — no privileged human read path. */
  store?: Store;
  /** Root agent id, returned by `status.rootAgent` so clients (CLI chat,
   *  bridges) can address their mailbox publishes. */
  rootAgentId?: string;
  /** Owner-agent id (the human, post-LOG 2026-04-23 collapse) —
   *  addressee for the host's decision inbox. The `inbox.*` methods
   *  default to this when no ownerAgentId is supplied. */
  humanAgentId?: string;
  /** Decision-inbox handle. Wired so the CLI surface (`olle inbox`) and the
   *  agent core tools (mail_list/mail_respond) hit the same query layer. */
  inbox?: Inbox;
  /** Live snapshot of whether the root agent's chat loop is running.
   *  Evaluated on every `status.chat` request so the answer is current
   *  even when chat startup races IPC listen. False = chat.input events
   *  fall on the floor; consumers (chat REPL, bridges) probe this to
   *  fail fast instead of publishing into a dead mailbox. */
  chatStatus?: () => { enabled: boolean; reason?: string };
  /** Cancel the in-flight turn for a given thread on the root chat agent.
   *  Returns true when a turn was running and was signalled to abort,
   *  false when no active turn was found. */
  chatCancel?: (threadId: string) => boolean;
  /** Team tools — same factory result the agent core uses. CLI `team.*`
   *  methods dispatch through these so the parallel-tool-surface rule
   *  holds (no privileged human path). Empty when the mesh is disabled. */
  teamTools?: ToolDef[];
  /** True when the mesh bridge is alive. `team.*` mutating calls return
   *  a clean error when false rather than a confusing tool failure. */
  meshEnabled?: boolean;
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
          chmodSync(opts.socketPath, 0o600);
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
          toAgentId?: string;
          threadId?: string;
          parentThreadId?: string;
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
          toAgentId: p.toAgentId,
          threadId: p.threadId,
          parentThreadId: p.parentThreadId,
        });
        send({ id: req.id, ok: true, value: { id: ev.id, hlc: ev.hlc } });
        return;
      }
      case "status.rootAgent": {
        if (!opts.rootAgentId) {
          send({ id: req.id, ok: false, error: { message: "root agent id unavailable" } });
          return;
        }
        send({ id: req.id, ok: true, value: { rootAgentId: opts.rootAgentId } });
        return;
      }
      case "status.chat": {
        // Whether the root mailbox has a draining agent. False = chat.input
        // events fall on the floor; the chat REPL should refuse to start
        // and bridges should surface the reason rather than queue silently.
        const s = opts.chatStatus ? opts.chatStatus() : { enabled: false };
        send({
          id: req.id,
          ok: true,
          value: { enabled: s.enabled, reason: s.reason ?? null },
        });
        return;
      }
      case "chat.cancel": {
        const threadId = req.params?.threadId as string | undefined;
        if (!threadId) {
          send({ id: req.id, ok: false, error: { message: "threadId required" } });
          return;
        }
        const cancelled = opts.chatCancel ? opts.chatCancel(threadId) : false;
        send({ id: req.id, ok: true, value: { cancelled } });
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
        // Inventory rather than `list()` — surfaces on-disk-but-unregistered
        // extensions so the CLI shows the same picture the agent's
        // list_extensions tool does. Two surfaces, one source of truth per
        // the observability rule.
        const inv = await opts.extensions.inventory();
        send({ id: req.id, ok: true, value: inv });
        return;
      }
      case "extensions.reload": {
        if (!opts.extensions) {
          send({ id: req.id, ok: false, error: { message: "extensions unavailable" } });
          return;
        }
        const { name } = (req.params ?? {}) as { name?: string };
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
        const { name, limit } = (req.params ?? {}) as { name?: string; limit?: number };
        if (!name) {
          send({ id: req.id, ok: false, error: { message: "name required" } });
          return;
        }
        const hist = history(opts.paths.extensionsDir, name, limit ?? 20);
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
        const bytes = Buffer.byteLength(value, "utf8");
        // Publish a `secret.set` event (name only — never the value).
        // Lets subscribers react to a fresh secret without polling: the
        // chat-agent bringup, for one, hot-reloads on ANTHROPIC_API_KEY.
        // The CLI socket is mode 0600 owned by the human, so callers
        // here are the human acting through their CLI — attribute to
        // the human-agent id when available so federation provenance
        // is honest. Falls back to host-as-actor only if the IPC server
        // was wired without one (tests, headless probes).
        opts.bus.publish({
          type: "secret.set",
          hostId: opts.bus.hostId,
          actorId: opts.humanAgentId ?? opts.bus.hostId,
          durable: true,
          payload: { name, bytes },
        });
        send({ id: req.id, ok: true, value: { name, bytes } });
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
      // Observability surface — same query layer the agent-callable
      // tools use. CLI subcommands wrap these (AGENTS.md vision-check).
      case "observability.usage":
        observabilityCall(req, opts, send, (store, params) => usageStats(store, params));
        return;
      case "observability.budget":
        observabilityCall(req, opts, send, (store, params) => budgetStatus(store, params));
        return;
      case "observability.runs":
        observabilityCall(req, opts, send, (store, params) => runHistory(store, params));
        return;
      case "observability.threads":
        observabilityCall(req, opts, send, (store, params) => threadInventory(store, params));
        return;
      case "observability.self": {
        if (!opts.store) {
          send({ id: req.id, ok: false, error: { message: "store unavailable" } });
          return;
        }
        const agentId = req.params?.agentId as string | undefined;
        if (!agentId) {
          send({ id: req.id, ok: false, error: { message: "agentId required" } });
          return;
        }
        send({ id: req.id, ok: true, value: agentSelf(opts.store, agentId) });
        return;
      }
      case "observability.events":
        observabilityCall(req, opts, send, (store, params) => recentEvents(store, params));
        return;
      // Decision-inbox surface — same Inbox the askUp chain writes to. CLI
      // (`olle inbox`) and agent core tools (mail_list/mail_respond) both
      // dispatch through here so the parallel-tool-surface rule holds.
      case "inbox.list": {
        if (!opts.inbox) {
          send({ id: req.id, ok: false, error: { message: "inbox unavailable" } });
          return;
        }
        const ownerAgentId =
          (req.params?.ownerAgentId as string | undefined) ?? opts.humanAgentId;
        if (!ownerAgentId) {
          send({ id: req.id, ok: false, error: { message: "ownerAgentId required" } });
          return;
        }
        // Three filter modes:
        //   "all"        — every decision for this owner
        //   "open"       — strict status='open' only (lifecycle filter)
        //   default      — actionable: open OR has unread replies for me
        // The default treats "needs my attention" the way a real inbox
        // does: a resolved decision with a new agent reply ("done — see
        // commit X") still surfaces until I read it.
        const status = req.params?.status as string | undefined;
        const reader = ownerAgentId;
        let rows;
        if (status === "all") {
          rows = opts.inbox.listAll(ownerAgentId);
        } else if (status === "open") {
          rows = opts.inbox.listOpen(ownerAgentId);
        } else {
          rows = opts.inbox.listActionable(ownerAgentId, reader);
        }
        const enriched = opts.store ? enrichDecisions(opts.store, rows) : rows;
        // Per-decision unread reply counts for the owner — backs the
        // "(N new)" badge on the listing UI. One pair of queries for the
        // whole batch (no N+1).
        const unread = opts.inbox.unreadCountsByDecision(
          enriched.map((r) => r.id),
          reader,
        );
        const withUnread = enriched.map((r) => ({
          ...r,
          unreadReplyCount: unread.get(r.id) ?? 0,
        }));
        send({ id: req.id, ok: true, value: withUnread });
        return;
      }
      case "inbox.get": {
        if (!opts.inbox) {
          send({ id: req.id, ok: false, error: { message: "inbox unavailable" } });
          return;
        }
        const id = req.params?.id as string | undefined;
        if (!id) {
          send({ id: req.id, ok: false, error: { message: "id required" } });
          return;
        }
        const row = opts.inbox.resolve(id);
        if (!row) {
          send({ id: req.id, ok: false, error: { message: `decision ${id} not found` } });
          return;
        }
        const enriched = opts.store ? enrichDecision(opts.store, row) : row;
        // Pull replies + per-message read state for this reader BEFORE
        // marking-as-read, so the CLI can render `[NEW]` markers on
        // previously-unread rows in the same view that acks them.
        const reader =
          (req.params?.readerActorId as string | undefined) ??
          opts.humanAgentId ??
          "principal";
        const messages = opts.inbox.listMessages(row.id);
        const wasRead = opts.inbox.readMessageIdsFor(row.id, reader);
        const enrichedMessages = opts.store
          ? enrichDecisionMessages(opts.store, messages)
          : messages.map((m) => ({ ...m, actorName: m.actorId }));
        const messagesWithRead = enrichedMessages.map((m) => ({
          ...m,
          read: wasRead.has(m.id),
        }));
        // Auto-mark on view: opening the decision IS reading it. Avoids
        // a second IPC round-trip and keeps the badge accurate without
        // discipline. Pass markRead:false to suppress (e.g. observability
        // peeks). Idempotent.
        const shouldMark = req.params?.markRead !== false;
        if (shouldMark && messages.length > 0) {
          opts.inbox.markDecisionRead(row.id, reader);
        }
        send({
          id: req.id,
          ok: true,
          value: { ...enriched, messages: messagesWithRead },
        });
        return;
      }
      case "inbox.respond": {
        if (!opts.inbox) {
          send({ id: req.id, ok: false, error: { message: "inbox unavailable" } });
          return;
        }
        const p = (req.params ?? {}) as {
          id?: string;
          vote?: UserVote;
          actorId?: string;
          message?: string;
          payloadOverride?: Record<string, unknown>;
        };
        const actorId = p.actorId ?? opts.humanAgentId ?? "principal";
        if (!p.id || !p.vote) {
          send({ id: req.id, ok: false, error: { message: "id and vote required" } });
          return;
        }
        if (p.vote !== "approve" && p.vote !== "deny" && p.vote !== "modify") {
          send({ id: req.id, ok: false, error: { message: "vote must be approve|deny|modify" } });
          return;
        }
        // Resolve prefix → full id so users can paste what `olle inbox`
        // displays (10 chars) rather than retyping the whole ULID.
        const target = opts.inbox.resolve(p.id);
        if (!target) {
          send({ id: req.id, ok: false, error: { message: `decision ${p.id} not found` } });
          return;
        }
        const updated = opts.inbox.respond({
          decisionId: target.id,
          actorId,
          vote: p.vote,
          message: p.message,
          payloadOverride: p.payloadOverride,
        });
        send({ id: req.id, ok: true, value: updated });
        return;
      }
      case "inbox.count": {
        if (!opts.inbox) {
          send({ id: req.id, ok: true, value: { open: 0 } });
          return;
        }
        const ownerAgentId =
          (req.params?.ownerAgentId as string | undefined) ?? opts.humanAgentId;
        if (!ownerAgentId) {
          send({ id: req.id, ok: true, value: { open: 0 } });
          return;
        }
        send({
          id: req.id,
          ok: true,
          value: { open: opts.inbox.listOpen(ownerAgentId).length },
        });
        return;
      }
      // Team substrate — `olle team ...` and any future bridge surface
      // route through the same tools the agent core uses, with the
      // human agent as the synthetic actor. Mutating methods refuse
      // when the mesh is disabled; status is always-on (read-only).
      case "team.create":
      case "team.invite":
      case "team.join":
      case "team.leave":
      case "team.status": {
        const toolName = req.method.replace("team.", "team_");
        const tools = opts.teamTools ?? [];
        const tool = tools.find((t) => t.name === toolName);
        if (!tool) {
          if (!opts.meshEnabled) {
            send({
              id: req.id,
              ok: false,
              error: {
                message:
                  "mesh disabled on this daemon; team operations unavailable",
              },
            });
            return;
          }
          send({
            id: req.id,
            ok: false,
            error: { message: `team tool not registered: ${toolName}` },
          });
          return;
        }
        const actorId = (req.params?.actorId as string | undefined) ?? opts.humanAgentId;
        if (!actorId) {
          send({
            id: req.id,
            ok: false,
            error: { message: "humanAgentId required to invoke team tools" },
          });
          return;
        }
        const args = (req.params ?? {}) as Record<string, unknown>;
        const ctx = {
          hostId: opts.rootAgentId ? "(daemon)" : "(daemon)",
          extensionId: "core",
          actorId,
          abort: new AbortController().signal,
          secrets: {} as Record<string, string>,
        };
        Promise.resolve()
          .then(() => tool.execute(args, ctx))
          .then((value) => send({ id: req.id, ok: true, value }))
          .catch((err: unknown) =>
            send({
              id: req.id,
              ok: false,
              error: { message: (err as Error).message ?? String(err) },
            }),
          );
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

// Shared shape for the observability.* dispatch arms: every one needs the
// store, every one threads `req.params ?? {}` into a query function whose
// own type carries the filter shape. The cast here is the same one each
// call site used inline — kept narrow to this file.
function observabilityCall<T>(
  req: Request,
  opts: IpcServerOptions,
  send: (r: Response) => void,
  run: (store: Store, params: never) => T,
): void {
  if (!opts.store) {
    send({ id: req.id, ok: false, error: { message: "store unavailable" } });
    return;
  }
  send({ id: req.id, ok: true, value: run(opts.store, (req.params ?? {}) as never) });
}
