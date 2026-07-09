import { expect, test, describe } from "bun:test";
import {
  renderCache,
  renderRuns,
  renderThreads,
  renderEvents,
  renderEventLine,
  type ObsRenderOpts,
} from "../src/cli/obs-render.ts";
import { makeColorer, vlen } from "../src/cli/render.ts";
import type {
  UsageStats,
  RunHistoryRow,
  ThreadInventoryRow,
  RecentEventRow,
} from "../src/observability/index.ts";

const ESC = /\x1b/;

/** Assert every rendered line fits the width and — under color:false — carries
 *  zero escape codes. The two invariants every renderer must hold. */
function assertLayout(rendered: string, width: number, color: boolean): void {
  for (const line of rendered.split("\n")) {
    expect(vlen(line)).toBeLessThanOrEqual(width);
    if (!color) expect(ESC.test(line)).toBe(false);
  }
}

function bothWidths(render: (opts: ObsRenderOpts) => string): void {
  for (const width of [60, 100]) {
    for (const color of [true, false]) {
      assertLayout(render({ width, color }), width, color);
    }
  }
}

const HOUR = 3_600_000;

// -------- cache --------

function usageFixture(): UsageStats {
  return {
    totals: {
      inputTokens: 1_200_000,
      outputTokens: 96_000,
      cacheReadTokens: 13_900_000,
      cacheCreationTokens: 620_000,
      totalTokens: 15_816_000,
      usdMicros: 2_410_000,
      cacheHitRatio: 13_900_000 / (13_900_000 + 1_200_000),
    },
    byModel: [
      {
        provider: "anthropic",
        model: "claude-opus-4-8",
        inputTokens: 1_100_000,
        outputTokens: 90_000,
        cacheReadTokens: 13_900_000,
        cacheCreationTokens: 600_000,
        totalTokens: 15_690_000,
        usdMicros: 1_980_000,
        cacheHitRatio: 13_900_000 / (13_900_000 + 1_100_000),
        calls: 2904,
        pricePosted: true,
      },
      {
        provider: "openai",
        model: "gpt-4o-mini",
        inputTokens: 100_000,
        outputTokens: 6_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 106_000,
        usdMicros: 430_000,
        cacheHitRatio: 0,
        calls: 40,
        pricePosted: false,
      },
    ],
    window: { since: Date.now() - 24 * HOUR },
    rows: 3481,
  };
}

describe("renderCache", () => {
  test("humanized headline, gloss, and per-model table", () => {
    const out = renderCache(usageFixture(), { width: 100, color: false });
    expect(out).toContain("olle cache");
    expect(out).toContain("92% hit"); // 13.9M / 15.1M rounds to 92%
    expect(out).toContain("13.9M read");
    expect(out).toContain("620k write");
    expect(out).toContain("1.2M fresh input");
    expect(out).toContain("anthropic/claude-opus-4-8");
    // OpenAI had real input but no reads → an honest "0% hit".
    expect(out).toContain("0% hit");
  });

  test("a model with no cache-eligible tokens shows '— hit', never a broken 0%", () => {
    const f = usageFixture();
    f.byModel[1]!.inputTokens = 0; // no input, no reads → caching N/A
    const out = renderCache(f, { width: 100, color: false });
    expect(out).toContain("— hit");
  });

  test("layout holds at 60 and 100, both color modes", () => {
    bothWidths((opts) => renderCache(usageFixture(), opts));
  });

  test("empty state names the fix, not a bare (none)", () => {
    const empty: UsageStats = {
      totals: usageFixture().totals,
      byModel: [],
      window: { since: undefined },
      rows: 0,
    };
    const out = renderCache(empty, { width: 80, color: false });
    expect(out).toContain("No cache activity recorded yet.");
    expect(out).toContain("olle chat");
    expect(ESC.test(out)).toBe(false);
    // Empty-state prose must fit the terminal too — it wraps, and the inline
    // command never breaks across a line.
    bothWidths((opts) => renderCache(empty, opts));
    for (const w of [60, 100]) {
      expect(renderCache({ ...empty, window: { since: undefined } }, { width: w, color: true })).toContain("olle chat");
    }
  });
});

