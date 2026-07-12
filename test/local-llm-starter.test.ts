import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installStarter } from "../src/starters/index.ts";
import { validateManifestWithWarnings } from "../src/extensions/manifest.ts";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { createExtensionHost } from "../src/extensions/index.ts";
import { ulid } from "../src/id/index.ts";
import { openStore, tables } from "../src/store/index.ts";

// All network is mocked: globalThis.fetch is swapped per test and restored
// after. The staged extension calls global fetch at call time, so the mock
// sees exactly the requests the tools would send at a real server.

const realFetch = globalThis.fetch;

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const MODELS_ONE = {
  object: "list",
  data: [{ id: "Qwen3.6-27B-Q4_K_M.gguf", object: "model", owned_by: "llamacpp" }],
};

const MODELS_TWO = {
  object: "list",
  data: [
    { id: "model-a", object: "model", owned_by: "llamacpp" },
    { id: "model-b", object: "model", owned_by: "llamacpp" },
  ],
};

function completion(content: string, extra: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    model: "Qwen3.6-27B-Q4_K_M.gguf",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content, ...extra } }],
    usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 },
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "olle-local-llm-"));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(tmp, { recursive: true, force: true });
});

// Load the staged starter through the extension host so we exercise the
// same register path the daemon uses. Fetch must already be mocked before
// calling (load runs the smoke test, which hits /v1/models).
async function loadTools() {
  installStarter({ name: "local-llm", extensionsDir: tmp, authorName: "t" });
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  const host = createExtensionHost({ bus, store, hostId, extensionsDir: tmp });
  await host.load("local-llm");
  const generate = host.tools().find((t) => t.tool.name === "local_llm_generate");
  const models = host.tools().find((t) => t.tool.name === "local_llm_models");
  const ctx = (secrets: Record<string, string> = {}) => ({
    hostId,
    extensionId: "local-llm",
    actorId: "a",
    abort: new AbortController().signal,
    secrets,
  });
  const teardown = async () => {
    await host.unload("local-llm");
    bus.close();
    store.close();
  };
  return { generate, models, ctx, teardown };
}

describe("local-llm starter — manifest", () => {
  it("manifest validates clean, with catalog prose and the declared secret", () => {
    installStarter({ name: "local-llm", extensionsDir: tmp, authorName: "t" });
    const raw = readFileSync(join(tmp, "local-llm", "manifest.json"), "utf8");
    const { manifest, warnings } = validateManifestWithWarnings(JSON.parse(raw), "local-llm");
    expect(warnings).toEqual([]);
    expect(manifest.name).toBe("local-llm");
    expect(manifest.secrets).toEqual(["LOCAL_LLM_API_KEY"]);
    expect(manifest.catalog).toBeDefined();
    expect(manifest.catalog!.tagline).toBe("generating text with a local LLM");
    expect(manifest.catalog!.tools).toMatchObject({
      local_llm_generate: expect.stringContaining("auto-picks"),
      local_llm_models: expect.any(String),
    });
    const config = JSON.parse(raw).config;
    expect(config.baseUrl).toBe("http://localhost:30000");
    expect(config.apiKeySecret).toBe("LOCAL_LLM_API_KEY");
  });
});

