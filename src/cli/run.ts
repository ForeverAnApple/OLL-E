import { readFileSync } from "node:fs";
import { startDaemon } from "../daemon/daemon.ts";
import { resolvePaths } from "../paths.ts";
import { connectIpc, type IpcClient } from "../ipc/client.ts";
import { connectOrExit, withIpc } from "./ipc-helper.ts";
import { plainTheme, renderMarkdown } from "./markdown.ts";
import type {
  AgentSelf,
  BudgetStatus,
  RecentEventRow,
  RunHistoryRow,
  ThreadInventoryRow,
  UsageStats,
} from "../observability/index.ts";

export async function runCli(args: string[]): Promise<void> {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "version":
    case "--version":
    case "-v":
      console.log("olle 0.0.0");
      return;
    case "run":
      await cmdRun();
      return;
    case "status":
      await cmdStatus();
      return;
    case "daemon":
      await cmdDaemon(rest);
      return;
    case "tail":
      await cmdTail(rest);
      return;
    case "publish":
      await cmdPublish(rest);
      return;
    case "chat":
      await cmdChat();
      return;
    case "extension":
    case "extensions":
    case "ext":
      await cmdExtension(rest);
      return;
    case "starter":
    case "starters":
      await cmdStarter(rest);
      return;
    case "secret":
    case "secrets":
      await cmdSecret(rest);
      return;
    case "stats":
      await cmdStats(rest);
      return;
    case "cache":
      await cmdCache(rest);
      return;
    case "runs":
      await cmdRuns(rest);
      return;
    case "threads":
      await cmdThreads(rest);
      return;
    case "events":
      await cmdEvents(rest);
      return;
    case "inspect":
      await cmdInspect(rest);
      return;
    case "inbox":
      await cmdInbox(rest);
      return;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(2);
  }
}

