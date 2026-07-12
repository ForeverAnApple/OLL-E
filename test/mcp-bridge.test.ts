import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { createIpcServer, connectIpc, type IpcServer, type IpcClient } from "../src/ipc/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import { createToolDispatch } from "../src/mcp/dispatch.ts";
import { runMcpStdioServer, type McpHandlers, type McpIo } from "../src/mcp/mcp-server.ts";
import type { ExtensionHost } from "../src/extensions/index.ts";
import type { ToolDef } from "../src/extensions/types.ts";
import type { McpToolSpec, ToolCallResult, ToolCallRequest, ToolDispatch } from "../src/mcp/contract.ts";

// --- shared stub ToolDispatch ------------------------------------------------

function stubDispatch(): ToolDispatch & { calls: ToolCallRequest[] } {
  const calls: ToolCallRequest[] = [];
  return {
    calls,
    async list(agentId: string): Promise<McpToolSpec[]> {
      return [
        {
          name: "echo",
          description: `tools for ${agentId}`,
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
      ];
    },
    async call(req: ToolCallRequest): Promise<ToolCallResult> {
      calls.push(req);
      if (req.name === "boom") throw new Error("kaboom");
      return { content: `ran ${req.name}(${JSON.stringify(req.input)})`, isError: false };
    },
  };
}

// --- 1. Direct RPC through the real IPC server -------------------------------

describe("tools.* IPC RPC", () => {
  let tmp: string;
  let server: IpcServer;
  let client: IpcClient;
  let socketPath: string;
  const dispatch = stubDispatch();

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "olle-mcp-"));
    socketPath = join(tmp, "olle.sock");
    const bus = createBus({ hostId: ulid() });
    server = createIpcServer({ socketPath, bus, version: "test", toolDispatch: dispatch });
    await server.listen();
    client = await connectIpc(socketPath);
  });

  afterAll(async () => {
    client.close();
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("tools.list round-trips McpToolSpec[]", async () => {
    const specs = await client.call<McpToolSpec[]>("tools.list", { agentId: "agent-1" });
    expect(specs).toHaveLength(1);
    expect(specs[0]!.name).toBe("echo");
    expect(specs[0]!.description).toBe("tools for agent-1");
    expect(specs[0]!.inputSchema).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
    });
  });

  it("tools.list errors when agentId is missing", async () => {
    await expect(client.call("tools.list", {})).rejects.toThrow(/agentId required/);
  });

  it("tools.call round-trips a ToolCallResult and forwards the request", async () => {
    const r = await client.call<ToolCallResult>("tools.call", {
      agentId: "agent-1",
      threadId: "thr-1",
      name: "echo",
      input: { text: "hi" },
    });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("ran echo");
    const last = dispatch.calls.at(-1)!;
    expect(last.agentId).toBe("agent-1");
    expect(last.threadId).toBe("thr-1");
    expect(last.input).toEqual({ text: "hi" });
  });

  it("tools.call validates required string params and object input", async () => {
    await expect(
      client.call("tools.call", { threadId: "t", name: "echo", input: {} }),
    ).rejects.toThrow(/agentId required/);
    await expect(
      client.call("tools.call", { agentId: "a", name: "echo", input: {} }),
    ).rejects.toThrow(/threadId required/);
    await expect(
      client.call("tools.call", { agentId: "a", threadId: "t", input: {} }),
    ).rejects.toThrow(/name required/);
    await expect(
      client.call("tools.call", { agentId: "a", threadId: "t", name: "echo", input: 7 }),
    ).rejects.toThrow(/input must be an object/);
  });
});

describe("tools.* guard when dispatch is unwired", () => {
  let tmp: string;
  let server: IpcServer;
  let client: IpcClient;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "olle-mcp-"));
    const socketPath = join(tmp, "olle.sock");
    const bus = createBus({ hostId: ulid() });
    server = createIpcServer({ socketPath, bus, version: "test" }); // no toolDispatch
    await server.listen();
    client = await connectIpc(socketPath);
  });

  afterAll(async () => {
    client.close();
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("tools.list errors cleanly", async () => {
    await expect(client.call("tools.list", { agentId: "a" })).rejects.toThrow(
      /tool dispatch unavailable/,
    );
  });

  it("tools.call errors cleanly", async () => {
    await expect(
      client.call("tools.call", { agentId: "a", threadId: "t", name: "x", input: {} }),
    ).rejects.toThrow(/tool dispatch unavailable/);
  });
});