describe("local-llm starter — tools via extension host", () => {
  it("registers both tools: operational tier, generate capped at 32KB", async () => {
    mockFetch(() => json(MODELS_ONE));
    const { generate, models, teardown } = await loadTools();
    try {
      expect(generate).toBeDefined();
      expect(models).toBeDefined();
      expect(generate!.tool.tier).toBe("operational");
      expect(models!.tool.tier).toBe("operational");
      expect(generate!.tool.maxResultBytes).toBe(32768);
    } finally {
      await teardown();
    }
  });

  it("generate happy path with explicit model: no models round-trip", async () => {
    const calls = mockFetch((url) => {
      if (url.endsWith("/v1/chat/completions")) return json(completion("hello from local"));
      return json(MODELS_ONE);
    });
    const { generate, ctx, teardown } = await loadTools();
    try {
      const before = calls.length; // smoke's /v1/models probe during load
      const r = (await generate!.tool.execute(
        { prompt: "hi", system: "be brief", model: "explicit-model", temperature: 0, max_tokens: 64 },
        ctx() as never,
      )) as { model: string; content: string; finishReason: string | null; usage?: unknown };
      const mine = calls.slice(before);
      expect(mine).toHaveLength(1); // explicit model skips /v1/models
      expect(mine[0]!.url).toBe("http://localhost:30000/v1/chat/completions");
      expect(mine[0]!.method).toBe("POST");
      expect(mine[0]!.body).toMatchObject({
        model: "explicit-model",
        temperature: 0,
        max_tokens: 64,
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hi" },
        ],
      });
      expect(r.content).toBe("hello from local");
      expect(r.finishReason).toBe("stop");
      expect(r.usage).toEqual({ promptTokens: 17, completionTokens: 5 });
    } finally {
      await teardown();
    }
  });

  it("auto-picks the single served model and caches the pick", async () => {
    const calls = mockFetch((url) => {
      if (url.endsWith("/v1/chat/completions")) return json(completion("ok"));
      return json(MODELS_ONE);
    });
    const { generate, ctx, teardown } = await loadTools();
    try {
      const before = calls.length;
      await generate!.tool.execute({ prompt: "one" }, ctx() as never);
      await generate!.tool.execute({ prompt: "two" }, ctx() as never);
      const mine = calls.slice(before);
      // One /v1/models lookup total, then two completions.
      expect(mine.filter((c) => c.url.endsWith("/v1/models"))).toHaveLength(1);
      const posts = mine.filter((c) => c.url.endsWith("/v1/chat/completions"));
      expect(posts).toHaveLength(2);
      for (const p of posts) {
        expect((p.body as { model: string }).model).toBe("Qwen3.6-27B-Q4_K_M.gguf");
      }
    } finally {
      await teardown();
    }
  });

  it("multiple served models: demands an explicit model, naming the ids", async () => {
    mockFetch(() => json(MODELS_TWO));
    const { generate, ctx, teardown } = await loadTools();
    try {
      await expect(generate!.tool.execute({ prompt: "hi" }, ctx() as never)).rejects.toThrow(
        /model-a, model-b.*pass model explicitly/,
      );
    } finally {
      await teardown();
    }
  });

  it("messages transcript form works; prompt+messages together is rejected", async () => {
    const calls = mockFetch((url) => {
      if (url.endsWith("/v1/chat/completions")) return json(completion("ok"));
      return json(MODELS_ONE);
    });
    const { generate, ctx, teardown } = await loadTools();
    try {
      await generate!.tool.execute(
        {
          messages: [
            { role: "user", content: "a" },
            { role: "assistant", content: "b" },
            { role: "user", content: "c" },
          ],
          model: "m",
        },
        ctx() as never,
      );
      const post = calls.find((c) => c.url.endsWith("/v1/chat/completions"))!;
      expect((post.body as { messages: unknown[] }).messages).toHaveLength(3);

      await expect(
        generate!.tool.execute({ prompt: "x", messages: [{ role: "user", content: "y" }] }, ctx() as never),
      ).rejects.toThrow(/not both/);
      await expect(generate!.tool.execute({}, ctx() as never)).rejects.toThrow(
        /pass prompt or messages/,
      );
    } finally {
      await teardown();
    }
  });

  it("surfaces reasoning_content from thinking models", async () => {
    mockFetch((url) => {
      if (url.endsWith("/v1/chat/completions")) {
        return json(completion("pong", { reasoning_content: "thought about it" }));
      }
      return json(MODELS_ONE);
    });
    const { generate, ctx, teardown } = await loadTools();
    try {
      const r = (await generate!.tool.execute({ prompt: "ping", model: "m" }, ctx() as never)) as {
        content: string;
        reasoning?: string;
      };
      expect(r.content).toBe("pong");
      expect(r.reasoning).toBe("thought about it");
    } finally {
      await teardown();
    }
  });

  it("models tool lists ids with owners", async () => {
    mockFetch(() => json(MODELS_TWO));
    const { models, ctx, teardown } = await loadTools();
    try {
      const r = (await models!.tool.execute({}, ctx() as never)) as {
        count: number;
        models: Array<{ id: string; ownedBy: string | null }>;
      };
      expect(r.count).toBe(2);
      expect(r.models).toEqual([
        { id: "model-a", ownedBy: "llamacpp" },
        { id: "model-b", ownedBy: "llamacpp" },
      ]);
    } finally {
      await teardown();
    }
  });

  it("sends Bearer only when the named secret is present", async () => {
    const calls = mockFetch((url) => {
      if (url.endsWith("/v1/chat/completions")) return json(completion("ok"));
      return json(MODELS_ONE);
    });
    const { generate, ctx, teardown } = await loadTools();
    try {
      await generate!.tool.execute({ prompt: "a", model: "m" }, ctx() as never);
      await generate!.tool.execute(
        { prompt: "b", model: "m" },
        ctx({ LOCAL_LLM_API_KEY: "sk-local" }) as never,
      );
      const posts = calls.filter((c) => c.url.endsWith("/v1/chat/completions"));
      expect(posts[0]!.headers.authorization).toBeUndefined();
      expect(posts[1]!.headers.authorization).toBe("Bearer sk-local");
    } finally {
      await teardown();
    }
  });

  it("error surfaces: server down names the URL; 401 hints at the secret; non-JSON is called out", async () => {
    // Load needs a healthy mock (the smoke probe hits /v1/models); each
    // error case swaps the mock afterwards.
    mockFetch(() => json(MODELS_ONE));
    const { generate, models, ctx, teardown } = await loadTools();
    try {
      // Server down — fetch rejects.
      mockFetch(() => {
        throw new TypeError("Unable to connect");
      });
      await expect(generate!.tool.execute({ prompt: "x", model: "m" }, ctx() as never)).rejects.toThrow(
        /cannot reach http:\/\/localhost:30000\/v1\/chat\/completions.*Is the server running/,
      );

      // 401 — names the secret to set.
      mockFetch(() => json({ error: { message: "Invalid API Key" } }, 401));
      await expect(generate!.tool.execute({ prompt: "x", model: "m" }, ctx() as never)).rejects.toThrow(
        /401.*LOCAL_LLM_API_KEY/,
      );

      // 500 — status + body surfaced.
      mockFetch(() => new Response("boom", { status: 500 }));
      await expect(models!.tool.execute({}, ctx() as never)).rejects.toThrow(/500.*boom/);

      // 200 but not JSON.
      mockFetch(() => new Response("<html>not an api</html>", { status: 200 }));
      await expect(models!.tool.execute({}, ctx() as never)).rejects.toThrow(/non-JSON/);

      // 200 JSON but wrong shape.
      mockFetch(() => json({ nonsense: true }));
      await expect(models!.tool.execute({}, ctx() as never)).rejects.toThrow(
        /OpenAI-shaped/,
      );
    } finally {
      await teardown();
    }
  });
});

