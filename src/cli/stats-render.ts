// Pure renderer for `olle stats`. Takes the observability query results
// and returns a finished string — no IO, no daemon, no process access.
// cmdStats (src/cli/run.ts) fetches over IPC, computes width/color from
// the live terminal, then prints what this returns. Keeping it pure makes
// the whole layout testable without a running daemon.
//
// Rendering technique — plain-pad-then-color: every aligned cell is built
// as a PLAIN string, widths and padding are computed on those plain
// strings, and ONLY THEN is each cell wrapped in color(). Because the ANSI
// escapes are zero-width, columns stay aligned identically with or without
// color. So there is no vlen/padVisible math here — padding is always done
// before any escape is added.
//
// Generic formatting/bar primitives live in render.ts (shared across the
// CLI); this module keeps only the stats-specific layout.

import { ANSI } from "./theme.ts";
import {
  bar,
  clip,
  fmtAge,
  fmtUsdSmart,
  formatTokens,
  hiColor,
  intComma,
  loColor,
  wrap,
  wrapSpans,
  type Colorer,
} from "./render.ts";
import type { BudgetStatus, UsageStats } from "../observability/index.ts";

// run.ts and test/stats-render.test.ts import formatTokens from here.
export { formatTokens, fmtUsdSmart };

export interface StatsRenderOpts {
  width: number;
  color: boolean;
  /** The --agent flag value, if the human scoped the query. Drives the
   *  scope label and whether the budget section is eligible. */
  agent?: string;
}

// --- stats-specific labels -----------------------------------------------

function windowLabel(since?: number): string {
  return since == null ? "all time" : `last ${fmtAge(Date.now() - since)}`;
}

function rowsLabel(rows: number, limit = 5000): string {
  if (rows === limit) return "5,000+ rows (scan capped)";
  return `${intComma(rows)} ${rows === 1 ? "row" : "rows"}`;
}

/** Cache hit as a per-model cell: "—" when caching doesn't apply (no input
 *  and no cache reads, e.g. a no-cache OpenAI call) so it never reads as a
 *  broken "0%". */
function hitCell(input: number, cacheRead: number): string {
  const denom = input + cacheRead;
  if (denom === 0) return "—";
  return `${Math.round((cacheRead / denom) * 100)}%`;
}

// -------------------------------------------------------------------------

export function renderStats(
  stats: UsageStats,
  budget: BudgetStatus | undefined,
  opts: StatsRenderOpts,
): string {
  const { width } = opts;
  // Local colorer: gated once here, so every styled span degrades to plain
  // text under non-TTY / NO_COLOR without a branch at each call site.
  const C = (code: string, s: string): string => (opts.color ? `${code}${s}${ANSI.reset}` : s);

  const out: string[] = [];
  const since = stats.window.since;

  // --- header (always prints, including the empty state) ---
  const scopeLabel = opts.agent ? `agent ${opts.agent}` : "all agents";
  const metaPlain = `${windowLabel(since)} · ${scopeLabel} · ${rowsLabel(stats.rows)}`;
  const leftPlain = "olle stats";
  const leftStyled = C(ANSI.dim, leftPlain);
  const gap = width - leftPlain.length - metaPlain.length;
  if (gap >= 1) {
    out.push(leftStyled + " ".repeat(gap) + C(ANSI.muted, metaPlain));
  } else {
    out.push(leftStyled);
    out.push(C(ANSI.muted, metaPlain));
  }
  out.push("");

  if (stats.byModel.length === 0) {
    renderEmpty(out, C, width, since);
  } else {
    renderSpend(out, C, stats);
    renderCache(out, C, stats, width);
    renderByModel(out, C, stats, width);
  }

  const budgetRendered =
    budget != null && opts.agent != null && budget.rows.length > 0;
  if (budgetRendered) {
    renderBudget(out, C, budget!, opts.agent!, width);
  }

  // Fallback footnote — only meaningful when models rendered.
  if (stats.byModel.some((m) => !m.pricePosted)) {
    for (const line of wrap("~ estimated at a fallback rate — no posted price for this model", width)) {
      out.push(C(ANSI.muted, line));
    }
  }

  return out.join("\n");
}