// --- 1b. Tool resolution precedence (findTool) -------------------------------

describe("createToolDispatch — call() tool resolution", () => {
  function rig() {
    const store = openStore({ path: ":memory:" });
    const hostId = ulid();
    store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
    const bus = createBus({ hostId, persist: persistToStore(store) });
    const agentId = ulid();
    store
      .insert(tables.agents)
      .values({ id: agentId, name: "a", hostId, scope: {} as never, createdAt: Date.now() })
      .run();
    return { store, bus, hostId, agentId };
  }

  // findTool() replaced a full toolMap() rebuild-per-call; this pins the
  // core-wins precedence that rebuild guaranteed (core added first, extension
  // only if the name is free). A same-named extension tool must never shadow
  // the core one at call() time.
  it("resolves the core tool over a same-named extension tool", async () => {
    const { store, bus, hostId, agentId } = rig();
    const core: ToolDef = {
      name: "clash",
      description: "core clash",
      inputSchema: { type: "object" },
      execute: () => "core-ran",
    };
    const extTool: ToolDef = {
      name: "clash",
      description: "extension clash",
      inputSchema: { type: "object" },
      execute: () => "ext-ran",
    };
    const extensions = {
      tools: () => [{ extensionId: "ext", tool: extTool }],
    } as unknown as ExtensionHost;

    const dispatch = createToolDispatch({ bus, store, hostId, coreTools: () => [core], extensions });
    const res = await dispatch.call({ agentId, threadId: "t1", name: "clash", input: {} });
    expect(res.isError).toBe(false);
    expect(res.content).toBe("core-ran");
  });

  it("resolves an extension-only tool by name and wraps it", async () => {
    const { store, bus, hostId, agentId } = rig();
    const extTool: ToolDef = {
      name: "ext_only",
      description: "extension tool",
      inputSchema: { type: "object" },
      execute: () => "ext-ran",
    };
    const extensions = {
      tools: () => [{ extensionId: "ext", tool: extTool }],
    } as unknown as ExtensionHost;

    const dispatch = createToolDispatch({ bus, store, hostId, coreTools: () => [], extensions });
    const res = await dispatch.call({ agentId, threadId: "t1", name: "ext_only", input: {} });
    expect(res.isError).toBe(false);
    expect(res.content).toBe("ext-ran");
  });
});

// --- 2. In-process MCP protocol handling -------------------------------------

/** Feed a fixed set of newline-JSON lines through the server and collect the
 *  parsed responses. Input ends after the last line, so runMcpStdioServer
 *  resolves once every line is processed. */
async function driveMcp(handlers: McpHandlers, lines: string[]): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  const io: McpIo = {
    input: (async function* () {
      for (const l of lines) yield l + "\n";
    })(),
    write: (line: string) => {
      const trimmed = line.trim();
      if (trimmed) out.push(JSON.parse(trimmed));
    },
  };
  await runMcpStdioServer(handlers, io);
  return out;
}

