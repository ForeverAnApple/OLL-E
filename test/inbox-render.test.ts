// Pure-render tests for `olle inbox list` / `olle inbox show`. The renderers
// take IPC rows + {width, color, now} and return a finished string, so we
// assert on that string directly — no daemon, no IPC. We fix `now` for
// deterministic relative ages, test the color:false form for content and
// width, and exercise color:true only for the escape-balance invariant.

import { describe, expect, test } from "bun:test";
import {
  renderInboxList,
  renderInboxShow,
  type InboxRow,
  type InboxRowWithMessages,
} from "../src/cli/inbox-render.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function plain(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function row(over: Partial<InboxRow> = {}): InboxRow {
  return {
    id: "01J8ZXAAAA1111BBBB2222CCCC",
    ownerAgentId: "01J8OWNERAGENT0000000000",
    proposingAgentId: "01J8PROPOSER00000000000",
    proposingAgentName: "oz",
    ownerDisplay: "kin",
    tier: "strategic",
    summary: "Register a Discord bridge extension so the team can be reached in chat",
    payload: { action: "register_extension", name: "discord" },
    status: "open",
    staleness: NOW + 2 * HOUR,
    createdAt: NOW - 30 * MIN,
    resolvedAt: null,
    unreadReplyCount: 0,
    ...over,
  };
}

const NC = { width: 80, color: false, now: NOW } as const;

describe("renderInboxList — populated", () => {
  test("header shows scope, count, and emphasized unread total", () => {
    const rows = [row({ unreadReplyCount: 2 }), row({ id: "01J8ZZZ", status: "approved" })];
    const out = plain(renderInboxList(rows, { ...NC, filter: "active" }));
    expect(out).toContain("olle inbox");
    expect(out).toContain("active · 2 items");
    expect(out).toContain("2 unread replies");
  });

  test("singular grammar for one item / one unread reply", () => {
    const out = plain(renderInboxList([row({ unreadReplyCount: 1 })], { ...NC }));
    expect(out).toContain("1 item");
    expect(out).not.toContain("1 items");
    expect(out).toContain("1 unread reply");
    expect(out).not.toContain("1 unread replies");
  });

  test("humanized age, short id, and (N new) badge; no raw ISO or full ULID", () => {
    const out = plain(renderInboxList([row({ unreadReplyCount: 3 })], { ...NC }));
    expect(out).toContain("30m"); // 30 minutes old, not an ISO string
    expect(out).toContain("01J8ZXAAAA"); // 10-char short id
    expect(out).not.toContain("01J8ZXAAAA1111BBBB2222CCCC"); // never the full ULID
    expect(out).toContain("(3 new)");
    expect(out).toContain("[oz]");
  });

  test("stale open item flags '!'; non-stale does not", () => {
    const staleRow = row({ staleness: NOW - HOUR }); // deadline passed
    const freshRow = row({ id: "01J8FRESH", staleness: NOW + HOUR });
    const out = plain(renderInboxList([staleRow, freshRow], { ...NC }));
    // The stale marker sits right after the status glyph on the stale row.
    const staleLine = out.split("\n").find((l) => l.includes("01J8ZXAAAA"))!;
    const freshLine = out.split("\n").find((l) => l.includes("01J8FRESH"))!;
    expect(staleLine).toContain("!");
    expect(freshLine).not.toContain("!");
  });

  test("resolved items show tier/status tag", () => {
    const out = plain(
      renderInboxList([row({ status: "approved", unreadReplyCount: 0 })], { ...NC, filter: "all" }),
    );
    expect(out).toContain("strategic/approved");
  });
});

describe("renderInboxList — empty states", () => {
  test("active empty: inbox-zero sentence + widen command", () => {
    const out = plain(renderInboxList([], { ...NC, filter: "active" }));
    expect(out).toContain("Inbox zero");
    expect(out).toContain("olle inbox list --all");
    expect(out).not.toContain("(none)");
  });

  test("open empty: approval sentence", () => {
    const out = plain(renderInboxList([], { ...NC, filter: "open" }));
    expect(out).toContain("No open decisions");
    expect(out).toContain("olle inbox list --all");
  });

  test("all empty: suggests chat", () => {
    const out = plain(renderInboxList([], { ...NC, filter: "all" }));
    expect(out).toContain("No inbox items yet");
    expect(out).toContain("olle chat");
  });
});

