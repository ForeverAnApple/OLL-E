// Mutt-style TUI for `olle inbox` — alt-screen, raw stdin, vim + common
// hotkeys. Strictly a human-facing read/respond surface; the agent's
// parallel surface (`mail_*` tools) is unaffected (AGENTS.md: every CLI
// command has a parallel core tool — never a privileged human dashboard).
//
// Layout (top to bottom):
//   header bar            — title + filter (open/all) + counts
//   list pane             — one row per decision, scrollable
//   separator             — single rule
//   preview pane          — selected decision detail + payload (scrollable)
//   status / command bar  — hints, messages, or active prompt
//
// Modes: "normal" | "search" | "command" | "prompt" | "help"
//   normal   — j/k/g/G nav; a/d/m act; / search; : command; ? help; q quit
//   search   — type-ahead filter; Enter commits; ESC cancels
//   command  — `:command` line at bottom (e.g. :q, :refresh, :all, :open)
//   prompt   — capturing message/payload for an action; ESC cancels
//   help     — full-screen help overlay
//
// Vim keys: j k h l g G Ctrl-d Ctrl-u Ctrl-f Ctrl-b 0 $ /  n N : ? q gg
// Common keys: ↑ ↓ ← → PgUp PgDn Home End Enter Tab Esc Backspace

import type { IpcClient } from "../ipc/client.ts";

const ESC = "\x1b";
const CSI = `${ESC}[`;

const ANSI = {
  reset: `${CSI}0m`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  inv: `${CSI}7m`,
  red: `${CSI}31m`,
  green: `${CSI}32m`,
  yellow: `${CSI}33m`,
  blue: `${CSI}34m`,
  magenta: `${CSI}35m`,
  cyan: `${CSI}36m`,
  gray: `${CSI}90m`,
};

const ALT_ON = `${CSI}?1049h`;
const ALT_OFF = `${CSI}?1049l`;
const CURSOR_HIDE = `${CSI}?25l`;
const CURSOR_SHOW = `${CSI}?25h`;
const CLEAR = `${CSI}2J`;
const HOME = `${CSI}H`;

interface InboxRow {
  id: string;
  principalId: string;
  proposingAgentId: string;
  /** Display name for `proposingAgentId`, resolved server-side. Falls
   *  back to the id when the agent row is missing. */
  proposingAgentName?: string;
  /** Display name for `principalId`. */
  principalDisplay?: string;
  tier: string;
  summary: string;
  payload: Record<string, unknown>;
  status: string;
  staleness: number | null;
  createdAt: number;
  resolvedAt: number | null;
  /** Per-decision unread reply count for the principal — emitted by
   *  `inbox.list`. Drives the "(N new)" badge in the row. */
  unreadReplyCount?: number;
}

interface DecisionMessageRow {
  id: string;
  decisionId: string;
  actorId: string;
  /** Display name for `actorId`, resolved server-side. */
  actorName?: string;
  text: string;
  at: number;
  /** Whether this message had been seen by the principal BEFORE the
   *  current `inbox.get` call returned. (The handler auto-marks-read
   *  at the same time it captures this state.) */
  read?: boolean;
}

export interface InboxTuiOptions {
  client: IpcClient;
}

type Mode = "normal" | "search" | "command" | "prompt" | "help" | "detail";

interface Pending {
  /** "approve" | "deny" | "modify" — vote being collected. */
  vote: "approve" | "deny" | "modify";
  /** Already-collected message (modify always; approve/deny optional). */
  message: string;
  /** Free-form payload string for modify. */
  payload?: string;
  /** Which prompt step we're on. */
  step: "message" | "payload";
}