async function cmdRun(): Promise<void> {
  const daemon = await startDaemon({ version: "0.0.0" });
  const stop = async (sig: NodeJS.Signals) => {
    console.log(`\nolle: received ${sig}, shutting down`);
    await daemon.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // Park the main task — IPC server keeps the loop alive.
  await new Promise<void>(() => {});
}

async function cmdStatus(): Promise<void> {
  const paths = resolvePaths();
  await withIpc(paths.socketFile, async (client) => {
    const value = await client.call<{ hostId: string; pid: number; uptimeMs: number }>("status");
    console.log(
      `host: ${value.hostId}\npid:  ${value.pid}\nup:   ${Math.round(value.uptimeMs / 1000)}s`,
    );
  });
}

async function cmdDaemon(args: string[]): Promise<void> {
  const [sub] = args;
  switch (sub) {
    case "restart":
      await cmdDaemonRestart();
      return;
    default:
      throw new Error(
        `usage: olle daemon restart   (relies on the service supervisor — systemd-user / launchd — to bring the daemon back; in foreground mode you'll have to re-run \`olle run\`)`,
      );
  }
}

async function cmdDaemonRestart(): Promise<void> {
  const paths = resolvePaths();
  // Read the live pid so we can detect the supervisor-restarted process by
  // its new pid below. Reading via IPC lets us fail fast with a clear
  // message when the daemon is already down.
  let oldPid: number;
  try {
    const c = await connectIpc(paths.socketFile);
    const status = await c.call<{ pid: number }>("status");
    c.close();
    oldPid = status.pid;
  } catch (err) {
    throw new Error(
      `daemon not reachable on ${paths.socketFile} — already down? (${(err as Error).message})`,
    );
  }
  // SIGTERM the daemon; the SIGTERM handler in `cmdRun` calls
  // daemon.shutdown() and exits cleanly. Service supervisors
  // (systemd-user `Restart=always`, launchd `KeepAlive`) bring it back.
  // In foreground mode the daemon just exits.
  process.kill(oldPid, "SIGTERM");
  console.log(`signalled pid ${oldPid}; waiting for daemon to come back...`);
  // Poll the socket. ~10s budget covers Bun cold-start + migrations + bind.
  const deadline = Date.now() + 10_000;
  let lastErr: Error | undefined;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const c = await connectIpc(paths.socketFile);
      const status = await c.call<{ pid: number }>("status");
      c.close();
      if (status.pid !== oldPid) {
        console.log(`daemon back up (pid ${status.pid})`);
        return;
      }
      // Same pid means we're still talking to the prior process —
      // SIGTERM hasn't been delivered yet, or its shutdown handler is
      // still running. Keep polling; the new daemon binds the socket
      // only after the old one releases it.
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw new Error(
    `daemon did not come back within 10s${lastErr ? ` (last: ${lastErr.message})` : ""}.\n  Check the supervisor: \`systemctl --user status olle.service\` or \`launchctl print gui/$(id -u)/sh.olle.daemon\`.\n  In foreground mode, re-run \`olle run\`.`,
  );
}

async function cmdTail(args: string[]): Promise<void> {
  const type = args[0] ?? "*";
  const paths = resolvePaths();
  const client = await connectOrExit(paths.socketFile);
  const sub = client.stream("tail", { type });
  const stop = () => {
    void sub.cancel().then(() => {
      client.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  for await (const ev of sub.events) {
    console.log(
      `${ev.hlc} ${ev.type} actor=${ev.actorId} payload=${JSON.stringify(ev.payload)}`,
    );
  }
}

async function cmdPublish(args: string[]): Promise<void> {
  const [type, ...rest] = args;
  if (!type) {
    console.error("usage: olle publish <type> [json-payload]");
    process.exit(2);
  }
  let payload: unknown = {};
  if (rest.length) {
    try {
      payload = JSON.parse(rest.join(" "));
    } catch (err) {
      console.error(`olle publish: invalid JSON payload — ${(err as Error).message}`);
      process.exit(2);
    }
  }
  const paths = resolvePaths();
  await withIpc(paths.socketFile, async (client) => {
    const res = await client.call<{ id: string; hlc: string }>("publish", {
      type,
      payload,
      actorId: "cli",
      durable: true,
    });
    console.log(`${res.hlc} ${res.id}`);
  });
}

async function cmdExtension(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const paths = resolvePaths();
  await withIpc(paths.socketFile, async (client) => {
    switch (sub) {
      case undefined:
      case "list": {
        const list = await client.call<
          Array<{
            name: string;
            status: "registered" | "unregistered" | "broken";
            path: string;
            error?: string;
            lastCommit?: { sha: string; date: number; subject: string };
          }>
        >("extensions.list");
        if (list.length === 0) {
          console.log("(no extensions on disk)");
          return;
        }
        for (const e of list) {
          const last = e.lastCommit
            ? ` (${e.lastCommit.sha.slice(0, 7)} ${new Date(e.lastCommit.date).toISOString().slice(0, 10)})`
            : "";
          const detail = e.status === "broken" && e.error ? `  err=${e.error}` : "";
          console.log(`${e.name}  ${e.status}${last}${detail}`);
        }
        return;
      }
      case "reload": {
        const name = rest[0];
        if (!name) throw new Error("usage: olle extension reload <name>");
        const r = await client.call<{ name: string; status: string }>("extensions.reload", { name });
        console.log(`${r.name} ${r.status}`);
        return;
      }
      case "history": {
        const name = rest[0];
        if (!name) throw new Error("usage: olle extension history <name>");
        const rows = await client.call<
          Array<{ sha: string; author: string; date: number; subject: string }>
        >("extensions.history", { name });
        for (const r of rows) {
          const when = new Date(r.date).toISOString();
          console.log(`${r.sha.slice(0, 8)} ${when} ${r.author}: ${r.subject}`);
        }
        return;
      }
      case "revert": {
        const [name, sha] = rest;
        if (!name || !sha) throw new Error("usage: olle extension revert <name> <sha>");
        const r = await client.call<{
          name: string;
          revertedTo: string;
          newCommit: string | null;
          status: string;
        }>("extensions.revert", { name, sha });
        console.log(`${r.name}: reverted to ${sha.slice(0, 8)} (now ${r.status})`);
        return;
      }
      default:
        throw new Error(`unknown extension subcommand: ${sub}`);
    }
  });
}

async function cmdStarter(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const paths = resolvePaths();
  await withIpc(paths.socketFile, async (client) => {
    switch (sub) {
      case undefined:
      case "list": {
        const list = await client.call<Array<{ name: string; description: string }>>("starters.list");
        for (const s of list) {
          console.log(`${s.name}\n  ${s.description}`);
        }
        return;
      }
      case "install": {
        const name = rest[0];
        const overwrite = rest.includes("--overwrite");
        const noLoad = rest.includes("--no-load");
        if (!name) throw new Error("usage: olle starter install <name> [--overwrite] [--no-load]");
        const r = await client.call<{
          name: string;
          filesWritten: number;
          alreadyExisted: boolean;
          commit: string | null;
          status?: string;
        }>("starters.install", { name, overwrite, load: !noLoad });
        if (r.alreadyExisted && !overwrite) {
          console.log(`${r.name}: already installed (use --overwrite to replace)`);
        } else {
          console.log(`${r.name}: installed ${r.filesWritten} files${r.commit ? ` (commit ${r.commit.slice(0, 8)})` : ""}${r.status ? `; status=${r.status}` : ""}`);
        }
        return;
      }
      default:
        throw new Error(`unknown starter subcommand: ${sub}`);
    }
  });
}

async function cmdSecret(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const paths = resolvePaths();
  await withIpc(paths.socketFile, async (client) => {
    switch (sub) {
      case undefined:
      case "list": {
        const list = await client.call<
          Array<{ name: string; size: number; updatedAt: number }>
        >("secrets.list");
        if (list.length === 0) {
          console.log("(no secrets set)");
          return;
        }
        for (const s of list) {
          const when = new Date(s.updatedAt).toISOString();
          console.log(`${s.name}  ${s.size}B  ${when}`);
        }
        return;
      }
      case "set": {
        const name = rest[0];
        if (!name) {
          throw new Error("usage: olle secret set <NAME> [<value>]   (omit value to read from stdin)");
        }
        let value = rest.slice(1).join(" ");
        if (!value) {
          if (process.stdin.isTTY) {
            throw new Error(
              "no value provided. pass as argument or pipe on stdin, e.g. `printf '%s' $TOKEN | olle secret set DISCORD_TOKEN`",
            );
          }
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
          value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
        }
        const r = await client.call<{ name: string; bytes: number }>("secrets.set", {
          name,
          value,
        });
        console.log(`${r.name}: ${r.bytes}B written`);
        return;
      }
      case "remove":
      case "rm": {
        const name = rest[0];
        if (!name) throw new Error("usage: olle secret remove <NAME>");
        await client.call("secrets.remove", { name });
        console.log(`${name}: removed`);
        return;
      }
      default:
        throw new Error(`unknown secret subcommand: ${sub}`);
    }
  });
}

async function cmdChat(): Promise<void> {
  const paths = resolvePaths();
  // Initial connect — fail-fast if the daemon is not up at launch.
  // Once we're in the chat session, transient daemon outages are
  // recovered by the reconnect loop below.
  let current = await connectOrExit(paths.socketFile);
  // Fetch the root agent's id so we can address events to its mailbox.
  // Falls back to "root" only as a last resort — ids are ULID so the
  // lookup is cheap and authoritative.
  const { rootAgentId } = await current.call<{ rootAgentId: string }>("status.rootAgent");
  // Fail fast if the daemon's chat loop isn't running — typing into a
  // dead mailbox is the worst UX. The bus-level fallback also bounces
  // chat.input with the same reason, so this is belt-and-suspenders for
  // the CLI specifically. Older daemons without this method default to
  // "enabled" so we don't block the REPL on a missing endpoint.
  const chatStatus = await current
    .call<{ enabled: boolean; reason: string | null }>("status.chat")
    .catch(() => ({ enabled: true, reason: null }));
  if (!chatStatus.enabled) {
    current.close();
    const reason = chatStatus.reason ?? "chat loop not running";
    console.error(`olle chat: chat agent is disabled\n  ${reason}`);
    process.exit(1);
  }
  // Resolve the agent's actual name so the banner says "olle" or whatever
  // the principal named their agent — the ULID id is for logs, not eyes.
  const self = await current
    .call<AgentSelf | null>("observability.self", { agentId: rootAgentId })
    .catch(() => null);
  const agentName = self?.name?.trim() || "agent";
  // Inbox count is the channel-of-first-contact's nudge: if proposals are
  // waiting, surface them before the user types anything. Failing this
  // call shouldn't block chat — older daemons don't expose inbox.count.
  const inboxOpen = await current
    .call<{ open: number }>("inbox.count")
    .then((r) => r.open)
    .catch(() => 0);
  const threadId = `cli:${Math.random().toString(36).slice(2, 10)}`;

  const ui = createChatUI({ agentId: rootAgentId, agentName, threadId, inboxOpen });
  ui.banner();

  let turnBusy = false;
  let stopping = false;
  // Two-tap quit on idle: first Ctrl-C arms a hint, second within the
  // window exits. Streaming Ctrl-C cancels the turn and is independent.
  const QUIT_ARM_MS = 2_000;
  let quitArmedUntil = 0;

  // Slash command surface. Tiny on purpose; agent-authored extension
  // commands are not v0 — those would be tools, not chat shortcuts.
  const slashCommands: Array<{ name: string; description: string }> = [
    { name: "/help", description: "show available commands" },
    { name: "/clear", description: "clear scrollback" },
    { name: "/cancel", description: "cancel the current agent turn" },
    { name: "/inbox", description: "open the decision inbox in a new window (run `olle inbox`)" },
    { name: "/cost", description: "show running session cost (token + USD totals)" },
    { name: "/exit", description: "exit chat" },
    { name: "/quit", description: "exit chat" },
  ];
  const matchSlash = (input: string) => {
    if (!input.startsWith("/")) return [];
    // Match against the first whitespace-bounded token only; once the
    // user has typed `/help arg…` we leave the buffer alone.
    const head = input.split(/\s/, 1)[0]!.toLowerCase();
    return slashCommands.filter((c) => c.name.toLowerCase().startsWith(head));
  };
  const aboveFor = (text: string): string | null => {
    if (text.startsWith("/")) return ui.formatSuggestions(matchSlash(text));
    return ui.formatStatus();
  };

  const { LineEditor } = await import("./line-editor.ts");
  const editor = new LineEditor({
    in: process.stdin,
    out: process.stdout,
    prompt: ui.promptString(),
    promptCont: ui.promptContString(),
    callbacks: {
      onSubmit: handleSubmit,
      onAbort: () => idleCtrlC(),
      onEof: () => void stop(),
      onTab: (text) => {
        const matches = matchSlash(text);
        if (matches.length !== 1) return null;
        // Replace the leading `/foo` token with the canonical name + space.
        const rest = text.slice(text.split(/\s/, 1)[0]!.length);
        return matches[0]!.name + (rest.startsWith(" ") ? rest : ` ${rest.trimStart()}`);
      },
      onChange: (text) => editor.setAboveLine(aboveFor(text)),
      onStreamCancel: () => void cancelTurn(),
    },
  });

  function idleCtrlC(): void {
    // First press: arm; second press within the window: exit.
    const now = Date.now();
    if (now <= quitArmedUntil) {
      void stop();
      return;
    }
    quitArmedUntil = now + QUIT_ARM_MS;
    editor.setAboveLine(
      color(ANSI.muted, "press Ctrl-C again within 2s to exit"),
    );
    setTimeout(() => {
      if (Date.now() > quitArmedUntil) return; // already exited or rearmed
      // Disarm: redraw the normal status line if still idle.
      quitArmedUntil = 0;
      if (!turnBusy && !stopping) editor.setAboveLine(ui.formatStatus());
    }, QUIT_ARM_MS + 50);
  }

  async function cancelTurn(): Promise<void> {
    if (!turnBusy) return;
    ui.cancelling();
    try {
      await current.call("chat.cancel", { threadId });
    } catch {
      // If the IPC call itself fails the chat.cancelled / chat.error
      // event will still surface via the tail loop once the daemon
      // recovers. Don't let a transient socket error spam the user.
    }
  }

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    editor.close();
    process.stdout.write(color(ANSI.muted, "bye.") + "\n");
    try {
      current.close();
    } catch {
      /* already gone */
    }
    process.exit(0);
  };
  // Note: process.on("SIGINT") is intentionally NOT installed. Raw mode
  // disables OS-level SIGINT generation from \x03; the LineEditor reads
  // the byte directly and routes it (idle → two-tap quit confirm,
  // streaming → cancelTurn). SIGTERM still flows; we leave it unhandled
  // so the default exit semantics apply.

  async function handleSubmit(raw: string): Promise<void> {
    const text = raw.replace(/\s+$/, "");
    if (!text) {
      editor.refresh();
      return;
    }
    const slash = slashCommands.find((c) => c.name === text);
    if (slash) {
      ui.commitUserInput(text);
      if (slash.name === "/exit" || slash.name === "/quit") {
        await stop();
        return;
      }
      if (slash.name === "/help") ui.printSlashHelp(slashCommands);
      else if (slash.name === "/clear") ui.clearScrollback();
      else if (slash.name === "/cancel") {
        if (turnBusy) await cancelTurn();
        else ui.note("no agent turn in progress");
      } else if (slash.name === "/cost") ui.printCost();
      else if (slash.name === "/inbox")
        ui.note("inbox is its own command — run `olle inbox` in another shell");
      if (!stopping) {
        editor.setAboveLine(ui.formatStatus());
        editor.refresh();
      }
      return;
    }
    ui.commitUserInput(text);
    turnBusy = true;
    editor.suspend();
    try {
      await current.call("publish", {
        type: "chat.input",
        payload: { text },
        actorId: "cli",
        durable: true,
        toAgentId: rootAgentId,
        threadId,
      });
    } catch (e) {
      // Publish failed — usually the daemon dropped between input and
      // send. Surface the error; the reconnect loop repaints the prompt
      // once we're back on the bus.
      ui.error(`send failed: ${(e as Error).message}`);
      turnBusy = false;
      reprompt();
    }
  }

  function reprompt(): void {
    if (stopping || turnBusy) return;
    editor.setAboveLine(ui.formatStatus());
    editor.refresh();
  }

  editor.start();

  // Outer reconnect loop. Each iteration subscribes to the tail and
  // drains events until the underlying socket closes, then reconnects
  // with exponential backoff and resubscribes — same threadId, so the
  // session continues against the same conversation on the daemon side.
  let backoff = 250;
  while (!stopping) {
    let sub: ReturnType<typeof current.stream>;
    try {
      sub = current.stream("tail", { type: "*" });
    } catch {
      await current.closed.catch(() => {});
      await reconnect();
      continue;
    }
    backoff = 250;
    reprompt();

    try {
      for await (const ev of sub.events) {
        if (ev.threadId !== threadId) continue;
        const p = ev.payload as Record<string, unknown>;
        if (ev.type === "chat.assistant-delta") {
          ui.assistantDelta(String(p.text ?? ""));
        } else if (ev.type === "chat.assistant-text") {
          // Authoritative full text arrives after the deltas finish.
          // Rewind the streamed plaintext and reprint with markdown
          // applied so the user sees real headings/bold/code blocks.
          ui.assistantText(String(p.text ?? ""));
        } else if (ev.type === "chat.tool-call") {
          ui.toolCall(String(p.name ?? "?"), p.input);
        } else if (ev.type === "chat.tool-result") {
          ui.toolResult(String(p.content ?? ""), Boolean(p.isError));
        } else if (ev.type === "chat.api-retry") {
          ui.retry({
            attempt: numFrom(p.attempt),
            status: typeof p.status === "number" ? p.status : undefined,
            waitMs: numFrom(p.waitMs),
            message: typeof p.message === "string" ? p.message : undefined,
          });
        } else if (ev.type === "chat.turn-end") {
          ui.turnEnd({
            inputTokens: numFrom(p.inputTokens),
            outputTokens: numFrom(p.outputTokens),
            cacheReadTokens: numFrom(p.cacheReadTokens),
            cacheCreationTokens: numFrom(p.cacheCreationTokens),
            usdMicros: numFrom(p.usdMicros),
            stopReason: String(p.stopReason ?? ""),
            model: typeof p.model === "string" ? p.model : "",
          });
          turnBusy = false;
          reprompt();
        } else if (ev.type === "chat.error") {
          ui.error(String(p.error ?? ""));
          turnBusy = false;
          reprompt();
        } else if (ev.type === "chat.cancelled") {
          ui.cancelled();
          turnBusy = false;
          reprompt();
        }
      }
    } catch {
      /* ipc closed mid-stream — fall through to reconnect */
    }

    if (stopping) break;
    // Disconnect mid-turn leaves turnBusy true with no chat.turn-end
    // ever arriving. Clear it so the prompt re-fires after we
    // resubscribe.
    turnBusy = false;
    await reconnect();
  }

  async function reconnect(): Promise<void> {
    editor.suspend();
    process.stdout.write(
      color(ANSI.warning, "  ⟳ daemon disconnected — reconnecting…") + "\n",
    );
    let attempt = 1;
    while (!stopping) {
      try {
        current = await connectIpc(paths.socketFile);
        process.stdout.write(color(ANSI.success, "  ⟳ reconnected") + "\n");
        return;
      } catch {
        process.stdout.write(
          color(
            ANSI.muted,
            `  ⟳ retry in ${(backoff / 1000).toFixed(1)}s (attempt ${attempt})`,
          ) + "\n",
        );
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
        attempt++;
      }
    }
  }
}

function numFrom(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

// ───────────────────────────────────────────────────────────────────────
// Chat UI — light ANSI dressing for `olle chat`. No TUI framework, no
// alternate screen; just a vocabulary of styled lines so the agent's
// turn structure is legible. Palette lives in `./theme.ts` so the
// markdown renderer paints from the same swatches.
// ───────────────────────────────────────────────────────────────────────

import { ANSI } from "./theme.ts";

function color(code: string, s: string): string {
  // Skip styling when stdout is piped — keeps `olle chat | tee` clean.
  if (!process.stdout.isTTY) return s;
  return `${code}${s}${ANSI.reset}`;
}

function termWidth(): number {
  const w = process.stdout.columns;
  return w && w > 20 ? w : 80;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatUsd(usdMicros: number): string {
  const usd = usdMicros / 1_000_000;
  if (usd < 0.001) return `$${usd.toFixed(5)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

// Keys that, when present, carry the most important "what specifically"
// information for a tool call. Tried in order; the first match wins and
// the matching field renders bare (e.g. memory_search("discord auth"))
// while the rest fold into key=value pairs after it. The list is
// deliberately broad — the same name shape repeats across primitives
// (id, path, name, query, etc.) so a single cross-tool table works.
const PRIMARY_INPUT_KEYS = [
  "query",
  "q",
  "path",
  "title",
  "name",
  "id",
  "agentId",
  "threadId",
  "memoryId",
  "handle",
  "names",
  "text",
  "to",
];

function clipString(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}

function summarizeScalar(v: unknown, budget: number): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return JSON.stringify(clipString(v, Math.max(8, budget - 2)));
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (v.length > 4) return `[${v.length} items]`;
    const inner = v.map((x) => summarizeScalar(x, 24)).join(", ");
    return inner.length <= budget ? `[${inner}]` : `[${v.length} items]`;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>);
    if (keys.length === 0) return "{}";
    if (keys.length === 1) {
      const k = keys[0]!;
      return `{${k}: ${summarizeScalar((v as Record<string, unknown>)[k], 24)}}`;
    }
    return `{${keys.length} keys}`;
  }
  return String(v);
}

function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  const max = Math.max(20, termWidth() - 16);
  if (typeof input !== "object") return clipString(String(input), max);
  if (Array.isArray(input)) return clipString(summarizeScalar(input, max), max);

  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return "";

  // Find the primary key, if any. Surfaces the "what specifically" of
  // the call as a bare value while everything else stays as key=value
  // for clarity.
  let primary: string | null = null;
  for (const k of PRIMARY_INPUT_KEYS) {
    if (k in obj) {
      primary = k;
      break;
    }
  }

  const parts: string[] = [];
  if (primary !== null) {
    parts.push(summarizeScalar(obj[primary], 80));
    for (const k of keys) {
      if (k === primary) continue;
      const v = obj[k];
      if (v === null || v === undefined) continue;
      parts.push(`${k}=${summarizeScalar(v, 24)}`);
    }
  } else {
    for (const k of keys) {
      const v = obj[k];
      if (v === null || v === undefined) continue;
      parts.push(`${k}=${summarizeScalar(v, 24)}`);
    }
  }

  let out = parts.join(", ");
  if (out.length > max) out = `${out.slice(0, Math.max(1, max - 1))}…`;
  return out;
}

function summarizeResult(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  const max = Math.max(20, termWidth() - 8);
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Visible length, ignoring ANSI escape sequences. */
function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export interface ChatUIOut {
  write(s: string): unknown;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

export interface ChatUIOpts {
  agentId: string;
  agentName: string;
  threadId: string;
  /** Open decision-inbox count at session start. When > 0 the banner
   *  prints a one-line nudge so the channel-of-first-contact actually
   *  surfaces async work waiting on the principal. */
  inboxOpen?: number;
  /** Test injection point. Defaults to process.stdout. */
  out?: ChatUIOut;
}

export function createChatUI(opts: ChatUIOpts) {
  const out: ChatUIOut = opts.out ?? process.stdout;
  const headerLabel = `◆ ${opts.agentName}`;

  // Progressive block-commit streaming. The assistant block has two halves:
  //   committed — header + already-rendered markdown blocks. Written once,
  //               never rewound. Lines that scroll into the terminal's
  //               scrollback are stable and never duplicated by a later
  //               redraw.
  //   pending   — the in-flight tail past the last stable boundary
  //               (a blank line outside any fenced code block). Painted as
  //               raw text and rewound on each delta. Bounded by the
  //               viewport via maxPendingRows() — when the tail outgrows
  //               that budget we force-commit it as raw and start fresh,
  //               sacrificing markdown formatting on the overflow chunk
  //               but never letting rewind reach into scrollback.
  let headerWritten = false;
  let committedText = ""; // exact prefix already markdown-committed
  let hasCommittedContent = false; // gate the inter-block blank line
  let inFence = false; // does the committed prefix end inside a fence?
  let pendingText = ""; // post-boundary tail buffer
  let pendingRows = 0; // visual rows below the start of the pending tail
  let pendingCol = 0; // cursor column on the bottom pending row

  // Cumulative session stats — accumulated across every chat.turn-end
  // and rendered as a single dim line above the next prompt.
  const sessionStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    usdMicros: 0,
    model: "",
  };

  function termWidth(): number {
    const w = out.columns;
    return w && w > 20 ? w : 80;
  }

  function termHeight(): number {
    const h = out.rows;
    return h && h > 10 ? h : 24;
  }

  function maxPendingRows(): number {
    // Reserve a few rows for the prompt + statusline so an expanding
    // tail never quite fills the viewport before we cap it.
    return Math.max(4, termHeight() - 4);
  }

  function ensureHeader(): void {
    if (headerWritten) return;
    out.write(color(`${ANSI.bold}${ANSI.primary}`, headerLabel) + "\n");
    headerWritten = true;
  }

  function rewindPending(): void {
    // Cursor back to the start of the pending tail, then erase forward.
    // Bounded by maxPendingRows() so this never tries to reach into
    // scrollback. Non-TTY: pending is never painted, nothing to rewind.
    if (!out.isTTY) return;
    if (pendingRows === 0 && pendingCol === 0) return;
    if (pendingRows > 0) out.write(`\x1b[${pendingRows}F`);
    else out.write("\r");
    out.write("\x1b[0J");
    pendingRows = 0;
    pendingCol = 0;
  }

  function writeRawPending(text: string): void {
    // Stream raw text indented two spaces (matching the markdown commit
    // format), tracking visual rows for the next rewind. Each line of
    // content gets its own indent so a rewind+rewrite reproduces the
    // same shape.
    if (text.length === 0) return;
    const w = termWidth();
    if (pendingRows === 0 && pendingCol === 0) {
      out.write("  ");
      pendingCol = 2;
    }
    for (const ch of text) {
      if (ch === "\n") {
        out.write("\n  ");
        pendingRows++;
        pendingCol = 2;
        continue;
      }
      // Deferred-wrap accounting: terminals park the cursor at col=width
      // and only advance to the next row when the *next* visible char
      // arrives. Counting the wrap on the next char (not when col first
      // reaches width) keeps pendingRows in sync with where the cursor
      // actually sits, so the rewind moves up the right number of rows.
      if (pendingCol >= w) {
        pendingRows++;
        pendingCol = 0;
      }
      out.write(ch);
      pendingCol++;
    }
  }

  function commitMarkdown(text: string): boolean {
    if (text.length === 0) return false;
    const lines = renderMarkdown(
      text,
      Math.max(20, termWidth() - 2),
      out.isTTY ? undefined : plainTheme,
    );
    if (lines.length === 0) return false;
    for (const line of lines) {
      out.write("  ");
      out.write(line);
      out.write("\n");
    }
    return true;
  }

  function commitTail(tail: string): void {
    if (tail.length === 0) return;
    if (hasCommittedContent) out.write("\n");
    if (commitMarkdown(tail)) hasCommittedContent = true;
  }

  function finalizeBlock(): void {
    if (!headerWritten) return;
    out.write("\n");
    headerWritten = false;
    committedText = "";
    pendingText = "";
    pendingRows = 0;
    pendingCol = 0;
    inFence = false;
    hasCommittedContent = false;
  }

  function flushAssistant(): void {
    if (!headerWritten) return;
    rewindPending();
    commitTail(pendingText);
    finalizeBlock();
  }

  function findStableBoundary(
    text: string,
    startInFence: boolean,
  ): { idx: number; endsInFence: boolean } | null {
    // Earliest renderable point: position immediately after the last
    // blank line that sits outside a code fence. The trailing blank
    // proves the previous block is structurally complete (a paragraph
    // with no trailing blank could still grow another line and reflow).
    // The last text segment is excluded because it has no terminating
    // newline yet — it might still grow.
    let inF = startInFence;
    let pos = 0;
    let lastBoundary = -1;
    let lastEndsInFence = startInFence;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const segLen = line.length + (i < lines.length - 1 ? 1 : 0);
      pos += segLen;
      if (/^\s*```/.test(line)) inF = !inF;
      if (i < lines.length - 1 && line.trim() === "" && !inF) {
        lastBoundary = pos;
        lastEndsInFence = inF;
      }
    }
    return lastBoundary >= 0
      ? { idx: lastBoundary, endsInFence: lastEndsInFence }
      : null;
  }

  function countFenceToggles(text: string): boolean {
    let toggled = false;
    for (const line of text.split("\n")) {
      if (/^\s*```/.test(line)) toggled = !toggled;
    }
    return toggled;
  }

  function forceFlushPending(): void {
    // Pending tail outgrew the viewport-bounded rewind budget. Freeze
    // what's on screen as raw committed text — markdown formatting is
    // sacrificed for that span, but scrollback stays clean. Subsequent
    // pending starts fresh on a new row.
    if (pendingText.length === 0) {
      pendingRows = 0;
      pendingCol = 0;
      return;
    }
    if (countFenceToggles(pendingText)) inFence = !inFence;
    committedText += pendingText;
    pendingText = "";
    hasCommittedContent = true;
    if (pendingCol > 0) out.write("\n");
    pendingRows = 0;
    pendingCol = 0;
  }

  function processDelta(delta: string): void {
    if (!out.isTTY) {
      // Piped output: buffer silently. assistantText() commits the whole
      // reply once at the end so log files don't get partial chunks.
      pendingText += delta;
      return;
    }
    ensureHeader();
    pendingText += delta;
    const boundary = findStableBoundary(pendingText, inFence);
    if (boundary) {
      const stable = pendingText.slice(0, boundary.idx);
      const remainder = pendingText.slice(boundary.idx);
      rewindPending();
      commitTail(stable);
      committedText += stable;
      inFence = boundary.endsInFence;
      pendingText = remainder;
      writeRawPending(remainder);
    } else {
      rewindPending();
      writeRawPending(pendingText);
    }
    if (pendingRows > maxPendingRows()) forceFlushPending();
  }

  return {
    banner(): void {
      // Lean two-line intro — diamond + name on the first row, hint
      // strip below in muted text. The previous heavy box-drawing
      // didn't carry information that earned its visual weight, and
      // flush-left lets the welcome ◆ sit on the same column the
      // assistant header lands on for every subsequent turn.
      const diamond = color(`${ANSI.bold}${ANSI.primary}`, "◆");
      const name = color(ANSI.bold, opts.agentName);
      out.write(`${diamond} ${name}\n`);
      const sep = color(ANSI.muted, " · ");
      const hints = ["alt+enter newline", "ctrl+c cancel/quit", "/help"]
        .map((h) => color(ANSI.muted, h))
        .join(sep);
      out.write(`${hints}\n`);
      const n = opts.inboxOpen ?? 0;
      if (n > 0) {
        const word = n === 1 ? "item" : "items";
        const bullet = color(`${ANSI.bold}${ANSI.warning}`, "!");
        const text = color(
          ANSI.warning,
          `${n} ${word} in your inbox — \`olle inbox\` to review`,
        );
        out.write(`\n${bullet} ${text}\n`);
      }
      out.write("\n");
    },

    promptString(): string {
      return color(`${ANSI.bold}${ANSI.primary}`, "❯ ");
    },
    promptContString(): string {
      // Two visible spaces — same width as `❯ `, no glyph. Aligns
      // continuation-line text with the first line's content column.
      return "  ";
    },

    /** Write the user's submitted message into scrollback as a styled
     *  gutter block. Multi-line messages get one gutter mark on the
     *  first line and a blank-prefix indent on continuation lines, so
     *  the entire message reads as one visually grouped chunk. */
    commitUserInput(text: string): void {
      if (!out.isTTY) {
        out.write(text);
        out.write("\n");
        return;
      }
      const lines = text.split("\n");
      const gutter = color(`${ANSI.bold}${ANSI.secondary}`, "▎");
      for (let i = 0; i < lines.length; i++) {
        const body = color(ANSI.text, lines[i] ?? "");
        out.write(i === 0 ? `${gutter} ${body}\n` : `  ${body}\n`);
      }
      out.write("\n");
    },

    /** Print the slash command list as a small agent-style help block. */
    printSlashHelp(cmds: Array<{ name: string; description: string }>): void {
      out.write(color(`${ANSI.bold}${ANSI.primary}`, "◆ commands") + "\n");
      const w = Math.max(...cmds.map((c) => c.name.length));
      for (const c of cmds) {
        out.write(
          `  ${color(ANSI.primary, c.name.padEnd(w))}  ${color(ANSI.muted, c.description)}\n`,
        );
      }
      out.write("\n");
    },

    /** Wipe screen + scrollback. */
    clearScrollback(): void {
      if (!out.isTTY) return;
      out.write("\x1b[H\x1b[2J\x1b[3J");
    },

    /** Stream a chunk of assistant text. Each delta extends the pending
     *  tail and either commits the just-stabilized block as markdown
     *  (when a blank-line boundary appears) or repaints just the tail.
     *  On non-TTY we silently buffer and let assistantText() commit the
     *  whole reply once. */
    assistantDelta(text: string): void {
      if (!text) return;
      processDelta(text);
    },

    /** Authoritative full text. Commits any tail not already markdown-
     *  rendered and closes the block. Trusts `full` over the streamed
     *  buffer — if the provider sent something different from what we
     *  concatenated (rare), we render the un-committed tail of `full`
     *  rather than risk double-printing. */
    assistantText(full: string): void {
      ensureHeader();
      if (!out.isTTY) {
        commitTail(full);
        finalizeBlock();
        return;
      }
      rewindPending();
      const tail = full.startsWith(committedText)
        ? full.slice(committedText.length)
        : pendingText;
      commitTail(tail);
      finalizeBlock();
    },

    toolCall(name: string, input: unknown): void {
      flushAssistant();
      const icon = toolIcon(name);
      const head = color(ANSI.muted, `  ${icon} `);
      const body = `${color(ANSI.text, name)}${color(ANSI.muted, `(${summarizeInput(input)})`)}`;
      out.write(`${head}${body}\n`);
    },

    toolResult(content: string, isError: boolean): void {
      flushAssistant();
      const text = (content ?? "").replace(/\s+$/, "");
      const barColor = isError ? ANSI.error : ANSI.border;
      const bodyColor = isError ? ANSI.error : ANSI.muted;
      const bar = color(barColor, "│");
      // Always render results inside a left-bar block so the eye binds
      // them to the call line above. Single-line collapses to one bar
      // row; multi-line stacks. Border picks up the error tone when
      // the call failed so colour is the cue, not a tag.
      if (!text) {
        out.write(`    ${bar} ${color(bodyColor, "(empty)")}\n`);
        return;
      }
      const lines = text.split("\n");
      if (lines.length === 1) {
        const oneLine = summarizeResult(text);
        out.write(`    ${bar} ${color(bodyColor, oneLine)}\n`);
        return;
      }
      const w = termWidth();
      const inner = Math.max(20, w - 6); // 4 lead spaces + "│ "
      const MAX_LINES = 12;
      const shown = lines.slice(0, MAX_LINES);
      for (const ln of shown) {
        const trimmed = ln.length > inner ? `${ln.slice(0, inner - 1)}…` : ln;
        out.write(`    ${bar} ${color(bodyColor, trimmed)}\n`);
      }
      if (lines.length > MAX_LINES) {
        const more = `… ${lines.length - MAX_LINES} more line${lines.length - MAX_LINES === 1 ? "" : "s"}`;
        out.write(`    ${bar} ${color(ANSI.muted, more)}\n`);
      }
    },

    retry(info: { attempt: number; status?: number; waitMs: number; message?: string }): void {
      flushAssistant();
      const waitS = (info.waitMs / 1000).toFixed(1);
      const statusStr = info.status ? ` HTTP ${info.status}` : "";
      const reason =
        info.status === 529 || info.status === 503
          ? "API overloaded"
          : info.status === 429
            ? "rate limited"
            : "API hiccup";
      const line = `  ⟳ ${reason}${statusStr} — retrying in ${waitS}s (attempt ${info.attempt + 1})`;
      out.write(color(ANSI.warning, line) + "\n");
    },

    error(msg: string): void {
      flushAssistant();
      out.write(color(ANSI.error, `  ⚠ ${msg}`) + "\n\n");
    },

    /** "we asked the daemon to cancel; waiting on the abort to land". */
    cancelling(): void {
      out.write(color(ANSI.warning, "  ⏹ cancelling…") + "\n");
    },

    /** Daemon confirmed the turn was aborted. */
    cancelled(): void {
      flushAssistant();
      out.write(color(ANSI.warning, "  ⏹ turn cancelled") + "\n\n");
    },

    /** Plain dim status note (no agent attribution). */
    note(msg: string): void {
      out.write(color(ANSI.muted, `  ${msg}`) + "\n\n");
    },

    /** Spell out the cumulative session cost in a multi-line block. The
     *  one-liner above the prompt is glanceable; this is the "give me the
     *  numbers" form for `/cost`. */
    printCost(): void {
      const s = sessionStats;
      const total =
        s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheCreationTokens;
      if (total === 0 && s.usdMicros === 0) {
        out.write(color(ANSI.muted, "  no turns this session yet.") + "\n\n");
        return;
      }
      const label = (s: string) => color(ANSI.muted, s.padEnd(13));
      const value = (s: string) => color(ANSI.text, s);
      const lines = [
        color(`${ANSI.bold}${ANSI.primary}`, "◆ session cost"),
        `  ${label("input")}${value(formatTokens(s.inputTokens))}`,
        `  ${label("output")}${value(formatTokens(s.outputTokens))}`,
        `  ${label("cache read")}${value(formatTokens(s.cacheReadTokens))}`,
        `  ${label("cache create")}${value(formatTokens(s.cacheCreationTokens))}`,
        `  ${label("total tokens")}${value(formatTokens(total))}`,
        `  ${label("total cost")}${value(formatUsd(s.usdMicros))}`,
      ];
      if (s.model) lines.push(`  ${label("model")}${color(ANSI.muted, s.model)}`);
      out.write(lines.join("\n") + "\n\n");
    },

    /** Accumulate per-turn usage into running session totals. The
     *  rendered output is deferred to formatStatus(), which the editor
     *  paints into its above-prompt slot between turns — so the user
     *  sees one quiet line above the prompt rather than a noisy border
     *  after every reply. */
    turnEnd(stats: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      usdMicros: number;
      stopReason: string;
      model: string;
    }): void {
      flushAssistant();
      sessionStats.inputTokens += stats.inputTokens;
      sessionStats.outputTokens += stats.outputTokens;
      sessionStats.cacheReadTokens += stats.cacheReadTokens;
      sessionStats.cacheCreationTokens += stats.cacheCreationTokens;
      sessionStats.usdMicros += stats.usdMicros;
      if (stats.model) sessionStats.model = stats.model;
      // Surface non-normal stop reasons immediately — user shouldn't
      // wait for the next prompt to learn the turn cut off early.
      if (stats.stopReason && stats.stopReason !== "end_turn") {
        out.write(color(ANSI.muted, `  ⌁ stop: ${stats.stopReason}`) + "\n");
      }
    },

    /** Format the dim cumulative status line. Returns null when there's
     *  nothing meaningful to show (first prompt, before any turn
     *  completed). The caller passes the result to the editor's
     *  setAboveLine() — rendering is the editor's responsibility. */
    formatStatus(): string | null {
      const parts: string[] = [];
      if (sessionStats.inputTokens) parts.push(`↑${formatTokens(sessionStats.inputTokens)}`);
      if (sessionStats.outputTokens) parts.push(`↓${formatTokens(sessionStats.outputTokens)}`);
      if (sessionStats.cacheReadTokens) parts.push(`R${formatTokens(sessionStats.cacheReadTokens)}`);
      if (sessionStats.cacheCreationTokens) parts.push(`W${formatTokens(sessionStats.cacheCreationTokens)}`);
      if (sessionStats.usdMicros) parts.push(formatUsd(sessionStats.usdMicros));
      // Use a styled ` · ` separator so the eye groups paired numbers
      // instead of reading the run together. Both halves dim so the
      // line stays a footer, never competing with assistant content.
      const sep = color(ANSI.border, " · ");
      const left = parts.map((p) => color(ANSI.muted, p)).join(sep);
      const right = sessionStats.model
        ? color(ANSI.muted, sessionStats.model)
        : "";
      if (!left && !right) return null;
      const w = termWidth();
      const padNeeded = Math.max(1, w - visibleLen(left) - visibleLen(right));
      return `${left}${" ".repeat(padNeeded)}${right}`;
    },

    /** Format matching slash-command suggestions for the above-prompt
     *  slot. Returns a single-line styled string. */
    formatSuggestions(matches: Array<{ name: string; description: string }>): string {
      if (matches.length === 0) return color(ANSI.muted, "no matches");
      const w = Math.max(20, termWidth());
      const items = matches
        .slice(0, 5)
        .map((c) => `${color(ANSI.primary, c.name)}${color(ANSI.muted, ` ${c.description}`)}`);
      const sep = color(ANSI.border, " · ");
      let acc = "";
      for (const it of items) {
        const next = acc ? acc + sep + it : it;
        if (visibleLen(next) > w - 2) break;
        acc = next;
      }
      return acc || items[0]!;
    },
  };
}

/** Map a tool name to a small visual icon so the eye sorts the
 *  assistant's tool calls by shape, not by reading. Mirrors the
 *  vocabulary common in modern chat-style coding agents:
 *
 *    →  read-shaped (read_*, mail_list, query_self memory_read, …)
 *    ←  write-shaped (write_*, set_secret, memory_write, mail_respond, …)
 *    ✱  search (memory_search, query_events with filters)
 *    ◇  query / list (query_*, list_*, extension_history)
 *    │  delegation (spawn_agent, kill_agent, retarget_thread)
 *    +  load_tools         −  unload_tools
 *    ▶  run_smoke_test
 *    ⏵  fallback
 */
function toolIcon(name: string): string {
  if (name === "load_tools") return "+";
  if (name === "unload_tools") return "−";
  if (name === "memory_search") return "✱";
  if (name === "run_smoke_test") return "▶";
  if (
    name === "spawn_agent" ||
    name === "kill_agent" ||
    name === "retarget_thread"
  ) {
    return "│";
  }
  if (
    name.startsWith("read_") ||
    name === "mail_list" ||
    name === "scratch_read" ||
    name === "scratch_list" ||
    name === "memory_read" ||
    name === "memory_lineage"
  ) {
    return "→";
  }
  if (
    name.startsWith("write_") ||
    name === "set_secret" ||
    name === "remove_secret" ||
    name === "scratch_write" ||
    name === "scratch_delete" ||
    name === "install_starter" ||
    name === "register_extension" ||
    name === "revert_extension" ||
    name === "memory_write" ||
    name === "memory_promote" ||
    name === "memory_forget" ||
    name === "mail_respond" ||
    name === "mail_reply" ||
    name === "mail_propose"
  ) {
    return "←";
  }
  if (
    name.startsWith("query_") ||
    name.startsWith("list_") ||
    name === "extension_history"
  ) {
    return "◇";
  }
  return "⏵";
}

// --- Observability subcommands. All wrap the same observability.* IPC
// methods that agents reach through their query_my_* core tools. The CLI
// is just the human's tool surface — no privileged data, no special path.

interface ObsFlags {
  agent?: string;
  thread?: string;
  since?: number;
  limit?: number;
}

function parseObsFlags(args: string[]): ObsFlags {
  const out: ObsFlags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--agent" && args[i + 1]) {
      out.agent = args[++i];
    } else if (a === "--thread" && args[i + 1]) {
      out.thread = args[++i];
    } else if (a === "--since" && args[i + 1]) {
      out.since = parseSinceArg(args[++i]!);
    } else if (a === "--limit" && args[i + 1]) {
      out.limit = Number.parseInt(args[++i]!, 10);
    }
  }
  return out;
}

