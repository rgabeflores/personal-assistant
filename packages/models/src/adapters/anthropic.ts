import Anthropic from "@anthropic-ai/sdk";
import { ModelError, type Block, type KeySource, type ModelAdapter, type ModelEvent, type ModelRequest, type StopReason } from "../types.js";

type AnthropicBlock = Anthropic.Messages.ContentBlockParam;

function toAnthropicBlock(b: Block): AnthropicBlock {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "tool_call":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input as Record<string, unknown> };
    case "tool_result":
      return { type: "tool_result", tool_use_id: b.call_id, content: b.content, is_error: b.is_error };
  }
}

export function toAnthropicRequest(model: string, req: ModelRequest): Anthropic.Messages.MessageCreateParamsStreaming {
  const cache = { type: "ephemeral" } as const;
  const tools = req.tools?.map((t, i, all) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
    // Marking the last tool caches the whole tool list.
    ...(req.cacheHints?.tools && i === all.length - 1 ? { cache_control: cache } : {}),
  }));
  return {
    model,
    max_tokens: req.maxTokens,
    stream: true,
    system: [{ type: "text", text: req.system, ...(req.cacheHints?.system ? { cache_control: cache } : {}) }],
    messages: req.messages.map((m) => ({ role: m.role, content: m.content.map(toAnthropicBlock) })),
    ...(tools?.length ? { tools } : {}),
  };
}

function mapStopReason(reason: string | null | undefined): StopReason {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  return "end";
}

export class AnthropicAdapter implements ModelAdapter {
  private client: { key: string; sdk: Anthropic } | undefined;

  constructor(private readonly apiKey: KeySource) {}

  private async getClient(): Promise<Anthropic> {
    const key = await this.apiKey();
    if (!key) throw new ModelError("Anthropic API key is not configured", false);
    // Rebuilt when the key changes. Retries and fallback are handled by the router, not the SDK.
    if (this.client?.key !== key) this.client = { key, sdk: new Anthropic({ apiKey: key, maxRetries: 0, timeout: 60_000 }) };
    return this.client.sdk;
  }

  async *stream(model: string, req: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const client = await this.getClient();
    let events: AsyncIterable<Anthropic.Messages.RawMessageStreamEvent>;
    try {
      events = await client.messages.create(toAnthropicRequest(model, req), { signal });
    } catch (err) {
      throw toModelError(err);
    }

    const toolCalls = new Map<number, { id: string; name: string; json: string }>();
    let inputTokens = 0;
    let cachedTokens = 0;
    let outputTokens = 0;
    let stopReason: StopReason = "end";

    try {
      for await (const ev of events) {
        switch (ev.type) {
          case "message_start":
            inputTokens = ev.message.usage.input_tokens;
            cachedTokens = ev.message.usage.cache_read_input_tokens ?? 0;
            break;
          case "content_block_start":
            if (ev.content_block.type === "tool_use") {
              toolCalls.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: "" });
            }
            break;
          case "content_block_delta":
            if (ev.delta.type === "text_delta") {
              yield { type: "text.delta", text: ev.delta.text };
            } else if (ev.delta.type === "input_json_delta") {
              const call = toolCalls.get(ev.index);
              if (call) call.json += ev.delta.partial_json;
            }
            break;
          case "content_block_stop": {
            const call = toolCalls.get(ev.index);
            if (call) {
              yield { type: "tool_call", id: call.id, name: call.name, input: call.json ? JSON.parse(call.json) : {} };
              toolCalls.delete(ev.index);
            }
            break;
          }
          case "message_delta":
            stopReason = mapStopReason(ev.delta.stop_reason);
            outputTokens = ev.usage.output_tokens;
            break;
        }
      }
    } catch (err) {
      throw toModelError(err);
    }

    yield {
      type: "done",
      stopReason,
      usage: { inputTokens, outputTokens, cachedTokens },
      model: `anthropic/${model}`,
    };
  }
}

function toModelError(err: unknown): ModelError {
  if (err instanceof ModelError) return err;
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const retryable = status === undefined || status === 408 || status === 429 || status >= 500;
    return new ModelError(err.message, retryable, status);
  }
  // Connection resets and timeouts surface as plain errors; treat them as retryable.
  return new ModelError(err instanceof Error ? err.message : String(err), true);
}
