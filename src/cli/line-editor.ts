// Single-stream raw line editor for `olle chat`. Replaces node:readline
// because readline is single-line by design — no multi-line buffer, no
// bracketed-paste capture — both of which the chat input needs:
//   - Pasting a multi-line snippet must arrive as one message, not one
//     submit per embedded newline.
//   - Alt+Enter (and Opt+Enter on macOS) inserts a newline; plain Enter
//     submits.
//
// Scope deliberately small: no kill-by-word, no Emacs/vi modes, no
// reverse search, no soft-wrap accounting. Just enough editor to type a
// chat message comfortably and ergonomically. If we later need more, the
// surface here is small enough to grow.

import type { ReadStream, WriteStream } from "node:tty";

export interface LineEditorCallbacks {
  /** Plain Enter — submit the buffer. The editor has already erased its
   *  rendered input area before this fires; the caller may write
   *  scrollback content (e.g. a styled user-message gutter) and then
   *  call refresh() to show a fresh prompt for the next turn. */
  onSubmit(text: string): void | Promise<void>;
  /** Ctrl+C — caller decides exit semantics. */
  onAbort(): void;
  /** Ctrl+D on empty buffer — caller decides exit semantics. */
  onEof(): void;
  /** Optional Tab completion. Receives the full multi-line buffer; return
   *  the replacement text (cursor moves to end), or null to leave it. */
  onTab?(text: string): string | null;
  /** Fires after every buffer change (typing, paste, history nav). The
   *  caller can use this to drive the above-prompt slot via
   *  setAboveLine(). */
  onChange?(text: string): void;
}

export interface LineEditorOpts {
  in: ReadStream;
  out: WriteStream;
  /** First-line prompt (e.g. styled "❯ "). */
  prompt: string;
  /** Continuation prompt for line 2+. Pad to the same visible width as
   *  `prompt` so the cursor column is visually consistent across lines. */
  promptCont: string;
  callbacks: LineEditorCallbacks;
}

function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").length;
}

export class LineEditor {
  private buffer = "";
  private cursor = 0;
  private aboveLine: string | null = null;

  private pasting = false;
  private pasteBuf = "";
  private pendingEsc = ""; // partial escape sequence carried across chunks

  private renderedRow = 0; // cursor row offset from top of the rendered frame
  private renderedRows = 0; // total rows the last render occupied

  private listening = false;
  private suspended = false;

  private history: string[] = [];
  private historyIdx: number | null = null;
  private historyDraft = "";

  constructor(private opts: LineEditorOpts) {}

  start(): void {
    if (this.listening) return;
    this.listening = true;
    const { in: stdin, out } = this.opts;
    if (stdin.isTTY) stdin.setRawMode?.(true);
    stdin.setEncoding("utf8");
    if (out.isTTY) out.write("\x1b[?2004h"); // bracketed paste on
    stdin.on("data", this.handleData);
    stdin.resume();
    this.render();
  }

  close(): void {
    if (!this.listening) return;
    this.listening = false;
    const { in: stdin, out } = this.opts;
    stdin.removeListener("data", this.handleData);
    if (out.isTTY) out.write("\x1b[?2004l"); // bracketed paste off
    if (stdin.isTTY) {
      try {
        stdin.setRawMode?.(false);
      } catch {
        /* already gone */
      }
    }
  }

