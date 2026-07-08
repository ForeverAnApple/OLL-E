// Starter extension templates — shipped inside the binary as in-memory
// files. `install_starter` writes them to ~/.olle/extensions/<name>/ so
// the agent can iterate on them like any other extension (git-tracked,
// smoke-gated, hot-reloadable). No hardcoded features.
//
// Each starter lives in its own module under ./templates/; this barrel
// re-assembles them into the STARTERS map and keeps the public surface
// (listStarters, getStarter, StarterTemplate) stable.

import type { StarterTemplate } from "./templates/types.ts";
import { cronTrigger } from "./templates/cron-trigger.ts";
import { claudeCode } from "./templates/claude-code.ts";
import { discord } from "./templates/discord.ts";
import { discordCommunication } from "./templates/discord-communication.ts";
import { github } from "./templates/github.ts";

export type { StarterTemplate };

const STARTERS: Record<string, StarterTemplate> = {
  "cron-trigger": cronTrigger,
  "claude-code": claudeCode,
  discord,
  "discord-communication": discordCommunication,
  github,
};

export function listStarters(): StarterTemplate[] {
  return Object.values(STARTERS);
}

export function getStarter(name: string): StarterTemplate | undefined {
  return STARTERS[name];
}