function fmtAge(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

const STATUS_GLYPHS: Record<string, string> = {
  open: `${ANSI.yellow}●${ANSI.reset}`,
  approved: `${ANSI.green}✓${ANSI.reset}`,
  denied: `${ANSI.red}✗${ANSI.reset}`,
  modified: `${ANSI.cyan}±${ANSI.reset}`,
  stale: `${ANSI.gray}·${ANSI.reset}`,
};

function statusGlyph(status: string): string {
  return STATUS_GLYPHS[status] ?? " ";
}

const TIER_COLORS: Record<string, string> = {
  vision: ANSI.magenta,
  strategic: ANSI.cyan,
  operational: ANSI.gray,
};

function tierColor(tier: string): string {
  return TIER_COLORS[tier] ?? "";
}

/** Visible width, ignoring ANSI sequences. Single-byte assumption is OK
 *  for our content (latin + ASCII glyphs); we don't render CJK. */
function vlen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function pad(s: string, width: number): string {
  const n = vlen(s);
  if (n >= width) return clip(s, width);
  return s + " ".repeat(width - n);
}

function clip(s: string, width: number): string {
  if (vlen(s) <= width) return s;
  // Strip ANSI before clipping to avoid cutting mid-sequence; cheap & safe
  // for our short summaries.
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  return plain.slice(0, Math.max(0, width - 1)) + "…";
}

export async function runInboxTui(opts: InboxTuiOptions): Promise<void> {
  const { client } = opts;
  const stdin = process.stdin;
  const stdout = process.stdout;

  if (!stdout.isTTY || !stdin.isTTY) {
    throw new Error("inbox tui requires a tty (stdin and stdout)");
  }

  let rows: InboxRow[] = [];
  let visible: InboxRow[] = [];
  // Cache of replies + unread state for the currently-selected decision.
  // Populated by an async fetch that runs whenever selection changes; the
  // preview pane reads this synchronously when rendering. Auto-marks read
  // on the IPC side so the listing's unreadReplyCount drops on next refresh.
  let detailMessages: DecisionMessageRow[] | null = null;
  let detailDecisionId: string | null = null;
  let filterAll = false;
  let selected = 0;
  let listOffset = 0;
  let previewOffset = 0;
  let mode: Mode = "normal";
  let searchQuery = "";
  let cmdBuf = "";
  let prompt: Pending | null = null;
  let promptBuf = "";
  let statusMsg = "";
  let statusMsgUntil = 0;
  let lastG = 0; // for `gg`
  let running = true;

  function setStatus(msg: string, ttlMs = 3000): void {
    statusMsg = msg;
    statusMsgUntil = Date.now() + ttlMs;
    render();
  }

  function termCols(): number {
    const w = stdout.columns ?? 80;
    return w > 40 ? w : 80;
  }
  function termRows(): number {
    const r = stdout.rows ?? 24;
    return r > 10 ? r : 24;
  }

  // Layout heights derived from terminal size each render. Roughly 50/50
  // list-and-preview so the preview has room for replies above the fold;
  // before LOG 2026-04-28 the preview was 40% and replies frequently fell
  // off-screen. Header + status each take one row; -1 for separator.
  // Detail mode collapses the list and gives the preview the full body.
  function layout(): { listH: number; prevH: number } {
    const total = termRows();
    const body = total - 2; // header + status
    if (mode === "detail") {
      return { listH: 0, prevH: body };
    }
    const prevH = Math.max(8, Math.floor(body * 0.5));
    const listH = Math.max(3, body - prevH - 1); // -1 for separator
    return { listH, prevH };
  }

  async function fetch(): Promise<void> {
    try {
      // `undefined` = default = actionable (open OR unread replies).
      // `all` = everything for audit. Tab toggles between the two.
      rows = await client.call<InboxRow[]>("inbox.list", {
        status: filterAll ? "all" : undefined,
      });
    } catch (e) {
      setStatus(`fetch failed: ${(e as Error).message}`, 5000);
      rows = [];
    }
    applyFilter();
  }

  /** Async-fetch the selected decision's replies + read state. Auto-marks
   *  read server-side. Re-fetches the listing afterward so the unread
   *  badge on the row drops to 0. Idempotent on the same selection (no
   *  thrashing). */
  async function fetchDetail(): Promise<void> {
    const r = current();
    if (!r) {
      detailMessages = null;
      detailDecisionId = null;
      return;
    }
    if (detailDecisionId === r.id && detailMessages !== null) {
      // Already loaded for this selection.
      return;
    }
    try {
      const got = await client.call<{ messages?: DecisionMessageRow[] }>("inbox.get", {
        id: r.id,
      });
      detailDecisionId = r.id;
      detailMessages = got.messages ?? [];
      // Refresh listing so the row's unreadReplyCount drops to 0.
      const hadUnread = (r.unreadReplyCount ?? 0) > 0;
      if (hadUnread) {
        await fetch();
      }
      render();
    } catch (e) {
      setStatus(`detail fetch failed: ${(e as Error).message}`, 5000);
    }
  }

  function applyFilter(): void {
    if (!searchQuery) {
      visible = rows.slice();
    } else {
      const q = searchQuery.toLowerCase();
      visible = rows.filter(
        (r) =>
          r.summary.toLowerCase().includes(q) ||
          r.id.toLowerCase().includes(q) ||
          r.tier.toLowerCase().includes(q) ||
          r.proposingAgentId.toLowerCase().includes(q) ||
          r.status.toLowerCase().includes(q),
      );
    }
    if (selected >= visible.length) selected = Math.max(0, visible.length - 1);
    if (selected < 0) selected = 0;
    ensureSelectedVisible();
  }

  function ensureSelectedVisible(): void {
    const { listH } = layout();
    if (selected < listOffset) listOffset = selected;
    if (selected >= listOffset + listH) listOffset = selected - listH + 1;
    if (listOffset < 0) listOffset = 0;
  }

  function current(): InboxRow | undefined {
    return visible[selected];
  }

  // ─── rendering ──────────────────────────────────────────────────────────

  let frameBuf = "";
  function w(s: string): void {
    frameBuf += s;
  }

  function flush(): void {
    stdout.write(frameBuf);
    frameBuf = "";
  }

  function render(): void {
    const cols = termCols();
    const { listH, prevH } = layout();

    w(HOME);
    renderHeader(cols);
    if (mode === "detail") {
      renderPreview(cols, prevH);
    } else {
      renderList(cols, listH);
      renderSeparator(cols);
      renderPreview(cols, prevH);
    }
    renderStatus(cols);
    flush();

    // After painting, kick an async detail fetch if the selection has
    // moved off the cached row. The fetch auto-marks-read on the IPC
    // side, refreshes the listing, and re-renders. Fire-and-forget;
    // fetchDetail dedupes against detailDecisionId.
    const sel = current();
    if (sel && detailDecisionId !== sel.id) {
      detailMessages = null;
      detailDecisionId = null;
      void fetchDetail();
    }
  }

  function renderHeader(cols: number): void {
    const open = rows.filter((r) => r.status === "open").length;
    const total = rows.length;
    const totalUnread = rows.reduce((acc, r) => acc + (r.unreadReplyCount ?? 0), 0);
    // Filter labels:
    //   "active" — default; rows that need attention (open OR unread replies)
    //   "all"    — every decision, including resolved-and-read
    const filter = filterAll ? "all" : "active";
    const title = mode === "detail" ? "olle inbox · view" : "olle inbox";
    const left = ` ${ANSI.bold}${title}${ANSI.reset}  ${ANSI.dim}filter:${ANSI.reset} ${filter}`;
    const unreadPart =
      totalUnread > 0
        ? `${ANSI.bold}${ANSI.cyan}${totalUnread} unread${ANSI.reset}${ANSI.dim} · ${ANSI.reset}`
        : "";
    const right = `${unreadPart}${ANSI.dim}${open} open · ${total} total${ANSI.reset} `;
    const lWidth = vlen(left);
    const rWidth = vlen(right);
    const gap = Math.max(1, cols - lWidth - rWidth);
    const line = `${left}${" ".repeat(gap)}${right}`;
    // Inverse-video bar across full width
    w(`${ANSI.inv}${pad(line, cols)}${ANSI.reset}\n`);
  }

  function renderList(cols: number, h: number): void {
    if (visible.length === 0) {
      const empty = filterAll
        ? "(no inbox items)"
        : searchQuery
          ? `(no matches for "${searchQuery}")`
          : "(inbox zero — nothing waiting for you. Tab to show all.)";
      w(`${ANSI.dim}${pad(`  ${empty}`, cols)}${ANSI.reset}\n`);
      for (let i = 1; i < h; i++) w(`${pad("", cols)}\n`);
      return;
    }
    const now = Date.now();
    const idW = 10;
    const ageW = 5;
    const tierW = 12;
    for (let i = 0; i < h; i++) {
      const idx = listOffset + i;
      if (idx >= visible.length) {
        w(`${pad("", cols)}\n`);
        continue;
      }
      const r = visible[idx]!;
      const cur = idx === selected;
      const unread = r.unreadReplyCount ?? 0;
      // Cyan-bold glyph when unread replies are waiting — reads as
      // higher-priority than the open-yellow it overrides.
      const glyph =
        unread > 0
          ? `${ANSI.bold}${ANSI.cyan}${STATUS_GLYPHS[r.status]?.replace(/\x1b\[[0-9;]*m/g, "") ?? "●"}${ANSI.reset}`
          : statusGlyph(r.status);
      const tier = `${tierColor(r.tier)}${r.tier}${ANSI.reset}`;
      const id = `${ANSI.dim}${r.id.slice(0, idW)}${ANSI.reset}`;
      const age = fmtAge(now - r.createdAt);
      const stale =
        r.status === "open" && r.staleness != null && r.staleness < now
          ? `${ANSI.red}!${ANSI.reset}`
          : " ";
      const summary = r.summary.replace(/\s+/g, " ");
      // Prefix the row's summary with the proposing agent's name so the
      // list itself answers "who is asking" without expanding the row.
      const fromTag = r.proposingAgentName
        ? `${ANSI.dim}[${r.proposingAgentName}]${ANSI.reset} `
        : "";
      const unreadBadge =
        unread > 0
          ? `  ${ANSI.bold}${ANSI.cyan}(${unread} new)${ANSI.reset}`
          : "";
      const lineRaw = ` ${glyph}${stale} ${id}  ${pad(tier, tierW)}  ${pad(age, ageW)}  ${fromTag}${summary}${unreadBadge}`;
      let line = clip(lineRaw, cols);
      if (cur) {
        // Strip ANSI inside selected line then inverse-paint: highlights
        // win over per-cell color but we keep the row legible.
        const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
        line = `${ANSI.inv}${pad(plain, cols)}${ANSI.reset}`;
      } else {
        line = pad(line, cols);
      }
      w(`${line}\n`);
    }
  }

  function renderSeparator(cols: number): void {
    w(`${ANSI.dim}${"─".repeat(cols)}${ANSI.reset}\n`);
  }

  function renderPreview(cols: number, h: number): void {
    const r = current();
    if (!r) {
      for (let i = 0; i < h; i++) w(`${pad("", cols)}\n`);
      return;
    }
    const lines = previewLines(r, cols);
    if (previewOffset > Math.max(0, lines.length - h)) {
      previewOffset = Math.max(0, lines.length - h);
    }
    if (previewOffset < 0) previewOffset = 0;
    const above = previewOffset;
    const below = Math.max(0, lines.length - previewOffset - h);
    // We reserve the top/bottom-most row for scroll hints when overflow
    // exists. Hints sit on the same row as content (no extra height cost):
    // they replace the first/last visible line with a dim "▲ N more above"
    // / "▼ N more below" string. This lets the user know to scroll without
    // burning a whole row of preview.
    for (let i = 0; i < h; i++) {
      const idx = previewOffset + i;
      let ln = idx < lines.length ? lines[idx]! : "";
      const isFirst = i === 0;
      const isLast = i === h - 1;
      if (isFirst && above > 0) {
        const hint = `${ANSI.dim}▲ ${above} more line${above === 1 ? "" : "s"} above (k / Ctrl-U / press o for full view)${ANSI.reset}`;
        ln = hint;
      } else if (isLast && below > 0) {
        const hint = `${ANSI.dim}▼ ${below} more line${below === 1 ? "" : "s"} below (j / Ctrl-D / press o for full view)${ANSI.reset}`;
        ln = hint;
      }
      w(`${pad(clip(ln, cols), cols)}\n`);
    }
  }

  /** Build the per-decision "thread view" — the same content the small
   *  preview pane and the full-screen detail mode both render. Layout
   *  (top to bottom):
   *
   *    1. Headline:  bold summary
   *    2. Meta:      single dim line — status · tier · age · resolved/stale · from → to
   *    3. What's-being-requested highlights (if payload matches a known shape)
   *    4. Replies (if any, oldest → newest, with [NEW] markers and unread counter)
   *    5. Payload JSON (full, soft-wrapped)
   *    6. Footer line with the full id (for copy/paste)
   *
   *  Replies sit above the payload because they are what the principal
   *  most-recently needs to see; the payload was already approved.
   *  Anything beyond what the small preview window can show is surfaced
   *  via "▼ N more lines" / "▲ N more above" indicators on the preview's
   *  edges (rendered separately in renderPreview). */
  function previewLines(r: InboxRow, cols: number): string[] {
    const now = Date.now();
    const out: string[] = [];

    // 1. Headline — bold, wrapped.
    const headlineLimit = Math.max(20, cols - 2);
    const headlineLines = softWrap(r.summary.replace(/\s+/g, " "), headlineLimit);
    for (let i = 0; i < headlineLines.length; i++) {
      out.push(`${ANSI.bold}${headlineLines[i]}${ANSI.reset}`);
    }

    // 2. Meta — one dense line summarising who/when/state.
    const metaParts: string[] = [];
    metaParts.push(`${statusGlyph(r.status)} ${r.status}`);
    metaParts.push(`${tierColor(r.tier)}${r.tier}${ANSI.reset}`);
    metaParts.push(`${ANSI.dim}${fmtAge(now - r.createdAt)} old${ANSI.reset}`);
    if (r.staleness != null && r.status === "open") {
      const remaining = r.staleness - now;
      metaParts.push(
        remaining > 0
          ? `${ANSI.yellow}stale in ${fmtAge(remaining)}${ANSI.reset}`
          : `${ANSI.red}stale ${fmtAge(-remaining)} ago${ANSI.reset}`,
      );
    }
    if (r.resolvedAt != null) {
      metaParts.push(`${ANSI.dim}resolved ${fmtAge(now - r.resolvedAt)} ago${ANSI.reset}`);
    }
    out.push(`${ANSI.dim}·${ANSI.reset} ${metaParts.join(`  ${ANSI.dim}·${ANSI.reset}  `)}`);

    const fromName = r.proposingAgentName ?? r.proposingAgentId;
    const toName = r.principalDisplay ?? r.principalId;
    out.push(
      `${ANSI.dim}from${ANSI.reset} ${ANSI.bold}${fromName}${ANSI.reset}  ${ANSI.dim}to${ANSI.reset} ${toName}`,
    );

    // 3. Highlights (payload-shape-aware) — kept compact.
    const hi = highlightLines(r, cols);
    if (hi.length > 0) {
      out.push("");
      out.push(`${ANSI.cyan}${ANSI.bold}── what's being requested ${ANSI.reset}${ANSI.dim}${"─".repeat(Math.max(2, cols - vlen("── what's being requested ")))}${ANSI.reset}`);
      for (const line of hi) out.push(line);
    }

    // 4. Replies — visible above the fold by default. Loaded async by
    //    fetchDetail() on selection change; absent until the IPC roundtrip
    //    completes (the next render shows them).
    if (detailDecisionId === r.id && detailMessages !== null) {
      out.push("");
      const n = detailMessages.length;
      const newCount = detailMessages.filter((m) => !m.read).length;
      const ruleLabel =
        n === 0
          ? "── no replies yet "
          : `── replies (${n})${newCount > 0 ? `  ${ANSI.bold}${ANSI.cyan}· ${newCount} new${ANSI.reset}${ANSI.dim}` : ""} `;
      const fillW = Math.max(2, cols - vlen(ruleLabel));
      out.push(`${ANSI.dim}${ruleLabel}${"─".repeat(fillW)}${ANSI.reset}`);
      if (n === 0) {
        out.push(
          `  ${ANSI.dim}(no follow-ups posted yet — agent uses mail_reply to report back here)${ANSI.reset}`,
        );
      } else {
        for (const m of detailMessages) {
          const when = formatTimestamp(m.at);
          const newTag = m.read ? "" : `  ${ANSI.bold}${ANSI.cyan}[NEW]${ANSI.reset}`;
          const author = m.actorName ?? m.actorId;
          out.push("");
          out.push(
            `  ${ANSI.bold}${ANSI.cyan}▸${ANSI.reset} ${ANSI.bold}${author}${ANSI.reset}  ${ANSI.dim}${when}${ANSI.reset}${newTag}`,
          );
          const limit = Math.max(20, cols - 6);
          for (const para of m.text.split("\n")) {
            for (const wrapped of softWrap(para, limit)) {
              out.push(`      ${wrapped}`);
            }
          }
        }
      }
    }

    // 5. Payload — kept but pushed below replies; the principal already
    //    approved this, so it's reference content.
    out.push("");
    const payloadLabel = "── payload ";
    out.push(
      `${ANSI.dim}${payloadLabel}${"─".repeat(Math.max(2, cols - vlen(payloadLabel)))}${ANSI.reset}`,
    );
    const pretty = JSON.stringify(r.payload ?? {}, null, 2).split("\n");
    for (const ln of pretty) {
      // Soft-wrap long json lines so they don't clip.
      let rest = ln;
      const indentMatch = rest.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1]! : "";
      const limit = Math.max(20, cols - 2);
      while (vlen(rest) > limit) {
        out.push(`  ${rest.slice(0, limit)}`);
        rest = indent + "  " + rest.slice(limit);
      }
      out.push(`  ${rest}`);
    }

    // 6. Footer with full id for copy/paste.
    out.push("");
    out.push(`${ANSI.dim}id ${r.id}${ANSI.reset}`);

    return out;
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

  function softWrap(text: string, width: number): string[] {
    if (text.length === 0) return [""];
    const out: string[] = [];
    let line = "";
    for (const word of text.split(/\s+/)) {
      if (line.length === 0) {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += " " + word;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line.length > 0) out.push(line);
    return out;
  }

  /** Render a payload-shape-aware highlights block. Currently knows
   *  `grant_scope`; falls back to empty for unknown shapes (the raw
   *  payload below still renders). Old decisions (created before the
   *  payload-enrichment change) lack `agentName`/`input`/`toolDescription` —
   *  fall back to the row-level enriched name and to the bare tool name
   *  so they still read clearly. */
  function highlightLines(row: InboxRow, cols: number): string[] {
    const payload = row.payload;
    if (!payload) return [];
    const out: string[] = [];
    const k = (label: string, value: string): string =>
      `${ANSI.dim}${label.padEnd(14)}${ANSI.reset}${value}`;
    const action = typeof payload.action === "string" ? payload.action : null;

    if (action === "grant_scope") {
      const tool = payload.tool as string | undefined;
      const tier = payload.tier as string | undefined;
      const agentName =
        (payload.agentName as string | undefined) ?? row.proposingAgentName;
      const agentId = (payload.agentId as string | undefined) ?? row.proposingAgentId;
      const reason = payload.reason as string | undefined;
      const desc = payload.toolDescription as string | undefined;
      const threadId = payload.threadId as string | undefined;
      const input = payload.input as Record<string, unknown> | undefined;

      const inputRendered =
        input != null ? renderToolCall(tool ?? "?", input, cols - 16) : tool ?? "?";
      const agentLabel =
        agentName && agentName !== agentId
          ? `${ANSI.bold}${agentName}${ANSI.reset}${
              agentId ? ` ${ANSI.dim}(${agentId.slice(0, 10)}…)${ANSI.reset}` : ""
            }`
          : agentId ?? "?";

      out.push(k("agent:", agentLabel));
      out.push(k("wants to call:", `${ANSI.bold}${inputRendered}${ANSI.reset}`));
      if (tier) out.push(k("tier:", `${tierColor(tier)}${tier}${ANSI.reset}`));
      if (desc) {
        // Wrap the tool description so the human sees what the tool
        // actually does without having to leave the inbox.
        const wrapWidth = Math.max(20, cols - 16);
        const wrapped = wrapText(desc, wrapWidth);
        out.push(k("does:", wrapped[0] ?? ""));
        for (let i = 1; i < wrapped.length; i++) {
          out.push(`${" ".repeat(14)}${wrapped[i]!}`);
        }
      }
      if (reason) out.push(k("blocked by:", `${ANSI.yellow}${reason}${ANSI.reset}`));
      if (threadId) out.push(k("thread:", `${ANSI.dim}${threadId}${ANSI.reset}`));
      return out;
    }

    return out;
  }

  function renderToolCall(name: string, input: Record<string, unknown>, max: number): string {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(input)) {
      let rendered: string;
      if (typeof v === "string") rendered = JSON.stringify(v);
      else if (typeof v === "number" || typeof v === "boolean" || v === null)
        rendered = String(v);
      else {
        try {
          rendered = JSON.stringify(v);
        } catch {
          rendered = String(v);
        }
      }
      if (rendered.length > 60) rendered = `${rendered.slice(0, 59)}…`;
      parts.push(`${k}: ${rendered}`);
    }
    let s = `${name}(${parts.join(", ")})`;
    if (s.length > max) s = `${s.slice(0, Math.max(10, max - 1))}…`;
    return s;
  }

  function wrapText(s: string, width: number): string[] {
    const words = s.split(/\s+/);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      if (cur.length === 0) {
        cur = w;
      } else if (cur.length + 1 + w.length <= width) {
        cur += " " + w;
      } else {
        lines.push(cur);
        cur = w;
      }
    }
    if (cur.length > 0) lines.push(cur);
    return lines;
  }

  function renderStatus(cols: number): void {
    let line = "";
    const now = Date.now();
    if (mode === "search") {
      line = `/${searchQuery}`;
    } else if (mode === "command") {
      line = `:${cmdBuf}`;
    } else if (mode === "prompt" && prompt) {
      const stepLabel = prompt.step === "message" ? `${prompt.vote} message` : "payload (json)";
      line = `${stepLabel}: ${promptBuf}`;
    } else if (mode === "help") {
      line = `${ANSI.dim}help — press any key to dismiss${ANSI.reset}`;
    } else if (statusMsg && now < statusMsgUntil) {
      line = statusMsg;
    } else if (mode === "detail") {
      line = `${ANSI.dim}j/k scroll · q/Esc/← back · a approve · d deny · m modify · ? help${ANSI.reset}`;
    } else {
      line = `${ANSI.dim}j/k move · o/Enter open · a/d/m vote · / search · Tab open/all · ? help · q quit${ANSI.reset}`;
    }
    w(pad(clip(line, cols), cols));
  }

  function renderHelpOverlay(): void {
    const cols = termCols();
    const total = termRows();
    w(`${HOME}${CLEAR}`);
    const title = `${ANSI.inv}${pad(" olle inbox — keys ", cols)}${ANSI.reset}`;
    w(`${title}\n`);
    const lines: Array<[string, string]> = [
      ["j  ↓", "next item"],
      ["k  ↑", "previous item"],
      ["gg", "first item"],
      ["G", "last item"],
      ["Ctrl-d / Ctrl-u", "half-page down / up"],
      ["Ctrl-f / Ctrl-b / PgDn / PgUp", "page down / up"],
      ["o  Enter", "open in detail view (full screen, scrollable)"],
      ["q  Esc  ← (in detail)", "back to list"],
      ["h  ←", "scroll preview up (list mode)"],
      ["l  →", "scroll preview down (list mode)"],
      ["", ""],
      ["a", "approve (prompts for optional message)"],
      ["d", "deny (prompts for optional message)"],
      ["m", "modify (prompts for message + payload JSON)"],
      ["", ""],
      ["/", "search"],
      ["n  N", "next / previous match"],
      ["Tab  t", "toggle filter open ↔ all"],
      ["r", "refresh"],
      ["y", "yank id (clipboard via OSC 52)"],
      [":", "command line  (:q :refresh :open :all :show)"],
      ["Esc", "cancel prompt / overlay"],
      ["q  Ctrl-C", "quit"],
    ];
    let row = 1;
    for (const [k, d] of lines) {
      if (row >= total - 1) break;
      const left = `  ${ANSI.cyan}${k}${ANSI.reset}`;
      const text = d ? `${pad(left, 36)}${ANSI.dim}${d}${ANSI.reset}` : "";
      w(pad(text, cols) + "\n");
      row++;
    }
    while (row < total - 1) {
      w(pad("", cols) + "\n");
      row++;
    }
    w(`${ANSI.dim}${pad(" press any key to return ", cols)}${ANSI.reset}`);
    flush();
  }

  // ─── input handling ────────────────────────────────────────────────────

  function quit(): void {
    running = false;
  }

  function moveDown(n = 1): void {
    if (visible.length === 0) return;
    selected = Math.min(visible.length - 1, selected + n);
    previewOffset = 0;
    ensureSelectedVisible();
  }
  function moveUp(n = 1): void {
    if (visible.length === 0) return;
    selected = Math.max(0, selected - n);
    previewOffset = 0;
    ensureSelectedVisible();
  }

  function findNext(reverse = false): void {
    if (!searchQuery || visible.length === 0) return;
    const q = searchQuery.toLowerCase();
    const match = (r: InboxRow): boolean =>
      r.summary.toLowerCase().includes(q) ||
      r.id.toLowerCase().includes(q) ||
      r.tier.toLowerCase().includes(q) ||
      r.proposingAgentId.toLowerCase().includes(q) ||
      r.status.toLowerCase().includes(q);
    const n = visible.length;
    for (let step = 1; step <= n; step++) {
      const i = ((selected + (reverse ? -step : step)) % n + n) % n;
      if (match(visible[i]!)) {
        selected = i;
        previewOffset = 0;
        ensureSelectedVisible();
        return;
      }
    }
  }

  async function refresh(): Promise<void> {
    await fetch();
    setStatus("refreshed");
  }

  async function respond(
    vote: "approve" | "deny" | "modify",
    message: string,
    payloadOverride?: Record<string, unknown>,
  ): Promise<void> {
    const r = current();
    if (!r) return;
    if (r.status !== "open") {
      setStatus(`already ${r.status}`, 4000);
      return;
    }
    try {
      const updated = await client.call<InboxRow>("inbox.respond", {
        id: r.id,
        vote,
        message: message || undefined,
        payloadOverride,
      });
      setStatus(`${updated.id.slice(0, 10)} → ${updated.status}`, 3000);
      await fetch();
    } catch (e) {
      setStatus(`error: ${(e as Error).message}`, 6000);
    }
  }

  function startAction(vote: "approve" | "deny" | "modify"): void {
    const r = current();
    if (!r) return;
    if (r.status !== "open") {
      setStatus(`already ${r.status}`, 3000);
      return;
    }
    prompt = { vote, message: "", step: "message" };
    promptBuf = "";
    mode = "prompt";
  }

  async function commitPrompt(): Promise<void> {
    if (!prompt) {
      mode = "normal";
      return;
    }
    if (prompt.step === "message") {
      prompt.message = promptBuf;
      if (prompt.vote === "modify") {
        prompt.step = "payload";
        const cur = current();
        promptBuf = cur ? JSON.stringify(cur.payload ?? {}) : "{}";
        return;
      }
      const v = prompt.vote;
      const msg = prompt.message;
      prompt = null;
      promptBuf = "";
      mode = "normal";
      await respond(v, msg);
      return;
    }
    // payload step (modify)
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(promptBuf) as Record<string, unknown>;
    } catch (e) {
      setStatus(`invalid JSON: ${(e as Error).message}`, 5000);
      return;
    }
    const v = prompt.vote;
    const msg = prompt.message;
    prompt = null;
    promptBuf = "";
    mode = "normal";
    await respond(v, msg, parsed);
  }

  async function commitCommand(): Promise<void> {
    const cmd = cmdBuf.trim();
    cmdBuf = "";
    mode = "normal";
    if (!cmd) return;
    const [head, ...rest] = cmd.split(/\s+/);
    switch (head) {
      case "q":
      case "quit":
      case "exit":
        quit();
        return;
      case "r":
      case "refresh":
        await refresh();
        return;
      case "all":
        filterAll = true;
        await fetch();
        return;
      case "open":
        filterAll = false;
        await fetch();
        return;
      case "help":
      case "h":
        mode = "help";
        renderHelpOverlay();
        return;
      case "approve":
      case "a":
        await respond("approve", rest.join(" "));
        return;
      case "deny":
      case "d":
        await respond("deny", rest.join(" "));
        return;
      default:
        setStatus(`unknown command: ${head}`, 4000);
    }
  }

  function yankCurrentId(): void {
    const r = current();
    if (!r) return;
    // OSC 52 — terminal-driven clipboard. Many terminals (iTerm2, kitty,
    // wezterm, recent xterm with allowWindowOps) honor it. Where they
    // don't, the user still gets the id printed in the status bar.
    const b64 = Buffer.from(r.id, "utf8").toString("base64");
    stdout.write(`${ESC}]52;c;${b64}\x07`);
    setStatus(`yanked ${r.id}`, 2000);
  }

  function handleKey(seq: string): void {
    // Help overlay swallows any key.
    if (mode === "help") {
      mode = "normal";
      stdout.write(`${HOME}${CLEAR}`);
      render();
      return;
    }

    // Mode-specific input editors first.
    if (mode === "search") {
      if (seq === "\x1b" || seq === "\x03") {
        mode = "normal";
        searchQuery = "";
        applyFilter();
      } else if (seq === "\r" || seq === "\n") {
        mode = "normal";
        applyFilter();
      } else if (seq === "\x7f" || seq === "\b") {
        searchQuery = searchQuery.slice(0, -1);
        applyFilter();
      } else if (isPrintable(seq)) {
        searchQuery += seq;
        applyFilter();
      }
      render();
      return;
    }

    if (mode === "command") {
      if (seq === "\x1b" || seq === "\x03") {
        cmdBuf = "";
        mode = "normal";
      } else if (seq === "\r" || seq === "\n") {
        void commitCommand().then(render);
      } else if (seq === "\x7f" || seq === "\b") {
        cmdBuf = cmdBuf.slice(0, -1);
      } else if (isPrintable(seq)) {
        cmdBuf += seq;
      }
      render();
      return;
    }

    if (mode === "prompt") {
      if (seq === "\x1b" || seq === "\x03") {
        prompt = null;
        promptBuf = "";
        mode = "normal";
      } else if (seq === "\r" || seq === "\n") {
        void commitPrompt().then(render);
        return;
      } else if (seq === "\x7f" || seq === "\b") {
        promptBuf = promptBuf.slice(0, -1);
      } else if (isPrintable(seq)) {
        promptBuf += seq;
      }
      render();
      return;
    }

    // ── normal mode ────────────────────────────────────────────────────
    const { listH, prevH } = layout();
    const half = Math.max(1, Math.floor(mode === "detail" ? prevH / 2 : listH / 2));

    // Detail-mode early-out: `q`/`Esc`/`←` returns to list; navigation
    // keys scroll the body rather than moving between decisions (same
    // convention as `less`/`man` and most inbox clients).
    if (mode === "detail") {
      // `q` or `Esc` exits detail mode (does NOT quit the TUI).
      if (seq === "\x1b" || seq === "q") {
        mode = "normal";
        previewOffset = 0;
        lastG = 0;
        render();
        return;
      }
      switch (seq) {
        case "?":
          mode = "help";
          renderHelpOverlay();
          return;
        case "j":
        case "\x1b[B": // ↓
          previewOffset += 1;
          lastG = 0;
          render();
          return;
        case "k":
        case "\x1b[A": // ↑
          previewOffset = Math.max(0, previewOffset - 1);
          lastG = 0;
          render();
          return;
        case "\x04": // Ctrl-D
        case "J":
          previewOffset += half;
          lastG = 0;
          render();
          return;
        case "\x15": // Ctrl-U
        case "K":
          previewOffset = Math.max(0, previewOffset - half);
          lastG = 0;
          render();
          return;
        case "\x06": // Ctrl-F
        case "\x1b[6~": // PgDn
          previewOffset += prevH;
          lastG = 0;
          render();
          return;
        case "\x02": // Ctrl-B
        case "\x1b[5~": // PgUp
          previewOffset = Math.max(0, previewOffset - prevH);
          lastG = 0;
          render();
          return;
        case "g":
          if (Date.now() - lastG < 700) {
            previewOffset = 0;
            lastG = 0;
          } else {
            lastG = Date.now();
          }
          render();
          return;
        case "G":
          // Jump to bottom; previewOffset clamped in renderPreview.
          previewOffset = Number.MAX_SAFE_INTEGER;
          lastG = 0;
          render();
          return;
        case "h":
        case "\x1b[D": // ←
          mode = "normal";
          previewOffset = 0;
          lastG = 0;
          render();
          return;
        case "a":
          startAction("approve");
          render();
          return;
        case "d":
          startAction("deny");
          render();
          return;
        case "m":
          startAction("modify");
          render();
          return;
        case "y":
          yankCurrentId();
          return;
        case "\x03": // Ctrl-C
          quit();
          return;
        default:
          return;
      }
    }

    // gg sequence — `g` then `g` within ~700ms jumps to first.
    if (seq === "g") {
      if (Date.now() - lastG < 700) {
        selected = 0;
        previewOffset = 0;
        ensureSelectedVisible();
        lastG = 0;
      } else {
        lastG = Date.now();
      }
      render();
      return;
    } else {
      lastG = 0;
    }

    switch (seq) {
      case "q":
      case "\x03": // Ctrl-C
        quit();
        return;
      case "?":
        mode = "help";
        renderHelpOverlay();
        return;
      case "j":
      case "\x1b[B": // ↓
        moveDown();
        break;
      case "k":
      case "\x1b[A": // ↑
        moveUp();
        break;
      case "G":
        selected = Math.max(0, visible.length - 1);
        previewOffset = 0;
        ensureSelectedVisible();
        break;
      case "\x04": // Ctrl-D
        moveDown(half);
        break;
      case "\x15": // Ctrl-U
        moveUp(half);
        break;
      case "\x06": // Ctrl-F
      case "\x1b[6~": // PgDn
        moveDown(listH);
        break;
      case "\x02": // Ctrl-B
      case "\x1b[5~": // PgUp
        moveUp(listH);
        break;
      case "\x1b[H": // Home
        selected = 0;
        previewOffset = 0;
        ensureSelectedVisible();
        break;
      case "\x1b[F": // End
        selected = Math.max(0, visible.length - 1);
        previewOffset = 0;
        ensureSelectedVisible();
        break;
      case "h":
      case "\x1b[D": // ←
        previewOffset = Math.max(0, previewOffset - 1);
        break;
      case "l":
      case "\x1b[C": // →
        previewOffset += 1;
        break;
      case "o":
      case "\r":
      case "\n":
        // Open the selected decision in full-screen detail mode. ESC, q,
        // or ← returns to the list. Same content as the small preview;
        // gets the whole screen so long replies + payload aren't behind
        // the fold.
        if (current()) {
          mode = "detail";
          previewOffset = 0;
        }
        break;
      case "K":
        previewOffset = Math.max(0, previewOffset - prevH);
        break;
      case "J":
        previewOffset += prevH;
        break;
      case "\t":
      case "t":
        filterAll = !filterAll;
        void fetch().then(render);
        return;
      case "r":
        void refresh().then(render);
        return;
      case "/":
        mode = "search";
        searchQuery = "";
        break;
      case "n":
        findNext(false);
        break;
      case "N":
        findNext(true);
        break;
      case ":":
        mode = "command";
        cmdBuf = "";
        break;
      case "a":
        startAction("approve");
        break;
      case "d":
        startAction("deny");
        break;
      case "m":
        startAction("modify");
        break;
      case "y":
        yankCurrentId();
        break;
      default:
      // ignore unknown keys silently
    }
    render();
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────

  stdout.write(`${ALT_ON}${CURSOR_HIDE}${CLEAR}`);
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  await fetch();
  render();

  const onResize = (): void => {
    stdout.write(`${HOME}${CLEAR}`);
    ensureSelectedVisible();
    render();
  };
  stdout.on("resize", onResize);

  // Periodic age refresh so the list updates without input. 30s is a
  // sensible compromise between freshness and idle CPU.
  const ticker = setInterval(() => {
    if (mode === "normal") render();
  }, 30_000);

  await new Promise<void>((resolve) => {
    const onData = (chunk: string | Buffer): void => {
      const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      // A single read can carry several keys (paste, fast typing) or a
      // single multi-byte escape sequence. Walk the buffer one logical
      // key at a time.
      let i = 0;
      while (i < data.length && running) {
        const { seq, len } = readKey(data, i);
        i += len;
        try {
          handleKey(seq);
        } catch (e) {
          setStatus(`error: ${(e as Error).message}`, 5000);
        }
      }
      if (!running) {
        cleanup();
        resolve();
      }
    };
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdout.off("resize", onResize);
      clearInterval(ticker);
      stdin.setRawMode?.(false);
      stdin.pause();
      stdout.write(`${CURSOR_SHOW}${ALT_OFF}`);
    };
    stdin.on("data", onData);
  });
}

