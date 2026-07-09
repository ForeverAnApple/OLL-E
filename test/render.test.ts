// Tests for the shared CLI rendering primitives. The load-bearing property
// across the whole module is plain-pad-then-color: color:true and color:false
// output must have identical visible width on every line, and color:false must
// carry zero escapes. The table primitive's width-fit + clip is the trickiest
// bit, so it gets the most coverage.

import { describe, expect, test } from "bun:test";
import {
  clip,
  clipPlain,
  emptyState,
  fmtAge,
  fmtUsdSmart,
  formatTokens,
  headerLine,
  heading,
  kv,
  makeColorer,
  padVisible,
  shortId,
  table,
  vlen,
  wrap,
} from "../src/cli/render.ts";
import { ANSI } from "../src/cli/theme.ts";

function plain(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const C = makeColorer(true);
const P = makeColorer(false);

describe("scalar formatters", () => {
  test("formatTokens humanizes across tiers", () => {
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(96_300)).toBe("96k");
    expect(formatTokens(1_180_000)).toBe("1.2M");
    expect(formatTokens(1_000_000_000)).toBe("1.00B");
  });

  test("fmtUsdSmart trims sub-dollar to >=2dp, 2dp for dollars, commas for thousands", () => {
    expect(fmtUsdSmart(0)).toBe("$0.00");
    expect(fmtUsdSmart(590_000)).toBe("$0.59");
    expect(fmtUsdSmart(2_410_000)).toBe("$2.41");
    expect(fmtUsdSmart(1_234_560_000)).toBe("$1,234.56");
  });

  test("fmtAge steps s→m→h→d", () => {
    expect(fmtAge(5_000)).toBe("5s");
    expect(fmtAge(120_000)).toBe("2m");
    expect(fmtAge(5 * 3_600_000)).toBe("5h");
    expect(fmtAge(3 * 86_400_000)).toBe("3d");
  });

  test("shortId is a 10-char slice", () => {
    expect(shortId("01J8ZXCVBNMASDFGHJKL")).toBe("01J8ZXCVBN");
    expect(shortId("abc")).toBe("abc");
  });
});

describe("clip / vlen / clipPlain", () => {
  test("clip keeps head and appends ellipsis past width", () => {
    expect(clip("hello", 10)).toBe("hello");
    expect(clip("hello world", 5)).toBe("hell…");
    expect(clip("hello world", 5).length).toBe(5);
  });

  test("vlen ignores ANSI escapes", () => {
    expect(vlen(`${ANSI.error}oops${ANSI.reset}`)).toBe(4);
  });

  test("clipPlain measures visible width even with embedded escapes", () => {
    const colored = `${ANSI.error}hello world${ANSI.reset}`;
    const out = clipPlain(colored, 5);
    expect(plain(out)).toBe("hell…");
    expect(vlen(out)).toBe(5);
  });
});

describe("padVisible", () => {
  test("pads plain and ANSI strings to the same visible width", () => {
    const a = padVisible("hi", 6);
    const b = padVisible(`${ANSI.text}hi${ANSI.reset}`, 6);
    expect(a.length).toBe(6);
    expect(vlen(b)).toBe(6);
  });
});

describe("wrap", () => {
  test("greedy-wraps to width, preserves blank lines, never splits a word", () => {
    const lines = wrap("the quick brown fox\n\njumps", 9);
    expect(lines).toEqual(["the quick", "brown fox", "", "jumps"]);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(9);
  });

  test("a word longer than the width overflows on its own line", () => {
    expect(wrap("supercalifragilistic", 10)).toEqual(["supercalifragilistic"]);
  });
});

