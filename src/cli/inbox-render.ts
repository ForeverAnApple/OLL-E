// Pure renderers for `olle inbox list` and `olle inbox show`. Each takes the
// IPC result + {width, color} and returns a finished string — no IO, no
// daemon, no process access. cmdInbox (src/cli/run.ts) fetches over IPC,
// computes width/color from the live terminal, then prints what these return.
//
// This is the same visual language as `olle stats` (see stats-render.ts):
// the shared render.ts primitives, the plain-pad-then-color discipline, a
// single C-colorer gated once on opts.color, humane empty states, and
// relative-age timestamps rather than raw ISO strings.
//
// Rendering technique — plain-pad-then-color: build every aligned cell as a
// PLAIN string, size on those plain strings, and colorize LAST. The inbox
// listing is the rare case where a cell (the tier tag) arrives pre-colored,
// so widths there are measured with vlen()/padVisible() instead.

import { ANSI } from "./theme.ts";
import {
  clipPlain,
  emptyState,
  fmtAge,
  kv,
  makeColorer,
  padVisible,
  shortId,
  vlen,
  wrap,
  type Colorer,
} from "./render.ts";

// Structurally identical to the IPC result shapes cmdInbox receives. Exported
// so run.ts can pass its own rows straight through.
export interface InboxRow {
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
  /** Per-decision unread reply count for the current reader — drives the
   *  "(N new)" badge without a follow-up call. */
  unreadReplyCount?: number;
}

export interface DecisionMessageRow {
  id: string;
  decisionId: string;
  actorId: string;
  actorName?: string;
  text: string;
  at: number;
  /** Whether this reply was already read before the current `inbox.get`.
   *  Unread rows get the `[NEW]` flag. */
  read?: boolean;
}

export interface InboxRowWithMessages extends InboxRow {
  messages?: DecisionMessageRow[];
}

// --- glyphs / tier / status colors ---------------------------------------

const STATUS_GLYPH: Record<string, string> = {
  open: "●",
  approved: "✓",
  denied: "✗",
  modified: "±",
  stale: "·",
};

/** Status glyph in its semantic color. Unread replies override everything —
 *  info+bold reads as "look here" above the open-warning it covers. */
function statusGlyphColored(C: Colorer, status: string, hasUnread: boolean): string {
  const glyph = STATUS_GLYPH[status] ?? " ";
  if (hasUnread) return C(ANSI.bold + ANSI.info, glyph);
  switch (status) {
    case "open":
      return C(ANSI.warning, glyph);
    case "approved":
      return C(ANSI.success, glyph);
    case "denied":
      return C(ANSI.error, glyph);
    case "modified":
      return C(ANSI.info, glyph);
    case "stale":
      return C(ANSI.muted, glyph);
    default:
      return glyph;
  }
}

/** Tier tag in its semantic color: vision = accent, strategic = info,
 *  operational = muted. */
function tierColored(C: Colorer, tier: string): string {
  switch (tier) {
    case "vision":
      return C(ANSI.accent, tier);
    case "strategic":
      return C(ANSI.info, tier);
    case "operational":
      return C(ANSI.muted, tier);
    default:
      return tier;
  }
}

// --- list ----------------------------------------------------------------

export type InboxFilter = "active" | "all" | "open";

export interface InboxListOpts {
  width: number;
  color: boolean;
  /** Which listing the human asked for — picks the empty-state wording. */
  filter?: InboxFilter;
  /** Reference time for age math; defaults to now (injectable for tests). */
  now?: number;
}

// Column geometry — id + age + tier are dense and scan-friendly; the summary
// gets whatever's left. Prefix width is the fixed run before the from-tag:
//  " " glyph stale " " id(10) "  " tier(18) "  " age(5) "  ".
const ID_W = 10;
const AGE_W = 5;
const TIER_W = 18;
const PREFIX_W = 1 + 1 + 1 + 1 + ID_W + 2 + TIER_W + 2 + AGE_W + 2; // = 43

export function renderInboxList(rows: InboxRow[], opts: InboxListOpts): string {
  const { width } = opts;
  const now = opts.now ?? Date.now();
  const filter = opts.filter ?? "active";
  const C = makeColorer(opts.color);

  if (rows.length === 0) return renderListEmpty(C, filter, width);

  let totalUnread = 0;
  for (const r of rows) totalUnread += r.unreadReplyCount ?? 0;

  const out: string[] = [];
  out.push(renderListHeader(C, width, filter, rows.length, totalUnread));
  out.push("");

  for (const r of rows) {
    const unread = r.unreadReplyCount ?? 0;
    const glyph = statusGlyphColored(C, r.status, unread > 0);
    const stale =
      r.status === "open" && r.staleness != null && r.staleness < now
        ? C(ANSI.error, "!")
        : " ";
    const age = fmtAge(now - r.createdAt);
    const id = C(ANSI.muted, shortId(r.id));
    const tag =
      r.status === "open"
        ? tierColored(C, r.tier)
        : `${tierColored(C, r.tier)}/${r.status}`;

    // from-tag and unread badge are variable-width; size the summary against
    // whatever they leave so the line never overflows the terminal.
    const fromPlain = r.proposingAgentName ? `[${r.proposingAgentName}] ` : "";
    const fromTag = fromPlain ? C(ANSI.muted, fromPlain) : "";
    const badgePlain = unread > 0 ? ` (${unread} new)` : "";
    const badge = badgePlain ? C(ANSI.bold + ANSI.info, badgePlain.trimStart()) : "";

    const summaryRaw = r.summary.replace(/\s+/g, " ").trim();
    const summaryW = Math.max(8, width - PREFIX_W - fromPlain.length - badgePlain.length);
    const summary = clipPlain(summaryRaw, summaryW);

    const line =
      ` ${glyph}${stale} ${id}  ${padVisible(tag, TIER_W)}  ${age.padStart(AGE_W)}  ` +
      `${fromTag}${summary}${badgePlain ? " " + badge : ""}`;
    // Final safety net for pathologically narrow terminals.
    out.push(clipPlain(line, width));
  }

  return out.join("\n");
}

