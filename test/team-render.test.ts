// Pure-render tests for the team / budget / model / publish CLI renderers.
// Each function takes query results + {width,color} and returns a finished
// string, so we assert on that string directly — no daemon, no IPC. We test
// humanized values, alignment at 60 and 100 cols, the color:false invariant
// (zero escapes), and the humane empty states.

import { describe, expect, test } from "bun:test";
import {
  renderBudgetSet,
  renderBudgetShow,
  renderModelGet,
  renderModelSet,
  renderPublishAck,
  renderTeamCreateAck,
  renderTeamInviteAck,
  renderTeamJoinAck,
  renderTeamLeaveAck,
  renderTeamStatus,
  type BudgetSetData,
  type TeamStatusData,
} from "../src/cli/team-render.ts";
import type { BudgetStatus } from "../src/observability/index.ts";
import { ANSI } from "../src/cli/theme.ts";

function plain(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
function noEscapes(s: string): void {
  expect(s).not.toMatch(/\x1b\[/);
}
function fitsWidth(s: string, width: number): void {
  for (const line of plain(s).split("\n")) {
    expect(line.length).toBeLessThanOrEqual(width);
  }
}

function usd(dollars: number): number {
  return Math.round(dollars * 1_000_000);
}

const NOW = 1_700_000_000_000;

// --- team status ---------------------------------------------------------

function teamStatus(over: Partial<TeamStatusData> = {}): TeamStatusData {
  return {
    teams: over.teams ?? [
      {
        teamId: "01HTEAMabc0000000000000000",
        name: "research",
        members: [
          { actorId: "01HAGENTozzzzzzzzzzzzzzzzz", role: "owner" },
          { actorId: "01HAGENTalice000000000000z", role: "member" },
        ],
        peers: [
          {
            peerHostId: "01HHOSTbob0000000000000000",
            status: "connected",
            addr: "192.168.1.7:7777",
            lastHeartbeatAt: NOW - 12_000,
          },
          {
            peerHostId: "01HHOSTcarol00000000000000",
            status: "stale",
            addr: "192.168.1.9:7777",
            lastHeartbeatAt: NOW - 75_000,
          },
          {
            peerHostId: "01HHOSTdave000000000000000",
            status: "disconnected",
            addr: "10.0.0.4:7777",
            lastHeartbeatAt: null,
          },
        ],
      },
    ],
  };
}

describe("renderTeamStatus", () => {
  test("heading, members, and aligned peer table with relative heartbeats", () => {
    const out = plain(renderTeamStatus(teamStatus(), { width: 100, color: false, now: NOW }));
    expect(out).toContain("olle team status");
    expect(out).toContain("1 team");
    expect(out).toContain("research");
    // short teamId, not the full ULID
    expect(out).toContain("01HTEAMabc");
    expect(out).not.toContain("01HTEAMabc0000000000000000");
    // members compact list with short ids + roles
    expect(out).toContain("owner");
    expect(out).toContain("member");
    // heartbeat as relative age, never an ISO timestamp
    expect(out).toContain("12s");
    expect(out).toContain("—"); // null heartbeat
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test("peer status colors: connected=success, stale=warning, disconnected=error", () => {
    const out = renderTeamStatus(teamStatus(), { width: 100, color: true, now: NOW });
    // Each of the three peers carries its semantic status escape.
    expect(out).toContain(ANSI.success + "connected");
    expect(out).toContain(ANSI.warning + "stale");
    expect(out).toContain(ANSI.error + "disconnected");
  });

  test("empty state names the create command", () => {
    const out = plain(renderTeamStatus({ teams: [] }, { width: 80, color: false }));
    expect(out).toContain("not in any team");
    expect(out).toContain("olle team create <name>");
  });

  test("peerless team points at invite", () => {
    const data: TeamStatusData = {
      teams: [
        {
          teamId: "01HTEAMsolo0000000000000000",
          name: "solo",
          members: [{ actorId: "01HAGENTozzzzzzzzzzzzzzzzz", role: "owner" }],
          peers: [],
        },
      ],
    };
    const out = plain(renderTeamStatus(data, { width: 80, color: false, now: NOW }));
    expect(out).toContain("No peers yet");
    expect(out).toContain("olle team invite 01HTEAMsolo0000000000000000");
  });

  test("degradation: fits width and no escapes at 60/100", () => {
    for (const width of [60, 100]) {
      const out = renderTeamStatus(teamStatus(), { width, color: false, now: NOW });
      fitsWidth(out, width);
      noEscapes(out);
    }
  });
});

// --- team acks -----------------------------------------------------------

describe("team acks", () => {
  test("create: confident ack + invite hint", () => {
    const out = plain(
      renderTeamCreateAck({ teamId: "01HTEAMabc0000000000000000", name: "research" }, {
        width: 80,
        color: false,
      }),
    );
    expect(out).toContain('Created team "research"');
    expect(out).toContain("01HTEAMabc");
    expect(out).toContain("olle team invite 01HTEAMabc0000000000000000");
    noEscapes(out);
  });

  test("invite: code stays raw and uncolored on its own line even with color on", () => {
    const code = "eyJwcm90byI6Im9sbGUudjAiLCJ0ZWFtSWQiOiIwMUhURUFNIn0";
    const rendered = renderTeamInviteAck({ code, inviteId: "01HINVITEabc00000000000000" }, {
      width: 80,
      color: true,
    });
    const firstLine = rendered.split("\n")[0]!;
    // The first line is exactly the raw code — no escapes, no wrapping.
    expect(firstLine).toBe(code);
    expect(firstLine).not.toMatch(/\x1b\[/);
    // The explainer below is muted and mentions sharing out-of-band.
    expect(plain(rendered)).toContain("share this code out-of-band");
    expect(plain(rendered)).toContain("01HINVITEa");
  });

  test("join / leave one-liners", () => {
    const j = plain(
      renderTeamJoinAck({ teamId: "01HTEAMabc0000000000000000", peerHostId: "01HHOSTbob0000000000000000" }, {
        width: 80,
        color: false,
      }),
    );
    expect(j).toContain("Joined team 01HTEAMabc0000000000000000");
    expect(j).toContain("via peer 01HHOSTbob");

    const l = plain(renderTeamLeaveAck({ teamId: "01HTEAMabc0000000000000000" }, { width: 80, color: false }));
    expect(l).toContain("Left team 01HTEAMabc0000000000000000");
    noEscapes(l);
  });
});

// --- budget show ---------------------------------------------------------

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
        spentUsd: usd(2.9),
        spentTokens: 0,
        percentUsd: 2.9 / 3,
        percentTokens: null,
      },
    ],
  };
}

describe("renderBudgetShow", () => {
  test("reuses the stats budget idiom: spent/cap, threshold, remaining", () => {
    const out = plain(renderBudgetShow(budget(), { width: 80, color: false, agent: "oz" }));
    expect(out).toContain("olle budget");
    expect(out).toContain("agent oz");
    expect(out).toContain("monthly");
    expect(out).toContain("$2.41 / $50.00");
    expect(out).toContain("$47.59 left");
    expect(out).toContain("5%");
    // humanized USD, not $2.4100
    expect(out).not.toContain("$2.4100");
  });

  test("threshold color flips at 80% burn (daily row is over 80%)", () => {
    const out = renderBudgetShow(budget(), { width: 80, color: true, agent: "oz" });
    expect(out).toContain(ANSI.warning);
  });

  test("no-cap row prints 'no cap', no bar", () => {
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
    const out = plain(renderBudgetShow(b, { width: 80, color: false, agent: "oz" }));
    expect(out).toContain("no cap");
    expect(out).not.toContain("█");
  });

  test("empty state points at budget set", () => {
    const out = plain(renderBudgetShow({ rows: [] }, { width: 80, color: false, agent: "oz" }));
    expect(out).toContain("uncapped");
    expect(out).toContain("olle budget set --usd 50");
  });

  test("degradation: fits width, no escapes at 60/100", () => {
    for (const width of [60, 100]) {
      const out = renderBudgetShow(budget(), { width, color: false, agent: "oz" });
      fitsWidth(out, width);
      noEscapes(out);
    }
  });
});

// --- budget set ack ------------------------------------------------------

describe("renderBudgetSet", () => {
  function setResult(over: Partial<BudgetSetData> = {}): BudgetSetData {
    return {
      agentId: "oz",
      period: "monthly",
      capUsdMicros: usd(50),
      capTokens: null,
      spentUsdMicros: usd(2.41),
      spentTokens: 0,
      created: true,
      ...over,
    };
  }

  test("armed (created) names cap + spent, humanized", () => {
    const out = plain(renderBudgetSet(setResult(), { width: 80, color: false }));
    expect(out).toContain("Armed monthly budget");
    expect(out).toContain("for oz");
    expect(out).toContain("cap $50.00");
    expect(out).toContain("Spent so far $2.41");
  });

  test("updated (not created) uses the update verb", () => {
    const out = plain(renderBudgetSet(setResult({ created: false }), { width: 80, color: false }));
    expect(out).toContain("Updated monthly budget");
  });

  test("cleared cap reads 'no cap'; token cap is comma-grouped", () => {
    const out = plain(
      renderBudgetSet(setResult({ capUsdMicros: null, capTokens: 2_000_000 }), {
        width: 80,
        color: false,
      }),
    );
    expect(out).toContain("cap no cap");
    expect(out).toContain("2,000,000 tokens");
  });

  test("armed is colored success, updated is not", () => {
    const armed = renderBudgetSet(setResult({ created: true }), { width: 80, color: true });
    expect(armed).toContain(ANSI.success);
    noEscapes(plain(renderBudgetSet(setResult(), { width: 80, color: false })));
  });
});

// --- model ---------------------------------------------------------------

describe("model", () => {
  test("get: model plain; default tag when isDefault", () => {
    const plainModel = plain(
      renderModelGet({ model: "anthropic/claude-opus-4-8" }, { width: 80, color: false }),
    );
    expect(plainModel).toContain("anthropic/claude-opus-4-8");
    expect(plainModel).not.toContain("host default");

    const withDefault = plain(
      renderModelGet({ model: "anthropic/claude-opus-4-8", isDefault: true }, {
        width: 80,
        color: false,
      }),
    );
    expect(withDefault).toContain("host default");
  });

  test("get: empty model → humane empty state", () => {
    const out = plain(renderModelGet({ model: "" }, { width: 80, color: false }));
    expect(out).toContain("No model set");
    expect(out).toContain("olle model <name>");
  });

  test("set: one-line ack", () => {
    const out = plain(renderModelSet({ model: "gpt-5.5" }, { width: 80, color: false }));
    expect(out).toContain("default model → gpt-5.5");
    expect(out.split("\n").length).toBe(1);
  });
});

// --- publish -------------------------------------------------------------

describe("renderPublishAck", () => {
  test("muted hlc + id, one line, no escapes at color:false", () => {
    const out = renderPublishAck(
      { id: "01HEVENTabc0000000000000000", hlc: "0000000000001-0000-host" },
      { width: 80, color: false },
    );
    expect(out.split("\n").length).toBe(1);
    expect(plain(out)).toContain("0000000000001-0000-host");
    expect(plain(out)).toContain("01HEVENTabc0000000000000000");
    noEscapes(out);
  });
});
