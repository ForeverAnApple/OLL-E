import type { StarterTemplate } from "./types.ts";

// The index.ts / smoke.ts / SETUP.md bodies are captured with String.raw so
// backslashes in the regexes survive verbatim into the on-disk file. That
// forbids two sequences inside the raw templates: a backtick (ends the
// template) and "${" (starts interpolation). The generated source therefore
// uses String.fromCharCode(96) for any literal backtick it needs and plain
// "+"-concatenation instead of template literals.

export const web: StarterTemplate = {
  name: "web",
  description:
    "SSRF-guarded web fetch. One tool: web_fetch pulls a single public http(s) URL and returns it as markdown (HTML) or text (json/plain). No crawling, no POST, no secrets.",
  files: {
    "manifest.json": JSON.stringify(
      {
        name: "web",
        version: "0.1.1",
        description:
          "SSRF-guarded single-URL fetch: web_fetch returns a public web page as markdown or text.",
        capabilities: ["tool:web"],
        catalog: {
          tagline: "fetching the public web",
          blurb:
            "Pull a single public URL and read it back as markdown (HTML) or\n" +
            "text (json/plain). Reach here to check a page, read documentation,\n" +
            "or grab a reference the conversation needs — it fetches exactly the\n" +
            "one URL you give it, never crawls, never posts.",
        },
        config: {
          // Hard wall-clock cap per fetch (ms).
          timeoutMs: 15000,
          // Max HTTP redirects to follow; each hop re-runs the SSRF guard.
          maxRedirects: 5,
          // Download cap in bytes; the body is streamed and cut here.
          maxContentBytes: 2000000,
        },
      },
      null,
      2,
    ) + "\n",

    "index.ts": String.raw`// web: a single SSRF-guarded fetch tool. Pulls one public URL and returns
// it as markdown (HTML pages) or text (json/plain). No crawling, no POST,
// no secrets. HTML is converted to markdown by a hand-rolled single pass
// using only Bun built-ins + fetch — no third-party dependency.
//
// The guard resolves the hostname to IP addresses BEFORE fetching and
// rejects any private/reserved target. Redirects are followed manually so
// every hop re-runs the FULL guard. Literal-IP URLs are checked directly.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

interface WebConfig {
  timeoutMs: number;
  maxRedirects: number;
  maxContentBytes: number;
}

const DEFAULT_CONFIG: WebConfig = {
  timeoutMs: 15000,
  maxRedirects: 5,
  maxContentBytes: 2000000,
};

const TICK = String.fromCharCode(96);
const FENCE = TICK + TICK + TICK;
const SSRF = "blocked by SSRF guard";

function loadConfig(): WebConfig {
  try {
    const here = dirname(new URL(import.meta.url).pathname);
    const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
    return { ...DEFAULT_CONFIG, ...(manifest.config ?? {}) } as WebConfig;
  } catch {
    return DEFAULT_CONFIG;
  }
}

// ---- SSRF classification -------------------------------------------------

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const a = parts[0];
  const b = parts[1];
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

// Expand a (possibly ::-compressed) IPv6 literal into 16 bytes. Returns null
// for anything malformed — callers treat null as "not classified private".
function expandV6(addr: string): number[] | null {
  let head: string[];
  let tail: string[];
  if (addr.includes("::")) {
    const halves = addr.split("::");
    if (halves.length !== 2) return null;
    head = halves[0] ? halves[0].split(":") : [];
    tail = halves[1] ? halves[1].split(":") : [];
  } else {
    head = addr.split(":");
    tail = [];
  }
  const missing = 8 - (head.length + tail.length);
  if (missing < 0) return null;
  const groups: string[] = [];
  for (const g of head) groups.push(g);
  for (let i = 0; i < missing; i++) groups.push("0");
  for (const g of tail) groups.push(g);
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    const val = parseInt(g || "0", 16);
    if (Number.isNaN(val) || val < 0 || val > 0xffff) return null;
    bytes.push((val >> 8) & 0xff, val & 0xff);
  }
  return bytes;
}

function isPrivateV6(ip: string): boolean {
  let addr = ip.toLowerCase();
  const pct = addr.indexOf("%"); // strip zone id
  if (pct >= 0) addr = addr.slice(0, pct);
  // IPv4-mapped (::ffff:x.x.x.x) — unwrap and re-check as IPv4.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  const bytes = expandV6(addr);
  if (!bytes) return false;
  if (bytes.every((b, i) => (i < 15 ? b === 0 : b === 1))) return true; // ::1
  if (bytes.every((b) => b === 0)) return true; // ::
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) return isPrivateV6(ip);
  return false;
}

// Full guard. Throws on any violation; returns the parsed URL to fetch.
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("web_fetch: invalid URL " + JSON.stringify(rawUrl));
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("web_fetch: " + SSRF + " — scheme " + u.protocol + " not allowed (http/https only)");
  }
  const hostname = u.hostname.replace(/^\[|\]$/g, "").toLowerCase(); // unbracket IPv6
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("web_fetch: " + SSRF + " — localhost is not allowed");
  }
  // Literal IP: check the literal directly, no DNS.
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error("web_fetch: " + SSRF + " — " + hostname + " is a private/reserved address");
    }
    return u;
  }
  // Resolve BEFORE fetching; reject if ANY resolved address is private.
  // Accepted limitation: DNS could rebind between this lookup and the fetch
  // below (TOCTOU). v0 does not re-pin the resolved IP onto the connection.
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(hostname, { all: true });
  } catch (err) {
    throw new Error("web_fetch: DNS lookup failed for " + hostname + " — " + (err as Error).message);
  }
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      throw new Error("web_fetch: " + SSRF + " — " + hostname + " resolves to private address " + a.address);
    }
  }
  return u;
}

// ---- HTML -> markdown (single pass, entities decoded once at the end) ----

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&"); // last, so &amp;lt; decodes to &lt; not <
}

export function htmlToMarkdown(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|noscript|head|svg)\b[\s\S]*?<\/\1>/gi, "");
  for (let i = 6; i >= 1; i--) {
    const hashes = "#".repeat(i);
    s = s.replace(new RegExp("<h" + i + "\\b[^>]*>([\\s\\S]*?)</h" + i + ">", "gi"), (_m, inner) =>
      "\n\n" + hashes + " " + stripTags(inner).trim() + "\n\n",
    );
  }
  s = s.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) =>
    "[" + stripTags(text).trim() + "](" + href + ")",
  );
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner) =>
    "\n\n" + FENCE + "\n" + stripTags(inner).trim() + "\n" + FENCE + "\n\n",
  );
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner) => TICK + stripTags(inner).trim() + TICK);
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => "**" + stripTags(inner).trim() + "**");
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => "*" + stripTags(inner).trim() + "*");
  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_m, inner) => {
    let n = 0;
    const items = inner.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_mm, li) => {
      n += 1;
      return "\n" + n + ". " + stripTags(li).trim();
    });
    return "\n" + items + "\n";
  });
  s = s.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_m, inner) => {
    const items = inner.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_mm, li) => "\n- " + stripTags(li).trim());
    return "\n" + items + "\n";
  });
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, li) => "\n- " + stripTags(li).trim()); // stray items
  s = s.replace(/<\/?(p|div|tr|br|table|thead|tbody|section|article|header|footer|h[1-6])\b[^>]*>/gi, "\n");
  s = stripTags(s);
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

// ---- fetch with byte cap + manual redirects ------------------------------

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const body = res.body;
  if (!body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    const truncated = buf.byteLength > maxBytes;
    return { text: new TextDecoder().decode(truncated ? buf.subarray(0, maxBytes) : buf), truncated };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = maxBytes - total;
    if (value.byteLength >= remaining) {
      chunks.push(value.subarray(0, remaining));
      total = maxBytes;
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

interface FetchCtx {
  abort?: AbortSignal;
}

async function webFetch(args: { url: string }, ctx: FetchCtx) {
  const config = loadConfig();
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
  const signal = ctx?.abort ? AbortSignal.any([timeoutSignal, ctx.abort]) : timeoutSignal;

  let currentUrl = args.url;
  let redirects = 0;
  for (;;) {
    const target = await assertPublicUrl(currentUrl); // full guard each hop
    const res = await fetch(target.href, {
      redirect: "manual",
      signal,
      headers: {
        "user-agent": "olle-web/0.1",
        accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*",
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (location) {
        redirects += 1;
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        if (redirects > config.maxRedirects) {
          throw new Error("web_fetch: too many redirects (limit " + config.maxRedirects + ")");
        }
        currentUrl = new URL(location, target).href;
        continue;
      }
    }
    const contentType = res.headers.get("content-type") ?? "";
    const { text, truncated } = await readCapped(res, config.maxContentBytes);
    const content = contentType.toLowerCase().includes("html") ? htmlToMarkdown(text) : text;
    const result: {
      url: string;
      status: number;
      contentType: string;
      content: string;
      truncated?: boolean;
    } = { url: target.href, status: res.status, contentType, content };
    if (truncated) result.truncated = true;
    return result;
  }
}

export function register(api: any) {
  api.registerTool({
    name: "web_fetch",
    description:
      "Fetch a single public URL over http/https and return it as markdown (HTML pages) or text (json/plain). Read-only: it never crawls and never posts. SSRF-guarded — private and reserved network targets are rejected before connect. Large bodies are capped and spilled; recover the rest with read_tool_result.",
    tier: "operational",
    category: "web",
    shortClause: "pull one public web page as markdown/text",
    maxResultBytes: 32768,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to fetch." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    execute: webFetch,
  });
}
`,

    "smoke.ts": String.raw`// Smoke: no network. Exercise the pure guard + converter helpers so a
// broken SSRF classifier or HTML pass fails the gate before activation.

import { isPrivateAddress, htmlToMarkdown } from "./index.ts";

export async function smokeTest() {
  if (!isPrivateAddress("127.0.0.1")) {
    throw new Error("web smoke: 127.0.0.1 must classify as private");
  }
  if (!isPrivateAddress("169.254.169.254")) {
    throw new Error("web smoke: link-local 169.254.169.254 must classify as private");
  }
  if (isPrivateAddress("93.184.216.34")) {
    throw new Error("web smoke: public 93.184.216.34 misclassified as private");
  }
  if (!htmlToMarkdown("<h1>x</h1>").includes("# x")) {
    throw new Error("web smoke: htmlToMarkdown lost the heading");
  }
}
`,

    "SETUP.md": String.raw`# web — setup

## What it does
Adds one tool, web_fetch. Give it an http(s) URL and it returns the page as
markdown (for HTML) or plain text (for json/plain). It fetches exactly the
one URL you hand it — it never crawls links, never submits forms, never
posts. Read-only, operational tier, no approval gate.

## Secrets
None. Nothing to store, nothing to acquire. web_fetch talks to public URLs
only.

## Config knobs (manifest.json, config object)
- timeoutMs — hard wall-clock cap per fetch. Default 15000.
- maxRedirects — how many redirect hops to follow. Each hop re-runs the full
  SSRF guard. Default 5.
- maxContentBytes — download cap in bytes; the body is streamed and cut at
  this size, with truncated: true on the result. Default 2000000 (2 MB).

## Install script (narrate this to the human)
    install_starter("web")
    register_extension("web")

register runs the smoke test first (a no-network check of the SSRF
classifier and the HTML-to-markdown pass). No secrets, no config edits
required to start.

## Guardrails
- SSRF stance: the tool resolves the hostname to its IP addresses BEFORE
  connecting and refuses any private or reserved target — loopback
  (127.0.0.0/8, ::1), RFC1918 (10/8, 172.16/12, 192.168/16), link-local
  (169.254/16, fe80::/10), unique-local (fc00::/7), CGNAT (100.64/10),
  0.0.0.0/8, and the literal hostname localhost. Redirects are followed
  manually so each hop is re-checked. Non-http(s) schemes are rejected.
- Accepted limitation: a DNS name could rebind between the safety lookup and
  the actual connection (TOCTOU). v0 does not re-pin the resolved address.
- Size: results are capped at 32 KB inline; anything larger spills to
  durable storage and is recovered with read_tool_result. The download
  itself stops at maxContentBytes so a huge page cannot exhaust memory.
- This fetches only. It never crawls, never posts, never mutates anything.
`,
  },
};
