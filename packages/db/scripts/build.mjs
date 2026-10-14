// Bundles the migration Lambda with its SQL files into dist/ for SAM.
import { build } from "esbuild";
import { cpSync, rmSync } from "node:fs";

rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: ["src/migrate-handler.ts"],
  outfile: "dist/index.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["pg-native"],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: "info",
});
cpSync("migrations", "dist/migrations", { recursive: true });
cpSync("src/rds-ca.pem", "dist/rds-ca.pem");
