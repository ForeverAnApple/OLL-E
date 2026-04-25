// Memory surface — projector, tools, scope enforcement, principle
// injection.

import { describe, expect, it } from "bun:test";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid, encodeStamp } from "../src/id/index.ts";
import {
  MEMORY_FORGOTTEN,
  MEMORY_WROTE,
  buildMemoryTools,
  loadPrinciples,
  renderPrinciples,
  startMemoryProjector,
} from "../src/memory/index.ts";
import { startAgentLoop } from "../src/agent/chat.ts";
import type { Completion, CompletionRequest, Llm } from "../src/llm/types.ts";

function rig() {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  return { store, bus, hostId };
}

function makeCtx(actorId: string, hostId: string) {
  return {
    hostId,
    extensionId: actorId,
    actorId,
    abort: new AbortController().signal,
    secrets: {},
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseTool = { name: string; execute: (args: any, ctx: any) => Promise<any> };
function getTool(tools: ReturnType<typeof buildMemoryTools>, name: string): LooseTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool missing: ${name}`);
  return t as unknown as LooseTool;
}

describe("memory projector", () => {
  it("upserts memory.wrote into the memories table with event HLC", () => {
    const r = rig();
    const proj = startMemoryProjector({ bus: r.bus, store: r.store, hostId: r.hostId });
    const id = ulid();
    r.bus.publish({
      type: MEMORY_WROTE,
      hostId: r.hostId,
      actorId: "a",
      durable: true,
      payload: {
        id,
        actorId: "a",
        scope: "private",
        scopeRef: "a",
        role: "principle",
        title: "honest",
        bodyMd: "always",
        tags: [],
        depth: 10,
      },
    });
    const row = r.store.raw.query("SELECT * FROM memories WHERE id = ?").get(id) as
      | { hlc: string; title: string; depth: number; role: string }
      | null;
    expect(row).not.toBeNull();
    expect(row?.title).toBe("honest");
    expect(row?.depth).toBe(10);
    expect(row?.role).toBe("principle");
    proj.stop();
  });

  it("applies LWW on HLC — later write wins, earlier write is dropped", () => {
    const r = rig();
    const proj = startMemoryProjector({ bus: r.bus, store: r.store, hostId: r.hostId });
    const id = ulid();
    // First write (earlier HLC by publish order)
    r.bus.publish({
      type: MEMORY_WROTE,
      hostId: r.hostId,
      actorId: "a",
      durable: true,
      payload: {
        id,
        actorId: "a",
        scope: "private",
        scopeRef: "a",
        role: "principle",
        title: "v1",
        bodyMd: "old",
        tags: [],
        depth: 1,
      },
    });
    // Second write (later HLC)
    r.bus.publish({
      type: MEMORY_WROTE,
      hostId: r.hostId,
      actorId: "a",
      durable: true,
      payload: {
        id,
        actorId: "a",
        scope: "private",
        scopeRef: "a",
        role: "principle",
        title: "v2",
        bodyMd: "new",
        tags: [],
        depth: 1,
      },
    });
    const row = r.store.raw.query("SELECT title FROM memories WHERE id = ?").get(id) as {
      title: string;
    };
    expect(row.title).toBe("v2");
    proj.stop();
  });

  it("tombstone deletes the row; a later write resurrects", () => {
    const r = rig();
    const proj = startMemoryProjector({ bus: r.bus, store: r.store, hostId: r.hostId });
    const id = ulid();
    r.bus.publish({
      type: MEMORY_WROTE,
      hostId: r.hostId,
      actorId: "a",
      durable: true,
      payload: {
        id,
        actorId: "a",
        scope: "private",
        scopeRef: "a",
        role: "knowledge",
        title: "x",
        bodyMd: "y",
        tags: [],
        depth: 1,
      },
    });
    r.bus.publish({
      type: MEMORY_FORGOTTEN,
      hostId: r.hostId,
      actorId: "a",
      durable: true,
      payload: { id },
    });
    let row = r.store.raw.query("SELECT id FROM memories WHERE id = ?").get(id);
    expect(row).toBeNull();
    r.bus.publish({
      type: MEMORY_WROTE,
      hostId: r.hostId,
      actorId: "a",
      durable: true,
      payload: {
        id,
        actorId: "a",
        scope: "private",
        scopeRef: "a",
        role: "knowledge",
        title: "resurrected",
        bodyMd: "z",
        tags: [],
        depth: 1,
      },
    });
    row = r.store.raw.query("SELECT title FROM memories WHERE id = ?").get(id) as {
      title: string;
    } | null;
    expect(row).not.toBeNull();
    expect((row as { title: string }).title).toBe("resurrected");
    proj.stop();
  });

  it("drops stale-HLC writes — incoming event with HLC <= existing row's is ignored", () => {
    const r = rig();
    const proj = startMemoryProjector({ bus: r.bus, store: r.store, hostId: r.hostId });
    const id = ulid();
    // Forge a row with a maximum-future HLC. Any real bus event will
    // necessarily have a smaller HLC; the projector must drop it.
    const futureHlc = encodeStamp({ l: 0xffffffffffff, c: 0xffff });
    r.store.raw
      .prepare(
        `INSERT INTO memories (
           id, hlc, host_id, actor_id, scope, scope_ref, role, depth,
           authored_by, seeded_from, title, body_md, tags,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        futureHlc,
        r.hostId,
        "a",
        "private",
        "a",
        "principle",
        99,
        null,
        null,
        "from-the-future",
        "winner",
        "[]",
        Date.now(),
        Date.now(),
      );
    // Now publish a real wrote event. Its HLC is in the present; the
    // projector should compare and drop the update.
    r.bus.publish({
      type: MEMORY_WROTE,
      hostId: r.hostId,
      actorId: "a",
      durable: true,
      payload: {
        id,
        actorId: "a",
        scope: "private",
        scopeRef: "a",
        role: "principle",
        title: "stale-loser",
        bodyMd: "should-not-overwrite",
        tags: [],
        depth: 1,
      },
    });
    const row = r.store.raw.query("SELECT title, depth FROM memories WHERE id = ?").get(id) as {
      title: string;
      depth: number;
    };
    expect(row.title).toBe("from-the-future");
    expect(row.depth).toBe(99);
    proj.stop();
  });

  it("drops stale tombstones — forgotten event with HLC <= existing row's is ignored", () => {
    const r = rig();
    const proj = startMemoryProjector({ bus: r.bus, store: r.store, hostId: r.hostId });
    const id = ulid();
    const futureHlc = encodeStamp({ l: 0xffffffffffff, c: 0xffff });
    r.store.raw
      .prepare(
        `INSERT INTO memories (
           id, hlc, host_id, actor_id, scope, scope_ref, role, depth,
           authored_by, seeded_from, title, body_md, tags,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        futureHlc,
        r.hostId,
        "a",
        "private",
        "a",
        "knowledge",
        1,
        null,
        null,
        "survivor",
        "x",
        "[]",
        Date.now(),
        Date.now(),
      );
    r.bus.publish({
      type: MEMORY_FORGOTTEN,
      hostId: r.hostId,
      actorId: "a",
      durable: true,
      payload: { id },
    });
    const row = r.store.raw.query("SELECT id FROM memories WHERE id = ?").get(id);
    expect(row).not.toBeNull();
    proj.stop();
  });

  it("preserves memory_reads across a forget (audit survives tombstone)", () => {
    const r = rig();
    const proj = startMemoryProjector({ bus: r.bus, store: r.store, hostId: r.hostId });
    const id = ulid();
    r.bus.publish({
      type: MEMORY_WROTE,
      hostId: r.hostId,
      actorId: "a",
      durable: true,
      payload: {
        id,
        actorId: "a",
        scope: "private",
        scopeRef: "a",
        role: "goal",
        title: "g",
        bodyMd: "go",
        tags: [],
        depth: 1,
      },
    });
    r.bus.publish({
      type: "memory.read",
      hostId: r.hostId,
      actorId: "a",
      durable: true,
      payload: { id, readerActorId: "a" },
    });
    r.bus.publish({
      type: MEMORY_FORGOTTEN,
      hostId: r.hostId,
      actorId: "a",
      durable: true,
      payload: { id },
    });
    const reads = r.store.raw.query("SELECT * FROM memory_reads WHERE memory_id = ?").all(id);
    expect(reads.length).toBe(1);
    proj.stop();
  });
});

describe("memory tools", () => {
  function setup() {
    const r = rig();
    const proj = startMemoryProjector({ bus: r.bus, store: r.store, hostId: r.hostId });
    const tools = buildMemoryTools({ bus: r.bus, store: r.store, hostId: r.hostId });
    // Seed two agents
    for (const id of ["alice", "bob"]) {
      r.store
        .insert(tables.agents)
        .values({ id, name: id, hostId: r.hostId, scope: {}, createdAt: Date.now() })
        .run();
    }
    return {
      ...r,
      proj,
      tools,
      stop: () => {
        proj.stop();
        r.bus.close();
        r.store.close();
      },
    };
  }

  it("defaults depth by role — principle=10, other=1", async () => {
    const s = setup();
    const write = getTool(s.tools, "memory_write");
    const r1 = await write.execute(
      { title: "p", bodyMd: "q", role: "principle" },
      makeCtx("alice", s.hostId),
    );
    const r2 = await write.execute(
      { title: "k", bodyMd: "v", role: "knowledge" },
      makeCtx("alice", s.hostId),
    );
    expect(r1.depth).toBe(10);
    expect(r2.depth).toBe(1);
    s.stop();
  });

  it("memory_read denies private reads by another actor", async () => {
    const s = setup();
    const write = getTool(s.tools, "memory_write");
    const read = getTool(s.tools, "memory_read");
    const r = await write.execute(
      { title: "secret", bodyMd: "only mine", role: "knowledge" },
      makeCtx("alice", s.hostId),
    );
    await expect(read.execute({ id: r.id }, makeCtx("bob", s.hostId))).rejects.toThrow(
      /caller is not the owner/,
    );
    // Owner read succeeds
    const got = await read.execute({ id: r.id }, makeCtx("alice", s.hostId));
    expect(got.title).toBe("secret");
    s.stop();
  });

  it("memory_write rejects updates targeting someone else's memory", async () => {
    const s = setup();
    const write = getTool(s.tools, "memory_write");
    const r = await write.execute(
      { title: "mine", bodyMd: "yes", role: "knowledge" },
      makeCtx("alice", s.hostId),
    );
    await expect(
      write.execute(
        { title: "hijacked", bodyMd: "gotcha", updates: r.id },
        makeCtx("bob", s.hostId),
      ),
    ).rejects.toThrow(/cannot update/);
    s.stop();
  });

  it("memory_search filters out private memories owned by other actors", async () => {
    const s = setup();
    const write = getTool(s.tools, "memory_write");
    const search = getTool(s.tools, "memory_search");
    await write.execute(
      { title: "alice secret", bodyMd: "mine", role: "knowledge" },
      makeCtx("alice", s.hostId),
    );
    await write.execute(
      { title: "bob secret", bodyMd: "mine too", role: "knowledge" },
      makeCtx("bob", s.hostId),
    );
    const aHits: Array<{ title: string }> = await search.execute({}, makeCtx("alice", s.hostId));
    const bHits: Array<{ title: string }> = await search.execute({}, makeCtx("bob", s.hostId));
    expect(aHits.map((h) => h.title)).toEqual(["alice secret"]);
    expect(bHits.map((h) => h.title)).toEqual(["bob secret"]);
    s.stop();
  });

  it("memory_promote private→team requires ownership + team membership", async () => {
    const s = setup();
    const write = getTool(s.tools, "memory_write");
    const promote = getTool(s.tools, "memory_promote");
    const teamId = ulid();
    s.store.insert(tables.teams).values({ id: teamId, name: "t", createdAt: Date.now() }).run();
    // alice is a team member; bob is not
    s.store
      .insert(tables.teamMembers)
      .values({ teamId, actorId: "alice", role: "member", joinedAt: Date.now() })
      .run();

    const r = await write.execute(
      { title: "t", bodyMd: "b", role: "knowledge" },
      makeCtx("alice", s.hostId),
    );
    // bob can't promote someone else's memory
    await expect(
      promote.execute({ id: r.id, teamId }, makeCtx("bob", s.hostId)),
    ).rejects.toThrow(/do not own/);
    // alice promotes her own
    const result = await promote.execute(
      { id: r.id, teamId },
      makeCtx("alice", s.hostId),
    );
    expect(result.scope).toBe("team");
    const row = s.store.raw
      .query("SELECT scope, scope_ref FROM memories WHERE id = ?")
      .get(r.id) as { scope: string; scope_ref: string };
    expect(row.scope).toBe("team");
    expect(row.scope_ref).toBe(teamId);
    s.stop();
  });

  it("explicit depth overrides the role default", async () => {
    const s = setup();
    const write = getTool(s.tools, "memory_write");
    const r = await write.execute(
      { title: "weak principle", bodyMd: "for now", role: "principle", depth: 3 },
      makeCtx("alice", s.hostId),
    );
    expect(r.depth).toBe(3);
    const row = s.store.raw.query("SELECT depth FROM memories WHERE id = ?").get(r.id) as {
      depth: number;
    };
    expect(row.depth).toBe(3);
    s.stop();
  });

  it("memory_write rejects scope=team without a scopeRef", async () => {
    const s = setup();
    const write = getTool(s.tools, "memory_write");
    await expect(
      write.execute(
        { title: "x", bodyMd: "y", role: "knowledge", scope: "team" },
        makeCtx("alice", s.hostId),
      ),
    ).rejects.toThrow(/scopeRef/);
    s.stop();
  });

  it("memory_write auto-fills scopeRef=actor for private", async () => {
    const s = setup();
    const write = getTool(s.tools, "memory_write");
    const r = await write.execute(
      { title: "x", bodyMd: "y", role: "knowledge" },
      makeCtx("alice", s.hostId),
    );
    const row = s.store.raw.query("SELECT scope_ref FROM memories WHERE id = ?").get(r.id) as {
      scope_ref: string;
    };
    expect(row.scope_ref).toBe("alice");
    s.stop();
  });

  it("memory_search role filter narrows results to one posture", async () => {
    const s = setup();
    const write = getTool(s.tools, "memory_write");
    const search = getTool(s.tools, "memory_search");
    await write.execute(
      { title: "p1", bodyMd: "a", role: "principle" },
      makeCtx("alice", s.hostId),
    );
    await write.execute(
      { title: "g1", bodyMd: "b", role: "goal" },
      makeCtx("alice", s.hostId),
    );
    await write.execute(
      { title: "k1", bodyMd: "c", role: "knowledge" },
      makeCtx("alice", s.hostId),
    );
    const goals: Array<{ title: string; role: string }> = await search.execute(
      { role: "goal" },
      makeCtx("alice", s.hostId),
    );
    expect(goals.map((g) => g.title)).toEqual(["g1"]);
    expect(goals.every((g) => g.role === "goal")).toBe(true);
    s.stop();
  });

  it("memory_search query LIKE-matches title and body", async () => {
    const s = setup();
    const write = getTool(s.tools, "memory_write");
    const search = getTool(s.tools, "memory_search");
    await write.execute(
      { title: "git workflow", bodyMd: "branch per feature", role: "skill" },
      makeCtx("alice", s.hostId),
    );
    await write.execute(
      { title: "code review", bodyMd: "be kind in feedback", role: "skill" },
      makeCtx("alice", s.hostId),
    );
    // Title match
    const titleHits: Array<{ title: string }> = await search.execute(
      { query: "git" },
      makeCtx("alice", s.hostId),
    );
    expect(titleHits.map((h) => h.title)).toEqual(["git workflow"]);
    // Body match
    const bodyHits: Array<{ title: string }> = await search.execute(
      { query: "kind" },
      makeCtx("alice", s.hostId),
    );
    expect(bodyHits.map((h) => h.title)).toEqual(["code review"]);
    s.stop();
  });

  it("team scope: members can read each other's team memories; non-members cannot", async () => {
    const s = setup();
    const write = getTool(s.tools, "memory_write");
    const read = getTool(s.tools, "memory_read");
    const search = getTool(s.tools, "memory_search");
    const teamId = ulid();
    s.store.insert(tables.teams).values({ id: teamId, name: "x", createdAt: Date.now() }).run();
    s.store
      .insert(tables.teamMembers)
      .values({ teamId, actorId: "alice", role: "member", joinedAt: Date.now() })
      .run();
    // bob is not a member
    const r = await write.execute(
      {
        title: "team note",
        bodyMd: "shared",
        role: "knowledge",
        scope: "team",
        scopeRef: teamId,
      },
      makeCtx("alice", s.hostId),
    );
    // Owner (alice) reads
    const got = await read.execute({ id: r.id }, makeCtx("alice", s.hostId));
    expect(got.title).toBe("team note");
    // Non-member (bob) denied
    await expect(read.execute({ id: r.id }, makeCtx("bob", s.hostId))).rejects.toThrow(
      /caller not in team/,
    );
    // Search: bob shouldn't see it
    const bSearch: Array<{ title: string }> = await search.execute({}, makeCtx("bob", s.hostId));
    expect(bSearch.map((h) => h.title)).not.toContain("team note");
    // Add bob to the team — now he can read
    s.store
      .insert(tables.teamMembers)
      .values({ teamId, actorId: "bob", role: "member", joinedAt: Date.now() })
      .run();
    const bGot = await read.execute({ id: r.id }, makeCtx("bob", s.hostId));
    expect(bGot.title).toBe("team note");
    const bSearch2: Array<{ title: string }> = await search.execute({}, makeCtx("bob", s.hostId));
    expect(bSearch2.map((h) => h.title)).toContain("team note");
    s.stop();
  });

  it("scratch scope: only the owning actor can read; promote rejects scratch", async () => {
    const s = setup();
    const write = getTool(s.tools, "memory_write");
    const read = getTool(s.tools, "memory_read");
    const promote = getTool(s.tools, "memory_promote");
    const taskRunId = ulid(); // pretend task_run id; scope_ref is just a string in v0
    const r = await write.execute(
      {
        title: "scratch note",
        bodyMd: "ephemeral",
        role: "knowledge",
        scope: "scratch",
        scopeRef: taskRunId,
      },
      makeCtx("alice", s.hostId),
    );
    // Owner reads
    const got = await read.execute({ id: r.id }, makeCtx("alice", s.hostId));
    expect(got.scope).toBe("scratch");
    // Other denied
    await expect(read.execute({ id: r.id }, makeCtx("bob", s.hostId))).rejects.toThrow(
      /caller is not the owner/,
    );
    // Promotion: scratch is not promotable in v0
    const teamId = ulid();
    s.store.insert(tables.teams).values({ id: teamId, name: "t", createdAt: Date.now() }).run();
    s.store
      .insert(tables.teamMembers)
      .values({ teamId, actorId: "alice", role: "member", joinedAt: Date.now() })
      .run();
    await expect(
      promote.execute({ id: r.id, teamId }, makeCtx("alice", s.hostId)),
    ).rejects.toThrow(/only private memories can be promoted/);
    s.stop();
  });

  it("update preserves seeded_from and authored_by — lineage trace survives self-edits", async () => {
    // Regression: a child editing a seeded principle must keep the
    // attribution forward. Simulate a seeded row directly (the spawn
    // path is exercised in pass-on tests; here we isolate the tool
    // invariant).
    const s = setup();
    const write = getTool(s.tools, "memory_write");
    const childId = ulid();
    const seededFrom = ulid();
    s.store.insert(tables.agents).values({ id: childId, name: "c", hostId: s.hostId, scope: {}, createdAt: Date.now() }).run();
    // Forge a seeded principle directly via a memory.wrote event so
    // the projector lays it down with the attribution we want.
    const memId = ulid();
    s.bus.publish({
      type: MEMORY_WROTE,
      hostId: s.hostId,
      actorId: "parent",
      durable: true,
      payload: {
        id: memId,
        actorId: childId,
        scope: "private",
        scopeRef: childId,
        role: "principle",
        title: "inherited",
        bodyMd: "from parent",
        tags: [],
        depth: 10,
        authoredBy: "parent",
        seededFrom,
      },
    });
    const seedRow = s.store.raw
      .query("SELECT authored_by, seeded_from FROM memories WHERE id = ?")
      .get(memId) as { authored_by: string; seeded_from: string };
    expect(seedRow.authored_by).toBe("parent");
    expect(seedRow.seeded_from).toBe(seededFrom);
    // Child edits it via memory_write+updates — attribution must survive
    await write.execute(
      { title: "drifted", bodyMd: "my own take now", role: "principle", updates: memId },
      makeCtx(childId, s.hostId),
    );
    const after = s.store.raw
      .query("SELECT authored_by, seeded_from, title FROM memories WHERE id = ?")
      .get(memId) as { authored_by: string; seeded_from: string; title: string };
    expect(after.title).toBe("drifted");
    expect(after.authored_by).toBe("parent");
    expect(after.seeded_from).toBe(seededFrom);
    s.stop();
  });

  it("memory_forget owner-only; leaves memory_reads intact", async () => {
    const s = setup();
    const write = getTool(s.tools, "memory_write");
    const read = getTool(s.tools, "memory_read");
    const forget = getTool(s.tools, "memory_forget");
    const r = await write.execute(
      { title: "g", bodyMd: "x", role: "goal" },
      makeCtx("alice", s.hostId),
    );
    await read.execute({ id: r.id }, makeCtx("alice", s.hostId));
    await expect(forget.execute({ id: r.id }, makeCtx("bob", s.hostId))).rejects.toThrow(
      /do not own/,
    );
    await forget.execute({ id: r.id }, makeCtx("alice", s.hostId));
    const row = s.store.raw.query("SELECT id FROM memories WHERE id = ?").get(r.id);
    expect(row).toBeNull();
    const reads = s.store.raw
      .query("SELECT * FROM memory_reads WHERE memory_id = ?")
      .all(r.id);
    expect(reads.length).toBe(1);
    s.stop();
  });
});

describe("principle injection", () => {
  it("loadPrinciples returns only actor's role=principle private memories, depth-sorted", async () => {
    const r = rig();
    const proj = startMemoryProjector({ bus: r.bus, store: r.store, hostId: r.hostId });
    const tools = buildMemoryTools({ bus: r.bus, store: r.store, hostId: r.hostId });
    const write = getTool(tools, "memory_write");
    r.store
      .insert(tables.agents)
      .values({ id: "alice", name: "alice", hostId: r.hostId, scope: {}, createdAt: Date.now() })
      .run();
    r.store
      .insert(tables.agents)
      .values({ id: "bob", name: "bob", hostId: r.hostId, scope: {}, createdAt: Date.now() })
      .run();
    const ctx = makeCtx("alice", r.hostId);
    await write.execute({ title: "honesty", bodyMd: "always", role: "principle" }, ctx);
    await write.execute({ title: "brevity", bodyMd: "be short", role: "principle", depth: 15 }, ctx);
    // Non-principle — excluded
    await write.execute({ title: "note", bodyMd: "fact", role: "knowledge" }, ctx);
    // Bob has his own principle — must not leak to Alice
    await write.execute(
      { title: "bob thing", bodyMd: "his own", role: "principle" },
      makeCtx("bob", r.hostId),
    );

    const ps = loadPrinciples(r.store, "alice");
    expect(ps.map((p) => p.title)).toEqual(["brevity", "honesty"]);
    const rendered = renderPrinciples(ps);
    expect(rendered).toContain("strict, non-negotiable");
    expect(rendered).toContain("brevity");
    expect(rendered).not.toContain("bob thing");
    expect(rendered).not.toContain("note");
    proj.stop();
    r.bus.close();
    r.store.close();
  });

  it("agent loop prepends principles to the system prompt every turn", async () => {
    const r = rig();
    const proj = startMemoryProjector({ bus: r.bus, store: r.store, hostId: r.hostId });
    const tools = buildMemoryTools({ bus: r.bus, store: r.store, hostId: r.hostId });
    const write = getTool(tools, "memory_write");
    const agentId = "root";
    r.store
      .insert(tables.agents)
      .values({ id: agentId, name: "root", hostId: r.hostId, scope: {}, createdAt: Date.now() })
      .run();
    await write.execute(
      { title: "honesty", bodyMd: "always tell the truth", role: "principle" },
      makeCtx(agentId, r.hostId),
    );

    // Capture what the LLM sees
    const captured: CompletionRequest[] = [];
    const llm: Llm = {
      provider: "mock",
      defaultModel: "mock-1",
      async complete(req: CompletionRequest): Promise<Completion> {
        captured.push(req);
        return {
          content: [{ type: "text", text: "ok" }],
          stopReason: "end_turn",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            totalTokens: 2,
          },
        };
      },
    };
    startAgentLoop({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm,
      agentId,
      system: "you are a helper",
    });

    const done = new Promise<void>((resolve) => {
      r.bus.subscribe("chat.turn-end", () => resolve());
    });
    r.bus.publish({
      type: "chat.input",
      hostId: r.hostId,
      actorId: "cli",
      durable: true,
      toAgentId: agentId,
      threadId: "t1",
      payload: { text: "hi" },
    });
    await done;

    expect(captured.length).toBeGreaterThan(0);
    // System is now structured segments (LOG 2026-04-24) — flatten the
    // text for the "everything got injected" assertion.
    const rawSys = captured[0]!.system;
    const sys =
      typeof rawSys === "string"
        ? rawSys
        : (rawSys ?? []).map((s) => s.text).join("\n");
    expect(sys).toContain("you are a helper");
    expect(sys).toContain("Your principles");
    expect(sys).toContain("honesty");
    expect(sys).toContain("always tell the truth");
    proj.stop();
    r.bus.close();
    r.store.close();
  });
});
