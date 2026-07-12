// Shared subprocess plumbing for the CLI-brain adapters. The claude and codex
// adapters are siblings: they differ only in how they render args and parse
// each CLI's structured event stream. Everything about *spawning* a process,
// feeding it stdin, reading stdout line-by-line, capturing stderr, and honoring
// timeouts/aborts lives here so neither adapter reimplements it.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { CliErrorCode } from "./types.ts";

/** Why the subprocess ended abnormally — adapters map this onto a CliErrorCode. */
export type SpawnFailureKind = "spawn_failed" | "timeout" | "aborted";

export class SpawnError extends Error {
  constructor(
    message: string,
    readonly kind: SpawnFailureKind,
  ) {
    super(message);
    this.name = "SpawnError";
  }
}

export interface ResolveBinaryOptions {
  /** Explicit command from adapter options — highest precedence. Accepts an
   *  absolute/relative path (used as-is if it exists) or a bare name (looked up
   *  on PATH). */
  command?: string;
  /** Env var checked next (e.g. CLAUDE_CODE_BIN / CODEX_BIN). A daemon under
   *  launchd/systemd may have a thin PATH, so an explicit override matters. */
  envVar?: string;
  /** Bare fallback name resolved on PATH when neither command nor env is set. */
  fallback: string;
  env?: NodeJS.ProcessEnv;
}

/** Resolve a CLI binary to an absolute path, or null if unresolved. Precedence:
 *  explicit command -> env override -> PATH lookup of the fallback name. */
export function resolveBinary(opts: ResolveBinaryOptions): string | null {
  const env = opts.env ?? process.env;
  const candidate =
    opts.command ??
    (opts.envVar ? env[opts.envVar] : undefined) ??
    opts.fallback;
  return resolveOnPath(candidate, env);
}

function resolveOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  if (command.includes("/")) return existsSync(command) ? command : null;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, command);
    if (existsSync(full)) return full;
  }
  return null;
}

export interface StreamResult {
  code: number | null;
  stderrText: string;
}

export interface StreamOptions {
  command: string;
  args: string[];
  /** Written to stdin then closed. If omitted, stdin is closed immediately so
   *  the child sees EOF (some CLIs take the prompt as an arg instead). */
  stdin?: string;
  /** Called once per complete stdout line (trailing newline/CR stripped, blank
   *  lines skipped). Callback errors are swallowed — a bad parse of one line
   *  must not kill the stream. */
  onLine: (line: string) => void;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}

/** Spawn a command, stream its stdout line-by-line, resolve with the exit code
 *  and captured stderr. Rejects with a SpawnError on spawn failure, timeout, or
 *  abort so the caller can classify the failure. */
export function streamLines(opts: StreamOptions): Promise<StreamResult> {
  return new Promise<StreamResult>((resolve, reject) => {
    let settled = false;
    const child = spawn(opts.command, opts.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env ?? process.env,
      cwd: opts.cwd,
    });

    let stderrText = "";
    let buf = "";
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onAbort = () => fail("aborted", "subprocess aborted");

    function cleanup() {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }

    function fail(kind: SpawnFailureKind, message: string) {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      reject(new SpawnError(message, kind));
    }

    function feed(line: string) {
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (trimmed.length === 0) return;
      try {
        opts.onLine(trimmed);
      } catch {
        /* a malformed line is diagnostic noise, not a fatal error */
      }
    }

    if (opts.timeoutMs) {
      timer = setTimeout(
        () => fail("timeout", `subprocess timed out after ${opts.timeoutMs}ms`),
        opts.timeoutMs,
      );
    }

    if (opts.signal) {
      if (opts.signal.aborted) {
        fail("aborted", "subprocess aborted");
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        feed(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrText += chunk;
    });

    // ENOENT and friends arrive here — the binary vanished between resolve and
    // spawn, or is not executable.
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new SpawnError(err.message, "spawn_failed"));
    });

    child.on("close", (code) => {
      if (settled) return;
      if (buf.length > 0) feed(buf); // flush a final unterminated line
      settled = true;
      cleanup();
      resolve({ code, stderrText });
    });

    // A CLI that exits before draining stdin raises EPIPE on write/end. Without
    // a listener that surfaces as an uncaughtException (and could be misblamed
    // on an unrelated extension circuit-breaker). The close/error handlers above
    // already carry the real outcome, so swallow the pipe error here.
    child.stdin.on("error", () => {
      /* EPIPE / broken pipe — child gone before stdin drained; non-fatal */
    });
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

/** Test whether any pattern matches — small shared helper so both adapters
 *  classify auth/quota text the same way. */
export function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}

// Failure-signal pattern sets shared by both adapters. AUTH_PATTERNS stays
// per-adapter (the login hint text differs: "codex login" vs "claude login"),
// but quota/transient signals and the spawn-error mapping are identical.
export const QUOTA_PATTERNS = [
  /usage limit/i,
  /quota/i,
  /out of credit/i,
  /billing/i,
  /insufficient/i,
];
export const TRANSIENT_PATTERNS = [
  /rate limit/i,
  /\b429\b/,
  /overloaded/i,
  /capacity/i,
  /temporarily/i,
  /timeout/i,
  /\b5\d\d\b/,
];

/** Coerce an unknown to a finite number, or 0 — used to read provider-reported
 *  token counts that may be missing or non-numeric. */
export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Map a subprocess spawn failure onto a CliErrorCode: a genuine spawn failure
 *  (ENOENT / not executable) is terminal; a timeout/abort is transient. */
export function classifySpawnError(err: SpawnError): CliErrorCode {
  return err.kind === "spawn_failed" ? "spawn_failed" : "transient";
}
