// Anthropic adapter. Maps our generic LLM interface onto the Vercel
// AI SDK (`ai` + `@ai-sdk/anthropic`) and reports usage (including
// cache stats) back through the Usage shape. Pricing is computed by
// the caller via src/llm/pricing.ts — this adapter does not know dollars.
//
// Caching strategy (LOG 2026-04-24): four breakpoints, all ephemeral.
//
//   1) System prompt — caller passes a SystemSegment[] and marks which
//      segments get providerOptions.anthropic.cacheControl. The chat
//      loop uses this to keep the stable identity/principles cached
//      while the volatile mailbox sidebar sits after the breakpoint
//      and never invalidates the prefix.
//
//   2) Tools block — last tool gets providerOptions.anthropic.cacheControl.
//      Tools change less often than the conversation; one cache point
//      covers the whole tool list.
//
//   3) Last user message — the conversation prefix up through this
//      message gets cached. Next turn's append-only growth reads
//      through the cache. Standard Anthropic conversation-cache pattern.
//
// Docs: https://docs.anthropic.com/en/docs/prompt-caching
//       https://ai-sdk.dev/providers/ai-sdk-providers/anthropic#cache-control

import {
  streamText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type ToolSet,
} from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type {
  Completion,
  CompletionRequest,
  Llm,
  SystemSegment,
  ToolSpec,
} from "./types.ts";
import { createInstrumentedFetch, type FetchLike } from "./instrumented-fetch.ts";
import {
  buildMessages as buildSharedMessages,
  contentPartsToBlocks,
  mapFinishReason,
  mapUsage,
} from "./vercel-mappers.ts";

export interface AnthropicAdapterOptions {
  apiKey?: string;
  /** Override default model name. */
  model?: string;
  /** Inject a pre-built LanguageModel for tests. When set, apiKey/fetch are
   *  ignored — the injected model is reused across calls. */
  languageModel?: LanguageModel;
  /** How many transient-failure retries we'll attempt before giving up.
   *  Default 40. The AI SDK's backoff is exponential, jittered, with
   *  enough ride-out to coast through typical overload windows. */
  maxRetries?: number;
  /** Override the standard fetch (primarily for testing the retry-observability wrapper). */
  fetch?: FetchLike;
}

export const DEFAULT_MODEL = "claude-opus-4-7";
const DEFAULT_MAX_RETRIES = 40;
const CACHE_CONTROL = { type: "ephemeral" } as const;
const ANTHROPIC_CACHE_OPTIONS = { anthropic: { cacheControl: CACHE_CONTROL } } as const;

export function createAnthropicAdapter(opts: AnthropicAdapterOptions = {}): Llm {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const defaultModel = opts.model ?? DEFAULT_MODEL;

  // Default-fetch case: build the provider once and reuse. Per-call
  // construction is only needed when an onRetry hook is in play (the
  // instrumented fetch closure is per-call).
  const sharedProvider = opts.languageModel
    ? null
    : createAnthropic({
        apiKey: opts.apiKey,
        ...(opts.fetch && { fetch: opts.fetch as typeof fetch }),
      });

  return {
    provider: "anthropic",
    defaultModel,

    async complete(req: CompletionRequest): Promise<Completion> {
      let model: LanguageModel;
      if (opts.languageModel) {
        model = opts.languageModel;
      } else if (req.onRetry) {
        const fetchWrapper = createInstrumentedFetch(req.onRetry, opts.fetch ?? fetch);
        model = createAnthropic({
          apiKey: opts.apiKey,
          fetch: fetchWrapper as typeof fetch,
        }).chat(req.model);
      } else {
        model = sharedProvider!.chat(req.model);
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
        usage: mapUsage(usage, { hasCacheWrites: true }),
      };
    },
  };
}

/** Build the AI SDK `system` parameter. Returns a single string when there's
 *  no caching to express (or only one segment), else a SystemModelMessage[]
 *  carrying per-segment Anthropic cacheControl provider options. */
function buildSystem(
  system: CompletionRequest["system"],
): string | SystemModelMessage[] | undefined {
  if (!system) return undefined;
  if (typeof system === "string") {
    // Single segment cached as a whole — match prior behavior where the
    // single-string form was treated as ephemeral.
    return [{ role: "system", content: system, providerOptions: ANTHROPIC_CACHE_OPTIONS }];
  }
  const nonEmpty = system.filter((s) => s.text.length > 0);
  if (nonEmpty.length === 0) return undefined;
  return nonEmpty.map<SystemModelMessage>((s) => ({
    role: "system",
    content: s.text,
    ...(s.cache === "ephemeral" && { providerOptions: ANTHROPIC_CACHE_OPTIONS }),
  }));
}

/** Convert our neutral ToolSpec[] into an AI SDK ToolSet, marking the
 *  last tool's providerOptions with cacheControl so the entire tools
 *  block is cached as one prefix. */
function buildTools(tools: ToolSpec[] | undefined): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;
  const out: ToolSet = {};
  tools.forEach((t, i) => {
    const isLast = i === tools.length - 1;
    out[t.name] = {
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
      ...(isLast && { providerOptions: ANTHROPIC_CACHE_OPTIONS }),
    };
  });
  return out;
}

/** OLL-E messages → AI SDK ModelMessages with an Anthropic cache
 *  breakpoint on the last message's last content piece. The rest of
 *  the translation lives in vercel-mappers; only the trailing cache
 *  marker is provider-specific. */
function buildMessages(messages: ReadonlyArray<CompletionRequest["messages"][number]>): ModelMessage[] {
  const out = buildSharedMessages([...messages]);
  if (out.length > 0) {
    out[out.length - 1] = withTrailingCacheControl(out[out.length - 1]!);
  }
  return out;
}

function withTrailingCacheControl(m: ModelMessage): ModelMessage {
  if (m.role === "system") return m;  // system uses a separate path
  if (typeof m.content === "string") {
    // string content can't carry per-part providerOptions; normalize to a
    // one-text-part array and mark that part.
    if (m.role === "user") {
      return {
        ...m,
        content: [{ type: "text", text: m.content, providerOptions: ANTHROPIC_CACHE_OPTIONS }],
      };
    }
    if (m.role === "assistant") {
      return {
        ...m,
        content: [{ type: "text", text: m.content, providerOptions: ANTHROPIC_CACHE_OPTIONS }],
      };
    }
    return m;
  }
  const parts = m.content.slice() as Array<{ providerOptions?: unknown }>;
  if (parts.length === 0) return m;
  const last = parts[parts.length - 1];
  if (!last) return m;
  parts[parts.length - 1] = {
    ...last,
    providerOptions: ANTHROPIC_CACHE_OPTIONS,
  };
  return { ...m, content: parts as unknown as typeof m.content } as ModelMessage;
}

