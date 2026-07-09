// Pure-render tests for `olle status` and `olle inspect agent`. The renderers
// take query results + {width,color,now} and return a finished string, so we
// assert on that string directly — no daemon, no IPC. We test the color:false
// form (stable, human-readable) plus a color:true smoke for escapes, and the
// invariants the visual language promises: humanized numbers, width-fit at 60
// and 100, zero escapes when color is off, humane empty states.

import { describe, expect, test } from "bun:test";
import {
  renderStatus,
  renderInspectAgent,
  type StatusData,
} from "../src/cli/status-render.ts";
import type { AgentSelf, UsageStats } from "../src/observability/index.ts";

function plain(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function usd(dollars: number): number {
  return Math.round(dollars * 1_000_000);
}

const NOW = 1_700_000_000_000;
const SINCE = NOW - 7 * 86_400_000;

function usage(over: Partial<UsageStats> = {}): UsageStats {
  return {
    totals: over.totals ?? {
      inputTokens: 1_180_000,
      outputTokens: 96_300,
      cacheReadTokens: 13_900_000,
      cacheCreationTokens: 620_000,
      totalTokens: 15_796_300,
      usdMicros: usd(2.41),
      cacheHitRatio: 0.92,
    },
    byModel: over.byModel ?? [
      {
        provider: "anthropic",
        model: "claude-opus-4-8",
        calls: 100,
        inputTokens: 1_180_000,
        outputTokens: 96_300,
        cacheReadTokens: 13_900_000,
        cacheCreationTokens: 620_000,
        totalTokens: 15_796_300,
        usdMicros: usd(2.41),
        cacheHitRatio: 0.92,
        pricePosted: true,
      },
    ],
    window: over.window ?? { since: SINCE },
    rows: over.rows ?? 3481,
  };
}

function self(over: Partial<AgentSelf> = {}): AgentSelf {
  return {
    agentId: "01J8ZK3P7QRSTUVWXYZ0123456",
    name: "oz",
    displayName: "Oz",
    hostId: "01J8ZK3HOSTABCDEF000000000",
    parentAgentId: null,
    systemPrompt: null,
    scope: { allowTiers: ["operational", "strategic"] },
    principleCount: 3,
    tools: [],
    recentlyPricedModels: [],
    thinkingModel: "claude-opus-4-8",
    thinkingModelIsDefault: false,
    reasoningEffort: "high",
    ...over,
  };
}

function baseData(over: Partial<StatusData> = {}): StatusData {
  return {
    host: over.host !== undefined ? over.host : { hostId: "01J8ZK3HOSTABCDEF000000000", pid: 40213, uptimeMs: 7_200_000 },
    chat: over.chat !== undefined ? over.chat : { enabled: true, reason: null },
    rootAgent: over.rootAgent !== undefined ? over.rootAgent : { rootAgentId: "01J8ZK3P7QRSTUVWXYZ0123456" },
    self: over.self !== undefined ? over.self : self(),
    exts: over.exts ?? [],
    usage: over.usage !== undefined ? over.usage : usage(),
    runs: over.runs ?? [],
    threads: over.threads ?? [],
    inbox: over.inbox ?? [],
    teams: over.teams ?? { teams: [] },
    sinceMs: over.sinceMs ?? SINCE,
  };
}

function run(data: StatusData, width: number, color = false): string {
  return renderStatus(data, { width, color, now: NOW });
}

const WIDTHS = [60, 100];

describe("renderStatus — populated", () => {
  test("humanized usage numbers, no raw key=value dump", () => {
    const s = plain(run(baseData(), 100));
    expect(s).toContain("Spend");
    expect(s).toContain("$2.41");
    expect(s).toContain("15.8M");
    expect(s).toContain("92%");
    // The old raw idiom is gone.
    expect(s).not.toContain("in=");
    expect(s).not.toContain("cache_r=");
    expect(s).not.toContain("cache_w=");
  });

  test("daemon block shows short host id, humanized uptime", () => {
    const s = plain(run(baseData(), 100));
    expect(s).toContain("host");
    expect(s).toContain("01J8ZK3HOS"); // 10-char short id
    expect(s).not.toContain("01J8ZK3HOSTABCDEF000000000"); // never the full ULID
    expect(s).toContain("2h"); // uptime humanized
    expect(s).toContain("enabled");
  });

  test("agent summary: principles + ext tools + model + effort", () => {
    const s = plain(run(baseData({ self: self({ tools: [{ name: "a", extensionId: "x" }, { name: "b", extensionId: "x" }] }) }), 100));
    expect(s).toContain("oz / Oz");
    expect(s).toContain("3 principles · 2 ext tools");
    expect(s).toContain("claude-opus-4-8");
    expect(s).toContain("effort: high");
  });

  test("runs tally is colored glyph summary with total", () => {
    const runs = [
      { id: "r1", taskId: "t", agentId: "a", hostId: "h", status: "succeeded", startedAt: NOW, endedAt: NOW, durationMs: 1, error: null },
      { id: "r2", taskId: "t", agentId: "a", hostId: "h", status: "failed", startedAt: NOW, endedAt: NOW, durationMs: 1, error: "boom" },
    ];
    const s = plain(run(baseData({ runs }), 100));
    expect(s).toContain("✓ 1");
    expect(s).toContain("✗ 1");
    expect(s).toContain("(2 total)");
  });

  test("threads: active count + snippet + humanized size/age", () => {
    const threads = [
      {
        threadId: "cli:main",
        toAgentId: "a",
        events: 12,
        turns: 4,
        contextTokens: 15_800_000,
        lastHlc: "x",
        lastEventAt: NOW - 3_600_000,
        lastType: "chat.turn-end",
        firstUserText: "help me plan the launch",
        cacheHitRatio: 0.9,
      },
    ];
    const s = plain(run(baseData({ threads }), 100));
    expect(s).toContain("help me plan the launch");
    expect(s).toContain("15.8M tokens");
    expect(s).toContain("recent");
  });

  test("extensions tally + broken detail line", () => {
    const exts = [
      { name: "discord", status: "registered" },
      { name: "github", status: "broken", error: "bad token" },
    ];
    const s = plain(run(baseData({ exts }), 100));
    expect(s).toContain("1 registered");
    expect(s).toContain("1 broken");
    expect(s).toContain("✗ github");
    expect(s).toContain("bad token");
  });

  test("teams section renders only when a team exists, with peer rows", () => {
    const teams = {
      teams: [
        {
          teamId: "01J8TEAM000000000000000000",
          name: "launch-crew",
          members: [{ actorId: "a", role: "owner", joinedAt: NOW }],
          peers: [
            { peerHostId: "01J8PEER00000000000000000A", addr: "192.168.1.5:9000", status: "connected", lastHeartbeatAt: NOW - 5000, lastReceivedEventId: "e" },
            { peerHostId: "01J8PEER00000000000000000B", addr: "192.168.1.6:9000", status: "stale", lastHeartbeatAt: NOW - 90_000, lastReceivedEventId: "e" },
          ],
        },
      ],
    };
    const s = plain(run(baseData({ teams }), 100));
    expect(s).toContain("launch-crew");
    expect(s).toContain("1 member");
    expect(s).toContain("1 connected");
    expect(s).toContain("1 stale");
    expect(s).toContain("connected");
    expect(s).toContain("192.168.1.5:9000");
    // no team → no header
    expect(plain(run(baseData(), 100))).not.toContain("teams");
  });

  test("inbox summary with actionable peek", () => {
    const inbox = [
      { id: "01J8DEC000000000000000000A", tier: "strategic", summary: "raise the monthly budget cap", status: "open", staleness: NOW - 1000, createdAt: NOW - 10_800_000 },
      { id: "01J8DEC000000000000000000B", tier: "operational", summary: "approve a new discord channel", status: "open", staleness: null, createdAt: NOW - 3_600_000 },
    ];
    const s = plain(run(baseData({ inbox }), 100));
    expect(s).toContain("2 actionable");
    expect(s).toContain("1 past deadline"); // one stale
    expect(s).toContain("raise the monthly budget cap");
  });
});

describe("renderStatus — empty states and partial failure", () => {
  test("daemon unreachable renders a sentence + command, never throws", () => {
    const s = plain(run(baseData({ host: null, chat: null, self: null }), 80));
    expect(s).toContain("Daemon not reachable.");
    expect(s).toContain("olle run");
  });

  test("empty sections give humane sentences, never bare (none)", () => {
    const s = plain(run(baseData({ usage: null, runs: [], threads: [], inbox: [], exts: [] }), 80));
    expect(s).toContain("No token spend");
    expect(s).toContain("No task runs");
    expect(s).toContain("No conversations yet.");
    expect(s).toContain("No decisions waiting.");
    expect(s).toContain("No extensions installed.");
    expect(s).not.toContain("(none)");
    expect(s).not.toContain("(empty)");
  });

  test("usage with zero rows is treated as empty", () => {
    const s = plain(run(baseData({ usage: usage({ rows: 0 }) }), 80));
    expect(s).toContain("No token spend");
  });
});

describe("renderStatus — layout invariants", () => {
  for (const width of WIDTHS) {
    test(`every line fits width ${width} (populated)`, () => {
      const full = baseData({
        exts: [{ name: "discord", status: "registered" }, { name: "github", status: "broken", error: "a very long error message that could overflow the terminal width if not clipped by the table" }],
        runs: [{ id: "r", taskId: "t", agentId: "a", hostId: "h", status: "succeeded", startedAt: NOW, endedAt: NOW, durationMs: 1, error: null }],
        threads: [{ threadId: "cli:main", toAgentId: "a", events: 5, turns: 2, contextTokens: 900_000, lastHlc: "x", lastEventAt: NOW - 1000, lastType: "chat.turn-end", firstUserText: "a fairly long opening line that should be clipped to fit inside the narrow column without overflow", cacheHitRatio: 0.5 }],
        inbox: [{ id: "01J8DEC000000000000000000A", tier: "strategic", summary: "a long decision summary that should also be clipped by the flex column so nothing overflows the width", status: "open", staleness: null, createdAt: NOW - 1000 }],
        // Multi-status peers so the header's peer summary is wide enough to
        // force the drop-to-second-line path at 60 cols (regression: the
        // summary used to overflow when connected+stale+down all showed).
        teams: { teams: [{ teamId: "01J8TEAM000000000000000000", name: "research-cell", members: [{ actorId: "a", role: "founder", joinedAt: NOW }, { actorId: "b", role: "member", joinedAt: NOW }], peers: [
          { peerHostId: "01J8PEER00000000000000000A", addr: "192.168.100.200:65000", status: "connected", lastHeartbeatAt: NOW - 1000, lastReceivedEventId: "e" },
          { peerHostId: "01J8PEER00000000000000000B", addr: "192.168.100.201:65000", status: "stale", lastHeartbeatAt: NOW - 90_000, lastReceivedEventId: "e" },
          { peerHostId: "01J8PEER00000000000000000C", addr: "10.0.0.5:65000", status: "disconnected", lastHeartbeatAt: null, lastReceivedEventId: null },
        ] }] },
      });
      for (const line of plain(run(full, width)).split("\n")) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    });
  }

  test("color:false output contains zero escape codes", () => {
    const s = run(baseData({ runs: [{ id: "r", taskId: "t", agentId: "a", hostId: "h", status: "failed", startedAt: NOW, endedAt: NOW, durationMs: 1, error: null }] }), 100, false);
    expect(s).not.toContain("\x1b[");
  });

  test("color:true output does contain escape codes", () => {
    const s = run(baseData(), 100, true);
    expect(s).toContain("\x1b[");
  });
});

describe("renderInspectAgent", () => {
  test("identity card: bold name headline, muted id block, scope, principles", () => {
    const s = plain(renderInspectAgent(self(), { width: 100, color: false }));
    const lines = s.split("\n");
    expect(lines[0]).toBe("oz / Oz"); // headline first, no key: prefix
    expect(s).toContain("id");
    expect(s).toContain("01J8ZK3P7QRSTUVWXYZ0123456"); // full id on the card
    expect(s).toContain("operational, strategic"); // scope tiers
    expect(s).toContain("principles");
    expect(s).toContain("3");
    expect(s).toContain("claude-opus-4-8");
    expect(s).toContain("effort: high");
  });

  test("no display name → name alone, no slash", () => {
    const s = plain(renderInspectAgent(self({ displayName: null }), { width: 100, color: false }));
    expect(s.split("\n")[0]).toBe("oz");
  });

  test("parent none renders (none)", () => {
    const s = plain(renderInspectAgent(self(), { width: 80, color: false }));
    expect(s).toContain("(none)");
  });

  test("ext tools render as a wrapped muted list", () => {
    const tools = Array.from({ length: 12 }, (_, i) => ({ name: `some_tool_number_${i}`, extensionId: "x" }));
    const s = plain(renderInspectAgent(self({ tools }), { width: 60, color: false }));
    expect(s).toContain("tools");
    expect(s).toContain("some_tool_number_0");
    expect(s).toContain("some_tool_number_11");
    for (const line of s.split("\n")) expect(line.length).toBeLessThanOrEqual(60);
  });

  test("recent models carry the ~ fallback marker", () => {
    const s = plain(
      renderInspectAgent(
        self({
          recentlyPricedModels: [
            { provider: "anthropic", model: "claude-opus-4-8", pricePosted: true },
            { provider: "openai", model: "gpt-4o", pricePosted: false },
          ],
        }),
        { width: 100, color: false },
      ),
    );
    expect(s).toContain("recent models");
    expect(s).toContain("anthropic/claude-opus-4-8");
    expect(s).toContain("openai/gpt-4o ~");
    expect(s).toContain("fallback rate");
  });

  test("system prompt renders LAST under a rule, plain and width-fit", () => {
    const prompt = "You are Oz. ".repeat(30);
    const s = plain(renderInspectAgent(self({ systemPrompt: prompt }), { width: 60, color: false }));
    expect(s).toContain("─"); // the rule
    expect(s).toContain("You are Oz.");
    const ix = s.indexOf("─");
    expect(s.indexOf("You are Oz.")).toBeGreaterThan(ix); // prompt after the rule
    for (const line of s.split("\n")) expect(line.length).toBeLessThanOrEqual(60);
  });

  test("color:false inspect has zero escapes; color:true has some", () => {
    expect(renderInspectAgent(self(), { width: 80, color: false })).not.toContain("\x1b[");
    expect(renderInspectAgent(self(), { width: 80, color: true })).toContain("\x1b[");
  });
});
