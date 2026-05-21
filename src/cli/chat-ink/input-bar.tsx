// Framed input bar: two horizontal dividers bracket the input row,
// with a `▎` accent on the prompt whose color tracks BarState (idle /
// busy / quit-armed / error). Status hint above the top divider,
// footer info below the bottom divider.

import { Box, Text } from "ink";
import { Spinner, TextInput } from "@inkjs/ui";
import { theme, sym } from "./theme.ts";
import { matchSlash, exactCommand, splitSlash, type SlashCommand } from "./commands.ts";

export type BarState = "idle" | "busy" | "error" | "quit-armed";

function stateColor(state: BarState): string {
  if (state === "error") return theme.error;
  if (state === "busy" || state === "quit-armed") return theme.warn;
  return theme.primary;
}

/** Top + bottom rules bracketing the input row. Left/right borders
 *  disabled so corners don't render. */
export function InputFrame({
  state,
  inputKey,
  placeholder,
  suggestions,
  onSubmit,
  onChange,
}: {
  state: BarState;
  inputKey: number;
  placeholder: string;
  suggestions?: string[];
  onSubmit: (text: string) => void;
  onChange?: (text: string) => void;
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
        {...(suggestions && suggestions.length > 0 && { suggestions })}
        {...(onChange && { onChange })}
        onSubmit={onSubmit}
      />
    </Box>
  );
}

/** Hint / spinner / quit-confirm row sitting above the top divider.
 *  When the user is typing a slash command, this expands into a
 *  multi-line autocomplete pane listing each matching command with
 *  its description. Otherwise it's a single dim line. */
export function StatusLine({
  state,
  quitArmed,
  input,
}: {
  state: BarState;
  quitArmed: boolean;
  /** Current input buffer. Drives the slash-completion pane. */
  input: string;
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
  if (input.startsWith("/")) {
    const exact = exactCommand(input);
    const parts = splitSlash(input);
    const inArgPosition = !!(exact && parts && (parts.arg.length > 0 || input.endsWith(" ")));
    if (inArgPosition) return <ArgHintPane cmd={exact!} arg={parts!.arg} />;
    const matches = matchSlash(input);
    if (matches.length > 0) return <CommandPane matches={matches} />;
  }
  return (
    <Box paddingX={1}>
      <Text color={theme.muted}>/help {sym.sep} /clear {sym.sep} /inbox {sym.sep} /model {sym.sep} /exit</Text>
    </Box>
  );
}

function CommandPane({ matches }: { matches: SlashCommand[] }): React.ReactElement {
  // Cap the list so a long-suffix typo doesn't paper-cut.
  const shown = matches.slice(0, 6);
  const nameW = shown.reduce((w, c) => Math.max(w, c.name.length), 0);
  return (
    <Box flexDirection="column" paddingX={1}>
      {shown.map((c) => (
        <Box key={c.name}>
          <Text color={theme.primary}>{c.name.padEnd(nameW)}</Text>
          <Text color={theme.muted}>  {c.description}</Text>
        </Box>
      ))}
      {matches.length > shown.length && (
        <Text color={theme.muted}>… +{matches.length - shown.length} more</Text>
      )}
    </Box>
  );
}

function ArgHintPane({ cmd, arg }: { cmd: SlashCommand; arg: string }): React.ReactElement {
  const choices = cmd.argChoices
    ? cmd.argChoices.filter((c) => c.toLowerCase().startsWith(arg.toLowerCase()))
    : [];
  if (choices.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color={theme.primary}>{cmd.name}</Text>
        {cmd.argHint && <Text color={theme.muted}> {cmd.argHint}</Text>}
        <Text color={theme.muted}>  {sym.sep}  {cmd.description}</Text>
      </Box>
    );
  }
  const shown = choices.slice(0, 6);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={theme.primary}>{cmd.name}</Text>
        {cmd.argHint && <Text color={theme.muted}> {cmd.argHint}</Text>}
        <Text color={theme.muted}>  {sym.sep}  {cmd.description}</Text>
      </Box>
      {shown.map((c) => (
        <Box key={c}><Text color={theme.muted}>  {c}</Text></Box>
      ))}
      {choices.length > shown.length && (
        <Text color={theme.muted}>  … +{choices.length - shown.length} more</Text>
      )}
    </Box>
  );
}
