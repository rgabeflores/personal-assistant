import { Signer } from "@aws-sdk/rds-signer";
import { readFileSync } from "node:fs";
import pg from "pg";

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

let pool: pg.Pool | undefined;

/**
 * One pool per Lambda container, created at module load and reused by warm invocations.
 * Takes a connection string (local) or a full config (AWS, see rdsIamConfig).
 */
export function getPool(config: string | pg.PoolConfig | undefined = process.env.DATABASE_URL): pg.Pool {
  if (!pool) {
    if (!config) throw new Error("DATABASE_URL is not set");
    // Reserved concurrency (5) × 2 connections stays far below the instance's connection limit.
    const base = { max: 2, idleTimeoutMillis: 60_000 };
    pool = new pg.Pool(typeof config === "string" ? { ...base, connectionString: config } : { ...base, ...config });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** TLS options for RDS: verify the server against Amazon's RDS CA bundle (bundled next to this module). */
export function rdsTls(): pg.PoolConfig["ssl"] {
  return { rejectUnauthorized: true, ca: readFileSync(new URL("./rds-ca.pem", import.meta.url), "utf8") };
}

/**
 * Connects with IAM database authentication: each new connection uses a fresh 15-minute token,
 * so no database password is stored or passed to the app (Q-24).
 */
export function rdsIamConfig(opts: { host: string; database: string; user: string; region?: string }): pg.PoolConfig {
  const signer = new Signer({ hostname: opts.host, port: 5432, username: opts.user, region: opts.region ?? process.env.AWS_REGION });
  return {
    host: opts.host,
    port: 5432,
    database: opts.database,
    user: opts.user,
    password: () => signer.getAuthToken(),
    ssl: rdsTls(),
  };
}
