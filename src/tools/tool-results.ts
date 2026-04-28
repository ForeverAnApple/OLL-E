// Recovery surface for spilled tool output. When a tool returns more than
// the byte cap, the runtime persists the full content and replaces the
// inline block with a preview + handle. The agent uses this tool to slice
// back into the persisted content on demand — no implicit re-inflation,
// the agent decides whether the rest of the output is worth its context.
//
// Always-loaded: every thread that touches a fat tool needs this within
// the same turn. Loadout cost is one extra LLM round-trip; that's a real
// papercut for the recovery path the agent didn't choose to be in.

import type { ToolDef } from "../extensions/types.ts";
import type { ToolResultStore } from "../store/tool-results.ts";

export interface ToolResultToolsOptions {
  store: ToolResultStore;
  /** Soft cap on the slice size returned in a single call. Agents asking
   *  for more bytes are quietly clamped to this; the response includes
   *  hasMore + nextOffset so the agent can paginate. Mirrors the
   *  truncation cap the runtime applies elsewhere — same physics. */
  maxSliceBytes?: number;
}

const DEFAULT_MAX_SLICE_BYTES = 16_000;

export function buildToolResultTools(opts: ToolResultToolsOptions): ToolDef[] {
  const maxSlice = opts.maxSliceBytes ?? DEFAULT_MAX_SLICE_BYTES;

  const read: ToolDef<
    { handle: string; offset?: number; limit?: number },
    {
      handle: string;
      toolName: string;
      totalBytes: number;
      offset: number;
      returnedBytes: number;
      hasMore: boolean;
      nextOffset: number | null;
      content: string;
    } | { error: string }
  > = {
    name: "read_tool_result",
    category: "tool results",
    shortClause: "fetch a slice of a spilled tool output",
    alwaysLoaded: true,
    description:
      "Read a slice of a tool result that was spilled to durable storage " +
      "because it exceeded the inline byte cap. The handle is the id from the " +
      "<persisted-output> block (the part after 'tool-result/'). Use offset " +
      "and limit to paginate; the response includes hasMore and nextOffset.",
    inputSchema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description:
            "The persisted tool-use id. Accepts the bare id or a 'tool-result/<id>' path.",
        },
        offset: { type: "number", minimum: 0, default: 0 },
        limit: {
          type: "number",
          minimum: 1,
          description: `Max bytes to return. Clamped to ${maxSlice}.`,
        },
      },
      required: ["handle"],
      additionalProperties: false,
    },
    execute: ({ handle, offset = 0, limit }) => {
      const id = normalizeHandle(handle);
      const wantBytes = Math.min(limit ?? maxSlice, maxSlice);
      const result = opts.store.read(id, { offset, limit: wantBytes });
      if (!result) {
        return { error: `no persisted tool result for handle: ${id}` };
      }
      return {
        handle: id,
        toolName: result.meta.toolName,
        totalBytes: result.totalBytes,
        offset: result.offset,
        returnedBytes: Buffer.byteLength(result.content, "utf8"),
        hasMore: result.hasMore,
        nextOffset: result.hasMore
          ? result.offset + Buffer.byteLength(result.content, "utf8")
          : null,
        content: result.content,
      };
    },
  };

  return [read];
}

function normalizeHandle(raw: string): string {
  const trimmed = raw.trim();
  const prefix = "tool-result/";
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}
