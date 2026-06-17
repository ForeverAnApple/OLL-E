// Two-zone footer below the input bar. Left = identity (agent + model).
// Right = situational indicators (inbox count, token throughput). Every
// metadata cluster uses the · separator so the eye learns the rhythm.

import { Box, Text } from "ink";
import { theme, sym } from "./theme.ts";

export function StatusFooter({
  agentName,
  model,
  inboxOpen,
  totalBilledTokens,
}: {
  agentName: string;
  model: string;
  inboxOpen: number;
  /** Cumulative billed tokens for the thread (in + out + cache read + cache write). */
  totalBilledTokens: number;
}): React.ReactElement {
  // KISS: identity on the left, situational indicators on the right.
  // Cost lives on each turn-end line as a running total. The footer
  // carries a single token counter — total throughput across the thread.
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
          <Text color={theme.muted}>{formatTokens(totalBilledTokens)} tok</Text>
        )}
      </Box>
    </Box>
  );
}

function formatTokens(n: number): string {
  // Thousands separator so big counts read at a glance.
  return n.toLocaleString("en-US");
}
