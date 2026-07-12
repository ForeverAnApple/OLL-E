// Shared contract between the MCP bridge surface and the CLI-brain wiring.
//
// The CLI-brain feature lets a logged-in `claude`/`codex` CLI run an agent
// turn as OLL-E's LLM backend. The CLI harness owns its own inner LLM<->tool
// loop, so OLL-E exposes its own tools to that harness over MCP: the harness
// spawns `olle mcp-bridge` (an MCP stdio server) which proxies tools/list and
// tools/call back into the daemon over the IPC socket, through the same
// permission gate and audit-event path the chat loop uses.
//
// This file is the seam. Three build surfaces import it and must agree:
//   - the MCP bridge + `tools.list` / `tools.call` IPC RPC (consumes ToolDispatch)
//   - the daemon wiring (constructs a ToolDispatch from coreTools + extensions)
//   - the CLI adapters (turn a BridgeInvocation into their CLI's MCP config)

/** A tool as advertised to an MCP client (name + JSON Schema). Mirrors the
 *  MCP `tools/list` entry shape. */
export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallRequest {
  /** Agent on whose behalf the call runs — its scope drives the permission
   *  gate (checkTool). */
  agentId: string;
  /** Thread the call belongs to; durable chat.tool-call / chat.tool-result
   *  audit events are published on it. */
  threadId: string;
  name: string;
  input: Record<string, unknown>;
  /** Correlates the emitted audit events to the originating turn/event. */
  parentEventId?: string;
}

export interface ToolCallResult {
  /** Result text, already truncated + secret-scrubbed by the dispatch layer
   *  (same treatment the chat loop applies before a result reaches the LLM). */
  content: string;
  isError: boolean;
}

/** Daemon-side tool execution surface the MCP bridge RPC calls into. The
 *  daemon constructs one from its live core-tool set + extension tools; the
 *  IPC server closes over it. Both methods run the full gate:
 *  scope check -> input validation -> execute -> redact/scrub/truncate ->
 *  durable chat.tool-call / chat.tool-result events. */
export interface ToolDispatch {
  /** Tools visible to `agentId`. Deliberately NOT filtered by the chat
   *  thread's per-thread loaded set — the loaded set is a prompt-context
   *  economy for the API path; a CLI harness carries its own context budget,
   *  and execution never consulted the loaded set anyway. Scope/tier gates
   *  are the real boundary and stay enforced at call(). */
  list(agentId: string): Promise<McpToolSpec[]>;
  call(req: ToolCallRequest): Promise<ToolCallResult>;
}

/** Args the `olle mcp-bridge` subcommand parses. */
export interface McpBridgeArgs {
  agentId: string;
  threadId: string;
  /** IPC socket to reach the daemon; defaults to the resolved host socket
   *  when omitted (tests pass an explicit path under a temp OLLE_HOME). */
  socketPath?: string;
}

/** A concrete process invocation of the bridge, provider-agnostic. Each CLI
 *  adapter wraps this in its own MCP-config format (Claude: a `mcpServers`
 *  JSON entry; Codex: `mcp_servers.*` config keys). */
export interface BridgeInvocation {
  command: string;
  args: string[];
}

/** The MCP server name OLL-E registers its tools under, shared by both
 *  adapters so tool names resolve identically across harnesses. */
export const OLLE_MCP_SERVER_NAME = "olle";

/** The CLI subcommand the bridge is reached through: `olle mcp-bridge ...`. */
export const MCP_BRIDGE_SUBCOMMAND = "mcp-bridge";

/** Build the bridge invocation. `olleCommand` + `olleArgvPrefix` describe how
 *  to launch this OLL-E build (compiled binary: {command: binPath, prefix: []};
 *  dev: {command: bunPath, prefix: [cliEntryPath]}). The daemon resolves those
 *  and passes them down; this helper only formats the argv. */
export function bridgeInvocation(
  olleCommand: string,
  olleArgvPrefix: string[],
  a: McpBridgeArgs,
): BridgeInvocation {
  const args = [...olleArgvPrefix, MCP_BRIDGE_SUBCOMMAND, "--agent", a.agentId, "--thread", a.threadId];
  if (a.socketPath) args.push("--socket", a.socketPath);
  return { command: olleCommand, args };
}
