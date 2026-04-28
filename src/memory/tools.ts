// Memory tools — the agent-facing surface for identity-writes and reads.
//
// These are core-bundle tools (not extensions). Every agent has them in its
// kit. The tools emit `memory.*` events via the bus; the projector folds
// those events into the `memories` table synchronously (LOG 2026-04-23).
//
// Scope enforcement:
//  - private: reads/writes require ctx.actorId == row.actor_id (strictly
//    solo per LOG 2026-04-23 — no ancestor peek; parents ask, or the
//    child promotes to team).
//  - team:    reads require membership in the team; writes require
//    ctx.actorId == row.actor_id (you can only speak for yourself).
//  - scratch: reads/writes require ctx.actorId == row.actor_id.
//
// Writes via these tools always set actor_id = ctx.actorId. The only
// blessed case of writing on behalf of another actor is cultural pass-on
// at spawn — which goes through the manager directly, not through these
// tools.

import { and, desc, eq, inArray, like, or } from "drizzle-orm";
import type { EventBus } from "../bus/index.ts";
import type { Store } from "../store/db.ts";
import type { ToolDef } from "../extensions/types.ts";
import { tables } from "../store/index.ts";
import { ulid } from "../id/index.ts";
import {
  MEMORY_FORGOTTEN,
  MEMORY_READ,
  MEMORY_WROTE,
  defaultDepthForRole,
  type MemoryScope,
} from "./events.ts";

export interface MemoryToolsOptions {
  bus: EventBus;
  store: Store;
  hostId: string;
}

interface WriteArgs {
  title: string;
  bodyMd: string;
  role?: string;
  scope?: MemoryScope;
  scopeRef?: string;
  tags?: string[];
  depth?: number;
  /** When set, target an existing memory by id (update). Caller must
   *  own the target (actor_id == ctx.actorId). */
  updates?: string;
}

interface WriteResult {
  id: string;
  scope: MemoryScope;
  role: string;
  depth: number;
  updated: boolean;
}

interface ReadArgs {
  id: string;
}

interface ReadResult {
  id: string;
  title: string;
  bodyMd: string;
  role: string;
  scope: MemoryScope;
  depth: number;
  tags: string[];
  actorId: string;
  authoredBy: string | null;
  seededFrom: string | null;
  updatedAt: number;
}

interface SearchArgs {
  query?: string;
  role?: string;
  scope?: MemoryScope;
  actor?: string;
  limit?: number;
}

interface SearchHit {
  id: string;
  title: string;
  role: string;
  scope: MemoryScope;
  depth: number;
  actorId: string;
  updatedAt: number;
  snippet: string;
}

interface PromoteArgs {
  id: string;
  teamId: string;
}

interface ForgetArgs {
  id: string;
}

