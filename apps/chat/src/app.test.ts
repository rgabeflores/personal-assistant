import { describe, expect, it } from "vitest";
import { handleRequest, type AppDeps } from "./app.js";
import type { HttpRequest, ResponseSink } from "./http.js";

function capture() {
  const out = { status: 0, headers: {} as Record<string, string>, body: "", ended: false };
  const sink: ResponseSink = {
    start: (s, h) => Object.assign(out, { status: s, headers: h }),
    write: (c) => void (out.body += c),
    end: () => void (out.ended = true),
  };
  return { out, sink };
}

const noDb = new Proxy({}, { get: () => () => { throw new Error("database should not be touched"); } });
const deps = { pool: noDb, models: noDb, authenticate: async () => null } as unknown as AppDeps;
const req = (p: Partial<HttpRequest>): HttpRequest => ({ method: "GET", path: "/", headers: {}, body: "", ...p });

describe("chat app routing", () => {
  it("GET /v1/warm returns 204 without auth or database work", async () => {
    const { out, sink } = capture();
    await handleRequest(deps, req({ path: "/v1/warm" }), sink);
    expect(out).toMatchObject({ status: 204, body: "", ended: true });
  });

  it("rejects a send without a valid token before touching the database", async () => {
    const { out, sink } = capture();
    await handleRequest(deps, req({ method: "POST", path: "/v1/conversations/7c1e0000-0000-4000-8000-000000000000/messages", body: "{}" }), sink);
    expect(out.status).toBe(401);
    expect(JSON.parse(out.body).error.code).toBe("unauthorized");
  });

  it("returns 404 for unknown routes", async () => {
    const { out, sink } = capture();
    await handleRequest(deps, req({ path: "/v1/today" }), sink);
    expect(out.status).toBe(404);
  });
});
