// Pure renderers for the observability read commands — `olle cache`,
// `olle runs`, `olle threads`, `olle events`, and the per-line renderer
// `olle tail` streams through. They extend the visual language established
// by stats-render.ts (studied as the anchor): the theme.ts semantic
// palette, humanized numbers, plain-pad-then-color alignment, short ids,
// humane empty states, and threshold-colored bars.
//
// Every function is pure: (data, opts {width, color, ...}) => string. The
// caller (run.ts) computes width/color from the live terminal and prints.
//
// Rendering technique — plain-pad-then-color: aligned cells are built as
// PLAIN strings (see render.ts `table`), sized on those plain strings, and
// colored last, so columns stay aligned with or without ANSI.

import { ANSI } from "./theme.ts";
import {
  bar,
  clip,
  fmtAge,
  formatTokens,
  hiColor,
  intComma,
  makeColorer,
  shortId,
  table,
  headerLine,
  heading,
  wrapSpans,
  type Colorer,
  type Column,
  type Span,
} from "./render.ts";
import type {
  UsageStats,
  RunHistoryRow,
  ThreadInventoryRow,
  RecentEventRow,
} from "../observability/index.ts";

export interface ObsRenderOpts {
  width: number;
  color: boolean;
  /** The --agent flag value, if the human scoped the query. Drives the
   *  scope label in the header. */
  agent?: string;
  /** The --since flag as a ms epoch, for the window label on commands whose
   *  result payload doesn't echo the window (runs, events). */
  since?: number;
}

// --- shared header labels -------------------------------------------------

function windowLabel(since?: number): string {
  return since == null ? "all time" : `last ${fmtAge(Date.now() - since)}`;
}

function scopeLabel(agent?: string): string {
  return agent ? `agent ${agent}` : "all agents";
}

function countLabel(n: number, noun: string): string {
  return `${intComma(n)} ${n === 1 ? noun : noun + "s"}`;
}

/** Right-side header meta: `window · scope · count`. Drop the window for
 *  commands with no time filter (threads). */
function metaLine(
  agent: string | undefined,
  count: number,
  noun: string,
  since?: number,
  hasWindow = true,
): string {
  const parts: string[] = [];
  if (hasWindow) parts.push(windowLabel(since));
  parts.push(scopeLabel(agent));
  parts.push(countLabel(count, noun));
  return parts.join(" · ");
}

// -------------------------------------------------------------------------
// cache — a cache-focused receipt: hit bar headline, read/write/input gloss,
// per-model hit table. Same query as `olle stats`, cache columns only.
// -------------------------------------------------------------------------

