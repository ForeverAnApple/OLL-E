// Loadout meta-tools: load_tools / unload_tools.
//
// Most tool schemas are deferred (not sent to the LLM each turn) to keep
// context lean. The agent reads the catalog (rendered into the system
// prompt) to know what exists, then calls load_tools to bring specific
// schemas into context. The schemas appear in the LLM's tool list on the
// next round-trip.
//
// These are built per-turn from chat.ts so they capture the per-thread
// loaded Set in closure. Both are alwaysLoaded — the agent can't pick
// up anything else without them.

import type { ToolDef } from "../extensions/types.ts";

export interface LoadoutDeps {
  /** The per-thread loaded set the tools mutate. */
  loadedTools: Set<string>;
  /** Full registered tool catalog (core + extensions). Used to resolve
   *  schemas and validate names. Called fresh each invocation so newly-
   *  registered extension tools appear without rebuilding. */
  allTools: () => ToolDef[];
}

interface LoadResultEntry {
  name: string;
  status: "loaded" | "already-loaded" | "unknown" | "always-loaded";
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface UnloadResultEntry {
  name: string;
  status: "unloaded" | "not-loaded" | "always-loaded";
}

export function buildLoadoutTools(deps: LoadoutDeps): ToolDef[] {
  const load: ToolDef<{ names: string[] }, { results: LoadResultEntry[] }> = {
    name: "load_tools",
    tier: "operational",
    category: "loadout",
    shortClause: "pull tool schemas into context for this thread",
    alwaysLoaded: true,
    description:
      "Bring deferred tools' schemas into your context for this thread. Pass a list of tool names from the catalog. The schemas are returned in the result so you can read them this turn; calls to those tools succeed starting next turn. Unknown names are reported per-tool without failing the call.",
    inputSchema: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
      },
      required: ["names"],
      additionalProperties: false,
    },
    execute: async ({ names }) => {
      const tools = deps.allTools();
      const byName = new Map(tools.map((t) => [t.name, t]));
      const results: LoadResultEntry[] = [];
      for (const name of names) {
        const t = byName.get(name);
        if (!t) {
          results.push({ name, status: "unknown" });
          continue;
        }
        if (t.alwaysLoaded) {
          // Already in every turn; loading is a no-op but worth surfacing
          // so the agent doesn't waste a load slot on it.
          results.push({
            name,
            status: "always-loaded",
            description: t.description,
            inputSchema: t.inputSchema,
          });
          continue;
        }
        if (deps.loadedTools.has(name)) {
          results.push({
            name,
            status: "already-loaded",
            description: t.description,
            inputSchema: t.inputSchema,
          });
          continue;
        }
        deps.loadedTools.add(name);
        results.push({
          name,
          status: "loaded",
          description: t.description,
          inputSchema: t.inputSchema,
        });
      }
      return { results };
    },
  };

  const unload: ToolDef<{ names: string[] }, { results: UnloadResultEntry[] }> = {
    name: "unload_tools",
    tier: "operational",
    category: "loadout",
    shortClause: "drop tool schemas to free context",
    alwaysLoaded: true,
    description:
      "Drop previously-loaded tool schemas from this thread's context. Mostly a politeness lever — useful when you're done with a heavy schema. Always-loaded core tools cannot be unloaded. Unknown / not-loaded names are reported per-tool without failing the call.",
    inputSchema: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
      },
      required: ["names"],
      additionalProperties: false,
    },
    execute: async ({ names }) => {
      const tools = deps.allTools();
      const byName = new Map(tools.map((t) => [t.name, t]));
      const results: UnloadResultEntry[] = [];
      for (const name of names) {
        const t = byName.get(name);
        if (t?.alwaysLoaded) {
          results.push({ name, status: "always-loaded" });
          continue;
        }
        if (!deps.loadedTools.has(name)) {
          results.push({ name, status: "not-loaded" });
          continue;
        }
        deps.loadedTools.delete(name);
        results.push({ name, status: "unloaded" });
      }
      return { results };
    },
  };

  return [load, unload];
}