function isPrintable(s: string): boolean {
  if (s.length === 0) return false;
  // Reject control chars and lone escape; everything else (including
  // unicode letters, digits, punctuation) is fine.
  if (s.length === 1) {
    const c = s.charCodeAt(0);
    return c >= 0x20 && c !== 0x7f;
  }
  // Multi-char chunks coming through here are escape sequences we'd want
  // to handle as keys; treat as non-printable.
  return false;
}

/** Pull one logical key from `data` starting at `i`. Handles CSI (`\x1b[`)
 *  and SS3 (`\x1bO`) sequences plus a lone ESC. Returns the substring and
 *  consumed length. */
function readKey(data: string, i: number): { seq: string; len: number } {
  const ch = data[i]!;
  if (ch !== "\x1b") return { seq: ch, len: 1 };
  if (i + 1 >= data.length) return { seq: "\x1b", len: 1 };
  const next = data[i + 1]!;
  if (next !== "[" && next !== "O") return { seq: "\x1b", len: 1 };
  // CSI / SS3 — read until a final byte (0x40-0x7e) or `~`
  let j = i + 2;
  while (j < data.length) {
    const c = data.charCodeAt(j);
    j++;
    if (c === 0x7e || (c >= 0x40 && c <= 0x7e)) break;
  }
  return { seq: data.slice(i, j), len: j - i };
}