describe("runMcpStdioServer", () => {
  function handlers(): McpHandlers {
    const d = stubDispatch();
    return {
      listTools: () => d.list("agent-x"),
      callTool: (name, args) =>
        d.call({ agentId: "agent-x", threadId: "thr-x", name, input: args }),
    };
  }

  it("handles initialize / tools/list / tools/call in sequence", async () => {
    const out = await driveMcp(handlers(), [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } }),
    ]);

    // notifications/initialized produces no frame → 3 responses for 4 inputs.
    expect(out).toHaveLength(3);

    const init = out[0]!;
    expect(init.id).toBe(1);
    const initResult = init.result as Record<string, unknown>;
    expect(initResult.protocolVersion).toBe("2025-06-18");
    expect(initResult.capabilities).toEqual({ tools: {} });
    expect((initResult.serverInfo as Record<string, unknown>).name).toBe("olle");

    const list = out[1]!;
    expect(list.id).toBe(2);
    const tools = (list.result as { tools: McpToolSpec[] }).tools;
    expect(tools[0]!.name).toBe("echo");
    expect(tools[0]!.inputSchema).toBeDefined();

    const call = out[2]!;
    expect(call.id).toBe(3);
    const callResult = call.result as { content: Array<{ type: string; text: string }>; isError: boolean };
    expect(callResult.isError).toBe(false);
    expect(callResult.content[0]!.type).toBe("text");
    expect(callResult.content[0]!.text).toContain("ran echo");
  });

  it("advertises a supported protocol version when the client offers an unknown one", async () => {
    const out = await driveMcp(handlers(), [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } }),
    ]);
    expect((out[0]!.result as Record<string, unknown>).protocolVersion).toBe("2025-06-18");
  });

  it("returns -32601 for an unknown method with an id", async () => {
    const out = await driveMcp(handlers(), [
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "resources/list" }),
    ]);
    expect(out).toHaveLength(1);
    expect((out[0]!.error as Record<string, unknown>).code).toBe(-32601);
  });

  it("ignores an unknown notification (no id → no frame)", async () => {
    const out = await driveMcp(handlers(), [
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled" }),
    ]);
    expect(out).toHaveLength(0);
  });

  it("emits a -32700 parse error for a malformed line", async () => {
    const out = await driveMcp(handlers(), ["{not json"]);
    expect(out).toHaveLength(1);
    expect((out[0]!.error as Record<string, unknown>).code).toBe(-32700);
  });

  it("surfaces a thrown callTool as an isError tool result, not a crash", async () => {
    const out = await driveMcp(handlers(), [
      JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "boom", arguments: {} } }),
    ]);
    const result = out[0]!.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("kaboom");
  });

  it("tolerates a message split across input chunks", async () => {
    const msg = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const mid = Math.floor(msg.length / 2);
    const out: Array<Record<string, unknown>> = [];
    const io: McpIo = {
      input: (async function* () {
        yield msg.slice(0, mid);
        yield msg.slice(mid) + "\n";
      })(),
      write: (line) => {
        const t = line.trim();
        if (t) out.push(JSON.parse(t));
      },
    };
    await runMcpStdioServer(handlers(), io);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(1);
  });
});

// --- 3. Bridge subprocess end-to-end -----------------------------------------

describe("olle mcp-bridge subprocess", () => {
  let tmp: string;
  let server: IpcServer;
  let socketPath: string;
  const dispatch = stubDispatch();

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "olle-mcp-"));
    socketPath = join(tmp, "olle.sock");
    const bus = createBus({ hostId: ulid() });
    server = createIpcServer({ socketPath, bus, version: "test", toolDispatch: dispatch });
    await server.listen();
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("proxies MCP tools/list + tools/call to the daemon", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        join(import.meta.dir, "..", "src", "cli", "index.ts"),
        "mcp-bridge",
        "--agent",
        "agent-sub",
        "--thread",
        "thr-sub",
        "--socket",
        socketPath,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );

    const write = (obj: unknown) => proc.stdin.write(JSON.stringify(obj) + "\n");
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    write({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    write({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "yo" } } });
    await proc.stdin.flush();

    // Read stdout until we've collected the 3 responses, then close stdin.
    const responses = await readNLines(proc.stdout, 3);
    proc.stdin.end();
    await proc.exited;

    const byId = new Map(responses.map((r) => [r.id, r]));
    expect((byId.get(1)!.result as Record<string, unknown>).serverInfo).toBeDefined();
    const tools = (byId.get(2)!.result as { tools: McpToolSpec[] }).tools;
    expect(tools[0]!.name).toBe("echo");
    const callResult = byId.get(3)!.result as { content: Array<{ text: string }>; isError: boolean };
    expect(callResult.isError).toBe(false);
    expect(callResult.content[0]!.text).toContain("ran echo");

    // The daemon saw the call with the bridge's --agent/--thread.
    const last = dispatch.calls.at(-1)!;
    expect(last.agentId).toBe("agent-sub");
    expect(last.threadId).toBe("thr-sub");
  });
});

/** Read newline-JSON objects off a ReadableStream until `n` are parsed. */
async function readNLines(
  stream: ReadableStream<Uint8Array>,
  n: number,
): Promise<Array<Record<string, unknown>>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const out: Array<Record<string, unknown>> = [];
  let buffer = "";
  while (out.length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0 && out.length < n) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) out.push(JSON.parse(line));
    }
  }
  reader.releaseLock();
  return out;
}
