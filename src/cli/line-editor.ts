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
  /** Ctrl+C arrived while the editor was suspended (the chat is streaming).
   *  Lets the caller route a turn-cancel without resuming the editor. When
   *  omitted, suspended Ctrl+C falls back to onAbort(). */
  onStreamCancel?(): void;
}

export interface LineEditorOpts {
  in: ReadStream;
  out: WriteStream;
  /** First-line prompt (e.g. styled "❯ "). */
  prompt: string;
  /** Continuation prompt for line 2+. Pad to the same visible width as
   *  `prompt` so the cursor column is visually consistent across lines. */
  promptCont: string;
  /** Optional top frame line drawn directly above the input area. Called
   *  fresh per render so the caller can recompute against current
   *  `out.columns`. Returning null/undefined elides the row. */
  frameTop?: () => string | null | undefined;
  /** Optional bottom frame line drawn directly below the input area. Same
   *  contract as `frameTop`. */
  frameBottom?: () => string | null | undefined;
  /** Optional tray rows drawn inside the frame, between the top border
   *  and the input prompt. Used for queued user messages awaiting the
   *  daemon's mailbox drain (see `chat.input-folded`) — visually they
   *  sit pinned above the input until the agent folds them in, at
   *  which point the caller drops them and the regular scrollback
   *  commit lands. Each entry is a single pre-styled visible row (no
   *  embedded `\n`); long entries should be truncated by the caller
   *  to avoid soft-wrapping the editor frame's row math. Returning
   *  null/undefined or an empty array elides the section. */
  tray?: () => string[] | null | undefined;
  callbacks: LineEditorCallbacks;
}

function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").length;
}

/** Clip a styled string so its visible width (ANSI escapes excluded)
 *  stays within `maxCols`. Pass-through for CSI escape sequences (no
 *  width cost). When the content already fits, returns it verbatim.
 *  When it doesn't, walks to `maxCols - 1` printable chars and
 *  appends `…` (which itself takes the last column). */
function clipVisible(s: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  if (visibleLen(s) <= maxCols) return s;
  let visible = 0;
  let out = "";
  let i = 0;
  const budget = maxCols - 1;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "\x1b" && s[i + 1] === "[") {
      const j = s.slice(i + 2).search(/[A-Za-z]/);
      const end = j === -1 ? s.length : i + 2 + j + 1;
      out += s.slice(i, end);
      i = end;
      continue;
    }
    if (visible >= budget) break;
    out += ch;
    visible += 1;
    i += 1;
  }
  return out + "…";
}

/** Strip non-printable control bytes from pasted content, keeping only
 *  newline and tab. A clipboard snippet that includes BEL, BS, FF, raw
 *  ESC etc. would otherwise either ring the terminal bell, repaint the
 *  prompt mid-buffer, or worse — bracketed-paste only protects against
 *  embedded `\n` becoming submits, not against arbitrary control bytes. */