  /** Pause input handling and erase the rendered frame. Use during agent
   *  streaming so the prompt isn't sitting under the agent's output and
   *  user keystrokes don't silently accumulate into the next message. */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    this.eraseRender();
    this.opts.in.removeListener("data", this.handleData);
  }

  /** Resume after suspend(): re-attach the input listener and repaint. */
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.opts.in.on("data", this.handleData);
    this.render();
  }

  /** Set (or clear) the single ephemeral line painted directly above the
   *  prompt — status during idle, slash suggestions while typing `/…`.
   *  Cleared automatically on submit by eraseRender(). */
  setAboveLine(content: string | null): void {
    if (this.aboveLine === content) return;
    this.aboveLine = content;
    if (this.listening && !this.suspended) this.render();
  }

  /** Get the current buffer (e.g. for completer logic). */
  get text(): string {
    return this.buffer;
  }

  /** Erase the current rendered frame; cursor lands at column 0 of the
   *  row where the above-line started. Caller can then write scrollback
   *  content from that position. */
  eraseRender(): void {
    if (!this.opts.out.isTTY) return;
    const out = this.opts.out;
    if (this.renderedRow > 0) out.write(`\x1b[${this.renderedRow}A`);
    out.write("\r\x1b[J");
    this.renderedRow = 0;
    this.renderedRows = 0;
  }

  /** Force a re-render. Also un-suspends if currently suspended, so
   *  callers don't have to track suspend state — calling refresh() at
   *  the end of a turn always lands the user back at a working prompt. */
  refresh(): void {
    if (this.suspended) {
      this.suspended = false;
      this.opts.in.on("data", this.handleData);
    }
    this.render();
  }

  private render(): void {
    if (this.suspended) return;
    if (!this.opts.out.isTTY) return;
    const out = this.opts.out;
    this.eraseRender();

    if (this.aboveLine !== null) out.write(this.aboveLine + "\n");

    const lines = this.buffer.split("\n");
    const promptLen = visibleLen(this.opts.prompt);
    const contLen = visibleLen(this.opts.promptCont);
    for (let i = 0; i < lines.length; i++) {
      out.write(i === 0 ? this.opts.prompt : this.opts.promptCont);
      out.write(lines[i]!);
      if (i < lines.length - 1) out.write("\n");
    }

    const aboveRows = this.aboveLine !== null ? 1 : 0;
    this.renderedRows = aboveRows + lines.length;

    // Find which rendered line + col the cursor lands on.
    let inputRow = 0;
    let inputCol = 0;
    let abs = 0;
    for (let i = 0; i < lines.length; i++) {
      const len = lines[i]!.length;
      if (this.cursor <= abs + len) {
        inputRow = i;
        inputCol = this.cursor - abs;
        break;
      }
      abs += len + 1; // +1 for the implicit \n
    }

    // After printing, cursor sits at end of last input line. Move up to
    // the target line, then to its column.
    const upFromEnd = lines.length - 1 - inputRow;
    if (upFromEnd > 0) out.write(`\x1b[${upFromEnd}A`);
    out.write("\r");
    const promptVis = inputRow === 0 ? promptLen : contLen;
    const targetCol = promptVis + inputCol;
    if (targetCol > 0) out.write(`\x1b[${targetCol}C`);

    this.renderedRow = aboveRows + inputRow;

    this.opts.callbacks.onChange?.(this.buffer);
  }

  // ── Buffer mutations ───────────────────────────────────────────────

  private insert(text: string): void {
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
    this.invalidateHistory();
    this.render();
  }

  private backspace(): void {
    if (this.cursor === 0) return;
    this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
    this.cursor--;
    this.invalidateHistory();
    this.render();
  }

  private deleteForward(): void {
    if (this.cursor >= this.buffer.length) return;
    this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
    this.invalidateHistory();
    this.render();
  }

  private killLine(): void {
    this.buffer = "";
    this.cursor = 0;
    this.invalidateHistory();
    this.render();
  }

  private invalidateHistory(): void {
    this.historyDraft = this.buffer;
    this.historyIdx = null;
  }

  // ── Cursor movement ────────────────────────────────────────────────

  private moveLeft(): void {
    if (this.cursor > 0) {
      this.cursor--;
      this.render();
    }
  }
  private moveRight(): void {
    if (this.cursor < this.buffer.length) {
      this.cursor++;
      this.render();
    }
  }
  private moveLineStart(): void {
    const before = this.buffer.slice(0, this.cursor);
    const nl = before.lastIndexOf("\n");
    this.cursor = nl + 1;
    this.render();
  }
  private moveLineEnd(): void {
    const after = this.buffer.slice(this.cursor);
    const nl = after.indexOf("\n");
    this.cursor = nl === -1 ? this.buffer.length : this.cursor + nl;
    this.render();
  }

  // ── History ────────────────────────────────────────────────────────

  private historyPrev(): void {
    if (this.history.length === 0) return;
    if (this.historyIdx === null) {
      this.historyDraft = this.buffer;
      this.historyIdx = this.history.length - 1;
    } else if (this.historyIdx > 0) {
      this.historyIdx--;
    } else {
      return;
    }
    this.buffer = this.history[this.historyIdx]!;
    this.cursor = this.buffer.length;
    this.render();
  }
  private historyNext(): void {
    if (this.historyIdx === null) return;
    if (this.historyIdx < this.history.length - 1) {
      this.historyIdx++;
      this.buffer = this.history[this.historyIdx]!;
    } else {
      this.historyIdx = null;
      this.buffer = this.historyDraft;
    }
    this.cursor = this.buffer.length;
    this.render();
  }

  // ── Submit / Tab ───────────────────────────────────────────────────

  private submit(): void {
    const text = this.buffer;
    if (text && this.history[this.history.length - 1] !== text) {
      this.history.push(text);
    }
    this.buffer = "";
    this.cursor = 0;
    this.aboveLine = null;
    this.historyDraft = "";
    this.historyIdx = null;
    this.eraseRender();
    void this.opts.callbacks.onSubmit(text);
  }

  private handleTab(): void {
    if (!this.opts.callbacks.onTab) return;
    const replacement = this.opts.callbacks.onTab(this.buffer);
    if (replacement === null) return;
    this.buffer = replacement;
    this.cursor = replacement.length;
    this.invalidateHistory();
    this.render();
  }

  // ── Input dispatch ─────────────────────────────────────────────────

  private handleData = (chunk: string): void => {
    if (this.pendingEsc) {
      chunk = this.pendingEsc + chunk;
      this.pendingEsc = "";
    }
    let i = 0;
    while (i < chunk.length) {
      // Bracketed paste: capture verbatim until the end marker.
      if (this.pasting) {
        const end = chunk.indexOf("\x1b[201~", i);
        if (end === -1) {
          this.pasteBuf += chunk.slice(i);
          return;
        }
        this.pasteBuf += chunk.slice(i, end);
        i = end + "\x1b[201~".length;
        const paste = this.pasteBuf.replace(/\r\n?/g, "\n");
        this.pasteBuf = "";
        this.pasting = false;
        this.insert(paste);
        continue;
      }
      if (chunk.startsWith("\x1b[200~", i)) {
        this.pasting = true;
        i += "\x1b[200~".length;
        continue;
      }

      const ch = chunk[i]!;

      if (ch === "\r" || ch === "\n") {
        this.submit();
        i++;
        continue;
      }
      if (ch === "\x03") {
        // Ctrl+C
        this.opts.callbacks.onAbort();
        return;
      }
      if (ch === "\x04") {
        // Ctrl+D
        if (this.buffer === "") {
          this.opts.callbacks.onEof();
          return;
        }
        this.deleteForward();
        i++;
        continue;
      }
      if (ch === "\x7f" || ch === "\b") {
        this.backspace();
        i++;
        continue;
      }
      if (ch === "\t") {
        this.handleTab();
        i++;
        continue;
      }
      if (ch === "\x15") {
        this.killLine();
        i++;
        continue;
      } // Ctrl+U
      if (ch === "\x01") {
        this.moveLineStart();
        i++;
        continue;
      } // Ctrl+A
      if (ch === "\x05") {
        this.moveLineEnd();
        i++;
        continue;
      } // Ctrl+E

      if (ch === "\x1b") {
        const rest = chunk.slice(i);
        // Alt+Enter / Opt+Enter — newline within buffer. Some terminals
        // send \x1b\r; some \x1b\n.
        if (rest.length >= 2 && (rest[1] === "\r" || rest[1] === "\n")) {
          this.insert("\n");
          i += 2;
          continue;
        }
        // CSI / SS3 escape sequences.
        if (rest.length >= 2 && (rest[1] === "[" || rest[1] === "O")) {
          let j = 2;
          while (j < rest.length && !/[A-Za-z~]/.test(rest[j]!)) j++;
          if (j >= rest.length) {
            // Truncated — keep for next chunk.
            this.pendingEsc = rest;
            return;
          }
          const seq = rest.slice(0, j + 1);
          this.handleCsi(seq);
          i += seq.length;
          continue;
        }
        // Lone ESC — drop.
        i++;
        continue;
      }

      // Default: treat as printable. Skip remaining control chars.
      if (ch >= " ") this.insert(ch);
      i++;
    }
  };

  private handleCsi(seq: string): void {
    switch (seq) {
      case "\x1b[D":
        this.moveLeft();
        return;
      case "\x1b[C":
        this.moveRight();
        return;
      case "\x1b[A":
        this.historyPrev();
        return;
      case "\x1b[B":
        this.historyNext();
        return;
      case "\x1b[H":
      case "\x1bOH":
        this.moveLineStart();
        return;
      case "\x1b[F":
      case "\x1bOF":
        this.moveLineEnd();
        return;
      case "\x1b[3~":
        this.deleteForward();
        return;
      // Kitty keyboard protocol sends \x1b[13;2u for Shift+Enter and
      // \x1b[13;5u for Ctrl+Enter. Either inserts a newline. Without
      // the kitty protocol enabled, plain Shift+Enter is byte-identical
      // to Enter and falls through to submit — accepted limitation.
      case "\x1b[13;2u":
      case "\x1b[13;5u":
        this.insert("\n");
        return;
    }
    // Unknown — ignore.
  }
}
