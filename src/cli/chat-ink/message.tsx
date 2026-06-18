// One row per committed scrollback entry. Each variant is its own
// component so the layout decisions stay near the data — easier to
// tune individual rows without threading a single mega-renderer.
//
// Visual rule the whole file follows: no prefix labels ("you:",
// "assistant:"). The vertical bar on the left edge carries role
// identity through color; metadata is muted gray; tool nesting is
// implied by left-padding, not labels.

import { Box, Text } from "ink";
import { theme, sym } from "./theme.ts";
import { Markdown } from "./markdown.tsx";
import { clipString } from "./format.ts";

export type ScrollbackEntry =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "tool-call"; id: string; name: string; input: unknown }
  | { kind: "tool-result"; id: string; content: string; isError: boolean }
  | { kind: "note"; id: string; text: string }
  | { kind: "error"; id: string; text: string }
  | { kind: "retry"; id: string; attempt: number; status?: number; message?: string }
  /** `cumulativeUsdMicros` is the running total **including this turn**,
   *  not the per-turn cost — see the comment in app.tsx where the entry
   *  is constructed for why. Per-turn cost is derivable as the delta
   *  from the previous turn-end entry. */
  | { kind: "turn-end"; id: string; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; cumulativeUsdMicros: number; stopReason: string };

export function MessageRow({ entry }: { entry: ScrollbackEntry }): React.ReactElement {
  switch (entry.kind) {
    case "user":          return <UserRow text={entry.text} />;
    case "assistant":     return <AssistantRow text={entry.text} />;
    case "tool-call":     return <ToolCallRow name={entry.name} input={entry.input} />;
    case "tool-result":   return <ToolResultRow content={entry.content} isError={entry.isError} />;
    case "note":          return <NoteRow text={entry.text} />;
    case "error":         return <ErrorRow text={entry.text} />;
    case "retry":         return <RetryRow attempt={entry.attempt} status={entry.status} message={entry.message} />;
    case "turn-end":      return <TurnEndRow {...entry} />;
    default:              return assertNever(entry);
  }
}

/** Exhaustiveness guard: a new ScrollbackEntry kind added without a
 *  matching MessageRow branch trips the TS compiler at this call site
 *  rather than silently rendering nothing at runtime. */
function assertNever(x: never): never {
  throw new Error(`MessageRow: unhandled scrollback entry kind: ${JSON.stringify(x)}`);
}

/** Mid-turn submits pinned above the input bar until the daemon
 *  emits `chat.input-folded`. Visually distinct from the committed
 *  user gutter — same `▎` accent but muted + a `(queued)` tag. */
export function TrayList({ items }: { items: string[] }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      {items.map((text, i) => (
        <Box key={i}>
          <Text color={theme.muted}>{sym.bar} </Text>
          <Text color={theme.muted}>{text}  </Text>
          <Text color={theme.warn}>(queued)</Text>
        </Box>
      ))}
    </Box>
  );
}

function UserRow({ text }: { text: string }): React.ReactElement {
  // A blank line above each user turn is the strongest single cue that a
  // new exchange started — turns stop running together in the scrollback.
  return (
    <Box marginTop={1} paddingX={1}>
      <Text color={theme.user}>{sym.bar} </Text>
      <Box flexDirection="column" flexGrow={1}>
        {text.split("\n").map((line, i) => <Text key={i}>{line}</Text>)}
      </Box>
    </Box>
  );
}

function AssistantRow({ text }: { text: string }): React.ReactElement {
  // Balanced L/R padding. paddingRight={1} left almost no right margin, so at
  // wide terminals the wrap boundary lands against the edge and long lines
  // bleed past it. paddingRight must match the live streaming region (app.tsx)
  // so text doesn't reflow the instant a streaming turn commits.
  return (
    <Box paddingLeft={3} paddingRight={2} flexDirection="column">
      <Markdown source={text} />
    </Box>
  );
}

function ToolCallRow({ name, input }: { name: string; input: unknown }): React.ReactElement {
  const args = formatCallArgs(input);
  // Each call gets air above it; its result (ToolResultRow) stays glued
  // below with no margin, so a call+result reads as one unit.
  return (
    <Box marginTop={1} paddingLeft={3} paddingRight={1}>
      <Text color={theme.tool}>{sym.tool} </Text>
      <Text>{name}</Text>
      {args && <Text color={theme.muted}>({args})</Text>}
    </Box>
  );
}