// -------- runs --------

function runsFixture(): RunHistoryRow[] {
  const now = Date.now();
  return [
    {
      id: "01JRUN000000000000000SUCC",
      taskId: "01JTASKDIGEST0000000000000",
      agentId: "oz",
      hostId: "host1",
      status: "succeeded",
      startedAt: now - 2 * HOUR,
      endedAt: now - 2 * HOUR + 1200,
      durationMs: 1200,
      error: null,
    },
    {
      id: "01JRUN000000000000000FAIL",
      taskId: "01JTASKGHPOLL00000000000000",
      agentId: "oz",
      hostId: "host1",
      status: "failed",
      startedAt: now - 3 * HOUR,
      endedAt: now - 3 * HOUR + 840,
      durationMs: 840,
      error: "fetch failed: 404 not found for https://api.example.com/very/long/path/that/keeps/going",
    },
    {
      id: "01JRUN000000000000000RUNN",
      taskId: "01JTASKCRONSWEEP00000000000",
      agentId: "oz",
      hostId: "host1",
      status: "running",
      startedAt: now - 30_000,
      endedAt: null,
      durationMs: null,
      error: null,
    },
  ];
}

describe("renderRuns", () => {
  test("glyph rollup, humanized duration, relative age, clipped error", () => {
    const out = renderRuns(runsFixture(), { width: 100, color: false });
    expect(out).toContain("✓ 1 succeeded");
    expect(out).toContain("✗ 1 failed");
    expect(out).toContain("⏵ 1 running");
    expect(out).toContain("1.2s"); // 1200ms → 1.2s, not "1200ms"
    expect(out).toContain("840ms"); // sub-second keeps ms
    expect(out).toContain("2h"); // relative age, no ISO timestamp
    expect(out).not.toContain("T00:"); // no ISO date fragment
    expect(out).toContain("running");
  });

  test("layout holds at 60 and 100, both color modes (long error clips)", () => {
    bothWidths((opts) => renderRuns(runsFixture(), opts));
  });

  test("empty state names the fix", () => {
    const out = renderRuns([], { width: 80, color: false });
    expect(out).toContain("No task runs yet.");
    expect(out).toContain("olle chat");
    expect(ESC.test(out)).toBe(false);
    bothWidths((opts) => renderRuns([], opts));
    // The command must survive wrapping intact at every width.
    for (const w of [60, 100]) expect(renderRuns([], { width: w, color: false })).toContain("olle chat");
  });
});

// -------- threads --------

function threadsFixture(): ThreadInventoryRow[] {
  const now = Date.now();
  return [
    {
      threadId: "cli:a3f9c2d1e0",
      toAgentId: "oz",
      events: 24,
      turns: 8,
      contextTokens: 42_000,
      lastHlc: "2",
      lastEventAt: now - 2 * HOUR,
      lastType: "chat.turn-end",
      firstUserText: "help me draft the launch email\nwith a punchy subject",
      cacheHitRatio: 0.88,
    },
    {
      threadId: "mailbox:oz00000000",
      toAgentId: "oz",
      events: 2,
      turns: 0,
      contextTokens: 0,
      lastHlc: "1",
      lastEventAt: now - 24 * HOUR,
      lastType: "decision.resolved",
      firstUserText: null,
      cacheHitRatio: 0,
    },
  ];
}