export function renderCache(stats: UsageStats, opts: ObsRenderOpts): string {
  const C = makeColorer(opts.color);
  const { width } = opts;
  const out: string[] = [];

  out.push(
    headerLine(
      C,
      "olle cache",
      metaLine(opts.agent, stats.rows, "row", stats.window.since),
      width,
    ),
  );
  out.push("");

  if (stats.byModel.length === 0) {
    out.push(C(ANSI.text, "No cache activity recorded yet."));
    out.push("");
    const spans: Span[] =
      stats.window.since != null
        ? [
            { code: ANSI.muted, text: `Nothing cached in the ${windowLabel(stats.window.since)} window. Widen it with ` },
            { code: ANSI.text, text: "olle cache --since 7d", nowrap: true },
            { code: ANSI.muted, text: ", or drop --since for all time." },
          ]
        : [
            { code: ANSI.muted, text: "Nothing on this host has cached tokens yet. Open a chat with " },
            { code: ANSI.text, text: "olle chat", nowrap: true },
            { code: ANSI.muted, text: " — prompt caching turns on automatically." },
          ];
    for (const line of wrapSpans(C, spans, width)) out.push(line);
    return out.join("\n");
  }

  const t = stats.totals;
  const ratio = t.cacheHitRatio;
  const barW = Math.min(24, Math.max(10, width - 22));
  const b = bar(ratio, barW);
  out.push(
    C(ANSI.dim, "Cache".padEnd(8)) +
      C(ANSI.bold + hiColor(ratio), `${Math.round(ratio * 100)}%`) +
      " hit   " +
      C(hiColor(ratio), b.filled) +
      C(ANSI.border, b.empty),
  );
  // Plain-English gloss: read = cheap cache reads, write = one-time cache
  // setup, fresh input = uncached prompt. Drop the last clause if it won't fit.
  const counts =
    `${formatTokens(t.cacheReadTokens)} read · ` +
    `${formatTokens(t.cacheCreationTokens)} write`;
  const inputClause = ` · ${formatTokens(t.inputTokens)} fresh input`;
  const gloss = 9 + counts.length + inputClause.length <= width ? counts + inputClause : counts;
  out.push(" ".repeat(9) + C(ANSI.muted, gloss));
  out.push("");

  out.push(heading(C, "By model"));
  const models = [...stats.byModel].sort((a, b) => b.cacheReadTokens - a.cacheReadTokens);
  const columns: Column<(typeof models)[number]>[] = [
    {
      cell: (m) => `${m.provider}/${m.model}`,
      color: (m) => (m.pricePosted ? ANSI.text : ANSI.muted),
      flex: true,
      min: 12,
    },
    {
      cell: (m) => hitLabel(m.inputTokens, m.cacheReadTokens),
      color: (m) => hitColorFor(m.inputTokens, m.cacheReadTokens),
      align: "right",
    },
    { cell: (m) => `${formatTokens(m.cacheReadTokens)} read`, color: ANSI.text, align: "right" },
    {
      cell: (m) => `${formatTokens(m.cacheCreationTokens)} write`,
      color: ANSI.muted,
      align: "right",
    },
  ];
  out.push(...table(C, models, columns, { width, indent: "  ", gap: "  " }));

  return out.join("\n");
}

/** Per-model hit as "92% hit", or "— hit" when caching doesn't apply (no
 *  input and no reads — e.g. a no-cache provider call). */
function hitLabel(input: number, cacheRead: number): string {
  const denom = input + cacheRead;
  if (denom === 0) return "— hit";
  return `${Math.round((cacheRead / denom) * 100)}% hit`;
}

function hitColorFor(input: number, cacheRead: number): string {
  const denom = input + cacheRead;
  if (denom === 0) return ANSI.muted;
  return hiColor(cacheRead / denom);
}

// -------------------------------------------------------------------------
// runs — task-run history. Status glyphs, a rollup header, relative ages,
// humanized durations, clipped error tails.
// -------------------------------------------------------------------------

const RUN_GLYPH: Record<string, { glyph: string; color: string }> = {
  succeeded: { glyph: "✓", color: ANSI.success },
  failed: { glyph: "✗", color: ANSI.error },
  running: { glyph: "⏵", color: ANSI.info },
  queued: { glyph: "⏸", color: ANSI.muted },
  lost: { glyph: "?", color: ANSI.warning },
};

function runGlyph(status: string): { glyph: string; color: string } {
  return RUN_GLYPH[status] ?? { glyph: "·", color: ANSI.muted };
}

/** Sub-second durations keep ms; seconds get one decimal; longer falls back
 *  to the compact relative form (2m/3h). */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return fmtAge(ms);
}