function renderSpend(out: string[], C: Colorer, stats: UsageStats): void {
  const t = stats.totals;
  out.push(
    C(ANSI.dim, "Spend".padEnd(8)) +
      C(ANSI.bold + ANSI.primary, fmtUsdSmart(t.usdMicros)),
  );
  out.push(
    C(ANSI.dim, "Tokens".padEnd(8)) +
      C(ANSI.text, formatTokens(t.totalTokens)) +
      C(ANSI.muted, " total   ·   in ") +
      C(ANSI.text, formatTokens(t.inputTokens)) +
      C(ANSI.muted, "  out ") +
      C(ANSI.text, formatTokens(t.outputTokens)),
  );
  out.push("");
}

function renderCache(out: string[], C: Colorer, stats: UsageStats, width: number): void {
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
  // Plain-English gloss — what makes hit ratio legible to a non-billing
  // reader: reused = cheap cache reads, newly cached = one-time setup cost.
  // The price explainer is educational, not data — drop it before wrapping.
  const counts = `${formatTokens(t.cacheReadTokens)} reused · ${formatTokens(
    t.cacheCreationTokens,
  )} newly cached`;
  const explainer = " · cache reads cost ~1/10 of fresh input";
  const gloss =
    9 + counts.length + explainer.length <= width ? counts + explainer : counts;
  out.push(" ".repeat(9) + C(ANSI.muted, gloss));
  out.push("");
}

const SEP = "   ";

function renderByModel(out: string[], C: Colorer, stats: UsageStats, width: number): void {
  out.push(C(ANSI.secondary + ANSI.bold, "By model"));

  // The human asked "what did I spend on" — sort by cost, not tokens.
  const models = [...stats.byModel].sort((a, b) => b.usdMicros - a.usdMicros);
  const wide = width >= 72;

  // Build plain cells, then size each numeric column to its widest plain form.
  const cells = models.map((m) => ({
    m,
    callsPlain: `${intComma(m.calls)} calls`,
    callsNum: intComma(m.calls),
    tokensPlain: formatTokens(m.totalTokens),
    hitPlain: `${hitCell(m.inputTokens, m.cacheReadTokens)} hit`,
    costPlain: fmtUsdSmart(m.usdMicros),
  }));

  const callsW = Math.max(...cells.map((c) => c.callsPlain.length));
  const tokensW = Math.max(...cells.map((c) => c.tokensPlain.length));
  const hitW = Math.max(...cells.map((c) => c.hitPlain.length));
  const costW = Math.max(...cells.map((c) => c.costPlain.length));

  const rightW = wide
    ? callsW + SEP.length + tokensW + SEP.length + hitW + SEP.length + costW
    : hitW + SEP.length + costW;
  // A fallback-priced row trails a " ~" (2 cols) past the cost column; reserve
  // it so the widest possible line still fits the terminal.
  const tildeReserve = cells.some((c) => !c.m.pricePosted) ? 2 : 0;
  const modelColW = Math.max(12, width - 2 - SEP.length - rightW - tildeReserve);

  for (const c of cells) {
    const m = c.m;
    let name = `${m.provider}/${m.model}`;
    if (name.length > modelColW) name = m.model; // drop provider — recoverable
    if (name.length > modelColW) name = clip(name, modelColW);
    const modelRender = C(m.pricePosted ? ANSI.text : ANSI.muted, name.padEnd(modelColW));

    // calls: number in text, unit muted.
    const callsRender =
      " ".repeat(callsW - c.callsPlain.length) +
      C(ANSI.text, c.callsNum) +
      C(ANSI.muted, " calls");
    // tokens: number in text.
    const tokensRender =
      " ".repeat(tokensW - c.tokensPlain.length) + C(ANSI.text, c.tokensPlain);
    // hit: whole cell muted — the totals bar is the headline cache signal,
    // rows stay calm.
    const hitRender =
      " ".repeat(hitW - c.hitPlain.length) + C(ANSI.muted, c.hitPlain);
    // cost: money pops; fallback price flagged with a trailing "~".
    const costRender =
      " ".repeat(costW - c.costPlain.length) +
      C(ANSI.primary, c.costPlain) +
      (m.pricePosted ? "" : C(ANSI.warning, " ~"));

    const line = wide
      ? "  " +
        modelRender +
        SEP +
        callsRender +
        SEP +
        tokensRender +
        SEP +
        hitRender +
        SEP +
        costRender
      : "  " + modelRender + SEP + hitRender + SEP + costRender;
    out.push(line);
  }
  out.push("");
}

