// Headless tool dispatch — the execution surface behind the `tools.list` /
// `tools.call` IPC RPCs (src/ipc/server.ts) that `olle mcp-bridge` proxies a
// CLI harness into. It is the chat loop's per-tool dispatch (src/agent/
// runtime.ts) with the LLM removed: a CLI brain owns its own inner loop and
// reaches OLL-E's tools through here, so every call runs the *same* gate the
// chat loop runs — scope/tier check → input validation → execute → redact +
// secret-scrub + truncate — and emits the *same* durable audit events
// (chat.tool-call / chat.tool-result / tool.denied) on the same thread.
//
// Deliberately NOT per-thread-loadout-aware: the loaded set is a prompt-
// context economy for the API path (fewer schemas per turn = cheaper cache);
// execution never consulted it, and a CLI harness carries its own context
// budget. Scope/tier is the real boundary and stays enforced at call().

import { eq } from "drizzle-orm";
import type { EventBus } from "../bus/index.ts";
import type { Store } from "../store/db.ts";
import { tables } from "../store/index.ts";
import type { ExtensionHost } from "../extensions/index.ts";
import type { ToolDef, ToolExecuteContext } from "../extensions/types.ts";
import type {
  McpToolSpec,
  ToolCallRequest,
  ToolCallResult,
  ToolDispatch,
} from "./contract.ts";
import { ulid } from "../id/index.ts";
import { checkTool } from "../permissions/index.ts";
import { loadAgentScope, wrapExtensionTool } from "../agent/chat.ts";
import { redactToolResult } from "../agent/runtime.ts";
import { redactInput, scrubSecrets } from "../agent/redaction.ts";
import { getSecretsProvider } from "../agent/secrets-provider.ts";
import { formatInputError, validateToolInput } from "../agent/validate-tool-input.ts";
import {
  createTruncationState,
  DEFAULT_MAX_RESULT_BYTES,
  maybeTruncateOne,
  type TruncationState,
} from "../agent/tool-truncate.ts";

export interface ToolDispatchDeps {
  bus: EventBus;
  store: Store;
  hostId: string;
  /** Core/meta tools built at chat bringup — the same array startAgentLoop
   *  gets as `coreTools`. Read live via a getter so a rebuild swaps them
   *  without reconstructing the dispatch. */
  coreTools: () => ToolDef[];
  /** Extension runtime — execution surface reads its live tool set. */
  extensions?: ExtensionHost;
  /** Secrets dir for value-level result scrubbing (see scrubSecrets). Omit
   *  to disable scrubbing. */
  secretsDir?: string;
  /** Tool-result truncation — oversize outputs spill to the durable handle
   *  the chat loop shares, recovered via read_tool_result. Omit to disable. */
  toolTruncate?: {
    persist(input: { id: string; threadId: string; toolName: string; content: string }): void;
    maxBytesPerCall?: number;
  };
}

