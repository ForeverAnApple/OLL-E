import type { StarterTemplate } from "./types.ts";

export const cronTrigger: StarterTemplate = {
  name: "cron-trigger",
  description: "Fires an event every N milliseconds. Declare the interval and event type in the manifest's `config`.",
  files: {
    "manifest.json": JSON.stringify(
      {
        name: "cron-trigger",
        version: "0.1.0",
        description: "Periodic event trigger. Configure intervalMs + eventType.",
        capabilities: ["trigger:cron"],
        eventWrites: ["cron.fire"],
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
let cronTimer: ReturnType<typeof setInterval> | null = null;

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
  if (cronTimer) clearInterval(cronTimer);
  cronTimer = setInterval(() => {
    ticks += 1;
    api.publish(eventType, { tick: ticks, at: Date.now() }, { durable: true });
  }, intervalMs);
}

export function unload() {
  if (cronTimer) clearInterval(cronTimer);
  cronTimer = null;
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
    "SETUP.md":
`# cron-trigger — setup

## What it does
Emits a durable event on a fixed interval. Nothing more. It is the raw
heartbeat other tasks subscribe to; it holds no cognition and reaches no
network.

If what you actually want is a scheduled *instruction* — a natural-language
job that posts a digest on a cron, say — use the built-in schedule_task
tool instead. This starter is the low-level primitive, not the standing-job
system.

## Secrets
None. This starter never leaves the host.

## Config knobs (manifest.json, config object)
- intervalMs — milliseconds between fires. Default 60000 (one minute).
- eventType — the event type published on each tick. Default cron.fire.

One extension instance fires one interval. Need a second rate? Install a
second copy under a new name (e.g. cron-hourly) and edit its config.

## Install script (narrate this to the human)
No secret to collect. Just:

    install_starter("cron-trigger")
    # optionally edit manifest.json config.intervalMs / config.eventType
    register_extension("cron-trigger")

Registration arms the timer immediately.

## Guardrails
- A very small intervalMs floods the bus. Keep it >= 1000 unless you know
  why you want faster.
- Nothing consumes cron.fire until you write a task that subscribes to it.
  Firing into the void is harmless but pointless.
`,
  },
};
