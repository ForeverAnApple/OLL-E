// Pure renderers for the entity list/ack CLI commands — `olle extension`,
// `olle starter`, `olle secret`. Same visual language as stats-render.ts:
// theme.ts semantic palette only, plain-pad-then-color via the render.ts
// primitives, humanized numbers, humane empty states.
//
// Every function is pure: (data, opts {width, color, ...}) => string. The
// callers in run.ts fetch over IPC, compute width/color from the live
// terminal, and print what these return. Input types mirror the IPC result
// shapes run.ts already receives (see server.ts handlers).

import { ANSI } from "./theme.ts";
import {
  clip,
  emptyState,
  fmtAge,
  headerLine,
  makeColorer,
  table,
  wrap,
  type Colorer,
} from "./render.ts";

// --- input types (structurally identical to the IPC payloads) ------------

export type ExtensionStatus = "registered" | "unregistered" | "broken";

export interface ExtensionListItem {
  name: string;
  status: ExtensionStatus;
  path: string;
  error?: string;
  lastCommit?: { sha: string; date: number; subject: string };
}

export interface ExtensionHistoryItem {
  sha: string;
  author: string;
  date: number;
  subject: string;
}

export interface StarterListItem {
  name: string;
  description: string;
  /** Whether the starter ships a SETUP.md. Optional — the current
   *  starters.list IPC payload omits it; rendered only when present. */
  hasSetupGuide?: boolean;
}

export interface SecretListItem {
  name: string;
  size: number;
  updatedAt: number;
}

/** Shared list-render options. `now` is injectable so relative-age output
 *  is deterministic in tests; defaults to the wall clock. */
export interface ListRenderOpts {
  width: number;
  color: boolean;
  now?: number;
}

export interface HistoryRenderOpts extends ListRenderOpts {
  /** The extension whose history this is — drives the header. */
  name: string;
}

/** Acks are one line; width never bites, so only the color flag matters. */
export interface AckOpts {
  color: boolean;
}

// --- status vocabulary ----------------------------------------------------

interface StatusStyle {
  glyph: string;
  color: string;
  label: string;
}

const STATUS: Record<ExtensionStatus, StatusStyle> = {
  registered: { glyph: "●", color: ANSI.success, label: "registered" },
  unregistered: { glyph: "○", color: ANSI.warning, label: "unregistered" },
  broken: { glyph: "✗", color: ANSI.error, label: "broken" },
};

/** Color for a status word that may be any string (reload/revert return a
 *  bare status string, not the typed union). */
function statusColor(status: string): string {
  return (STATUS as Record<string, StatusStyle | undefined>)[status]?.color ?? ANSI.text;
}

