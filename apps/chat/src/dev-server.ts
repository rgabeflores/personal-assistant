// Local HTTP adapter for the Chat Lambda. `sam local` cannot emulate response streaming
// (ARCH §11), so this serves the same handleRequest over plain Node HTTP.
import { getPool } from "@pa/db";
import { createModelRouter } from "@pa/models";
import { createServer } from "node:http";
import { handleRequest } from "./app.js";
import { cognitoAuthenticator, type Authenticate } from "./auth.js";
import { loadConfig } from "./config.js";

const config = await loadConfig();
const pool = getPool(config.db);
const port = Number(process.env.PORT ?? 8787);

// With no Authorization header, requests act as DEV_AUTH_SUB. A Bearer token is verified for real
// when a user pool is configured, so the app can be pointed here with genuine Cognito tokens.
const devSub = process.env.DEV_AUTH_SUB;
const cognito = config.userPoolId && config.userPoolClientId ? cognitoAuthenticator(config.userPoolId, config.userPoolClientId) : undefined;
const authenticate: Authenticate = async (authorization) => {
  if (authorization && cognito) return cognito(authorization);
  if (!authorization && devSub) return { sub: devSub };
  return null;
};

const deps = {
  pool,
  models: createModelRouter(config.models, config.modelKeys),
  authenticate,
};

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v]));
  try {
    await handleRequest(
      deps,
      { method: req.method ?? "GET", path: new URL(req.url ?? "/", "http://local").pathname, headers, body: Buffer.concat(chunks).toString("utf8") },
      {
        start: (status, h) => res.writeHead(status, h),
        write: (chunk) => void res.write(chunk),
        end: () => res.end(),
      },
    );
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "internal", message: "Unhandled error", retryable: true } }));
  }
}).listen(port, () => {
  console.log(`chat dev server on http://localhost:${port} (auth: ${devSub ? `DEV_AUTH_SUB=${devSub}` : "Bearer only"})`);
});
