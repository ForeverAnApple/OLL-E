// Pure-logic tests for the chat input's editing core: word/line motion
// and deletion, plus the key-chord → edit decision. Locks down the
// keybindings @inkjs/ui's <TextInput> was missing (Ctrl/Alt+Backspace,
// Ctrl+W/U/K, word-wise arrows) so the terminal editing behaves like
// every other editor.

import { describe, expect, it } from "bun:test";
import {
  decide,
  reduce,
  wordLeft,
  wordRight,
  type KeyLike,
  type State,
} from "../src/cli/chat-ink/text-edit.ts";

const KEY_BASE: KeyLike = {
  ctrl: false,
  meta: false,
  return: false,
  leftArrow: false,
  rightArrow: false,
  upArrow: false,
  downArrow: false,
  pageUp: false,
  pageDown: false,
  home: false,
  end: false,
  tab: false,
  backspace: false,
  delete: false,
  escape: false,
};
const k = (over: Partial<KeyLike>): KeyLike => ({ ...KEY_BASE, ...over });

/** Apply one keypress: decide, then reduce. Submit/noop leave state as-is. */
function press(state: State, input: string, key: KeyLike): State {
  const d = decide(input, key, state);
  return d.kind === "action" ? reduce(state, d.action) : state;
}

describe("word boundaries", () => {
  it("wordLeft skips trailing whitespace then the word", () => {
    expect(wordLeft("foo bar", 7)).toBe(4); // |bar -> start of bar
    expect(wordLeft("foo bar ", 8)).toBe(4); // trailing space + bar
    expect(wordLeft("foo", 0)).toBe(0); // at start, nowhere to go
    expect(wordLeft("  foo", 5)).toBe(2);
  });

  it("wordRight skips leading whitespace then the word", () => {
    expect(wordRight("foo bar", 0)).toBe(3);
    expect(wordRight("foo bar", 3)).toBe(7); // space + bar
    expect(wordRight("foo", 3)).toBe(3); // at end
  });
});

describe("char editing", () => {
  it("inserts printable input at the cursor", () => {
    expect(press({ value: "", cursor: 0 }, "h", k({}))).toEqual({ value: "h", cursor: 1 });
    expect(press({ value: "ac", cursor: 1 }, "b", k({}))).toEqual({ value: "abc", cursor: 2 });
  });

  it("backspace at offset 0 is a no-op (no phantom char loss)", () => {
    expect(press({ value: "abc", cursor: 0 }, "", k({ backspace: true }))).toEqual({
      value: "abc",
      cursor: 0,
    });
  });

  it("backspace deletes the char before the cursor", () => {
    expect(press({ value: "abc", cursor: 3 }, "", k({ backspace: true }))).toEqual({
      value: "ab",
      cursor: 2,
    });
    expect(press({ value: "abc", cursor: 1 }, "", k({ backspace: true }))).toEqual({
      value: "bc",
      cursor: 0,
    });
  });

  it("delete removes the char after the cursor; no-op at end", () => {
    expect(press({ value: "abc", cursor: 1 }, "", k({ delete: true }))).toEqual({
      value: "ac",
      cursor: 1,
    });
    expect(press({ value: "abc", cursor: 3 }, "", k({ delete: true }))).toEqual({
      value: "abc",
      cursor: 3,
    });
  });
});

describe("word + line deletion", () => {
  const line = { value: "hello world foo", cursor: 15 } as State;

  it("Ctrl+W deletes the word before the cursor", () => {
    expect(press(line, "w", k({ ctrl: true }))).toEqual({ value: "hello world ", cursor: 12 });
  });

  it("Alt+Backspace and Ctrl+Backspace also delete the word back", () => {
    expect(press(line, "", k({ backspace: true, meta: true }))).toEqual({
      value: "hello world ",
      cursor: 12,
    });
    expect(press(line, "", k({ backspace: true, ctrl: true }))).toEqual({
      value: "hello world ",
      cursor: 12,
    });
  });

  it("Alt+D and Ctrl+Delete delete the word forward", () => {
    const mid = { value: "hello world", cursor: 5 } as State; // "hello| world"
    expect(press(mid, "d", k({ meta: true }))).toEqual({ value: "hello", cursor: 5 });
    expect(press(mid, "", k({ delete: true, ctrl: true }))).toEqual({ value: "hello", cursor: 5 });
  });

  it("Ctrl+U deletes to line start, Ctrl+K to line end", () => {
    const mid = { value: "hello world", cursor: 6 } as State; // "hello |world"
    expect(press(mid, "u", k({ ctrl: true }))).toEqual({ value: "world", cursor: 0 });
    expect(press(mid, "k", k({ ctrl: true }))).toEqual({ value: "hello ", cursor: 6 });
  });
});

describe("motion", () => {
  const s = { value: "hello world", cursor: 5 } as State;

  it("arrows move one char and clamp at bounds", () => {
    expect(press(s, "", k({ leftArrow: true })).cursor).toBe(4);
    expect(press(s, "", k({ rightArrow: true })).cursor).toBe(6);
    expect(press({ value: "x", cursor: 0 }, "", k({ leftArrow: true })).cursor).toBe(0);
    expect(press({ value: "x", cursor: 1 }, "", k({ rightArrow: true })).cursor).toBe(1);
  });

  it("Alt/Ctrl + arrows move by word", () => {
    expect(press(s, "", k({ leftArrow: true, meta: true })).cursor).toBe(0);
    expect(press(s, "", k({ rightArrow: true, ctrl: true })).cursor).toBe(11);
  });

  it("Home/End and Ctrl+A/E jump to the ends", () => {
    expect(press(s, "", k({ home: true })).cursor).toBe(0);
    expect(press(s, "", k({ end: true })).cursor).toBe(11);
    expect(press(s, "a", k({ ctrl: true })).cursor).toBe(0);
    expect(press(s, "e", k({ ctrl: true })).cursor).toBe(11);
  });
});

describe("decision routing", () => {
  const s = { value: "abc", cursor: 3 } as State;

  it("Ctrl+C / Ctrl+D defer to the app (noop here)", () => {
    expect(decide("c", k({ ctrl: true }), s).kind).toBe("noop");
    expect(decide("d", k({ ctrl: true }), s).kind).toBe("noop");
  });

  it("Enter submits; Up/Down/Tab are inert", () => {
    expect(decide("", k({ return: true }), s).kind).toBe("submit");
    expect(decide("", k({ upArrow: true }), s).kind).toBe("noop");
    expect(decide("", k({ downArrow: true }), s).kind).toBe("noop");
    expect(decide("", k({ tab: true }), s).kind).toBe("noop");
  });

  it("stray escape / control chords never insert", () => {
    expect(decide("", k({ escape: true }), s).kind).toBe("noop");
    expect(decide("z", k({ ctrl: true }), s).kind).toBe("noop");
  });
});
