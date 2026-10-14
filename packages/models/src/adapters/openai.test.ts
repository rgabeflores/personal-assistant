import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModelRouter, loadModelConfig, toOpenAIMessages, type ModelRequest } from "../index.js";

// A fake OpenAI-compatible server, so the adapter is exercised over real HTTP and SSE.
let server: Server;
let baseUrl = "";
const received: { auth?: string; body: any }[] = [];
let nextReply: string[] = [];
let nextStatus = 200;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    received.push({ auth: req.headers.authorization, body: JSON.parse(body) });
    if (nextStatus !== 200) {
      res.writeHead(nextStatus, { "content-type": "application/json" }).end('{"error":{"message":"nope"}}');
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of nextReply) res.write(`data: ${chunk}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const req: ModelRequest = {
  system: "sys",
  maxTokens: 256,
  messages: [{ role: "user", content: [{ type: "text", text: "log capoeira" }] }],
  tools: [{ name: "log_entry", description: "Log it", inputSchema: { type: "object", properties: {} } }],
};

function router(auth: "key" | "none" = "none", keys: Record<string, string> = {}) {
  const config = loadModelConfig({
    providers: { local: { kind: "openai_compatible", base_url: baseUrl, auth } },
    models: { "local/llama3.1:8b": { tools: true, streaming: true, jsonSchema: false, contextWindow: 128_000 } },
    routes: { "chat.agent": { primary: "local/llama3.1:8b" } },
  });
  return createModelRouter(config, keys);
}

const chunk = (delta: object, finish: string | null = null, usage?: object) =>
  JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) });

describe("OpenAI-compatible adapter", () => {
  it("streams text and assembles tool calls split across chunks", async () => {
    nextStatus = 200;
    nextReply = [
      chunk({ content: "Logging " }),
      chunk({ content: "that." }),
      chunk({ tool_calls: [{ index: 0, id: "call_a", function: { name: "log_entry", arguments: '{"activity":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"capoeira","duration_min":45}' } }] }),
      chunk({}, "tool_calls"),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } } }),
    ];
    const deltas: string[] = [];
    const res = await router().complete("chat.agent", req, { onText: (t) => deltas.push(t) });

    expect(deltas).toEqual(["Logging ", "that."]);
    expect(res.content).toEqual([
      { type: "text", text: "Logging that." },
      { type: "tool_call", id: "call_a", name: "log_entry", input: { activity: "capoeira", duration_min: 45 } },
    ]);
    expect(res).toMatchObject({ stopReason: "tool_use", model: "local/llama3.1:8b", usage: { inputTokens: 120, outputTokens: 30, cachedTokens: 100 } });

    const sent = received.at(-1)!;
    expect(sent.auth).toBeUndefined(); // auth: none sends no key
    expect(sent.body).toMatchObject({ model: "llama3.1:8b", stream: true, max_tokens: 256 });
    expect(sent.body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(sent.body.tools[0]).toEqual({ type: "function", function: { name: "log_entry", description: "Log it", parameters: { type: "object", properties: {} } } });
  });

  it("sends the key when the provider uses one, and fails clearly without it", async () => {
    nextReply = [chunk({ content: "ok" }, "stop")];
    await router("key", { local: "sk-test" }).complete("chat.agent", req);
    expect(received.at(-1)!.auth).toBe("Bearer sk-test");
    await expect(router("key").complete("chat.agent", req)).rejects.toThrow(/No API key configured for provider "local"/);
  });

  it("maps HTTP errors to retryable or not", async () => {
    nextStatus = 400;
    await expect(router().complete("chat.agent", req)).rejects.toMatchObject({ retryable: false, status: 400 });
    nextStatus = 503;
    const before = received.length;
    await expect(router().complete("chat.agent", req)).rejects.toMatchObject({ retryable: true, status: 503 });
    expect(received.length - before).toBe(2); // one retry on the same model, no fallback configured
    nextStatus = 200;
  });

  it("passes unparseable tool arguments through for the tool to reject", async () => {
    nextReply = [chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "log_entry", arguments: "{oops" } }] }, "tool_calls")];
    const res = await router().complete("chat.agent", req);
    expect(res.content[0]).toMatchObject({ type: "tool_call", input: { _unparseable_arguments: "{oops" } });
  });
});

describe("toOpenAIMessages", () => {
  it("turns canonical history into assistant tool_calls followed by tool messages", () => {
    const out = toOpenAIMessages("sys", [
      { role: "user", content: [{ type: "text", text: "log it" }] },
      { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "log_entry", input: { a: 1 } }] },
      { role: "user", content: [{ type: "tool_result", call_id: "c1", content: '{"ok":true}' }] },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ]);
    expect(out).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "log it" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "log_entry", arguments: '{"a":1}' } }] },
      { role: "tool", tool_call_id: "c1", content: '{"ok":true}' },
      { role: "assistant", content: "Done." },
    ]);
  });
});
