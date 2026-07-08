// Cron subsystem — the deterministic half of a standing job.
//
// Determinism lives here: croner fires on schedule, `fireJob` publishes a
// durable `chat.input` onto the job's thread, and the agent's turn (the
// only stochastic part) runs downstream. The scheduler owns arming; the
// `schedule_*` tools own the row. They couple through the bus, not a shared
// handle: the tool publishes `schedule.armed`/`schedule.cancelled`, this
// scheduler subscribes and arms/disarms live — so a job scheduled mid-run
// starts firing without a daemon restart.
//
// Misfire policy: skip-missed-while-down. Arming computes the next FUTURE
// fire; a daemon that was asleep across a scheduled time does not replay it.

import { Cron } from "croner";
import type { EventBus } from "../bus/index.ts";
import type { Store } from "../store/db.ts";
import { tables } from "../store/index.ts";
import { eq } from "drizzle-orm";
import { jobThreadId } from "./thread.ts";
import { parseCronConfig, type CronJob } from "./types.ts";

export interface CronSchedulerDeps {
  bus: EventBus;
  store: Store;
  hostId: string;
}

export interface ArmedJob {
  jobId: string;
  agentId: string;
  cronExpr: string;
  nextRun: Date | null;
}

export interface CronScheduler {
  /** Read every `type='cron'` trigger row and arm it. Call once at daemon
   *  startup. Returns the count armed. */
  loadAndArm(): number;
  /** Arm (or re-arm) a single job. Disarm-first, so calling it twice on the
   *  same job leaves exactly one live timer. */
  arm(job: CronJob): void;
  /** Stop and drop a job's timer. No-op if not armed. */
  disarm(jobId: string): void;
  /** Snapshot of currently-armed jobs with their next fire time. */
  list(): ArmedJob[];
  /** Stop every timer and unsubscribe from the bus. */
  close(): void;
}

/** Publish the events a fired job produces: the durable `chat.input` that
 *  wakes the agent on the job's thread (mirroring the mail-wake seam in
 *  src/agent/chat.ts), plus a durable `schedule.fired` audit event.
 *
 *  Exported standalone so tests drive a fire without waiting on a timer. */
export function fireJob(deps: { bus: EventBus; hostId: string }, job: CronJob): void {
  const threadId = jobThreadId(job.config.deliver, job.jobId);
  deps.bus.publish({
    type: "chat.input",
    hostId: deps.hostId,
    actorId: deps.hostId,
    durable: true,
    toAgentId: job.agentId,
    threadId,
    payload: { text: job.config.instruction, standingJob: true, jobId: job.jobId },
  });
  deps.bus.publish({
    type: "schedule.fired",
    hostId: deps.hostId,
    actorId: deps.hostId,
    durable: true,
    payload: {
      jobId: job.jobId,
      agentId: job.agentId,
      threadId,
      cronExpr: job.config.cronExpr,
      deliver: job.config.deliver,
    },
  });
}

export function createCronScheduler(deps: CronSchedulerDeps): CronScheduler {
  const { bus, store, hostId } = deps;
  const armed = new Map<string, { job: CronJob; cron: Cron }>();

  function disarm(jobId: string): void {
    const entry = armed.get(jobId);
    if (!entry) return;
    entry.cron.stop();
    armed.delete(jobId);
  }

  function arm(job: CronJob): void {
    // Disarm-first keeps arm idempotent — no double-firing on re-arm.
    disarm(job.jobId);
    const options = job.config.tz ? { timezone: job.config.tz } : undefined;
    // croner computes the next future run at construction; it never fires
    // for a scheduled time that already passed while the daemon was down.
    const cron = new Cron(job.config.cronExpr, options, () => fireJob({ bus, hostId }, job));
    armed.set(job.jobId, { job, cron });
  }

  function loadAndArm(): number {
    const rows = store
      .select()
      .from(tables.triggers)
      .where(eq(tables.triggers.type, "cron"))
      .all();
    let n = 0;
    for (const row of rows) {
      const job = parseCronConfig(row);
      if (!job) continue;
      arm(job);
      n += 1;
    }
    return n;
  }

  function list(): ArmedJob[] {
    return [...armed.values()].map(({ job, cron }) => ({
      jobId: job.jobId,
      agentId: job.agentId,
      cronExpr: job.config.cronExpr,
      nextRun: cron.nextRun(),
    }));
  }

  // Live coupling to the tool surface. schedule_task publishes schedule.armed
  // {jobId} after inserting the row; we load the row and arm. schedule_cancel
  // publishes schedule.cancelled {jobId} after deleting; we disarm.
  const unsubArmed = bus.subscribe<{ jobId?: string }>("schedule.armed", (ev) => {
    const jobId = ev.payload?.jobId;
    if (!jobId) return;
    const row = store
      .select()
      .from(tables.triggers)
      .where(eq(tables.triggers.id, jobId))
      .all()[0];
    if (!row) return;
    const job = parseCronConfig(row);
    if (job) arm(job);
  });
  const unsubCancelled = bus.subscribe<{ jobId?: string }>("schedule.cancelled", (ev) => {
    const jobId = ev.payload?.jobId;
    if (jobId) disarm(jobId);
  });

  function close(): void {
    unsubArmed();
    unsubCancelled();
    for (const { cron } of armed.values()) cron.stop();
    armed.clear();
  }

  return { loadAndArm, arm, disarm, list, close };
}
