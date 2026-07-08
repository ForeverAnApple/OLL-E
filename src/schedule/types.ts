// Standing-job types. A standing job is a cron'd natural-language
// instruction: the substrate fires deterministically (cron in code,
// delivery routed by kind); cognition happens only inside the turn the
// fire wakes. Jobs live in the existing `triggers` table as `type='cron'`
// rows with this config JSON — no new primitive, no migration.

import type { TriggerRow } from "../store/schema.ts";

/** Where a fired job's turn (and its reply) is routed. `cli` is the local
 *  terminal thread; `discord`/`telegram` route into a channel thread so the
 *  channel bridge delivers the agent's output with no prior inbound message. */
export type DeliverTarget =
  | { kind: "cli" }
  | { kind: "discord"; channelId: string }
  | { kind: "telegram"; chatId: string };

/** The shape stored in `triggers.config` for a standing job. */
export interface CronTriggerConfig {
  /** 5-field cron expression (minute hour dom month dow). Seconds are
   *  deliberately rejected — the finest useful granularity for a standing
   *  natural-language job is a minute. */
  cronExpr: string;
  instruction: string;
  deliver: DeliverTarget;
  /** IANA timezone (e.g. "America/New_York"). Omit for the host's local tz. */
  tz?: string;
  /** actorId that created the job — provenance for the audit trail. */
  createdBy: string;
}

/** A parsed, armable standing job: the triggers-row identity plus its
 *  validated config. */
export interface CronJob {
  jobId: string;
  agentId: string;
  config: CronTriggerConfig;
}

function isDeliverTarget(v: unknown): v is DeliverTarget {
  if (!v || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  switch (d.kind) {
    case "cli":
      return true;
    case "discord":
      return typeof d.channelId === "string" && d.channelId.length > 0;
    case "telegram":
      return typeof d.chatId === "string" && d.chatId.length > 0;
    default:
      return false;
  }
}

/** Row guard: fold a `triggers` row into a CronJob, or return null when the
 *  row isn't a well-formed standing job (wrong type, malformed config). The
 *  scheduler skips nulls so one bad row never blocks arming the rest. */
export function parseCronConfig(row: TriggerRow): CronJob | null {
  if (row.type !== "cron") return null;
  const c = row.config as Record<string, unknown> | null | undefined;
  if (!c || typeof c !== "object") return null;
  if (typeof c.cronExpr !== "string" || c.cronExpr.trim().length === 0) return null;
  if (typeof c.instruction !== "string" || c.instruction.trim().length === 0) return null;
  if (!isDeliverTarget(c.deliver)) return null;
  const config: CronTriggerConfig = {
    cronExpr: c.cronExpr,
    instruction: c.instruction,
    deliver: c.deliver,
    tz: typeof c.tz === "string" ? c.tz : undefined,
    createdBy: typeof c.createdBy === "string" ? c.createdBy : row.agentId,
  };
  return { jobId: row.id, agentId: row.agentId, config };
}
