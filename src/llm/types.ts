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

export interface CompletionRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolSpec[];
  maxTokens: number;
  temperature?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Total including cache reads/writes if the provider reports them. */
  totalTokens: number;
}

export interface Completion {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "refusal";
  usage: Usage;
  /** Micro-USD cost if the adapter can compute it, else 0. */
  usdMicros: number;
}

export interface Llm {
  readonly provider: string;
  readonly defaultModel: string;
  complete(req: CompletionRequest): Promise<Completion>;
}
