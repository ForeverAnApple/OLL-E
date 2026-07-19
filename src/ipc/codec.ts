// Line-delimited JSON framing, shared by every peer that speaks the wire
// protocol in protocol.ts. Both the IPC client and server hand-rolled the
// same buffer/indexOf("\n") loop; the microVM host↔guest channel needs it
// too. One codec, one place to get the framing right.

/** Frame a message as a single newline-terminated JSON line. */
export function encodeLine(msg: unknown): string {
  return JSON.stringify(msg) + "\n";
}

/** Buffers partial byte input and reassembles newline-delimited lines. The
 *  internal buffer persists across calls so a message split across chunks
 *  joins back up. Two read surfaces share one buffer:
 *
 *  - `push` parses each completed line as JSON, silently skipping blank lines
 *    and parse failures (the client and channel policy).
 *  - `pushLines` returns the raw non-blank lines, leaving the JSON.parse
 *    decision to the caller — the server keeps its own "bad json" error reply,
 *    so it can't use the silent-skip parse. */
export class LineDecoder<T = unknown> {
  private buffer = "";

  /** Raw non-blank lines completed by this chunk. */
  pushLines(chunk: string | Buffer): string[] {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const out: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      out.push(line);
    }
    return out;
  }

  /** Parsed JSON values for completed lines; malformed lines skipped. */
  push(chunk: string | Buffer): T[] {
    const out: T[] = [];
    for (const line of this.pushLines(chunk)) {
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        continue;
      }
    }
    return out;
  }
}
