# OLL-E Extension API

OLL-E agents author extensions themselves. This file is the complete contract: everything an extension can see, do, and break. Read it completely before your first `write_extension` call; copy the worked examples, don't reconstruct them from prose.

## Quick start

A complete pure-tool extension — two files, no smoke test needed:

```json
// manifest.json
{
  "name": "dice",
  "version": "0.1.0",
  "description": "Roll dice for decisions that deserve randomness"
}
```

```ts
// index.ts
export function register(api) {
  api.registerTool({
    name: "dice_roll",
    description: "Roll N dice with S sides; returns the rolls and their sum.",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "How many dice (1-100)" },
        sides: { type: "number", description: "Sides per die (2-1000)" },
      },
      required: ["count", "sides"],
      additionalProperties: false,
    },
    async execute({ count, sides }) {
      const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
      return { rolls, sum: rolls.reduce((a, b) => a + b, 0) };
    },
  });
}
```

Ship it with the loop — always the same three calls:

1. `write_extension({ name: "dice", files: { "manifest.json": "...", "index.ts": "..." } })` — writes `~/.olle/extensions/dice/`, validates the manifest, git-commits with your attribution. Returns `{ commit }`.
2. `run_smoke_test({ name: "dice" })` — stages a fresh copy, runs `smoke.ts` if present. Returns `{ ok: true }` or `{ ok: false, error }`. No smoke file → passes.
3. `register_extension({ name: "dice" })` — smoke gate again, then hot-load (or reload). Returns `{ status, failures }`. Your contributed tools are auto-loaded into the calling thread with their schemas in the result — call them immediately.

write → smoke → register. Every worked example below ends with this loop.

## Anatomy

```
~/.olle/extensions/<name>/
  manifest.json     # authority boundary — required; name must equal the dir name
  index.ts          # register(api) entry point — required
  smoke.ts          # optional probe; write one whenever you touch secrets, config, or a wire format
  SETUP.md, *.ts    # anything else; read back with read_extension_file
  .scratch/         # your api.scratchDir — working files, never committed as content
```

### manifest.json — every field

```json
{
  "name": "freshrss",                      // required; /^[a-z0-9][a-z0-9-_]*$/; must match the dir
  "version": "0.1.0",                      // required string
  "description": "FreshRSS adapter",       // optional
  "author": "olle-root",                   // optional
  "secrets": ["FRESHRSS_USER"],            // secret names you read; injected into api.secrets / ctx.secrets
  "capabilities": ["tool:freshrss"],       // informational in v0; the permission gate uses it in v1+
  "callsTools": ["discord_send"],          // allowlist for api.callTool — self-registered tools NOT exempt
  "eventReads": ["chat.turn-end"],         // event types you may api.on() / registerTask against; "*" = broad observer
  "eventWrites": ["freshrss.polled"],      // event types you may api.publish() / ctx.emit(); "*" = broad bridge
  "config": { "url": "https://rss.example.com" },   // known, unparsed passthrough — see below
  "catalog": { "tagline": "...", "blurb": "..." }   // catalog prose — see below
}
```

- `validateManifest` warns on **unknown manifest keys** — a typo'd `eventRead` gets caught at write time instead of silently gating nothing.
- **`config` is a known, unparsed passthrough.** The runtime never interprets it. Extensions re-read their own `manifest.json` for config, as every starter does:

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

