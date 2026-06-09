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
  ReasoningEffort,
  RetryInfo,
  SystemSegment,
  ToolSpec,
  Usage,
} from "../llm/index.ts";
import { clampEffort, maxOutputTokens } from "../llm/index.ts";
import {
  enforceMessageBudget,
  maybeTruncateOne,
  type TruncateOptions,
} from "./tool-truncate.ts";

export interface AgentRunOptions {
  llm: Llm;
  model?: string;
  /** Reasoning effort. When set, enables adaptive thinking at this depth
   *  (see CompletionRequest.effort) and raises the default max_tokens so
   *  thinking + output don't truncate. */
  effort?: ReasoningEffort;
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
  /** Cancel the in-flight turn. Forwarded to the LLM call so streaming
   *  aborts at network level; also checked between rounds so a fired
   *  abort during a tool call ends the turn before the next LLM hop. */
  signal?: AbortSignal;
  /** Mid-turn user inbox. Drained at every round-trip boundary (and
   *  one final time when the model would otherwise end_turn). New
   *  user messages typed while the agent was streaming or running a
   *  tool get folded into the next LLM call as turn-extending input —
   *  the conversational counterpart to "humans are events." Returns
   *  the messages to append (caller is expected to splice them out of
   *  whatever queue holds them, so calling drains). When omitted, the
   *  loop behaves exactly as before: messages are captured once at
   *  turn-top and never re-read. */
  mailbox?: () => Message[];
}

export type AgentStep =
  | { kind: "assistant"; content: ContentBlock[] }
  | { kind: "assistant_delta"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  // `tool_result_live` is the UX-facing event: fires the moment a tool's
  // output is computed (post per-tool cap, *pre* aggregate-budget cap).
  // Non-durable when published — pure surface signalling. UX subscribers
  // (CLI, future bridges) consume it; observability / federation do not.
  | { kind: "tool_result_live"; id: string; name: string; content: string; isError: boolean }
  // `tool_result` is the canonical event: fires after the aggregate
  // budget pass with the exact content the model receives in its tool
  // results message. Durable, persisted, replayable, federation-safe.
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
  // Clamp the requested effort to what this model accepts. The model and
  // effort are independently-chosen memories; an unsupported pair (e.g.
  // `max` on Sonnet, any effort on Haiku) would 400 every turn and the
  // agent couldn't recover. clampEffort degrades to the highest supported
  // level, or undefined (no thinking) when the model has no effort dial.
  const effort = opts.effort ? clampEffort(model, opts.effort) : undefined;
  // Thinking + output share the response budget. 4096 (the no-thinking
  // default) truncates mid-thought once reasoning is on; high/xhigh/max
  // can spend a lot of tokens thinking, so give the bigger dials more room.
  // Never exceed the model's own output ceiling, or the call 400s.
  const effortDefault = effort
    ? effort === "xhigh" || effort === "max"
      ? 64_000
      : 32_000
    : 4096;
  const defaultMaxTokens = Math.min(effortDefault, maxOutputTokens(model));

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
    if (opts.signal?.aborted) throw abortError(opts.signal);
    // Drain the mid-turn mailbox before the next LLM call. Mailbox
    // delivery only ever lands user-role messages, and only at this
    // boundary (between a completed `tool_result` and the next
    // assistant call) — the API rejects user messages between a
    // `tool_use` and its `tool_result`, so this is the single safe
    // injection point. On iteration 0 the mailbox is normally empty
    // (messages that arrived before runAgent are already in the
    // initial array); a non-empty drain here just means the caller
    // bundled extras explicitly.
    const earlyInbox = opts.mailbox?.() ?? [];
    if (earlyInbox.length > 0) messages.push(...earlyInbox);
    const { tools: roundTools, byName: toolByName } = resolveTools();
    const visibleTools = filterVisibleTools(roundTools, opts.isLoaded);
    const toolSpecs: ToolSpec[] | undefined = visibleTools?.map(toToolSpec);
    const req: CompletionRequest = {
      model,
      messages,
      system: opts.system,
      // An explicit maxTokens still can't exceed the model's ceiling.
      maxTokens: Math.min(opts.maxTokens ?? defaultMaxTokens, maxOutputTokens(model)),
      temperature: opts.temperature,
    };
    if (effort) req.effort = effort;
    if (toolSpecs && toolSpecs.length > 0) req.tools = toolSpecs;
    req.onRetry = (info) => opts.onStep?.({ kind: "retry", info });
    req.onTextDelta = (delta) => opts.onStep?.({ kind: "assistant_delta", text: delta });
    if (opts.signal) req.signal = opts.signal;
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
      // Last chance to extend this turn with anything the user typed
      // while the model was producing its closing response. If the
      // mailbox is empty, the turn ends. If something's there, we
      // append it as a fresh user message and keep going — feels like
      // "I was about to wrap, but you spoke," not "your message had
      // to wait for the next turn."
      const lateInbox = opts.mailbox?.() ?? [];
      if (lateInbox.length === 0) {
        return {
          messages,
          stopReason: completion.stopReason,
          totalUsage: total,
        };
      }
      messages.push(...lateInbox);
      continue;
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
    // Two-tier tool-result emission, mirroring the chat.assistant-delta
    // / chat.assistant-text split. `tool_result_live` fires here, the
    // moment each tool finishes executing, so the chat stays responsive
    // when a slow tool would otherwise leave the turn looking frozen.
    // `tool_result` (canonical, durable) fires *after* the aggregate-
    // budget pass below, carrying the exact content the model receives.
    // For the 99% case the two are byte-identical; for the rare case
    // where aggregate truncation rewrites a result they diverge by
    // design — UX showed what the tool produced, the log records what
    // the model saw.
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
        const content = `unknown tool: ${block.name}`;
        pushResult(block.id, block.name, content, true);
        opts.onStep?.({ kind: "tool_result_live", id: block.id, name: block.name, content, isError: true });
        continue;
      }
      if (opts.authorize) {
        const gate = opts.authorize(tool);
        if (!gate.ok) {
          opts.onDenied?.({ tool, reason: gate.reason, input: block.input });
          const content = `permission denied: ${gate.reason}`;
          pushResult(block.id, block.name, content, true);
          opts.onStep?.({ kind: "tool_result_live", id: block.id, name: block.name, content, isError: true });
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
        opts.onStep?.({ kind: "tool_result_live", id: block.id, name: block.name, content: final, isError: false });
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        pushResult(block.id, block.name, msg, true);
        opts.onStep?.({ kind: "tool_result_live", id: block.id, name: block.name, content: msg, isError: true });
      }
    }
    if (opts.truncate) {
      enforceMessageBudget(
        pending.filter((p) => !p.isError),
        opts.truncate,
      );
    }
    // Canonical emission, post-truncation. One per tool use, durable
    // when the chat layer publishes it. For the 99% case content
    // matches the live emit above; for the aggregate-cap case the
    // content is the `<persisted-output>` recovery marker that the
    // model actually sees in its messages.
    for (const r of pending) {
      opts.onStep?.({
        kind: "tool_result",
        id: r.id,
        name: r.name,
        content: r.content,
        isError: r.isError,
      });
    }
    const toolResults: ContentBlock[] = pending.map((r) =>
      r.isError
        ? { type: "tool_result", tool_use_id: r.id, content: r.content, is_error: true }
        : { type: "tool_result", tool_use_id: r.id, content: r.content },
    );
    messages.push({ role: "user", content: toolResults });
  }

  return { messages, stopReason: "max_turns", totalUsage: total };
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const e = new Error(typeof reason === "string" ? reason : "aborted");
  e.name = "AbortError";
  return e;
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
