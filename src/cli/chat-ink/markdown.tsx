// Markdown → Ink renderer. Walks marked's token AST and emits JSX
// instead of an ANSI string — Ink owns its own styling pipeline, so
// passing raw ANSI through <Text> would either get stripped or fight
// the measure-based layout in <Static>.
//
// Scope: the block + inline tokens you actually see in chat (headings,
// paragraphs with bold/italic/code/link, code blocks, lists, blockquotes,
// tables, hr). Images, definitions, footnotes, raw HTML — passed through
// as text since they're rare in agent output.

import { Box, Text } from "ink";
import { useMemo } from "react";
import { marked, type Token, type Tokens } from "marked";
import { theme, sym } from "./theme.ts";

export function Markdown({ source }: { source: string }): React.ReactElement {
  // <Static> renders each entry once so the lexer cost is paid once
  // per assistant message — but memoizing keeps that contract durable
  // if a future caller mounts Markdown outside Static.
  const tokens = useMemo(() => marked.lexer(source), [source]);
  return (
    <Box flexDirection="column">
      {tokens.map((tok, i) => <BlockToken key={i} token={tok} />)}
    </Box>
  );
}

function BlockToken({ token }: { token: Token }): React.ReactElement | null {
  switch (token.type) {
    case "space":      return null;
    case "heading":    return <Heading token={token as Tokens.Heading} />;
    case "paragraph":  return <Paragraph token={token as Tokens.Paragraph} />;
    case "code":       return <CodeBlock token={token as Tokens.Code} />;
    case "list":       return <List token={token as Tokens.List} />;
    case "blockquote": return <BlockQuote token={token as Tokens.Blockquote} />;
    case "table":      return <MarkdownTable token={token as Tokens.Table} />;
    case "hr":         return <Hr />;
    case "html":       return <Text>{(token as Tokens.HTML).text}</Text>;
    case "text":
    default:
      // Block-level Text token: marked emits these for "loose" content
      // (e.g. lines between list items in loose lists). Render as a
      // single line; inline children if present.
      return <BlockText token={token as Tokens.Text} />;
  }
}

function Heading({ token }: { token: Tokens.Heading }): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text color={theme.muted}>{"#".repeat(token.depth)} </Text>
      <Text bold color={theme.primary}><Inline tokens={token.tokens} /></Text>
    </Box>
  );
}

function Paragraph({ token }: { token: Tokens.Paragraph }): React.ReactElement {
  // marginTop opens a blank line above each paragraph so consecutive ones
  // read as separate blocks instead of running together — same separation
  // Heading already uses.
  return (
    <Box marginTop={1}>
      <Text><Inline tokens={token.tokens} /></Text>
    </Box>
  );
}

function BlockText({ token }: { token: Tokens.Text }): React.ReactElement {
  if (token.tokens && token.tokens.length > 0) {
    return <Text><Inline tokens={token.tokens} /></Text>;
  }
  return <Text>{token.text}</Text>;
}

function CodeBlock({ token }: { token: Tokens.Code }): React.ReactElement {
  // Rounded box matches the tool-result aesthetic so code reads as
  // "carved-out content." Language tag on its own dim row when present.
  return (
    <Box
      marginY={1}
      borderStyle="round"
      borderColor={theme.muted}
      paddingX={1}
      flexDirection="column"
    >
      {token.lang && <Text color={theme.muted}>{token.lang}</Text>}
      {token.text.split("\n").map((line, i) => (
        <Text key={i} color={theme.primary}>{line}</Text>
      ))}
    </Box>
  );
}

function List({ token }: { token: Tokens.List }): React.ReactElement {
  const start = typeof token.start === "number" ? token.start : 1;
  return (
    <Box flexDirection="column">
      {token.items.map((item, i) => (
        <ListItemRow key={i} item={item} marker={token.ordered ? `${start + i}.` : "•"} />
      ))}
    </Box>
  );
}

function ListItemRow({ item, marker }: { item: Tokens.ListItem; marker: string }): React.ReactElement {
  // Most items contain a single block (often a Text or Paragraph). Render
  // the marker, then each nested block — nested lists, code, paragraphs
  // all keep working through the same BlockToken switch.
  return (
    <Box>
      <Text color={theme.primary}>{marker} </Text>
      <Box flexDirection="column" flexGrow={1}>
        {item.tokens.map((tok, i) => <BlockToken key={i} token={tok} />)}
      </Box>
    </Box>
  );
}

