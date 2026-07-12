// Shared Message[] -> plain-text flattener for the CLI-brain path. Two callers
// need to collapse a conversation into a role-labeled prompt string:
//   - as-llm.ts renders the one-shot `Llm` shim's messages (tool_use dropped,
//     tool_result rendered as its raw content, only non-user/assistant roles
//     labeled).
//   - the chat loop renders a prior transcript when a fresh CLI session opens on
//     a thread that already has history (tool_use -> `[called x]`, tool_result
//     -> `[tool result: ...]`, every role labeled `User:`/`Assistant:`).
//
// The block rendering and role labeling genuinely differ between the two (their
// output feeds different consumers — a live resumed session vs a liveness
// probe — so neither format may drift), so only the traversal is shared here:
// both parameterize how a block and a role-label are rendered.

import type { ContentBlock, Message, Role } from "../types.ts";

export interface FlattenOptions {
  /** Render one content block to text; return "" to drop it from the output. */
  renderBlock: (block: ContentBlock) => string;
  /** Turn a message's role + already-flattened body into its final line. */
  label: (role: Role, text: string) => string;
  /** Separator between blocks within one message. Default "\n". */
  blockSeparator?: string;
  /** Separator between messages. Default "\n\n". */
  messageSeparator?: string;
}

/** Flatten a message list into one plain-text string. Empty-bodied messages are
 *  dropped so a tool-only turn doesn't leave a bare role label. */
export function flattenMessages(messages: Message[], opts: FlattenOptions): string {
  const blockSep = opts.blockSeparator ?? "\n";
  const msgSep = opts.messageSeparator ?? "\n\n";
  return messages
    .map((m) => {
      const text =
        typeof m.content === "string"
          ? m.content
          : m.content
              .map(opts.renderBlock)
              .filter((t) => t.length > 0)
              .join(blockSep);
      if (text.length === 0) return "";
      return opts.label(m.role, text);
    })
    .filter((t) => t.length > 0)
    .join(msgSep);
}
