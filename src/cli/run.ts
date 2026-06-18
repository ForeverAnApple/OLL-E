import { readFileSync } from "node:fs";
import { startDaemon } from "../daemon/daemon.ts";
import { enrichPathFromLoginShell } from "../daemon/path-env.ts";
import { resolvePaths } from "../paths.ts";
import { connectIpc, type IpcClient } from "../ipc/client.ts";
import { connectOrExit, withIpc } from "./ipc-helper.ts";
import { ANSI } from "./theme.ts";
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
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(2);
  }
}

async function cmdModel(args: string[]): Promise<void> {
  // `olle model` → print the current default.
  // `olle model <name>` → set the default; daemon swaps live if up.
  const paths = resolvePaths();
  await withIpc(paths.socketFile, async (client) => {
    if (args.length === 0) {
      const r = await client.call<{ model: string }>("model.get");
      console.log(r.model || "(unset)");
      return;
    }
    const model = args.join(" ").trim();
    if (!model) throw new Error("usage: olle model [<model>]");
    const r = await client.call<{ model: string }>("model.set", { model });
    console.log(`default model → ${r.model}`);
  });
}

async function cmdRun(): Promise<void> {
  // launchd/systemd start the daemon with a stripped PATH. Pull the user's
  // real PATH from their login shell so the agent (and the subprocesses it
  // spawns) can find tools installed via Nix/Homebrew/asdf/etc. See path-env.ts.
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

    const now = Date.now();
    const sinceLabel = fmtAge(now - sinceMs);
    const heading = (s: string) => color(ANSI.accent, s);
    const label = (s: string) => color(ANSI.muted, s);
    const ok = (s: string) => color(ANSI.success, s);
    const warn = (s: string) => color(ANSI.warning, s);
    const err = (s: string) => color(ANSI.error, s);

    // ─── daemon ────────────────────────────────────────────────────────
    console.log(heading("daemon"));
    if (host) {
      console.log(`  ${label("host")}    ${host.hostId}`);
      console.log(`  ${label("pid")}     ${host.pid}`);
      console.log(`  ${label("uptime")}  ${fmtAge(host.uptimeMs)}`);
    } else {
      console.log(`  ${err("daemon unreachable")}`);
    }
    if (chat) {
      const chatLabel = chat.enabled
        ? ok("enabled")
        : `${err("disabled")}${chat.reason ? ` (${chat.reason})` : ""}`;
      console.log(`  ${label("chat")}    ${chatLabel}`);
    }
    if (self) {
      const named = self.displayName ? ` / ${self.displayName}` : "";
      console.log(`  ${label("agent")}   ${self.name}${named}  ${color(ANSI.muted, self.agentId)}`);
      // `tools` here is extension-registered tools only — core tools live in
      // memory and aren't in the agents row. Label it explicitly so the
      // count isn't read as "the agent has only N tools available".
      const principles = `${self.principleCount} ${self.principleCount === 1 ? "principle" : "principles"}`;
      const tools = `${self.tools.length} ext ${self.tools.length === 1 ? "tool" : "tools"}`;
      console.log(`  ${label("        ")}${principles}  ${tools}`);
      // The model the agent thinks in (its own choice, or the host default)
      // plus its reasoning effort when it's running thinking on.
      const modelTag = self.thinkingModelIsDefault ? color(ANSI.muted, " (default)") : "";
      const effortTag =
        self.reasoningEffort && self.reasoningEffort !== "off"
          ? `  ${color(ANSI.muted, `effort: ${self.reasoningEffort}`)}`
          : "";
      console.log(`  ${label("model")}   ${self.thinkingModel}${modelTag}${effortTag}`);
    }

    // ─── teams ─────────────────────────────────────────────────────────
    // Only render when this host is in at least one team. Solo users get
    // the un-cluttered dashboard; federated hosts get peer connectivity
    // surfaced up top where flapping links are easy to spot.
    if (teams.teams.length > 0) {
      console.log("");
      console.log(heading("teams"));
      for (const t of teams.teams) {
        const memberCount = t.members.length;
        const peerCount = t.peers.length;
        const connected = t.peers.filter((p) => p.status === "connected").length;
        const stale = t.peers.filter((p) => p.status === "stale").length;
        const disconnected = t.peers.filter(
          (p) => p.status === "disconnected" || p.status === "connecting" || p.status === "rejected",
        ).length;
        const left = t.peers.filter((p) => p.status === "left").length;
        const peerSummary: string[] = [];
        if (connected > 0) peerSummary.push(ok(`${connected} connected`));
        if (stale > 0) peerSummary.push(warn(`${stale} stale`));
        if (disconnected > 0) peerSummary.push(err(`${disconnected} disconnected`));
        if (left > 0) peerSummary.push(label(`${left} left`));
        const peersTxt =
          peerCount === 0 ? label("(no peers yet)") : peerSummary.join("  ");
        console.log(
          `  ${t.name}  ${color(ANSI.muted, t.teamId.slice(0, 10))}  ${memberCount} ${memberCount === 1 ? "member" : "members"}  ${peersTxt}`,
        );
        for (const p of t.peers.slice(0, 5)) {
          const statusFmt =
            p.status === "connected"
              ? ok(p.status)
              : p.status === "stale"
                ? warn(p.status)
                : p.status === "left"
                  ? label(p.status)
                  : err(p.status);
          const hb =
            p.lastHeartbeatAt != null
              ? color(ANSI.muted, `hb=${fmtAge(now - p.lastHeartbeatAt)}`)
              : color(ANSI.muted, "hb=—");
          console.log(
            `    ${color(ANSI.muted, p.peerHostId.slice(0, 10))}  ${statusFmt.padEnd(20)}  ${color(ANSI.muted, p.addr)}  ${hb}`,
          );
        }
      }
    }

    // ─── inbox ─────────────────────────────────────────────────────────
    const open = inbox.filter((d) => d.status === "open").length;
    const unreadReplies = inbox.reduce((n, d) => n + (d.unreadReplyCount ?? 0), 0);
    const stale = inbox.filter(
      (d) => d.status === "open" && d.staleness != null && d.staleness < now,
    ).length;
    console.log("");
    console.log(heading("inbox"));
    if (inbox.length === 0) {
      console.log(`  ${label("(empty)")}`);
    } else {
      const openTxt = open > 0 ? warn(`${open}`) : `${open}`;
      console.log(`  ${label("open")}        ${openTxt} actionable`);
      if (unreadReplies > 0) {
        console.log(`  ${label("replies")}     ${warn(`${unreadReplies}`)} unread`);
      }
      if (stale > 0) {
        console.log(`  ${label("stale")}       ${err(`${stale}`)} past deadline`);
      }
      // Show the top 3 actionable items as a peek.
      const actionable = inbox
        .filter((d) => d.status === "open" || (d.unreadReplyCount ?? 0) > 0)
        .slice(0, 3);
      if (actionable.length > 0) {
        console.log(`  ${label("recent:")}`);
        for (const d of actionable) {
          const age = fmtAge(now - d.createdAt);
          const summary = d.summary.length > 60 ? `${d.summary.slice(0, 57)}...` : d.summary;
          console.log(
            `    ${color(ANSI.muted, d.id.slice(0, 10))}  ${d.tier.padEnd(10)}  ${summary}  ${color(ANSI.muted, age)}`,
          );
        }
      }
    }

    // ─── usage ─────────────────────────────────────────────────────────
    console.log("");
    console.log(`${heading("usage")}  ${color(ANSI.muted, `(last ${sinceLabel})`)}`);
    if (!usage || usage.rows === 0) {
      console.log(`  ${label("(no ledger activity)")}`);
    } else {
      const t = usage.totals;
      const calls = usage.byModel.reduce((n, m) => n + m.calls, 0);
      console.log(
        `  ${label("tokens")}      in=${formatTokens(t.inputTokens)} out=${formatTokens(t.outputTokens)} cache_r=${formatTokens(t.cacheReadTokens)} cache_w=${formatTokens(t.cacheCreationTokens)}`,
      );
      const callsTxt = `${calls} ${calls === 1 ? "call" : "calls"}`;
      console.log(
        `  ${label("cost")}        ${fmtUsd(t.usdMicros)}  ${color(ANSI.muted, `(${callsTxt}, cache hit ${fmtPct(t.cacheHitRatio)})`)}`,
      );
      if (usage.byModel.length > 0) {
        const top = usage.byModel[0]!;
        const tag = top.pricePosted ? "" : color(ANSI.warning, " (fallback price)");
        const topCalls = `${top.calls} ${top.calls === 1 ? "call" : "calls"}`;
        console.log(
          `  ${label("top model")}   ${top.provider}/${top.model}  ${fmtUsd(top.usdMicros)}  ${color(ANSI.muted, `(${topCalls})`)}${tag}`,
        );
      }
    }

    // ─── runs ──────────────────────────────────────────────────────────
    console.log("");
    console.log(`${heading("runs")}  ${color(ANSI.muted, `(last ${sinceLabel})`)}`);
    if (runs.length === 0) {
      console.log(`  ${label("(no task runs)")}`);
    } else {
      const counts: Record<string, number> = {};
      for (const r of runs) counts[r.status] = (counts[r.status] ?? 0) + 1;
      const succeeded = counts.succeeded ?? 0;
      const failed = counts.failed ?? 0;
      const running = counts.running ?? 0;
      const lost = counts.lost ?? 0;
      const queued = counts.queued ?? 0;
      const parts: string[] = [];
      parts.push(`${ok(`✓${succeeded}`)}`);
      if (failed > 0) parts.push(err(`✗${failed}`));
      if (running > 0) parts.push(color(ANSI.info, `⏵${running}`));
      if (queued > 0) parts.push(color(ANSI.muted, `⏸${queued}`));
      if (lost > 0) parts.push(warn(`?${lost}`));
      console.log(`  ${parts.join("  ")}  ${color(ANSI.muted, `(${runs.length} total)`)}`);
    }

    // ─── threads ───────────────────────────────────────────────────────
    console.log("");
    console.log(heading("threads"));
    if (threads.length === 0) {
      console.log(`  ${label("(no threads)")}`);
    } else {
      const oneHourAgo = now - 3_600_000;
      const recentlyActive = threads.filter((t) => t.lastEventAt >= oneHourAgo).length;
      console.log(
        `  ${label("active")}      ${recentlyActive} ${color(ANSI.muted, `in last hour (of ${threads.length} recent)`)}`,
      );
      // Lead with the conversation's opening line — what a human recognizes
      // the thread by — then its current context size (the last turn's prompt
      // tokens = how much information is in the conversation now) and age.
      for (const t of threads.slice(0, 5)) {
        const age = fmtAge(now - t.lastEventAt);
        const size =
          t.contextTokens > 0
            ? `${formatTokens(t.contextTokens)} tokens`
            : label("(no turns yet)");
        console.log(
          `    ${threadSnippet(t.firstUserText).padEnd(40)} ${color(ANSI.muted, `${size} · ${age}`)}`,
        );
      }
    }

    // ─── extensions ────────────────────────────────────────────────────
    console.log("");
    console.log(heading("extensions"));
    if (exts.length === 0) {
      console.log(`  ${label("(none on disk)")}`);
    } else {
      const registered = exts.filter((e) => e.status === "registered").length;
      const broken = exts.filter((e) => e.status === "broken");
      const unregistered = exts.filter((e) => e.status === "unregistered").length;
      const parts: string[] = [];
      parts.push(`${ok(`${registered}`)} registered`);
      if (broken.length > 0) parts.push(`${err(`${broken.length}`)} broken`);
      if (unregistered > 0) parts.push(`${warn(`${unregistered}`)} unregistered`);
      console.log(`  ${parts.join("  ")}`);
      for (const b of broken) {
        const why = b.error ? `  ${color(ANSI.muted, b.error)}` : "";
        console.log(`    ${err("✗")} ${b.name}${why}`);
      }
    }
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

async function cmdTeam(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const paths = resolvePaths();
  await withIpc(paths.socketFile, async (client) => {
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
        console.log(`Created team "${name}" (${r.teamId}).`);
        console.log(`Use 'olle team invite ${r.teamId}' to add peers.`);
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
        console.log(r.code);
        console.log(`(invite ${r.inviteId} — share the code above out-of-band)`);
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
        console.log(`Joined team ${r.teamId} via peer ${r.peerHostId}.`);
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
        console.log(`Left team ${r.teamId}.`);
        return;
      }
      case undefined:
      case "status": {
        const r = await client.call<{
          teams: Array<{
            teamId: string;
            name: string;
            members: Array<{ actorId: string; role: string }>;
            peers: Array<{
              peerHostId: string;
              status: string;
              addr: string;
              lastHeartbeatAt: number | null;
            }>;
          }>;
        }>("team.status");
        if (r.teams.length === 0) {
          console.log("(no teams)");
          return;
        }
        for (const t of r.teams) {
          console.log(`${t.name}  ${t.teamId}`);
          console.log(`  members: ${t.members.map((m) => `${m.actorId} (${m.role})`).join(", ") || "(none)"}`);
          if (t.peers.length === 0) {
            console.log(`  peers:   (none)`);
          } else {
            for (const p of t.peers) {
              const hb =
                p.lastHeartbeatAt != null
                  ? new Date(p.lastHeartbeatAt).toISOString()
                  : "-";
              console.log(`  peer ${p.peerHostId}  ${p.status}  ${p.addr}  hb=${hb}`);
            }
          }
        }
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
  // Skip styling when stdout is piped — keeps output clean.
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
    if (self.displayName) console.log(`called: ${self.displayName}`);
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

function fmtAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/** The opening line of a thread's conversation, normalized for the status
 *  dashboard — what a human recognizes the thread by, in place of an opaque id. */
function threadSnippet(firstUserText: string | null): string {
  const raw = (firstUserText ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "(no messages yet)";
  return raw.length > 38 ? `${raw.slice(0, 37)}…` : raw;
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
    r.ownerDisplay
      ? `${r.ownerDisplay} ${color(ANSI.dim, `(${r.ownerAgentId.slice(0, 10)})`)}`
      : r.ownerAgentId,
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
      "  status [--since 24h]        dashboard: daemon, agent, inbox, usage, runs, extensions",
      "  daemon restart              SIGTERM the daemon and wait for the supervisor to bring it back",
      "  chat                        Ink-based REPL connected to the default agent",
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
      "  model [<name>]              show or set the default LLM model (claude-opus-4-7, gpt-5.5, …)",
      "",
      "  Teams — cell-to-cell federation (paired with team_* tools):",
      "  team status                                   list teams, members, and connected peers",
      "  team create <name>                            mint a new team rooted on this host",
      "  team invite <teamId> [--ttl <ms>]             issue a bearer code peers can redeem",
      "  team join <code>                              accept a bearer code from a peer",
      "  team leave <teamId>                           drop out of a team",
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
