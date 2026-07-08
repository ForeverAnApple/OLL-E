// Thread-id contract for standing jobs. One source of truth shared by the
// tool (which stores nothing thread-side), the scheduler (which fires onto
// the thread), and the channel bridges (which route the resulting turn's
// output back out). Get this wrong and a fired job's reply lands nowhere.

import type { DeliverTarget } from "./types.ts";

/** The thread a fired job runs on. `cli` jobs get a private `cron:<jobId>`
 *  thread; channel jobs encode the destination in the thread id so the
 *  bridge can route delivery from the id alone, with no prior inbound
 *  message on the thread. */
export function jobThreadId(deliver: DeliverTarget, jobId: string): string {
  switch (deliver.kind) {
    case "discord":
      return `discord:${deliver.channelId}:job:${jobId}`;
    case "telegram":
      return `telegram:${deliver.chatId}:job:${jobId}`;
    case "cli":
    default:
      return `cron:${jobId}`;
  }
}

/** Loose channel-prefix contract. Any thread id of the form
 *  `<channel>:<id>:...` (channel ∈ {discord, telegram}) is a channel-routed
 *  thread whose destination id is capture group 2 — whether or not it was
 *  minted by `jobThreadId`. Bridges use this to deliver channel-only (no
 *  reply_to) for threads they have no stored inbound route for. Kept
 *  deliberately permissive so a channel bridge and the scheduler agree on
 *  one parse without importing each other's internals. */
export const CHANNEL_THREAD_PREFIX_RE = /^(discord|telegram):([^:]+):/;

export interface ChannelThreadRoute {
  channel: "discord" | "telegram";
  /** channelId for discord, chatId for telegram. */
  id: string;
}

/** Parse a channel-routed thread id to its {channel, id}, or null when the
 *  id doesn't carry the channel prefix. */
export function parseChannelThread(threadId: string): ChannelThreadRoute | null {
  const m = CHANNEL_THREAD_PREFIX_RE.exec(threadId);
  if (!m) return null;
  return { channel: m[1] as "discord" | "telegram", id: m[2]! };
}