export function renderRuns(runs: RunHistoryRow[], opts: ObsRenderOpts): string {
  const C = makeColorer(opts.color);
  const { width } = opts;
  const out: string[] = [];

  out.push(
    headerLine(C, "olle runs", metaLine(opts.agent, runs.length, "run", opts.since), width),
  );
  out.push("");

  if (runs.length === 0) {
    out.push(C(ANSI.text, "No task runs yet."));
    out.push("");
    const spans: Span[] = [
      { code: ANSI.muted, text: "Tasks fire when a trigger matches an event. Schedule a standing job in " },
      { code: ANSI.text, text: "olle chat", nowrap: true },
      { code: ANSI.muted, text: ", or watch activity with " },
      { code: ANSI.text, text: "olle events", nowrap: true },
      { code: ANSI.muted, text: "." },
    ];
    for (const line of wrapSpans(C, spans, width)) out.push(line);
    return out.join("\n");
  }

  // Rollup: one colored glyph+count per status present, in a fixed order.
  const counts: Record<string, number> = {};
  for (const r of runs) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const rollup: string[] = [];
  for (const status of ["succeeded", "failed", "running", "queued", "lost"]) {
    const n = counts[status];
    if (!n) continue;
    const g = runGlyph(status);
    rollup.push(C(g.color, `${g.glyph} ${n} ${status}`));
  }
  if (rollup.length > 0) {
    out.push("  " + rollup.join(C(ANSI.muted, " · ")));
    out.push("");
  }

  const now = Date.now();
  const columns: Column<RunHistoryRow>[] = [
    { cell: (r) => runGlyph(r.status).glyph, color: (r) => runGlyph(r.status).color },
    { cell: (r) => shortId(r.taskId), color: ANSI.muted },
    { cell: (r) => fmtAge(now - r.startedAt), color: ANSI.muted, align: "right" },
    {
      cell: (r) => (r.durationMs != null ? fmtDuration(r.durationMs) : "running"),
      color: (r) => (r.durationMs != null ? ANSI.text : ANSI.info),
      align: "right",
    },
    // Error tail flexes into whatever's left and clips; empty on success.
    { cell: (r) => (r.error ? sanitize(r.error) : ""), color: ANSI.error, flex: true, min: 0 },
  ];
  out.push(...table(C, runs, columns, { width, indent: "  ", gap: "  " }));

  return out.join("\n");
}

// -------------------------------------------------------------------------
// threads — what a human recognizes a conversation by: its opening line,
// live context size, age, cache hit, and a short id to reconnect with.
// -------------------------------------------------------------------------

export function renderThreads(threads: ThreadInventoryRow[], opts: ObsRenderOpts): string {
  const C = makeColorer(opts.color);
  const { width } = opts;
  const out: string[] = [];

  out.push(
    headerLine(
      C,
      "olle threads",
      metaLine(opts.agent, threads.length, "thread", undefined, false),
      width,
    ),
  );
  out.push("");

  if (threads.length === 0) {
    out.push(C(ANSI.text, "No conversations yet."));
    out.push("");
    const spans: Span[] = [
      { code: ANSI.muted, text: "Start one with " },
      { code: ANSI.text, text: "olle chat", nowrap: true },
      { code: ANSI.muted, text: " and it shows up here: opening line, context size, and cache hit." },
    ];
    for (const line of wrapSpans(C, spans, width)) out.push(line);
    return out.join("\n");
  }

  const now = Date.now();
  const columns: Column<ThreadInventoryRow>[] = [
    {
      // Opening line is the human-recognizable label; fall back to the last
      // event type when the thread carries no user text (e.g. a mail wake).
      cell: (t) => (t.firstUserText ? `"${sanitize(t.firstUserText)}"` : t.lastType),
      color: (t) => (t.firstUserText ? ANSI.text : ANSI.muted),
      flex: true,
      min: 16,
    },
    {
      cell: (t) => (t.contextTokens > 0 ? `${formatTokens(t.contextTokens)} ctx` : "— ctx"),
      color: ANSI.muted,
      align: "right",
    },
    { cell: (t) => fmtAge(now - t.lastEventAt), color: ANSI.muted, align: "right" },
    {
      cell: (t) => (t.turns > 0 ? `${Math.round(t.cacheHitRatio * 100)}% hit` : "— hit"),
      color: (t) => (t.turns > 0 ? hiColor(t.cacheHitRatio) : ANSI.muted),
      align: "right",
    },
    { cell: (t) => shortId(t.threadId), color: ANSI.muted },
  ];
  out.push(...table(C, threads, columns, { width, indent: "  ", gap: "  " }));

  return out.join("\n");
}

// -------------------------------------------------------------------------
// events / tail — one event per line. renderEventLine is the shared per-line
// renderer: `olle events` maps it over a batch, `olle tail` calls it per
// streamed event, so both look byte-identical line for line.
// -------------------------------------------------------------------------

