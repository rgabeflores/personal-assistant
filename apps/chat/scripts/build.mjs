// Bundles the Chat Lambda into dist/ for SAM (CodeUri: ../apps/chat/dist).
import { build } from "esbuild";
import { cpSync, rmSync } from "node:fs";

rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: ["src/handler.ts"],
  outfile: "dist/index.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: "linked",
  minify: false,
  external: ["pg-native"],
  // Some dependencies (pg) still call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: "info",
});
// RDS CA bundle, read at runtime by @pa/db for TLS verification.
cpSync("../../packages/db/src/rds-ca.pem", "dist/rds-ca.pem");
