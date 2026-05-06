// Tiny markdown → ANSI renderer for `olle chat`. Walks marked's token
// tree and emits styled terminal lines for what a streaming CLI needs:
// headings, bold/italic, inline + fenced code, lists, blockquotes, links,
// tables, and hr.
//
// Lines are returned without the assistant block's "  " indent —
// the caller is expected to prefix it. This keeps wrapping logic in
// one place (the chat UI), and lets non-chat callers reuse the renderer.

import { marked, type Token, type Tokens } from "marked";
import { highlightCodeLine, normalizeLang } from "./highlight.ts";
import { ANSI } from "./theme.ts";

export interface Theme {
  heading(text: string, level: number): string;
  bold(text: string): string;
  italic(text: string): string;
  strike(text: string): string;
  code(text: string): string;
  codeBlock(text: string): string;
  codeFence(text: string): string;
  codeHighlight(text: string, lang: string): string;
  link(text: string, href: string): string;
  bullet(text: string): string;
  quoteBar: string;
  hr(width: number): string;
}

const defaultTheme: Theme = {
  heading: (text, level) => {
    const hash = `${ANSI.muted}${"#".repeat(level)}${ANSI.reset} `;
    return `${hash}${ANSI.bold}${ANSI.accent}${text}${ANSI.reset}`;
  },
  bold: (t) => `${ANSI.bold}${t}${ANSI.reset}`,
  italic: (t) => `${ANSI.italic}${t}${ANSI.reset}`,
  strike: (t) => `${ANSI.strike}${t}${ANSI.reset}`,
  code: (t) => `${ANSI.primary}${t}${ANSI.reset}`,
  codeBlock: (t) => `${ANSI.text}${t}${ANSI.reset}`,
  codeFence: (t) => `${ANSI.muted}${t}${ANSI.reset}`,
  codeHighlight: (text, lang) => highlightCodeLine(text, lang),
  link: (text, href) =>
    text === href
      ? `${ANSI.secondary}${ANSI.underline}${text}${ANSI.reset}`
      : `${ANSI.secondary}${ANSI.underline}${text}${ANSI.reset}${ANSI.muted} (${href})${ANSI.reset}`,
  bullet: (t) => `${ANSI.primary}${t}${ANSI.reset}`,
  quoteBar: `${ANSI.muted}│${ANSI.reset} `,
  hr: (w) => `${ANSI.muted}${"─".repeat(Math.min(w, 60))}${ANSI.reset}`,
};

export const plainTheme: Theme = {
  heading: (text, level) => `${"#".repeat(level)} ${text}`,
  bold: (t) => t,
  italic: (t) => t,
  strike: (t) => t,
  code: (t) => t,
  codeBlock: (t) => t,
  codeFence: (t) => t,
  codeHighlight: (text) => text,
  link: (text, href) => (text === href ? text : `${text} (${href})`),
  bullet: (t) => t,
  quoteBar: "> ",
  hr: (w) => "-".repeat(Math.min(w, 60)),
};

