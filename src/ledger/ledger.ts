// Spend ledger. Records token usage per LLM call (and, eventually, paid
// tool calls) with full attribution: actor, thread, provider, model.
//
// Tokens-only at the row level (LOG 2026-04-24). USD is a derivation —
// computed from current prices via src/llm/pricing.ts when needed. The
// budget is the one place we DO snapshot USD: applyToBudget() prices the
// spend at decrement time and accumulates into budgets.spent_usd, so the
// running cap-comparison stays meaningful even when prices shift.

import type { EventBus } from "../bus/index.ts";
import type { Store } from "../store/db.ts";
import { tables } from "../store/index.ts";
import { encodeStamp, createClock, ulid, type HlcClock } from "../id/index.ts";
import { priceTokens } from "../llm/pricing.ts";
import { and, eq } from "drizzle-orm";

export interface SpendInput {
  actorId: string;
  /** Thread the spend belongs to. Mailbox drainer's per-thread loop is
   *  the natural locus for "did THIS conversation reuse its prefix?"
   *  questions, so threadId rides on every ledger row when known. */
  threadId?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  toolCallId?: string;
  /** Agent who owns the budget envelope (typically the human — an
   *  `owns_money` agent). If omitted, no budget enforcement — the spend
   *  is still recorded for audit. */
  ownerAgentId?: string;
  /** Budget period key. Defaults to "all-time". */
  period?: string;
}

export interface LedgerOptions {
  bus: EventBus;
  store: Store;
  hostId: string;
  clock?: HlcClock;
}

export interface Ledger {
  record(input: SpendInput): { ledgerId: string; usdMicros: number; overBudget: boolean };
}

const THRESHOLDS = [0.8, 1.0] as const;

export function createLedger(opts: LedgerOptions): Ledger {
  const clock = opts.clock ?? createClock();

  function record(input: SpendInput): { ledgerId: string; usdMicros: number; overBudget: boolean } {
    const now = Date.now();
    const ledgerId = ulid(now);
    const cacheRead = input.cacheReadTokens ?? 0;
    const cacheCreation = input.cacheCreationTokens ?? 0;
    opts.store
      .insert(tables.ledger)
      .values({
        id: ledgerId,
        hlc: encodeStamp(clock.now()),
        hostId: opts.hostId,
        actorId: input.actorId,
        threadId: input.threadId,
        provider: input.provider,
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        toolCallId: input.toolCallId,
        at: now,
      })
      .run();

    // USD is computed at apply time, at the rate in effect for this
    // spend's timestamp (= now; record() runs as the turn ends). We
    // return it so callers (chat loop, future paid-tool wrappers) can
    // surface "this turn cost ~$X" without re-pricing themselves.
    const usdMicros = priceTokens(
      input.provider,
      input.model,
      {
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: cacheCreation,
      },
      now,
    );

    let overBudget = false;
    if (input.ownerAgentId) {
      overBudget = applyToBudget(opts, input, usdMicros, now);
    }
    return { ledgerId, usdMicros, overBudget };
  }

  return { record };
}

function applyToBudget(
  opts: LedgerOptions,
  input: SpendInput,
  usdMicros: number,
  now: number,
): boolean {
  const period = input.period ?? "all-time";
  const existing = opts.store
    .select()
    .from(tables.budgets)
    .where(
      and(
        eq(tables.budgets.ownerAgentId, input.ownerAgentId!),
        eq(tables.budgets.agentId, input.actorId),
        eq(tables.budgets.period, period),
      ),
    )
    .all();
  if (existing.length === 0) return false;
  const b = existing[0]!;
  // Token side: simple sum of everything the agent moved through the
  // model this call. Cache reads still count as tokens served, even if
  // they're cheap on the dollar side.
  const totalTokens =
    input.inputTokens +
    input.outputTokens +
    (input.cacheReadTokens ?? 0) +
    (input.cacheCreationTokens ?? 0);
  const beforeTokens = b.spentTokens;
  const beforeUsd = b.spentUsd;
  const afterTokens = beforeTokens + totalTokens;
  const afterUsd = beforeUsd + usdMicros;

  opts.store
    .update(tables.budgets)
    .set({
      spentTokens: afterTokens,
      spentUsd: afterUsd,
      updatedAt: now,
    })
    .where(eq(tables.budgets.id, b.id))
    .run();

  // Threshold crossings — emit budget events once per crossing.
  if (b.capUsd != null && b.capUsd > 0) {
    for (const t of THRESHOLDS) {
      const boundary = b.capUsd * t;
      if (beforeUsd < boundary && afterUsd >= boundary) {
        opts.bus.publish({
          type: t >= 1 ? "budget.exceeded" : "budget.threshold",
          hostId: opts.hostId,
          actorId: input.actorId,
          durable: true,
          payload: {
            ownerAgentId: input.ownerAgentId,
            agentId: input.actorId,
            period,
            threshold: t,
            capUsd: b.capUsd,
            spentUsd: afterUsd,
          },
        });
      }
    }
  }

  const over = b.capUsd != null ? afterUsd > b.capUsd : false;
  return over;
}
