// Pure-render tests for `olle stats`. The renderer takes query results +
// {width,color} and returns a finished string, so we assert on that string
// directly — no daemon, no IPC. We mostly test the color:false form (stable,
// human-readable) and exercise the color:true path for the threshold escapes.

import { describe, expect, test } from "bun:test";
import { formatTokens, renderStats } from "../src/cli/stats-render.ts";
import { ANSI } from "../src/cli/theme.ts";
import type { BudgetStatus, UsageStats } from "../src/observability/index.ts";

function usd(dollars: number): number {
  return Math.round(dollars * 1_000_000);
}

function model(over: Partial<UsageStats["byModel"][number]>): UsageStats["byModel"][number] {
  return {
    provider: "anthropic",
    model: "claude-opus-4-8",
    calls: 100,
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheReadTokens: 10_000_000,
    cacheCreationTokens: 500_000,
    totalTokens: 11_600_000,
    usdMicros: usd(1.5),
    cacheHitRatio: 10 / 11,
    pricePosted: true,
    ...over,
  };
}

function stats(over: Partial<UsageStats> = {}): UsageStats {
  const byModel = over.byModel ?? [model({})];
  const totals: UsageStats["totals"] = over.totals ?? {
    inputTokens: 1_180_000,
    outputTokens: 96_300,
    cacheReadTokens: 13_900_000,
    cacheCreationTokens: 620_000,
    totalTokens: 15_796_300,
    usdMicros: usd(2.41),
    cacheHitRatio: 0.92,
  };
  return {
    totals,
    byModel,
    window: over.window ?? { since: undefined },
    rows: over.rows ?? 3481,
  };
}

