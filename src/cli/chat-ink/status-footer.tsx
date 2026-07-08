// Two-zone footer below the input bar. Left = identity (agent + model).
// Right = situational indicators (inbox count, token throughput). Every
// metadata cluster uses the · separator so the eye learns the rhythm.

import { Box, Text } from "ink";
import { theme, sym } from "./theme.ts";
import { formatCost } from "./format.ts";

export function StatusFooter({
  agentName,
  model,
  inboxOpen,
  totalBilledTokens,
  totalUsdMicros,
}: {
  agentName: string;
  model: string;
  inboxOpen: number;
  /** Cumulative billed tokens for the thread (in + out + cache read + cache write). */
  totalBilledTokens: number;
  /** Cumulative spend for the thread, in micro-USD. */
  totalUsdMicros: number;
}): React.ReactElement {
  // KISS: identity on the left, situational indicators on the right.
  // The right cluster is the running cost of the thread — tokens spent
  // and what they cost — so the price is always in view, not only on the
  // turn-end lines that scroll away.
  // (The thread id was dropped — an opaque hash means nothing to a human.)
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box>
        <Text color={theme.primary}>{agentName}</Text>
        {model && <Text color={theme.muted}> {sym.sep} {model}</Text>}
      </Box>
      <Box>
        {inboxOpen > 0 && (
          <Text color={theme.warn}>
            {sym.warn} {inboxOpen} inbox{totalBilledTokens > 0 ? ` ${sym.sep} ` : ""}
          </Text>
        )}
        {totalBilledTokens > 0 && (
          <Text color={theme.muted}>
            {formatTokens(totalBilledTokens)} tok
            {totalUsdMicros > 0 ? ` ${sym.sep} ${formatCost(totalUsdMicros)}` : ""}
          </Text>
        )}
      </Box>
    </Box>
  );
}

function formatTokens(n: number): string {
  // Thousands separator so big counts read at a glance.
  return n.toLocaleString("en-US");
}
