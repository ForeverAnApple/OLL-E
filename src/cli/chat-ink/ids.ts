// Short prefixed ids for chat-ink — used both for visible thread ids
// (cli:abcd1234) and internal React keys (e:abcd1234). Bun's
// crypto.randomUUID is fine but too long for UI; base36-slice gives a
// 9-char tail with ~2.8T-value space, enough for a chat session.

export function mintId(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}`;
}
