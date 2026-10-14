// Runs pending migrations as the master user, then makes sure the IAM-authenticated "app" role
// exists with the privileges the Lambdas need. Invoked once after each deploy:
//   aws lambda invoke --function-name <MigrateFunction> /dev/stdout
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { rdsTls } from "./index.js";

// rds_iam exists only on RDS, so this lives here rather than in a migration that also runs locally.
const APP_ROLE_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app LOGIN;
  END IF;
END $$;
GRANT rds_iam TO app;
GRANT USAGE ON SCHEMA public TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app;
`;

export async function handler(): Promise<{ applied: string[] }> {
  const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN }));
  const { username, password } = JSON.parse(out.SecretString ?? "{}") as { username: string; password: string };
  const connection: pg.ClientConfig = {
    host: process.env.DB_HOST,
    port: 5432,
    database: process.env.DB_NAME,
    user: username,
    password,
    ssl: rdsTls(),
  };

  const applied = await runner({
    databaseUrl: connection,
    dir: fileURLToPath(new URL("./migrations", import.meta.url)),
    migrationsTable: "pgmigrations",
    direction: "up",
    count: Infinity,
    singleTransaction: true,
    log: (msg) => console.log(msg.split("\n")[0]),
  });

  const client = new pg.Client(connection);
  await client.connect();
  try {
    await client.query(APP_ROLE_SQL);
  } finally {
    await client.end();
  }
  return { applied: applied.map((m) => m.name) };
}