// Accept either an absolute ms epoch ("1714000000000") or a relative
// duration ("1h", "30m", "7d"). Relative is more useful in practice.
function parseSinceArg(raw: string): number {
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  const m = /^(\d+)([smhd])$/.exec(raw);
  if (!m) throw new Error(`bad --since: ${raw} (use ms epoch or 30s/15m/2h/7d)`);
  const n = Number.parseInt(m[1]!, 10);
  const unit = m[2];
  const ms = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return Date.now() - n * ms;
}

function fmtUsd(micros: number): string {
  if (micros === 0) return "$0.00";
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

function fmtPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

// Shared shape for the simple observability commands: parse obs flags +
// any extras, run one IPC call, hand the result to a formatter. Commands
// that need a second call (cmdStats' optional budget pull) take an
// `extra` hook with the live client. Everyone goes through withIpc.
async function runObsCmd<T>(
  args: string[],
  spec: {
    method: string;
    buildParams: (flags: ObsFlags, args: string[]) => Record<string, unknown>;
    format: (value: T) => void;
    extra?: (client: IpcClient, flags: ObsFlags) => Promise<void>;
  },
): Promise<void> {
  const flags = parseObsFlags(args);
  const paths = resolvePaths();
  await withIpc(paths.socketFile, async (client) => {
    const value = await client.call<T>(spec.method, spec.buildParams(flags, args));
    spec.format(value);
    if (spec.extra) await spec.extra(client, flags);
  });
}

function parseFlagValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) return args[i + 1];
  }
  return undefined;
}

