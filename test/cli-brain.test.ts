// CLI-brain adapter tests. No real claude/codex needed: the adapters spawn
// whatever `opts.command` points at, so we point them at stub executables that
// read stdin, record their argv, and print canned NDJSON/JSONL. Behavior is
// switched via env vars (STUB_MODE, STUB_ARGV_FILE, STUB_MCP_OUT) the stubs read.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClaudeCliBrain } from "../src/llm/cli-brain/claude.ts";
import { createCodexCliBrain } from "../src/llm/cli-brain/codex.ts";
import { cliBrainToLlm } from "../src/llm/cli-brain/as-llm.ts";
import { priceTokens } from "../src/llm/pricing.ts";
import type { BridgeInvocation } from "../src/mcp/contract.ts";

let dir: string;
let claudeStub: string;
let codexStub: string;

const bridge: BridgeInvocation = {
  command: "/opt/olle/olle",
  args: ["mcp-bridge", "--agent", "agent-1", "--thread", "thread-1"],
};

const usage = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

const CLAUDE_STUB = `#!/usr/bin/env bun
const fs = require("fs");
const argv = process.argv.slice(2);
if (argv.includes("--version")) { process.stdout.write("claude-stub 1.2.3\\n"); process.exit(0); }
if (process.env.STUB_ARGV_FILE) fs.writeFileSync(process.env.STUB_ARGV_FILE, JSON.stringify(argv));
if (process.env.STUB_MCP_OUT) {
  const i = argv.indexOf("--mcp-config");
  if (i >= 0 && argv[i + 1]) {
    try { fs.writeFileSync(process.env.STUB_MCP_OUT, fs.readFileSync(argv[i + 1], "utf8")); } catch {}
  }
}
try { fs.readFileSync(0); } catch {}
const w = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const mode = process.env.STUB_MODE || "ok";
const sid = "sess-claude-1";
if (mode === "auth") { process.stderr.write("Invalid API key. Please run /login\\n"); process.exit(1); }
if (mode === "quota") {
  w({ type: "system", subtype: "init", session_id: sid });
  w({ type: "result", subtype: "error_during_execution", is_error: true, result: "usage limit reached, upgrade your plan", session_id: sid, usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  process.exit(0);
}
w({ type: "system", subtype: "init", session_id: sid, model: "claude-x" });
w({ type: "assistant", message: { content: [{ type: "text", text: "hello world" }] }, session_id: sid });
w({ type: "result", subtype: "success", is_error: false, result: "hello world", stop_reason: "end_turn", session_id: sid, usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 5, output_tokens: 7 } });
`;

