// Pure editing core for the chat input: word/line motion + deletion,
// and the key-chord → edit decision. Kept framework-free so it can be
// unit-tested without a terminal. The .tsx wrapper owns React state and
// rendering; everything with an off-by-one risk lives here.

export type State = { value: string; cursor: number };

export type Action =
  | { type: "move"; to: number }
  | { type: "insert"; text: string }
  | { type: "delete-range"; from: number; to: number; cursor: number };

/** Subset of ink's Key we act on. */
export type KeyLike = {
  ctrl: boolean;
  meta: boolean;
  return: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  upArrow: boolean;
  downArrow: boolean;
  pageUp: boolean;
  pageDown: boolean;
  home: boolean;
  end: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  escape: boolean;
};

export type Decision =
  | { kind: "action"; action: Action }
  | { kind: "submit" }
  | { kind: "noop" };

const isWs = (c: string | undefined): boolean => c === undefined || /\s/.test(c);

/** First offset of the word to the left of `cur`: skip whitespace, then
 *  the word body. Whitespace-delimited — the boring, predictable rule. */
export function wordLeft(value: string, cur: number): number {
  let i = cur;
  while (i > 0 && isWs(value[i - 1])) i--;
  while (i > 0 && !isWs(value[i - 1])) i--;
  return i;
}

/** Offset just past the word to the right of `cur`. */
export function wordRight(value: string, cur: number): number {
  let i = cur;
  while (i < value.length && isWs(value[i])) i++;
  while (i < value.length && !isWs(value[i])) i++;
  return i;
}

export function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "move":
      return { ...state, cursor: Math.max(0, Math.min(state.value.length, action.to)) };
    case "insert":
      return {
        value: state.value.slice(0, state.cursor) + action.text + state.value.slice(state.cursor),
        cursor: state.cursor + action.text.length,
      };
    case "delete-range": {
      const raw = action.from <= action.to ? [action.from, action.to] : [action.to, action.from];
      const lo = Math.max(0, raw[0]!);
      const hi = Math.min(state.value.length, raw[1]!);
      return {
        value: state.value.slice(0, lo) + state.value.slice(hi),
        cursor: Math.max(0, Math.min(state.value.length - (hi - lo), action.cursor)),
      };
    }
  }
}

/** Map a keypress to an edit decision against the current buffer.
 *  Ctrl+C / Ctrl+D are not handled here — the app owns quit / EOF. */
export function decide(input: string, key: KeyLike, state: State): Decision {
  const { value, cursor } = state;
  const noop: Decision = { kind: "noop" };
  const move = (to: number): Decision => ({ kind: "action", action: { type: "move", to } });
  const del = (from: number, to: number, cur: number): Decision => ({
    kind: "action",
    action: { type: "delete-range", from, to, cursor: cur },
  });
  const wordy = key.meta || key.ctrl;

  if (key.ctrl && (input === "c" || input === "d")) return noop;
  if (key.upArrow || key.downArrow || key.tab || key.pageUp || key.pageDown) return noop;

  if (key.return) return { kind: "submit" };

  // Motion
  if (key.leftArrow) return move(wordy ? wordLeft(value, cursor) : cursor - 1);
  if (key.rightArrow) return move(wordy ? wordRight(value, cursor) : cursor + 1);
  if (key.home || (key.ctrl && input === "a")) return move(0);
  if (key.end || (key.ctrl && input === "e")) return move(value.length);

  // Line-wise deletion
  if (key.ctrl && input === "u") return del(0, cursor, 0);
  if (key.ctrl && input === "k") return del(cursor, value.length, cursor);

  // Word-wise deletion: Ctrl+W or Alt/Ctrl+Backspace (back); Alt+D or Alt/Ctrl+Delete (forward)
  if ((key.ctrl && input === "w") || (key.backspace && wordy)) {
    const to = wordLeft(value, cursor);
    return del(to, cursor, to);
  }
  if ((key.meta && input === "d") || (key.delete && wordy)) {
    return del(cursor, wordRight(value, cursor), cursor);
  }

  // Char-wise deletion
  if (key.backspace) return del(cursor - 1, cursor, cursor - 1);
  if (key.delete) return del(cursor, cursor + 1, cursor);

  // Swallow any other control/meta chord rather than inserting a control char.
  if (key.ctrl || key.meta || key.escape) return noop;

  if (input) return { kind: "action", action: { type: "insert", text: input } };
  return noop;
}