/** Minimal event shape the line renderer reads. Both the bus `Event` (tail)
 *  and `RecentEventRow` (events) satisfy it structurally. */
export interface EventLineData {
  type: string;
  actorId: string;
  createdAt: number;
  payload: unknown;
}

// Stable event-family → color map. A family is the segment before the first
// dot; anything unrecognized renders in plain text.
const FAMILY_COLOR: Record<string, string> = {
  chat: ANSI.secondary,
  task: ANSI.primary,
  schedule: ANSI.accent,
  mesh: ANSI.info,
  memory: ANSI.success,
  decision: ANSI.warning,
  scope: ANSI.warning,
  tool: ANSI.info,
  team: ANSI.info,
};

function familyColor(type: string): string {
  const family = type.slice(0, type.indexOf(".") === -1 ? type.length : type.indexOf("."));
  return FAMILY_COLOR[family] ?? ANSI.text;
}

/** One-line payload summary: compact JSON with whitespace collapsed. The
 *  caller clips it to the remaining width — full JSON only when it fits,
 *  never wrapped. Handles the truncated-marker payload shape too. */
function payloadSummary(payload: unknown): string {
  if (payload == null) return "";
  if (typeof payload !== "object") return sanitize(String(payload));
  const p = payload as Record<string, unknown>;
  if (p._truncated === true && typeof p._preview === "string") {
    return sanitize(p._preview) + "…";
  }
  try {
    return sanitize(JSON.stringify(payload));
  } catch {
    return "";
  }
}

// Per-line column widths, a pure function of terminal width so tail and
// events (which pass the same width) align identically. Narrow terminals get
// tighter type/actor columns; the payload absorbs the rest.
function eventCols(width: number): { age: number; type: number; actor: number; payload: number } {
  const age = 4;
  const type = width >= 90 ? 26 : 18;
  const actor = width >= 90 ? 14 : 10;
  const gaps = 6; // three 2-space gaps
  const payload = Math.max(0, width - age - type - actor - gaps);
  return { age, type, actor, payload };
}

export function renderEventLine(C: Colorer, ev: EventLineData, width: number): string {
  const cols = eventCols(width);
  const now = Date.now();

  const agePlain = clip(fmtAge(now - ev.createdAt), cols.age).padStart(cols.age);
  let typePlain = ev.type;
  if (typePlain.length > cols.type) typePlain = clip(typePlain, cols.type);
  typePlain = typePlain.padEnd(cols.type);
  const actorPlain = clip(shortId(ev.actorId), cols.actor).padEnd(cols.actor);
  const payloadPlain = clip(payloadSummary(ev.payload), cols.payload);

  return (
    C(ANSI.muted, agePlain) +
    "  " +
    C(familyColor(ev.type), typePlain) +
    "  " +
    C(ANSI.muted, actorPlain) +
    "  " +
    C(ANSI.muted, payloadPlain)
  );
}

export function renderEvents(events: RecentEventRow[], opts: ObsRenderOpts): string {
  const C = makeColorer(opts.color);
  const { width } = opts;
  const out: string[] = [];

  out.push(
    headerLine(C, "olle events", metaLine(opts.agent, events.length, "event", opts.since), width),
  );
  out.push("");

  if (events.length === 0) {
    out.push(C(ANSI.text, "No events match yet."));
    out.push("");
    const spans: Span[] = [
      { code: ANSI.muted, text: "Widen the window with " },
      { code: ANSI.text, text: "olle events --since 7d", nowrap: true },
      { code: ANSI.muted, text: ", drop --type, or stream live with " },
      { code: ANSI.text, text: "olle tail", nowrap: true },
      { code: ANSI.muted, text: "." },
    ];
    for (const line of wrapSpans(C, spans, width)) out.push(line);
    return out.join("\n");
  }

  for (const e of events) out.push(renderEventLine(C, e, width));
  return out.join("\n");
}

// --- local helpers --------------------------------------------------------

/** Collapse all whitespace runs to single spaces so a value stays on one
 *  line (payloads and error tails may carry embedded newlines). */
function sanitize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
