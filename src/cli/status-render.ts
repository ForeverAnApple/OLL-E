// Pure renderers for `olle status` (the dashboard) and `olle inspect agent`
// (the identity card). Same visual language as stats-render.ts — the shared
// primitives live in render.ts, this module holds only the layout for these
// two surfaces. No IO, no daemon, no process access: cmdStatus / cmdInspect
// fetch over IPC, compute width/color from the live terminal, and print what
// these return. Purity keeps the whole dashboard testable without a daemon.
//
// Rendering technique — plain-pad-then-color: every aligned cell is built as
// a PLAIN string, widths/padding computed on those plain strings, and ONLY
// THEN wrapped in color(). See render.ts for the full note.

import { ANSI } from "./theme.ts";
import {
  bar,
  clip,
  fmtAge,
  fmtUsdSmart,
  formatTokens,
  heading,
  headerLine,
  hiColor,
  intComma,
  kv,
  makeColorer,
  shortId,
  table,
  wrap,
  type Colorer,
} from "./render.ts";
import type {
  AgentSelf,
  RunHistoryRow,
  TeamRoster,
  ThreadInventoryRow,
  UsageStats,
} from "../observability/index.ts";

// --- input shapes ---------------------------------------------------------
// Structurally identical to what cmdStatus gathers over IPC. Kept local (not
// imported from run.ts) so this module stays leaf-level and independently
// testable.

export interface StatusHost {
  hostId: string;
  pid: number;
  uptimeMs: number;
}

export interface StatusChat {
  enabled: boolean;
  reason: string | null;
}

export interface StatusExt {
  name: string;
  status: string; // "registered" | "unregistered" | "broken"
  error?: string;
}

export interface StatusInboxRow {
  id: string;
  tier: string;
  summary: string;
  status: string;
  staleness: number | null;
  createdAt: number;
  unreadReplyCount?: number;
}

/** The full bag cmdStatus assembles. Every section is independently
 *  nullable/empty so a partial IPC failure renders an "unreachable" or empty
 *  line rather than throwing. */
export interface StatusData {
  host: StatusHost | null;
  chat: StatusChat | null;
  rootAgent: { rootAgentId: string } | null;
  self: AgentSelf | null;
  exts: StatusExt[];
  usage: UsageStats | null;
  runs: RunHistoryRow[];
  threads: ThreadInventoryRow[];
  inbox: StatusInboxRow[];
  teams: TeamRoster;
  /** Lower bound of the usage/runs window (ms since epoch). */
  sinceMs: number;
}

export interface StatusRenderOpts {
  width: number;
  color: boolean;
  /** Overridable clock so age/window labels are deterministic in tests. */
  now?: number;
}

// -------------------------------------------------------------------------

