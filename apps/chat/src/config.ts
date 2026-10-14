import { GetSecretValueCommand, ResourceNotFoundException, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { rdsIamConfig } from "@pa/db";
import { keysFromEnv, loadModelConfig, routedProviders, type ModelConfig, type ProviderKeys } from "@pa/models";
import type pg from "pg";

export type Config = {
  db: string | pg.PoolConfig;
  models: ModelConfig;
  modelKeys: ProviderKeys;
  userPoolId: string | undefined;
  userPoolClientId: string | undefined;
};

/**
 * Resolves configuration once per container (chat-service.md §4: expensive init outside the handler).
 * In AWS the database uses IAM auth and provider keys come from Secrets Manager (ARCH §10);
 * locally both come from .env.
 */
export async function loadConfig(env = process.env): Promise<Config> {
  let db: Config["db"] | undefined = env.DATABASE_URL;
  if (!db && env.DB_HOST) {
    db = rdsIamConfig({ host: env.DB_HOST, database: env.DB_NAME ?? "assistant", user: env.DB_USER ?? "app" });
  }
  if (!db) throw new Error("No database configured (DATABASE_URL or DB_HOST)");

  const models = loadModelConfig(env.MODEL_CONFIG);
  const modelKeys = await resolveModelKeys(models, env);

  return { db, models, modelKeys, userPoolId: env.USER_POOL_ID, userPoolClientId: env.USER_POOL_CLIENT_ID };
}

/**
 * A key for each routed provider: the provider's env var if set, else the secret
 * `<MODEL_SECRET_PREFIX><provider>` (e.g. pa/dev/llm/openai). Providers with auth "none" need neither.
 * A missing key is logged, not fatal; turns routed to that provider fail until it is added.
 */
async function resolveModelKeys(models: ModelConfig, env: NodeJS.ProcessEnv): Promise<ProviderKeys> {
  const keys = keysFromEnv(models, env);
  const prefix = env.MODEL_SECRET_PREFIX;
  const sm = prefix ? new SecretsManagerClient({}) : undefined;

  await Promise.all(
    routedProviders(models).map(async (id) => {
      if ((models.providers[id]!.auth ?? "key") === "none" || keys[id]) return;
      if (sm) {
        try {
          const out = await sm.send(new GetSecretValueCommand({ SecretId: `${prefix}${id}` }));
          keys[id] = out.SecretString?.trim() || undefined;
        } catch (err) {
          if (!(err instanceof ResourceNotFoundException)) throw err;
        }
      }
      if (!keys[id]) console.warn(JSON.stringify({ msg: "model_key_missing", provider: id }));
    }),
  );
  return keys;
}
