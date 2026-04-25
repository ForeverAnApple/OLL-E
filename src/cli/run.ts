import { startDaemon } from "../daemon/daemon.ts";
import { resolvePaths } from "../paths.ts";
import { connectIpc } from "../ipc/client.ts";
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
  const client = await connectIpc(paths.socketFile).catch((e) => {
    console.error(`olle: daemon not reachable (${e.message})`);
    process.exit(1);
  });
  const value = await client.call<{ hostId: string; pid: number; uptimeMs: number }>("status");
  client.close();
  console.log(
    `host: ${value.hostId}\npid:  ${value.pid}\nup:   ${Math.round(value.uptimeMs / 1000)}s`,
  );
}

async function cmdTail(args: string[]): Promise<void> {
  const type = args[0] ?? "*";
  const paths = resolvePaths();
  const client = await connectIpc(paths.socketFile);
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
  const payload = rest.length ? JSON.parse(rest.join(" ")) : {};
  const paths = resolvePaths();
  const client = await connectIpc(paths.socketFile);
  const res = await client.call<{ id: string; hlc: string }>("publish", {
    type,
    payload,
    actorId: "cli",
    durable: true,
  });
  client.close();
  console.log(`${res.hlc} ${res.id}`);
}

async function cmdExtension(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const paths = resolvePaths();
  const client = await connectIpc(paths.socketFile);
  try {
    switch (sub) {
      case undefined:
      case "list": {
        const list = await client.call<
          Array<{ name: string; version: string; status: string; failures: number }>
        >("extensions.list");
        if (list.length === 0) {
          console.log("(no extensions loaded)");
          return;
        }
        for (const e of list) {
          console.log(`${e.name}@${e.version}  ${e.status}  fail=${e.failures}`);
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
  } finally {
    client.close();
  }
}

async function cmdStarter(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const paths = resolvePaths();
  const client = await connectIpc(paths.socketFile);
  try {
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
  } finally {
    client.close();
  }
}

async function cmdSecret(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const paths = resolvePaths();
  const client = await connectIpc(paths.socketFile);
  try {
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
  } finally {
    client.close();
  }
}

async function cmdChat(): Promise<void> {
  const paths = resolvePaths();
  const client = await connectIpc(paths.socketFile);
  // Fetch the root agent's id so we can address events to its mailbox.
  // Falls back to "root" only as a last resort — ids are ULID so the
  // lookup is cheap and authoritative.
  const { rootAgentId } = await client.call<{ rootAgentId: string }>("status.rootAgent");
  const threadId = `cli:${Math.random().toString(36).slice(2, 10)}`;
  const sub = client.stream("tail", { type: "*" });

  const ui = createChatUI({ agentId: rootAgentId, threadId });
  ui.banner();

  let turnBusy = false;
  let prompt = () => undefined as void;

  (async () => {
    for await (const ev of sub.events) {
      if (ev.threadId !== threadId) continue;
      const p = ev.payload as Record<string, unknown>;
      if (ev.type === "chat.assistant-delta") {
        ui.assistantDelta(String(p.text ?? ""));
      } else if (ev.type === "chat.assistant-text") {
        // Authoritative full text arrives after the deltas finish. We've
        // already streamed it; just close the assistant block so the next
        // tool/turn-end lands cleanly.
        ui.assistantClose();
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
        });
        turnBusy = false;
        prompt();
      } else if (ev.type === "chat.error") {
        ui.error(String(p.error ?? ""));
        turnBusy = false;
        prompt();
      }
    }
  })();

  const stop = async () => {
    await sub.cancel();
    client.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);

  const rl = (await import("node:readline")).createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  prompt = () => {
    if (turnBusy) return;
    rl.setPrompt(ui.promptString());
    rl.prompt();
  };
  prompt();
  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) {
      prompt();
      return;
    }
    if (text === "/exit" || text === "/quit") {
      await stop();
      return;
    }
    turnBusy = true;
    ui.afterUserInput();
    await client.call("publish", {
      type: "chat.input",
      payload: { text },
      actorId: "cli",
      durable: true,
      toAgentId: rootAgentId,
      threadId,
    });
  });
  rl.on("close", stop);
}

