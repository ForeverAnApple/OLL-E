// Multi-provider LLM router. Wraps the provider-specific adapters
// behind a single `Llm` so callers (agent loop, manager, ledger) never
// have to know which provider is currently selected. The active model
// is mutable at runtime; switching providers is just `setDefaultModel`.
//
// Provider routing is by model-name prefix:
//   - `gpt-*` / `o3*` / `o4*`  → openai
//   - `claude-*`               → anthropic
// New providers add a clause here. Unknown prefixes are an error at
// route time (better than silently dispatching to a default that may
// hold the wrong API key).

import type { Completion, CompletionRequest, Llm } from "./types.ts";

export interface RouterAdapters {
  anthropic?: Llm;
  openai?: Llm;
}

export interface RouterOptions {
  adapters: RouterAdapters;
  defaultModel: string;
}

export interface RouterLlm extends Llm {
  /** Swap the active default model. Throws if the model's provider
   *  adapter isn't built (e.g. no API key for that provider). */
  setDefaultModel(model: string): void;
  /** Hot-add a provider after a new API key arrives, without restarting
   *  chat. Overwrites any existing adapter for that provider. */
  setAdapter(provider: "anthropic" | "openai", adapter: Llm): void;
  /** True iff the given provider has a loaded adapter. Cheap probe for
   *  CLI validation paths that don't want to mutate state. */
  hasAdapter(provider: "anthropic" | "openai"): boolean;
  /** The provider currently active. Useful for the chat-bringup error
   *  message ("OPENAI_API_KEY needed to use gpt-5.5"). */
  readonly activeProvider: string;
}

export function providerForModel(model: string): "anthropic" | "openai" {
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-") || /^o[0-9]/.test(model)) return "openai";
  throw new Error(`unknown provider for model "${model}"`);
}

export function createRouterLlm(opts: RouterOptions): RouterLlm {
  let currentModel = opts.defaultModel;
  const adapters: RouterAdapters = { ...opts.adapters };

  function pick(model: string): Llm {
    const provider = providerForModel(model);
    const adapter = adapters[provider];
    if (!adapter) {
      const keyName = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
      throw new Error(
        `model "${model}" requires the ${provider} adapter, which isn't loaded — set ${keyName} via \`olle secret set ${keyName}\``,
      );
    }
    return adapter;
  }

  // Validate the boot default — fail loud here instead of waiting for
  // the first chat turn.
  pick(currentModel);

  return {
    get provider() {
      return providerForModel(currentModel);
    },
    get defaultModel() {
      return currentModel;
    },
    get activeProvider() {
      return providerForModel(currentModel);
    },
    async complete(req: CompletionRequest): Promise<Completion> {
      const model = req.model || currentModel;
      const adapter = pick(model);
      // Force the adapter to see the model we routed on, even when the
      // caller passed an empty string (some legacy paths default the
      // model field by reading `llm.defaultModel` — when those land here
      // they'd otherwise re-route through `currentModel` lookup again).
      return adapter.complete({ ...req, model });
    },
    setDefaultModel(model: string): void {
      // Throws if provider missing — caller surfaces to user.
      pick(model);
      currentModel = model;
    },
    setAdapter(provider, adapter): void {
      adapters[provider] = adapter;
    },
    hasAdapter(provider): boolean {
      return adapters[provider] !== undefined;
    },
  };
}