describe("local-llm starter — smoke", () => {
  async function importSmoke(): Promise<{
    smokeTest: (bus: unknown, ctx?: { secrets?: Record<string, string> }) => Promise<void>;
  }> {
    installStarter({ name: "local-llm", extensionsDir: tmp, authorName: "t" });
    return import(pathToFileURL(join(tmp, "local-llm", "smoke.ts")).href);
  }

  it("passes against a healthy /v1/models", async () => {
    const { smokeTest } = await importSmoke();
    const calls = mockFetch(() => json(MODELS_ONE));
    await smokeTest(undefined, { secrets: {} });
    expect(calls[0]!.url).toBe("http://localhost:30000/v1/models");
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it("sends the Bearer key when the secret is set", async () => {
    const { smokeTest } = await importSmoke();
    const calls = mockFetch(() => json(MODELS_ONE));
    await smokeTest(undefined, { secrets: { LOCAL_LLM_API_KEY: "sk-x" } });
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-x");
  });

  it("fails naming the baseUrl when the server is unreachable", async () => {
    const { smokeTest } = await importSmoke();
    mockFetch(() => {
      throw new TypeError("Unable to connect");
    });
    await expect(smokeTest(undefined, { secrets: {} })).rejects.toThrow(
      /cannot reach http:\/\/localhost:30000.*Is the server running/,
    );
  });

  it("fails with the set_secret hint on 401 and the shape hint on junk", async () => {
    const { smokeTest } = await importSmoke();
    mockFetch(() => json({ error: "auth" }, 401));
    await expect(smokeTest(undefined, { secrets: {} })).rejects.toThrow(
      /401.*LOCAL_LLM_API_KEY/,
    );
    mockFetch(() => json({ hello: "world" }));
    await expect(smokeTest(undefined, { secrets: {} })).rejects.toThrow(/OpenAI-shaped/);
  });
});