/** Strip ANSI escape sequences for visible-length math. */
const ESC_RE = /\x1b\[[0-9;]*m/g;
function visibleLen(s: string): number {
  return s.replace(ESC_RE, "").length;
}

/** Hard-wrap a styled line to `width` cells. ANSI codes are zero-width;
 *  we walk char-by-char and only break on whitespace once a candidate
 *  line is long enough. Falls back to mid-word break if a single token
 *  exceeds the width. */
function wrap(line: string, width: number): string[] {
  if (visibleLen(line) <= width) return [line];
  const out: string[] = [];
  let cur = "";
  let curLen = 0;
  let i = 0;
  while (i < line.length) {
    // Pass-through ANSI escape with no width cost.
    if (line[i] === "\x1b" && line[i + 1] === "[") {
      const end = line.indexOf("m", i);
      if (end !== -1) {
        cur += line.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    const ch = line[i++]!;
    cur += ch;
    if (ch !== "\n") curLen++;
    if (curLen >= width) {
      // Try to break at last whitespace.
      const lastSpace = cur.lastIndexOf(" ");
      if (lastSpace > 0 && visibleLen(cur.slice(0, lastSpace)) > 0) {
        out.push(cur.slice(0, lastSpace));
        cur = cur.slice(lastSpace + 1);
        curLen = visibleLen(cur);
      } else {
        out.push(cur);
        cur = "";
        curLen = 0;
      }
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function renderInline(tokens: Token[], theme: Theme): string {
  let out = "";
  for (const t of tokens) {
    switch (t.type) {
      case "text": {
        const tt = t as Tokens.Text;
        out += tt.tokens && tt.tokens.length > 0 ? renderInline(tt.tokens, theme) : tt.text;
        break;
      }
      case "strong":
        out += theme.bold(renderInline((t as Tokens.Strong).tokens || [], theme));
        break;
      case "em":
        out += theme.italic(renderInline((t as Tokens.Em).tokens || [], theme));
        break;
      case "del":
        out += theme.strike(renderInline((t as Tokens.Del).tokens || [], theme));
        break;
      case "codespan":
        out += theme.code((t as Tokens.Codespan).text);
        break;
      case "link": {
        const lt = t as Tokens.Link;
        const inner = renderInline(lt.tokens || [], theme) || lt.text;
        out += theme.link(inner, lt.href);
        break;
      }
      case "br":
        out += "\n";
        break;
      case "html":
        out += (t as Tokens.HTML).raw;
        break;
      default:
        if ("text" in t && typeof t.text === "string") out += t.text;
    }
  }
  return out;
}

function renderBlock(token: Token, width: number, theme: Theme): string[] {
  switch (token.type) {
    case "heading": {
      const h = token as Tokens.Heading;
      const text = renderInline(h.tokens || [], theme);
      return [theme.heading(text, h.depth), ""];
    }
    case "paragraph": {
      const p = token as Tokens.Paragraph;
      const text = renderInline(p.tokens || [], theme);
      return [...flowLines(text, width), ""];
    }
    case "code": {
      const c = token as Tokens.Code;
      const lang = normalizeLang(c.lang ?? "");
      const out = [theme.codeFence(`\`\`\`${c.lang ?? ""}`)];
      for (const ln of c.text.split("\n")) {
        out.push(lang ? theme.codeHighlight(ln, lang) : theme.codeBlock(ln));
      }
      out.push(theme.codeFence("```"));
      out.push("");
      return out;
    }
    case "table": {
      const t = token as Tokens.Table;
      return renderTable(t, width, theme);
    }
    case "list": {
      const l = token as Tokens.List;
      const out: string[] = [];
      const start = l.start || 1;
      for (let i = 0; i < l.items.length; i++) {
        const item = l.items[i]!;
        const bullet = l.ordered ? `${start + i}.` : "•";
        const itemText = renderInline(item.tokens?.[0]?.type === "text" ? (item.tokens[0] as Tokens.Text).tokens || [] : [], theme)
          || (item.text ?? "");
        const wrapped = flowLines(itemText, Math.max(1, width - bullet.length - 1));
        if (wrapped.length === 0) {
          out.push(`${theme.bullet(bullet)} `);
          continue;
        }
        out.push(`${theme.bullet(bullet)} ${wrapped[0]}`);
        for (let j = 1; j < wrapped.length; j++) {
          out.push(`${" ".repeat(bullet.length + 1)}${wrapped[j]}`);
        }
        // Render any nested blocks (nested lists, code, etc.) under the item.
        for (const child of item.tokens || []) {
          if (child.type === "text") continue;
          const childLines = renderBlock(child, Math.max(1, width - 2), theme);
          for (const cl of childLines) out.push(`  ${cl}`);
        }
      }
      out.push("");
      return out;
    }
    case "blockquote": {
      const q = token as Tokens.Blockquote;
      const inner: string[] = [];
      for (const child of q.tokens || []) {
        inner.push(...renderBlock(child, Math.max(1, width - 2), theme));
      }
      // Trim trailing blank inside the quote.
      while (inner.length > 0 && inner[inner.length - 1] === "") inner.pop();
      return [...inner.map((l) => `${theme.quoteBar}${l}`), ""];
    }
    case "hr":
      return [theme.hr(width), ""];
    case "space":
      return [""];
    case "html": {
      const h = token as Tokens.HTML;
      return [h.raw.trimEnd(), ""];
    }
    default:
      if ("text" in token && typeof token.text === "string") return [token.text, ""];
      return [];
  }
}

/** Render an inline-text string into width-respecting lines, splitting
 *  on existing newlines and wrapping each segment. */
function flowLines(text: string, width: number): string[] {
  const out: string[] = [];
  for (const seg of text.split("\n")) out.push(...wrap(seg, width));
  return out;
}

/** Pad a styled string with spaces to a target visible width. */
function padTo(s: string, width: number): string {
  const need = Math.max(0, width - visibleLen(s));
  return s + " ".repeat(need);
}

/** Render a markdown table as width-capped pipe rows. */
function renderTable(t: Tokens.Table, available: number, theme: Theme): string[] {
  const cols = t.header.length;
  if (cols === 0) return [];

  // Row overhead: "| " + (cols-1) * " | " + " |" = 3*cols + 1.
  const rowOverhead = 3 * cols + 1;
  const cellBudget = available - rowOverhead;
  if (cellBudget < cols) {
    return [...wrap(t.raw ?? "", available), ""];
  }

  const headerCells = t.header.map((h) => renderInline(h.tokens || [], theme));
  const rowCells = t.rows.map((row) => row.map((c) => renderInline(c.tokens || [], theme)));

  const natural = Array.from({ length: cols }, (_, i) =>
    Math.max(1, ...[headerCells[i] ?? "", ...rowCells.map((row) => row[i] ?? "")].map(visibleLen)),
  );
  let widths = natural.slice();
  const naturalTotal = widths.reduce((sum, w) => sum + w, 0);
  if (naturalTotal > cellBudget) {
    const even = Math.max(1, Math.floor(cellBudget / cols));
    widths = Array.from({ length: cols }, () => even);
    let leftover = cellBudget - even * cols;
    for (let i = 0; leftover > 0; i = (i + 1) % cols) {
      widths[i]!++;
      leftover--;
    }
  }

  const wrapCell = (cell: string, width: number) => flowLines(cell, width);
  const headerLines = headerCells.map((cell, i) => wrapCell(cell, widths[i]!));
  const rowsLines = rowCells.map((row) =>
    Array.from({ length: cols }, (_, i) => wrapCell(row[i] ?? "", widths[i]!)),
  );
  const dim = (s: string) => (theme === plainTheme ? s : `${ANSI.dim}${s}${ANSI.reset}`);
  const pipe = dim("|");
  const separator = `${pipe}${widths.map((w) => dim("-".repeat(w + 2))).join(pipe)}${pipe}`;
  const renderRow = (cells: string[][], lineIdx: number, header: boolean): string => {
    const parts = cells.map((cellLines, i) => {
      const text = padTo(cellLines[lineIdx] ?? "", widths[i]!);
      return header ? theme.bold(text) : text;
    });
    return `${pipe} ${parts.join(` ${pipe} `)} ${pipe}`;
  };

  const out: string[] = [];
  const headerHeight = Math.max(...headerLines.map((cell) => cell.length));
  for (let lineIdx = 0; lineIdx < headerHeight; lineIdx++) {
    out.push(renderRow(headerLines, lineIdx, true));
  }
  out.push(separator);
  for (const row of rowsLines) {
    const rowHeight = Math.max(...row.map((cell) => cell.length));
    for (let lineIdx = 0; lineIdx < rowHeight; lineIdx++) out.push(renderRow(row, lineIdx, false));
  }
  out.push("");
  return out;
}

/** Render markdown text to a list of ANSI-styled lines fitting `width`.
 *  Trailing blank lines are trimmed so the caller doesn't emit a sea
 *  of whitespace below short replies. */
export function renderMarkdown(text: string, width: number, theme: Theme = defaultTheme): string[] {
  const tokens = marked.lexer(text);
  const raw: string[] = [];
  for (const tok of tokens) raw.push(...renderBlock(tok, width, theme));
  // Collapse runs of blank lines to one — block emitters add a trailing
  // "" and marked also emits `space` tokens for blank lines in the
  // source, so we'd otherwise paint two-line gutters between blocks.
  const out: string[] = [];
  let prevBlank = false;
  for (const line of raw) {
    const blank = line === "";
    if (blank && prevBlank) continue;
    out.push(line);
    prevBlank = blank;
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}
