import type { Queryable } from "./db.js";
import { toLocalIso } from "./time.js";

export type ConversationKind = "chat" | "checkin" | "review" | "shortcut";

type ChangeChip = { kind: string; outcome: "saved" | "pending" | "not_added" | "undone" | "failed"; count: number; label: string };

/** API shape (openapi.yaml Conversation). */
export type Conversation = {
  id: string;
  kind: ConversationKind;
  title: string | null;
  title_source: "auto" | "user" | "fixed";
  checkin_date: string | null;
  is_current: boolean;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_message_role: "user" | "assistant" | null;
  change_summary: ChangeChip[];
  pending_count: number;
  has_changes: boolean;
  created_at: string;
};

const SELECT_CONVERSATION = `
  SELECT c.*,
         c.id = (SELECT id FROM conversations c2
                 WHERE c2.user_id = c.user_id AND c2.deleted_at IS NULL AND c2.last_user_message_at IS NOT NULL
                 ORDER BY c2.last_user_message_at DESC LIMIT 1) AS is_current
  FROM conversations c`;

function toApi(r: Record<string, any>, timezone: string): Conversation {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    title_source: r.title_source,
    checkin_date: null,
    is_current: Boolean(r.is_current),
    last_message_at: r.last_message_at ? toLocalIso(r.last_message_at, timezone) : null,
    last_message_preview: r.last_message_preview,
    last_message_role: r.last_message_role,
    change_summary: r.change_summary,
    pending_count: r.pending_count,
    has_changes: r.has_changes,
    created_at: toLocalIso(r.created_at, timezone),
  };
}

/** Creates a conversation, idempotent on the request's Idempotency-Key (D-16). */
export async function createConversation(
  db: Queryable,
  user: { id: string; timezone: string },
  opts: { requestId?: string; kind?: ConversationKind } = {},
): Promise<Conversation> {
  if (opts.requestId) {
    const existing = await db.query(`${SELECT_CONVERSATION} WHERE c.user_id = $1 AND c.request_id = $2`, [user.id, opts.requestId]);
    if (existing.rows[0]) return toApi(existing.rows[0], user.timezone);
  }
  const { rows } = await db.query(
    `INSERT INTO conversations (user_id, kind, request_id) VALUES ($1, $2, $3)
     ON CONFLICT (request_id) DO NOTHING RETURNING id`,
    [user.id, opts.kind ?? "chat", opts.requestId ?? null],
  );
  const id = rows[0]?.id;
  const where = id ? `c.id = $2` : `c.request_id = $2`;
  const found = await db.query(`${SELECT_CONVERSATION} WHERE c.user_id = $1 AND ${where}`, [user.id, id ?? opts.requestId]);
  return toApi(found.rows[0], user.timezone);
}

export async function getConversation(
  db: Queryable,
  user: { id: string; timezone: string },
  id: string,
): Promise<Conversation | null> {
  const { rows } = await db.query(`${SELECT_CONVERSATION} WHERE c.user_id = $1 AND c.id = $2 AND c.deleted_at IS NULL`, [user.id, id]);
  return rows[0] ? toApi(rows[0], user.timezone) : null;
}

export async function setTitle(db: Queryable, conversationId: string, title: string): Promise<void> {
  await db.query(`UPDATE conversations SET title = $2 WHERE id = $1 AND title_source = 'auto'`, [conversationId, title]);
}

const OUTCOME: Record<string, ChangeChip["outcome"]> = {
  saved: "saved",
  confirmed: "saved",
  pending_confirmation: "pending",
  cancelled: "not_added",
  expired: "not_added",
  undone: "undone",
  failed: "failed",
};

function chipLabel(kind: string, outcome: ChangeChip["outcome"], count: number): string {
  if (outcome === "pending") return `${count} waiting for you`;
  if (outcome === "not_added") return `${count} not added`;
  if (outcome === "undone") return `${count} undone`;
  if (outcome === "failed") return `${count} failed`;
  const nouns: Record<string, string> = {
    log_entry: "logged",
    event: count === 1 ? "event" : "events",
    reminder: count === 1 ? "reminder" : "reminders",
    note: count === 1 ? "note" : "notes",
    list_change: count === 1 ? "item added" : "items added",
    chore: count === 1 ? "chore" : "chores",
  };
  return `${count} ${nouns[kind] ?? kind}`;
}

/** Refreshes the denormalized History fields (D-41) after a turn or a card state change. */
export async function refreshConversationSummary(db: Queryable, conversationId: string): Promise<void> {
  const cards = await db.query(
    `SELECT ac.kind, ac.state, count(*)::int AS n
     FROM action_cards ac JOIN messages m ON m.id = ac.message_id
     WHERE m.conversation_id = $1
     GROUP BY ac.kind, ac.state
     ORDER BY min(ac.created_at)`,
    [conversationId],
  );
  const chips = new Map<string, ChangeChip>();
  let pending = 0;
  for (const r of cards.rows) {
    const outcome = OUTCOME[r.state] ?? "failed";
    if (outcome === "pending") pending += r.n;
    const key = `${r.kind}:${outcome}`;
    const chip = chips.get(key) ?? { kind: r.kind, outcome, count: 0, label: "" };
    chip.count += r.n;
    chip.label = chipLabel(r.kind, outcome, chip.count);
    chips.set(key, chip);
  }
  const summary = [...chips.values()];

  await db.query(
    `UPDATE conversations c SET
       last_message_at      = m.last_at,
       last_user_message_at = m.last_user_at,
       last_message_preview = m.preview,
       last_message_role    = m.role,
       change_summary       = $2,
       pending_count        = $3,
       has_changes          = $4
     FROM (
       SELECT
         max(created_at) AS last_at,
         max(created_at) FILTER (WHERE role = 'user') AS last_user_at,
         (array_agg(left(display_text, 140) ORDER BY created_at DESC))[1] AS preview,
         (array_agg(role ORDER BY created_at DESC))[1] AS role
       FROM messages WHERE conversation_id = $1 AND display_text IS NOT NULL
     ) m
     WHERE c.id = $1`,
    [conversationId, JSON.stringify(summary), pending, summary.some((c) => c.outcome === "saved" || c.outcome === "pending")],
  );
}
