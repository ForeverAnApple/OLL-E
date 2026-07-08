import type { StarterTemplate } from "./types.ts";

export const freshrss: StarterTemplate = {
  name: "freshrss",
  description: "FreshRSS reader adapter over the Google Reader compatible API. Tools: freshrss_unread (digest), freshrss_feeds, freshrss_mark_read. Credentials in secrets, instance URL in config.",
  files: {
    "manifest.json": JSON.stringify(
      {
        name: "freshrss",
        version: "0.1.0",
        description: "FreshRSS (Google Reader API) adapter: unread digest, feed list, mark-read.",
        secrets: ["FRESHRSS_USER", "FRESHRSS_API_PASSWORD"],
        capabilities: ["tool:freshrss"],
        config: {
          // Base URL of your FreshRSS instance, no trailing /api path.
          // e.g. https://rss.example.com
          url: "",
        },
      },
      null,
      2,
    ) + "\n",
    "index.ts":
`// freshrss: adapter over FreshRSS's Google Reader compatible API
// (/api/greader.php). ClientLogin exchanges the API password for an auth
// token (cached module-scope, re-fetched once on a 401). Three tools: an
// unread digest, a feed list, and a mark-read (strategic — it mutates state).
//
// Credentials live in secrets (FRESHRSS_USER / FRESHRSS_API_PASSWORD); the
// instance URL lives in manifest.config.url. The API password is NOT the
// web login password — it's set separately in FreshRSS Settings -> Profile.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface FreshRssConfig {
  url: string;
}

let cfg: FreshRssConfig | null = null;
let user = "";
let password = "";
let authToken: string | null = null;

function loadConfig(): FreshRssConfig {
  const here = dirname(new URL(import.meta.url).pathname);
  const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
  return manifest.config as FreshRssConfig;
}

function apiBase(): string {
  return (cfg?.url ?? "").replace(/\\/$/, "") + "/api/greader.php";
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\\s+/g, " ").trim();
}

async function clientLogin(): Promise<string> {
  const body = new URLSearchParams({ Email: user, Passwd: password });
  const r = await fetch(\`\${apiBase()}/accounts/ClientLogin\`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(\`freshrss ClientLogin: \${r.status} \${text}\`);
  const line = text.split(/\\r?\\n/).find((l) => l.startsWith("Auth="));
  if (!line) throw new Error("freshrss ClientLogin: no Auth token in response (bad credentials?)");
  return line.slice("Auth=".length).trim();
}

async function ensureAuth(): Promise<string> {
  if (authToken) return authToken;
  authToken = await clientLogin();
  return authToken;
}

// Authorized request against the Google Reader API. Re-auths once on a 401
// (token expired) then gives up.
async function greader(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const token = await ensureAuth();
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", \`GoogleLogin auth=\${token}\`);
  const r = await fetch(\`\${apiBase()}\${path}\`, { ...init, headers });
  if (r.status === 401 && retry) {
    authToken = null;
    return greader(path, init, false);
  }
  if (!r.ok) throw new Error(\`freshrss \${path}: \${r.status} \${await r.text()}\`);
  return r;
}

export function register(api: any) {
  user = api.secrets?.FRESHRSS_USER;
  password = api.secrets?.FRESHRSS_API_PASSWORD;
  if (!user || !password) {
    throw new Error("freshrss: FRESHRSS_USER / FRESHRSS_API_PASSWORD not injected; approve the proposal and set the secrets.");
  }
  cfg = loadConfig();
  if (!cfg.url) {
    throw new Error("freshrss: manifest.config.url is empty — set it to your FreshRSS base URL (e.g. https://rss.example.com) and re-register.");
  }
  authToken = null;

  api.registerTool({
    name: "freshrss_unread",
    description:
      "Unread-items digest from FreshRSS, newest first, stripped to compact shapes for a daily digest. Filters out already-read items. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "number",
          description: "Unix epoch SECONDS; only items published at or after this. Omit for no lower bound.",
        },
        limit: { type: "number", minimum: 1, maximum: 100, default: 30 },
      },
      additionalProperties: false,
    },
    async execute({ since, limit = 30 }: { since?: number; limit?: number }) {
      const n = Math.min(Math.max(1, limit), 100);
      const q = new URLSearchParams({
        output: "json",
        n: String(n),
        xt: "user/-/state/com.google/read",
      });
      if (typeof since === "number") q.set("ot", String(since));
      const r = await greader(\`/reader/api/0/stream/contents/user/-/state/com.google/reading-list?\${q}\`);
      const data = (await r.json()) as { items?: any[] };
      const items = (data.items ?? []).map((it: any) => ({
        id: it.id,
        title: it.title ?? "",
        url: it.canonical?.[0]?.href ?? it.alternate?.[0]?.href ?? null,
        published: it.published ?? null,
        feedTitle: it.origin?.title ?? null,
        summary: stripHtml(it.summary?.content ?? it.content?.content ?? "").slice(0, 500),
      }));
      return { count: items.length, items };
    },
  });

  api.registerTool({
    name: "freshrss_feeds",
    description: "List subscribed feeds with their ids and titles. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const r = await greader("/reader/api/0/subscription/list?output=json");
      const data = (await r.json()) as { subscriptions?: any[] };
      return (data.subscriptions ?? []).map((s: any) => ({
        id: s.id,
        title: s.title ?? "",
        url: s.htmlUrl ?? s.url ?? null,
        categories: (s.categories ?? []).map((c: any) => c.label).filter(Boolean),
      }));
    },
  });

  api.registerTool({
    name: "freshrss_mark_read",
    description:
      "Mark one or more items as read by their FreshRSS item ids (the id field from freshrss_unread). Mutates reader state — confirm the ids before calling.",
    tier: "strategic",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Item ids to mark read (from freshrss_unread results).",
        },
      },
      required: ["ids"],
      additionalProperties: false,
    },
    async execute({ ids }: { ids: string[] }) {
      if (!ids || !ids.length) return { marked: 0 };
      // edit-tag requires a short-lived write token.
      const tr = await greader("/reader/api/0/token");
      const token = (await tr.text()).trim();
      const body = new URLSearchParams();
      for (const id of ids) body.append("i", id);
      body.append("a", "user/-/state/com.google/read");
      body.append("T", token);
      await greader("/reader/api/0/edit-tag", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      return { marked: ids.length };
    },
  });
}

export function unload() {
  cfg = null;
  user = "";
  password = "";
  authToken = null;
}
`,
    "smoke.ts":
`// Smoke: ClientLogin only. Distinguishes an unreachable URL (fetch throws)
// from bad credentials (200-with-no-Auth or 4xx). No reads, no writes.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export async function smokeTest(_bus, ctx) {
  const user = ctx?.secrets?.FRESHRSS_USER;
  const password = ctx?.secrets?.FRESHRSS_API_PASSWORD;
  if (!user || !password) {
    throw new Error("freshrss smoke: FRESHRSS_USER / FRESHRSS_API_PASSWORD not set. Store them with set_secret. The API password is set in FreshRSS Settings -> Profile, not your web login.");
  }
  const here = dirname(new URL(import.meta.url).pathname);
  const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
  const url = (manifest.config?.url ?? "").replace(/\\/$/, "");
  if (!url) {
    throw new Error("freshrss smoke: manifest.config.url is empty — set it to your FreshRSS base URL.");
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  let r;
  try {
    r = await fetch(\`\${url}/api/greader.php/accounts/ClientLogin\`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ Email: user, Passwd: password }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new Error(\`freshrss smoke: cannot reach \${url} — \${(err as Error).message}. Check manifest.config.url.\`);
  } finally {
    clearTimeout(t);
  }
  const text = await r.text();
  if (!r.ok || !text.includes("Auth=")) {
    throw new Error(\`freshrss smoke: ClientLogin rejected (status \${r.status}). Check FRESHRSS_USER / FRESHRSS_API_PASSWORD — the API password is set in FreshRSS Settings -> Profile.\`);
  }
}
`,
  },
};
