import { ModelError, type Block, type ModelAdapter, type ModelEvent, type ModelRequest, type StopReason, type Turn } from "../types.js";

// Chat Completions over fetch. Serves OpenAI and any OpenAI-compatible server
// (Ollama, llama.cpp, vLLM, and hosted open models), so no SDK is needed.

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type OpenAIAdapterOptions = {
  baseUrl: string;
  apiKey: () => string | undefined;
  /** OpenAI's own API wants max_completion_tokens; compatible servers expect max_tokens. */
  tokenParam: "max_completion_tokens" | "max_tokens";
  /** "none" for servers that take no key. */
  auth: "key" | "none";
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export function toOpenAIMessages(system: string, turns: Turn[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const turn of turns) {
    if (turn.role === "assistant") {
      const text = textOf(turn.content);
      const calls = turn.content.flatMap((b) =>
        b.type === "tool_call" ? [{ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }] : [],
      );
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Tool results become "tool" messages and must directly follow the assistant's tool calls.
    for (const b of turn.content) {
      if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.call_id, content: b.content });
    }
    const text = textOf(turn.content);
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

function textOf(blocks: Block[]): string {
  return blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");
}

export function toOpenAIRequest(model: string, req: ModelRequest, tokenParam: OpenAIAdapterOptions["tokenParam"]): Record<string, unknown> {
  return {
    model,
    stream: true,
    stream_options: { include_usage: true },
    [tokenParam]: req.maxTokens,
    messages: toOpenAIMessages(req.system, req.messages),
    ...(req.tools?.length
      ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
      : {}),
    ...(typeof req.responseFormat === "object"
      ? { response_format: { type: "json_schema", json_schema: { name: "response", schema: req.responseFormat.jsonSchema, strict: true } } }
      : {}),
  };
}

function mapFinish(reason: string | null | undefined, sawToolCalls: boolean): StopReason {
  if (reason === "tool_calls" || (sawToolCalls && reason !== "length")) return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end";
}

export class OpenAIAdapter implements ModelAdapter {
  constructor(
    private readonly providerId: string,
    private readonly opts: OpenAIAdapterOptions,
  ) {}

  async *stream(model: string, req: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const key = this.opts.apiKey();
    if (this.opts.auth === "key" && !key) throw new ModelError(`No API key configured for provider "${this.providerId}"`, false);

    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 60_000);
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(toOpenAIRequest(model, req, this.opts.tokenParam)),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      throw new ModelError(`${this.providerId}: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      throw new ModelError(`${this.providerId} returned ${res.status}: ${detail.slice(0, 300)}`, retryable, res.status);
    }

    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;

    try {
      for await (const data of sseData(res.body)) {
        if (data === "[DONE]") break;
        const chunk = JSON.parse(data) as {
          choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
          error?: { message?: string };
        };
        if (chunk.error) throw new ModelError(`${this.providerId}: ${chunk.error.message ?? "stream error"}`, true);
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
          outputTokens = chunk.usage.completion_tokens ?? outputTokens;
          cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? cachedTokens;
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) yield { type: "text.delta", text: choice.delta.content };
        for (const tc of choice.delta?.tool_calls ?? []) {
          const call = calls.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) call.id = tc.id;
          if (tc.function?.name) call.name += tc.function.name;
          if (tc.function?.arguments) call.args += tc.function.arguments;
          calls.set(tc.index, call);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    } catch (err) {
      if (err instanceof ModelError) throw err;
      throw new ModelError(`${this.providerId}: ${err instanceof Error ? err.message : String(err)}`, true);
    }

    for (const [index, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
      yield { type: "tool_call", id: call.id || `call_${index}`, name: call.name, input: parseArgs(call.args) };
    }
    yield {
      type: "done",
      stopReason: mapFinish(finish, calls.size > 0),
      usage: { inputTokens, outputTokens, cachedTokens },
      model: `${this.providerId}/${model}`,
    };
  }
}

/** Unparseable arguments are passed through so the tool rejects them as invalid input. */
function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _unparseable_arguments: raw };
  }
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
        const data = raw
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
