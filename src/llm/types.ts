// Provider-neutral LLM types. Adapters map these to/from vendor-specific
// shapes. Deliberately small — we add fields as they start to matter.

export type Role = "user" | "assistant" | "system" | "tool";

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
/** Extended-thinking block. Carries the model's reasoning text (empty when
 *  display is omitted) plus a `signature` the API requires echoed back
 *  verbatim on the next turn — drop it and a tool-use turn 400s. */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}
/** Encrypted thinking the API redacted. Opaque to us; must also be echoed
 *  back verbatim across tool-use turns. */
export interface RedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock;

/** Reasoning-effort level. Maps to Anthropic's `output_config.effort`
 *  (GA on Opus 4.5+/Sonnet 4.6); paired with adaptive thinking when set.
 *  `xhigh` is Opus 4.7+, `max` is Opus-tier only. */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Message {
  role: Role;
  content: string | ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input, passed directly to the vendor. */
  inputSchema: Record<string, unknown>;
}

/** A piece of the system prompt with optional cache marking. The order
 *  matters — earlier segments form the prefix Anthropic caches against,
 *  so put stable content first and volatile content last. Mark only the
 *  tail of the stable region with `cache: "ephemeral"` (the breakpoint).
 *  Volatile segments after it are sent uncached and don't invalidate
 *  the prefix when they change. */
export interface SystemSegment {
  text: string;
  cache?: "ephemeral";
}

export interface RetryInfo {
  /** 1-indexed attempt that just failed (so retry #1 means the first call
   *  errored and we're about to make a second). */
  attempt: number;
  /** HTTP status if the failure was an APIError. */
  status?: number;
  /** Provider/error message, for display. */
  message?: string;
}

export interface CompletionRequest {
  model: string;
  /** Either a single string (the whole system prompt; cached as one block)
   *  or a structured array of segments where you control the cache breakpoint. */
  system?: string | SystemSegment[];
  messages: Message[];
  tools?: ToolSpec[];
  maxTokens: number;
  /** Reasoning effort. When set, the Anthropic adapter enables adaptive
   *  thinking and sends `output_config.effort`. undefined = no thinking
   *  (the historical default). Mutually exclusive with `temperature` on
   *  Opus 4.7/4.8, which reject sampling params — the adapter drops
   *  temperature when effort is set. */
  effort?: ReasoningEffort;
  temperature?: number;
  /** Fired by the adapter when a transient failure (overload, rate limit,
   *  5xx) triggered the SDK's retry. Fires once per retry attempt at the
   *  start of the new attempt — the SDK owns the backoff timing, so we
   *  can't report ms-until-next-attempt up front. Surface for the UI to
   *  show "API busy, retrying…" rather than letting the user stare at a
   *  frozen prompt. */
  onRetry?: (info: RetryInfo) => void;
  /** Fired with each text delta as it streams in from the provider. The
   *  adapter still returns the assembled Completion; this is purely a
   *  visibility hook for surfaces (CLI, future bridges) that want to
   *  render tokens as they arrive instead of waiting for the full block. */
  onTextDelta?: (delta: string) => void;
  /** Cancel the in-flight request. The adapter forwards this to the SDK;
   *  on abort the call rejects with an AbortError. Lets the agent loop
   *  surface a Ctrl-C from the CLI as a real network interrupt rather
   *  than waiting for the full response and discarding it. */
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from prompt cache (cheap reads). 0 if provider doesn't report. */
  cacheReadInputTokens: number;
  /** Tokens written to prompt cache (premium first-time). 0 if provider doesn't report. */
  cacheCreationInputTokens: number;
  /** Total including cache reads/writes if the provider reports them. */
  totalTokens: number;
}

export interface Completion {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "refusal";
  usage: Usage;
}

export interface Llm {
  readonly provider: string;
  readonly defaultModel: string;
  complete(req: CompletionRequest): Promise<Completion>;
}