async function cmdStats(args: string[]): Promise<void> {
  await runObsCmd<UsageStats>(args, {
    method: "observability.usage",
    buildParams: (f) => ({ actorId: f.agent, threadId: f.thread, since: f.since }),
    format: (stats) => {
      const t = stats.totals;
      console.log(
        `tokens: in=${t.inputTokens} out=${t.outputTokens} cache_read=${t.cacheReadTokens} cache_create=${t.cacheCreationTokens}`,
      );
      console.log(`hit_ratio: ${fmtPct(t.cacheHitRatio)}`);
      console.log(`usd: ${fmtUsd(t.usdMicros)} (${stats.rows} ledger rows scanned)`);
      if (stats.byModel.length > 0) {
        console.log("by model:");
        for (const m of stats.byModel) {
          const tag = m.pricePosted ? "" : " (fallback price)";
          console.log(
            `  ${m.provider}/${m.model}: ${m.calls} calls, in=${m.inputTokens} out=${m.outputTokens} cache_r=${m.cacheReadTokens} hit=${fmtPct(m.cacheHitRatio)} ${fmtUsd(m.usdMicros)}${tag}`,
          );
        }
      }
    },
    // Budget side, same call shape if --agent given.
    extra: async (client, f) => {
      if (!f.agent) return;
      const b = await client.call<BudgetStatus>("observability.budget", { actorId: f.agent });
      if (b.rows.length === 0) return;
      console.log("budget:");
      for (const r of b.rows) {
        const cap = r.capUsd != null ? fmtUsd(r.capUsd) : "-";
        const pct = r.percentUsd != null ? fmtPct(r.percentUsd) : "-";
        console.log(`  ${r.period}: ${fmtUsd(r.spentUsd)} / ${cap}  (${pct})`);
      }
    },
  });
}