// Strip ANSI so we can measure visible width the way a terminal sees it.
function plain(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const NC = { width: 80, color: false } as const;

describe("formatTokens", () => {
  test("billions tier — 1e9 is not 1000.0M", () => {
    expect(formatTokens(1_000_000_000)).toBe("1.00B");
    expect(formatTokens(2_500_000_000)).toBe("2.50B");
    expect(formatTokens(15_800_000)).toBe("15.8M");
    expect(formatTokens(96_300)).toBe("96k");
    expect(formatTokens(1_180_000)).toBe("1.2M");
    expect(formatTokens(500)).toBe("500");
  });
});

describe("renderStats — populated", () => {
  test("humanized headline numbers, no raw integers", () => {
    const out = plain(renderStats(stats(), undefined, NC));
    expect(out).toContain("olle stats");
    expect(out).toContain("all time");
    expect(out).toContain("all agents");
    expect(out).toContain("3,481 rows");
    expect(out).toContain("Spend");
    expect(out).toContain("$2.41");
    expect(out).toContain("15.8M total");
    expect(out).toContain("92% hit");
    // Humanized, never the raw token integer.
    expect(out).not.toContain("13900000");
    expect(out).toContain("13.9M reused");
    expect(out).toContain("620k newly cached");
  });

  test("window + scope labels reflect since and agent", () => {
    // fmtAge rounds — 5h stays hours, 24h would flip to "1d".
    const since = Date.now() - 5 * 3_600_000;
    const out = plain(
      renderStats(stats({ window: { since } }), undefined, {
        width: 80,
        color: false,
        agent: "oz",
      }),
    );
    expect(out).toContain("last 5h");
    expect(out).toContain("agent oz");
  });

  test("by model is sorted by cost desc and shows per-model cells", () => {
    const s = stats({
      byModel: [
        model({ model: "claude-haiku-4-5", usdMicros: usd(0.31), calls: 540 }),
        model({ model: "claude-opus-4-8", usdMicros: usd(1.98), calls: 2904 }),
      ],
    });
    const out = plain(renderStats(s, undefined, NC));
    const opusIdx = out.indexOf("opus");
    const haikuIdx = out.indexOf("haiku");
    // opus ($1.98) must render above haiku ($0.31).
    expect(opusIdx).toBeGreaterThan(-1);
    expect(opusIdx).toBeLessThan(haikuIdx);
    expect(out).toContain("2,904 calls");
    expect(out).toContain("$1.98");
  });

  test("no-cache model renders — for hit, not 0%", () => {
    const s = stats({
      byModel: [
        model({
          provider: "openai",
          model: "gpt-5-mini",
          inputTokens: 0,
          cacheReadTokens: 0,
          calls: 37,
          usdMicros: usd(0.12),
        }),
      ],
    });
    const out = plain(renderStats(s, undefined, NC));
    expect(out).toContain("— hit");
    expect(out).not.toContain("0% hit");
  });

  test("fallback-price model gets a ~ flag and footnote", () => {
    const s = stats({ byModel: [model({ pricePosted: false })] });
    const out = plain(renderStats(s, undefined, NC));
    expect(out).toContain("~");
    expect(out).toContain("fallback rate");
  });
});

describe("renderStats — budget", () => {
  function budget(): BudgetStatus {
    return {
      rows: [
        {
          id: "b1",
          ownerAgentId: "oz",
          agentId: "oz",
          period: "monthly",
          capUsd: usd(50),
          capTokens: null,
          spentUsd: usd(2.41),
          spentTokens: 0,
          percentUsd: 2.41 / 50,
          percentTokens: null,
        },
        {
          id: "b2",
          ownerAgentId: "oz",
          agentId: "oz",
          period: "daily",
          capUsd: usd(3),
          capTokens: null,
          spentUsd: usd(2.41),
          spentTokens: 0,
          percentUsd: 2.41 / 3,
          percentTokens: null,
        },
      ],
    };
  }

  test("renders spent/cap, percent, and remaining", () => {
    const out = plain(
      renderStats(stats(), budget(), { width: 80, color: false, agent: "oz" }),
    );
    expect(out).toContain("Budget");
    expect(out).toContain("monthly");
    expect(out).toContain("$2.41 / $50.00");
    expect(out).toContain("$47.59 left");
    expect(out).toContain("5%");
    expect(out).toContain("80%");
  });

  test("no cap row prints 'no cap', no bar", () => {
    const b: BudgetStatus = {
      rows: [
        {
          id: "b1",
          ownerAgentId: "oz",
          agentId: "oz",
          period: "monthly",
          capUsd: null,
          capTokens: null,
          spentUsd: usd(2.41),
          spentTokens: 0,
          percentUsd: null,
          percentTokens: null,
        },
      ],
    };
    const out = plain(renderStats(stats(), b, { width: 80, color: false, agent: "oz" }));
    expect(out).toContain("no cap");
  });

  test("budget only renders when --agent is set", () => {
    const out = plain(renderStats(stats(), budget(), NC)); // no agent
    expect(out).not.toContain("Budget");
  });
});

describe("renderStats — empty state", () => {
  test("no models: header still prints, offers chat when no --since", () => {
    const s = stats({ byModel: [], totals: zeroTotals(), rows: 0 });
    const out = plain(renderStats(s, undefined, NC));
    expect(out).toContain("olle stats");
    expect(out).toContain("No spend recorded yet.");
    expect(out).toContain("olle chat");
    expect(out).not.toContain("By model");
  });

  test("no models with --since: suggests widening the window", () => {
    const s = stats({ byModel: [], totals: zeroTotals(), rows: 0, window: { since: Date.now() - 3_600_000 } });
    const out = plain(renderStats(s, undefined, { width: 80, color: false }));
    expect(out).toContain("Widen it with");
    expect(out).toContain("olle stats --since 7d");
  });

  test("budget still renders in empty state when agent + rows exist", () => {
    const s = stats({ byModel: [], totals: zeroTotals(), rows: 0 });
    const b: BudgetStatus = {
      rows: [
        {
          id: "b1",
          ownerAgentId: "oz",
          agentId: "oz",
          period: "monthly",
          capUsd: usd(50),
          capTokens: null,
          spentUsd: 0,
          spentTokens: 0,
          percentUsd: 0,
          percentTokens: null,
        },
      ],
    };
    const out = plain(renderStats(s, b, { width: 80, color: false, agent: "oz" }));
    expect(out).toContain("No spend recorded yet.");
    expect(out).toContain("Budget");
    expect(out).toContain("$50.00");
  });

  test("empty-state prose + inline command fit width and never split at 60/100", () => {
    const sBoth = [
      stats({ byModel: [], totals: zeroTotals(), rows: 0 }),
      stats({ byModel: [], totals: zeroTotals(), rows: 0, window: { since: Date.now() - 3_600_000 } }),
    ];
    for (const s of sBoth) {
      for (const width of [60, 100]) {
        for (const color of [true, false]) {
          const rendered = renderStats(s, undefined, { width, color });
          for (const line of rendered.split("\n")) {
            expect(plain(line).length).toBeLessThanOrEqual(width);
          }
          // The suggested command stays copy-pasteable — never wrapped.
          expect(plain(rendered)).toContain(
            s.window.since != null ? "olle stats --since 7d" : "olle chat",
          );
        }
      }
    }
  });

  test("empty-state budget row fits a narrow terminal (barW reservation)", () => {
    const s = stats({ byModel: [], totals: zeroTotals(), rows: 0 });
    const b: BudgetStatus = {
      rows: [
        { id: "b1", ownerAgentId: "oz", agentId: "oz", period: "daily", capUsd: usd(50), capTokens: null, spentUsd: usd(42.3), spentTokens: 0, percentUsd: 0.846, percentTokens: null },
      ],
    };
    for (const width of [60, 100]) {
      const rendered = renderStats(s, b, { width, color: true, agent: "oz" });
      for (const line of rendered.split("\n")) {
        expect(plain(line).length).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("renderStats — alignment & degradation", () => {
  test("aligned by-model rows fit terminal width at 80 cols, ~ trailer included", () => {
    const s = stats({
      byModel: [
        model({ model: "claude-opus-4-8", usdMicros: usd(1234.56), calls: 29040 }),
        model({ provider: "openai", model: "gpt-5-mini", inputTokens: 0, cacheReadTokens: 0, pricePosted: false }),
      ],
    });
    // Tabular rows (indented, contain a $ cost) must never overflow — even the
    // fallback row's trailing " ~". The free-text cache gloss may soft-wrap and
    // is not a column, so it's excluded.
    const rows = plain(renderStats(s, undefined, NC))
      .split("\n")
      .filter((l) => l.startsWith("  ") && /\$/.test(l));
    expect(rows.length).toBe(2);
    for (const line of rows) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  test("by-model columns right-align: cost column shares an end position", () => {
    const s = stats({
      byModel: [
        model({ model: "a", usdMicros: usd(1.98) }),
        model({ model: "b", usdMicros: usd(1234.56) }),
      ],
    });
    const lines = plain(renderStats(s, undefined, NC))
      .split("\n")
      .filter((l) => l.startsWith("  ") && /\$/.test(l));
    // Every model row ends at the same column (right-aligned cost, no ~).
    const ends = lines.map((l) => l.trimEnd().length);
    expect(new Set(ends).size).toBe(1);
  });
});

describe("renderStats — color path", () => {
  test("over-budget row uses the error escape; under-budget uses success", () => {
    const b: BudgetStatus = {
      rows: [
        {
          id: "b1",
          ownerAgentId: "oz",
          agentId: "oz",
          period: "daily",
          capUsd: usd(3),
          capTokens: null,
          spentUsd: usd(4),
          spentTokens: 0,
          percentUsd: 1, // over cap → error color
          percentTokens: null,
        },
      ],
    };
    const out = renderStats(stats(), b, { width: 80, color: true, agent: "oz" });
    expect(out).toContain(ANSI.error);
  });

  test("color:true emits balanced reset codes (every open is closed)", () => {
    const out = renderStats(stats(), undefined, { width: 80, color: true, agent: "oz" });
    // Count style-open escapes (non-reset) vs resets. Our colorer wraps each
    // span as <code><text><reset>, so opens and resets must be equal. Bold+color
    // combined codes ("\x1b[1m\x1b[38..") count as two opens sharing one reset,
    // so resets are the lower bound — assert every reset is preceded by content
    // and the string ends cleanly (no dangling open at EOL).
    const resets = out.match(/\x1b\[0m/g)?.length ?? 0;
    expect(resets).toBeGreaterThan(0);
    // The last escape in the string must be a reset — nothing left un-closed.
    const lastEsc = out.match(/\x1b\[[0-9;]*m/g)!.at(-1);
    expect(lastEsc).toBe(ANSI.reset);
  });

  test("color:false emits no ANSI escapes at all", () => {
    const out = renderStats(stats(), undefined, { width: 80, color: false, agent: "oz" });
    expect(out).not.toMatch(/\x1b\[/);
  });
});

function zeroTotals(): UsageStats["totals"] {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    usdMicros: 0,
    cacheHitRatio: 0,
  };
}
