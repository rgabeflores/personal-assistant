// Local migrations: node scripts/migrate.mjs [up|down] [count]. Reads DATABASE_URL from the root .env.
import { runner } from "node-pg-migrate";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (!process.env.DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

const [direction = "up", count] = process.argv.slice(2);
const applied = await runner({
  databaseUrl: process.env.DATABASE_URL,
  dir: fileURLToPath(new URL("../migrations", import.meta.url)),
  migrationsTable: "pgmigrations",
  direction,
  count: count ? Number(count) : direction === "up" ? Infinity : 1,
  singleTransaction: true,
  log: () => {},
});
console.log(applied.length ? `Applied ${direction}: ${applied.map((m) => m.name).join(", ")}` : "No migrations to run.");
