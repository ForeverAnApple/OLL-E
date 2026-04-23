// Agent runtime — a single conversation turn loop. Given messages, tools,
// and an LLM adapter, drives the "assistant → tool_use → tool_result →
// assistant → …" cycle until the model says end_turn (or we hit the cap).
//
// The loop is small on purpose: it's stateless and synchronous-shaped
// over the LLM call, so the daemon-side chat agent can drive it from a
// subscribed event or a direct request.

import type { ToolDef, ToolExecuteContext } from "../extensions/types.ts";
import type {
  CompletionRequest,
  ContentBlock,
  Llm,
  Message,
  ToolSpec,
  Usage,
} from "../llm/index.ts";

export interface AgentRunOptions {
  llm: Llm;
  model?: string;
  system?: string;
  tools?: ToolDef[];
  toolCtx: ToolExecuteContext;
  messages: Message[];
  maxTurns?: number;
  maxTokens?: number;
  temperature?: number;
  /** Hook for streaming step visibility into the event bus. */
  onStep?: (step: AgentStep) => void;
  /** Permission gate. Called before every tool.execute. Returning
   *  `{ ok: false, reason }` surfaces the reason to the model as an
   *  is_error tool_result and (if provided) onDenied fires so the caller
   *  can post a grant_scope proposal. Omit to allow all. */
  authorize?: (tool: ToolDef) => { ok: true } | { ok: false; reason: string };
  /** Side-effect hook fired on a denied call. Caller uses this to drop a
   *  grant_scope proposal on the inbox per the vision "constraints feel
   *  like physics" clause. */
  onDenied?: (info: { tool: ToolDef; reason: string; input: unknown }) => void;
}

export type AgentStep =
  | { kind: "assistant"; content: ContentBlock[] }
  | { kind: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; id: string; name: string; content: string; isError: boolean }
  | { kind: "usage"; usage: Usage; usdMicros: number };

export interface AgentResult {
  messages: Message[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "refusal" | "max_turns";
  totalUsage: Usage;
  totalUsdMicros: number;
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentResult> {
  const model = opts.model ?? opts.llm.defaultModel;
  const maxTurns = opts.maxTurns ?? 10;
  const toolSpecs: ToolSpec[] | undefined = opts.tools?.map(toToolSpec);
  const toolByName = new Map<string, ToolDef>();
  for (const t of opts.tools ?? []) toolByName.set(t.name, t);

  const messages: Message[] = [...opts.messages];
  const total: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let totalUsd = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const req: CompletionRequest = {
      model,
      messages,
      system: opts.system,
      maxTokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature,
    };
    if (toolSpecs && toolSpecs.length > 0) req.tools = toolSpecs;
    const completion = await opts.llm.complete(req);
    total.inputTokens += completion.usage.inputTokens;
    total.outputTokens += completion.usage.outputTokens;
    total.totalTokens += completion.usage.totalTokens;
    totalUsd += completion.usdMicros;

    opts.onStep?.({ kind: "assistant", content: completion.content });
    opts.onStep?.({ kind: "usage", usage: completion.usage, usdMicros: completion.usdMicros });

    messages.push({ role: "assistant", content: completion.content });

    if (completion.stopReason !== "tool_use") {
      return {
        messages,
        stopReason: completion.stopReason,
        totalUsage: total,
        totalUsdMicros: totalUsd,
      };
    }

    const toolResults: ContentBlock[] = [];
    for (const block of completion.content) {
      if (block.type !== "tool_use") continue;
      opts.onStep?.({
        kind: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      });
      const tool = toolByName.get(block.name);
      if (!tool) {
        const msg = `unknown tool: ${block.name}`;
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: msg,
          is_error: true,
        });
        opts.onStep?.({ kind: "tool_result", id: block.id, name: block.name, content: msg, isError: true });
        continue;
      }
      if (opts.authorize) {
        const gate = opts.authorize(tool);
        if (!gate.ok) {
          const msg = `permission denied: ${gate.reason}`;
          opts.onDenied?.({ tool, reason: gate.reason, input: block.input });
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: msg,
            is_error: true,
          });
          opts.onStep?.({
            kind: "tool_result",
            id: block.id,
            name: block.name,
            content: msg,
            isError: true,
          });
          continue;
        }
      }
      try {
        const args = tool.validate ? tool.validate(block.input) : block.input;
        const result = await tool.execute(args, opts.toolCtx);
        const rendered = typeof result === "string" ? result : JSON.stringify(result);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: rendered });
        opts.onStep?.({
          kind: "tool_result",
          id: block.id,
          name: block.name,
          content: rendered,
          isError: false,
        });
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: msg, is_error: true });
        opts.onStep?.({ kind: "tool_result", id: block.id, name: block.name, content: msg, isError: true });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  return { messages, stopReason: "max_turns", totalUsage: total, totalUsdMicros: totalUsd };
}

function toToolSpec(t: ToolDef): ToolSpec {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  };
}
