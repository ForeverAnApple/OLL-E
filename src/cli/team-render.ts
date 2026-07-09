// Pure renderers for the team / budget / model / publish CLI commands.
// Same visual language as stats-render.ts: build every aligned cell as a
// PLAIN string, size columns on those plain strings, and color LAST. All
// functions are (data, opts {width, color}) => string with no IO, so the
// whole layout is testable without a running daemon.
//
// Generic primitives (colorer, humanized numbers, bars, table, headers)
// live in render.ts; this module holds only the per-command layout.

import { ANSI } from "./theme.ts";
import {
  bar,
  emptyState,
  fmtAge,
  fmtUsdSmart,
  headerLine,
  heading,
  intComma,
  kv,
  loColor,
  makeColorer,
  shortId,
  table,
  wrap,
  type Colorer,
} from "./render.ts";
import type { BudgetStatus } from "../observability/index.ts";

export interface RenderOpts {
  width: number;
  color: boolean;
  /** Injected for deterministic relative-age rendering (peer heartbeats).
   *  Defaults to Date.now(). */
  now?: number;
}

// -------------------------------------------------------------------------
// team status
// -------------------------------------------------------------------------

// Structurally identical to the `team.status` IPC result run.ts receives.
export interface TeamStatusMember {
  actorId: string;
  role: string;
}
export interface TeamStatusPeer {
  peerHostId: string;
  status: string;
  addr: string;
  lastHeartbeatAt: number | null;
}
export interface TeamStatusTeam {
  teamId: string;
  name: string;
  members: TeamStatusMember[];
  peers: TeamStatusPeer[];
}
export interface TeamStatusData {
  teams: TeamStatusTeam[];
}

/** connected → success, stale → warning, left → muted, everything else
 *  (disconnected / connecting / rejected) → error. */
function peerStatusColor(status: string): string {
  switch (status) {
    case "connected":
      return ANSI.success;
    case "stale":
      return ANSI.warning;
    case "left":
      return ANSI.muted;
    default:
      return ANSI.error;
  }
}

export function renderTeamStatus(data: TeamStatusData, opts: RenderOpts): string {
  const { width } = opts;
  const now = opts.now ?? Date.now();
  const C = makeColorer(opts.color);
  const out: string[] = [];

  const n = data.teams.length;
  out.push(
    headerLine(C, "olle team status", `${n} ${n === 1 ? "team" : "teams"}`, width),
  );
  out.push("");

  if (n === 0) {
    out.push(
      emptyState(
        C,
        "You're not in any team yet.",
        "olle team create <name>",
      ),
    );
    return out.join("\n");
  }

  for (const t of data.teams) {
    out.push(heading(C, t.name, shortId(t.teamId)));

    // Members — a compact one-line list: short id in text, role muted.
    const memberList =
      t.members.length === 0
        ? C(ANSI.muted, "(none)")
        : t.members
            .map((m) => C(ANSI.text, shortId(m.actorId)) + " " + C(ANSI.muted, m.role))
            .join("  ");
    out.push("  " + kv(C, "members", memberList));

    // Peers — aligned table; the substrate's federation health at a glance.
    if (t.peers.length === 0) {
      out.push(
        "    " +
          C(ANSI.muted, "No peers yet — mint a code with ") +
          C(ANSI.text, `olle team invite ${t.teamId}`),
      );
    } else {
      const rows = table<TeamStatusPeer>(
        C,
        t.peers,
        [
          { cell: (p) => shortId(p.peerHostId), color: ANSI.muted },
          { cell: (p) => p.status, color: (p) => peerStatusColor(p.status) },
          { cell: (p) => p.addr, color: ANSI.muted, flex: true, min: 12 },
          {
            cell: (p) =>
              p.lastHeartbeatAt != null ? fmtAge(now - p.lastHeartbeatAt) : "—",
            color: ANSI.muted,
            align: "right",
          },
        ],
        { width, indent: "    " },
      );
      out.push(...rows);
    }
    out.push("");
  }
  // Drop the trailing blank the last team appended.
  if (out.at(-1) === "") out.pop();
  return out.join("\n");
}

// -------------------------------------------------------------------------
// team acks — confident one-liners. The invite CODE is the exception: it
// stays raw and uncolored on its own line so a human can copy-paste it.
// -------------------------------------------------------------------------

