import { describe, expect, it } from "bun:test";
import { plainTheme, renderMarkdown } from "../src/cli/markdown.ts";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

describe("CLI markdown rendering", () => {
  it("can render markdown without ANSI escapes for non-TTY output", () => {
    const lines = renderMarkdown(
      [
        "# Heading",
        "",
        "Use **bold**, `code`, and [docs](https://example.test).",
        "",
        "```ts",
        "const x = 1;",
        "```",
      ].join("\n"),
      80,
      plainTheme,
    );

    const output = lines.join("\n");
    expect(output).not.toMatch(ANSI_RE);
    expect(output).toContain("# Heading");
    expect(output).toContain("Use bold, code, and docs (https://example.test).");
    expect(output).toContain("const x = 1;");
  });
});