describe("renderThreads", () => {
  test("opening-line snippet, context tokens, age, hit, short id", () => {
    const out = renderThreads(threadsFixture(), { width: 100, color: false });
    expect(out).toContain('"help me draft the launch email with a punchy subject"');
    expect(out).toContain("42k ctx");
    expect(out).toContain("88% hit");
    expect(out).toContain("cli:a3f9c2"); // short id, not the full thread id
    // No user text + no turns → muted fallbacks, never a broken "0%".
    expect(out).toContain("decision.resolved");
    expect(out).toContain("— hit");
    expect(out).toContain("— ctx");
  });

  test("layout holds at 60 and 100, both color modes", () => {
    bothWidths((opts) => renderThreads(threadsFixture(), opts));
  });

  test("empty state names the fix", () => {
    const out = renderThreads([], { width: 80, color: false });
    expect(out).toContain("No conversations yet.");
    expect(out).toContain("olle chat");
    expect(ESC.test(out)).toBe(false);
    bothWidths((opts) => renderThreads([], opts));
    for (const w of [60, 100]) expect(renderThreads([], { width: w, color: false })).toContain("olle chat");
  });
});

// -------- events / tail --------

function eventsFixture(): RecentEventRow[] {
  const now = Date.now();
  return [
    {
      id: "01JEV0000000000000000CHAT",
      hlc: "3",
      type: "chat.turn-end",
      actorId: "oz",
      toAgentId: "oz",
      threadId: "cli:a3f9",
      parentEventId: null,
      createdAt: now - 45_000,
      payload: { inputTokens: 1234, text: "here is the draft" },
    },
    {
      id: "01JEV0000000000000000SCHE",
      hlc: "2",
      type: "schedule.fired",
      actorId: "01JAGENTOZ0000000000000000",
      toAgentId: null,
      threadId: null,
      parentEventId: null,
      createdAt: now - 2 * HOUR,
      payload: { jobId: "j1", standingJob: true },
    },
    {
      id: "01JEV0000000000000000TRUN",
      hlc: "1",
      type: "mesh.claim-split-brain",
      actorId: "peer2",
      toAgentId: null,
      threadId: null,
      parentEventId: null,
      createdAt: now - 3 * HOUR,
      payload: { _truncated: true, _bytes: 90000, _preview: "{\"events\":[{\"id\":\"01J" },
    },
  ];
}

describe("renderEvents / renderEventLine", () => {
  test("relative age, family-colored type, short actor, single-line payload", () => {
    const out = renderEvents(eventsFixture(), { width: 100, color: false });
    expect(out).toContain("olle events");
    expect(out).toContain("chat.turn-end");
    expect(out).toContain("schedule.fired");
    expect(out).toContain("01JAGENTOZ"); // long actor id shortened to 10 chars
    expect(out).not.toContain("01JAGENTOZ0"); // ...and not the full ulid
    // Payload rendered on one line — no embedded newline in any body line.
    for (const line of out.split("\n")) expect(line).not.toContain("\n");
  });

  test("tail and events share the identical per-line renderer", () => {
    const C = makeColorer(false);
    const ev = eventsFixture()[0]!;
    const fromEvents = renderEvents([ev], { width: 100, color: false }).split("\n").at(-1);
    const fromTail = renderEventLine(C, ev, 100);
    expect(fromEvents).toBe(fromTail);
  });

  test("truncated-marker payload renders as a clipped preview", () => {
    const C = makeColorer(false);
    const trunc = eventsFixture()[2]!;
    const line = renderEventLine(C, trunc, 120);
    expect(line).toContain("mesh.claim-split");
    expect(line).toContain("events");
  });

  test("layout holds at 60 and 100, both color modes", () => {
    bothWidths((opts) => renderEvents(eventsFixture(), opts));
  });

  test("per-line renderer never exceeds width", () => {
    const C = makeColorer(false);
    for (const width of [60, 80, 100]) {
      for (const ev of eventsFixture()) {
        expect(vlen(renderEventLine(C, ev, width))).toBeLessThanOrEqual(width);
      }
    }
  });

  test("empty state names the fix", () => {
    const out = renderEvents([], { width: 80, color: false });
    expect(out).toContain("No events match yet.");
    expect(out).toContain("olle tail");
    expect(ESC.test(out)).toBe(false);
    bothWidths((opts) => renderEvents([], opts));
    for (const w of [60, 100]) {
      expect(renderEvents([], { width: w, color: false })).toContain("olle tail");
      expect(renderEvents([], { width: w, color: false })).toContain("olle events --since 7d");
    }
  });
});
