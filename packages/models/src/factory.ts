import { AnthropicAdapter } from "./adapters/anthropic.js";
import { OpenAIAdapter } from "./adapters/openai.js";
import { ModelRouter } from "./router.js";
import type { ModelConfig } from "./routing.js";
import type { ModelAdapter } from "./types.js";

export type ProviderKeys = Record<string, string | undefined>;

/** Builds one adapter per configured provider and a router over the configured routes. */
export function createModelRouter(config: ModelConfig, keys: ProviderKeys): ModelRouter {
  const adapters: Record<string, ModelAdapter> = {};
  for (const [id, p] of Object.entries(config.providers)) {
    const apiKey = () => keys[id];
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
