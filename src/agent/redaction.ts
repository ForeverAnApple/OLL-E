// Redaction helpers for tool inputs that the agent loop must not persist
// or trace verbatim (e.g. `set_secret` value bodies). Pure functions keyed
// off a tool's `sensitiveInputFields`; chat.ts builds the map once per
// turn and reuses it for both the live event stream and the on-disk
// thread snapshot.

import type { Message } from "../llm/index.ts";
import type { ToolDef } from "../extensions/types.ts";

export function buildRedactionMap(tools: ToolDef[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const t of tools) {
    if (t.sensitiveInputFields && t.sensitiveInputFields.length) {
      m.set(t.name, t.sensitiveInputFields);
    }
  }
  return m;
}

export function redactInput(input: unknown, fields: string[]): Record<string, unknown> {
  const src = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...src };
  for (const f of fields) {
    if (f in out) out[f] = "[redacted]";
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
