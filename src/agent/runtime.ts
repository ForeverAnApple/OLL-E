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
import {
  enforceMessageBudget,
  maybeTruncateOne,
  type TruncateOptions,
} from "./tool-truncate.ts";

export interface AgentRunOptions {
  llm: Llm;
  model?: string;
  /** A plain string is sent as a single cached system block. A
   *  SystemSegment[] lets the caller place the cache breakpoint between
   *  stable and volatile content (chat loop uses this for the mailbox
   *  sidebar). */
  system?: string | SystemSegment[];
  tools?: ToolDef[];
  /** Live tool getter, called fresh at the start of every round-trip.
   *  Use this when the tool surface can mutate inside a turn (e.g. an
   *  agent calls `register_extension` mid-turn — the new tool needs to
   *  appear in the LLM's tool list and become dispatchable on the very
   *  next round-trip). When omitted, falls back to the static `tools`
   *  array (legacy behavior; fine for callers whose tool set is fixed
   *  for the whole turn, like tests). */
  getTools?: () => ToolDef[];
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
  /** Tool-result truncation policy. When supplied, oversize outputs are
   *  spilled to a durable handle and replaced with a stable preview block.
   *  Per-thread state is the caller's responsibility — pass the same
   *  TruncationState across turns of one thread to keep the prompt cache
   *  prefix stable. */
  truncate?: TruncateOptions;
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

  // Resolve the tool surface for the next round-trip. `getTools` (when
  // supplied) is re-read each call so a mid-turn register/unload becomes
  // visible immediately. Duplicates are deduped first-wins rather than
  // thrown — the provider would 400 on the second copy, but trapping the
  // whole agent loop on a registry inconsistency is anti-vision (limits
  // should feel like physics, not refusals). The registration boundary
  // is the canonical guard; this is defense-in-depth.
  function resolveTools(): { tools: ToolDef[]; byName: Map<string, ToolDef> } {
    const raw = opts.getTools ? opts.getTools() : opts.tools ?? [];
    const tools: ToolDef[] = [];
    const byName = new Map<string, ToolDef>();
    for (const t of raw) {
      if (byName.has(t.name)) {
        console.warn(
          `[runAgent] duplicate tool name "${t.name}" in registry — keeping first, dropping later copy`,
        );
        continue;
      }
      byName.set(t.name, t);
      tools.push(t);
    }
    return { tools, byName };
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
    const { tools: roundTools, byName: toolByName } = resolveTools();
    const visibleTools = filterVisibleTools(roundTools, opts.isLoaded);
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

    // Gate dispatch on actual content, not stop_reason. Anthropic emits
    // stop_reason="pause_turn" (and our adapter folds it to "end_turn")
    // when long parallel-tool batches are split — the assistant message
    // still carries tool_use blocks that must be answered before the next
    // user turn, or the API 400s with "tool_use ids were found without
    // tool_result blocks". Same applies to max_tokens / refusal endings
    // that nonetheless include tool_use blocks.
    const hasToolUse = completion.content.some((b) => b.type === "tool_use");
    if (!hasToolUse) {
      return {
        messages,
        stopReason: completion.stopReason,
        totalUsage: total,
      };
    }

    interface PendingResult {
      id: string;
      name: string;
      content: string;
      isError: boolean;
    }
    const pending: PendingResult[] = [];
    const pushResult = (id: string, name: string, content: string, isError: boolean) => {
      pending.push({ id, name, content, isError });
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
        const safeResult = redactToolResult(tool, result);
        const rendered = typeof safeResult === "string" ? safeResult : JSON.stringify(safeResult);
        let final = rendered;
        if (opts.truncate && !tool.sensitiveOutput) {
          final = maybeTruncateOne({
            id: block.id,
            toolName: block.name,
            content: rendered,
            perToolMaxBytes: tool.maxResultBytes,
            options: opts.truncate,
          });
        }
        pushResult(block.id, block.name, final, false);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        pushResult(block.id, block.name, msg, true);
      }
    }
    if (opts.truncate) {
      enforceMessageBudget(
        pending.filter((p) => !p.isError),
        opts.truncate,
      );
    }
    const toolResults: ContentBlock[] = [];
    for (const r of pending) {
      toolResults.push(
        r.isError
          ? { type: "tool_result", tool_use_id: r.id, content: r.content, is_error: true }
          : { type: "tool_result", tool_use_id: r.id, content: r.content },
      );
      opts.onStep?.({
        kind: "tool_result",
        id: r.id,
        name: r.name,
        content: r.content,
        isError: r.isError,
      });
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

function redactToolResult(tool: ToolDef, result: unknown): unknown {
  if (tool.sensitiveOutput) return "[redacted]";
  const fields = tool.sensitiveOutputFields;
  if (!fields || fields.length === 0) return result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const out: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  for (const f of fields) {
    if (f in out) out[f] = "[redacted]";
  }
  return out;
}