export interface TeamCreateData {
  teamId: string;
  name: string;
}
export function renderTeamCreateAck(data: TeamCreateData, opts: RenderOpts): string {
  const C = makeColorer(opts.color);
  const line =
    C(ANSI.success, `Created team "${data.name}"`) +
    C(ANSI.muted, ` (${shortId(data.teamId)}).`);
  const hint =
    C(ANSI.muted, "Add peers with ") + C(ANSI.text, `olle team invite ${data.teamId}`);
  return line + "\n" + hint;
}

export interface TeamInviteData {
  code: string;
  inviteId: string;
}
export function renderTeamInviteAck(data: TeamInviteData, opts: RenderOpts): string {
  const C = makeColorer(opts.color);
  // The code is a credential a human copies out-of-band — never styled,
  // never wrapped, always alone on its line.
  const explainer = wrap(
    `invite ${shortId(data.inviteId)} — share this code out-of-band; anyone who holds it can join the team.`,
    opts.width,
  )
    .map((l) => C(ANSI.muted, l))
    .join("\n");
  return data.code + "\n" + explainer;
}

export interface TeamJoinData {
  teamId: string;
  peerHostId: string;
}
export function renderTeamJoinAck(data: TeamJoinData, opts: RenderOpts): string {
  const C = makeColorer(opts.color);
  return (
    C(ANSI.success, "Joined team ") +
    C(ANSI.text, data.teamId) +
    C(ANSI.muted, ` via peer ${shortId(data.peerHostId)}.`)
  );
}

export interface TeamLeaveData {
  teamId: string;
}
export function renderTeamLeaveAck(data: TeamLeaveData, opts: RenderOpts): string {
  const C = makeColorer(opts.color);
  return C(ANSI.text, "Left team ") + C(ANSI.muted, `${data.teamId}.`);
}

// -------------------------------------------------------------------------
// budget show — the same idiom as the stats budget block.
// -------------------------------------------------------------------------

export interface BudgetShowOpts extends RenderOpts {
  /** The --agent flag value, if scoped; drives the header label. */
  agent?: string;
}

export function renderBudgetShow(budget: BudgetStatus, opts: BudgetShowOpts): string {
  const { width } = opts;
  const C = makeColorer(opts.color);
  const out: string[] = [];

  // The caller may pass a resolved ULID (default root agent) rather than a
  // human-typed name — shorten it like every other id in the CLI.
  const agentLabel =
    opts.agent && opts.agent.length > 12 ? shortId(opts.agent) : opts.agent;
  const scope = agentLabel ? `agent ${agentLabel}` : "all budgets";
  const nRows = budget.rows.length;
  out.push(
    headerLine(
      C,
      "olle budget",
      `${scope} · ${nRows} ${nRows === 1 ? "period" : "periods"}`,
      width,
    ),
  );
  out.push("");

  if (nRows === 0) {
    out.push(
      emptyState(
        C,
        "Spend is uncapped — no budget armed for this agent.",
        "olle budget set --usd 50",
      ),
    );
    return out.join("\n");
  }

  renderBudgetRows(out, C, budget.rows, width);
  if (out.at(-1) === "") out.pop();
  return out.join("\n");
}

