// Client copies of the API shapes the Phase 1 chat screen uses (planning/api/openapi.yaml).

export type Conversation = {
  id: string;
  title: string | null;
  is_current: boolean;
  last_message_preview: string | null;
  change_summary: { kind: string; outcome: string; count: number; label: string }[];
  pending_count: number;
};

export type ActionCard = {
  id: string;
  kind: "event" | "log_entry" | "reminder" | "note" | "list_change" | "chore";
  state: "saved" | "pending_confirmation" | "confirmed" | "cancelled" | "expired" | "undone" | "failed";
  data: Record<string, unknown>;
  actions: string[];
  spoken_caption: string | null;
};

export type MessageBlock = { type: "text"; text: string } | { type: "action_card"; card: ActionCard };

export type ChatMessage = {
  id: string;
  client_message_id: string | null;
  role: "user" | "assistant";
  status: "complete" | "failed";
  blocks: MessageBlock[];
  spoken_text: string | null;
  suggestions: string[];
};

export type ChatStreamEvent =
  | { type: "turn.started"; user_message_id: string; assistant_message_id: string }
  | { type: "status"; label: string; tool?: string }
  | { type: "text.delta"; text: string }
  | { type: "card"; card: ActionCard }
  | { type: "turn.completed"; message: ChatMessage; conversation: Conversation }
  | { type: "error"; error: { code: string; message: string; retryable: boolean } };
