// Pure-render tests for the entity list/ack commands. Each renderer takes
// query results + {width, color} and returns a finished string, so we assert
// on that string directly — no daemon, no IPC. We test the color:false form
// (stable, human-readable), width fit at 60 and 100, humanized values, and
// the humane empty states.

import { describe, expect, test } from "bun:test";
import {
  renderExtensionHistory,
  renderExtensionList,
  renderExtensionReloadAck,
  renderExtensionRevertAck,
  renderSecretList,
  renderSecretRemoveAck,
  renderSecretSetAck,
  renderStarterInstallAck,
  renderStarterList,
  type ExtensionHistoryItem,
  type ExtensionListItem,
  type SecretListItem,
  type StarterListItem,
} from "../src/cli/entity-render.ts";

// A fixed "now" so relative ages are deterministic.
const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

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

// --- extension list -------------------------------------------------------

const extensions: ExtensionListItem[] = [
  {
    name: "discord",
    status: "registered",
    path: "/x/discord",
    lastCommit: { sha: "abc1234def", date: NOW - 3 * DAY, subject: "fix gateway reconnect backoff" },
  },
  {
    name: "github",
    status: "broken",
    path: "/x/github",
    error: "manifest.json missing eventWrites",
    lastCommit: { sha: "def5678abc", date: NOW - HOUR, subject: "add webhook receiver" },
  },
  {
    name: "telegram",
    status: "unregistered",
    path: "/x/telegram",
    lastCommit: { sha: "9911aabbcc", date: NOW - 30 * MIN, subject: "long-poll adapter" },
  },
];