const CODEX_STUB = `#!/usr/bin/env bun
const fs = require("fs");
const argv = process.argv.slice(2);
if (process.env.STUB_ARGV_FILE) fs.writeFileSync(process.env.STUB_ARGV_FILE, JSON.stringify(argv));
let stdinText = "";
try { stdinText = fs.readFileSync(0, "utf8"); } catch {}
if (process.env.STUB_STDIN_FILE) fs.writeFileSync(process.env.STUB_STDIN_FILE, stdinText);
const w = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const mode = process.env.STUB_MODE || "ok";
const sid = "thread-codex-1";
if (mode === "auth") { w({ type: "thread.started", thread_id: sid }); w({ type: "error", message: "Not logged in. Please run codex login" }); process.exit(1); }
if (mode === "transient") { w({ type: "thread.started", thread_id: sid }); w({ type: "error", message: "stream error: 503 overloaded, try again later" }); process.exit(0); }
const text = mode === "hello" ? "hello" : "hi from codex";
w({ type: "thread.started", thread_id: sid });
w({ type: "turn.started" });
w({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } });
w({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5 } });
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "olle-cli-brain-test-"));
  claudeStub = join(dir, "claude-stub.js");
  codexStub = join(dir, "codex-stub.js");
  writeFileSync(claudeStub, CLAUDE_STUB);
  writeFileSync(codexStub, CODEX_STUB);
  chmodSync(claudeStub, 0o755);
  chmodSync(codexStub, 0o755);
});

afterEach(() => {
  delete process.env.STUB_MODE;
  delete process.env.STUB_ARGV_FILE;
  delete process.env.STUB_MCP_OUT;
  delete process.env.STUB_STDIN_FILE;
});

describe("probe classification", () => {
  test("claude: hello result -> ready (with version)", async () => {
    const res = await createClaudeCliBrain({ command: claudeStub }).probe();
    expect(res.status).toBe("ready");
    expect(res.version).toBe("claude-stub 1.2.3");
  });

  test("claude: auth error -> needs-login", async () => {
    process.env.STUB_MODE = "auth";
    const res = await createClaudeCliBrain({ command: claudeStub }).probe();
    expect(res.status).toBe("needs-login");
    expect(res.loginHint).toBe("run: claude login");
  });

  test("claude: missing binary -> not-installed", async () => {
    const res = await createClaudeCliBrain({ command: "/no/such/claude-xyz" }).probe();
    expect(res.status).toBe("not-installed");
  });

  test("codex: hello turn -> ready", async () => {
    process.env.STUB_MODE = "hello";
    const res = await createCodexCliBrain({ command: codexStub }).probe();
    expect(res.status).toBe("ready");
  });

  test("codex: auth error -> needs-login", async () => {
    process.env.STUB_MODE = "auth";
    const res = await createCodexCliBrain({ command: codexStub }).probe();
    expect(res.status).toBe("needs-login");
    expect(res.loginHint).toBe("run: codex login");
  });

  test("codex: missing binary -> not-installed", async () => {
    const res = await createCodexCliBrain({ command: "/no/such/codex-xyz" }).probe();
    expect(res.status).toBe("not-installed");
  });
});

describe("runTurn happy path", () => {
  test("claude: text, usage, session, deltas", async () => {
    const deltas: string[] = [];
    const res = await createClaudeCliBrain({ command: claudeStub }).runTurn({
      system: "you are olle",
      prompt: "hi",
      bridge,
      onTextDelta: (d) => deltas.push(d),
    });
    expect(res.text).toBe("hello world");
    expect(res.stopReason).toBe("end_turn");
    expect(res.sessionId).toBe("sess-claude-1");
    // claude reports input_tokens already-uncached; maps 1:1.
    expect(res.usage).toEqual({
      inputTokens: 10,
      outputTokens: 7,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 2,
      totalTokens: 24,
    });
    expect(deltas.join("")).toBe("hello world");
  });

  test("codex: text, usage (uncached-input math), session, deltas", async () => {
    const deltas: string[] = [];
    const res = await createCodexCliBrain({ command: codexStub }).runTurn({
      system: "you are olle",
      prompt: "hi",
      bridge,
      onTextDelta: (d) => deltas.push(d),
    });
    expect(res.text).toBe("hi from codex");
    expect(res.stopReason).toBe("end_turn");
    expect(res.sessionId).toBe("thread-codex-1");
    // input_tokens=100 includes cached=40 -> uncached input 60; total 100+20=120.
    expect(res.usage).toEqual({
      inputTokens: 60,
      outputTokens: 20,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 0,
      totalTokens: 120,
    });
    expect(deltas.join("")).toBe("hi from codex");
  });
});

describe("session resume", () => {
  test("claude: passes --resume, does not re-send system", async () => {
    const argvFile = join(dir, "claude-resume-argv.json");
    process.env.STUB_ARGV_FILE = argvFile;
    await createClaudeCliBrain({ command: claudeStub }).runTurn({
      system: "SECRET_SYSTEM_MARKER",
      prompt: "continue",
      bridge,
      resumeSessionId: "sess-abc",
    });
    const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
    expect(argv).toContain("--resume");
    expect(argv[argv.indexOf("--resume") + 1]).toBe("sess-abc");
    expect(argv).not.toContain("--append-system-prompt");
    expect(argv).not.toContain("--append-system-prompt-file");
    expect(JSON.stringify(argv)).not.toContain("SECRET_SYSTEM_MARKER");
  });

  test("codex: passes resume subcommand, does not re-send system", async () => {
    const argvFile = join(dir, "codex-resume-argv.json");
    process.env.STUB_ARGV_FILE = argvFile;
    await createCodexCliBrain({ command: codexStub }).runTurn({
      system: "SECRET_SYSTEM_MARKER",
      prompt: "continue",
      bridge,
      resumeSessionId: "thread-xyz",
    });
    const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
    expect(argv[0]).toBe("exec");
    expect(argv[1]).toBe("resume");
    expect(argv).toContain("thread-xyz");
    expect(JSON.stringify(argv)).not.toContain("SECRET_SYSTEM_MARKER");
  });
});

describe("MCP config", () => {
  test("claude: writes bridge under mcpServers.olle", async () => {
    const mcpOut = join(dir, "claude-mcp.json");
    process.env.STUB_MCP_OUT = mcpOut;
    await createClaudeCliBrain({ command: claudeStub }).runTurn({
      system: "s",
      prompt: "hi",
      bridge,
    });
    const cfg = JSON.parse(readFileSync(mcpOut, "utf8"));
    expect(cfg.mcpServers.olle.command).toBe(bridge.command);
    expect(cfg.mcpServers.olle.args).toEqual(bridge.args);
  });

  test("codex: renders bridge into -c mcp_servers overrides", async () => {
    const argvFile = join(dir, "codex-mcp-argv.json");
    process.env.STUB_ARGV_FILE = argvFile;
    await createCodexCliBrain({ command: codexStub }).runTurn({
      system: "s",
      prompt: "hi",
      bridge,
    });
    const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
    expect(argv).toContain(`mcp_servers.olle.command=${JSON.stringify(bridge.command)}`);
    expect(argv).toContain(`mcp_servers.olle.args=${JSON.stringify(bridge.args)}`);
  });
});

describe("codex sandbox + effort flags", () => {
  test("runTurn uses a read-only sandbox, not the bypass flag", async () => {
    const argvFile = join(dir, "codex-sandbox-argv.json");
    process.env.STUB_ARGV_FILE = argvFile;
    await createCodexCliBrain({ command: codexStub }).runTurn({
      system: "s",
      prompt: "hi",
      bridge,
    });
    const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv).toContain(`sandbox_mode="read-only"`);
    expect(argv).toContain(`approval_policy="never"`);
  });

  test("maps reasoning effort to model_reasoning_effort (xhigh clamps to high)", async () => {
    const argvFile = join(dir, "codex-effort-argv.json");
    process.env.STUB_ARGV_FILE = argvFile;
    await createCodexCliBrain({ command: codexStub }).runTurn({
      system: "s",
      prompt: "hi",
      bridge,
      effort: "xhigh",
    });
    const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
    expect(argv).toContain(`model_reasoning_effort="high"`);
  });

  test("omits the effort override when no effort is set", async () => {
    const argvFile = join(dir, "codex-noeffort-argv.json");
    process.env.STUB_ARGV_FILE = argvFile;
    await createCodexCliBrain({ command: codexStub }).runTurn({
      system: "s",
      prompt: "hi",
      bridge,
    });
    const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
    expect(argv.some((a) => a.startsWith("model_reasoning_effort="))).toBe(false);
  });
});

describe("error classification", () => {
  test("claude: usage-limit result -> quota", async () => {
    process.env.STUB_MODE = "quota";
    const res = await createClaudeCliBrain({ command: claudeStub }).runTurn({
      system: "s",
      prompt: "hi",
      bridge,
    });
    expect(res.stopReason).toBe("error");
    expect(res.error?.code).toBe("quota");
  });

  test("codex: 503 overloaded -> transient", async () => {
    process.env.STUB_MODE = "transient";
    const res = await createCodexCliBrain({ command: codexStub }).runTurn({
      system: "s",
      prompt: "hi",
      bridge,
    });
    expect(res.stopReason).toBe("error");
    expect(res.error?.code).toBe("transient");
  });

  test("runTurn on missing binary -> not_installed error", async () => {
    const res = await createClaudeCliBrain({ command: "/no/such/claude" }).runTurn({
      system: "s",
      prompt: "hi",
      bridge,
    });
    expect(res.stopReason).toBe("error");
    expect(res.error?.code).toBe("not_installed");
  });
});

describe("prompt injection safety (codex)", () => {
  // A message beginning with `-` must never reach argv as a parsed flag — a
  // bare positional would let `-c mcp_servers.*.command=<binary>` inject codex
  // config (e.g. override the sandbox/approval settings the turn runs under).
  // The prompt goes through stdin (positional `-`).
  const EVIL = "-c mcp_servers.evil.command=/bin/sh --evil-flag";

  test("fresh: flag-shaped prompt goes to stdin, not argv", async () => {
    const argvFile = join(dir, "codex-inject-fresh-argv.json");
    const stdinFile = join(dir, "codex-inject-fresh-stdin.txt");
    process.env.STUB_ARGV_FILE = argvFile;
    process.env.STUB_STDIN_FILE = stdinFile;
    await createCodexCliBrain({ command: codexStub }).runTurn({
      system: "sys",
      prompt: EVIL,
      bridge,
    });
    const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
    // Prompt travels via stdin behind a `-` positional; never as its own arg.
    expect(argv).toContain("-");
    expect(argv).not.toContain(EVIL);
    // No fragment of the injected prompt leaks into argv as a parsed token.
    expect(argv).not.toContain("mcp_servers.evil.command=/bin/sh");
    expect(argv).not.toContain("--evil-flag");
    expect(readFileSync(stdinFile, "utf8")).toContain(EVIL);
  });

  test("resume: flag-shaped prompt goes to stdin, not argv", async () => {
    const argvFile = join(dir, "codex-inject-resume-argv.json");
    const stdinFile = join(dir, "codex-inject-resume-stdin.txt");
    process.env.STUB_ARGV_FILE = argvFile;
    process.env.STUB_STDIN_FILE = stdinFile;
    await createCodexCliBrain({ command: codexStub }).runTurn({
      system: "sys",
      prompt: EVIL,
      bridge,
      resumeSessionId: "thread-xyz",
    });
    const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
    expect(argv[0]).toBe("exec");
    expect(argv[1]).toBe("resume");
    expect(argv).toContain("thread-xyz");
    expect(argv[argv.length - 1]).toBe("-"); // prompt positional is `-`
    expect(argv).not.toContain(EVIL);
    expect(argv).not.toContain("--evil-flag");
    expect(readFileSync(stdinFile, "utf8")).toBe(EVIL);
  });
});

describe("oneShot surfaces backend errors (FIX 4)", () => {
  test("claude: auth-error stub rejects instead of returning empty success", async () => {
    process.env.STUB_MODE = "auth";
    const brain = createClaudeCliBrain({ command: claudeStub });
    await expect(brain.oneShot({ prompt: "hi" })).rejects.toThrow();
  });

  test("codex: auth-error stub rejects instead of returning empty success", async () => {
    process.env.STUB_MODE = "auth";
    const brain = createCodexCliBrain({ command: codexStub });
    await expect(brain.oneShot({ prompt: "hi" })).rejects.toThrow();
  });
});

describe("pricing", () => {
  test("*-cli providers price at $0", () => {
    expect(priceTokens("claude-cli", "claude", usage, Date.now())).toBe(0);
    expect(priceTokens("codex-cli", "codex", usage, Date.now())).toBe(0);
  });

  test("real providers still price normally", () => {
    expect(priceTokens("anthropic", "claude-opus-4-8", usage, Date.now())).toBeGreaterThan(0);
  });
});

describe("cliBrainToLlm shim", () => {
  test("claude: complete returns a Completion with the stub's text", async () => {
    const llm = cliBrainToLlm(createClaudeCliBrain({ command: claudeStub }));
    const c = await llm.complete({
      model: "claude",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
    });
    expect(c.stopReason).toBe("end_turn");
    expect(c.content).toEqual([{ type: "text", text: "hello world" }]);
    expect(c.usage.inputTokens).toBe(10);
  });

  test("codex: complete returns the stub's text", async () => {
    const llm = cliBrainToLlm(createCodexCliBrain({ command: codexStub }));
    const c = await llm.complete({
      model: "codex",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
    });
    expect(c.content).toEqual([{ type: "text", text: "hi from codex" }]);
  });
});
