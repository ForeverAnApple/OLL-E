// Tool catalog — the agent's identity-level tool surface.
//
// Most tool schemas are deferred (not sent to the LLM each turn) to keep
// context lean. The catalog is the always-on "you have these capabilities"
// surface: name + short clause grouped under purposive category prose.
// Reading the catalog tells the agent what to load; loading is what brings
// the schema into context.
//
// The catalog is a pure function of the registered tool set — no per-thread
// state, no `[LOADED]` markers. Mutating per-thread state would invalidate
// the catalog's place in the cached identity segment of the system prompt.
// "What schemas are loaded right now" is encoded by the tools block itself
// (which the LLM provider caches separately), not by this catalog text.

import type { ToolDef } from "../extensions/types.ts";

/** Default category for tools that don't declare one. Rendered last. */
const MISC = "misc";

/** Category-level prose shown before the tool list within each category.
 *  Purposive: "when to reach for these," not structural. */
const CATEGORY_PROSE: Record<string, { tagline: string; body: string }> = {
  loadout: {
    tagline: "your equipped tools",
    body:
      "Pull schemas into your context for this thread, or set them down\n" +
      "when done. The catalog below tells you what exists; loading is\n" +
      "what brings the schema in. One extra turn per load.",
  },
  observability: {
    tagline: "knowing what's happening to you and around you",
    body:
      "Inspect your own ledger, recent runs, threads, budget posture, and\n" +
      "event history. Reach here when something feels off (\"am I spending\n" +
      "more than usual?\"), when orienting at the start of a strategic turn,\n" +
      "or before a parent asks you for status.",
  },
  memory: {
    tagline: "your persistent self",
    body:
      "Memory is identity. Reach here to recall what you've remembered\n" +
      "before, to record something worth keeping, or to inspect the lineage\n" +
      "of a belief. Most turns you only need to search; writes and lineage\n" +
      "queries are rarer.",
  },
  delegation: {
    tagline: "calling reinforcements",
    body:
      "Hire children for work that shouldn't block this conversation, or\n" +
      "redirect inbound mail when a different agent should handle a thread.\n" +
      "Use spawning when work spans multiple turns; use retargeting when\n" +
      "another mailbox is the right destination going forward.",
  },
  mailbox: {
    tagline: "what's waiting for you",
    body:
      "The per-turn sidebar shows threads you've already touched. Reach\n" +
      "here for durable mail from threads you haven't ingested yet — a\n" +
      "spawned child's progress, a cron task's output, peer messages.",
  },
  "extension authoring": {
    tagline: "growing your habitat",
    body:
      "Write, inspect, register, smoke-test, and revert extensions. OLL-E\n" +
      "is yours to reshape: when you need a capability the world doesn't\n" +
      "have yet, author it through this loop. Read existing files before\n" +
      "guessing at error strings; smoke before registering; revert when\n" +
      "an edit breaks load.",
  },
  secrets: {
    tagline: "credentials your extensions need",
    body:
      "Store, list, or remove host-scoped secrets (API tokens, etc.).\n" +
      "Extensions declare what they need in their manifest; you set the\n" +
      "value once and it's injected at load. Values are redacted from\n" +
      "audit events and persisted messages.",
  },
  "host context": {
    tagline: "live state of your machine",
    body:
      "Inspect the actual cwd, PATH, executable availability, and loaded\n" +
      "extensions. Use before filesystem or subprocess work — knowing\n" +
      "beats guessing at error strings.",
  },
  team: {
    tagline: "cell-to-cell federation",
    body:
      "Teams are peer cells negotiating around a shared goal. Use\n" +
      "`team_create` to start a new shared identity rooted on this host,\n" +
      "`team_invite` to mint a bearer code another host can redeem,\n" +
      "`team_join` to accept a code, and `team_leave` to drop out.\n" +
      "`team_status` is the read-only roster. Strategic tier on create/\n" +
      "invite/join — entering or expanding a trust relationship.",
  },
  scratch: {
    tagline: "task-ephemeral working files",
    body:
      "Scratch is your throwaway workspace within a task — files live until\n" +
      "the task completes or times out. Use for intermediate artifacts,\n" +
      "draft documents, in-progress generations.",
  },
  "tool results": {
    tagline: "fetching spilled tool output",
    body:
      "Tool calls that return more than the inline byte cap get spilled\n" +
      "to durable storage and replaced in your message history with a\n" +
      "preview + handle. Reach here to fetch the rest on demand — slice\n" +
      "with offset/limit so you only pay for the bytes you need.",
  },
  [MISC]: {
    tagline: "uncategorized",
    body: "Tools that didn't declare a category. Treat each on its own merits.",
  },
};

/** Default category prose used when a category appears in the registered
 *  tool set but isn't in CATEGORY_PROSE — typically extension-contributed
 *  categories the core hasn't been taught about yet. */
const DEFAULT_CATEGORY: { tagline: string; body: string } = {
  tagline: "tools contributed by extensions",
  body:
    "Capabilities authored by an extension. Read each tool's name +\n" +
    "clause; load the schemas you need.",
};

/** Render the catalog as a markdown block suitable for the stable
 *  segment of the system prompt. Pure function of the registered tool
 *  set — calling it again with the same tools returns identical text. */
export function renderToolCatalog(tools: ToolDef[]): string {
  const grouped = groupByCategory(tools);
  const ordered = orderedCategories(grouped);
  const parts: string[] = [];
  parts.push("## Available tools");
  parts.push(
    "Tools below are organized by category. Schemas you carry this turn\n" +
      "are in your tool list above. To pick up another, call\n" +
      '`load_tools(["name", ...])`; its schema appears on the next turn.\n' +
      "Unload with `unload_tools` when done.",
  );
  for (const category of ordered) {
    const prose = CATEGORY_PROSE[category] ?? DEFAULT_CATEGORY;
    parts.push(`### ${category} — ${prose.tagline}\n${prose.body}\n`);
    const lines: string[] = [];
    const members = grouped.get(category)!;
    for (const t of members) {
      lines.push(`  - ${t.name} — ${clauseFor(t)}`);
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

function groupByCategory(tools: ToolDef[]): Map<string, ToolDef[]> {
  const out = new Map<string, ToolDef[]>();
  // Stable name-sort within each category for deterministic output.
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  for (const t of sorted) {
    const cat = t.category || MISC;
    let list = out.get(cat);
    if (!list) {
      list = [];
      out.set(cat, list);
    }
    list.push(t);
  }
  return out;
}

function orderedCategories(grouped: Map<string, ToolDef[]>): string[] {
  // Known categories first (in insertion order from CATEGORY_PROSE), then
  // any unknown extension-contributed categories alphabetically, then
  // misc at the very end.
  const known = Object.keys(CATEGORY_PROSE).filter((c) => c !== MISC);
  const present = new Set(grouped.keys());
  const out: string[] = [];
  for (const c of known) {
    if (present.has(c)) {
      out.push(c);
      present.delete(c);
    }
  }
  const extras = [...present].filter((c) => c !== MISC).sort();
  out.push(...extras);
  if (grouped.has(MISC)) out.push(MISC);
  return out;
}

function clauseFor(t: ToolDef): string {
  if (t.shortClause) return t.shortClause;
  // Fall back to the description, truncated. Keeps catalog entries tight
  // when a tool author hasn't written a purposive clause.
  const desc = t.description ?? "";
  if (desc.length <= 80) return desc;
  return desc.slice(0, 77).trimEnd() + "...";
}
