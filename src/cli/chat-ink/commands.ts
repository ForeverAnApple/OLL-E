// Slash command registry. One declaration drives matching, the hint
// pane, and the `/help` listing. Add a command by appending to
// SLASH_COMMANDS and adding a branch in app.tsx's handleSlash.

import { listKnownModels } from "../../llm/pricing.ts";

export interface SlashCommand {
  name: string;
  description: string;
  argHint?: string;
  /** Static completions for the first argument — fed both to
   *  `<TextInput suggestions>` and to the hint pane. */
  argChoices?: readonly string[];
}

// Sourced from the pricing table so a new model gets autocomplete the
// same release it gets a price. The daemon accepts any string (the LLM
// provider rejects unknowns), so anything not in the table just doesn't
// autocomplete — type the full name to use it.
export const KNOWN_MODELS: readonly string[] = listKnownModels();

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "/help",   description: "show available commands" },
  { name: "/clear",  description: "clear scrollback and start a fresh thread" },
  { name: "/new",    description: "alias of /clear — fresh thread, fresh scrollback" },
  { name: "/cancel", description: "cancel the current agent turn" },
  { name: "/model",  description: "show or set the default LLM model", argHint: "[name]", argChoices: KNOWN_MODELS },
  { name: "/inbox",  description: "list open inbox items (or /inbox <id> to show one)", argHint: "[id]" },
  { name: "/exit",   description: "exit chat" },
  { name: "/quit",   description: "exit chat" },
];

/** Parse `text` into head + arg. Returns `null` for non-slash text. */
export function splitSlash(text: string): { head: string; arg: string } | null {
  if (!text.startsWith("/")) return null;
  const head = text.split(/\s+/, 1)[0]!;
  const arg = text.slice(head.length).trim();
  return { head, arg };
}

/** Commands whose names start with the current `/foo` token. */
export function matchSlash(text: string): SlashCommand[] {
  const parts = splitSlash(text);
  if (!parts) return [];
  const head = parts.head.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(head));
}

/** The command whose head matches `text` exactly (head only — arg
 *  may still be in progress). */
export function exactCommand(text: string): SlashCommand | null {
  const parts = splitSlash(text);
  if (!parts) return null;
  return SLASH_COMMANDS.find((c) => c.name === parts.head.toLowerCase()) ?? null;
}

/** Inline ghost-text suggestion(s) for `<TextInput suggestions>`.
 *  Empty when ambiguous — the hint pane handles multi-match listing. */
export function inlineSuggestions(text: string): string[] {
  const parts = splitSlash(text);
  if (!parts) return [];
  // Still typing the head (no space yet) — auto-complete only when one match remains.
  if (!text.includes(" ")) {
    const matches = matchSlash(text);
    return matches.length === 1 ? [matches[0]!.name + " "] : [];
  }
  const cmd = exactCommand(text);
  if (!cmd?.argChoices) return [];
  const prefix = parts.arg.toLowerCase();
  return cmd.argChoices
    .filter((c) => c.toLowerCase().startsWith(prefix))
    .map((c) => `${cmd.name} ${c}`);
}