function sanitizePaste(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const code = ch.charCodeAt(0);
    if (ch === "\n" || ch === "\t") {
      out += ch;
      continue;
    }
    // C0 controls (0x00-0x1F) other than \n/\t, plus DEL (0x7F) and the
    // C1 range (0x80-0x9F). Everything else passes through (including
    // multi-byte UTF-8 since this is a JS string of code units).
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    out += ch;
  }
  return out;
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
    stdin.removeListener("data", this.handleStreamData);
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
   *  user keystrokes don't silently accumulate into the next message.
   *  Ctrl+C still routes (to onStreamCancel, falling back to onAbort) so
   *  the user can interrupt a running turn — raw mode swallows the SIGINT
   *  the OS would otherwise generate, so the editor has to read it itself. */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    this.eraseRender();
    this.opts.in.removeListener("data", this.handleData);
    this.opts.in.on("data", this.handleStreamData);
  }

  /** Resume after suspend(): re-attach the input listener and repaint. */
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.opts.in.removeListener("data", this.handleStreamData);
    this.opts.in.on("data", this.handleData);
    this.render();
  }

  /** Slim listener installed while suspended. Reads only Ctrl+C; drops
   *  everything else on the floor. */
  private handleStreamData = (chunk: string): void => {
    if (chunk.includes("\x03")) {
      const cb = this.opts.callbacks;
      if (cb.onStreamCancel) cb.onStreamCancel();
      else cb.onAbort();
    }
  };

  /** Set (or clear) the single ephemeral line painted directly above the
   *  prompt — status during idle, slash suggestions while typing `/…`.
   *  Cleared automatically on submit by eraseRender().
   *
   *  Defensively clipped to `out.columns - 1` visible characters so a
   *  producer that miscalculates its target width can't soft-wrap the
   *  slot into a second row. The editor's renderedRow accounts for
   *  exactly one above-line row; a wrap that the editor doesn't see
   *  leaves the stranded row in scrollback as a ghost on the next
   *  eraseRender. */
  setAboveLine(content: string | null): void {
    const clipped = content !== null ? clipVisible(content, this.out1Cols()) : null;
    if (this.aboveLine === clipped) return;
    this.aboveLine = clipped;
    if (this.listening && !this.suspended) this.render();
  }

  private out1Cols(): number {
    const w = this.opts.out.columns ?? 80;
    return Math.max(1, w - 1);
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
      this.opts.in.removeListener("data", this.handleStreamData);
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

    const frameTop = this.opts.frameTop?.() ?? null;
    if (frameTop) out.write(frameTop + "\n");

    // Tray sits between the frame top and the input prompt. Each entry
    // is one visible row; we trust the caller to keep them within
    // `out.columns` (run.ts truncates queued messages before passing
    // them in) so the row math stays accurate without needing
    // soft-wrap accounting here.
    const trayLines = this.opts.tray?.() ?? null;
    const trayRows = trayLines?.length ?? 0;
    if (trayLines) {
      for (const line of trayLines) out.write(line + "\n");
    }

    const lines = this.buffer.split("\n");
    const promptLen = visibleLen(this.opts.prompt);
    const contLen = visibleLen(this.opts.promptCont);
    const w = Math.max(1, this.opts.out.columns ?? 80);

    // Visual rows per logical line, accounting for soft-wrap *and* for
    // cursor parking. When `promptVis + lineLen` is exactly a multiple
    // of width the terminal parks the cursor at col=w of the current
    // row; whether it actually advances to col 0 of the next row is
    // terminal-dependent (xterm/iTerm/kitty/alacritty park; some
    // others advance immediately). We sidestep that ambiguity by
    // emitting an explicit `\n` after any parked line below, and
    // counting that phantom row here. Without this, `renderedRow`
    // drifts +1 on backspace-across-wrap, eraseRender moves up too
    // far, and \x1b[J chews into the visible scrollback above the
    // chat area.
    const visualRows = lines.map((line, i) => {
      const promptVis = i === 0 ? promptLen : contLen;
      const totalVis = promptVis + line.length;
      if (totalVis === 0) return 1;
      return Math.floor(totalVis / w) + 1;
    });
    const totalInputRows = visualRows.reduce((a, b) => a + b, 0);

    for (let i = 0; i < lines.length; i++) {
      out.write(i === 0 ? this.opts.prompt : this.opts.promptCont);
      out.write(lines[i]!);
      const promptVis = i === 0 ? promptLen : contLen;
      const totalVis = promptVis + lines[i]!.length;
      const isLast = i === lines.length - 1;
      const parked = totalVis > 0 && totalVis % w === 0;
      // Emit `\n` between logical lines normally. For the trailing
      // line, emit `\n` *only* if it parked at the wrap column — that
      // forces the terminal off the parking position so our cursor
      // bookkeeping has a stable anchor.
      if (!isLast || parked) out.write("\n");
    }

    const frameBottom = this.opts.frameBottom?.() ?? null;
    if (frameBottom) {
      // Always advance to a fresh row for the border, regardless of
      // parking. After the input loop the cursor sits either at the
      // end of the last content row (not parked) or at col 0 of the
      // phantom parking row. A single `\n` lands us on a clean row
      // beneath all input either way; the border then occupies that
      // row and the cursor reposition logic below moves up past it
      // back into the editing area.
      out.write("\n" + frameBottom);
    }

    // Cursor's visual position within the input frame. For visualCol
    // exactly at a multiple of width (parking on the line containing
    // the cursor), this lands on `row=N, col=0` of the phantom row —
    // exactly where the explicit `\n` above leaves the terminal.
    let inputVisualRow = 0;
    let inputVisualCol = 0;
    let abs = 0;
    let priorRows = 0;
    for (let i = 0; i < lines.length; i++) {
      const len = lines[i]!.length;
      if (this.cursor <= abs + len) {
        const promptVis = i === 0 ? promptLen : contLen;
        const visualCol = promptVis + (this.cursor - abs);
        inputVisualRow = priorRows + Math.floor(visualCol / w);
        inputVisualCol = visualCol % w;
        break;
      }
      abs += len + 1;
      priorRows += visualRows[i]!;
    }

    // Where the cursor sits right now (in input-area row coords) after
    // all rendering: end of last input row when there's no bottom
    // border, or one row below all input when there is.
    const cursorAtEnd = totalInputRows - (frameBottom ? 0 : 1);
    const upFromEnd = cursorAtEnd - inputVisualRow;
    if (upFromEnd > 0) out.write(`\x1b[${upFromEnd}A`);
    out.write("\r");
    if (inputVisualCol > 0) out.write(`\x1b[${inputVisualCol}C`);

    const aboveRows = this.aboveLine !== null ? 1 : 0;
    const topRows = frameTop ? 1 : 0;
    const bottomRows = frameBottom ? 1 : 0;
    this.renderedRow = aboveRows + topRows + trayRows + inputVisualRow;
    this.renderedRows =
      aboveRows + topRows + trayRows + totalInputRows + bottomRows;

    this.opts.callbacks.onChange?.(this.buffer);
  }

  // ── Buffer mutations ───────────────────────────────────────────────

  private insert(text: string): void {
    const fast = this.canFastAppend(text);
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
    this.invalidateHistory();
    if (fast) {
      this.opts.out.write(text);
      this.opts.callbacks.onChange?.(this.buffer);
      // setAboveLine() (driven by onChange) will only call render() if
      // the slot's content actually changed — and during plain typing
      // outside slash-prefix mode it doesn't, so we stay on the fast
      // path and avoid the full erase+redraw per keystroke.
      return;
    }
    this.render();
  }

  /** True iff an insert of `text` can be painted by writing it straight
   *  to stdout without invoking the full erase+redraw. Conditions:
   *
   *   - TTY output (otherwise we have nothing to write into);
   *   - editor not suspended (the agent is streaming; nothing to paint);
   *   - cursor sits at the end of the buffer (otherwise the chars after
   *     the cursor would be visually overwritten);
   *   - text contains no newline (multi-line edits change row layout);
   *   - the inserted chars don't reach the soft-wrap column (crossing
   *     `width` parks the cursor on the next visual row, which our
   *     bookkeeping doesn't track on the fast path).
   *
   *  This is the dominant case during ordinary typing, so the fast path
   *  saves the full prompt+buffer rewrite on every keystroke.
   */
  private canFastAppend(text: string): boolean {
    if (!this.opts.out.isTTY) return false;
    if (this.suspended) return false;
    if (this.cursor !== this.buffer.length) return false;
    if (text.length === 0) return false;
    if (text.includes("\n")) return false;
    const w = Math.max(1, this.opts.out.columns ?? 80);
    const nlIdx = this.buffer.lastIndexOf("\n");
    const lastLine = nlIdx === -1 ? this.buffer : this.buffer.slice(nlIdx + 1);
    const promptVis =
      nlIdx === -1 ? visibleLen(this.opts.prompt) : visibleLen(this.opts.promptCont);
    const totalVis = promptVis + lastLine.length;
    const beforeCol = totalVis % w;
    // "Parked" — content written exactly fills a visual row, cursor is
    // at col=w (or col=0 of next, terminal-dependent). Bail to full
    // render so the next char's row offset is recomputed from scratch.
    if (totalVis > 0 && beforeCol === 0) return false;
    // Inserted chars must not reach or cross the wrap column.
    return beforeCol + text.length < w;
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

  /** Ctrl+W — delete the word ending at the cursor. Word boundary is
   *  whitespace; runs of trailing whitespace immediately before the
   *  cursor count as part of the word being killed (so a single Ctrl+W
   *  on `foo bar |` lands on `foo `, not `foo bar`). */
  private killPrevWord(): void {
    if (this.cursor === 0) return;
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.buffer[i - 1]!)) i--;
    while (i > 0 && !/\s/.test(this.buffer[i - 1]!)) i--;
    this.buffer = this.buffer.slice(0, i) + this.buffer.slice(this.cursor);
    this.cursor = i;
    this.invalidateHistory();
    this.render();
  }

  /** Ctrl+L — wipe the screen and re-anchor the prompt at the top. Also
   *  drop any in-flight paste state: a Ctrl+L mid-bracketed-paste would
   *  otherwise leave `pasting=true` and a stray `\x1b[201~` later in the
   *  same chunk would commit the half-captured `pasteBuf` as if the
   *  user had pasted it, which is exactly the kind of phantom edit
   *  that's hard to debug. Wipe-the-canvas should mean wipe-the-state. */
  private clearScreen(): void {
    if (!this.opts.out.isTTY) return;
    this.opts.out.write("\x1b[H\x1b[2J\x1b[3J");
    this.renderedRow = 0;
    this.renderedRows = 0;
    this.pasting = false;
    this.pasteBuf = "";
    this.pendingEsc = "";
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
        const paste = sanitizePaste(this.pasteBuf.replace(/\r\n?/g, "\n"));
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
        // Paste-fallback heuristic. Bracketed paste (above) is the canonical
        // path; this catches terminals that strip the markers (tmux without
        // proper config, some SSH paths). A real Enter keypress arrives as
        // its own 1-byte chunk; a paste arrives bundled. If there are more
        // printable bytes after this newline in the same chunk, treat the
        // newline as embedded — otherwise submit.
        const after = chunk.slice(i + 1);
        if (/[^\r\n]/.test(after)) {
          this.insert("\n");
          i += ch === "\r" && chunk[i + 1] === "\n" ? 2 : 1;
          continue;
        }
        this.submit();
        i++;
        continue;
      }
      if (ch === "\x03") {
        // Ctrl+C: standard line-editor convention. A non-empty buffer
        // is dropped (the in-flight line goes away); only an
        // already-empty buffer escalates to onAbort, which is where
        // callers wire two-tap quit / cancel-stream semantics. This
        // means the first Ctrl+C is always "scrap what I'm typing,"
        // never an unintended exit-arm.
        if (this.buffer.length > 0) {
          this.killLine();
          i++;
          continue;
        }
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
      if (ch === "\x17") {
        this.killPrevWord();
        i++;
        continue;
      } // Ctrl+W
      if (ch === "\x0c") {
        this.clearScreen();
        i++;
        continue;
      } // Ctrl+L
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
