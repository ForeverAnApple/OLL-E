// Persistence for the host's selected default model. A single-line text
// file at `~/.olle/default_model` — one number to read, one number to
// write. Daemon reads on boot and on `model.set` events; CLI/chat both
// write through the `model.set` IPC. Absent file → caller-provided
// boot default.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ANTHROPIC_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL } from "../llm/index.ts";

/** The hard default if neither config nor explicit override sets one.
 *  Lives here rather than in src/llm/ so it stays an OLL-E policy
 *  choice, not a provider adapter's choice. Anthropic Opus is the v1
 *  pick — most OLL-E development happened against it and the prompts
 *  are tuned to its behavior. */
export const BOOT_DEFAULT_MODEL = ANTHROPIC_DEFAULT_MODEL;

/** Per-provider fallback when the desired default's provider has no
 *  key on disk. The router can't run a model whose adapter isn't
 *  loaded, so chat bringup picks one of these instead of refusing to
 *  start. Returns null if the provider name is unknown. */
export function fallbackForProvider(provider: "anthropic" | "openai"): string {
  return provider === "anthropic" ? ANTHROPIC_DEFAULT_MODEL : OPENAI_DEFAULT_MODEL;
}

export function readDefaultModel(file: string, fallback = BOOT_DEFAULT_MODEL): string {
  if (!existsSync(file)) return fallback;
  const raw = readFileSync(file, "utf8").trim();
  return raw.length > 0 ? raw : fallback;
}

export function writeDefaultModel(file: string, model: string): void {
  // 0600: the model name isn't a secret, but the rest of the OLL-E
  // root is per-user-private — match that posture.
  writeFileSync(file, model + "\n", { mode: 0o600 });
}
