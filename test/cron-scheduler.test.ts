import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createBus, persistToStore, type Event } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import {
  createCronScheduler,
  fireJob,
  CHANNEL_THREAD_PREFIX_RE,
  parseCronConfig,
  type CronJob,
} from "../src/schedule/index.ts";

function rig() {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  function seedAgent(id: string): void {
    store
      .insert(tables.agents)
      .values({ id, name: id, hostId, scope: {}, createdAt: Date.now() })
      .onConflictDoNothing()
      .run();
  }
  function seedCronRow(id: string, agentId: string, cronExpr = "0 8 * * *"): void {
    store
      .insert(tables.triggers)
      .values({
        id,
        agentId,
        type: "cron",
        config: { cronExpr, instruction: `job ${id}`, deliver: { kind: "cli" }, createdBy: agentId },
        scope: {},
        createdAt: Date.now(),
      })
      .run();
  }
  return { store, bus, hostId, seedAgent, seedCronRow };
}

function job(
  overrides: Partial<CronJob> & {
    deliver?: CronJob["config"]["deliver"];
    threadMode?: "fresh" | "shared";
  } = {},
): CronJob {
  return {
    jobId: overrides.jobId ?? "j1",
    agentId: overrides.agentId ?? "a1",
    config: {
      cronExpr: "0 8 * * *",
      instruction: "post the digest",
      deliver: overrides.deliver ?? { kind: "cli" },
      threadMode: overrides.threadMode,
      createdBy: "a1",
    },
  };
}

const ULID = "[0-9A-HJKMNP-TV-Z]{26}";

describe("fireJob", () => {
  it("publishes a durable chat.input on a fresh per-fire cli thread with the standing-job payload", () => {
    const { bus, hostId } = rig();
    const inputs: Event[] = [];
    bus.subscribe("chat.input", (e) => void inputs.push(e));
    fireJob({ bus, hostId }, job());
    expect(inputs).toHaveLength(1);
    const ev = inputs[0]!;
    // Default (no threadMode) is fresh-per-fire: a new thread id every fire.
    expect(ev.threadId).toMatch(new RegExp(`^cron:j1:fire:${ULID}$`));
    expect(ev.toAgentId).toBe("a1");
    expect(ev.actorId).toBe(hostId);
    expect(ev.durable).toBe(true);
    expect(ev.payload).toMatchObject({
      text: "post the digest",
      standingJob: true,
      jobId: "j1",
      disposableThread: true,
    });
  });

  it("gives two consecutive fires of the same job different fresh thread ids", () => {
    const { bus, hostId } = rig();
    const inputs: Event[] = [];
    bus.subscribe("chat.input", (e) => void inputs.push(e));
    fireJob({ bus, hostId }, job());
    fireJob({ bus, hostId }, job());
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.threadId).not.toBe(inputs[1]!.threadId);
  });

  it("routes discord and telegram deliveries onto fresh per-fire channel threads", () => {
    const { bus, hostId } = rig();
    const inputs: Event[] = [];
    bus.subscribe("chat.input", (e) => void inputs.push(e));
    fireJob({ bus, hostId }, job({ jobId: "d1", deliver: { kind: "discord", channelId: "123" } }));
    fireJob({ bus, hostId }, job({ jobId: "t1", deliver: { kind: "telegram", chatId: "456" } }));
    // Fire segment sits BEFORE :job: so the end-anchored bridge jobId parse survives.
    expect(inputs[0]!.threadId).toMatch(new RegExp(`^discord:123:fire:${ULID}:job:d1$`));
    expect(inputs[1]!.threadId).toMatch(new RegExp(`^telegram:456:fire:${ULID}:job:t1$`));
  });

  it("threadMode:'shared' lands every fire on the job's one stable thread", () => {
    const { bus, hostId } = rig();
    const inputs: Event[] = [];
    bus.subscribe("chat.input", (e) => void inputs.push(e));
    fireJob({ bus, hostId }, job({ threadMode: "shared" }));
    fireJob({ bus, hostId }, job({ threadMode: "shared" }));
    expect(inputs[0]!.threadId).toBe("cron:j1");
    expect(inputs[1]!.threadId).toBe("cron:j1");
    expect(inputs[0]!.payload).toMatchObject({ disposableThread: false });
  });

  it("threadMode:'shared' keeps the old stable channel thread ids", () => {
    const { bus, hostId } = rig();
    const inputs: Event[] = [];
    bus.subscribe("chat.input", (e) => void inputs.push(e));
    fireJob({ bus, hostId }, job({ jobId: "d1", threadMode: "shared", deliver: { kind: "discord", channelId: "123" } }));
    fireJob({ bus, hostId }, job({ jobId: "t1", threadMode: "shared", deliver: { kind: "telegram", chatId: "456" } }));
    expect(inputs[0]!.threadId).toBe("discord:123:job:d1");
    expect(inputs[1]!.threadId).toBe("telegram:456:job:t1");
  });

  it("emits a durable schedule.fired audit event carrying the fired thread id", () => {
    const { bus, hostId } = rig();
    const fired: Event[] = [];
    bus.subscribe("schedule.fired", (e) => void fired.push(e));
    fireJob({ bus, hostId }, job());
    expect(fired).toHaveLength(1);
    expect(fired[0]!.durable).toBe(true);
    expect(fired[0]!.payload).toMatchObject({ jobId: "j1", agentId: "a1" });
    expect((fired[0]!.payload as { threadId: string }).threadId).toMatch(
      new RegExp(`^cron:j1:fire:${ULID}$`),
    );
  });
});

