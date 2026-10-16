import { AnthropicAdapter } from "./adapters/anthropic.js";
import { OpenAIAdapter } from "./adapters/openai.js";
import { ModelRouter } from "./router.js";
import type { ModelConfig } from "./routing.js";
import type { ModelAdapter } from "./types.js";

/** Static keys by provider id, or a lookup that can refresh them (e.g. from Secrets Manager). */
export type ProviderKeys = Record<string, string | undefined> | ((provider: string) => string | undefined | Promise<string | undefined>);

/** Builds one adapter per configured provider and a router over the configured routes. */
export function createModelRouter(config: ModelConfig, keys: ProviderKeys): ModelRouter {
  const adapters: Record<string, ModelAdapter> = {};
  for (const [id, p] of Object.entries(config.providers)) {
    const apiKey = typeof keys === "function" ? () => keys(id) : () => keys[id];
    switch (p.kind) {
      case "anthropic":
        adapters[id] = new AnthropicAdapter(apiKey);
        break;
      case "openai":
        adapters[id] = new OpenAIAdapter(id, { baseUrl: p.base_url ?? "https://api.openai.com/v1", apiKey, tokenParam: "max_completion_tokens", auth: p.auth ?? "key" });
        break;
      case "openai_compatible":
        adapters[id] = new OpenAIAdapter(id, { baseUrl: p.base_url!, apiKey, tokenParam: "max_tokens", auth: p.auth ?? "key" });
        break;
    }
  }
  return new ModelRouter(adapters, config.routes);
}