export function renderStatus(data: StatusData, opts: StatusRenderOpts): string {
  const C = makeColorer(opts.color);
  const now = opts.now ?? Date.now();
  const { width } = opts;
  const sinceLabel = fmtAge(now - data.sinceMs);
  const out: string[] = [];

  const meta = data.host
    ? `last ${sinceLabel} · host ${shortId(data.host.hostId)}`
    : `last ${sinceLabel} · daemon down`;
  out.push(headerLine(C, "olle status", meta, width));
  out.push("");

  renderDaemon(out, C, data, now);
  if (data.teams.teams.length > 0) renderTeams(out, C, data.teams, now, width);
  renderInbox(out, C, data.inbox, now, width);
  renderUsage(out, C, data.usage, sinceLabel, width);
  renderRuns(out, C, data.runs, sinceLabel);
  renderThreads(out, C, data.threads, now, width);
  renderExtensions(out, C, data.exts, width);

  // Drop the trailing blank the last section pushed.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/** Push a humane empty line (a full sentence, never "(none)"), plus an
 *  optional follow-up command line, both at `indent`. */
function pushEmpty(
  out: string[],
  C: Colorer,
  indent: string,
  sentence: string,
  cmd?: string,
): void {
  out.push(indent + C(ANSI.text, sentence));
  if (cmd) out.push(indent + C(ANSI.muted, "Try ") + C(ANSI.text, cmd));
}

function renderDaemon(out: string[], C: Colorer, data: StatusData, now: number): void {
  out.push(heading(C, "daemon"));
  if (!data.host) {
    pushEmpty(out, C, "  ", "Daemon not reachable.", "olle run");
    out.push("");
    return;
  }
  out.push("  " + kv(C, "host", C(ANSI.muted, shortId(data.host.hostId))));
  out.push("  " + kv(C, "pid", C(ANSI.text, String(data.host.pid))));
  out.push("  " + kv(C, "uptime", C(ANSI.text, fmtAge(data.host.uptimeMs))));

  if (data.chat) {
    const chatVal = data.chat.enabled
      ? C(ANSI.success, "enabled")
      : C(ANSI.error, "disabled") +
        (data.chat.reason ? C(ANSI.muted, ` (${data.chat.reason})`) : "");
    out.push("  " + kv(C, "chat", chatVal));
  }

  const self = data.self;
  if (self) {
    const named = self.displayName ? C(ANSI.muted, ` / ${self.displayName}`) : "";
    out.push(
      "  " +
        kv(
          C,
          "agent",
          C(ANSI.text, self.name) + named + "  " + C(ANSI.muted, shortId(self.agentId)),
        ),
    );
    const principles = `${self.principleCount} ${self.principleCount === 1 ? "principle" : "principles"}`;
    const tools = `${self.tools.length} ext ${self.tools.length === 1 ? "tool" : "tools"}`;
    out.push("  " + " ".repeat(8) + C(ANSI.muted, `${principles} · ${tools}`));

    const dflt = self.thinkingModelIsDefault ? C(ANSI.muted, " (default)") : "";
    const effort =
      self.reasoningEffort && self.reasoningEffort !== "off"
        ? "   " + C(ANSI.muted, `effort: ${self.reasoningEffort}`)
        : "";
    out.push("  " + kv(C, "model", C(ANSI.text, self.thinkingModel) + dflt + effort));
  }
  out.push("");
}

function renderTeams(
  out: string[],
  C: Colorer,
  teams: TeamRoster,
  now: number,
  width: number,
): void {
  out.push(heading(C, "teams"));
  for (const t of teams.teams) {
    const members = `${t.members.length} ${t.members.length === 1 ? "member" : "members"}`;
    const connected = t.peers.filter((p) => p.status === "connected").length;
    const stale = t.peers.filter((p) => p.status === "stale").length;
    const down = t.peers.filter(
      (p) => p.status === "disconnected" || p.status === "connecting" || p.status === "rejected",
    ).length;
    const summary: string[] = [];
    const summaryPlain: string[] = [];
    if (connected > 0) {
      summary.push(C(ANSI.success, `${connected} connected`));
      summaryPlain.push(`${connected} connected`);
    }
    if (stale > 0) {
      summary.push(C(ANSI.warning, `${stale} stale`));
      summaryPlain.push(`${stale} stale`);
    }
    if (down > 0) {
      summary.push(C(ANSI.error, `${down} down`));
      summaryPlain.push(`${down} down`);
    }
    const peersTxt =
      t.peers.length === 0 ? C(ANSI.muted, "no peers yet") : summary.join("  ");
    const peersPlain = t.peers.length === 0 ? "no peers yet" : summaryPlain.join("  ");
    // id + members always fit; the peer summary is the variable part — drop it
    // to its own indented line rather than overflow a narrow terminal.
    const headPlainLen = 2 + t.name.length + 2 + shortId(t.teamId).length + 2 + members.length;
    const head =
      "  " +
      C(ANSI.text, t.name) +
      "  " +
      C(ANSI.muted, shortId(t.teamId)) +
      "  " +
      C(ANSI.muted, members);
    if (headPlainLen + 2 + peersPlain.length <= width) {
      out.push(head + "  " + peersTxt);
    } else {
      out.push(head);
      out.push("    " + peersTxt);
    }
    if (t.peers.length > 0) {
      const rows = table(
        C,
        t.peers.slice(0, 5),
        [
          { cell: (p) => shortId(p.peerHostId), color: ANSI.muted },
          { cell: (p) => p.status, color: (p) => peerStatusColor(p.status) },
          { cell: (p) => p.addr, color: ANSI.muted, flex: true, min: 12 },
          {
            cell: (p) =>
              p.lastHeartbeatAt != null ? `hb ${fmtAge(now - p.lastHeartbeatAt)}` : "hb —",
            color: ANSI.muted,
          },
        ],
        { width, indent: "    " },
      );
      out.push(...rows);
    }
  }
  out.push("");
}

function peerStatusColor(status: string): string {
  if (status === "connected") return ANSI.success;
  if (status === "stale") return ANSI.warning;
  if (status === "left") return ANSI.muted;
  return ANSI.error;
}

function renderInbox(
  out: string[],
  C: Colorer,
  inbox: StatusInboxRow[],
  now: number,
  width: number,
): void {
  out.push(heading(C, "inbox"));
  if (inbox.length === 0) {
    pushEmpty(out, C, "  ", "No decisions waiting.");
    out.push("");
    return;
  }

  const open = inbox.filter((d) => d.status === "open").length;
  const replies = inbox.reduce((n, d) => n + (d.unreadReplyCount ?? 0), 0);
  const stale = inbox.filter(
    (d) => d.status === "open" && d.staleness != null && d.staleness < now,
  ).length;

  out.push(
    "  " +
      kv(C, "open", C(open > 0 ? ANSI.warning : ANSI.text, String(open)) + C(ANSI.muted, " actionable"), 9),
  );
  if (replies > 0) {
    out.push("  " + kv(C, "replies", C(ANSI.warning, String(replies)) + C(ANSI.muted, " unread"), 9));
  }
  if (stale > 0) {
    out.push("  " + kv(C, "stale", C(ANSI.error, String(stale)) + C(ANSI.muted, " past deadline"), 9));
  }

  const actionable = inbox
    .filter((d) => d.status === "open" || (d.unreadReplyCount ?? 0) > 0)
    .slice(0, 3);
  if (actionable.length > 0) {
    out.push("  " + C(ANSI.muted, "recent"));
    const rows = table(
      C,
      actionable,
      [
        { cell: (d) => shortId(d.id), color: ANSI.muted },
        { cell: (d) => d.tier, color: ANSI.muted },
        { cell: (d) => d.summary.replace(/\s+/g, " ").trim(), color: ANSI.text, flex: true, min: 20 },
        { cell: (d) => fmtAge(now - d.createdAt), color: ANSI.muted, align: "right" },
      ],
      { width, indent: "    " },
    );
    out.push(...rows);
  }
  out.push("");
}

function renderUsage(
  out: string[],
  C: Colorer,
  usage: UsageStats | null,
  sinceLabel: string,
  width: number,
): void {
  out.push(heading(C, "usage", `last ${sinceLabel}`));
  if (!usage || usage.rows === 0) {
    pushEmpty(out, C, "  ", `No token spend in the last ${sinceLabel}.`, "olle chat");
    out.push("");
    return;
  }
  const t = usage.totals;
  out.push("  " + kv(C, "Spend", C(ANSI.bold + ANSI.primary, fmtUsdSmart(t.usdMicros))));
  out.push(
    "  " +
      kv(
        C,
        "Tokens",
        C(ANSI.text, formatTokens(t.totalTokens)) +
          C(ANSI.muted, " total   ·   in ") +
          C(ANSI.text, formatTokens(t.inputTokens)) +
          C(ANSI.muted, "  out ") +
          C(ANSI.text, formatTokens(t.outputTokens)),
      ),
  );
  // Cache line only when caching actually happened — a flat "0% hit" on a
  // no-cache provider reads as broken.
  if (t.cacheReadTokens + t.cacheCreationTokens > 0) {
    const ratio = t.cacheHitRatio;
    const barW = Math.min(16, Math.max(8, width - 40));
    const b = bar(ratio, barW);
    out.push(
      "  " +
        kv(
          C,
          "Cache",
          C(ANSI.bold + hiColor(ratio), `${Math.round(ratio * 100)}%`) +
            " hit  " +
            C(hiColor(ratio), b.filled) +
            C(ANSI.border, b.empty),
        ),
    );
  }
  out.push("");
}

function renderRuns(
  out: string[],
  C: Colorer,
  runs: RunHistoryRow[],
  sinceLabel: string,
): void {
  out.push(heading(C, "runs", `last ${sinceLabel}`));
  if (runs.length === 0) {
    pushEmpty(out, C, "  ", `No task runs in the last ${sinceLabel}.`);
    out.push("");
    return;
  }
  const n: Record<string, number> = {};
  for (const r of runs) n[r.status] = (n[r.status] ?? 0) + 1;
  const parts: string[] = [];
  parts.push(C(ANSI.success, `✓ ${n.succeeded ?? 0}`));
  if ((n.failed ?? 0) > 0) parts.push(C(ANSI.error, `✗ ${n.failed}`));
  if ((n.running ?? 0) > 0) parts.push(C(ANSI.info, `⏵ ${n.running}`));
  if ((n.queued ?? 0) > 0) parts.push(C(ANSI.muted, `⏸ ${n.queued}`));
  if ((n.lost ?? 0) > 0) parts.push(C(ANSI.warning, `? ${n.lost}`));
  out.push(
    "  " + parts.join("   ") + "   " + C(ANSI.muted, `(${intComma(runs.length)} total)`),
  );
  out.push("");
}

function renderThreads(
  out: string[],
  C: Colorer,
  threads: ThreadInventoryRow[],
  now: number,
  width: number,
): void {
  out.push(heading(C, "threads"));
  if (threads.length === 0) {
    pushEmpty(out, C, "  ", "No conversations yet.", "olle chat");
    out.push("");
    return;
  }
  const active = threads.filter((t) => t.lastEventAt >= now - 3_600_000).length;
  out.push(
    "  " +
      C(ANSI.text, String(active)) +
      C(ANSI.muted, ` active in the last hour, of ${threads.length} recent`),
  );
  const rows = table(
    C,
    threads.slice(0, 5),
    [
      { cell: (t) => threadSnippet(t.firstUserText), color: ANSI.text, flex: true, min: 20 },
      {
        cell: (t) => {
          const size = t.contextTokens > 0 ? `${formatTokens(t.contextTokens)} tokens` : "no turns yet";
          return `${size} · ${fmtAge(now - t.lastEventAt)}`;
        },
        color: ANSI.muted,
        align: "right",
      },
    ],
    { width, indent: "  " },
  );
  out.push(...rows);
  out.push("");
}

function threadSnippet(firstUserText: string | null): string {
  const raw = (firstUserText ?? "").replace(/\s+/g, " ").trim();
  return raw || "(no messages yet)";
}

function renderExtensions(out: string[], C: Colorer, exts: StatusExt[], width: number): void {
  out.push(heading(C, "extensions"));
  if (exts.length === 0) {
    pushEmpty(out, C, "  ", "No extensions installed.");
    out.push("");
    return;
  }
  const registered = exts.filter((e) => e.status === "registered").length;
  const broken = exts.filter((e) => e.status === "broken");
  const unregistered = exts.filter((e) => e.status === "unregistered").length;
  const parts: string[] = [C(ANSI.success, `${registered} registered`)];
  if (broken.length > 0) parts.push(C(ANSI.error, `${broken.length} broken`));
  if (unregistered > 0) parts.push(C(ANSI.warning, `${unregistered} unregistered`));
  out.push("  " + parts.join(C(ANSI.muted, "   ·   ")));
  for (const b of broken) {
    // "    ✗ " (6) + name + "  " (2) is the fixed prefix; clip the error to
    // whatever's left so a long crash message never overflows the terminal.
    const room = width - 6 - b.name.length - 2;
    const why = b.error && room > 4 ? "  " + C(ANSI.muted, clip(b.error, room)) : "";
    out.push("    " + C(ANSI.error, "✗") + " " + C(ANSI.text, b.name) + why);
  }
  out.push("");
}

// === inspect agent — the identity card ===================================

export interface InspectRenderOpts {
  width: number;
  color: boolean;
}

export function renderInspectAgent(self: AgentSelf, opts: InspectRenderOpts): string {
  const C = makeColorer(opts.color);
  const { width } = opts;
  const out: string[] = [];

  // Headline: the name is the identity, so it leads bold — not the dim
  // command-name treatment the dashboards use.
  const display = self.displayName ? C(ANSI.muted, ` / ${self.displayName}`) : "";
  out.push(C(ANSI.bold + ANSI.text, self.name) + display);
  out.push("");

  const LW = 12; // widest label ("principles") + gap
  out.push(kv(C, "id", C(ANSI.muted, self.agentId), LW));
  out.push(kv(C, "host", C(ANSI.muted, shortId(self.hostId)), LW));
  out.push(
    kv(C, "parent", self.parentAgentId ? C(ANSI.muted, shortId(self.parentAgentId)) : C(ANSI.muted, "(none)"), LW),
  );

  const tiers = self.scope.allowTiers?.length
    ? self.scope.allowTiers.join(", ")
    : "operational";
  out.push(kv(C, "scope", C(ANSI.text, tiers), LW));
  out.push(kv(C, "principles", C(ANSI.text, String(self.principleCount)), LW));

  const dflt = self.thinkingModelIsDefault ? C(ANSI.muted, " (default)") : "";
  const effort =
    self.reasoningEffort && self.reasoningEffort !== "off"
      ? "   " + C(ANSI.muted, `effort: ${self.reasoningEffort}`)
      : "";
  out.push(kv(C, "model", C(ANSI.text, self.thinkingModel) + dflt + effort, LW));

  // Ext tools as a wrapped muted list under the "tools" label; continuation
  // lines indent to the value column so the block reads as one field.
  if (self.tools.length > 0) {
    const list = self.tools.map((t) => t.name).join(", ");
    const lines = wrap(list, Math.max(20, width - LW));
    out.push(kv(C, "tools", C(ANSI.muted, lines[0]!), LW));
    for (const cont of lines.slice(1)) {
      out.push(" ".repeat(LW) + C(ANSI.muted, cont));
    }
  }

  // Recent models, one per line, with the same trailing "~" fallback marker
  // stats uses for a model priced at a fallback rate.
  if (self.recentlyPricedModels.length > 0) {
    out.push("");
    out.push(heading(C, "recent models"));
    for (const m of self.recentlyPricedModels) {
      const name = `${m.provider}/${m.model}`;
      const mark = m.pricePosted ? "" : C(ANSI.warning, " ~");
      out.push("  " + C(ANSI.text, name) + mark);
    }
    if (self.recentlyPricedModels.some((m) => !m.pricePosted)) {
      out.push("  " + C(ANSI.muted, "~ estimated at a fallback rate — no posted price"));
    }
  }

  // System prompt LAST, under a dim rule, PLAIN — it's the agent's prose and
  // colorizing it would lie about its content. Wrapped so every line fits.
  if (self.systemPrompt) {
    out.push("");
    out.push(C(ANSI.dim, "─".repeat(width)));
    for (const line of wrap(self.systemPrompt, width)) out.push(line);
  }

  return out.join("\n");
}
