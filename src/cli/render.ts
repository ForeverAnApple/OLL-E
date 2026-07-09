// Shared rendering primitives for the `olle` CLI. Pure string builders —
// no IO, no process access, no daemon. Every command renderer (stats, and
// the rest of the CLI as it adopts this visual language) imports from here
// so the whole surface reads as one painting rather than a quilt.
//
// Rendering technique — plain-pad-then-color: build every aligned cell as a
// PLAIN string, compute widths and padding on those plain strings, and ONLY
// THEN wrap each cell in color(). ANSI escapes are zero-width, so columns
// stay aligned identically with or without color. Never measure a string
// that already contains an escape — use vlen()/padVisible() for the rare
// case where a value arrives pre-colored (the inbox listing).

import { ANSI } from "./theme.ts";

// --- color gating --------------------------------------------------------

/** Wrap a span in an ANSI code (closed with reset), or return it plain. A
 *  colorer is gated once on the color flag so styled spans degrade to plain
 *  text under non-TTY / NO_COLOR without a branch at each call site. */
export type Colorer = (code: string, s: string) => string;

export function makeColorer(color: boolean): Colorer {
  return (code, s) => (color ? `${code}${s}${ANSI.reset}` : s);
}

// --- number / label formatting -------------------------------------------

/** Humanize a token count. Billions tier included so 1e9 doesn't render as
 *  "1000.0M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

/** Adaptive USD precision: sub-dollar dev bills keep up to 4dp so they stay
 *  meaningful (trailing zeros trimmed to at least 2dp — "$0.59", not
 *  "$0.5900"); dollars use 2dp; thousands get comma grouping. */
