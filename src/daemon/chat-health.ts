// Chat health monitor — converts repeated chat.error into an inbox item.
//
// When `olle chat` 400s on every turn (today's bug pattern: provider
// rejects the request because of a structural problem in our tool list
// or prompt), the agent has no surface to propose a fix — chat is the
// agent's mouth. Mirroring the extension auto-disable rule (2 failures
// in a 5-minute window), this watcher posts a "chat is failing" inbox
// item so the principal hears via whatever inbox channel is up, even
// when chat itself is dead.
//
// Single proposal per outage: once an inbox item is posted we don't
// post again until either (a) a chat.turn-end fires (chat recovered),
// or (b) the time window slides past the last failure. The pattern
// matches the extension breaker — "tell once, don't spam."

import type { EventBus } from "../bus/index.ts";
import type { Inbox } from "../inbox/index.ts";

const DEFAULT_THRESHOLD = 2;
const DEFAULT_WINDOW_MS = 5 * 60_000;

export interface ChatHealthOptions {
  bus: EventBus;
  inbox: Inbox;
  hostId: string;
  principalId: string;
  agentId: string;
  /** Failure count within the window that triggers a proposal. Default 2. */
  threshold?: number;
  /** Sliding window in ms. Default 5 minutes. */
  windowMs?: number;
}

export interface ChatHealthMonitor {
  stop(): void;
}

export function startChatHealthMonitor(opts: ChatHealthOptions): ChatHealthMonitor {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  // Per-thread error timestamps so a flood on one bad thread doesn't
  // mask a separate problem on another.
  const failures = new Map<string, number[]>();
  // Per-thread "we already paged about this outage" flag — cleared on
  // the next chat.turn-end for that thread.
  const proposed = new Set<string>();

  const unErr = opts.bus.subscribe("chat.error", (ev) => {
    if (ev.actorId !== opts.agentId) return;
    const threadId = ev.threadId ?? "_no-thread_";
    const now = Date.now();
    const window = (failures.get(threadId) ?? []).filter((t) => now - t < windowMs);
    window.push(now);
    failures.set(threadId, window);
    if (window.length < threshold) return;
    if (proposed.has(threadId)) return;
    proposed.add(threadId);

    const errPayload = ev.payload as { error?: string };
    try {
      opts.inbox.propose({
        principalId: opts.principalId,
        // The chat agent observed itself failing. `decisions.proposing_agent_id`
        // is FK'd to `agents`, so we can't use hostId here even though
        // the watcher lives in daemon code.
        proposingAgentId: opts.agentId,
        tier: "vision",
        summary: `chat agent failing (${window.length}× in ${Math.round(windowMs / 60000)}m)`,
        payload: {
          action: "system_diagnostic",
          kind: "chat-failure",
          agentId: opts.agentId,
          threadId,
          lastError: errPayload?.error ?? "(unknown)",
          recovery:
            "Inspect recent commits: `git log --oneline -20`. Boot invariants are checked at daemon start; a failure that lands here means the breakage is provider-side or runtime — try `olle inbox`, restart the daemon, and revert the most recent core change if the loop reproduces.",
        },
        rollbackPlan: "git log --oneline -20",
      });
    } catch {
      /* best-effort — we never want the watcher itself to throw */
    }
  });

  const unEnd = opts.bus.subscribe("chat.turn-end", (ev) => {
    if (ev.actorId !== opts.agentId) return;
    const threadId = ev.threadId ?? "_no-thread_";
    failures.delete(threadId);
    proposed.delete(threadId);
  });

  return {
    stop: () => {
      unErr();
      unEnd();
    },
  };
}
