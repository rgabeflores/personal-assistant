import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Integration tests use the local Postgres from docker-compose and skip when DATABASE_URL is unset.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  test: {
    include: ["scripts/*.test.ts", "apps/chat/src/**/*.test.ts", "apps/mobile/src/lib/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
