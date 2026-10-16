import { apiKeyEnvName, routedProviders, type ModelConfig } from "@pa/models";

export type SecretFetcher = (name: string) => Promise<string | undefined>;

type Entry = { value: string | undefined; fetchedAt: number; inflight?: Promise<string | undefined> };

/**
 * Provider keys for the routed providers. An env var (local development) wins and never refreshes.
 * Otherwise the key is read from `<prefix><provider>` in Secrets Manager and re-read after `ttlMs`,
 * or after `missingTtlMs` while it is absent. Warm containers then pick up a key that the deploy
 * script synced or rotated, without a redeploy.
 */
export class ModelKeyStore {
  private readonly envKeys = new Map<string, string>();
  private readonly entries = new Map<string, Entry>();
  private readonly keyed: Set<string>;

  constructor(
    config: ModelConfig,
    env: Record<string, string | undefined>,
    private readonly prefix: string | undefined,
    private readonly fetchSecret: SecretFetcher | undefined,
    private readonly opts: { ttlMs?: number; missingTtlMs?: number; now?: () => number } = {},
  ) {
    this.keyed = new Set(routedProviders(config).filter((id) => (config.providers[id]!.auth ?? "key") === "key"));
    for (const id of this.keyed) {
      const value = env[apiKeyEnvName(id, config.providers[id]!)];
      if (value) this.envKeys.set(id, value);
    }
  }

  /** Loads every routed key once at module init and logs the ones that are missing. */
  async init(): Promise<void> {
    await Promise.all(
      [...this.keyed].map(async (id) => {
        if (!(await this.get(id))) console.warn(JSON.stringify({ msg: "model_key_missing", provider: id }));
      }),
    );
  }

  get = async (provider: string): Promise<string | undefined> => {
    const fromEnv = this.envKeys.get(provider);
    if (fromEnv) return fromEnv;
    if (!this.keyed.has(provider) || !this.fetchSecret || !this.prefix) return undefined;

    const now = (this.opts.now ?? Date.now)();
    const entry = this.entries.get(provider);
    const ttl = entry?.value ? (this.opts.ttlMs ?? 300_000) : (this.opts.missingTtlMs ?? 30_000);
    if (entry && now - entry.fetchedAt < ttl) return entry.value;
    if (entry?.inflight) return entry.inflight;

    const inflight = this.fetchSecret(`${this.prefix}${provider}`)
      .then((value) => {
        this.entries.set(provider, { value: value?.trim() || undefined, fetchedAt: now });
        return value?.trim() || undefined;
      })
      .catch((err) => {
        // Keep serving the last known key if a refresh fails.
        console.warn(JSON.stringify({ msg: "model_key_refresh_failed", provider, error: err instanceof Error ? err.name : String(err) }));
        this.entries.set(provider, { value: entry?.value, fetchedAt: now });
        return entry?.value;
      });
    this.entries.set(provider, { value: entry?.value, fetchedAt: entry?.fetchedAt ?? 0, inflight });
    return inflight;
  };
}
