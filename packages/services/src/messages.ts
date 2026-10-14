import type { Block, Turn } from "@pa/models";
import { cardsForMessages, toApiCard, type ActionCard } from "./cards.js";
import type { Queryable } from "./db.js";
import { toLocalIso } from "./time.js";

export type InputMode = "text" | "voice";

/** API shape (openapi.yaml ChatMessage). Tool blocks are never exposed. */
export type ChatMessage = {
  id: string;
  client_message_id: string | null;
  role: "user" | "assistant";
  input_mode: InputMode;
  created_at: string;
  status: "complete" | "failed";
  blocks: ({ type: "text"; text: string } | { type: "action_card"; card: ActionCard })[];
  spoken_text: string | null;
  suggestions: string[];
};

export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: Block[];
  clientMessageId: string | null;
  inputMode: InputMode;
  displayText: string | null;
  spokenText: string | null;
  suggestions: string[];
  status: "complete" | "failed";
  createdAt: Date;
};

function fromRow(r: Record<string, any>): StoredMessage {
  return {
    id: r.id,
    role: r.role,
    content: r.content,
    clientMessageId: r.client_message_id,
    inputMode: r.input_mode,
    displayText: r.display_text,
    spokenText: r.spoken_text,
    suggestions: r.suggestions,
    status: r.status,
    createdAt: r.created_at,
  };
}

export async function findMessage(db: Queryable, userId: string, id: string): Promise<StoredMessage | null> {
  const { rows } = await db.query(`SELECT * FROM messages WHERE user_id = $1 AND id = $2`, [userId, id]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function findByClientMessageId(db: Queryable, userId: string, clientMessageId: string): Promise<StoredMessage | null> {
  const { rows } = await db.query(`SELECT * FROM messages WHERE user_id = $1 AND client_message_id = $2`, [userId, clientMessageId]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function insertUserMessage(
  db: Queryable,
  p: { userId: string; conversationId: string; clientMessageId: string; text: string; inputMode: InputMode; sentAt?: Date },
): Promise<StoredMessage> {
  const { rows } = await db.query(
    `INSERT INTO messages (user_id, conversation_id, role, content, client_message_id, input_mode, display_text, created_at)
     VALUES ($1, $2, 'user', $3, $4, $5, $6, COALESCE($7, now()))
     RETURNING *`,
    [p.userId, p.conversationId, JSON.stringify([{ type: "text", text: p.text }]), p.clientMessageId, p.inputMode, p.text, p.sentAt ?? null],
  );
  return fromRow(rows[0]);
}

/**
 * Stores the assistant side of a turn as one row. `content` keeps every model block in order
 * (tool calls, tool results, text) so history can be replayed to any provider (D-49).
 */
export async function insertAssistantMessage(
  db: Queryable,
  p: {
    id: string;
    userId: string;
    conversationId: string;
    content: Block[];
    displayText: string;
    spokenText: string | null;
    inputMode: InputMode;
    status: "complete" | "failed";
    model: string | null;
    usage: unknown;
  },
): Promise<StoredMessage> {
  const { rows } = await db.query(
    `INSERT INTO messages (id, user_id, conversation_id, role, content, input_mode, display_text, spoken_text, status, model, usage)
     VALUES ($1, $2, $3, 'assistant', $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [p.id, p.userId, p.conversationId, JSON.stringify(p.content), p.inputMode, p.displayText, p.spokenText, p.status, p.model, JSON.stringify(p.usage ?? null)],
  );
  return fromRow(rows[0]);
}

/**
 * Model context: the last `limit` complete messages, expanded into alternating turns.
 * An assistant row [tool_call, tool_result, text] becomes assistant[tool_call], user[tool_result], assistant[text].
 */
export async function loadHistory(db: Queryable, conversationId: string, limit = 20): Promise<Turn[]> {
  const { rows } = await db.query(
    `SELECT role, content FROM (
       SELECT role, content, created_at FROM messages
       WHERE conversation_id = $1 AND status = 'complete'
       ORDER BY created_at DESC LIMIT $2
     ) recent ORDER BY created_at`,
    [conversationId, limit],
  );
  const turns: Turn[] = [];
  for (const r of rows) for (const t of expandStored(r.role, r.content)) turns.push(t);
  while (turns[0] && (turns[0].role !== "user" || turns[0].content.some((b) => b.type === "tool_result"))) turns.shift();
  return mergeAdjacent(turns);
}

export function expandStored(role: "user" | "assistant", content: Block[]): Turn[] {
  if (role === "user") return [{ role: "user", content }];
  const turns: Turn[] = [];
  for (const block of content) {
    const turnRole = block.type === "tool_result" ? "user" : "assistant";
    const last = turns[turns.length - 1];
    if (last && last.role === turnRole) last.content.push(block);
    else turns.push({ role: turnRole, content: [block] } as Turn);
  }
  return turns;
}

function mergeAdjacent(turns: Turn[]): Turn[] {
  const out: Turn[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.content.push(...t.content);
    else out.push({ role: t.role, content: [...t.content] } as Turn);
  }
  return out;
}

export async function toChatMessages(db: Queryable, messages: StoredMessage[], timezone: string, now: Date): Promise<ChatMessage[]> {
  const cards = await cardsForMessages(db, messages.filter((m) => m.role === "assistant").map((m) => m.id));
  return messages.map((m) => ({
    id: m.id,
    client_message_id: m.clientMessageId,
    role: m.role,
    input_mode: m.inputMode,
    created_at: toLocalIso(m.createdAt, timezone),
    status: m.status,
    blocks: [
      ...(m.displayText ? [{ type: "text" as const, text: m.displayText }] : []),
      ...(cards.get(m.id) ?? []).map((c) => ({ type: "action_card" as const, card: toApiCard(c, timezone, now) })),
    ],
    spoken_text: m.spokenText,
    suggestions: m.suggestions,
  }));
}
