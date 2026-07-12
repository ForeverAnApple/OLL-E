// Live e2e for the local-llm starter — exercises the REAL template code
// (install → hot-load with smoke → tool execution) against a real
// OpenAI-compatible server. Skipped automatically when nothing listens at
// the base URL, so CI without a local model server stays green.
//
// Server URL: OLLE_TEST_LOCAL_LLM_URL (default http://localhost:30000).
// If the server was started with an API key (llama-server --api-key ...),
// pass it as LOCAL_LLM_API_KEY — the test threads it through the extension
// host's secrets resolver, exercising the Bearer path for real. When the
// server demands a key we don't have, the generate tests skip instead of
// failing; models/smoke stay (llama.cpp leaves /v1/models open).

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installStarter } from "../src/starters/index.ts";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { createExtensionHost, type ExtensionHost } from "../src/extensions/index.ts";
import { ulid } from "../src/id/index.ts";
import { openStore, tables, type Store } from "../src/store/index.ts";

const BASE = (process.env.OLLE_TEST_LOCAL_LLM_URL ?? "http://localhost:30000").replace(/\/+$/, "");
const KEY = process.env.LOCAL_LLM_API_KEY;

const UP = await (async () => {
  try {
    const r = await fetch(`${BASE}/v1/models`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
})();

// Chat may be key-gated even when /v1/models is open (llama.cpp --api-key).
// One max_tokens:1 probe tells us whether generation is reachable.
const CAN_GENERATE =
  UP &&
  (await (async () => {
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (KEY) headers.authorization = `Bearer ${KEY}`;
      const r = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
        signal: AbortSignal.timeout(30000),
      });
      if (r.status === 401 || r.status === 403) {
        console.warn(
          `[local-llm-live] ${BASE} requires an API key for chat — set LOCAL_LLM_API_KEY to run the generate tests`,
        );
        return false;
      }
      return true;
    } catch {
      return false;
    }
  })());

const describeLive = UP ? describe : describe.skip;
if (!UP) {
  console.warn(`[local-llm-live] no OpenAI-compatible server at ${BASE} — skipping live e2e`);
}

describeLive("local-llm starter — live e2e", () => {
  let tmp: string;
  let host: ExtensionHost;
  let store: Store;
  let bus: ReturnType<typeof createBus>;
  let ctx: Record<string, unknown>;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "olle-local-llm-live-"));
    installStarter({ name: "local-llm", extensionsDir: tmp, authorName: "live-test" });
    // Point the staged manifest at the server under test — the same config
    // edit an operator would make when their server isn't on :30000.
    const manifestPath = join(tmp, "local-llm", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.config.baseUrl = BASE;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    store = openStore({ path: ":memory:" });
    const hostId = ulid();
    store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
    bus = createBus({ hostId, persist: persistToStore(store) });
    host = createExtensionHost({
      bus,
      store,
      hostId,
      extensionsDir: tmp,
      // Real secrets path: the resolver the daemon would back with
      // ~/.olle/secrets/ is backed here by the test env.
      secrets: (name: string) => (name === "LOCAL_LLM_API_KEY" ? KEY : undefined),
    });
    // load() runs the template's real smokeTest against the live server —
    // a smoke failure fails the suite right here.
    await host.load("local-llm");
    ctx = {
      hostId,
      extensionId: "local-llm",
      actorId: "live",
      abort: new AbortController().signal,
      secrets: KEY ? { LOCAL_LLM_API_KEY: KEY } : {},
    };
  });

  afterAll(async () => {
    if (host) await host.unload("local-llm");
    bus?.close();
    store?.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("install → smoke → register leaves both tools live", () => {
    const names = host.tools().map((t) => t.tool.name);
    expect(names).toContain("local_llm_generate");
    expect(names).toContain("local_llm_models");
  });

  it("local_llm_models lists the served model", async () => {
    const tool = host.tools().find((t) => t.tool.name === "local_llm_models")!.tool;
    const r = (await tool.execute({}, ctx as never)) as {
      count: number;
      models: Array<{ id: string; ownedBy: string | null }>;
    };
    expect(r.count).toBeGreaterThanOrEqual(1);
    for (const m of r.models) expect(typeof m.id).toBe("string");
    console.log(`[local-llm-live] served models: ${r.models.map((m) => m.id).join(", ")}`);
  });

  it.skipIf(!CAN_GENERATE)(
    "local_llm_generate auto-picks the model and returns a real completion",
    async () => {
      const tool = host.tools().find((t) => t.tool.name === "local_llm_generate")!.tool;
      const r = (await tool.execute(
        {
          prompt: "Reply with exactly the word: pong",
          temperature: 0,
          max_tokens: 1024, // reasoning models burn part of this on thinking
        },
        ctx as never,
      )) as {
        model: string;
        content: string;
        finishReason: string | null;
        reasoning?: string;
        usage?: { promptTokens: number | null; completionTokens: number | null };
      };
      expect(r.content.length).toBeGreaterThan(0);
      expect(r.model.length).toBeGreaterThan(0);
      expect(r.usage?.completionTokens ?? 0).toBeGreaterThan(0);
      console.log(
        `[local-llm-live] ${r.model} said: ${JSON.stringify(r.content)} ` +
          `(finish=${r.finishReason}, completionTokens=${r.usage?.completionTokens}` +
          `${r.reasoning ? `, reasoning=${r.reasoning.length} chars` : ""})`,
      );
    },
    120000,
  );

  it.skipIf(!CAN_GENERATE)(
    "local_llm_generate honors an explicit model and a messages transcript",
    async () => {
      const modelsTool = host.tools().find((t) => t.tool.name === "local_llm_models")!.tool;
      const listed = (await modelsTool.execute({}, ctx as never)) as {
        models: Array<{ id: string }>;
      };
      const modelId = listed.models[0]!.id;
      const tool = host.tools().find((t) => t.tool.name === "local_llm_generate")!.tool;
      const r = (await tool.execute(
        {
          model: modelId,
          system: "You answer arithmetic with just the number.",
          messages: [{ role: "user", content: "What is 2+2?" }],
          temperature: 0,
          max_tokens: 1024,
        },
        ctx as never,
      )) as { model: string; content: string };
      expect(r.content).toContain("4");
      console.log(`[local-llm-live] explicit-model (${modelId}) said: ${JSON.stringify(r.content)}`);
    },
    120000,
  );
});
