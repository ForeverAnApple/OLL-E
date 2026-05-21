// Semantic palette + symbol set for the Ink chat REPL. Everything that
// reaches a <Text color={...}> should land on one of these names rather
// than a raw color string — keeps the visual language coherent and
// makes a future "real theme" file a one-line swap.

export const theme = {
  /** Assistant identity, default accent, input bar in idle state. */
  primary: "cyan",
  /** User-authored content (input echo, you-said gutter). */
  user: "green",
  /** Tool invocation gutter. */
  tool: "yellow",
  /** Retries, queued, "needs attention" — anything attention-seeking but not failed. */
  warn: "yellow",
  /** Hard failure — tool errors, error events, refusal. */
  error: "red",
  /** Success affordances — turn-end checkmarks, "done". */
  success: "green",
  /** Secondary text: metadata, hints, footer info, gutter labels. */
  muted: "gray",
} as const;

export const sym = {
  /** Inline metadata separator: `agent · model · cost`. */
  sep: "·",
  /** Vertical accent bar to color-code a message's role on the left edge.
   *  Left-one-quarter-block (U+258E) — sits flush left in its cell,
   *  reads as a clean ribbon rather than a heavy line. */
  bar: "▎",
  /** Turn-end success. */
  done: "✓",
  /** Warning glyph used for retries and inbox indicators. */
  warn: "△",
  /** Tool-call bullet — leads the call line. */
  tool: "●",
  /** Tool-result inline glyph for short/cheap results that skip the box. */
  ret: "↩",
  /** Tool-error indicator — paired with red color on the call + box. */
  err: "✗",
  /** Tool-success indicator for the right-edge of completed calls. */
  ok: "✓",
  /** Retry indicator. */
  retry: "↻",
} as const;
