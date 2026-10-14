import type { Queryable } from "./db.js";
import type { LogEntry } from "./log-entries.js";
import { toLocalIso } from "./time.js";

export type CardKind = "event" | "log_entry" | "reminder" | "note" | "list_change" | "chore";
export type CardState = "saved" | "pending_confirmation" | "confirmed" | "cancelled" | "expired" | "undone" | "failed";

/** A card produced during a turn, inserted when the assistant message is persisted. */
export type PendingCard = {
  id: string;
  kind: CardKind;
  state: CardState;
  data: unknown;
  entityId: string | null;
  requestId: string | null;
  toolName: string;
  toolInput: unknown;
  spokenCaption: string | null;
  undoExpiresAt: Date | null;
  confirmExpiresAt: Date | null;
};

/** API shape (openapi.yaml ActionCard). */
export type ActionCard = {
  id: string;
  kind: CardKind;
  state: CardState;
  data: unknown;
  actions: ("confirm" | "cancel" | "undo" | "open" | "edit" | "renew")[];
  entity_status: string | null;
  spoken_caption: string | null;
  undo_expires_at: string | null;
  confirm_expires_at: string | null;
  error: string | null;
};

const UNDO_WINDOW_MS = 10 * 60_000; // server-side undo window (ARCH §5 undo_entry)

export function logEntryCard(id: string, entry: LogEntry, requestId: string, toolInput: unknown, caption: string, now: Date): PendingCard {
  return {
    id,
    kind: "log_entry",
    state: "saved",
    data: entry,
    entityId: entry.id,
    requestId,
    toolName: "log_entry",
    toolInput,
    spokenCaption: caption,
    undoExpiresAt: new Date(now.getTime() + UNDO_WINDOW_MS),
    confirmExpiresAt: null,
  };
}

export function toApiCard(card: PendingCard, timezone: string, now: Date): ActionCard {
  const actions: ActionCard["actions"] = [];
  if (card.state === "saved" && card.undoExpiresAt && card.undoExpiresAt > now) actions.push("undo");
  if (card.state === "pending_confirmation") actions.push("confirm", "cancel");
  return {
    id: card.id,
    kind: card.kind,
    state: card.state,
    data: card.data,
    actions,
    entity_status: card.state === "saved" ? "active" : null,
    spoken_caption: card.spokenCaption,
    undo_expires_at: card.undoExpiresAt ? toLocalIso(card.undoExpiresAt, timezone) : null,
    confirm_expires_at: card.confirmExpiresAt ? toLocalIso(card.confirmExpiresAt, timezone) : null,
    error: null,
  };
}

export async function insertCards(db: Queryable, userId: string, messageId: string, cards: PendingCard[]): Promise<void> {
  for (const c of cards) {
    await db.query(
      `INSERT INTO action_cards
         (id, user_id, message_id, kind, state, data, entity_id, request_id, tool_name, tool_input,
          spoken_caption, undo_expires_at, confirm_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO NOTHING`,
      [
        c.id, userId, messageId, c.kind, c.state, JSON.stringify(c.data), c.entityId, c.requestId, c.toolName,
        JSON.stringify(c.toolInput), c.spokenCaption, c.undoExpiresAt, c.confirmExpiresAt,
      ],
    );
  }
}

export async function cardsForMessages(db: Queryable, messageIds: string[]): Promise<Map<string, PendingCard[]>> {
  const out = new Map<string, PendingCard[]>();
  if (!messageIds.length) return out;
  const { rows } = await db.query(
    `SELECT * FROM action_cards WHERE message_id = ANY($1::uuid[]) ORDER BY created_at, id`,
    [messageIds],
  );
  for (const r of rows) {
    const list = out.get(r.message_id) ?? [];
    list.push({
      id: r.id,
      kind: r.kind,
      state: r.state,
      data: r.data,
      entityId: r.entity_id,
      requestId: r.request_id,
      toolName: r.tool_name,
      toolInput: r.tool_input,
      spokenCaption: r.spoken_caption,
      undoExpiresAt: r.undo_expires_at,
      confirmExpiresAt: r.confirm_expires_at,
    });
    out.set(r.message_id, list);
  }
  return out;
}
