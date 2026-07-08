// Standing-job tools — the agent's front door to the cron subsystem.
//
// These are validating front doors (per src/tools/model.ts): all shape and
// sanity checks live inside execute, close to the write. A standing job is a
// cron'd natural-language instruction — the agent describes what it wants to
// happen on a schedule ("post yesterday's unread digest to #daily"), and the
// substrate fires it deterministically, waking a fresh turn each time. Jobs
// are stored as `type='cron'` rows in the `triggers` table; arming happens in
// the cron scheduler, coupled through the `schedule.armed`/`schedule.cancelled`
// events these tools publish.

import { Cron } from "croner";
import { eq, and } from "drizzle-orm";
import type { EventBus } from "../bus/index.ts";
import type { Store } from "../store/db.ts";
import { tables } from "../store/index.ts";
import { ulid } from "../id/index.ts";
import type { ToolDef } from "../extensions/types.ts";
import type { CronTriggerConfig, DeliverTarget } from "../schedule/index.ts";

export interface ScheduleToolsOptions {
  bus: EventBus;
  store: Store;
  hostId: string;
}

/** Per-agent standing-job ceiling. Generous — the point is to catch runaway
 *  loops (an agent scheduling itself in a tight cycle), not to ration. */
const MAX_JOBS_PER_AGENT = 50;

interface ScheduleTaskArgs {
  cronExpr: string;
  instruction: string;
  deliver: DeliverTarget;
}

interface ScheduleTaskResult {
  jobId: string;
  nextRun: string | null;
}

interface ScheduleListRow {
  jobId: string;
  cronExpr: string;
  instruction: string;
  deliver: DeliverTarget;
  nextRun: string | null;
}

/** Validate + normalize a deliver target, throwing a precise error on the
 *  agent-facing surface so a bad shape is corrected in one turn. */
function validateDeliver(raw: unknown): DeliverTarget {
  if (!raw || typeof raw !== "object") {
    throw new Error("schedule_task: deliver is required — {kind:'cli'|'discord'|'telegram', ...}");
  }
  const d = raw as Record<string, unknown>;
  switch (d.kind) {
    case "cli":
      return { kind: "cli" };
    case "discord":
      if (typeof d.channelId !== "string" || d.channelId.trim().length === 0) {
        throw new Error("schedule_task: deliver.kind='discord' requires a non-empty channelId");
      }
      return { kind: "discord", channelId: d.channelId };
    case "telegram":
      if (typeof d.chatId !== "string" || d.chatId.trim().length === 0) {
        throw new Error("schedule_task: deliver.kind='telegram' requires a non-empty chatId");
      }
      return { kind: "telegram", chatId: d.chatId };
    default:
      throw new Error(
        `schedule_task: deliver.kind must be 'cli', 'discord', or 'telegram' (got ${JSON.stringify(d.kind)})`,
      );
  }
}

/** Reject anything but a valid 5-field cron. croner also accepts a 6-field
 *  (seconds) form; we reject it — a minute is the finest useful granularity
 *  for a natural-language standing job, and per-second wakeups would burn
 *  tokens. Returns the next fire time as a sanity check the expression is
 *  actually schedulable. */
function validateCron(expr: string): Date | null {
  const trimmed = expr.trim();
  if (trimmed.length === 0) throw new Error("schedule_task: cronExpr is required");
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `schedule_task: cronExpr must be 5 fields (minute hour day-of-month month day-of-week); got ${fields.length}. Seconds are not supported.`,
    );
  }
  try {
    return new Cron(trimmed).nextRun();
  } catch (err) {
    throw new Error(`schedule_task: invalid cronExpr "${trimmed}" — ${(err as Error).message}`);
  }
}