function renderListHeader(
  C: Colorer,
  width: number,
  filter: InboxFilter,
  count: number,
  totalUnread: number,
): string {
  const leftPlain = "olle inbox";
  const scope = filter; // "active" | "all" | "open" — already the label
  const countPlain = `${count} ${count === 1 ? "item" : "items"}`;
  const unreadPlain =
    totalUnread > 0
      ? ` · ${totalUnread} unread ${totalUnread === 1 ? "reply" : "replies"}`
      : "";
  const metaPlain = `${scope} · ${countPlain}${unreadPlain}`;

  const left = C(ANSI.dim, leftPlain);
  const meta =
    C(ANSI.muted, `${scope} · ${countPlain}`) +
    (totalUnread > 0
      ? C(ANSI.muted, " · ") +
        C(ANSI.bold + ANSI.info, unreadPlain.replace(/^ · /, ""))
      : "");

  const gap = width - leftPlain.length - metaPlain.length;
  if (gap >= 1) return left + " ".repeat(gap) + meta;
  return left + "\n" + meta;
}

function renderListEmpty(C: Colorer, filter: InboxFilter, width: number): string {
  switch (filter) {
    case "open":
      return emptyState(
        C,
        "No open decisions — nothing is waiting on your approval.",
        "olle inbox list --all",
        width,
      );
    case "all":
      return emptyState(
        C,
        "No inbox items yet. Decisions land here when an agent proposes one.",
        "olle chat",
        width,
      );
    default:
      return emptyState(
        C,
        "Inbox zero — nothing waiting on your decision.",
        "olle inbox list --all",
        width,
      );
  }
}

// --- show ----------------------------------------------------------------

export interface InboxShowOpts {
  width: number;
  color: boolean;
  now?: number;
}

export function renderInboxShow(r: InboxRowWithMessages, opts: InboxShowOpts): string {
  const { width } = opts;
  const now = opts.now ?? Date.now();
  const C = makeColorer(opts.color);

  const out: string[] = [];

  // A section rule: "── label ─────". `label` may carry color, so measure
  // with vlen; the fill runs to the terminal edge.
  const rule = (label?: string): string => {
    const base = label ? `── ${label} ` : "";
    const fill = "─".repeat(Math.max(2, width - vlen(base)));
    return C(ANSI.dim, base) + C(ANSI.dim, fill);
  };

  // Title block — full id (the human copies it into `inbox respond`).
  out.push(C(ANSI.bold, r.id));
  out.push(C(ANSI.dim, "═".repeat(width)));
  out.push("");

  const row = (label: string, value: string): void => {
    out.push("  " + kv(C, label, value, 10));
  };

  row("status", `${statusGlyphColored(C, r.status, false)} ${r.status}`);
  row("tier", tierColored(C, r.tier));
  row(
    "from",
    r.proposingAgentName
      ? `${r.proposingAgentName} ${C(ANSI.muted, `(${shortId(r.proposingAgentId)})`)}`
      : r.proposingAgentId,
  );
  row(
    "to",
    r.ownerDisplay
      ? `${r.ownerDisplay} ${C(ANSI.muted, `(${shortId(r.ownerAgentId)})`)}`
      : r.ownerAgentId,
  );
  row("age", fmtAge(now - r.createdAt));
  if (r.staleness != null) {
    const remaining = r.staleness - now;
    const dl =
      remaining > 0
        ? C(ANSI.warning, `in ${fmtAge(remaining)}`)
        : C(ANSI.error, `${fmtAge(-remaining)} ago`);
    row("stale", dl);
  }
  if (r.resolvedAt != null) {
    row("resolved", C(ANSI.muted, `${fmtAge(now - r.resolvedAt)} ago`));
  }

  out.push("");
  for (const line of wrap(r.summary, width - 4)) out.push("  " + line);

  out.push("");
  out.push(rule("payload"));
  const payloadStr = JSON.stringify(r.payload ?? {}, null, 2);
  for (const line of payloadStr.split("\n")) out.push("  " + line);

  if (r.messages && r.messages.length > 0) {
    const newCount = r.messages.filter((m) => !m.read).length;
    const header =
      `replies (${r.messages.length})` +
      (newCount > 0 ? `  · ${C(ANSI.bold + ANSI.info, `${newCount} new`)}` : "");
    out.push("");
    out.push(rule(header));
    for (const m of r.messages) {
      const when = `${fmtAge(now - m.at)} ago`;
      const newTag = m.read ? "" : " " + C(ANSI.bold + ANSI.info, "[NEW]");
      const author = C(ANSI.bold, m.actorName ?? m.actorId);
      out.push("");
      out.push(`  · ${C(ANSI.muted, when)}  ${author}${newTag}`);
      for (const paragraph of m.text.split("\n")) {
        for (const wrapped of wrap(paragraph, width - 6)) out.push("      " + wrapped);
      }
    }
  }

  return out.join("\n");
}
