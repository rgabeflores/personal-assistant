import { GetSecretValueCommand, ResourceNotFoundException, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { rdsIamConfig } from "@pa/db";
import { loadModelConfig, type ModelConfig, type ProviderKeys } from "@pa/models";
import type pg from "pg";
import { ModelKeyStore, type SecretFetcher } from "./keys.js";

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
  const prefix = env.MODEL_SECRET_PREFIX;
  const keys = new ModelKeyStore(models, env, prefix, prefix ? secretsManagerFetcher() : undefined);
  await keys.init();

  return { db, models, modelKeys: keys.get, userPoolId: env.USER_POOL_ID, userPoolClientId: env.USER_POOL_CLIENT_ID };
}

function secretsManagerFetcher(): SecretFetcher {
  const sm = new SecretsManagerClient({});
  return async (name) => {
    try {
      return (await sm.send(new GetSecretValueCommand({ SecretId: name }))).SecretString;
    } catch (err) {
      // Missing, or created by the template but never given a value.
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  };
}