function BlockQuote({ token }: { token: Tokens.Blockquote }): React.ReactElement {
  return (
    <Box>
      <Text color={theme.muted}>{sym.bar} </Text>
      <Box flexDirection="column" flexGrow={1}>
        {token.tokens.map((tok, i) => <BlockToken key={i} token={tok} />)}
      </Box>
    </Box>
  );
}

function Hr(): React.ReactElement {
  // Ink computes width on its own when given flexGrow + a fill char,
  // but a fixed-width rule reads more like a markdown hr.
  return (
    <Box marginY={1}>
      <Text color={theme.muted}>{"─".repeat(40)}</Text>
    </Box>
  );
}

function MarkdownTable({ token }: { token: Tokens.Table }): React.ReactElement {
  // Compute per-column widths from the longest cell text (header + rows).
  // Each column gets a fixed-width Box so the row layout aligns without
  // tabs or manual padding.
  const colCount = token.header.length;
  const widths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    let w = visualWidth(token.header[c]?.text ?? "");
    for (const row of token.rows) {
      w = Math.max(w, visualWidth(row[c]?.text ?? ""));
    }
    widths.push(Math.max(1, w));
  }
  const GAP = 2;
  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        {token.header.map((cell, c) => (
          <Box key={c} width={widths[c]! + GAP} flexShrink={0}>
            <Text bold>
              <Inline tokens={cell.tokens} />
            </Text>
          </Box>
        ))}
      </Box>
      <Box>
        {widths.map((w, c) => (
          <Box key={c} width={w + GAP} flexShrink={0}>
            <Text color={theme.muted}>{"─".repeat(w)}</Text>
          </Box>
        ))}
      </Box>
      {token.rows.map((row, ri) => (
        <Box key={ri}>
          {row.map((cell, c) => (
            <Box key={c} width={widths[c]! + GAP} flexShrink={0}>
              <Text><Inline tokens={cell.tokens} /></Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

/** Visual width of a markdown cell — strips inline markdown markers so
 *  `**bold**` measures as `bold` (4) not 8. Good enough for the common
 *  case; CJK / emoji width isn't accounted for. */
function visualWidth(s: string): number {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/[*_~`]/g, "")
    .length;
}

function Inline({ tokens }: { tokens: Token[] | undefined }): React.ReactElement {
  if (!tokens || tokens.length === 0) return <></>;
  return <>{tokens.map((t, i) => <InlineToken key={i} token={t} />)}</>;
}

function InlineToken({ token }: { token: Token }): React.ReactElement {
  switch (token.type) {
    case "text": {
      const t = token as Tokens.Text;
      // Inline Text tokens sometimes carry their own child tokens
      // (when the text contains nested inline formatting marked
      // wants to re-parse). Render those if present.
      if (t.tokens && t.tokens.length > 0) return <Inline tokens={t.tokens} />;
      return <Text>{t.text}</Text>;
    }
    case "strong":
      return <Text bold><Inline tokens={(token as Tokens.Strong).tokens} /></Text>;
    case "em":
      return <Text italic><Inline tokens={(token as Tokens.Em).tokens} /></Text>;
    case "del":
      return <Text strikethrough><Inline tokens={(token as Tokens.Del).tokens} /></Text>;
    case "codespan":
      return <Text color={theme.primary}>{(token as Tokens.Codespan).text}</Text>;
    case "link": {
      const l = token as Tokens.Link;
      // Show the link text underlined; append (href) when the visible
      // text and href differ so the URL still surfaces.
      const showHref = l.text !== l.href;
      return (
        <Text color={theme.user} underline>
          {l.text}
          {showHref && <Text color={theme.muted} underline={false}> ({l.href})</Text>}
        </Text>
      );
    }
    case "br":
      return <Text>{"\n"}</Text>;
    case "image": {
      const img = token as Tokens.Image;
      // No image rendering in a TUI; show alt + href so info isn't lost.
      return <Text color={theme.muted}>[image: {img.text}{img.href ? ` — ${img.href}` : ""}]</Text>;
    }
    default:
      return <Text>{(token as { raw?: string }).raw ?? ""}</Text>;
  }
}