export function buildScheduleTools(opts: ScheduleToolsOptions): ToolDef[] {
  const { bus, store, hostId } = opts;

  const scheduleTask: ToolDef<ScheduleTaskArgs, ScheduleTaskResult> = {
    name: "schedule_task",
    tier: "operational",
    category: "scheduling",
    shortClause: "run a natural-language instruction on a repeating schedule",
    description:
      "Register a standing job: a cron'd natural-language instruction the substrate fires for you on a schedule, waking a fresh turn each time. Use this to make yourself useful without being prompted — a morning digest, a periodic check, a recurring nudge. `cronExpr` is a 5-field cron (minute hour day-of-month month day-of-week; e.g. '0 8 * * *' = 8am daily); seconds are not supported. `instruction` is what you'll be told to do when it fires — write it as a clear directive to your future self ('Summarize yesterday's unread items and post the digest'). `deliver` says where the resulting turn runs and its output lands: {kind:'cli'} for the local terminal, {kind:'discord', channelId} or {kind:'telegram', chatId} to post into a channel with no prior message needed. The job runs as you, on your budget and tools. Fires start at the next scheduled time — a job set at 7:59 for '0 8 * * *' fires at 8:00. Returns {jobId, nextRun}.",
    inputSchema: {
      type: "object",
      properties: {
        cronExpr: {
          type: "string",
          description:
            "5-field cron expression (minute hour day-of-month month day-of-week). Examples: '0 8 * * *' daily 8am; '*/30 * * * *' every 30 min; '0 9 * * 1' Mondays 9am.",
        },
        instruction: {
          type: "string",
          description:
            "What you'll be instructed to do when the job fires. Write it as a directive to your future self — it becomes the turn's input.",
        },
        deliver: {
          type: "object",
          description:
            "Where the fired turn runs and its output is delivered.",
          properties: {
            kind: { type: "string", enum: ["cli", "discord", "telegram"] },
            channelId: { type: "string", description: "Required when kind='discord'." },
            chatId: { type: "string", description: "Required when kind='telegram'." },
          },
          required: ["kind"],
          additionalProperties: false,
        },
      },
      required: ["cronExpr", "instruction", "deliver"],
      additionalProperties: false,
    },
    execute: (args, ctx) => {
      const instruction = typeof args.instruction === "string" ? args.instruction.trim() : "";
      if (!instruction) {
        throw new Error("schedule_task: instruction is required and must be non-empty");
      }
      const nextRun = validateCron(args.cronExpr);
      const deliver = validateDeliver(args.deliver);

      const existing = store
        .select({ id: tables.triggers.id })
        .from(tables.triggers)
        .where(and(eq(tables.triggers.agentId, ctx.actorId), eq(tables.triggers.type, "cron")))
        .all();
      if (existing.length >= MAX_JOBS_PER_AGENT) {
        throw new Error(
          `schedule_task: you already have ${existing.length} standing jobs (cap ${MAX_JOBS_PER_AGENT}). Cancel one with schedule_cancel before adding another.`,
        );
      }

      const jobId = ulid();
      const config: CronTriggerConfig = {
        cronExpr: args.cronExpr.trim(),
        instruction,
        deliver,
        createdBy: ctx.actorId,
      };
      store
        .insert(tables.triggers)
        .values({
          id: jobId,
          agentId: ctx.actorId,
          type: "cron",
          config: config as unknown as Record<string, unknown>,
          scope: {},
          createdAt: Date.now(),
        })
        .onConflictDoNothing()
        .run();

      // Wake the live cron scheduler (bus coupling — see src/schedule/cron.ts).
      bus.publish({
        type: "schedule.armed",
        hostId,
        actorId: ctx.actorId,
        durable: true,
        payload: { jobId, agentId: ctx.actorId, cronExpr: config.cronExpr, deliver },
      });

      return { jobId, nextRun: nextRun ? nextRun.toISOString() : null };
    },
  };

  const scheduleList: ToolDef<Record<string, never>, ScheduleListRow[]> = {
    name: "schedule_list",
    tier: "operational",
    category: "scheduling",
    shortClause: "list your standing jobs and their next fire times",
    description:
      "List the standing jobs you've scheduled — their cron expression, the instruction that fires, where they deliver, and when each next runs. Scoped to you; you only see your own jobs. Use before scheduling to avoid duplicates, or to find a jobId to cancel.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: (_args, ctx) => {
      const rows = store
        .select()
        .from(tables.triggers)
        .where(and(eq(tables.triggers.agentId, ctx.actorId), eq(tables.triggers.type, "cron")))
        .all();
      const out: ScheduleListRow[] = [];
      for (const row of rows) {
        const config = row.config as unknown as CronTriggerConfig;
        let nextRun: string | null = null;
        try {
          nextRun = new Cron(config.cronExpr).nextRun()?.toISOString() ?? null;
        } catch {
          // A row whose expression no longer parses shows up with nextRun
          // null rather than blocking the whole list.
        }
        out.push({
          jobId: row.id,
          cronExpr: config.cronExpr,
          instruction: config.instruction,
          deliver: config.deliver,
          nextRun,
        });
      }
      return out;
    },
  };

  const scheduleCancel: ToolDef<{ jobId: string }, { jobId: string; cancelled: boolean }> = {
    name: "schedule_cancel",
    tier: "operational",
    category: "scheduling",
    shortClause: "cancel one of your standing jobs by id",
    description:
      "Cancel a standing job you created. Deletes the job and stops future fires immediately. You can only cancel your own jobs. Get the jobId from schedule_list or the return of schedule_task.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "The job's id (from schedule_list or schedule_task)." },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
    execute: (args, ctx) => {
      const jobId = typeof args.jobId === "string" ? args.jobId.trim() : "";
      if (!jobId) throw new Error("schedule_cancel: jobId is required");
      const row = store
        .select()
        .from(tables.triggers)
        .where(eq(tables.triggers.id, jobId))
        .all()[0];
      if (!row || row.type !== "cron") {
        throw new Error(`schedule_cancel: no standing job ${jobId}`);
      }
      if (row.agentId !== ctx.actorId) {
        throw new Error(`schedule_cancel: job ${jobId} belongs to another agent — you can only cancel your own`);
      }
      store.delete(tables.triggers).where(eq(tables.triggers.id, jobId)).run();
      bus.publish({
        type: "schedule.cancelled",
        hostId,
        actorId: ctx.actorId,
        durable: true,
        payload: { jobId, agentId: ctx.actorId },
      });
      return { jobId, cancelled: true };
    },
  };

  return [scheduleTask, scheduleList, scheduleCancel];
}
