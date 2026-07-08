import type { StarterTemplate } from "./types.ts";

export const claudeCode: StarterTemplate = {
  name: "claude-code",
  description: "Tool that shells out to the claude CLI for code-authoring tasks in a workspace path.",
  files: {
    "manifest.json": JSON.stringify(
      {
        name: "claude-code",
        version: "0.1.0",
        description: "Invoke the claude CLI as a subprocess on a workspace.",
        capabilities: ["tool:claude_code"],
        config: {
          command: "claude",
        },
      },
      null,
      2,
    ) + "\n",
    "index.ts":
`// claude-code: a tool that runs \`claude -p <prompt>\` in a workspace and
// returns stdout. Useful when an agent wants to delegate a coding task
// to a headless Claude Code session.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

function loadConfig() {
  try {
    const here = dirname(new URL(import.meta.url).pathname);
    const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
    return manifest.config || {};
  } catch {
    return {};
  }
}

function resolveCommand(command) {
  if (command.includes("/")) {
    return existsSync(command) ? command : null;
  }
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function validateCwd(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("claude_code: cwd must be a non-empty absolute path");
  }
  if (!isAbsolute(cwd)) {
    throw new Error(\`claude_code: cwd must be absolute, got "\${cwd}"\`);
  }
  if (!existsSync(cwd)) {
    throw new Error(\`claude_code: cwd does not exist: \${cwd}\`);
  }
  if (!statSync(cwd).isDirectory()) {
    throw new Error(\`claude_code: cwd is not a directory: \${cwd}\`);
  }
}

export function register(api) {
  const cfg = loadConfig();
  api.registerTool({
    name: "claude_code",
    description:
      "Run the claude CLI with a prompt inside a verified absolute working directory and return its stdout. Useful for delegating code changes. If this fails, inspect query_host_context for cwd/PATH and command availability before retrying.",
    tier: "strategic",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "prompt to pass to claude -p" },
        cwd: { type: "string", description: "absolute path to the workspace" },
        timeoutMs: { type: "number" },
      },
      required: ["prompt", "cwd"],
      additionalProperties: false,
    },
    execute: ({ prompt, cwd, timeoutMs }) =>
      new Promise((resolve, reject) => {
        try {
          validateCwd(cwd);
        } catch (err) {
          reject(err);
          return;
        }
        const command = cfg.command || process.env.CLAUDE_CODE_BIN || "claude";
        const executable = resolveCommand(command);
        if (!executable) {
          reject(
            new Error(
              \`claude_code: executable "\${command}" not found on PATH. Set manifest.config.command to an absolute Claude CLI path or ensure the daemon PATH includes it.\`,
            ),
          );
          return;
        }
        const child = spawn(executable, ["-p", prompt], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d.toString()));
        child.stderr.on("data", (d) => (err += d.toString()));
        const t = timeoutMs
          ? setTimeout(() => {
              child.kill("SIGTERM");
              reject(new Error(\`claude_code timeout after \${timeoutMs}ms\`));
            }, timeoutMs)
          : null;
        child.on("close", (code) => {
          if (t) clearTimeout(t);
          if (code === 0) resolve(out);
          else reject(new Error(\`claude exited \${code}: \${err || out}\`));
        });
        child.on("error", (e) => {
          if (t) clearTimeout(t);
          reject(
            new Error(
              \`claude_code: failed to spawn "\${executable}" in cwd "\${cwd}": \${e.message}\`,
            ),
          );
        });
      }),
  });
}
`,
    "smoke.ts":
`export async function smokeTest() {
  // Verify the 'claude' binary exists on PATH. Don't actually run it
  // (would spend tokens / need auth).
  const { existsSync, readFileSync } = require("node:fs");
  const { delimiter, dirname, join } = require("node:path");
  const here = dirname(new URL(import.meta.url).pathname);
  const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
  const command = manifest.config?.command || process.env.CLAUDE_CODE_BIN || "claude";
  const found = command.includes("/")
    ? existsSync(command)
    : (process.env.PATH || "")
        .split(delimiter)
        .some((dir) => dir && existsSync(join(dir, command)));
  if (found) return;
  const { spawnSync } = require("node:child_process");
  const r = spawnSync("which", [command], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) {
    throw new Error(\`claude-code: executable "\${command}" not on PATH; set manifest.config.command to an absolute path if the daemon has a different PATH\`);
  }
}
`,
  },
};
