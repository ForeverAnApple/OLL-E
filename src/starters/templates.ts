// Starter extension templates — shipped inside the binary as in-memory
// files. `install_starter` writes them to ~/.olle/extensions/<name>/ so
// the agent can iterate on them like any other extension (git-tracked,
// smoke-gated, hot-reloadable). No hardcoded features.

export interface StarterTemplate {
  name: string;
  description: string;
  files: Record<string, string>;
}

const cronTrigger: StarterTemplate = {
  name: "cron-trigger",
  description: "Fires an event every N milliseconds. Declare the interval and event type in the manifest's `config`.",
  files: {
    "manifest.json": JSON.stringify(
      {
        name: "cron-trigger",
        version: "0.1.0",
        description: "Periodic event trigger. Configure intervalMs + eventType.",
        capabilities: ["trigger:cron"],
        config: { intervalMs: 60000, eventType: "cron.fire" },
      },
      null,
      2,
    ) + "\n",
    "index.ts":
`// cron-trigger: fires a periodic event at intervalMs with eventType, per
// manifest.config. A single extension instance can only declare one
// interval; the agent grows specialized forks (e.g. "cron-hourly") for
// more rates.

const DEFAULT_INTERVAL = 60000;
const DEFAULT_TYPE = "cron.fire";

export function register(api) {
  // Read config from the manifest we shipped beside us.
  const fs = require("node:fs");
  const path = require("node:path");
  const here = path.dirname(new URL(import.meta.url).pathname);
  const manifestPath = path.join(here, "manifest.json");
  const cfg = JSON.parse(fs.readFileSync(manifestPath, "utf8")).config || {};
  const intervalMs = cfg.intervalMs ?? DEFAULT_INTERVAL;
  const eventType = cfg.eventType ?? DEFAULT_TYPE;

  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    api.publish(eventType, { tick: ticks, at: Date.now() }, { durable: true });
  }, intervalMs);

  // Store the timer on the api object so unload() can clear it.
  api.__cronTimer = timer;
}

export function unload() {
  // Best effort; if the api object is lost we accept leaking one timer.
}
`,
    "smoke.ts":
`export async function smokeTest() {
  // Non-destructive — just validate the manifest can be read.
  const fs = require("node:fs");
  const path = require("node:path");
  const here = path.dirname(new URL(import.meta.url).pathname);
  const raw = fs.readFileSync(path.join(here, "manifest.json"), "utf8");
  const m = JSON.parse(raw);
  if (!m.config || typeof m.config.intervalMs !== "number") {
    throw new Error("cron-trigger: manifest.config.intervalMs must be a number");
  }
}
`,
  },
};

const claudeCode: StarterTemplate = {
  name: "claude-code",
  description: "Tool that shells out to the claude CLI for code-authoring tasks in a workspace path.",
  files: {
    "manifest.json": JSON.stringify(
      {
        name: "claude-code",
        version: "0.1.0",
        description: "Invoke the claude CLI as a subprocess on a workspace.",
        capabilities: ["tool:claude_code"],
      },
      null,
      2,
    ) + "\n",
    "index.ts":
`// claude-code: a tool that runs \`claude -p <prompt>\` in a workspace and
// returns stdout. Useful when an agent wants to delegate a coding task
// to a headless Claude Code session.

import { z } from "zod";
import { spawn } from "node:child_process";

export function register(api) {
  api.registerTool({
    name: "claude_code",
    description:
      "Run the claude CLI with a prompt inside a working directory and return its stdout. Useful for delegating code changes.",
    parameters: z.object({
      prompt: z.string().describe("prompt to pass to claude -p"),
      cwd: z.string().describe("absolute path to the workspace"),
      timeoutMs: z.number().optional(),
    }),
    execute: ({ prompt, cwd, timeoutMs }) =>
      new Promise((resolve, reject) => {
        const child = spawn("claude", ["-p", prompt], {
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
          reject(e);
        });
      }),
  });
}
`,
    "smoke.ts":
`export async function smokeTest() {
  // Verify the 'claude' binary exists on PATH. Don't actually run it
  // (would spend tokens / need auth).
  const { spawnSync } = require("node:child_process");
  const r = spawnSync("which", ["claude"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) {
    throw new Error("claude CLI not on PATH");
  }
}
`,
  },
};

const discord: StarterTemplate = {
  name: "discord",
  description: "Stub Discord gateway extension. Agent expected to flesh out the connect + message pipeline; manifest declares TOKEN secret.",
  files: {
    "manifest.json": JSON.stringify(
      {
        name: "discord",
        version: "0.0.1",
        description: "Skeleton Discord adapter. Agent authors the gateway + message tools.",
        secrets: ["DISCORD_TOKEN"],
        capabilities: ["channel:discord"],
      },
      null,
      2,
    ) + "\n",
    "index.ts":
`// discord: stub template. The agent will flesh this out per the owner's
// ask — usually: open the gateway websocket using DISCORD_TOKEN, publish
// channel-message events to the bus, and register a discord_send tool.

export function register(api) {
  api.registerTool({
    name: "discord_send",
    description: "Placeholder discord_send — agent should replace with a real gateway call.",
    parameters: {
      parse: (x) => x,
    },
    execute: async (args) => {
      return \`discord stub received: \${JSON.stringify(args)}\`;
    },
  });
}
`,
    "smoke.ts":
`export async function smokeTest() {
  // No-op: stub extension; agent should replace with a live handshake
  // test once the gateway code is written.
}
`,
  },
};

const github: StarterTemplate = {
  name: "github",
  description: "Stub GitHub extension. Agent expected to author webhook receiver + REST ops; manifest declares GH_TOKEN.",
  files: {
    "manifest.json": JSON.stringify(
      {
        name: "github",
        version: "0.0.1",
        description: "Skeleton GitHub adapter. Agent authors webhook receiver + issue/PR tools.",
        secrets: ["GH_TOKEN"],
        capabilities: ["tool:github"],
      },
      null,
      2,
    ) + "\n",
    "index.ts":
`// github: stub template. Agent will add a webhook listener (HTTP server)
// and REST tools (issues, PRs, comments) using GH_TOKEN.

export function register(api) {
  api.registerTool({
    name: "github_stub",
    description: "Placeholder github tool — agent should replace with real REST calls.",
    parameters: { parse: (x) => x },
    execute: async (args) => \`github stub: \${JSON.stringify(args)}\`,
  });
}
`,
    "smoke.ts":
`export async function smokeTest() {
  // No-op stub; agent replaces with a GH_TOKEN ping once implemented.
}
`,
  },
};

const STARTERS: Record<string, StarterTemplate> = {
  "cron-trigger": cronTrigger,
  "claude-code": claudeCode,
  discord,
  github,
};

export function listStarters(): StarterTemplate[] {
  return Object.values(STARTERS);
}

export function getStarter(name: string): StarterTemplate | undefined {
  return STARTERS[name];
}
