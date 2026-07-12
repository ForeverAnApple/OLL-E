// Claude Code CLI adapter. Drives `claude -p --output-format stream-json` as an
// LLM backend: the CLI harness owns its own inner LLM<->tool loop, and OLL-E's
// tools reach that loop over MCP (the bridge in ../../mcp/contract.ts). We spawn
// one turn, stream assistant text, parse the final `result` event for usage +
// session id, and classify failures.
//
// Sibling of ./codex.ts — the two share ./spawn.ts for all process plumbing and
// differ only in arg construction and event-stream parsing.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import type { Usage } from "../types.ts";
import { zeroUsage } from "../types.ts";
import { OLLE_MCP_SERVER_NAME } from "../../mcp/contract.ts";
import type {
  CliBrain,
  CliErrorCode,
  CliProbeResult,
  CliTurnRequest,
  CliTurnResult,
} from "./types.ts";
import type { OneShotBrain, OneShotRequest, OneShotResult } from "./one-shot.ts";
import {
  SpawnError,
  QUOTA_PATTERNS,
  TRANSIENT_PATTERNS,
  classifySpawnError,
  matchesAny,
  num,
  resolveBinary,
  streamLines,
} from "./spawn.ts";

const PROVIDER = "claude-cli";
const PROBE_TIMEOUT_MS = 30_000;
// System prompts over this size go through a temp file: a single argv string is
// capped (~128KB per arg on Linux, MAX_ARG_STRLEN), and identity + catalog can
// exceed it. Small prompts stay inline to avoid a temp file per turn.
const SYSTEM_INLINE_MAX = 32_000;

const AUTH_PATTERNS = [
  /not logged in/i,
  /please run\s+(?:\/|claude\s+)?login/i,
  /invalid api key/i,
  /unauthorized/i,
  /authentication (?:failed|required|error)/i,
  /\/login\b/i,
  /run:?\s*claude login/i,
];

interface ParsedTurn {
  text: string;
  usage: Usage;
  sessionId?: string;
  subtype?: string;
  isError: boolean;
  stopReasonRaw?: string;
  sawResult: boolean;
  code: number | null;
  stderrText: string;
  raw: string;
}

// claude reports `input_tokens` as UNCACHED input, with cache reads/writes in
// separate fields — this maps 1:1 onto our Usage (uncached-input semantics).
function mapUsage(u: unknown): Usage {
  const o = (u ?? {}) as Record<string, unknown>;
  const input = num(o.input_tokens);
  const cacheRead = num(o.cache_read_input_tokens);
  const cacheCreate = num(o.cache_creation_input_tokens);
  const output = num(o.output_tokens);
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreate,
    totalTokens: input + output + cacheRead + cacheCreate,
  };
}

/** Run one `claude` invocation and parse its stream-json output. Shared by both
 *  runTurn (full turn with MCP) and the one-shot Llm shim (no MCP). */
async function runClaude(params: {
  command: string;
  args: string[];
  stdin: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onTextDelta?: (delta: string) => void;
}): Promise<ParsedTurn> {
  let text = "";
  let usage = zeroUsage();
  let sessionId: string | undefined;
  let subtype: string | undefined;
  let isError = false;
  let stopReasonRaw: string | undefined;
  let sawResult = false;
  let raw = "";

  const onLine = (line: string) => {
    raw += line + "\n";
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // non-JSON diagnostic line — ignore, keep it out of the parse path
    }
    const type = ev.type;
    if (type === "system" && ev.subtype === "init") {
      if (typeof ev.session_id === "string") sessionId = ev.session_id;
    } else if (type === "assistant") {
      const msg = ev.message as { content?: unknown } | undefined;
      const content = Array.isArray(msg?.content) ? msg!.content : [];
      for (const block of content) {
        const b = block as { type?: string; text?: string };
        if (b.type === "text" && typeof b.text === "string") {
          text += b.text;
          params.onTextDelta?.(b.text);
        }
      }
    } else if (type === "result") {
      sawResult = true;
      subtype = typeof ev.subtype === "string" ? ev.subtype : undefined;
      isError = ev.is_error === true;
      if (typeof ev.session_id === "string") sessionId = ev.session_id;
      if (typeof ev.stop_reason === "string") stopReasonRaw = ev.stop_reason;
      if (ev.usage) usage = mapUsage(ev.usage);
      // If no assistant text streamed (some turns only surface `result`), fall
      // back to the final result string.
      if (text.length === 0 && typeof ev.result === "string") text = ev.result;
    }
  };

  const { code, stderrText } = await streamLines({
    command: params.command,
    args: params.args,
    stdin: params.stdin,
    onLine,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });

  return {
    text,
    usage,
    sessionId,
    subtype,
    isError,
    stopReasonRaw,
    sawResult,
    code,
    stderrText,
    raw,
  };
}

