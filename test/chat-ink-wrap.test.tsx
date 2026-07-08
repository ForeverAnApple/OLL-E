// Regression guard for the markdown bleed: assistant output rendered inside
// <Static> on a wide terminal had its list items / blockquotes run past the
// right edge and hard-wrap to column 0. Root cause: <Static> mounts each item
// as a detached root that does NOT inherit the terminal-width constraint Ink
// applies to the live tree, so flex rows (list items use flexGrow) measured at
// max-content. ScrollbackItem pins the width to restore the budget.
//
// The test renders the *real* ScrollbackItem the app uses, at several wide
// terminal widths, and asserts no visible line exceeds the terminal width.
// ink-testing-library can't help here — its fake stdout hardcodes 100 columns —
// so we drive ink's own render() with a stdout stub of configurable width.

import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { render, Box, Static } from "ink";
import type * as React from "react";
import { ScrollbackItem, type ScrollbackEntry } from "../src/cli/chat-ink/message.tsx";

/** Render `node` against a fake stdout reporting `cols` columns and return
 *  every visible line (ANSI stripped). All writes are captured and joined —
 *  <Static> output lands on a separate write from the live frame, so capturing
 *  only the last frame would miss exactly the rows under test. */
function renderLines(cols: number, node: React.ReactElement): string[] {
  class Stdout extends EventEmitter {
    get columns(): number { return cols; }
    rows = 50;
    frames: string[] = [];
    write = (frame: string): void => { this.frames.push(frame); };
  }
  const stdout = new Stdout();
  const { unmount } = render(node, { stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false });
  unmount();
  return stripAnsi(stdout.frames.join("")).split("\n");
}

/** Strip the escape sequences ink emits: SGR colors (`\x1b[…m`), cursor /
 *  erase moves (`\x1b[…A`, `\x1b[2K`, …), and OSC strings (`\x1b]…\x07`). What
 *  remains is the printable glyphs whose count is the on-screen line width. */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/** Visible width = code-point count. Test fixtures stay within ASCII + en/em
 *  dashes (all width-1 single code points) so this matches terminal columns
 *  without pulling in a full east-asian-width table. */
function width(line: string): number {
  return [...line].length;
}

function staticApp(cols: number, entries: ScrollbackEntry[]): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Static items={entries}>
        {(entry) => <ScrollbackItem key={entry.id} entry={entry} width={cols} />}
      </Static>
    </Box>
  );
}

// Mirrors the shape that bled in the wild: ordered list, bold spans, long
// sentences that must wrap several times.
const LISTY_ASSISTANT = [
  "How sharing **actually** propagates, and where it's strong vs. weak:",
  "1. **Principles propagate by copy at spawn, not by reference**. When I spawn a child, my principle memories get passed down into it. But that's a snapshot. If I update a principle afterward, the already-spawned child doesn't see the change. So \"shared\" really means \"shared as of spawn time\" for the parent axis. That's a real limitation, not a feature.",
  "2. **Team memory is the only live shared surface** — members read/write the same pool. But it's coarse: it's a LIKE search over title/body, no semantic retrieval, no conflict resolution beyond the depth/resistance model. If five agents write overlapping beliefs, nothing merges them.",
].join("\n");

const NESTED_ASSISTANT = [
  "Here is the breakdown:",
  "- top level bullet that is long enough to need wrapping across the width of a wide terminal window without bleeding off the edge of the screen at all",
  "  - a nested bullet that is also quite long and must wrap inside its indented column rather than running off the right side of the terminal screen",
  "",
  "> a blockquote that is similarly long and needs to wrap within the quoted column instead of bleeding past the right edge of a very wide terminal window for sure",
].join("\n");

const WIDTHS = [80, 100, 120, 160, 190, 220];

describe("chat-ink scrollback wrapping inside <Static>", () => {
  it("ordered-list assistant output never bleeds past the terminal width", () => {
    for (const cols of WIDTHS) {
      const lines = renderLines(cols, staticApp(cols, [
        { kind: "assistant", id: "a", text: LISTY_ASSISTANT },
      ]));
      const over = lines.filter((l) => width(l) > cols);
      expect(over.map((l) => `${width(l)}>${cols}: ${l}`)).toEqual([]);
    }
  });

  it("nested bullets and blockquotes never bleed past the terminal width", () => {
    for (const cols of WIDTHS) {
      const lines = renderLines(cols, staticApp(cols, [
        { kind: "assistant", id: "n", text: NESTED_ASSISTANT },
      ]));
      const over = lines.filter((l) => width(l) > cols);
      expect(over.map((l) => `${width(l)}>${cols}: ${l}`)).toEqual([]);
    }
  });

  it("long user and tool-result gutters never bleed past the terminal width", () => {
    const longLine = "this is a single very long line of user text that has no natural break points for a while and therefore must be wrapped by the renderer rather than allowed to bleed off the right edge of a wide terminal".repeat(2);
    const entries: ScrollbackEntry[] = [
      { kind: "user", id: "u", text: longLine },
      { kind: "tool-result", id: "t", content: longLine, isError: false },
    ];
    for (const cols of WIDTHS) {
      const lines = renderLines(cols, staticApp(cols, entries));
      const over = lines.filter((l) => width(l) > cols);
      expect(over.map((l) => `${width(l)}>${cols}: ${l}`)).toEqual([]);
    }
  });

  it("actually wraps long content (guards against a vacuous pass)", () => {
    // If the harness silently rendered nothing, the bleed assertions above
    // would pass trivially. Prove there IS multi-line wrapped output.
    const lines = renderLines(120, staticApp(120, [
      { kind: "assistant", id: "a", text: LISTY_ASSISTANT },
    ])).filter((l) => width(l) > 0);
    expect(lines.length).toBeGreaterThan(5);
    // And at least one line uses a healthy chunk of the available width, so
    // we know wrapping happens near the boundary, not at some tiny width.
    expect(Math.max(...lines.map(width))).toBeGreaterThan(90);
  });
});