/** Humanize a small byte count. Secrets are tokens — almost always under a
 *  kilobyte, so bytes stay legible and only large blobs round to KB. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

// --- extension list -------------------------------------------------------

function extensionDetail(e: ExtensionListItem, now: number): string {
  // Broken extensions lead with the error — the reason you're looking.
  if (e.status === "broken" && e.error) return `err: ${e.error}`;
  if (e.lastCommit) {
    return `${e.lastCommit.sha.slice(0, 8)} · ${fmtAge(now - e.lastCommit.date)} ago · ${e.lastCommit.subject}`;
  }
  return "no commits yet";
}

export function renderExtensionList(
  list: ExtensionListItem[],
  opts: ListRenderOpts,
): string {
  const C = makeColorer(opts.color);
  const now = opts.now ?? Date.now();
  const out: string[] = [];

  const broken = list.filter((e) => e.status === "broken").length;
  const countLabel = `${list.length} ${list.length === 1 ? "extension" : "extensions"}`;
  const meta = broken > 0 ? `${countLabel} · ${broken} broken` : countLabel;
  out.push(headerLine(C, "olle extension list", meta, opts.width));
  out.push("");

  if (list.length === 0) {
    out.push(
      emptyState(
        C,
        "No extensions on disk yet.",
        "olle starter list",
      ),
    );
    return out.join("\n");
  }

  const lines = table(
    C,
    list,
    [
      { cell: (e) => STATUS[e.status].glyph, color: (e) => STATUS[e.status].color },
      { cell: (e) => e.name, color: ANSI.text },
      { cell: (e) => STATUS[e.status].label, color: (e) => STATUS[e.status].color },
      {
        cell: (e) => extensionDetail(e, now),
        color: (e) => (e.status === "broken" && e.error ? ANSI.error : ANSI.muted),
        flex: true,
        min: 10,
      },
    ],
    { width: opts.width, indent: "  " },
  );
  out.push(...lines);
  return out.join("\n");
}

// --- extension history ----------------------------------------------------

export function renderExtensionHistory(
  rows: ExtensionHistoryItem[],
  opts: HistoryRenderOpts,
): string {
  const C = makeColorer(opts.color);
  const now = opts.now ?? Date.now();
  const out: string[] = [];

  const meta = `${rows.length} ${rows.length === 1 ? "commit" : "commits"}`;
  out.push(headerLine(C, `olle extension history ${opts.name}`, meta, opts.width));
  out.push("");

  if (rows.length === 0) {
    out.push(emptyState(C, `No commit history for ${opts.name} yet.`));
    return out.join("\n");
  }

  const lines = table(
    C,
    rows,
    [
      { cell: (r) => r.sha.slice(0, 8), color: ANSI.muted },
      { cell: (r) => fmtAge(now - r.date), color: ANSI.muted, align: "right" },
      { cell: (r) => r.author, color: ANSI.dim },
      { cell: (r) => r.subject, color: ANSI.text, flex: true, min: 10 },
    ],
    { width: opts.width, indent: "  " },
  );
  out.push(...lines);
  return out.join("\n");
}

// --- starter list ---------------------------------------------------------

export function renderStarterList(
  list: StarterListItem[],
  opts: ListRenderOpts,
): string {
  const C = makeColorer(opts.color);
  const out: string[] = [];

  const meta = `${list.length} ${list.length === 1 ? "starter" : "starters"}`;
  out.push(headerLine(C, "olle starter list", meta, opts.width));
  out.push("");

  if (list.length === 0) {
    out.push(emptyState(C, "No starter templates available."));
    return out.join("\n");
  }

  // A menu a human picks from: name is the item (bold), description the
  // gloss (muted), wrapped to a hanging indent under the description column.
  const indent = "  ";
  const gap = "  ";
  const nameW = Math.max(...list.map((s) => s.name.length));
  const descCol = Math.max(20, opts.width - indent.length - nameW - gap.length);
  const hang = indent + " ".repeat(nameW) + gap;

  for (const s of list) {
    const nameCell = C(ANSI.bold + ANSI.text, s.name.padEnd(nameW));
    const descLines = wrap(s.description, descCol);
    out.push(indent + nameCell + gap + C(ANSI.muted, descLines[0] ?? ""));
    for (const line of descLines.slice(1)) {
      out.push(hang + C(ANSI.muted, line));
    }
    if (s.hasSetupGuide) {
      out.push(hang + C(ANSI.info, "setup guide — read SETUP.md first"));
    }
  }
  return out.join("\n");
}

// --- secret list ----------------------------------------------------------

export function renderSecretList(
  list: SecretListItem[],
  opts: ListRenderOpts,
): string {
  const C = makeColorer(opts.color);
  const now = opts.now ?? Date.now();
  const out: string[] = [];

  const meta = `${list.length} ${list.length === 1 ? "secret" : "secrets"}`;
  out.push(headerLine(C, "olle secret list", meta, opts.width));
  out.push("");

  if (list.length === 0) {
    // Values are never rendered anywhere here — the list carries none, and
    // it stays that way.
    out.push(emptyState(C, "No secrets set.", "olle secret set <NAME>"));
    return out.join("\n");
  }

  const lines = table(
    C,
    list,
    [
      // Keep the compact left-grouped layout, but clip a pathologically long
      // name to what the terminal leaves after the fixed size/age columns so
      // the row never overflows (fmtBytes ≤ ~8, age ≤ ~4, indent+gaps ≤ ~8).
      { cell: (s) => clip(s.name, Math.max(12, opts.width - 20)), color: ANSI.text },
      { cell: (s) => fmtBytes(s.size), color: ANSI.muted, align: "right" },
      { cell: (s) => fmtAge(now - s.updatedAt), color: ANSI.muted, align: "right" },
    ],
    { width: opts.width, indent: "  " },
  );
  out.push(...lines);
  return out.join("\n");
}

// --- acks -----------------------------------------------------------------

interface AckPart {
  code?: string;
  text: string;
}

/** Consistent ack grammar: "<name> — <what happened>". Name in text, an em
 *  dash separator, then the colored body. */
