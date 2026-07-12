import { readFileSync } from "node:fs";
import { startDaemon } from "../daemon/daemon.ts";
import { MCP_BRIDGE_SUBCOMMAND } from "../mcp/contract.ts";
import { cmdMcpBridge } from "./mcp-bridge.ts";
import { enrichPathFromLoginShell } from "../daemon/path-env.ts";
import { resolvePaths } from "../paths.ts";
import { connectIpc } from "../ipc/client.ts";
import { connectOrExit, withIpc } from "./ipc-helper.ts";
import { ANSI } from "./theme.ts";
import { renderStats } from "./stats-render.ts";
import { renderCache, renderRuns, renderThreads, renderEvents, renderEventLine } from "./obs-render.ts";
import {
  renderExtensionList,
  renderExtensionHistory,
  renderExtensionReloadAck,
  renderExtensionRevertAck,
  renderStarterList,
  renderStarterInstallAck,
  renderSecretList,
  renderSecretRemoveAck,
  renderSecretSetAck,
} from "./entity-render.ts";
import {
  renderTeamStatus,
  renderTeamCreateAck,
  renderTeamInviteAck,
  renderTeamJoinAck,
  renderTeamLeaveAck,
  renderBudgetShow,
  renderBudgetSet,
  renderModelGet,
  renderModelSet,
  renderPublishAck,
  type TeamStatusData,
} from "./team-render.ts";
import { renderStatus, renderInspectAgent } from "./status-render.ts";
import { renderInboxList, renderInboxShow } from "./inbox-render.ts";
import { makeColorer } from "./render.ts";
import type {
  AgentSelf,
  BudgetStatus,
  RecentEventRow,
  RunHistoryRow,
  TeamRoster,
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
      await cmdStatus(rest);
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
    case "team":
    case "teams":
      await cmdTeam(rest);
      return;
    case "model":
      await cmdModel(rest);
      return;
    case "budget":
      await cmdBudget(rest);
      return;
    case MCP_BRIDGE_SUBCOMMAND:
      await cmdMcpBridge(rest);
      return;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(2);
  }
}

interface BudgetSetResult {
  agentId: string | null;
  period: string;
  capUsdMicros: number | null;
  capTokens: number | null;
  spentUsdMicros: number;
  spentTokens: number;
  created: boolean;
}

function parseBudgetFlags(args: string[]): { agent?: string; usd?: string; tokens?: string } {
  const out: { agent?: string; usd?: string; tokens?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--agent" && args[i + 1]) out.agent = args[++i];
    else if (a === "--usd" && args[i + 1]) out.usd = args[++i];
    else if (a === "--tokens" && args[i + 1]) out.tokens = args[++i];
  }
  return out;
}

async function cmdBudget(args: string[]): Promise<void> {
  // `olle budget show [--agent X]` → cap + spend for the agent (default root).
  // `olle budget set --usd N [--tokens N] [--agent X]` → arm/adjust the cap.
  //   USD is whole dollars (fractions ok: --usd 12.50); "none" clears a cap.
  const sub = args[0];
  const paths = resolvePaths();
  await withIpc(paths.socketFile, async (client) => {
    const opts = renderOpts();
    if (sub === "set") {
      const flags = parseBudgetFlags(args.slice(1));
      const params: Record<string, unknown> = {};
      if (flags.agent) params.agentId = flags.agent;
      if (flags.usd !== undefined) {
        params.capUsdMicros =
          flags.usd === "none" ? null : Math.round(Number(flags.usd) * 1_000_000);
        if (params.capUsdMicros !== null && !Number.isFinite(params.capUsdMicros as number)) {
          throw new Error(`--usd must be a number or "none", got "${flags.usd}"`);
        }
      }
      if (flags.tokens !== undefined) {
        params.capTokens = flags.tokens === "none" ? null : Number(flags.tokens);
        if (params.capTokens !== null && !Number.isFinite(params.capTokens as number)) {
          throw new Error(`--tokens must be a number or "none", got "${flags.tokens}"`);
        }
      }
      if (params.capUsdMicros === undefined && params.capTokens === undefined) {
        throw new Error("usage: olle budget set --usd <dollars|none> [--tokens <n|none>] [--agent <id>]");
      }
      const r = await client.call<BudgetSetResult>("budget.set", params);
      console.log(renderBudgetSet(r, opts));
      return;
    }
    if (sub === "show" || sub === undefined) {
      const flags = parseBudgetFlags(args.slice(1));
      const agentId =
        flags.agent ??
        (await client.call<{ rootAgentId: string }>("status.rootAgent")).rootAgentId;
      const b = await client.call<BudgetStatus>("observability.budget", { actorId: agentId });
      console.log(renderBudgetShow(b, { ...opts, agent: flags.agent ?? agentId }));
      return;
    }
    throw new Error(`unknown budget subcommand "${sub}" — use show|set`);
  });
}

