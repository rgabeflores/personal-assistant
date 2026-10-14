import { resolveActivity, type Category } from "./activities.js";
import type { Queryable } from "./db.js";
import { toLocalIso } from "./time.js";

export type LogSource = "chat" | "quick_log" | "habit_chip" | "shortcut";

export type LogEntryInput = {
  activity: string;
  category: Category;
  variant?: string;
  startedAt?: Date;
  durationMin?: number;
  metrics?: Record<string, unknown>;
  tags?: string[];
  note?: string;
};

/** API shape (openapi.yaml LogEntry). Times carry the user's offset (INV-5). */
export type LogEntry = {
  id: string;
  activity_id: string;
  activity_name: string;
  category: Category;
  variant: string | null;
  started_at: string;
  duration_min: number | null;
  metrics: Record<string, unknown>;
  tags: string[];
  note: string | null;
  source: LogSource;
  created_at: string;
};

const SELECT_ENTRY = `
  SELECT e.id, e.activity_id, a.name AS activity_name, e.category, e.variant, e.started_at,
         e.duration_min, e.metrics, e.tags, e.note, e.source, e.created_at
  FROM log_entries e JOIN activities a ON a.id = e.activity_id`;

function toApi(row: Record<string, any>, timezone: string): LogEntry {
  return {
    id: row.id,
    activity_id: row.activity_id,
    activity_name: row.activity_name,
    category: row.category,
    variant: row.variant,
    started_at: toLocalIso(row.started_at, timezone),
    duration_min: row.duration_min,
    metrics: row.metrics,
    tags: row.tags,
    note: row.note,
    source: row.source,
    created_at: toLocalIso(row.created_at, timezone),
  };
}

/**
 * Writes one log entry. Idempotent on requestId (INV-4): a repeat returns the original row
 * and `created: false`. Shared by the log_entry tool and, from Phase 2, quick log (D-2).
 */
export async function logEntry(
  db: Queryable,
  user: { id: string; timezone: string },
  input: LogEntryInput,
  opts: { requestId: string; source: LogSource; now?: Date },
): Promise<{ entry: LogEntry; created: boolean }> {
  const existing = await db.query(`${SELECT_ENTRY} WHERE e.user_id = $1 AND e.request_id = $2`, [user.id, opts.requestId]);
  if (existing.rows[0]) return { entry: toApi(existing.rows[0], user.timezone), created: false };

  const activity = await resolveActivity(db, user.id, input.activity, input.category);
  const inserted = await db.query(
    `INSERT INTO log_entries
       (user_id, activity_id, category, activity, variant, started_at, duration_min, metrics, tags, note, source, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (request_id) DO NOTHING
     RETURNING id`,
    [
      user.id,
      activity.id,
      activity.category,
      activity.slug,
      input.variant ?? null,
      input.startedAt ?? opts.now ?? new Date(),
      input.durationMin ?? null,
      input.metrics ?? {},
      input.tags ?? [],
      input.note ?? null,
      opts.source,
      opts.requestId,
    ],
  );
  const row = await db.query(`${SELECT_ENTRY} WHERE e.user_id = $1 AND e.request_id = $2`, [user.id, opts.requestId]);
  return { entry: toApi(row.rows[0], user.timezone), created: inserted.rowCount === 1 };
}
