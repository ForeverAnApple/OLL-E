// Tests for the progressive block-commit streaming UI in `olle chat`.
// The bug we're guarding against: per-chunk full-block rewinds duplicate
// content into terminal scrollback once a reply outgrows the viewport,
// and partial markdown tokens (e.g. unclosed `**`) freeze as raw
// asterisks in those duplicated frames. The new model commits stable
// blocks as markdown once and only rewinds the in-flight tail.

import { describe, expect, it } from "bun:test";
import { createChatUI, type ChatUIOut } from "../src/cli/run.ts";

// ── Tiny terminal simulator ─────────────────────────────────────────────
//
// Tracks scrollback (lines that have left the viewport, never to be
// rewritten) separately from the viewport (lines the rewind sequences
// can still touch). Processes the subset of ANSI we actually emit:
//   \n          — newline; if at bottom of viewport, top row scrolls into
//                 scrollback
//   \r          — carriage return; cursor to col 0 of current row
//   \x1b[<n>F   — cursor up n rows, to col 0
//   \x1b[0J     — erase from cursor through end of viewport
// SGR sequences (\x1b[...m) are kept inline in the row text.

interface FakeTerm extends ChatUIOut {
  lines: () => string[]; // committed scrollback + remaining viewport, top-down
  scrollback: () => string[];
  viewport: () => string[];
  raw: () => string; // raw write stream for sanity assertions
}

function makeTerm(cols: number, rows: number, isTTY = true): FakeTerm {
  const scrollback: string[] = [];
  const viewport: string[] = [""];
  let row = 0;
  let col = 0;
  let rawAccum = "";

  function ensureRow(r: number) {
    while (viewport.length <= r) viewport.push("");
  }
  function cursorDown() {
    row++;
    col = 0;
    if (row >= rows) {
      // Scroll: top row leaves the viewport.
      scrollback.push(viewport.shift() ?? "");
      row = rows - 1;
    }
    ensureRow(row);
  }
  function writeChar(ch: string) {
    if (col >= cols) cursorDown();
    ensureRow(row);
    const line = viewport[row]!;
    // Replace at col (overwrite), keeping any tail beyond if shorter.
    if (col === line.length) viewport[row] = line + ch;
    else viewport[row] = line.slice(0, col) + ch + line.slice(col + 1);
    col++;
  }

  function processAnsi(buf: string, i: number): number {
    // Returns the new index after consuming the sequence.
    // Supports the few we emit: F (cursor up), J (erase display), and
    // SGR (m, kept inline as styling).
    if (buf[i] !== "\x1b" || buf[i + 1] !== "[") return -1;
    let j = i + 2;
    while (j < buf.length && !/[A-Za-z]/.test(buf[j]!)) j++;
    if (j >= buf.length) return -1;
    const params = buf.slice(i + 2, j);
    const cmd = buf[j]!;
    if (cmd === "F") {
      const n = Math.max(1, parseInt(params, 10) || 1);
      row = Math.max(0, row - n);
      col = 0;
      return j + 1;
    }
    if (cmd === "J") {
      const mode = parseInt(params, 10) || 0;
      if (mode === 0) {
        // Erase from cursor (exclusive of preceding chars on this row)
        // through end of viewport.
        viewport[row] = (viewport[row] ?? "").slice(0, col);
        for (let r = row + 1; r < viewport.length; r++) viewport[r] = "";
        // Drop trailing empty rows that nothing will write to again.
        while (viewport.length > row + 1 && viewport[viewport.length - 1] === "") {
          viewport.pop();
        }
        return j + 1;
      }
    }
    if (cmd === "m") {
      // SGR — keep the escape inline so the test can see styling.
      const seq = buf.slice(i, j + 1);
      for (const ch of seq) writeChar(ch);
      return j + 1;
    }
    return -1;
  }

  function write(s: string): boolean {
    rawAccum += s;
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === "\x1b") {
        const next = processAnsi(s, i);
        if (next > 0) {
          i = next;
          continue;
        }
      }
      if (ch === "\n") {
        cursorDown();
        i++;
        continue;
      }
      if (ch === "\r") {
        col = 0;
        i++;
        continue;
      }
      writeChar(ch);
      i++;
    }
    return true;
  }

  return {
    write,
    isTTY,
    columns: cols,
    rows,
    lines: () => [...scrollback, ...viewport],
    scrollback: () => [...scrollback],
    viewport: () => [...viewport],
    raw: () => rawAccum,
  };
}

const ANSI_BOLD = "\x1b[1m";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function visibleLines(term: FakeTerm): string[] {
  return term.lines().map(stripAnsi);
}

