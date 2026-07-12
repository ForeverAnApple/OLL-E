// `olle mcp-bridge --agent <id> --thread <id> [--socket <path>]`
//
// The MCP stdio server a CLI harness (`claude`/`codex`) spawns when OLL-E is
// its LLM backend. It holds a long-lived IPC connection to the daemon and
// proxies MCP tools/list and tools/call into `tools.list` / `tools.call` RPCs,
// so the harness runs OLL-E's own tools through the daemon's scope gate and
// audit-event path. stdout is the MCP protocol channel — every diagnostic
// here goes to stderr.

import { connectIpc } from "../ipc/client.ts";
import type { IpcClient } from "../ipc/client.ts";
import { resolvePaths } from "../paths.ts";
import { runMcpStdioServer } from "../mcp/mcp-server.ts";
import type { McpToolSpec, ToolCallResult } from "../mcp/contract.ts";

interface ParsedArgs {
  agentId: string;
  threadId: string;
  socketPath: string;
}

function parseArgs(args: string[]): ParsedArgs {
  let agentId: string | undefined;
  let threadId: string | undefined;
  let socketPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--agent" && args[i + 1]) agentId = args[++i];
    else if (a === "--thread" && args[i + 1]) threadId = args[++i];
    else if (a === "--socket" && args[i + 1]) socketPath = args[++i];
  }
  if (!agentId || !threadId) {
    throw new Error("usage: olle mcp-bridge --agent <id> --thread <id> [--socket <path>]");
  }
  return { agentId, threadId, socketPath: socketPath ?? resolvePaths().socketFile };
}

export async function cmdMcpBridge(args: string[]): Promise<void> {
  const { agentId, threadId, socketPath } = parseArgs(args);

  let client: IpcClient;
  try {
    client = await connectIpc(socketPath);
  } catch (err) {
    process.stderr.write(
      `olle mcp-bridge: daemon not reachable at ${socketPath} (${errMessage(err)})\n`,
    );
    process.exit(1);
  }

  // Daemon disconnect kills the bridge — a harness talking to a dead daemon
  // should see the MCP server go away, not hang on every tools/call.
  void client.closed.then(() => {
    process.stderr.write("olle mcp-bridge: daemon connection closed; exiting\n");
    process.exit(0);
  });

  const handlers = {
    async listTools(): Promise<McpToolSpec[]> {
      return await client.call<McpToolSpec[]>("tools.list", { agentId });
    },
    async callTool(name: string, callArgs: Record<string, unknown>): Promise<ToolCallResult> {
      try {
        return await client.call<ToolCallResult>("tools.call", {
          agentId,
          threadId,
          name,
          input: callArgs,
        });
      } catch (err) {
        // Surface an RPC failure as a tool-error result so the harness renders
        // it inline instead of the bridge crashing mid-turn.
        return { content: errMessage(err), isError: true };
      }
    },
  };

  await runMcpStdioServer(handlers);
  // stdin ended: the harness is done with us. Clean exit.
  client.close();
  process.exit(0);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
