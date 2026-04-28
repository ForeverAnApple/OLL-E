// Tool-result truncation. The runtime calls into here after a tool's
// `execute` returns, before the result enters the message history. Outputs
// over the cap get spilled to the tool_results store and replaced inline
// with a preview + handle marker; the agent recovers the rest via the
// always-loaded `read_tool_result` tool.
//
// Stable replacement state. Once a tool_use_id has been truncated, every
// subsequent rendering of that block uses the byte-identical preview.
// Without this, replaying the same conversation would produce different
// preview text on each turn (different timestamp, different size string)
// and the prompt-cache prefix would invalidate. We pay 1.25× for each
// cache write — a single replacement-instability bug erases the entire
// reason to truncate.

const PERSISTED_TAG_OPEN = "<persisted-output>";
const PERSISTED_TAG_CLOSE = "</persisted-output>";

export const DEFAULT_MAX_RESULT_BYTES = 50_000;
export const DEFAULT_MAX_MESSAGE_BYTES = 200_000;
export const PREVIEW_BYTES = 8_000;

export interface PersistFn {
  (input: {
    id: string;
    toolName: string;
    content: string;
  }): void;
}

export interface TruncationState {
  /** id → exact preview string emitted on first replacement. Re-emit
   *  byte-identically forever after to preserve cache prefix stability. */
  readonly seen: Map<string, string>;
}

export function createTruncationState(): TruncationState {
  return { seen: new Map() };
}

export interface TruncateOptions {
  state: TruncationState;
  /** System-wide cap. Per-tool `maxResultBytes` overrides up to this. */
  maxBytesPerCall: number;
  /** Aggregate cap across all tool_results in one assistant→tools round.
   *  Catches the "N parallel tools each at 49KB" failure mode the per-call
   *  cap leaves open. */
  maxBytesPerMessage: number;
  persist: PersistFn;
}

/** Decide whether a single tool's rendered content needs replacement.
 *  Honors per-tool `maxResultBytes` capped by the system limit. */
export function maybeTruncateOne(args: {
  id: string;
  toolName: string;
  content: string;
  perToolMaxBytes?: number;
  options: TruncateOptions;
}): string {
  const { id, toolName, content, perToolMaxBytes, options } = args;
  const cached = options.state.seen.get(id);
  if (cached !== undefined) return cached;

  const cap = Math.min(
    perToolMaxBytes ?? options.maxBytesPerCall,
    options.maxBytesPerCall,
  );
  if (Buffer.byteLength(content, "utf8") <= cap) return content;

  return spill({ id, toolName, content, options });
}

/** After per-call truncation, the parallel batch may still aggregate over
 *  the per-message cap. Spill the largest blocks first until the message
 *  fits under budget. Mutates `blocks` and updates state.
 *
 *  Stability comes from selecting "largest first" deterministically — same
 *  inputs, same output, byte-identical preview text via the cache lookup. */
export function enforceMessageBudget(
  blocks: Array<{ id: string; name: string; content: string }>,
  options: TruncateOptions,
): void {
  let total = 0;
  for (const b of blocks) total += Buffer.byteLength(b.content, "utf8");
  if (total <= options.maxBytesPerMessage) return;

  const order = blocks
    .map((b, i) => ({ i, size: Buffer.byteLength(b.content, "utf8") }))
    .sort((a, b) => b.size - a.size || a.i - b.i);

  for (const { i } of order) {
    const block = blocks[i]!;
    const before = Buffer.byteLength(block.content, "utf8");
    const cached = options.state.seen.get(block.id);
    block.content =
      cached ??
      spill({ id: block.id, toolName: block.name, content: block.content, options });
    const after = Buffer.byteLength(block.content, "utf8");
    total -= before - after;
    if (total <= options.maxBytesPerMessage) return;
  }
}

function spill(args: {
  id: string;
  toolName: string;
  content: string;
  options: TruncateOptions;
}): string {
  args.options.persist({
    id: args.id,
    toolName: args.toolName,
    content: args.content,
  });
  const preview = previewOf(args.content);
  const replacement = renderReplacement({
    id: args.id,
    totalBytes: Buffer.byteLength(args.content, "utf8"),
    preview,
    hasMore: preview.length < args.content.length,
  });
  args.options.state.seen.set(args.id, replacement);
  return replacement;
}

function previewOf(content: string): string {
  if (content.length <= PREVIEW_BYTES) return content;
  const sliced = content.slice(0, PREVIEW_BYTES);
  const lastBreak = sliced.lastIndexOf("\n");
  if (lastBreak > PREVIEW_BYTES * 0.5) return sliced.slice(0, lastBreak);
  return sliced;
}

function renderReplacement(args: {
  id: string;
  totalBytes: number;
  preview: string;
  hasMore: boolean;
}): string {
  const sizeLabel = formatBytes(args.totalBytes);
  const previewLabel = formatBytes(Buffer.byteLength(args.preview, "utf8"));
  const lines = [
    PERSISTED_TAG_OPEN,
    `Output too large (${sizeLabel}). Full output saved to: tool-result/${args.id}`,
    "",
    `Preview (first ${previewLabel}):`,
    args.preview,
  ];
  if (args.hasMore) {
    lines.push("...");
    lines.push(
      `Use read_tool_result(handle="${args.id}", offset=N, limit=N) to fetch more.`,
    );
  }
  lines.push(PERSISTED_TAG_CLOSE);
  return lines.join("\n");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}