describe("renderExtensionList", () => {
  test("humanized, status words, broken count in header", () => {
    const out = plain(renderExtensionList(extensions, { width: 100, color: false, now: NOW }));
    expect(out).toContain("olle extension list");
    expect(out).toContain("3 extensions");
    expect(out).toContain("1 broken");
    expect(out).toContain("discord");
    expect(out).toContain("registered");
    expect(out).toContain("broken");
    expect(out).toContain("unregistered");
    // broken leads with the error, not the commit.
    expect(out).toContain("err: manifest.json missing eventWrites");
    // last-commit humanized: short sha (8, matching history + acks) + relative
    // age + subject.
    expect(out).toContain("abc1234d · 3d ago · fix gateway reconnect backoff");
  });

  test("short shas, never full-length", () => {
    const out = plain(renderExtensionList(extensions, { width: 100, color: false, now: NOW }));
    expect(out).toContain("abc1234");
    expect(out).not.toContain("abc1234def");
  });

  test("fits width at 60 and 100, no escapes at color:false", () => {
    for (const w of [60, 100]) {
      const s = renderExtensionList(extensions, { width: w, color: false, now: NOW });
      noEscapes(s);
      fitsWidth(s, w);
    }
  });

  test("empty state: humane sentence + a command to change it", () => {
    const out = plain(renderExtensionList([], { width: 80, color: false, now: NOW }));
    expect(out).toContain("No extensions on disk yet.");
    expect(out).toContain("olle starter list");
    expect(out).not.toContain("(none)");
  });

  test("color:true closes every escape it opens", () => {
    const out = renderExtensionList(extensions, { width: 100, color: true, now: NOW });
    const lastEsc = out.match(/\x1b\[[0-9;]*m/g)!.at(-1);
    expect(lastEsc).toBe("\x1b[0m");
  });
});

// --- extension history ----------------------------------------------------

const history: ExtensionHistoryItem[] = [
  { sha: "aa11bb22cc33", author: "oz", date: NOW - 2 * HOUR, subject: "harden RESUME + backoff" },
  { sha: "dd44ee55ff66", author: "root", date: NOW - 5 * DAY, subject: "initial discord gateway" },
];

describe("renderExtensionHistory", () => {
  test("git-log-like, humanized age, short sha, author, subject", () => {
    const out = plain(
      renderExtensionHistory(history, { width: 100, color: false, now: NOW, name: "discord" }),
    );
    expect(out).toContain("olle extension history discord");
    expect(out).toContain("2 commits");
    expect(out).toContain("aa11bb22");
    expect(out).not.toContain("aa11bb22cc33");
    expect(out).toContain("2h");
    expect(out).toContain("5d");
    expect(out).toContain("oz");
    expect(out).toContain("harden RESUME + backoff");
  });

  test("fits width at 60 and 100, no escapes at color:false", () => {
    for (const w of [60, 100]) {
      const s = renderExtensionHistory(history, { width: w, color: false, now: NOW, name: "discord" });
      noEscapes(s);
      fitsWidth(s, w);
    }
  });

  test("empty state names the extension", () => {
    const out = plain(
      renderExtensionHistory([], { width: 80, color: false, now: NOW, name: "github" }),
    );
    expect(out).toContain("No commit history for github yet.");
  });
});

// --- starter list ---------------------------------------------------------

const starters: StarterListItem[] = [
  { name: "discord", description: "bot gateway + message send/receive" },
  {
    name: "telegram",
    description:
      "long-poll getUpdates adapter with markdown-to-Telegram-HTML rendering and native draft streaming in direct messages",
    hasSetupGuide: true,
  },
];

describe("renderStarterList", () => {
  test("menu shape: name + description, header count", () => {
    const out = plain(renderStarterList(starters, { width: 100, color: false }));
    expect(out).toContain("olle starter list");
    expect(out).toContain("2 starters");
    expect(out).toContain("discord");
    expect(out).toContain("bot gateway + message send/receive");
  });

  test("hasSetupGuide surfaces a setup nudge", () => {
    const out = plain(renderStarterList(starters, { width: 100, color: false }));
    expect(out).toContain("setup guide");
    expect(out).toContain("SETUP.md");
  });

  test("long descriptions wrap under a hanging indent, fit width", () => {
    for (const w of [60, 100]) {
      const s = renderStarterList(starters, { width: w, color: false });
      noEscapes(s);
      fitsWidth(s, w);
      // wrapped continuation lines exist for the long telegram description.
      expect(plain(s).split("\n").length).toBeGreaterThan(3);
    }
  });

  test("empty state is humane", () => {
    const out = plain(renderStarterList([], { width: 80, color: false }));
    expect(out).toContain("No starter templates available.");
    expect(out).not.toContain("(none)");
  });
});

// --- secret list ----------------------------------------------------------

const secrets: SecretListItem[] = [
  { name: "DISCORD_TOKEN", size: 72, updatedAt: NOW - 3 * DAY },
  { name: "GITHUB_WEBHOOK_SECRET", size: 40, updatedAt: NOW - 15 * MIN },
];

describe("renderSecretList", () => {
  test("name + humanized size + relative age, never a value", () => {
    const out = plain(renderSecretList(secrets, { width: 100, color: false, now: NOW }));
    expect(out).toContain("olle secret list");
    expect(out).toContain("2 secrets");
    expect(out).toContain("DISCORD_TOKEN");
    expect(out).toContain("72 B");
    expect(out).toContain("3d");
    expect(out).toContain("15m");
  });

  test("fits width at 60 and 100, no escapes at color:false", () => {
    for (const w of [60, 100]) {
      const s = renderSecretList(secrets, { width: w, color: false, now: NOW });
      noEscapes(s);
      fitsWidth(s, w);
    }
  });

  test("empty state points at the set command", () => {
    const out = plain(renderSecretList([], { width: 80, color: false, now: NOW }));
    expect(out).toContain("No secrets set.");
    expect(out).toContain("olle secret set <NAME>");
  });

  test("a pathologically long secret name clips instead of overflowing at 60", () => {
    const long = [
      { name: "A_VERY_LONG_SECRET_NAME_THAT_WOULD_OTHERWISE_PUSH_THE_ROW_PAST_THE_EDGE", size: 4096, updatedAt: NOW - 1000 },
    ];
    for (const w of [60, 100]) {
      const s = renderSecretList(long, { width: w, color: false, now: NOW });
      fitsWidth(s, w);
    }
    // Long name is clipped with an ellipsis at 60, kept whole at 100.
    expect(plain(renderSecretList(long, { width: 60, color: false, now: NOW }))).toContain("…");
    expect(plain(renderSecretList(long, { width: 100, color: false, now: NOW }))).toContain(long[0]!.name);
  });
});

// --- acks -----------------------------------------------------------------

describe("acks — consistent '<name> — <what happened>' grammar", () => {
  test("extension reload", () => {
    const out = plain(renderExtensionReloadAck({ name: "discord", status: "registered" }, { color: false }));
    expect(out).toBe("discord — reloaded, now registered");
  });

  test("extension revert shows short sha", () => {
    const out = plain(
      renderExtensionRevertAck(
        { name: "github", revertedTo: "abc1234def567", newCommit: "newsha", status: "registered" },
        { color: false },
      ),
    );
    expect(out).toBe("github — reverted to abc1234d, now registered");
    expect(out).not.toContain("abc1234def567");
  });

  test("starter install — fresh", () => {
    const out = plain(
      renderStarterInstallAck(
        { name: "discord", filesWritten: 12, alreadyExisted: false, commit: "abc1234def", status: "registered" },
        { color: false },
      ),
    );
    expect(out).toBe("discord — installed 12 files, commit abc1234d, now registered");
  });

  test("starter install — no-op when already installed", () => {
    const out = plain(
      renderStarterInstallAck(
        { name: "discord", filesWritten: 0, alreadyExisted: true, commit: null },
        { color: false },
      ),
    );
    expect(out).toContain("already installed");
    expect(out).toContain("--overwrite");
  });

  test("secret set reports humanized size", () => {
    const out = plain(renderSecretSetAck({ name: "DISCORD_TOKEN", bytes: 72 }, { color: false }));
    expect(out).toBe("DISCORD_TOKEN — set, 72 B written");
  });

  test("secret remove", () => {
    const out = plain(renderSecretRemoveAck({ name: "DISCORD_TOKEN" }, { color: false }));
    expect(out).toBe("DISCORD_TOKEN — removed");
  });

  test("acks emit no escapes at color:false and close escapes at color:true", () => {
    const nc = renderSecretSetAck({ name: "X", bytes: 10 }, { color: false });
    noEscapes(nc);
    const c = renderSecretSetAck({ name: "X", bytes: 10 }, { color: true });
    expect(c.match(/\x1b\[[0-9;]*m/g)!.at(-1)).toBe("\x1b[0m");
  });
});
