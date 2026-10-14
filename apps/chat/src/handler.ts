import { getPool } from "@pa/db";
import { createModelRouter } from "@pa/models";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type { Writable } from "node:stream";
import { handleRequest, type AppDeps } from "./app.js";
import { cognitoAuthenticator, hydrateJwks } from "./auth.js";
import { loadConfig } from "./config.js";
import type { ResponseSink } from "./http.js";

// Lambda's Node.js runtime provides `awslambda` for response streaming.
declare const awslambda: {
  streamifyResponse(
    fn: (event: APIGatewayProxyEventV2, stream: Writable, context: unknown) => Promise<void>,
  ): unknown;
  HttpResponseStream: {
    from(stream: Writable, meta: { statusCode: number; headers?: Record<string, string> }): Writable;
  };
};

// Module-level init runs once per container; warm invocations (and GET /warm) reuse it.
const config = await loadConfig();
if (!config.userPoolId || !config.userPoolClientId) throw new Error("USER_POOL_ID and USER_POOL_CLIENT_ID are required");
const pool = getPool(config.db);
await Promise.all([pool.query("SELECT 1"), hydrateJwks(config.userPoolId, config.userPoolClientId)]);

const deps: AppDeps = {
  pool,
  models: createModelRouter(config.models, config.modelKeys),
  authenticate: cognitoAuthenticator(config.userPoolId, config.userPoolClientId),
};

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  let stream: Writable | undefined;
  const sink: ResponseSink = {
    start(statusCode, headers) {
      stream = awslambda.HttpResponseStream.from(responseStream, { statusCode, headers });
    },
    write(chunk) {
      stream?.write(chunk);
    },
    end() {
      (stream ?? responseStream).end();
    },
  };

  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : "";
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

  try {
    await handleRequest(deps, { method: event.requestContext.http.method, path: event.rawPath, headers, body }, sink);
  } catch (err) {
    console.error(JSON.stringify({ msg: "unhandled", error: err instanceof Error ? err.message : String(err) }));
    if (!stream) {
      sink.start(500, { "content-type": "application/json" });
      sink.write(JSON.stringify({ error: { code: "internal", message: "Something went wrong. Try again.", retryable: true } }));
    }
    sink.end();
  }
});