export function createToolDispatch(deps: ToolDispatchDeps): ToolDispatch {
  // Per-thread truncation state so repeated identical spills within one
  // thread stay byte-stable. There is no OLL-E prompt-cache prefix to protect
  // on the CLI path (the harness owns its own context), but the handle-
  // recovery contract still wants a stable preview, and a spill always
  // persists the row regardless.
  //
  // Bounded LRU: the daemon lives forever and every distinct threadId that
  // spills a result would otherwise leave a permanent entry (standing jobs,
  // cron, channel threads each mint fresh ids), so cap the map and evict the
  // least-recently-used thread. Eviction only costs a re-spilled thread its
  // byte-stable preview — the durable tool_results row is written on every
  // spill regardless, so recovery via read_tool_result is unaffected.
  const TRUNC_STATE_CAP = 64;
  const truncStates = new Map<string, TruncationState>();
  const truncStateFor = (threadId: string): TruncationState => {
    const existing = truncStates.get(threadId);
    if (existing) {
      // Refresh recency: delete + re-insert moves the key to the tail.
      truncStates.delete(threadId);
      truncStates.set(threadId, existing);
      return existing;
    }
    if (truncStates.size >= TRUNC_STATE_CAP) {
      const oldest = truncStates.keys().next().value; // head = least-recent
      if (oldest !== undefined) truncStates.delete(oldest);
    }
    const s = createTruncationState();
    truncStates.set(threadId, s);
    return s;
  };

  /** Live core ∪ extension tool map, first-wins on name collision (core
   *  wins) — the exact precedence the chat loop's resolveTools uses. Used by
   *  list(), which needs the whole surface; call() uses findTool() to avoid
   *  building (and wrapping) the full set to reach a single tool. */
  function toolMap(): Map<string, ToolDef> {
    const m = new Map<string, ToolDef>();
    for (const t of deps.coreTools()) if (!m.has(t.name)) m.set(t.name, t);
    if (deps.extensions) {
      for (const { extensionId, tool } of deps.extensions.tools()) {
        if (!m.has(tool.name)) m.set(tool.name, wrapExtensionTool(tool, extensionId));
      }
    }
    return m;
  }

  /** Resolve one tool by name with the same core-wins precedence toolMap()
   *  gives, but without materializing the whole map or wrapping every
   *  extension tool: scan core first (first match wins → core beats a
   *  same-named extension tool, first core copy beats a later duplicate),
   *  then extensions, wrapping only the one that matches. */
  function findTool(name: string): ToolDef | undefined {
    for (const t of deps.coreTools()) if (t.name === name) return t;
    if (deps.extensions) {
      for (const { extensionId, tool } of deps.extensions.tools()) {
        if (tool.name === name) return wrapExtensionTool(tool, extensionId);
      }
    }
    return undefined;
  }

  // A caller asserts its own agentId over the bridge; nothing binds the bridge
  // token to a specific agent yet. Guard the one identity a missing row would
  // silently unlock: loadAgentScope returns {} for a nonexistent agent, and
  // {} means UNRESTRICTED in checkTool, so a bogus agentId would run any tier
  // ungated. Reject unknown agents before doing anything. (An existing row with
  // an empty scope stays unrestricted per the existing convention — only the
  // missing-row case is a bug.) Per-turn bridge-token→agent binding, so the
  // harness can't mint OTHER existing agents' identities, is a deferred v0.1
  // hardening — not implemented here.
  function agentExists(agentId: string): boolean {
    return (
      deps.store.select().from(tables.agents).where(eq(tables.agents.id, agentId)).all().length > 0
    );
  }

  async function list(agentId: string): Promise<McpToolSpec[]> {
    if (!agentExists(agentId)) return [];
    return [...toolMap().values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async function call(req: ToolCallRequest): Promise<ToolCallResult> {
    const { agentId, threadId, name, input, parentEventId } = req;
    if (!agentExists(agentId)) {
      return { content: `unknown agent: ${agentId}`, isError: true };
    }
    const tool = findTool(name);
    if (!tool) {
      return { content: `unknown tool: ${name}`, isError: true };
    }
    const tier = tool.tier ?? "operational";

    // DRIFT HAZARD — this per-tool pipeline (scope/tier gate → input
    // validation → validate/execute → redact → scrub → truncate, plus the
    // tool.denied / chat.tool-call / chat.tool-result audit events) is a
    // second copy of runtime.ts's inner-loop pipeline (src/agent/runtime.ts,
    // the `for (block of completion.content)` body). Every *leaf* is already a
    // shared import — checkTool, validateToolInput/formatInputError,
    // redactToolResult, scrubSecrets, maybeTruncateOne — so only the
    // orchestration order and the audit-event surface can drift, and both are
    // security-relevant. A change to the execution contract (new redaction
    // step, new audit field, altered truncation call) applied to one path and
    // not the other diverges the API path from the CLI/MCP path.
    //
    // FOLLOW-UP: extract a single executeOneTool(tool, input, ctx, sink) that
    // both runtime.ts's loop and this call() invoke, keeping them in lockstep.
    // Not done here: runtime.ts's copy is inlined in the turn loop and coupled
    // to opts.onStep/authorize/scrubResult/truncate; hoisting it into a shared
    // executor requires editing src/agent/runtime.ts, out of scope for this
    // change. Until then, edits to either pipeline must be mirrored by hand.

    // Redact declared-sensitive input fields before anything is traced.
    const safeInput =
      tool.sensitiveInputFields && tool.sensitiveInputFields.length
        ? redactInput(input, tool.sensitiveInputFields)
        : input;

    // Gate 1: scope/tier. Denied → durable tool.denied (same payload the
    // loop publishes) and a legible error back to the harness. No inbox
    // ask-up here: the loop's onDenied files a grant_scope proposal because
    // it's mid-turn with an inbox in hand; the MCP path is a bare execution
    // surface, so the denial is terminal for this call (the agent can still
    // propose a grant through its normal tools).
    const scope = loadAgentScope(deps.store, agentId);
    const gate = checkTool(scope, { name: tool.name, tier });
    if (!gate.ok) {
      deps.bus.publish({
        type: "tool.denied",
        hostId: deps.hostId,
        actorId: agentId,
        threadId,
        ...(parentEventId && { parentEventId }),
        durable: true,
        payload: { tool: tool.name, tier, reason: gate.reason, input: safeInput },
      });
      return { content: `permission denied: ${gate.reason}`, isError: true };
    }

    // The MCP call carries no tool_use id — mint one so the audit pair and
    // any spilled tool_results row share a stable handle.
    const id = ulid();
    deps.bus.publish({
      type: "chat.tool-call",
      hostId: deps.hostId,
      actorId: agentId,
      threadId,
      ...(parentEventId && { parentEventId }),
      durable: true,
      payload: { id, name: tool.name, input: safeInput },
    });

    const emitResult = (content: string, isError: boolean): ToolCallResult => {
      deps.bus.publish({
        type: "chat.tool-result",
        hostId: deps.hostId,
        actorId: agentId,
        threadId,
        ...(parentEventId && { parentEventId }),
        durable: true,
        payload: { id, name: tool.name, isError, content },
      });
      return { content, isError };
    };

    // Gate 2: structural input validation — a blind/mis-shaped call gets the
    // schema-carrying error it can self-correct from, not an opaque execute()
    // throw.
    const problems = validateToolInput(tool.inputSchema, input);
    if (problems.length > 0) {
      return emitResult(formatInputError(tool.name, problems, tool.inputSchema), true);
    }

    // Execute. secrets: {} matches the chat loop — extension tools close over
    // their own api.secrets at register time; core tools take none.
    const ctx: ToolExecuteContext = {
      hostId: deps.hostId,
      extensionId: "",
      actorId: agentId,
      abort: new AbortController().signal,
      secrets: {},
    };
    try {
      const args = tool.validate ? tool.validate(input) : input;
      const result = await tool.execute(args, ctx);
      const safeResult = redactToolResult(tool, result);
      const rendered = typeof safeResult === "string" ? safeResult : JSON.stringify(safeResult);
      const scrubbed = deps.secretsDir
        ? scrubSecrets(rendered, getSecretsProvider(deps.secretsDir)())
        : rendered;
      let final = scrubbed;
      if (deps.toolTruncate && !tool.sensitiveOutput) {
        final = maybeTruncateOne({
          id,
          toolName: tool.name,
          content: scrubbed,
          perToolMaxBytes: tool.maxResultBytes,
          options: {
            state: truncStateFor(threadId),
            maxBytesPerCall: deps.toolTruncate.maxBytesPerCall ?? DEFAULT_MAX_RESULT_BYTES,
            // Single-call path — no parallel batch, so the aggregate cap is
            // never exercised. Set to the per-call cap for a well-formed
            // TruncateOptions.
            maxBytesPerMessage: deps.toolTruncate.maxBytesPerCall ?? DEFAULT_MAX_RESULT_BYTES,
            persist: ({ id: pid, toolName, content }) =>
              deps.toolTruncate!.persist({ id: pid, threadId, toolName, content }),
          },
        });
      }
      return emitResult(final, false);
    } catch (err) {
      return emitResult((err as Error).message ?? String(err), true);
    }
  }

  return { list, call };
}
