// Budget cap upsert — the write half of the budget surface (the read half
// is observability.budgetStatus; the decrement half is ledger.applyToBudget).
// One row per (ownerAgentId, agentId, period); setting a cap on an existing
// row preserves its accumulated spend — a cap change is a policy change,
// not an amnesty.

import { and, eq, isNull } from "drizzle-orm";
import type { Store } from "../store/db.ts";
import { tables } from "../store/index.ts";
import { ulid } from "../id/index.ts";

export interface SetBudgetInput {
  /** The owns-money agent whose real dollars back this envelope. */
  ownerAgentId: string;
  /** The agent being capped. Omit to cap the owner's direct spend row. */
  agentId?: string;
  /** Defaults to "all-time" — the only period the decrement path keys on
   *  today (ledger.record passes no period). */
  period?: string;
  /** Cap in micro-USD. null clears the USD cap. */
  capUsdMicros?: number | null;
  /** Cap in tokens. null clears the token cap. */
  capTokens?: number | null;
}

export interface SetBudgetResult {
  id: string;
  ownerAgentId: string;
  agentId: string | null;
  period: string;
  capUsdMicros: number | null;
  capTokens: number | null;
  spentUsdMicros: number;
  spentTokens: number;
  created: boolean;
}

export function setBudget(store: Store, input: SetBudgetInput): SetBudgetResult {
  const period = input.period ?? "all-time";
  const agentId = input.agentId ?? null;
  const now = Date.now();
  const existing = store
    .select()
    .from(tables.budgets)
    .where(
      and(
        eq(tables.budgets.ownerAgentId, input.ownerAgentId),
        agentId === null ? isNull(tables.budgets.agentId) : eq(tables.budgets.agentId, agentId),
        eq(tables.budgets.period, period),
      ),
    )
    .all();

  if (existing.length > 0) {
    const b = existing[0]!;
    const capUsd = input.capUsdMicros === undefined ? b.capUsd : input.capUsdMicros;
    const capTokens = input.capTokens === undefined ? b.capTokens : input.capTokens;
    store
      .update(tables.budgets)
      .set({ capUsd, capTokens, updatedAt: now })
      .where(eq(tables.budgets.id, b.id))
      .run();
    return {
      id: b.id,
      ownerAgentId: b.ownerAgentId,
      agentId: b.agentId,
      period,
      capUsdMicros: capUsd,
      capTokens,
      spentUsdMicros: b.spentUsd,
      spentTokens: b.spentTokens,
      created: false,
    };
  }

  const id = ulid(now);
  store
    .insert(tables.budgets)
    .values({
      id,
      ownerAgentId: input.ownerAgentId,
      agentId,
      period,
      capUsd: input.capUsdMicros ?? null,
      capTokens: input.capTokens ?? null,
      spentTokens: 0,
      spentUsd: 0,
      updatedAt: now,
    })
    .run();
  return {
    id,
    ownerAgentId: input.ownerAgentId,
    agentId,
    period,
    capUsdMicros: input.capUsdMicros ?? null,
    capTokens: input.capTokens ?? null,
    spentUsdMicros: 0,
    spentTokens: 0,
    created: true,
  };
}