function numFrom(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

// ───────────────────────────────────────────────────────────────────────
// Chat UI — light ANSI dressing for `olle chat`. No TUI framework, no
// alternate screen; just a vocabulary of styled lines so the agent's
// turn structure is legible. Inspiration taken from pi-mono's interactive
// mode (role headers, dim tool execution, footer status line) without
// pulling in the framework that drives them.
// ───────────────────────────────────────────────────────────────────────

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function color(code: string, s: string): string {
  // Skip styling when stdout is piped — keeps `olle chat | tee` clean.
  if (!process.stdout.isTTY) return s;
  return `${code}${s}${ANSI.reset}`;
}

function termWidth(): number {
  const w = process.stdout.columns;
  return w && w > 20 ? w : 80;
}

function shortAgent(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-3)}` : id;
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

function summarizeInput(input: unknown): string {
  let s: string;
  try {
    s = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  const max = Math.max(20, termWidth() - 16);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
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

interface ChatUIOpts {
  agentId: string;
  threadId: string;
}

function createChatUI(opts: ChatUIOpts) {
  const out = process.stdout;
  // Track open assistant block so consecutive deltas/chunks land under
  // one "◆ olle" header instead of restamping it each time. Also tracks
  // whether the last byte we wrote ended on a newline — important for
  // streaming deltas, which can arrive mid-line and need a leading "  "
  // indent only at the start of a fresh line.
  let assistantOpen = false;
  let atLineStart = true;

  function ensureAssistantHeader(): void {
    if (assistantOpen) return;
    out.write(color(`${ANSI.bold}${ANSI.cyan}`, "◆ olle") + "\n");
    out.write("  "); // first-line indent
    assistantOpen = true;
    atLineStart = false;
  }

  function closeAssistant(): void {
    if (!assistantOpen) return;
    if (!atLineStart) out.write("\n");
    assistantOpen = false;
    atLineStart = true;
    out.write("\n");
  }

  function padLine(s: string, w: number): string {
    return s + " ".repeat(Math.max(0, w - visibleLen(s)));
  }

  return {
    banner(): void {
      const w = Math.min(72, termWidth());
      const inner = w - 2;
      const top = color(ANSI.cyan, `╭${"─".repeat(inner)}╮`);
      const bot = color(ANSI.cyan, `╰${"─".repeat(inner)}╯`);
      const side = color(ANSI.cyan, "│");
      const title = `${ANSI.bold}olle chat${ANSI.reset}`;
      const meta = `${color(ANSI.dim, "agent")} ${shortAgent(opts.agentId)}  ${color(ANSI.dim, "thread")} ${opts.threadId}`;
      const hint = color(ANSI.dim, "/exit to quit · Ctrl-C to interrupt");
      const row = (s: string) => `${side} ${padLine(s, inner - 2)} ${side}\n`;
      out.write(`${top}\n`);
      out.write(row(title));
      out.write(row(meta));
      out.write(row(hint));
      out.write(`${bot}\n\n`);
    },

    promptString(): string {
      return color(`${ANSI.bold}${ANSI.cyan}`, "❯ ");
    },

    /** Called right after the user submits a line. Readline already
     *  echoed the input next to the prompt, so we just drop a separator
     *  before the assistant block lands. */
    afterUserInput(): void {
      out.write("\n");
    },

    /** Stream a chunk of assistant text. Maintains a running "is the
     *  cursor at the start of a fresh line?" so we only emit the "  "
     *  indent at line breaks — important when the model emits a single
     *  word at a time. */
    assistantDelta(text: string): void {
      if (!text) return;
      ensureAssistantHeader();
      // Walk the chunk char-by-char on newlines so multi-line deltas
      // get re-indented; everything else writes through unchanged.
      const parts = text.split("\n");
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        if (atLineStart && part.length > 0) {
          out.write("  ");
          atLineStart = false;
        }
        if (part.length > 0) out.write(part);
        if (i < parts.length - 1) {
          out.write("\n");
          atLineStart = true;
        }
      }
    },

    /** Called when the authoritative chat.assistant-text arrives — the
     *  stream is done, flush any trailing newline + visual gap. */
    assistantClose(): void {
      closeAssistant();
    },

    toolCall(name: string, input: unknown): void {
      closeAssistant();
      const head = color(ANSI.gray, "  ⏵ ");
      const body = color(ANSI.dim, `${name}(${summarizeInput(input)})`);
      out.write(`${head}${body}\n`);
    },

    toolResult(content: string, isError: boolean): void {
      closeAssistant();
      const c = isError ? ANSI.red : ANSI.gray;
      const bodyColor = isError ? ANSI.red : ANSI.dim;
      const head = color(c, "  ⏷ ");
      const body = color(bodyColor, summarizeResult(content) || "(empty)");
      out.write(`${head}${body}\n`);
    },

    retry(info: { attempt: number; status?: number; waitMs: number; message?: string }): void {
      closeAssistant();
      const waitS = (info.waitMs / 1000).toFixed(1);
      const statusStr = info.status ? ` HTTP ${info.status}` : "";
      const reason =
        info.status === 529 || info.status === 503
          ? "API overloaded"
          : info.status === 429
            ? "rate limited"
            : "API hiccup";
      const line = `  ⟳ ${reason}${statusStr} — retrying in ${waitS}s (attempt ${info.attempt + 1})`;
      out.write(color(ANSI.yellow, line) + "\n");
    },

    error(msg: string): void {
      closeAssistant();
      out.write(color(ANSI.red, `  ⚠ ${msg}`) + "\n\n");
    },

    turnEnd(stats: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      usdMicros: number;
      stopReason: string;
    }): void {
      closeAssistant();
      const parts: string[] = [];
      if (stats.inputTokens) parts.push(`↑${formatTokens(stats.inputTokens)}`);
      if (stats.outputTokens) parts.push(`↓${formatTokens(stats.outputTokens)}`);
      if (stats.cacheReadTokens) parts.push(`R${formatTokens(stats.cacheReadTokens)}`);
      if (stats.cacheCreationTokens) parts.push(`W${formatTokens(stats.cacheCreationTokens)}`);
      if (stats.usdMicros) parts.push(formatUsd(stats.usdMicros));
      if (stats.stopReason && stats.stopReason !== "end_turn") parts.push(stats.stopReason);
      const inner = parts.length ? `  ${parts.join("  ")}  ` : "  · ";
      const w = termWidth();
      const tail = "─".repeat(Math.max(2, w - inner.length - 2));
      out.write(color(ANSI.dim, `─${inner}${tail}`) + "\n");
    },
  };
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

async function cmdStats(args: string[]): Promise<void> {
  const flags = parseObsFlags(args);
  const paths = resolvePaths();
  const client = await connectIpc(paths.socketFile);
  try {
    const stats = await client.call<UsageStats>("observability.usage", {
      actorId: flags.agent,
      threadId: flags.thread,
      since: flags.since,
    });
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
    // Budget side, same call shape if --agent given.
    if (flags.agent) {
      const b = await client.call<BudgetStatus>("observability.budget", {
        actorId: flags.agent,
      });
      if (b.rows.length > 0) {
        console.log("budget:");
        for (const r of b.rows) {
          const cap = r.capUsd != null ? fmtUsd(r.capUsd) : "-";
          const pct = r.percentUsd != null ? fmtPct(r.percentUsd) : "-";
          console.log(`  ${r.period}: ${fmtUsd(r.spentUsd)} / ${cap}  (${pct})`);
        }
      }
    }
  } finally {
    client.close();
  }
}

async function cmdCache(args: string[]): Promise<void> {
  // Cache-focused rollup — just the cache columns + hit ratio.
  const flags = parseObsFlags(args);
  const paths = resolvePaths();
  const client = await connectIpc(paths.socketFile);
  try {
    const stats = await client.call<UsageStats>("observability.usage", {
      actorId: flags.agent,
      threadId: flags.thread,
      since: flags.since,
    });
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
  } finally {
    client.close();
  }
}

async function cmdRuns(args: string[]): Promise<void> {
  const flags = parseObsFlags(args);
  let status: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--status" && args[i + 1]) {
      status = args[++i];
    }
  }
  const paths = resolvePaths();
  const client = await connectIpc(paths.socketFile);
  try {
    const runs = await client.call<RunHistoryRow[]>("observability.runs", {
      actorId: flags.agent,
      status,
      since: flags.since,
      limit: flags.limit,
    });
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
  } finally {
    client.close();
  }
}

async function cmdThreads(args: string[]): Promise<void> {
  const flags = parseObsFlags(args);
  const paths = resolvePaths();
  const client = await connectIpc(paths.socketFile);
  try {
    const threads = await client.call<ThreadInventoryRow[]>("observability.threads", {
      toAgentId: flags.agent,
      limit: flags.limit,
    });
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
  } finally {
    client.close();
  }
}

async function cmdEvents(args: string[]): Promise<void> {
  // Single-shot event-log query (the streaming variant is `olle tail`).
  const flags = parseObsFlags(args);
  let type: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--type" && args[i + 1]) {
      type = args[++i];
    }
  }
  const paths = resolvePaths();
  const client = await connectIpc(paths.socketFile);
  try {
    const events = await client.call<RecentEventRow[]>("observability.events", {
      actorId: flags.agent,
      type,
      threadId: flags.thread,
      since: flags.since,
      limit: flags.limit,
    });
    if (events.length === 0) {
      console.log("(no events)");
      return;
    }
    for (const e of events) {
      console.log(`${e.hlc} ${e.type} actor=${e.actorId} payload=${JSON.stringify(e.payload)}`);
    }
  } finally {
    client.close();
  }
}

async function cmdInspect(args: string[]): Promise<void> {
  const [sub, target] = args;
  if (sub !== "agent" || !target) {
    throw new Error("usage: olle inspect agent <agent-id>");
  }
  const paths = resolvePaths();
  const client = await connectIpc(paths.socketFile);
  try {
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
  } finally {
    client.close();
  }
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
