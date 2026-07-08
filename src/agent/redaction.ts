// Redaction helpers for tool inputs that the agent loop must not persist
// or trace verbatim (e.g. `set_secret` value bodies). Pure functions keyed
// off a tool's `sensitiveInputFields`; chat.ts keeps a turn-local union so
// tools registered mid-turn redact immediately, and tools later unloaded in
// that same turn still redact from the final on-disk thread snapshot.

import type { Message } from "../llm/index.ts";
import type { ToolDef } from "../extensions/types.ts";

export function buildRedactionMap(tools: ToolDef[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  mergeRedactionMap(m, tools);
  return m;
}

export function mergeRedactionMap(m: Map<string, string[]>, tools: ToolDef[]): void {
  for (const t of tools) {
    if (t.sensitiveInputFields && t.sensitiveInputFields.length) {
      m.set(t.name, t.sensitiveInputFields);
    }
  }
}

export function redactInput(input: unknown, fields: string[]): Record<string, unknown> {
  const src = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...src };
  for (const f of fields) {
    if (f in out) out[f] = "[redacted]";
  }
  return out;
}

/** Minimum secret-value length eligible for value-level scrubbing. A
 *  floor keeps a short token (e.g. "1234") from redacting every incidental
 *  substring in a tool result. Eight chars is well below any real API key
 *  and above the noise. */
export const MIN_SECRET_SCRUB_LEN = 8;

/** Replace every exact occurrence of a known secret VALUE in `content` with
 *  `[redacted:<NAME>]`. This is distinct from the input-field redaction
 *  above: that hides declared `sensitiveInputFields` on a tool's *input*;
 *  this catches a secret's raw bytes surfacing in a tool *result* — e.g. an
 *  agent that reads `~/.olle/secrets/FOO` through a shell tool. Applied
 *  before a result enters message history / thread snapshots / the
 *  `chat.tool-result` event, so the value never lands in a durable
 *  transcript. Assistant text and user input are deliberately left alone:
 *  by induction the model can't repeat a value it never saw. */
export function scrubSecrets(content: string, secrets: Map<string, string>): string {
  if (!content) return content;
  let out = content;
  for (const [name, value] of secrets) {
    if (value.length < MIN_SECRET_SCRUB_LEN) continue;
    if (!out.includes(value)) continue;
    // split/join is a literal, all-occurrences replace (no regex escaping).
    out = out.split(value).join(`[redacted:${name}]`);
  }
  return out;
}

export function redactMessages(
  messages: Message[],
  redactions: Map<string, string[]>,
): Message[] {
  return messages.map((m) => {
    if (m.role !== "assistant" || typeof m.content === "string") return m;
    const content = (m.content as unknown[]).map((block) => {
      const b = block as { type?: string; name?: string; input?: unknown };
      if (b.type !== "tool_use" || !b.name) return block;
      const fields = redactions.get(b.name);
      if (!fields) return block;
      return { ...b, input: redactInput(b.input, fields) };
    });
    return { ...m, content } as Message;
  });
}
