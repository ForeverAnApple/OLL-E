import type { StarterTemplate } from "./types.ts";

export const github: StarterTemplate = {
  name: "github",
  description: "GitHub REST adapter. Issue/PR/comment tools + a compact activity digest, using GH_TOKEN. Webhook receiver (inbound events) is deliberately left for the agent to add when a task needs it.",
  files: {
    "manifest.json": JSON.stringify(
      {
        name: "github",
        version: "0.1.0",
        description: "GitHub REST adapter: create_issue, add_comment, list_issues, close_issue, activity.",
        secrets: ["GH_TOKEN"],
        capabilities: ["tool:github"],
        config: {
          apiBase: "https://api.github.com",
          userAgent: "olle-github-adapter",
        },
      },
      null,
      2,
    ) + "\n",
    "index.ts":
`// github: REST adapter. Exposes the subset of the GitHub REST API that the
// first use cases need (create/close issues, add comments, list issues, and
// a compact activity digest). Webhook ingress (push/issue/PR events) is not
// wired here — add an http-webhook-trigger extension + a task that calls
// into this one when a task actually needs inbound events.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface GitHubConfig {
  apiBase: string;
  userAgent: string;
}

let cfg: GitHubConfig | null = null;
let authHeader = "";

function loadConfig(): GitHubConfig {
  const here = dirname(new URL(import.meta.url).pathname);
  const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
  return manifest.config as GitHubConfig;
}

async function gh(path: string, init: RequestInit = {}): Promise<any> {
  const base = cfg?.apiBase ?? "https://api.github.com";
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", authHeader);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  headers.set("User-Agent", cfg?.userAgent ?? "olle");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const r = await fetch(\`\${base}\${path}\`, { ...init, headers });
  if (!r.ok) throw new Error(\`github \${path}: \${r.status} \${await r.text()}\`);
  return r.status === 204 ? null : await r.json();
}

export function register(api: any) {
  const token = api.secrets?.GH_TOKEN;
  if (!token) throw new Error("github: GH_TOKEN not injected; approve the extension proposal and set the secret.");
  cfg = loadConfig();
  authHeader = \`Bearer \${token}\`;

  api.registerTool({
    name: "github_create_issue",
    description: "Open a new issue in a repo. Attach body, labels, assignees as needed.",
    tier: "strategic",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name, e.g. acme/api" },
        title: { type: "string" },
        body: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        assignees: { type: "array", items: { type: "string" } },
      },
      required: ["repo", "title"],
      additionalProperties: false,
    },
    async execute({ repo, title, body, labels, assignees }: { repo: string; title: string; body?: string; labels?: string[]; assignees?: string[] }) {
      return await gh(\`/repos/\${repo}/issues\`, {
        method: "POST",
        body: JSON.stringify({ title, body, labels, assignees }),
      });
    },
  });

  api.registerTool({
    name: "github_add_comment",
    description: "Add a comment to an existing issue or PR.",
    tier: "strategic",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        issue_number: { type: "number" },
        body: { type: "string" },
      },
      required: ["repo", "issue_number", "body"],
      additionalProperties: false,
    },
    async execute({ repo, issue_number, body }: { repo: string; issue_number: number; body: string }) {
      return await gh(\`/repos/\${repo}/issues/\${issue_number}/comments\`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
    },
  });

  api.registerTool({
    name: "github_list_issues",
    description: "List issues in a repo filtered by state/labels. Useful for dedup before opening new ones.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "all"], default: "open" },
        labels: { type: "string", description: "comma-separated label names" },
        per_page: { type: "number", minimum: 1, maximum: 100, default: 30 },
      },
      required: ["repo"],
      additionalProperties: false,
    },
    async execute({ repo, state = "open", labels, per_page = 30 }: { repo: string; state?: string; labels?: string; per_page?: number }) {
      const q = new URLSearchParams({ state, per_page: String(per_page) });
      if (labels) q.set("labels", labels);
      return await gh(\`/repos/\${repo}/issues?\${q}\`);
    },
  });

  api.registerTool({
    name: "github_close_issue",
    description: "Close an issue. Optional reason: completed or not_planned.",
    tier: "strategic",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        issue_number: { type: "number" },
        reason: { type: "string", enum: ["completed", "not_planned"], default: "completed" },
      },
      required: ["repo", "issue_number"],
      additionalProperties: false,
    },
    async execute({ repo, issue_number, reason = "completed" }: { repo: string; issue_number: number; reason?: string }) {
      return await gh(\`/repos/\${repo}/issues/\${issue_number}\`, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed", state_reason: reason }),
      });
    },
  });

  api.registerTool({
    name: "github_activity",
    description:
      "Compact activity digest for a repo since an ISO timestamp: recently-updated issues (incl. PRs) and new commits, stripped to small shapes suitable for a daily digest. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name, e.g. acme/api" },
        since: {
          type: "string",
          description: "ISO 8601 timestamp (e.g. 2026-07-07T00:00:00Z). Only activity at or after this.",
        },
        include: {
          type: "array",
          items: { type: "string", enum: ["issues", "commits"] },
          description: "Which streams to fetch. Default both.",
        },
        per_page: { type: "number", minimum: 1, maximum: 100, default: 30 },
      },
      required: ["repo", "since"],
      additionalProperties: false,
    },
    async execute({ repo, since, include, per_page = 30 }: { repo: string; since: string; include?: string[]; per_page?: number }) {
      const want = include && include.length ? include : ["issues", "commits"];
      const out: { since: string; issues?: unknown[]; commits?: unknown[] } = { since };
      if (want.includes("issues")) {
        const q = new URLSearchParams({ since, sort: "updated", state: "all", per_page: String(per_page) });
        const raw = (await gh(\`/repos/\${repo}/issues?\${q}\`)) ?? [];
        out.issues = raw.map((i: any) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          updated_at: i.updated_at,
          url: i.html_url,
          user: i.user?.login ?? null,
          is_pr: !!i.pull_request,
          comments: i.comments,
        }));
      }
      if (want.includes("commits")) {
        const q = new URLSearchParams({ since, per_page: String(per_page) });
        const raw = (await gh(\`/repos/\${repo}/commits?\${q}\`)) ?? [];
        out.commits = raw.map((c: any) => ({
          sha: c.sha,
          message: (c.commit?.message ?? "").split("\\n")[0],
          author: c.commit?.author?.name ?? c.author?.login ?? null,
          date: c.commit?.author?.date ?? null,
          url: c.html_url,
        }));
      }
      return out;
    },
  });
}

export function unload() {
  cfg = null;
  authHeader = "";
}
`,
    "smoke.ts":
`// Smoke: confirm GH_TOKEN is accepted by calling /user. Doesn't mutate
// anything. Token comes from the secrets store only; env is reserved for
// behavior config, never secrets.

export async function smokeTest(_bus, ctx) {
  const token = ctx?.secrets?.GH_TOKEN;
  if (!token) {
    throw new Error("github smoke: GH_TOKEN not set. Ask olle to store it (set_secret tool) or run: printf %s \\"\\$TOKEN\\" | olle secret set GH_TOKEN");
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: \`Bearer \${token}\`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "olle-smoke",
      },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      throw new Error(\`github smoke: /user returned \${r.status} \${await r.text()}\`);
    }
    const user = await r.json() as { login?: string };
    if (!user?.login) {
      throw new Error("github smoke: unexpected response shape from /user");
    }
  } finally {
    clearTimeout(t);
  }
}
`,
  },
};