function renderBudget(
  out: string[],
  C: Colorer,
  budget: BudgetStatus,
  agent: string,
  width: number,
): void {
  out.push(C(ANSI.secondary + ANSI.bold, "Budget") + C(ANSI.muted, ` · agent ${agent}`));
  const SPENT_CAP_W = 17;
  // Line = indent(2) + period(9) + scW(17) + gap(2) + bar + gap(2) + pct(4)
  //      + gap(3) + "$X left". Reserve the widest "left" so the bar never
  //      pushes a capped row past the terminal edge.
  const leftMax = Math.max(
    0,
    ...budget.rows.map((r) =>
      r.capUsd != null ? `${fmtUsdSmart(Math.max(0, r.capUsd - r.spentUsd))} left`.length : 0,
    ),
  );
  const barW = Math.max(4, Math.min(20, width - (2 + 9 + SPENT_CAP_W + 2 + 2 + 4 + 3 + leftMax)));

  for (const r of budget.rows) {
    const periodLabel = C(ANSI.dim, r.period.padEnd(9));
    const capPlain = r.capUsd != null ? fmtUsdSmart(r.capUsd) : "no cap";
    const spentPlain = fmtUsdSmart(r.spentUsd);
    const scPlain = `${spentPlain} / ${capPlain}`;
    const scPad = " ".repeat(Math.max(0, SPENT_CAP_W - scPlain.length));
    const scRender =
      C(ANSI.text, spentPlain) +
      C(ANSI.muted, " / ") +
      C(r.capUsd != null ? ANSI.text : ANSI.muted, capPlain) +
      scPad;

    let tail: string;
    if (r.capUsd != null) {
      const pct = r.percentUsd ?? 0;
      const b = bar(pct, barW);
      const lc = loColor(pct);
      const pctStr = `${Math.round(pct * 100)}%`.padStart(4);
      const leftStr = `${fmtUsdSmart(Math.max(0, r.capUsd - r.spentUsd))} left`;
      tail =
        C(lc, b.filled) +
        C(ANSI.border, b.empty) +
        "  " +
        C(lc, pctStr) +
        "   " +
        C(lc, leftStr);
    } else {
      tail = C(ANSI.muted, "no cap");
    }

    out.push("  " + periodLabel + scRender + "  " + tail);
  }
  out.push("");
}

function renderEmpty(out: string[], C: Colorer, width: number, since?: number): void {
  out.push(C(ANSI.text, "No spend recorded yet."));
  out.push("");
  const spans =
    since != null
      ? [
          { code: ANSI.muted, text: `Nothing has used tokens in the ${windowLabel(since)} window. Widen it with ` },
          { code: ANSI.text, text: "olle stats --since 7d", nowrap: true },
          { code: ANSI.muted, text: ", or drop --since for all time." },
        ]
      : [
          { code: ANSI.muted, text: "Nothing on this host has used tokens yet. Open a chat with " },
          { code: ANSI.text, text: "olle chat", nowrap: true },
          { code: ANSI.muted, text: " and this fills in: spend, model breakdown, and cache savings." },
        ];
  for (const line of wrapSpans(C, spans, width)) out.push(line);
  out.push("");
}
