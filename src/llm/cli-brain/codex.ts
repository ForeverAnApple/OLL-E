// Codex CLI adapter. Drives `codex exec --json` as an LLM backend, the sibling
// of ./claude.ts: same shape, adapted to Codex's JSONL event stream and config
// surface. The harness owns its inner loop; OLL-E's tools reach it over MCP,
// configured through `-c mcp_servers.olle.*` overrides built from the bridge.
//
// Shares ./spawn.ts for all process plumbing; differs only in arg construction
// and event parsing.

import type { ReasoningEffort, Usage } from "../types.ts";
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

const PROVIDER = "codex-cli";
const PROBE_TIMEOUT_MS = 30_000;

const AUTH_PATTERNS = [
  /not logged in/i,
  /please run\s+codex login/i,
  /run:?\s*codex login/i,
  /unauthorized/i,
  /authentication (?:failed|required|error)/i,
  /no api key|missing api key|invalid api key/i,
  /sign in/i,
];

interface ParsedTurn {
  text: string;
  usage: Usage;
  sessionId?: string;
  sawTurnComplete: boolean;
  errorText?: string;
  code: number | null;
  stderrText: string;
  raw: string;
}

// Codex reports `input_tokens` INCLUSIVE of cached input, with the cached slice
// in `cached_input_tokens`. Our Usage.inputTokens is uncached-only, so subtract.
// `reasoning_output_tokens` is a breakdown of `output_tokens`, not additive.
function mapUsage(u: unknown): Usage {
  const o = (u ?? {}) as Record<string, unknown>;
  const totalInput = num(o.input_tokens);
  const cacheRead = num(o.cached_input_tokens);
  const uncachedInput = Math.max(0, totalInput - cacheRead);
  const output = num(o.output_tokens);
  return {
    inputTokens: uncachedInput,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: 0, // Codex has no cache-creation surcharge/field
    totalTokens: uncachedInput + output + cacheRead,
  };
}

