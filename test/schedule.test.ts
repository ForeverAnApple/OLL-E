import { describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createBus, persistToStore, type Event } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import { buildScheduleTools } from "../src/tools/schedule.ts";
import type { ToolDef, ToolExecuteContext } from "../src/extensions/types.ts";

function rig() {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  const tools = buildScheduleTools({ bus, store, hostId });
  const byName = new Map(tools.map((t) => [t.name, t] as const));
  function seedAgent(id: string): void {
    store
      .insert(tables.agents)
      .values({ id, name: id, hostId, scope: {}, createdAt: Date.now() })
      .onConflictDoNothing()
      .run();
  }
  function ctx(actorId: string): ToolExecuteContext {
    return { hostId, extensionId: "core", actorId, abort: new AbortController().signal, secrets: {} };
  }
  return { store, bus, hostId, tools, byName, seedAgent, ctx };
}

// Async wrapper so a synchronously-thrown validation error surfaces as a
// rejected promise for `.rejects.toThrow`.
async function run<I, O>(tool: ToolDef, args: I, ctx: ToolExecuteContext): Promise<O> {
  return (await (tool as ToolDef<I, O>).execute(args, ctx)) as O;
}

describe("schedule_task", () => {
  it("inserts a cron trigger row, emits schedule.armed, and returns a jobId + nextRun", async () => {
    const { byName, store, bus, seedAgent, ctx } = rig();
    seedAgent("a1");
    const events: Event[] = [];
    bus.subscribe("schedule.armed", (e) => void events.push(e));

    const res = (await run(
      byName.get("schedule_task")!,
      { cronExpr: "0 8 * * *", instruction: "post the morning digest", deliver: { kind: "cli" } },
      ctx("a1"),
    )) as { jobId: string; nextRun: string | null };

    expect(res.jobId).toBeTruthy();
    expect(res.nextRun).toBeTruthy();

    const rows = store
      .select()
      .from(tables.triggers)
      .where(and(eq(tables.triggers.agentId, "a1"), eq(tables.triggers.type, "cron")))
      .all();
    expect(rows).toHaveLength(1);
    expect((rows[0]!.config as Record<string, unknown>).instruction).toBe("post the morning digest");

    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { jobId: string }).jobId).toBe(res.jobId);
  });

  it("rejects a 6-field (seconds) cron", async () => {
    const { byName, seedAgent, ctx } = rig();
    seedAgent("a1");
    await expect(
      run(
        byName.get("schedule_task")!,
        { cronExpr: "0 0 8 * * *", instruction: "x", deliver: { kind: "cli" } },
        ctx("a1"),
      ),
    ).rejects.toThrow(/5 fields/);
  });

  it("rejects an unparseable cron", async () => {
    const { byName, seedAgent, ctx } = rig();
    seedAgent("a1");
    await expect(
      run(
        byName.get("schedule_task")!,
        { cronExpr: "99 99 99 99 99", instruction: "x", deliver: { kind: "cli" } },
        ctx("a1"),
      ),
    ).rejects.toThrow(/invalid cronExpr/);
  });

  it("rejects an empty instruction", async () => {
    const { byName, seedAgent, ctx } = rig();
    seedAgent("a1");
    await expect(
      run(
        byName.get("schedule_task")!,
        { cronExpr: "0 8 * * *", instruction: "   ", deliver: { kind: "cli" } },
        ctx("a1"),
      ),
    ).rejects.toThrow(/instruction is required/);
  });

  it("rejects a discord deliver missing channelId", async () => {
    const { byName, seedAgent, ctx } = rig();
    seedAgent("a1");
    await expect(
      run(
        byName.get("schedule_task")!,
        { cronExpr: "0 8 * * *", instruction: "x", deliver: { kind: "discord" } },
        ctx("a1"),
      ),
    ).rejects.toThrow(/channelId/);
  });

  it("stores discord deliver with the channelId", async () => {
    const { byName, store, seedAgent, ctx } = rig();
    seedAgent("a1");
    await run(
      byName.get("schedule_task")!,
      { cronExpr: "0 8 * * *", instruction: "x", deliver: { kind: "discord", channelId: "123" } },
      ctx("a1"),
    );
    const row = store.select().from(tables.triggers).all()[0]!;
    const deliver = (row.config as Record<string, unknown>).deliver as { kind: string; channelId: string };
    expect(deliver).toEqual({ kind: "discord", channelId: "123" });
  });

  it("enforces the per-agent job cap", async () => {
    const { byName, store, hostId, seedAgent, ctx } = rig();
    seedAgent("a1");
    // Seed 50 existing cron rows directly.
    for (let i = 0; i < 50; i++) {
      store
        .insert(tables.triggers)
        .values({
          id: ulid(),
          agentId: "a1",
          type: "cron",
          config: { cronExpr: "0 8 * * *", instruction: "x", deliver: { kind: "cli" }, createdBy: "a1" },
          scope: {},
          createdAt: Date.now(),
        })
        .run();
    }
    void hostId;
    await expect(
      run(
        byName.get("schedule_task")!,
        { cronExpr: "0 8 * * *", instruction: "one too many", deliver: { kind: "cli" } },
        ctx("a1"),
      ),
    ).rejects.toThrow(/cap 50/);
  });
});

describe("schedule_list", () => {
  it("returns only the caller's jobs", async () => {
    const { byName, seedAgent, ctx } = rig();
    seedAgent("a1");
    seedAgent("a2");
    await run(
      byName.get("schedule_task")!,
      { cronExpr: "0 8 * * *", instruction: "a1 job", deliver: { kind: "cli" } },
      ctx("a1"),
    );
    await run(
      byName.get("schedule_task")!,
      { cronExpr: "0 9 * * *", instruction: "a2 job", deliver: { kind: "cli" } },
      ctx("a2"),
    );
    const listed = (await run(byName.get("schedule_list")!, {}, ctx("a1"))) as Array<{ instruction: string }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]!.instruction).toBe("a1 job");
  });
});

describe("schedule_cancel", () => {
  it("cancels the caller's own job, deletes the row, and emits schedule.cancelled", async () => {
    const { byName, store, bus, seedAgent, ctx } = rig();
    seedAgent("a1");
    const { jobId } = (await run(
      byName.get("schedule_task")!,
      { cronExpr: "0 8 * * *", instruction: "x", deliver: { kind: "cli" } },
      ctx("a1"),
    )) as { jobId: string };
    const events: Event[] = [];
    bus.subscribe("schedule.cancelled", (e) => void events.push(e));

    const res = (await run(byName.get("schedule_cancel")!, { jobId }, ctx("a1"))) as { cancelled: boolean };
    expect(res.cancelled).toBe(true);
    expect(store.select().from(tables.triggers).all()).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { jobId: string }).jobId).toBe(jobId);
  });

  it("refuses to cancel another agent's job and leaves it intact", async () => {
    const { byName, store, seedAgent, ctx } = rig();
    seedAgent("a1");
    seedAgent("a2");
    const { jobId } = (await run(
      byName.get("schedule_task")!,
      { cronExpr: "0 8 * * *", instruction: "x", deliver: { kind: "cli" } },
      ctx("a1"),
    )) as { jobId: string };
    await expect(run(byName.get("schedule_cancel")!, { jobId }, ctx("a2"))).rejects.toThrow(
      /another agent/,
    );
    expect(store.select().from(tables.triggers).all()).toHaveLength(1);
  });
});