export function buildMemoryTools(opts: MemoryToolsOptions): ToolDef[] {
  const { bus, store, hostId } = opts;

  function loadMemory(id: string): {
    id: string;
    actorId: string;
    scope: MemoryScope;
    scopeRef: string | null;
    role: string;
    title: string;
    bodyMd: string;
    tags: string[];
    depth: number;
    authoredBy: string | null;
    seededFrom: string | null;
    updatedAt: number;
  } | null {
    const row = store.select().from(tables.memories).where(eq(tables.memories.id, id)).all()[0];
    if (!row) return null;
    return {
      id: row.id,
      actorId: row.actorId,
      scope: row.scope as MemoryScope,
      scopeRef: row.scopeRef ?? null,
      role: row.role,
      title: row.title,
      bodyMd: row.bodyMd,
      tags: row.tags as string[],
      depth: row.depth,
      authoredBy: row.authoredBy ?? null,
      seededFrom: row.seededFrom ?? null,
      updatedAt: row.updatedAt,
    };
  }

  function isTeamMember(teamId: string, actorId: string): boolean {
    const row = store
      .select({ actorId: tables.teamMembers.actorId })
      .from(tables.teamMembers)
      .where(and(eq(tables.teamMembers.teamId, teamId), eq(tables.teamMembers.actorId, actorId)))
      .all()[0];
    return !!row;
  }

  /** Gate a read against scope rules. Returns the authoritative reason
   *  string when denied; null when allowed. */
  function reasonReadDenied(
    row: { actorId: string; scope: MemoryScope; scopeRef: string | null },
    caller: string,
  ): string | null {
    if (row.scope === "private") {
      return row.actorId === caller ? null : "private memory — caller is not the owner";
    }
    if (row.scope === "team") {
      if (row.actorId === caller) return null;
      if (!row.scopeRef) return "team memory missing team id";
      return isTeamMember(row.scopeRef, caller) ? null : "team memory — caller not in team";
    }
    if (row.scope === "scratch") {
      return row.actorId === caller ? null : "scratch memory — caller is not the owner";
    }
    return `unknown scope: ${row.scope}`;
  }

  const write: ToolDef<WriteArgs, WriteResult> = {
    name: "memory_write",
    tier: "operational",
    category: "memory",
    shortClause: "record or update a memory (private/team/scratch)",
    // The write half of `memory_search` belongs in the always-loaded
    // core: bootstrap-interview turns and any turn that learns something
    // worth remembering would otherwise spend a `load_tools` round-trip
    // before recording. Cheap to carry, paid for on first soul-seeding
    // turn alone (LOG 2026-04-28).
    alwaysLoaded: true,
    description:
      "Write or update a memory. Memory is your persistent self across time — preferences, principles, goals, skills, knowledge. Role tags the posture: `principle` memories are your strict commitments (they're injected into every turn and passed to any child you spawn), `goal` is an in-flight intention, `skill`/`knowledge` is how-you-do-things. Default depth weights the belief under the resistance model: principles default to 10 (strict), other roles to 1 (lived). Scope: `private` (yours only) / `team` (shared with a team) / `scratch` (task-ephemeral). Pass `updates: <id>` to edit an existing memory you own.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        bodyMd: { type: "string" },
        role: {
          type: "string",
          description:
            "Posture tag — principle / goal / preference / skill / knowledge / ... Free-form; coin your own when it helps.",
        },
        scope: {
          type: "string",
          enum: ["private", "team", "scratch"],
          description: "Default private.",
        },
        scopeRef: {
          type: "string",
          description:
            "Scope-dependent anchor. For team, the team id (required). For scratch, the task_run id. Omit for private (you are the anchor).",
        },
        tags: { type: "array", items: { type: "string" } },
        depth: {
          type: "number",
          description:
            "Override the role's default depth. Higher = more weight / harder to update under the resistance model.",
        },
        updates: {
          type: "string",
          description: "Existing memory id to update. You must own it.",
        },
      },
      required: ["title", "bodyMd"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      // Validate at the boundary — the LLM may send malformed args
      // (omitted fields, snake_case, empty strings). Without this,
      // the publish goes through and the projector crashes on NOT NULL,
      // returning a "successful" id the agent can never read back.
      if (typeof args.title !== "string" || args.title.length === 0) {
        throw new Error("memory_write: title is required and must be a non-empty string");
      }
      if (typeof args.bodyMd !== "string" || args.bodyMd.length === 0) {
        throw new Error("memory_write: bodyMd is required and must be a non-empty string");
      }

      const role = args.role ?? "";
      const scope: MemoryScope = args.scope ?? "private";
      const tags = args.tags ?? [];
      const depth = Number.isFinite(args.depth)
        ? (args.depth as number)
        : defaultDepthForRole(role);

      let id = args.updates;
      let updated = false;
      let scopeRef = args.scopeRef ?? null;
      // Lineage attribution survives self-edits: when a child updates
      // a seeded principle, the seeded_from / authored_by fields must
      // travel forward, otherwise the next projection nulls them and
      // the parent-trace is gone forever. New writes (no `updates`)
      // start fresh — null on both fields. (Pass-on at spawn writes
      // these directly through the manager, not through this tool.)
      let authoredBy: string | null | undefined;
      let seededFrom: string | null | undefined;

      if (id) {
        const existing = loadMemory(id);
        if (!existing) throw new Error(`memory_write: updates target ${id} not found`);
        if (existing.actorId !== ctx.actorId) {
          throw new Error(
            `memory_write: cannot update ${id} — owner is ${existing.actorId}, not ${ctx.actorId}`,
          );
        }
        updated = true;
        // Inherit the existing scope_ref when not explicitly re-set.
        if (!scopeRef) scopeRef = existing.scopeRef;
        authoredBy = existing.authoredBy;
        seededFrom = existing.seededFrom;
      } else {
        id = ulid();
      }

      if (scope === "team" && !scopeRef) {
        throw new Error("memory_write: scope=team requires scopeRef (team id)");
      }
      if (scope === "scratch" && !scopeRef) {
        throw new Error("memory_write: scope=scratch requires scopeRef (task_run id)");
      }
      if (scope === "private" && !scopeRef) {
        scopeRef = ctx.actorId;
      }

      bus.publish({
        type: MEMORY_WROTE,
        hostId,
        actorId: ctx.actorId,
        durable: true,
        payload: {
          id,
          actorId: ctx.actorId,
          scope,
          scopeRef,
          role,
          title: args.title,
          bodyMd: args.bodyMd,
          tags,
          depth,
          authoredBy,
          seededFrom,
        },
      });

      return { id, scope, role, depth, updated };
    },
  };

  const read: ToolDef<ReadArgs, ReadResult> = {
    name: "memory_read",
    tier: "operational",
    category: "memory",
    shortClause: "read one memory by id (audited)",
    description:
      "Read a memory by id. Emits an audit event (memory.read) so who-read-what-when is traceable. Scope-gated: you can only read your own private memories; team memories require team membership; scratch is owner-only.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const row = loadMemory(args.id);
      if (!row) throw new Error(`memory_read: ${args.id} not found`);
      const denied = reasonReadDenied(row, ctx.actorId);
      if (denied) throw new Error(`memory_read: ${denied}`);
      bus.publish({
        type: MEMORY_READ,
        hostId,
        actorId: ctx.actorId,
        durable: true,
        payload: { id: row.id, readerActorId: ctx.actorId },
      });
      return {
        id: row.id,
        title: row.title,
        bodyMd: row.bodyMd,
        role: row.role,
        scope: row.scope,
        depth: row.depth,
        tags: row.tags,
        actorId: row.actorId,
        authoredBy: row.authoredBy,
        seededFrom: row.seededFrom,
        updatedAt: row.updatedAt,
      };
    },
  };

  const search: ToolDef<SearchArgs, SearchHit[]> = {
    name: "memory_search",
    tier: "operational",
    category: "memory",
    shortClause: "find what you've remembered",
    alwaysLoaded: true,
    description:
      "Search your own memories (plus any team memories you have membership for). LIKE match over title and body. Filter by role (principle/goal/...), scope (private/team/scratch), or a specific actor. Default scope: private + team-you-belong-to. Empty query = recent memories by role/scope filter.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        role: { type: "string" },
        scope: { type: "string", enum: ["private", "team", "scratch"] },
        actor: { type: "string", description: "Filter to a specific actor id." },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const limit = Math.max(1, Math.min(args.limit ?? 20, 100));

      // Caller's accessible team ids — needed so the SQL scope filter
      // doesn't have to fall back to a JS-side membership check.
      const teamIds = store
        .select({ teamId: tables.teamMembers.teamId })
        .from(tables.teamMembers)
        .where(eq(tables.teamMembers.actorId, ctx.actorId))
        .all()
        .map((r) => r.teamId);

      // Scope visibility: own private + own scratch + own team writes +
      // any team the caller belongs to. Encoded as a SQL OR so the
      // database returns only readable rows.
      const ownAll = eq(tables.memories.actorId, ctx.actorId);
      const teamVisible = teamIds.length
        ? and(eq(tables.memories.scope, "team"), inArray(tables.memories.scopeRef, teamIds))!
        : null;
      const visibility = teamVisible ? or(ownAll, teamVisible)! : ownAll;

      const parts = [visibility];
      if (args.query) {
        const q = `%${args.query}%`;
        parts.push(or(like(tables.memories.title, q), like(tables.memories.bodyMd, q))!);
      }
      if (args.role) parts.push(eq(tables.memories.role, args.role));
      if (args.scope) parts.push(eq(tables.memories.scope, args.scope));
      if (args.actor) parts.push(eq(tables.memories.actorId, args.actor));

      const rows = store
        .select()
        .from(tables.memories)
        .where(and(...parts))
        .orderBy(desc(tables.memories.updatedAt))
        .limit(limit)
        .all();

      return rows.map<SearchHit>((row) => ({
        id: row.id,
        title: row.title,
        role: row.role,
        scope: row.scope as MemoryScope,
        depth: row.depth,
        actorId: row.actorId,
        updatedAt: row.updatedAt,
        snippet: row.bodyMd.length > 240 ? row.bodyMd.slice(0, 240) + "…" : row.bodyMd,
      }));
    },
  };

  const promote: ToolDef<PromoteArgs, { id: string; scope: "team"; teamId: string }> = {
    name: "memory_promote",
    category: "memory",
    shortClause: "promote a private memory to team scope",
    tier: "operational",
    description:
      "Promote a private memory you own to team-scope. The memory keeps its id; a new memory.wrote event lands with scope=team and the given teamId. Team members can read from that point on. Promotion is operational (no ask-up needed); demotion is not a v0 operation.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        teamId: { type: "string" },
      },
      required: ["id", "teamId"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const existing = loadMemory(args.id);
      if (!existing) throw new Error(`memory_promote: ${args.id} not found`);
      if (existing.actorId !== ctx.actorId) {
        throw new Error(`memory_promote: you do not own ${args.id}`);
      }
      if (existing.scope !== "private") {
        throw new Error(
          `memory_promote: only private memories can be promoted (this one is ${existing.scope})`,
        );
      }
      if (!isTeamMember(args.teamId, ctx.actorId)) {
        throw new Error(`memory_promote: you are not a member of team ${args.teamId}`);
      }
      bus.publish({
        type: MEMORY_WROTE,
        hostId,
        actorId: ctx.actorId,
        durable: true,
        payload: {
          id: existing.id,
          actorId: ctx.actorId,
          scope: "team",
          scopeRef: args.teamId,
          role: existing.role,
          title: existing.title,
          bodyMd: existing.bodyMd,
          tags: existing.tags,
          depth: existing.depth,
          authoredBy: existing.authoredBy,
          seededFrom: existing.seededFrom,
        },
      });
      return { id: existing.id, scope: "team", teamId: args.teamId };
    },
  };

  const forget: ToolDef<ForgetArgs, { id: string; forgotten: true }> = {
    name: "memory_forget",
    category: "memory",
    shortClause: "tombstone one of your own memories",
    tier: "operational",
    description:
      "Tombstone a memory you own. Emits memory.forgotten; the row is removed on projection. Audit (memory_reads) survives the forget. v0 does not gate forgetting on depth — the resistance model currently governs update-difficulty, not retirement-difficulty.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const existing = loadMemory(args.id);
      if (!existing) throw new Error(`memory_forget: ${args.id} not found`);
      if (existing.actorId !== ctx.actorId) {
        throw new Error(`memory_forget: you do not own ${args.id}`);
      }
      bus.publish({
        type: MEMORY_FORGOTTEN,
        hostId,
        actorId: ctx.actorId,
        durable: true,
        payload: { id: existing.id },
      });
      return { id: existing.id, forgotten: true };
    },
  };

  interface LineageArgs {
    /** Filter to a specific posture. Default: `principle`. */
    role?: string;
    /** Max hops up the parent chain. Default: unlimited. */
    depth?: number;
    /** Stop at (and include) this many matching memories. Default 50. */
    limit?: number;
  }

  interface LineageHit {
    id: string;
    actorId: string;
    hopsFromCaller: number;
    role: string;
    title: string;
    bodyMd: string;
    depth: number;
  }

  const lineage: ToolDef<LineageArgs, LineageHit[]> = {
    name: "memory_lineage",
    category: "memory",
    shortClause: "walk ancestor memories (live, post-spawn)",
    tier: "operational",
    description:
      "Walk up your parent chain and surface ancestors' live memories for a given role (default: principle). This is the 'passive read access to the parent's ongoing culture' half of the pass-on model — seed principles are copied into your private memory at birth, but ancestors keep writing, and this tool lets you see what they're currently committed to. Read-only; emits memory.read per hit for audit. Respects strictly-solo private — ancestors' private memories are NEVER returned; only memories they've promoted to team (where you're a fellow member) appear. Use when you're weighing evidence you received against what the lineage holds; use memory_search first if you want to check your own seeded copies.",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", description: "Posture filter; default `principle`." },
        depth: {
          type: "number",
          description: "Max hops up the parent chain (ancestors). Omit for unlimited.",
        },
        limit: { type: "number", description: "Max matching memories returned. Default 50." },
      },
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const role = args.role ?? "principle";
      const limit = Math.max(1, Math.min(args.limit ?? 50, 200));
      const maxHops =
        args.depth != null && Number.isFinite(args.depth) ? Math.max(0, Math.floor(args.depth)) : Infinity;

      // Walk up parent_agent_id from the caller. Guard against cycles
      // (shouldn't happen — agents row parent_agent_id is immutable at
      // spawn — but cheap to enforce).
      const ancestors: Array<{ id: string; hops: number }> = [];
      const seen = new Set<string>([ctx.actorId]);
      let cursor: string | null = ctx.actorId;
      let hops = 0;
      while (cursor && hops < maxHops) {
        const row: { parent: string | null } | undefined = store
          .select({ parent: tables.agents.parentAgentId })
          .from(tables.agents)
          .where(eq(tables.agents.id, cursor))
          .all()[0];
        if (!row || !row.parent) break;
        if (seen.has(row.parent)) break;
        seen.add(row.parent);
        hops += 1;
        ancestors.push({ id: row.parent, hops });
        cursor = row.parent;
      }
      if (ancestors.length === 0) return [];

      // Single fetch across the precomputed ancestor chain; ordering is
      // restored in JS by walking ancestors in hops-ascending order and
      // depth-descending within each. Private/scratch are filtered post-fetch
      // because the ancestor's scope_ref column doesn't carry membership.
      const hopsByActor = new Map(ancestors.map((a) => [a.id, a.hops] as const));
      const ancestorIds = ancestors.map((a) => a.id);
      const rows = store
        .select()
        .from(tables.memories)
        .where(and(inArray(tables.memories.actorId, ancestorIds), eq(tables.memories.role, role)))
        .orderBy(desc(tables.memories.depth))
        .all();

      const byActor = new Map<string, typeof rows>();
      for (const row of rows) {
        const list = byActor.get(row.actorId) ?? [];
        list.push(row);
        byActor.set(row.actorId, list);
      }

      const hits: LineageHit[] = [];
      for (const anc of ancestors) {
        if (hits.length >= limit) break;
        const ancRows = byActor.get(anc.id);
        if (!ancRows) continue;
        for (const row of ancRows) {
          if (hits.length >= limit) break;
          const scope = row.scope as MemoryScope;
          if (scope === "private") continue;
          if (scope === "scratch") continue;
          if (scope === "team") {
            if (!row.scopeRef) continue;
            if (!isTeamMember(row.scopeRef, ctx.actorId)) continue;
          }
          hits.push({
            id: row.id,
            actorId: row.actorId,
            hopsFromCaller: hopsByActor.get(row.actorId)!,
            role: row.role,
            title: row.title,
            bodyMd: row.bodyMd,
            depth: row.depth,
          });
        }
      }

      // Audit events fire after the fetch, in the same hops-then-depth
      // order callers see in the result.
      for (const hit of hits) {
        bus.publish({
          type: MEMORY_READ,
          hostId,
          actorId: ctx.actorId,
          durable: true,
          payload: { id: hit.id, readerActorId: ctx.actorId },
        });
      }
      return hits;
    },
  };

  return [write, read, search, promote, forget, lineage];
}
