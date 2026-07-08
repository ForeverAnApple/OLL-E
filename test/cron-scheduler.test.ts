import { describe, expect, it } from "bun:test";
import { createBus, persistToStore, type Event } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import { createCronScheduler, fireJob, type CronJob } from "../src/schedule/index.ts";

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

function job(overrides: Partial<CronJob> & { deliver?: CronJob["config"]["deliver"] } = {}): CronJob {
  return {
    jobId: overrides.jobId ?? "j1",
    agentId: overrides.agentId ?? "a1",
    config: {
      cronExpr: "0 8 * * *",
      instruction: "post the digest",
      deliver: overrides.deliver ?? { kind: "cli" },
      createdBy: "a1",
    },
  };
}

describe("fireJob", () => {
  it("publishes a durable chat.input on the cli thread with the standing-job payload", () => {
    const { bus, hostId } = rig();
    const inputs: Event[] = [];
    bus.subscribe("chat.input", (e) => void inputs.push(e));
    fireJob({ bus, hostId }, job());
    expect(inputs).toHaveLength(1);
    const ev = inputs[0]!;
    expect(ev.threadId).toBe("cron:j1");
    expect(ev.toAgentId).toBe("a1");
    expect(ev.actorId).toBe(hostId);
    expect(ev.durable).toBe(true);
    expect(ev.payload).toMatchObject({ text: "post the digest", standingJob: true, jobId: "j1" });
  });

  it("routes discord and telegram deliveries onto channel threads", () => {
    const { bus, hostId } = rig();
    const inputs: Event[] = [];
    bus.subscribe("chat.input", (e) => void inputs.push(e));
    fireJob({ bus, hostId }, job({ jobId: "d1", deliver: { kind: "discord", channelId: "123" } }));
    fireJob({ bus, hostId }, job({ jobId: "t1", deliver: { kind: "telegram", chatId: "456" } }));
    expect(inputs[0]!.threadId).toBe("discord:123:job:d1");
    expect(inputs[1]!.threadId).toBe("telegram:456:job:t1");
  });

  it("emits a durable schedule.fired audit event", () => {
    const { bus, hostId } = rig();
    const fired: Event[] = [];
    bus.subscribe("schedule.fired", (e) => void fired.push(e));
    fireJob({ bus, hostId }, job());
    expect(fired).toHaveLength(1);
    expect(fired[0]!.durable).toBe(true);
    expect(fired[0]!.payload).toMatchObject({ jobId: "j1", agentId: "a1", threadId: "cron:j1" });
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
