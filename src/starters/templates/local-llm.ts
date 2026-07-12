import type { StarterTemplate } from "./types.ts";

// The index.ts / smoke.ts / SETUP.md bodies are captured with String.raw so
// escapes survive verbatim into the on-disk file (same convention as web.ts).
// That forbids backticks and "${" inside the raw templates — the generated
// source uses plain "+"-concatenation instead of template literals.

export const localLlm: StarterTemplate = {
  name: "local-llm",
  description:
    "Local OpenAI-compatible LLM adapter (llama.cpp, vLLM, LM Studio, Ollama). Tools: local_llm_generate (chat completion, auto-picks the model when only one is served), local_llm_models (list served ids). baseUrl in config; optional Bearer key via secret.",
  files: {
    "manifest.json": JSON.stringify(
      {
        name: "local-llm",
        version: "0.1.0",
        description:
          "Adapter for a local OpenAI-compatible LLM server: local_llm_generate chat-completes, local_llm_models lists what it serves.",
        secrets: ["LOCAL_LLM_API_KEY"],
        capabilities: ["tool:local-llm"],
        catalog: {
          tagline: "generating text with a local LLM",
          blurb:
            "Chat-complete against an OpenAI-compatible server running on this\n" +
            "machine (llama.cpp, vLLM, LM Studio, Ollama). Reach here to offload\n" +
            "bulk or private generation — summarizing, drafting, classifying —\n" +
            "to local weights that cost nothing per token and never leave the\n" +
            "host. This is a tool, not a brain swap: your own reasoning still\n" +
            "runs on the configured provider.",
          tools: {
            local_llm_generate:
              "chat completion from the local server; auto-picks the model when only one is served",
            local_llm_models: "list the model ids the local server currently serves",
          },
        },
        config: {
          // Where the OpenAI-compatible server listens. Operator-set; tools
          // never take a URL as input.
          baseUrl: "http://localhost:30000",
          // Hard wall-clock cap per request (ms). Local models can be slow;
          // raise this for long generations on big models.
          timeoutMs: 120000,
          // Name of the secret sent as a Bearer token when set. Leave the
          // secret unset for unauthenticated servers (llama.cpp default).
          apiKeySecret: "LOCAL_LLM_API_KEY",
        },
      },
      null,
      2,
    ) + "\n",

    "index.ts": String.raw`// local-llm: adapter for a local OpenAI-compatible LLM server (llama.cpp,
// vLLM, LM Studio, Ollama's OpenAI shim). Two tools:
//   local_llm_generate — POST /v1/chat/completions, returns the completion
//   local_llm_models   — GET  /v1/models, returns the served model ids
//
// Deliberately NO SSRF guard here: baseUrl comes from operator config in
// manifest.json, never from tool input, and pointing at localhost is the
// whole point of the extension. Contrast with web_fetch, which takes
// untrusted URLs and must guard.
//
// Auth is optional: manifest.config.apiKeySecret names a secret; when that
// secret is set it is sent as a Bearer token, otherwise no auth header goes
// out (llama.cpp without --api-key, LM Studio, Ollama need none).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface LocalLlmConfig {
  baseUrl: string;
  timeoutMs: number;
  apiKeySecret: string;
}

const DEFAULT_CONFIG: LocalLlmConfig = {
  baseUrl: "http://localhost:30000",
  timeoutMs: 120000,
  apiKeySecret: "LOCAL_LLM_API_KEY",
};

interface ToolCtx {
  abort?: AbortSignal;
  secrets?: Record<string, string>;
}

interface ModelInfo {
  id: string;
  ownedBy: string | null;
}

function loadConfig(): LocalLlmConfig {
  try {
    const here = dirname(new URL(import.meta.url).pathname);
    const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
    return { ...DEFAULT_CONFIG, ...(manifest.config ?? {}) } as LocalLlmConfig;
  } catch {
    return DEFAULT_CONFIG;
  }
}

function baseUrlOf(cfg: LocalLlmConfig): string {
  return cfg.baseUrl.replace(/\/+$/, "");
}

function headersFor(cfg: LocalLlmConfig, ctx: ToolCtx | undefined): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = cfg.apiKeySecret ? ctx?.secrets?.[cfg.apiKeySecret] : undefined;
  if (key) headers.authorization = "Bearer " + key;
  return headers;
}

// One fetch wrapper for both endpoints: timeout + abort wiring, and errors
// that name the failing URL so a misconfigured baseUrl is obvious.
async function apiFetch(
  cfg: LocalLlmConfig,
  ctx: ToolCtx | undefined,
  path: string,
  init: { method?: string; body?: string } = {},
): Promise<unknown> {
  const url = baseUrlOf(cfg) + path;
  const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs);
  const signal = ctx?.abort ? AbortSignal.any([timeoutSignal, ctx.abort]) : timeoutSignal;
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: headersFor(cfg, ctx), signal });
  } catch (err) {
    throw new Error(
      "local-llm: cannot reach " + url + " — " + (err as Error).message +
        ". Is the server running? Check manifest.config.baseUrl.",
    );
  }
  const text = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403
        ? ' (server wants an API key — set_secret("' + cfg.apiKeySecret + '", ...), see SETUP.md)'
        : "";
    throw new Error("local-llm: " + path + " returned " + res.status + hint + " — " + text.slice(0, 500));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      "local-llm: " + path + " returned non-JSON (" + text.slice(0, 200) +
        ") — is " + baseUrlOf(cfg) + " really an OpenAI-compatible server?",
    );
  }
}

export async function listModels(cfg: LocalLlmConfig, ctx: ToolCtx | undefined): Promise<ModelInfo[]> {
  const json = (await apiFetch(cfg, ctx, "/v1/models")) as {
    data?: Array<{ id?: string; owned_by?: string }>;
    models?: Array<{ model?: string; name?: string }>;
  };
  if (Array.isArray(json.data)) {
    return json.data
      .filter((m) => typeof m.id === "string")
      .map((m) => ({ id: m.id as string, ownedBy: m.owned_by ?? null }));
  }
  // Ollama-flavored fallback: some servers put the list under "models".
  if (Array.isArray(json.models)) {
    return json.models
      .map((m) => m.model ?? m.name)
      .filter((id): id is string => typeof id === "string")
      .map((id) => ({ id, ownedBy: null }));
  }
  throw new Error(
    "local-llm: /v1/models did not return an OpenAI-shaped { data: [...] } — is " +
      baseUrlOf(cfg) + " really an OpenAI-compatible server?",
  );
}

// Auto-picked model, cached for the process lifetime (one /v1/models
// round-trip, not one per call). An explicit model arg always bypasses.
let pickedModel: string | null = null;

async function resolveModel(
  cfg: LocalLlmConfig,
  ctx: ToolCtx | undefined,
  explicit: string | undefined,
): Promise<string> {
  if (explicit) return explicit;
  if (pickedModel) return pickedModel;
  const models = await listModels(cfg, ctx);
  if (models.length === 0) {
    throw new Error("local-llm: server lists no models — pass model explicitly");
  }
  if (models.length > 1) {
    throw new Error(
      "local-llm: server serves " + models.length + " models (" +
        models.map((m) => m.id).join(", ") + ") — pass model explicitly",
    );
  }
  pickedModel = models[0].id;
  return pickedModel;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface GenerateArgs {
  prompt?: string;
  messages?: ChatMessage[];
  system?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

export async function generate(args: GenerateArgs, ctx: ToolCtx | undefined, cfg: LocalLlmConfig) {
  const hasPrompt = typeof args.prompt === "string" && args.prompt.length > 0;
  const hasMessages = Array.isArray(args.messages) && args.messages.length > 0;
  if (!hasPrompt && !hasMessages) {
    throw new Error("local_llm_generate: pass prompt or messages");
  }
  if (hasPrompt && hasMessages) {
    throw new Error("local_llm_generate: pass prompt OR messages, not both");
  }
  const chat: ChatMessage[] = [];
  if (args.system) chat.push({ role: "system", content: args.system });
  if (hasMessages) for (const m of args.messages as ChatMessage[]) chat.push(m);
  if (hasPrompt) chat.push({ role: "user", content: args.prompt as string });

  const model = await resolveModel(cfg, ctx, args.model);
  const body: Record<string, unknown> = { model, messages: chat };
  if (args.temperature !== undefined) body.temperature = args.temperature;
  if (args.max_tokens !== undefined) body.max_tokens = args.max_tokens;

  const json = (await apiFetch(cfg, ctx, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify(body),
  })) as {
    model?: string;
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: string; reasoning_content?: string };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = json.choices?.[0];
  if (!choice || !choice.message) {
    throw new Error(
      "local-llm: response has no choices[0].message — raw: " + JSON.stringify(json).slice(0, 300),
    );
  }
  const result: {
    model: string;
    content: string;
    finishReason: string | null;
    reasoning?: string;
    usage?: { promptTokens: number | null; completionTokens: number | null };
  } = {
    model: json.model ?? model,
    content: choice.message.content ?? "",
    finishReason: choice.finish_reason ?? null,
  };
  // Reasoning models behind llama.cpp put thinking in reasoning_content.
  if (choice.message.reasoning_content) result.reasoning = choice.message.reasoning_content;
  if (json.usage) {
    result.usage = {
      promptTokens: json.usage.prompt_tokens ?? null,
      completionTokens: json.usage.completion_tokens ?? null,
    };
  }
  return result;
}

export function register(api: any) {
  // Config is immutable for the process lifetime — parse once.
  const config = loadConfig();

  api.registerTool({
    name: "local_llm_generate",
    category: "local-llm",
    description:
      "Chat completion from the local OpenAI-compatible LLM server (manifest.config.baseUrl). Pass prompt (single user message) or messages (full transcript), plus optional system, temperature, max_tokens. Omit model to auto-pick when the server serves exactly one; local_llm_models lists ids. Returns content, finishReason, token usage, and reasoning when the model emits it. Local weights: no per-token cost, nothing leaves the host.",
    tier: "operational",
    shortClause: "chat-complete against the local LLM server",
    maxResultBytes: 32768,
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Single user message. Shorthand for messages=[{role:'user',content:prompt}]. Pass prompt or messages, not both.",
        },
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["system", "user", "assistant"] },
              content: { type: "string" },
            },
            required: ["role", "content"],
            additionalProperties: false,
          },
          description: "Full chat transcript in OpenAI shape.",
        },
        system: { type: "string", description: "System prompt, prepended to the transcript." },
        model: {
          type: "string",
          description: "Model id (see local_llm_models). Omit to auto-pick when the server serves exactly one.",
        },
        temperature: { type: "number", minimum: 0, maximum: 2 },
        max_tokens: { type: "number", minimum: 1, description: "Cap on generated tokens (reasoning included on thinking models — leave headroom)." },
      },
      additionalProperties: false,
    },
    execute: (args: GenerateArgs, ctx: ToolCtx) => generate(args, ctx, config),
  });

  api.registerTool({
    name: "local_llm_models",
    category: "local-llm",
    description:
      "List the model ids the local OpenAI-compatible server currently serves (GET /v1/models). Read-only.",
    tier: "operational",
    shortClause: "list models served by the local LLM server",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute(_args: Record<string, never>, ctx: ToolCtx) {
      const models = await listModels(config, ctx);
      return { count: models.length, models };
    },
  });
}

export function unload() {
  pickedModel = null;
}
`,

    "smoke.ts": String.raw`// Smoke: read-only GET /v1/models with a short timeout. Proves the server
// is reachable at manifest.config.baseUrl and speaks the OpenAI shape.
// Sends the Bearer key when the named secret is set — harmless on llama.cpp
// (which leaves /v1/models open) and required by stricter servers.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export async function smokeTest(_bus: unknown, ctx?: { secrets?: Record<string, string> }) {
  let cfg: { baseUrl?: string; apiKeySecret?: string } = {};
  try {
    const here = dirname(new URL(import.meta.url).pathname);
    cfg = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8")).config ?? {};
  } catch {
    /* fall through to defaults */
  }
  const baseUrl = (cfg.baseUrl ?? "http://localhost:30000").replace(/\/+$/, "");
  const secretName = cfg.apiKeySecret ?? "LOCAL_LLM_API_KEY";
  const headers: Record<string, string> = {};
  const key = ctx?.secrets?.[secretName];
  if (key) headers.authorization = "Bearer " + key;

  let res: Response;
  try {
    res = await fetch(baseUrl + "/v1/models", { headers, signal: AbortSignal.timeout(5000) });
  } catch (err) {
    throw new Error(
      "local-llm smoke: cannot reach " + baseUrl + " — " + (err as Error).message +
        ". Is the server running? Point manifest.config.baseUrl at where it listens.",
    );
  }
  if (!res.ok) {
    throw new Error(
      "local-llm smoke: GET " + baseUrl + "/v1/models returned " + res.status +
        '. If the server requires a key, set_secret("' + secretName + '", ...) and re-register.',
    );
  }
  const json = (await res.json().catch(() => null)) as { data?: unknown; models?: unknown } | null;
  if (!json || (!Array.isArray(json.data) && !Array.isArray(json.models))) {
    throw new Error(
      "local-llm smoke: " + baseUrl + "/v1/models did not return an OpenAI-shaped { data: [...] } — is this really an OpenAI-compatible server?",
    );
  }
}
`,

    "SETUP.md": String.raw`# local-llm — setup

## What it does
Adapts a local OpenAI-compatible LLM server — llama.cpp's llama-server,
vLLM, LM Studio, Ollama's OpenAI shim — into two tools. local_llm_generate
sends a chat completion (a prompt or a full transcript, optional system /
temperature / max_tokens) and returns the completion text plus token usage.
local_llm_models lists what the server currently serves. When the server
serves exactly one model, generate picks it automatically; otherwise pass
model explicitly. Both operational tier, no approval gate.

This is a tool, not a brain swap: your own reasoning keeps running on the
configured provider. Reach for it to offload bulk or private generation to
local weights that cost nothing per token and never leave the host.

## Secrets
Usually none — llama.cpp without --api-key, LM Studio, and Ollama accept
unauthenticated requests. If the server was started with an API key (e.g.
llama-server --api-key ... or vLLM --api-key ...):

    set_secret("LOCAL_LLM_API_KEY", "<the key>")

The key goes out as a Bearer token. manifest.config.apiKeySecret names
which secret to use; leave the secret unset for open servers. Ask the human
what key their server was started with — never guess, never paste it into
chat outside set_secret.

## Config knobs (manifest.json, config object)
- baseUrl — where the server listens, no trailing slash needed. Default
  http://localhost:30000. This is operator config, not tool input: the
  tools never take a URL.
- timeoutMs — hard wall-clock cap per request. Default 120000. Local models
  can be slow; raise it for long generations on big models.
- apiKeySecret — name of the secret sent as Bearer when set. Default
  LOCAL_LLM_API_KEY.

## Install script (narrate this to the human)
    install_starter("local-llm")
    # if the server is not on http://localhost:30000, edit manifest.json config.baseUrl
    # if the server requires a key:
    set_secret("LOCAL_LLM_API_KEY", "<the key>")
    register_extension("local-llm")

register runs the smoke test first: a read-only GET /v1/models with a 5s
timeout. Its error tells you whether the server is unreachable (fix
baseUrl / start the server), rejecting auth (set the secret), or not
actually OpenAI-compatible.

## Guardrails
- No SSRF guard, on purpose. baseUrl comes from operator config and the
  whole point is talking to localhost. Contrast web_fetch, which takes
  untrusted URLs and must guard. Do not point baseUrl at hosts you do not
  control.
- Results are capped at 32 KB inline; longer completions spill and are
  recovered with read_tool_result. Cap generations with max_tokens instead
  of relying on the spill.
- Reasoning models (Qwen, DeepSeek-R1 behind llama.cpp) burn part of
  max_tokens on thinking and return it in the reasoning field — leave
  headroom or the content comes back truncated.
- Local completions cost no budget tokens, but they are not free: they
  occupy the machine's GPU/CPU while running. Keep max_tokens sane.
`,
  },
};
