// Internal one-shot seam. The `Llm` shim (./as-llm.ts) needs a plain
// system+prompt round-trip with NO MCP tools and NO session — the incidental
// `llm.complete` callers (a 1-token liveness probe, manager construction that
// requires an Llm) don't want the full CLI-brain turn machinery. Rather than
// spawn a dead MCP server via runTurn, each adapter exposes this lighter path
// and the shim uses it directly.

import type { Usage } from "../types.ts";

export interface OneShotRequest {
  system?: string;
  prompt: string;
  model?: string;
  signal?: AbortSignal;
}

export interface OneShotResult {
  text: string;
  usage: Usage;
}

/** A CliBrain that also offers a tool-less one-shot completion. Both adapters
 *  implement it; ./as-llm.ts consumes it. */
export interface OneShotBrain {
  oneShot(req: OneShotRequest): Promise<OneShotResult>;
}
