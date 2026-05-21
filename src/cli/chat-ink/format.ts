// Small formatting helpers shared across chat-ink components. Lifted
// out of app.tsx so the inbox renderer doesn't bury domain types and
// glyph maps inside a React file.

export interface InboxRow {
  id: string;
  proposingAgentId: string;
  proposingAgentName?: string;
  tier: string;
  summary: string;
  status: string;
  createdAt: number;
  unreadReplyCount?: number;
  payload?: Record<string, unknown>;
}

/** Human-relative duration: 12s · 3m · 2h · 5d. Negative input
 *  (clock skew on a freshly-created row) clamps to 0s. */
export function fmtAge(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/** Length-capped string with a trailing ellipsis. */
export function clipString(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Single-char glyph encoding the inbox row's resolution state. */
export function statusGlyph(status: string): string {
  switch (status) {
    case "open":     return "●";
    case "approved": return "✓";
    case "denied":   return "✗";
    case "modified": return "±";
    case "stale":    return "·";
    default:         return " ";
  }
}
