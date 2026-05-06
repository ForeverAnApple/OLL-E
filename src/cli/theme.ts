// Centralized color palette for `olle chat`. Picks truecolor RGB on
// terminals that advertise COLORTERM=truecolor|24bit, otherwise falls
// back to 16-color named codes that exist on every TTY.
//
// The chat UI (run.ts) and the markdown renderer (markdown.ts) both
// pull from here so the assistant surface reads as one coherent
// painting rather than a quilt.

const TRUECOLOR =
  process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit";

function fg(r: number, g: number, b: number, fallback: string): string {
  return TRUECOLOR ? `\x1b[38;2;${r};${g};${b}m` : fallback;
}

export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  strike: "\x1b[9m",

  // Semantic palette.
  primary: fg(250, 178, 131, "\x1b[33m"), //   #fab283 — soft orange
  secondary: fg(92, 156, 245, "\x1b[34m"), //  #5c9cf5 — sky blue
  accent: fg(157, 124, 216, "\x1b[35m"), //    #9d7cd8 — lavender
  text: fg(238, 238, 238, "\x1b[37m"), //      #eeeeee — near-white
  muted: fg(128, 128, 128, "\x1b[90m"), //     #808080 — mid-gray
  border: fg(72, 72, 72, "\x1b[90m"), //       #484848 — dark-gray

  success: fg(127, 216, 143, "\x1b[32m"), //   #7fd88f
  warning: fg(245, 167, 66, "\x1b[33m"), //    #f5a742
  error: fg(224, 108, 117, "\x1b[31m"), //     #e06c75
  info: fg(86, 182, 194, "\x1b[36m"), //       #56b6c2

  // Legacy 16-color aliases — retained because some callers still
  // reach for "I want yellow" by name. New code should prefer the
  // semantic colors above.
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};
