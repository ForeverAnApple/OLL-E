// Minimal MCP stdio server (JSON-RPC 2.0, newline-delimited JSON).
//
// One JSON object per line on stdin/stdout. stdout is the protocol channel —
// NEVER write logs there; diagnostics go to stderr only. This is the server a
// CLI harness (`claude`/`codex`) speaks to when OLL-E is its LLM backend; the
// `olle mcp-bridge` subcommand wires the handlers here to the daemon over IPC.
//
// Scope is deliberately tiny: initialize + the two tools/* methods. No
// capability negotiation beyond `tools`, no resources/prompts. v0 plumbing.

import { OLLE_MCP_SERVER_NAME } from "./contract.ts";
import type { McpToolSpec, ToolCallResult } from "./contract.ts";

/** Protocol versions this server knows how to speak. The first is what it
 *  advertises when the client offers nothing recognizable. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18"];

const SERVER_VERSION = "0.0.0";

/** The daemon-proxying half the bridge supplies. Kept free of transport
 *  detail so tests can drive the protocol with in-memory streams + stubs. */
export interface McpHandlers {
  listTools(): Promise<McpToolSpec[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

/** Injectable streams. Defaults bind to the process stdio; tests pass
 *  in-memory duplexes. `input` yields chunks (Buffer or string); `write`
 *  emits a single already-newline-terminated frame. */
export interface McpIo {
  input: AsyncIterable<Buffer | string>;
  write(line: string): void;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

/** Run the server until `io.input` ends, then resolve. Each input line is one
 *  JSON-RPC message; responses are written as newline-terminated frames. */
export async function runMcpStdioServer(handlers: McpHandlers, io?: McpIo): Promise<void> {
  const stream: McpIo = io ?? defaultIo();

  let buffer = "";
  for await (const chunk of stream.input) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      await handleLine(line, handlers, stream);
    }
  }
  // Flush a trailing line with no newline (rare, but tolerate it).
  if (buffer.trim()) await handleLine(buffer, handlers, stream);
}

async function handleLine(line: string, handlers: McpHandlers, io: McpIo): Promise<void> {
  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(line) as JsonRpcRequest;
  } catch {
    // Parse error: JSON-RPC says respond with id:null. Best-effort — a
    // truly garbled line has no recoverable id.
    sendError(io, null, -32700, "parse error");
    return;
  }

  const { id, method } = msg;
  // A message with no `id` is a notification — never answered, even on error.
  const isNotification = id === undefined;

  if (method === "initialize") {
    const params = (msg.params ?? {}) as { protocolVersion?: unknown };
    const offered =
      typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
    const protocolVersion =
      offered && SUPPORTED_PROTOCOL_VERSIONS.includes(offered)
        ? offered
        : SUPPORTED_PROTOCOL_VERSIONS[0];
    sendResult(io, id ?? null, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: OLLE_MCP_SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }

  if (method === "notifications/initialized") {
    // Notification: no response.
    return;
  }

  if (method === "tools/list") {
    try {
      const tools = await handlers.listTools();
      sendResult(io, id ?? null, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    } catch (err) {
      if (!isNotification) sendError(io, id ?? null, -32603, errMessage(err));
    }
    return;
  }

  if (method === "tools/call") {
    const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
    const name = typeof params.name === "string" ? params.name : undefined;
    if (!name) {
      if (!isNotification) sendError(io, id ?? null, -32602, "tools/call requires a string name");
      return;
    }
    const args =
      params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
    try {
      const result = await handlers.callTool(name, args);
      sendResult(io, id ?? null, {
        content: [{ type: "text", text: result.content }],
        isError: result.isError,
      });
    } catch (err) {
      // A thrown callTool still surfaces to the client as a tool error result
      // rather than a protocol error — the harness can show it inline.
      if (!isNotification) {
        sendResult(io, id ?? null, {
          content: [{ type: "text", text: errMessage(err) }],
          isError: true,
        });
      }
    }
    return;
  }

  // Unknown method. Notifications are silently ignored; requests get -32601.
  if (!isNotification) sendError(io, id ?? null, -32601, `method not found: ${method ?? "(none)"}`);
}

function sendResult(io: McpIo, id: string | number | null, result: unknown): void {
  io.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(
  io: McpIo,
  id: string | number | null,
  code: number,
  message: string,
): void {
  io.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultIo(): McpIo {
  return {
    input: process.stdin,
    write: (line: string) => {
      process.stdout.write(line);
    },
  };
}