function classifyError(haystack: string): CliErrorCode {
  if (matchesAny(haystack, AUTH_PATTERNS)) return "auth_required";
  if (matchesAny(haystack, QUOTA_PATTERNS)) return "quota";
  if (matchesAny(haystack, TRANSIENT_PATTERNS)) return "transient";
  return "unknown";
}

/** A turn failed if the harness flagged an error / a non-success result
 *  subtype, or exited non-zero without ever emitting a `result` event. Shared
 *  by runTurn's toResult and oneShot. */
function turnFailed(parsed: ParsedTurn): boolean {
  return (
    parsed.isError ||
    (parsed.subtype !== undefined && parsed.subtype !== "success") ||
    (!parsed.sawResult && parsed.code !== 0)
  );
}

/** Write `content` into a fresh temp dir as `filename`. Returns the file path
 *  and a best-effort cleanup fn. Used for both the MCP config and an oversized
 *  system prompt (claude reads both from a path). */
function writeTempFile(
  prefix: string,
  filename: string,
  content: string,
): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, filename);
  writeFileSync(path, content);
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/** Write the bridge as a claude `--mcp-config` file. */
function writeMcpConfig(bridge: CliTurnRequest["bridge"]): {
  path: string;
  cleanup: () => void;
} {
  return writeTempFile(
    "olle-claude-mcp-",
    "mcp.json",
    JSON.stringify({
      mcpServers: {
        [OLLE_MCP_SERVER_NAME]: { command: bridge.command, args: bridge.args },
      },
    }),
  );
}

function writeSystemFile(system: string): { path: string; cleanup: () => void } {
  return writeTempFile("olle-claude-sys-", "system.txt", system);
}

export interface ClaudeCliBrainOptions {
  command?: string;
  model?: string;
}

