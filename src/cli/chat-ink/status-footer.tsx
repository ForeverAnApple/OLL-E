// Two-zone footer below the input bar. Left = identity (agent + model).
// Right = situational indicators (inbox count, short thread id). Every
// metadata cluster uses the · separator so the eye learns the rhythm.

import { Box, Text } from "ink";
import { theme, sym } from "./theme.ts";

export function StatusFooter({
  agentName,
  model,
  inboxOpen,
  threadId,
  totalBilledTokens,
}: {
  agentName: string;
  model: string;
  inboxOpen: number;
  threadId: string;
  /** Cumulative billed tokens for the thread (in + out + cache read + cache write). */
  totalBilledTokens: number;
}): React.ReactElement {
  // KISS: identity on the left, situational indicators on the right.
  // Cost lives on each turn-end line as a running total. The footer
  // carries a single token counter — total throughput across the
  // thread — and the thread id.
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box>
        <Text color={theme.primary}>{agentName}</Text>
        {model && <Text color={theme.muted}> {sym.sep} {model}</Text>}
      </Box>
      <Box>
        {inboxOpen > 0 && (
          <Text color={theme.warn}>{sym.warn} {inboxOpen} inbox {sym.sep} </Text>
        )}
        {totalBilledTokens > 0 && (
          <Text color={theme.muted}>{formatTokens(totalBilledTokens)} tok {sym.sep} </Text>
        )}
        <Text color={theme.muted}>{shortThread(threadId)}</Text>
      </Box>
    </Box>
  );
}

function formatTokens(n: number): string {
  // Thousands separator so big counts read at a glance.
  return n.toLocaleString("en-US");
}

function shortThread(id: string): string {
  // CLI-minted thread ids look like `cli:abcd1234`; drop the prefix to
  // save horizontal space in the footer.
  return id.startsWith("cli:") ? id.slice(4) : id.slice(-8);
}