async function cmdCache(args: string[]): Promise<void> {
  // Cache-focused rollup — just the cache columns + hit ratio.
  await runObsCmd<UsageStats>(args, {
    method: "observability.usage",
    buildParams: (f) => ({ actorId: f.agent, threadId: f.thread, since: f.since }),
    format: (stats) => {
      const t = stats.totals;
      console.log(`hit_ratio: ${fmtPct(t.cacheHitRatio)}`);
      console.log(
        `cache_read=${t.cacheReadTokens} cache_create=${t.cacheCreationTokens} input=${t.inputTokens}`,
      );
      if (stats.byModel.length === 0) {
        console.log("(no ledger rows)");
        return;
      }
      console.log("by model:");
      for (const m of stats.byModel) {
        console.log(
          `  ${m.provider}/${m.model}: hit=${fmtPct(m.cacheHitRatio)} read=${m.cacheReadTokens} create=${m.cacheCreationTokens} (${m.calls} calls)`,
        );
      }
    },
  });
}

async function cmdRuns(args: string[]): Promise<void> {
  await runObsCmd<RunHistoryRow[]>(args, {
    method: "observability.runs",
    buildParams: (f, raw) => ({
      actorId: f.agent,
      status: parseFlagValue(raw, "--status"),
      since: f.since,
      limit: f.limit,
    }),
    format: (runs) => {
      if (runs.length === 0) {
        console.log("(no runs)");
        return;
      }
      for (const r of runs) {
        const dur = r.durationMs != null ? `${r.durationMs}ms` : "running";
        const err = r.error ? `  err=${r.error}` : "";
        const when = new Date(r.startedAt).toISOString();
        console.log(`${when}  ${r.status.padEnd(9)}  ${r.taskId}  ${dur}${err}`);
      }
    },
  });
}