function loadConfig() {
  const here = dirname(new URL(import.meta.url).pathname);
  const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
  return manifest.config;   // your shape, your problem
}
```

- **`catalog`** feeds the tool catalog in the agent's system prompt. `tagline` + `blurb` are required if `catalog` is present; `tools` is optional. Malformed catalog → warning + dropped, never a load failure.

```json
"catalog": {
  "tagline": "fetching the public web",
  "blurb": "2-4 lines of markdown, purposive ('when to reach for these'), rendered under the category heading.",
  "tools": { "web_fetch": "optional per-tool one-liner, used when the ToolDef lacks shortClause" }
}
```

Renderer precedence: core CATEGORY_PROSE wins for core categories → your extension's catalog prose → default blurb. **Pair it with `category: "<extension-name>"` on each ToolDef or the prose never binds** — the renderer groups by ToolDef category, not by extension.

### index.ts contract

Export `register(api)` — named or default export, both work (`"default" in mod ? mod.default : mod`). Optionally export `unload()` for teardown: clear timers, close sockets, null module state.

```ts
export function register(api) { /* register tools/triggers/tasks, subscribe */ }
export function unload() { /* teardown — must NOT call api methods */ }
```

**`unload()` runs after api revocation.** By the time it executes, every method on your api handle throws. Teardown works only on state you hold yourself. An `unload()` that throws publishes `extension.unload-failed` and moves on — it can't block the unload.

### Smoke contract

`smoke.ts` exports `smokeTest`:

```ts
// smoke.ts — signature is (bus, ctx), NOT (api)
export async function smokeTest(bus, ctx) {
  // bus          - the REAL event bus (publish/subscribe if the probe needs it)
  // ctx.secrets  - resolved values for manifest.secrets; missing secrets are absent
  //                (env is never consulted — secrets have one source of truth)
  const user = ctx?.secrets?.FRESHRSS_USER;
  if (!user) throw new Error("FRESHRSS_USER not set. Store it with set_secret.");
  // throw = fail; return = pass
}
```

It runs **in-process on a staged copy** with the real bus and real secrets — not a sandbox. Keep it read-only or idempotent: a login probe, a reachability check, a config sanity check. It runs on every `run_smoke_test` *and* again inside every `register_extension`.

**A missing `smoke.ts` is legal and passes.** This is deliberate for tool-only extensions — a pure function with no I/O has nothing to probe. Write a smoke whenever your extension touches config, secrets, or a wire format; that's where staging catches lies before they go live, and the smoke's error message is what the human sees when setup is wrong. Make it diagnose: "cannot reach URL" and "credentials rejected" are different failures — say which.

## register(api) reference

The `api` handed to `register()` is your whole world. Every member:

### api.hostId / api.extensionId

```ts
api.hostId       // this host's id — stamp it nowhere; the bus stamps it for you
api.extensionId  // your identity as an actor; audit events carry it
```

### api.registerTool(def)

```ts
api.registerTool({
  name: "web_fetch",             // globally unique; collisions are FIRST-WINS (see below)
  description: "Fetch a URL and return the body as text.",   // full text the LLM sees when loaded
  tier: "operational",           // "operational" | "strategic" | "vision"; default "operational".
                                 // Read-only/idempotent = operational; writes to the world = strategic;
                                 // rewrites mission/budget/goals = vision. Non-operational tools are
                                 // UNREACHABLE via callTool — they route through the decision inbox.
  category: "myext",             // catalog grouping; use your extension name to bind manifest.catalog prose.
                                 // Falls back to "misc" (rendered last) when absent.
  shortClause: "fetch a URL",    // one purposive clause for the catalog line; falls back to catalog.tools
  alwaysLoaded: false,           // default false = schema deferred until load_tools. Flip true only for
                                 // tools used on most turns of most threads — schemas cost context every turn.
  inputSchema: {                 // PLAIN JSON Schema object — no Zod/Valibot instances cross the boundary.
    type: "object",              // Host does minimal structural validation (required props,
    properties: { url: { type: "string" } },   // additionalProperties: false, primitive types) so a
    required: ["url"],           // wrong-shaped call gets a legible schema-carrying error.
    additionalProperties: false, // Omit inputSchema entirely → warning + { type: "object" } default.
  },
  validate(input) {              // optional deep/semantic validator; runs on the raw LLM input.
    return input;                // its return value is what execute() receives. Throw to reject.
  },
  sensitiveInputFields: ["token"],  // input props redacted from audit events + persisted messages;
                                    // execute() still gets the raw value.
  sensitiveOutput: false,        // true = whole result replaced with "[redacted]" in transcript/log/snapshot
  sensitiveOutputFields: [],     // field-level output redaction; ignored when sensitiveOutput is true
  maxResultBytes: 20_000,        // tighter cap than the 50KB system default; oversize output spills
                                 // to tool_results and the LLM gets a preview + read_tool_result handle
  async execute(args, ctx) {
    // ctx.hostId       - this host
    // ctx.extensionId  - the extension that OWNS this tool
    // ctx.actorId      - who is calling (agent id, or caller extension id via callTool)
    // ctx.abort        - AbortSignal; honor it in long fetches
    // ctx.secrets      - YOUR manifest.secrets, freshly resolved (rotation propagates without reload)
    return { ok: true };         // JSON-serializable
  },
});
```

**First-wins name collision.** A tool name is a single slot in the host registry. If the name is taken — by another extension or a double-register from your own — your registration is **dropped with a warning** and a non-durable `tool.collision-rejected` event; `register()` does not throw. Namespace your tools (`myext_fetch`, not `fetch`).

**Escaped throws vs tool errors.** An `execute()` that throws returns `is_error` to the LLM — a normal, recoverable outcome that does **not** count against the circuit breaker. Only errors that escape outside a tool call (trigger crashes, unhandled rejections attributed to your files) trip it.

### api.registerTrigger(def)

A trigger is an event *source*. Its `type` field is itself the authority statement — declaring `type: "channel-message"` is the manifest-visible promise that you emit that event type. Re-listing it in `eventWrites` is harmless but not required; a trigger can never emit anything other than its declared type. Trigger emits are **durable**.

```ts
api.registerTrigger({
  name: "issue-poller",          // human-readable label
  type: "myext.issues-changed",  // the event type every emit produces — this IS the write authority
  async start(emit, ctx) {
    // ctx: { hostId, extensionId, secrets }
    // emit(payload) publishes a durable event of the declared type.
    // After unload, emit is a silent no-op — but clear your timer anyway (see Footguns).
    timer = setInterval(async () => {
      const issues = await poll(ctx.secrets.GH_TOKEN);
      if (issues.changed) emit({ issues: issues.list });
    }, 60_000);
  },
  stop() { clearInterval(timer); },   // called on unload, before your module-level unload()
});
```

Triggers start after `register()` returns, in registration order. A `start()` that throws fails the whole load (transactional — see Lifecycle physics).

### api.registerTask(def)

Behaviors belong here. Raw `api.on()` is for fire-and-forget side effects; anything worth remembering across a restart goes through `registerTask` so it gets a `task_runs` row.

```ts
api.registerTask({
  id: "digest",                  // stable local id; the host persists it as ext:<name>:<id>
  eventType: "myext.issues-changed",  // gated: must be in manifest.eventReads (or eventReads: ["*"])
  tier: "operational",           // default "operational"
  match: (ev) => true,           // optional payload filter, runs before claiming
  concurrency: 1,                // optional
  tokenEst: 500,                 // optional LLM-token estimate for the scheduler
  async handler(ctx) {
    // ctx.event        - the triggering event (id, hlc, type, payload, threadId, ...)
    // ctx.agentId      - the agent this task is attributed to
    // ctx.secrets      - your manifest.secrets
    // ctx.emit(type, payload, { durable? })  - follow-on event, parented to the trigger;
    //                    gated by manifest.eventWrites
    // ctx.callTool(name, args, opts?)        - same as api.callTool but threads asAgent=ctx.agentId
    //                    automatically, so the acting agent's scope applies. Prefer this inside
    //                    handlers; reach for api.callTool only when no agent context applies.
    await ctx.callTool("discord_send", { channelId: "...", text: "..." });
    ctx.emit("myext.digested", { count: 3 }, { durable: true });
  },
});
```

`registerTask` throws if the host has no scheduler wired, and throws the eventReads gate error if `eventType` isn't declared.

### api.on(event, handler) → Unsubscribe

```ts
const un = api.on("chat.turn-end", async (ev) => { /* ... */ });
```

Gated by `manifest.eventReads`. Violation throws, verbatim:

```
extensions: "<name>" cannot subscribe to "<type>" — add it to manifest.eventReads
```

Subscriptions are torn down automatically on unload; you rarely need the returned unsubscribe.

### api.publish(type, payload, opts?)

```ts
api.publish("myext.polled", { count: 4 }, {
  durable: true,            // default false. Durable = persisted event row, crosses the mesh
                            // (scope permitting), replayable. Non-durable = in-process only.
  toAgentId: api.rootAgentId,  // address the event to an agent's mailbox
  threadId: "discord:123:...", // correlation id for a conversation / work stream
  parentThreadId: undefined,   // if opening a thread that descends from another
  parentEventId: undefined,
});
```

Gated by `manifest.eventWrites`. Violation throws, verbatim:

```
extensions: "<name>" cannot publish "<type>" — add it to manifest.eventWrites
```

(Task-handler `ctx.emit` uses the same gate with `cannot emit "<type>"`.)

### api.callTool(name, args, opts?)

Invoke a tool registered by any extension — **including your own; self-calls are not exempt from the allowlist**. Five gates, in order:

1. **Allowlist** — `name` must be in your `manifest.callsTools`. Makes cross-extension coupling visible in git. Throws:
   `extensions: "<name>" cannot callTool("<tool>") — add it to manifest.callsTools`
2. **Existence** — the tool must be registered right now. Throws:
   `extensions: callTool("<tool>") — tool not registered`
3. **Tier** — only `operational` tools are directly callable. Strategic/vision actions propose a decision first; the resolved-decision handler invokes the tool. Throws:
   `extensions: callTool("<tool>") — tool is tier "<tier>"; route through the decision inbox`
4. **Agent scope** — only when `opts.asAgent` is set: the acting agent's `allowTools`/`denyTools`/`allowTiers` policy runs through the same `checkTool` gate the chat agent uses. Task-handler `ctx.callTool` sets this automatically.
5. **Input validation** — the target's own `validate()`, if declared; otherwise args flow through unchanged.

```ts
const result = await api.callTool("discord_send", { channelId, text }, {
  timeoutMs: 30_000,   // default 30s hard wall-clock cap; aborts via the target's ctx.abort
  signal: undefined,   // your own AbortSignal; propagates to the target
  asAgent: undefined,  // acting agent id → gate 4 applies; omit for pure ext-to-ext plumbing
});
```

**Secret isolation:** the target runs with *its own* extension's secrets, freshly resolved; yours never cross, theirs never leak back. **Audit:** every call — success or failure — publishes a durable `tool.called` event with `{ caller, targetExtension, tool, durationMs, ok, error? }`.

### api.secrets

```ts
const token = api.secrets.DISCORD_TOKEN;   // plain Record<string, string>, resolved at load
```

Only names declared in `manifest.secrets` appear; missing ones are absent (check and fail loudly in `register` or smoke). Secrets are stored via the `set_secret` tool (name must match `/^[A-Z][A-Z0-9_]{0,63}$/`, written mode 0600, value redacted from all logs) or `olle secret set`. Extensions read secrets; they never mint them.

### api.scratchDir

`<your-extension-dir>/.scratch` — created for you, read/write, for working files. Not durable identity, not synced.

### api.rootAgentId / api.resolveMailbox(threadId)

```ts
const target = api.resolveMailbox?.(threadId) ?? api.rootAgentId;
api.publish("chat.input", { text }, { durable: true, toAgentId: target, threadId });
```

Bridges address inbound events to the root agent's mailbox by default; `resolveMailbox` returns the override when a thread has been retargeted (`retarget_thread`), else `undefined`. Both may be absent in minimal hosts — fall back exactly as above.

## Event conventions

- **Names**: `namespace.past-tense` — `freshrss.polled`, `schedule.fired`, `delivery.succeeded`. The namespace is yours; the grammar is the world's.
- **Durable vs non-durable**: durable events persist as rows, survive restarts, and cross the mesh when team-scoped; non-durable events (`chat.assistant-delta`, `tool.collision-rejected`) are in-process visualization/diagnostics. Trigger emits are always durable; `api.publish` defaults to non-durable — say `durable: true` when the event is a fact, not a flicker.
- **threadId shapes**: channel threads are `discord:<channelId>:...` or `telegram:<chatId>:...`; standing-job threads end `:job:<jobId>` (`discord:<channelId>:job:<jobId>`); CLI cron jobs run on `cron:<jobId>`. One parse contract for all bridges: `/^(discord|telegram):([^:]+):/` — capture 2 is the delivery destination. A bridge that holds no stored inbound route for a thread it can parse delivers channel-only (no reply_to).
- **Delivery audit — the bridge convention**: after attempting delivery of a turn's output, a communication bridge publishes a durable `delivery.succeeded` or `delivery.failed` with payload `{ channel, threadId, destination, jobId?, error? }` — `jobId` parsed from the `:job:` threadId suffix. Follow this in any bridge you author; it's how standing jobs and observers learn whether output actually landed.

## Lifecycle physics

These are the mechanics of your existence. None are configurable from inside an extension.

- **Staging cache-bust.** Every smoke and every load copies your directory to a fresh uniquely-named tmpdir and imports from there — Bun's ESM cache is keyed by resolved path, so this guarantees your *latest write* runs, never a stale module. Consequence: your code executes from a copy; use `import.meta.url` for paths to your own files (as the config snippet above does), never a hardcoded extensions path.
- **Transactional register.** `manifest name != dir` fails first. Then smoke gates. Then `register(api)` and trigger `start()` run; any throw purges everything you registered (tools, tasks, triggers, subscriptions), marks the extension inactive, and re-raises. No half-loaded extensions.
- **API revocation after unload.** Once your extension is unloaded — explicit unload, failed-load rollback, or breaker auto-unload — every api method throws:
  `extensions: "<name>" was unloaded; re-register before acting`
  Trigger `emit`s after revocation are dropped silently. `unload()` runs *after* revocation, so it must not call api methods. A reload mints a fresh api; the old captured one stays revoked forever.
- **Circuit breaker.** 2 failures within a rolling 5 minutes → status `crashed`, durable `extension.crashed` event, auto-unload, inbox item offering revert. Only **escaped** throws count: a tool `execute()` error returns `is_error` to the LLM and does not trip it; a trigger callback crash or an unhandled rejection attributed to your files does. Each failure also publishes durable `extension.failure` with the running count.
- **Explicit-call-only reload.** There is no fs watcher. Edits via `write_extension` take effect only at the next `register_extension` (which reloads if already loaded).
- **Git per write.** Every `write_extension` is a commit in the extensions repo with your attribution. `extension_history({ name })` lists commits; `revert_extension({ name, sha })` reverts the subtree and reloads. `list_extensions` shows everything on disk — `registered`, `unregistered` (authored in a prior session, never loaded), or `broken` (invalid manifest, error attached).
- **Lifecycle events** you can observe (with `eventReads`): `extension.loaded`, `extension.unloaded`, `extension.failure`, `extension.crashed`, `extension.unload-failed`.

## Footguns

Each pair: the mistake, then the shape that survives.

### Captured api in a timer across unload

```ts
// UNSAFE — the interval outlives the extension; after unload every tick throws
// `extensions: "myext" was unloaded; re-register before acting`, and unhandled
// rejections attributed to your files feed the circuit breaker.
export function register(api) {
  setInterval(() => api.publish("myext.ticked", {}, { durable: true }), 60_000);
}
```

```ts
// SAFE — hold the handle; unload() clears it (using no api methods).
let timer;
export function register(api) {
  timer = setInterval(() => api.publish("myext.ticked", {}, { durable: true }), 60_000);
}
export function unload() {
  clearInterval(timer);
  timer = undefined;
}
```

### Missing eventReads / eventWrites

```ts
// UNSAFE — manifest has "eventReads": []; register() throws mid-load:
// extensions: "myext" cannot subscribe to "chat.turn-end" — add it to manifest.eventReads
// The whole load rolls back — your tools vanish too.
api.on("chat.turn-end", handler);
```

```ts
// SAFE — declare intent in the manifest; the gate is the authority boundary, not a hint.
// manifest.json: "eventReads": ["chat.turn-end"], "eventWrites": ["myext.summarized"]
api.on("chat.turn-end", handler);
api.publish("myext.summarized", { ... }, { durable: true });
```

### Third-party dependencies

**There are none. Bun built-ins + `fetch` + `WebSocket` only.** Staged copies land in a tmpdir where `node_modules` can't follow — an `import "lodash"` passes nowhere, not even once. Every starter is built this way: raw `fetch` against REST APIs, native `WebSocket` for gateways, `node:fs`/`node:path`/`node:crypto` for the rest. If a capability truly needs a package, that's a decision-inbox proposal for a core-bundle addition — not an extension workaround.

```ts
// UNSAFE — dies at import time in the staging dir
import TelegramBot from "node-telegram-bot-api";
```

```ts
// SAFE — the API under every wrapper is plain HTTP
const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=50`);
const updates = await r.json();
```