function streamInChunks(text: string, chunkSize: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) out.push(text.slice(i, i + chunkSize));
  return out;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("chat UI progressive streaming", () => {
  it("commits paragraph blocks as styled markdown", () => {
    const term = makeTerm(80, 24);
    const ui = createChatUI({
      agentId: "a",
      agentName: "olle",
      threadId: "t",
      out: term,
    });
    const reply = "First paragraph with **bold** word.\n\nSecond paragraph.";
    for (const c of streamInChunks(reply, 5)) ui.assistantDelta(c);
    ui.assistantText(reply);

    const visible = visibleLines(term).join("\n");
    // Bold rendered, no literal asterisks remain.
    expect(visible).toContain("First paragraph with bold word.");
    expect(visible).not.toContain("**bold**");
    expect(visible).toContain("Second paragraph.");
    // The committed block's bold ANSI must appear in the raw stream.
    expect(term.raw()).toContain(ANSI_BOLD);
  });

  it("does not duplicate content into scrollback when the reply exceeds the viewport", () => {
    // Small viewport — 12 rows — to force scroll. Reply has ~10 short
    // paragraphs separated by blank lines, each one a stable boundary.
    const term = makeTerm(80, 12);
    const ui = createChatUI({
      agentId: "a",
      agentName: "olle",
      threadId: "t",
      out: term,
    });
    const paras: string[] = [];
    for (let i = 0; i < 10; i++) paras.push(`Paragraph number ${i} body text here.`);
    const reply = paras.join("\n\n");

    for (const c of streamInChunks(reply, 7)) ui.assistantDelta(c);
    ui.assistantText(reply);
    ui.turnEnd({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      usdMicros: 0,
      stopReason: "end_turn",
      model: "",
    });

    // Each paragraph should appear EXACTLY ONCE across scrollback +
    // viewport. The old per-chunk repaint left every prior frame in
    // scrollback, so paragraph 0 would appear N times for N deltas.
    const flat = visibleLines(term).join("\n");
    for (let i = 0; i < 10; i++) {
      const occurrences = flat.split(`Paragraph number ${i}`).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  it("treats blank lines inside fenced code blocks as part of the fence, not boundaries", () => {
    const term = makeTerm(80, 40);
    const ui = createChatUI({
      agentId: "a",
      agentName: "olle",
      threadId: "t",
      out: term,
    });
    const reply = [
      "Intro.",
      "",
      "```ts",
      "const a = 1;",
      "",
      "const b = 2;",
      "```",
      "",
      "Outro.",
    ].join("\n");
    // Stream char-by-char to maximize the chance of mid-fence boundary
    // detection mistakes.
    for (const ch of reply) ui.assistantDelta(ch);
    ui.assistantText(reply);

    const flat = visibleLines(term).join("\n");
    // Both lines of code present in their original order — proves the
    // fence wasn't split mid-stream and treated as separate paragraphs
    // (which would have lost the syntactic context of the code block).
    expect(flat).toContain("const a = 1;");
    expect(flat).toContain("const b = 2;");
    // No duplicated outro.
    expect(flat.split("Outro.").length - 1).toBe(1);
  });

  it("flushes pending tail when a tool call interrupts mid-stream", () => {
    const term = makeTerm(80, 24);
    const ui = createChatUI({
      agentId: "a",
      agentName: "olle",
      threadId: "t",
      out: term,
    });
    // Stream a partial paragraph (no closing blank line), then jump
    // straight to a tool call. The pending text must commit before the
    // tool-call line lands.
    ui.assistantDelta("Looking at the data — ");
    ui.assistantDelta("**bold detail** then ");
    ui.toolCall("read_file", { path: "/tmp/foo" });

    const flat = visibleLines(term).join("\n");
    expect(flat).toContain("Looking at the data");
    expect(flat).toContain("bold detail");
    expect(flat).not.toContain("**bold detail**");
    expect(flat).toContain("read_file(");
    // Tool line must appear AFTER the assistant text in viewport order.
    const assistantIdx = flat.indexOf("Looking at the data");
    const toolIdx = flat.indexOf("read_file(");
    expect(toolIdx).toBeGreaterThan(assistantIdx);
  });

  it("force-flushes a pending tail that outgrows the viewport budget", () => {
    // Tiny viewport (12 rows → maxPendingRows = 8). Build a reply with
    // no blank-line boundaries that will exceed the rewind budget.
    const term = makeTerm(40, 12);
    const ui = createChatUI({
      agentId: "a",
      agentName: "olle",
      threadId: "t",
      out: term,
    });
    // 20 single-newline-separated lines, no blank lines → no boundaries.
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) lines.push(`Line ${i} of long unbroken stream.`);
    const reply = lines.join("\n");
    for (const ch of reply) ui.assistantDelta(ch);
    ui.assistantText(reply);

    // The early lines must have force-flushed into scrollback. We don't
    // care about formatting (markdown is sacrificed on overflow), only
    // that each line appears at most once and no rewind tried to reach
    // back into scrollback.
    const flat = visibleLines(term).join("\n");
    for (let i = 0; i < 20; i++) {
      const tag = `Line ${i} of`;
      const occurrences = flat.split(tag).length - 1;
      // Allow up to 1 occurrence — some early lines may have been
      // discarded entirely if they scrolled off before commit.
      expect(occurrences).toBeLessThanOrEqual(1);
    }
    // The most-recent few lines must be present in the viewport.
    expect(flat).toContain("Line 19 of");
    expect(flat).toContain("Line 18 of");
  });

  it("non-TTY output skips streaming and writes the final markdown once", () => {
    const term = makeTerm(80, 24, false);
    const ui = createChatUI({
      agentId: "a",
      agentName: "olle",
      threadId: "t",
      out: term,
    });
    ui.assistantDelta("Hello ");
    ui.assistantDelta("**world**");
    // Mid-stream, raw should be empty (deltas suppressed).
    expect(term.raw()).toBe("");
    ui.assistantText("Hello **world**");
    // Now the rendered block lands once, with bold ANSI.
    expect(term.raw()).toContain("Hello");
    expect(term.raw()).toContain("world");
    // The "**" markers should NOT appear in the rendered output (marked
    // consumed them for bold styling).
    const visible = visibleLines(term).join("\n");
    expect(visible).not.toContain("**world**");
  });
});