// Shared with stats-render's budget block by convention (same layout):
// period label, spent / cap, threshold bar, "$X left". The bar width is
// responsive — it lands on 20 (stats' fixed value) at width 80 and shrinks
// below so the line still fits a narrow terminal.
function renderBudgetRows(
  out: string[],
  C: Colorer,
  rows: BudgetStatus["rows"],
  width: number,
): void {
  // Size the money columns to their widest plain form so rows stay aligned
  // and the bar gets exactly the space that's left.
  const scPlains = rows.map(
    (r) =>
      `${fmtUsdSmart(r.spentUsd)} / ${r.capUsd != null ? fmtUsdSmart(r.capUsd) : "no cap"}`,
  );
  const scW = Math.max(17, ...scPlains.map((s) => s.length));
  const leftPlains = rows.map((r) =>
    r.capUsd != null ? `${fmtUsdSmart(Math.max(0, r.capUsd - r.spentUsd))} left` : "",
  );
  const leftW = Math.max(0, ...leftPlains.map((s) => s.length));
  // indent(2) + period(9) + scW + gap(2) + gap(2) + pct(4) + gap(3) + leftW.
  const fixed = 2 + 9 + scW + 2 + 2 + 4 + 3 + leftW;
  const barW = Math.max(4, Math.min(20, width - fixed));

  for (const r of rows) {
    const periodLabel = C(ANSI.dim, r.period.padEnd(9));
    const capPlain = r.capUsd != null ? fmtUsdSmart(r.capUsd) : "no cap";
    const spentPlain = fmtUsdSmart(r.spentUsd);
    const scPlain = `${spentPlain} / ${capPlain}`;
    const scPad = " ".repeat(Math.max(0, scW - scPlain.length));
    const scRender =
      C(ANSI.text, spentPlain) +
      C(ANSI.muted, " / ") +
      C(r.capUsd != null ? ANSI.text : ANSI.muted, capPlain) +
      scPad;

    let tail: string;
    if (r.capUsd != null) {
      const pct = r.percentUsd ?? 0;
      const b = bar(pct, barW);
      const lc = loColor(pct);
      const pctStr = `${Math.round(pct * 100)}%`.padStart(4);
      const leftStr = `${fmtUsdSmart(Math.max(0, r.capUsd - r.spentUsd))} left`.padStart(
        leftW,
      );
      tail =
        C(lc, b.filled) +
        C(ANSI.border, b.empty) +
        "  " +
        C(lc, pctStr) +
        "   " +
        C(lc, leftStr);
    } else {
      tail = C(ANSI.muted, "no cap");
    }

    out.push("  " + periodLabel + scRender + "  " + tail);
  }
}

// -------------------------------------------------------------------------
// budget set ack — what changed, colored by direction.
// -------------------------------------------------------------------------

// Structurally identical to run.ts' local BudgetSetResult.
export interface BudgetSetData {
  agentId: string | null;
  period: string;
  capUsdMicros: number | null;
  capTokens: number | null;
  spentUsdMicros: number;
  spentTokens: number;
  created: boolean;
}

export function renderBudgetSet(data: BudgetSetData, opts: RenderOpts): string {
  const C = makeColorer(opts.color);
  const verb = data.created ? "Armed" : "Updated";
  const verbColor = data.created ? ANSI.success : ANSI.text;
  const who = data.agentId ?? "owner";

  const capPart =
    data.capUsdMicros != null
      ? C(ANSI.primary, fmtUsdSmart(data.capUsdMicros))
      : C(ANSI.muted, "no cap");
  const tokPart =
    data.capTokens != null ? C(ANSI.muted, ` / ${intComma(data.capTokens)} tokens`) : "";

  const head =
    C(verbColor, `${verb} ${data.period} budget`) +
    C(ANSI.muted, ` for ${who} — cap `) +
    capPart +
    tokPart +
    C(ANSI.muted, ".");
  const spent = C(ANSI.muted, ` Spent so far ${fmtUsdSmart(data.spentUsdMicros)}.`);
  return head + spent;
}

// -------------------------------------------------------------------------
// model — current / set.
// -------------------------------------------------------------------------

export interface ModelGetData {
  model: string;
  /** True when the reported model is the host default rather than the
   *  agent's own choice. Optional: omitted renders the model plainly. */
  isDefault?: boolean;
}

export function renderModelGet(data: ModelGetData, opts: RenderOpts): string {
  const C = makeColorer(opts.color);
  if (!data.model) {
    return emptyState(
      C,
      "No model set — the agent runs the built-in default.",
      "olle model <name>",
    );
  }
  const tag = data.isDefault ? " " + C(ANSI.muted, "(host default)") : "";
  return kv(C, "model", C(ANSI.text, data.model) + tag);
}

export interface ModelSetData {
  model: string;
}
export function renderModelSet(data: ModelSetData, opts: RenderOpts): string {
  const C = makeColorer(opts.color);
  return C(ANSI.muted, "default model → ") + C(ANSI.text, data.model);
}

// -------------------------------------------------------------------------
// publish ack — muted hlc + id, one line.
// -------------------------------------------------------------------------

export interface PublishAckData {
  id: string;
  hlc: string;
}
export function renderPublishAck(data: PublishAckData, opts: RenderOpts): string {
  const C = makeColorer(opts.color);
  return C(ANSI.muted, `published · ${data.hlc} · ${data.id}`);
}