### Strategic tools via callTool

```ts
// UNSAFE — gate 3 rejects it regardless of your callsTools allowlist:
// extensions: callTool("freshrss_mark_read") — tool is tier "strategic"; route through the decision inbox
await api.callTool("freshrss_mark_read", { ids });
```

```ts
// SAFE — compose operational tools; leave strategic actions to the agent + inbox.
// If your task genuinely needs a strategic action, emit an event the agent
// reacts to (it proposes the decision), or file the proposal yourself via mail.
const digest = await api.callTool("freshrss_unread", { limit: 30 });
```

### Double-registering a tool name

```ts
// UNSAFE — first-wins: the second registration is silently dropped (warning +
// non-durable tool.collision-rejected event). Your "updated" tool never exists.
api.registerTool({ name: "send", ... });    // another extension already owns "send"
```

```ts
// SAFE — namespace with your extension name; collisions become impossible.
api.registerTool({ name: "myext_send", ... });
```

## Worked examples

Each is complete and single-concept. Ship each with: `write_extension` → `run_smoke_test` → `register_extension`.

### 1. Pure tool

The quick-start `dice` extension above. No smoke, no events, no secrets — the smallest legal extension.

### 2. Poll trigger

```json
// manifest.json
{
  "name": "hn-watch",
  "version": "0.1.0",
  "description": "Emits an event when the Hacker News front page top story changes"
}
```

