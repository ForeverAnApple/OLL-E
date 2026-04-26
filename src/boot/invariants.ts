// Boot-time invariants for the assembled core tool set.
//
// The agent loop sends every registered ToolDef to the LLM provider on
// every turn (subject to the per-thread loaded set). Anything malformed
// blows up the entire chat surface — the bug we hit was two tools
// independently named `mail_list`, which Anthropic rejected with a 400
// "tool names must be unique" on every turn.
//
// These checks run before chat boots so the same class of structural
// breakage fails fast at startup with a clear pointer, not silently at
// every LLM round-trip. The same battery is callable from tests and (in
// principle) from a future agent that wants to validate a tool set
// before installing it.

import type { ToolDef } from "../extensions/types.ts";

export interface InvariantFailure {
  /** Stable identifier for the failing check (e.g. "duplicate-tool-name"). */
  code: string;
  /** Human-readable message ready to print or post to the inbox. */
  message: string;
  /** Tools or names involved, when applicable. Helpful for narrowing the
   *  failure to a specific registration site. */
  offenders?: string[];
}

export interface InvariantResult {
  ok: boolean;
  failures: InvariantFailure[];
}

const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/**
 * Validate the assembled core tool set. Returns every failure rather
 * than throwing on the first — boot-time output should name *all* the
 * structural issues in one shot so a fix lands once.
 */
export function checkCoreInvariants(tools: ToolDef[]): InvariantResult {
  const failures: InvariantFailure[] = [];

  // Duplicate names — the bug that motivated this module. Two tools with
  // the same name can come from independent registrations (e.g. core
  // bundles each adding their own `mail_list`). Provider rejects the
  // request before the agent gets a turn.
  const byName = new Map<string, number>();
  for (const t of tools) {
    byName.set(t.name, (byName.get(t.name) ?? 0) + 1);
  }
  const dupes = [...byName.entries()].filter(([, n]) => n > 1).map(([name]) => name);
  if (dupes.length > 0) {
    failures.push({
      code: "duplicate-tool-name",
      message: `core tool registry has duplicate names: ${dupes.join(", ")}`,
      offenders: dupes,
    });
  }

  for (const t of tools) {
    if (!TOOL_NAME_RE.test(t.name)) {
      failures.push({
        code: "invalid-tool-name",
        message: `tool name "${t.name}" doesn't match /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/ — provider may reject it`,
        offenders: [t.name],
      });
    }
    const schema = t.inputSchema as Record<string, unknown> | undefined;
    if (!schema || typeof schema !== "object") {
      failures.push({
        code: "missing-input-schema",
        message: `tool "${t.name}" has no inputSchema`,
        offenders: [t.name],
      });
      continue;
    }
    if (schema.type !== "object") {
      failures.push({
        code: "non-object-input-schema",
        message: `tool "${t.name}" inputSchema.type must be "object" (got ${JSON.stringify(schema.type)})`,
        offenders: [t.name],
      });
    }
    if (typeof t.description !== "string" || t.description.length === 0) {
      failures.push({
        code: "missing-description",
        message: `tool "${t.name}" has no description — providers may reject and the catalog has nothing to render`,
        offenders: [t.name],
      });
    }
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Render a single human-readable summary of an InvariantResult. Intended
 * for daemon stderr / inbox payload / test failure messages.
 */
export function formatFailures(result: InvariantResult): string {
  if (result.ok) return "core invariants: ok";
  const lines = ["core invariants failed:"];
  for (const f of result.failures) lines.push(`  [${f.code}] ${f.message}`);
  return lines.join("\n");
}
