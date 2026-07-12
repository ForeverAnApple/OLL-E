// CLI-brain adapter contract.
//
// A CliBrain runs one agent turn by driving a logged-in coding-agent CLI
// (`claude -p --output-format stream-json`, `codex exec --json`) as the LLM
// backend. Unlike an `Llm` (which returns one round-trip and lets OLL-E's
// runAgent loop own tool dispatch), a CliBrain owns the entire inner
// LLM<->tool loop inside the CLI process. OLL-E's tools reach that loop over
// MCP via the bridge (see ../../mcp/contract.ts); the chat loop delegates the
// whole turn and records the resulting usage.

import type { ReasoningEffort, Usage } from "../types.ts";
import type { BridgeInvocation } from "../../mcp/contract.ts";

export type CliBrainProbeStatus = "ready" | "needs-login" | "not-installed" | "broken";

/** Result of the cheap liveness probe the detection ladder runs to decide
 *  whether this CLI can back the chat agent. `ready` = installed AND logged in
 *  AND a one-shot hello round-tripped. */
export interface CliProbeResult {
  status: CliBrainProbeStatus;
  /** Human-readable detail for the disabled-reason string / logs. */
  detail?: string;
  /** Actionable recovery hint when status is needs-login (e.g. "run: claude login"). */
  loginHint?: string;
  version?: string;
}

export type CliErrorCode =
  | "auth_required"
  | "quota"
  | "transient"
  | "not_installed"
  | "spawn_failed"
  | "parse_error"
  | "refusal"
  | "unknown";

export interface CliTurnRequest {
  /** Fully composed system prompt (identity + principles + catalog + sidebar,
   *  already joined). Injected on FRESH sessions only — resuming a session
   *  must not re-send it (wastes thousands of tokens/turn and some CLIs reject
   *  combining a system-prompt flag with resume). */
  system: string;
  /** The new user input driving this turn. */
  prompt: string;
  /** Rendered prior transcript, supplied ONLY when starting a fresh session on
   *  a thread that already has history (e.g. after a daemon restart dropped
   *  the in-memory session id). Empty/omitted on a genuinely new thread. */
  priorTranscript?: string;
  /** Resume an existing CLI session instead of starting fresh. When set, the
   *  adapter passes the CLI's resume flag and does NOT re-send system/transcript. */
  resumeSessionId?: string;
  /** How the harness should reach OLL-E's tools. The adapter renders this into
   *  its CLI-specific MCP config. */
  bridge: BridgeInvocation;
  model?: string;
  effort?: ReasoningEffort;
  signal?: AbortSignal;
  /** Streaming visibility hook — fires per assistant text delta. The assembled
   *  final `text` is still returned in the result. */
  onTextDelta?: (delta: string) => void;
}

export interface CliTurnResult {
  /** Final assistant text for the turn. */
  text: string;
  usage: Usage;
  /** CLI session id to resume on the next turn of this thread. */
  sessionId?: string;
  stopReason: "end_turn" | "max_turns" | "refusal" | "error";
  error?: { code: CliErrorCode; message: string; loginHint?: string };
}

export interface CliBrain {
  /** Ledger/pricing provider key. Must exist in pricing PRICES with $0 rates
   *  (subscription turns record tokens, bill $0). e.g. "claude-cli". */
  readonly provider: string;
  /** Model label reported into the ledger / turn-end event. */
  readonly defaultModel: string;
  probe(signal?: AbortSignal): Promise<CliProbeResult>;
  runTurn(req: CliTurnRequest): Promise<CliTurnResult>;
}