```ts
// index.ts — trigger type IS the write authority; no eventWrites needed
let timer;
let lastTopId = null;

export function register(api) {
  api.registerTrigger({
    name: "hn-top-poller",
    type: "hn-watch.top-changed",     // every emit is a durable event of this type
    start(emit) {
      timer = setInterval(async () => {
        const r = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
        const [topId] = await r.json();
        if (lastTopId !== null && topId !== lastTopId) emit({ storyId: topId });
        lastTopId = topId;
      }, 5 * 60_000);
    },
    stop() { clearInterval(timer); },
  });
}

export function unload() { clearInterval(timer); }
```

### 3. registerTask subscriber

```json
// manifest.json — reads the trigger's event, calls a peer's tool, emits its own
{
  "name": "hn-notify",
  "version": "0.1.0",
  "description": "Announce HN top-story changes to Discord",
  "callsTools": ["discord_send"],
  "eventReads": ["hn-watch.top-changed"],
  "eventWrites": ["hn-notify.announced"]
}
```

```ts
// index.ts
export function register(api) {
  api.registerTask({
    id: "announce",                        // persisted as ext:hn-notify:announce
    eventType: "hn-watch.top-changed",     // gated by eventReads
    async handler(ctx) {
      const { storyId } = ctx.event.payload;
      // ctx.callTool threads asAgent=ctx.agentId — the acting agent's scope applies
      await ctx.callTool("discord_send", {
        channelId: "123456789",
        text: `New HN top story: https://news.ycombinator.com/item?id=${storyId}`,
      });
      ctx.emit("hn-notify.announced", { storyId }, { durable: true });
    },
  });
}
```

### 4. callTool consumer (extension-to-extension plumbing)

```json
// manifest.json
{
  "name": "morning-brief",
  "version": "0.1.0",
  "description": "One tool that composes freshrss_unread into a compact brief",
  "callsTools": ["freshrss_unread"]
}
```

```ts
// index.ts — a tool built from another extension's tool
export function register(api) {
  api.registerTool({
    name: "morning_brief",
    description: "Compact unread-feed brief: top N headlines from the last 24h.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", default: 10 } },
      additionalProperties: false,
    },
    async execute({ limit = 10 }) {
      // No agent context here — pure plumbing; gates 1-3 + validation still apply.
      const since = Math.floor(Date.now() / 1000) - 24 * 3600;
      const unread = await api.callTool("freshrss_unread", { since, limit });
      return unread.items.map((it) => `- ${it.title} (${it.feedTitle})`).join("\n");
    },
  });
}
```

### 5. A real smoke

For an extension with `"secrets": ["FRESHRSS_USER", "FRESHRSS_API_PASSWORD"]` and `config.url`:

```ts
// smoke.ts — probes credentials + reachability, read-only, and DIAGNOSES:
// unreachable URL, missing secrets, and rejected credentials are different
// failures with different fixes. Say which one happened.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export async function smokeTest(_bus, ctx) {
  const user = ctx?.secrets?.FRESHRSS_USER;
  const password = ctx?.secrets?.FRESHRSS_API_PASSWORD;
  if (!user || !password) {
    throw new Error("FRESHRSS_USER / FRESHRSS_API_PASSWORD not set. Store them with set_secret.");
  }
  const here = dirname(new URL(import.meta.url).pathname);
  const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
  const url = (manifest.config?.url ?? "").replace(/\/$/, "");
  if (!url) throw new Error("manifest.config.url is empty — set your FreshRSS base URL and re-register.");

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  let r;
  try {
    r = await fetch(`${url}/api/greader.php/accounts/ClientLogin`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ Email: user, Passwd: password }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new Error(`cannot reach ${url} — ${err.message}. Check manifest.config.url.`);
  } finally {
    clearTimeout(t);
  }
  const text = await r.text();
  if (!r.ok || !text.includes("Auth=")) {
    throw new Error(`ClientLogin rejected (status ${r.status}). Check the credentials.`);
  }
}
```

Then, as always: `write_extension` → `run_smoke_test` (iterate here until `{ ok: true }`) → `register_extension`. If register later reports failures or the extension crashes, `extension_history` shows every commit and `revert_extension` returns you to the last shape that worked.