function ack(C: Colorer, name: string, parts: AckPart[]): string {
  const body = parts.map((p) => (p.code ? C(p.code, p.text) : p.text)).join("");
  return C(ANSI.text, name) + C(ANSI.muted, " — ") + body;
}

export function renderExtensionReloadAck(
  r: { name: string; status: string },
  opts: AckOpts,
): string {
  const C = makeColorer(opts.color);
  return ack(C, r.name, [
    { code: ANSI.success, text: "reloaded" },
    { code: ANSI.muted, text: ", now " },
    { code: statusColor(r.status), text: r.status },
  ]);
}

export function renderExtensionRevertAck(
  r: { name: string; revertedTo: string; newCommit: string | null; status: string },
  opts: AckOpts,
): string {
  const C = makeColorer(opts.color);
  return ack(C, r.name, [
    { code: ANSI.success, text: "reverted" },
    { code: ANSI.muted, text: " to " },
    { code: ANSI.muted, text: r.revertedTo.slice(0, 8) },
    { code: ANSI.muted, text: ", now " },
    { code: statusColor(r.status), text: r.status },
  ]);
}

export function renderStarterInstallAck(
  r: {
    name: string;
    filesWritten: number;
    alreadyExisted: boolean;
    commit: string | null;
    status?: string;
  },
  opts: AckOpts,
): string {
  const C = makeColorer(opts.color);
  // alreadyExisted with zero writes = the install was a no-op (the dir was
  // left alone); anything else means files landed (fresh or --overwrite).
  if (r.alreadyExisted && r.filesWritten === 0) {
    return ack(C, r.name, [
      { code: ANSI.warning, text: "already installed" },
      { code: ANSI.muted, text: ", use " },
      { code: ANSI.text, text: "--overwrite" },
      { code: ANSI.muted, text: " to replace" },
    ]);
  }
  const parts: AckPart[] = [
    { code: ANSI.success, text: "installed" },
    { code: ANSI.muted, text: " " },
    { code: ANSI.text, text: `${r.filesWritten} ${r.filesWritten === 1 ? "file" : "files"}` },
  ];
  if (r.commit) {
    parts.push({ code: ANSI.muted, text: `, commit ${r.commit.slice(0, 8)}` });
  }
  if (r.status) {
    parts.push({ code: ANSI.muted, text: ", now " });
    parts.push({ code: statusColor(r.status), text: r.status });
  }
  return ack(C, r.name, parts);
}

export function renderSecretSetAck(
  r: { name: string; bytes: number },
  opts: AckOpts,
): string {
  const C = makeColorer(opts.color);
  return ack(C, r.name, [
    { code: ANSI.success, text: "set" },
    { code: ANSI.muted, text: ", " },
    { code: ANSI.text, text: fmtBytes(r.bytes) },
    { code: ANSI.muted, text: " written" },
  ]);
}

export function renderSecretRemoveAck(
  r: { name: string },
  opts: AckOpts,
): string {
  const C = makeColorer(opts.color);
  return ack(C, r.name, [{ code: ANSI.success, text: "removed" }]);
}