export function createClaudeCliBrain(
  opts: ClaudeCliBrainOptions = {},
): CliBrain & OneShotBrain {
  const defaultModel = opts.model ?? "claude";

  const resolve = () =>
    resolveBinary({
      command: opts.command,
      envVar: "CLAUDE_CODE_BIN",
      fallback: "claude",
    });

  async function probe(signal?: AbortSignal): Promise<CliProbeResult> {
    const bin = resolve();
    if (!bin) {
      return {
        status: "not-installed",
        detail: "claude CLI not found (checked options.command, CLAUDE_CODE_BIN, PATH)",
      };
    }
    let parsed: ParsedTurn;
    try {
      parsed = await runClaude({
        command: bin,
        args: ["-p", "--output-format", "stream-json", "--verbose"],
        stdin: "Respond with the single word: hello.",
        signal,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
    } catch (err) {
      if (err instanceof SpawnError && err.kind === "aborted") throw err;
      return {
        status: "broken",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    const haystack = `${parsed.stderrText}\n${parsed.raw}`;
    if (matchesAny(haystack, AUTH_PATTERNS)) {
      return {
        status: "needs-login",
        loginHint: "run: claude login",
        detail: parsed.stderrText.trim() || parsed.text.trim() || undefined,
      };
    }
    if (
      parsed.sawResult &&
      !parsed.isError &&
      /hello/i.test(parsed.text)
    ) {
      return { status: "ready", version: cheapVersion(bin) };
    }
    return {
      status: "broken",
      detail:
        parsed.stderrText.trim() ||
        `unexpected probe output (exit ${parsed.code ?? "?"})`,
    };
  }

  function cheapVersion(bin: string): string | undefined {
    try {
      const out = execFileSync(bin, ["--version"], {
        encoding: "utf8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async function runTurn(req: CliTurnRequest): Promise<CliTurnResult> {
    const bin = resolve();
    if (!bin) {
      return {
        text: "",
        usage: zeroUsage(),
        stopReason: "error",
        error: {
          code: "not_installed",
          message: "claude CLI not found",
        },
      };
    }

    const mcp = writeMcpConfig(req.bridge);
    const cleanups: Array<() => void> = [mcp.cleanup];

    // Base args. `--allowedTools mcp__olle` allowlists ONLY our MCP server's
    // tools so the harness auto-runs them non-interactively in print mode.
    // Safe because OLL-E's own permission gate enforces scope/tier server-side
    // in the bridge — the CLI allowlist is not the boundary, ours is.
    // `--strict-mcp-config` keeps the harness from loading the user's other MCP
    // servers into this turn.
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      mcp.path,
      "--strict-mcp-config",
      "--allowedTools",
      `mcp__${OLLE_MCP_SERVER_NAME}`,
    ];

    if (req.resumeSessionId) {
      // Resume: do NOT re-send system or transcript.
      args.push("--resume", req.resumeSessionId);
    } else if (req.system) {
      if (req.system.length > SYSTEM_INLINE_MAX) {
        const sys = writeSystemFile(req.system);
        cleanups.push(sys.cleanup);
        args.push("--append-system-prompt-file", sys.path);
      } else {
        args.push("--append-system-prompt", req.system);
      }
    }

    if (req.model) args.push("--model", req.model);

    // req.effort is intentionally ignored: the `claude` CLI exposes no reliable
    // flag/env to set reasoning effort per invocation, so set_reasoning_effort
    // is a no-op on this backend (it still applies in API mode and on codex).

    // Fresh session with prior history: prepend the rendered transcript to the
    // prompt (claude has no transcript flag).
    const prompt =
      !req.resumeSessionId && req.priorTranscript
        ? `${req.priorTranscript}\n\n${req.prompt}`
        : req.prompt;

    try {
      const parsed = await runClaude({
        command: bin,
        args,
        stdin: prompt,
        signal: req.signal,
        onTextDelta: req.onTextDelta,
      });
      return toResult(parsed);
    } catch (err) {
      if (err instanceof SpawnError) {
        if (err.kind === "aborted") throw err;
        return {
          text: "",
          usage: zeroUsage(),
          stopReason: "error",
          error: { code: classifySpawnError(err), message: err.message },
        };
      }
      throw err;
    } finally {
      for (const c of cleanups) c();
    }
  }

  function toResult(parsed: ParsedTurn): CliTurnResult {
    if (turnFailed(parsed)) {
      const haystack = `${parsed.stderrText}\n${parsed.raw}`;
      let code = classifyError(haystack);
      let stopReason: CliTurnResult["stopReason"] = "error";
      if (parsed.subtype === "error_max_turns") {
        stopReason = "max_turns";
        code = code === "unknown" ? "transient" : code;
      } else if (parsed.stopReasonRaw === "refusal") {
        stopReason = "refusal";
        code = "refusal";
      }
      const loginHint = code === "auth_required" ? "run: claude login" : undefined;
      return {
        text: parsed.text,
        usage: parsed.usage,
        sessionId: parsed.sessionId,
        stopReason,
        error: {
          code,
          message: parsed.stderrText.trim() || `claude turn failed (${parsed.subtype ?? "no result"})`,
          loginHint,
        },
      };
    }

    return {
      text: parsed.text,
      usage: parsed.usage,
      sessionId: parsed.sessionId,
      stopReason: parsed.stopReasonRaw === "refusal" ? "refusal" : "end_turn",
    };
  }

  // One-shot path for the Llm shim: no MCP, no session, just system + prompt.
  async function oneShot(req: OneShotRequest): Promise<OneShotResult> {
    const bin = resolve();
    if (!bin) throw new Error("claude CLI not found");
    const cleanups: Array<() => void> = [];
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (req.system) {
      if (req.system.length > SYSTEM_INLINE_MAX) {
        const sys = writeSystemFile(req.system);
        cleanups.push(sys.cleanup);
        args.push("--append-system-prompt-file", sys.path);
      } else {
        args.push("--append-system-prompt", req.system);
      }
    }
    if (req.model) args.push("--model", req.model);
    try {
      const parsed = await runClaude({
        command: bin,
        args,
        stdin: req.prompt,
        signal: req.signal,
      });
      // Same failed-turn test as toResult: a dead backend (auth-lost/quota)
      // surfaces isError / a non-success subtype / no result. Returning that as
      // a success makes the model-switch probe "pass" against a logged-out CLI,
      // so throw instead and let callers treat it as failure.
      if (turnFailed(parsed)) {
        throw new Error(
          parsed.stderrText.trim() ||
            parsed.text.trim() ||
            `claude one-shot failed (${parsed.subtype ?? "no result"})`,
        );
      }
      return { text: parsed.text, usage: parsed.usage };
    } finally {
      for (const c of cleanups) c();
    }
  }

  return { provider: PROVIDER, defaultModel, probe, runTurn, oneShot };
}