async function cmdModel(args: string[]): Promise<void> {
  // `olle model` → print the current default.
  // `olle model <name>` → set the default; daemon swaps live if up.
  const paths = resolvePaths();
  await withIpc(paths.socketFile, async (client) => {
    const opts = renderOpts();
    if (args.length === 0) {
      const r = await client.call<{ model: string }>("model.get");
      console.log(renderModelGet({ model: r.model }, opts));
      return;
    }
    const model = args.join(" ").trim();
    if (!model) throw new Error("usage: olle model [<model>]");
    const r = await client.call<{ model: string }>("model.set", { model });
    console.log(renderModelSet(r, opts));
  });
}

async function cmdRun(): Promise<void> {
  // launchd/systemd start the daemon with a stripped PATH. Pull the user's real
  // PATH from their login shell and fix process.env.PATH, so anything resolving
  // in-process (query_host_context's resolver, agent reasoning over the reported
  // PATH) sees the real one. NOTE: this does NOT reach child processes — a
  // compiled Bun binary spawns children with the *exec-time* env, not later
  // process.env mutations (LOG 2026-06-17). Subprocess extensions therefore rely
  // on the PATH baked into the launchd/systemd service definition by install.sh;
  // this runtime pass is the in-process half (and the rescue for `olle run` from
  // a stripped shell). See path-env.ts.
  const enriched = enrichPathFromLoginShell();
  if (enriched.changed) {
    console.log(`olle: PATH enriched from login shell (+${enriched.added.length} dirs)`);
  } else if (!enriched.probed) {
    // The probe failed (no login shell, timeout, or a shell that didn't honor
    // -lc). Don't fail boot, but say so — otherwise "claude not on PATH" later
    // looks like the tool is missing rather than the daemon being blind to it.
    console.warn("olle: could not read login-shell PATH; tools installed outside the service PATH may be invisible to the agent");
  }
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

async function cmdStatus(args: string[]): Promise<void> {
  // Dashboard: composes the same observability/inbox/extension IPC calls
  // an agent reaches through its tool surface — no privileged human read
  // path (AGENTS.md vision-check). Default window is 7d; --since lets a
  // human ask the same question over a different slice.
  const sinceArg = parseFlagValue(args, "--since");
  const sinceMs = sinceArg ? parseSinceArg(sinceArg) : Date.now() - 7 * 86_400_000;
  const paths = resolvePaths();
  await withIpc(paths.socketFile, async (client) => {
    // All independent reads in flight at once. Each tolerates failure so
    // an older daemon (or one mid-startup) still produces a partial view
    // rather than crashing the dashboard.
    const [host, chat, rootAgent, exts, usage, runs, threads, inbox, teams] =
      await Promise.all([
        client
          .call<{ hostId: string; pid: number; uptimeMs: number }>("status")
          .catch(() => null),
        client
          .call<{ enabled: boolean; reason: string | null }>("status.chat")
          .catch(() => null),
        client
          .call<{ rootAgentId: string }>("status.rootAgent")
          .catch(() => null),
        client
          .call<
            Array<{
              name: string;
              status: "registered" | "unregistered" | "broken";
              error?: string;
            }>
          >("extensions.list")
          .catch(() => [] as Array<{ name: string; status: string; error?: string }>),
        client
          .call<UsageStats>("observability.usage", { since: sinceMs })
          .catch(() => null),
        client
          .call<RunHistoryRow[]>("observability.runs", { since: sinceMs, limit: 200 })
          .catch(() => [] as RunHistoryRow[]),
        client
          .call<ThreadInventoryRow[]>("observability.threads", { limit: 10 })
          .catch(() => [] as ThreadInventoryRow[]),
        client
          .call<InboxRow[]>("inbox.list")
          .catch(() => [] as InboxRow[]),
        client
          .call<TeamRoster>("observability.teams")
          .catch(() => ({ teams: [] }) as TeamRoster),
      ]);

    const self = rootAgent
      ? await client
          .call<AgentSelf | null>("observability.self", { agentId: rootAgent.rootAgentId })
          .catch(() => null)
      : null;

    const width = process.stdout.columns ?? 80;
    const color = process.stdout.isTTY === true && process.env.NO_COLOR == null;
    console.log(
      renderStatus(
        { host, chat, rootAgent, self, exts, usage, runs, threads, inbox, teams, sinceMs },
        { width, color },
      ),
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
  const tailWidth = process.stdout.columns ?? 80;
  const tailC = makeColorer(Boolean(process.stdout.isTTY) && process.env.NO_COLOR == null);
  for await (const ev of sub.events) {
    console.log(renderEventLine(tailC, ev, tailWidth));
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
    console.log(renderPublishAck(res, renderOpts()));
  });
}

async function cmdExtension(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const paths = resolvePaths();
  await withIpc(paths.socketFile, async (client) => {
    const width = process.stdout.columns ?? 80;
    const color = Boolean(process.stdout.isTTY) && process.env.NO_COLOR == null;
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
        console.log(renderExtensionList(list, { width, color }));
        return;
      }
      case "reload": {
        const name = rest[0];
        if (!name) throw new Error("usage: olle extension reload <name>");
        const r = await client.call<{ name: string; status: string }>("extensions.reload", { name });
        console.log(renderExtensionReloadAck(r, { color }));
        return;
      }
      case "history": {
        const name = rest[0];
        if (!name) throw new Error("usage: olle extension history <name>");
        const rows = await client.call<
          Array<{ sha: string; author: string; date: number; subject: string }>
        >("extensions.history", { name });
        console.log(renderExtensionHistory(rows, { width, color, name }));
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
        console.log(renderExtensionRevertAck(r, { color }));
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
    const width = process.stdout.columns ?? 80;
    const color = Boolean(process.stdout.isTTY) && process.env.NO_COLOR == null;
    switch (sub) {
      case undefined:
      case "list": {
        const list = await client.call<Array<{ name: string; description: string }>>("starters.list");
        console.log(renderStarterList(list, { width, color }));
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
        console.log(renderStarterInstallAck(r, { color }));
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
    const width = process.stdout.columns ?? 80;
    const color = Boolean(process.stdout.isTTY) && process.env.NO_COLOR == null;
    switch (sub) {
      case undefined:
      case "list": {
        const list = await client.call<
          Array<{ name: string; size: number; updatedAt: number }>
        >("secrets.list");
        console.log(renderSecretList(list, { width, color }));
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
        console.log(renderSecretSetAck(r, { color }));
        return;
      }
      case "remove":
      case "rm": {
        const name = rest[0];
        if (!name) throw new Error("usage: olle secret remove <NAME>");
        await client.call("secrets.remove", { name });
        console.log(renderSecretRemoveAck({ name }, { color }));
        return;
      }
      default:
        throw new Error(`unknown secret subcommand: ${sub}`);
    }
  });
}

async function cmdTeam(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const paths = resolvePaths();
  await withIpc(paths.socketFile, async (client) => {
    const opts = renderOpts();
    switch (sub) {
      case "create": {
        const name = rest.join(" ").trim();
        if (!name) throw new Error("usage: olle team create <name>");
        const r = await client.call<{
          ok: boolean;
          teamId?: string;
          error?: string;
        }>("team.create", { name });
        if (!r.ok) throw new Error(`team create failed: ${r.error ?? "unknown"}`);
        console.log(renderTeamCreateAck({ teamId: r.teamId!, name }, opts));
        return;
      }
      case "invite": {
        const teamId = rest[0];
        if (!teamId) throw new Error("usage: olle team invite <teamId> [--ttl <ms>]");
        const ttlRaw = parseFlagValue(rest.slice(1), "--ttl");
        const ttlMs = ttlRaw ? Number.parseInt(ttlRaw, 10) : undefined;
        if (ttlRaw && (!Number.isFinite(ttlMs!) || ttlMs! < 0)) {
          throw new Error(`--ttl must be a non-negative integer (ms), got ${ttlRaw}`);
        }
        const params: Record<string, unknown> = { teamId };
        if (ttlMs !== undefined) params.ttlMs = ttlMs;
        const r = await client.call<{
          ok: boolean;
          code?: string;
          inviteId?: string;
          error?: string;
        }>("team.invite", params);
        if (!r.ok) throw new Error(`team invite failed: ${r.error ?? "unknown"}`);
        console.log(renderTeamInviteAck({ code: r.code!, inviteId: r.inviteId! }, opts));
        return;
      }
      case "join": {
        const code = rest[0];
        if (!code) throw new Error("usage: olle team join <code>");
        const r = await client.call<{
          ok: boolean;
          teamId?: string;
          peerHostId?: string;
          error?: string;
        }>("team.join", { code });
        if (!r.ok) throw new Error(`team join failed: ${r.error ?? "unknown"}`);
        console.log(renderTeamJoinAck({ teamId: r.teamId!, peerHostId: r.peerHostId! }, opts));
        return;
      }
      case "leave": {
        const teamId = rest[0];
        if (!teamId) throw new Error("usage: olle team leave <teamId>");
        const r = await client.call<{ ok: boolean; teamId?: string; error?: string }>(
          "team.leave",
          { teamId },
        );
        if (!r.ok) throw new Error(`team leave failed: ${r.error ?? "unknown"}`);
        console.log(renderTeamLeaveAck({ teamId: r.teamId! }, opts));
        return;
      }
      case undefined:
      case "status": {
        const r = await client.call<TeamStatusData>("team.status");
        console.log(renderTeamStatus(r, opts));
        return;
      }
      default:
        throw new Error(`unknown team subcommand: ${sub}`);
    }
  });
}

async function cmdChat(): Promise<void> {
  // Lazy import keeps Ink/React off the cold CLI path.
  const { runInkChat } = await import("./chat-ink/render.tsx");
  await runInkChat();
}

function color(code: string, s: string): string {
  // Skip styling when stdout is piped or NO_COLOR is set (any value, per
  // no-color.org — `!= null` so NO_COLOR= still disables) — keeps output clean.
  if (!process.stdout.isTTY || process.env.NO_COLOR != null) return s;
  return `${code}${s}${ANSI.reset}`;
}

function termWidth(): number {
  const w = process.stdout.columns;
  return w && w > 20 ? w : 80;
}

/** Render opts shared by every restyled command: live terminal width and a
 *  single color gate (TTY and NO_COLOR unset). Renderers take {width,color}
 *  as data, so this is computed once per command and passed straight in. */
function renderOpts(): { width: number; color: boolean } {
  return {
    width: process.stdout.columns ?? 80,
    color: Boolean(process.stdout.isTTY) && process.env.NO_COLOR == null,
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

function parseFlagValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) return args[i + 1];
  }
  return undefined;
}

async function cmdStats(args: string[]): Promise<void> {
  // One IPC pull for usage, a second for budget when --agent is set, then a
  // single render — the pretty layout weaves budget into the same receipt,
  // so we can't print usage before the budget call returns.
  const flags = parseObsFlags(args);
  const paths = resolvePaths();
  await withIpc(paths.socketFile, async (client) => {
    const stats = await client.call<UsageStats>("observability.usage", {
      actorId: flags.agent,
      threadId: flags.thread,
      since: flags.since,
    });
    const budget = flags.agent
      ? await client.call<BudgetStatus>("observability.budget", { actorId: flags.agent })
      : undefined;
    console.log(
      renderStats(stats, budget, {
        width: process.stdout.columns ?? 80,
        color: Boolean(process.stdout.isTTY) && process.env.NO_COLOR == null,
        agent: flags.agent,
      }),
    );
  });
}

async function cmdCache(args: string[]): Promise<void> {
  const flags = parseObsFlags(args);
  const paths = resolvePaths();
  await withIpc(paths.socketFile, async (client) => {
    const stats = await client.call<UsageStats>("observability.usage", {
      actorId: flags.agent, threadId: flags.thread, since: flags.since,
    });
    console.log(renderCache(stats, {
      width: process.stdout.columns ?? 80,
      color: Boolean(process.stdout.isTTY) && process.env.NO_COLOR == null,
      agent: flags.agent, since: flags.since,
    }));
  });
}

async function cmdRuns(args: string[]): Promise<void> {
  const flags = parseObsFlags(args);
  const paths = resolvePaths();
  await withIpc(paths.socketFile, async (client) => {
    const runs = await client.call<RunHistoryRow[]>("observability.runs", {
      actorId: flags.agent, status: parseFlagValue(args, "--status"),
      since: flags.since, limit: flags.limit,
    });
    console.log(renderRuns(runs, {
      width: process.stdout.columns ?? 80,
      color: Boolean(process.stdout.isTTY) && process.env.NO_COLOR == null,
      agent: flags.agent, since: flags.since,
    }));
  });
}

async function cmdThreads(args: string[]): Promise<void> {
  const flags = parseObsFlags(args);
  const paths = resolvePaths();
  await withIpc(paths.socketFile, async (client) => {
    const threads = await client.call<ThreadInventoryRow[]>("observability.threads", {
      toAgentId: flags.agent, limit: flags.limit,
    });
    console.log(renderThreads(threads, {
      width: process.stdout.columns ?? 80,
      color: Boolean(process.stdout.isTTY) && process.env.NO_COLOR == null,
      agent: flags.agent,
    }));
  });
}

async function cmdEvents(args: string[]): Promise<void> {
  const flags = parseObsFlags(args);
  const paths = resolvePaths();
  await withIpc(paths.socketFile, async (client) => {
    const events = await client.call<RecentEventRow[]>("observability.events", {
      actorId: flags.agent, type: parseFlagValue(args, "--type"),
      threadId: flags.thread, since: flags.since, limit: flags.limit,
    });
    console.log(renderEvents(events, {
      width: process.stdout.columns ?? 80,
      color: Boolean(process.stdout.isTTY) && process.env.NO_COLOR == null,
      agent: flags.agent, since: flags.since,
    }));
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
    const width = process.stdout.columns ?? 80;
    const color = process.stdout.isTTY === true && process.env.NO_COLOR == null;
    console.log(renderInspectAgent(self, { width, color }));
  });
}

interface InboxRow {
  id: string;
  ownerAgentId: string;
  proposingAgentId: string;
  proposingAgentName?: string;
  ownerDisplay?: string;
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

// `olle inbox` list/show rendering lives in inbox-render.ts (the shared
// design-system module); cmdInbox below calls it. See inbox-render.ts.

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
        const filter = all ? "all" : open ? "open" : "active";
        const rows = await client.call<InboxRow[]>("inbox.list", { status });
        // renderInboxList carries its own humane empty state (keyed on the
        // filter) — no bare "(none)" branch here.
        console.log(renderInboxList(rows, { ...renderOpts(), filter }));
        return;
      }
      case "show": {
        const id = rest[0];
        if (!id) throw new Error("usage: olle inbox show <id>");
        const r = await client.call<InboxRowWithMessages>("inbox.get", { id });
        console.log(renderInboxShow(r, renderOpts()));
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
  const C = makeColorer(Boolean(process.stdout.isTTY) && process.env.NO_COLOR == null);
  const out: string[] = [];

  // A titled block of `cmd → description` rows. The command column is sized
  // per block to its widest command *that carries a description* (rows with
  // no description, e.g. the long `inbox respond` form, print alone and don't
  // inflate the column). Command in text, description muted; dim heading.
  const block = (title: string | null, rows: Array<[string, string?]>): void => {
    if (title) {
      out.push("");
      out.push(C(ANSI.dim, title));
    }
    const withDesc = rows.filter(([, d]) => d != null);
    const col = withDesc.length
      ? Math.max(...withDesc.map(([c]) => c.length)) + 2
      : 2;
    for (const [cmd, desc] of rows) {
      if (!desc) {
        out.push("  " + C(ANSI.text, cmd));
        continue;
      }
      const pad = " ".repeat(Math.max(2, col - cmd.length));
      out.push("  " + C(ANSI.text, cmd) + pad + C(ANSI.muted, desc));
    }
  };

  out.push(C(ANSI.text, "olle") + C(ANSI.muted, " — a world agents love to live in"));
  out.push("");
  out.push(C(ANSI.dim, "Usage: ") + C(ANSI.text, "olle <command> [args]"));

  block("commands", [
    ["run", "start foreground daemon"],
    ["status [--since 24h]", "dashboard: daemon, agent, inbox, usage, runs, extensions"],
    ["daemon restart", "SIGTERM the daemon and wait for the supervisor to bring it back"],
    ["chat", "Ink-based REPL connected to the default agent"],
    ["tail [type]", "stream events (default: all)"],
    ["publish <type> [json]", "emit a durable event"],
    ["extension list", "list loaded extensions"],
    ["extension reload <name>", "hot-reload an extension"],
    ["extension history <name>", "show git history for an extension"],
    ["extension revert <name> <sha>", "checkout <sha> of an extension"],
    ["starter list", "list shipped starter templates"],
    ["starter install <name>", "copy a starter into ~/.olle/extensions/"],
    ["secret list", "list secret names (values never shown)"],
    ["secret set <NAME> [value]", "store a secret (or pipe on stdin)"],
    ["secret remove <NAME>", "remove a stored secret"],
    ["model [<name>]", "show or set the default LLM model (claude-opus-4-7, gpt-5.5, …)"],
  ]);

  block("Teams — cell-to-cell federation (paired with team_* tools):", [
    ["team status", "list teams, members, and connected peers"],
    ["team create <name>", "mint a new team rooted on this host"],
    ["team invite <teamId> [--ttl <ms>]", "issue a bearer code peers can redeem"],
    ["team join <code>", "accept a bearer code from a peer"],
    ["team leave <teamId>", "drop out of a team"],
  ]);

  block("Inbox — async decisions awaiting your response (paired with mail_* tools):", [
    ["inbox", "interactive TUI (vim keys; ? for help)"],
    ["inbox list [--all|--open]", "list active (default), all, or strictly-open"],
    ["inbox show <id>", "full decision payload + agent reply thread"],
    ["inbox respond <id> approve|deny|modify [--message ...] [--payload {json}]"],
  ]);

  block("Observability — same data agents see via their query_my_* tools:", [
    ["stats [--agent X] [--thread X] [--since 1h]", "token + USD rollup"],
    ["cache [--agent X] [--thread X] [--since 1h]", "cache hit ratio rollup"],
    ["runs [--agent X] [--status X] [--since 1h]", "recent task_runs"],
    ["threads [--agent X] [--limit N]", "threads per mailbox"],
    ["events [--agent X] [--type T] [--thread X]", "one-shot event query"],
    ["inspect agent <id>", "agent identity surface"],
  ]);

  out.push("");
  block(null, [
    ["version", "show version"],
    ["help", "show this help"],
  ]);

  console.log(out.join("\n"));
}
