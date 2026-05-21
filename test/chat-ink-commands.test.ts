// Pure-logic tests for the chat-ink slash command registry. Locks
// down the matching + completion shape so the UI layer (input-bar,
// app) keeps working when commands are added or renamed.

import { describe, expect, it } from "bun:test";
import {
  SLASH_COMMANDS,
  exactCommand,
  inlineSuggestions,
  matchSlash,
  splitSlash,
} from "../src/cli/chat-ink/commands.ts";

describe("chat-ink slash commands", () => {
  it("registry has unique canonical names, all leading with /", () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n.startsWith("/")).toBe(true);
  });

  it("splits head + arg, returns null for non-slash text", () => {
    expect(splitSlash("hello")).toBeNull();
    expect(splitSlash("/help")).toEqual({ head: "/help", arg: "" });
    expect(splitSlash("/model gpt-5")).toEqual({ head: "/model", arg: "gpt-5" });
    expect(splitSlash("/inbox  abc123  ")).toEqual({ head: "/inbox", arg: "abc123" });
  });

  it("matchSlash prefix-matches on the head only", () => {
    expect(matchSlash("/h").map((c) => c.name)).toEqual(["/help"]);
    // /c → /clear + /cancel (both start with /c).
    expect(matchSlash("/c").map((c) => c.name).sort()).toEqual(["/cancel", "/clear"]);
    expect(matchSlash("/zzz")).toEqual([]);
    expect(matchSlash("not-slash")).toEqual([]);
  });

  it("exactCommand resolves a fully-typed head", () => {
    expect(exactCommand("/help")?.name).toBe("/help");
    expect(exactCommand("/model gpt-5")?.name).toBe("/model");
    expect(exactCommand("/notreal")).toBeNull();
  });

  it("inlineSuggestions completes a unique command name", () => {
    expect(inlineSuggestions("/he")).toEqual(["/help "]);
    // Ambiguous /c → no inline ghost (the multi-match pane shows them).
    expect(inlineSuggestions("/c")).toEqual([]);
  });

  it("inlineSuggestions completes an argument from argChoices", () => {
    const suggs = inlineSuggestions("/model claude-");
    expect(suggs.length).toBeGreaterThan(0);
    for (const s of suggs) expect(s.startsWith("/model claude-")).toBe(true);
    // Commands without argChoices return nothing in arg position.
    expect(inlineSuggestions("/inbox foo")).toEqual([]);
  });
});
