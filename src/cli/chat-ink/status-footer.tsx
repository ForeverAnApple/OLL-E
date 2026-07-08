// Two-zone footer below the input bar. Left = identity (agent + model).
// Right = situational indicators (inbox count, cost, context gauge). Every
// metadata cluster uses the · separator so the eye learns the rhythm.

import { Box, Text } from "ink";
import { theme, sym } from "./theme.ts";
import { formatCost } from "./format.ts";
import { contextWindow } from "../../llm/models.ts";

export function StatusFooter({
  agentName,
  model,
  inboxOpen,
  totalUsdMicros,
  contextTokens,
}: {
  agentName: string;
  model: string;
  inboxOpen: number;
  /** Cumulative spend for the thread, in micro-USD. */
  totalUsdMicros: number;
  /** Context-window occupancy after the last round-trip (prompt + output).
   *  A snapshot of what's in the window now, not a running total. */
  contextTokens: number;
}): React.ReactElement {
  // KISS: identity on the left, situational indicators on the right.
  // The right cluster answers the two questions that outlive scrollback:
  // what has this thread cost (turn-end lines scroll away), and how full
  // is the window right now (the gauge hue is the fast signal). The old
  // cumulative token counter is gone — cost prices the past better, the
  // gauge measures the present better, and the sum answered neither.
  // (The thread id was dropped — an opaque hash means nothing to a human.)
  const hasCost = totalUsdMicros > 0;
  const hasCtx = contextTokens > 0;
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box>
        <Text color={theme.primary}>{agentName}</Text>
        {model && <Text color={theme.muted}> {sym.sep} {model}</Text>}
      </Box>
      <Box>
        {inboxOpen > 0 && (
          <Text color={theme.warn}>
            {sym.warn} {inboxOpen} inbox{hasCost || hasCtx ? ` ${sym.sep} ` : ""}
          </Text>
        )}
        {hasCost && (
          <Text color={theme.muted}>
            {formatCost(totalUsdMicros)}
            {hasCtx ? ` ${sym.sep} ` : ""}
          </Text>
        )}
        {hasCtx && (
          <Text color={contextColor(contextTokens, model)}>
            {formatTokens(contextTokens)} ctx
          </Text>
        )}
      </Box>
    </Box>
  );
}

// Gray while there's headroom, amber past 70%, red past 90%. The color is
// the fast signal — you read "getting full" from the hue before the number.
function contextColor(tokens: number, model: string): string {
  const ratio = tokens / contextWindow(model);
  if (ratio >= 0.9) return theme.error;
  if (ratio >= 0.7) return theme.warn;
  return theme.muted;
}

function formatTokens(n: number): string {
  // Thousands separator so big counts read at a glance.
  return n.toLocaleString("en-US");
}