async function cmdThreads(args: string[]): Promise<void> {
  await runObsCmd<ThreadInventoryRow[]>(args, {
    method: "observability.threads",
    buildParams: (f) => ({ toAgentId: f.agent, limit: f.limit }),
    format: (threads) => {
      if (threads.length === 0) {
        console.log("(no threads)");
        return;
      }
      for (const t of threads) {
        const when = new Date(t.lastEventAt).toISOString();
        console.log(
          `${when}  ${t.threadId}  events=${t.events}  hit=${fmtPct(t.cacheHitRatio)}  last=${t.lastType}`,
        );
      }
    },
  });
}

async function cmdEvents(args: string[]): Promise<void> {
  // Single-shot event-log query (the streaming variant is `olle tail`).
  await runObsCmd<RecentEventRow[]>(args, {
    method: "observability.events",
    buildParams: (f, raw) => ({
      actorId: f.agent,
      type: parseFlagValue(raw, "--type"),
      threadId: f.thread,
      since: f.since,
      limit: f.limit,
    }),
    format: (events) => {
      if (events.length === 0) {
        console.log("(no events)");
        return;
      }
      for (const e of events) {
        console.log(`${e.hlc} ${e.type} actor=${e.actorId} payload=${JSON.stringify(e.payload)}`);
      }
    },
  });
}

