// Cultural pass-on tests — principles seeded at spawn, memory_lineage
// tool, and the drift property (a child's copy of a seed is independent
// from the parent's row).

import { afterEach, describe, expect, it } from "bun:test";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import { createAgentManager } from "../src/agent/index.ts";
import {
  buildMemoryTools,
  loadPrinciples,
  startMemoryProjector,
} from "../src/memory/index.ts";
import type { Completion, CompletionRequest, Llm } from "../src/llm/types.ts";

function mockLlm(): Llm {
  return {
    provider: "mock",
    defaultModel: "mock-1",
    async complete(_req: CompletionRequest): Promise<Completion> {
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
}

function rig() {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  const projector = startMemoryProjector({ bus, store, hostId });
  const tools = buildMemoryTools({ bus, store, hostId });
  const cleanup = () => {
    projector.stop();
    bus.close();
    store.close();
  };
  return { store, bus, hostId, tools, cleanup };
}

function ctxFor(actorId: string, hostId: string) {
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
  if (!t) throw new Error(`missing tool ${name}`);
  return t as unknown as LooseTool;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe("cultural pass-on at spawn", () => {
  it("fresh parent with no principles → child born with no seeds (sparse lineage)", async () => {
    const r = rig();
    cleanups.push(r.cleanup);
    const parentId = "parent";
    r.store
      .insert(tables.agents)
      .values({ id: parentId, name: "parent", hostId: r.hostId, scope: {}, createdAt: Date.now() })
      .run();
    const mgr = createAgentManager({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm: mockLlm(),
    });
    const result = await mgr.spawn({
      name: "worker",
      mission: "go",
      parentAgentId: parentId,
    });
    const childSeeds = r.store.raw
      .query("SELECT COUNT(*) as n FROM memories WHERE actor_id = ?")
      .get(result.agentId) as { n: number };
    expect(childSeeds.n).toBe(0);
    mgr.shutdown();
  });

  it("parent with N role=principle memories seeds the child with N rows, attribution preserved", async () => {
    const r = rig();
    cleanups.push(r.cleanup);
    const write = getTool(r.tools, "memory_write");
    const parentId = "parent";
    r.store
      .insert(tables.agents)
      .values({ id: parentId, name: "parent", hostId: r.hostId, scope: {}, createdAt: Date.now() })
      .run();
    const p1 = await write.execute(
      { title: "honesty", bodyMd: "always tell the truth", role: "principle" },
      ctxFor(parentId, r.hostId),
    );
    const p2 = await write.execute(
      { title: "brevity", bodyMd: "be concise", role: "principle", depth: 15 },
      ctxFor(parentId, r.hostId),
    );
    // Non-principle — must NOT pass
    await write.execute(
      { title: "trivia", bodyMd: "sky is blue", role: "knowledge" },
      ctxFor(parentId, r.hostId),
    );

    const mgr = createAgentManager({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm: mockLlm(),
    });
    const result = await mgr.spawn({
      name: "worker",
      mission: "go",
      parentAgentId: parentId,
    });

    const seeds = r.store.raw
      .query(
        "SELECT title, role, depth, authored_by, seeded_from FROM memories WHERE actor_id = ? ORDER BY title",
      )
      .all(result.agentId) as Array<{
      title: string;
      role: string;
      depth: number;
      authored_by: string | null;
      seeded_from: string | null;
    }>;
    expect(seeds.map((s) => s.title)).toEqual(["brevity", "honesty"]);
    for (const s of seeds) {
      expect(s.role).toBe("principle");
      expect(s.authored_by).toBe(parentId);
      expect(s.seeded_from).not.toBeNull();
    }
    // Depth preserved from parent
    const brevity = seeds.find((s) => s.title === "brevity")!;
    const honesty = seeds.find((s) => s.title === "honesty")!;
    expect(brevity.depth).toBe(15);
    expect(honesty.depth).toBe(10);
    // Seed IDs should reference parent memory ids
    expect(seeds.map((s) => s.seeded_from).sort()).toEqual([p1.id, p2.id].sort());
    mgr.shutdown();
  });

  it("seedMemoryIds augments pass-on with non-principle seeds (ownership enforced)", async () => {
    const r = rig();
    cleanups.push(r.cleanup);
    const write = getTool(r.tools, "memory_write");
    const parentId = "parent";
    const strangerId = "stranger";
    for (const id of [parentId, strangerId]) {
      r.store
        .insert(tables.agents)
        .values({ id, name: id, hostId: r.hostId, scope: {}, createdAt: Date.now() })
        .run();
    }
    const principle = await write.execute(
      { title: "be kind", bodyMd: "", role: "principle" },
      ctxFor(parentId, r.hostId),
    );
    const skill = await write.execute(
      { title: "git-flow", bodyMd: "branch per feature", role: "skill" },
      ctxFor(parentId, r.hostId),
    );
    const stranger_only = await write.execute(
      { title: "stranger thing", bodyMd: "nope", role: "skill" },
      ctxFor(strangerId, r.hostId),
    );

    const mgr = createAgentManager({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm: mockLlm(),
    });
    const result = await mgr.spawn({
      name: "specialist",
      mission: "go",
      parentAgentId: parentId,
      seedMemoryIds: [skill.id, stranger_only.id], // stranger's must be ignored
    });

    const titles = r.store.raw
      .query("SELECT title FROM memories WHERE actor_id = ? ORDER BY title")
      .all(result.agentId) as Array<{ title: string }>;
    expect(titles.map((t) => t.title)).toEqual(["be kind", "git-flow"]);
    // Silence unused-var linting for principle
    expect(principle.id).toBeDefined();
    mgr.shutdown();
  });

  it("child's seed copy drifts from parent on update; parent row unchanged", async () => {
    const r = rig();
    cleanups.push(r.cleanup);
    const write = getTool(r.tools, "memory_write");
    const parentId = "parent";
    r.store
      .insert(tables.agents)
      .values({ id: parentId, name: "parent", hostId: r.hostId, scope: {}, createdAt: Date.now() })
      .run();
    const p1 = await write.execute(
      { title: "original", bodyMd: "parent version", role: "principle" },
      ctxFor(parentId, r.hostId),
    );
    const mgr = createAgentManager({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm: mockLlm(),
    });
    const result = await mgr.spawn({
      name: "worker",
      mission: "go",
      parentAgentId: parentId,
    });

    const childSeed = r.store.raw
      .query("SELECT id FROM memories WHERE actor_id = ?")
      .get(result.agentId) as { id: string };

    // Child mutates its own copy — parent must stay untouched
    await write.execute(
      { title: "drifted", bodyMd: "child's view", role: "principle", updates: childSeed.id },
      ctxFor(result.agentId, r.hostId),
    );

    const parentRow = r.store.raw.query("SELECT title FROM memories WHERE id = ?").get(p1.id) as {
      title: string;
    };
    const childRow = r.store.raw
      .query("SELECT title FROM memories WHERE id = ?")
      .get(childSeed.id) as { title: string };
    expect(parentRow.title).toBe("original");
    expect(childRow.title).toBe("drifted");
    mgr.shutdown();
  });

  it("seeded principles feed into the child's turn-start injection", async () => {
    const r = rig();
    cleanups.push(r.cleanup);
    const write = getTool(r.tools, "memory_write");
    const parentId = "parent";
    r.store
      .insert(tables.agents)
      .values({ id: parentId, name: "parent", hostId: r.hostId, scope: {}, createdAt: Date.now() })
      .run();
    await write.execute(
      { title: "serve the principal", bodyMd: "their goals are yours", role: "principle" },
      ctxFor(parentId, r.hostId),
    );
    const mgr = createAgentManager({
      bus: r.bus,
      store: r.store,
      hostId: r.hostId,
      llm: mockLlm(),
    });
    const result = await mgr.spawn({
      name: "worker",
      mission: "go",
      parentAgentId: parentId,
    });
    const principles = loadPrinciples(r.store, result.agentId);
    expect(principles.length).toBe(1);
    expect(principles[0]!.title).toBe("serve the principal");
    expect(principles[0]!.seededFrom).not.toBeNull();
    mgr.shutdown();
  });
});

describe("memory_lineage", () => {
  it("returns ancestors' team principles only; never their private", async () => {
    const r = rig();
    cleanups.push(r.cleanup);
    const write = getTool(r.tools, "memory_write");
    const promote = getTool(r.tools, "memory_promote");
    const lineage = getTool(r.tools, "memory_lineage");
    const grand = "grand";
    const parent = "parent";
    const child = "child";
    r.store
      .insert(tables.agents)
      .values({ id: grand, name: "grand", hostId: r.hostId, scope: {}, createdAt: Date.now() })
      .run();
    r.store
      .insert(tables.agents)
      .values({
        id: parent,
        name: "parent",
        hostId: r.hostId,
        parentAgentId: grand,
        scope: {},
        createdAt: Date.now(),
      })
      .run();
    r.store
      .insert(tables.agents)
      .values({
        id: child,
        name: "child",
        hostId: r.hostId,
        parentAgentId: parent,
        scope: {},
        createdAt: Date.now(),
      })
      .run();

    // Team the child is a member of (and grandparent + parent too)
    const teamId = ulid();
    r.store.insert(tables.teams).values({ id: teamId, name: "team", createdAt: Date.now() }).run();
    for (const a of [grand, parent, child]) {
      r.store
        .insert(tables.teamMembers)
        .values({ teamId, actorId: a, role: "member", joinedAt: Date.now() })
        .run();
    }

    // grand writes a private principle, then promotes a copy to team
    const grandPrivate = await write.execute(
      { title: "private ancient wisdom", bodyMd: "secret", role: "principle" },
      ctxFor(grand, r.hostId),
    );
    const grandToPromote = await write.execute(
      { title: "shared ancient wisdom", bodyMd: "public", role: "principle" },
      ctxFor(grand, r.hostId),
    );
    await promote.execute({ id: grandToPromote.id, teamId }, ctxFor(grand, r.hostId));

    // parent writes a principle on team directly
    await write.execute(
      {
        title: "parent's commitment",
        bodyMd: "lead by example",
        role: "principle",
        scope: "team",
        scopeRef: teamId,
      },
      ctxFor(parent, r.hostId),
    );
    // parent's own private — must NOT leak to child via lineage
    await write.execute(
      { title: "parent private", bodyMd: "mine alone", role: "principle" },
      ctxFor(parent, r.hostId),
    );

    const hits: Array<{ title: string; actorId: string; hopsFromCaller: number }> =
      await lineage.execute({}, ctxFor(child, r.hostId));
    const titles = hits.map((h) => h.title).sort();
    expect(titles).toContain("parent's commitment");
    expect(titles).toContain("shared ancient wisdom");
    expect(titles).not.toContain("private ancient wisdom");
    expect(titles).not.toContain("parent private");
    // Near lineage reported first
    const parentHop = hits.find((h) => h.actorId === parent)!;
    const grandHop = hits.find((h) => h.actorId === grand)!;
    expect(parentHop.hopsFromCaller).toBe(1);
    expect(grandHop.hopsFromCaller).toBe(2);
    // Silence unused-var lint
    expect(grandPrivate.id).toBeDefined();
  });

  it("respects the depth cap (max hops)", async () => {
    const r = rig();
    cleanups.push(r.cleanup);
    const write = getTool(r.tools, "memory_write");
    const lineage = getTool(r.tools, "memory_lineage");
    const grand = "grand2";
    const parent = "parent2";
    const child = "child2";
    r.store
      .insert(tables.agents)
      .values({ id: grand, name: "grand2", hostId: r.hostId, scope: {}, createdAt: Date.now() })
      .run();
    r.store
      .insert(tables.agents)
      .values({
        id: parent,
        name: "parent2",
        hostId: r.hostId,
        parentAgentId: grand,
        scope: {},
        createdAt: Date.now(),
      })
      .run();
    r.store
      .insert(tables.agents)
      .values({
        id: child,
        name: "child2",
        hostId: r.hostId,
        parentAgentId: parent,
        scope: {},
        createdAt: Date.now(),
      })
      .run();

    const teamId = ulid();
    r.store.insert(tables.teams).values({ id: teamId, name: "team2", createdAt: Date.now() }).run();
    for (const a of [grand, parent, child]) {
      r.store
        .insert(tables.teamMembers)
        .values({ teamId, actorId: a, role: "member", joinedAt: Date.now() })
        .run();
    }
    await write.execute(
      {
        title: "parent rule",
        bodyMd: "x",
        role: "principle",
        scope: "team",
        scopeRef: teamId,
      },
      ctxFor(parent, r.hostId),
    );
    await write.execute(
      {
        title: "grand rule",
        bodyMd: "y",
        role: "principle",
        scope: "team",
        scopeRef: teamId,
      },
      ctxFor(grand, r.hostId),
    );

    const hits1: Array<{ title: string }> = await lineage.execute({ depth: 1 }, ctxFor(child, r.hostId));
    expect(hits1.map((h) => h.title)).toEqual(["parent rule"]);
    const hitsAll: Array<{ title: string }> = await lineage.execute({}, ctxFor(child, r.hostId));
    expect(hitsAll.map((h) => h.title).sort()).toEqual(["grand rule", "parent rule"]);
  });

  it("returns [] when caller has no parent (orphan agent)", async () => {
    const r = rig();
    cleanups.push(r.cleanup);
    const lineage = getTool(r.tools, "memory_lineage");
    const orphan = "orphan";
    r.store
      .insert(tables.agents)
      .values({ id: orphan, name: "orphan", hostId: r.hostId, scope: {}, createdAt: Date.now() })
      .run();
    const hits = await lineage.execute({}, ctxFor(orphan, r.hostId));
    expect(hits).toEqual([]);
  });

  it("survives a cycle in parent_agent_id without infinite-looping", async () => {
    // Cycles shouldn't happen via spawn (parent_agent_id is set once
    // at insert), but the walk must defend against bad data.
    const r = rig();
    cleanups.push(r.cleanup);
    const lineage = getTool(r.tools, "memory_lineage");
    const a = "cycA";
    const b = "cycB";
    // Insert with the cycle: a → b → a
    r.store
      .insert(tables.agents)
      .values({
        id: a,
        name: a,
        hostId: r.hostId,
        parentAgentId: b,
        scope: {},
        createdAt: Date.now(),
      })
      .run();
    r.store
      .insert(tables.agents)
      .values({
        id: b,
        name: b,
        hostId: r.hostId,
        parentAgentId: a,
        scope: {},
        createdAt: Date.now(),
      })
      .run();
    // Should terminate quickly (the seen-set breaks the cycle).
    const hits = await lineage.execute({}, ctxFor(a, r.hostId));
    expect(Array.isArray(hits)).toBe(true);
  });

  it("emits memory.read events for each surfaced hit", async () => {
    const r = rig();
    cleanups.push(r.cleanup);
    const write = getTool(r.tools, "memory_write");
    const lineage = getTool(r.tools, "memory_lineage");
    const parent = "parentX";
    const child = "childX";
    r.store
      .insert(tables.agents)
      .values({ id: parent, name: "parentX", hostId: r.hostId, scope: {}, createdAt: Date.now() })
      .run();
    r.store
      .insert(tables.agents)
      .values({
        id: child,
        name: "childX",
        hostId: r.hostId,
        parentAgentId: parent,
        scope: {},
        createdAt: Date.now(),
      })
      .run();
    const teamId = ulid();
    r.store.insert(tables.teams).values({ id: teamId, name: "teamx", createdAt: Date.now() }).run();
    for (const a of [parent, child]) {
      r.store
        .insert(tables.teamMembers)
        .values({ teamId, actorId: a, role: "member", joinedAt: Date.now() })
        .run();
    }
    await write.execute(
      {
        title: "rule",
        bodyMd: "y",
        role: "principle",
        scope: "team",
        scopeRef: teamId,
      },
      ctxFor(parent, r.hostId),
    );

    const reads: unknown[] = [];
    r.bus.subscribe("memory.read", (ev) => void reads.push(ev));
    await lineage.execute({}, ctxFor(child, r.hostId));
    expect(reads.length).toBe(1);
  });
});