function ToolResultRow({ content, isError }: { content: string; isError: boolean }): React.ReactElement {
  // Short / cheap result: inline one-line render, skip the box.
  // The result lives visually right under the bullet without a heavy frame.
  const trimmed = content.trim();
  if (!isError && trimmed.length <= 60 && !trimmed.includes("\n")) {
    return (
      <Box paddingLeft={5} paddingRight={1}>
        <Text color={theme.muted}>{sym.ret} {trimmed || "(empty)"}</Text>
      </Box>
    );
  }
  // Long or failed result: rounded box, color-coded by success/error.
  // Width-capped so wide terminals don't stretch a small result edge-to-edge.
  const { head, more } = truncate(content, { maxLines: 10, maxChars: 800 });
  const borderColor = isError ? theme.error : theme.muted;
  const textColor = isError ? theme.error : undefined;
  return (
    <Box paddingLeft={5} paddingRight={1}>
      <Box
        borderStyle="round"
        borderColor={borderColor}
        paddingX={1}
        flexDirection="column"
        flexGrow={1}
      >
        {isError && (
          <Text color={theme.error}>{sym.err} tool error</Text>
        )}
        {head.split("\n").map((line, i) => (
          <Text key={i} {...(textColor && { color: textColor })}>{line}</Text>
        ))}
        {more > 0 && (
          <Text color={theme.muted}>
            … {more} more {moreUnit(more, head, content)}
          </Text>
        )}
      </Box>
    </Box>
  );
}

function moreUnit(more: number, head: string, full: string): string {
  // We truncated by lines vs by chars depending on which limit hit
  // first. Tell the user which budget they ran out of so the "more N"
  // count reads correctly.
  const headLines = head.split("\n").length;
  const fullLines = full.split("\n").length;
  if (fullLines > headLines) return fullLines - headLines === 1 ? "line" : "lines";
  return more === 1 ? "char" : "chars";
}

function NoteRow({ text }: { text: string }): React.ReactElement {
  return (
    <Box paddingX={1}>
      <Text color={theme.muted}>{text}</Text>
    </Box>
  );
}

function ErrorRow({ text }: { text: string }): React.ReactElement {
  return (
    <Box paddingX={1}>
      <Text color={theme.error}>{sym.err} {text}</Text>
    </Box>
  );
}

function RetryRow({ attempt, status, message }: { attempt: number; status?: number; message?: string }): React.ReactElement {
  const tail = [status ? `${status}` : null, message].filter(Boolean).join(" ");
  return (
    <Box paddingX={1}>
      <Text color={theme.warn}>{sym.retry} retry attempt {attempt}</Text>
      {tail && <Text color={theme.muted}>  {tail}</Text>}
    </Box>
  );
}

function TurnEndRow(props: Extract<ScrollbackEntry, { kind: "turn-end" }>): React.ReactElement {
  // KISS: one line, one cost, one place. The $ is the **running total**
  // at the end of this turn (not the per-turn delta) so the eye reads
  // "we're at $X total now" rather than re-summing every turn-line. The
  // footer no longer carries cost — this is the only place it lives.
  //
  // Two polish rules survive from the earlier version:
  //   - collapse "(+0 cache, +0 write)" when both are 0
  //   - hide "end_turn" stop reason; only surface non-default outcomes
  const cost = formatCost(props.cumulativeUsdMicros);
  const cacheParts: string[] = [];
  if (props.cacheReadTokens > 0) cacheParts.push(`+${props.cacheReadTokens} cache`);
  if (props.cacheCreationTokens > 0) cacheParts.push(`+${props.cacheCreationTokens} write`);
  const cacheStr = cacheParts.length > 0 ? ` (${cacheParts.join(", ")})` : "";
  const stopStr = props.stopReason && props.stopReason !== "end_turn"
    ? ` ${sym.sep} ${props.stopReason}`
    : "";
  return (
    <Box paddingX={1}>
      <Text color={theme.muted}>
        <Text color={theme.success}>{sym.done}</Text> {props.model} {sym.sep} in {props.inputTokens}{cacheStr} {sym.sep} out {props.outputTokens} {sym.sep} {cost}{stopStr}
      </Text>
    </Box>
  );
}

function formatCost(usdMicros: number): string {
  const usd = usdMicros / 1_000_000;
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function formatCallArgs(input: unknown): string {
  // Compact arg string that sits in the call's parentheses:
  //   `query_self`           — empty input renders as bare name
  //   `memory_search("dave")` — single string arg uses positional form
  //   `write_file(path="/x", content="…")` — multi-arg keeps keys
  if (input == null) return "";
  if (typeof input === "string") return JSON.stringify(clipString(input, 40));
  if (typeof input !== "object") return String(input);
  try {
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length === 0) return "";
    if (entries.length === 1 && typeof entries[0]![1] === "string") {
      return JSON.stringify(clipString(entries[0]![1] as string, 40));
    }
    const parts = entries.slice(0, 4).map(([k, v]) => `${k}=${clipString(stringifyShort(v), 24)}`);
    const suffix = entries.length > 4 ? `, +${entries.length - 4}` : "";
    return clipString(parts.join(", "), 80) + suffix;
  } catch {
    return "";
  }
}

function stringifyShort(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null || typeof v !== "object") return String(v);
  try { return JSON.stringify(v); } catch { return "[obj]"; }
}

function truncate(s: string, opts: { maxLines: number; maxChars: number }): { head: string; more: number } {
  const lines = s.split("\n");
  if (lines.length > opts.maxLines) {
    return { head: lines.slice(0, opts.maxLines).join("\n"), more: lines.length - opts.maxLines };
  }
  if (s.length > opts.maxChars) {
    return { head: s.slice(0, opts.maxChars), more: s.length - opts.maxChars };
  }
  return { head: s, more: 0 };
}