async function cmdInspect(args: string[]): Promise<void> {
  const [sub, target] = args;
  if (sub !== "agent" || !target) {
    throw new Error("usage: olle inspect agent <agent-id>");
  }
  const paths = resolvePaths();
  await withIpc(paths.socketFile, async (client) => {
    const self = await client.call<AgentSelf | null>("observability.self", {
      agentId: target,
    });
    if (!self) {
      console.error(`agent not found: ${target}`);
      process.exit(1);
    }
    console.log(`id:     ${self.agentId}`);
    console.log(`name:   ${self.name}`);
    console.log(`host:   ${self.hostId}`);
    console.log(`parent: ${self.parentAgentId ?? "(none)"}`);
    console.log(`principles: ${self.principleCount}`);
    if (self.scope.allowTiers) {
      console.log(`scope: tiers=${self.scope.allowTiers.join(",")}`);
    }
    if (self.tools.length > 0) {
      console.log(`tools: ${self.tools.map((t) => t.name).join(", ")}`);
    }
    if (self.recentlyPricedModels.length > 0) {
      console.log("recent models:");
      for (const m of self.recentlyPricedModels) {
        const tag = m.pricePosted ? "" : " (fallback price)";
        console.log(`  ${m.provider}/${m.model}${tag}`);
      }
    }
    if (self.systemPrompt) {
      console.log("---");
      console.log(self.systemPrompt);
    }
  });
}

interface InboxRow {
  id: string;
  principalId: string;
  proposingAgentId: string;
  proposingAgentName?: string;
  principalDisplay?: string;
  tier: string;
  summary: string;
  payload: Record<string, unknown>;
  status: string;
  staleness: number | null;
  createdAt: number;
  resolvedAt: number | null;
  /** Per-decision unread reply count for the current reader. Emitted by
   *  `inbox.list` so the CLI can render the "(N new)" badge without a
   *  follow-up call. */
  unreadReplyCount?: number;
}

interface DecisionMessageRow {
  id: string;
  decisionId: string;
  actorId: string;
  /** Display name for `actorId`, resolved server-side. Falls back to
   *  the raw id when no agents/principals row matches. */
  actorName?: string;
  text: string;
  at: number;
  /** Whether this message had been seen by the requesting reader BEFORE
   *  this `inbox.get` call. The handler auto-marks-read on view, so the
   *  next call returns `read: true` for the same row. Used by the CLI
   *  to flag `[NEW]` on previously-unread replies. */
  read?: boolean;
}

interface InboxRowWithMessages extends InboxRow {
  messages?: DecisionMessageRow[];
}

function fmtAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

type InboxVote = "approve" | "deny" | "modify";

interface RespondArgs {
  id: string;
  vote: InboxVote;
  message?: string;
  payloadOverride?: Record<string, unknown>;
}

function validateVote(v: string): InboxVote {
  if (v !== "approve" && v !== "deny" && v !== "modify") {
    throw new Error("vote must be approve, deny, or modify");
  }
  return v;
}

function parseRespondArgs(rest: string[]): RespondArgs {
  const [id, vote, ...flags] = rest;
  if (!id || !vote) {
    throw new Error(
      'usage: olle inbox respond <id> approve|deny|modify [--message "..."] [--payload \'{json}\']',
    );
  }
  const v = validateVote(vote);
  let message: string | undefined;
  let payloadOverride: Record<string, unknown> | undefined;
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!;
    if (f === "--message" && flags[i + 1]) {
      message = flags[++i];
    } else if (f === "--payload" && flags[i + 1]) {
      payloadOverride = JSON.parse(flags[++i]!) as Record<string, unknown>;
    }
  }
  if (v === "modify" && !payloadOverride) {
    throw new Error("modify requires --payload '{json}'");
  }
  return { id, vote: v, message, payloadOverride };
}

// ───────────────────────────────────────────────────────────────────────
// Inbox CLI rendering — list + show. ANSI dressing on a TTY; plain on
// pipes. Visibility-first: unread badges on the listing, `[NEW]` markers
// on the show view (auto-marked-read by `inbox.get` after capture).
// ───────────────────────────────────────────────────────────────────────

const STATUS_GLYPH: Record<string, string> = {
  open: "●",
  approved: "✓",
  denied: "✗",
  modified: "±",
  stale: "·",
};

function statusGlyphColored(status: string, hasUnread: boolean): string {
  const glyph = STATUS_GLYPH[status] ?? " ";
  // Cyan for "has unread replies you should look at" — reads as
  // higher-priority than the open-yellow it overlays.
  if (hasUnread) return color(`${ANSI.bold}${ANSI.cyan}`, glyph);
  switch (status) {
    case "open":
      return color(ANSI.yellow, glyph);
    case "approved":
      return color(ANSI.green, glyph);
    case "denied":
      return color(ANSI.red, glyph);
    case "modified":
      return color(ANSI.cyan, glyph);
    case "stale":
      return color(ANSI.gray, glyph);
    default:
      return glyph;
  }
}

function tierColored(tier: string): string {
  switch (tier) {
    case "vision":
      return color(ANSI.magenta, tier);
    case "strategic":
      return color(ANSI.cyan, tier);
    case "operational":
      return color(ANSI.gray, tier);
    default:
      return tier;
  }
}

function renderInboxList(rows: InboxRow[]): void {
  const now = Date.now();
  const cols = termWidth();
  // Column widths chosen so the summary gets the lion's share. id+age+tier
  // are dense and scan-friendly; the summary is the headline.
  const idW = 10;
  const ageW = 5;
  const tierW = 18;
  const fixed = 1 /*glyph*/ + 1 /*stale*/ + 2 + idW + 2 + tierW + 2 + ageW + 2;
  const summaryW = Math.max(20, cols - fixed - 18 /*reserved for "(N new)" suffix*/);

  let totalUnread = 0;
  for (const r of rows) totalUnread += r.unreadReplyCount ?? 0;

  // Header line — quick orientation.
  const totalLine =
    `${rows.length} item${rows.length === 1 ? "" : "s"}` +
    (totalUnread > 0
      ? ` · ${color(ANSI.bold + ANSI.cyan, `${totalUnread} unread ${totalUnread === 1 ? "reply" : "replies"}`)}`
      : "");
  console.log(color(ANSI.dim, totalLine));
  console.log(color(ANSI.dim, "─".repeat(cols)));

  for (const r of rows) {
    const unread = r.unreadReplyCount ?? 0;
    const glyph = statusGlyphColored(r.status, unread > 0);
    const stale =
      r.status === "open" && r.staleness != null && r.staleness < now
        ? color(ANSI.red, "!")
        : " ";
    const age = fmtAge(now - r.createdAt);
    const id = color(ANSI.dim, r.id.slice(0, idW));
    const tag = r.status === "open" ? tierColored(r.tier) : `${tierColored(r.tier)}/${r.status}`;
    const fromTag = r.proposingAgentName
      ? color(ANSI.dim, `[${r.proposingAgentName}] `)
      : "";
    const summaryRaw = r.summary.replace(/\s+/g, " ");
    const summary = clipPlain(summaryRaw, summaryW);
    const unreadBadge =
      unread > 0
        ? " " + color(ANSI.bold + ANSI.cyan, `(${unread} new)`)
        : "";
    console.log(
      ` ${glyph}${stale} ${id}  ${padVisible(tag, tierW)}  ${age.padStart(ageW)}  ${fromTag}${summary}${unreadBadge}`,
    );
  }
}