async function runCodex(params: {
  command: string;
  args: string[];
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onTextDelta?: (delta: string) => void;
}): Promise<ParsedTurn> {
  let text = "";
  let usage = zeroUsage();
  let sessionId: string | undefined;
  let sawTurnComplete = false;
  let errorText: string | undefined;
  let raw = "";

  const onLine = (line: string) => {
    raw += line + "\n";
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (ev.type) {
      case "thread.started":
        if (typeof ev.thread_id === "string") sessionId = ev.thread_id;
        break;
      case "item.completed": {
        const item = ev.item as { type?: string; text?: string } | undefined;
        if (item?.type === "agent_message" && typeof item.text === "string") {
          text += item.text;
          params.onTextDelta?.(item.text);
        }
        break;
      }
      case "turn.completed":
        sawTurnComplete = true;
        if (ev.usage) usage = mapUsage(ev.usage);
        break;
      case "turn.failed":
      case "error": {
        const e = ev.error as { message?: string } | undefined;
        errorText =
          (typeof e?.message === "string" && e.message) ||
          (typeof ev.message === "string" ? (ev.message as string) : undefined) ||
          "codex error";
        break;
      }
    }
  };

  const { code, stderrText } = await streamLines({
    command: params.command,
    args: params.args,
    ...(params.stdin !== undefined && { stdin: params.stdin }),
    onLine,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });

  return {
    text,
    usage,
    sessionId,
    sawTurnComplete,
    errorText,
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

/** A turn failed if Codex reported an error, or exited non-zero without ever
 *  emitting `turn.completed`. Shared by runTurn's toResult and oneShot. */
function turnFailed(parsed: ParsedTurn): boolean {
  return (
    parsed.errorText !== undefined ||
    (!parsed.sawTurnComplete && parsed.code !== 0)
  );
}

// Non-interactive, read-only sandbox for the harness's own shell/apply_patch.
// OLL-E's tools reach the turn over the MCP bridge (Codex spawns MCP servers
// itself, outside the shell sandbox), so the native shell needs no write
// access — read-only keeps a misfired or adversarially-steered turn from
// touching host state outside OLL-E's permission gate, while
// `approval_policy=never` keeps exec non-interactive (it cannot prompt anyway).
// Values are TOML literals (quoted strings). This replaces the far wider
// `--dangerously-bypass-approvals-and-sandbox`, which lifted the sandbox whole.
const SANDBOX_ARGS = [
  "-c",
  `sandbox_mode="read-only"`,
  "-c",
  `approval_policy="never"`,
];

// Codex exposes reasoning effort via `-c model_reasoning_effort=<low|medium|high>`.
// OLL-E's scale (low/medium/high/xhigh/max) tops out higher, so clamp xhigh/max
// down to high; undefined effort (the `off` case) omits the override entirely.
function effortArgs(effort: ReasoningEffort | undefined): string[] {
  if (!effort) return [];
  const level = effort === "low" ? "low" : effort === "medium" ? "medium" : "high";
  return ["-c", `model_reasoning_effort="${level}"`];
}

// Render the bridge into Codex `-c` config overrides. Values are parsed as TOML,
// so JSON.stringify gives valid TOML string / string-array literals.
function mcpConfigArgs(bridge: CliTurnRequest["bridge"]): string[] {
  return [
    "-c",
    `mcp_servers.${OLLE_MCP_SERVER_NAME}.command=${JSON.stringify(bridge.command)}`,
    "-c",
    `mcp_servers.${OLLE_MCP_SERVER_NAME}.args=${JSON.stringify(bridge.args)}`,
  ];
}

export interface CodexCliBrainOptions {
  command?: string;
  model?: string;
}

export function createCodexCliBrain(
  opts: CodexCliBrainOptions = {},
): CliBrain & OneShotBrain {
  const defaultModel = opts.model ?? "codex";

  const resolve = () =>
    resolveBinary({
      command: opts.command,
      envVar: "CODEX_BIN",
      fallback: "codex",
    });

  async function probe(signal?: AbortSignal): Promise<CliProbeResult> {
    const bin = resolve();
    if (!bin) {
      return {
        status: "not-installed",
        detail: "codex CLI not found (checked options.command, CODEX_BIN, PATH)",
      };
    }
    let parsed: ParsedTurn;
    try {
      parsed = await runCodex({
        command: bin,
        args: [
          "exec",
          "--json",
          "--skip-git-repo-check",
          "Respond with the single word: hello.",
        ],
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
        loginHint: "run: codex login",
        detail: parsed.stderrText.trim() || parsed.errorText || undefined,
      };
    }
    if (parsed.sawTurnComplete && !parsed.errorText && /hello/i.test(parsed.text)) {
      return { status: "ready" };
    }
    return {
      status: "broken",
      detail:
        parsed.errorText ||
        parsed.stderrText.trim() ||
        `unexpected probe output (exit ${parsed.code ?? "?"})`,
    };
  }

  async function runTurn(req: CliTurnRequest): Promise<CliTurnResult> {
    const bin = resolve();
    if (!bin) {
      return {
        text: "",
        usage: zeroUsage(),
        stopReason: "error",
        error: { code: "not_installed", message: "codex CLI not found" },
      };
    }

    // Sandbox read-only + approvals never (see SANDBOX_ARGS): the harness's own
    // shell runs sandboxed, OLL-E's tools reach the turn over the MCP bridge.
    const common = [
      "--json",
      "--skip-git-repo-check",
      ...SANDBOX_ARGS,
      ...effortArgs(req.effort),
      ...mcpConfigArgs(req.bridge),
    ];
    if (req.model) common.push("-m", req.model);

    // The prompt goes through stdin (positional `-`), never argv. Two reasons:
    // (1) a bare positional lets a message starting with `-` inject codex flags
    //     — e.g. `-c mcp_servers.*.command=<binary>`. `codex exec -` /
    //     `codex exec resume <id> -` read instructions from stdin (documented),
    //     so message content can never be parsed as an option.
    // (2) a post-restart turn concatenates system + full transcript + prompt;
    //     as one argv string that blows past the ~128KB Linux arg limit (E2BIG).
    //     stdin has no such cap.
    let args: string[];
    let stdin: string;
    if (req.resumeSessionId) {
      // Resume: no system, no transcript. Session id is a positional; the
      // prompt is stdin via the trailing `-`.
      args = ["exec", "resume", req.resumeSessionId, ...common, "-"];
      stdin = req.prompt;
    } else {
      // Fresh: Codex has no system-prompt flag, so prepend system (+ transcript)
      // to the prompt. Injected on fresh sessions only, all through stdin.
      const parts = [req.system, req.priorTranscript, req.prompt].filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      );
      args = ["exec", ...common, "-"];
      stdin = parts.join("\n\n");
    }

    try {
      const parsed = await runCodex({
        command: bin,
        args,
        stdin,
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
    }
  }

  function toResult(parsed: ParsedTurn): CliTurnResult {
    if (turnFailed(parsed)) {
      const haystack = `${parsed.errorText ?? ""}\n${parsed.stderrText}\n${parsed.raw}`;
      const code = classifyError(haystack);
      const loginHint = code === "auth_required" ? "run: codex login" : undefined;
      return {
        text: parsed.text,
        usage: parsed.usage,
        sessionId: parsed.sessionId,
        stopReason: "error",
        error: {
          code,
          message: parsed.errorText || parsed.stderrText.trim() || "codex turn failed",
          loginHint,
        },
      };
    }

    return {
      text: parsed.text,
      usage: parsed.usage,
      sessionId: parsed.sessionId,
      stopReason: "end_turn",
    };
  }

  async function oneShot(req: OneShotRequest): Promise<OneShotResult> {
    const bin = resolve();
    if (!bin) throw new Error("codex CLI not found");
    const parts = [req.system, req.prompt].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      ...SANDBOX_ARGS,
    ];
    if (req.model) args.push("-m", req.model);
    args.push("-"); // prompt via stdin, never argv (injection + E2BIG safe)
    const parsed = await runCodex({
      command: bin,
      args,
      stdin: parts.join("\n\n"),
      signal: req.signal,
    });
    // A dead backend (auth-lost/quota) yields empty text + no turn.completed;
    // returning that as a success makes the model-switch probe "pass" against a
    // logged-out CLI. Throw so callers (probe, shim) treat it as failure.
    if (turnFailed(parsed)) {
      throw new Error(
        parsed.errorText ||
          parsed.stderrText.trim() ||
          `codex one-shot failed (exit ${parsed.code ?? "?"})`,
      );
    }
    return { text: parsed.text, usage: parsed.usage };
  }

  return { provider: PROVIDER, defaultModel, probe, runTurn, oneShot };
}
