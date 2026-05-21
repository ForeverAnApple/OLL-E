// Short prefixed ids for chat-ink — used both for visible thread ids
// (cli:abcd1234) and internal React keys (e:abcd1234). Bun's
// crypto.randomUUID is fine but too long for UI; base36-slice gives a
// 9-char tail with ~2.8T-value space, enough for a chat session.

const PREFIX = {
  /** CLI-minted thread id. Visible in the footer; rotates on /clear. */
  thread: "cli:",
  /** React key for a scrollback entry. */
  entry: "e:",
  /** Synthetic tool-result id (only when the daemon omits one — rare). */
  tool: "tool:",
} as const;

function mint(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}`;
}

export const mintThreadId = (): string => mint(PREFIX.thread);
export const mintEntryId = (): string => mint(PREFIX.entry);
export const mintToolId = (): string => mint(PREFIX.tool);
