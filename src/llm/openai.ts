// OpenAI adapter. Maps our generic LLM interface onto the Vercel
// AI SDK (`ai` + `@ai-sdk/openai`) and reports usage (including cache
// hits) back through the Usage shape. Pricing is computed by the caller
// via src/llm/pricing.ts — this adapter does not know dollars.
//
// Caching: OpenAI does automatic prompt caching server-side for
// supported models (no manual cache_control breakpoints). The provider-
// neutral `SystemSegment.cache` markers are accepted but ignored —
// OpenAI decides what to cache. The AI SDK normalizes cached prompt
// tokens into `inputTokenDetails.cacheReadTokens` for parity with
// Anthropic; OpenAI has no "cache creation" concept and that field
// stays 0.
//
// Tool calls: AI SDK exposes a unified shape — `tool-call` content
// parts on the assistant message, ToolModelMessage for results — so
// we don't manually explode messages for OpenAI like we used to.
//
// Docs: https://platform.openai.com/docs/guides/prompt-caching
//       https://ai-sdk.dev/providers/ai-sdk-providers/openai

import {
  streamText,
  jsonSchema,
  type LanguageModel,
  type ToolSet,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type {
  Completion,
  CompletionRequest,
  Llm,
  SystemSegment,
  ToolSpec,
} from "./types.ts";
import { createInstrumentedFetch, type FetchLike } from "./instrumented-fetch.ts";
import {
  buildMessages,
  contentPartsToBlocks,
  mapFinishReason,
  mapUsage,
} from "./vercel-mappers.ts";

export interface OpenAIAdapterOptions {
  apiKey?: string;
  /** Override default model name. */
  model?: string;
  /** Inject a pre-built LanguageModel for tests. When set, apiKey/fetch are
   *  ignored — the injected model is reused across calls. */
  languageModel?: LanguageModel;
  /** How many transient-failure retries we'll attempt before giving up.
   *  Default 40 to match the Anthropic adapter's ride-out envelope. */
  maxRetries?: number;
  /** Override the standard fetch (primarily for testing the retry-observability wrapper). */
  fetch?: FetchLike;
}

export const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_MAX_RETRIES = 40;

export function createOpenAIAdapter(opts: OpenAIAdapterOptions = {}): Llm {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const defaultModel = opts.model ?? DEFAULT_MODEL;

  // Default-fetch case: build the provider once and reuse. Per-call
  // construction is only needed when an onRetry hook is in play.
  const sharedProvider = opts.languageModel
    ? null
    : createOpenAI({
        apiKey: opts.apiKey,
        ...(opts.fetch && { fetch: opts.fetch as typeof fetch }),
      });

  return {
    provider: "openai",
    defaultModel,

    async complete(req: CompletionRequest): Promise<Completion> {
      let model: LanguageModel;
      if (opts.languageModel) {
        model = opts.languageModel;
      } else if (req.onRetry) {
        const fetchWrapper = createInstrumentedFetch(req.onRetry, opts.fetch ?? (fetch as FetchLike));
        model = createOpenAI({
          apiKey: opts.apiKey,
          fetch: fetchWrapper as typeof fetch,
        })(req.model);
      } else {
        model = sharedProvider!(req.model);
      }

      const result = streamText({
        model,
        system: buildSystem(req.system),
        messages: buildMessages(req.messages),
        tools: buildTools(req.tools),
        maxOutputTokens: req.maxTokens,
        ...(req.temperature !== undefined && { temperature: req.temperature }),
        maxRetries,
        ...(req.signal && { abortSignal: req.signal }),
        ...(req.onTextDelta && {
          onChunk: ({ chunk }) => {
            if (chunk.type === "text-delta") {
              try {
                req.onTextDelta?.(chunk.text);
              } catch {
                // A misbehaving subscriber must not blow up the LLM call.
              }
            }
          },
        }),
      });

      const [content, usage, finishReason] = await Promise.all([
        result.content,
        result.usage,
        result.finishReason,
      ]);

      return {
        content: contentPartsToBlocks(content),
        stopReason: mapFinishReason(finishReason),
        usage: mapUsage(usage, { hasCacheWrites: false }),
      };
    },
  };
}

/** OpenAI takes the system role as a single string; cache markers from
 *  the provider-neutral SystemSegment are ignored (OpenAI auto-caches).
 *  Concatenate with double newlines so segment boundaries survive as
 *  paragraph breaks in the rendered prompt. */
function buildSystem(system: CompletionRequest["system"]): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system.length > 0 ? system : undefined;
  const joined = (system as SystemSegment[])
    .filter((s) => s.text.length > 0)
    .map((s) => s.text)
    .join("\n\n");
  return joined.length > 0 ? joined : undefined;
}

function buildTools(tools: ToolSpec[] | undefined): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;
  const out: ToolSet = {};
  for (const t of tools) {
    out[t.name] = {
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
    };
  }
  return out;
}

