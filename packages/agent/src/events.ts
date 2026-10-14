import type { ActionCard, ChatMessage, Conversation } from "@pa/services";

/** SSE events for one chat turn (planning/api/README.md §3, openapi.yaml ChatStreamEvent). */
export type ChatStreamEvent =
  | { type: "turn.started"; user_message_id: string; assistant_message_id: string }
  | { type: "status"; label: string; tool?: string }
  | { type: "text.delta"; text: string }
  | { type: "card"; card: ActionCard }
  | { type: "turn.completed"; message: ChatMessage; conversation: Conversation }
  | { type: "error"; error: ApiError };

export type ApiError = { code: string; message: string; retryable: boolean; request_id?: string };

export class AgentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AgentError";
  }

  toApi(): ApiError {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}