describe("renderInboxList — width & degradation", () => {
  for (const width of [60, 100]) {
    test(`every line fits width ${width}`, () => {
      const rows = [
        row({ unreadReplyCount: 5, tier: "vision" }),
        row({ id: "01J8B", status: "denied", proposingAgentName: "a-very-long-agent-name" }),
        row({ id: "01J8C", status: "modified", summary: "x".repeat(200) }),
      ];
      const out = plain(renderInboxList(rows, { width, color: false, now: NOW }));
      for (const line of out.split("\n")) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    });
  }

  test("color:false emits zero ANSI escapes", () => {
    const rows = [row({ unreadReplyCount: 2, tier: "vision", status: "open" })];
    const out = renderInboxList(rows, { width: 80, color: false, now: NOW });
    expect(out).not.toMatch(/\x1b\[/);
  });

  test("color:true closes every escape it opens", () => {
    const rows = [row({ unreadReplyCount: 2 }), row({ status: "stale" })];
    const out = renderInboxList(rows, { width: 80, color: true, now: NOW });
    const resets = out.match(/\x1b\[0m/g)?.length ?? 0;
    expect(resets).toBeGreaterThan(0);
    const lastEsc = out.match(/\x1b\[[0-9;]*m/g)!.at(-1);
    expect(lastEsc).toBe("\x1b[0m");
  });
});

describe("renderInboxShow — populated", () => {
  function withMessages(over: Partial<InboxRowWithMessages> = {}): InboxRowWithMessages {
    return {
      ...row(),
      messages: [
        { id: "m1", decisionId: "d", actorId: "01J8OZ", actorName: "oz", text: "Any budget cap?", at: NOW - 2 * HOUR, read: true },
        { id: "m2", decisionId: "d", actorId: "01J8KIN", actorName: "kin", text: "Cap it at $5/day.", at: NOW - 20 * MIN, read: false },
      ],
      ...over,
    };
  }

  test("kv block: humanized age + short ids, not full ULIDs", () => {
    const out = plain(renderInboxShow(row(), NC));
    expect(out).toContain("status");
    expect(out).toContain("tier");
    expect(out).toContain("strategic");
    expect(out).toContain("30m"); // age, relative
    expect(out).toContain("oz (01J8PROPOS"); // short proposer id
    expect(out).not.toContain("01J8PROPOSER00000000000");
  });

  test("stale deadline in the future renders 'in Xh'", () => {
    const out = plain(renderInboxShow(row({ staleness: NOW + 2 * HOUR }), NC));
    expect(out).toContain("in 2h");
  });

  test("stale deadline in the past renders 'X ago'", () => {
    const out = plain(renderInboxShow(row({ staleness: NOW - 45 * MIN }), NC));
    expect(out).toContain("45m ago");
  });

  test("resolved renders relative age, not ISO", () => {
    const out = plain(
      renderInboxShow(row({ status: "approved", resolvedAt: NOW - 3 * DAY }), NC),
    );
    expect(out).toContain("resolved");
    expect(out).toContain("3d ago");
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no ISO timestamp
  });

  test("payload is pretty-printed under a section rule", () => {
    const out = plain(renderInboxShow(row(), NC));
    expect(out).toContain("payload");
    expect(out).toContain("register_extension");
  });

  test("replies: count, new marker, and per-message relative time", () => {
    const out = plain(renderInboxShow(withMessages(), NC));
    expect(out).toContain("replies (2)");
    expect(out).toContain("1 new");
    expect(out).toContain("[NEW]"); // the unread reply
    expect(out).toContain("Cap it at $5/day.");
    expect(out).toContain("20m ago");
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/); // no absolute timestamp
  });

  test("no replies: reply section absent", () => {
    const out = plain(renderInboxShow(row(), NC));
    expect(out).not.toContain("replies (");
  });
});

describe("renderInboxShow — width & degradation", () => {
  for (const width of [60, 100]) {
    test(`every line fits width ${width}`, () => {
      const r: InboxRowWithMessages = {
        ...row({ summary: "This is a deliberately long decision summary ".repeat(6) }),
        messages: [
          {
            id: "m1",
            decisionId: "d",
            actorId: "01J8OZ",
            actorName: "oz",
            text: "A long reply that must wrap cleanly at the column edge ".repeat(4),
            at: NOW - HOUR,
            read: false,
          },
        ],
      };
      const out = plain(renderInboxShow(r, { width, color: false, now: NOW }));
      for (const line of out.split("\n")) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    });
  }

  test("color:false emits zero ANSI escapes", () => {
    const out = renderInboxShow(row({ status: "approved", resolvedAt: NOW - HOUR }), {
      width: 80,
      color: false,
      now: NOW,
    });
    expect(out).not.toMatch(/\x1b\[/);
  });

  test("color:true ends on a reset (nothing left open)", () => {
    const out = renderInboxShow(row(), { width: 80, color: true, now: NOW });
    const lastEsc = out.match(/\x1b\[[0-9;]*m/g)!.at(-1);
    expect(lastEsc).toBe("\x1b[0m");
  });
});
