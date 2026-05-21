// Input bar in the "framed" style — two horizontal dividers bracket
// the input row, with a `▎` accent on the prompt. Matches the rhythm
// of OLL-E's original olle-chat REPL: status hint above the top
// divider, input row inside the frame, footer info below the bottom
// divider. The accent + divider colors track state so "what's
// happening" reads at a glance without prose.

import { Box, Text } from "ink";
import { Spinner, TextInput } from "@inkjs/ui";
import { theme, sym } from "./theme.ts";

export type BarState = "idle" | "busy" | "error" | "quit-armed";

function stateColor(state: BarState): string {
  if (state === "error") return theme.error;
  if (state === "busy" || state === "quit-armed") return theme.warn;
  return theme.primary;
}

/** The input row + its bracketing horizontal dividers. Borders are
 *  drawn via Ink's <Box borderStyle> with left/right disabled so we
 *  get a clean top + bottom rule without any corners. */
export function InputFrame({
  state,
  inputKey,
  placeholder,
  onSubmit,
}: {
  state: BarState;
  inputKey: number;
  placeholder: string;
  onSubmit: (text: string) => void;
}): React.ReactElement {
  const color = stateColor(state);
  return (
    <Box
      borderStyle="single"
      borderTop={true}
      borderBottom={true}
      borderLeft={false}
      borderRight={false}
      borderColor={theme.muted}
      paddingX={1}
    >
      <Text color={color}>{sym.bar} </Text>
      <TextInput
        key={inputKey}
        placeholder={placeholder}
        onSubmit={onSubmit}
      />
    </Box>
  );
}

/** Hint / spinner / quit-confirm row sitting above the top divider.
 *  Single line, dim — never the thing the eye lands on, just the
 *  ambient state. */
export function StatusLine({
  state,
  quitArmed,
}: {
  state: BarState;
  quitArmed: boolean;
}): React.ReactElement {
  if (quitArmed) {
    return <Box paddingX={1}><Text color={theme.warn}>press Ctrl-C again within 2s to exit</Text></Box>;
  }
  if (state === "busy") {
    return (
      <Box paddingX={1}>
        <Spinner />
        <Text color={theme.muted}>  thinking…  (Ctrl-C to cancel)</Text>
      </Box>
    );
  }
  return (
    <Box paddingX={1}>
      <Text color={theme.muted}>/help {sym.sep} /clear {sym.sep} /model {sym.sep} /exit</Text>
    </Box>
  );
}