function renderInboxShow(r: InboxRowWithMessages): void {
  const now = Date.now();
  const cols = termWidth();
  const rule = (label?: string): string => {
    const base = label ? `── ${label} ` : "";
    const fill = "─".repeat(Math.max(2, cols - vlen(base)));
    return color(ANSI.dim, base + fill);
  };

  // Title block.
  console.log(color(ANSI.bold, r.id));
  console.log(color(ANSI.dim, "═".repeat(cols)));
  console.log("");

  const kv = (label: string, value: string): void => {
    console.log(`  ${color(ANSI.dim, label.padEnd(10))}${value}`);
  };

  const statusValue = `${statusGlyphColored(r.status, false)} ${r.status}`;
  kv("status", statusValue);
  kv("tier", tierColored(r.tier));
  kv(
    "from",
    r.proposingAgentName
      ? `${r.proposingAgentName} ${color(ANSI.dim, `(${r.proposingAgentId.slice(0, 10)})`)}`
      : r.proposingAgentId,
  );
  kv(
    "to",
    r.principalDisplay
      ? `${r.principalDisplay} ${color(ANSI.dim, `(${r.principalId.slice(0, 10)})`)}`
      : r.principalId,
  );
  kv("age", fmtAge(now - r.createdAt));
  if (r.staleness != null) {
    const remaining = r.staleness - now;
    const dl =
      remaining > 0
        ? color(ANSI.yellow, `in ${fmtAge(remaining)}`)
        : color(ANSI.red, `${fmtAge(-remaining)} ago`);
    kv("stale", dl);
  }
  if (r.resolvedAt != null) {
    kv("resolved", color(ANSI.dim, new Date(r.resolvedAt).toISOString()));
  }
  console.log("");
  // Summary — wrapped, indented, given visual room.
  for (const line of wrap(r.summary, cols - 4)) {
    console.log(`  ${line}`);
  }

  console.log("");
  console.log(rule("payload"));
  const payloadStr = JSON.stringify(r.payload ?? {}, null, 2);
  for (const line of payloadStr.split("\n")) {
    console.log(`  ${line}`);
  }

  if (r.messages && r.messages.length > 0) {
    const newCount = r.messages.filter((m) => !m.read).length;
    const header =
      `replies (${r.messages.length})` +
      (newCount > 0
        ? `  · ${color(ANSI.bold + ANSI.cyan, `${newCount} new`)}`
        : "");
    console.log("");
    console.log(rule(header));
    for (const m of r.messages) {
      const when = formatTimestamp(m.at);
      const newTag = m.read ? "" : " " + color(ANSI.bold + ANSI.cyan, "[NEW]");
      const author = color(ANSI.bold, m.actorName ?? m.actorId);
      console.log("");
      console.log(`  · ${color(ANSI.dim, when)}  ${author}${newTag}`);
      for (const line of m.text.split("\n")) {
        for (const wrapped of wrap(line, cols - 6)) {
          console.log(`      ${wrapped}`);
        }
      }
    }
  }
  console.log("");
}

function formatTimestamp(at: number): string {
  const d = new Date(at);
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, "0");
  const D = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${Y}-${M}-${D} ${h}:${m}`;
}

function wrap(text: string, width: number): string[] {
  if (width < 10) width = 10;
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (line.length === 0) {
        line = word;
        continue;
      }
      if (line.length + 1 + word.length <= width) {
        line += " " + word;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line.length > 0) out.push(line);
  }
  return out;
}

function vlen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function clipPlain(s: string, width: number): string {
  if (vlen(s) <= width) return s;
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  return plain.slice(0, Math.max(0, width - 1)) + "…";
}

function padVisible(s: string, width: number): string {
  const n = vlen(s);
  if (n >= width) return clipPlain(s, width);
  return s + " ".repeat(width - n);
}

async function cmdInbox(args: string[]): Promise<void> {
  // Default form (`olle inbox` with no subcommand) drops into the
  // mutt-style TUI on a TTY. Pipes / scripts fall through to `list`
  // so existing automation keeps working.
  const ttyDefault = process.stdout.isTTY && process.stdin.isTTY;
  const [sub = ttyDefault ? "tui" : "list", ...rest] = args;
  const paths = resolvePaths();
  await withIpc(paths.socketFile, async (client) => {
    switch (sub) {
      case "tui": {
        if (!process.stdout.isTTY || !process.stdin.isTTY) {
          throw new Error("inbox tui requires a tty; use `olle inbox list` for non-tty");
        }
        const { runInboxTui } = await import("./inbox-tui.ts");
        await runInboxTui({ client });
        return;
      }
      case "list": {
        // Default filter is "active" (open OR has unread replies). Pass
        // --all for everything, --open for the strict status='open' subset.
        const all = rest.includes("--all");
        const open = rest.includes("--open");
        const status = all ? "all" : open ? "open" : undefined;
        const rows = await client.call<InboxRow[]>("inbox.list", { status });
        if (rows.length === 0) {
          console.log(
            all
              ? "(no inbox items)"
              : open
                ? "(no open decisions)"
                : "(inbox zero — nothing waiting for you)",
          );
          return;
        }
        renderInboxList(rows);
        return;
      }
      case "show": {
        const id = rest[0];
        if (!id) throw new Error("usage: olle inbox show <id>");
        const r = await client.call<InboxRowWithMessages>("inbox.get", { id });
        renderInboxShow(r);
        return;
      }
      case "respond": {
        const parsed = parseRespondArgs(rest);
        const updated = await client.call<InboxRow>("inbox.respond", { ...parsed });
        console.log(`${updated.id.slice(0, 10)} ${updated.status}`);
        return;
      }
      default:
        throw new Error(`unknown inbox subcommand: ${sub}`);
    }
  });
}

function printHelp(): void {
  console.log(
    [
      "olle — a world agents love to live in",
      "",
      "Usage: olle <command> [args]",
      "",
      "Commands:",
      "  run                         start foreground daemon",
      "  status                      show daemon status",
      "  daemon restart              SIGTERM the daemon and wait for the supervisor to bring it back",
      "  chat                        REPL connected to the default agent",
      "  tail [type]                 stream events (default: all)",
      "  publish <type> [json]       emit a durable event",
      "  extension list              list loaded extensions",
      "  extension reload <name>     hot-reload an extension",
      "  extension history <name>    show git history for an extension",
      "  extension revert <name> <sha>   checkout <sha> of an extension",
      "  starter list                list shipped starter templates",
      "  starter install <name>      copy a starter into ~/.olle/extensions/",
      "  secret list                 list secret names (values never shown)",
      "  secret set <NAME> [value]   store a secret (or pipe on stdin)",
      "  secret remove <NAME>        remove a stored secret",
      "",
      "  Inbox — async decisions awaiting your response (paired with mail_* tools):",
      "  inbox                                         interactive TUI (vim keys; ? for help)",
      "  inbox list [--all|--open]                     list active (default), all, or strictly-open",
      "  inbox show <id>                               full decision payload + agent reply thread",
      "  inbox respond <id> approve|deny|modify [--message ...] [--payload {json}]",
      "",
      "  Observability — same data agents see via their query_my_* tools:",
      "  stats [--agent X] [--thread X] [--since 1h]   token + USD rollup",
      "  cache [--agent X] [--thread X] [--since 1h]   cache hit ratio rollup",
      "  runs [--agent X] [--status X] [--since 1h]    recent task_runs",
      "  threads [--agent X] [--limit N]               threads per mailbox",
      "  events [--agent X] [--type T] [--thread X]    one-shot event query",
      "  inspect agent <id>                            agent identity surface",
      "",
      "  version                     show version",
      "  help                        show this help",
    ].join("\n"),
  );
}