describe("makeColorer", () => {
  test("color:true wraps in code+reset; color:false is identity", () => {
    expect(C(ANSI.error, "x")).toBe(`${ANSI.error}x${ANSI.reset}`);
    expect(P(ANSI.error, "x")).toBe("x");
    expect(P(ANSI.error, "x")).not.toMatch(/\x1b\[/);
  });
});

describe("heading / headerLine / kv / emptyState", () => {
  test("heading with meta appends muted ' · meta'", () => {
    expect(plain(heading(P, "Budget", "agent oz"))).toBe("Budget · agent oz");
    expect(plain(heading(P, "By model"))).toBe("By model");
  });

  test("headerLine right-aligns meta to width when it fits", () => {
    const line = headerLine(P, "olle runs", "last 1d · 12 rows", 40);
    expect(line.length).toBe(40);
    expect(line.startsWith("olle runs")).toBe(true);
    expect(line.endsWith("last 1d · 12 rows")).toBe(true);
  });

  test("headerLine stacks onto two lines when too narrow", () => {
    const line = headerLine(P, "olle runs", "a very long meta string here", 20);
    expect(line.split("\n").length).toBe(2);
  });

  test("kv pads the label to labelWidth before the value", () => {
    expect(kv(P, "host", "abc", 8)).toBe("host    abc");
  });

  test("emptyState is a plain sentence plus the exact command", () => {
    const s = plain(emptyState(P, "No runs yet.", "olle runs --since 7d"));
    expect(s).toContain("No runs yet.");
    expect(s).toContain("olle runs --since 7d");
    expect(emptyState(P, "Nothing here.")).toBe("Nothing here.");
  });
});

// --- table ---------------------------------------------------------------

interface Row {
  name: string;
  calls: number;
  cost: string;
}

const ROWS: Row[] = [
  { name: "anthropic/claude-opus-4-8", calls: 2904, cost: "$1.98" },
  { name: "anthropic/claude-haiku-4-5", calls: 540, cost: "$0.31" },
];

describe("table", () => {
  test("fixed columns size to their widest cell; right-align shares an end column", () => {
    const lines = table(P, ROWS, [
      { cell: (r) => r.name },
      { cell: (r) => `${r.calls} calls`, align: "right" },
      { cell: (r) => r.cost, align: "right" },
    ], { width: 80, indent: "  " });
    expect(lines.length).toBe(2);
    // Every line ends at the same visible column (right-aligned last col).
    const ends = lines.map((l) => l.length);
    expect(new Set(ends).size).toBe(1);
    // The name column is left-padded to the widest name (haiku > opus), so
    // the shorter opus name carries a trailing space to the shared column.
    const widest = Math.max(...ROWS.map((r) => r.name.length));
    for (const l of lines) expect(l.startsWith("  ")).toBe(true);
    expect(lines[0]!.slice(2, 2 + widest)).toBe(ROWS[0]!.name.padEnd(widest));
  });

  test("a flex column absorbs leftover width and the line fits total width", () => {
    const width = 50;
    const lines = table(P, ROWS, [
      { cell: (r) => r.name, flex: true, min: 8 },
      { cell: (r) => `${r.calls}`, align: "right" },
      { cell: (r) => r.cost, align: "right" },
    ], { width, indent: "  " });
    for (const l of lines) expect(l.length).toBe(width);
  });

  test("flex column clips long cells with an ellipsis to honor total width", () => {
    const width = 24;
    const long = [{ name: "anthropic/claude-opus-4-8-super-long", calls: 1, cost: "$1" }];
    const lines = table(P, long, [
      { cell: (r) => r.name, flex: true, min: 6 },
      { cell: (r) => r.cost, align: "right" },
    ], { width, indent: "  " });
    expect(lines[0]!.length).toBe(width);
    expect(lines[0]).toContain("…");
  });

  test("plain-pad-then-color: color and no-color lines share visible width", () => {
    const spec = [
      { cell: (r: Row) => r.name, color: ANSI.text },
      { cell: (r: Row) => `${r.calls}`, align: "right" as const, color: ANSI.muted },
      {
        cell: (r: Row) => r.cost,
        align: "right" as const,
        color: (r: Row) => (r.cost === "$1.98" ? ANSI.error : ANSI.primary),
      },
    ];
    const colored = table(C, ROWS, spec, { width: 60, indent: "  " });
    const bare = table(P, ROWS, spec, { width: 60, indent: "  " });
    for (let i = 0; i < colored.length; i++) {
      expect(plain(colored[i]!)).toBe(bare[i]!);
      expect(vlen(colored[i]!)).toBe(bare[i]!.length);
    }
    // color:false path is escape-free.
    for (const l of bare) expect(l).not.toMatch(/\x1b\[/);
    // per-row color function fired (opus row is error-red).
    expect(colored[0]).toContain(ANSI.error);
  });
});
