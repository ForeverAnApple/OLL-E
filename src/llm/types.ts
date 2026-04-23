// Provider-neutral LLM types. Adapters map these to/from vendor-specific
// shapes. Deliberately small — we add fields as they start to matter.

import type { z } from "zod";

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
  /** JSON-schema-like input shape. Adapters convert Zod → JSON Schema. */
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

/** Utility: turn a Zod schema into a JSON-schema-ish shape good enough
 *  for vendor tool-use specs. Adapters may further normalize. */
export function zodToJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  // Use Zod's own internals when available; fall back to a minimal shape.
  const def = (schema as unknown as { _def?: { shape?: () => Record<string, z.ZodType> } })._def;
  if (def?.shape) {
    const shape = def.shape();
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, sub] of Object.entries(shape)) {
      properties[key] = zodLeaf(sub);
      if (!sub.isOptional()) required.push(key);
    }
    return { type: "object", properties, required, additionalProperties: false };
  }
  return { type: "object" };
}

function zodLeaf(sub: z.ZodType<unknown>): Record<string, unknown> {
  const name = (sub as unknown as { _def?: { typeName?: string } })._def?.typeName ?? "";
  switch (name) {
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodArray":
      return { type: "array" };
    case "ZodObject":
      return zodToJsonSchema(sub);
    default:
      return {};
  }
}
