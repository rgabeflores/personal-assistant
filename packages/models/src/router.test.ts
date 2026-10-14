import { describe, expect, it } from "vitest";
import { ModelError, ModelRouter, ScriptedAdapter, loadModelConfig, routedProviders, toAnthropicRequest, type ModelRequest } from "./index.js";

const req: ModelRequest = { system: "sys", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], maxTokens: 100 };
const done = (model: `${string}/${string}`) => ({ type: "done", stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 }, model }) as const;

describe("ModelRouter", () => {
  it("collects text and tool calls into canonical blocks", async () => {
    const adapter = new ScriptedAdapter([
      [
        { type: "text.delta", text: "Logging " },
        { type: "text.delta", text: "that." },
        { type: "tool_call", id: "t1", name: "log_entry", input: { activity: "capoeira" } },
        { ...done("anthropic/claude-sonnet-5-5"), stopReason: "tool_use" },
      ],
    ]);
    const deltas: string[] = [];
    const res = await new ModelRouter({ anthropic: adapter }).complete("chat.agent", req, { onText: (t) => deltas.push(t) });
    expect(deltas).toEqual(["Logging ", "that."]);
    expect(res.content).toEqual([
      { type: "text", text: "Logging that." },
      { type: "tool_call", id: "t1", name: "log_entry", input: { activity: "capoeira" } },
    ]);
    expect(res.stopReason).toBe("tool_use");
  });

  it("retries once, then uses the fallback, when nothing has streamed", async () => {
    const adapter = new ScriptedAdapter([
      new ModelError("overloaded", true, 529),
      new ModelError("overloaded", true, 529),
      [{ type: "text.delta", text: "ok" }, done("anthropic/claude-sonnet-5-5")],
    ]);
    const res = await new ModelRouter({ anthropic: adapter }).complete("logging.simple", req);
    expect(adapter.requests.map((r) => r.model)).toEqual(["claude-haiku-4-5", "claude-haiku-4-5", "claude-sonnet-5-5"]);
    expect(res.model).toBe("anthropic/claude-sonnet-5-5");
  });

  it("does not retry non-retryable errors", async () => {
    const adapter = new ScriptedAdapter([new ModelError("bad request", false, 400)]);
    await expect(new ModelRouter({ anthropic: adapter }).complete("chat.agent", req)).rejects.toThrow("bad request");
    expect(adapter.requests).toHaveLength(1);
  });

  it("fails instead of falling back once text has streamed", async () => {
    let calls = 0;
    const midStream = {
      async *stream() {
        calls++;
        yield { type: "text.delta" as const, text: "partial" };
        throw new ModelError("connection reset", true);
      },
    };
    await expect(new ModelRouter({ anthropic: midStream }).complete("logging.simple", req)).rejects.toThrow("connection reset");
    expect(calls).toBe(1);
  });
});

describe("loadModelConfig", () => {
  it("merges overrides per task", () => {
    const { routes } = loadModelConfig('{"routes":{"chat.title":{"primary":"anthropic/claude-sonnet-5-5"}}}');
    expect(routes["chat.title"].primary).toBe("anthropic/claude-sonnet-5-5");
    expect(routes["chat.agent"].primary).toBe("anthropic/claude-sonnet-5-5");
  });

  it("adds a provider, a model, and a route from config alone", () => {
    const config = loadModelConfig({
      providers: { ollama: { kind: "openai_compatible", base_url: "http://localhost:11434/v1", auth: "none" } },
      models: { "ollama/llama3.1:8b": { tools: true, streaming: true, jsonSchema: false, contextWindow: 128_000 } },
      routes: { "chat.title": { primary: "ollama/llama3.1:8b", fallback: "anthropic/claude-haiku-4-5" } },
    });
    expect(config.routes["chat.title"].primary).toBe("ollama/llama3.1:8b");
    expect(routedProviders(config).sort()).toEqual(["anthropic", "ollama"]);
  });

  it("rejects an unknown provider, a missing catalog entry, or a missing capability", () => {
    expect(() => loadModelConfig({ routes: { "chat.agent": { primary: "home/llama-8b" } } })).toThrow(/unknown provider "home"/);
    expect(() =>
      loadModelConfig({ providers: { home: { kind: "openai_compatible", base_url: "http://x/v1" } }, routes: { "chat.agent": { primary: "home/llama-8b" } } }),
    ).toThrow(/no capability entry/);
    expect(() =>
      loadModelConfig({
        providers: { home: { kind: "openai_compatible", base_url: "http://x/v1" } },
        models: { "home/tiny": { tools: false, streaming: true, jsonSchema: false, contextWindow: 8000 } },
        routes: { "chat.agent": { primary: "home/tiny" } },
      }),
    ).toThrow(/lacks "tools"/);
  });

  it("requires base_url for openai_compatible and rejects unknown tasks", () => {
    expect(() => loadModelConfig({ providers: { home: { kind: "openai_compatible" } } })).toThrow(/needs base_url/);
    expect(() => loadModelConfig('{"routes":{"chat.everything":{"primary":"anthropic/claude-haiku-4-5"}}}')).toThrow(/unknown task/);
  });
});

describe("toAnthropicRequest", () => {
  it("translates canonical blocks and cache hints", () => {
    const out = toAnthropicRequest("claude-sonnet-5-5", {
      ...req,
      messages: [
        { role: "user", content: [{ type: "text", text: "log capoeira" }] },
        { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "log_entry", input: { a: 1 } }] },
        { role: "user", content: [{ type: "tool_result", call_id: "t1", content: "{}" }] },
      ],
      tools: [{ name: "log_entry", description: "d", inputSchema: { type: "object" } }],
      cacheHints: { system: true, tools: true },
    });
    expect(out.messages[1]!.content).toEqual([{ type: "tool_use", id: "t1", name: "log_entry", input: { a: 1 } }]);
    expect(out.messages[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "t1", content: "{}", is_error: undefined }]);
    expect(out.tools?.[0]).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect(out.system).toEqual([{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }]);
  });
});
