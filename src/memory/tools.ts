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

import { and, desc, eq, like, or } from "drizzle-orm";
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
      const role = args.role ?? "";
      const scope: MemoryScope = args.scope ?? "private";
      const tags = args.tags ?? [];
      const depth = Number.isFinite(args.depth)
        ? (args.depth as number)
        : defaultDepthForRole(role);

      let id = args.updates;
      let updated = false;
      let scopeRef = args.scopeRef ?? null;

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
      } else {
        id = ulid();
      }

      if (scope === "team" && !scopeRef) {
        throw new Error("memory_write: scope=team requires scopeRef (team id)");
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
          scopeRef: scopeRef ?? undefined,
          role,
          title: args.title,
          bodyMd: args.bodyMd,
          tags,
          depth,
        },
      });

      return { id, scope, role, depth, updated };
    },
  };

  const read: ToolDef<ReadArgs, ReadResult> = {
    name: "memory_read",
    tier: "operational",
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
      const parts = [];
      if (args.query) {
        const q = `%${args.query}%`;
        parts.push(or(like(tables.memories.title, q), like(tables.memories.bodyMd, q))!);
      }
      if (args.role) parts.push(eq(tables.memories.role, args.role));
      if (args.scope) parts.push(eq(tables.memories.scope, args.scope));
      if (args.actor) parts.push(eq(tables.memories.actorId, args.actor));
      const where = parts.length ? and(...parts) : undefined;
      const rows = where
        ? store
            .select()
            .from(tables.memories)
            .where(where)
            .orderBy(desc(tables.memories.updatedAt))
            .limit(limit * 3) // over-fetch; scope filter may prune heavily
            .all()
        : store
            .select()
            .from(tables.memories)
            .orderBy(desc(tables.memories.updatedAt))
            .limit(limit * 3)
            .all();
      const hits: SearchHit[] = [];
      for (const row of rows) {
        if (hits.length >= limit) break;
        const scope = row.scope as MemoryScope;
        const denied = reasonReadDenied(
          { actorId: row.actorId, scope, scopeRef: row.scopeRef ?? null },
          ctx.actorId,
        );
        if (denied) continue;
        hits.push({
          id: row.id,
          title: row.title,
          role: row.role,
          scope,
          depth: row.depth,
          actorId: row.actorId,
          updatedAt: row.updatedAt,
          snippet: row.bodyMd.length > 240 ? row.bodyMd.slice(0, 240) + "…" : row.bodyMd,
        });
      }
      return hits;
    },
  };

  const promote: ToolDef<PromoteArgs, { id: string; scope: "team"; teamId: string }> = {
    name: "memory_promote",
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
          authoredBy: existing.authoredBy ?? undefined,
          seededFrom: existing.seededFrom ?? undefined,
        },
      });
      return { id: existing.id, scope: "team", teamId: args.teamId };
    },
  };

  const forget: ToolDef<ForgetArgs, { id: string; forgotten: true }> = {
    name: "memory_forget",
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

  return [write, read, search, promote, forget];
}
