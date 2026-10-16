import { loadModelConfig } from "@pa/models";
import { describe, expect, it } from "vitest";
import { ModelKeyStore } from "./keys.js";

const config = loadModelConfig({
  providers: { openai: { kind: "openai" }, ollama: { kind: "openai_compatible", base_url: "http://x/v1", auth: "none" } },
  models: {
    "openai/m": { tools: true, streaming: true, jsonSchema: true, contextWindow: 1000 },
    "ollama/m": { tools: true, streaming: true, jsonSchema: false, contextWindow: 1000 },
  },
  routes: { "chat.title": { primary: "openai/m" }, "chat.summary": { primary: "ollama/m" } },
});

function store(secrets: Record<string, string | undefined>, env: Record<string, string> = {}) {
  let t = 0;
  const calls: string[] = [];
  const s = new ModelKeyStore(config, env, "pa/dev/llm/", async (name) => (calls.push(name), secrets[name]), { ttlMs: 300, missingTtlMs: 30, now: () => t });
  return { s, calls, advance: (ms: number) => (t += ms) };
}

describe("ModelKeyStore", () => {
  it("prefers the env var and never calls Secrets Manager for it", async () => {
    const { s, calls } = store({}, { ANTHROPIC_API_KEY: "env-key" });
    expect(await s.get("anthropic")).toBe("env-key");
    expect(calls).not.toContain("pa/dev/llm/anthropic");
  });

  it("caches a key and re-reads it after the TTL, picking up a rotation", async () => {
    const secrets: Record<string, string | undefined> = { "pa/dev/llm/openai": "k1" };
    const { s, calls, advance } = store(secrets);
    expect(await s.get("openai")).toBe("k1");
    secrets["pa/dev/llm/openai"] = "k2";
    advance(100);
    expect(await s.get("openai")).toBe("k1");
    advance(300);
    expect(await s.get("openai")).toBe("k2");
    expect(calls.filter((c) => c === "pa/dev/llm/openai")).toHaveLength(2);
  });

  it("retries a missing key sooner, so a freshly synced key is used within seconds", async () => {
    const secrets: Record<string, string | undefined> = {};
    const { s, advance } = store(secrets);
    expect(await s.get("openai")).toBeUndefined();
    secrets["pa/dev/llm/openai"] = "new";
    advance(31);
    expect(await s.get("openai")).toBe("new");
  });

  it("asks for nothing for providers with auth none or no route", async () => {
    const { s, calls } = store({});
    expect(await s.get("ollama")).toBeUndefined();
    expect(await s.get("unrouted")).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("keeps the last key when a refresh fails", async () => {
    let fail = false;
    let t = 0;
    const s = new ModelKeyStore(config, {}, "pa/dev/llm/", async () => {
      if (fail) throw new Error("throttled");
      return "k1";
    }, { ttlMs: 10, now: () => t });
    expect(await s.get("openai")).toBe("k1");
    fail = true;
    t = 20;
    expect(await s.get("openai")).toBe("k1");
  });
});
