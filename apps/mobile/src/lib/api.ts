import { fetch } from "expo/fetch";
import { config } from "./config";
import { readSse } from "./sse";
import type { ChatStreamEvent, Conversation } from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

type TokenFn = () => Promise<string | null>;

async function headers(getToken: TokenFn, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const token = await getToken();
  return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra };
}

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code: string; message: string; retryable: boolean } };
    if (body.error) return new ApiError(res.status, body.error.code, body.error.message, body.error.retryable);
  } catch {}
  return new ApiError(res.status, "http_error", "Something went wrong. Try again.", res.status >= 500);
}

let lastWarm = 0;
/** Fire-and-forget warm-up, at most once every 2 minutes (api/README.md, Warm-up). */
export function warmChat(): void {
  if (Date.now() - lastWarm < 120_000) return;
  lastWarm = Date.now();
  fetch(`${config.chatBaseUrl}/v1/warm`).catch(() => {});
}

/** Phase 1: served by the Chat Lambda; moves to the REST API in Phase 2. */
export async function createConversation(getToken: TokenFn, idempotencyKey: string): Promise<Conversation> {
  const res = await fetch(`${config.chatBaseUrl}/v1/conversations`, {
    method: "POST",
    headers: await headers(getToken, { "idempotency-key": idempotencyKey }),
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as Conversation;
}

/** Sends a message and yields SSE events as they arrive (api/README.md §3). */
export async function* sendMessage(
  getToken: TokenFn,
  conversationId: string,
  body: { client_message_id: string; text: string; input_mode?: "text" | "voice" },
): AsyncGenerator<ChatStreamEvent> {
  const res = await fetch(`${config.chatBaseUrl}/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: await headers(getToken, { accept: "text/event-stream" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toApiError(res);
  if (!res.body) throw new ApiError(0, "no_body", "No response body.", true);
  for await (const msg of readSse(res.body)) yield JSON.parse(msg.data) as ChatStreamEvent;
}
