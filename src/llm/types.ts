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

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

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

export interface CompletionRequest {
  model: string;
  /** Either a single string (the whole system prompt; cached as one block)
   *  or a structured array of segments where you control the cache breakpoint. */
  system?: string | SystemSegment[];
  messages: Message[];
  tools?: ToolSpec[];
  maxTokens: number;
  temperature?: number;
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
