// Canonical, provider-neutral types (planning/model-providers.md §3–4, D-48, D-49).
// Stored history uses these shapes; adapters translate them for each provider.

export type TextBlock = { type: "text"; text: string };
export type ToolCallBlock = { type: "tool_call"; id: string; name: string; input: unknown };
export type ToolResultBlock = { type: "tool_result"; call_id: string; content: string; is_error?: boolean };
export type Block = TextBlock | ToolCallBlock | ToolResultBlock;

export type Turn =
  | { role: "user"; content: Block[] }
  | { role: "assistant"; content: Block[] };

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema, same definition the MCP server publishes
};

export type ModelTask =
  | "chat.agent"
  | "chat.title"
  | "chat.summary"
  | "checkin.write"
  | "review.write"
  | "logging.simple";

export type ModelRequest = {
  system: string;
  messages: Turn[];
  tools?: ToolDef[];
  responseFormat?: "text" | { jsonSchema: Record<string, unknown> };
  maxTokens: number;
  cacheHints?: { system: boolean; tools: boolean };
};

/** "provider/model", e.g. "anthropic/claude-sonnet-5-5". */
export type ModelRef = `${string}/${string}`;

export type Usage = { inputTokens: number; outputTokens: number; cachedTokens?: number };

export type StopReason = "end" | "tool_use" | "max_tokens";

export type ModelEvent =
  | { type: "text.delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "done"; stopReason: StopReason; usage: Usage; model: ModelRef };

/** Returns the current key; may look it up, so a rotated key is picked up without a restart. */
export type KeySource = () => string | undefined | Promise<string | undefined>;

export type Capabilities = {
  tools: boolean;
  streaming: boolean;
  jsonSchema: boolean;
  contextWindow: number;
};

export interface ModelAdapter {
  /** Streams one model call. Throws ModelError on failure. */
  stream(model: string, req: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelError";
  }
}
