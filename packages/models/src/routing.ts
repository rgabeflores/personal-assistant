import type { Capabilities, ModelRef, ModelTask } from "./types.js";

export type Route = { primary: ModelRef; fallback?: ModelRef };
export type Routes = Record<ModelTask, Route>;

export type ProviderKind = "anthropic" | "openai" | "openai_compatible";

export type ProviderConfig = {
  kind: ProviderKind;
  /** Required for openai_compatible; defaults to the provider's public API otherwise. */
  base_url?: string;
  /** "none" for local or self-hosted servers that take no key. Default "key". */
  auth?: "key" | "none";
  /** Env var holding the key, for local development. Default <PROVIDER>_API_KEY. */
  api_key_env?: string;
};

export type ModelConfig = {
  providers: Record<string, ProviderConfig>;
  /** Capability catalog, keyed by "provider/model". A route to an unlisted model fails at load. */
  models: Record<string, Capabilities>;
  routes: Routes;
};

/** Partial config from the environment; each section is merged over the defaults by key. */
export type ModelConfigOverride = {
  providers?: Record<string, ProviderConfig>;
  models?: Record<string, Capabilities>;
  routes?: Partial<Routes>;
};

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  providers: {
    anthropic: { kind: "anthropic" },
  },
  models: {
    "anthropic/claude-sonnet-5-5": { tools: true, streaming: true, jsonSchema: false, contextWindow: 200_000 },
    "anthropic/claude-haiku-4-5": { tools: true, streaming: true, jsonSchema: false, contextWindow: 200_000 },
  },
  // Defaults from Q-16 / D-50.
  routes: {
    "chat.agent": { primary: "anthropic/claude-sonnet-5-5" },
    "logging.simple": { primary: "anthropic/claude-haiku-4-5", fallback: "anthropic/claude-sonnet-5-5" },
    "chat.title": { primary: "anthropic/claude-haiku-4-5" },
    "chat.summary": { primary: "anthropic/claude-haiku-4-5" },
    "checkin.write": { primary: "anthropic/claude-haiku-4-5" },
    "review.write": { primary: "anthropic/claude-haiku-4-5" },
  },
};

// What each task needs from its model (model-providers.md §5).
const TASK_NEEDS: Record<ModelTask, Partial<Capabilities>> = {
  "chat.agent": { tools: true, streaming: true },
  "logging.simple": { tools: true, streaming: true },
  "chat.title": {},
  "chat.summary": {},
  "checkin.write": {},
  "review.write": {},
};

const PROVIDER_KINDS: readonly ProviderKind[] = ["anthropic", "openai", "openai_compatible"];

/**
 * Builds the model config from defaults plus the MODEL_CONFIG environment variable (JSON).
 * Adding a provider, a model, or a route is a config change, not a code change (D-53).
 */
export function loadModelConfig(override: string | ModelConfigOverride | undefined = process.env.MODEL_CONFIG): ModelConfig {
  const o: ModelConfigOverride = typeof override === "string" ? (override.trim() ? JSON.parse(override) : {}) : (override ?? {});
  for (const task of Object.keys(o.routes ?? {})) {
    if (!(task in DEFAULT_MODEL_CONFIG.routes)) throw new Error(`MODEL_CONFIG: unknown task "${task}"`);
  }
  const config: ModelConfig = {
    providers: { ...DEFAULT_MODEL_CONFIG.providers, ...o.providers },
    models: { ...DEFAULT_MODEL_CONFIG.models, ...o.models },
    routes: { ...DEFAULT_MODEL_CONFIG.routes, ...(o.routes as Routes | undefined) },
  };
  validateModelConfig(config);
  return config;
}

export function validateModelConfig(config: ModelConfig): void {
  for (const [id, p] of Object.entries(config.providers)) {
    if (id.includes("/")) throw new Error(`Model config: provider id "${id}" must not contain "/"`);
    if (!PROVIDER_KINDS.includes(p.kind)) throw new Error(`Model config: provider "${id}" has unknown kind "${p.kind}"`);
    if (p.kind === "openai_compatible" && !p.base_url) throw new Error(`Model config: provider "${id}" needs base_url`);
  }
  for (const [task, route] of Object.entries(config.routes) as [ModelTask, Route][]) {
    for (const ref of [route.primary, route.fallback]) {
      if (!ref) continue;
      const { provider } = splitRef(ref);
      if (!config.providers[provider]) throw new Error(`Model config: "${ref}" for ${task} uses unknown provider "${provider}"`);
      const caps = config.models[ref];
      if (!caps) throw new Error(`Model config: "${ref}" for ${task} has no capability entry`);
      for (const [need, required] of Object.entries(TASK_NEEDS[task]) as [keyof Capabilities, unknown][]) {
        if (required && !caps[need]) throw new Error(`Model config: ${ref} lacks "${need}", required by ${task}`);
      }
    }
  }
}

/** Providers that some route actually uses; only these need keys at startup. */
export function routedProviders(config: ModelConfig): string[] {
  const ids = new Set<string>();
  for (const r of Object.values(config.routes)) {
    ids.add(splitRef(r.primary).provider);
    if (r.fallback) ids.add(splitRef(r.fallback).provider);
  }
  return [...ids];
}

export function apiKeyEnvName(providerId: string, p: ProviderConfig): string {
  return p.api_key_env ?? `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

export function splitRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf("/");
  if (i <= 0) throw new Error(`Model ref "${ref}" must look like provider/model`);
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

/** Keys for routed providers from environment variables (local development and evals). */
export function keysFromEnv(config: ModelConfig, env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const keys: Record<string, string | undefined> = {};
  for (const id of routedProviders(config)) {
    const p = config.providers[id]!;
    if ((p.auth ?? "key") === "key") keys[id] = env[apiKeyEnvName(id, p)] || undefined;
  }
  return keys;
}
