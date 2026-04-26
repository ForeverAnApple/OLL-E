// Tiny markdown → ANSI renderer for `olle chat`. Walks marked's token
// tree and emits styled terminal lines. Inspired by pi-mono's TUI
// component (references/pi-mono/packages/tui/src/components/markdown.ts)
// but stripped to what a streaming CLI actually needs: headings,
// bold/italic, inline + fenced code, lists, blockquotes, links, hr.
//
// Lines are returned without the assistant block's "  " indent —
// the caller is expected to prefix it. This keeps wrapping logic in
// one place (the chat UI), and lets non-chat callers reuse the renderer.

import { marked, type Token, type Tokens } from "marked";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  strike: "\x1b[9m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
};

interface Theme {
  heading(text: string, level: number): string;
  bold(text: string): string;
  italic(text: string): string;
  strike(text: string): string;
  code(text: string): string;
  codeBlock(text: string): string;
  codeFence(text: string): string;
  link(text: string, href: string): string;
  bullet(text: string): string;
  quoteBar: string;
  hr(width: number): string;
}

const defaultTheme: Theme = {
  heading: (text, level) => {
    const hash = `${ANSI.dim}${"#".repeat(level)}${ANSI.reset} `;
    return `${hash}${ANSI.bold}${ANSI.cyan}${text}${ANSI.reset}`;
  },
  bold: (t) => `${ANSI.bold}${t}${ANSI.reset}`,
  italic: (t) => `${ANSI.italic}${t}${ANSI.reset}`,
  strike: (t) => `${ANSI.strike}${t}${ANSI.reset}`,
  code: (t) => `${ANSI.magenta}${t}${ANSI.reset}`,
  codeBlock: (t) => `${ANSI.green}${t}${ANSI.reset}`,
  codeFence: (t) => `${ANSI.dim}${t}${ANSI.reset}`,
  link: (text, href) =>
    text === href
      ? `${ANSI.cyan}${ANSI.underline}${text}${ANSI.reset}`
      : `${ANSI.cyan}${ANSI.underline}${text}${ANSI.reset}${ANSI.dim} (${href})${ANSI.reset}`,
  bullet: (t) => `${ANSI.cyan}${t}${ANSI.reset}`,
  quoteBar: `${ANSI.dim}│${ANSI.reset} `,
  hr: (w) => `${ANSI.dim}${"─".repeat(Math.min(w, 60))}${ANSI.reset}`,
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
      const lang = c.lang ?? "";
      const out = [theme.codeFence(`\`\`\`${lang}`)];
      for (const ln of c.text.split("\n")) out.push(theme.codeBlock(ln));
      out.push(theme.codeFence("```"));
      out.push("");
      return out;
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
