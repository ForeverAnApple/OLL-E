import type { EventBus } from "../bus/index.ts";
import type { Store } from "../store/db.ts";
import { tables } from "../store/index.ts";
import { encodeStamp, createClock, ulid, type HlcClock } from "../id/index.ts";
import { and, eq } from "drizzle-orm";

export interface SpendInput {
  actorId: string;
  provider: string;
  model: string;
  tokens: number;
  /** micro-USD (1_000_000 = $1) */
  usd: number;
  toolCallId?: string;
  /** Principal who owns the budget. If omitted, no budget enforcement — the
   *  spend is still recorded for audit. */
  principalId?: string;
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
  record(input: SpendInput): { ledgerId: string; overBudget: boolean };
}

const THRESHOLDS = [0.8, 1.0] as const;

export function createLedger(opts: LedgerOptions): Ledger {
  const clock = opts.clock ?? createClock();

  function record(input: SpendInput): { ledgerId: string; overBudget: boolean } {
    const now = Date.now();
    const ledgerId = ulid(now);
    opts.store
      .insert(tables.ledger)
      .values({
        id: ledgerId,
        hlc: encodeStamp(clock.now()),
        hostId: opts.hostId,
        actorId: input.actorId,
        provider: input.provider,
        model: input.model,
        tokens: input.tokens,
        usd: input.usd,
        toolCallId: input.toolCallId,
        at: now,
      })
      .run();

    let overBudget = false;
    if (input.principalId) {
      overBudget = applyToBudget(opts, input, now);
    }
    return { ledgerId, overBudget };
  }

  return { record };
}

function applyToBudget(opts: LedgerOptions, input: SpendInput, now: number): boolean {
  const period = input.period ?? "all-time";
  const existing = opts.store
    .select()
    .from(tables.budgets)
    .where(
      and(
        eq(tables.budgets.principalId, input.principalId!),
        eq(tables.budgets.agentId, input.actorId),
        eq(tables.budgets.period, period),
      ),
    )
    .all();
  if (existing.length === 0) return false;
  const b = existing[0]!;
  const beforeTokens = b.spentTokens;
  const beforeUsd = b.spentUsd;
  const afterTokens = beforeTokens + input.tokens;
  const afterUsd = beforeUsd + input.usd;

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
            principalId: input.principalId,
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
