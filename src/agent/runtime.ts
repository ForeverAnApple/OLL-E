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
  RetryInfo,
  SystemSegment,
  ToolSpec,
  Usage,
} from "../llm/index.ts";

export interface AgentRunOptions {
  llm: Llm;
  model?: string;
  /** A plain string is sent as a single cached system block. A
   *  SystemSegment[] lets the caller place the cache breakpoint between
   *  stable and volatile content (chat loop uses this for the mailbox
   *  sidebar). */
  system?: string | SystemSegment[];
  tools?: ToolDef[];
  /** Per-turn filter deciding which tools' schemas reach the LLM. Returns
   *  true for names whose schema should be sent on the next round-trip.
   *  Tools with `alwaysLoaded: true` are included regardless. The full
   *  `tools` list is still required for `execute()` lookup — execution
   *  is independent of which schemas were sent. Omit to send every tool
   *  every turn (legacy behavior). The callback is consulted at the
   *  start of each LLM round-trip, so a tool that mutates the loaded
   *  set (e.g. `load_tools`) becomes visible on the next round. */
  isLoaded?: (name: string) => boolean;
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
  | { kind: "assistant_delta"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; id: string; name: string; content: string; isError: boolean }
  | { kind: "usage"; usage: Usage }
  | { kind: "retry"; info: RetryInfo };

export interface AgentResult {
  messages: Message[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "refusal" | "max_turns";
  totalUsage: Usage;
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentResult> {
  const model = opts.model ?? opts.llm.defaultModel;
  const maxTurns = opts.maxTurns ?? 10;
  // Pre-flight: catch duplicate tool names before the provider 400s. Boot
  // invariants check this at daemon start, but extension hot-reload can
  // still introduce a collision with a core tool mid-session — re-checking
  // here turns a generic provider 400 into a named local error.
  const toolByName = new Map<string, ToolDef>();
  for (const t of opts.tools ?? []) {
    if (toolByName.has(t.name)) {
      throw new Error(
        `runAgent: duplicate tool name "${t.name}" in registry — refusing to call provider`,
      );
    }
    toolByName.set(t.name, t);
  }

  const messages: Message[] = [...opts.messages];
  const total: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 0,
  };

  for (let turn = 0; turn < maxTurns; turn++) {
    // Filter the tool surface per round-trip so a `load_tools` call
    // mutating the loaded set (external to runAgent) becomes visible
    // on the very next LLM call without rebuilding the runtime.
    const visibleTools = filterVisibleTools(opts.tools, opts.isLoaded);
    const toolSpecs: ToolSpec[] | undefined = visibleTools?.map(toToolSpec);
    const req: CompletionRequest = {
      model,
      messages,
      system: opts.system,
      maxTokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature,
    };
    if (toolSpecs && toolSpecs.length > 0) req.tools = toolSpecs;
    req.onRetry = (info) => opts.onStep?.({ kind: "retry", info });
    req.onTextDelta = (delta) => opts.onStep?.({ kind: "assistant_delta", text: delta });
    const completion = await opts.llm.complete(req);
    total.inputTokens += completion.usage.inputTokens;
    total.outputTokens += completion.usage.outputTokens;
    total.cacheReadInputTokens += completion.usage.cacheReadInputTokens;
    total.cacheCreationInputTokens += completion.usage.cacheCreationInputTokens;
    total.totalTokens += completion.usage.totalTokens;

    opts.onStep?.({ kind: "assistant", content: completion.content });
    opts.onStep?.({ kind: "usage", usage: completion.usage });

    messages.push({ role: "assistant", content: completion.content });

    if (completion.stopReason !== "tool_use") {
      return {
        messages,
        stopReason: completion.stopReason,
        totalUsage: total,
      };
    }

    const toolResults: ContentBlock[] = [];
    const pushResult = (id: string, name: string, content: string, isError: boolean) => {
      toolResults.push(
        isError
          ? { type: "tool_result", tool_use_id: id, content, is_error: true }
          : { type: "tool_result", tool_use_id: id, content },
      );
      opts.onStep?.({ kind: "tool_result", id, name, content, isError });
    };
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
        pushResult(block.id, block.name, `unknown tool: ${block.name}`, true);
        continue;
      }
      if (opts.authorize) {
        const gate = opts.authorize(tool);
        if (!gate.ok) {
          opts.onDenied?.({ tool, reason: gate.reason, input: block.input });
          pushResult(block.id, block.name, `permission denied: ${gate.reason}`, true);
          continue;
        }
      }
      try {
        const args = tool.validate ? tool.validate(block.input) : block.input;
        const result = await tool.execute(args, opts.toolCtx);
        const rendered = typeof result === "string" ? result : JSON.stringify(result);
        pushResult(block.id, block.name, rendered, false);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        pushResult(block.id, block.name, msg, true);
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  return { messages, stopReason: "max_turns", totalUsage: total };
}

function toToolSpec(t: ToolDef): ToolSpec {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  };
}

function filterVisibleTools(
  tools: ToolDef[] | undefined,
  isLoaded: ((name: string) => boolean) | undefined,
): ToolDef[] | undefined {
  if (!tools) return undefined;
  if (!isLoaded) return tools;
  return tools.filter((t) => t.alwaysLoaded === true || isLoaded(t.name));
}