export function fmtUsdSmart(micros: number): string {
  if (micros === 0) return "$0.00";
  const d = micros / 1_000_000;
  if (d < 1) return `$${d.toFixed(4).replace(/0{1,2}$/, "")}`;
  if (d < 1000) return `$${d.toFixed(2)}`;
  return `$${d.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function intComma(n: number): string {
  return n.toLocaleString("en-US");
}

export function fmtPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

/** Compact relative duration: 5s / 2m / 3h / 4d. */
export function fmtAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/** First 10 chars of a ULID — enough to recognize, short enough to tabulate.
 *  Returns the plain slice; the caller wraps it in ANSI.muted. */
export function shortId(id: string): string {
  return id.slice(0, 10);
}

// --- plain-string clipping -----------------------------------------------

/** Head-keeping ellipsis on a PLAIN (un-colored) string. */
export function clip(s: string, width: number): string {
  if (s.length <= width) return s;
  return s.slice(0, Math.max(0, width - 1)) + "…";
}

/** Visible length of a string that MAY contain ANSI escapes. */
export function vlen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Head-keeping ellipsis that measures visible width, tolerating embedded
 *  ANSI escapes (strips them when it has to cut). */
export function clipPlain(s: string, width: number): string {
  if (vlen(s) <= width) return s;
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  return plain.slice(0, Math.max(0, width - 1)) + "…";
}

/** Right-pad to a visible width, clipping if already over. Safe on strings
 *  that already carry ANSI escapes. */
export function padVisible(s: string, width: number): string {
  const n = vlen(s);
  if (n >= width) return clipPlain(s, width);
  return s + " ".repeat(width - n);
}

/** Greedy word-wrap a plain paragraph to a column width. Preserves blank
 *  lines; never splits a word (long words overflow rather than break). */
export function wrap(text: string, width: number): string[] {
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

/** One colored run inside a wrapped paragraph. Spans concatenate with no
 *  inserted whitespace — put the spaces in the text. Mark `nowrap` on a
 *  command span ("olle chat") so it packs as a single token and never breaks
 *  mid-command across a line boundary. */
export interface Span {
  code?: string;
  text: string;
  nowrap?: boolean;
}

/** Word-wrap a run of colored spans to a visible width, preserving each
 *  character's color across line breaks. Never splits a word (a word longer
 *  than the width overflows its own line rather than breaking); a `nowrap`
 *  span stays whole. Used for the humane empty states whose prose carries an
 *  inline colored command. */
export function wrapSpans(C: Colorer, spans: Span[], width: number): string[] {
  if (width < 10) width = 10;
  // Flatten to a plain string with parallel per-code-point color and
  // break-opportunity arrays, so wrapping math runs on visible characters
  // (never escapes) and never breaks inside a nowrap span.
  let plain = "";
  const codes: (string | undefined)[] = [];
  const breakable: boolean[] = [];
  for (const sp of spans) {
    for (const ch of sp.text) {
      plain += ch;
      codes.push(sp.code);
      breakable.push(!sp.nowrap && /\s/.test(ch));
    }
  }
  const renderWord = (start: number, end: number): string => {
    let out = "";
    let j = start;
    while (j < end) {
      const code = codes[j];
      let k = j;
      while (k < end && codes[k] === code) k++;
      const seg = plain.slice(j, k);
      out += code ? C(code, seg) : seg;
      j = k;
    }
    return out;
  };

  // Tokenize: split only at breakable whitespace (dropped); non-breakable
  // whitespace stays inside its token.
  const tokens: Array<{ start: number; end: number }> = [];
  let i = 0;
  const n = plain.length;
  while (i < n) {
    if (breakable[i]) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && !breakable[i]) i++;
    tokens.push({ start, end: i });
  }

  const lines: string[] = [];
  let cur = "";
  let curLen = 0;
  for (const t of tokens) {
    const wlen = t.end - t.start;
    if (curLen === 0) {
      cur = renderWord(t.start, t.end);
      curLen = wlen;
    } else if (curLen + 1 + wlen <= width) {
      cur += " " + renderWord(t.start, t.end);
      curLen += 1 + wlen;
    } else {
      lines.push(cur);
      cur = renderWord(t.start, t.end);
      curLen = wlen;
    }
  }
  if (curLen > 0) lines.push(cur);
  return lines;
}

// --- bars & threshold colors ---------------------------------------------

/** Split a bar of the given width into filled (█) and empty (░) runs at the
 *  given ratio. Ratio is clamped to [0,1]. */
export function bar(ratio: number, width: number): { filled: string; empty: string } {
  const k = Math.round(Math.max(0, Math.min(1, ratio)) * width);
  return { filled: "█".repeat(k), empty: "░".repeat(width - k) };
}

/** Higher-is-better threshold color (cache hit, success rates). */
export function hiColor(ratio: number): string {
  return ratio >= 0.7 ? ANSI.success : ratio >= 0.4 ? ANSI.warning : ANSI.error;
}

/** Lower-is-better threshold color (budget burn). Thresholds match the
 *  80%/100% inbox auto-post thresholds — the visual state flips exactly
 *  where the system already acts. */
export function loColor(ratio: number): string {
  return ratio < 0.8 ? ANSI.success : ratio < 1.0 ? ANSI.warning : ANSI.error;
}

// --- composite primitives ------------------------------------------------

/** A section heading: bold secondary text, with an optional muted " · meta"
 *  suffix (e.g. `Budget · agent oz`). */
export function heading(C: Colorer, text: string, meta?: string): string {
  const head = C(ANSI.secondary + ANSI.bold, text);
  return meta ? head + C(ANSI.muted, ` · ${meta}`) : head;
}

/** The top-of-command header: dim command name on the left, muted meta on
 *  the right, right-aligned to `width`. Stacks onto two lines when they
 *  won't fit side by side. */
export function headerLine(
  C: Colorer,
  left: string,
  rightMeta: string,
  width: number,
): string {
  const leftStyled = C(ANSI.dim, left);
  const gap = width - left.length - rightMeta.length;
  if (gap >= 1) {
    return leftStyled + " ".repeat(gap) + C(ANSI.muted, rightMeta);
  }
  return leftStyled + "\n" + C(ANSI.muted, rightMeta);
}

/** An aligned dim-label row: `label   value`. The label is padded (plain)
 *  to `labelWidth` before coloring so a column of them lines up. */
export function kv(
  C: Colorer,
  label: string,
  value: string,
  labelWidth = 8,
): string {
  return C(ANSI.dim, label.padEnd(labelWidth)) + value;
}

/** A humane empty state: one plain sentence, then the exact command to
 *  change the situation. Never a bare "(none)". Pass `width` to wrap the
 *  sentence so a longer one never overflows a narrow terminal. */
export function emptyState(
  C: Colorer,
  sentence: string,
  suggestedCommand?: string,
  width?: number,
): string {
  const body =
    width != null
      ? wrap(sentence, width)
          .map((l) => C(ANSI.text, l))
          .join("\n")
      : C(ANSI.text, sentence);
  if (!suggestedCommand) return body;
  return body + "\n" + C(ANSI.muted, "Try ") + C(ANSI.text, suggestedCommand);
}

/** One column of a `table`. Cells are produced as PLAIN strings; the column
 *  is sized to its widest cell, then each cell is padded and colored. */
export interface Column<R> {
  /** Plain-string value for a row. */
  cell: (row: R) => string;
  /** ANSI code for every cell in the column, or a per-row function. Omit
   *  for uncolored text. */
  color?: string | ((row: R) => string);
  /** Padding side. Numeric columns want "right"; the default is "left". */
  align?: "left" | "right";
  /** At most one column may flex: it absorbs the width left over after the
   *  fixed columns and gaps, and clips its cells to fit. */
  flex?: boolean;
  /** Minimum width for a flex column. */
  min?: number;
}

/** Render aligned rows using plain-pad-then-color. Fixed columns size to
 *  their widest plain cell; an optional flex column takes the remaining
 *  width (clamped to its `min`) so the whole line fits `opts.width`. */
export function table<R>(
  C: Colorer,
  rows: R[],
  columns: Column<R>[],
  opts: { width: number; indent?: string; gap?: string },
): string[] {
  const indent = opts.indent ?? "";
  const gap = opts.gap ?? "   ";
  const plain = rows.map((r) => columns.map((c) => c.cell(r)));

  const widths = columns.map((c, ci) =>
    c.flex ? 0 : plain.reduce((w, row) => Math.max(w, row[ci]!.length), 0),
  );

  const flexIdx = columns.findIndex((c) => c.flex);
  if (flexIdx >= 0) {
    const fixed = widths.reduce((a, b) => a + b, 0);
    const gaps = gap.length * (columns.length - 1);
    const avail = opts.width - indent.length - fixed - gaps;
    widths[flexIdx] = Math.max(columns[flexIdx]!.min ?? 0, avail);
  }

  return rows.map((r, ri) => {
    const cells = columns.map((c, ci) => {
      const w = widths[ci]!;
      let text = plain[ri]![ci]!;
      if (text.length > w) text = clip(text, w);
      const pad = " ".repeat(Math.max(0, w - text.length));
      const padded = c.align === "right" ? pad + text : text + pad;
      const code = typeof c.color === "function" ? c.color(r) : c.color;
      return code ? C(code, padded) : padded;
    });
    return indent + cells.join(gap);
  });
}