describe("fresh channel thread id — bridge parse contracts", () => {
  it("still matches CHANNEL_THREAD_PREFIX_RE (channelId) and the end-anchored :job: jobId parse", () => {
    const { bus, hostId } = rig();
    const inputs: Event[] = [];
    bus.subscribe("chat.input", (e) => void inputs.push(e));
    fireJob({ bus, hostId }, job({ jobId: "d1", deliver: { kind: "discord", channelId: "123" } }));
    const threadId = inputs[0]!.threadId!;
    // Prefix parse (bridge routing): capture group 2 is the channelId.
    const prefix = CHANNEL_THREAD_PREFIX_RE.exec(threadId);
    expect(prefix?.[2]).toBe("123");
    // End-anchored jobId parse (cloned bridge delivery audit): the terminal
    // :job:<id> is the jobId, never the fireId.
    const jobMatch = /:job:([^:]+)$/.exec(threadId);
    expect(jobMatch?.[1]).toBe("d1");
  });
});

describe("createCronScheduler", () => {
  it("loadAndArm re-arms every cron row and lists them", () => {
    const { bus, store, hostId, seedAgent, seedCronRow } = rig();
    seedAgent("a1");
    seedCronRow("j1", "a1");
    seedCronRow("j2", "a1");
    const cron = createCronScheduler({ bus, store, hostId });
    const n = cron.loadAndArm();
    expect(n).toBe(2);
    expect(cron.list().map((j) => j.jobId).sort()).toEqual(["j1", "j2"]);
    cron.close();
  });

  it("arm is idempotent (disarm-first) — double-arm leaves one timer", () => {
    const { bus, store, hostId, seedAgent } = rig();
    seedAgent("a1");
    const cron = createCronScheduler({ bus, store, hostId });
    cron.arm(job());
    cron.arm(job());
    expect(cron.list()).toHaveLength(1);
    cron.close();
  });

  it("disarm stops a job", () => {
    const { bus, store, hostId, seedAgent } = rig();
    seedAgent("a1");
    const cron = createCronScheduler({ bus, store, hostId });
    cron.arm(job());
    cron.disarm("j1");
    expect(cron.list()).toHaveLength(0);
    cron.close();
  });

  it("does not fire on arm (skip-missed-while-down / no catch-up)", () => {
    const { bus, store, hostId, seedAgent } = rig();
    seedAgent("a1");
    const inputs: Event[] = [];
    bus.subscribe("chat.input", (e) => void inputs.push(e));
    const cron = createCronScheduler({ bus, store, hostId });
    // Even a once-a-minute schedule must not fire synchronously on arm.
    cron.arm(job({ jobId: "j1" }));
    expect(inputs).toHaveLength(0);
    cron.close();
  });

  it("arms live when a schedule.armed event lands for a persisted row", () => {
    const { bus, store, hostId, seedAgent, seedCronRow } = rig();
    seedAgent("a1");
    const cron = createCronScheduler({ bus, store, hostId });
    seedCronRow("j9", "a1");
    bus.publish({
      type: "schedule.armed",
      hostId,
      actorId: "a1",
      durable: true,
      payload: { jobId: "j9" },
    });
    expect(cron.list().map((j) => j.jobId)).toContain("j9");
    cron.close();
  });

  it("disarms live when a schedule.cancelled event lands", () => {
    const { bus, store, hostId, seedAgent } = rig();
    seedAgent("a1");
    const cron = createCronScheduler({ bus, store, hostId });
    cron.arm(job({ jobId: "j5" }));
    bus.publish({
      type: "schedule.cancelled",
      hostId,
      actorId: "a1",
      durable: true,
      payload: { jobId: "j5" },
    });
    expect(cron.list()).toHaveLength(0);
    cron.close();
  });
});

describe("parseCronConfig threadMode default", () => {
  // Insert a row with an arbitrary config and read it back parsed, so the test
  // exercises the real store round-trip (config JSON in, CronJob out).
  function parseWith(config: Record<string, unknown>): CronJob | null {
    const { store, seedAgent } = rig();
    seedAgent("a1");
    const id = ulid();
    store
      .insert(tables.triggers)
      .values({ id, agentId: "a1", type: "cron", config, scope: {}, createdAt: Date.now() })
      .run();
    const row = store.select().from(tables.triggers).where(eq(tables.triggers.id, id)).all()[0]!;
    return parseCronConfig(row);
  }

  const base = { cronExpr: "0 8 * * *", instruction: "post the digest", deliver: { kind: "cli" }, createdBy: "a1" };

  it("missing threadMode defaults to 'fresh' (retroactive, no migration)", () => {
    expect(parseWith(base)?.config.threadMode).toBe("fresh");
  });

  it("'shared' is preserved", () => {
    expect(parseWith({ ...base, threadMode: "shared" })?.config.threadMode).toBe("shared");
  });

  it("a garbage threadMode falls back to 'fresh'", () => {
    expect(parseWith({ ...base, threadMode: "nonsense" })?.config.threadMode).toBe("fresh");
  });
});
